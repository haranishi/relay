export const pilotCommunityPath = "/api/v1/communities/community-campus-demo";
const sessionPath = "/api/v1/session";
const listingsPath = `${pilotCommunityPath}/listings`;

export type PilotUser = { id: string; displayName: string };
type PilotSession = { user: PilotUser; expiresAt: string };

export type PickupSlot = { startAt: string; endAt: string };
export type ListingStatus = "DRAFT" | "OPEN" | "RESERVED" | "COMPLETED" | "EXPIRED" | "CANCELLED";
export type ListingSummary = { id: string; title: string; updatedAt: string };
export type Listing = {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  category: string;
  condition: string;
  pickupArea: string;
  pickupSlots: PickupSlot[];
  pickupDeadline: string;
  logistics: {
    dimensionsCm?: { width: number; depth: number; height: number };
    floor?: number;
    hasElevator?: boolean;
    helpersRequired?: number;
  };
  status: ListingStatus;
};

export type TransportMode = "walk" | "bicycle" | "car" | "other";
export type ApplicationInput = {
  message: string;
  availableSlots: PickupSlot[];
  transportMode: TransportMode;
  helperCount: number;
};
export type Application = ApplicationInput & {
  id: string;
  applicantId: string;
  status: "APPLIED" | "SELECTED" | "BACKUP" | "REJECTED" | "WITHDRAWN" | "EXPIRED";
  createdAt: string;
};
export type Handoff = {
  id: string;
  applicationId: string;
  receiverId: string;
  status: "PROPOSED" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
  confirmationExpiresAt: string;
};
export type MatchingView = {
  listingStatus: ListingStatus;
  viewerRole: "giver" | "applicant" | "none";
  applications: Application[];
  handoffs: Handoff[];
};

export type ListingInput = Pick<Listing, "title" | "description" | "pickupArea" | "pickupSlots" | "pickupDeadline">
  & Listing["logistics"] & { category: "furniture"; condition: "used_visible_wear" };
export type SelectionInput = {
  selectedApplicationId: string;
  backupApplicationIds: string[];
  confirmationExpiresAt: string;
};

export class PilotApiError extends Error {
  constructor(readonly status: number, readonly code?: string, readonly detail?: string) {
    super("Pilot API request failed");
  }
}

type RequestOptions = {
  method?: "POST" | "DELETE";
  body?: object;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

async function request(path: string, options: RequestOptions): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  if (options.body) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: options.body ? JSON.stringify(options.body) : null,
      signal: options.signal ?? null
    });
  } catch {
    throw new PilotApiError(0);
  }
  if (!response.ok) {
    const problem: unknown = await response.json().catch(() => null);
    const data = problem && typeof problem === "object" ? problem as Record<string, unknown> : {};
    const code = typeof data.code === "string" ? data.code : data.error;
    throw new PilotApiError(
      response.status,
      typeof code === "string" ? code : undefined,
      typeof data.detail === "string" ? data.detail : undefined
    );
  }
  return response;
}

async function readJson<T>(path: string, options: RequestOptions): Promise<T> {
  const response = await request(path, options);
  try {
    return await response.json<T>();
  } catch {
    throw new PilotApiError(502);
  }
}

async function listListings(signal: AbortSignal): Promise<ListingSummary[]> {
  // 一覧には状態ごとの絞り込みがある。完了後の読み直しにも同じ出品を出す。
  const lists = await Promise.all(["", "?status=RESERVED", "?status=COMPLETED"].map((query) =>
    readJson<{ items: ListingSummary[] }>(listingsPath + query, { signal })
  ));
  const entries = lists.flatMap(({ items }) => items)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  const unique = new Map<string, ListingSummary>();
  for (const { id, title, updatedAt } of entries) {
    if (!unique.has(id)) unique.set(id, { id, title, updatedAt });
  }
  return [...unique.values()];
}

export const pilotApi = {
  session: (signal: AbortSignal) => readJson<PilotSession>(sessionPath, { signal }),
  login: (code: string) => readJson<PilotSession>(sessionPath, { method: "POST", body: { code } }),
  async logout() {
    await request(sessionPath, { method: "DELETE" });
  },
  listListings,
  listing: (id: string, signal: AbortSignal) =>
    readJson<Listing>(`${listingsPath}/${encodeURIComponent(id)}`, { signal }),
  matching: (id: string, signal: AbortSignal) =>
    readJson<MatchingView>(`${listingsPath}/${encodeURIComponent(id)}/matching`, { signal }),
  createListing: (body: ListingInput) =>
    readJson<{ id: string }>(listingsPath, { method: "POST", body }),
  async apply(id: string, body: ApplicationInput) {
    await request(`${listingsPath}/${encodeURIComponent(id)}/applications`, { method: "POST", body });
  },
  async select(id: string, body: SelectionInput, idempotencyKey: string) {
    await request(`${listingsPath}/${encodeURIComponent(id)}/selection`, { method: "POST", body, idempotencyKey });
  },
  async decline(id: string) {
    await request(`${pilotCommunityPath}/handoffs/${encodeURIComponent(id)}/cancel`, {
      method: "POST", body: { reason: "declined" }
    });
  },
  async complete(id: string) {
    await request(`${pilotCommunityPath}/handoffs/${encodeURIComponent(id)}/complete`, { method: "POST" });
  }
};
