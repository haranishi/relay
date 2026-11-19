import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

type SessionEnv = { Bindings: Env };
type Session = { user: { id: string; displayName: string }; expiresAt: string };

const invites = [
  { secret: "RELAY_INVITE_GIVER", user: { id: "giver", displayName: "出品者" } },
  { secret: "RELAY_INVITE_A", user: { id: "receiver-a", displayName: "受取人A" } },
  { secret: "RELAY_INVITE_B", user: { id: "receiver-b", displayName: "受取人B" } }
] as const;
const inviteRequestSchema = z.object({ code: z.string().min(1).max(128) });
const inviteBodyLimit = 4096;
const sessionPayloadSchema = z.object({
  userId: z.string(),
  issuedAt: z.int().nonnegative(),
  expiresAt: z.int().positive()
});
const cookieName = "relay_session";
const sessionMaxAge = 28800;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const failureLimit = 5;
const requestLimit = 30;
const attemptWindowMs = 5 * 60 * 1000;
const trackedIpLimit = 1024;
const attempts = new Map<string, { failures: number; requests: number; resetsAt: number }>();

export function checkOrigin(request: Request, allowedOrigins?: string): void {
  const origin = request.headers.get("Origin");
  if (origin === null) throw new HTTPException(403, { message: "Origin is required" });
  const allowed = allowedOrigins?.split(",").some((value) => value.trim() === origin);
  if (!origin || origin === "null" || !allowed) {
    throw new HTTPException(403, { message: "Origin is not allowed" });
  }
}

export async function createSession<E extends SessionEnv>(context: Context<E>): Promise<Response> {
  checkOrigin(context.req.raw, context.env.ALLOWED_ORIGINS);
  const ip = context.req.header("CF-Connecting-IP") ?? "";
  const attempt = reserveAttempt(ip);
  const parsed = inviteRequestSchema.safeParse(await readInviteBody(context.req.raw));
  if (!parsed.success) throw new HTTPException(401, { message: "Invalid invite code" });

  const codes = invites.map(({ secret }) => normalizeInvite(context.env[secret] ?? ""));
  const secret = context.env.RELAY_SESSION_KEY;
  if (!secret || codes.some((code) => !code) || new Set(codes).size !== codes.length) {
    throw new Error("Session secrets are missing or invite codes are duplicated");
  }

  const key = await importKey(secret);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode("invite:" + normalizeInvite(parsed.data.code)));
  // 3件とも固定長の署名を照合してから、該当する利用者を選ぶ。
  const matches = await Promise.all(codes.map((code) =>
    crypto.subtle.verify("HMAC", key, digest, encoder.encode("invite:" + code))
  ));
  const invite = invites[matches.findIndex((match) => match)];
  if (!invite) throw new HTTPException(401, { message: "Invalid invite code" });

  const issuedAt = Date.now();
  const expiresAt = issuedAt + sessionMaxAge * 1000;
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    userId: invite.user.id, issuedAt, expiresAt
  })));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  setCookie(context, cookieName, payload + "." + encodeBase64Url(new Uint8Array(signature)), {
    ...cookieOptions(context.req.url),
    maxAge: sessionMaxAge
  });
  attempt.failures -= 1;
  return context.json({ user: invite.user, expiresAt: new Date(expiresAt).toISOString() });
}

export async function readSession<E extends SessionEnv>(context: Context<E>): Promise<Session | null> {
  const cookie = getCookie(context, cookieName);
  const secret = context.env.RELAY_SESSION_KEY;
  if (!cookie || !secret) return null;

  const [, payload, signature] = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(cookie) ?? [];
  if (!payload || !signature) return null;
  const bytes = decodeBase64Url(signature);
  if (encodeBase64Url(bytes) !== signature) return null;
  const key = await importKey(secret);
  if (!await crypto.subtle.verify("HMAC", key, bytes, encoder.encode(payload))) return null;

  try {
    const parsed = sessionPayloadSchema.safeParse(JSON.parse(decoder.decode(decodeBase64Url(payload))));
    if (!parsed.success) return null;
    const { userId, issuedAt, expiresAt } = parsed.data;
    if (expiresAt !== issuedAt + sessionMaxAge * 1000 || expiresAt <= Date.now()) return null;
    const invite = invites.find(({ user }) => user.id === userId);
    return invite ? { user: invite.user, expiresAt: new Date(expiresAt).toISOString() } : null;
  } catch {
    return null;
  }
}

export function clearSession<E extends SessionEnv>(context: Context<E>): Response {
  checkOrigin(context.req.raw, context.env.ALLOWED_ORIGINS);
  deleteCookie(context, cookieName, cookieOptions(context.req.url));
  return context.body(null, 204);
}

async function readInviteBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("Content-Length")) > inviteBodyLimit) {
    throw new HTTPException(413, { message: "Payload too large" });
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const bytes = new Uint8Array(inviteBodyLimit);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > inviteBodyLimit) {
        void reader.cancel().catch(() => {});
        throw new HTTPException(413, { message: "Payload too large" });
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    return JSON.parse(decoder.decode(bytes.subarray(0, length))) as unknown;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    return null;
  } finally {
    reader.releaseLock();
  }
}

function normalizeInvite(value: string): string {
  return value.normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
}

function reserveAttempt(ip: string) {
  const now = Date.now();
  let attempt = attempts.get(ip);
  if (!attempt || attempt.resetsAt <= now) {
    attempts.delete(ip);
    if (attempts.size >= trackedIpLimit) {
      const oldestIp = attempts.keys().next().value;
      if (oldestIp !== undefined) attempts.delete(oldestIp);
    }
    attempt = { failures: 0, requests: 0, resetsAt: now + attemptWindowMs };
    attempts.set(ip, attempt);
  }
  if (attempt.failures >= failureLimit || attempt.requests >= requestLimit) {
    throw new HTTPException(429, { message: "Too many login attempts" });
  }
  // 並行する要求も数えられるよう、本文を読む前に両方の枠を確保する。
  attempt.failures += 1;
  attempt.requests += 1;
  return attempt;
}

function cookieOptions(url: string) {
  const { protocol, hostname } = new URL(url);
  const localHttp = protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  return { httpOnly: true, path: "/", sameSite: "Lax" as const, secure: !localHttp };
}

function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}
