/**
 * The renderer-facing edge of migration 16: what a payload may carry, and that the owner-only gate
 * holds when reached through the channel rather than the service. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;
const ok = <T>(r: { ok: boolean; data?: unknown; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const errCode = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error!.code);

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
  ipc = syncHandlers(createIpcHandlers(h.service, { invoices: h.invoices }));
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const prepared = () => {
  const c = h.parties.create({ kind: "customer", displayName: "زبون" }).party;
  const { invoice } = h.invoices.createDraft();
  h.invoices.addLines(invoice.id, [{ description: "صنف", unitLabel: "حبة", canonicalUnit: null, productId: null, quantity: "1", unitPrice: "12.00" }], "batch-ipc-000001");
  return { c, id: invoice.id };
};

describe("linking through the channel", () => {
  it("the header patch carries the chosen account id and returns it on the DTO", () => {
    const { c, id } = prepared();
    const view = ok<{ invoice: { customerPartyId: string | null } }>(
      ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPartyId: c.id } }),
    );
    expect(view.invoice.customerPartyId).toBe(c.id);
    const cleared = ok<{ invoice: { customerPartyId: string | null } }>(
      ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPartyId: null } }),
    );
    expect(cleared.invoice.customerPartyId).toBeNull();
  });

  it("a name is not an account: an unknown id is refused, not matched", () => {
    const { id } = prepared();
    expect(errCode(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPartyId: "زبون" } }))).toBe("PARTY_NOT_FOUND");
  });
});

describe("issue-on-account through the channel", () => {
  it("must be a real boolean when present, and may be absent for the ordinary path", () => {
    const { c, id } = prepared();
    ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPartyId: c.id } });
    expect(errCode(ipc.finalizeInvoice({ invoiceId: id, issueOnAccount: "yes" }))).toBe("INVALID_INPUT");
    expect(errCode(ipc.finalizeInvoice({ invoiceId: id, issueOnAccount: 1 }))).toBe("INVALID_INPUT");
    expect(errCode(ipc.finalizeInvoice({ invoiceId: id, extra: true }))).toBe("INVALID_INPUT");
    // Absent == ordinary: finalizes with NO debt even though a customer is linked.
    ok(ipc.finalizeInvoice({ invoiceId: id }));
    expect(Number((h.db.prepare("SELECT count(*) AS n FROM obligations").get() as { n: bigint }).n)).toBe(0);
  });

  it("owner issues on account; the cashier is refused with its own code and nothing changes", () => {
    const { c, id } = prepared();
    ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPartyId: c.id } });
    h.service.login("cashier-02", "2222");
    expect(errCode(ipc.finalizeInvoice({ invoiceId: id, issueOnAccount: true }))).toBe("CREDIT_OWNER_ONLY");
    expect(ok<{ invoice: { status: string } }>(ipc.getInvoice({ invoiceId: id })).invoice.status).toBe("draft");
    h.service.login("cashier-01", "1111");
    ok(ipc.finalizeInvoice({ invoiceId: id, issueOnAccount: true }));
    expect(Number((h.db.prepare("SELECT count(*) AS n FROM obligations").get() as { n: bigint }).n)).toBe(1);
    // The lost-response repeat answers from the ledger and writes nothing.
    ok(ipc.finalizeInvoice({ invoiceId: id, issueOnAccount: true }));
    expect(Number((h.db.prepare("SELECT count(*) AS n FROM sales").get() as { n: bigint }).n)).toBe(1);
    expect(Number((h.db.prepare("SELECT count(*) AS n FROM obligations").get() as { n: bigint }).n)).toBe(1);
  });
});
