/**
 * Issuing an invoice that goes wrong: what the cashier is told, decided by READING the ledger.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THESE PROVE THAT THE PURE TESTS CANNOT. `invoiceOutcomeText.test.ts` proves the sentences
 * are right. These prove the right sentence is CHOSEN, through the real channel, from the real
 * database — and that the diagnosis itself writes nothing and duplicates nothing.
 *
 * 🔴 THE THREE FAULTS ARE REAL, NOT MOCKED OUTCOMES. Each one is injected at a seam that already
 * existed for dependency injection, and the classification then runs against whatever the ledger
 * actually holds afterwards:
 *
 *   PRE-COMMIT   `repository.commitSale` throws — step 10 of `finalizeInvoice`, INSIDE its single
 *                transaction. SQLite rolls the whole thing back.
 *   POST-COMMIT  `options.logger.info` throws — `ipcHandlers.ts` logs AFTER
 *                `invoices().finalizeInvoice(...)` has returned, so the transaction is already
 *                committed. This is the exact window the defect lived in.
 *   UNKNOWN      the post-commit fault happens AND `saleForInvoice` throws, so the classifier
 *                cannot establish what the ledger holds.
 *
 * No production fault-injection hook exists or was added: all three use `makeHarness`'s own objects
 * and `createIpcHandlers`'s own `logger` option.
 *
 * 🔴 COVERAGE LIMIT, STATED RATHER THAN PAPERED OVER. A failure of the COMMIT STATEMENT ITSELF
 * (SQLITE_FULL / SQLITE_IOERR at commit time) is not simulated here — better-sqlite3 offers no seam
 * to fail a commit without faking the database. Such a failure rolls back, so it lands in the
 * PRE-COMMIT class, and the classifier reads the ledger rather than the exception, which is exactly
 * why that gap does not change the answer. It is a missing test, not a missing behaviour.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { type Harness, type TempDir, countRows, makeHarness, tempDir } from "../helpers/harness";
import type { TerminalSettings } from "../../src/shared/i18n";
import type { Logger } from "../../src/main/logger";

let t: TempDir;
let h: Harness;

const PROFILE = {
  nameAr: "متجر اختباري",
  nameEn: "Test Store",
  legalName: null,
  tagline: null,
  address: "شارع الاختبار",
  phone1: "0000000",
  phone2: null,
  email: null,
  logoPath: null,
  taxpayerNumber: "TP-1",
  commercialRegister: "CR-2",
  vatNumber: "VAT-3",
  taxEnabled: false,
  taxRatePercent: null,
  taxLabel: null,
};

const LINE = {
  description: "صنف اختباري",
  unitLabel: "حبة",
  canonicalUnit: null,
  productId: null,
  quantity: "1",
  unitPrice: "474.40",
};

const settingsFor = (lang: "ar" | "en") => ({
  get: (): TerminalSettings => ({ terminalLanguage: lang, receiptLanguage: lang }),
  setTerminalLanguage: (): TerminalSettings => ({ terminalLanguage: lang, receiptLanguage: lang }),
});

/**
 * A logger that throws on exactly ONE event — the real post-commit seam.
 *
 * 🔴 IT MUST BE THIS NARROW. A logger that throws on every `info` breaks the setup calls
 * (`saveCompanyProfile`, `createInvoiceDraft`, `addInvoiceLine` all log), so the test would never
 * reach a finalize at all — the first version of this helper did exactly that and failed loudly,
 * which is how the seam got pinned down. `ipcHandlers.ts` logs `"invoice-finalized"` AFTER
 * `invoices().finalizeInvoice(...)` has returned, so throwing on that one event lands the fault
 * precisely in the committed-but-not-yet-answered window this slice exists for.
 */
const throwingLogger = (): Logger => ({
  info: (event: string) => {
    if (event === "invoice-finalized") throw new Error("log sink exploded after the commit");
  },
  warn: () => undefined,
  error: () => undefined,
  file: null,
});

const quietLogger = (): Logger => ({ info: () => undefined, warn: () => undefined, error: () => undefined, file: null });

function handlers(lang: "ar" | "en", logger: Logger) {
  return syncHandlers(createIpcHandlers(h.service, { invoices: h.invoices, settings: settingsFor(lang), logger }));
}

const ok = <T>(r: { ok: boolean; data?: unknown; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const err = (r: { ok: boolean; error?: { code: string; message: string } }) => {
  if (r.ok) throw new Error("expected a failure");
  return r.error!;
};

/** A draft with one line, ready to be issued. */
function draftReadyToIssue(ipc: ReturnType<typeof syncHandlers>): string {
  ok(ipc.saveCompanyProfile(PROFILE));
  const view = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined));
  ok(ipc.addInvoiceLine({ invoiceId: view.invoice.id, line: LINE }));
  return view.invoice.id;
}

const statusOf = (id: string) => h.invoiceStore.findById(id)?.status ?? null;

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

describe("an unexpected error while issuing an invoice", () => {
  // ── A · definitely NOT committed ────────────────────────────────────────────────────────────
  it("🔴 PRE-COMMIT: the transaction rolls back, and the cashier is told it is still a draft", () => {
    const ipc = handlers("ar", quietLogger());
    const id = draftReadyToIssue(ipc);

    const commitSale = h.repository.commitSale.bind(h.repository);
    h.repository.commitSale = () => {
      throw new Error("disk exploded inside the transaction");
    };
    const e = err(ipc.finalizeInvoice({ invoiceId: id }));
    h.repository.commitSale = commitSale;

    expect(e.code).toBe("INVOICE_NOT_FINALIZED");
    expect(e.message).toContain("لم تُصدَر الفاتورة");
    expect(e.message).toContain("ما تزال مسوّدة");
    expect(e.message).toContain("يمكنك إعادة المحاولة");

    // And the claim is TRUE, measured against the database rather than asserted.
    expect(statusOf(id)).toBe("draft");
    expect(h.invoices.saleForInvoice(id)).toBeUndefined();
    expect(countRows(h.db).sales).toBe(0);
    expect(h.invoices.invoiceNumberOf(id)).toBeUndefined();
  });

  it("the same fault in English reads the English sentence", () => {
    const ipc = handlers("en", quietLogger());
    const id = draftReadyToIssue(ipc);
    const commitSale = h.repository.commitSale.bind(h.repository);
    h.repository.commitSale = () => {
      throw new Error("disk exploded inside the transaction");
    };
    const e = err(ipc.finalizeInvoice({ invoiceId: id }));
    h.repository.commitSale = commitSale;
    expect(e.message).toBe("Unexpected error — the invoice was not issued and is still a draft. You can try again.");
  });

  it("🔴 …and the retry it invites really does work, issuing exactly ONE invoice and ONE sale", () => {
    const ipc = handlers("ar", quietLogger());
    const id = draftReadyToIssue(ipc);
    const commitSale = h.repository.commitSale.bind(h.repository);
    h.repository.commitSale = () => {
      throw new Error("disk exploded inside the transaction");
    };
    err(ipc.finalizeInvoice({ invoiceId: id }));
    h.repository.commitSale = commitSale;

    ok(ipc.finalizeInvoice({ invoiceId: id }));
    expect(statusOf(id)).toBe("final");
    expect(countRows(h.db).sales).toBe(1);
    const sale = h.invoices.saleForInvoice(id);
    expect(sale?.receiptNumber).toBe(1);
    // 🔴 The number the rolled-back attempt allocated was RETURNED, not burned.
    expect(h.invoices.invoiceNumberOf(id)).toBe(1);
  });

  // ── B · definitely committed ───────────────────────────────────────────────────────────────
  it("🔴 POST-COMMIT: the invoice IS issued, and the cashier is told so with the real numbers", () => {
    const ipc = handlers("ar", throwingLogger());
    const id = draftReadyToIssue(ipc);

    const e = err(ipc.finalizeInvoice({ invoiceId: id }));

    expect(e.code).toBe("INVOICE_FINALIZED");
    // The real identity, off real rows.
    expect(e.message).toContain("الفاتورة رقم 1");
    expect(e.message).toContain("إيصال رقم 1");
    // 🔴 THE DEFECT THIS SLICE CLOSES: it must NOT invite another attempt.
    expect(e.message).toContain("لا تُصدرها مرّة أخرى");
    expect(e.message).not.toContain("يمكنك إعادة المحاولة");
    expect(e.message).not.toContain("حاول مرّة أخرى");
    // It sends them to the invoice list, not to sales History.
    expect(e.message).toContain("قائمة الفواتير");

    // The claim is true: the document exists, numbered, with exactly one sale behind it.
    expect(statusOf(id)).toBe("final");
    expect(h.invoices.invoiceNumberOf(id)).toBe(1);
    expect(countRows(h.db).sales).toBe(1);
  });

  it("the same post-commit fault in English names the invoice and the receipt", () => {
    const ipc = handlers("en", throwingLogger());
    const id = draftReadyToIssue(ipc);
    const e = err(ipc.finalizeInvoice({ invoiceId: id }));
    expect(e.message).toBe(
      "Invoice #1 WAS issued (receipt #1) but an unexpected error followed. Check the invoice list — do not issue it again.",
    );
    expect(e.message).not.toMatch(/try again/i);
  });

  it("🔴 the diagnosis is READ-ONLY — it does not issue a second invoice or a second sale", () => {
    const ipc = handlers("ar", throwingLogger());
    const id = draftReadyToIssue(ipc);
    err(ipc.finalizeInvoice({ invoiceId: id }));

    const before = countRows(h.db);
    const saleBefore = h.invoices.saleForInvoice(id);
    // Hitting the same failing channel again changes nothing durable: the invoice is no longer a
    // draft, so the service refuses it as a business error before any write.
    const again = err(ipc.finalizeInvoice({ invoiceId: id }));
    expect(again.code).not.toBe("INVOICE_FINALIZED");

    expect(countRows(h.db)).toEqual(before);
    expect(h.invoices.saleForInvoice(id)?.id).toBe(saleBefore?.id);
    expect(h.invoices.saleForInvoice(id)?.receiptNumber).toBe(saleBefore?.receiptNumber);
    expect(h.invoices.invoiceNumberOf(id)).toBe(1);
  });

  // ── C · status cannot be established ───────────────────────────────────────────────────────
  it("🔴 UNKNOWN: when the lookup itself fails, it says so — and never claims nothing happened", () => {
    const ipc = handlers("ar", throwingLogger());
    const id = draftReadyToIssue(ipc);

    const saleForInvoice = h.invoices.saleForInvoice.bind(h.invoices);
    h.invoices.saleForInvoice = () => {
      throw new Error("the ledger read exploded too");
    };
    const e = err(ipc.finalizeInvoice({ invoiceId: id }));
    h.invoices.saleForInvoice = saleForInvoice;

    expect(e.code).toBe("INVOICE_STATUS_UNKNOWN");
    expect(e.message).toContain("لا نعرف");
    expect(e.message).toContain("قائمة الفواتير");
    // 🔴 Neither of the two false claims is made.
    expect(e.message).not.toContain("لم تُصدَر الفاتورة");
    expect(e.message).not.toContain("يمكنك إعادة المحاولة");
    // And no number is invented for an outcome we could not read.
    expect(e.message).not.toMatch(/[0-9]/);
  });

  it("the unknown outcome in English is uncertain, not negative", () => {
    const ipc = handlers("en", throwingLogger());
    const id = draftReadyToIssue(ipc);
    const saleForInvoice = h.invoices.saleForInvoice.bind(h.invoices);
    h.invoices.saleForInvoice = () => {
      throw new Error("the ledger read exploded too");
    };
    const e = err(ipc.finalizeInvoice({ invoiceId: id }));
    h.invoices.saleForInvoice = saleForInvoice;
    expect(e.message).toBe(
      "Unexpected error — it is not known whether the invoice was issued. Check the invoice list before trying again.",
    );
  });

  // ── Existing behaviour, unchanged ──────────────────────────────────────────────────────────
  it("an ALREADY-FINALIZED invoice is still refused as a business error, not as an outcome", () => {
    const ipc = handlers("ar", quietLogger());
    const id = draftReadyToIssue(ipc);
    ok(ipc.finalizeInvoice({ invoiceId: id }));

    const e = err(ipc.finalizeInvoice({ invoiceId: id }));
    // A DomainError, with its own code — it never reaches the outcome classifier.
    expect(e.code).not.toBe("INVOICE_FINALIZED");
    expect(e.code).not.toBe("INVOICE_NOT_FINALIZED");
    expect(e.code).not.toBe("INVOICE_STATUS_UNKNOWN");
    expect(countRows(h.db).sales).toBe(1);
  });

  it("an unknown invoice id is still INVOICE_NOT_FOUND, and a malformed payload still INVALID_INPUT", () => {
    const ipc = handlers("ar", quietLogger());
    draftReadyToIssue(ipc);
    expect(err(ipc.finalizeInvoice({ invoiceId: "no-such-invoice" })).code).toBe("INVOICE_NOT_FOUND");
    expect(err(ipc.finalizeInvoice({ invoiceId: 7 })).code).toBe("INVALID_INPUT");
    expect(err(ipc.finalizeInvoice({})).code).toBe("INVALID_INPUT");
    expect(countRows(h.db).sales).toBe(0);
  });

  it("a terminal with no invoice service still answers NOT_AVAILABLE, not an outcome", () => {
    const bare = syncHandlers(createIpcHandlers(h.service, { settings: settingsFor("ar") }));
    expect(err(bare.finalizeInvoice({ invoiceId: "x" })).code).toBe("NOT_AVAILABLE");
  });

  it("🔴 a successful issue is untouched — no error, and the sale is there once", () => {
    const ipc = handlers("ar", quietLogger());
    const id = draftReadyToIssue(ipc);
    const view = ok<{ invoice: { invoiceNumber: number | null; status: string } }>(ipc.finalizeInvoice({ invoiceId: id }));
    expect(view.invoice.status).toBe("final");
    expect(view.invoice.invoiceNumber).toBe(1);
    expect(countRows(h.db).sales).toBe(1);
    expect(h.invoices.saleForInvoice(id)?.receiptNumber).toBe(1);
  });
});
