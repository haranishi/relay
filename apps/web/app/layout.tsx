import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Relay — まだ使えるを、次の人へ。",
  description: "卒業生と在学生をつなぐ、キャンパス内の受け渡しマッチングサービス"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
