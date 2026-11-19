"use client";

import { useRef, useState, useSyncExternalStore } from "react";

const shareText = "Relay — 卒業で手放す物を、同じキャンパスの次の人へ。";
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "";

export function shareLinks(url: string) {
  return {
    x: `https://x.com/intent/post?${new URLSearchParams({ text: shareText, url })}`,
    line: `https://social-plugins.line.me/lineit/share?${new URLSearchParams({ url })}`
  };
}

const subscribe = () => () => {};
const getServerUrl = () => siteUrl;
const getClientUrl = () => siteUrl || window.location.origin + "/";
const getServerShareSupport = () => false;
const getClientShareSupport = () => typeof navigator.share === "function";

export function ShareButtons() {
  const url = useSyncExternalStore(subscribe, getClientUrl, getServerUrl);
  const canShare = useSyncExternalStore(subscribe, getClientShareSupport, getServerShareSupport);
  const [feedback, setFeedback] = useState<"idle" | "copied" | "manual">("idle");
  const input = useRef<HTMLInputElement>(null);
  const links = shareLinks(url);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setFeedback("copied");
    } catch {
      if (input.current) {
        input.current.focus();
        input.current.select();
      }
      setFeedback("manual");
    }
  }

  async function share() {
    try {
      await navigator.share({ text: shareText, url });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setFeedback("manual");
    }
  }

  return (
    <section className="pilot-share" aria-label="Relay をシェア">
      <div className="pilot-share-actions">
        {url && <>
          <a className="pilot-button pilot-secondary" href={links.x} target="_blank" rel="noopener noreferrer">Xでシェア</a>
          <a className="pilot-button pilot-secondary" href={links.line} target="_blank" rel="noopener noreferrer">LINEでシェア</a>
        </>}
        {canShare && <button className="pilot-button pilot-secondary" type="button" onClick={() => void share()}>端末の共有</button>}
        <button className="pilot-button pilot-secondary" type="button" disabled={!url} onClick={() => void copyLink()}>リンクをコピー</button>
      </div>
      <p className="pilot-feedback" aria-live="polite">
        {feedback === "copied" ? "コピーしました" : feedback === "manual" ? "表示されたリンクを選んでコピーしてください。" : ""}
      </p>
      {feedback === "manual" && (
        <label className="pilot-field">共有リンク
          <input value={url} readOnly ref={(node) => {
            input.current = node;
            node?.focus();
            node?.select();
          }} onFocus={(event) => event.currentTarget.select()} />
        </label>
      )}
      <p className="pilot-share-note">Instagram などは、「リンクをコピー」か「端末の共有」から送ってください（Web から投稿画面を開く公式の仕組みがないため）。</p>
    </section>
  );
}
