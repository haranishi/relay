import { describe, expect, it, vi } from "vitest";
import type { Application, Handoff, Listing, MatchingView, PilotUser } from "../lib/pilot-api";
import { buildPilotView, listingTemplate, selectionAttempt, type PilotReadPhase } from "./pilot-view";

const giver = { id: "giver", displayName: "出品者" };
const alice = { id: "receiver-a", displayName: "受取人A" };
const bob = { id: "receiver-b", displayName: "受取人B" };
const listing: Listing = {
  ...listingTemplate(new Date("2026-11-19T00:00:00Z")), id: "listing-1", ownerId: giver.id, status: "OPEN", logistics: {}
};
const application: Application = {
  id: "application-a", applicantId: alice.id, status: "APPLIED",
  message: "車で行きます", availableSlots: listing.pickupSlots.slice(0, 1),
  transportMode: "car", helperCount: 1, createdAt: "2026-11-19T10:00:00Z"
};
const proposal: Handoff = {
  id: "handoff-a", applicationId: application.id, receiverId: alice.id,
  status: "PROPOSED", confirmationExpiresAt: "2026-11-20T10:00:00Z"
};
const open: MatchingView = { listingStatus: "OPEN", viewerRole: "none", applications: [], handoffs: [] };
const ownerView: MatchingView = { ...open, viewerRole: "giver" };
const applied: MatchingView = { ...open, viewerRole: "applicant", applications: [application] };
const selected: MatchingView = {
  ...applied, listingStatus: "RESERVED", handoffs: [proposal], applications: [{ ...application, status: "SELECTED" }]
};
const withdrawn: MatchingView = {
  ...selected, applications: [{ ...application, status: "WITHDRAWN" }], handoffs: [{ ...proposal, status: "CANCELLED" }]
};
const completed: MatchingView = {
  ...selected, listingStatus: "COMPLETED", handoffs: [{ ...proposal, status: "COMPLETED" }]
};

type Case = {
  name: string;
  user: PilotUser | null;
  listing: Listing | null;
  matching: MatchingView | null;
  phase?: PilotReadPhase;
  card: ReturnType<typeof buildPilotView>["card"];
};

const cases: Case[] = [
  { name: "未ログイン", user: null, listing: null, matching: null, card: { kind: "invite" } },
  { name: "出品者・出品なし", user: giver, listing: null, matching: null, card: { kind: "create" } },
  { name: "出品者・応募なし", user: giver, listing, matching: ownerView, card: { kind: "wait-applications" } },
  { name: "出品者・応募あり", user: giver, listing, matching: { ...ownerView, applications: [application] },
    card: { kind: "select", applications: [application] } },
  { name: "出品者・承諾待ち", user: giver, listing, matching: { ...selected, viewerRole: "giver" },
    card: { kind: "wait-confirmation", handoff: proposal } },
  { name: "出品者・完了", user: giver, listing, matching: { ...completed, viewerRole: "giver" }, card: { kind: "completed" } },
  { name: "受取人・未応募", user: alice, listing, matching: open, card: { kind: "apply" } },
  { name: "受取人・応募済み", user: alice, listing, matching: applied, card: { kind: "wait-selection", backup: false } },
  { name: "受取人・予備候補", user: alice, listing, matching: {
    ...applied, listingStatus: "RESERVED", applications: [{ ...application, status: "BACKUP" }]
  }, card: { kind: "wait-selection", backup: true } },
  { name: "受取人・選ばれた", user: alice, listing, matching: selected, card: { kind: "receive", handoff: proposal } },
  { name: "受取人・辞退", user: alice, listing, matching: withdrawn, card: { kind: "declined" } },
  { name: "受取人・自分の受け渡しが完了", user: alice, listing, matching: completed, card: { kind: "completed" } },
  { name: "受取人・他の人の承諾待ち", user: bob, listing, matching: { ...open, listingStatus: "RESERVED" },
    card: { kind: "other-recipient" } },
  { name: "受取人・他の人の受け渡しが完了", user: bob, listing, matching: { ...open, listingStatus: "COMPLETED" },
    card: { kind: "other-recipient" } },
  { name: "受取人・見送り", user: alice, listing, matching: {
    ...open, listingStatus: "RESERVED", applications: [{ ...application, status: "REJECTED" }]
  }, card: { kind: "other-recipient" } },
  { name: "受取人・応募取り消し", user: alice, listing, matching: {
    ...open, listingStatus: "COMPLETED", applications: [{ ...application, status: "WITHDRAWN" }]
  }, card: { kind: "other-recipient" } },
  { name: "受取人・出品なし", user: alice, listing: null, matching: null, card: { kind: "no-listing" } },
  { name: "ほかのメンバー・閲覧のみ", user: { id: "member", displayName: "参加者" }, listing, matching: open,
    card: { kind: "view-only" } },
  { name: "照会が404で反映を待つ", user: giver, listing, matching: null, phase: "reflecting", card: { kind: "reflecting" } },
  { name: "反映待ちが30秒を過ぎた", user: alice, listing, matching: null, phase: "reflection-paused",
    card: { kind: "reflection-paused" } }
];

describe("主役のカード", () => {
  it.each(cases)("$name", ({ user, listing, matching, phase, card }) => {
    expect(buildPilotView(user, listing, matching, phase).card).toEqual(card);
  });

  it("完了後は予備のままでも他の人に決まったと表示する", () => {
    const matching: MatchingView = {
      ...open, listingStatus: "COMPLETED", viewerRole: "applicant", applications: [{ ...application, status: "BACKUP" }]
    };
    expect(buildPilotView(alice, listing, matching).card.kind).toBe("other-recipient");
  });

  it("出品者の履歴には辞退と次の候補が出る。辞退した本人には次の候補の名前が出ない", () => {
    const reoffered: Handoff = { ...proposal, id: "handoff-b", applicationId: "application-b", receiverId: bob.id };
    const matching: MatchingView = {
      ...withdrawn, viewerRole: "giver", handoffs: [...withdrawn.handoffs, reoffered]
    };
    const owner = buildPilotView(giver, listing, matching);
    expect(owner.listingStatus).toBe("RESERVED");
    expect(owner.card).toEqual({ kind: "wait-confirmation", handoff: reoffered });
    expect(owner.progress.find(({ label }) => label === "辞退・繰り上げ")?.state).toBe("done");
    expect(owner.events.map(({ label }) => label)).toEqual([
      "受取人Aさんが応募しました", "受取人Aさんが受取人に選ばれました", "受取人Aさんが辞退しました",
      "受取人Bさんが次の受取候補になりました"
    ]);

    const receiver = buildPilotView(alice, listing, { ...matching, viewerRole: "applicant" });
    expect(receiver.card.kind).toBe("declined");
    expect(receiver.events.map(({ label }) => label)).toEqual([
      "あなたが応募しました", "あなたが受取人に選ばれました", "あなたが辞退しました"
    ]);
    expect(buildPilotView(bob, listing, { ...matching, viewerRole: "applicant", handoffs: [reoffered] }).card)
      .toEqual({ kind: "receive", handoff: reoffered });
  });
});

it("ひな形は日本の暦日を基準に翌日、翌々日、3日後を設定する", () => {
  const template = listingTemplate(new Date("2026-12-31T16:00:00Z"));
  expect(template.pickupSlots).toEqual([
    { startAt: "2027-01-02T10:00:00+09:00", endAt: "2027-01-02T12:00:00+09:00" },
    { startAt: "2027-01-03T14:00:00+09:00", endAt: "2027-01-03T16:00:00+09:00" }
  ]);
  expect(template.pickupDeadline).toBe("2027-01-04T18:00:00+09:00");
});

it("同じ選定を再試行するとキーと期限を保ち、別の候補を選ぶと新しく発行する", () => {
  const now = Date.parse("2026-11-19T09:00:00Z");
  const newKey = vi.fn().mockReturnValueOnce("dummy-first-key").mockReturnValueOnce("dummy-second-key");
  const attempt = selectionAttempt("application-a", ["application-b"], null, now, newKey);
  expect(attempt.key).toBe("dummy-first-key");
  expect(attempt.input.confirmationExpiresAt).toBe("2026-11-20T09:00:00.000Z");
  expect(selectionAttempt("application-a", ["application-b"], attempt, now + 1000, newKey)).toBe(attempt);
  expect(selectionAttempt("application-b", [], attempt, now + 1000, newKey).key).toBe("dummy-second-key");
  expect(newKey).toHaveBeenCalledTimes(2);
});
