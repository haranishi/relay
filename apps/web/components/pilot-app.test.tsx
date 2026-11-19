import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Handoff, Listing, MatchingView, PilotUser } from "../lib/pilot-api";
import { PilotApp } from "./pilot-app";
import { listingTemplate } from "./pilot-view";

vi.mock("react", async (original) => ({
  ...await original<object>(),
  useState: vi.fn()
}));

const listing: Listing = {
  ...listingTemplate(new Date("2026-11-19T00:00:00Z")), id: "listing-1", ownerId: "giver", status: "OPEN", logistics: {}
};

function renderPilot(user: PilotUser | null, matching?: MatchingView) {
  const state = vi.mocked(useState);
  state.mockReturnValue([null, vi.fn()]);
  state.mockReturnValueOnce([user, vi.fn()]);
  if (matching) {
    state.mockReturnValueOnce([null, vi.fn()]).mockReturnValueOnce([false, vi.fn()])
      .mockReturnValueOnce([{
        listings: [], listingId: listing.id, listing, matching, phase: "ready", error: null
      }, vi.fn()]);
  }
  return renderToStaticMarkup(<PilotApp />);
}

beforeEach(() => {
  vi.mocked(useState).mockReset();
});

it("未ログインでは、招待コードの欄とログインボタンを表示する", () => {
  const html = renderPilot(null);
  expect(html).toContain("招待コードでログイン");
  expect(html).toContain("<label");
  const input = html.match(/<input[^>]*>/)?.[0];
  expect(input).toContain('name="code"');
  expect(input).toContain('type="password"');
  expect(input).toMatch(/autocomplete="off"/i);
  expect(input).toMatch(/autocapitalize="off"/i);
  expect(input).toMatch(/spellcheck="false"/i);
  expect(input).not.toContain("value=");
  expect(html).toContain(">ログイン</button>");
  expect(html).toContain('aria-live="polite"');
});

it("応募待ちの出品者には、何を待っているかと手動更新を表示する", () => {
  const html = renderPilot({ id: "giver", displayName: "出品者" }, {
    listingStatus: "OPEN", viewerRole: "giver", applications: [], handoffs: []
  });
  expect(html).toContain("応募を待っています");
  expect(html).toContain("画面は自動で更新されます。");
  expect(html).toContain("いま更新する");
  expect(html).toContain("受け渡しの進み具合");
  expect(html).toContain(listing.title);
  expect(html).not.toContain("候補を確定する");
});

it("選ばれた人には承諾期限と、確定・辞退の操作を表示する", () => {
  const handoff: Handoff = {
    id: "handoff-b", applicationId: "application-b", receiverId: "receiver-b",
    status: "PROPOSED", confirmationExpiresAt: "2026-11-20T00:00:00.000Z"
  };
  const html = renderPilot({ id: "receiver-b", displayName: "受取人B" }, {
    listingStatus: "RESERVED", viewerRole: "applicant", applications: [], handoffs: [handoff]
  });
  expect(html).toContain("あなたが受取人に選ばれました");
  expect(html).toContain("受け取りを確定する");
  expect(html).toContain("辞退する");
  expect(html.toLowerCase()).toContain(`datetime="${handoff.confirmationExpiresAt.toLowerCase()}"`);
  expect(html).toContain("09:00");
  expect(html).not.toContain("受取人A");
});

it("予備候補になったことを主役のカードで伝える", () => {
  const html = renderPilot({ id: "receiver-b", displayName: "受取人B" }, {
    listingStatus: "RESERVED", viewerRole: "applicant", handoffs: [],
    applications: [{
      id: "application-b", applicantId: "receiver-b", status: "BACKUP", availableSlots: listing.pickupSlots,
      message: "", transportMode: "car", helperCount: 2, createdAt: "2026-11-19T00:00:00Z"
    }]
  });
  expect(html).toMatch(/<h2[^>]*>予備候補に入っています<\/h2>/);
  expect(html).not.toContain("受け取りを確定する");
});
