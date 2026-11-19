import { expect, it } from "vitest";
import { applyForListing, confirmAndComplete, createMatchingState, selectRecipients } from "../src/index.js";

it("keeps a completed listing closed while allowing the original selection to be retried", () => {
  const state = createMatchingState({ listingId: "listing", communityId: "campus", giverId: "giver" });
  const clock = { id: () => crypto.randomUUID(), now: () => new Date("2027-03-01T00:00:00Z") };
  const a = applyForListing(state, { applicantId: "alice" }, clock);
  const b = applyForListing(state, { applicantId: "bob" }, clock);
  const selection = { selectedApplicationId: a.id, backupApplicationIds: [],
    confirmationExpiresAt: "2027-03-02T00:00:00Z", idempotencyKey: "first" };
  const first = selectRecipients(state, selection, clock);
  confirmAndComplete(state, first.id, clock);
  expect(selectRecipients(state, selection, clock).id).toBe(first.id);
  expect(() => selectRecipients(state, { ...selection, selectedApplicationId: b.id, idempotencyKey: "second" }, clock))
    .toThrow("受渡しが完了");
  expect(state.listingStatus).toBe("COMPLETED");
  expect(state.handoffs).toHaveLength(1);
});
