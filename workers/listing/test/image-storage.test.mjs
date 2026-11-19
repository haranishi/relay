import { INTERNAL_AUTH_HEADER, encodeAuthContext } from "@relay/contracts";
import { expect, it } from "vitest";
import listingWorker from "../src/index.ts";

it("returns 404 when image storage is disabled", async () => {
  const auth = encodeAuthContext({
    requestId: "00000000-0000-4000-8000-000000000001",
    userId: "giver",
    communityId: "campus",
    membershipId: "membership",
    membershipRole: "member",
    membershipVersion: 1
  });
  const response = await listingWorker.fetch(
    new globalThis.Request("https://relay.test/internal/images/sofa.webp", {
      headers: { [INTERNAL_AUTH_HEADER]: auth }
    }),
    {},
    {}
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "image_storage_disabled" });
});
