import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Application, Handoff, Listing, MatchingView, PilotUser } from "../lib/pilot-api";
import { PickupSlotText } from "./pickup-slot-text";
import { PilotApp } from "./pilot-app";
import { SelectRecipientsForm } from "./pilot-forms";
import { listingTemplate, type ApplicationChoices } from "./pilot-view";

vi.mock("react", async (original) => ({
  ...await original<object>(),
  useState: vi.fn()
}));

const listing: Listing = {
  ...listingTemplate(new Date("2026-11-19T00:00:00Z")), id: "listing-1", ownerId: "giver", status: "OPEN", logistics: {}
};
const applicantA: Application = {
  id: "application-a", applicantId: "receiver-a", status: "APPLIED", availableSlots: listing.pickupSlots,
  message: "", transportMode: "car", helperCount: 1, createdAt: "2026-11-19T01:00:00Z"
};
const applicantB: Application = {
  ...applicantA, id: "application-b", applicantId: "receiver-b", createdAt: "2026-11-19T02:00:00Z"
};

function renderPilot(user: PilotUser | null, matching?: MatchingView) {
  const state = vi.mocked(useState);
  state.mockImplementation((initial?: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, vi.fn()]);
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
  expect(html).toMatch(/<p>Relay の試験運用です。招待された方だけが入れます。招待コードは、案内してくれた人に聞いてください。<\/p><label/);
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
  expect(html).toContain('class="pickup-deadline-active"');
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
  expect(html).toContain('09:00</time><span class="pilot-nowrap">（日本時間）</span>です。');
  // 承諾を求めているあいだは、承諾期限だけを強調する（受取期限は赤くしない）
  expect(html).not.toContain('class="pickup-deadline-active"');
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

it("応募フォームの上に、出品の題名と受取場所を表示する", () => {
  const html = renderPilot({ id: "receiver-a", displayName: "受取人A" }, {
    listingStatus: "OPEN", viewerRole: "none", applications: [], handoffs: []
  });
  expect(html).toContain(`対象：${listing.title}（${listing.pickupArea}）</p><form`);
  expect(html.match(/11月20日\(金\) <span class="pilot-nowrap">10:00〜12:00<\/span>/g)).toHaveLength(2);
});

it("日をまたぐ時間帯も、日付ごとに時刻をひとまとまりにする", () => {
  const slot = { startAt: "2026-11-20T22:00:00+09:00", endAt: "2026-11-21T01:00:00+09:00" };
  expect(renderToStaticMarkup(<PickupSlotText slot={slot} />)).toBe(
    '<span>11月20日(金) <span class="pilot-nowrap">22:00</span>〜11月21日(土) <span class="pilot-nowrap">01:00</span></span>'
  );
});

it("応募ごとに名前のついたラジオ群があり、第一候補が決まるまで確定できない", () => {
  const html = renderPilot({ id: "giver", displayName: "出品者" }, {
    listingStatus: "OPEN", viewerRole: "giver", applications: [applicantA, applicantB], handoffs: []
  });
  const groups = html.match(/<fieldset\b.*?<\/fieldset>/g) ?? [];
  expect(groups).toHaveLength(2);
  for (const [index, group] of groups.entries()) {
    expect(group).toContain(`>受取人${index === 0 ? "A" : "B"}の扱い</legend>`);
    const radios = group.match(/<input type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    expect(radios.every((radio) => radio.includes(`name="recipient-application-${index === 0 ? "a" : "b"}"`))).toBe(true);
    expect(radios.find((radio) => radio.includes('value="none"'))).toContain('checked=""');
    expect(group.match(/<span>[^<]+<\/span><\/label>/g)).toEqual([
      "<span>第一候補</span></label>", "<span>予備候補</span></label>", "<span>選ばない</span></label>"
    ]);
  }
  expect(html).toContain("第一候補を1人選ぶと、候補を確定できます。");
  expect(html).toContain("予備候補は2人までです。予備候補は応募が早い順に繰り上がります。");
  expect(html).toContain("第一候補：未選択／予備：なし");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>候補を確定する<\/button>/);
});

it("選んだ候補をバッジと要約に出し、予備が2人いると他の人の予備ボタンを無効にする", () => {
  const applicantC = { ...applicantB, id: "application-c", applicantId: "receiver-c", createdAt: "2026-11-19T03:00:00Z" };
  const choices: ApplicationChoices = new Map([[applicantA.id, "primary"], [applicantC.id, "backup"], [applicantB.id, "backup"]]);
  vi.mocked(useState).mockReturnValueOnce([choices, vi.fn()]);
  const html = renderToStaticMarkup(<SelectRecipientsForm applications={[applicantA, applicantB, applicantC]}
    listingId={listing.id} busy={false} runAction={vi.fn()} />);
  expect(html).toContain('<h3>受取人A</h3><span class="pilot-choice-badge">第一候補</span>');
  expect(html).toContain('<h3>受取人B</h3><span class="pilot-choice-badge">予備候補</span>');
  expect(html).toContain("第一候補：受取人A／予備：受取人B、参加者");
  const backups = (html.match(/<input type="radio"[^>]*>/g) ?? []).filter((radio) => radio.includes('value="backup"'));
  expect(backups).toHaveLength(3);
  expect(backups[0]).toContain('disabled=""');
  expect(backups.slice(1).every((radio) => radio.includes('checked=""') && !radio.includes('disabled=""'))).toBe(true);
  expect(html).toContain('<button class="pilot-button pilot-main-action" type="submit">候補を確定する</button>');
});

it.each([
  { id: "giver", displayName: "出品者", viewerRole: "giver" as const },
  { id: "receiver-a", displayName: "受取人A", viewerRole: "applicant" as const }
])("完了後は手動更新と受取期限の強調を外し、出品者には省略の横棒を、受取人には辞退の段を出さない（$displayName）", ({ viewerRole, ...user }) => {
  const html = renderPilot(user, {
    listingStatus: "COMPLETED", viewerRole, applications: [], handoffs: [{
      id: "handoff-a", applicationId: applicantA.id, receiverId: applicantA.applicantId,
      status: "COMPLETED", confirmationExpiresAt: "2026-11-20T00:00:00.000Z"
    }]
  });
  expect(html).toContain("受け渡しが完了しました");
  if (viewerRole === "giver") {
    expect(html).toContain('class="progress-skipped"><span aria-hidden="true" class="progress-mark">—</span>');
    expect(html).toContain("辞退はありませんでした");
  } else {
    // 受取人には、ほかの人の辞退が見えない。「辞退・繰り上げ」の段は、失敗のように見えないよう、出さない
    expect(html).not.toContain("辞退・繰り上げ");
    expect(html).not.toContain("progress-skipped");
  }
  expect(html).toContain("受取期限");
  expect(html).not.toContain('class="pickup-deadline-active"');
  expect(html).not.toContain("いま更新する");
});
