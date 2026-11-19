import console from "node:console";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { CliError, parseCliArgs, runCli } from "./cli.mjs";

const dbRoot = join(import.meta.dirname, "../../db");
const require = createRequire(new URL("../../packages/turso/package.json", import.meta.url));
const databases = ["community", "listing", "matching", "read-model"];
const usage = "使い方: node scripts/cloud/apply-migrations.mjs <community|listing|matching|read-model> [--demo-seed] [--list|--dry-run|--apply]";

async function migrationFiles(database, demoSeed, root) {
  if (!databases.includes(database) || (demoSeed && database !== "community")) {
    throw new CliError(usage);
  }
  const files = (await readdir(join(root, database)))
    .filter((file) => /^\d{4}_[\w-]+\.sql$/.test(file))
    .sort();
  if (files.length === 0) throw new CliError("番号付きの移行ファイルがありません。");
  if (demoSeed) files.push("demo_seed.sql");
  return files;
}

function sqlError(error, url, authToken) {
  if (!/^(?:SQLITE_(?:ERROR|CONSTRAINT|BUSY|LOCKED)(?:_[A-Z0-9_]+)?|SQL_INPUT_ERROR)$/.test(error?.code ?? "")) {
    return "DBに接続できないか、処理結果を確認できませんでした。";
  }
  const address = new URL(url);
  const sensitive = [url, authToken, address.hostname];
  if (address.protocol === "file:") sensitive.push(address.pathname);
  let message = error.message;
  for (const value of sensitive) {
    if (value) message = message.replaceAll(value, "<redacted>");
  }
  return message.replace(/\b(?:libsql|https?|wss?|file):\/\/[^\s"']+/gi, "<redacted>")
    .replace(/\s+/g, " ");
}

async function applyFile(client, directory, file) {
  const transaction = await client.transaction("write");
  try {
    const entry = await transaction.execute("SELECT file FROM _relay_migrations WHERE file = ?", [file]);
    if (entry.rows.length > 0) return false;

    const sql = await readFile(join(directory, file), "utf8");
    // 0003 の外側の BEGIN / COMMIT だけを外し、SQL と台帳を一緒に確定する。
    const body = sql.replace(/^\s*BEGIN IMMEDIATE;([\s\S]*)\nCOMMIT;\s*$/i, "$1");
    await transaction.executeMultiple(body);
    await transaction.execute("INSERT INTO _relay_migrations (file, applied_at) VALUES (?, ?)", [file, Date.now()]);
    await transaction.commit();
    return true;
  } finally {
    transaction.close();
  }
}

export async function main(args, { env = process.env, root = dbRoot, log = console.log } = {}) {
  const { values, positionals } = parseCliArgs(args, {
    "demo-seed": { type: "boolean" },
    list: { type: "boolean" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" }
  }, usage);
  if (positionals.length !== 1 || (values.apply && (values.list || values["dry-run"]))) {
    throw new CliError(usage);
  }
  const [database] = positionals;
  const files = await migrationFiles(database, values["demo-seed"], root);
  if (!values.apply) {
    for (const file of files) log(file);
    return;
  }

  const url = env.TURSO_DATABASE_URL;
  const authToken = env.TURSO_AUTH_TOKEN;
  if (!url || !URL.canParse(url) || (!url.startsWith("file:") && !authToken)) {
    throw new CliError("TURSO_DATABASE_URL と TURSO_AUTH_TOKEN を設定してください。");
  }
  const { createClient } = require("@libsql/client");
  let client;
  try {
    client = createClient({ url, authToken });
    await client.execute("CREATE TABLE IF NOT EXISTS _relay_migrations (file TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  } catch (error) {
    client?.close();
    throw new CliError(`_relay_migrations ${sqlError(error, url, authToken)}`);
  }
  try {
    for (const file of files) {
      try {
        const applied = await applyFile(client, join(root, database), file);
        log(`${file} ${applied ? "適用済み" : "スキップ"}`);
      } catch (error) {
        const detail = error?.code === "ENOENT" || error?.code === "EACCES"
          ? "移行ファイルを読み込めませんでした。"
          : sqlError(error, url, authToken);
        throw new CliError(`${file} ${detail}`);
      }
    }
  } finally {
    client.close();
  }
}

await runCli(import.meta, main);
