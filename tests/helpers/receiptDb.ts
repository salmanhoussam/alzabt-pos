/**
 * Raw-SQL fixtures for the migration-18 receipt tables. Synthetic data only. These helpers skip the
 * service on purpose: the point of the tests built on them is that the DATABASE refuses what the
 * service also refuses.
 */
import type { Db } from "../../src/persistence/db";

export const AT = "2026-10-25T09:00:00.000Z";
export const DAY = "2026-10-25";

export interface Ledger {
  readonly op: string;
}

export function operatorId(db: Db): string {
  return (db.prepare("SELECT id FROM operators ORDER BY id LIMIT 1").get() as { id: string }).id;
}

export function addParty(db: Db, id: string, kind: "customer" | "supplier" = "customer", active = 1): void {
  const op = operatorId(db);
  db.prepare(
    "INSERT INTO parties (id, kind, display_name, is_active, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run(id, kind, `name-${id}`, active, op, AT, AT);
}

export function addObligation(
  db: Db,
  id: string,
  partyId: string,
  currency: string,
  amountMinor: number,
  kind: "customer" | "supplier" = "customer",
): void {
  db.prepare(
    `INSERT INTO obligations (id, party_id, party_kind, direction, source_kind, source_ref, sale_id, currency, amount_minor, posted_by, posted_at, business_date)
     VALUES (?,?,?,?, 'manual', ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(id, partyId, kind, kind === "customer" ? "receivable" : "payable", `REF-${id}`, currency, amountMinor, operatorId(db), AT, DAY);
}

let seq = 0;
/** An allocation settlement written the way the service writes it (before its receipt exists). */
export function child(
  db: Db,
  receiptId: string,
  obligationId: string,
  currency: string,
  amountMinor: number,
  over: Partial<{ method: string; provider: string | null; reference: string | null; confirmed: number | null; key: string }> = {},
): void {
  seq += 1;
  db.prepare(
    `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, provider, reference, funds_confirmed, settled_by, settled_at, business_date, receipt_id)
     VALUES (?,?,?,?, 'fp', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `alloc-${seq}`,
    obligationId,
    currency,
    over.key ?? `rcpt-alloc-key-${String(seq).padStart(6, "0")}`,
    amountMinor,
    over.method ?? "external",
    over.provider ?? null,
    over.reference ?? null,
    over.confirmed ?? null,
    operatorId(db),
    AT,
    DAY,
    receiptId,
  );
}

/** The sealing receipt row. */
export function seal(
  db: Db,
  id: string,
  customerId: string,
  currency: string,
  amountMinor: number,
  count: number,
  provider: string,
  reference: string,
  key = `receipt-key-${id}-0001`,
): void {
  db.prepare(
    `INSERT INTO receipts (id, customer_id, currency, amount_minor, provider, reference, funds_confirmed, allocation_count, idempotency_key, request_fingerprint, received_by, received_at, business_date)
     VALUES (?,?,?,?,?,?,1,?,?, 'fp', ?, ?, ?)`,
  ).run(id, customerId, currency, amountMinor, provider, reference, count, key, operatorId(db), AT, DAY);
}

export function directSettlement(
  db: Db,
  key: string,
  obligationId: string,
  currency: string,
  amountMinor: number,
  provider: string | null,
  reference: string | null,
): void {
  db.prepare(
    `INSERT INTO settlements (id, obligation_id, currency, idempotency_key, request_fingerprint, amount_minor, method, provider, reference, funds_confirmed, settled_by, settled_at, business_date)
     VALUES (?,?,?,?, 'fp', ?, 'external', ?, ?, ?, ?, ?, ?)`,
  ).run(`direct-${key}`, obligationId, currency, key, amountMinor, provider, reference, provider ? 1 : null, operatorId(db), AT, DAY);
}

export const count = (db: Db, table: string, where = "1=1"): number =>
  Number((db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number | bigint }).n);
