import { useEffect, useRef, useState } from "react";
import { pilotApi, PilotApiError, type Listing, type ListingSummary, type MatchingView } from "../lib/pilot-api";
import { pilotErrorMessage } from "../lib/pilot-copy";
import type { PilotReadPhase } from "./pilot-view";

type PilotData = {
  listings: ListingSummary[];
  listingId: string | null;
  listing: Listing | null;
  matching: MatchingView | null;
  phase: PilotReadPhase;
  error: string | null;
};

type RefreshOptions = { includeListings?: boolean; listingId?: string };
const initialData: PilotData = {
  listings: [], listingId: null, listing: null, matching: null, phase: "loading", error: null
};
const fastIntervalMs = 6_000;
const slowIntervalMs = 30_000;
const idleThresholdMs = 10 * 60 * 1000;
const reflectionLimitMs = 30_000;

function pilotPollDelay(unchangedForMs: number, reflectingForMs: number | null): number | null {
  if (reflectingForMs !== null) {
    const remaining = reflectionLimitMs - reflectingForMs;
    return remaining > 0 ? Math.min(fastIntervalMs, remaining) : null;
  }
  return unchangedForMs >= idleThresholdMs ? slowIntervalMs : fastIntervalMs;
}

export function usePilotData(onSessionExpired: () => void) {
  const [data, setData] = useState(initialData);
  const refresh = useRef<((options?: RefreshOptions) => Promise<void>) | null>(null);

  useEffect(() => {
    let current = initialData;
    let request: AbortController | undefined;
    let timer: number | undefined;
    let lastChange = Date.now();
    let reflectingSince: number | null = null;

    function show(next: PilotData) {
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      current = next;
      lastChange = Date.now();
      setData(next);
    }

    function isPaused() {
      return document.visibilityState === "hidden"
        || current.matching?.listingStatus === "COMPLETED"
        || current.phase === "reflection-paused";
    }

    function nextDelay() {
      const now = Date.now();
      return pilotPollDelay(now - lastChange, reflectingSince === null ? null : now - reflectingSince);
    }

    function schedule() {
      if (isPaused()) return;
      const delay = nextDelay();
      if (delay === null) pauseReflection();
      else timer = window.setTimeout(refreshAutomatically, delay);
    }

    function stopReading() {
      window.clearTimeout(timer);
      request?.abort();
    }

    function pauseReflection() {
      stopReading();
      show({ ...current, phase: "reflection-paused" });
    }

    function refreshAutomatically(includeListings = false) {
      if (isPaused()) return;
      if (nextDelay() === null) pauseReflection();
      else void read({ includeListings }, true);
    }

    async function read({ includeListings = true, listingId }: RefreshOptions = {}, automatic = false) {
      stopReading();
      request = new AbortController();
      const { signal } = request;
      if (listingId && listingId !== current.listingId) {
        reflectingSince = null;
        show({ ...initialData, listings: current.listings, listingId });
      }
      if (automatic && reflectingSince !== null) {
        timer = window.setTimeout(pauseReflection, Math.max(0, reflectingSince + reflectionLimitMs - Date.now()));
      }

      try {
        // 出品の詳細は固定。定期更新では選んだ出品の進行だけを読みに行く。
        const listings = includeListings || !current.listingId
          ? await pilotApi.listListings(signal) : current.listings;
        if (signal.aborted) return;
        const id = current.listingId ?? listings[0]?.id;
        if (!id) {
          show({ ...initialData, listings, phase: "ready" });
          return;
        }
        const [listing, matching] = await Promise.all([
          includeListings || !current.listing ? pilotApi.listing(id, signal) : current.listing,
          pilotApi.matching(id, signal).catch((error: unknown) => {
            if (error instanceof PilotApiError && error.status === 404) return null;
            throw error;
          })
        ]);
        if (signal.aborted) return;
        reflectingSince = matching ? null : reflectingSince ?? Date.now();
        const phase = matching ? "ready" : nextDelay() === null ? "reflection-paused" : "reflecting";
        show({ listings, listingId: id, listing, matching, phase, error: null });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof PilotApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        const forbidden = error instanceof PilotApiError && error.status === 403;
        show({
          ...(forbidden ? initialData : current),
          phase: forbidden || current.phase === "loading" ? "error" : current.phase,
          error: pilotErrorMessage(error)
        });
      } finally {
        if (!signal.aborted) {
          window.clearTimeout(timer);
          request = undefined;
          schedule();
        }
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        stopReading();
      } else refreshAutomatically(true);
    }

    refresh.current = read;
    document.addEventListener("visibilitychange", onVisibilityChange);
    refreshAutomatically(true);
    return () => {
      stopReading();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      refresh.current = null;
    };
  }, [onSessionExpired]);

  return { data, refresh };
}
