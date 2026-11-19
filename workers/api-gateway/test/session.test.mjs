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
    ALLOWED_ORIGINS: base + ", https://extra.test",
    RELAY_SESSION_KEY: "dummy-session-key-for-unit-tests",
    RELAY_INVITE_GIVER: "dummy-giver-code",
    RELAY_INVITE_A: "dummy-code-for-a",
    RELAY_INVITE_B: "dummy-code-for-receiver-b",
    COMMUNITY_SERVICE: { fetch: membership },
    LISTING_SERVICE: { fetch: listing },
    MATCHING_SERVICE: { fetch: matching }
  };
  function fetch(path, { method = "GET", headers, body, rawBody } = {}) {
    return gateway.fetch(new globalThis.Request(base + path, {
      method,
      headers: { "CF-Connecting-IP": ip, ...headers },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      duplex: "half"
    }), env, {});
  }
  function login(code = env.RELAY_INVITE_GIVER, headers) {
    return fetch(sessionPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, ...headers },
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

it.each(["127.0.0.1", "localhost", "[::1]"])("allows the session cookie over local HTTP on %s", async (host) => {
  const base = "http://" + host + ":8787";
  const { fetch, login } = setup(base);
  const response = await login(undefined, { Origin: base });
  expect(response.status).toBe(200);
  expect(response.headers.get("Set-Cookie")).not.toContain("Secure");

  const logout = await fetch(sessionPath, { method: "DELETE", headers: { Origin: base, Cookie: sessionCookie(response) } });
  expect(logout.status).toBe(204);
  expect(await logout.text()).toBe("");
  expect(logout.headers.get("Cache-Control")).toBe("no-store");
  expect(logout.headers.get("Set-Cookie")).toBe("relay_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
});

it.each(["http://relay.test", "https://localhost:8787"])("always sets Secure outside loopback HTTP on %s", async (base) => {
  const { fetch, login } = setup(base);
  const response = await login();
  expect(response.status).toBe(200);
  expect(response.headers.get("Set-Cookie")).toContain("; Secure;");

  const logout = await fetch(sessionPath, { method: "DELETE", headers: { Origin: base, Cookie: sessionCookie(response) } });
  expect(logout.status).toBe(204);
  expect(logout.headers.get("Set-Cookie")).toBe("relay_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
});

it("accepts 4096 bytes and rejects a larger declared length before reading the body", async () => {
  const { env, fetch, login } = setup();
  const json = JSON.stringify({ code: env.RELAY_INVITE_GIVER, padding: "界".repeat(1300) });
  const rawBody = json + " ".repeat(4096 - Buffer.byteLength(json));
  expect((await fetch(sessionPath, {
    method: "POST", headers: { Origin: "https://relay.test" }, rawBody
  })).status).toBe(200);

  const getReader = vi.spyOn(globalThis.ReadableStream.prototype, "getReader");
  const response = await login(undefined, { "Content-Length": "4097" });
  expect(getReader).not.toHaveBeenCalled();
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    type: "https://relay.example/problems/413", title: "Payload too large", status: 413, detail: "Payload too large"
  });
});

it.each([{}, { "Content-Length": "2" }])("uses the actual byte count with headers %j", async (lengthHeader) => {
  const { fetch } = setup();
  const cancel = vi.fn();
  const rawBody = new globalThis.ReadableStream({
    start(controller) {
      const encoder = new globalThis.TextEncoder();
      controller.enqueue(encoder.encode("界".repeat(1000)));
      controller.enqueue(encoder.encode("界".repeat(366)));
    },
    cancel
  });
  const response = await fetch(sessionPath, {
    method: "POST", headers: { Origin: "https://relay.test", ...lengthHeader }, rawBody
  });
  expect(response.status).toBe(413);
  expect(cancel).toHaveBeenCalledOnce();
});

it("rejects invalid JSON, an invalid shape and codes longer than 128 characters", async () => {
  const { env, fetch, login } = setup();
  env.RELAY_INVITE_GIVER = "a".repeat(129);
  const invalid = [
    await fetch(sessionPath, { method: "POST", headers: { Origin: "https://relay.test" }, rawBody: "{" }),
    await fetch(sessionPath, { method: "POST", headers: { Origin: "https://relay.test" }, body: { code: 123 } }),
    await login()
  ];
  for (const response of invalid) {
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ detail: "Invalid invite code" });
  }
  env.RELAY_INVITE_GIVER = "a".repeat(128);
  expect((await login()).status).toBe(200);
});

it("normalizes both the supplied and configured invite codes", async () => {
  const { env, login } = setup();
  env.RELAY_INVITE_A = " ＤＵＭＭＹ－ＣＯＤＥ１２３ ";
  const response = await login("  dummy - ｃｏｄｅ１２３  ");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ user: { id: "receiver-a" } });
  expect((await login("  dummy - ｃｏｄｅ１２４  ")).status).toBe(401);
});

it.each([" ＤＵＭＭＹ－ＧＩＶＥＲ－ＣＯＤＥ ", " -　－ "])("rejects invalid invite configuration %j", async (code) => {
  const { env, login } = setup();
  env.RELAY_INVITE_A = code;
  const response = await login();
  expect(response.status).toBe(500);
  expect(response.headers.has("Set-Cookie")).toBe(false);
  expect(await response.json()).toMatchObject({ detail: "An unexpected error occurred" });
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

it.each([401, 413])("keeps earlier failures after a success and counts %i as a failure", async (status) => {
  const { login } = setup();
  for (let i = 0; i < 4; i++) {
    expect((await login("dummy-wrong-code")).status).toBe(401);
  }
  expect((await login()).status).toBe(200);
  const failure = status === 401
    ? await login("dummy-wrong-code")
    : await login(undefined, { "Content-Length": "4097" });
  expect(failure.status).toBe(status);
  expect((await login()).status).toBe(429);
});

it("limits successful requests as well and reopens the window after five minutes", async () => {
  const { login } = setup();
  for (let i = 0; i < 30; i++) {
    expect((await login()).status).toBe(200);
  }
  expect((await login()).status).toBe(429);
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

  expect((await fetch(listingPath, { method: "POST", headers: { Origin: "https://relay.test", Cookie: cookie } })).status).toBe(201);
  const logout = await fetch(sessionPath, { method: "DELETE", headers: { Origin: "https://relay.test", Cookie: cookie } });
  expect(logout.status).toBe(204);
  expect(logout.headers.get("Cache-Control")).toBe("no-store");
  expect(logout.headers.get("Set-Cookie")).toBe("relay_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
});

it("rejects missing Origin for login, logout and cookie writes while allowing cookie reads", async () => {
  const { fetch, login, membership, listing } = setup();
  const cookie = sessionCookie(await login());
  const denied = [
    await fetch(sessionPath, { method: "POST", body: { code: "dummy-giver-code" } }),
    await fetch(sessionPath, { method: "DELETE", headers: { Cookie: cookie } }),
    await fetch(listingPath, { method: "POST", headers: { Cookie: cookie } })
  ];
  for (const response of denied) {
    expect(response.status).toBe(403);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(await response.json()).toMatchObject({ detail: "Origin is required" });
  }
  expect(membership).not.toHaveBeenCalled();
  expect(listing).not.toHaveBeenCalled();
  expect((await fetch(sessionPath, { headers: { Cookie: cookie } })).status).toBe(200);
  for (const method of ["GET", "HEAD"]) {
    expect((await fetch(listingPath + "/listing/matching", { method, headers: { Cookie: cookie } })).status).toBe(200);
  }
});

it.each([undefined, ""])("rejects a supplied Origin with allowlist %j", async (allowedOrigins) => {
  const { env, login } = setup();
  env.ALLOWED_ORIGINS = allowedOrigins;
  const response = await login();
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ detail: "Origin is not allowed" });
});

it("allows a community write with demo header authentication and no Origin", async () => {
  const { env, fetch } = setup();
  env.ALLOW_DEMO_AUTH = "true";
  const response = await fetch(listingPath, { method: "POST", headers: { "x-relay-demo-user": "giver" } });
  expect(response.status).toBe(201);
});

it("encodes listing and handoff IDs so they cannot change the internal path", async () => {
  const { fetch, login, matching } = setup();
  const cookie = sessionCookie(await login());
  const traversal = "..%2F..%2Fhandoffs%2Fother";

  const applications = await fetch(listingPath + "/" + traversal + "/applications", { headers: { Cookie: cookie } });
  expect(applications.status).toBe(200);
  expect(new URL(matching.mock.calls[0][0].url).pathname)
    .toBe("/internal/listings/" + traversal + "/applications");

  const cancel = await fetch(
    "/api/v1/communities/community-campus-demo/handoffs/" + traversal + "/cancel",
    { method: "POST", headers: { Origin: "https://relay.test", Cookie: cookie } }
  );
  expect(cancel.status).toBe(200);
  expect(new URL(matching.mock.calls[1][0].url).pathname)
    .toBe("/internal/handoffs/" + traversal + "/cancel");
});
