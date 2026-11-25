/**
 * O-1 (contract v3.1 §2 + review R4): WHAT "AN EMPTY SHOP" MEANS, enumerated — never inferred.
 *
 * New-shop owner enrollment (and, later, the pre-claim restore) is allowed ONLY on an empty, unclaimed ledger. A wrong
 * answer here would let someone enroll themselves as the owner of a shop that already has history, so the rule is a
 * closed list:
 *   BUSINESS tables   must hold ZERO rows (any row is shop history)
 *   COUNTER tables    may hold their seeded rows, but every counter must still be 0
 *   SYSTEM tables     are account/terminal machinery and do not decide emptiness
 * A table that exists in the database but is in NONE of the lists makes the answer «not empty» (fail closed), and
 * tests/persistence/ledgerEmptiness.test.ts fails by name, so the next migration that adds a table must classify it.
 */
import type { Db } from "./db";

export const BUSINESS_TABLES = [
  "advance_applications", "advance_attempts", "advance_corrections", "advance_refunds",
  "audit_events", // no migration seeds a row; any row is an operator or business event
  "catalog_categories", "catalog_imports", "catalog_product_images", "catalog_products",
  "collection_attempts", "collection_documents", "company_profile", "customer_advances",
  "external_references", "invoice_line_batches", "invoice_lines", "invoice_reconciliation", "invoices",
  "obligations", "parties", "party_contact_history", "receipt_attempt_lines", "receipt_attempts", "receipts",
  "sale_lines", "sale_tenders", "sales", "settlements", "voids",
] as const;

/** Seeded with counters at 0 (migration 19); a non-zero counter means a document was issued. */
export const COUNTER_TABLES = ["document_numbers"] as const;

/** Account and terminal machinery: seeded by migrations, written by sign-in attempts; never shop history. */
export const SYSTEM_TABLES = ["cashier_pin_state", "operators", "schema_migrations", "terminal_security_state"] as const;

const KNOWN = new Set<string>([...BUSINESS_TABLES, ...COUNTER_TABLES, ...SYSTEM_TABLES]);

/** Every user table actually present (SQLite internals excluded). */
export function presentTables(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
}

export interface EmptinessReport {
  readonly empty: boolean;
  /** Why not: the first tables (by name) holding history, a non-zero counter, or an unclassified table. */
  readonly reasons: readonly string[];
}

/** Read-only. Call it INSIDE the transaction that acts on the answer, so nothing can be written in between. */
export function ledgerEmptiness(db: Db): EmptinessReport {
  const reasons: string[] = [];
  const present = presentTables(db);
  for (const t of present) if (!KNOWN.has(t)) reasons.push(`unclassified table ${t}`);
  const presentSet = new Set(present);
  for (const t of BUSINESS_TABLES) {
    if (!presentSet.has(t)) continue; // an older schema simply lacks it
    const row = db.prepare(`SELECT EXISTS (SELECT 1 FROM "${t}") AS has`).get() as { has: number | bigint };
    if (Number(row.has) !== 0) reasons.push(`${t} has rows`);
  }
  if (presentSet.has("document_numbers")) {
    const row = db.prepare("SELECT EXISTS (SELECT 1 FROM document_numbers WHERE last_no <> 0) AS has").get() as { has: number | bigint };
    if (Number(row.has) !== 0) reasons.push("document_numbers has issued numbers");
  }
  return { empty: reasons.length === 0, reasons };
}
