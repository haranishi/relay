#!/usr/bin/env node
// ローカルの sqld と wrangler dev --local だけで、招待コードのログインから受渡し完了までを通す。
// クラウドのアカウント操作（login / deploy / secret / queues create / turso）はしない。

import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, openSync } from "node:fs";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(ROOT, "packages/turso/package.json"));
const { createClient } = require("@libsql/client");

const args = process.argv.slice(2);
const serveMode = args.includes("--serve");
const LABEL = args.find((arg) => !arg.startsWith("-")) ?? (serveMode ? "serve" : "run");
const RUNTIME = "/tmp/relay-e2e";
const LOG_DIR = path.join(RUNTIME, "logs");
const STATE_DIR = path.join(RUNTIME, "wrangler-state");
const INVITE_FILE = path.join(RUNTIME, "invite-codes.json");
const BASE = "http://127.0.0.1:8787";
const ORIGIN = "http://127.0.0.1:8787";
const SESSION = `${BASE}/api/v1/session`;
const COMMUNITY = "community-campus-demo";
const PREFIX = `${BASE}/api/v1/communities/${COMMUNITY}`;
const PORTS = [8787, 8081, 8082, 8083, 8084, 9230];
const SECRET_BYTES = 32;
const DATABASES = [
  { name: "community", port: 8081, worker: "community-auth", files: ["db/community/0001_initial.sql", "db/community/demo_seed.sql"] },
  { name: "listing", port: 8082, worker: "listing", files: ["db/listing/0001_initial.sql", "db/listing/0002_matching_revision.sql"] },
  { name: "matching", port: 8083, worker: "matching", files: ["db/matching/0001_initial.sql", "db/matching/0002_handoff_transition.sql", "db/matching/0003_listing_keys.sql", "db/matching/0004_application_open.sql"] },
  { name: "read-model", port: 8084, worker: "read-model", files: ["db/read-model/0001_initial.sql", "db/read-model/0002_matching_revision.sql"] }
];
const WORKER_CONFIGS = [
  "workers/api-gateway/wrangler.jsonc",
  "workers/community-auth/wrangler.jsonc",
  "workers/listing/wrangler.jsonc",
  "workers/matching/wrangler.jsonc",
  "workers/read-model/wrangler.jsonc",
  "workers/event-router/wrangler.jsonc",
  "workers/notification/wrangler.jsonc"
];

const children = [];
const steps = [];
const secretValues = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(msAhead) {
  return new Date(Date.now() + msAhead).toISOString();
}

function redact(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secretValues) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(/relay_session=[^;\s"]+/g, "relay_session=[REDACTED]");
}

function exec(command, commandArgs) {
  return new Promise((resolve) => {
    execFile(command, commandArgs, { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({
        code: error ? error.code ?? 1 : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? ""
      });
    });
  });
}

function childEnv() {
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLOUDFLARE_") || key.startsWith("TURSO_") || key === "WRANGLER_LOG") {
      delete env[key];
    }
  }
  return env;
}

function startLogged(label, command, commandArgs) {
  const logPath = path.join(LOG_DIR, `${LABEL}-${label}.log`);
  const fd = openSync(logPath, "w");
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    detached: true,
    env: childEnv(),
    stdio: ["ignore", fd, fd]
  });
  closeSync(fd);
  children.push({ label, child, logPath, command, args: commandArgs });
  return { child, logPath };
}

async function stopChildren() {
  for (const { child } of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && children.some(({ child }) => alive(child.pid))) {
    await sleep(200);
  }
  for (const { child } of children) {
    if (!alive(child.pid)) continue;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  await sleep(300);
  return children
    .filter(({ child }) => alive(child.pid))
    .map(({ label, child, command, args: commandArgs }) => ({
      label,
      pid: child.pid,
      command: [command, ...commandArgs].join(" ")
    }));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listenLines() {
  const result = await exec("lsof", ["-nP", ...PORTS.flatMap((port) => ["-iTCP", `:${port}`]), "-sTCP:LISTEN"]);
  return result.stdout.trim();
}

async function assertPortsFree() {
  const lines = await listenLines();
  if (lines) {
    throw new Error(`使用中のポートがあるので起動しません。\n${lines}`);
  }
}

async function resetState() {
  await mkdir(LOG_DIR, { recursive: true });
  for (const database of DATABASES) {
    await rm(path.join(RUNTIME, database.name), { recursive: true, force: true });
  }
  await rm(STATE_DIR, { recursive: true, force: true });
}

async function waitFor(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "未応答";
  while (Date.now() < deadline) {
    if (!alive(child.pid)) {
      throw new Error(`${url} を待つ間にプロセスが終了しました`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(400);
  }
  throw new Error(`${url} が ${timeoutMs}ms 以内に 200 になりませんでした（最後: ${last}）`);
}

async function migrate() {
  for (const database of DATABASES) {
    const client = createClient({ url: `http://127.0.0.1:${database.port}` });
    try {
      for (const file of database.files) {
        const sql = await readFile(path.join(ROOT, file), "utf8");
        try {
          await client.executeMultiple(sql);
          if (!serveMode) console.log(`migrate ok ${file}`);
        } catch (error) {
          const detail = error instanceof Error ? error.stack ?? error.message : String(error);
          throw new Error(`移行に失敗しました: ${file}\n${detail}`);
        }
      }
    } finally {
      client.close();
    }
  }
}

function newSecret() {
  const value = randomBytes(SECRET_BYTES).toString("hex").toUpperCase();
  secretValues.push(value);
  return value;
}

async function writePrivate(file, body) {
  await writeFile(file, body, { mode: 0o600 });
  await chmod(file, 0o600);
}

// このスクリプトが作った .dev.vars の印。印の無い .dev.vars は、開発者が自分で作った本物の設定なので、上書きしない。
const DEV_VARS_MARK = "# relay の local-e2e が作った一時ファイル（終了時に消す）\n";
const writtenDevVars = [];

async function claimDevVars(files) {
  for (const file of files) {
    const existing = await readFile(file, "utf8").catch(() => null);
    if (existing !== null && !existing.startsWith(DEV_VARS_MARK)) {
      throw new Error(`${path.relative(ROOT, file)} が既にあり、このスクリプトが作ったものではないので、上書きしません。退避してから、もう一度実行してください。`);
    }
  }
}

async function writeDevVarsFile(file, body) {
  await writePrivate(file, DEV_VARS_MARK + body);
  writtenDevVars.push(file);
}

async function removeDevVars() {
  for (const file of writtenDevVars) await rm(file, { force: true });
}

async function writeDevVars() {
  const gatewayFile = path.join(ROOT, "workers/api-gateway/.dev.vars");
  const dbFiles = DATABASES.map((database) => path.join(ROOT, "workers", database.worker, ".dev.vars"));
  await claimDevVars([...dbFiles, gatewayFile]);
  for (const [index, database] of DATABASES.entries()) {
    const body = `TURSO_DATABASE_URL=http://127.0.0.1:${database.port}\nTURSO_AUTH_TOKEN=\n`;
    await writeDevVarsFile(dbFiles[index], body);
  }
  const codes = {
    sessionKey: newSecret(),
    giver: newSecret(),
    a: newSecret(),
    b: newSecret()
  };
  const gateway = [
    `RELAY_SESSION_KEY=${codes.sessionKey}`,
    `RELAY_INVITE_GIVER=${codes.giver}`,
    `RELAY_INVITE_A=${codes.a}`,
    `RELAY_INVITE_B=${codes.b}`,
    ""
  ].join("\n");
  await writeDevVarsFile(gatewayFile, gateway);
  if (!serveMode) console.log(`シークレットを4つ設定した（各${SECRET_BYTES}バイト）`);
  return codes;
}

async function webWorkerReady() {
  try {
    await access(path.join(ROOT, "apps/web/.open-next/worker.js"));
    return true;
  } catch {
    return false;
  }
}

async function call(step, method, route, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.cookie) headers.cookie = options.cookie;
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (typeof options.origin === "string") headers.origin = options.origin;
  else if (options.origin !== false && write && options.cookie) headers.origin = ORIGIN;
  if (options.body !== undefined && options.rawBody === undefined) headers["content-type"] = "application/json";
  if (options.idempotency) headers["idempotency-key"] = options.idempotency;
  const response = await fetch(options.absolute ?? `${PREFIX}${route}`, {
    method,
    headers,
    body: options.rawBody !== undefined
      ? options.rawBody
      : options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* 本文が JSON でない */ }
  const record = { step, status: response.status, body: parsed };
  steps.push(record);
  const setCookie = response.headers.getSetCookie?.()[0] ?? "";
  const pair = setCookie.split(";")[0];
  if (!serveMode) console.log(`${step} ${response.status}`);
  return {
    ...record,
    cookie: pair.startsWith("relay_session=") ? pair : null,
    cookieFlags: setCookie.slice(pair.length)
  };
}

function expectStatus(record, status, label) {
  if (record.status !== status) {
    throw new Error(`${label}: HTTP ${record.status}（期待 ${status}） ${redact(record.body)}`);
  }
}

function assertLocalCookie(record, label) {
  if (!record.cookie) throw new Error(`${label}: Set-Cookie がありません`);
  const flags = record.cookieFlags;
  const problems = [];
  if (!/HttpOnly/i.test(flags)) problems.push("HttpOnly がない");
  if (!/SameSite=Lax/i.test(flags)) problems.push("SameSite=Lax がない");
  if (/;\s*Secure\b/i.test(flags)) problems.push("Secure がある");
  if (!/Max-Age=28800/.test(flags)) problems.push("Max-Age=28800 がない");
  if (problems.length > 0) {
    throw new Error(`${label}: Cookie 属性が想定と違います（${problems.join("、")}）${flags}`);
  }
}

function disguise(code) {
  const lower = code.toLowerCase();
  return ` ${lower.slice(0, 4)}-${lower.slice(4, 12)}-${lower.slice(12)} `;
}

async function login(step, code, extra = {}) {
  return call(step, "POST", "/api/v1/session", {
    absolute: SESSION,
    origin: extra.origin === undefined ? ORIGIN : extra.origin,
    headers: extra.headers,
    body: { code }
  });
}

function matchingRoute(listingId) {
  return `/listings/${listingId}/matching`;
}

function summarizeView(view) {
  return {
    listingStatus: view?.listingStatus ?? null,
    viewerRole: view?.viewerRole ?? null,
    applications: (view?.applications ?? []).map((item) => ({
      applicantId: item.applicantId,
      status: item.status
    })),
    handoffs: (view?.handoffs ?? []).map((item) => ({
      receiverId: item.receiverId,
      status: item.status
    }))
  };
}

function pairStatus(items, idKey) {
  return items.map((item) => `${item[idKey]}:${item.status}`).sort();
}

async function checkDisclosure(stage, listingId, cookies, expected) {
  const giver = await call(`${stage}-giver`, "GET", matchingRoute(listingId), { cookie: cookies.giver });
  const a = await call(`${stage}-a`, "GET", matchingRoute(listingId), { cookie: cookies.a });
  const b = await call(`${stage}-b`, "GET", matchingRoute(listingId), { cookie: cookies.b });
  const stranger = await call(`${stage}-stranger`, "GET", matchingRoute(listingId), {
    cookie: cookies.giver,
    absolute: `${BASE}/api/v1/communities/community-outside/listings/${listingId}/matching`
  });
  expectStatus(giver, 200, `${stage} 出品者`);
  expectStatus(a, 200, `${stage} 受取人A`);
  expectStatus(b, 200, `${stage} 受取人B`);
  expectStatus(stranger, 403, `${stage} 所属外`);
  if (!JSON.stringify(stranger.body).includes("Active community membership is required")) {
    throw new Error(`${stage} 所属外の本文が想定と違います ${redact(stranger.body)}`);
  }

  const views = { giver: giver.body, a: a.body, b: b.body };
  for (const [name, view] of Object.entries(views)) {
    if (view.listingStatus !== expected.listingStatus) {
      throw new Error(`${stage} ${name} の出品状態が ${view.listingStatus} です（期待 ${expected.listingStatus}）`);
    }
  }
  if (views.giver.viewerRole !== "giver" || views.a.viewerRole !== "applicant" || views.b.viewerRole !== "applicant") {
    throw new Error(`${stage} の役割が想定と違います ${redact(summarizeView(views.giver))} ${redact(summarizeView(views.a))} ${redact(summarizeView(views.b))}`);
  }
  if (pairStatus(views.giver.applications, "applicantId").join() !== expected.applications.join()) {
    throw new Error(`${stage} 出品者の応募が想定と違います ${redact(summarizeView(views.giver))}`);
  }
  if (pairStatus(views.a.applications, "applicantId").join() !== expected.aApplications.join()) {
    throw new Error(`${stage} Aに他人の応募が見えます ${redact(summarizeView(views.a))}`);
  }
  if (pairStatus(views.b.applications, "applicantId").join() !== expected.bApplications.join()) {
    throw new Error(`${stage} Bに他人の応募が見えます ${redact(summarizeView(views.b))}`);
  }
  if (pairStatus(views.giver.handoffs, "receiverId").join() !== expected.handoffs.join()) {
    throw new Error(`${stage} 出品者の受け渡しが想定と違います ${redact(summarizeView(views.giver))}`);
  }
  if (pairStatus(views.a.handoffs, "receiverId").join() !== expected.aHandoffs.join()) {
    throw new Error(`${stage} Aに他人の受け渡しが見えます ${redact(summarizeView(views.a))}`);
  }
  if (pairStatus(views.b.handoffs, "receiverId").join() !== expected.bHandoffs.join()) {
    throw new Error(`${stage} Bに他人の受け渡しが見えます ${redact(summarizeView(views.b))}`);
  }
  return {
    stranger: stranger.status,
    giver: summarizeView(views.giver),
    a: summarizeView(views.a),
    b: summarizeView(views.b),
    bHandoffId: views.b.handoffs.find((item) => item.receiverId === "receiver-b")?.id ?? null
  };
}

async function runFlow(codes) {
  const slot = { startAt: iso(3_600_000), endAt: iso(7_200_000) };
  const listingBody = {
    title: "二人がけソファ",
    description: "卒業のため、同じキャンパスの人へ譲ります。",
    category: "furniture",
    condition: "used_good",
    pickupArea: "デモキャンパス正門",
    pickupSlots: [slot],
    pickupDeadline: iso(7 * 86_400_000)
  };
  const applicationBody = {
    message: "受け取ります",
    availableSlots: [slot],
    transportMode: "walk",
    helperCount: 1
  };

  const health = await call("health", "GET", "/api/v1/health", { absolute: `${BASE}/api/v1/health` });
  expectStatus(health, 200, "health");

  const noAuth = await call("no-auth", "POST", "/listings", { body: listingBody });
  expectStatus(noAuth, 401, "Cookie なし");
  const demo = await call("demo-header", "POST", "/listings", {
    headers: { "x-relay-demo-user": "giver" },
    body: listingBody
  });
  expectStatus(demo, 401, "デモ認証ヘッダー");

  const wrong = await login("login-wrong", "not-a-valid-code");
  expectStatus(wrong, 401, "間違った招待コード");
  const noOrigin = await login("login-no-origin", "not-a-valid-code", { origin: false });
  expectStatus(noOrigin, 403, "Origin なしのログイン");
  const evilOrigin = await login("login-evil-origin", "not-a-valid-code", { origin: "http://evil.example" });
  expectStatus(evilOrigin, 403, "別 Origin のログイン");
  const tooLarge = await call("login-too-large", "POST", "/api/v1/session", {
    absolute: SESSION,
    origin: ORIGIN,
    rawBody: "x".repeat(5000)
  });
  expectStatus(tooLarge, 413, "5000バイトのログイン");

  const giverLogin = await login("login-giver-normalized", disguise(codes.giver));
  expectStatus(giverLogin, 200, "正規化した招待コード");
  assertLocalCookie(giverLogin, "出品者のログイン");
  if (giverLogin.body?.user?.id !== "giver") {
    throw new Error(`正規化ログインの利用者が想定と違います ${redact(giverLogin.body)}`);
  }
  const cookies = { giver: giverLogin.cookie };

  const writeNoOrigin = await call("write-no-origin", "POST", "/listings", {
    cookie: cookies.giver,
    origin: false,
    body: listingBody
  });
  expectStatus(writeNoOrigin, 403, "Origin なしの書き込み");
  const readNoOrigin = await call("read-no-origin", "GET", "/listings?status=OPEN", { cookie: cookies.giver });
  expectStatus(readNoOrigin, 200, "Origin なしの読み取り");

  const traversalMatching = await call("traversal-matching", "GET", "/listings/traversal/matching", {
    cookie: cookies.giver,
    absolute: `${PREFIX}/listings/..%2F..%2Fhandoffs%2Fother/matching`
  });
  const traversalListing = await call("traversal-listing", "GET", "/listings/traversal", {
    cookie: cookies.giver,
    absolute: `${PREFIX}/listings/..%2F..%2Fhandoffs%2Fother`
  });
  for (const record of [traversalMatching, traversalListing]) {
    if (record.status === 200) {
      throw new Error(`${record.step}: パスをずらした GET が 200 を返しました ${redact(record.body)}`);
    }
    if (![400, 403, 404].includes(record.status)) {
      throw new Error(`${record.step}: 想定外の HTTP ${record.status} ${redact(record.body)}`);
    }
  }

  const loginA = await login("login-a", codes.a);
  const loginB = await login("login-b", codes.b);
  expectStatus(loginA, 200, "受取人Aのログイン");
  expectStatus(loginB, 200, "受取人Bのログイン");
  assertLocalCookie(loginA, "受取人Aのログイン");
  assertLocalCookie(loginB, "受取人Bのログイン");
  cookies.a = loginA.cookie;
  cookies.b = loginB.cookie;
  for (const [step, cookie, id] of [
    ["session-giver", cookies.giver, "giver"],
    ["session-a", cookies.a, "receiver-a"],
    ["session-b", cookies.b, "receiver-b"]
  ]) {
    const session = await call(step, "GET", "/api/v1/session", { absolute: SESSION, cookie });
    expectStatus(session, 200, step);
    if (session.body?.user?.id !== id) {
      throw new Error(`${step} の利用者が想定と違います ${redact(session.body)}`);
    }
  }

  const created = await call("create", "POST", "/listings", { cookie: cookies.giver, body: listingBody });
  expectStatus(created, 201, "出品");
  if (created.body?.status !== "OPEN" || typeof created.body?.id !== "string") {
    throw new Error(`出品の応答が想定と違います ${redact(created.body)}`);
  }
  const listingId = created.body.id;

  let sawMatching404 = false;
  const readyDeadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const matching = await call("wait-matching", "GET", matchingRoute(listingId), { cookie: cookies.giver });
    if (matching.status === 404) sawMatching404 = true;
    else if (matching.status === 200 && matching.body?.viewerRole === "giver" && matching.body?.applications?.length === 0) {
      ready = true;
      break;
    } else {
      throw new Error(`出品の反映待ちが想定外です HTTP ${matching.status} ${redact(matching.body)}`);
    }
    await sleep(1000);
  }
  if (!ready) throw new Error("出品が Matching に 45 秒以内で反映されませんでした");

  const appliedA = await call("apply-a", "POST", `/listings/${listingId}/applications`, {
    cookie: cookies.a,
    body: applicationBody
  });
  expectStatus(appliedA, 201, "Aの応募");
  const duplicate = await call("apply-a-again", "POST", `/listings/${listingId}/applications`, {
    cookie: cookies.a,
    body: applicationBody
  });
  expectStatus(duplicate, 409, "Aの二重応募");
  if (duplicate.body?.error !== "DUPLICATE_APPLICATION") {
    throw new Error(`二重応募のエラーコードが違います ${redact(duplicate.body)}`);
  }
  const appliedB = await call("apply-b", "POST", `/listings/${listingId}/applications`, {
    cookie: cookies.b,
    body: applicationBody
  });
  expectStatus(appliedB, 201, "Bの応募");

  const disclosure = [];
  disclosure.push(await checkDisclosure("applied", listingId, cookies, {
    listingStatus: "OPEN",
    applications: ["receiver-a:APPLIED", "receiver-b:APPLIED"],
    aApplications: ["receiver-a:APPLIED"],
    bApplications: ["receiver-b:APPLIED"],
    handoffs: [],
    aHandoffs: [],
    bHandoffs: []
  }));

  const selected = await call("select", "POST", `/listings/${listingId}/selection`, {
    cookie: cookies.giver,
    idempotency: "local-e2e-selection",
    body: {
      selectedApplicationId: appliedA.body.id,
      backupApplicationIds: [appliedB.body.id],
      confirmationExpiresAt: iso(86_400_000)
    }
  });
  expectStatus(selected, 201, "選定");
  if (selected.body?.receiverId !== "receiver-a" || selected.body?.status !== "PROPOSED") {
    throw new Error(`選定結果が想定と違います ${redact(selected.body)}`);
  }
  const replay = await call("select-replay", "POST", `/listings/${listingId}/selection`, {
    cookie: cookies.giver,
    idempotency: "local-e2e-selection",
    body: {
      selectedApplicationId: appliedA.body.id,
      backupApplicationIds: [appliedB.body.id],
      confirmationExpiresAt: iso(86_400_000)
    }
  });
  expectStatus(replay, 200, "同じ Idempotency-Key の再送");
  if (replay.body?.id !== selected.body.id) throw new Error("再送で別の受渡しが返りました");

  disclosure.push(await checkDisclosure("selected", listingId, cookies, {
    listingStatus: "RESERVED",
    applications: ["receiver-a:SELECTED", "receiver-b:BACKUP"],
    aApplications: ["receiver-a:SELECTED"],
    bApplications: ["receiver-b:BACKUP"],
    handoffs: ["receiver-a:PROPOSED"],
    aHandoffs: ["receiver-a:PROPOSED"],
    bHandoffs: []
  }));

  const cancelled = await call("cancel-a", "POST", `/handoffs/${selected.body.id}/cancel`, {
    cookie: cookies.a,
    body: { reason: "declined" }
  });
  expectStatus(cancelled, 200, "Aの辞退");
  const next = cancelled.body?.nextHandoff;
  if (cancelled.body?.cancelledHandoffId !== selected.body.id || next?.receiverId !== "receiver-b" || next?.status !== "PROPOSED") {
    throw new Error(`繰り上げ結果が想定と違います ${redact(cancelled.body)}`);
  }

  const declined = await checkDisclosure("declined", listingId, cookies, {
    listingStatus: "RESERVED",
    applications: ["receiver-a:WITHDRAWN", "receiver-b:SELECTED"],
    aApplications: ["receiver-a:WITHDRAWN"],
    bApplications: ["receiver-b:SELECTED"],
    handoffs: ["receiver-a:CANCELLED", "receiver-b:PROPOSED"],
    aHandoffs: ["receiver-a:CANCELLED"],
    bHandoffs: ["receiver-b:PROPOSED"]
  });
  disclosure.push(declined);
  if (!declined.bHandoffId) throw new Error("Bの照会に自分の受け渡しがありません");
  if (declined.bHandoffId !== next.id) {
    throw new Error("Bの照会で得た受け渡しIDが、辞退応答の nextHandoff と一致しません");
  }

  const wrongComplete = await call("complete-wrong", "POST", `/handoffs/${declined.bHandoffId}/complete`, {
    cookie: cookies.a
  });
  expectStatus(wrongComplete, 403, "関係のない人の完了");
  const completed = await call("complete-b", "POST", `/handoffs/${declined.bHandoffId}/complete`, {
    cookie: cookies.b
  });
  expectStatus(completed, 200, "Bの完了");
  if (completed.body?.status !== "COMPLETED" || completed.body?.receiverId !== "receiver-b") {
    throw new Error(`完了結果が想定と違います ${redact(completed.body)}`);
  }

  disclosure.push(await checkDisclosure("completed", listingId, cookies, {
    listingStatus: "COMPLETED",
    applications: ["receiver-a:WITHDRAWN", "receiver-b:SELECTED"],
    aApplications: ["receiver-a:WITHDRAWN"],
    bApplications: ["receiver-b:SELECTED"],
    handoffs: ["receiver-a:CANCELLED", "receiver-b:COMPLETED"],
    aHandoffs: ["receiver-a:CANCELLED"],
    bHandoffs: ["receiver-b:COMPLETED"]
  }));

  const feedDeadline = Date.now() + 45_000;
  let finalFeed = null;
  while (Date.now() < feedDeadline) {
    const feed = await call("feed-completed", "GET", "/listings?status=COMPLETED", { cookie: cookies.giver });
    const item = feed.body?.items?.find((entry) => entry.id === listingId);
    if (feed.status === 200 && item?.status === "COMPLETED" && item.activeReceiverId === "receiver-b" && item.applicantCount === 2) {
      finalFeed = feed;
      break;
    }
    if (feed.status !== 200) throw new Error(`完了一覧が HTTP ${feed.status} ${redact(feed.body)}`);
    await sleep(1000);
  }
  if (!finalFeed) throw new Error("COMPLETED の一覧に 45 秒以内で反映されませんでした");

  const applications = await call("final-applications", "GET", `/listings/${listingId}/applications`, {
    cookie: cookies.giver
  });
  expectStatus(applications, 200, "最終の応募一覧");
  if (!Array.isArray(applications.body) || applications.body.length !== 2) {
    throw new Error(`応募件数が 2 件ではありません ${redact(applications.body)}`);
  }
  const byApplicant = Object.fromEntries(applications.body.map((item) => [item.applicantId, item.status]));
  if (byApplicant["receiver-a"] !== "WITHDRAWN" || byApplicant["receiver-b"] !== "SELECTED") {
    throw new Error(`応募の状態が想定と違います ${JSON.stringify(byApplicant)}`);
  }

  const handoffs = await readRows(8083, "SELECT receiver_id, status FROM handoffs ORDER BY receiver_id");
  const byReceiver = Object.fromEntries(handoffs.map((row) => [row.receiver_id, row.status]));
  if (byReceiver["receiver-a"] !== "CANCELLED" || byReceiver["receiver-b"] !== "COMPLETED") {
    throw new Error(`受渡しの状態が想定と違います ${JSON.stringify(byReceiver)}`);
  }
  const outbox = [
    ...await readRows(8082, "SELECT event_type, published_at, publish_attempts, last_error FROM outbox_events"),
    ...await readRows(8083, "SELECT event_type, published_at, publish_attempts, last_error FROM outbox_events")
  ];
  if (outbox.length === 0 || outbox.some((row) => row.published_at === null || row.last_error !== null || Number(row.publish_attempts) !== 1)) {
    throw new Error(`Outbox が1回で配信完了していません ${JSON.stringify(outbox)}`);
  }

  const logout = await call("logout", "DELETE", "/api/v1/session", { absolute: SESSION, cookie: cookies.giver });
  expectStatus(logout, 204, "ログアウト");
  const still = await call("logout-still-readable", "GET", "/api/v1/session", {
    absolute: SESSION,
    cookie: cookies.giver
  });

  const rateIp = { "cf-connecting-ip": "203.0.113.77" };
  const rate = [];
  for (let index = 1; index <= 4; index += 1) {
    const failed = await login(`rate-fail-${index}`, "not-a-valid-code", { headers: rateIp });
    expectStatus(failed, 401, `回数制限の失敗 ${index}`);
    rate.push(failed.status);
  }
  const rateSuccess = await login("rate-success", codes.giver, { headers: rateIp });
  expectStatus(rateSuccess, 200, "回数制限の途中の成功");
  rate.push(rateSuccess.status);
  const rateAfter = await login("rate-fail-after-success", "not-a-valid-code", { headers: rateIp });
  expectStatus(rateAfter, 401, "成功のあとの失敗");
  rate.push(rateAfter.status);
  const blocked = await login("rate-blocked", "not-a-valid-code", { headers: rateIp });
  expectStatus(blocked, 429, "回数制限");
  rate.push(blocked.status);
  const otherIp = await login("rate-other-ip", "not-a-valid-code", {
    headers: { "cf-connecting-ip": "203.0.113.78" }
  });
  expectStatus(otherIp, 401, "別IPのログイン");

  return {
    listingId,
    sawMatching404,
    traversal: { matching: traversalMatching.status, listing: traversalListing.status },
    disclosure,
    byApplicant,
    byReceiver,
    outboxEvents: outbox.map((row) => row.event_type),
    feed: finalFeed.body.items.find((entry) => entry.id === listingId),
    logout: {
      status: logout.status,
      clearCookie: /Max-Age=0/.test(logout.cookieFlags),
      oldCookieStatus: still.status
    },
    rateLimit: { sequence: rate, otherIp: otherIp.status }
  };
}

async function readRows(port, sql) {
  const client = createClient({ url: `http://127.0.0.1:${port}` });
  try {
    const result = await client.execute(sql);
    return result.rows.map((row) => ({ ...row }));
  } finally {
    client.close();
  }
}

const QUEUES = [
  "relay-domain-events-dev",
  "relay-listing-commands-dev",
  "relay-matching-commands-dev",
  "relay-read-model-commands-dev",
  "relay-notification-commands-dev"
];

function inspectLog(logText) {
  // eslint-disable-next-line no-control-regex -- ANSIの色指定を取り除くため。
  const plain = logText.replace(/\u001b\[[0-9;]*m/g, "");
  const expected = [
    "Authentication is required",
    "Active community membership is required",
    "Listing is not available in matching service",
    "この出品には応募済みです",
    "Not a participant in this handoff",
    "Scheduled Workers are not automatically triggered",
    "Invalid invite code",
    "Origin is required",
    "Origin is not allowed",
    "Payload too large",
    "Too many login attempts"
  ];
  const notable = plain.split("\n").filter((line) => /error|warn|retry|fail/i.test(line));
  const unexpected = notable.filter((line) => !expected.some((fragment) => line.includes(fragment)));
  const queues = {};
  for (const name of QUEUES) {
    const batches = [...plain.matchAll(new RegExp(`QUEUE ${name} (\\d+)/(\\d+)`, "g"))];
    queues[name] = batches.map((match) => `${match[1]}/${match[2]}`);
    if (batches.length === 0 || batches.some((match) => match[1] !== match[2] || match[1] === "0")) {
      unexpected.push(`キュー ${name} の消費が確認できません: ${queues[name].join(", ") || "ログなし"}`);
    }
  }
  return { queues, unexpected: unexpected.slice(0, 30).map((line) => redact(line)) };
}

async function readLogWhenQueuesAppear(logPath) {
  const deadline = Date.now() + 5000;
  let text = "";
  while (Date.now() < deadline) {
    text = await readFile(logPath, "utf8");
    if (text.includes("QUEUE relay-read-model-commands-dev") && text.includes("QUEUE relay-domain-events-dev")) {
      return text;
    }
    await sleep(200);
  }
  return text;
}

async function boot() {
  await assertPortsFree();
  await resetState();
  const sqld = path.join(process.env.HOME, ".turso", "sqld");
  await access(sqld).catch(() => {
    throw new Error("~/.turso/sqld がありません。sqld（libSQL のサーバー）を、tursodatabase/libsql のリリースから入手して置いてください（scripts/local-e2e/README.md を参照）。");
  });
  for (const database of DATABASES) {
    const started = startLogged(`sqld-${database.name}`, sqld, [
      "--db-path", path.join(RUNTIME, database.name),
      "--http-listen-addr", `127.0.0.1:${database.port}`,
      "--no-welcome"
    ]);
    await waitFor(`http://127.0.0.1:${database.port}/health`, started.child, 15_000);
  }
  await migrate();
  const codes = await writeDevVars();
  const includeWeb = await webWorkerReady();
  const configs = includeWeb ? ["apps/web/wrangler.jsonc", ...WORKER_CONFIGS] : WORKER_CONFIGS;
  const wrangler = path.join(ROOT, "workers/api-gateway/node_modules/wrangler/bin/wrangler.js");
  const startedWrangler = startLogged("wrangler", process.execPath, [
    wrangler, "dev",
    "--local",
    "--no-latest",
    "--ip", "127.0.0.1",
    "--port", "8787",
    "--inspector-port", "9230",
    "--persist-to", STATE_DIR,
    "--show-interactive-dev-session=false",
    "--log-level", "info",
    ...configs.flatMap((config) => ["-c", config])
  ]);
  await waitFor(`${BASE}/api/v1/health`, startedWrangler.child, 90_000);
  if (includeWeb) await waitFor(`${BASE}/`, startedWrangler.child, 30_000);
  return { codes, includeWeb, startedWrangler };
}

async function main() {
  const booted = await boot();
  if (serveMode) {
    await writePrivate(INVITE_FILE, `${JSON.stringify({
      giver: booted.codes.giver,
      "receiver-a": booted.codes.a,
      "receiver-b": booted.codes.b
    }, null, 2)}\n`);
    console.log(`起動した ${BASE}`);
    console.log(`招待コードの置き場所: ${INVITE_FILE}`);
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    return;
  }

  const flow = await runFlow(booted.codes);
  const log = inspectLog(await readLogWhenQueuesAppear(booted.startedWrangler.logPath));
  if (log.unexpected.length > 0) {
    throw new Error(`想定外のログがあります\n${log.unexpected.join("\n")}`);
  }

  const result = {
    label: LABEL,
    ok: true,
    secrets: { count: 4, bytes: SECRET_BYTES },
    webWorker: booted.includeWeb,
    sawMatching404: flow.sawMatching404,
    traversal: flow.traversal,
    disclosure: flow.disclosure,
    applications: flow.byApplicant,
    handoffs: flow.byReceiver,
    outboxEvents: flow.outboxEvents,
    feed: {
      status: flow.feed.status,
      applicantCount: flow.feed.applicantCount,
      activeReceiverId: flow.feed.activeReceiverId
    },
    logout: flow.logout,
    rateLimit: flow.rateLimit,
    queues: log.queues,
    steps: steps.map(({ step, status }) => ({ step, status }))
  };
  await writeFile(path.join(LOG_DIR, `${LABEL}-result.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`RESULT ${JSON.stringify(result)}`);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(redact(message));
  const partial = {
    label: LABEL,
    ok: false,
    steps: steps.map(({ step, status }) => ({ step, status }))
  };
  await mkdir(LOG_DIR, { recursive: true }).catch(() => {});
  await writeFile(path.join(LOG_DIR, `${LABEL}-result.json`), `${JSON.stringify(partial, null, 2)}\n`).catch(() => {});
} finally {
  const leftovers = await stopChildren();
  await removeDevVars();
  const lines = await listenLines();
  console.log(`CLEANUP leftovers=${JSON.stringify(leftovers)} ports=${lines || "free"}`);
  if (leftovers.length > 0 || lines) exitCode = 1;
}
process.exit(exitCode);
