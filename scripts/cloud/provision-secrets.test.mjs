import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { main } from "./provision-secrets.mjs";

const gateway = {
  RELAY_SESSION_KEY: "dummy-session-key",
  RELAY_INVITE_GIVER: "dummy-giver",
  RELAY_INVITE_A: "dummy-receiver-a",
  RELAY_INVITE_B: "dummy-receiver-b"
};
const account = "dummy-cloudflare-account-id";

async function secretsFile(t, mode = 0o600) {
  const dir = await mkdtemp(join(tmpdir(), "relay-provision-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "pilot-secrets.json");
  await writeFile(file, JSON.stringify(gateway), { mode });
  return file;
}

function stubSpawn(answer) {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      const call = { command, args, options, input: "" };
      calls.push(call);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk) => { call.input += chunk; });
      globalThis.queueMicrotask(() => {
        const { code, stdout = "" } = answer(call);
        child.stdout.end(stdout);
        child.emit("close", code);
      });
      return child;
    }
  };
}

test("既定と --dry-run はWorker名とSecret名だけを表示する", async () => {
  const env = new Proxy(gateway, { get: () => assert.fail("環境変数を参照しました") });
  const spawn = () => assert.fail("子プロセスを起動しました");
  const logs = [];
  for (const args of [[], ["--dry-run", "--secrets", "dummy-nonexistent-file.json"]]) {
    await main(args, { env, spawn, log: (line) => logs.push(line) });
    assert.deepEqual(logs.splice(0), [
      "relay-community-auth TURSO_DATABASE_URL TURSO_AUTH_TOKEN",
      "relay-listing TURSO_DATABASE_URL TURSO_AUTH_TOKEN",
      "relay-matching TURSO_DATABASE_URL TURSO_AUTH_TOKEN",
      "relay-read-model TURSO_DATABASE_URL TURSO_AUTH_TOKEN",
      "relay-api-gateway RELAY_SESSION_KEY RELAY_INVITE_GIVER RELAY_INVITE_A RELAY_INVITE_B"
    ]);
  }
});

test("アカウントIDが未指定ならSecretファイルを読む前に止まる", async () => {
  const { spawn, calls } = stubSpawn(() => ({ code: 0 }));
  await assert.rejects(main(["--apply", "--secrets", "dummy-nonexistent-file.json"], { env: {}, spawn }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(calls.length, 0);
});

test("Secretファイルの権限が0600でなければトークンを発行しない", async (t) => {
  const file = await secretsFile(t, 0o644);
  const { spawn, calls } = stubSpawn(() => ({ code: 0 }));
  await assert.rejects(main(["--apply", "--secrets", file], { env: { CLOUDFLARE_ACCOUNT_ID: account }, spawn }), /relay-api-gateway.*0600/);
  assert.equal(calls.length, 0);
});

test("発行内容と登録先を対応させ、値はWranglerの標準入力だけに渡す", async (t) => {
  const file = await secretsFile(t);
  const url = (database) => `libsql://${database}.dummy.invalid`;
  const token = (database) => `dummy.${database}.token`;
  const { spawn, calls } = stubSpawn(({ args }) => {
    if (args[1] === "show") return { code: 0, stdout: `${url(args[2])}\n` };
    if (args[1] === "tokens") return { code: 0, stdout: `${token(args[3])}\n` };
    return { code: 0, stdout: "dummy-unreported-output" };
  });
  const logs = [];
  const env = {
    ...gateway, CLOUDFLARE_ACCOUNT_ID: account, TURSO_DATABASE_URL: "libsql://dummy-inherited.invalid",
    TURSO_AUTH_TOKEN: "dummy-inherited-token"
  };
  await main(["--apply", "--secrets", file], { env, spawn, log: (line) => logs.push(line) });

  const targets = [["community-auth", "community"], ["listing", "listing"], ["matching", "matching"], ["read-model", "read-model"]];
  for (const [index, [worker, db]] of targets.entries()) {
    const database = `relay-${db}-dev`;
    const [show, create, bulk] = calls.slice(index * 3, index * 3 + 3);
    assert.ok(show.command.endsWith("/.turso/turso"));
    assert.equal(create.command, show.command);
    assert.deepEqual(show.args, ["db", "show", database, "--url"]);
    assert.deepEqual(create.args, ["db", "tokens", "create", database, "--expiration", "30d", ...(index === 0 ? ["--read-only"] : [])]);
    assert.deepEqual(show.options.stdio, ["ignore", "pipe", "ignore"]);
    assert.deepEqual(create.options.stdio, ["ignore", "pipe", "ignore"]);
    assert.equal(bulk.args[1], `workers/${worker}`);
    assert.deepEqual(JSON.parse(bulk.input), { TURSO_DATABASE_URL: url(database), TURSO_AUTH_TOKEN: token(database) });
  }
  const gatewayCall = calls[12];
  assert.equal(gatewayCall.args[1], "workers/api-gateway");
  assert.deepEqual(JSON.parse(gatewayCall.input), gateway);
  assert.equal(calls.length, 13);
  for (const call of calls.filter((call) => call.input)) {
    assert.equal(call.command, "pnpm");
    assert.deepEqual(call.args.slice(2), ["exec", "wrangler", "secret", "bulk", "-c", "wrangler.jsonc"]);
    assert.deepEqual(call.options.stdio, ["pipe", "ignore", "ignore"]);
    assert.equal(call.options.env.CLOUDFLARE_ACCOUNT_ID, account);
    assert.equal(call.options.env.WRANGLER_WRITE_LOGS, "false");
  }
  const allValues = [...Object.values(gateway), env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN, "dummy-unreported-output",
    ...targets.flatMap(([, db]) => [url(`relay-${db}-dev`), token(`relay-${db}-dev`)])];
  const visible = JSON.stringify([logs, calls.map(({ command, args, options }) => [command, args, options.env])]);
  assert.ok(allValues.every((value) => !visible.includes(value)), "入力の値が引数・環境変数・表示に混ざらない");
});

test("子プロセスが失敗したら対象と手順だけを返し、後続を実行しない", async (t) => {
  const file = await secretsFile(t);
  const { spawn, calls } = stubSpawn(() => ({ code: 1, stdout: "dummy-sensitive-cli-error" }));
  await assert.rejects(main(["--apply", "--secrets", file], { env: { CLOUDFLARE_ACCOUNT_ID: account }, spawn }), {
    message: "relay-community-auth DB URL の取得に失敗しました。"
  });
  assert.equal(calls.length, 1);
});
