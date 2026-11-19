import console from "node:console";
import { createRequire } from "node:module";
import process from "node:process";
import { URL } from "node:url";

import { CliError, parseCliArgs, runCli } from "./cli.mjs";

const require = createRequire(new URL("../../packages/turso/package.json", import.meta.url));
const databases = ["listing", "matching", "read-model"];
const usage = "使い方: node scripts/cloud/reset-pilot-data.mjs <listing|matching|read-model> [--apply]";

async function resetTables(client) {
  const transaction = await client.transaction("write");
  try {
    await transaction.execute("PRAGMA defer_foreign_keys = ON");
    const { rows } = await transaction.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name != '_relay_migrations' ORDER BY name"
    );
    // 接続先を取り違えた場合も所属を守る。
    if (rows.some(({ name }) => name === "memberships")) {
      throw new CliError("community DB はリセットできません。");
    }
    const deleted = [];
    for (const { name } of rows) {
      const table = `"${name.replaceAll('"', '""')}"`;
      const { rowsAffected } = await transaction.execute(`DELETE FROM ${table}`);
      deleted.push([name, rowsAffected]);
    }
    await transaction.commit();
    return deleted;
  } finally {
    transaction.close();
  }
}

export async function main(args, { env = process.env, log = console.log } = {}) {
  const { values, positionals } = parseCliArgs(args, { apply: { type: "boolean" } }, usage);
  const [database] = positionals;
  if (positionals.length !== 1 || !databases.includes(database)) throw new CliError(usage);
  if (!values.apply) {
    log(`${database} DB の全テーブルの行を削除します。_relay_migrations と SQLite の内部テーブルは対象外です。実行には --apply が必要です。`);
    return;
  }

  const url = env.TURSO_DATABASE_URL;
  const authToken = env.TURSO_AUTH_TOKEN;
  if (!url || !URL.canParse(url) || (!url.startsWith("file:") && !authToken)) {
    throw new CliError("TURSO_DATABASE_URL と TURSO_AUTH_TOKEN を設定してください。");
  }
  const { createClient } = require("@libsql/client");
  let client;
  let deleted;
  try {
    client = createClient({ url, authToken });
    deleted = await resetTables(client);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${database} DB のリセット結果を確認できませんでした。`);
  } finally {
    client?.close();
  }
  for (const [table, count] of deleted) log(`${table} ${count}件削除`);
}

await runCli(import.meta, main);
