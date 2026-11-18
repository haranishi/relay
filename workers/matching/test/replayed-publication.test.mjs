import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { createTursoClient } from "@relay/turso";
import worker from "../src/index.ts";

vi.mock("@relay/turso", async (original) => ({ ...await original(), createTursoClient: vi.fn() }));

it("preserves the matching status when publication is delivered again", async () => {
  const db = createClient({ url: "file::memory:" });
  vi.mocked(createTursoClient).mockReturnValue({ execute: db.execute.bind(db), close() {} });
  try {
    await db.executeMultiple(readFileSync(new URL("../../../db/matching/0001_initial.sql", import.meta.url), "utf8"));
    const message = {
      body: {
        eventId: globalThis.crypto.randomUUID(), eventType: "ListingPublished.v1", eventVersion: 1,
        aggregateType: "listing", aggregateId: "listing", aggregateVersion: 1, communityId: "campus",
        occurredAt: new Date().toISOString(), producer: "listing-service",
        correlationId: globalThis.crypto.randomUUID(), causationId: null, payload: { ownerId: "giver" }
      },
      ack: vi.fn(), retry: vi.fn()
    };
    const deliver = () => worker.queue({ messages: [message] }, {});
    await deliver();
    for (const status of ["OPEN", "RESERVED", "COMPLETED"]) {
      await db.execute({ sql: "UPDATE listing_snapshots SET status = ? WHERE id = 'listing'", args: [status] });
      await deliver();
      const row = (await db.execute("SELECT status FROM listing_snapshots")).rows[0];
      expect(row.status).toBe(status);
    }
    expect(message.ack).toHaveBeenCalledTimes(4);
    expect(message.retry).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});
