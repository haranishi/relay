import type { PickupSlot } from "../lib/pilot-api";
import { formatPickupSlot } from "../lib/pilot-copy";

export function PickupSlotText({ slot }: { slot: PickupSlot }) {
  // 日をまたぐときは、日付を挟んだ前後の時刻をそれぞれまとめる。
  const parts = formatPickupSlot(slot).split(/(\d{2}:\d{2}(?:〜\d{2}:\d{2})?)/);
  return <span>{parts.map((part, index) => index % 2 === 0 ? part : (
    <span className="pilot-nowrap" key={index}>{part}</span>
  ))}</span>;
}
