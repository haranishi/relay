import type { Metadata } from "next";
import "./globals.css";

const title = "Relay — まだ使えるを、次の人へ。";
const description = "卒業生と在学生をつなぐ、キャンパス内の受け渡しマッチングサービス";
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

// 公開 URL が分かるときだけ、og:url・canonical・og:image を出す。
// 無いまま画像を出すと、Next.js が `http://localhost:3000/og.png` のような誤った住所を作ってしまう。
export const metadata: Metadata = {
  title,
  description,
  ...(siteUrl ? { metadataBase: new URL(siteUrl), alternates: { canonical: "/" } } : {}),
  openGraph: {
    title,
    description,
    type: "website",
    locale: "ja_JP",
    siteName: "Relay",
    ...(siteUrl ? { url: "/", images: [{ url: "/og.png", width: 1200, height: 630, alt: "Relay" }] } : {})
  },
  twitter: { card: siteUrl ? "summary_large_image" : "summary" }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
