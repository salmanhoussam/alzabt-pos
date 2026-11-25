/**
 * DEC-35z+ COL — the COL- receipt of a collection or of one shared transfer, as main read it from the
 * ledger. Shown right after the payment AND for every reprint from the statement.
 *
 * 🔴 A DOCUMENT OF A PAYMENT THAT ALREADY EXISTS. Print / PDF load the SAME COL- by number and record
 *    nothing: no payment, no second registration of the Whish reference. A print failure never undoes
 *    the payment (it committed before any window opened).
 * 🔴 NO FIGURE IS COMPUTED HERE.
 */
import { useEffect, useRef, useState } from "react";
import { call, errorText, fmt, pos } from "../api";
import { stamp } from "../format";
import { useT } from "../i18n";
import type { CollectionDocumentDto } from "../../shared/ipcContract";
import { statementDocumentText } from "../statementDocument";

export function CollectionReceipt({ doc, duplicate, onClose }: { doc: CollectionDocumentDto; duplicate: boolean; onClose: () => void }) {
  const { t } = useT();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLElement>(null);
  // Brought into view when it appears (after a payment, or a reprint picked lower in the statement).
  // A block body on purpose: this Chromium's scrollIntoView RETURNS a Promise, and an effect that returns a
  // non-function makes React call it as a cleanup on unmount (TypeError — the whole statement blanked).
  useEffect(() => {
    void box.current?.scrollIntoView?.({ block: "nearest" });
  }, [doc.docNo]);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await fn());
    } catch (err) {
      setNote(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    // INLINE, not a modal: the owner keeps working on the statement (a second payment, another debt).
    <section ref={box} className="col-receipt-inline" data-testid="col-receipt-panel">
      <div>
        <div className="card receipt adv-receipt" data-testid="col-receipt" data-col-number={doc.number}>
          <div className="receipt-ok">
            <span className="receipt-check" aria-hidden="true">✓</span>
            <h2>{t("col.title")}</h2>
          </div>
          {duplicate && (
            <p className="warn" data-testid="col-duplicate">
              {t("col.duplicate")}
            </p>
          )}
          <dl className="adv-receipt-fields">
            <dt>{t("adv.number")}</dt>
            <dd data-testid="col-number">
              <bdi dir="ltr">{doc.number}</bdi>
            </dd>
            <dt>{t("customers.name")}</dt>
            <dd data-testid="col-customer">
              <bdi>{doc.customerName}</bdi>
            </dd>
            <dt>{t("col.amount")}</dt>
            <dd data-testid="col-amount">
              <bdi dir="ltr">{fmt(doc.total)}</bdi>
            </dd>
            <dt>{t("col.method")}</dt>
            <dd data-testid="col-method" data-channel={doc.channel}>
              {t(`statement.channel.${doc.channel}`)}
              {doc.reference && (
                <>
                  {" · "}
                  <bdi dir="ltr" data-testid="col-reference">
                    {doc.reference}
                  </bdi>
                </>
              )}
            </dd>
            <dt>{t("col.appliedTo")}</dt>
            <dd>
              {doc.lines.map((l) => (
                <div key={l.obligationId} data-testid="col-line">
                  <bdi>{statementDocumentText(l.debtDocument, t)}</bdi> · <bdi dir="ltr">{fmt(l.amount)}</bdi>
                </div>
              ))}
            </dd>
            <dt>{t("col.by")}</dt>
            <dd data-testid="col-by">
              <bdi>{doc.receivedByName}</bdi>
            </dd>
            <dt>{t("col.at")}</dt>
            <dd>
              <bdi dir="ltr">{stamp(doc.receivedAt)}</bdi>
            </dd>
          </dl>
          <p className="muted small">{t("col.what")}</p>
          {note && (
            <p className="muted" data-testid="col-print-note">
              {note}
            </p>
          )}
          <div className="panel-actions">
            <button
              className="btn"
              disabled={busy}
              data-testid="col-print"
              onClick={() =>
                void run(async () => {
                  const r = await call(pos().printCollectionReceipt({ collectionNo: doc.docNo }));
                  return r.status === "previewed" ? t("print.previewOpened") : r.status === "printed" ? t("adv.printed") : "";
                })
              }
            >
              {t("adv.print")}
            </button>
            <button
              className="btn"
              disabled={busy}
              data-testid="col-pdf"
              onClick={() =>
                void run(async () => {
                  const r = await call(pos().saveCollectionReceiptPdf({ collectionNo: doc.docNo }));
                  return r.status === "saved" ? `${t("adv.saved")} ${r.fileName}` : "";
                })
              }
            >
              {t("adv.pdf")}
            </button>
            <button className="btn primary" disabled={busy} onClick={onClose} data-testid="col-receipt-close">
              {t("adv.close")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
