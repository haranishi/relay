import { useRef, useState, type FormEvent } from "react";
import { pilotApi, PilotApiError, type Application, type Listing, type TransportMode } from "../lib/pilot-api";
import { formatPickupSlot, participantName, transportLabels } from "../lib/pilot-copy";
import { listingTemplate, selectionAttempt, type SelectionAttempt } from "./pilot-view";

export type RunPilotAction = (action: () => Promise<string | void>) => Promise<void>;

type FormProps = { busy: boolean; runAction: RunPilotAction };

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export function CreateListingForm({ busy, runAction }: FormProps) {
  const [template] = useState(() => listingTemplate(new Date()));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void runAction(async () => {
      const { id } = await pilotApi.createListing({
        ...template,
        title: formText(form, "title"),
        description: formText(form, "description"),
        pickupArea: formText(form, "pickupArea")
      });
      return id;
    });
  }

  return (
    <form className="pilot-form" onSubmit={submit}>
      <p>ソファのひな形を用意しました。必要に応じて題名・説明・受取場所を直してください。</p>
      <label className="pilot-field">題名
        <input name="title" defaultValue={template.title} maxLength={60} required />
      </label>
      <label className="pilot-field">説明
        <textarea name="description" defaultValue={template.description} rows={4} maxLength={1000} required />
      </label>
      <label className="pilot-field">受取場所
        <input name="pickupArea" defaultValue={template.pickupArea} maxLength={100} required />
      </label>
      <button className="pilot-button pilot-main-action" type="submit" disabled={busy}>出品する</button>
    </form>
  );
}

export function ApplyForm({ listing, busy, runAction, onNotice }: FormProps & {
  listing: Listing;
  onNotice: (message: string) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selected = new Set(form.getAll("slot"));
    const availableSlots = listing.pickupSlots.filter((_, index) => selected.has(String(index)));
    if (!availableSlots.length) {
      onNotice("受け取れる時間を1つ以上選んでください");
      event.currentTarget.querySelector<HTMLInputElement>('input[name="slot"]')?.focus();
      return;
    }
    void runAction(() => pilotApi.apply(listing.id, {
      availableSlots,
      transportMode: form.get("transportMode") as TransportMode,
      helperCount: Number(form.get("helperCount")),
      message: formText(form, "message")
    }));
  }

  return (
    <form className="pilot-form" onSubmit={submit}>
      <fieldset className="pilot-slots">
        <legend>受け取れる時間（日本時間・1つ以上）</legend>
        {listing.pickupSlots.map((slot, index) => (
          <label className="pilot-check" key={slot.startAt + slot.endAt}>
            <input type="checkbox" name="slot" value={index} />
            {formatPickupSlot(slot)}
          </label>
        ))}
      </fieldset>
      <label className="pilot-field">搬出手段
        <select name="transportMode" defaultValue="" required>
          <option value="" disabled>選んでください</option>
          {Object.entries(transportLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="pilot-field">手伝いの人数
        <select name="helperCount" defaultValue="" required>
          <option value="" disabled>選んでください</option>
          {Array.from({ length: 11 }, (_, count) => <option key={count} value={count}>{count}人</option>)}
        </select>
      </label>
      <label className="pilot-field">メッセージ（任意）
        <textarea name="message" rows={3} maxLength={500} />
      </label>
      <button className="pilot-button pilot-main-action" type="submit" disabled={busy}>応募する</button>
    </form>
  );
}

export function SelectRecipientsForm({ applications, listingId, busy, runAction }: FormProps & {
  applications: Application[];
  listingId: string;
}) {
  const [primary, setPrimary] = useState("");
  const [firstBackup, setFirstBackup] = useState("");
  const [secondBackup, setSecondBackup] = useState("");
  const attempt = useRef<SelectionAttempt | null>(null);
  const options = applications.map((item) => ({ id: item.id, name: participantName(item.applicantId) }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validIds = new Set(options.map((option) => option.id));
    if (!validIds.has(primary)) return;
    const backups = [firstBackup, secondBackup].filter((id) => validIds.has(id));
    void runAction(async () => {
      const selection = selectionAttempt(primary, backups, attempt.current, Date.now(), () => crypto.randomUUID());
      attempt.current = selection;
      try {
        await pilotApi.select(listingId, selection.input, selection.key);
        attempt.current = null;
      } catch (error) {
        // 通信が切れたときは、確定済みの可能性があるので同じ内容とキーを使う。
        if (error instanceof PilotApiError && error.status > 0 && error.status < 500) attempt.current = null;
        throw error;
      }
    });
  }

  return (
    <>
      <ul className="pilot-applicants">
        {applications.map((item) => (
          <li key={item.id}>
            <h3>{participantName(item.applicantId)}</h3>
            <dl className="facts">
              <div><dt>搬出手段</dt><dd>{transportLabels[item.transportMode]}</dd></div>
              <div><dt>手伝いの人数</dt><dd>{item.helperCount}人</dd></div>
              <div><dt>メッセージ</dt><dd>{item.message || "なし"}</dd></div>
              <div><dt>希望時間</dt><dd><ul>{item.availableSlots.map((slot) =>
                <li key={slot.startAt + slot.endAt}>{formatPickupSlot(slot)}</li>
              )}</ul></dd></div>
            </dl>
          </li>
        ))}
      </ul>
      <form className="pilot-form" onSubmit={submit}>
        <p>第一候補を1人選んでください。予備候補は順に2人まで選べます。承諾の期限は確定から24時間後です。</p>
        <label className="pilot-field">第一候補
          <select value={primary} required onChange={(event) => {
            const id = event.currentTarget.value;
            setPrimary(id);
            if (firstBackup === id) setFirstBackup("");
            if (secondBackup === id) setSecondBackup("");
          }}>
            <option value="" disabled>選んでください</option>
            {options.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        {options.length > 1 && <label className="pilot-field">予備候補 1（任意）
          <select value={firstBackup} onChange={(event) => setFirstBackup(event.currentTarget.value)}>
            <option value="">選ばない</option>
            {options.filter(({ id }) => id !== primary && id !== secondBackup)
              .map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>}
        {options.length > 2 && <label className="pilot-field">予備候補 2（任意）
          <select value={secondBackup} onChange={(event) => setSecondBackup(event.currentTarget.value)}>
            <option value="">選ばない</option>
            {options.filter(({ id }) => id !== primary && id !== firstBackup)
              .map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>}
        <button className="pilot-button pilot-main-action" type="submit" disabled={busy}>候補を確定する</button>
      </form>
    </>
  );
}
