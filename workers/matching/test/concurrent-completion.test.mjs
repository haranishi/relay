import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeAuthContext, INTERNAL_AUTH_HEADER } from "@relay/contracts";
import worker from "../src/index.ts";

vi.mock("@relay/turso", async (original) => ({
  ...await original(),
  createTursoClient: (env) => {
    const client = createClient({ url: env.TURSO_DATABASE_URL });
    if (env.beforeBatch) {
      const batch = client.batch.bind(client);
      client.batch = async (statements, mode) => {
        await env.beforeBatch(statements);
        return batch(statements, mode);
      };
    }
    return client;
  },
  publishPendingOutbox: () => Promise.resolve(0)
}));

let dir, env, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-matching-"));
  env = { TURSO_DATABASE_URL: `file:${dir}/matching.db` };
  db = createClient({ url: env.TURSO_DATABASE_URL });
});

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

async function prepareHandoff() {
  await migrate();
  await db.executeMultiple(`
    INSERT INTO listing_snapshots (id, community_id, owner_id, status, updated_at) VALUES ('listing','campus','giver','OPEN',0);
    INSERT INTO applications VALUES
      ('a','listing','campus','alice','','[]','walk',0,'APPLIED',0),
      ('b','listing','campus','bob','','[]','walk',0,'APPLIED',0);
  `);
  const selected = await select("a", "first");
  expect(selected.status).toBe(201);
  return (await selected.json()).id;
}

it("commits one completion and one event for concurrent completion requests", async () => {
  const id = await prepareHandoff();
  const path = `handoffs/${id}/complete`;
  const responses = await Promise.all([post(path), post(path)]);
  const statuses = responses.map((response) => response.status).sort();
  const events = await db.execute("SELECT event_id FROM outbox_events WHERE event_type = 'HandoffCompleted.v1'");
  expect({ statuses, events: events.rows.length }).toEqual({ statuses: [200, 409], events: 1 });
});

it("does not reopen a handoff completed while its cancellation was in flight", async () => {
  const id = await prepareHandoff();
  const paused = Promise.withResolvers();
  const resume = Promise.withResolvers();
  env.beforeBatch = async (statements) => {
    if (statements.some(({ sql }) => sql.includes("UPDATE handoffs SET status = 'CANCELLED'"))) {
      paused.resolve();
      await resume.promise;
    }
  };
  const cancel = post(`handoffs/${id}/cancel`, { reason: "declined" });
  await paused.promise;
  const completed = await post(`handoffs/${id}/complete`);
  resume.resolve();
  const cancelled = await cancel;
  const listing = (await db.execute("SELECT status FROM listing_snapshots")).rows[0].status;
  const decisions = (await db.execute(`SELECT event_type FROM outbox_events WHERE event_type IN
    ('HandoffCompleted.v1','HandoffCancelled.v1','ListingReopened.v1') ORDER BY rowid`)).rows;
  expect({ complete: completed.status, cancel: cancelled.status, listing, decisions: decisions.map(r => r.event_type) })
    .toEqual({ complete: 200, cancel: 409, listing: "COMPLETED", decisions: ["HandoffCompleted.v1"] });
});
