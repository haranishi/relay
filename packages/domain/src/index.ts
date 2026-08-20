import type {
  ApplicationStatus,
  DomainEvent,
  HandoffStatus,
  SelectRecipientsInput
} from "@relay/contracts";

export class DomainError extends Error {
  constructor(
    readonly code:
      | "LISTING_NOT_OPEN"
      | "OWNER_CANNOT_APPLY"
      | "DUPLICATE_APPLICATION"
      | "APPLICATION_NOT_FOUND"
      | "SELECTION_EXISTS"
      | "HANDOFF_NOT_FOUND"
      | "HANDOFF_NOT_ACTIVE",
    message: string
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export type Application = {
  id: string;
  listingId: string;
  applicantId: string;
  status: ApplicationStatus;
};

export type Candidate = {
  applicationId: string;
  rank: number;
  status: "waiting" | "offered" | "accepted" | "skipped";
};

export type Handoff = {
  id: string;
  listingId: string;
  applicationId: string;
  giverId: string;
  receiverId: string;
  status: HandoffStatus;
  eventVersion: number;
};

export type MatchingState = {
  listingId: string;
  communityId: string;
  giverId: string;
  listingStatus: "OPEN" | "RESERVED" | "COMPLETED";
  applications: Application[];
  candidates: Candidate[];
  handoffs: Handoff[];
  events: DomainEvent[];
  idempotency: Map<string, string>;
};

export type DomainClock = {
  now: () => Date;
  id: () => string;
};

export function createMatchingState(input: {
  listingId: string;
  communityId: string;
  giverId: string;
}): MatchingState {
  return {
    ...input,
    listingStatus: "OPEN",
    applications: [],
    candidates: [],
    handoffs: [],
    events: [],
    idempotency: new Map()
  };
}

export function applyForListing(
  state: MatchingState,
  input: { applicantId: string },
  clock: DomainClock
): Application {
  if (state.listingStatus !== "OPEN") {
    throw new DomainError("LISTING_NOT_OPEN", "募集終了後は応募できません");
  }
  if (input.applicantId === state.giverId) {
    throw new DomainError("OWNER_CANNOT_APPLY", "自分の出品には応募できません");
  }
  if (state.applications.some((item) => item.applicantId === input.applicantId)) {
    throw new DomainError("DUPLICATE_APPLICATION", "この出品には応募済みです");
  }

  const application: Application = {
    id: clock.id(),
    listingId: state.listingId,
    applicantId: input.applicantId,
    status: "APPLIED"
  };
  state.applications.push(application);
  state.events.push(
    makeEvent(state, clock, {
      eventType: "ApplicationSubmitted.v1",
      aggregateType: "application",
      aggregateId: application.id,
      aggregateVersion: 1,
      payload: { listingId: state.listingId, applicantId: application.applicantId }
    })
  );
  return application;
}

export function selectRecipients(
  state: MatchingState,
  input: SelectRecipientsInput & { idempotencyKey: string },
  clock: DomainClock
): Handoff {
  const existingId = state.idempotency.get(input.idempotencyKey);
  if (existingId) {
    const existing = state.handoffs.find((handoff) => handoff.id === existingId);
    if (existing) return existing;
  }
  if (state.handoffs.some((handoff) => isActive(handoff.status))) {
    throw new DomainError("SELECTION_EXISTS", "受取候補は既に選定済みです");
  }

  const selected = findApplication(state, input.selectedApplicationId);
  const backups = input.backupApplicationIds.map((id) => findApplication(state, id));

  state.candidates = [selected, ...backups].map((application, rank) => ({
    applicationId: application.id,
    rank,
    status: rank === 0 ? "offered" : "waiting"
  }));
  selected.status = "SELECTED";
  for (const backup of backups) backup.status = "BACKUP";

  const handoff: Handoff = {
    id: clock.id(),
    listingId: state.listingId,
    applicationId: selected.id,
    giverId: state.giverId,
    receiverId: selected.applicantId,
    status: "PROPOSED",
    eventVersion: 1
  };
  state.handoffs.push(handoff);
  state.listingStatus = "RESERVED";
  state.idempotency.set(input.idempotencyKey, handoff.id);
  state.events.push(
    makeEvent(state, clock, {
      eventType: "RecipientSelected.v1",
      aggregateType: "handoff",
      aggregateId: handoff.id,
      aggregateVersion: 1,
      payload: {
        listingId: state.listingId,
        receiverId: selected.applicantId,
        confirmationExpiresAt: input.confirmationExpiresAt
      }
    })
  );
  return handoff;
}

export function cancelAndReoffer(
  state: MatchingState,
  input: { handoffId: string; reason: "declined" | "expired" | "giver_cancelled" | "no_show" },
  clock: DomainClock
): Handoff | null {
  const current = state.handoffs.find((handoff) => handoff.id === input.handoffId);
  if (!current) throw new DomainError("HANDOFF_NOT_FOUND", "受渡しが見つかりません");
  if (!isActive(current.status)) {
    throw new DomainError("HANDOFF_NOT_ACTIVE", "この受渡しは既に終了しています");
  }

  current.status = "CANCELLED";
  current.eventVersion += 1;
  const currentCandidate = state.candidates.find(
    (candidate) => candidate.applicationId === current.applicationId
  );
  if (currentCandidate) currentCandidate.status = "skipped";
  const currentApplication = state.applications.find(
    (application) => application.id === current.applicationId
  );
  if (currentApplication) {
    currentApplication.status = input.reason === "expired" ? "EXPIRED" : "WITHDRAWN";
  }
  state.events.push(
    makeEvent(state, clock, {
      eventType: "HandoffCancelled.v1",
      aggregateType: "handoff",
      aggregateId: current.id,
      aggregateVersion: current.eventVersion,
      payload: { listingId: state.listingId, reason: input.reason }
    })
  );

  const nextCandidate = state.candidates
    .filter((candidate) => candidate.status === "waiting")
    .sort((left, right) => left.rank - right.rank)[0];

  if (!nextCandidate) {
    state.listingStatus = "OPEN";
    state.events.push(
      makeEvent(state, clock, {
        eventType: "ListingReopened.v1",
        aggregateType: "listing",
        aggregateId: state.listingId,
        aggregateVersion: state.handoffs.length + 1,
        payload: { listingId: state.listingId }
      })
    );
    return null;
  }

  nextCandidate.status = "offered";
  const application = state.applications.find(
    (item) => item.id === nextCandidate.applicationId && item.status === "BACKUP"
  );
  if (!application) {
    throw new DomainError("APPLICATION_NOT_FOUND", "有効な予備候補が見つかりません");
  }
  application.status = "SELECTED";
  const nextHandoff: Handoff = {
    id: clock.id(),
    listingId: state.listingId,
    applicationId: application.id,
    giverId: state.giverId,
    receiverId: application.applicantId,
    status: "PROPOSED",
    eventVersion: 1
  };
  state.handoffs.push(nextHandoff);
  state.events.push(
    makeEvent(state, clock, {
      eventType: "RecipientReoffered.v1",
      aggregateType: "handoff",
      aggregateId: nextHandoff.id,
      aggregateVersion: 1,
      payload: { listingId: state.listingId, receiverId: application.applicantId }
    })
  );
  return nextHandoff;
}

export function confirmAndComplete(
  state: MatchingState,
  handoffId: string,
  clock: DomainClock
): Handoff {
  const handoff = state.handoffs.find((item) => item.id === handoffId);
  if (!handoff) throw new DomainError("HANDOFF_NOT_FOUND", "受渡しが見つかりません");
  if (handoff.status !== "PROPOSED") {
    throw new DomainError("HANDOFF_NOT_ACTIVE", "確認待ちの受渡しではありません");
  }
  handoff.status = "COMPLETED";
  handoff.eventVersion += 1;
  state.listingStatus = "COMPLETED";
  state.events.push(
    makeEvent(state, clock, {
      eventType: "HandoffCompleted.v1",
      aggregateType: "handoff",
      aggregateId: handoff.id,
      aggregateVersion: handoff.eventVersion,
      payload: { listingId: state.listingId, receiverId: handoff.receiverId }
    })
  );
  return handoff;
}

function findApplication(state: MatchingState, id: string): Application {
  const application = state.applications.find((item) => item.id === id);
  if (!application || application.status !== "APPLIED") {
    throw new DomainError("APPLICATION_NOT_FOUND", "有効な応募が見つかりません");
  }
  return application;
}

function isActive(status: HandoffStatus): boolean {
  return status === "PROPOSED" || status === "CONFIRMED";
}

function makeEvent(
  state: MatchingState,
  clock: DomainClock,
  input: Pick<
    DomainEvent,
    "eventType" | "aggregateType" | "aggregateId" | "aggregateVersion" | "payload"
  >
): DomainEvent {
  return {
    eventId: clock.id(),
    eventType: input.eventType,
    eventVersion: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    communityId: state.communityId,
    occurredAt: clock.now().toISOString(),
    producer: "matching-service",
    correlationId: clock.id(),
    causationId: null,
    payload: input.payload
  };
}
