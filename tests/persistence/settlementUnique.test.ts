/**
 * `settlements.idempotency_key UNIQUE` — the DATABASE constraint, not the service that usually
 * prevents reaching it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS SEPARATELY FROM `ledger.test.ts`'s RETRY TEST. That test proves
 * `LedgerService.settle` recognises a repeat and answers "already done". This one deletes the
 * service from the picture entirely and inserts straight through the repository, because the
 * service check is a CONVENIENCE and the constraint is the GUARANTEE. If someone later reorders
 * the lookup, adds a second write path, or two settlements race inside one transaction, the
 * service check is what fails first and the constraint is what still holds. A guarantee with no
 * test is a guarantee nobody will notice losing.
 *
 * S3A verified this by hand with a throwaway probe and said so in the checkpoint rather than
 * pretending it was covered. This is that probe, made permanent.
 *
 * Disposable v13 database per test, built by the real MIGRATIONS. No merchant data.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../../src/persistence/db";
import { MIGRATIONS } from "../../src/persistence/migrations";
import { LedgerRepository } from "../../src/persistence/ledgerRepository";
import { outstanding } from "../../src/domain/ledger";
import { type TempDir, tempDir } from "../helpers/harness";

let t: TempDir;
let db: Db;
let repo: LedgerRepository;
let operatorId: string;

const OBLIGATION = "o-1";
const KEY = "pay-00000001";

beforeEach(() => {
  t = tempDir();
  db = openDatabase(t.dbPath, MIGRATIONS);
  repo = new LedgerRepository(db);
  operatorId = (db.prepare(`SELECT id FROM operators LIMIT 1`).get() as { id: string }).id;
  db.prepare(
    `INSERT INTO parties (id, kind, display_name, phone, address, note, is_active,
                          created_by, created_at, updated_at)
     VALUES ('p-1', 'customer', 'زبون', NULL, NULL, NULL, 1, ?,
             '2026-10-23T08:00:00.000Z', '2026-10-23T08:00:00.000Z')`,
  ).run(operatorId);
  repo.insertObligation({
    id: OBLIGATION,
    partyId: "p-1",
    partyKind: "customer",
    direction: "receivable",
    sourceKind: "manual",
    sourceRef: "bill-1",
    saleId: null,
    currency: "USD",
    amountMinor: 1000n,
    postedBy: operatorId,
    postedAt: "2026-10-23T08:00:00.000Z",
    businessDate: "2026-10-23",
  });
});
afterEach(() => {
  db.close();
  t.cleanup();
});

const settlement = (id: string, amountMinor: bigint, key = KEY) => ({
  id,
  obligationId: OBLIGATION,
  currency: "USD",
  idempotencyKey: key,
  requestFingerprint: `fp-${id}`,
  amountMinor,
  method: "cash" as const,
  settledBy: operatorId,
  settledAt: "2026-10-23T09:00:00.000Z",
  businessDate: "2026-10-23",
});

const count = (table: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n);

describe("settlements.idempotency_key UNIQUE — the database constraint itself", () => {
  it("🔴 rejects a second insert carrying the same key, and keeps the first intact", () => {
    repo.insertSettlement(settlement("s-1", 400n));

    // Straight through the repository: no service, no duplicate lookup, nothing in the way.
    expect(() => repo.insertSettlement(settlement("s-2", 400n))).toThrow(/UNIQUE/i);

    // 🔴 EXACTLY ONE ROW. Not "at least one" — a second row is the failure this guards.
    expect(count("settlements")).toBe(1);

    const rows = repo.listSettlements(OBLIGATION);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("s-1");
    expect(rows[0]!.amountMinor).toBe(400n);
    expect(rows[0]!.idempotencyKey).toBe(KEY);

    // 🔴 AND THE MONEY IS STILL RIGHT. 1000 owed, 400 paid once -> 600. If the refused insert had
    // landed, this would read 200, and the customer would be told they owe less than they do.
    const o = repo.findObligationById(OBLIGATION)!;
    expect(outstanding(o, rows).minor).toBe(600n);
    expect(repo.settledTotal(OBLIGATION)).toBe(400n);
  });

  it("🔴 rejects it even when the amount differs — the KEY is what is unique", () => {
    // 🔴 500, NOT 999, AND THE REASON IS WORTH KNOWING. A BEFORE INSERT trigger runs before SQLite
    // checks UNIQUE, so 400 + 999 against a 1000 obligation reports OVERPAYMENT and never reaches
    // the key check — the first draft of this test asserted /UNIQUE/ and got the overpayment
    // message. 400 + 500 stays within what is owed, so the duplicate key is the only thing left
    // to refuse it, which is exactly what this test is for.
    repo.insertSettlement(settlement("s-1", 400n));
    expect(() => repo.insertSettlement(settlement("s-2", 500n))).toThrow(/UNIQUE/i);
    expect(count("settlements")).toBe(1);
    expect(repo.settledTotal(OBLIGATION)).toBe(400n);
  });

  it("🔴 an overpaying duplicate reports OVERPAYMENT, not duplication — trigger before constraint", () => {
    // The ordering above, pinned deliberately rather than left as a surprise for the next reader.
    repo.insertSettlement(settlement("s-1", 400n));
    expect(() => repo.insertSettlement(settlement("s-2", 999n))).toThrow(/cannot exceed what is owed/);
    expect(count("settlements")).toBe(1);
    expect(repo.settledTotal(OBLIGATION)).toBe(400n);
  });

  it("🔴 a DIFFERENT key is accepted — the constraint is not refusing everything", () => {
    // 🔴 THE ANTI-VACUITY CONTROL. Without it, a test that broke every insert would still pass the
    // two above, and the constraint could be wrong in the opposite direction unnoticed.
    repo.insertSettlement(settlement("s-1", 400n));
    repo.insertSettlement(settlement("s-2", 350n, "pay-00000002"));
    expect(count("settlements")).toBe(2);
    expect(repo.settledTotal(OBLIGATION)).toBe(750n);

    const o = repo.findObligationById(OBLIGATION)!;
    expect(outstanding(o, repo.listSettlements(OBLIGATION)).minor).toBe(250n);
  });

  it("🔴 the obligation itself is untouched by a refused settlement", () => {
    const before = repo.findObligationById(OBLIGATION)!;
    repo.insertSettlement(settlement("s-1", 400n));
    expect(() => repo.insertSettlement(settlement("s-2", 400n))).toThrow(/UNIQUE/i);
    const after = repo.findObligationById(OBLIGATION)!;
    expect(after).toEqual(before);
    expect(count("obligations")).toBe(1);
  });

  it("🔴 and the constraint survives a transaction rollback around it", () => {
    // A refused insert inside a transaction must leave the earlier committed one alone.
    repo.insertSettlement(settlement("s-1", 400n));
    expect(() =>
      db.transaction(() => {
        repo.insertSettlement(settlement("s-3", 100n, "pay-00000003"));
        repo.insertSettlement(settlement("s-4", 100n)); // same KEY as s-1 -> aborts the whole thing
      }).immediate(),
    ).toThrow(/UNIQUE/i);
    // s-3 went in and came back out with the transaction; s-1 is still there.
    expect(count("settlements")).toBe(1);
    expect(repo.listSettlements(OBLIGATION)[0]!.id).toBe("s-1");
    expect(repo.settledTotal(OBLIGATION)).toBe(400n);
  });
});
