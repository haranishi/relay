import { PilotApiError, type ListingStatus, type PickupSlot, type TransportMode } from "./pilot-api";

export const demoSofaDescription = "卒業に伴い手放します。4年間使いましたが、へたりは少なくまだ十分使えます。搬出を一緒に手伝ってくれる方を優先します。";

const names = new Map([
  ["giver", "出品者"],
  ["receiver-a", "受取人A"],
  ["receiver-b", "受取人B"]
]);

export function participantName(id: string) {
  return names.get(id) ?? "参加者";
}

export const listingStatusLabels: Record<ListingStatus, string> = {
  DRAFT: "公開前",
  OPEN: "募集中",
  RESERVED: "受取人の承諾待ち",
  COMPLETED: "受け渡し完了",
  EXPIRED: "募集終了",
  CANCELLED: "取り下げ"
};

export const transportLabels: Record<TransportMode, string> = {
  walk: "徒歩",
  bicycle: "自転車",
  car: "車",
  other: "その他"
};

const japanDateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "long", day: "numeric",
  weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

export function formatPickupSlot(slot: PickupSlot) {
  return japanDateTime.formatRange(new Date(slot.startAt), new Date(slot.endAt));
}

export function formatPilotDate(value: string) {
  return japanDateTime.format(new Date(value));
}

export const sessionExpiredMessage = "ログインの有効期限が切れました。もう一度、招待コードを入れてください";
const connectionMessage = "つながりませんでした。電波のよいところで、もう一度お試しください";

export function pilotErrorMessage(error: unknown, login = false): string {
  if (!(error instanceof PilotApiError)) return connectionMessage;
  const { status, code, detail } = error;
  if (status === 401) {
    return login ? "招待コードを確認して、もう一度入力してください" : sessionExpiredMessage;
  }
  if (status === 403) return "このコミュニティの参加者ではありません";
  if (status === 429) return "試行が多すぎます。5分ほど待ってから、もう一度お試しください";
  if (status === 0 || status >= 500) return connectionMessage;
  if (status === 409 && code === "DUPLICATE_APPLICATION") return "すでに応募しています";
  if (status === 409 || status === 400) {
    return detail || "入力内容と出品の状況を確認して、もう一度お試しください";
  }
  if (status === 413) return "入力が長すぎます。短くして、もう一度お試しください";
  return "出品の情報を取得できませんでした。「いま更新する」を押してください";
}
