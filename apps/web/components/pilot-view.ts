import type { Application, Handoff, Listing, ListingInput, MatchingView, PilotUser, SelectionInput } from "../lib/pilot-api";
import { demoSofaDescription, participantName } from "../lib/pilot-copy";

type PilotCard =
  | { kind: "invite" | "loading" | "load-error" | "create" | "no-listing" | "reflecting" | "reflection-paused" }
  | { kind: "wait-applications" | "apply" | "declined" | "completed" | "other-recipient" | "closed" | "view-only" }
  | { kind: "select"; applications: Application[] }
  | { kind: "wait-confirmation"; handoff?: Handoff }
  | { kind: "wait-selection"; backup: boolean }
  | { kind: "receive"; handoff: Handoff };

export type PilotReadPhase = "loading" | "error" | "ready" | "reflecting" | "reflection-paused";
type ProgressStep = { label: string; state: "done" | "active" | "idle"; detail: string };
type PilotEvent = { id: string; label: string; date?: string };

function primaryCard(
  user: PilotUser | null,
  listing: Listing | null,
  matching: MatchingView | null,
  phase: PilotReadPhase
): PilotCard {
  if (!user) return { kind: "invite" };
  if (phase === "loading") return { kind: "loading" };
  if (phase === "error") return { kind: "load-error" };
  if (phase === "reflecting" || phase === "reflection-paused") return { kind: phase };
  if (!listing) return { kind: user.id === "giver" ? "create" : "no-listing" };
  if (!matching) return { kind: "loading" };

  const { listingStatus, viewerRole } = matching;
  if (listing.ownerId === user.id && viewerRole === "giver") {
    if (listingStatus === "COMPLETED") return { kind: "completed" };
    if (listingStatus === "RESERVED") {
      const handoff = matching.handoffs.find((item) => item.status === "PROPOSED" || item.status === "CONFIRMED");
      return handoff ? { kind: "wait-confirmation", handoff } : { kind: "wait-confirmation" };
    }
    if (listingStatus === "OPEN") {
      const applications = matching.applications.filter((item) => item.status === "APPLIED");
      return applications.length ? { kind: "select", applications } : { kind: "wait-applications" };
    }
    return { kind: "closed" };
  }
  if (user.id !== "receiver-a" && user.id !== "receiver-b") return { kind: "view-only" };

  const application = matching.applications.find((item) => item.applicantId === user.id);
  const handoff = matching.handoffs.findLast((item) => item.receiverId === user.id);
  if (listingStatus === "COMPLETED" && handoff?.status === "COMPLETED") return { kind: "completed" };
  if (listingStatus === "RESERVED" && handoff?.status === "PROPOSED") return { kind: "receive", handoff };
  if (listingStatus === "RESERVED" && handoff?.status === "CONFIRMED") return { kind: "wait-confirmation" };
  if (handoff?.status === "CANCELLED") return { kind: "declined" };
  if (listingStatus === "COMPLETED") return { kind: "other-recipient" };
  if (application?.status === "BACKUP") return { kind: "wait-selection", backup: true };
  if (listingStatus === "RESERVED" || application?.status === "WITHDRAWN" || application?.status === "REJECTED") {
    return { kind: "other-recipient" };
  }
  if (listingStatus === "OPEN") {
    return application ? { kind: "wait-selection", backup: false } : { kind: "apply" };
  }
  return { kind: "closed" };
}

function progressSteps(status: MatchingView["listingStatus"], applications: Application[], handoffs: Handoff[], owner: boolean): ProgressStep[] {
  const finished = status === "COMPLETED";
  const selected = status === "RESERVED" || finished || handoffs.length > 0;
  const hasApplication = applications.length > 0 || selected;
  const declined = handoffs.some((item) => item.status === "CANCELLED");
  const reopened = status === "OPEN" && declined;
  return [
    { label: "応募", state: hasApplication ? "done" : "active", detail: hasApplication ? "応募あり" : "応募待ち" },
    { label: "選定", state: reopened ? "active" : selected ? "done" : hasApplication ? "active" : "idle",
      detail: reopened ? "再選定待ち" : selected ? "選定済み" : "選定待ち" },
    { label: "辞退・繰り上げ", state: declined ? "done" : "idle",
      // 受取人には、ほかの人の辞退は見えない。完了したあとは、自分の分に辞退が無かったことだけを伝える。
      detail: declined ? "辞退あり" : finished ? (owner ? "辞退はありませんでした" : "あなたの分では、ありませんでした") : "必要に応じて次の候補へ" },
    { label: "完了", state: finished ? "done" : status === "RESERVED" ? "active" : "idle",
      detail: finished ? "受け渡し済み" : status === "RESERVED" ? "受取人の操作待ち" : "受け渡し前" }
  ];
}

function listingEvents(applications: Application[], handoffs: Handoff[], owner: boolean): PilotEvent[] {
  const events: PilotEvent[] = applications.map((application) => ({
    id: application.id,
    label: owner ? `${participantName(application.applicantId)}さんが応募しました` : "あなたが応募しました",
    date: application.createdAt
  }));
  for (const [index, handoff] of handoffs.entries()) {
    const name = owner ? `${participantName(handoff.receiverId)}さん` : "あなた";
    events.push({
      id: `${handoff.id}-selected`,
      label: index > 0 && owner ? `${name}が次の受取候補になりました` : `${name}が受取人に選ばれました`
    });
    if (handoff.status === "CANCELLED") {
      const expired = applications.some((item) => item.id === handoff.applicationId && item.status === "EXPIRED");
      events.push({
        id: `${handoff.id}-cancelled`,
        label: expired ? `${name}の承諾期限が過ぎました` : `${name}が辞退しました`
      });
    }
    if (handoff.status === "COMPLETED") {
      events.push({ id: `${handoff.id}-completed`, label: `${name}への受け渡しが完了しました` });
    }
  }
  return events;
}

export function buildPilotView(
  user: PilotUser | null,
  listing: Listing | null,
  matching: MatchingView | null,
  phase: PilotReadPhase = "ready"
) {
  const card = primaryCard(user, listing, matching, phase);
  const listingStatus = matching?.listingStatus ?? listing?.status ?? null;
  if (!user || !matching || !listing) return { card, listingStatus, progress: [], events: [] };

  const owner = matching.viewerRole === "giver" && user.id === listing.ownerId;
  const applications = owner ? matching.applications : matching.applications.filter((item) => item.applicantId === user.id);
  const handoffs = owner ? matching.handoffs : matching.handoffs.filter((item) => item.receiverId === user.id);
  return {
    card,
    listingStatus,
    progress: progressSteps(matching.listingStatus, applications, handoffs, owner),
    events: listingEvents(applications, handoffs, owner)
  };
}

const dayMs = 24 * 60 * 60 * 1000;

export function listingTemplate(openedAt: Date): ListingInput {
  const jstDate = (days: number, time: string) => {
    const date = new Date(openedAt.getTime() + 9 * 60 * 60 * 1000 + days * dayMs).toISOString().slice(0, 10);
    return `${date}T${time}:00+09:00`;
  };
  return {
    title: "二人掛けソファ、引き取ってください",
    description: demoSofaDescription,
    category: "furniture",
    condition: "used_visible_wear",
    pickupArea: "南キャンパス・学生寮A棟",
    pickupSlots: [
      { startAt: jstDate(1, "10:00"), endAt: jstDate(1, "12:00") },
      { startAt: jstDate(2, "14:00"), endAt: jstDate(2, "16:00") }
    ],
    pickupDeadline: jstDate(3, "18:00"),
    dimensionsCm: { width: 140, depth: 75, height: 72 },
    floor: 3,
    hasElevator: false,
    helpersRequired: 2
  };
}

export type SelectionAttempt = { key: string; input: SelectionInput };

export function selectionAttempt(
  selectedApplicationId: string,
  backupApplicationIds: string[],
  previous: SelectionAttempt | null,
  now: number,
  newKey: () => string
): SelectionAttempt {
  const old = previous?.input;
  if (old && old.selectedApplicationId === selectedApplicationId
    && old.backupApplicationIds.length === backupApplicationIds.length
    && old.backupApplicationIds.every((id, index) => id === backupApplicationIds[index])) {
    return previous;
  }
  return {
    key: newKey(),
    input: {
      selectedApplicationId,
      backupApplicationIds,
      confirmationExpiresAt: new Date(now + dayMs).toISOString()
    }
  };
}
