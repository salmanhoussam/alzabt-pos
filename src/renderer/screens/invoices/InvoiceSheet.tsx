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
  CustomerDto,
  InvoiceHeaderPatch,
  InvoiceHeaderPatchKey,
  InvoiceLineDto,
  InvoiceLineRequest,
  InvoiceViewDto,
  ReconciliationDto,
} from "../../../shared/ipcContract";
import { INVOICE_HEADER_PATCH_KEYS } from "../../../shared/ipcContract";
import { ApiError, call, errorText, fmt, newIdempotencyKey, pos } from "../../api";
import { CustomerFinder } from "../CustomerFinder";
import { useT } from "../../i18n";
import { DEFAULT_UNIT, UnitCell } from "../../components/UnitCell";
import { formatDecimal, money, parseDecimal } from "../../../domain/money";
import { DraftRowStore } from "./draftRowStore";
import { isTypedTaxRateUnsaved } from "./taxRateDirty";
import { classifyFlushFailure } from "./flushOutcome";
import { accountPrefill } from "./accountPrefill";
import { claimModal, focusedControl, openSheetModals, useModalFocus, type SheetModal } from "./sheetModal";
import { appModalOwner, claimAppModal, releaseAppModal, useAppModalOwner } from "../../appModal";
import { confirmationDigest } from "../../../shared/invoiceConfirmation";
import {
  createFailureLedger,
  createSaveQueue,
  lineInputMatchesStored,
  paidWriteDecision,
  type LineInputField,
  type LineParsers,
} from "./headerSaveQueue";
import { cleanText, parseInvoiceQuantity } from "../../../domain/invoice";

/** INV-PAY-METHOD: the issue step's own sentences for the refusals it can meet. */
const PAY_ERROR_KEY: Readonly<Record<string, string>> = {
  INVOICE_PAYMENT_METHOD_REQUIRED: "inv.pay.needed",
  DUPLICATE_PAYMENT_REFERENCE: "pay.whishErr.duplicate",
  FUNDS_NOT_CONFIRMED: "pay.whishErr.notConfirmed",
};

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

// A renderer remount is not proof that an unanswered Main operation has settled.
// Keep the per-invoice lock for this renderer session; a confirmed final read resolves it.
const unknownIssueOutcomes = new Set<string>();

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
  // An issue refusal belongs to the issue attempt, not to a later unrelated field save.
  // It is cleared only when a newly prepared confirmation is actually opened.
  const [issueRefusal, setIssueRefusal] = useState<string | null>(() =>
    unknownIssueOutcomes.has(invoiceId) ? t("inv.sheet.issueOutcomeUnknown") : null,
  );
  const [issueOutcomeUncertain, setIssueOutcomeUncertain] = useState(() => unknownIssueOutcomes.has(invoiceId));
  const preparingIssue = useRef(false);
  /** This document printed without its own archived logo. A warning, never an error — see below. */
  const [logoWarning, setLogoWarning] = useState(false);
  /**
   * This document named a logo that was never archived, so it printed WITHOUT one rather than with
   * today's file (Track 2 phase 3). A different fact from `logoWarning`, with its own sentence.
   */
  const [logoUnverified, setLogoUnverified] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /**
   * R3 (Abu Abbas, R2 review — confirmation race): the exact figures the confirmation SHOWED, captured when it opened.
   *
   * 🔴 WHY. With the confirmation open, keyboard Tab reached the paid field underneath it; a cashier could confirm
   * «paid 5.00» while a queued save changed it to 3.00, and the issue went out on 3.00. The background is now inert
   * while the confirmation is open, AND the issue is bound to these figures: after the final flushes the freshly stored
   * figures must be identical, or nothing is issued and the operator is asked to confirm again.
   */
  const confirmedFigures = useRef<string | null>(null);
  /** R3: true while the finalize request is in flight — the paid amount is then shown as text, not as an input. */
  const [issuing, setIssuing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [finalized, setFinalized] = useState<FinalizedNotice | null>(null);
  /** Migration 16. The linked account's name for DISPLAY only — the link itself is the id on the invoice. */
  const [linkedName, setLinkedName] = useState<string | null>(null);
  const [findingCustomer, setFindingCustomer] = useState(false);
  /**
   * R4 (Abu Abbas, R3-1 — the confirmation behind the product picker): ONE modal at a time, the background inert
   * while any is open, focus kept inside it. `modalsRef` is written by every opener BEFORE React re-renders, so two
   * openers in one tick cannot both win; each render re-syncs it from state. See sheetModal.ts.
   */
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const openModals = openSheetModals({
    finalized: finalized !== null,
    exit: exiting,
    discard: discarding,
    confirm: confirming,
    customer: findingCustomer,
    picker: pickerFor !== null,
  });
  const modalsRef = useRef<{ value: readonly SheetModal[] }>({ value: [] });
  modalsRef.current.value = openModals;
  const modalOpen = openModals.length > 0;
  /** The control a modal hands focus back to — recorded by the opener, before the background turns inert. */
  const modalOpener = useRef<HTMLElement | null>(null);
  /**
   * R5 (Abu Abbas F2 + R5 contract invariants 1–2): the issue in flight is an OWNER too. From the confirmed «إصدار»
   * until the answer, no dialog opens and the app shell is inert — the operation stays isolated until it completes or
   * is refused. `operatingRef` is read synchronously by every gate; `operating` re-renders the shell.
   */
  const operatingRef = useRef(false);
  const [operating, setOperating] = useState(false);
  /** The app-level owner id this sheet claims while any of its dialogs, or its issue, owns interaction. */
  const appOwnerId = `invoice:${invoiceId}`;
  const activeAppOwner = useAppModalOwner();
  const externalOwner = () => appModalOwner() !== null && appModalOwner() !== appOwnerId;
  /**
   * Opens `kind` only when nothing else owns interaction — no other dialog, no issue in flight, and no operator action
   * still waiting or running (`queue.acting`), unless the opener IS that action (`insideAction`: the confirmation from
   * «إصدار», the exit question from «خروج», the customer finder from «اختيار حساب»). A refusal says why; false =
   * nothing opened. Claimed in the sheet's ref AND the app owner synchronously, before React re-renders.
   */
  const openModal = (
    kind: SheetModal,
    open: () => void,
    opener: HTMLElement | null = focusedControl(),
    insideAction = false,
  ): boolean => {
    if (externalOwner() || operatingRef.current || (!insideAction && queue.acting)) {
      setError(t("inv.sheet.actionPending"));
      return false;
    }
    if (!claimModal(modalsRef.current, kind)) {
      setError(t("inv.sheet.modalOpen"));
      return false;
    }
    claimAppModal(appOwnerId);
    modalOpener.current = opener;
    open();
    return true;
  };
  /** Closes `kind` in the ref at once (so the action that follows in the same tick is not refused), then in state. */
  const closeModal = (kind: SheetModal, close: () => void) => {
    modalsRef.current.value = modalsRef.current.value.filter((k) => k !== kind);
    close();
  };
  /**
   * R5: may a write or action requested BY `by` (null = the sheet's background) run now? Only when no dialog is open,
   * or when the open dialog is the one asking. Checked when it is requested AND again when a queued action runs.
   */
  const dialogAllows = (by: SheetModal | null): boolean => {
    const open = modalsRef.current.value;
    return open.length === 0 || (open.length === 1 && open[0] === by);
  };
  useModalFocus(openModals[0] ?? null, sheetRef, modalOpener);
  const appOwned = modalOpen || operating;
  useEffect(() => {
    if (appOwned) claimAppModal(appOwnerId);
    else releaseAppModal(appOwnerId);
  }, [appOwned, appOwnerId]);
  useEffect(() => () => releaseAppModal(appOwnerId), [appOwnerId]);
  /** Convenience only: the owner-only option is drawn for owners; the service re-reads the live role. */
  const [isOwner, setIsOwner] = useState(false);
  /** Explicit, per attempt, never remembered: issuing on account is a deliberate act every time. */
  const [issueOnAccount, setIssueOnAccount] = useState(false);
  /**
   * INV-PAY-METHOD (owner, 2026-11-09): how the amount marked paid arrived, chosen in the confirmation
   * itself — the one moment before the document becomes immutable. Cash, or Whish Money with its
   * reference and an explicit (never pre-ticked) "the money arrived". Reset every time it opens.
   */
  const [payMethod, setPayMethod] = useState<"cash" | "whish" | null>(null);
  const [payReference, setPayReference] = useState("");
  const [payConfirmed, setPayConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The tax-rate input, so Finalize can read what is typed instead of trusting that a blur happened. */
  const taxInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    call(pos().getInvoice({ invoiceId }))
      .then((next) => {
        if (next.invoice.status === "final") {
          unknownIssueOutcomes.delete(invoiceId);
          setIssueOutcomeUncertain(false);
          setIssueRefusal(null);
        }
        setView(next);
      })
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
   * CURRENCY-P1 / Finding C (Abu Abbas, v3 review): has the merchant typed into the paid field since it was rendered?
   *
   * 🔴 WHY A TOUCH FLAG AND NOT ONLY A VALUE COMPARISON. The paid input is uncontrolled and was written back from its
   * own rendering — by its blur and by every full `flushHeader` (save, save-and-leave, issue). Any difference between
   * the rendering and the stored value (a two-decimal rendering of a 0.100 JOD amount was one) turned an untouched
   * field into a silent rewrite of money. Now an untouched field is never sent; a touched one is sent only when its
   * value, parsed by the service's own `parseDecimal` in the invoice currency, differs from the stored minor units.
   * It is the header counterpart of v3's `touchedLineInputs` for existing lines.
   */
  // R2 (Abu Abbas P1-1): no touch flag. The VISIBLE value is compared with the sheet's own exact rendering of the
  // NEWEST stored amount (`viewRef`), then by value — so a change that fired no `input` event (a `change`-only update,
  // a programmatic assignment) is still seen, and an untouched field is still never written back.
  const paidDecision = () => {
    const inv = viewRef.current?.invoice;
    const el = fieldRefs.current.paid;
    if (!inv || !el) return "omit" as const;
    const rendering = inv.paid.minor === "0" ? "" : paidText(inv.paid.minor, inv.paid.currency);
    return paidWriteDecision(el.value, rendering, inv.paid.minor, (text) => parseDecimal(text.trim(), inv.paid.currency));
  };
  /**
   * R2 (Invariants A/E): the last check before «محفوظة», «حفظ وخروج» closing, the confirmation and the issue — run
   * AFTER the flushes. If the paid amount on screen still differs from the stored one at that moment (it changed while
   * a flush was in flight, by any means), nothing may claim success over it: the action stops and says so.
   */
  const verifyPaid = (): string | null => (paidDecision() === "send" ? t("inv.sheet.paidUnverified") : null);

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
  /**
   * INV-FIRST-CLICK (F2-5): background saves and operator actions, in order (`headerSaveQueue.ts`).
   *
   * 🔴 A BLUR NEVER DISABLES A BUTTON. It used to go through `run`, whose `setBusy(true)` was committed
   * between the merchant's mouse press and release, so the very button being pressed was disabled
   * before its click arrived and the click was lost. Blur saves now go through `background`, which
   * never touches `busy`; buttons go through `act`, which waits for those saves, stops if one of them
   * was refused, and ignores a second press while the first is still waiting or running.
   */
  const queue = useMemo(() => createSaveQueue(), []);
  /**
   * F2-5-R2 (Abu Abbas's review): header and tax refusals that are STILL UNRESOLVED, by field.
   *
   * 🔴 A LATER SUCCESS MUST NOT ERASE AN EARLIER REFUSAL. Every save used to clear the one `error`
   * string as it started, so a refused name followed by an accepted phone left the sheet silent while
   * the press that depended on them was (correctly) blocked. A refusal now lives here until a save of
   * the SAME field succeeds — its own blur, the account link, or an action's full `flushHeader` — and
   * it is shown whenever no newer action error is on screen.
   *
   * Existing-LINE edits are deliberately NOT tracked here: their unresolved-failure handling is the
   * separate, pre-existing finding INV-LINE-EDIT-FAIL, awaiting the owner's decision.
   */
  const saveFailures = useMemo(() => createFailureLedger(), []);
  const [, setFailureVersion] = useState(0);
  const markSaved = (keys: readonly string[]) => {
    if (saveFailures.saved(keys)) setFailureVersion((v) => v + 1);
  };
  const markRefused = (keys: readonly string[], message: string) => {
    saveFailures.refused(keys, message);
    setFailureVersion((v) => v + 1);
  };
  const unresolvedFailure = (): string | null => saveFailures.latest();
  /** `failureKeys`: the header fields (or "tax") this save writes; `null` for a line edit (not tracked). */
  /**
   * `failureKeys`: the header fields, "tax", or `line:<id>` this save writes. `describe` turns a refusal
   * into the text kept for it (default: the refusal as the service worded it).
   */
  const background = (
    action: () => Promise<InvoiceViewDto>,
    failureKeys: readonly string[] | null,
    describe: (e: unknown) => string = errorText,
    /** INV-LINE-EDIT-FAIL v2: when given, decides what a success resolves INSTEAD of clearing `failureKeys`. */
    resolveOnSuccess?: (next: InvoiceViewDto) => void,
    /** R5: the dialog this write comes from (the picker's pick); the background passes nothing. */
    by: SheetModal | null = null,
  ): Promise<boolean> => {
    // R5 (Abu Abbas F2): a write REQUESTED while a dialog owns the sheet is refused, not queued. The typed value stays
    // on screen and every action's own flush re-sends it. A save requested before the dialog opened runs as accepted.
    if (externalOwner() || operatingRef.current || preparingIssue.current || !dialogAllows(by)) {
      setError(t(operatingRef.current || preparingIssue.current ? "inv.sheet.actionPending" : "inv.sheet.modalOpen"));
      return Promise.resolve(false);
    }
    return queue.save(async () => {
      setError(null);
      try {
        const next = await action();
        setView(next);
        if (resolveOnSuccess) resolveOnSuccess(next);
        else if (failureKeys) markSaved(failureKeys);
      } catch (e) {
        // Shown here; the queue records the failure so a waiting action does not run over it.
        if (failureKeys) markRefused(failureKeys, describe(e));
        else setError(errorText(e));
        throw e;
      }
    });
  };

  /**
   * INV-LINE-EDIT-FAIL (owner-approved 2026-11-20): the newest refused edit to an EXISTING saved line that
   * has not been resolved, or null.
   *
   * 🔴 WHY THIS EXISTS. An existing line is written ONLY by its own blur (`editLine`); issue, save and
   * save-and-leave flush draft rows, tax and header, never existing lines. So a refused line edit used to
   * be cleared from the screen by the next unrelated save, and «إصدار» then issued the OLD line while the
   * field still showed the merchant's typed value — on an immutable document. A refusal stays here until a
   * save of the SAME line succeeds (its retry) or the line is removed; issue and save refuse while it does,
   * and leaving asks first.
   */
  const unresolvedLineEdit = (): string | null => saveFailures.latestFor("line:");

  /**
   * INV-LINE-EDIT-FAIL v2 (Abu Abbas L-R1 / L-R2): unresolved state is kept PER FIELD of a line, at value level.
   *
   * Keys: `line:<id>:description|quantity|unitPrice` (typed inputs), `line:<id>:unit` (the unit select) and
   * `line:<id>:pick` (a catalog pick). For a typed input an entry exists exactly while what the merchant SEES
   * differs from what is STORED, compared through the service's own parsers (`lineInputMatchesStored`). So a
   * successful save of ANOTHER field — the same line's description, a header field, anything — cannot resolve
   * a refused price: only its own accepted retry, an explicit «تراجع», a write that really stored that value,
   * or removing the line can. The unit and the pick are props-driven (a refused one snaps back on screen), so
   * they are resolved only by an accepted write of that same kind, «تراجع», or removing the line.
   */
  const lineKey = (lineId: string, field: LineInputField | "unit" | "pick") => `line:${lineId}:${field}`;
  const LINE_PARSERS: LineParsers = {
    cleanText: (text) => cleanText(text, "description", Number.MAX_SAFE_INTEGER),
    quantityMilli: (text) => parseInvoiceQuantity(text),
    priceMinor: (text) => parseDecimal(text.trim(), viewRef.current?.invoice.currency ?? "USD").minor,
  };
  /** The typed inputs of existing lines, by `<lineId>:<field>` — read, never controlled. */
  const lineInputs = useRef(new Map<string, HTMLInputElement>());
  /**
   * v3 (Abu Abbas Finding B): the existing-line inputs the merchant has TYPED into and whose value is not yet
   * confirmed stored, by `<lineId>:<field>`. Set on `input`; cleared only when the value is confirmed stored
   * (by value), on «تراجع», or when the line is removed.
   *
   * 🔴 WHY. v2 treated an input that equals the sheet's own rendering of the stored value as unchanged. That
   * rendering is LOSSY for a 3-decimal currency (a stored 0.100 JOD renders «1.00»), so a merchant who typed
   * «1.00» — 1.000 JOD, ten times the price — and was refused looked "unchanged" and the refusal vanished.
   * The rendering shortcut now applies only to an input nobody typed into; a touched input must match the
   * stored value through the service's own parser, or it stays unsaved. And an untouched input is never
   * written on blur at all, so merely focusing a lossy field can no longer send its rendering back.
   */
  const touchedLineInputs = useRef(new Set<string>());
  const touchLineInput = (lineId: string, field: LineInputField) => () => {
    touchedLineInputs.current.add(`${lineId}:${field}`);
  };
  const isTouched = (lineId: string, field: LineInputField) => touchedLineInputs.current.has(`${lineId}:${field}`);
  const bindLineInput = (lineId: string, field: LineInputField) => (el: HTMLInputElement | null) => {
    if (el) lineInputs.current.set(`${lineId}:${field}`, el);
    else lineInputs.current.delete(`${lineId}:${field}`);
  };
  const storedOf = (line: InvoiceLineDto) => ({
    description: line.description,
    quantityMilli: line.quantityMilli,
    unitPriceMinor: line.unitPrice.minor,
  });
  /**
   * Re-derives every typed-input entry of the given lines from screen vs store. A mismatch with no entry yet
   * (a value displayed but never stored — e.g. a pick over an edited input) gets one; a match clears one.
   */
  const reconcileLineInputs = (lines: readonly InvoiceLineDto[]) => {
    for (const line of lines) {
      for (const field of ["description", "quantity", "unitPrice"] as const) {
        const input = lineInputs.current.get(`${line.id}:${field}`);
        if (!input) continue;
        const key = lineKey(line.id, field);
        const touched = isTouched(line.id, field);
        // v3: the sheet's OWN rendering of the stored value counts as "unchanged" ONLY for an input nobody typed
        // into (a display quirk must not become a false block on an untouched 3-decimal line). A TOUCHED input
        // is compared by value through the service's parser — never by the lossy rendering (Finding B).
        const unchanged = !touched && input.value === defaultLineText(line, field);
        if (unchanged || lineInputMatchesStored(field, input.value, storedOf(line), LINE_PARSERS)) {
          markSaved([key]);
          touchedLineInputs.current.delete(`${line.id}:${field}`);
        } else if (!saveFailures.has(key)) markRefused([key], t("inv.sheet.lineEditUnverified"));
      }
    }
  };
  /**
   * The issue / save / leave guard: reconcile EVERY line's inputs against the newest stored view, then report
   * the newest unresolved line entry. Runs after the queue has drained (every caller is an `act`).
   */
  const verifyLines = (): string | null => {
    reconcileLineInputs(viewRef.current?.lines ?? []);
    return unresolvedLineEdit();
  };
  /** An explicit «تراجع»: show the stored value again; nothing is written, because the store never changed. */
  const revertLineField = (line: InvoiceLineDto, field: LineInputField | "unit" | "pick") => {
    if (field === "description" || field === "quantity" || field === "unitPrice") {
      const input = lineInputs.current.get(`${line.id}:${field}`);
      if (input) input.value = defaultLineText(line, field);
      touchedLineInputs.current.delete(`${line.id}:${field}`);
    }
    markSaved([lineKey(line.id, field)]);
  };
  /**
   * R5 (Abu Abbas F2): an operator action, gated by ONE rule at the press AND when the queue finally runs it — a
   * dispatched click on a control behind an open dialog (delete, add row, save, leave, unlink…) changes nothing.
   * `by` names the dialog an action comes from; the background passes nothing.
   */
  const act = (op: () => Promise<void> | void, by: SheetModal | null = null, preparing = false) => {
    if (externalOwner() || operatingRef.current || preparingIssue.current || !dialogAllows(by)) {
      setError(t(operatingRef.current || preparingIssue.current ? "inv.sheet.actionPending" : "inv.sheet.modalOpen"));
      return;
    }
    if (preparing && queue.acting) return;
    if (preparing) preparingIssue.current = true;
    void queue
      .action(async () => {
        if (externalOwner() || !dialogAllows(by)) throw new Error(t("inv.sheet.modalOpen"));
        await op();
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => { if (preparing) preparingIssue.current = false; });
  };

  const header = (patch: InvoiceHeaderPatch) =>
    background(() => call(pos().updateInvoiceHeader({ invoiceId, patch })), Object.keys(patch));

  /**
   * Writes EVERY header field as the operator has it typed right now, in one request.
   *
   * The durable save path the product rule demands: commercial header data must never depend only
   * on blur timing. Save draft, leaving the screen and Finalize all go through this, so a value
   * that was typed but never blurred is still persisted.
   */
  const flushHeader = async (): Promise<InvoiceViewDto | null> => {
    const patch: Record<string, string | null> = {};
    let paidResolved = false;
    for (const key of INVOICE_HEADER_PATCH_KEYS) {
      if (!fieldRefs.current[key]) continue;
      if (key === "paid") {
        // CURRENCY-P1 / Finding C: the paid amount is NOT re-sent "as typed" unless it really was typed and differs.
        const decision = paidDecision();
        if (decision === "omit" || decision === "resolve") {
          paidResolved = true;
          continue;
        }
      }
      patch[key] = typed(key);
    }
    if (Object.keys(patch).length === 0) {
      if (paidResolved) markSaved(["paid"]);
      return viewRef.current;
    }
    const next = await call(pos().updateInvoiceHeader({ invoiceId, patch: patch as InvoiceHeaderPatch }));
    setView(next);
    // Every bound field was just accepted as typed: no header refusal is unresolved any more.
    markSaved(paidResolved ? [...Object.keys(patch), "paid"] : Object.keys(patch));
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
    // F2-5-R1: the NEWEST stored row (`viewRef`), never the render this handler was created in. `leave`
    // now runs after the queued blur-saves; reading `view` here compared the typed text with the row
    // as it was BEFORE that save, and a draft saved a moment ago was reported unsaved.
    const inv = viewRef.current?.invoice;
    if (!inv) return "";
    if (key === "paid") return inv.paid.minor === "0" ? "" : paidText(inv.paid.minor, inv.paid.currency);
    return (inv as unknown as Record<string, string | null>)[key] ?? "";
  };

  /**
   * Compare exactly as the service parses percentages: a numerically equal but invalid value
   * (e.g. "11.000" or "11e0") must still count as unsaved, never permit a false Saved claim.
   */
  const taxDirty = (): boolean => {
    const el = taxInput.current;
    const stored = viewRef.current?.invoice.taxSnapshot ?? null; // F2-5-R1: newest, as above
    if (!el || !stored || stored.enabled !== true) return false;
    return isTypedTaxRateUnsaved(el.value, stored.rateBasisPoints);
  };

  /**
   * Is anything typed but not yet stored?
   *
   * 🔴 THE EXIT RULE NEEDS A REAL ANSWER, not an optimistic one. Comparing each bound input's
   * CURRENT value against the value on the stored row is the only way to know; a flag set by
   * onChange would miss a field restored to its original value and would nag for nothing.
   */
  const isDirty = (): boolean => {
    const inv = viewRef.current?.invoice; // F2-5-R1: newest, as above
    if (!inv) return false;
    if (taxDirty()) return true;
    // INV-LINE-EDIT-FAIL: a refused line edit is unsaved work — leaving asks, never discards silently.
    if (verifyLines() !== null) return true;
    for (const key of INVOICE_HEADER_PATCH_KEYS) {
      if (!fieldRefs.current[key]) continue;
      if (key === "paid") {
        if (paidDecision() === "send") return true;
        continue;
      }
      if ((typed(key) ?? "") !== storedDisplay(key)) return true;
    }
    return false;
  };

  const snapshot = view?.invoice.taxSnapshot ?? null;
  const taxOn = snapshot?.enabled === true;
  /** The frozen rate as a percentage string, from exact basis points — never a float. */
  const taxRate = snapshot && snapshot.enabled ? percentText(snapshot.rateBasisPoints) : "";

  const applyTax = (enabled: boolean, ratePercent: string) =>
    background(
      () =>
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
      ["tax"],
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
      // INV-LINE-EDIT-FAIL: everything else is stored, but «محفوظة» would be false while a line edit is not.
      const lineRefusal = verifyLines();
      if (lineRefusal !== null) {
        setError(lineRefusal);
        return next;
      }
      // R2: and never while the paid amount on screen differs from the stored one.
      const paidRefusal = verifyPaid();
      if (paidRefusal !== null) {
        setError(paidRefusal);
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

  /**
   * Writes one existing line. `touched` is what THIS write carries from the merchant: one typed field, the
   * unit, or a pick. A refusal records exactly those fields; a success re-checks the line's typed inputs by
   * value and resolves only the unit / pick entry this write actually carried.
   */
  const editLine = (
    lineId: string,
    line: InvoiceLineRequest,
    touched: LineInputField | "unit" | "pick",
    by: SheetModal | null = null,
  ) =>
    background(
      () => call(pos().updateInvoiceLine({ invoiceId, lineId, line })),
      [lineKey(lineId, touched)],
      (e) => `${t("inv.sheet.lineEditUnsaved")} ${errorText(e)}`,
      (next) => {
        if (touched === "unit" || touched === "pick") markSaved([lineKey(lineId, touched)]);
        reconcileLineInputs(next.lines.filter((l) => l.id === lineId));
      },
      by,
    );

  const removeLine = (lineId: string) =>
    run(async () => {
      const next = await call(pos().removeInvoiceLine({ invoiceId, lineId }));
      // A removed line has no edit left to resolve — every field of THAT line, and no other line's.
      markSaved(saveFailures.keysWithPrefix(`line:${lineId}:`));
      for (const field of ["description", "quantity", "unitPrice"] as const) touchedLineInputs.current.delete(`${lineId}:${field}`);
      return next;
    });

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
      openModal("exit", () => setExiting(true), focusedControl(), true);
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
      // INV-LINE-EDIT-FAIL: «حفظ وخروج» must not close over an unsaved line edit; «خروج دون حفظ» stays the
      // explicit way to discard it.
      const lineRefusal = verifyLines();
      if (lineRefusal !== null) {
        setError(lineRefusal);
        return;
      }
      // R2: nor over a paid amount that differs from the stored one.
      const paidRefusal = verifyPaid();
      if (paidRefusal !== null) {
        setError(paidRefusal);
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
    // R5: the service found the persisted draft different from the confirmation — the same sentence as the sheet's own.
    if (e instanceof ApiError && e.code === "INVOICE_CONFIRMATION_STALE") return t("inv.sheet.confirmStale");
    if (e instanceof ApiError && e.code === "INVOICE_CONFIRMATION_REQUIRED") return t("inv.sheet.confirmIdentityRequired");
    if (e instanceof ApiError && e.code === "INVOICE_CONFIRMATION_UNVERIFIABLE") return t("inv.sheet.confirmIdentityUnavailable");
    if (e instanceof ApiError && e.code === "INVOICE_TAX_CONFIRMATION_REQUIRED") return t("inv.sheet.confirmTaxExplicit");
    if (e instanceof ApiError && e.code === "IDEMPOTENCY_CONFLICT") return t("inv.sheet.confirmIdentityConflict");
    // INV-PAY-METHOD: the method step's own sentences (text follows the operation).
    if (e instanceof ApiError && PAY_ERROR_KEY[e.code]) return t(PAY_ERROR_KEY[e.code]!);
    if (e instanceof ApiError && e.code.startsWith("CREDIT_")) {
      // The cashier cannot tick "on account", so a part-paid refusal tells them who can.
      const key = e.code === "CREDIT_PARTIAL_NEEDS_ACCOUNT" && !isOwner ? `inv.account.err.${e.code}.cashier` : `inv.account.err.${e.code}`;
      const text = t(key);
      if (text !== key) return text;
    }
    return errorText(e);
  };

  /** Links (or unlinks) an exact account through the ordinary header write, then adopts the answer. */
  const chooseAccount = async (account: CustomerDto | null) => {
    setBusy(true);
    setError(null);
    try {
      const previousCustomerId = viewRef.current?.invoice.customerPartyId ?? null;
      // INV-CUSTOMER-PREFILL: the EMPTY printed name, phone and address are filled from the account
      // in the SAME write as the link (`accountPrefill`), so they are stored with it rather than on
      // a later blur. Typed values are never replaced; unlinking fills nothing.
      const fill =
        account === null
          ? {}
          : accountPrefill(account, {
              customerName: fieldRefs.current.customerName?.value,
              customerPhone: fieldRefs.current.customerPhone?.value,
              customerAddress: fieldRefs.current.customerAddress?.value,
            });
      const next = await call(
        pos().updateInvoiceHeader({ invoiceId, patch: { customerPartyId: account?.id ?? null, ...fill } }),
      );
      setView(next);
      markSaved(["customerPartyId", ...Object.keys(fill)]);
      setLinkedName(account?.displayName ?? null);
      // A checked credit instruction belongs to the PREVIOUS customer's identity. Changing the
      // account (including unlinking) must require an explicit fresh tick for the new customer.
      if (next.invoice.customerPartyId !== previousCustomerId) setIssueOnAccount(false);
      // The inputs are uncontrolled: show in each filled field what the row now holds.
      for (const key of Object.keys(fill) as (keyof typeof fill)[]) {
        const input = fieldRefs.current[key];
        if (input) input.value = next.invoice[key] ?? "";
      }
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
    markSaved(["tax"]);
  };

  const prepareFinalize = async () => {
    // A lost/ambiguous answer needs a fresh read of the invoice, not a second issue from this sheet.
    if (issueOutcomeUncertain) return;
    // R4: «إصدار» itself, taken NOW — it is disabled while the flushes below run, which takes its focus away.
    const issueButton = focusedControl();
    // R4: the issue confirmation never opens while another dialog is open (it would sit under or over it).
    if (modalsRef.current.value.length > 0) {
      setError(t("inv.sheet.modalOpen"));
      return;
    }
    // INV-LINE-EDIT-FAIL: never issue while an edit to an existing line is refused and unresolved.
    const lineRefusal = verifyLines();
    if (lineRefusal !== null) {
      setError(lineRefusal);
      return;
    }
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
      // v3 (Abu Abbas Finding A): re-verify AFTER the flushes. The guard at the top ran before them; nothing the
      // merchant can see may differ from the store at the moment the confirmation is offered.
      const lateLineRefusal = verifyLines();
      if (lateLineRefusal !== null) {
        setError(lateLineRefusal);
        return;
      }
      // R2: the confirmation reads the STORED paid amount; it must be the one on screen.
      const latePaidRefusal = verifyPaid();
      if (latePaidRefusal !== null) {
        setError(latePaidRefusal);
        return;
      }
      // INV-PARTIAL-DEBT (Option B): decided here on the STORED values, before the confirmation — and
      // again by the service, which is the authority. TRANSITION: this used to refuse ANY paid amount
      // on account (inv.account.err.CREDIT_NEEDS_UNPAID); a part-paid invoice now MUST go on account.
      const storedView = viewRef.current;
      const stored = storedView?.invoice;
      if (stored) {
        const partlyPaid = stored.paid.minor !== "0" && stored.balanceDue.minor !== "0";
        if (partlyPaid && !issueOnAccount) {
          setError(t(isOwner ? "inv.account.err.CREDIT_PARTIAL_NEEDS_ACCOUNT" : "inv.account.err.CREDIT_PARTIAL_NEEDS_ACCOUNT.cashier"));
          return;
        }
        if (issueOnAccount && stored.balanceDue.minor === "0") {
          setError(t("inv.account.err.CREDIT_NOTHING_OWED"));
          return;
        }
      }
      setPayMethod(null);
      setPayReference("");
      setPayConfirmed(false);
      // R3: what the confirmation is about to show — the stored figures, read back after every flush above.
      // R5 (Abu Abbas F3): the COMPLETE draft the confirmation is about to show — every line, not only the totals.
      confirmedFigures.current = storedView ? confirmationDigest(storedView, issueOnAccount) : null;
      // R4: re-checked at the moment of opening — a dialog opened while the flushes above ran wins, this refuses.
      if (!openModal("confirm", () => setConfirming(true), issueButton, true)) return;
      setIssueRefusal(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * R5 (Abu Abbas F3 + R5 contract invariant 3): a confirmation describes ONE stable draft. If the stored draft changes
   * while it is open — a save accepted earlier landing late, anything — it is WITHDRAWN, not live-updated: a card that
   * quietly changes under the operator's eyes is not consent. They review the new figures and press «إصدار» again.
   */
  useEffect(() => {
    if (!confirming || !view || confirmedFigures.current === null) return;
    if (confirmationDigest(view, issueOnAccount) === confirmedFigures.current) return;
    confirmedFigures.current = null;
    closeModal("confirm", () => setConfirming(false));
    setError(t("inv.sheet.confirmWithdrawn"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeModal/t are stable in effect; the draft is the trigger
  }, [view, confirming, issueOnAccount]);

  /** INV-PAY-METHOD: is anything marked paid on the stored draft, and is its method complete? */
  const paidNow = (view?.invoice.paid.minor ?? "0") !== "0";
  const payReady =
    !paidNow || payMethod === "cash" || (payMethod === "whish" && payReference.trim() !== "" && payConfirmed);

  const finalize = async () => {
    if (!payReady) return;
    // R4 (action boundary): issue only from a confirmation that is the ONE open modal. Not a disabled button, a
    // z-index or the focus trap: a click dispatched on a covered or hidden control still arrives here, and stops.
    const modals = modalsRef.current.value;
    if (modals.length !== 1 || modals[0] !== "confirm") {
      setError(t("inv.sheet.modalOpen"));
      return;
    }
    // INV-LINE-EDIT-FAIL: never issue while an edit to an existing line is refused and unresolved.
    const lineRefusal = verifyLines();
    if (lineRefusal !== null) {
      setError(lineRefusal);
      return;
    }
    // R4: closed NOW in the ref too, so the pre-dispatch check below never sees this confirmation as still open.
    closeModal("confirm", () => setConfirming(false));
    // R5: and the issue now OWNS interaction until it answers — no dialog opens, the app shell is inert.
    operatingRef.current = true;
    setOperating(true);
    claimAppModal(appOwnerId);
    setBusy(true);
    setError(null);
    let issueRequestStarted = false;
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
      // v3 (Abu Abbas Finding A): the last check before the irreversible call, AFTER every flush — an edit made
      // while the flushes were in flight must stop the issue here, not be overtaken by it.
      const lateLineRefusal = verifyLines();
      if (lateLineRefusal !== null) {
        setError(lateLineRefusal);
        return;
      }
      // R2: and never issue over a paid amount on screen that differs from the stored one.
      const latePaidRefusal = verifyPaid();
      if (latePaidRefusal !== null) {
        setError(latePaidRefusal);
        return;
      }
      // R3: the issue is bound to what the confirmation SHOWED. After every flush, the freshly stored figures (paid,
      // totals, balance, customer, on-account choice) must be exactly the confirmed ones — or nothing is issued.
      const freshStored = viewRef.current;
      if (
        !freshStored ||
        confirmedFigures.current === null ||
        confirmationDigest(freshStored, issueOnAccount) !== confirmedFigures.current
      ) {
        setIssueRefusal(t("inv.sheet.confirmStale"));
        return;
      }
      // Never silently downgrade a checked on-account instruction to an ordinary unpaid invoice.
      // The service remains the authority and will refuse a missing/inactive account.
      const account = issueOnAccount;
      // INV-PAY-METHOD: only when something is marked paid; the service refuses a mismatch. Built ONCE
      // so a verified replay below repeats exactly the same payment (INV-PARTIAL-DEBT).
      const paymentPart =
        paidNow && payMethod === "cash"
          ? { payment: { method: "cash" as const } }
          : paidNow && payMethod === "whish"
            ? { payment: { method: "external" as const, whish: { reference: payReference, fundsConfirmed: payConfirmed } } }
            : {};
      let next: InvoiceViewDto;
      // R4: the background is live again while the flushes run; a dialog opened meanwhile stops the issue here.
      if (modalsRef.current.value.length > 0) {
        setError(t("inv.sheet.modalOpen"));
        return;
      }
      const confirmedDraft = confirmedFigures.current;
      // R3: from here until the answer, the paid amount is fixed text — nothing on screen can differ from what is sent.
      setIssuing(true);
      try {
        issueRequestStarted = true;
        next = await call(
          pos().finalizeInvoice({
            invoiceId,
            issueOnAccount: account,
            ...paymentPart,
            // R5: the service re-checks this exact confirmation against the persisted draft, inside its transaction.
            confirmedDraft,
          }),
        );
      } catch (e) {
        // 🔴 ON ACCOUNT, an unclear outcome is resolved by ASKING the ledger, never by guessing: the
        // same request again verifies the invoice, its sale and its receivable and writes nothing
        // if they already exist (and refuses plainly if they do not).
        const unclear =
          !(e instanceof ApiError) || e.code === "INVOICE_FINALIZED" || e.code === "INVOICE_STATUS_UNKNOWN" || e.code === "INTERNAL";
        if (!account || !unclear) throw e;
        try {
          next = await call(pos().finalizeInvoice({ invoiceId, issueOnAccount: true, ...paymentPart, confirmedDraft }));
        } catch (again) {
          if (again instanceof ApiError && (again.code.startsWith("CREDIT_") || again.code === "INVOICE_CONFIRMATION_REQUIRED" ||
            again.code === "INVOICE_CONFIRMATION_UNVERIFIABLE" || again.code === "INVOICE_TAX_CONFIRMATION_REQUIRED" || again.code === "IDEMPOTENCY_CONFLICT")) throw again;
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
      const uncertain = issueRequestStarted &&
        (!(e instanceof ApiError) || e.code === "INVOICE_STATUS_UNKNOWN" || e.code === "INTERNAL" || e.code === "INVOICE_FINALIZED");
      setIssueRefusal(uncertain ? t("inv.sheet.issueOutcomeUnknown") : accountErrorText(e));
      if (uncertain) {
        unknownIssueOutcomes.add(invoiceId);
        setIssueOutcomeUncertain(true);
      }
    } finally {
      operatingRef.current = false;
      setOperating(false);
      setIssuing(false);
      setBusy(false);
    }
  };

  const print = async () => {
    setLogoWarning(false);
    setLogoUnverified(false);
    try {
      const result = await call(pos().printInvoice({ invoiceId }));
      if (result.status === "unavailable") setError(t("inv.sheet.print") + " — " + t("inv.review.none"));
      // Reported on a cancelled print too: the document was rendered before the dialog opened, so
      // the archived logo was already found to be missing and the operator should know either way.
      else {
        if (result.logoMissing === true) setLogoWarning(true);
        if (result.logoUnverified === true) setLogoUnverified(true);
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  const savePdf = async () => {
    setLogoWarning(false);
    setLogoUnverified(false);
    try {
      const result = await call(pos().saveInvoicePdf({ invoiceId }));
      if (result.status === "saved" && result.logoMissing === true) setLogoWarning(true);
      if (result.status === "saved" && result.logoUnverified === true) setLogoUnverified(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const matches = useMemo(
    () => products.filter((p) => matchesSearch([p.nameAr, p.nameEn, p.sku], query)).slice(0, 20),
    [products, query],
  );

  if (!view) return <div className="center muted">{error ?? "…"}</div>;
  /** F2-5-R2: the newest action error, else the newest header refusal that is still unresolved. */
  const shownError = [issueRefusal, error ?? unresolvedFailure()].filter(Boolean).join(" ") || null;

  /** L-R2: does this line show any value that is not stored? */
  const lineHasUnsaved = (line: InvoiceLineDto): boolean => saveFailures.keysWithPrefix(`line:${line.id}:`).length > 0;
  /** L-R2: the rejected input keeps the merchant's value, is marked invalid and is described by its own note. */
  const unsavedInputProps = (line: InvoiceLineDto, field: LineInputField) =>
    saveFailures.has(lineKey(line.id, field))
      ? { "aria-invalid": true as const, "aria-describedby": `unsaved-${line.id}-${field}` }
      : {};
  /** L-R2: the local UNSAVED note — names the STORED value, and offers the explicit «تراجع». */
  const unsavedNote = (line: InvoiceLineDto, field: LineInputField | "unit" | "pick") =>
    !readOnly && saveFailures.has(lineKey(line.id, field)) ? (
      <span className="error small" id={`unsaved-${line.id}-${field}`} data-testid="line-unsaved" data-field={field} role="status">
        {t("inv.line.unsaved").replace("{saved}", storedText(line, field))}{" "}
        <button
          type="button"
          className="btn ghost small"
          onClick={() => act(() => revertLineField(line, field))}
          data-testid="line-revert"
        >
          {t("inv.line.revert")}
        </button>
      </span>
    ) : null;
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
      if (existing) void editLine(existing.id, { ...line, quantity: String(existing.quantityMilli / 1000) }, "pick", "picker");
    }
    setPickerFor(null);
    setQuery("");
  };

  return (
    <div className="inv-sheet" ref={sheetRef} inert={activeAppOwner !== null && activeAppOwner !== appOwnerId}>
      <header className="inv-sheet-head" inert={modalOpen}>
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
              disabled={readOnly || busy}
              ref={bind("invoiceDate")}
              onChange={(e) => void header({ invoiceDate: e.target.value === "" ? null : e.target.value })}
              data-testid="sheet-date"
            />
          </label>
        </div>
      </header>

      {readOnly && <p className="notice" data-testid="sheet-readonly">{t("inv.sheet.readOnly")}</p>}

      <section className="inv-customer" inert={modalOpen}>
        <label className="field">
          <span>{t("inv.sheet.customer")}</span>
          <input
            defaultValue={inv.customerName ?? ""}
            disabled={readOnly || busy}
            ref={bind("customerName")}
            onBlur={(e) => void header({ customerName: e.target.value.trim() === "" ? null : e.target.value })}
            data-testid="sheet-customer"
          />
        </label>
        <label className="field">
          <span>{t("inv.sheet.address")}</span>
          <input
            defaultValue={inv.customerAddress ?? ""}
            disabled={readOnly || busy}
            ref={bind("customerAddress")}
            onBlur={(e) => void header({ customerAddress: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t("inv.sheet.phone")}</span>
          <input
            dir="ltr"
            defaultValue={inv.customerPhone ?? ""}
            disabled={readOnly || busy}
            ref={bind("customerPhone")}
            onBlur={(e) => void header({ customerPhone: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </label>
        <label className="field wide">
          <span>{t("inv.sheet.notes")}</span>
          <input
            defaultValue={inv.notes ?? ""}
            disabled={readOnly || busy}
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
                  <button className="btn ghost small" disabled={busy} onClick={() => act(() => {
                    openModal("customer", () => setFindingCustomer(true), focusedControl(), true);
                  })} data-testid="account-change">
                    {t("inv.account.change")}
                  </button>
                  <button className="btn ghost small" disabled={busy} onClick={() => act(() => chooseAccount(null))} data-testid="account-unlink">
                    {t("inv.account.unlink")}
                  </button>
                </>
              )}
            </div>
          ) : (
            !readOnly && (
              <button className="btn ghost small" disabled={busy} onClick={() => act(() => {
                    openModal("customer", () => setFindingCustomer(true), focusedControl(), true);
                  })} data-testid="account-choose">
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
        <section className="inv-tax" data-testid="sheet-tax-controls" inert={modalOpen}>
          <label className="field inline">
            <input
              type="checkbox"
              checked={taxOn}
              disabled={busy}
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
                disabled={busy}
                ref={taxInput}
                onBlur={(e) => void applyTax(true, e.target.value)}
                data-testid="tax-rate"
              />
            </label>
          )}
          <span className="muted small">{t("inv.tax.hint")}</span>
        </section>
      )}

      <div className="inv-lines-scroll" inert={modalOpen}>
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
                  disabled={readOnly || busy}
                  onBlur={(e) =>
                    isTouched(l.id, "description") &&
                    editLine(l.id, {
                      description: e.target.value.trim() === "" ? null : e.target.value,
                      unitLabel: l.unitLabel,
                      canonicalUnit: l.canonicalUnit,
                      productId: l.productId,
                      quantity: String(l.quantityMilli / 1000),
                      unitPrice: storedPriceForWrite(l),
                    }, "description")
                  }
                  ref={bindLineInput(l.id, "description")}
                  onInput={touchLineInput(l.id, "description")}
                  {...unsavedInputProps(l, "description")}
                />
                {unsavedNote(l, "description")}
              </td>
              <td className="num">
                <input
                  dir="ltr"
                  inputMode="decimal"
                  defaultValue={l.quantityText}
                  disabled={readOnly || busy}
                  onBlur={(e) =>
                    isTouched(l.id, "quantity") &&
                    editLine(l.id, {
                      description: l.description,
                      unitLabel: l.unitLabel,
                      canonicalUnit: l.canonicalUnit,
                      productId: l.productId,
                      quantity: e.target.value,
                      unitPrice: storedPriceForWrite(l),
                    }, "quantity")
                  }
                  ref={bindLineInput(l.id, "quantity")}
                  onInput={touchLineInput(l.id, "quantity")}
                  {...unsavedInputProps(l, "quantity")}
                />
                {unsavedNote(l, "quantity")}
              </td>
              <td>
                {/* The SAME unit list the product form uses. A label this build cannot match —
                    "كيس (50PCS)" on a real invoice — renders as Other with the label prefilled and
                    is never rewritten, which is what makes an older draft reopen unharmed. */}
                <UnitCell
                  unitLabel={l.unitLabel}
                  canonicalUnit={l.canonicalUnit}
                  disabled={readOnly || busy}
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
                      unitPrice: storedPriceForWrite(l),
                    }, "unit");
                  }}
                />
                {unsavedNote(l, "unit")}
              </td>
              <td className="num">
                <input
                  dir="ltr"
                  inputMode="decimal"
                  defaultValue={priceText(l.unitPrice.minor, l.unitPrice.currency)}
                  disabled={readOnly || busy}
                  onBlur={(e) =>
                    isTouched(l.id, "unitPrice") &&
                    editLine(l.id, {
                      description: l.description,
                      unitLabel: l.unitLabel,
                      canonicalUnit: l.canonicalUnit,
                      productId: l.productId,
                      quantity: String(l.quantityMilli / 1000),
                      unitPrice: e.target.value,
                    }, "unitPrice")
                  }
                  ref={bindLineInput(l.id, "unitPrice")}
                  onInput={touchLineInput(l.id, "unitPrice")}
                  {...unsavedInputProps(l, "unitPrice")}
                />
                {unsavedNote(l, "unitPrice")}
              </td>
              {/* Read-only, and computed by the service — never by this component. */}
              <td className="num total" data-testid="sheet-line-total">
                <bdi
                  dir="ltr"
                  data-testid="line-total-value"
                  {...(lineHasUnsaved(l) ? { "aria-describedby": "totals-saved-only" } : {})}
                >
                  {fmt(l.lineTotal)}
                </bdi>
                {unsavedNote(l, "pick")}
              </td>
              <td className="row-actions">
                {!readOnly && (
                  <>
                    <button className="btn ghost small" onClick={() => openModal("picker", () => setPickerFor(l.id))}>
                      {t("inv.sheet.pick")}
                    </button>
                    <button className="btn ghost small" onClick={() => act(() => removeLine(l.id))}>
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
                    onClick={() => openModal("picker", () => setPickerFor(`draft:${r.key}`))}
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
                  <button className="btn primary" onClick={() => act(addRow)} disabled={busy} data-testid="add-row">
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
        <div className="inv-actions" inert={modalOpen}>
          <span className="muted small">{t("inv.sheet.pickHint")}</span>
        </div>
      )}

      <section className="inv-totals" inert={modalOpen}>
        {/* L-R2: while any line shows an unsaved value, the totals are the STORED values' — and say so. */}
        {view.lines.some(lineHasUnsaved) && (
          <p className="notice" role="note" id="totals-saved-only" data-testid="totals-saved-only">
            {t("inv.sheet.totalsSavedOnly")}
          </p>
        )}
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
                {readOnly || issuing ? (
                  <bdi dir="ltr" data-testid={issuing ? "sheet-paid-issuing" : undefined}>{fmt(inv.paid)}</bdi>
                ) : (
                  <input
                    dir="ltr"
                    inputMode="decimal"
                    defaultValue={inv.paid.minor === "0" ? "" : paidText(inv.paid.minor, inv.paid.currency)}
                    disabled={busy}
                    ref={bind("paid")}
                    onBlur={(e) => {
                      // CURRENCY-P1 / Finding C (R2): a blur writes the paid amount ONLY when the VISIBLE value differs
                      // from the stored one. An untouched field (its own exact rendering) is never rewritten.
                      const decision = paidDecision();
                      if (decision === "send") void header({ paid: e.target.value.trim() === "" ? null : e.target.value });
                      else markSaved(["paid"]);
                    }}
                    data-testid="sheet-paid"
                  />
                )}
              </td>
            </tr>
            {/* INV-PAY-METHOD: an issued invoice that recorded how it was paid says so; older ones say nothing new. */}
            {inv.payment && (
              <tr>
                <th>{t("inv.pay.method")}</th>
                <td data-testid="sheet-payment" data-method={inv.payment.method} data-provider={inv.payment.provider ?? "none"}>
                  {inv.payment.provider === "whish" ? t("method.whish") : t(`method.${inv.payment.method}`)}
                  {inv.payment.reference && (
                    <>
                      {" · "}
                      <bdi dir="ltr">{inv.payment.reference}</bdi>
                    </>
                  )}
                </td>
              </tr>
            )}
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
      <div className="inv-actions inv-keep" inert={modalOpen}>
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
        {(shownError || logoWarning || logoUnverified) && (
          <div className="inv-feedback" role="status" aria-live="polite" data-testid="sheet-feedback">
            {shownError && <p className="error" data-testid="sheet-error">{shownError}</p>}
            {logoWarning && (
              <p className="small" data-testid="sheet-logo-warning">
                <span className="badge warn">{t("tools.noticeTag")}</span> {t("inv.sheet.logoMissing")}
              </p>
            )}
            {logoUnverified && (
              <p className="small" data-testid="sheet-logo-unverified">
                <span className="badge warn">{t("tools.noticeTag")}</span> {t("inv.sheet.logoUnverified")}
              </p>
            )}
          </div>
        )}
        {!readOnly ? (
          <>
            <button
              className="btn primary"
              onClick={() => act(prepareFinalize, null, true)}
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
            <button className="btn" onClick={() => act(saveDraft)} disabled={busy} data-testid="save-draft">
              {t("inv.sheet.save")}
            </button>
            <button className="btn" onClick={() => act(leave)} disabled={busy} data-testid="leave-draft">
              {t("inv.sheet.leave")}
            </button>
            {saved && (
              <span className="muted small" data-testid="draft-saved">
                {t("inv.sheet.saved")}
              </span>
            )}
            {/* Destructive, separate, and confirmed. Navigating away is NOT this. */}
            <button className="btn danger ghost" onClick={() => openModal("discard", () => setDiscarding(true))} data-testid="discard">
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
        <button className="btn ghost" onClick={readOnly ? onClosed : () => act(leave)} data-testid="sheet-close">
          {t("action.cancel")}
        </button>
      </div>

      {/* Finalization is never implicit: the operator reads the figures and confirms. */}
      {confirming && (
        <div className="overlay" data-sheet-modal="confirm">
          <div className="card dialog" role="dialog" aria-modal="true" data-testid="finalize-confirm">
            <h2>{t("inv.sheet.confirmTitle")}</h2>
            <dl className="inv-confirm">
              <dt>{t("inv.sheet.customer")}</dt>
              <dd>{inv.customerName ?? "—"}</dd>
              {issueOnAccount && linkedId && (
                <>
                  <dt>{t("inv.account.confirmRow")}</dt>
                  <dd data-testid="confirm-account">
                    {/* The REMAINDER owed (INV-PARTIAL-DEBT); equal to the total when nothing is paid. */}
                    <bdi dir="auto">{linkedName ?? "—"}</bdi> — <bdi dir="ltr">{fmt(inv.balanceDue)}</bdi>
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
            {/* INV-PAY-METHOD: money marked paid must say how it arrived before the document is frozen. */}
            {paidNow && (
              <div className="inv-pay-method" data-testid="confirm-pay">
                <p className="small">
                  {t("inv.pay.question")} <bdi dir="ltr">{fmt(inv.paid)}</bdi>
                </p>
                <div className="methods">
                  <button
                    type="button"
                    className={payMethod === "cash" ? "btn primary" : "btn"}
                    aria-pressed={payMethod === "cash"}
                    onClick={() => setPayMethod("cash")}
                    data-testid="confirm-pay-cash"
                  >
                    {t("method.cash")}
                  </button>
                  <button
                    type="button"
                    className={payMethod === "whish" ? "btn primary" : "btn"}
                    aria-pressed={payMethod === "whish"}
                    onClick={() => setPayMethod("whish")}
                    data-testid="confirm-pay-whish"
                  >
                    {t("method.whish")}
                  </button>
                </div>
                {payMethod === "whish" && (
                  <>
                    <label className="field">
                      <span>{t("pay.whishReference")}</span>
                      <input
                        type="text"
                        dir="auto"
                        maxLength={64}
                        value={payReference}
                        onChange={(e) => setPayReference(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.preventDefault();
                        }}
                        data-testid="confirm-pay-reference"
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={payConfirmed}
                        onChange={(e) => setPayConfirmed(e.target.checked)}
                        data-testid="confirm-pay-confirmed"
                      />
                      <span>{t("pay.whishConfirm")}</span>
                    </label>
                  </>
                )}
                {!payReady && <p className="muted small" data-testid="confirm-pay-needed">{t("inv.pay.needed")}</p>}
              </div>
            )}
            <p className="muted small">{t("inv.sheet.confirmNote")}</p>
            <div className="inv-actions">
              <button className="btn primary" disabled={!payReady} onClick={() => act(finalize, "confirm")} data-testid="finalize-confirm-yes">
                {t("inv.sheet.finalize")}
              </button>
              <button className="btn ghost" onClick={() => setConfirming(false)} data-modal-initial data-testid="finalize-confirm-no">
                {t("action.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {exiting && (
        <div className="overlay" data-sheet-modal="exit">
          <div className="card dialog" role="dialog" aria-modal="true" data-testid="exit-confirm">
            <h2>{t("inv.exit.title")}</h2>
            <p className="muted small">{t("inv.exit.body")}</p>
            {error && <p className="error" data-testid="exit-error">{error}</p>}
            <div className="inv-actions">
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => act(saveAndLeave, "exit")}
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
              <button className="btn" disabled={busy} onClick={() => setExiting(false)} data-modal-initial data-testid="exit-cancel">
                {t("action.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {discarding && (
        <div className="overlay" data-sheet-modal="discard">
          <div className="card dialog" role="dialog" aria-modal="true" data-testid="discard-confirm">
            <h2>{t("inv.sheet.discardTitle")}</h2>
            <p className="muted">{t("inv.sheet.discardConfirm")}</p>
            <div className="inv-actions">
              <button className="btn danger" onClick={() => act(discard, "discard")} data-testid="discard-confirm-yes">
                {t("inv.sheet.discardYes")}
              </button>
              <button className="btn ghost" onClick={() => setDiscarding(false)} data-modal-initial data-testid="discard-confirm-no">
                {t("inv.sheet.discardKeep")}
              </button>
            </div>
          </div>
        </div>
      )}

      {findingCustomer && (
        <CustomerFinder
          onClose={() => closeModal("customer", () => setFindingCustomer(false))}
          onPick={(c) => {
            closeModal("customer", () => setFindingCustomer(false));
            act(() => chooseAccount(c));
          }}
        />
      )}

      {finalized && (
        <div className="overlay" data-sheet-modal="finalized">
          <div className="card dialog" role="dialog" aria-modal="true" data-testid="finalized-notice">
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
        <div className="overlay" data-sheet-modal="picker">
          <div className="card dialog" role="dialog" aria-modal="true" data-testid="product-picker">
            <h2>{t("inv.sheet.pick")}</h2>
            <input
              autoFocus
              data-modal-initial
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
            <button className="btn ghost wide" onClick={() => setPickerFor(null)} data-testid="picker-cancel">
              {t("action.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Minor units back to the decimal string the service will re-parse. Two decimals, no float math. */
/**
 * v3 (Abu Abbas Finding B): the STORED unit price, written exactly, for the fields a whole-line write carries over.
 *
 * 🔴 NOT `priceText`. Every existing-line write sends the whole line; the fields the merchant did not edit used to
 * be rebuilt from `priceText`, which always renders two decimals. For a 3-decimal currency that is a different
 * amount: a description edit on a 0.100 JOD line sent «1.00» and stored 1.000 — ten times the price, silently.
 * `formatDecimal` renders the stored minor units at the currency's own exponent, so the carried value is the stored
 * value («1.00» for USD, unchanged; «0.100» for JOD). The DISPLAY is untouched (S-3, an owner decision).
 */
function storedPriceForWrite(line: InvoiceLineDto): string {
  return formatDecimal(money(BigInt(line.unitPrice.minor), line.unitPrice.currency));
}

/** Exactly the `defaultValue` each existing-line input is rendered with — what «تراجع» puts back. */
function defaultLineText(line: InvoiceLineDto, field: "description" | "quantity" | "unitPrice"): string {
  if (field === "description") return line.description ?? "";
  if (field === "quantity") return line.quantityText;
  return priceText(line.unitPrice.minor, line.unitPrice.currency);
}

/** L-R2: a stored line value as the merchant would type it — what «تراجع» restores and the note names. */
function storedText(line: InvoiceLineDto, field: LineInputField | "unit" | "pick"): string {
  if (field === "description" || field === "pick") return line.description ?? "—";
  if (field === "quantity") return line.quantityText;
  if (field === "unit") return line.unitLabel ?? "—";
  return priceText(line.unitPrice.minor, line.unitPrice.currency);
}

/**
 * CURRENCY-P1: stored minor units rendered at the CURRENCY'S OWN exponent (`formatDecimal`), never a fixed two decimals.
 *
 * 🔴 THE OLD BODY PADDED TO TWO DECIMALS FOR EVERY CURRENCY. For USD and LBP (exponent 2, `money.ts`) the output is
 * byte-identical to before; for a 3-decimal currency it rendered minor 100 (0.100) as «1.00», and every path that
 * wrote the rendering back (Finding C: the paid field; v3 Finding B: line prices) stored ten times the amount. The
 * rendering is now the stored value exactly, so writing it back can no longer change it. An unknown currency throws
 * (`UNKNOWN_CURRENCY`) instead of being shown as a guessed amount.
 */
function priceText(minor: string, currency: string): string {
  return formatDecimal(money(BigInt(minor), currency));
}
const paidText = priceText;
