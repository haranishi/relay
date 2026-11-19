import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "./route";

const gatewayFetch = vi.fn<(request: Request) => Promise<Response>>();
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { API_GATEWAY: { fetch: gatewayFetch } } })
}));

const origin = "https://relay.example";
const session = "/api/v1/session";
const community = "/api/v1/communities/community-campus-demo";
const listings = `${community}/listings`;
const handlers = { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT };

function relay(method: keyof typeof handlers, path: string, init: RequestInit = {}) {
  return handlers[method](new Request(origin + path, { method, headers: { origin }, ...init }));
}

beforeEach(() => {
  gatewayFetch.mockReset();
  gatewayFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
});

describe("Web から Gateway への中継", () => {
  it.each([
    ["GET", session], ["POST", session], ["DELETE", session],
    ["GET", listings], ["POST", listings], ["GET", `${listings}/a`],
    ["GET", `${listings}/${"a".repeat(64)}/matching`],
    ["GET", `${listings}/item-1/applications`], ["POST", `${listings}/item-1/applications`],
    ["POST", `${listings}/item-1/selection`],
    ["POST", `${community}/handoffs/offer-1/cancel`], ["POST", `${community}/handoffs/offer-1/complete`]
  ] as const)("%s %s を中継する", async (method, path) => {
    const response = await relay(method, path);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const request = gatewayFetch.mock.calls[0]?.[0];
    expect(request?.url).toBe("https://relay-api-gateway.internal" + path);
    expect(request?.method).toBe(method);
  });

  it.each([
    ["GET", "/api/v1/health"], ["GET", "/api/v1/communities/other/listings"],
    ["GET", `${listings}/item_1`], ["GET", `${listings}/${"a".repeat(65)}`],
    ["GET", `${listings}/item%2Fmatching`], ["GET", `${listings}/item-1/matching/extra`],
    ["POST", `${listings}/item-1/matching`], ["GET", `${listings}/item-1/selection`],
    ["DELETE", listings], ["PUT", session], ["PATCH", session], ["HEAD", session], ["OPTIONS", session]
  ] as const)("%s %s は 404 を返す", async (method, path) => {
    const response = await relay(method, path);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it.each(["https://other.example", "http://relay.example", "null", undefined])("更新時の Origin %s を拒む", async (value) => {
    const response = await relay("POST", session, { headers: value === undefined ? {} : { origin: value } });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "forbidden_origin" });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it("一覧の GET だけクエリを中継する", async () => {
    const query = "?status=RESERVED&q=a%20b";
    await relay("GET", listings + query, { headers: {} });
    await relay("POST", listings + query);
    await relay("GET", `${listings}/item-1${query}`);
    await relay("GET", session + query);
    expect(gatewayFetch.mock.calls.map(([request]) => new URL(request.url).search)).toEqual([query, "", "", ""]);
  });

  it("指定のヘッダーと本文を渡し、応答の Cookie と本文を返す", async () => {
    const cookies = ["relay_session=dummy; Path=/; Secure; HttpOnly", "other=dummy; Path=/; Secure"];
    const responseHeaders = new Headers({ "content-type": "application/json", "cache-control": "public", "x-internal": "dummy" });
    for (const cookie of cookies) responseHeaders.append("set-cookie", cookie);
    gatewayFetch.mockResolvedValue(new Response('{"ok":true}', { status: 201, headers: responseHeaders }));

    const allowed = {
      "content-type": "application/json",
      "idempotency-key": "dummy-key",
      cookie: "relay_session=dummy",
      origin,
      "cf-connecting-ip": "192.0.2.10",
      accept: "application/json"
    };
    const response = await relay("POST", session, {
      headers: {
        ...allowed, authorization: "Bearer dummy", "x-relay-demo-user": "giver",
        "x-relay-auth-context": "dummy", "x-relay-other": "dummy", "x-forwarded-for": "192.0.2.20"
      },
      body: '{"code":"dummy"}'
    });

    const request = gatewayFetch.mock.calls[0]?.[0];
    expect(Object.fromEntries(request?.headers ?? [])).toEqual(allowed);
    await expect(request?.text()).resolves.toBe('{"code":"dummy"}');
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("x-internal")).toBe(false);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("本文の上限は文字数でなくバイト数で判定する", async () => {
    const response = await relay("POST", session, { body: "日".repeat(5462) });
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect((await relay("POST", session, { body: "a".repeat(16 * 1024) })).status).toBe(204);
  });

  it("大きさが分からない分割送信でも、上限を超えたら読むのをやめて 413 を返す", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(4096).fill(97);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
        if (pulled >= 100) controller.close();
      }
    });
    const response = await relay("POST", session, { body, duplex: "half" } as RequestInit);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(pulled).toBeLessThan(10);
  });

  it("中継が失敗したら内部の詳細を含めずに 502 を返す", async () => {
    gatewayFetch.mockRejectedValue(new Error("dummy internal detail"));
    const response = await relay("GET", session);
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "gateway_unavailable" });
  });
});
