/**
 * The invoice sheet — filling in an invoice, not a generic admin form.
 *
 * 🔴 THE RENDERER'S MATH IS A PREVIEW AND NOTHING ELSE. Every line total shown here comes from the
 * SERVICE: a row is sent, the service parses the typed quantity and price, computes the total with
 * the same exact-integer half-up rule the sales ledger uses, stores it, and sends the whole invoice
 * back. The sheet renders what came back. It never computes a total it then asks anyone to trust,
 * and FINALIZE sends an invoice id and nothing else.
 *
 * 🔴 PICKING A CATALOG PRODUCT PREFILLS; IT DOES NOT BIND. The description, unit and price stay
 * editable afterwards, and editing them here changes the invoice only — never the catalog. What the
 * catalog should become is decided later, deliberately, in the review queue.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { matchesSearch } from "../../../domain/arabic";
import type {
  AdminProductDto,
  InvoiceHeaderPatch,
  InvoiceHeaderPatchKey,
  InvoiceLineRequest,
  InvoiceViewDto,
  ReconciliationDto,
} from "../../../shared/ipcContract";
import { INVOICE_HEADER_PATCH_KEYS } from "../../../shared/ipcContract";
import { ApiError, call, errorText, fmt, newIdempotencyKey, pos } from "../../api";
import { CustomerFinder } from "../CustomerFinder";
import { useT } from "../../i18n";
import { DEFAULT_UNIT, UnitCell } from "../../components/UnitCell";
import { DraftRowStore } from "./draftRowStore";
import { isTypedTaxRateUnsaved } from "./taxRateDirty";
import { classifyFlushFailure } from "./flushOutcome";

const EMPTY_LINE: InvoiceLineRequest = {
  description: null,
  unitLabel: null,
  canonicalUnit: null,
  productId: null,
  quantity: "1",
  unitPrice: "",
};

/** One unsaved row: a stable identity plus what has been typed into it so far. */
type DraftRow = {
  readonly key: string;
  readonly line: InvoiceLineRequest;
  /**
   * «Other» is selected and no unit has been typed. Held separately because the line itself cannot
   * express it — an un-typed Other and a row with no unit at all are both `unitLabel: null`, and
   * only one of them is an error.
   */
  readonly unitIncomplete: boolean;
};

/**
 * A row nobody typed into. Trailing blanks are IGNORED everywhere — never saved, never validated,
 * never counted. Quantity is deliberately not consulted: it is prefilled with "1", so a row holding
 * only that default is still blank.
 */
function rowBlank(l: InvoiceLineRequest): boolean {
  // 🔴 THE UNIT IS NOT CONSULTED, and it used to be. A new row now opens with a unit already
  // selected from the dropdown, so a unit can no longer tell a blank row from a filled one — a
  // trailing row the operator never touched would otherwise look populated and demand validation.
  // A row is blank when nothing IDENTIFYING was entered.
  return (l.description ?? "").trim() === "" && l.productId === null && l.unitPrice.trim() === "";
}

/**
 * What is missing from a row somebody HAS typed into, or null when it is ready to save.
 *
 * Only PRESENCE is checked here. Whether "12.5.3" is a number, and whether a quantity is positive,
 * is the domain's judgement — parsed by `parseLine` in one place, its refusal surfacing as the
 * sheet's error. The renderer does not own a second, divergent idea of what a price is.
 */
function rowMissing(l: InvoiceLineRequest): "description" | "quantity" | "unitPrice" | null {
  if ((l.description ?? "").trim() === "") return "description";
  if (l.quantity.trim() === "") return "quantity";
  if (l.unitPrice.trim() === "") return "unitPrice";
  return null;
}

/** A populated row with nothing missing — the only kind that is ever written. */
function rowReady(r: DraftRow): boolean {
  return !rowBlank(r.line) && rowMissing(r.line) === null && !r.unitIncomplete;
}

/** A row the operator started and has not finished. Blocks saving ITSELF, never another row. */
function rowUnfinished(r: DraftRow): boolean {
  return !rowBlank(r.line) && !rowReady(r);
}

type FinalizedNotice = {
  /** The customer whose account the whole total was put on, when it was issued on account. */
  readonly onAccountOf?: string;
  readonly number: number;
  readonly items: ReadonlyArray<ReconciliationDto>;
};

/** Groups the review queue the way the operator is told about it after finalizing. */
function summarize(items: ReadonlyArray<ReconciliationDto>, t: (k: string) => string): string[] {
  const unresolved = items.filter((i) => i.status === "PENDING" || i.status === "FAILED");
  const counts = new Map<string, number>();
  for (const item of unresolved) counts.set(item.classification, (counts.get(item.classification) ?? 0) + 1);
  const label: Record<string, string> = {
    PRODUCT_NOT_FOUND: t("inv.review.addToCatalog"),
    PRICE_DIFFERENCE: t("inv.review.invoiceValue") + " / " + t("inv.review.catalogValue"),
    UNIT_DIFFERENCE: t("inv.sheet.colUnit"),
    DESCRIPTION_DIFFERENCE: t("inv.sheet.colDescription"),
    MULTIPLE_DIFFERENCES: t("inv.review.selectFields"),
    AMBIGUOUS_MATCH: t("inv.review.candidates"),
  };
  return [...counts.entries()].map(([classification, n]) => `${n} × ${label[classification] ?? classification}`);
}

/**
 * Exact basis points as a percentage string: 1100 -> "11", 1150 -> "11.5".
 *
 * 🔴 INTEGER ARITHMETIC ONLY. Dividing by 100 in floating point would print 11.499999999999998 for
 * a rate the database holds exactly, on a commercial document.
 */
function percentText(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const frac = basisPoints % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export function InvoiceSheet({
  invoiceId,
  onReviewNow,
  onClosed,
}: {
  readonly invoiceId: string;
  readonly onReviewNow: () => void;
  readonly onClosed: () => void;
}) {
  const { t, unit } = useT();
  const [view, setViewState] = useState<InvoiceViewDto | null>(null);
  /** The newest view, readable from an async handler without trusting the render it began in. */
  const viewRef = useRef<InvoiceViewDto | null>(null);
  const setView = (next: InvoiceViewDto | null) => {
    viewRef.current = next;
    setViewState(next);
  };
  const [products, setProducts] = useState<AdminProductDto[]>([]);
  /**
   * The rows the operator is typing, NOT yet in the database.
   *
   * 🔴 FIELD DEFECT, 2026-10-10. This was `InvoiceLineRequest | null` — ONE row — and "+ Add Row"
   * was `disabled={draftLine !== null}`, with a message telling the operator to save the current
   * row first. Entering a five-item invoice therefore meant five save round-trips, and the sheet
   * could not simply be filled in. Nothing below the renderer required that: the row model is a
   * renderer concern, and the sheet is now flushed as a batch in ONE transaction.
   *
   * A key per row, because rows are added and removed and an array index is not an identity —
   * React would otherwise carry a typed value from a removed row into the row that replaced it.
   */
  const [draftRows, setDraftRows] = useState<ReadonlyArray<DraftRow>>([]);
  /** Rows belonging to a batch that is being saved: not editable, removable or re-pickable. */
  const [frozenRows, setFrozenRows] = useState<ReadonlySet<string>>(new Set());
  /**
   * 🔴 THE ROWS LIVE IN THIS STORE, NOT IN A RENDER'S CLOSURE. See draftRowStore.ts: an async handler
   * that reads `draftRows` reads the render it started in, which is exactly how an edit made while a
   * batch was in the air used to be lost or mistaken for what was saved. React state above is only a
   * mirror for drawing.
   */
  const storeRef = useRef<DraftRowStore<InvoiceLineRequest, InvoiceViewDto> | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new DraftRowStore<InvoiceLineRequest, InvoiceViewDto>({
      isReady: rowReady,
      newKey: newIdempotencyKey,
      classify: classifyFlushFailure,
      onChange: () => {
        setDraftRows(storeRef.current!.rows);
        setFrozenRows(storeRef.current!.frozenSnapshot());
      },
    });
  }
  const rowStore = storeRef.current;
  const nextRowKey = useRef(1);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** This document printed without its own archived logo. A warning, never an error — see below. */
  const [logoWarning, setLogoWarning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [finalized, setFinalized] = useState<FinalizedNotice | null>(null);
  /** Migration 16. The linked account's name for DISPLAY only — the link itself is the id on the invoice. */
  const [linkedName, setLinkedName] = useState<string | null>(null);
  const [findingCustomer, setFindingCustomer] = useState(false);
  /** Convenience only: the owner-only option is drawn for owners; the service re-reads the live role. */
  const [isOwner, setIsOwner] = useState(false);
  /** Explicit, per attempt, never remembered: issuing on account is a deliberate act every time. */
  const [issueOnAccount, setIssueOnAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The tax-rate input, so Finalize can read what is typed instead of trusting that a blur happened. */
  const taxInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    call(pos().getInvoice({ invoiceId }))
      .then(setView)
      .catch((e) => setError(errorText(e)));
    call(pos().listProducts())
      .then(setProducts)
      .catch(() => setProducts([]));
  }, [invoiceId]);

  useEffect(() => {
    call(pos().currentCashier())
      .then((c) => setIsOwner(c?.role === "owner"))
      .catch(() => setIsOwner(false));
  }, []);

  const linkedId = view?.invoice.customerPartyId ?? null;
  useEffect(() => {
    if (!linkedId) {
      setLinkedName(null);
      setIssueOnAccount(false);
      return;
    }
    let live = true;
    call(pos().getCustomer({ customerId: linkedId }))
      .then((c) => live && setLinkedName(c.displayName))
      .catch(() => live && setLinkedName(null));
    return () => {
      live = false;
    };
  }, [linkedId]);

  const readOnly = view?.invoice.status === "final";

  /** One place where every service answer lands, so a refusal always reaches the operator. */
  const run = async (action: () => Promise<InvoiceViewDto>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await action());
    } catch (e) {
      // 🔴 The paid/total invariant refusal arrives here. It names both amounts and the way out,
      // and it is shown verbatim rather than replaced with a generic message.
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The live DOM value of every header input, so the CURRENT typed text can be read at any moment.
   *
   * 🔴 THE INPUTS STAY UNCONTROLLED ON PURPOSE. Controlling them would re-render on every service
   * response and move the caret while the operator is still typing. Refs give the same read access
   * without touching what they are doing.
   */
  const fieldRefs = useRef<Partial<Record<InvoiceHeaderPatchKey, HTMLInputElement | null>>>({});
  const bind = (key: InvoiceHeaderPatchKey) => (el: HTMLInputElement | null) => {
    fieldRefs.current[key] = el;
  };
  /** "" means "not given" for every header field — the service reads null as cleared. */
  const typed = (key: InvoiceHeaderPatchKey): string | null => {
    const raw = fieldRefs.current[key]?.value;
    if (raw === undefined) return null;
    return raw.trim() === "" ? null : raw;
  };

  /**
   * Sends ONLY the keys that changed.
   *
   * 🔴 THIS IS THE FIX FOR A REAL DEFECT, not a tidy-up. This helper used to fill every untouched
   * field from `view.invoice` and send a FULL overwrite. `view` is React state, so when two blurs
   * happened before the first response landed, the second request carried the FIRST field's stale
   * value and silently overwrote what had just been saved — a customer phone lost on a commercial
   * invoice, depending only on how fast the operator pressed Tab. Keys that are absent here are
   * absent all the way to the service, which then reads them from the current database row.
   */
  const header = (patch: InvoiceHeaderPatch) => run(() => call(pos().updateInvoiceHeader({ invoiceId, patch })));

  /**
   * Writes EVERY header field as the operator has it typed right now, in one request.
   *
   * The durable save path the product rule demands: commercial header data must never depend only
   * on blur timing. Save draft, leaving the screen and Finalize all go through this, so a value
   * that was typed but never blurred is still persisted.
   */
  const flushHeader = async (): Promise<InvoiceViewDto | null> => {
    const patch: Record<string, string | null> = {};
    for (const key of INVOICE_HEADER_PATCH_KEYS) {
      if (fieldRefs.current[key]) patch[key] = typed(key);
    }
    if (Object.keys(patch).length === 0) return viewRef.current;
    const next = await call(pos().updateInvoiceHeader({ invoiceId, patch: patch as InvoiceHeaderPatch }));
    setView(next);
    return next;
  };

  /**
   * What the stored row would put INTO each input.
   *
   * 🔴 NOT `invoice[key]` BLINDLY. `paid` is a MoneyDto — an object — while its input holds a
   * decimal string, so comparing the two directly made every draft look dirty and the exit dialog
   * appeared even on a draft saved a second earlier. Each entry mirrors that field's own
   * defaultValue, so "typed" and "stored" are the same kind of thing before they are compared.
   */
  const storedDisplay = (key: (typeof INVOICE_HEADER_PATCH_KEYS)[number]): string => {
    const inv = view?.invoice;
    if (!inv) return "";
    if (key === "paid") return inv.paid.minor === "0" ? "" : paidText(inv.paid.minor);
    return (inv as unknown as Record<string, string | null>)[key] ?? "";
  };

  /**
   * Compare exactly as the service parses percentages: a numerically equal but invalid value
   * (e.g. "11.000" or "11e0") must still count as unsaved, never permit a false Saved claim.
   */
  const taxDirty = (): boolean => {
    const el = taxInput.current;
    if (!el || !taxOn || !snapshot) return false;
    return isTypedTaxRateUnsaved(el.value, snapshot.rateBasisPoints);
  };

  /**
   * Is anything typed but not yet stored?
   *
   * 🔴 THE EXIT RULE NEEDS A REAL ANSWER, not an optimistic one. Comparing each bound input's
   * CURRENT value against the value on the stored row is the only way to know; a flag set by
   * onChange would miss a field restored to its original value and would nag for nothing.
   */
  const isDirty = (): boolean => {
    const inv = view?.invoice;
    if (!inv) return false;
    if (taxDirty()) return true;
    for (const key of INVOICE_HEADER_PATCH_KEYS) {
      if (!fieldRefs.current[key]) continue;
      if ((typed(key) ?? "") !== storedDisplay(key)) return true;
    }
    return false;
  };

  const snapshot = view?.invoice.taxSnapshot ?? null;
  const taxOn = snapshot?.enabled === true;
  /** The frozen rate as a percentage string, from exact basis points — never a float. */
  const taxRate = snapshot && snapshot.enabled ? percentText(snapshot.rateBasisPoints) : "";

  const applyTax = (enabled: boolean, ratePercent: string) =>
    run(() =>
      call(
        pos().setInvoiceTax({
          invoiceId,
          enabled,
          // An empty rate with tax switched on means "11" has not been typed yet; the service
          // refuses it and says so, rather than guessing a rate onto a commercial document.
          ratePercent: enabled ? (ratePercent.trim() === "" ? "0" : ratePercent) : null,
          label: snapshot?.label ?? null,
        }),
      ),
    );

  const saveDraft = () => {
    setSaved(false);
    return run(async () => {
      // Rows first, then the header: the operator pressed one button and means "save what I see".
      await flushRows();
      const next = await afterRowsSaved(async () => {
        await flushTax();
        return flushHeader();
      });
      if (!next) throw new Error("the draft could not be read back");
      if (rowStore.rows.some(rowUnfinished)) {
        setError(t("inv.sheet.rowsIncomplete"));
        return next;
      }
      setSaved(true);
      return next;
    });
  };

  /**
   * Writes a row's line, PRESERVING whatever the unit cell is mid-deciding.
   *
   * Typing a description cannot change whether the unit is finished, and recomputing the flag here
   * from the line alone would clear it — an un-typed «Other» and a row with no unit are the same
   * `unitLabel: null`, so the line cannot answer the question. Only the unit cell sets this flag,
   * and only the catalog picker (which always supplies a real base unit) clears it.
   */
  const setRow = (key: string, line: InvoiceLineRequest, unitResolved = false) =>
    rowStore.edit(key, (r) => ({ key, line, unitIncomplete: unitResolved ? false : r.unitIncomplete }));

  const dropRow = (key: string) => rowStore.remove(key);

  /**
   * Persists every row that is ready, in ONE transaction, and leaves the rest alone.
   *
   * Blank rows are ignored. A row still missing a field STAYS in the sheet with its inline
   * validation rather than blocking the rows that are complete — an incomplete row must never be a
   * reason the operator cannot carry on.
   *
   * Returns the view the service computed, so totals come from the database's arithmetic and never
   * from this component's.
   */
  const flushRows = async (): Promise<InvoiceViewDto | null> => {
    const sent = await rowStore.flush(
      async (key, lines) => {
        const next = await call(pos().addInvoiceLines({ invoiceId, lines: [...lines], idempotencyKey: key }));
        setView(next);
        return next;
      },
      {
        unknown: () => new Error(t("inv.sheet.flushUnknown")),
        editedWhileSaving: () => new Error(t("inv.sheet.rowChangedAfterSave")),
      },
    );
    return sent ?? viewRef.current;
  };

  /**
   * Appends an editable row. ALWAYS available — this is the whole point of the fix.
   *
   * The row is appended FIRST and the flush happens after, so a service refusal on an earlier row
   * can never be the reason a new row could not be started. Flushing here is what keeps the totals
   * honest: a completed row becomes a real line, and the service recomputes subtotal, tax and total
   * from the rows it actually holds.
   */
  const addRow = async () => {
    const key = `r${nextRowKey.current++}`;
    // The dropdown's default is `piece`, exactly as the Add/Edit Product form defaults, so a known
    // unit is valid immediately and the operator has one less field to visit.
    const line: InvoiceLineRequest = { ...EMPTY_LINE, unitLabel: unit(DEFAULT_UNIT), canonicalUnit: DEFAULT_UNIT };
    rowStore.add({ key, line, unitIncomplete: false });
    try {
      await flushRows();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const editLine = (lineId: string, line: InvoiceLineRequest) =>
    run(() => call(pos().updateInvoiceLine({ invoiceId, lineId, line })));

  const removeLine = (lineId: string) => run(() => call(pos().removeInvoiceLine({ invoiceId, lineId })));

  /**
   * Deletes the draft — AFTER an explicit in-app confirmation.
   *
   * 🔴 NOT window.confirm, which the rest of this screen already avoids: the finalize confirmation
   * is an in-app overlay, a native dialog is not reachable by a data-testid, and in some embeddings
   * window.confirm returns false immediately — which would make a destructive action silently do
   * nothing. The overlay is both testable and consistent.
   */
  const discard = async () => {
    setDiscarding(false);
    try {
      await call(pos().discardInvoiceDraft({ invoiceId }));
      onClosed();
    } catch (e) {
      setError(errorText(e));
    }
  };

  /**
   * Leaves the draft WITHOUT destroying it — the safe exit this screen did not have.
   *
   * Leaving with a changed header or entered row requires an explicit save, discard, or cancel
   * choice. Saving writes all completed rows and the header before the sheet closes.
   */
  /**
   * Leaving the draft.
   *
   * 🔴 NEVER AN ALWAYS-SILENT SAVE. A clean draft exits immediately — no dialog, no pause, which
   * is the common case. A dirty one asks, because a silent save hides a decision the operator did
   * not make, and an unconditional prompt punishes leaving a screen that has not changed.
   */
  const leave = () => {
    if (isDirty() || rowStore.rows.some((row) => !rowBlank(row.line))) {
      setError(null);
      setExiting(true);
      return;
    }
    onClosed();
  };

  const saveAndLeave = async () => {
    setBusy(true);
    setError(null);
    try {
      await flushRows();
      await afterRowsSaved(async () => {
        await flushTax();
        await flushHeader();
      });
      if (rowStore.rows.some(rowUnfinished)) {
        setError(t("inv.sheet.rowsIncomplete"));
        return;
      }
      setExiting(false);
      onClosed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Runs a step that comes AFTER the rows were stored, and says so if it fails.
   *
   * 🔴 THE ROWS ARE ALREADY IN THE LEDGER by then. A bare refusal from the header or the tax would
   * read as though the whole save had failed, and the operator would retype rows that exist.
   */
  const afterRowsSaved = async <T,>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (e) {
      if (!rowStore.rowsWritten) throw e;
      throw new Error(`${t("inv.sheet.partialSaved")} ${errorText(e)}`);
    }
  };

  /** The operator's own language for the account refusals; every other error keeps its normal text. */
  const accountErrorText = (e: unknown): string => {
    if (e instanceof ApiError && e.code.startsWith("CREDIT_")) {
      const key = `inv.account.err.${e.code}`;
      const text = t(key);
      if (text !== key) return text;
    }
    return errorText(e);
  };

  /** Links (or unlinks) an exact account through the ordinary header write, then adopts the answer. */
  const chooseAccount = async (customerId: string | null, displayName: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const previousCustomerId = viewRef.current?.invoice.customerPartyId ?? null;
      const next = await call(pos().updateInvoiceHeader({ invoiceId, patch: { customerPartyId: customerId } }));
      setView(next);
      setLinkedName(displayName);
      // A checked credit instruction belongs to the PREVIOUS customer's identity. Changing the
      // account (including unlinking) must require an explicit fresh tick for the new customer.
      if (next.invoice.customerPartyId !== previousCustomerId) setIssueOnAccount(false);
      // Convenience: an EMPTY printed name is prefilled with the account's name. The printed name
      // stays its own field — it is a snapshot the operator may edit, and never drives the link.
      const nameInput = fieldRefs.current.customerName;
      if (displayName && nameInput && nameInput.value.trim() === "") nameInput.value = displayName;
    } catch (e) {
      setError(accountErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  /** Stores a tax rate that is typed but not yet blurred, so the total is the stored one. */
  const flushTax = async () => {
    const el = taxInput.current;
    if (!el || !taxOn) return;
    if (!taxDirty()) return;
    const typedRate = el.value.trim();
    const next = await call(
      pos().setInvoiceTax({
        invoiceId,
        enabled: true,
        ratePercent: typedRate === "" ? "0" : typedRate,
        label: snapshot?.label ?? null,
      }),
    );
    setView(next);
  };

  const prepareFinalize = async () => {
    setBusy(true);
    setError(null);
    try {
      // 🔴 EVERYTHING THE CONFIRMATION SHOWS MUST BE STORED BEFORE IT SHOWS IT. Rows first (they set
      // the subtotal), then the tax rate (applied only on blur, so a rate still being typed is not
      // yet on the document), then the header (customer, paid, balance). Any refusal stops here and
      // leaves the draft exactly as it was; the confirmation only ever reads what was read back.
      await flushRows();
      if (rowStore.rows.some(rowUnfinished)) {
        setError(t("inv.sheet.rowsIncomplete"));
        return;
      }
      await afterRowsSaved(async () => {
        await flushTax();
        await flushHeader();
      });
      // On account means the WHOLE total is owed: refuse here, on the stored values, rather than
      // after the operator has confirmed.
      if (issueOnAccount && viewRef.current && viewRef.current.invoice.paid.minor !== "0") {
        setError(t("inv.account.err.CREDIT_NEEDS_UNPAID"));
        return;
      }
      setConfirming(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const finalize = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      // 🔴 FLUSH FIRST, AND AWAIT IT. A field the operator typed but never blurred — the commonest
      // case being the last field they touched before reaching for Finalize — would otherwise be
      // absent from a document that is immutable the moment it commits. Finalizing is the one
      // irreversible act in this screen, so it reads the inputs rather than trusting that a blur
      // happened. If the flush is refused, finalization does not proceed.
      // Rows before the header, for the same reason the header is flushed at all: a row typed but
      // never saved would otherwise be absent from a document that is immutable once it commits.
      await flushRows();
      // 🔴 An INCOMPLETE row refuses finalization rather than being silently dropped. Issuing an
      // invoice is the one irreversible act here, and quietly discarding a half-typed item is how
      // an operator ends up printing a document that is missing a line they entered.
      if (rowStore.rows.some(rowUnfinished)) {
        setError(t("inv.sheet.rowsIncomplete"));
        return;
      }
      await flushHeader();
      // Never silently downgrade a checked on-account instruction to an ordinary unpaid invoice.
      // The service remains the authority and will refuse a missing/inactive account.
      const account = issueOnAccount;
      let next: InvoiceViewDto;
      try {
        next = await call(pos().finalizeInvoice({ invoiceId, issueOnAccount: account }));
      } catch (e) {
        // 🔴 ON ACCOUNT, an unclear outcome is resolved by ASKING the ledger, never by guessing: the
        // same request again verifies the invoice, its sale and its receivable and writes nothing
        // if they already exist (and refuses plainly if they do not).
        const unclear =
          !(e instanceof ApiError) || e.code === "INVOICE_FINALIZED" || e.code === "INVOICE_STATUS_UNKNOWN" || e.code === "INTERNAL";
        if (!account || !unclear) throw e;
        try {
          next = await call(pos().finalizeInvoice({ invoiceId, issueOnAccount: true }));
        } catch (again) {
          if (again instanceof ApiError && again.code.startsWith("CREDIT_")) throw again;
          throw new Error(t("inv.account.unknown"));
        }
      }
      setView(next);
      const items = await call(pos().listReconciliation({ invoiceId }));
      setFinalized({
        number: next.invoice.invoiceNumber!,
        items,
        onAccountOf: account ? (linkedName ?? undefined) : undefined,
      });
    } catch (e) {
      setError(accountErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const print = async () => {
    setLogoWarning(false);
    try {
      const result = await call(pos().printInvoice({ invoiceId }));
      if (result.status === "unavailable") setError(t("inv.sheet.print") + " — " + t("inv.review.none"));
      // Reported on a cancelled print too: the document was rendered before the dialog opened, so
      // the archived logo was already found to be missing and the operator should know either way.
      else if (result.logoMissing === true) setLogoWarning(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const savePdf = async () => {
    setLogoWarning(false);
    try {
      const result = await call(pos().saveInvoicePdf({ invoiceId }));
      if (result.status === "saved" && result.logoMissing === true) setLogoWarning(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const matches = useMemo(
    () => products.filter((p) => matchesSearch([p.nameAr, p.nameEn, p.sku], query)).slice(0, 20),
    [products, query],
  );

  if (!view) return <div className="center muted">{error ?? "…"}</div>;
  const inv = view.invoice;

  /** Prefills from a catalog product — and leaves every field editable. */
  const prefill = (p: AdminProductDto): InvoiceLineRequest => ({
    description: p.nameAr,
    unitLabel: p.baseUnit,
    canonicalUnit: p.baseUnit,
    productId: p.id,
    quantity: "1",
    unitPrice: p.priceDecimal,
  });

  const pick = (p: AdminProductDto) => {
    const line = prefill(p);
    const draft = pickerFor?.startsWith("draft:") ? pickerFor.slice("draft:".length) : null;
    if (draft) {
      if (!setRow(draft, line, true)) setError(t("inv.sheet.rowSaving"));
    }
    else if (pickerFor) {
      const existing = view.lines.find((l) => l.id === pickerFor);
      if (existing) void editLine(existing.id, { ...line, quantity: String(existing.quantityMilli / 1000) });
    }
    setPickerFor(null);
    setQuery("");
  };

  return (
    <div className="inv-sheet">
      <header className="inv-sheet-head">
        <div className="inv-issuer">
          <strong data-testid="sheet-issuer">{inv.issuer?.nameAr ?? t("inv.company.title")}</strong>
          {inv.issuer?.nameEn && <span dir="ltr" className="muted"> · {inv.issuer.nameEn}</span>}
        </div>
        <div className="inv-meta">
          <span>
            {t("inv.sheet.number")}:{" "}
            <strong dir="ltr" data-testid="sheet-number">
              {inv.invoiceNumber === null ? `— (${t("inv.sheet.numberAtFinalize")})` : `#${inv.invoiceNumber}`}
            </strong>
          </span>
          {/* 🔴 THE DOCUMENT SAYS WHAT IT IS, on screen as well as on paper. An outgoing sales
              invoice and an incoming intake document look alike; only a label distinguishes them. */}
          <span className="badge mode" data-testid="sheet-mode">
            {t("inv.mode.badge")}
          </span>
          <span className={readOnly ? "badge" : "badge draft"} data-testid="sheet-status">
            {readOnly ? t("inv.sheet.title") : t("inv.sheet.draft")}
          </span>
          <label className="field inline">
            <span>{t("inv.sheet.date")}</span>
            <input
              type="date"
              dir="ltr"
              value={inv.invoiceDate ?? ""}
              disabled={readOnly}
              ref={bind("invoiceDate")}
              onChange={(e) => void header({ invoiceDate: e.target.value === "" ? null : e.target.value })}
              data-testid="sheet-date"
            />
          </label>
        </div>
      </header>

      {readOnly && <p className="notice" data-testid="sheet-readonly">{t("inv.sheet.readOnly")}</p>}

      <section className="inv-customer">
        <label className="field">
          <span>{t("inv.sheet.customer")}</span>
          <input
            defaultValue={inv.customerName ?? ""}
            disabled={readOnly}
            ref={bind("customerName")}
            onBlur={(e) => void header({ customerName: e.target.value.trim() === "" ? null : e.target.value })}
            data-testid="sheet-customer"
          />
        </label>
        <label className="field">
          <span>{t("inv.sheet.address")}</span>
          <input
            defaultValue={inv.customerAddress ?? ""}
            disabled={readOnly}
            ref={bind("customerAddress")}
            onBlur={(e) => void header({ customerAddress: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t("inv.sheet.phone")}</span>
          <input
            dir="ltr"
            defaultValue={inv.customerPhone ?? ""}
            disabled={readOnly}
            ref={bind("customerPhone")}
            onBlur={(e) => void header({ customerPhone: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
        <label className="field wide">
          <span>{t("inv.sheet.notes")}</span>
          <input
            defaultValue={inv.notes ?? ""}
            disabled={readOnly}
            ref={bind("notes")}
            onBlur={(e) => void header({ notes: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
        {/* 🔴 MIGRATION 16 · THE CUSTOMER ACCOUNT. Chosen from the directory by identity, never typed
            and never matched by name — two customers called the same thing are two accounts.
            Choosing one only LINKS the invoice; it creates no debt. Issuing on account is a
            separate, explicit, owner-only act below. */}
        <div className="field wide inv-account" data-testid="sheet-account">
          <span>{t("inv.account.title")}</span>
          {linkedId ? (
            <div className="inv-account-row">
              <strong dir="auto" data-testid="sheet-account-name">{linkedName ?? "…"}</strong>
              {!readOnly && (
                <>
                  <button className="btn ghost small" disabled={busy} onClick={() => setFindingCustomer(true)} data-testid="account-change">
                    {t("inv.account.change")}
                  </button>
                  <button className="btn ghost small" disabled={busy} onClick={() => void chooseAccount(null, null)} data-testid="account-unlink">
                    {t("inv.account.unlink")}
                  </button>
                </>
              )}
            </div>
          ) : (
            !readOnly && (
              <button className="btn ghost small" disabled={busy} onClick={() => setFindingCustomer(true)} data-testid="account-choose">
                {t("inv.account.choose")}
              </button>
            )
          )}
          {!readOnly && <span className="muted small">{t("inv.account.hint")}</span>}
          {!readOnly && linkedId && isOwner && (
            <label className="field inline" data-testid="account-issue-row">
              <input
                type="checkbox"
                checked={issueOnAccount}
                disabled={busy}
                onChange={(e) => setIssueOnAccount(e.target.checked)}
                data-testid="account-issue"
              />
              <span>{t("inv.account.issue")}</span>
            </label>
          )}
          {!readOnly && linkedId && isOwner && issueOnAccount && (
            <span className="muted small" data-testid="account-issue-hint">{t("inv.account.issueHint")}</span>
          )}
        </div>
      </section>

      {/* 🔴 PER-INVOICE TAX, not a global switch. Issuing one taxed invoice used to mean toggling
          the shop setting on and off around it, and anything finalized in between inherited the
          wrong state. The rate is frozen onto THIS document at finalization. */}
      {!readOnly && (
        <section className="inv-tax" data-testid="sheet-tax-controls">
          <label className="field inline">
            <input
              type="checkbox"
              checked={taxOn}
              onChange={(e) => void applyTax(e.target.checked, taxRate)}
              data-testid="tax-enabled"
            />
            <span>{t("inv.tax.apply")}</span>
          </label>
          {taxOn && (
            <label className="field">
              <span>{t("inv.tax.rate")}</span>
              <input
                dir="ltr"
                inputMode="decimal"
                defaultValue={taxRate}
                ref={taxInput}
                onBlur={(e) => void applyTax(true, e.target.value)}
                data-testid="tax-rate"
              />
            </label>
          )}
          <span className="muted small">{t("inv.tax.hint")}</span>
        </section>
      )}

      <div className="inv-lines-scroll">
      <table className="inv-lines" data-testid="sheet-lines">
        <thead>
          <tr>
            <th>{t("inv.sheet.colNo")}</th>
            <th>{t("inv.sheet.colDescription")}</th>
            <th>{t("inv.sheet.colQty")}</th>
            <th>{t("inv.sheet.colUnit")}</th>
            <th>{t("inv.sheet.colUnitPrice")}</th>
            <th>{t("inv.sheet.colTotal")}</th>
            {/* FIELD FINDING 1: the actions column was headerless, so the buttons read as part of
                the money columns next to them. It is a named region now. */}
            <th className="row-actions-col">{t("inv.sheet.colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {view.lines.map((l) => (
            <tr key={l.id} data-testid="sheet-line">
              <td className="num" dir="ltr">{l.lineNo}</td>
              <td>
                <input
                  defaultValue={l.description ?? ""}
                  disabled={readOnly}
                  onBlur={(e) =>
                    editLine(l.id, {
                      description: e.target.value.trim() === "" ? null : e.target.value,
                      unitLabel: l.unitLabel,
                      canonicalUnit: l.canonicalUnit,
                      productId: l.productId,
                      quantity: String(l.quantityMilli / 1000),
                      unitPrice: priceText(l.unitPrice.minor),
                    })
                  }
                />
              </td>
              <td className="num">
                <input
                  dir="ltr"
                  inputMode="decimal"
                  defaultValue={l.quantityText}
                  disabled={readOnly}
                  onBlur={(e) =>
                    editLine(l.id, {
                      description: l.description,
                      unitLabel: l.unitLabel,
                      canonicalUnit: l.canonicalUnit,
                      productId: l.productId,
                      quantity: e.target.value,
                      unitPrice: priceText(l.unitPrice.minor),
                    })
                  }
                />
              </td>
              <td>
                {/* The SAME unit list the product form uses. A label this build cannot match —
                    "كيس (50PCS)" on a real invoice — renders as Other with the label prefilled and
                    is never rewritten, which is what makes an older draft reopen unharmed. */}
                <UnitCell
                  unitLabel={l.unitLabel}
                  canonicalUnit={l.canonicalUnit}
                  disabled={readOnly}
                  idSuffix={l.id}
                  onChange={(choice) => {
                    // 🔴 An empty «Other» writes NOTHING. The cell shows its own inline validation;
                    // persisting null here would erase a unit the line already had.
                    if (choice.incomplete) return;
                    void editLine(l.id, {
                      description: l.description,
                      unitLabel: choice.unitLabel,
                      canonicalUnit: choice.canonicalUnit,
                      productId: l.productId,
                      quantity: String(l.quantityMilli / 1000),
                      unitPrice: priceText(l.unitPrice.minor),
                    });
                  }}
                />
              </td>
              <td className="num">
                <input
                  dir="ltr"
                  inputMode="decimal"
                  defaultValue={priceText(l.unitPrice.minor)}
                  disabled={readOnly}
                  onBlur={(e) =>
                    editLine(l.id, {
                      description: l.description,
                      unitLabel: l.unitLabel,
                      canonicalUnit: l.canonicalUnit,
                      productId: l.productId,
                      quantity: String(l.quantityMilli / 1000),
                      unitPrice: e.target.value,
                    })
                  }
                />
              </td>
              {/* Read-only, and computed by the service — never by this component. */}
              <td className="num total" data-testid="sheet-line-total">
                <bdi dir="ltr">{fmt(l.lineTotal)}</bdi>
              </td>
              <td className="row-actions">
                {!readOnly && (
                  <>
                    <button className="btn ghost small" onClick={() => setPickerFor(l.id)}>
                      {t("inv.sheet.pick")}
                    </button>
                    <button className="btn ghost small" onClick={() => void removeLine(l.id)}>
                      {t("inv.sheet.remove")}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {view.lines.length === 0 && draftRows.length === 0 && (
            <tr>
              <td colSpan={7} className="muted center">
                {t("inv.sheet.noLines")}
              </td>
            </tr>
          )}
          {/* Every unsaved row, in the order it was added. The LAST one autofocuses, so pressing
              "+ Add Row" puts the caret where the operator is about to type. A row carries its own
              inline validation and its own remove — one incomplete row never speaks for the rest. */}
          {draftRows.map((r, i) => {
            const missing = rowBlank(r.line) ? null : rowMissing(r.line);
            return (
              <tr className="inv-new-line" key={r.key} data-testid="sheet-draft-row" data-row-key={r.key}>
                <td className="num">+</td>
                <td>
                  <input
                    autoFocus={i === draftRows.length - 1}
                    value={r.line.description ?? ""}
                    disabled={frozenRows.has(r.key)}
                    onChange={(e) => setRow(r.key, { ...r.line, description: e.target.value || null })}
                    data-testid="new-line-description"
                  />
                  {missing && (
                    <span className="error small" data-testid="sheet-draft-row-missing">
                      {t(`inv.sheet.missing.${missing}`)}
                    </span>
                  )}
                </td>
                <td className="num">
                  <input
                    dir="ltr"
                    inputMode="decimal"
                    value={r.line.quantity}
                    disabled={frozenRows.has(r.key)}
                    onChange={(e) => setRow(r.key, { ...r.line, quantity: e.target.value })}
                    data-testid="new-line-quantity"
                  />
                </td>
                <td>
                  <UnitCell
                    unitLabel={r.line.unitLabel}
                    canonicalUnit={r.line.canonicalUnit}
                    idSuffix={r.key}
                    disabled={frozenRows.has(r.key)}
                    onChange={(choice) =>
                      rowStore.edit(r.key, (x) => ({
                        key: x.key,
                        unitIncomplete: choice.incomplete,
                        line: { ...x.line, unitLabel: choice.unitLabel, canonicalUnit: choice.canonicalUnit },
                      }))
                    }
                  />
                </td>
                <td className="num">
                  <input
                    dir="ltr"
                    inputMode="decimal"
                    value={r.line.unitPrice}
                    disabled={frozenRows.has(r.key)}
                    onChange={(e) => setRow(r.key, { ...r.line, unitPrice: e.target.value })}
                    data-testid="new-line-price"
                  />
                </td>
                <td className="num muted">—</td>
                <td className="row-actions">
                  <button
                    className="btn ghost small"
                    disabled={frozenRows.has(r.key)}
                    onClick={() => setPickerFor(`draft:${r.key}`)}
                  >
                    {t("inv.sheet.pick")}
                  </button>
                  <button
                    className="btn ghost small"
                    disabled={frozenRows.has(r.key)}
                    onClick={() => dropRow(r.key)}
                    data-testid="sheet-draft-row-remove"
                  >
                    {t("inv.sheet.remove")}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        {/* FIELD FINDING 2: adding a second item was not discoverable. The affordance now sits in
            the table itself, immediately under the last row, and it is ALWAYS rendered — the old
            one disappeared while a row was being entered, which is exactly when an operator looks
            for it. While a draft row is open it is disabled and says why, instead of vanishing. */}
        {!readOnly && (
          <tfoot>
            <tr className="inv-add-row">
              <td colSpan={7}>
                <div className="inv-add-bar">
                  {/* 🔴 NO `disabled` ON A FULL SHEET. It is disabled only while a call is in
                      flight. The old condition — disabled whenever a row was open — is the field
                      defect itself. */}
                  <button className="btn primary" onClick={() => void addRow()} disabled={busy} data-testid="add-row">
                    + {t("inv.sheet.addRow")}
                  </button>
                  <span className="muted small" data-testid="sheet-rows-count">
                    {t("inv.sheet.rowsCount")}: <bdi dir="ltr">{view.lines.length}</bdi>
                  </span>
                  {draftRows.some((r) => !rowBlank(r.line)) && (
                    <span className="muted small" data-testid="sheet-unsaved-rows">
                      {t("inv.sheet.unsavedRows")}:{" "}
                      <bdi dir="ltr">{draftRows.filter((r) => !rowBlank(r.line)).length}</bdi>
                    </span>
                  )}
                </div>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      </div>

      {!readOnly && draftRows.length === 0 && (
        <div className="inv-actions">
          <span className="muted small">{t("inv.sheet.pickHint")}</span>
        </div>
      )}

      <section className="inv-totals">
        <table>
          <tbody>
            <tr>
              <th>{t("inv.sheet.subtotal")}</th>
              <td data-testid="sheet-subtotal"><bdi dir="ltr">{fmt(inv.subtotal)}</bdi></td>
            </tr>
            {/* Only when the shop configured a tax. No rate is built into this program. */}
            {inv.taxSnapshot?.enabled || inv.tax.minor !== "0" ? (
              <tr>
                <th>{inv.taxSnapshot?.label ?? t("inv.sheet.tax")}</th>
                <td data-testid="sheet-tax"><bdi dir="ltr">{fmt(inv.tax)}</bdi></td>
              </tr>
            ) : null}
            <tr className="grand">
              <th>{t("inv.sheet.total")}</th>
              <td data-testid="sheet-total"><bdi dir="ltr">{fmt(inv.total)}</bdi></td>
            </tr>
            <tr>
              <th>{t("inv.sheet.paid")}</th>
              <td>
                {readOnly ? (
                  <bdi dir="ltr">{fmt(inv.paid)}</bdi>
                ) : (
                  <input
                    dir="ltr"
                    inputMode="decimal"
                    defaultValue={inv.paid.minor === "0" ? "" : paidText(inv.paid.minor)}
                    ref={bind("paid")}
                    onBlur={(e) => void header({ paid: e.target.value.trim() === "" ? null : e.target.value })}
                    data-testid="sheet-paid"
                  />
                )}
              </td>
            </tr>
            <tr>
              <th>{t("inv.sheet.balance")}</th>
              <td data-testid="sheet-balance"><bdi dir="ltr">{fmt(inv.balanceDue)}</bdi></td>
            </tr>
          </tbody>
        </table>
        <div className="inv-words" data-testid="sheet-words">
          <span className="muted small">{t("inv.sheet.words")}</span>
          <div>{inv.amountInWords ?? <span className="muted">({t("inv.sheet.wordsAtFinalize")})</span>}</div>
        </div>
      </section>

      {/* 🔴 inv-keep: the action bar stays in view while the sheet scrolls past it. The class
          already existed and was used by one screen only; the sheet it was written for did not
          have it. Reused because this sheet scrolls inside the same .content scrollport, not
          because the class happened to exist — verified in the installed-app screenshots. */}
      <div className="inv-actions inv-keep">
        {/* ════════════════════════════════════════════════════════════════════════════════════
            🔴 FEEDBACK LIVES WITH THE BUTTONS, BECAUSE THAT IS WHERE THE OPERATOR IS LOOKING.

            Both of these used to render ABOVE this bar, in normal document flow. Measured in the
            installed Windows app, the missing-logo warning appeared at y=709 in a 681px viewport
            — ENTIRELY BELOW THE FOLD, 28px past anything the merchant could see. They pressed
            "حفظ PDF", got a document with no logo, and the sentence explaining why was off-screen
            with nothing to scroll them to it. The E2E screenshot looked fine because the test
            scrolled; a merchant gets no such scroll.

            The bar is `position: sticky; bottom: 0`, so anything inside it stays visible while the
            sheet scrolls. `.inv-feedback` is `flex: 1 0 100%`, which takes a full row of the
            wrapping flex container and therefore sits ABOVE the buttons without displacing them.

            🔴 TWO STATES, NEVER ONE. A genuine print/save failure and "this document has no
            archived logo" are different facts: the first means the operator's action did not
            happen, the second means it happened and the document is honest about what it lacks.
            They render as separate elements with their own testids, and the error is first — a
            warning must never stand in for a failure, and a failure must never be dressed as a
            warning.

            aria-live="polite" on the container announces whichever appears, without interrupting.
            ════════════════════════════════════════════════════════════════════════════════════ */}
        {(error || logoWarning) && (
          <div className="inv-feedback" role="status" aria-live="polite" data-testid="sheet-feedback">
            {error && <p className="error" data-testid="sheet-error">{error}</p>}
            {logoWarning && (
              <p className="small" data-testid="sheet-logo-warning">
                <span className="badge warn">{t("tools.noticeTag")}</span> {t("inv.sheet.logoMissing")}
              </p>
            )}
          </div>
        )}
        {!readOnly ? (
          <>
            <button
              className="btn primary"
              onClick={() => void prepareFinalize()}
              // An invoice whose only rows are still unsaved is finalizable: finalize flushes them
              // first. What it refuses is an INCOMPLETE row, and it says so.
              disabled={busy || (view.lines.length === 0 && !draftRows.some((r) => !rowBlank(r.line)))}
              data-testid="finalize"
            >
              {t("inv.sheet.finalize")}
            </button>
            {/* 🔴 THE DURABLE SAVE PATH, as an action the operator can see and trust. The product
                rule is that commercial header data must never depend only on blur timing; this
                writes every field as it is typed right now. */}
            {/* One save, one exit. Two buttons reading "حفظ المسودّة" and "حفظ وخروج" sat side by
                side and differed only in whether the screen closed. */}
            <button className="btn" onClick={() => void saveDraft()} disabled={busy} data-testid="save-draft">
              {t("inv.sheet.save")}
            </button>
            <button className="btn" onClick={leave} disabled={busy} data-testid="leave-draft">
              {t("inv.sheet.leave")}
            </button>
            {saved && (
              <span className="muted small" data-testid="draft-saved">
                {t("inv.sheet.saved")}
              </span>
            )}
            {/* Destructive, separate, and confirmed. Navigating away is NOT this. */}
            <button className="btn danger ghost" onClick={() => setDiscarding(true)} data-testid="discard">
              {t("inv.sheet.discard")}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={print} data-testid="print">
              {t("inv.sheet.print")}
            </button>
            <button className="btn" onClick={savePdf} data-testid="save-pdf">
              {t("inv.sheet.savePdf")}
            </button>
          </>
        )}
        {/* The way out of a sheet, in every state including read-only. It had no testid, so a
            script could not leave an issued invoice without restarting the application. */}
        <button className="btn ghost" onClick={readOnly ? onClosed : leave} data-testid="sheet-close">
          {t("action.cancel")}
        </button>
      </div>

      {/* Finalization is never implicit: the operator reads the figures and confirms. */}
      {confirming && (
        <div className="overlay">
          <div className="card dialog" data-testid="finalize-confirm">
            <h2>{t("inv.sheet.confirmTitle")}</h2>
            <dl className="inv-confirm">
              <dt>{t("inv.sheet.customer")}</dt>
              <dd>{inv.customerName ?? "—"}</dd>
              {issueOnAccount && linkedId && (
                <>
                  <dt>{t("inv.account.confirmRow")}</dt>
                  <dd data-testid="confirm-account">
                    <bdi dir="auto">{linkedName ?? "—"}</bdi> — <bdi dir="ltr">{fmt(inv.total)}</bdi>
                  </dd>
                </>
              )}
              <dt>{t("inv.sheet.lineCount")}</dt>
              <dd dir="ltr">{view.lines.length}</dd>
              <dt>{t("inv.sheet.subtotal")}</dt>
              <dd dir="ltr">{fmt(inv.subtotal)}</dd>
              <dt>{t("inv.sheet.total")}</dt>
              <dd dir="ltr">{fmt(inv.total)}</dd>
              <dt>{t("inv.sheet.paid")}</dt>
              <dd dir="ltr">{fmt(inv.paid)}</dd>
              <dt>{t("inv.sheet.balance")}</dt>
              <dd dir="ltr">{fmt(inv.balanceDue)}</dd>
            </dl>
            <p className="muted small">{t("inv.sheet.confirmNote")}</p>
            <div className="inv-actions">
              <button className="btn primary" onClick={finalize} data-testid="finalize-confirm-yes">
                {t("inv.sheet.finalize")}
              </button>
              <button className="btn ghost" onClick={() => setConfirming(false)}>
                {t("action.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {exiting && (
        <div className="overlay">
          <div className="card dialog" role="dialog" aria-modal="true" data-testid="exit-confirm">
            <h2>{t("inv.exit.title")}</h2>
            <p className="muted small">{t("inv.exit.body")}</p>
            {error && <p className="error" data-testid="exit-error">{error}</p>}
            <div className="inv-actions">
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => void saveAndLeave()}
                data-testid="exit-save"
              >
                {t("inv.exit.saveAndLeave")}
              </button>
              {/* Ghost-danger: it discards work, but it is an action row, not the confirm of a
                  destructive dialog, so it must not out-weigh "save and leave". */}
              <button
                className="btn danger ghost"
                disabled={busy}
                onClick={() => {
                  setExiting(false);
                  onClosed();
                }}
                data-testid="exit-discard"
              >
                {t("inv.exit.leaveWithout")}
              </button>
              <button className="btn" disabled={busy} onClick={() => setExiting(false)} data-testid="exit-cancel">
                {t("action.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {discarding && (
        <div className="overlay">
          <div className="card dialog" data-testid="discard-confirm">
            <h2>{t("inv.sheet.discardTitle")}</h2>
            <p className="muted">{t("inv.sheet.discardConfirm")}</p>
            <div className="inv-actions">
              <button className="btn danger" onClick={() => void discard()} data-testid="discard-confirm-yes">
                {t("inv.sheet.discardYes")}
              </button>
              <button className="btn ghost" onClick={() => setDiscarding(false)} data-testid="discard-confirm-no">
                {t("inv.sheet.discardKeep")}
              </button>
            </div>
          </div>
        </div>
      )}

      {findingCustomer && (
        <CustomerFinder
          onClose={() => setFindingCustomer(false)}
          onPick={(c) => {
            setFindingCustomer(false);
            void chooseAccount(c.id, c.displayName);
          }}
        />
      )}

      {finalized && (
        <div className="overlay">
          <div className="card dialog" data-testid="finalized-notice">
            <h2>
              {t("inv.sheet.finalized")} <bdi dir="ltr">#{finalized.number}</bdi>
            </h2>
            {finalized.onAccountOf !== undefined && (
              <p data-testid="finalized-on-account">
                {t("inv.account.issued")} <bdi dir="auto">{finalized.onAccountOf}</bdi>
              </p>
            )}
            {summarize(finalized.items, t).length > 0 ? (
              <>
                <p>
                  <strong dir="ltr">
                    {finalized.items.filter((i) => i.status === "PENDING" || i.status === "FAILED").length}
                  </strong>{" "}
                  {t("inv.review.summary")}
                </p>
                <ul>
                  {summarize(finalized.items, t).map((row) => (
                    <li key={row} dir="auto">
                      {row}
                    </li>
                  ))}
                </ul>
                <div className="inv-actions">
                  <button className="btn primary" onClick={onReviewNow} data-testid="review-now">
                    {t("inv.sheet.reviewNow")}
                  </button>
                  <button className="btn ghost" onClick={() => setFinalized(null)} data-testid="review-later">
                    {t("inv.sheet.later")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>{t("inv.history.reviewClear")}</p>
                <button className="btn primary wide" onClick={() => setFinalized(null)} data-testid="review-clear-ok">
                  {t("action.ok")}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {pickerFor && (
        <div className="overlay">
          <div className="card dialog" data-testid="product-picker">
            <h2>{t("inv.sheet.pick")}</h2>
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("products.search")}
            />
            <ul className="inv-picker">
              {matches.map((p) => (
                <li key={p.id}>
                  <button className="btn ghost wide" onClick={() => pick(p)} data-testid="picker-option">
                    <span>{p.nameAr}</span>
                    <span className="muted" dir="ltr">
                      {p.priceDecimal} · {p.baseUnit}
                      {p.priceNeedsReview ? " · price?" : ""}
                    </span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && <li className="muted">{t("products.noMatch")}</li>}
            </ul>
            <p className="muted small">{t("inv.sheet.pickHint")}</p>
            <button className="btn ghost wide" onClick={() => setPickerFor(null)}>
              {t("action.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Minor units back to the decimal string the service will re-parse. Two decimals, no float math. */
function priceText(minor: string): string {
  const digits = minor.padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
const paidText = priceText;
