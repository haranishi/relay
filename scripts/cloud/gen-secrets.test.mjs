import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { test } from "node:test";

const script = join(import.meta.dirname, "gen-secrets.mjs");

async function tempDirectory(t) {
  const dir = await mkdtemp(join(tmpdir(), "relay-gen-secrets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function run(file) {
  return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
}

test("権限を絞ったファイルに異なる3つの招待コードを作り、値を表示しない", async (t) => {
  const file = join(await tempDirectory(t), "relay", "pilot-secrets.json");
  const result = run(file);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.trim() === `${file} を作成しました（4キー）。` && !result.stderr, "出力はパスとキー数だけ");
  assert.equal((await stat(file)).mode & 0o7777, 0o600);
  assert.equal((await stat(dirname(file))).mode & 0o7777, 0o700);

  const { RELAY_SESSION_KEY: key, RELAY_INVITE_GIVER: giver, RELAY_INVITE_A: a, RELAY_INVITE_B: b, ...rest } =
    JSON.parse(await readFile(file, "utf8"));
  const invites = [giver, a, b];
  assert.ok(/^[0-9a-f]{64}$/.test(key), "署名鍵は32バイトの16進表記");
  assert.ok(invites.every((code) => /^[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}$/.test(code)), "招待コードはCrockford Base32の20文字");
  assert.equal(new Set(invites).size, 3);
  assert.deepEqual(Object.keys(rest), []);
  assert.ok([key, ...invites].every((value) => !result.stdout.includes(value) && !result.stderr.includes(value)));

  const before = await readFile(file);
  const retry = run(file);
  assert.equal(retry.status, 1);
  assert.ok(retry.stderr.trim() === "出力先のファイルが既にあります。" && !retry.stdout);
  assert.ok(before.equals(await readFile(file)), "2回目も既存の内容を保持");
});

test("0700でない既存の親ディレクトリには書き込まない", async (t) => {
  const directory = await tempDirectory(t);
  await chmod(directory, 0o755);
  const file = join(directory, "pilot-secrets.json");
  const result = run(file);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /0700/);
  assert.equal((await stat(directory)).mode & 0o7777, 0o755);
  await assert.rejects(stat(file), { code: "ENOENT" });
});
