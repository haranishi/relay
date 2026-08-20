import {
  INTERNAL_AUTH_HEADER,
  decodeAuthContext,
  domainEventSchema,
  type AuthContext,
  type DomainEvent
} from "@relay/contracts";
import { createTursoClient, expectNumber, expectString } from "@relay/turso";
import type { InStatement } from "@libsql/client/web";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

type Variables = { auth: AuthContext };
type AppEnv = { Bindings: Env; Variables: Variables };
const app = new Hono<AppEnv>();

app.use("/internal/*", async (context, next) => {
  if (context.req.path.endsWith("/health")) return next();
  try { context.set("auth", decodeAuthContext(context.req.header(INTERNAL_AUTH_HEADER))); }
  catch { throw new HTTPException(401, { message: "Missing service authentication" }); }
  await next();
});

app.get("/internal/health", (context) => context.json({ service: "read-model", status: "ok" }));

app.get("/internal/listings", async (context) => {
  const auth = context.get("auth");
  const status = context.req.query("status") ?? "OPEN";
  const category = context.req.query("category");
  const search = context.req.query("q")?.trim();
  const client = createTursoClient(context.env);
  try {
    const conditions = ["community_id = ?", "status = ?"];
    const args: (string | number)[] = [auth.communityId, status];
    if (category) { conditions.push("category = ?"); args.push(category); }
    if (search) { conditions.push("(title LIKE ? OR description LIKE ?)"); args.push(`%${search}%`, `%${search}%`); }
    const result = await client.execute({
      sql: `
        SELECT id, owner_id, title, description, category, condition, pickup_area,
               pickup_deadline, status, applicant_count, active_receiver_id, updated_at
        FROM listing_feed
        WHERE ${conditions.join(" AND ")}
        ORDER BY updated_at DESC
        LIMIT 100
      `,
      args
    });
    return context.json({
      items: result.rows.map((row) => ({
        id: expectString(row.id, "id"), ownerId: expectString(row.owner_id, "owner_id"), title: expectString(row.title, "title"),
        description: expectString(row.description, "description"), category: expectString(row.category, "category"), condition: expectString(row.condition, "condition"),
        pickupArea: expectString(row.pickup_area, "pickup_area"), pickupDeadline: new Date(expectNumber(row.pickup_deadline, "pickup_deadline")).toISOString(),
        status: expectString(row.status, "status"), applicantCount: expectNumber(row.applicant_count, "applicant_count"),
        activeReceiverId: row.active_receiver_id === null ? null : expectString(row.active_receiver_id, "active_receiver_id"),
        updatedAt: new Date(expectNumber(row.updated_at, "updated_at")).toISOString()
      }))
    });
  } finally { client.close(); }
});

async function projectEvent(env: Env, event: DomainEvent): Promise<void> {
  const client = createTursoClient(env);
  try {
    const processed = await client.execute({ sql: `SELECT 1 FROM processed_events WHERE event_id = ?`, args: [event.eventId] });
    if (processed.rows.length > 0) return;
    const statements: InStatement[] = [projection(event), {
      sql: `INSERT INTO processed_events (event_id, event_type, processed_at) VALUES (?, ?, ?)`,
      args: [event.eventId, event.eventType, Date.now()]
    }];
    await client.batch(statements, "write");
  } finally { client.close(); }
}

function projection(event: DomainEvent): InStatement {
  const listingId = expectString(event.payload.listingId ?? event.aggregateId, "payload.listingId");
  switch (event.eventType) {
    case "ListingPublished.v1":
      return {
        sql: `
          INSERT INTO listing_feed (
            id, community_id, owner_id, title, description, category, condition,
            pickup_area, pickup_deadline, status, applicant_count, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 0, ?)
          ON CONFLICT(id) DO NOTHING
        `,
        args: [
          event.aggregateId,
          event.communityId,
          expectString(event.payload.ownerId, "payload.ownerId"),
          expectString(event.payload.title, "payload.title"),
          expectString(event.payload.description, "payload.description"),
          expectString(event.payload.category, "payload.category"),
          expectString(event.payload.condition, "payload.condition"),
          expectString(event.payload.pickupArea, "payload.pickupArea"),
          Date.parse(expectString(event.payload.pickupDeadline, "payload.pickupDeadline")),
          Date.now()
        ]
      };
    case "ApplicationSubmitted.v1":
      return { sql: `UPDATE listing_feed SET applicant_count = applicant_count + 1, updated_at = ? WHERE id = ?`, args: [Date.now(), listingId] };
    case "RecipientSelected.v1":
    case "RecipientReoffered.v1":
      return { sql: `UPDATE listing_feed SET status = 'RESERVED', active_receiver_id = ?, updated_at = ? WHERE id = ?`, args: [expectString(event.payload.receiverId, "payload.receiverId"), Date.now(), listingId] };
    case "HandoffCompleted.v1":
      return { sql: `UPDATE listing_feed SET status = 'COMPLETED', active_receiver_id = ?, updated_at = ? WHERE id = ?`, args: [expectString(event.payload.receiverId, "payload.receiverId"), Date.now(), listingId] };
    case "ListingReopened.v1":
      return { sql: `UPDATE listing_feed SET status = 'OPEN', active_receiver_id = NULL, updated_at = ? WHERE id = ?`, args: [Date.now(), listingId] };
    default:
      return { sql: `UPDATE listing_feed SET updated_at = updated_at WHERE id = ?`, args: [listingId] };
  }
}

app.onError((error, context) => {
  const status = error instanceof HTTPException ? error.status : 500;
  return context.json({ error: status === 500 ? "internal_error" : error.message }, status);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { return app.fetch(request, env, ctx); },
  async queue(batch: MessageBatch<DomainEvent>, env: Env) {
    for (const message of batch.messages) {
      try { await projectEvent(env, domainEventSchema.parse(message.body)); message.ack(); }
      catch (error) { console.error(JSON.stringify({ service: "read-model", messageId: message.id, error: String(error) })); message.retry({ delaySeconds: 10 }); }
    }
  }
} satisfies ExportedHandler<Env, DomainEvent>;
