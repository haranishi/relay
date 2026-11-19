import { describe, expect, it, vi } from "vitest";
import type { Application, Handoff, Listing, MatchingView, PilotUser } from "../lib/pilot-api";
import { buildPilotView, chooseApplication, listingTemplate, selectionAttempt, selectionFromChoices, type PilotReadPhase } from "./pilot-view";

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

describe("応募者カードでの選定", () => {
  const second = { ...application, id: "application-b", applicantId: bob.id, createdAt: "2026-11-19T11:00:00Z" };
  const third = { ...application, id: "application-c", applicantId: "receiver-c", createdAt: "2026-11-19T12:00:00Z" };
  const fourth = { ...application, id: "application-d", applicantId: "receiver-d", createdAt: "2026-11-19T13:00:00Z" };
  const applicants = [application, second, third, fourth];

  it("別の人を第一候補にすると、前の第一候補は選ばないに戻る", () => {
    const first = chooseApplication(new Map(), application.id, "primary");
    const changed = chooseApplication(first, second.id, "primary");
    expect(changed.has(application.id)).toBe(false);
    expect(selectionFromChoices(changed, applicants)).toEqual({ primary: second, backups: [] });
    expect(selectionFromChoices(first, applicants).primary).toBe(application);
    expect(selectionFromChoices(chooseApplication(changed, second.id, "none"), applicants).primary).toBeUndefined();
  });

  it("予備は2人までで、選んだ順にかかわらず応募順で確定する", () => {
    const first = chooseApplication(new Map(), third.id, "backup");
    const full = chooseApplication(first, second.id, "backup");
    expect(chooseApplication(full, fourth.id, "backup")).toBe(full);
    expect(selectionFromChoices(full, applicants).backups).toEqual([second, third]);

    const promoted = chooseApplication(full, second.id, "primary");
    const replaced = chooseApplication(promoted, fourth.id, "backup");
    expect(selectionFromChoices(replaced, applicants)).toEqual({ primary: second, backups: [third, fourth] });
  });

  it("更新でカードから消えた応募は確定に含めない", () => {
    const first = chooseApplication(new Map(), application.id, "primary");
    const choices = chooseApplication(first, second.id, "backup");
    expect(selectionFromChoices(choices, [third])).toEqual({ primary: undefined, backups: [] });
  });
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

describe("進み具合の『辞退・繰り上げ』", () => {
  const step = (view: ReturnType<typeof buildPilotView>) => view.progress[2];

  it("出品者には、辞退の有無をはっきり伝える", () => {
    const withDecline = buildPilotView(giver, listing, { ...withdrawn, viewerRole: "giver" });
    expect(step(withDecline)).toMatchObject({ state: "done", detail: "辞退あり" });
    const noDecline = buildPilotView(giver, listing, { ...completed, viewerRole: "giver" });
    expect(step(noDecline)).toMatchObject({ state: "skipped", detail: "辞退はありませんでした" });
  });

  it("受取人は、ほかの人の辞退が見えないので、完了後は自分の分だけを伝える", () => {
    const handoffs: Handoff[] = [
      { ...proposal, status: "CANCELLED" },
      { ...proposal, id: "handoff-b", applicationId: "application-b", receiverId: bob.id, status: "COMPLETED" }
    ];
    expect(step(buildPilotView(giver, listing, { ...completed, viewerRole: "giver", handoffs })))
      .toMatchObject({ state: "done", detail: "辞退あり" });
    // 受取人Bには、Aの辞退が見えない。自分の分で辞退が無かったので、この段そのものを出さない。
    for (const view of [buildPilotView(bob, listing, { ...completed, handoffs }), buildPilotView(bob, listing, completed)]) {
      expect(view.progress.map(({ label }) => label)).toEqual(["応募", "選定", "完了"]);
    }
    // 自分が辞退した受取人Aには、「辞退あり」を出す。
    expect(step(buildPilotView(alice, listing, { ...withdrawn, listingStatus: "COMPLETED" })))
      .toMatchObject({ state: "done", detail: "辞退あり" });
    expect(step(buildPilotView(bob, listing, { ...open, viewerRole: "applicant", applications: [] })))
      .toMatchObject({ state: "idle", detail: "必要に応じて次の候補へ" });
  });
});
