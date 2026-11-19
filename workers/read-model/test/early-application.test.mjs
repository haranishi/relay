import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { createTursoClient } from "@relay/turso";
import worker from "../src/index.ts";

vi.mock("@relay/turso", async (original) => ({ ...await original(), createTursoClient: vi.fn() }));

it("retries an application delivered before publication and counts it exactly once", async () => {
  const db = createClient({ url: "file::memory:" });
  vi.mocked(createTursoClient).mockReturnValue({
    execute: db.execute.bind(db), batch: db.batch.bind(db), close() {}
  });
  try {
    await db.executeMultiple(readFileSync(new URL("../../../db/read-model/0001_initial.sql", import.meta.url), "utf8"));
    const published = {
      eventId: globalThis.crypto.randomUUID(), eventType: "ListingPublished.v1", eventVersion: 1,
      aggregateType: "listing", aggregateId: "listing", aggregateVersion: 1, communityId: "campus",
      occurredAt: new Date().toISOString(), producer: "listing-service",
      correlationId: globalThis.crypto.randomUUID(), causationId: null,
      payload: { listingId: "listing", ownerId: "giver", title: "Desk", description: "Wooden desk",
        category: "furniture", condition: "used_good", pickupArea: "campus", pickupDeadline: "2099-01-01T10:00:00Z" }
    };
    const application = { ...published, eventId: globalThis.crypto.randomUUID(), eventType: "ApplicationSubmitted.v1",
      producer: "matching-service", aggregateType: "application", aggregateId: "application",
      payload: { listingId: "listing", applicantId: "alice" } };
    const deliver = async (body) => {
      const message = { body, ack: vi.fn(), retry: vi.fn() };
      await worker.queue({ messages: [message] }, {});
      return message;
    };
    const early = await deliver(application);
    await deliver(published);
    await deliver(application);
    await deliver(application);
    const feed = (await db.execute("SELECT applicant_count FROM listing_feed")).rows;
    expect(feed[0].applicant_count).toBe(1);
    expect(early.retry).toHaveBeenCalledOnce();
    expect(early.ack).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});
