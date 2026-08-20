import { z } from "zod";

export const listingStatusSchema = z.enum([
  "DRAFT",
  "OPEN",
  "RESERVED",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED"
]);

export const applicationStatusSchema = z.enum([
  "APPLIED",
  "SELECTED",
  "BACKUP",
  "REJECTED",
  "WITHDRAWN",
  "EXPIRED"
]);

export const handoffStatusSchema = z.enum([
  "PROPOSED",
  "CONFIRMED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW"
]);

export const authContextSchema = z.object({
  requestId: z.uuid(),
  userId: z.string().min(1).max(128),
  communityId: z.string().min(1).max(128),
  membershipId: z.string().min(1).max(128),
  membershipRole: z.enum(["member", "moderator", "admin"]),
  membershipVersion: z.int().nonnegative()
});

export const pickupSlotSchema = z
  .object({
    startAt: z.iso.datetime({ offset: true }),
    endAt: z.iso.datetime({ offset: true })
  })
  .refine((slot) => Date.parse(slot.startAt) < Date.parse(slot.endAt), {
    message: "受取時間帯の終了は開始より後にしてください"
  });

export const createListingSchema = z.object({
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(1000),
  category: z.enum(["furniture", "daily_goods", "books", "other"]),
  condition: z.enum(["like_new", "used_good", "used_visible_wear"]),
  pickupArea: z.string().trim().min(1).max(100),
  pickupSlots: z.array(pickupSlotSchema).min(1).max(10),
  pickupDeadline: z.iso.datetime({ offset: true }),
  dimensionsCm: z
    .object({
      width: z.number().positive().max(1000),
      depth: z.number().positive().max(1000),
      height: z.number().positive().max(1000)
    })
    .optional(),
  floor: z.int().min(-5).max(100).optional(),
  hasElevator: z.boolean().optional(),
  helpersRequired: z.int().min(0).max(10).optional()
});

export const createApplicationSchema = z.object({
  message: z.string().trim().max(500).default(""),
  availableSlots: z.array(pickupSlotSchema).min(1).max(10),
  transportMode: z.enum(["walk", "bicycle", "car", "other"]),
  helperCount: z.int().min(0).max(10)
});

export const selectRecipientsSchema = z
  .object({
    selectedApplicationId: z.string().min(1),
    backupApplicationIds: z.array(z.string().min(1)).max(2),
    confirmationExpiresAt: z.iso.datetime({ offset: true })
  })
  .refine(
    (value) => !value.backupApplicationIds.includes(value.selectedApplicationId),
    { message: "第一候補を予備候補へ重複指定できません" }
  )
  .refine(
    (value) => new Set(value.backupApplicationIds).size === value.backupApplicationIds.length,
    { message: "予備候補を重複指定できません" }
  );

export const cancelHandoffSchema = z.object({
  reason: z.enum(["declined", "expired", "giver_cancelled", "no_show"])
});

export const eventTypeSchema = z.enum([
  "ListingPublished.v1",
  "ApplicationSubmitted.v1",
  "RecipientSelected.v1",
  "RecipientReoffered.v1",
  "HandoffCancelled.v1",
  "HandoffCompleted.v1",
  "ListingReopened.v1"
]);

export const domainEventSchema = z.object({
  eventId: z.uuid(),
  eventType: eventTypeSchema,
  eventVersion: z.literal(1),
  aggregateType: z.enum(["listing", "application", "handoff"]),
  aggregateId: z.string().min(1),
  aggregateVersion: z.int().positive(),
  communityId: z.string().min(1),
  occurredAt: z.iso.datetime(),
  producer: z.enum(["listing-service", "matching-service"]),
  correlationId: z.uuid(),
  causationId: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown())
});

export type ListingStatus = z.infer<typeof listingStatusSchema>;
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;
export type AuthContext = z.infer<typeof authContextSchema>;
export type CreateListingInput = z.infer<typeof createListingSchema>;
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type SelectRecipientsInput = z.infer<typeof selectRecipientsSchema>;
export type CancelHandoffInput = z.infer<typeof cancelHandoffSchema>;
export type DomainEvent = z.infer<typeof domainEventSchema>;

export const INTERNAL_AUTH_HEADER = "x-relay-auth-context";

export function encodeAuthContext(context: AuthContext): string {
  return btoa(JSON.stringify(authContextSchema.parse(context)));
}

export function decodeAuthContext(value: string | undefined): AuthContext {
  if (!value) {
    throw new Error("Missing internal auth context");
  }
  return authContextSchema.parse(JSON.parse(atob(value)));
}
