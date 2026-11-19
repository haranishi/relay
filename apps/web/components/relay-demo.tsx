"use client";

import { useMemo, useState } from "react";
import { demoSofaDescription } from "../lib/pilot-copy";
import { ShareButtons } from "./share-buttons";
import { SofaVisual } from "./sofa-visual";

type DemoStep = 0 | 1 | 2 | 3 | 4 | 5;

const scene = [
  { actor: "受取希望者 A", action: "このソファに応募する", hint: "まず1人目の在学生が応募します" },
  { actor: "受取希望者 B", action: "予備候補として応募する", hint: "別の在学生も応募します" },
  { actor: "出品者", action: "Aを第一候補、Bを予備に選ぶ", hint: "応募者から受取候補を順位付きで選びます" },
  { actor: "受取希望者 A", action: "受け取りを辞退する", hint: "第一候補が予定変更で辞退します" },
  { actor: "受取希望者 B", action: "繰上げを承諾し、受渡し完了", hint: "予備候補へ自動でオファーされます" }
] as const;

const events = [
  { type: "ListingPublished.v1", service: "出品サービス", tone: "mint" },
  { type: "ApplicationSubmitted.v1", service: "マッチング", tone: "blue" },
  { type: "ApplicationSubmitted.v1", service: "マッチング", tone: "blue" },
  { type: "RecipientSelected.v1", service: "マッチング", tone: "amber" },
  { type: "HandoffCancelled.v1", service: "マッチング", tone: "rose" },
  { type: "RecipientReoffered.v1", service: "マッチング", tone: "violet" },
  { type: "HandoffCompleted.v1", service: "マッチング", tone: "mint" }
] as const;

export function RelayDemo() {
  const [step, setStep] = useState<DemoStep>(0);
  const visibleEvents = useMemo(() => events.slice(0, 1 + step + (step >= 4 ? 1 : 0)), [step]);
  const listingStatus = step === 5 ? "受渡し完了" : step >= 3 ? "受取者決定" : "募集中";
  const currentScene = scene.at(step);

  function advance() {
    setStep((current) => Math.min(5, current + 1) as DemoStep);
  }

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Relay ホーム">
          <span className="brand-mark" aria-hidden="true">R</span>
          <span>Relay</span>
        </a>
        <div className="header-actions">
          <a className="pilot-button pilot-secondary pilot-entry" href="/pilot">招待コードで試す</a>
          <span className="community-pill"><span className="live-dot" />Relay Demo Campus</span>
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <span className="eyebrow">CAMPUS CIRCULAR MARKET</span>
          <h1>まだ使えるを、<br /><em>次の人へ。</em></h1>
          <p>卒業で手放す家具を、必要としている在学生へ。<br />お金よりも「間に合う受け渡し」を中心にした<span className="pilot-nowrap">マッチング</span>です。</p>
          <a className="pilot-button pilot-entry" href="/pilot">招待コードで試す</a>
        </div>
        <div className="impact-card" aria-label="サービスの効果">
          <span>この受け渡しで</span>
          <strong>約 48 kg</strong>
          <small>の廃棄を回避できます</small>
          <div className="impact-bar"><span /></div>
        </div>
      </section>

      <div className="demo-notice">
        <span className="demo-icon">▶</span>
        <div><strong>インタラクティブ・デモ</strong><small>下のアクションを順に進めると、繰上げ<span className="pilot-nowrap">マッチング</span>まで体験できます。</small></div>
        <button type="button" onClick={() => setStep(0)}>最初から</button>
      </div>

      <section className="workspace" aria-label="Relayデモ">
        <article className="listing-panel">
          <SofaVisual />

          <div className="listing-body">
            <div className="listing-meta"><span className={`status status-${step === 5 ? "done" : step >= 3 ? "reserved" : "open"}`}>{listingStatus}</span><span>家具</span><span>使用感あり</span></div>
            <h2>二人掛けソファ、引き取ってください</h2>
            <p className="description">{demoSofaDescription}</p>
            <dl className="facts">
              <div><dt>受取場所</dt><dd>南キャンパス・学生寮A棟</dd></div>
              <div><dt>受取期限</dt><dd><strong className={step < 5 ? "pickup-deadline-active" : undefined}>3月24日 18:00まで</strong></dd></div>
              <div><dt>サイズ</dt><dd>幅140 × 奥行75 × 高さ72cm</dd></div>
              <div><dt>搬出条件</dt><dd>3階 / エレベーターなし / 2名推奨</dd></div>
            </dl>
            <div className="giver"><span className="person-icon">卒</span><div><small>出品者</small><strong>山口さん</strong><span>2026年3月卒業予定</span></div><span className="verified">✓ 在籍確認済み</span></div>
          </div>
        </article>

        <aside className="flow-panel">
          <div className="flow-heading"><div><span className="eyebrow">MATCHING FLOW</span><h2>受け渡しの進行</h2></div><span className="step-count">{step}<b>/ 5</b></span></div>

          {currentScene ? (
            <div className="action-card">
              <span className="actor-label">いま操作する人</span>
              <strong>{currentScene.actor}</strong>
              <p>{currentScene.hint}</p>
              <span className="demo-action-label">デモの操作</span>
              <button className="demo-action-button" type="button" onClick={advance}>{currentScene.action}<span aria-hidden="true">→</span></button>
            </div>
          ) : (
            <div className="complete-card" role="region" aria-labelledby="completion-title" tabIndex={-1}
              ref={(node) => node?.focus()}>
              <span aria-hidden="true">✓</span><strong id="completion-title">受け渡しが完了しました</strong><p>Bさんが新しい持ち主になりました。出品者と受取者の双方へ完了通知を送信します。</p></div>
          )}

          <ol className="progress-list">
            <ProgressItem state={step >= 1 ? "done" : "active"} number="1" title="Aさんが応募" detail="車で搬出可能・友人1名" />
            <ProgressItem state={step >= 2 ? "done" : step === 1 ? "active" : "idle"} number="2" title="Bさんが応募" detail="軽トラック・友人2名" />
            <ProgressItem state={step >= 4 ? "done" : step >= 2 ? "active" : "idle"} number="3" title="候補者を順位付け" detail={step >= 4 ? "Aさん辞退 → Bさんへ繰上げ" : "第一候補 A / 予備 B"} warning={step === 4} />
            <ProgressItem state={step === 5 ? "done" : step === 4 ? "active" : "idle"} number="4" title="受け渡し完了" detail="双方の確認でクローズ" />
          </ol>

          <div className="event-stream">
            <div className="event-title"><strong>ドメインイベント</strong><span><i /> LIVE</span></div>
            <div className="events">
              {visibleEvents.map((event, index) => (
                <div className="event-row" key={`${event.type}-${index}`}><i className={`event-${event.tone}`} /><div><strong>{event.type}</strong><small>{event.service}</small></div><time>{String(index + 1).padStart(2, "0")}</time></div>
              ))}
            </div>
          </div>
        </aside>
      </section>

      <section className="architecture">
        <div><span className="eyebrow">BEHIND THE SCENES</span><h2>画面の裏では、サービスが疎結合に連携</h2><p>障害が起きてもQueueがイベントを保持し、各サービスが自分のペースで処理します。</p></div>
        <div className="service-map" aria-label="システム構成">
          <Service name="API Gateway" tech="Workers" />
          <span>→</span><Service name="出品" tech="Turso" />
          <span>→</span><Service name="Event Router" tech="Queues" highlight />
          <span>→</span><Service name="一覧・通知" tech="Turso" />
        </div>
      </section>
      <div className="pilot-home-share"><ShareButtons /></div>
      <footer><span>Relay / Systems Design 2026</span><span>Campus first. Community next.</span></footer>
    </main>
  );
}

function ProgressItem({ state, number, title, detail, warning = false }: { state: "done" | "active" | "idle"; number: string; title: string; detail: string; warning?: boolean }) {
  return <li className={`progress-${state}`}><span className="progress-mark">{state === "done" ? "✓" : number}</span><div><strong>{title}</strong><small className={warning ? "warning" : ""}>{warning ? "↗ " : ""}{detail}</small></div></li>;
}

function Service({ name, tech, highlight = false }: { name: string; tech: string; highlight?: boolean }) {
  return <div className={`service ${highlight ? "service-highlight" : ""}`}><strong>{name}</strong><small>{tech}</small></div>;
}
