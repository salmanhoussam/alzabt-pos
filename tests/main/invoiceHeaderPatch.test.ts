/**
 * Header persistence — the defect that lost a customer phone on a real commercial invoice.
 *
 * 🔴 WHAT ACTUALLY WENT WRONG, so this file cannot drift from it: `InvoiceSheet`'s `header()`
 * helper took a one-key patch and expanded it into a FULL header overwrite, filling the untouched
 * fields from `view.invoice` — a React state snapshot. When two fields were blurred before the
 * first response landed, the second request carried the first field's STALE value and silently
 * overwrote what had just been saved. Main gate run 37929929423 reported it as
 * `and the phone (got null)` after six green runs.
 *
 * The contract now carries a PATCH, so the tests below are written against the thing that failed:
 * interleaved writes, each naming only its own field, must not be able to clobber a sibling.
 *
 * These go through the REAL IPC handlers on a REAL ledger, because the boundary is where the bug
 * lived — the service's partial-update logic was correct all along and unreachable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INVOICE_HEADER_PATCH_KEYS } from "../../src/shared/ipcContract";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";

let t: TempDir;
let h: Harness;
let ipc: ReturnType<typeof syncHandlers>;

/** Unwraps the result envelope, failing loudly with the service's own message. */
function ok<T>(result: unknown): T {
  const r = result as { ok: boolean; data?: T; error?: { code: string; message: string } };
  if (!r.ok) throw new Error(`IPC refused: ${r.error?.code} ${r.error?.message}`);
  return r.data as T;
}

const LINE = {
  description: "صنف اختباري",
  unitLabel: "حبة",
  canonicalUnit: null,
  productId: null,
  quantity: "1",
  unitPrice: "10.00",
};

interface HeaderShape {
  invoice: {
    id: string;
    invoiceDate: string | null;
    customerName: string | null;
    customerAddress: string | null;
    customerPhone: string | null;
    notes: string | null;
    paid: { minor: string };
  };
}

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  ipc = syncHandlers(createIpcHandlers(h.service, { invoices: h.invoices }));
  h.service.login("cashier-01", "1111");
  ok(ipc.saveCompanyProfile({
    nameAr: "متجر اختباري",
    nameEn: null,
    legalName: null,
    tagline: null,
    address: null,
    phone1: null,
    phone2: null,
    email: null,
    logoPath: null,
    taxpayerNumber: null,
    commercialRegister: null,
    vatNumber: null,
    taxEnabled: false,
    taxRatePercent: null,
    taxLabel: null,
  }));
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

function draft(): string {
  const created = ok<{ invoice: { id: string } }>(ipc.createInvoiceDraft(undefined));
  ok(ipc.addInvoiceLine({ invoiceId: created.invoice.id, line: LINE }));
  return created.invoice.id;
}

const headerOf = (id: string) => ok<HeaderShape>(ipc.getInvoice({ invoiceId: id })).invoice;

describe("a header patch writes only what it names", () => {
  it("🔴 THE EXACT SEQUENCE THAT FAILED: name, then phone, then date — nothing is lost", () => {
    const id = draft();
    // Three separate one-key writes, in the order the E2E types them. Under the old contract the
    // third call carried a stale `customerPhone: null` and erased the second.
    ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerName: "زبون اختباري" } }));
    ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPhone: "70-000000" } }));
    ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: { invoiceDate: "2026-10-08" } }));

    const after = headerOf(id);
    expect(after.customerName).toBe("زبون اختباري");
    expect(after.customerPhone).toBe("70-000000");
    expect(after.invoiceDate).toBe("2026-10-08");
  });

  it("every single-field write leaves all five siblings exactly as they were", () => {
    const id = draft();
    // Fill everything once, so each later write has something real to destroy.
    ok(ipc.updateInvoiceHeader({
      invoiceId: id,
      patch: {
        invoiceDate: "2026-10-01",
        customerName: "الاسم",
        customerAddress: "العنوان",
        customerPhone: "70-111111",
        notes: "ملاحظة",
        paid: "2.00",
      },
    }));
    const full = headerOf(id);

    const fresh: Record<string, string> = {
      invoiceDate: "2026-10-09",
      customerName: "اسم آخر",
      customerAddress: "عنوان آخر",
      customerPhone: "70-222222",
      notes: "ملاحظة أخرى",
      paid: "3.00",
    };
    for (const key of INVOICE_HEADER_PATCH_KEYS) {
      const id2 = draft();
      ok(ipc.updateInvoiceHeader({
        invoiceId: id2,
        patch: {
          invoiceDate: full.invoiceDate,
          customerName: full.customerName,
          customerAddress: full.customerAddress,
          customerPhone: full.customerPhone,
          notes: full.notes,
          paid: "2.00",
        },
      }));
      ok(ipc.updateInvoiceHeader({ invoiceId: id2, patch: { [key]: fresh[key] } }));
      const after = headerOf(id2);
      for (const other of INVOICE_HEADER_PATCH_KEYS) {
        if (other === key) continue;
        if (other === "paid") {
          expect(after.paid.minor, `${key} changed paid`).toBe("200");
          continue;
        }
        const before = full[other as "customerName"];
        expect(after[other as "customerName"], `writing ${key} changed ${other}`).toBe(before);
      }
    }
  });

  it("an EMPTY patch is a no-op, not an erasure", () => {
    const id = draft();
    ok(ipc.updateInvoiceHeader({
      invoiceId: id,
      patch: { customerName: "الاسم", customerPhone: "70-333333", notes: "ملاحظة" },
    }));
    const before = headerOf(id);
    ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: {} }));
    expect(headerOf(id)).toEqual(before);
  });

  it("an explicit null CLEARS a field — absent and null are different things", () => {
    const id = draft();
    ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerName: "الاسم", customerPhone: "70-444444" } }));
    // null is given on purpose: clear the phone, leave the name alone.
    ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPhone: null } }));
    const after = headerOf(id);
    expect(after.customerPhone).toBeNull();
    expect(after.customerName).toBe("الاسم");
  });

  it("🔴 stress: 40 interleaved one-key writes, and every field holds its LAST value", () => {
    const id = draft();
    const last: Record<string, string> = {};
    // Round-robin across the text fields, the way a fast operator tabs through them. Under the old
    // contract any of these could resurrect an earlier value for a field it never mentioned.
    const keys = ["customerName", "customerAddress", "customerPhone", "notes"] as const;
    for (let i = 0; i < 40; i += 1) {
      const key = keys[i % keys.length]!;
      const value = `${key}-${i}`;
      ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: { [key]: value } }));
      last[key] = value;
    }
    const after = headerOf(id);
    for (const key of keys) {
      expect(after[key as "customerName"], key).toBe(last[key]);
    }
    // And the date, never once mentioned in those 40 writes, is still untouched.
    expect(after.invoiceDate).toBeNull();
  });

  it("the boundary refuses an unknown patch key instead of silently ignoring it", () => {
    const id = draft();
    const bad = ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerPhne: "70-555555" } } as never);
    expect(bad).toMatchObject({ ok: false });
    // And nothing was written by the refused call.
    expect(headerOf(id).customerPhone).toBeNull();
  });

  it("a finalized invoice still refuses a header patch", () => {
    const id = draft();
    ok(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerName: "الاسم" } }));
    ok(ipc.finalizeInvoice({ invoiceId: id }));
    expect(ipc.updateInvoiceHeader({ invoiceId: id, patch: { customerName: "تغيير" } })).toMatchObject({ ok: false });
    expect(headerOf(id).customerName).toBe("الاسم");
  });
});

describe("the renderer cannot reintroduce the stale full-header write", () => {
  // 🔴 THE TESTS ABOVE PROVE THE CONTRACT, NOT THE RENDERER, and the bug lived in the renderer.
  // There is no DOM test framework in this repo (deliberately — UI behaviour is proven in the
  // Electron E2E), so the renderer is pinned here the same way the preload bridge already is:
  // by reading its source. A source assertion is weaker than a behavioural one and is not pretending
  // otherwise — it exists to make the specific regression impossible to reintroduce unnoticed.
  const sheet = readFileSync(join(__dirname, "../../src/renderer/screens/invoices/InvoiceSheet.tsx"), "utf8");

  it("header() forwards the patch and never fills missing fields from React state", () => {
    // The helper is one call. If anyone reintroduces `patch.X !== undefined ? patch.X : inv.X`,
    // this fails by name.
    expect(sheet).toContain("updateInvoiceHeader({ invoiceId, patch })");
    for (const field of ["customerName", "customerPhone", "customerAddress", "notes", "invoiceDate"]) {
      expect(sheet, `${field} is filled from stale state again`).not.toContain(
        `${field}: patch.${field} !== undefined`,
      );
    }
  });

  it("every header input is bound to a ref, so the typed value can be flushed", () => {
    for (const key of INVOICE_HEADER_PATCH_KEYS) {
      expect(sheet, `${key} has no ref and cannot be flushed`).toContain(`ref={bind("${key}")}`);
    }
  });

  it("finalize flushes the typed header BEFORE committing the document", () => {
    const body = sheet.slice(sheet.indexOf("const finalize = async"));
    const flushAt = body.indexOf("await flushHeader()");
    const finalizeAt = body.indexOf("pos().finalizeInvoice(");
    expect(flushAt, "finalize does not flush at all").toBeGreaterThan(-1);
    expect(flushAt, "the flush happens AFTER the invoice is committed").toBeLessThan(finalizeAt);
  });

  it("leaving the draft flushes too, and is not the same action as discarding", () => {
    const leave = sheet.slice(sheet.indexOf("const leave = async"), sheet.indexOf("const finalize = async"));
    expect(leave).toContain("await flushHeader()");
    expect(leave).toContain("onClosed()");
    // Discard is separate, and reaches onClosed only after an explicit confirmation.
    expect(sheet).toContain('data-testid="discard-confirm-yes"');
    // 🔴 THE CALL, NOT THE WORD. The first version asserted `not.toContain("window.confirm")` and
    // failed on the COMMENT above discard() that explains why window.confirm is not used — the same
    // substring-versus-meaning trap as a grep for `xit(` matching `exit(`. The open paren is what
    // makes this a call site rather than prose.
    expect(sheet).not.toContain("window.confirm(");
  });
});
