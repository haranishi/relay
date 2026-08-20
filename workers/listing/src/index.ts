import {
  INTERNAL_AUTH_HEADER,
  createListingSchema,
  decodeAuthContext,
  domainEventSchema,
  type AuthContext,
  type DomainEvent
} from "@relay/contracts";
import {
  createTursoClient,
  expectNumber,
  expectString,
  outboxInsert,
  parseJsonColumn,
  publishPendingOutbox
} from "@relay/turso";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

type Variables = { auth: AuthContext };
type AppEnv = { Bindings: Env; Variables: Variables };
const app = new Hono<AppEnv>();

app.use("/internal/*", async (context, next) => {
  if (context.req.path.endsWith("/health")) return next();
  try {
    context.set("auth", decodeAuthContext(context.req.header(INTERNAL_AUTH_HEADER)));
  } catch {
    throw new HTTPException(401, { message: "Missing service authentication" });
  }
  await next();
});

app.get("/internal/health", (context) => context.json({ service: "listing", status: "ok" }));

app.post("/internal/listings", async (context) => {
  const auth = context.get("auth");
  const parsed = createListingSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "invalid_listing", issues: parsed.error.issues }, 400);

  const listingId = crypto.randomUUID();
  const event = listingPublishedEvent(listingId, auth, parsed.data);
  const now = Date.now();
  const client = createTursoClient(context.env);
  try {
    await client.batch(
      [
        {
          sql: `
            INSERT INTO listings (
              id, community_id, owner_id, title, description, category, condition,
              pickup_area, pickup_slots_json, pickup_deadline, logistics_json,
              status, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 1, ?, ?)
          `,
          args: [
            listingId,
            auth.communityId,
            auth.userId,
            parsed.data.title,
            parsed.data.description,
            parsed.data.category,
            parsed.data.condition,
            parsed.data.pickupArea,
            JSON.stringify(parsed.data.pickupSlots),
            Date.parse(parsed.data.pickupDeadline),
            JSON.stringify({
              dimensionsCm: parsed.data.dimensionsCm,
              floor: parsed.data.floor,
              hasElevator: parsed.data.hasElevator,
              helpersRequired: parsed.data.helpersRequired
            }),
            now,
            now
          ]
        },
        outboxInsert(event)
      ],
      "write"
    );
    context.executionCtx.waitUntil(publishOutbox(context.env));
    return context.json({ id: listingId, status: "OPEN", version: 1 }, 201);
  } finally {
    client.close();
  }
});

app.get("/internal/listings/:listingId", async (context) => {
  const auth = context.get("auth");
  const client = createTursoClient(context.env);
  try {
    const result = await client.execute({
      sql: `SELECT * FROM listings WHERE id = ? AND community_id = ? LIMIT 1`,
      args: [context.req.param("listingId"), auth.communityId]
    });
    const row = result.rows[0];
    if (!row) return context.json({ error: "listing_not_found" }, 404);
    return context.json({
      id: expectString(row.id, "id"),
      ownerId: expectString(row.owner_id, "owner_id"),
      title: expectString(row.title, "title"),
      description: expectString(row.description, "description"),
      category: expectString(row.category, "category"),
      condition: expectString(row.condition, "condition"),
      pickupArea: expectString(row.pickup_area, "pickup_area"),
      pickupSlots: parseJsonColumn(row.pickup_slots_json, "pickup_slots_json"),
      pickupDeadline: new Date(expectNumber(row.pickup_deadline, "pickup_deadline")).toISOString(),
      logistics: parseJsonColumn(row.logistics_json, "logistics_json"),
      status: expectString(row.status, "status"),
      version: expectNumber(row.version, "version")
    });
  } finally {
    client.close();
  }
});

app.get("/internal/images/:key", async (context) => {
  const object = await context.env.LISTING_IMAGES.get(context.req.param("key"));
  if (!object) return context.json({ error: "image_not_found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(object.body, { headers });
});

app.onError((error, context) => {
  const status = error instanceof HTTPException ? error.status : 500;
  console.error(JSON.stringify({ service: "listing", path: context.req.path, status, error: String(error) }));
  return context.json({ error: status === 500 ? "internal_error" : error.message }, status);
});

function listingPublishedEvent(
  listingId: string,
  auth: AuthContext,
  listing: ReturnType<typeof createListingSchema.parse>
): DomainEvent {
  return domainEventSchema.parse({
    eventId: crypto.randomUUID(),
    eventType: "ListingPublished.v1",
    eventVersion: 1,
    aggregateType: "listing",
    aggregateId: listingId,
    aggregateVersion: 1,
    communityId: auth.communityId,
    occurredAt: new Date().toISOString(),
    producer: "listing-service",
    correlationId: auth.requestId,
    causationId: null,
    payload: { listingId, ownerId: auth.userId, ...listing }
  });
}

async function publishOutbox(env: Env): Promise<void> {
  await publishPendingOutbox(env, (event) => env.DOMAIN_EVENTS.send(event));
}

async function applyListingCommand(env: Env, event: DomainEvent): Promise<void> {
  if (!["RecipientSelected.v1", "RecipientReoffered.v1", "HandoffCompleted.v1", "ListingReopened.v1"].includes(event.eventType)) return;
  const status = event.eventType === "HandoffCompleted.v1" ? "COMPLETED" : event.eventType === "ListingReopened.v1" ? "OPEN" : "RESERVED";
  const listingId = expectString(event.payload.listingId ?? event.aggregateId, "payload.listingId");
  const client = createTursoClient(env);
  try {
    const alreadyProcessed = await client.execute({
      sql: `SELECT 1 FROM processed_events WHERE event_id = ?`,
      args: [event.eventId]
    });
    if (alreadyProcessed.rows.length > 0) return;
    await client.batch(
      [
        {
          sql: `UPDATE listings SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND community_id = ?`,
          args: [status, Date.now(), listingId, event.communityId]
        },
        {
          sql: `INSERT INTO processed_events (event_id, event_type, processed_at) VALUES (?, ?, ?)`,
          args: [event.eventId, event.eventType, Date.now()]
        }
      ],
      "write"
    );
  } finally {
    client.close();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(publishOutbox(env));
  },
  async queue(batch: MessageBatch<DomainEvent>, env: Env) {
    for (const message of batch.messages) {
      try {
        await applyListingCommand(env, domainEventSchema.parse(message.body));
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ service: "listing", messageId: message.id, error: String(error) }));
        message.retry({ delaySeconds: 10 });
      }
    }
  }
} satisfies ExportedHandler<Env, DomainEvent>;
