import { getCloudflareContext } from "@opennextjs/cloudflare";
import { pilotCommunityPath } from "../../../../lib/pilot-api";

export const dynamic = "force-dynamic";

const listings = `${pilotCommunityPath}/listings`;
const listingId = "[A-Za-z0-9-]{1,64}";
const routes = [
  { path: /^\/api\/v1\/session$/, methods: ["GET", "POST", "DELETE"] },
  { path: new RegExp(`^${listings}$`), methods: ["GET", "POST"] },
  { path: new RegExp(`^${listings}/${listingId}(?:/matching)?$`), methods: ["GET"] },
  { path: new RegExp(`^${listings}/${listingId}/applications$`), methods: ["GET", "POST"] },
  { path: new RegExp(`^${listings}/${listingId}/selection$`), methods: ["POST"] },
  { path: new RegExp(`^${pilotCommunityPath}/handoffs/${listingId}/(?:cancel|complete)$`), methods: ["POST"] }
];
const forwardedHeaders = ["content-type", "idempotency-key", "cookie", "origin", "cf-connecting-ip", "accept"];
const maxBodyBytes = 16 * 1024;

function problem(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

async function relay(request: Request): Promise<Response> {
  const { pathname, origin, search } = new URL(request.url);
  const { method } = request;
  if (!routes.some((route) => route.path.test(pathname) && route.methods.includes(method))) {
    return problem(404, "not_found");
  }
  if (method !== "GET" && request.headers.get("origin") !== origin) {
    return problem(403, "forbidden_origin");
  }

  let body: string | null = null;
  if (request.body !== null) {
    if (Number(request.headers.get("content-length")) > maxBodyBytes) {
      return problem(413, "body_too_large");
    }
    try {
      body = await request.text();
    } catch {
      return problem(400, "invalid_body");
    }
    if (body.length > maxBodyBytes || new TextEncoder().encode(body).byteLength > maxBodyBytes) {
      return problem(413, "body_too_large");
    }
  }

  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const query = method === "GET" && pathname === listings ? search : "";

  try {
    const { API_GATEWAY } = getCloudflareContext().env;
    const response = await API_GATEWAY.fetch(new Request(
      `https://relay-api-gateway.internal${pathname}${query}`,
      { method, headers, body, redirect: "manual" }
    ));
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    const contentType = response.headers.get("content-type");
    if (contentType !== null) responseHeaders.set("content-type", contentType);
    for (const cookie of response.headers.getSetCookie()) {
      responseHeaders.append("set-cookie", cookie);
    }
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return problem(502, "gateway_unavailable");
  }
}

// Next.js が HEAD と OPTIONS を自動で返す前に、同じ許可リストで判定する。
export { relay as GET, relay as POST, relay as DELETE, relay as HEAD, relay as OPTIONS, relay as PUT, relay as PATCH };
