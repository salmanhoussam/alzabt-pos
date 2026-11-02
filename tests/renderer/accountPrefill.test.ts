/**
 * INV-CUSTOMER-PREFILL (slice ACC-1): what linking a customer account to a draft invoice writes
 * into the printed customer fields — the pure decision, and the same patch through the REAL IPC
 * handler and service against a real SQLite ledger. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CUSTOMER_FIELD, MAX_NOTES } from "../../src/domain/invoice";
import { MAX_PARTY_ADDRESS, MAX_PARTY_NAME, MAX_PARTY_PHONE } from "../../src/domain/party";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { accountPrefill } from "../../src/renderer/screens/invoices/accountPrefill";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

const ACCOUNT = { displayName: "زبون الحساب", phone: "96170123456", address: "بيروت، شارع الحمرا" };
const EMPTY = { customerName: "", customerPhone: "", customerAddress: "" };

describe("which printed fields the account fills", () => {
  it("🔴 every EMPTY field is filled from the account — name, phone AND address", () => {
    expect(accountPrefill(ACCOUNT, EMPTY)).toEqual({
      customerName: "زبون الحساب",
      customerPhone: "96170123456",
      customerAddress: "بيروت، شارع الحمرا",
    });
  });

  it("🔴 a field the operator TYPED is never replaced — even if it was not blurred yet", () => {
    expect(accountPrefill(ACCOUNT, { ...EMPTY, customerPhone: "03 111 222" })).toEqual({
      customerName: "زبون الحساب",
      customerAddress: "بيروت، شارع الحمرا",
    });
    expect(accountPrefill(ACCOUNT, { customerName: "اسم مطبوع", customerPhone: "1", customerAddress: "x" })).toEqual({});
  });

  it("whitespace counts as empty", () => {
    expect(accountPrefill(ACCOUNT, { customerName: "  ", customerPhone: "\t", customerAddress: " " })).toEqual({
      customerName: "زبون الحساب",
      customerPhone: "96170123456",
      customerAddress: "بيروت، شارع الحمرا",
    });
  });

  it("🔴 an account with no phone or address sends NO key for them — the row keeps what it has", () => {
    const fill = accountPrefill({ displayName: "بلا تفاصيل", phone: null, address: "  " }, EMPTY);
    expect(fill).toEqual({ customerName: "بلا تفاصيل" });
    expect("customerPhone" in fill).toBe(false);
    expect("customerAddress" in fill).toBe(false);
  });

  it("a field that is not rendered is never filled (nothing is known about what it holds)", () => {
    expect(accountPrefill(ACCOUNT, { customerName: undefined, customerPhone: "", customerAddress: undefined })).toEqual({
      customerPhone: "96170123456",
    });
  });

  it("🔴 an account's longest name, phone and address always fit the invoice's own limits", () => {
    // Otherwise a long account would make the whole link write fail validation.
    expect(MAX_PARTY_NAME).toBeLessThanOrEqual(MAX_CUSTOMER_FIELD);
    expect(MAX_PARTY_PHONE).toBeLessThanOrEqual(MAX_CUSTOMER_FIELD);
    expect(MAX_PARTY_ADDRESS).toBeLessThanOrEqual(MAX_NOTES);
  });
});

describe("the sheet sends the fill WITH the link (source check — there is no DOM harness)", () => {
  const sheet = readFileSync("src/renderer/screens/invoices/InvoiceSheet.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("🔴 one updateInvoiceHeader call carries customerPartyId AND the prefilled keys", () => {
    expect(sheet).toContain("patch: { customerPartyId: account?.id ?? null, ...fill }");
    expect(sheet).toContain("accountPrefill(account, {");
  });

  it("the old input-only name prefill is gone (it reached the row only on a later blur or save)", () => {
    expect(sheet).not.toMatch(/nameInput\.value = displayName/);
  });
});

describe("through the real IPC handler and service", () => {
  let t: TempDir;
  let h: Harness;
  let ipc: ReturnType<typeof syncHandlers>;
  type View = {
    invoice: {
      status: string;
      customerPartyId: string | null;
      customerName: string | null;
      customerPhone: string | null;
      customerAddress: string | null;
    };
  };
  const ok = <T>(r: { ok: boolean; data?: unknown; error?: unknown }): T => {
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
    return r.data as T;
  };
  const errCode = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error!.code);
  const count = (sql: string) => Number((h.db.prepare(sql).get() as { n: bigint }).n);
  const row = (id: string) =>
    h.db.prepare("SELECT customer_party_id, customer_name, customer_phone, customer_address FROM invoices WHERE id = ?").get(id) as {
      customer_party_id: string | null;
      customer_name: string | null;
      customer_phone: string | null;
      customer_address: string | null;
    };

  beforeEach(() => {
    t = tempDir();
    h = makeHarness(t.dbPath);
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
    ipc = syncHandlers(createIpcHandlers(h.service, { invoices: h.invoices, parties: h.parties }));
  });
  afterEach(() => {
    h.db.close();
    t.cleanup();
  });

  /** The account exactly as the sheet receives it: the CustomerDto from the real channel. */
  const newAccount = () => {
    const id = h.parties.create({ kind: "customer", displayName: ACCOUNT.displayName, phone: ACCOUNT.phone, address: ACCOUNT.address }).party.id;
    return ok<{ id: string; displayName: string; phone: string | null; address: string | null }>(ipc.getCustomer({ customerId: id }));
  };

  const draftWithLine = () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(
      invoice.id,
      [{ description: "صنف", unitLabel: "حبة", canonicalUnit: null, productId: null, quantity: "1", unitPrice: "12.00" }],
      "batch-acct1-000001",
    );
    return invoice.id;
  };

  it("🔴 the link and the three contact fields are STORED by the one write — no blur, no save needed", () => {
    const c = newAccount();
    const id = draftWithLine();
    const fill = accountPrefill(c, EMPTY);
    const view = ok<View>(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPartyId: c.id, ...fill } }));
    expect(view.invoice).toMatchObject({
      customerPartyId: c.id,
      customerName: ACCOUNT.displayName,
      customerPhone: ACCOUNT.phone,
      customerAddress: ACCOUNT.address,
    });
    expect(row(id)).toEqual({
      customer_party_id: c.id,
      customer_name: ACCOUNT.displayName,
      customer_phone: ACCOUNT.phone,
      customer_address: ACCOUNT.address,
    });
    // 🔴 Linking and filling is not a debt.
    expect(count("SELECT count(*) AS n FROM obligations")).toBe(0);
    expect(count("SELECT count(*) AS n FROM sales")).toBe(0);
  });

  it("🔴 a stored value the operator typed earlier is kept when only empty fields are sent", () => {
    const c = newAccount();
    const id = draftWithLine();
    ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPhone: "03111222" } }));
    const fill = accountPrefill(c, { ...EMPTY, customerPhone: "03111222" });
    ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPartyId: c.id, ...fill } }));
    expect(row(id).customer_phone).toBe("03111222");
    expect(row(id).customer_address).toBe(ACCOUNT.address);
  });

  it("🔴 an ISSUED invoice refuses the link-and-fill write and keeps every field as issued", () => {
    const c = newAccount();
    const id = draftWithLine();
    ok(ipc.finalizeInvoice({ invoiceId: id }));
    const before = row(id);
    const fill = accountPrefill(c, EMPTY);
    expect(errCode(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPartyId: c.id, ...fill } }))).toBe("INVOICE_NOT_DRAFT");
    expect(row(id)).toEqual(before);
  });

  it("an archived account is refused, and the fields sent with it are NOT written either (one write)", () => {
    const c = newAccount();
    h.parties.setActive("customer", c.id, false);
    const id = draftWithLine();
    const r = ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPartyId: c.id, ...accountPrefill(c, EMPTY) } });
    expect(errCode(r)).not.toBeNull();
    expect(row(id)).toEqual({ customer_party_id: null, customer_name: null, customer_phone: null, customer_address: null });
  });
});
