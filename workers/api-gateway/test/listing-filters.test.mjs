import { URL, URLSearchParams } from "node:url";
import { expect, it } from "vitest";
import gateway from "../src/index.ts";

it("forwards the status, category and Japanese search text to the feed", async () => {
  const url = new URL("https://relay.test/api/v1/communities/campus/listings");
  url.search = new URLSearchParams({ status: "COMPLETED", category: "books", q: "本 & 机" });
  const response = await gateway.fetch(
    new globalThis.Request(url, {
      headers: { "x-relay-demo-user": "member", "x-relay-community-id": "campus" }
    }),
    {
      ALLOW_DEMO_AUTH: "true",
      COMMUNITY_SERVICE: { fetch: () => globalThis.Response.json({
        membershipId: "member", membershipRole: "member", membershipVersion: 1
      }) },
      READ_MODEL_SERVICE: { fetch: (request) => globalThis.Response.json(
        Object.fromEntries(new URL(request.url).searchParams)
      ) }
    },
    {}
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "COMPLETED", category: "books", q: "本 & 机" });
});
