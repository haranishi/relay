import { describe, expect, it } from "vitest";
import {
  applyForListing,
  cancelAndReoffer,
  confirmAndComplete,
  createMatchingState,
  DomainError,
  selectRecipients,
  type DomainClock
} from "../src/index.js";

function clock(): DomainClock {
  let sequence = 0;
  return {
    now: () => new Date("2027-03-10T03:00:00.000Z"),
    id: () => `019c8db0-6e34-7e44-927f-${String(++sequence).padStart(12, "0")}`
  };
}

describe("matching domain", () => {
  it("rejects the listing owner and duplicate applications", () => {
    const state = createMatchingState({
      listingId: "listing-1",
      communityId: "community-1",
      giverId: "giver"
    });
    const domainClock = clock();

    expect(() => applyForListing(state, { applicantId: "giver" }, domainClock)).toThrowError(
      DomainError
    );

    applyForListing(state, { applicantId: "receiver-a" }, domainClock);
    expect(() =>
      applyForListing(state, { applicantId: "receiver-a" }, domainClock)
    ).toThrowError(DomainError);
  });

  it("returns the same handoff for a repeated idempotency key", () => {
    const state = createMatchingState({
      listingId: "listing-1",
      communityId: "community-1",
      giverId: "giver"
    });
    const domainClock = clock();
    const primary = applyForListing(state, { applicantId: "receiver-a" }, domainClock);

    const first = selectRecipients(
      state,
      {
        selectedApplicationId: primary.id,
        backupApplicationIds: [],
        confirmationExpiresAt: "2027-03-18T12:00:00.000Z",
        idempotencyKey: "select-1"
      },
      domainClock
    );
    const repeated = selectRecipients(
      state,
      {
        selectedApplicationId: primary.id,
        backupApplicationIds: [],
        confirmationExpiresAt: "2027-03-18T12:00:00.000Z",
        idempotencyKey: "select-1"
      },
      domainClock
    );

    expect(repeated.id).toBe(first.id);
    expect(state.handoffs).toHaveLength(1);
  });

  it("reoffers to the first backup after the primary declines", () => {
    const state = createMatchingState({
      listingId: "listing-1",
      communityId: "community-1",
      giverId: "giver"
    });
    const domainClock = clock();
    const primary = applyForListing(state, { applicantId: "receiver-a" }, domainClock);
    const backup = applyForListing(state, { applicantId: "receiver-b" }, domainClock);
    const firstHandoff = selectRecipients(
      state,
      {
        selectedApplicationId: primary.id,
        backupApplicationIds: [backup.id],
        confirmationExpiresAt: "2027-03-18T12:00:00.000Z",
        idempotencyKey: "select-1"
      },
      domainClock
    );

    const next = cancelAndReoffer(
      state,
      { handoffId: firstHandoff.id, reason: "declined" },
      domainClock
    );

    expect(next?.receiverId).toBe("receiver-b");
    expect(firstHandoff.status).toBe("CANCELLED");
    expect(state.events.at(-1)?.eventType).toBe("RecipientReoffered.v1");
  });

  it("reopens the listing when there is no backup", () => {
    const state = createMatchingState({
      listingId: "listing-1",
      communityId: "community-1",
      giverId: "giver"
    });
    const domainClock = clock();
    const primary = applyForListing(state, { applicantId: "receiver-a" }, domainClock);
    const handoff = selectRecipients(
      state,
      {
        selectedApplicationId: primary.id,
        backupApplicationIds: [],
        confirmationExpiresAt: "2027-03-18T12:00:00.000Z",
        idempotencyKey: "select-1"
      },
      domainClock
    );

    expect(
      cancelAndReoffer(state, { handoffId: handoff.id, reason: "expired" }, domainClock)
    ).toBeNull();
    expect(state.listingStatus).toBe("OPEN");
    expect(state.events.at(-1)?.eventType).toBe("ListingReopened.v1");
  });

  it("completes the handoff and listing", () => {
    const state = createMatchingState({
      listingId: "listing-1",
      communityId: "community-1",
      giverId: "giver"
    });
    const domainClock = clock();
    const primary = applyForListing(state, { applicantId: "receiver-a" }, domainClock);
    const handoff = selectRecipients(
      state,
      {
        selectedApplicationId: primary.id,
        backupApplicationIds: [],
        confirmationExpiresAt: "2027-03-18T12:00:00.000Z",
        idempotencyKey: "select-1"
      },
      domainClock
    );

    confirmAndComplete(state, handoff.id, domainClock);

    expect(handoff.status).toBe("COMPLETED");
    expect(state.listingStatus).toBe("COMPLETED");
    expect(state.events.at(-1)?.eventType).toBe("HandoffCompleted.v1");
  });
});
