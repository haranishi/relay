import { afterEach, expect, it, vi } from "vitest";
import { pilotApi, pilotCommunityPath, PilotApiError } from "./pilot-api";
import { pilotErrorMessage } from "./pilot-copy";

afterEach(() => vi.unstubAllGlobals());

it("募集中・選定中・完了済みをまとめて、重複を除いた更新順の一覧を返す", async () => {
  const open = { id: "older", title: "ソファ", updatedAt: "2026-11-19T00:00:00Z" };
  const reserved = { id: "middle", title: "棚", updatedAt: "2026-11-20T00:00:00Z" };
  const completed = { ...open, title: "ソファ", updatedAt: "2026-11-21T00:00:00Z", activeReceiverId: "receiver-b" };
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ items: [open] }))
    .mockResolvedValueOnce(Response.json({ items: [reserved] }))
    .mockResolvedValueOnce(Response.json({ items: [completed] }));
  vi.stubGlobal("fetch", fetchMock);

  const listings = await pilotApi.listListings(new AbortController().signal);
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    `${pilotCommunityPath}/listings`, `${pilotCommunityPath}/listings?status=RESERVED`, `${pilotCommunityPath}/listings?status=COMPLETED`
  ]);
  expect(listings).toEqual([{ ...open, updatedAt: completed.updatedAt }, reserved]);
  expect(fetchMock.mock.calls.every(([, options]) => options?.credentials === "same-origin")).toBe(true);
});

it("辞退と完了は指定の受け渡しだけを更新し、返された次候補の情報を使わない", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ nextHandoff: { receiverId: "receiver-b" } }))
    .mockResolvedValueOnce(Response.json({ status: "COMPLETED" }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(pilotApi.decline("handoff-a")).resolves.toBeUndefined();
  await expect(pilotApi.complete("handoff-b")).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenNthCalledWith(1, `${pilotCommunityPath}/handoffs/handoff-a/cancel`, expect.objectContaining({
    method: "POST", credentials: "same-origin", body: '{"reason":"declined"}'
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(2, `${pilotCommunityPath}/handoffs/handoff-b/complete`, expect.objectContaining({ method: "POST" }));
});

it("HTTP 状態とエラーコードを取り出す", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({ error: "DUPLICATE_APPLICATION", detail: "この出品には応募済みです" }, { status: 409 })
  ));
  await expect(pilotApi.session(new AbortController().signal)).rejects.toMatchObject({
    status: 409, code: "DUPLICATE_APPLICATION", detail: "この出品には応募済みです"
  });
});

it("失敗の原因ごとに案内し、サーバー障害の詳細を出さない", () => {
  expect(pilotErrorMessage(new PilotApiError(401), true)).toContain("招待コードを確認して");
  expect(pilotErrorMessage(new PilotApiError(401))).toContain("ログインの有効期限が切れました");
  expect(pilotErrorMessage(new PilotApiError(403))).toBe("このコミュニティの参加者ではありません");
  expect(pilotErrorMessage(new PilotApiError(429))).toContain("5分ほど待って");
  expect(pilotErrorMessage(new PilotApiError(409, "DUPLICATE_APPLICATION"))).toBe("すでに応募しています");
  expect(pilotErrorMessage(new PilotApiError(409, "HANDOFF_EXPIRED", "承諾期限を過ぎています"))).toBe("承諾期限を過ぎています");
  expect(pilotErrorMessage(new PilotApiError(400, "invalid_listing", "受取場所を確認してください"))).toBe("受取場所を確認してください");
  expect(pilotErrorMessage(new PilotApiError(502, "gateway_unavailable", "dummy detail"))).toContain("つながりませんでした");
  expect(pilotErrorMessage(new PilotApiError(0))).toContain("つながりませんでした");
});
