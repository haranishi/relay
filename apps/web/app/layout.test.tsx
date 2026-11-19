import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadMetadata(siteUrl: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", siteUrl);
  return (await import("./layout")).metadata;
}

it("公開 URL があるときは、og:url・canonical・og:image を出す", async () => {
  const metadata = await loadMetadata("https://relay.example");
  expect(String(metadata.metadataBase)).toBe("https://relay.example/");
  expect(metadata.alternates?.canonical).toBe("/");
  expect(metadata.openGraph).toMatchObject({
    url: "/",
    images: [{ url: "/og.png", width: 1200, height: 630 }]
  });
  expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
});

it("公開 URL が無いときは、localhost を指す住所を作らないよう、画像も URL も出さない", async () => {
  const metadata = await loadMetadata("");
  expect(metadata.metadataBase).toBeUndefined();
  expect(metadata.alternates).toBeUndefined();
  expect(metadata.openGraph).not.toHaveProperty("url");
  expect(metadata.openGraph).not.toHaveProperty("images");
  expect(metadata.twitter).toMatchObject({ card: "summary" });
});
