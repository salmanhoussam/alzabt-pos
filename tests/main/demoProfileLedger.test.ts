import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { schemaVersion } from "../../src/persistence/db";
import { LEDGER_FILE_NAME } from "../../src/main/ledgerGuard";
import { createSyntheticDemoRoot, openNewSyntheticDemoLedger, reserveSyntheticDemoProfile } from "../../src/main/demoProfile";

// New test parent in the isolated worktree. Never deletes or opens existing profiles.
const parent = mkdtempSync(join(process.cwd(), "node_modules", "synthetic-ledger-test-"));

describe("new synthetic ledger capability", () => {
  // TRANSITION (M1 integration, 2026-11-25): schema-20 -> schema-21 with M21 (invoice_confirmed_request_identity).
  it("opens two exclusively created current-schema (21) ledgers with separated data", () => {
    const root = createSyntheticDemoRoot(mkdtempSync(join(parent, "case-")));
    const a = reserveSyntheticDemoProfile(root);
    const b = reserveSyntheticDemoProfile(root);
    const dbA = openNewSyntheticDemoLedger(a);
    const dbB = openNewSyntheticDemoLedger(b);
    try {
      expect(existsSync(join(a.path, LEDGER_FILE_NAME))).toBe(true);
      expect(schemaVersion(dbA)).toBe(21);
      expect(schemaVersion(dbB)).toBe(21);
      const add = dbA.prepare("INSERT INTO catalog_products (id, source, source_key, name_ar, selling_price_minor, currency, base_unit, price_needs_review, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      add.run("synthetic-a", "manual", "a", "Synthetic A", 100, "USD", "piece", 0, 1, "2026-01-01", "2026-01-01");
      const count = (db: typeof dbA) => Number((db.prepare("SELECT count(*) AS n FROM catalog_products").get() as { n: bigint }).n);
      expect(count(dbA)).toBe(1);
      expect(count(dbB)).toBe(0);
      dbB.prepare("INSERT INTO catalog_products (id, source, source_key, name_ar, selling_price_minor, currency, base_unit, price_needs_review, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("synthetic-b", "manual", "b", "Synthetic B", 200, "USD", "piece", 0, 1, "2026-01-01", "2026-01-01");
      expect(count(dbA)).toBe(1);
      expect(count(dbB)).toBe(1);
      expect(dbA.prepare("SELECT 1 FROM catalog_products WHERE id = ?").get("synthetic-b")).toBeUndefined();
      expect(dbB.prepare("SELECT 1 FROM catalog_products WHERE id = ?").get("synthetic-a")).toBeUndefined();
      expect(() => openNewSyntheticDemoLedger(a)).toThrow("Demo profile unavailable.");
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it("rejects forged/deserialized capability and an existing file without changing it", () => {
    const root = createSyntheticDemoRoot(mkdtempSync(join(parent, "case-")));
    const a = reserveSyntheticDemoProfile(root);
    const ledger = join(a.path, LEDGER_FILE_NAME);
    expect(() => openNewSyntheticDemoLedger({ path: a.path, slot: a.slot })).toThrow("Demo profile unavailable.");
    expect(existsSync(ledger)).toBe(false);
    writeFileSync(ledger, "synthetic-existing", { flag: "wx" });
    expect(() => openNewSyntheticDemoLedger(a)).toThrow("Demo profile unavailable.");
    expect(readFileSync(ledger, "utf8")).toBe("synthetic-existing");
    expect(() => openNewSyntheticDemoLedger(a)).toThrow("Demo profile unavailable.");
  });
});
