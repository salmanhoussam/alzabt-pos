/** M21: real transaction and SQLite assertions, using synthetic temporary ledgers only. */
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { openDatabase, SchemaNewerThanAppError } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { snapshotDatabase } from "../../src/persistence/backup";
import { toInvoiceViewDto } from "../../src/shared/dto";
import { confirmationDigest } from "../../src/shared/invoiceConfirmation";
import { makeHarness, tempDir, type Harness, type TempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let batch: number;
beforeEach(() => {
  t = tempDir(); h = makeHarness(t.dbPath); batch = 0;
  h.invoices.saveCompanyProfile({ nameAr: "Synthetic shop" });
});
afterEach(() => { h.db.close(); t.cleanup(); });

function draft(account = false, paid = "0") {
  const id = h.invoices.createDraft().invoice.id;
  h.invoices.addLines(id, [
    { description: "item A", productId: null, canonicalUnit: null, unitLabel: "piece", quantity: "1", unitPrice: "6.00" },
    { description: "item B", productId: null, canonicalUnit: null, unitLabel: "piece", quantity: "1", unitPrice: "4.00" },
  ], `m21-batch-key-${++batch}`);
  const customer = account ? h.parties.create({ kind: "customer", displayName: "Synthetic customer" }).party.id : null;
  h.invoices.updateDraftHeader(id, { ...(customer ? { customerPartyId: customer } : {}), paid });
  const token = confirmationDigest(toInvoiceViewDto(h.invoices.getInvoice(id)), account);
  return { id, token };
}
function counts() {
  const n = (table: string) => Number((h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);
  return { invoices: n("invoices"), sales: n("sales"), sale_tenders: n("sale_tenders"), obligations: n("obligations"), settlements: n("settlements") };
}
function refusal(fn: () => unknown) {
  try { fn(); return "NO_ERROR"; } catch (err) { if (err instanceof DomainError) return err.code; throw err; }
}
function identity(id: string) {
  return (h.db.prepare("SELECT confirmed_request_identity AS value FROM invoices WHERE id = ?").get(id) as { value: string | null }).value;
}
function numberState() {
  return {
    invoice: h.db.prepare("SELECT next_invoice_number FROM company_profile WHERE id = 'company'").get(),
    documents: h.db.prepare("SELECT kind, last_no FROM document_numbers ORDER BY kind").all(),
  };
}
async function workers(id: string, requests: Array<{ token: string; mode: string; payment?: { method: "cash" } }>) {
  const worker = join(t.dir, "m21-worker.cjs");
  buildSync({ entryPoints: [join(process.cwd(), "tests/helpers/m21Worker.ts")], outfile: worker, bundle: true, platform: "node", format: "cjs", external: ["better-sqlite3"], logLevel: "silent" });
  const go = join(t.dir, "go");
  const ready: string[] = [];
  const results = requests.map((request, index) => {
    const input = join(t.dir, `request-${index}.json`); const marker = join(t.dir, `ready-${index}`);
    ready.push(marker); writeFileSync(input, JSON.stringify({ ...request, id }));
    const child = spawn(process.execPath, [worker, t.dbPath, input, marker, go], {
      env: { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") }, windowsHide: true,
    });
    return new Promise<{ exit: number | null; output: string }>((resolve, reject) => {
      let output = ""; child.stdout.on("data", (x: Buffer) => { output += x.toString(); });
      child.stderr.on("data", (x: Buffer) => { output += x.toString(); });
      child.on("error", reject); child.on("close", (exit) => resolve({ exit, output }));
    });
  });
  const end = Date.now() + 15000;
  while (!ready.every(existsSync) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!ready.every(existsSync)) throw new Error(`Workers failed to become ready: ${JSON.stringify(await Promise.all(results))}`);
  writeFileSync(go, "go");
  return Promise.all(results);
}

describe("M21 durable confirmation identity", () => {
  it.each([false, true])("issues and replays exactly once (on account %s)", (account) => {
    const { id, token } = draft(account);
    const args = { issueOnAccount: account, confirmedDraft: token };
    const first = h.invoices.finalizeInvoice(id, args);
    expect(identity(id)).toMatch(/^v1:[0-9a-f]{64}$/);
    const before = counts(); const numbers = numberState();
    const second = h.invoices.finalizeInvoice(id, args);
    expect(second.invoice.invoice_number).toBe(first.invoice.invoice_number);
    expect(second.invoice.id).toBe(first.invoice.id);
    expect(counts()).toEqual(before);
    expect(numberState()).toEqual(numbers);
    expect(() => h.db.prepare("UPDATE invoices SET confirmed_request_identity = NULL WHERE id = ?").run(id)).toThrow();
  });

  it.each([
    ["same total, changed product", (x: any) => { x.lines[0][3] = "other-product"; }],
    ["same count, changed description", (x: any) => { x.lines[0][2] = "another description"; }],
    ["same count, changed quantity", (x: any) => { x.lines[0][4] = "2000"; }],
    ["line order", (x: any) => { x.lines.reverse(); }],
    ["customer", (x: any) => { x.customer[1] = "different"; }],
    ["tax", (x: any) => { x.tax = [true, 500, "tax"]; }],
  ])("refuses different confirmation: %s", (_label, alter) => {
    const { id, token } = draft(true);
    const args = { issueOnAccount: true, confirmedDraft: token };
    h.invoices.finalizeInvoice(id, args);
    const before = counts(); const numbers = numberState(); const fake = JSON.parse(token); alter(fake);
    expect(refusal(() => h.invoices.finalizeInvoice(id, { ...args, confirmedDraft: JSON.stringify(fake) }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(counts()).toEqual(before);
    expect(numberState()).toEqual(numbers);
    expect(h.invoices.finalizeInvoice(id, args).invoice.status).toBe("final");
  });

  it("binds partial account payment and refuses payment changes", () => {
    const { id, token } = draft(true, "4.00");
    const args = { issueOnAccount: true, confirmedDraft: token, payment: { method: "cash" as const } };
    h.invoices.finalizeInvoice(id, args); const before = counts();
    expect(h.invoices.finalizeInvoice(id, args).invoice.status).toBe("final");
    expect(refusal(() => h.invoices.finalizeInvoice(id, { ...args, payment: { method: "external", whish: { reference: "synthetic-reference", fundsConfirmed: true } } }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(counts()).toEqual(before);
  });

  it("binds a normalized Whish reference and verified receipt to a partial account payment", () => {
    const { id, token } = draft(true, "4.00");
    const payment = { method: "external" as const, whish: { reference: "SYNTHETIC-123", fundsConfirmed: true as const } };
    const args = { issueOnAccount: true, confirmedDraft: token, payment };
    h.invoices.finalizeInvoice(id, args); const before = counts();
    expect(h.invoices.finalizeInvoice(id, args).invoice.status).toBe("final");
    expect(refusal(() => h.invoices.finalizeInvoice(id, { ...args, payment: { ...payment, whish: { ...payment.whish, reference: "SYNTHETIC-456" } } }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(counts()).toEqual(before);
  });

  it.each([
    { method: "cash" as const },
    { method: "external" as const, whish: { reference: "ORDINARY-123", fundsConfirmed: true as const } },
  ])("replays a fully paid ordinary invoice with its original payment: $method", (payment) => {
    const { id, token } = draft(false, "10.00");
    const args = { confirmedDraft: token, payment };
    const issued = h.invoices.finalizeInvoice(id, args); const before = counts();
    expect(h.invoices.finalizeInvoice(id, args).invoice.invoice_number).toBe(issued.invoice.invoice_number);
    expect(refusal(() => h.invoices.finalizeInvoice(id, { confirmedDraft: token }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(counts()).toEqual(before);
  });

  it("refuses stripped or malformed confirmation on a protected invoice", () => {
    const { id, token } = draft(true);
    h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: token }); const before = counts();
    expect(refusal(() => h.invoices.finalizeInvoice(id, { issueOnAccount: true }))).toBe("INVOICE_CONFIRMATION_REQUIRED");
    expect(refusal(() => h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: "" }))).toBe("INVALID_INPUT");
    expect(counts()).toEqual(before);
  });

  it("does not invent a historic identity; legacy on-account replay stays unverified", () => {
    const { id, token } = draft(true);
    const first = h.invoices.finalizeInvoice(id, { issueOnAccount: true });
    expect(identity(id)).toBeNull(); const before = counts();
    expect(refusal(() => h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: token }))).toBe("INVOICE_CONFIRMATION_UNVERIFIABLE");
    expect(h.invoices.finalizeInvoice(id, { issueOnAccount: true }).invoice.invoice_number).toBe(first.invoice.invoice_number);
    expect(counts()).toEqual(before);
  });

  it("refuses a stale uncommitted draft without any financial write", () => {
    const { id, token } = draft(true); const before = counts(); const numbers = numberState();
    h.invoices.updateDraftHeader(id, { customerName: "changed" });
    expect(refusal(() => h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: token }))).toBe("INVOICE_CONFIRMATION_STALE");
    expect(h.invoices.getInvoice(id).invoice.invoice_number).toBeNull();
    expect(identity(id)).toBeNull(); expect(counts()).toEqual(before);
    expect(numberState()).toEqual(numbers);
  });

  it("refuses a changed company tax fallback before issuing a protected draft, then succeeds after explicit tax confirmation", () => {
    const { id, token } = draft(); const before = counts();
    h.invoices.saveCompanyProfile({ nameAr: "Synthetic shop", taxEnabled: true, taxRatePercent: "10", taxLabel: "VAT" });
    expect(confirmationDigest(toInvoiceViewDto(h.invoices.getInvoice(id)), false)).toBe(token);
    expect(refusal(() => h.invoices.finalizeInvoice(id, { confirmedDraft: token }))).toBe("INVOICE_TAX_CONFIRMATION_REQUIRED");
    expect(h.invoices.getInvoice(id).invoice.invoice_number).toBeNull(); expect(identity(id)).toBeNull();
    expect(counts()).toEqual(before);
    h.invoices.setInvoiceTax(id, { enabled: true, ratePercent: "10", label: "VAT" });
    const fresh = confirmationDigest(toInvoiceViewDto(h.invoices.getInvoice(id)), false);
    expect(h.invoices.finalizeInvoice(id, { confirmedDraft: fresh }).invoice.total_minor).toBe(1100n);
  });

  it("requires an explicit tax snapshot even when inherited tax leaves the same total", () => {
    h.invoices.saveCompanyProfile({ nameAr: "Synthetic shop", taxEnabled: true, taxRatePercent: "0", taxLabel: "VAT" });
    const { id, token } = draft(); const before = counts();
    expect(refusal(() => h.invoices.finalizeInvoice(id, { confirmedDraft: token }))).toBe("INVOICE_TAX_CONFIRMATION_REQUIRED");
    expect(counts()).toEqual(before);
    h.invoices.setInvoiceTax(id, { enabled: true, ratePercent: "0", label: "VAT" });
    expect(h.invoices.finalizeInvoice(id, { confirmedDraft: confirmationDigest(toInvoiceViewDto(h.invoices.getInvoice(id)), false) }).invoice.status).toBe("final");
  });

  it("refuses when a previously taxed NULL-snapshot draft's company fallback is turned off", () => {
    h.invoices.saveCompanyProfile({ nameAr: "Synthetic shop", taxEnabled: true, taxRatePercent: "10", taxLabel: "VAT" });
    const { id, token } = draft(); const before = counts();
    h.invoices.saveCompanyProfile({ nameAr: "Synthetic shop", taxEnabled: false });
    expect(refusal(() => h.invoices.finalizeInvoice(id, { confirmedDraft: token }))).toBe("INVOICE_CONFIRMATION_STALE");
    expect(counts()).toEqual(before);
  });

  it("retains legacy tokenless issuance with a company tax fallback", () => {
    h.invoices.saveCompanyProfile({ nameAr: "Synthetic shop", taxEnabled: true, taxRatePercent: "10", taxLabel: "VAT" });
    const { id } = draft();
    expect(h.invoices.finalizeInvoice(id).invoice.total_minor).toBe(1100n);
    expect(identity(id)).toBeNull();
  });

  it("preserves identity across a consistent SQLite backup and re-open", () => {
    const { id, token } = draft(true);
    h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: token });
    const expected = identity(id); const snap = join(t.dir, "synthetic-backup.sqlite");
    snapshotDatabase(h.db, snap);
    const restored = join(t.dir, "synthetic-restore.sqlite"); copyFileSync(snap, restored);
    const r = makeHarness(restored);
    try {
      expect((r.db.prepare("SELECT confirmed_request_identity AS value FROM invoices WHERE id = ?").get(id) as any).value).toBe(expected);
      expect(r.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: token }).invoice.id).toBe(id);
      expect(refusal(() => r.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: token + " " }))).toBe("IDEMPOTENCY_CONFLICT");
    } finally { r.db.close(); }
  });

  it("upgrades a synthetic schema 20 without rewriting historical invoice fields and older builds refuse schema 21", () => {
    const path = join(t.dir, "synthetic-v20.sqlite");
    const old = openDatabase(path, MIGRATIONS.slice(0, 20));
    old.prepare("INSERT INTO invoices (id, status, invoice_number, invoice_date, currency, subtotal_minor, tax_minor, total_minor, paid_minor, balance_due_minor, amount_in_words, issuer_snapshot_json, created_at, updated_at, finalized_at, created_by_id, created_by_name) VALUES (?, 'final', 1, '2026-01-01', 'USD', 1000, 100, 1100, 400, 700, 'synthetic amount', '{}', ?, ?, ?, ?, ?)")
      .run("historic-invoice", "2026-01-01", "2026-01-01", "2026-01-01", "operator", "Synthetic");
    const before = old.prepare("SELECT * FROM invoices WHERE id = ?").get("historic-invoice") as Record<string, unknown>;
    const checksums = old.prepare("SELECT * FROM schema_migrations ORDER BY version").all(); old.close();
    let observed: unknown;
    const upgraded = openDatabase(path, MIGRATIONS, { beforeMigrations: (_db, pending) => { observed = pending; } });
    try {
      expect(observed).toEqual({ fromVersion: 20, toVersion: 21 });
      const after = upgraded.prepare("SELECT * FROM invoices WHERE id = ?").get("historic-invoice") as Record<string, unknown>;
      expect(after.confirmed_request_identity).toBeNull(); delete after.confirmed_request_identity;
      expect(after).toEqual(before);
      expect(upgraded.prepare("SELECT * FROM schema_migrations WHERE version <= 20 ORDER BY version").all()).toEqual(checksums);
      expect(() => upgraded.prepare("INSERT INTO invoices (id, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, balance_due_minor, created_at, updated_at, created_by_id, created_by_name, confirmed_request_identity) VALUES ('bad', 'draft', 'USD', 0, 0, 0, 0, 0, '2026-01-01', '2026-01-01', 'operator', 'Synthetic', 'v1:bad')").run()).toThrow(/CHECK/);
    } finally { upgraded.close(); }
    expect(() => openDatabase(path, MIGRATIONS.slice(0, 20))).toThrow(SchemaNewerThanAppError);
    const historic = makeHarness(path);
    try {
      expect(historic.invoices.getInvoice("historic-invoice").invoice.status).toBe("final");
      expect(refusal(() => historic.invoices.finalizeInvoice("historic-invoice", { issueOnAccount: true, confirmedDraft: "synthetic" }))).toBe("INVOICE_CONFIRMATION_UNVERIFIABLE");
      expect(Number((historic.db.prepare("SELECT count(*) AS n FROM sales").get() as any).n)).toBe(0);
    } finally { historic.db.close(); }
  });

  it.each(["before", "after"])("recovers after process termination %s transaction commit", async (mode) => {
    const { id, token } = draft(true); const before = counts(); const numbers = numberState();
    const [result] = await workers(id, [{ token, mode }]);
    expect(result?.exit).toBe(mode === "before" ? 70 : 71);
    expect(result?.output).toContain(mode === "before" ? "BEFORE_COMMIT" : "AFTER_COMMIT");
    const during = h.invoices.getInvoice(id).invoice;
    if (mode === "before") { expect(during.status).toBe("draft"); expect(identity(id)).toBeNull(); expect(counts()).toEqual(before); expect(numberState()).toEqual(numbers); }
    else { expect(during.status).toBe("final"); expect(identity(id)).toMatch(/^v1:/); }
    const final = h.invoices.finalizeInvoice(id, { issueOnAccount: true, confirmedDraft: token });
    expect(final.invoice.status).toBe("final");
    expect(counts().sales).toBe(before.sales + 1); expect(counts().obligations).toBe(before.obligations + 1);
  }, 30000);

  it.each([false, true])("serializes simultaneous %s requests without duplicate ledger writes", async (conflict) => {
    const { id, token } = draft(true); const alternate = JSON.parse(token); alternate.notes = "different";
    const results = await workers(id, [{ token, mode: "normal" }, { token: conflict ? JSON.stringify(alternate) : token, mode: "normal" }]);
    expect(results.map((r) => r.exit)).toEqual([0, 0]);
    const outcomes = results.map((r) => JSON.parse(r.output.trim()));
    console.log("Synthetic concurrent outcomes:", JSON.stringify(outcomes));
    if (conflict) {
      expect(outcomes.filter((o) => o.outcome === "success")).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === "refused")).toHaveLength(1);
      expect(["INVOICE_CONFIRMATION_STALE", "IDEMPOTENCY_CONFLICT"]).toContain(outcomes.find((o) => o.outcome === "refused").code);
    } else expect(outcomes.every((o) => o.outcome === "success")).toBe(true);
    expect(counts().sales).toBe(1); expect(counts().obligations).toBe(1);
    expect(Number((h.db.prepare("SELECT count(*) AS n FROM invoices WHERE invoice_number IS NOT NULL").get() as any).n)).toBe(1);
  }, 30000);

  it("serializes concurrent partial-payment retries without duplicating a payment or debt", async () => {
    const { id, token } = draft(true, "4.00");
    const request = { token, mode: "normal", payment: { method: "cash" as const } };
    const results = await workers(id, [request, request]);
    expect(results.map((r) => JSON.parse(r.output.trim()).outcome)).toEqual(["success", "success"]);
    expect(counts()).toEqual({ invoices: 1, sales: 1, sale_tenders: 1, obligations: 1, settlements: 0 });
  }, 30000);

  it("waits for a deliberately delayed uncommitted writer, then replays without extra financial writes", async () => {
    const { id, token } = draft(true, "4.00");
    const payment = { method: "cash" as const };
    const results = await workers(id, [{ token, mode: "hold", payment }, { token, mode: "wait", payment }]);
    const [first, second] = results.map((r) => JSON.parse(r.output.trim()));
    expect(first.outcome).toBe("success"); expect(second.outcome).toBe("success");
    expect(second.elapsedMs).toBeGreaterThan(250);
    expect(second.number).toBe(first.number);
    expect(counts()).toEqual({ invoices: 1, sales: 1, sale_tenders: 1, obligations: 1, settlements: 0 });
  }, 30000);
});
