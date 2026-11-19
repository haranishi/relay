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
  env = {
    TURSO_DATABASE_URL: `file:${dir}/matching.db`,
    LISTING_SERVICE: { fetch: () => globalThis.Response.json({ pickupDeadline: "2099-04-01T00:00:00Z" }) }
  };
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

function post(path, body, key, userId = "giver") {
  const headers = {
    "content-type": "application/json",
    [INTERNAL_AUTH_HEADER]: encodeAuthContext({
      requestId: globalThis.crypto.randomUUID(), communityId: "campus", userId,
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

it("does not accept an in-flight application after another candidate is selected", async () => {
  await migrate();
  await db.executeMultiple(`
    INSERT INTO listing_snapshots (id, community_id, owner_id, status, updated_at) VALUES ('listing','campus','giver','OPEN',0);
    INSERT INTO applications VALUES ('a','listing','campus','alice','','[]','walk',0,'APPLIED',0);
  `);
  const paused = Promise.withResolvers();
  const resume = Promise.withResolvers();
  env.beforeBatch = async (statements) => {
    if (statements.some(({ sql }) => sql.includes("INSERT INTO applications"))) {
      paused.resolve();
      await resume.promise;
    }
  };
  const pending = post("listings/listing/applications", {
    message: "", availableSlots: [{ startAt: "2099-03-01T08:00:00Z", endAt: "2099-03-01T09:00:00Z" }],
    transportMode: "walk", helperCount: 0
  }, undefined, "bob");
  await paused.promise;
  const selected = await select("a", "first");
  resume.resolve();
  const application = await pending;
  const applicants = (await db.execute("SELECT applicant_id FROM applications ORDER BY rowid")).rows;
  expect({ selected: selected.status, applied: application.status, applicants: applicants.map(r => r.applicant_id) })
    .toEqual({ selected: 201, applied: 409, applicants: ["alice"] });
  expect((await db.execute("SELECT event_id FROM outbox_events WHERE event_type = 'ApplicationSubmitted.v1'")).rows).toHaveLength(0);
});
