"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { pilotApi, PilotApiError, type Listing, type ListingStatus, type PilotUser } from "../lib/pilot-api";
import { formatPilotDate, listingStatusLabels, participantName, pilotErrorMessage, sessionExpiredMessage } from "../lib/pilot-copy";
import { PickupSlotText } from "./pickup-slot-text";
import { ApplyForm, CreateListingForm, SelectRecipientsForm, type RunPilotAction } from "./pilot-forms";
import { buildPilotView } from "./pilot-view";
import { ShareButtons } from "./share-buttons";
import { SofaVisual } from "./sofa-visual";
import { usePilotData } from "./use-pilot-data";

export function PilotApp() {
  const [user, setUser] = useState<PilotUser | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sessionRequest = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await pilotApi.session(controller.signal);
        if (!controller.signal.aborted) setUser(session.user);
      } catch (error) {
        if (controller.signal.aborted) return;
        setUser(null);
        if (!(error instanceof PilotApiError && error.status === 401)) setNotice(pilotErrorMessage(error));
      }
    })();
    return () => controller.abort();
  }, []);

  const expireSession = useCallback(() => {
    setUser(null);
    setNotice(sessionExpiredMessage);
  }, []);

  async function changeSession(action: () => Promise<PilotUser | null>, login = false) {
    if (sessionRequest.current) return;
    sessionRequest.current = true;
    setBusy(true);
    setNotice(null);
    try {
      setUser(await action());
    } catch (error) {
      setNotice(pilotErrorMessage(error, login));
    } finally {
      setBusy(false);
      sessionRequest.current = false;
    }
  }

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("code");
    if (typeof code === "string") void changeSession(async () => (await pilotApi.login(code.trim())).user, true);
  }

  function logout() {
    void changeSession(async () => {
      await pilotApi.logout();
      return null;
    });
  }

  const invite = buildPilotView(null, null, null).card;

  return (
    <main className="pilot-page">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Relay ホーム">
          <span className="brand-mark" aria-hidden="true">R</span><span>Relay</span>
        </a>
        {user && <div className="header-actions pilot-account-actions">
          <span className="community-pill pilot-account">{user.displayName}</span>
          <button className="pilot-button pilot-secondary" type="button" disabled={busy} onClick={logout}>ログアウト</button>
        </div>}
      </header>
      <h1 className="pilot-page-title">Relay 試験運用</h1>
      {user ? <PilotWorkspace key={user.id} user={user} sessionNotice={notice} onSessionExpired={expireSession} />
        : <div className="workspace pilot-workspace pilot-single">
          <div className="flow-panel pilot-primary">
            <PrimaryCard title={user === undefined ? "ログインを確認しています" : cardTitle(invite)} notice={notice}>
              {user === null && <form className="pilot-form" onSubmit={login}>
                <p>Relay の試験運用です。招待された方だけが入れます。招待コードは、案内してくれた人に聞いてください。</p>
                <label className="pilot-field">招待コード
                  <input name="code" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} required />
                </label>
                <button className="pilot-button pilot-main-action" type="submit" disabled={busy}>ログイン</button>
                <ol className="pilot-intro-steps">
                  <li>招待コードでログインします。</li>
                  <li>画面の一番上に、いまあなたがすることが1つだけ出ます。</li>
                  <li>出品から受け渡しの完了まで、実際のサービスと同じ仕組みで通します。</li>
                </ol>
              </form>}
            </PrimaryCard>
          </div>
        </div>}
    </main>
  );
}

type PilotView = ReturnType<typeof buildPilotView>;
type Card = PilotView["card"];

const titles: Record<Card["kind"], string> = {
  invite: "招待コードでログイン",
  loading: "出品を読み込んでいます",
  "load-error": "出品を読み込めませんでした",
  create: "ひな形で出品する",
  "no-listing": "出品を待っています",
  reflecting: "出品の反映を待っています…",
  "reflection-paused": "出品がまだ反映されていません",
  "wait-applications": "応募を待っています",
  select: "応募者から受取人を選ぶ",
  "wait-confirmation": "受け渡しの完了を待っています",
  apply: "この出品に応募する",
  "wait-selection": "応募しました。出品者の選定を待っています",
  receive: "あなたが受取人に選ばれました",
  declined: "辞退しました",
  completed: "受け渡しが完了しました",
  "other-recipient": "ほかの方に決まりました",
  closed: "この出品の募集は終了しました",
  "view-only": "出品の状況を確認できます"
};

function cardTitle(card: Card) {
  if (card.kind === "wait-confirmation" && card.handoff?.status === "PROPOSED") {
    return `${participantName(card.handoff.receiverId)}さんの承諾を待っています`;
  }
  if (card.kind === "wait-selection" && card.backup) return "予備候補に入っています";
  return titles[card.kind];
}

function PrimaryCard({ title, notice, children, focusKey = title, signedIn = false, complete = false }: {
  title: string;
  notice: string | null;
  children: ReactNode;
  focusKey?: string;
  signedIn?: boolean;
  complete?: boolean;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [focusKey]);

  return (
    <section className={`pilot-action-card ${complete ? "complete-card" : "action-card"}`} aria-labelledby={id}>
      {signedIn && <div className="actor-label">いま、あなたがすること</div>}
      <h2 id={id} ref={heading} tabIndex={-1} aria-live="polite">{title}</h2>
      <p className="pilot-feedback" aria-live="polite">{notice}</p>
      {children}
    </section>
  );
}

function PilotWorkspace({ user, sessionNotice, onSessionExpired }: {
  user: PilotUser;
  sessionNotice: string | null;
  onSessionExpired: () => void;
}) {
  const { data, refresh } = usePilotData(onSessionExpired);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState(false);
  const writing = useRef(false);
  const view = buildPilotView(user, data.listing, data.matching, data.phase);
  const { card } = view;
  const title = cardTitle(card);
  const cardKey = `${data.listingId ?? ""}:${card.kind}`;
  const listingOptions = data.listing && !data.listings.some(({ id }) => id === data.listing?.id)
    ? [data.listing, ...data.listings] : data.listings;

  const runAction: RunPilotAction = async (action) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setActionNotice(null);
    try {
      const response = action();
      void refresh.current?.({ includeListings: false });
      const publishedId = await response;
      // 保存直後の出品は、一覧への反映より先に出品IDで読める。
      await refresh.current?.(publishedId ? { listingId: publishedId } : { includeListings: false });
    } catch (error) {
      if (error instanceof PilotApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setActionNotice(pilotErrorMessage(error));
      await refresh.current?.({ includeListings: false });
    } finally {
      setBusy(false);
      writing.current = false;
    }
  };

  async function updateNow() {
    setActionNotice(null);
    setUpdating(true);
    try {
      await refresh.current?.();
    } finally {
      setUpdating(false);
    }
  }

  return (
    <section className={`workspace pilot-workspace${data.listing ? "" : " pilot-single"}`} aria-label="出品と受け渡し">
      <div className="flow-panel pilot-primary">
        <PrimaryCard title={title} notice={sessionNotice ?? actionNotice ?? data.error}
          focusKey={`${cardKey}:${title}`} signedIn complete={card.kind === "completed"}>
          <CardContents key={cardKey} card={card} listing={data.listing} busy={busy || updating}
            runAction={runAction} onNotice={setActionNotice} />
        </PrimaryCard>
        {data.matching?.listingStatus !== "COMPLETED" && <button className="pilot-button pilot-secondary pilot-main-action" type="button"
          disabled={busy || updating} onClick={() => void updateNow()}>
          {updating ? "更新中…" : "いま更新する"}
        </button>}
      </div>
      {data.listing && view.listingStatus && (
        <article className="listing-panel pilot-listing">
          {listingOptions.length > 1 && <label className="pilot-field pilot-listing-picker">表示する出品
            <select value={data.listing.id} disabled={busy || updating} onChange={(event) => {
              setActionNotice(null);
              void refresh.current?.({ includeListings: false, listingId: event.currentTarget.value });
            }}>
              {listingOptions.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
            </select>
          </label>}
          <ListingDetails listing={data.listing} status={view.listingStatus} />
        </article>
      )}
      {view.progress.length > 0 && <PilotProgress progress={view.progress} events={view.events} />}
    </section>
  );
}

function CardContents({ card, listing, busy, runAction, onNotice }: {
  card: Card;
  listing: Listing | null;
  busy: boolean;
  runAction: RunPilotAction;
  onNotice: (message: string) => void;
}) {
  switch (card.kind) {
    case "create":
      return <CreateListingForm busy={busy} runAction={runAction} />;
    case "apply":
      return listing && <>
        <p className="pilot-application-target">対象：{listing.title}（{listing.pickupArea}）</p>
        <ApplyForm listing={listing} busy={busy} runAction={runAction} onNotice={onNotice} />
      </>;
    case "select":
      return listing && <SelectRecipientsForm listingId={listing.id} applications={card.applications} busy={busy} runAction={runAction} />;
    case "receive": {
      const { id, confirmationExpiresAt } = card.handoff;
      return <div className="pilot-form">
        <ConfirmationDeadline expiresAt={confirmationExpiresAt} />
        <button className="pilot-button pilot-main-action" type="button" disabled={busy}
          onClick={() => void runAction(() => pilotApi.complete(id))}>受け取りを確定する</button>
        <button className="pilot-button pilot-secondary pilot-main-action" type="button" disabled={busy} onClick={() => {
          if (window.confirm("この受け取りを辞退しますか？")) void runAction(() => pilotApi.decline(id));
        }}>辞退する</button>
      </div>;
    }
    case "wait-confirmation":
      return card.handoff && <ConfirmationDeadline expiresAt={card.handoff.confirmationExpiresAt} />;
    case "wait-selection":
    case "wait-applications":
    case "no-listing":
    case "reflecting":
      return <p>画面は自動で更新されます。</p>;
    case "reflection-paused":
      return <p>30秒たっても反映されませんでした。「いま更新する」を押してください。</p>;
    case "completed":
      return <ShareButtons />;
    default:
      return null;
  }
}

function ConfirmationDeadline({ expiresAt }: { expiresAt: string }) {
  return <p>承諾期限は <time dateTime={expiresAt}>{formatPilotDate(expiresAt)}</time><span className="pilot-nowrap">（日本時間）</span>です。</p>;
}

function ListingDetails({ listing, status }: { listing: Listing; status: ListingStatus }) {
  const { dimensionsCm, floor, hasElevator, helpersRequired } = listing.logistics;
  const logistics = [
    floor === undefined ? null : `${floor}階`,
    hasElevator === undefined ? null : hasElevator ? "エレベーターあり" : "エレベーターなし",
    helpersRequired === undefined ? null : helpersRequired === 0 ? "手伝い不要" : `手伝い ${helpersRequired}人`
  ].filter((item): item is string => item !== null);
  const category = new Map([["furniture", "家具"], ["daily_goods", "日用品"], ["books", "本"], ["other", "その他"]]).get(listing.category);
  const condition = new Map([["like_new", "新品に近い"], ["used_good", "状態良好"], ["used_visible_wear", "使用感あり"]]).get(listing.condition);
  // 承諾待ちのあいだは、承諾期限だけを強調する（受取期限を赤くすると、期限が2つ強調されて見える）。
  const deadlineClass = status === "OPEN" ? "pickup-deadline-active" : undefined;

  return (
    <>
      <SofaVisual />
      <div className="listing-body pilot-listing-body">
        <div className="listing-meta">
          <span className={`status status-${status === "COMPLETED" ? "done" : status === "RESERVED" ? "reserved" : "open"}`}>{listingStatusLabels[status]}</span>
          {category && <span>{category}</span>}{condition && <span>{condition}</span>}
        </div>
        <h2>{listing.title}</h2>
        <p className="description">{listing.description}</p>
        <dl className="facts">
          <div><dt>受取場所</dt><dd>{listing.pickupArea}</dd></div>
          <div><dt>受取時間</dt><dd><ul>{listing.pickupSlots.map((slot) =>
            <li key={slot.startAt + slot.endAt}><PickupSlotText slot={slot} /></li>
          )}</ul></dd></div>
          <div><dt>受取期限</dt><dd><strong className={deadlineClass}><time dateTime={listing.pickupDeadline}>{formatPilotDate(listing.pickupDeadline)}</time>まで</strong></dd></div>
          {dimensionsCm && <div><dt>サイズ</dt><dd>幅{dimensionsCm.width} × 奥行{dimensionsCm.depth} × 高さ{dimensionsCm.height}cm</dd></div>}
          {logistics.length > 0 && <div><dt>搬出条件</dt><dd>{logistics.map((item, index) =>
            <span key={item}>{index > 0 && " / "}<span className="pilot-nowrap">{item}</span></span>
          )}</dd></div>}
        </dl>
      </div>
    </>
  );
}

function PilotProgress({ progress, events }: Pick<PilotView, "progress" | "events">) {
  const marks = { done: "✓", active: "→", idle: "○", skipped: "—" };
  return (
    <div className="flow-panel pilot-tracking">
      <h2>受け渡しの進み具合</h2>
      <ol className="progress-list">
        {progress.map(({ label, state, detail }) => <li key={label} className={`progress-${state}`}
          aria-current={state === "active" ? "step" : undefined}>
          <span aria-hidden="true" className="progress-mark">{marks[state]}</span>
          <div><strong>{label}</strong><small>{detail}</small></div>
        </li>)}
      </ol>
      <section className="event-stream">
        <h2>出来事</h2>
        {events.length === 0 ? <p>まだ記録はありません。</p> : <ol className="pilot-events">
          {events.map(({ id, label, date }) => <li key={id}>
            <span>{label}</span>
            {date && <time dateTime={date}>{formatPilotDate(date)}</time>}
          </li>)}
        </ol>}
      </section>
    </div>
  );
}
