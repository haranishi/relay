import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL, pathToFileURL } from "node:url";

import { main as migrate } from "./apply-migrations.mjs";
import { main } from "./reset-pilot-data.mjs";

const require = createRequire(new URL("../../packages/turso/package.json", import.meta.url));
const { createClient } = require("@libsql/client");
const fixtures = {
  listing: {
    listings: "INSERT INTO listings VALUES ('listing', 'demo', 'giver', 'ソファ', '架空の出品', 'furniture', 'used_good', '正門', '[]', 2, '{}', 'OPEN', 1, 1, 1, 0)",
    outbox_events: "INSERT INTO outbox_events VALUES ('event', 'created', 'listing', 1, 'demo', '{}', 1, NULL, 0, NULL)",
    processed_events: "INSERT INTO processed_events VALUES ('event', 'created', 1)"
  },
  matching: {
    listing_snapshots: "INSERT INTO listing_snapshots VALUES ('listing', 'demo', 'giver', 'OPEN', 1)",
    applications: "INSERT INTO applications VALUES ('application', 'listing', 'demo', 'receiver-a', '応募', '[]', 'walk', 1, 'APPLIED', 1)",
    selection_candidates: "INSERT INTO selection_candidates VALUES ('listing', 'application', 1, 'waiting')",
    handoffs: "INSERT INTO handoffs VALUES ('handoff', 'listing', 'application', 'giver', 'receiver-a', 'PROPOSED', 2, 1, 1, 1)",
    idempotency_keys: "INSERT INTO idempotency_keys VALUES ('listing', 'key', 'handoff', '{}', 1)",
    outbox_events: "INSERT INTO outbox_events VALUES ('event', 'created', 'listing', 1, 'demo', '{}', 1, NULL, 0, NULL)"
  },
  "read-model": {
    listing_feed: "INSERT INTO listing_feed VALUES ('listing', 'demo', 'giver', 'ソファ', '架空の出品', 'furniture', 'used_good', '正門', 2, 'OPEN', 0, NULL, 1, 0)",
    processed_events: "INSERT INTO processed_events VALUES ('event', 'created', 1)"
  }
};

async function database(t, name) {
  const dir = await mkdtemp(join(tmpdir(), "relay-reset-"));
  const url = pathToFileURL(join(dir, `${name}.db`)).href;
  const client = createClient({ url });
  t.after(async () => {
    client.close();
    await rm(dir, { recursive: true, force: true });
  });
  const env = { TURSO_DATABASE_URL: url };
  const seed = name === "community" ? ["--demo-seed"] : [];
  await migrate([name, "--apply", ...seed], { env, log: () => {} });
  for (const sql of Object.values(fixtures[name] ?? {})) await client.execute(sql);
  return { client, env };
}

async function tableSize(client, table) {
  const { rows } = await client.execute(`SELECT count(*) AS count FROM "${table.replaceAll('"', '""')}"`);
  return rows[0].count;
}

test("3つのDBを空にし、移行台帳とスキーマを残す", async (t) => {
  for (const [name, data] of Object.entries(fixtures)) {
    const { client, env } = await database(t, name);
    const tables = Object.keys(data);
    if (name === "listing") {
      // 一覧から見つけた名前で削除し、引用符付きの名前と SQLite の内部テーブルを区別する。
      await client.execute('CREATE TABLE "sqliteXpilot""samples" (id INTEGER PRIMARY KEY AUTOINCREMENT)');
      await client.execute('INSERT INTO "sqliteXpilot""samples" DEFAULT VALUES');
      tables.push('sqliteXpilot"samples');
    }
    const schema = () => client.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
    const ledger = () => client.execute("SELECT file, applied_at FROM _relay_migrations ORDER BY file");
    const beforeSchema = (await schema()).rows;
    const beforeLedger = (await ledger()).rows;
    for (const table of tables) assert.equal(await tableSize(client, table), 1);

    const logs = [];
    await main([name, "--apply"], { env, log: (line) => logs.push(line) });

    for (const table of tables) assert.equal(await tableSize(client, table), 0);
    assert.deepEqual(logs, tables.sort().map((table) => `${table} 1件削除`));
    assert.deepEqual((await schema()).rows, beforeSchema);
    assert.deepEqual((await ledger()).rows, beforeLedger);
    if (name === "listing") assert.equal(await tableSize(client, "sqlite_sequence"), 1);
  }
});

test("community の指定を拒否し、所属を残す", async (t) => {
  const { client, env } = await database(t, "community");
  await assert.rejects(main(["community", "--apply"], { env, log: assert.fail }), /使い方:/);
  assert.equal(await tableSize(client, "memberships"), 3);
});

test("指定と違う接続先に community DB を渡しても所属を残す", async (t) => {
  const { client, env } = await database(t, "community");
  await assert.rejects(main(["listing", "--apply"], { env, log: assert.fail }), /community DB はリセットできません/);
  assert.equal(await tableSize(client, "memberships"), 3);
});

test("--apply がなければ接続情報を読まず、行を削除しない", async (t) => {
  const { client, env } = await database(t, "listing");
  const logs = [];
  const log = (line) => logs.push(line);
  await main(["listing"], { env, log });
  assert.equal(await tableSize(client, "listings"), 1);
  assert.match(logs[0], /listing.*削除.*--apply/);
  const unreadableEnv = new Proxy({}, { get: () => assert.fail("接続情報を参照しました") });
  await main(["listing"], { env: unreadableEnv, log });
});

test("途中で失敗したら削除を取り消し、エラーに接続情報を出さない", async (t) => {
  const { client, env } = await database(t, "listing");
  env.TURSO_AUTH_TOKEN = "dummy-reset-token";
  await client.executeMultiple(`
    CREATE TRIGGER fail_delete BEFORE DELETE ON outbox_events BEGIN
      SELECT RAISE(ABORT, 'test SQL error ${env.TURSO_DATABASE_URL} ${env.TURSO_AUTH_TOKEN}');
    END;
  `);

  const { status, stdout, stderr } = spawnSync(process.execPath,
    [join(import.meta.dirname, "reset-pilot-data.mjs"), "listing", "--apply"],
    { env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.equal(stderr.trim(), "listing DB のリセット結果を確認できませんでした。");
  assert.equal(await tableSize(client, "listings"), 1);
  assert.equal(await tableSize(client, "outbox_events"), 1);
});

test("指定した DB と違う DB に接続していたら、何も消さずに止まる", async (t) => {
  const listing = await database(t, "listing");
  const matching = await database(t, "matching");
  const readModel = await database(t, "read-model");
  const cases = [
    ["matching", listing, "listings"], ["listing", matching, "handoffs"], ["listing", readModel, "listing_feed"],
    ["read-model", matching, "handoffs"]
  ];
  for (const [target, wrong, table] of cases) {
    await assert.rejects(main([target, "--apply"], { env: wrong.env, log: () => {} }), /接続先/);
    assert.ok(await tableSize(wrong.client, table) > 0, `${target} の指定で ${table} が消えた`);
  }
});
