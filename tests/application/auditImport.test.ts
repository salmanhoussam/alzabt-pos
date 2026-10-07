/**
 * What a CSV catalog import writes to the durable audit trail — complete entity audit.
 *
 * The decision this file encodes: the summary counts alone cannot answer the questions an owner
 * actually asks. "5 updated" does not say WHICH five, and the old prices are gone from the table
 * the moment the import overwrites them in place; "7 deactivated" does not say which seven. So the
 * trail carries one summary PLUS one event per product the import really touched, and nothing at
 * all for products it left alone.
 *
 * Synthetic products and synthetic prices only — no merchant data is in this repository.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditRow } from "../../src/domain/audit";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";
import type { PosService } from "../../src/application/posService";
import type { AuditRepository } from "../../src/persistence/auditRepository";
import type { Db } from "../../src/persistence/db";

let t: TempDir;
let db: Db;
let service: PosService;
let trail: AuditRepository;

const HEADER = "source_id,name_ar,name_en,price,currency,base_unit,price_needs_review";

/** `rows` is a list of [sourceId, nameAr, price] — everything else is a fixed synthetic default. */
function csv(rows: ReadonlyArray<readonly [string, string, string]>): Uint8Array {
  const body = rows.map(([id, name, price]) => `${id},${name},,${price},USD,piece,0`);
  return new TextEncoder().encode([HEADER, ...body].join("\n"));
}

const synthetic = (n: number, priceOf: (i: number) => string = () => "1.00") =>
  Array.from({ length: n }, (_, i) => [String(i + 1), `صنف ${i + 1}`, priceOf(i + 1)] as const);

/** Oldest first, which is `seq` order. */
const stored = (): AuditRow[] => trail.listRecent(2000).reverse();
const typesOf = (rows: ReadonlyArray<AuditRow>) => {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.event_type] = (out[r.event_type] ?? 0) + 1;
  return out;
};

beforeEach(() => {
  t = tempDir();
  const h = makeHarness(t.dbPath);
  db = h.db;
  service = h.service;
  trail = h.audit;
});
afterEach(() => {
  db.close();
  t.cleanup();
});

describe("an import's durable audit", () => {
  it("an initial 400-item import writes 1 summary + 400 PRODUCT_CREATED", () => {
    const result = service.importCatalogCsv("synthetic.csv", csv(synthetic(400)));
    expect(result.status).toBe("imported");
    const rows = stored();
    expect(typesOf(rows)).toEqual({ CATALOG_IMPORTED: 1, PRODUCT_CREATED: 400 });
    expect(rows).toHaveLength(401);

    // The summary comes first, so it holds the lowest seq of the import.
    expect(rows[0]!.event_type).toBe("CATALOG_IMPORTED");
    expect(rows[0]!.entity_type).toBe("catalog");
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 401 }, (_, i) => i + 1));

    // Bounded summary metadata — counts and the file's identity, never a CSV row.
    const meta = JSON.parse(rows[0]!.metadata_json!) as Record<string, unknown>;
    expect(meta).toEqual({
      deactivated: 0,
      file_name: "synthetic.csv",
      file_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      inserted: 400,
      origin: "catalog_import",
      row_count: 400,
      unchanged: 0,
      updated: 0,
    });
    expect(rows[0]!.changed_json).toBe("{}"); // an import changed no single entity's fields

    // Every per-product event is correlated to the import that caused it.
    for (const row of rows.slice(1)) {
      const m = JSON.parse(row.metadata_json!) as Record<string, unknown>;
      expect(m.origin).toBe("catalog_import");
      expect(m.catalog_import_id).toBe(rows[0]!.entity_id);
      expect(m.source).toBe("merchant-csv");
    }
    // 🔴 Provenance is RECORDED, not inferred later from created_at/source/source_key.
    const created = rows.find((r) => r.entity_id === "merchant-csv:1")!;
    expect(created.event_type).toBe("PRODUCT_CREATED");
    expect(JSON.parse(created.changed_json)).toEqual({
      base_unit: { before: null, after: "piece" },
      currency: { before: null, after: "USD" },
      is_active: { before: null, after: true },
      name_ar: { before: null, after: "صنف 1" },
      name_en: { before: null, after: null },
      price_needs_review: { before: null, after: false },
      selling_price_minor: { before: null, after: "100" },
      sku: { before: null, after: null },
    });
  });

  it("an identical re-import writes 1 summary and 0 product events", () => {
    const file = csv(synthetic(50));
    service.importCatalogCsv("synthetic.csv", file);
    const after = stored().length;
    service.importCatalogCsv("synthetic.csv", file);
    const rows = stored().slice(after);
    expect(typesOf(rows)).toEqual({ CATALOG_IMPORTED: 1 });
    expect(JSON.parse(rows[0]!.metadata_json!)).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 50,
      deactivated: 0,
    });
  });

  it("an import with five changed prices writes 1 summary + 5 PRODUCT_UPDATED, with the OLD prices", () => {
    service.importCatalogCsv("v1.csv", csv(synthetic(20)));
    const after = stored().length;
    // Five rows get a new price; the other fifteen are byte-identical.
    service.importCatalogCsv("v2.csv", csv(synthetic(20, (i) => (i <= 5 ? "2.50" : "1.00"))));
    const rows = stored().slice(after);
    expect(typesOf(rows)).toEqual({ CATALOG_IMPORTED: 1, PRODUCT_UPDATED: 5 });
    const updated = rows.filter((r) => r.event_type === "PRODUCT_UPDATED");
    expect(updated.map((r) => r.entity_id).sort()).toEqual([
      "merchant-csv:1",
      "merchant-csv:2",
      "merchant-csv:3",
      "merchant-csv:4",
      "merchant-csv:5",
    ]);
    // 🔴 The whole reason per-row import events exist: the previous price is nowhere else.
    for (const row of updated) {
      expect(JSON.parse(row.changed_json)).toEqual({
        selling_price_minor: { before: "100", after: "250" },
      });
    }
  });

  it("an import that drops seven products writes 1 summary + 7 PRODUCT_DEACTIVATED", () => {
    service.importCatalogCsv("v1.csv", csv(synthetic(20)));
    const after = stored().length;
    service.importCatalogCsv("v2.csv", csv(synthetic(13)));
    const rows = stored().slice(after);
    expect(typesOf(rows)).toEqual({ CATALOG_IMPORTED: 1, PRODUCT_DEACTIVATED: 7 });
    const gone = rows.filter((r) => r.event_type === "PRODUCT_DEACTIVATED");
    // WHICH seven — the counts cannot say this.
    expect(gone.map((r) => r.entity_id).sort()).toEqual([
      "merchant-csv:14",
      "merchant-csv:15",
      "merchant-csv:16",
      "merchant-csv:17",
      "merchant-csv:18",
      "merchant-csv:19",
      "merchant-csv:20",
    ]);
    for (const row of gone) {
      expect(JSON.parse(row.changed_json)).toEqual({ is_active: { before: true, after: false } });
    }
  });

  it("a mixed import: the summary counts and the entity events agree exactly", () => {
    service.importCatalogCsv("v1.csv", csv(synthetic(10)));
    const after = stored().length;
    // 1-3 keep their price, 4-6 change, 7-10 vanish, 11-12 are new.
    const next = [
      ...synthetic(6, (i) => (i <= 3 ? "1.00" : "9.90")).slice(0, 6),
      ["11", "صنف 11", "1.00"] as const,
      ["12", "صنف 12", "1.00"] as const,
    ];
    service.importCatalogCsv("v2.csv", csv(next));
    const rows = stored().slice(after);
    const summary = JSON.parse(rows[0]!.metadata_json!) as Record<string, number>;
    expect(summary).toMatchObject({ inserted: 2, updated: 3, unchanged: 3, deactivated: 4 });
    const counts = typesOf(rows);
    expect(counts.PRODUCT_CREATED).toBe(summary.inserted);
    expect(counts.PRODUCT_UPDATED).toBe(summary.updated);
    expect(counts.PRODUCT_DEACTIVATED).toBe(summary.deactivated);
    expect(counts.CATALOG_IMPORTED).toBe(1);
    // Unchanged rows contributed nothing at all.
    expect(rows).toHaveLength(1 + 2 + 3 + 4);
  });

  it("a REJECTED file writes neither products nor audit rows", () => {
    const bad = new TextEncoder().encode([HEADER, "1,صنف,,not-a-price,USD,piece,0"].join("\n"));
    const result = service.importCatalogCsv("bad.csv", bad);
    expect(result.status).toBe("rejected");
    expect(service.listProducts()).toHaveLength(0);
    expect(trail.count()).toBe(0);
  });

  it("the import's own catalog_imports summary row and the audit event name the same import", () => {
    service.importCatalogCsv("synthetic.csv", csv(synthetic(3)));
    const summary = stored()[0]!;
    const row = db
      .prepare("SELECT id, file_name, inserted FROM catalog_imports")
      .get() as { id: string; file_name: string; inserted: bigint };
    expect(summary.entity_id).toBe(row.id);
    expect(JSON.parse(summary.metadata_json!)).toMatchObject({ file_name: row.file_name, inserted: 3 });
    // 🔴 And the audit adds what catalog_imports cannot: it has cashier_id but no cashier NAME.
    expect(summary.actor_name).toBe("Cashier One");
  });
});

describe("🔴 forced audit failure during an import rolls back EVERYTHING", () => {
  it("no product write, no catalog_imports row, no audit row", () => {
    // Fail on the 4th audit append — after the summary and two product events have been written.
    const failing = {
      append: (() => {
        let n = 0;
        const real = trail.append.bind(trail);
        return (draft: Parameters<AuditRepository["append"]>[0], id: string) => {
          n += 1;
          const row = real(draft, id);
          if (n === 4) throw new Error("injected audit fault mid-import");
          return row;
        };
      })(),
    };
    Object.assign(trail, failing);

    expect(() => service.importCatalogCsv("synthetic.csv", csv(synthetic(10)))).toThrow(
      /injected audit fault mid-import/,
    );

    expect(
      Number((db.prepare("SELECT count(*) AS n FROM catalog_products").get() as { n: bigint }).n),
    ).toBe(0);
    expect(Number((db.prepare("SELECT count(*) AS n FROM catalog_imports").get() as { n: bigint }).n)).toBe(0);
    expect(Number((db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: bigint }).n)).toBe(0);
  });
});
