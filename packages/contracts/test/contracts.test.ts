import { describe, expect, it } from "vitest";
import {
  createListingSchema,
  decodeAuthContext,
  encodeAuthContext,
  selectRecipientsSchema
} from "../src/index.js";

describe("contracts", () => {
  it("rejects duplicated primary and backup recipients", () => {
    const result = selectRecipientsSchema.safeParse({
      selectedApplicationId: "application-a",
      backupApplicationIds: ["application-a"],
      confirmationExpiresAt: "2027-03-18T21:00:00+09:00"
    });

    expect(result.success).toBe(false);
  });

  it("round-trips an internal auth context", () => {
    const context = {
      requestId: "019c8db0-6e34-7e44-927f-bb742f54dca9",
      userId: "user-a",
      communityId: "akita-university",
      membershipId: "membership-a",
      membershipRole: "member" as const,
      membershipVersion: 1
    };

    expect(decodeAuthContext(encodeAuthContext(context))).toEqual(context);
  });

  it("rejects pickup slots with reversed times", () => {
    const result = createListingSchema.safeParse({
      title: "ソファ",
      description: "卒業のため譲ります",
      category: "furniture",
      condition: "used_good",
      pickupArea: "手形",
      pickupDeadline: "2027-03-25T21:00:00+09:00",
      pickupSlots: [
        {
          startAt: "2027-03-20T21:00:00+09:00",
          endAt: "2027-03-20T18:00:00+09:00"
        }
      ]
    });

    expect(result.success).toBe(false);
  });
});
