/**
 * The hard rule, proven by behaviour: a business mutation and its durable audit row commit together
 * or neither exists.
 *
 *   A   a successful product mutation writes the product AND exactly one audit row;
 *   B   🔴 a forced AUDIT failure rolls back the BUSINESS mutation;
 *   C   🔴 a forced BUSINESS failure leaves no audit row;
 *   NEGATIVE CONTROL: the same forced audit failure with the transaction removed DOES leave a
 *   changed product with no audit row — which is what proves these tests can detect the failure
 *   they claim is prevented. Without it, B and C would pass against a no-op.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PosService } from "../../src/application/posService";
import type { AuditDraft, AuditRow } from "../../src/domain/audit";
import { loadCatalog } from "../../src/domain/catalog";
import { FIXTURE_CASHIERS } from "../../src/fixtures/cashiers";
import { FIXTURE_CATALOG } from "../../src/fixtures/catalog";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AuditRepository } from "../../src/persistence/auditRepository";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { type Db, openDatabase } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { PinStateRepository } from "../../src/persistence/pinStateRepository";
import { SaleRepository } from "../../src/persistence/saleRepository";
import { TestClock, type TempDir, tempDir } from "../helpers/harness";

/** Writes the row, then throws — the audit "succeeded" and the commit must still not happen. */
class FailAfterNthAudit extends AuditRepository {
  private written = 0;
  constructor(
    db: Db,
    private readonly failOn: number,
  ) {
    super(db, { appVersion: "test", schemaVersion: MIGRATIONS.length });
  }
  override append(draft: AuditDraft, id: string): AuditRow {
    const row = super.append(draft, id);
    this.written += 1;
    if (this.written >= this.failOn) throw new Error(`injected audit fault after row ${this.written}`);
    return row;
  }
}

/** Fails before writing anything — the other side of the same guarantee. */
class RefuseAudit extends AuditRepository {
  override append(): AuditRow {
    throw new Error("injected audit fault before write");
  }
}

/** The business write itself fails, after the audit row was already appended. */
class FailingCatalogRepository extends CatalogRepository {
  override setActive(): never {
    throw new Error("injected business fault");
  }
}

let t: TempDir;
let db: Db;
let clock: TestClock;

function makeService(opts: {
  auditStore?: AuditRepository;
  store?: CatalogRepository;
  /** Omit the transaction entirely — the negative control. */
  noTransaction?: boolean;
}): PosService {
  const store = opts.store ?? new CatalogRepository(db);
  const service = new PosService({
    repository: new SaleRepository(db),
    pinStates: new PinStateRepository(db),
    catalog: loadCatalog(FIXTURE_CATALOG),
    catalogStore: store,
    auditStore:
      opts.auditStore ?? new AuditRepository(db, { appVersion: "test", schemaVersion: MIGRATIONS.length }),
    transact: opts.noTransaction ? (fn) => fn() : (fn) => db.transaction(fn).immediate(),
    cashiers: FIXTURE_CASHIERS,
    terminal: FIXTURE_TERMINAL,
    now: clock.now,
  });
  service.login("cashier-01", "1111");
  return service;
}

const draft = { nameAr: "صنف", nameEn: "Item", sku: "SYN-1", price: "4.00", baseUnit: "piece" };

const auditCount = () => Number((db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: bigint }).n);
const productCount = () =>
  Number((db.prepare("SELECT count(*) AS n FROM catalog_products").get() as { n: bigint }).n);
const priceOf = (id: string) =>
  (db.prepare("SELECT selling_price_minor AS p FROM catalog_products WHERE id = ?").get(id) as { p: bigint }).p;
const activeOf = (id: string) =>
  (db.prepare("SELECT is_active AS a FROM catalog_products WHERE id = ?").get(id) as { a: bigint }).a;

beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath);
  clock = new TestClock();
});
afterEach(() => {
  db.close();
  t.cleanup();
});

describe("A · a mutation and its audit row commit together", () => {
  it("createProduct writes the product and exactly one audit row", () => {
    const service = makeService({});
    const row = service.createProduct(draft);
    expect(productCount()).toBe(1);
    expect(auditCount()).toBe(1);
    const stored = db.prepare("SELECT * FROM audit_events").get() as AuditRow;
    expect(stored.entity_id).toBe(row.id);
    expect(stored.event_type).toBe("PRODUCT_CREATED");
    expect(Number(stored.seq)).toBe(1);
  });

  it("seq is strictly increasing even when the clock is frozen to one instant", () => {
    const service = makeService({});
    const row = service.createProduct(draft);
    service.updateProduct(row.id, { ...draft, price: "5.00" }, true);
    service.setProductActive(row.id, false);
    const rows = db.prepare("SELECT seq, occurred_at FROM audit_events ORDER BY seq").all() as Array<{
      seq: bigint;
      occurred_at: string;
    }>;
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    // Timestamp equality is allowed on purpose; this is exactly why `seq` exists.
    expect(new Set(rows.map((r) => r.occurred_at)).size).toBe(1);
  });
});

describe("B · 🔴 a forced AUDIT failure rolls back the business mutation", () => {
  it("createProduct writes neither the product nor the audit row", () => {
    const service = makeService({ auditStore: new FailAfterNthAudit(db, 1) });
    expect(() => service.createProduct(draft)).toThrow(/injected audit fault/);
    expect(productCount()).toBe(0);
    expect(auditCount()).toBe(0);
  });

  it("updateProduct leaves the old price untouched", () => {
    const seeded = makeService({}).createProduct(draft);
    expect(priceOf(seeded.id)).toBe(400n);
    const service = makeService({ auditStore: new RefuseAudit(db, { appVersion: "test", schemaVersion: 5 }) });
    expect(() => service.updateProduct(seeded.id, { ...draft, price: "99.00" }, true)).toThrow(
      /injected audit fault/,
    );
    expect(priceOf(seeded.id)).toBe(400n);
    expect(auditCount()).toBe(1); // only the creation's own row
  });

  it("setProductActive leaves the product active", () => {
    const seeded = makeService({}).createProduct(draft);
    const service = makeService({ auditStore: new FailAfterNthAudit(db, 1) });
    expect(() => service.setProductActive(seeded.id, false)).toThrow(/injected audit fault/);
    expect(activeOf(seeded.id)).toBe(1n);
    expect(auditCount()).toBe(1);
  });
});

describe("C · 🔴 a forced BUSINESS failure leaves no audit row", () => {
  it("setProductActive writes nothing at all", () => {
    const seeded = makeService({}).createProduct(draft);
    const before = auditCount();
    const service = makeService({ store: new FailingCatalogRepository(db) });
    expect(() => service.setProductActive(seeded.id, false)).toThrow(/injected business fault/);
    expect(auditCount()).toBe(before);
    expect(activeOf(seeded.id)).toBe(1n);
  });
});

describe("NEGATIVE CONTROL · without the transaction, the hole is real", () => {
  it("🔴 the same forced audit failure DOES leave a changed product with no audit row", () => {
    const seeded = makeService({}).createProduct(draft);
    const auditBefore = auditCount();

    // Identical service, identical fault — only the transaction removed.
    const unsafe = makeService({
      auditStore: new RefuseAudit(db, { appVersion: "test", schemaVersion: 5 }),
      noTransaction: true,
    });
    expect(() => unsafe.setProductActive(seeded.id, false)).toThrow(/injected audit fault/);

    // The business write survived its own audit failing. This is the failure mode B and C prevent,
    // and seeing it here is what proves those tests are not passing vacuously.
    expect(activeOf(seeded.id)).toBe(0n);
    expect(auditCount()).toBe(auditBefore);
  });
});

describe("fail closed · product management refuses to run unaudited", () => {
  it("a terminal with a catalog but no audit trail cannot change master data", () => {
    const service = new PosService({
      repository: new SaleRepository(db),
      pinStates: new PinStateRepository(db),
      catalog: loadCatalog(FIXTURE_CATALOG),
      catalogStore: new CatalogRepository(db),
      // auditStore and transact deliberately absent
      cashiers: FIXTURE_CASHIERS,
      terminal: FIXTURE_TERMINAL,
      now: clock.now,
    });
    service.login("cashier-01", "1111");
    for (const act of [
      () => service.createProduct(draft),
      () => service.updateProduct("manual:000001", draft, true),
      () => service.setProductActive("manual:000001", false),
      () => service.importCatalogCsv("x.csv", new TextEncoder().encode("source_id\n")),
    ]) {
      expect(act).toThrow(/durable audit trail is not wired/);
    }
    expect(productCount()).toBe(0);
    expect(auditCount()).toBe(0);
    // Reading is still fine — only WRITING requires the trail.
    expect(service.listProducts()).toEqual([]);
  });
});
