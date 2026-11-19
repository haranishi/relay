import { createClient } from "@libsql/client";
import { readFileSync, readdirSync } from "node:fs";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { createTursoClient } from "@relay/turso";
import { applyForListing, cancelAndReoffer, confirmAndComplete, createMatchingState, selectRecipients }
  from "../../../packages/domain/src/index.ts";
import listingWorker from "../../listing/src/index.ts";
import feedWorker from "../src/index.ts";

vi.mock("@relay/turso", async (original) => ({ ...await original(), createTursoClient: vi.fn() }));

it("keeps the newest recipient and completion when matching events arrive out of order", async () => {
  const detailDb = createClient({ url: "file::memory:" });
  const feedDb = createClient({ url: "file::memory:" });
  vi.mocked(createTursoClient).mockImplementation(({ db }) => ({
    execute: db.execute.bind(db), batch: db.batch.bind(db), close() {}
  }));
  const clock = { now: () => new Date("2027-03-01T00:00:00Z"), id: () => globalThis.crypto.randomUUID() };
  const state = createMatchingState({ listingId: "listing", communityId: "campus", giverId: "giver" });
  const a = applyForListing(state, { applicantId: "alice" }, clock);
  const b = applyForListing(state, { applicantId: "bob" }, clock);
  const primary = selectRecipients(state, {
    selectedApplicationId: a.id, backupApplicationIds: [b.id],
    confirmationExpiresAt: "2027-03-02T00:00:00Z", idempotencyKey: "first"
  }, clock);
  const selected = state.events.at(-1);
  const backup = cancelAndReoffer(state, { handoffId: primary.id, reason: "declined" }, clock);
  const reoffered = state.events.at(-1);
  confirmAndComplete(state, backup.id, clock);
  const completed = state.events.at(-1);
  try {
    for (const [service, db] of [["listing", detailDb], ["read-model", feedDb]]) {
      const dir = new URL(`../../../db/${service}/`, import.meta.url);
      for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
        await db.executeMultiple(readFileSync(new URL(name, dir), "utf8"));
      }
    }
    await detailDb.executeMultiple(`
      INSERT INTO listings (id, community_id, owner_id, title, description, category, condition, pickup_area,
        pickup_slots_json, pickup_deadline, logistics_json, status, version, created_at, updated_at)
        VALUES ('listing','campus','giver','Desk','Wooden','furniture','used_good','campus','[]',0,'{}','OPEN',1,0,0);
    `);
    await feedDb.executeMultiple(`
      INSERT INTO listing_feed (id, community_id, owner_id, title, description, category, condition, pickup_area,
        pickup_deadline, status, updated_at) VALUES ('listing','campus','giver','Desk','Wooden','furniture','used_good','campus',0,'OPEN',0);
    `);
    const deliver = async (worker, body) => {
      const message = { body, ack: vi.fn(), retry: vi.fn() };
      await worker.queue({ messages: [message] }, { db: worker === listingWorker ? detailDb : feedDb });
      expect(message.ack).toHaveBeenCalledOnce();
    };
    // Each consumer receives every event once, with a different delay.
    for (const event of [completed, selected, reoffered]) await deliver(listingWorker, event);
    for (const event of [reoffered, selected]) await deliver(feedWorker, event);
    const detail = (await detailDb.execute("SELECT status FROM listings")).rows[0];
    const feed = (await feedDb.execute("SELECT active_receiver_id FROM listing_feed")).rows[0];
    expect({ detail: detail.status, receiver: feed.active_receiver_id }).toEqual({ detail: "COMPLETED", receiver: "bob" });
    await deliver(feedWorker, completed);
    expect((await feedDb.execute("SELECT status FROM listing_feed")).rows[0].status).toBe("COMPLETED");
  } finally {
    detailDb.close();
    feedDb.close();
  }
});
