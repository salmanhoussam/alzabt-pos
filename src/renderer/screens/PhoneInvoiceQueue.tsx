/**
 * DEC-35z16 (owner, PILOT): supplier-invoice photos from the phone — the desktop half.
 *
 * `PhoneInvoiceSessionDialog`: the QR for an INVOICE_BATCH session and the live count of photos
 * received; when the phone presses «إنهاء» it says how many arrived and offers the review queue.
 * `PhoneInvoiceQueue`: every staged photo waiting for review. Each one opens the EXISTING Photo
 * Invoice flow on its own (read by OCR or typed beside the photo, Decision Buttons, explicit sale
 * price, «تأكيد الإضافة»). Nothing here writes a product or a ledger row.
 *
 * 🔴 NON-BLOCKING. Neither component opens by itself over another screen: the dialog belongs to the
 * Products screen that started the session, and the queue opens only from its own button there. A
 * cashier in the middle of a sale is never interrupted.
 *
 * 🔴 The product phone dialog in `ProductsScreen` is untouched; this is a separate component.
 */
import { useEffect, useRef, useState } from "react";
import type { PhoneInvoiceQueueItemDto, PhoneInvoiceRef, PhoneSessionDto } from "../../shared/ipcContract";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";

export function PhoneInvoiceSessionDialog(props: {
  readonly session: PhoneSessionDto;
  readonly onClose: () => void;
  readonly onReview: () => void;
}) {
  const { t } = useT();
  const [count, setCount] = useState(0);
  const [claimed, setClaimed] = useState(false);
  /** Latched like the product dialog: the end of a batch is reported by the poll exactly once. */
  const [ended, setEnded] = useState<null | { finished: boolean; count: number }>(null);
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, new Date(props.session.expiresAt).getTime() - Date.now()));
  const endedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || endedRef.current) return;
      setRemainingMs(Math.max(0, new Date(props.session.expiresAt).getTime() - Date.now()));
      try {
        const s = await call(pos().phoneSessionState());
        if (cancelled || endedRef.current) return;
        if (s.state === "batch_ready" || (s.state === "closed" && s.action === "INVOICE_BATCH")) {
          endedRef.current = true;
          setEnded({ finished: s.state === "batch_ready", count: s.invoiceCount ?? 0 });
          return;
        }
        if (s.state === "closed") {
          endedRef.current = true;
          setEnded({ finished: false, count });
          return;
        }
        setClaimed(s.claimed);
        setCount(s.invoiceCount ?? 0);
      } catch {
        // A missed poll is not a failed session; the next tick tries again.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.session.expiresAt]);

  const cancel = async () => {
    try {
      await call(pos().cancelPhoneSession());
    } catch {
      // Closing the dialog matters more than reporting a session that was already gone.
    }
    props.onClose();
  };

  const mins = String(Math.floor(remainingMs / 60000));
  const secs = String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, "0");
  const n = (s: string, v: number) => s.replace("{n}", String(v));

  return (
    <div className="overlay">
      <div className="card dialog phone-dialog" data-testid="phone-invoice-dialog">
        <h2 data-testid="phone-invoice-dialog-title">{ended?.finished ? t("phoneInv.readyTitle") : t("phoneInv.title")}</h2>
        <p>TEST ONLY: synthetic runner loopback; a physical phone cannot connect.</p>
        {ended ? (
          <>
            <p className={ended.finished ? "ok" : ended.count > 0 ? "" : "error"} data-testid="phone-invoice-ended">
              {ended.finished
                ? n(t("phoneInv.ready"), ended.count)
                : ended.count > 0
                  ? n(t("phoneInv.closedKept"), ended.count)
                  : t("phone.expired")}
            </p>
            <div className="actions phone-actions">
              {ended.count > 0 && (
                <button className="btn primary" onClick={props.onReview} data-testid="phone-invoice-review-now">
                  {t("phoneInv.reviewNow")}
                </button>
              )}
              <button className="btn" onClick={props.onClose} data-testid="phone-invoice-dialog-close">
                {t("phone.close")}
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              className="phone-qr"
              data-testid="phone-qr"
              aria-label={t("phoneInv.title")}
              dangerouslySetInnerHTML={{ __html: props.session.qrSvg }}
            />
            <p className="muted small">{t("phoneInv.explain")}</p>
            <p className="small">
              {t("phone.address")}: <bdi dir="ltr" data-testid="phone-address">{`${props.session.host}:${props.session.port}`}</bdi>
            </p>
            <p className="small" data-testid="phone-countdown">
              {t("phone.expiresIn").replace("{mins}", mins).replace("{secs}", secs)}
            </p>
            <p data-testid="phone-invoice-count">
              <b>{n(t("phoneInv.count"), count)}</b>
            </p>
            <p className="muted small" data-testid="phone-progress">
              {claimed ? t("phone.claimed") : t("phone.waiting")}
            </p>
            <p className="muted small" data-testid="phone-invoice-pilot-note">
              {t("phoneInv.pilotNote")}
            </p>
            <p className="muted small">{t("phone.firewall")}</p>
            <div className="actions phone-actions">
              <button className="btn" onClick={() => void cancel()} data-testid="phone-invoice-dialog-cancel">
                {t("phone.cancel")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function PhoneInvoiceQueue(props: {
  readonly onClose: () => void;
  readonly onReview: (ref: PhoneInvoiceRef) => void;
  readonly onChanged: () => void;
}) {
  const { t, lang } = useT();
  const [items, setItems] = useState<readonly PhoneInvoiceQueueItemDto[] | null>(null);
  const [error, setError] = useState("");
  /** The one row whose «حذف» is waiting for an in-app confirmation (never window.confirm — see InvoiceSheet). */
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = async () => {
    try {
      setItems(await call(pos().listPhoneInvoices()));
    } catch (e) {
      setError(errorText(e));
      setItems([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const discard = async (ref: PhoneInvoiceRef) => {
    setConfirming(null);
    try {
      await call(pos().releasePhoneInvoice({ ...ref, why: "discarded" }));
    } catch (e) {
      setError(errorText(e));
    }
    await load();
    props.onChanged();
  };

  const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const when = (iso: string) => new Date(iso).toLocaleString(lang === "ar" ? "ar-LB" : "en-GB", { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="card dialog phone-invoice-queue" data-testid="phone-invoice-queue">
        <h2>{t("phoneInv.queueTitle")}</h2>
        {error && <p className="error">{error}</p>}
        {items === null ? (
          <p className="muted">{t("common.loading")}</p>
        ) : items.length === 0 ? (
          <p className="muted" data-testid="phone-invoice-queue-empty">
            {t("phoneInv.queueEmpty")}
          </p>
        ) : (
          <ul className="piq-list">
            {items.map((it, i) => (
              <li key={it.id} className="piq-item" data-testid="phone-invoice-queue-item" data-invoice={it.id}>
                {it.thumbnail ? <img className="piq-thumb" src={it.thumbnail} alt="" /> : <span className="piq-thumb" />}
                <span className="piq-text">
                  <b>{`${i + 1}.`}</b> <bdi dir="ltr">{when(it.receivedAt)}</bdi> · <bdi dir="ltr">{size(it.bytes)}</bdi>
                  {it.batchStatus === "incomplete" && <span className="piq-flag"> · {t("phoneInv.incomplete")}</span>}
                  {it.stale && <span className="piq-flag"> · {t("phoneInv.stale")}</span>}
                </span>
                <button className="btn primary small" onClick={() => props.onReview({ batchId: it.batchId, id: it.id })} data-testid="phone-invoice-queue-review">
                  {t("phoneInv.review")}
                </button>
                {confirming === it.id ? (
                  <span className="piq-confirm" data-testid="phone-invoice-queue-confirm">
                    <span className="small">{t("phoneInv.discardConfirm")}</span>{" "}
                    <button className="btn small danger" onClick={() => void discard({ batchId: it.batchId, id: it.id })} data-testid="phone-invoice-queue-discard-yes">
                      {t("phoneInv.discard")}
                    </button>{" "}
                    <button className="btn small" onClick={() => setConfirming(null)} data-testid="phone-invoice-queue-discard-no">
                      {t("phone.cancel")}
                    </button>
                  </span>
                ) : (
                  <button className="btn small" onClick={() => setConfirming(it.id)} data-testid="phone-invoice-queue-discard">
                    {t("phoneInv.discard")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button className="btn" onClick={props.onClose} data-testid="phone-invoice-queue-close">
            {t("phone.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
