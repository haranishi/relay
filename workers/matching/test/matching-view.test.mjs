import { createClient } from "@libsql/client";
import { readFileSync, readdirSync } from "node:fs";
import { URL } from "node:url";
import { INTERNAL_AUTH_HEADER, encodeAuthContext, matchingViewSchema } from "@relay/contracts";
import { createTursoClient, publishPendingOutbox, redactError } from "@relay/turso";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index.ts";

vi.mock("@relay/turso", async (original) => ({
  ...await original(),
  createTursoClient: vi.fn(),
  publishPendingOutbox: vi.fn(() => Promise.resolve(0))
}));

const viewPath = "listings/listing/matching";
const logEnv = { TURSO_DATABASE_URL: "libsql://db.example.test", TURSO_AUTH_TOKEN: "dummy-test-token.+$" };
let db;

beforeEach(async () => {
  vi.spyOn(globalThis.console, "error").mockImplementation(() => {});
  db = createClient({ url: "file::memory:" });
  vi.mocked(createTursoClient).mockReturnValue({
    execute: db.execute.bind(db),
    batch: db.batch.bind(db),
    close() {}
  });
  const migrations = new URL("../../../db/matching/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    await db.executeMultiple(readFileSync(new URL(file, migrations), "utf8"));
  }
  await db.executeMultiple(`
    INSERT INTO listing_snapshots VALUES ('listing','campus','giver','OPEN',0);
    INSERT INTO applications VALUES
      ('a','listing','campus','receiver-a','Message from A','[]','walk',0,'APPLIED',1),
      ('b','listing','campus','receiver-b','Message from B','[]','car',1,'APPLIED',2);
  `);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function request(path, { userId = "giver", communityId = "campus", method = "GET", body, key } = {}) {
  const headers = { "content-type": "application/json" };
  if (userId) headers[INTERNAL_AUTH_HEADER] = encodeAuthContext({
    requestId: globalThis.crypto.randomUUID(), communityId, userId,
    membershipId: "member", membershipRole: "member", membershipVersion: 1
  });
  if (key) headers["idempotency-key"] = key;
  return worker.fetch(new globalThis.Request("https://matching.test/internal/" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  }), {}, { waitUntil() {} });
}

async function viewAs(userId) {
  const response = await request(viewPath, { userId });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const view = await response.json();
  expect(matchingViewSchema.safeParse(view).success).toBe(true);
  return view;
}

it("shows all applications to the giver, a personal application to the applicant and none to other members", async () => {
  const giver = await viewAs("giver");
  expect(giver).toEqual({
    listingStatus: "OPEN", viewerRole: "giver",
    applications: [
      expect.objectContaining({ id: "a", applicantId: "receiver-a", message: "Message from A", status: "APPLIED" }),
      expect.objectContaining({ id: "b", applicantId: "receiver-b", message: "Message from B", status: "APPLIED" })
    ], handoffs: []
  });
  expect(await viewAs("receiver-a")).toEqual({
    listingStatus: "OPEN", viewerRole: "applicant", applications: [giver.applications[0]], handoffs: []
  });
  expect(await viewAs("other-member")).toEqual({
    listingStatus: "OPEN", viewerRole: "none", applications: [], handoffs: []
  });
});

it("reads selection retry state in one read batch", async () => {
  const path = "listings/listing/selection";
  const selection = {
    method: "POST", key: "unit-selection",
    body: { selectedApplicationId: "a", backupApplicationIds: ["b"], confirmationExpiresAt: "2099-03-01T00:00:00.000Z" }
  };
  const selected = await request(path, selection);
  expect(selected.status).toBe(201);
  const handoff = await selected.json();

  const execute = vi.fn(db.execute.bind(db));
  const batch = vi.fn(db.batch.bind(db));
  vi.mocked(createTursoClient).mockReturnValueOnce({ execute, batch, close() {} });

  const retried = await request(path, selection);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual(handoff);
  expect(execute).not.toHaveBeenCalled();
  expect(batch).toHaveBeenCalledExactlyOnceWith(expect.any(Array), "read");
  expect(batch.mock.calls[0][0]).toHaveLength(5);
});

it("allows B to find and complete their own handoff after A declines", async () => {
  const selected = await request("listings/listing/selection", {
    method: "POST", key: "unit-selection",
    body: { selectedApplicationId: "a", backupApplicationIds: ["b"], confirmationExpiresAt: "2099-03-01T00:00:00Z" }
  });
  expect(selected.status).toBe(201);
  const primary = await selected.json();
  expect((await viewAs("receiver-b")).handoffs).toEqual([]);

  const cancelled = await request("handoffs/" + primary.id + "/cancel", {
    userId: "receiver-a", method: "POST", body: { reason: "declined" }
  });
  expect(cancelled.status).toBe(200);
  const { nextHandoff } = await cancelled.json();

  const backup = await viewAs("receiver-b");
  expect(backup).toEqual({
    listingStatus: "RESERVED", viewerRole: "applicant",
    applications: [expect.objectContaining({ id: "b", applicantId: "receiver-b", status: "SELECTED" })],
    handoffs: [expect.objectContaining({ id: nextHandoff.id, applicationId: "b", receiverId: "receiver-b", status: "PROPOSED" })]
  });
  const declined = await viewAs("receiver-a");
  expect(declined.applications).toEqual([expect.objectContaining({ id: "a", status: "WITHDRAWN" })]);
  expect(declined.handoffs).toEqual([expect.objectContaining({ id: primary.id, receiverId: "receiver-a", status: "CANCELLED" })]);
  expect((await viewAs("giver")).handoffs).toEqual(expect.arrayContaining([...declined.handoffs, ...backup.handoffs]));
  expect((await viewAs("other-member")).handoffs).toEqual([]);

  const completed = await request("handoffs/" + backup.handoffs[0].id + "/complete", {
    userId: "receiver-b", method: "POST"
  });
  expect(completed.status).toBe(200);
  const completedView = await viewAs("receiver-b");
  expect(completedView.listingStatus).toBe("COMPLETED");
  expect(completedView.handoffs).toEqual([{ ...backup.handoffs[0], status: "COMPLETED" }]);
});

it("requires service authentication and limits matching views to the listing's community", async () => {
  expect((await request(viewPath, { userId: null })).status).toBe(401);
  for (const response of [
    await request(viewPath, { communityId: "another-campus" }),
    await request("listings/pending-publication/matching")
  ]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "request_failed", detail: "Listing is not available in matching service" });
  }
});

it("reports a DB failure in logs and sends a generic 500 response", async () => {
  await db.execute("DROP TABLE handoffs");
  const response = await request(viewPath);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "request_failed", detail: "An unexpected error occurred" });
  expect(globalThis.console.error).toHaveBeenCalledWith(expect.stringContaining("no such table"));
});

it("redacts the exact URL, the host in an HTTPS URL and the token before truncating", () => {
  const error = new Error("Failed at " + logEnv.TURSO_DATABASE_URL + " and https://db.example.test with " +
    logEnv.TURSO_AUTH_TOKEN + " " + "x".repeat(500));
  const message = redactError(error, logEnv);
  expect(message).toHaveLength(500);
  expect(message).toMatch(/^Error: Failed at <REDACTED> and https:\/\/<REDACTED> with <REDACTED> x+$/);
});

it("redacts the endpoint without its scheme when the configured URL cannot be parsed", () => {
  expect(redactError("Failure at endpoint [test", { TURSO_DATABASE_URL: "libsql://endpoint [test" }))
    .toBe("Failure at <REDACTED>");
});

it("preserves an error when redaction settings are empty or missing", () => {
  for (const env of [{}, { TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "" }]) {
    expect(redactError(new Error("DB unavailable"), env)).toBe("Error: DB unavailable");
  }
});

it("handles scheduled outbox failure and logs only the redacted error", async () => {
  vi.mocked(publishPendingOutbox).mockRejectedValueOnce(
    new Error("DB unavailable at https://db.example.test with " + logEnv.TURSO_AUTH_TOKEN)
  );
  const waitUntil = vi.fn();
  worker.scheduled({}, logEnv, { waitUntil });
  expect(waitUntil).toHaveBeenCalledOnce();
  await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  expect(globalThis.console.error).toHaveBeenCalledWith(JSON.stringify({
    service: "matching", job: "outbox", error: "Error: DB unavailable at https://<REDACTED> with <REDACTED>"
  }));
});
