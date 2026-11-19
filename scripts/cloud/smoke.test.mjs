import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "./smoke.mjs";

const origin = "https://relay-web.dummy.invalid";
const listings = "/api/v1/communities/community-campus-demo/listings";
const handoffs = "/api/v1/communities/community-campus-demo/handoffs";
const session = "/api/v1/session";
const matching = `${listings}/dummy-listing/matching`;
const secrets = {
  RELAY_SESSION_KEY: "dummy-signature-key",
  RELAY_INVITE_GIVER: "dummy-invite-giver",
  RELAY_INVITE_A: "dummy-invite-a",
  RELAY_INVITE_B: "dummy-invite-b"
};
const hiddenResponse = { message: "dummy-response-text" };
const checks = [
  ["GET", "/api/v1/health", 200],
  ["GET", listings, 401],
  ["GET", listings, 401],
  ["POST", session, 403]
];
const logins = ["giver", "receiver-a", "receiver-b"].map((id) => [
  "POST", session, 200, { user: { id } }, { "set-cookie": `relay_session=dummy-cookie-${id}; Secure; HttpOnly` }
]);
const flow = [
  ...logins,
  ["POST", listings, 201, { id: "dummy-listing" }],
  ["GET", matching, 404],
  ["GET", matching, 200],
  ["POST", `${listings}/dummy-listing/applications`, 201, { id: "dummy-application-a" }],
  ["POST", `${listings}/dummy-listing/applications`, 201, { id: "dummy-application-b" }],
  ["POST", `${listings}/dummy-listing/selection`, 201, { id: "dummy-handoff-a", receiverId: "receiver-a", status: "PROPOSED" }],
  ["POST", `${handoffs}/dummy-handoff-a/cancel`, 200, { nextHandoff: { id: "dummy-unused-id" } }],
  ["GET", matching, 200, { handoffs: [{ id: "dummy-handoff-b", receiverId: "receiver-b", status: "PROPOSED" }] }],
  ["POST", `${handoffs}/dummy-handoff-b/complete`, 200, { receiverId: "receiver-b", status: "COMPLETED" }]
];

async function secretsFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "relay-smoke-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pilot-secrets.json");
  await writeFile(path, JSON.stringify(secrets), { mode: 0o600 });
  return path;
}

function stubFetch(responses, fallback) {
  const calls = [];
  return {
    calls,
    async fetch(url, options) {
      const index = calls.push({ url, ...options }) - 1;
      const [, , status, data = hiddenResponse, headers] = responses[index] ?? fallback ?? [null, null, 500];
      return globalThis.Response.json(data, { status, headers });
    }
  };
}

function checkRoutes(calls, plan) {
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), plan.map(([method, path]) => [method, origin + path]));
  assert.ok(calls.every(({ redirect, headers }) => redirect === "manual" && !Object.hasOwn(headers, "cf-connecting-ip")));
}

test("既定は秘密ファイルを開かず、読み取りと拒否されるログインだけを確認する", async () => {
  const { fetch, calls } = stubFetch(checks);
  const logs = [];
  await main([`${origin}/`, "--secrets", "dummy-nonexistent-file.json"], { fetch, log: (line) => logs.push(line) });
  checkRoutes(calls, checks);
  assert.deepEqual(calls.map(({ headers }) => headers), [{}, {}, { "x-relay-demo-user": "giver" }, {
    origin: "http://127.0.0.1:8787", "content-type": "application/json"
  }]);
  assert.deepEqual(logs, [
    "ヘルスチェック 200", "未ログインの出品一覧 401", "デモ認証ヘッダー付きの出品一覧 401", "ローカル Origin のログイン 403"
  ]);
});

test("3人を別々のCookieで操作し、繰り上がったBの照会で得たIDで完了する", async (t) => {
  const plan = [...checks, ...flow];
  const { fetch, calls } = stubFetch(plan);
  const logs = [];
  const delays = [];
  await main([origin, "--flow", "--secrets", await secretsFile(t)], {
    fetch, log: (line) => logs.push(line), now: () => 0, pause: async (delay) => { delays.push(delay); }
  });
  checkRoutes(calls, plan);
  const flowCalls = calls.slice(checks.length);
  assert.ok(flowCalls.filter(({ method }) => method === "POST").every(({ headers }) => headers.origin === origin));
  assert.deepEqual(flowCalls.slice(0, 3).map(({ body }) => JSON.parse(body).code), [
    secrets.RELAY_INVITE_GIVER, secrets.RELAY_INVITE_A, secrets.RELAY_INVITE_B
  ]);
  assert.deepEqual(flowCalls.map(({ headers }) => headers.cookie?.replace("relay_session=dummy-cookie-", "")), [
    undefined, undefined, undefined, "giver", "giver", "giver", "receiver-a", "receiver-b", "giver", "receiver-a", "receiver-b", "receiver-b"
  ]);
  const selection = flowCalls[8];
  assert.ok(selection.headers["idempotency-key"]);
  const selected = JSON.parse(selection.body);
  assert.equal(selected.selectedApplicationId, "dummy-application-a");
  assert.deepEqual(selected.backupApplicationIds, ["dummy-application-b"]);
  assert.deepEqual(logs.map((line) => Number(line.split(" ").at(-1))), plan.map(([, , status]) => status));
  assert.ok(!logs.join("\n").includes("dummy-"), "出力に招待コード・Cookie・ID・応答本文が混ざらない");
  assert.deepEqual(delays, [1000]);
});

test("どの段でも異なるHTTP状態を受けたら、その段で止まる", async (t) => {
  const plan = [...checks, ...flow.filter(([, , status]) => status !== 404)];
  const args = [origin, "--flow", "--secrets", await secretsFile(t)];
  for (const [index, [method, path, status]] of plan.entries()) {
    const { fetch, calls } = stubFetch([...plan.slice(0, index), [method, path, 500]]);
    const logs = [];
    await assert.rejects(main(args, { fetch, log: (line) => logs.push(line) }), new RegExp(`HTTP ${status}`));
    assert.equal(calls.length, index + 1);
    assert.ok(logs.at(-1).endsWith(" 500"));
    assert.ok(!logs.join("\n").includes("dummy-"));
  }
});

test("Matching が404を返し続けたら45秒で打ち切る", async (t) => {
  const { fetch, calls } = stubFetch([...checks, ...flow.slice(0, 4)], ["GET", matching, 404]);
  let time = 0;
  await assert.rejects(main([origin, "--flow", "--secrets", await secretsFile(t)], {
    fetch, log: () => {}, now: () => time, pause: async (delay) => { time += delay; }
  }), /45秒/);
  assert.equal(time, 45_000);
  assert.equal(calls.length, checks.length + 4 + 45);
  for (const { method, url } of calls.slice(checks.length + 4)) {
    assert.equal(method, "GET");
    assert.equal(url, origin + matching);
  }
});
