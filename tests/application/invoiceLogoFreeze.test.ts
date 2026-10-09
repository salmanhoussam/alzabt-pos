/**
 * The logo is frozen onto a finalized invoice, instead of being resolved from a mutable directory.
 *
 * 🔴 WHAT WAS WRONG. `logo_path` sat inside `issuer_snapshot_json`, so the snapshot looked complete
 * — but it stores a FILENAME, and the main process resolved that name against the LIVE branding
 * directory at render time. Replacing the shop's logo changed the logo on every invoice already
 * issued; deleting it blanked them. It was the one field in a frozen snapshot that was not frozen.
 *
 * The service cannot touch the filesystem and must not start, so freezing is a PORT. These tests
 * drive that port with a fake vault, which is the right fidelity here: what is being proven is that
 * the service asks at the right moment and records exactly what it is told. The real vault's own
 * behaviour — content-addressing, atomic copy — lives in the main process.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceService, type LogoVault } from "../../src/application/invoiceService";
import { InvoiceRepository } from "../../src/persistence/invoiceRepository";
import { ReconciliationRepository } from "../../src/persistence/reconciliationRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;

const LINE = { description: "صنف اختباري", unitLabel: "حبة", quantity: "1", unitPrice: "10.00", productId: null };

/** Records every freeze request, and answers with a content-addressed-looking name. */
function recordingVault(answer: (name: string) => string | null = (n) => `frozen-${n}`) {
  const asked: string[] = [];
  const vault: LogoVault = {
    freeze(storedName) {
      asked.push(storedName);
      return answer(storedName);
    },
  };
  return { vault, asked };
}

function serviceWith(vault: LogoVault | undefined): InvoiceService {
  return new InvoiceService({
    invoices: new InvoiceRepository(h.db),
    reconciliation: new ReconciliationRepository(h.db),
    company: h.companyStore,
    catalogStore: new CatalogRepository(h.db),
    products: h.service,
    sales: new SaleRepository(h.db),
    logoVault: vault,
    transact: (fn) => h.db.transaction(fn).immediate(),
    terminal: FIXTURE_TERMINAL,
    now: h.clock.now,
  });
}

function finalize(svc: InvoiceService): string {
  const { invoice } = svc.createDraft();
  svc.addLine(invoice.id, LINE);
  svc.finalizeInvoice(invoice.id);
  return invoice.id;
}

const issuerOf = (id: string) => JSON.parse(h.invoices.getInvoice(id).invoice.issuer_snapshot_json!);

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  h.service.login("cashier-01", "1111");
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

describe("logo freezing at finalization", () => {
  it("freezes the shop's logo and records the immutable name on the document", () => {
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", logoPath: "shop-logo.png" });
    const { vault, asked } = recordingVault();
    const id = finalize(serviceWith(vault));

    expect(asked, "the vault was not asked to freeze anything").toEqual(["shop-logo.png"]);
    const issuer = issuerOf(id);
    expect(issuer.logo_asset).toBe("frozen-shop-logo.png");
    // The original name stays beside it as provenance — what the shop called its logo that day.
    expect(issuer.logo_path).toBe("shop-logo.png");
  });

  it("does not ask the vault at all when the shop has no logo", () => {
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
    const { vault, asked } = recordingVault();
    const id = finalize(serviceWith(vault));
    expect(asked).toEqual([]);
    expect(issuerOf(id).logo_asset).toBeNull();
  });

  it("🔴 a missing logo file records null and still issues the invoice", () => {
    // The honest outcome: the document prints no logo rather than refusing to exist. A shop whose
    // logo file was deleted must still be able to issue an invoice.
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", logoPath: "gone.png" });
    const { vault, asked } = recordingVault(() => null);
    const id = finalize(serviceWith(vault));
    expect(asked).toEqual(["gone.png"]);
    expect(issuerOf(id).logo_asset).toBeNull();
    expect(h.invoices.getInvoice(id).invoice.status).toBe("final");
  });

  it("a terminal with no vault configured still issues invoices, as it did before", () => {
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", logoPath: "shop-logo.png" });
    const id = finalize(serviceWith(undefined));
    expect(issuerOf(id).logo_asset).toBeNull();
    expect(issuerOf(id).logo_path).toBe("shop-logo.png");
  });

  it("🔴 replacing the shop logo afterwards does NOT change an issued invoice", () => {
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", logoPath: "first.png" });
    const { vault } = recordingVault();
    const svc = serviceWith(vault);
    const first = finalize(svc);

    // The shop changes its logo and issues a second invoice.
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", logoPath: "second.png" });
    const second = finalize(svc);

    expect(issuerOf(first).logo_asset).toBe("frozen-first.png");
    expect(issuerOf(second).logo_asset).toBe("frozen-second.png");
    // 🔴 The first document still points at the first image. Before freezing, BOTH would have
    // resolved "second.png" at render time, because both only held a filename.
    expect(issuerOf(first).logo_asset).not.toBe(issuerOf(second).logo_asset);
  });

  it("the frozen name is recorded once, at finalization, and not on a draft", () => {
    h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري", logoPath: "shop-logo.png" });
    const { vault, asked } = recordingVault();
    const svc = serviceWith(vault);
    const { invoice } = svc.createDraft();
    svc.addLine(invoice.id, LINE);
    svc.updateDraftHeader(invoice.id, { customerName: "زبون" });
    // Nothing frozen yet: a draft has no issuer snapshot at all.
    expect(asked).toEqual([]);
    expect(h.invoices.getInvoice(invoice.id).invoice.issuer_snapshot_json).toBeNull();

    svc.finalizeInvoice(invoice.id);
    expect(asked).toEqual(["shop-logo.png"]);
  });
});
