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
  vi.useRealTimers();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function migrate() {
  const migrations = new URL("../../../db/matching/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    await db.executeMultiple(readFileSync(new URL(file, migrations), "utf8"));
  }
}

function post(path, body) {
  const headers = {
    "content-type": "application/json",
    [INTERNAL_AUTH_HEADER]: encodeAuthContext({
      requestId: globalThis.crypto.randomUUID(), communityId: "campus", userId: "alice",
      membershipId: "member", membershipRole: "member", membershipVersion: 1
    })
  };

  return worker.fetch(
    new globalThis.Request(`https://matching.test/internal/${path}`, {
      method: "POST", headers, body: JSON.stringify(body)
    }), env, { waitUntil() {} }
  );
}
it("accepts applications through the deadline and rejects the next millisecond", async () => {
  await migrate();
  await db.executeMultiple(`INSERT INTO listing_snapshots (id, community_id, owner_id, status, updated_at)
    VALUES ('before','campus','giver','OPEN',0), ('equal','campus','giver','OPEN',0), ('after','campus','giver','OPEN',0)`);
  const deadline = "2027-03-24T18:00:00+09:00";
  env.LISTING_SERVICE = { fetch: () => globalThis.Response.json({ pickupDeadline: deadline }) };
  vi.useFakeTimers({ toFake: ["Date"] });
  const statuses = [];
  for (const [id, offset] of [["before", -1], ["equal", 0], ["after", 1]]) {
    vi.setSystemTime(Date.parse(deadline) + offset);
    statuses.push((await post(`listings/${id}/applications`, {
      message: "", transportMode: "walk", helperCount: 0, availableSlots: [
        { startAt: "2027-03-24T08:00:00Z", endAt: "2027-03-24T09:00:00Z" }
      ]
    })).status);
  }
  expect(statuses).toEqual([201, 201, 409]);
  expect((await db.execute("SELECT id FROM applications")).rows).toHaveLength(2);
  expect((await db.execute("SELECT event_id FROM outbox_events")).rows).toHaveLength(2);
});
