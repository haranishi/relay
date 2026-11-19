import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { INTERNAL_AUTH_HEADER, decodeAuthContext } from "@relay/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import gateway from "../src/index.ts";

const sessionPath = "/api/v1/session";
const listingPath = "/api/v1/communities/community-campus-demo/listings";
const now = Date.parse("2030-05-10T12:00:00Z");
const expiresAt = "2030-05-10T20:00:00.000Z";
let exampleIp = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.spyOn(globalThis.console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(base = "https://relay.test") {
  const ip = "192.0.2." + ++exampleIp;
  const membership = vi.fn(() => globalThis.Response.json({
    membershipId: "member", membershipRole: "member", membershipVersion: 1
  }));
  const listing = vi.fn(() => globalThis.Response.json({ id: "listing" }, { status: 201 }));
  const matching = vi.fn(() => globalThis.Response.json({
    listingStatus: "OPEN", viewerRole: "giver", applications: [], handoffs: []
  }, { headers: { "Cache-Control": "public, max-age=60" } }));
  const env = {
    ALLOW_DEMO_AUTH: "false",
    ALLOWED_ORIGINS: "http://127.0.0.1:8787, http://localhost:8787, https://relay.test",
    RELAY_SESSION_KEY: "dummy-session-key-for-unit-tests",
    RELAY_INVITE_GIVER: "dummy-giver-code",
    RELAY_INVITE_A: "dummy-code-for-a",
    RELAY_INVITE_B: "dummy-code-for-receiver-b",
    COMMUNITY_SERVICE: { fetch: membership },
    LISTING_SERVICE: { fetch: listing },
    MATCHING_SERVICE: { fetch: matching }
  };
  function fetch(path, { method = "GET", headers, body } = {}) {
    return gateway.fetch(new globalThis.Request(base + path, {
      method,
      headers: { "CF-Connecting-IP": ip, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    }), env, {});
  }
  function login(code = env.RELAY_INVITE_GIVER, headers) {
    return fetch(sessionPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: { code }
    });
  }
  return { env, fetch, login, membership, listing, matching };
}

function sessionCookie(response) {
  return response.headers.get("Set-Cookie").split(";")[0];
}

it.each([
  ["RELAY_INVITE_GIVER", "giver", "出品者"],
  ["RELAY_INVITE_A", "receiver-a", "受取人A"],
  ["RELAY_INVITE_B", "receiver-b", "受取人B"]
])("issues and reads an eight-hour session for %s", async (secretName, id, displayName) => {
  const { env, fetch, login } = setup();
  const issued = await login(env[secretName], { Origin: "https://relay.test" });
  expect(issued.status).toBe(200);
  expect(issued.headers.get("Cache-Control")).toBe("no-store");
  expect(issued.headers.get("Set-Cookie").split("; ")).toEqual([
    expect.stringMatching(/^relay_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/),
    "Max-Age=28800", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"
  ]);
  const expected = { user: { id, displayName }, expiresAt };
  expect(await issued.json()).toEqual(expected);
  const current = await fetch(sessionPath, {
    headers: { Cookie: "preference=example; " + sessionCookie(issued) }
  });
  expect(current.status).toBe(200);
  expect(current.headers.get("Cache-Control")).toBe("no-store");
  expect(await current.json()).toEqual(expected);
});

it.each(["127.0.0.1", "localhost"])("allows the session cookie over local HTTP on %s", async (host) => {
  const base = "http://" + host + ":8787";
  const { fetch, login } = setup(base);
  const response = await login(undefined, { Origin: base });
  expect(response.status).toBe(200);
  expect(response.headers.get("Set-Cookie")).not.toContain("Secure");

  const logout = await fetch(sessionPath, { method: "DELETE", headers: { Cookie: sessionCookie(response) } });
  expect(logout.status).toBe(204);
  expect(await logout.text()).toBe("");
  expect(logout.headers.get("Cache-Control")).toBe("no-store");
  expect(logout.headers.get("Set-Cookie")).toBe("relay_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
});

it("rejects a changed payload, a changed signature and an expired session", async () => {
  const { fetch, login } = setup();
  const original = sessionCookie(await login());
  const [payload, signature] = original.slice("relay_session=".length).split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  expect(claims).toEqual({ userId: "giver", issuedAt: now, expiresAt: Date.parse(expiresAt) });
  const altered = Buffer.from(JSON.stringify({ ...claims, userId: "receiver-b" })).toString("base64url");
  const changedSignature = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  for (const cookie of [undefined, "relay_session=" + altered + "." + signature, "relay_session=" + payload + "." + changedSignature]) {
    const response = await fetch(sessionPath, { headers: cookie ? { Cookie: cookie } : {} });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }

  vi.setSystemTime(Date.parse(expiresAt));
  const response = await fetch(sessionPath, { headers: { Cookie: original } });
  expect(response.status).toBe(401);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it("limits unsuccessful attempts from the same IP and reopens the window", async () => {
  const { login } = setup();
  const attempts = await Promise.all(Array.from({ length: 6 }, () => login("dummy-wrong-code")));
  expect(attempts.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 429]);
  expect(await attempts[0].json()).toEqual({
    type: "https://relay.example/problems/401", title: "Invalid invite code", status: 401, detail: "Invalid invite code"
  });
  expect((await login()).status).toBe(429);
  expect(attempts[5].headers.get("Cache-Control")).toBe("no-store");
  expect((await setup().login()).status).toBe(200);

  vi.setSystemTime(now + 5 * 60 * 1000);
  expect((await login()).status).toBe(200);
});

it("uses the cookie identity for membership and forwards only the server's auth context", async () => {
  const { fetch, login, membership, matching } = setup();
  const forgedHeaders = { "x-relay-demo-user": "receiver-b", [INTERNAL_AUTH_HEADER]: "dummy-client-context" };
  const denied = await fetch(listingPath + "/listing/matching", { headers: forgedHeaders });
  expect(denied.status).toBe(401);
  expect(membership).not.toHaveBeenCalled();
  expect(matching).not.toHaveBeenCalled();

  const cookie = sessionCookie(await login());
  const response = await fetch(listingPath + "/listing/matching", { headers: { ...forgedHeaders, Cookie: cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await membership.mock.calls[0][0].json()).toEqual({ userId: "giver", communityId: "community-campus-demo" });
  const forwarded = matching.mock.calls[0][0];
  expect(new URL(forwarded.url).pathname).toBe("/internal/listings/listing/matching");
  expect([...forwarded.headers.keys()]).toEqual([INTERNAL_AUTH_HEADER]);
  expect(decodeAuthContext(forwarded.headers.get(INTERNAL_AUTH_HEADER))).toMatchObject({
    userId: "giver", communityId: "community-campus-demo", membershipId: "member"
  });

  membership.mockReturnValueOnce(new globalThis.Response(null, { status: 404 }));
  const notMember = await fetch(listingPath + "/listing/matching", { headers: { Cookie: cookie } });
  expect(notMember.status).toBe(403);
  expect(notMember.headers.get("Cache-Control")).toBe("no-store");
  expect(matching).toHaveBeenCalledTimes(1);
});

it("checks Origin for login, logout, and cookie-authenticated writes", async () => {
  const { fetch, login, membership, listing } = setup();
  const offsite = "https://relay.test.other.test";
  const failedLogin = await login(undefined, { Origin: offsite });
  expect(failedLogin.status).toBe(403);
  expect(failedLogin.headers.has("Set-Cookie")).toBe(false);
  const cookie = sessionCookie(await login());
  const denied = await fetch(listingPath, { method: "POST", headers: { Origin: offsite, Cookie: cookie } });
  expect(denied.status).toBe(403);
  expect(denied.headers.get("Cache-Control")).toBe("no-store");
  expect(membership).not.toHaveBeenCalled();
  expect(listing).not.toHaveBeenCalled();

  const crossSiteLogout = await fetch(sessionPath, { method: "DELETE", headers: { Origin: "null", Cookie: cookie } });
  expect(crossSiteLogout.status).toBe(403);
  expect(crossSiteLogout.headers.has("Set-Cookie")).toBe(false);

  for (const headers of [{ Origin: "https://relay.test", Cookie: cookie }, { Cookie: cookie }]) {
    expect((await fetch(listingPath, { method: "POST", headers })).status).toBe(201);
  }
  const logout = await fetch(sessionPath, { method: "DELETE", headers: { Origin: "https://relay.test", Cookie: cookie } });
  expect(logout.status).toBe(204);
  expect(logout.headers.get("Cache-Control")).toBe("no-store");
  expect(logout.headers.get("Set-Cookie")).toBe("relay_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
});
