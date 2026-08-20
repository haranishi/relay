import {
  INTERNAL_AUTH_HEADER,
  cancelHandoffSchema,
  createApplicationSchema,
  decodeAuthContext,
  domainEventSchema,
  selectRecipientsSchema,
  type ApplicationStatus,
  type AuthContext,
  type DomainEvent,
  type HandoffStatus
} from "@relay/contracts";
import {
  DomainError,
  applyForListing,
  cancelAndReoffer,
  confirmAndComplete,
  selectRecipients,
  type DomainClock,
  type MatchingState
} from "@relay/domain";
import {
  createTursoClient,
  expectNumber,
  expectString,
  outboxInsert,
  parseJsonColumn,
  publishPendingOutbox
} from "@relay/turso";
import type { Client, InStatement } from "@libsql/client/web";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

type Variables = { auth: AuthContext };
type AppEnv = { Bindings: Env; Variables: Variables };
const app = new Hono<AppEnv>();
const clock: DomainClock = { now: () => new Date(), id: () => crypto.randomUUID() };

app.use("/internal/*", async (context, next) => {
  if (context.req.path.endsWith("/health")) return next();
  try {
    context.set("auth", decodeAuthContext(context.req.header(INTERNAL_AUTH_HEADER)));
  } catch {
    throw new HTTPException(401, { message: "Missing service authentication" });
  }
  await next();
});

app.get("/internal/health", (context) => context.json({ service: "matching", status: "ok" }));

app.post("/internal/listings/:listingId/applications", async (context) => {
  const auth = context.get("auth");
  const parsed = createApplicationSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "invalid_application", issues: parsed.error.issues }, 400);
  const client = createTursoClient(context.env);
  try {
    const state = await loadState(client, context.req.param("listingId"), auth.communityId);
    const application = applyForListing(state, { applicantId: auth.userId }, clock);
    const event = state.events.at(-1)!;
    await client.batch(
      [
        {
          sql: `
            INSERT INTO applications (
              id, listing_id, community_id, applicant_id, message,
              available_slots_json, transport_mode, helper_count, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'APPLIED', ?)
          `,
          args: [
            application.id,
            state.listingId,
            state.communityId,
            application.applicantId,
            parsed.data.message,
            JSON.stringify(parsed.data.availableSlots),
            parsed.data.transportMode,
            parsed.data.helperCount,
            Date.now()
          ]
        },
        outboxInsert(event)
      ],
      "write"
    );
    context.executionCtx.waitUntil(publishOutbox(context.env));
    return context.json(application, 201);
  } finally {
    client.close();
  }
});

app.get("/internal/listings/:listingId/applications", async (context) => {
  const auth = context.get("auth");
  const client = createTursoClient(context.env);
  try {
    const state = await loadState(client, context.req.param("listingId"), auth.communityId);
    if (state.giverId !== auth.userId) throw new HTTPException(403, { message: "Only the giver can view applicants" });
    const result = await client.execute({
      sql: `
        SELECT id, applicant_id, message, available_slots_json, transport_mode,
               helper_count, status, created_at
        FROM applications WHERE listing_id = ? ORDER BY created_at
      `,
      args: [state.listingId]
    });
    return context.json(
      result.rows.map((row) => ({
        id: expectString(row.id, "id"),
        applicantId: expectString(row.applicant_id, "applicant_id"),
        message: expectString(row.message, "message"),
        availableSlots: parseJsonColumn(row.available_slots_json, "available_slots_json"),
        transportMode: expectString(row.transport_mode, "transport_mode"),
        helperCount: expectNumber(row.helper_count, "helper_count"),
        status: expectString(row.status, "status"),
        createdAt: new Date(expectNumber(row.created_at, "created_at")).toISOString()
      }))
    );
  } finally {
    client.close();
  }
});

app.post("/internal/listings/:listingId/selection", async (context) => {
  const auth = context.get("auth");
  const idempotencyKey = context.req.header("idempotency-key");
  if (!idempotencyKey) return context.json({ error: "idempotency_key_required" }, 400);
  const parsed = selectRecipientsSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "invalid_selection", issues: parsed.error.issues }, 400);
  const client = createTursoClient(context.env);
  try {
    const state = await loadState(client, context.req.param("listingId"), auth.communityId);
    if (state.giverId !== auth.userId) throw new HTTPException(403, { message: "Only the giver can select recipients" });
    const eventCount = state.events.length;
    const handoff = selectRecipients(state, { ...parsed.data, idempotencyKey }, clock);
    if (state.events.length === eventCount) return context.json(handoff);

    const statements: InStatement[] = state.candidates.map((candidate) => ({
      sql: `INSERT INTO selection_candidates (listing_id, application_id, rank, status) VALUES (?, ?, ?, ?)`,
      args: [state.listingId, candidate.applicationId, candidate.rank, candidate.status]
    }));
    statements.push(
      ...state.applications.map((application) => ({
        sql: `UPDATE applications SET status = ? WHERE id = ?`,
        args: [application.status, application.id]
      })),
      handoffInsert(handoff, parsed.data.confirmationExpiresAt),
      {
        sql: `INSERT INTO idempotency_keys (key, resource_id, response_json, created_at) VALUES (?, ?, ?, ?)`,
        args: [idempotencyKey, handoff.id, JSON.stringify(handoff), Date.now()]
      },
      {
        sql: `UPDATE listing_snapshots SET status = 'RESERVED', updated_at = ? WHERE id = ?`,
        args: [Date.now(), state.listingId]
      },
      ...state.events.slice(eventCount).map(outboxInsert)
    );
    await client.batch(statements, "write");
    context.executionCtx.waitUntil(publishOutbox(context.env));
    return context.json(handoff, 201);
  } finally {
    client.close();
  }
});

app.post("/internal/handoffs/:handoffId/cancel", async (context) => {
  const auth = context.get("auth");
  const parsed = cancelHandoffSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "invalid_cancellation" }, 400);
  const client = createTursoClient(context.env);
  try {
    const listingResult = await client.execute({
      sql: `SELECT listing_id FROM handoffs WHERE id = ? LIMIT 1`,
      args: [context.req.param("handoffId")]
    });
    const listingId = expectString(listingResult.rows[0]?.listing_id, "listing_id");
    const state = await loadState(client, listingId, auth.communityId);
    const current = state.handoffs.find((item) => item.id === context.req.param("handoffId"));
    if (!current || (auth.userId !== current.giverId && auth.userId !== current.receiverId)) {
      throw new HTTPException(403, { message: "Not a participant in this handoff" });
    }
    const next = cancelAndReoffer(state, { handoffId: current.id, reason: parsed.data.reason }, clock);
    const statements: InStatement[] = [
      { sql: `UPDATE handoffs SET status = 'CANCELLED', version = ?, updated_at = ? WHERE id = ?`, args: [current.eventVersion, Date.now(), current.id] },
      ...state.candidates.map((candidate) => ({ sql: `UPDATE selection_candidates SET status = ? WHERE listing_id = ? AND application_id = ?`, args: [candidate.status, state.listingId, candidate.applicationId] })),
      ...state.applications.map((application) => ({ sql: `UPDATE applications SET status = ? WHERE id = ?`, args: [application.status, application.id] })),
      { sql: `UPDATE listing_snapshots SET status = ?, updated_at = ? WHERE id = ?`, args: [state.listingStatus, Date.now(), state.listingId] },
      ...state.events.map(outboxInsert)
    ];
    if (next) statements.push(handoffInsert(next, new Date(Date.now() + 86_400_000).toISOString()));
    await client.batch(statements, "write");
    context.executionCtx.waitUntil(publishOutbox(context.env));
    return context.json({ cancelledHandoffId: current.id, nextHandoff: next });
  } finally {
    client.close();
  }
});

app.post("/internal/handoffs/:handoffId/complete", async (context) => {
  const auth = context.get("auth");
  const client = createTursoClient(context.env);
  try {
    const listingResult = await client.execute({ sql: `SELECT listing_id FROM handoffs WHERE id = ? LIMIT 1`, args: [context.req.param("handoffId")] });
    const state = await loadState(
      client,
      expectString(listingResult.rows[0]?.listing_id, "listing_id"),
      auth.communityId
    );
    const handoff = state.handoffs.find((item) => item.id === context.req.param("handoffId"));
    if (!handoff || (auth.userId !== handoff.giverId && auth.userId !== handoff.receiverId)) throw new HTTPException(403, { message: "Not a participant in this handoff" });
    confirmAndComplete(state, handoff.id, clock);
    await client.batch(
      [
        { sql: `UPDATE handoffs SET status = 'COMPLETED', version = ?, updated_at = ? WHERE id = ?`, args: [handoff.eventVersion, Date.now(), handoff.id] },
        { sql: `UPDATE listing_snapshots SET status = 'COMPLETED', updated_at = ? WHERE id = ?`, args: [Date.now(), state.listingId] },
        ...state.events.map(outboxInsert)
      ],
      "write"
    );
    context.executionCtx.waitUntil(publishOutbox(context.env));
    return context.json(handoff);
  } finally {
    client.close();
  }
});

app.onError((error, context) => {
  const status = error instanceof HTTPException ? error.status : error instanceof DomainError ? 409 : 500;
  console.error(JSON.stringify({ service: "matching", path: context.req.path, status, error: String(error) }));
  return context.json({ error: error instanceof DomainError ? error.code : "request_failed", detail: error.message }, status);
});

async function loadState(client: Client, listingId: string, communityId: string): Promise<MatchingState> {
  const [listing, applications, candidates, handoffs, idempotency] = await Promise.all([
    client.execute({ sql: `SELECT owner_id, status FROM listing_snapshots WHERE id = ? AND community_id = ? LIMIT 1`, args: [listingId, communityId] }),
    client.execute({ sql: `SELECT id, applicant_id, status FROM applications WHERE listing_id = ?`, args: [listingId] }),
    client.execute({ sql: `SELECT application_id, rank, status FROM selection_candidates WHERE listing_id = ?`, args: [listingId] }),
    client.execute({ sql: `SELECT id, application_id, giver_id, receiver_id, status, version FROM handoffs WHERE listing_id = ?`, args: [listingId] }),
    client.execute(`SELECT key, resource_id FROM idempotency_keys`)
  ]);
  const row = listing.rows[0];
  if (!row) throw new HTTPException(404, { message: "Listing is not available in matching service" });
  return {
    listingId,
    communityId,
    giverId: expectString(row.owner_id, "owner_id"),
    listingStatus: expectString(row.status, "status") as MatchingState["listingStatus"],
    applications: applications.rows.map((item) => ({
      id: expectString(item.id, "application.id"),
      listingId,
      applicantId: expectString(item.applicant_id, "application.applicant_id"),
      status: expectString(item.status, "application.status") as ApplicationStatus
    })),
    candidates: candidates.rows.map((item) => ({
      applicationId: expectString(item.application_id, "candidate.application_id"),
      rank: expectNumber(item.rank, "candidate.rank"),
      status: expectString(item.status, "candidate.status") as "waiting" | "offered" | "accepted" | "skipped"
    })),
    handoffs: handoffs.rows.map((item) => ({
      id: expectString(item.id, "handoff.id"),
      listingId,
      applicationId: expectString(item.application_id, "handoff.application_id"),
      giverId: expectString(item.giver_id, "handoff.giver_id"),
      receiverId: expectString(item.receiver_id, "handoff.receiver_id"),
      status: expectString(item.status, "handoff.status") as HandoffStatus,
      eventVersion: expectNumber(item.version, "handoff.version")
    })),
    events: [],
    idempotency: new Map(
      idempotency.rows.map((item) => [
        expectString(item.key, "idempotency.key"),
        expectString(item.resource_id, "idempotency.resource_id")
      ])
    )
  };
}

function handoffInsert(handoff: MatchingState["handoffs"][number], expiresAt: string): InStatement {
  return {
    sql: `INSERT INTO handoffs (id, listing_id, application_id, giver_id, receiver_id, status, confirmation_expires_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [handoff.id, handoff.listingId, handoff.applicationId, handoff.giverId, handoff.receiverId, handoff.status, Date.parse(expiresAt), handoff.eventVersion, Date.now(), Date.now()]
  };
}

async function publishOutbox(env: Env): Promise<void> {
  await publishPendingOutbox(env, (event) => env.DOMAIN_EVENTS.send(event));
}

async function projectListing(env: Env, event: DomainEvent): Promise<void> {
  if (event.eventType !== "ListingPublished.v1") return;
  const client = createTursoClient(env);
  try {
    await client.execute({
      sql: `INSERT INTO listing_snapshots (id, community_id, owner_id, status, updated_at) VALUES (?, ?, ?, 'OPEN', ?) ON CONFLICT(id) DO UPDATE SET status = 'OPEN', updated_at = excluded.updated_at`,
      args: [event.aggregateId, event.communityId, expectString(event.payload.ownerId, "payload.ownerId"), Date.now()]
    });
  } finally {
    client.close();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { return app.fetch(request, env, ctx); },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(publishOutbox(env)); },
  async queue(batch: MessageBatch<DomainEvent>, env: Env) {
    for (const message of batch.messages) {
      try { await projectListing(env, domainEventSchema.parse(message.body)); message.ack(); }
      catch (error) { console.error(JSON.stringify({ service: "matching", messageId: message.id, error: String(error) })); message.retry({ delaySeconds: 10 }); }
    }
  }
} satisfies ExportedHandler<Env, DomainEvent>;
