/**
 * TILL-PRINT — the till receipt READ FROM THE LEDGER by sale id (getSaleReceipt), with Print / PDF. Used right
 * after a sale (completion) and from History (reprint), so the screen, the PDF and the print are the SAME data.
 *
 * 🔴 F4: the customer and — for a sale paid from an advance — the ADV- and what stayed on account come from the
 *    ledger's facts of THAT sale. History used to render the bare sale and read «المبلغ المستحق = sale total».
 * 🔴 D-TP3: a reprint (`copy`) prints the SAME receipt number with a «نسخة / COPY» mark; nothing is recorded.
 * 🔴 D-TP1: «طباعة 80مم» uses the thermal layout, «طباعة A5» an ordinary page, «حفظ PDF» an A5 PDF offline. With no
 *    printer installed the screen says so and offers the PDF — it never waits on a dialog that cannot print.
 */
import { useEffect, useState } from "react";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";
import type { SaleReceiptDto } from "../../shared/ipcContract";
import { Receipt } from "./Receipt";
import type { NamedProduct } from "../receiptNames";
import { useDemoMode } from "../demoMode";

export function LedgerReceipt({
  saleId,
  copy,
  onNewSale,
  fit,
}: {
  saleId: string;
  copy: boolean;
  onNewSale?: () => void;
  /** J1-PHASE5 U-3: layout only, passed to Receipt (History reprint). */
  fit?: boolean;
}) {
  const { t } = useT();
  // O-5 (joint C2): the demo is preview-only — no PDF is saved there, so the button is not offered.
  const demo = useDemoMode();
  const [receipt, setReceipt] = useState<SaleReceiptDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * J1-RECEIPT-NAMES: the current catalogue's names, through the existing session read the till already
   * uses. DISPLAY ONLY. A failure leaves it null and the receipt shows the recorded names, as before.
   */
  const [productNames, setProductNames] = useState<ReadonlyMap<string, NamedProduct> | null>(null);
  useEffect(() => {
    let live = true;
    call(pos().getCatalog())
      .then((c) => {
        if (!live) return;
        const map = new Map<string, NamedProduct>();
        for (const p of c.products) {
          map.set(p.id, {
            name: p.name,
            ...(p.nameAr !== undefined ? { nameAr: p.nameAr } : {}),
            ...(p.nameEn !== undefined ? { nameEn: p.nameEn } : {}),
          });
        }
        setProductNames(map);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [saleId]);
  useEffect(() => {
    let live = true;
    setReceipt(null);
    setError(null);
    call(pos().getSaleReceipt({ saleId }))
      .then((r) => live && setReceipt(r))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [saleId]);

  if (error) {
    return (
      <p className="error" data-testid="receipt-load-error">
        {error}
      </p>
    );
  }
  if (!receipt) return <p className="center muted">{t("common.loading")}</p>;

  const run = async (fn: () => Promise<{ kind: "ok" | "warn"; text: string } | null>) => {
    setBusy(true);
    try {
      setNote(await fn());
    } catch (err) {
      setNote({ kind: "warn", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  const print = (layout: "thermal80" | "a5") =>
    run(async () => {
      const r = await call(pos().printSaleReceipt({ saleId, layout, copy }));
      if (r.status === "previewed") return { kind: "ok", text: t("print.previewOpened") };
      if (r.status === "printed") return { kind: "ok", text: t("adv.printed") };
      if (r.status === "no-printer") return { kind: "warn", text: t("print.noPrinter") };
      if (r.status === "unavailable") return { kind: "warn", text: t("print.unavailable") };
      return null;
    });
  const actions = (
    <div className="receipt-print" data-testid="receipt-print-bar" data-copy={copy ? "1" : "0"}>
      {copy && (
        <p className="muted small" data-testid="receipt-copy-note">
          {t("print.copyNote")}
        </p>
      )}
      <div className="panel-actions">
        <button className="btn" disabled={busy} onClick={() => void print("thermal80")} data-testid="receipt-print-80">
          {t("print.thermal80")}
        </button>
        <button className="btn" disabled={busy} onClick={() => void print("a5")} data-testid="receipt-print-a5">
          {t("print.a5")}
        </button>
        {!demo && (
        <button
          className="btn"
          disabled={busy}
          data-testid="receipt-pdf"
          onClick={() =>
            void run(async () => {
              const r = await call(pos().saveSaleReceiptPdf({ saleId, layout: "a5", copy }));
              return r.status === "saved" ? { kind: "ok", text: `${t("adv.saved")} ${r.fileName}` } : null;
            })
          }
        >
          {t("adv.pdf")}
        </button>
        )}
      </div>
      {note && (
        <p className={note.kind === "warn" ? "warn" : "muted"} data-testid="receipt-print-note" data-kind={note.kind}>
          {note.text}
        </p>
      )}
    </div>
  );
  return (
    <Receipt
      sale={receipt.sale}
      onAccountFor={receipt.customerName}
      advanceApplied={receipt.advanceApplied}
      onNewSale={onNewSale}
      actions={actions}
      {...(fit !== undefined ? { fit } : {})}
      {...(productNames !== null ? { productNames } : {})}
    />
  );
}
