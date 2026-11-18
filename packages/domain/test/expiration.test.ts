import { expect, it } from "vitest";
import { applyForListing, confirmAndComplete, createMatchingState, selectRecipients } from "../src/index.js";

it.each([
  ["2027-03-17T23:59:59.999Z", true],
  ["2027-03-18T00:00:00.000Z", false],
  ["2027-03-18T00:00:00.001Z", false]
] as const)("checks the offer deadline at %s", (confirmationTime, allowed) => {
  let now = new Date("2027-03-01T00:00:00Z");
  const clock = { now: () => now, id: () => crypto.randomUUID() };
  const state = createMatchingState({ listingId: "listing", communityId: "campus", giverId: "giver" });
  const applicant = applyForListing(state, { applicantId: "alice" }, clock);
  const handoff = selectRecipients(state, {
    selectedApplicationId: applicant.id, backupApplicationIds: [], idempotencyKey: "first",
    confirmationExpiresAt: "2027-03-18T09:00:00+09:00"
  }, clock);
  now = new Date(confirmationTime);
  if (allowed) {
    expect(confirmAndComplete(state, handoff.id, clock).status).toBe("COMPLETED");
  } else {
    expect(() => confirmAndComplete(state, handoff.id, clock)).toThrow("承諾期限");
    expect(handoff.status).toBe("PROPOSED");
    expect(state.events.at(-1)?.eventType).toBe("RecipientSelected.v1");
  }
});
