import { spawn as spawnChild } from "node:child_process";
import console from "node:console";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { CliError, parseCliArgs, runCli } from "./cli.mjs";
import { gatewaySecrets, readPilotSecrets } from "./pilot-secrets.mjs";

const root = join(import.meta.dirname, "../..");
const dbSecrets = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
const databases = [
  { worker: "community-auth", database: "relay-community-dev", tokenFlags: ["--read-only"] },
  { worker: "listing", database: "relay-listing-dev", tokenFlags: [] },
  { worker: "matching", database: "relay-matching-dev", tokenFlags: [] },
  { worker: "read-model", database: "relay-read-model-dev", tokenFlags: [] }
];
const usage = "使い方: node scripts/cloud/provision-secrets.mjs [--dry-run|--apply] [--secrets <JSONのパス>]";

function runChild(spawn, command, args, { env, input, capture = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: [input ? "pipe" : "ignore", capture ? "pipe" : "ignore", "ignore"]
    });
    let output = "";
    let inputError;
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && !inputError) resolve(output.trim());
      else reject(new Error("子プロセスに失敗しました。"));
    });
    if (input) {
      child.stdin.on("error", (error) => { inputError = error; });
      child.stdin.end(JSON.stringify(input));
    }
  });
}

async function workerStep(worker, step, run) {
  try {
    return await run();
  } catch {
    throw new CliError(`relay-${worker} ${step}に失敗しました。`);
  }
}

export async function main(args, { env = process.env, log = console.log, spawn = spawnChild } = {}) {
  const { values, positionals } = parseCliArgs(args, {
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    secrets: { type: "string" }
  }, usage);
  if (positionals.length > 0 || (values.apply && values["dry-run"])) throw new CliError(usage);
  if (!values.apply) {
    for (const { worker } of databases) log(`relay-${worker} ${dbSecrets.join(" ")}`);
    log(`relay-api-gateway ${gatewaySecrets.join(" ")}`);
    return;
  }

  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!accountId) throw new CliError("CLOUDFLARE_ACCOUNT_ID を設定してください。");
  const gateway = await workerStep("api-gateway", "0600 の Secret ファイルの読み取り", () => readPilotSecrets(values.secrets));

  // ログイン済みの CLI が使う環境だけを渡す。DB や Gateway の秘密値は標準入力に渡す。
  const childEnv = Object.fromEntries(["HOME", "PATH", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]
    .map((key) => [key, env[key]]));
  const wranglerEnv = {
    ...childEnv,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_SEND_METRICS: "false"
  };
  const turso = join(homedir(), ".turso/turso");

  async function getTursoValue(worker, step, command, pattern) {
    return workerStep(worker, step, async () => {
      const value = await runChild(spawn, turso, command, { env: childEnv, capture: true });
      if (!pattern.test(value)) throw new Error("Turso の応答が想定と違います。");
      return value;
    });
  }

  async function upload(worker, input) {
    // Wrangler は各 Worker のワークスペースにインストールされている。
    const command = ["--dir", `workers/${worker}`, "exec", "wrangler", "secret", "bulk", "-c", "wrangler.jsonc"];
    await workerStep(worker, "Secret の登録", () => runChild(spawn, "pnpm", command, { env: wranglerEnv, input }));
    log(`relay-${worker} Secret を登録しました。`);
  }

  for (const { worker, database, tokenFlags } of databases) {
    const url = await getTursoValue(worker, "DB URL の取得", ["db", "show", database, "--url"], /^libsql:\/\/\S+$/);
    const token = await getTursoValue(worker, "DB トークンの発行",
      ["db", "tokens", "create", database, "--expiration", "30d", ...tokenFlags], /^[A-Za-z0-9_.-]+$/);
    await upload(worker, { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token });
  }
  await upload("api-gateway", gateway);
}

await runCli(import.meta, main);
