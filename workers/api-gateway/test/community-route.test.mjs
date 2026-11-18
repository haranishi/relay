import { expect, it, vi } from "vitest";
import gateway from "../src/index.ts";

it("resolves the membership for the community named in the listings URL", async () => {
  const resolve = vi.fn(() => globalThis.Response.json({
    membershipId: "membership", membershipRole: "member", membershipVersion: 1
  }));
  const response = await gateway.fetch(
    new globalThis.Request("https://relay.test/api/v1/communities/campus/listings", {
      headers: { "x-relay-demo-user": "member" }
    }),
    {
      ALLOW_DEMO_AUTH: "true",
      COMMUNITY_SERVICE: { fetch: resolve },
      READ_MODEL_SERVICE: { fetch: () => globalThis.Response.json({ items: [] }) }
    },
    {}
  );
  expect(response.status).toBe(200);
  expect(await resolve.mock.calls[0][0].json()).toEqual({ userId: "member", communityId: "campus" });
});
