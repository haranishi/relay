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

async function migrate() {
  const migrations = new URL("../../../db/matching/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    await db.executeMultiple(readFileSync(new URL(file, migrations), "utf8"));
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
function select(application, key) {
  return post("listings/listing/selection", {
    selectedApplicationId: application, backupApplicationIds: [],
    confirmationExpiresAt: "2099-03-10T12:00:00Z"
  }, key);
}

it("lets a new recipient take the first rank after the only candidate declines", async () => {
  await migrate();
  await db.executeMultiple(`
    INSERT INTO listing_snapshots (id, community_id, owner_id, status, updated_at) VALUES ('listing','campus','giver','OPEN',0);
    INSERT INTO applications VALUES
      ('a','listing','campus','alice','','[]','walk',0,'APPLIED',0),
      ('b','listing','campus','bob','','[]','walk',0,'APPLIED',0);
  `);
  const first = await select("a", "first");
  expect(first.status).toBe(201);
  const cancelled = await post(`handoffs/${(await first.json()).id}/cancel`, { reason: "declined" });
  expect(cancelled.status).toBe(200);
  const next = await select("b", "second");
  expect(next.status).toBe(201);
  expect((await next.json()).receiverId).toBe("bob");
  expect((await db.execute("SELECT status FROM handoffs ORDER BY rowid")).rows.map((r) => r.status))
    .toEqual(["CANCELLED", "PROPOSED"]);
});
