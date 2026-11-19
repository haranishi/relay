import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ShareButtons, shareLinks } from "./share-buttons";

it("X と LINE の共有先に、公開ページの URL と投稿文を渡す", () => {
  const root = "https://relay.example/?topic=campus&lang=ja";
  const links = shareLinks(root);
  const x = new URL(links.x);
  const line = new URL(links.line);
  expect(x.origin + x.pathname).toBe("https://x.com/intent/post");
  expect(x.searchParams.get("url")).toBe(root);
  expect(x.searchParams.get("text")).toBe("Relay — 卒業で手放す物を、同じキャンパスの次の人へ。");
  expect(line.origin + line.pathname).toBe("https://social-plugins.line.me/lineit/share");
  expect(line.searchParams.get("url")).toBe(root);
});

it("初期 HTML にはコピーと共有の案内があり、端末の共有ボタンは出さない", () => {
  const html = renderToStaticMarkup(<ShareButtons />);
  expect(html).toContain(">リンクをコピー</button>");
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("Instagram");
  expect(html).not.toContain(">端末の共有</button>");
});
