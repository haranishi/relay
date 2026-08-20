import { createTursoClient, expectNumber, expectString } from "@relay/turso";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<{ Bindings: Env }>();
const resolveMembershipSchema = z.object({
  userId: z.string().min(1).max(128),
  communityId: z.string().min(1).max(128)
});

app.get("/internal/health", (context) =>
  context.json({ service: "community-auth", status: "ok" })
);

app.post("/internal/memberships/resolve", async (context) => {
  const parsed = resolveMembershipSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "invalid_request" }, 400);

  const client = createTursoClient(context.env);
  try {
    const result = await client.execute({
      sql: `
        SELECT id, role, version
        FROM memberships
        WHERE user_id = ? AND community_id = ? AND status = 'active'
        LIMIT 1
      `,
      args: [parsed.data.userId, parsed.data.communityId]
    });
    const row = result.rows[0];
    if (!row) return context.json({ error: "membership_not_found" }, 404);
    return context.json({
      membershipId: expectString(row.id, "id"),
      membershipRole: expectString(row.role, "role"),
      membershipVersion: expectNumber(row.version, "version")
    });
  } finally {
    client.close();
  }
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
