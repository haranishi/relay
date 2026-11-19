import { useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pilotApi, PilotApiError, type Listing, type MatchingView } from "../lib/pilot-api";
import { listingTemplate } from "./pilot-view";
import { usePilotData } from "./use-pilot-data";

vi.mock("react", async (original) => ({
  ...await original<object>(),
  useEffect: vi.fn(),
  useState: vi.fn()
}));

const listing: Listing = {
  ...listingTemplate(new Date("2026-11-19T00:00:00Z")), id: "listing-1", ownerId: "giver", status: "OPEN", logistics: {}
};
const open: MatchingView = { listingStatus: "OPEN", viewerRole: "giver", applications: [], handoffs: [] };
const onSessionExpired = vi.fn();
const setData = vi.fn<(data: unknown) => void>();
let cleanup: (() => void) | undefined;

function Probe() {
  usePilotData(onSessionExpired);
  return null;
}

function startPolling() {
  const fakeDocument = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  renderToStaticMarkup(<Probe />);
  const setup = vi.mocked(useEffect).mock.calls[0]?.[0];
  cleanup = setup?.() || undefined;
  return (visibilityState: "hidden" | "visible") => {
    fakeDocument.visibilityState = visibilityState;
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
  vi.mocked(useEffect).mockReset();
  vi.mocked(useState).mockReturnValue([undefined, setData]);
  setData.mockReset();
  vi.spyOn(pilotApi, "listListings").mockResolvedValue([{
    id: listing.id, title: listing.title, updatedAt: "2026-11-19T00:00:00Z"
  }]);
  vi.spyOn(pilotApi, "listing").mockResolvedValue(listing);
});

afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("非表示の間は読み直さず、表示に戻るとすぐ読んで、完了したら止める", async () => {
  const matching = vi.spyOn(pilotApi, "matching").mockResolvedValue(open);
  const visibility = startPolling();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(matching).toHaveBeenCalledTimes(2);
  expect(pilotApi.listing).toHaveBeenCalledTimes(1);

  visibility("hidden");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(matching).toHaveBeenCalledTimes(2);

  matching.mockResolvedValue({ ...open, listingStatus: "COMPLETED" });
  visibility("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(matching).toHaveBeenCalledTimes(3);
  expect(setData.mock.lastCall?.[0]).toMatchObject({ matching: { listingStatus: "COMPLETED" } });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(matching).toHaveBeenCalledTimes(3);
});

it("10分間変化がなければ30秒間隔で照会する", async () => {
  const matching = vi.spyOn(pilotApi, "matching").mockResolvedValue(open);
  startPolling();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  const calls = matching.mock.calls.length;
  expect(calls).toBe(101);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(matching).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(1);
  expect(matching).toHaveBeenCalledTimes(calls + 1);
});

it("照会が404なら30秒だけ自動で待ち、途中の通信が終わらなくても手動更新へ移る", async () => {
  const matching = vi.spyOn(pilotApi, "matching").mockRejectedValueOnce(new PilotApiError(404))
    .mockImplementation(() => new Promise(() => {}));
  startPolling();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(setData).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "reflecting" }));
  expect(matching).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(1);
  expect(setData).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "reflection-paused" }));
  expect(matching.mock.calls[1]?.[1].aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(matching).toHaveBeenCalledTimes(2);
});
