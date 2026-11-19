import { expect, it } from "vitest";
import { formatPickupSlot, formatPilotDate } from "./pilot-copy";

it("受取時間を、日本時間の「11月20日(金) 10:00〜12:00」の形で表す", () => {
  expect(formatPickupSlot({ startAt: "2026-11-20T10:00:00+09:00", endAt: "2026-11-20T12:00:00+09:00" }))
    .toBe("11月20日(金) 10:00〜12:00");
  // UTC で渡されても、日本時間に直す
  expect(formatPickupSlot({ startAt: "2026-11-20T01:00:00Z", endAt: "2026-11-20T03:30:00Z" }))
    .toBe("11月20日(金) 10:00〜12:30");
});

it("日をまたぐ受取時間は、終わりにも日付を付ける", () => {
  expect(formatPickupSlot({ startAt: "2026-11-20T22:00:00+09:00", endAt: "2026-11-21T01:00:00+09:00" }))
    .toBe("11月20日(金) 22:00〜11月21日(土) 01:00");
});

it("日時は、日本時間の「11月19日(木) 19:02」の形で表す", () => {
  expect(formatPilotDate("2026-11-19T10:02:00Z")).toBe("11月19日(木) 19:02");
});
