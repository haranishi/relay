import console from "node:console";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";

import { CliError, parseCliArgs, runCli } from "./cli.mjs";
import { readPilotSecrets } from "./pilot-secrets.mjs";

const api = "/api/v1";
const session = `${api}/session`;
const community = `${api}/communities/community-campus-demo`;
const listings = `${community}/listings`;
const handoffs = `${community}/handoffs`;
const requestTimeout = 15_000;
const matchingTimeout = 45_000;
const usage = "使い方: node scripts/cloud/smoke.mjs <公開URL> [--secrets <JSONのパス>] [--flow [--allow-host <ホスト名>]]";

function publicOrigin(value) {
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.href !== `${url.origin}/`) {
    throw new CliError("公開URLには HTTPS のオリジンを指定してください。");
  }
  return url.origin;
}

function requester(origin, fetch, log) {
  return async (step, path, expected, {
    method = "GET", headers = {}, cookie, body, json = false, retry404 = false, timeout = requestTimeout
  } = {}) => {
    if (cookie) headers.cookie = cookie;
    if (method === "POST") headers.origin ??= origin;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetch(`${origin}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual", signal: globalThis.AbortSignal.timeout(timeout)
      });
    } catch {
      throw new CliError(`${step} HTTP 応答を受信できませんでした。`);
    }
    const { status } = response;
    log(`${step} ${status}`);
    if (!json || status !== expected) await response.body?.cancel().catch(() => {});
    if (retry404 && status === 404) return { status };
    if (status !== expected) throw new CliError(`${step} は HTTP ${expected} を想定しています。`);
    if (!json) return { status };
    const data = await response.json().catch(() => { throw new CliError(`${step} の応答が JSON ではありません。`); });
    return { data, headers: response.headers };
  };
}

function resourceId(step, resource) {
  if (typeof resource?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(resource.id)) {
    throw new CliError(`${step} の応答から ID を取得できませんでした。`);
  }
  return resource.id;
}

async function waitForMatching(request, path, cookie, now, pause) {
  const deadline = now() + matchingTimeout;
  for (let remaining = deadline - now(); remaining > 0; remaining = deadline - now()) {
    const { status } = await request("出品の反映", path, 200, {
      cookie, retry404: true, timeout: Math.ceil(Math.min(requestTimeout, remaining))
    });
    if (status === 200) return;
    const delay = Math.min(1000, deadline - now());
    if (delay > 0) await pause(delay);
  }
  throw new CliError("45秒以内に Matching へ出品が反映されませんでした。");
}

async function runFlow(request, secrets, now, pause) {
  async function login(label, id, code) {
    const { data, headers } = await request(label, session, 200, { method: "POST", body: { code }, json: true });
    const cookie = headers.getSetCookie()
      .find((value) => value.startsWith("relay_session="))?.split(";", 1)[0];
    if (data?.user?.id !== id || !cookie?.slice("relay_session=".length)) {
      throw new CliError(`${label} の利用者または Cookie を確認できませんでした。`);
    }
    return cookie;
  }

  const giver = await login("出品者ログイン", "giver", secrets.RELAY_INVITE_GIVER);
  const a = await login("受取人Aログイン", "receiver-a", secrets.RELAY_INVITE_A);
  const b = await login("受取人Bログイン", "receiver-b", secrets.RELAY_INVITE_B);
  const start = Date.now();
  const after = (ms) => new Date(start + ms).toISOString();
  const slot = { startAt: after(3_600_000), endAt: after(7_200_000) };
  const created = await request("出品", listings, 201, {
    method: "POST", cookie: giver, json: true,
    body: {
      title: "配備確認用の架空のソファ",
      description: "Relayの公開試験用です。",
      category: "furniture",
      condition: "used_good",
      pickupArea: "デモキャンパス正門",
      pickupSlots: [slot],
      pickupDeadline: after(7 * 86_400_000)
    }
  });
  const listing = `${listings}/${resourceId("出品", created.data)}`;
  await waitForMatching(request, `${listing}/matching`, giver, now, pause);

  const application = { message: "配備確認用の応募です。", availableSlots: [slot], transportMode: "walk", helperCount: 1 };
  const appliedA = await request("Aの応募", `${listing}/applications`, 201, { method: "POST", cookie: a, body: application, json: true });
  const appliedB = await request("Bの応募", `${listing}/applications`, 201, { method: "POST", cookie: b, body: application, json: true });
  const selected = await request("選定", `${listing}/selection`, 201, {
    method: "POST", cookie: giver, headers: { "idempotency-key": randomUUID() }, json: true,
    body: {
      selectedApplicationId: resourceId("Aの応募", appliedA.data),
      backupApplicationIds: [resourceId("Bの応募", appliedB.data)],
      confirmationExpiresAt: after(86_400_000)
    }
  });
  if (selected.data?.receiverId !== "receiver-a" || selected.data.status !== "PROPOSED") {
    throw new CliError("選定結果に受取人Aの受け渡しがありません。");
  }
  await request("Aの辞退", `${handoffs}/${resourceId("選定", selected.data)}/cancel`, 200, {
    method: "POST", cookie: a, body: { reason: "declined" }
  });

  const view = await request("Bの受け渡し照会", `${listing}/matching`, 200, { cookie: b, json: true });
  const next = Array.isArray(view.data?.handoffs) && view.data.handoffs
    .find((item) => item?.receiverId === "receiver-b" && item.status === "PROPOSED");
  const completed = await request("Bの完了", `${handoffs}/${resourceId("Bの受け渡し照会", next)}/complete`, 200, {
    method: "POST", cookie: b, json: true
  });
  if (completed.data?.receiverId !== "receiver-b" || completed.data.status !== "COMPLETED") {
    throw new CliError("受取人Bの受け渡しの完了を確認できませんでした。");
  }
}

export async function main(args, { fetch = globalThis.fetch, log = console.log, now = () => performance.now(), pause = sleep } = {}) {
  const { values, positionals } = parseCliArgs(
    args, { secrets: { type: "string" }, flow: { type: "boolean" }, "allow-host": { type: "string" } }, usage
  );
  if (positionals.length !== 1) throw new CliError(usage);
  const origin = publicOrigin(positionals[0]);
  // --flow は招待コードを送る。URL の打ち間違いや、別の相手に渡さないよう、workers.dev か、明示した宛先だけにする。
  const { hostname } = new URL(origin);
  if (values.flow && !hostname.endsWith(".workers.dev") && values["allow-host"] !== hostname) {
    throw new CliError(`--flow は、招待コードを ${hostname} へ送ります。workers.dev 以外へ送るときは、--allow-host ${hostname} を付けてください。`);
  }
  const secrets = values.flow ? await readPilotSecrets(values.secrets) : undefined;
  const request = requester(origin, fetch, log);

  await request("ヘルスチェック", `${api}/health`, 200);
  await request("未ログインの出品一覧", listings, 401);
  await request("デモ認証ヘッダー付きの出品一覧", listings, 401, { headers: { "x-relay-demo-user": "giver" } });
  await request("ローカル Origin のログイン", session, 403, {
    method: "POST", headers: { origin: "http://127.0.0.1:8787" }, body: { code: "invalid-local-origin-test" }
  });

  if (secrets) await runFlow(request, secrets, now, pause);
}

await runCli(import.meta, main);
