import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { encodeAuthContext, INTERNAL_AUTH_HEADER } from "@relay/contracts";
import worker from "../src/index.ts";

vi.mock("@relay/turso", async (original) => ({
  ...await original(),
  createTursoClient: (env) => createClient({ url: env.TURSO_DATABASE_URL }),
  publishPendingOutbox: () => Promise.resolve(0)
}));

const dir = mkdtempSync(join(tmpdir(), "relay-matching-"));
const env = { TURSO_DATABASE_URL: `file:${dir}/matching.db` };
const db = createClient({ url: env.TURSO_DATABASE_URL });

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function migrate(legacySetup) {
  const migrations = new URL("../../../db/matching/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    await db.executeMultiple(readFileSync(new URL(file, migrations), "utf8"));
    if (file === "0001_initial.sql") await legacySetup();
  }
}

function post(path, body, key) {
  const headers = {
    "content-type": "application/json",
    [INTERNAL_AUTH_HEADER]: encodeAuthContext({
      requestId: globalThis.crypto.randomUUID(), communityId: "campus", userId: "giver",
      membershipId: "member", membershipRole: "member", membershipVersion: 1
    })
  };
  if (key) headers["idempotency-key"] = key;
  return worker.fetch(
    new globalThis.Request(`https://matching.test/internal/${path}`, {
      method: "POST", headers, body: JSON.stringify(body)
    }), env, { waitUntil() {} }
  );
}
it("preserves an old receipt and allows the same client key for another listing", async () => {
  await migrate(() => db.executeMultiple(`
    INSERT INTO listing_snapshots (id, community_id, owner_id, status, updated_at)
      VALUES ('one','campus','giver','RESERVED',0), ('two','campus','giver','OPEN',0);
    INSERT INTO applications VALUES ('a','one','campus','alice','','[]','walk',0,'SELECTED',0),
      ('b','two','campus','bob','','[]','walk',0,'APPLIED',0);
    INSERT INTO handoffs VALUES ('original','one','a','giver','alice','PROPOSED',4070908800000,1,0,0);
    INSERT INTO idempotency_keys VALUES ('select-1','original','{}',0);
  `));
  const select = (listing, application) => post(`listings/${listing}/selection`, {
    selectedApplicationId: application, backupApplicationIds: [], confirmationExpiresAt: "2099-03-01T00:00:00Z"
  }, "select-1");
  const replay = await select("one", "a");
  expect(replay.status).toBe(200);
  expect((await replay.json()).id).toBe("original");
  const other = await select("two", "b");
  expect(other.status).toBe(201);
  const again = await select("two", "b");
  expect(again.status).toBe(200);
  expect((await again.json()).id).toBe((await other.json()).id);
});
