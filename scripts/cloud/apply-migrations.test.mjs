import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL, pathToFileURL } from "node:url";

import { main } from "./apply-migrations.mjs";

const require = createRequire(new URL("../../packages/turso/package.json", import.meta.url));
const { createClient } = require("@libsql/client");

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "relay-migrations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function database(t, dir, name) {
  const url = pathToFileURL(join(dir, `${name}.db`)).href;
  const client = createClient({ url });
  t.after(() => client.close());
  return { client, env: { TURSO_DATABASE_URL: url } };
}

async function ledger(client) {
  return (await client.execute("SELECT file, applied_at FROM _relay_migrations ORDER BY rowid")).rows;
}

test("既定と --list は資格情報を読まず、デモデータは指定時だけ末尾に並べる", async () => {
  const env = new Proxy({}, { get: () => assert.fail("資格情報を参照しました") });
  const logs = [];
  const log = (line) => logs.push(line);
  await main(["community"], { env, log });
  assert.deepEqual(logs.splice(0), ["0001_initial.sql"]);
  await main(["community", "--demo-seed", "--list"], { env, log });
  assert.deepEqual(logs, ["0001_initial.sql", "demo_seed.sql"]);
});

test("4つのDBの全移行を番号順に適用し、2回目は台帳もDBも変更しない", async (t) => {
  const dir = await workspace(t);
  for (const [name, files] of Object.entries({
    community: ["0001_initial.sql", "demo_seed.sql"],
    listing: ["0001_initial.sql", "0002_matching_revision.sql"],
    matching: ["0001_initial.sql", "0002_handoff_transition.sql", "0003_listing_keys.sql", "0004_application_open.sql"],
    "read-model": ["0001_initial.sql", "0002_matching_revision.sql"]
  })) {
    const { client, env } = database(t, dir, name);
    const args = name === "community" ? [name, "--apply", "--demo-seed"] : [name, "--apply"];
    const logs = [];
    const log = (line) => logs.push(line);
    await main(args, { env, log });
    const entries = await ledger(client);
    assert.deepEqual(entries.map((row) => row.file), files);
    assert.ok(entries.every((row) => Number.isInteger(row.applied_at)));
    assert.deepEqual(logs.splice(0), files.map((file) => `${file} 適用済み`));

    await main(args, { env, log });
    assert.deepEqual(logs, files.map((file) => `${file} スキップ`));
    assert.deepEqual(await ledger(client), entries);
    if (name === "community") {
      const result = await client.execute("SELECT user_id FROM memberships ORDER BY user_id");
      assert.deepEqual(result.rows.map((row) => row.user_id), ["giver", "receiver-a", "receiver-b"]);
    }
    if (name === "matching") {
      const triggers = await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
      assert.deepEqual(triggers.rows.map((row) => row.name), ["prevent_closed_handoff_transition", "require_open_listing_for_application"]);
    }
  }
});

test("不正なSQLで途中の書き込みを取り消し、成功済みの台帳を残す", async (t) => {
  const root = await workspace(t);
  const directory = join(root, "listing");
  await mkdir(directory);
  const broken = join(directory, "0002_broken.sql");
  await writeFile(join(directory, "0001_initial.sql"), "CREATE TABLE items (name TEXT); INSERT INTO items VALUES ('first');");
  await writeFile(broken, "BEGIN IMMEDIATE;\nINSERT INTO items VALUES ('second');\nSELECT * FROM missing_table;\nCOMMIT;\n");
  await writeFile(join(directory, "0003_last.sql"), "INSERT INTO items VALUES ('last');");
  const { client, env } = database(t, root, "listing");
  const run = () => main(["listing", "--apply"], { env, root, log: () => {} });

  await assert.rejects(run(), /0002_broken\.sql .*no such table: missing_table/);
  assert.deepEqual((await ledger(client)).map((row) => row.file), ["0001_initial.sql"]);
  assert.deepEqual((await client.execute("SELECT name FROM items")).rows.map((row) => row.name), ["first"]);

  await writeFile(broken, "INSERT INTO items VALUES ('second');");
  await run();
  assert.deepEqual((await client.execute("SELECT name FROM items ORDER BY rowid")).rows.map((row) => row.name), ["first", "second", "last"]);
});

test("SQLのエラーに混ざった接続先とトークンを伏せる", async (t) => {
  const root = await workspace(t);
  const directory = join(root, "community");
  await mkdir(directory);
  const { client, env } = database(t, root, "community");
  env.TURSO_AUTH_TOKEN = "dummy-migration-token";
  await writeFile(join(directory, "0001_redaction.sql"), `
    CREATE TABLE items (name TEXT);
    CREATE TRIGGER fail_insert BEFORE INSERT ON items BEGIN
      SELECT RAISE(ABORT, 'test SQL error ${env.TURSO_DATABASE_URL} ${env.TURSO_AUTH_TOKEN}');
    END;
    INSERT INTO items VALUES ('dummy');
  `);
  const logs = [];
  await assert.rejects(main(["community", "--apply"], { env, root, log: (line) => logs.push(line) }), (error) => {
    assert.match(error.message, /^0001_redaction\.sql .*test SQL error <redacted> <redacted>$/);
    assert.ok(!error.message.includes(env.TURSO_AUTH_TOKEN));
    assert.ok(!error.message.includes(env.TURSO_DATABASE_URL));
    return true;
  });
  assert.deepEqual(await ledger(client), []);
  assert.deepEqual(logs, []);
});

test("台帳への記録が失敗した場合も移行のSQLを取り消す", async (t) => {
  const root = await workspace(t);
  const directory = join(root, "listing");
  await mkdir(directory);
  await writeFile(join(directory, "0001_initial.sql"), "CREATE TABLE items (name TEXT);");
  const { client, env } = database(t, root, "listing");
  await client.execute("CREATE TABLE _relay_migrations (file TEXT PRIMARY KEY, applied_at INTEGER NOT NULL CHECK (applied_at = 0))");
  await assert.rejects(main(["listing", "--apply"], { env, root, log: () => {} }), /0001_initial\.sql .*CHECK constraint failed/);
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  assert.deepEqual(tables.rows.map((row) => row.name), ["_relay_migrations"]);
  assert.deepEqual(await ledger(client), []);
});
