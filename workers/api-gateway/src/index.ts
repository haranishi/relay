import {
  INTERNAL_AUTH_HEADER,
  authContextSchema,
  encodeAuthContext,
  type AuthContext
} from "@relay/contracts";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";

type Variables = { auth: AuthContext };
type AppEnv = { Bindings: Env; Variables: Variables };

const app = new Hono<AppEnv>();

app.use("/api/v1/*", async (context, next) => {
  if (context.req.path === "/api/v1/health") {
    await next();
    return;
  }

  const userId = context.req.header("x-relay-demo-user");
  const communityId = context.req.param("communityId") || context.req.header("x-relay-community-id");
  if (context.env.ALLOW_DEMO_AUTH !== "true" || !userId || !communityId) {
    throw new HTTPException(401, { message: "Authentication is required" });
  }

  const verifyResponse = await context.env.COMMUNITY_SERVICE.fetch(
    new Request("https://community.internal/internal/memberships/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, communityId })
    })
  );
  if (!verifyResponse.ok) {
    throw new HTTPException(403, { message: "Active community membership is required" });
  }
  const membership = authContextSchema
    .pick({ membershipId: true, membershipRole: true, membershipVersion: true })
    .parse(await verifyResponse.json());
  context.set("auth", {
    requestId: crypto.randomUUID(),
    userId,
    communityId,
    ...membership
  });
  await next();
});

app.get("/api/v1/health", (context) =>
  context.json({ service: "relay-api-gateway", status: "ok" })
);

app.get("/api/v1/communities/:communityId/listings", (context) =>
  proxy(context, context.env.READ_MODEL_SERVICE, "/internal/listings")
);

app.post("/api/v1/communities/:communityId/listings", (context) =>
  proxy(context, context.env.LISTING_SERVICE, "/internal/listings")
);

app.get("/api/v1/communities/:communityId/listings/:listingId", (context) =>
  proxy(
    context,
    context.env.LISTING_SERVICE,
    `/internal/listings/${context.req.param("listingId")}`
  )
);

app.post("/api/v1/communities/:communityId/listings/:listingId/applications", (context) =>
  proxy(
    context,
    context.env.MATCHING_SERVICE,
    `/internal/listings/${context.req.param("listingId")}/applications`
  )
);

app.get("/api/v1/communities/:communityId/listings/:listingId/applications", (context) =>
  proxy(
    context,
    context.env.MATCHING_SERVICE,
    `/internal/listings/${context.req.param("listingId")}/applications`
  )
);

app.post("/api/v1/communities/:communityId/listings/:listingId/selection", (context) =>
  proxy(
    context,
    context.env.MATCHING_SERVICE,
    `/internal/listings/${context.req.param("listingId")}/selection`
  )
);

app.post("/api/v1/communities/:communityId/handoffs/:handoffId/cancel", (context) =>
  proxy(
    context,
    context.env.MATCHING_SERVICE,
    `/internal/handoffs/${context.req.param("handoffId")}/cancel`
  )
);

app.post("/api/v1/communities/:communityId/handoffs/:handoffId/complete", (context) =>
  proxy(
    context,
    context.env.MATCHING_SERVICE,
    `/internal/handoffs/${context.req.param("handoffId")}/complete`
  )
);

app.notFound(() => problem(404, "Not Found", "The route does not exist"));

app.onError((error, context) => {
  const requestId = context.get("auth")?.requestId ?? crypto.randomUUID();
  const status = error instanceof HTTPException ? error.status : 500;
  const detail = error instanceof HTTPException ? error.message : "An unexpected error occurred";
  console.error(
    JSON.stringify({
      message: "gateway request failed",
      requestId,
      status,
      path: context.req.path,
      error: error instanceof Error ? error.message : "Unknown error"
    })
  );
  return problem(status, status === 500 ? "Internal Server Error" : detail, detail);
});

async function proxy(
  context: Context<AppEnv>,
  service: Fetcher,
  path: string
): Promise<Response> {
  return proxyRequest(context.req.raw, context.get("auth"), service, path);
}

async function proxyRequest(
  request: Request,
  auth: AuthContext,
  service: Fetcher,
  path: string
): Promise<Response> {
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const idempotencyKey = request.headers.get("idempotency-key");
  if (contentType) headers.set("content-type", contentType);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  headers.set(INTERNAL_AUTH_HEADER, encodeAuthContext(auth));

  const response = await service.fetch(
    new Request(`https://service.internal${path}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? null : request.body
    })
  );
  return new Response(response.body, response);
}

function problem(status: number, title: string, detail: string): Response {
  return Response.json(
    {
      type: `https://relay.example/problems/${status}`,
      title,
      status,
      detail
    },
    { status }
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
