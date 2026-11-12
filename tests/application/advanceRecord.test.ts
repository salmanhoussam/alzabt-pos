/**
 * ADV-RECORD (migration 20 draft, part 1 — G1). Owner decisions D1, D5, D7, D8 (DEC-35q/35r).
 *
 * 🔴 WHAT THESE PROTECT
 *   · owner AND cashier record Cash / Whish advances; an admin, a stranger and Card / Other / bank do not;
 *   · a refused advance leaves NO trace (no intent, no advance, no number consumed);
 *   · the request key alone decides a repeat: same key + same payload → the same ADV, nothing new;
 *     same key + different payload → refused; a genuine second advance (same customer, same amount,
 *     same day, NEW key) is recorded;
 *   · an OPEN intent (a crash between the two transactions) holds new advances for that customer until
 *     it is finished under its own key or closed — and is never auto-closed;
 *   · a failure inside the money transaction consumes no ADV number (no gap);
 *   · an advance is ONE row: no sale, settlement, receipt or obligation is written;
 *   · the database refuses, by trigger, an advance without its open identical intent, a reused closed
 *     key, an edited or deleted intent, and a resolution that lies about the ledger.
 *
 * Synthetic data only; real SQLite; amounts are MINOR units (USD cents).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdvanceService, formatAdvanceNo } from "../../src/application/advanceService";
import { AdvanceRepository, type AdvanceRecord } from "../../src/persistence/advanceRepository";
import { advanceDeps, makeAdvances } from "../helpers/advanceHarness";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;
let adv: AdvanceService;
let n = 0;
const key = () => `adv-test-key-${String(++n).padStart(4, "0")}`;

beforeEach(() => {
  t = tempDir();
  h = makeHarness(t.dbPath);
  adv = makeAdvances(h);
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const customer = (name = "زبون تجريبي") => h.parties.create({ kind: "customer", displayName: name }).party;
const count = (table: string, where = "1=1") =>
  Number((h.db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: bigint }).c);
const lastAdvanceNo = () => Number((h.db.prepare("SELECT last_no FROM document_numbers WHERE kind = 'advance'").get() as { last_no: bigint }).last_no);
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const cash = (customerId: string, k = key(), minor = 2500n) => ({ customerId, amountMinor: minor, channel: "cash", idempotencyKey: k });
const whish = (customerId: string, reference: string, k = key(), minor = 4000n) => ({
  customerId,
  amountMinor: minor,
  channel: "whish",
  reference,
  fundsConfirmed: true,
  idempotencyKey: k,
});
const nothingWritten = () => {
  expect(count("advance_attempts")).toBe(0);
  expect(count("customer_advances")).toBe(0);
  expect(lastAdvanceNo()).toBe(0);
};

describe("record — who, what, and that an advance is only an advance", () => {
  it("the owner records a cash advance: ADV-000001, one row, nothing else", () => {
    const c = customer();
    const r = adv.record(cash(c.id));
    expect(r.duplicate).toBe(false);
    expect(r.record.docNo).toBe(1);
    expect(formatAdvanceNo(r.record.docNo)).toBe("ADV-000001");
    expect(r.record).toMatchObject({ customerId: c.id, currency: "USD", amountMinor: 2500n, method: "cash", provider: null, reference: null, receivedBy: "cashier-01" });
    expect(count("customer_advances")).toBe(1);
    expect(count("advance_attempts", "resolution = 'recorded' AND acknowledged_at IS NULL")).toBe(1);
    for (const table of ["sales", "sale_tenders", "settlements", "receipts", "obligations", "advance_applications", "advance_refunds"]) {
      expect(count(table), table).toBe(0);
    }
  });

  it("a cashier records a Whish advance; the reference is registered once, against the advance", () => {
    const c = customer();
    h.service.login("cashier-02", "2222");
    const r = adv.record(whish(c.id, "WH-88001"));
    expect(r.record).toMatchObject({ method: "external", provider: "whish", reference: "WH-88001", receivedBy: "cashier-02" });
    expect(count("external_references", `owner_kind = 'advance' AND owner_id = '${r.record.id}' AND legacy = 0`)).toBe(1);
  });

  it("an admin, a signed-out terminal and a non-customer are refused, leaving no trace", () => {
    const c = customer();
    const supplier = h.parties.create({ kind: "supplier", displayName: "مورد" }).party;
    expect(code(() => adv.record(cash(supplier.id)))).toBe("PARTY_NOT_FOUND");
    expect(code(() => adv.record(cash("no-such-customer")))).toBe("PARTY_NOT_FOUND");
    h.parties.setActive("customer", c.id, false);
    expect(code(() => adv.record(cash(c.id)))).toBe("PARTY_NOT_FOUND");
    h.parties.setActive("customer", c.id, true);
    h.db.prepare("UPDATE operators SET role = 'admin' WHERE id = 'cashier-01'").run();
    expect(code(() => adv.record(cash(c.id)))).toBe("NOT_AUTHORIZED");
    h.db.prepare("UPDATE operators SET role = 'owner' WHERE id = 'cashier-01'").run();
    h.service.logout();
    expect(code(() => adv.record(cash(c.id)))).toBe("NOT_LOGGED_IN");
    nothingWritten();
  });

  it("only Cash and Whish Money: Card, Other and bank transfer are refused (P3), leaving no trace", () => {
    const c = customer();
    for (const channel of ["card", "other", "bank_transfer", "external", "credit"]) {
      expect(code(() => adv.record({ ...cash(c.id), channel })), channel).toBe("PAYMENT_METHOD_NOT_ACCEPTED");
    }
    nothingWritten();
  });

  it("amount, key, reference and confirmation are validated before anything is written", () => {
    const c = customer();
    expect(code(() => adv.record(cash(c.id, key(), 0n)))).toBe("INVALID_AMOUNT");
    expect(code(() => adv.record({ ...cash(c.id), amountMinor: 25 }))).toBe("NOT_EXACT");
    expect(code(() => adv.record(cash(c.id, key(), 10n ** 16n)))).toBe("MONEY_OUT_OF_RANGE");
    expect(code(() => adv.record(cash(c.id, "short")))).toBe("INVALID_INPUT");
    expect(code(() => adv.record({ ...cash(c.id), reference: "R-1" }))).toBe("INVALID_INPUT");
    expect(code(() => adv.record({ ...cash(c.id), fundsConfirmed: true }))).toBe("INVALID_INPUT");
    expect(code(() => adv.record(whish(c.id, "")))).toBe("INVALID_INPUT");
    expect(code(() => adv.record({ ...whish(c.id, "WH-1"), fundsConfirmed: false }))).toBe("FUNDS_NOT_CONFIRMED");
    expect(code(() => adv.record(whish(c.id, "4111 1111 1111 1111")))).toBe("INVALID_INPUT"); // a card number is never stored
    nothingWritten();
  });

  it("a Whish reference already used — by another advance, or written differently — is refused before any intent", () => {
    const c = customer();
    adv.record(whish(c.id, "WH-7001"));
    expect(code(() => adv.record(whish(c.id, "WH-7001")))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(code(() => adv.record(whish(c.id, "wh 7001")))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(code(() => adv.record(whish(c.id, "WH-٧٠٠١")))).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(count("advance_attempts")).toBe(1);
    expect(count("customer_advances")).toBe(1);
  });
});

describe("idempotency — the request key, and only the key", () => {
  it("an exact repeat returns the SAME advance and writes nothing", () => {
    const c = customer();
    const k = key();
    const first = adv.record(cash(c.id, k));
    const again = adv.record(cash(c.id, k));
    expect(again.duplicate).toBe(true);
    expect(again.record.id).toBe(first.record.id);
    expect(again.record.docNo).toBe(1);
    expect(count("customer_advances")).toBe(1);
    expect(count("advance_attempts")).toBe(1);
    expect(lastAdvanceNo()).toBe(1);
  });

  it("the same key with a different amount is refused loudly", () => {
    const c = customer();
    const k = key();
    adv.record(cash(c.id, k, 2500n));
    expect(code(() => adv.record(cash(c.id, k, 2600n)))).toBe("IDEMPOTENCY_CONFLICT");
    expect(count("customer_advances")).toBe(1);
  });

  it("🔴 two GENUINE advances — same customer, same amount, same day, new keys — are both recorded", () => {
    const c = customer();
    const a = adv.record(cash(c.id, key(), 1000n));
    const b = adv.record(cash(c.id, key(), 1000n));
    expect([a.record.docNo, b.record.docNo]).toEqual([1, 2]);
    expect(count("customer_advances", `customer_id = '${c.id}'`)).toBe(2);
  });

  it("an advance is allowed for a customer who owes a debt, and settles nothing (D8)", () => {
    const c = customer();
    h.ledger.postObligation({ partyId: c.id, direction: "receivable", sourceKind: "manual", sourceRef: "debt-1", currency: "USD", amountMinor: 5000n });
    adv.record(cash(c.id));
    expect(count("settlements")).toBe(0);
    expect(count("advance_applications")).toBe(0);
  });
});

/** Stands in for a crash BETWEEN the two transactions (the real process death is in advanceCrash.test.ts). */
class DiesAfterIntent extends AdvanceService {
  protected override afterIntentCommitted(): void {
    throw new Error("simulated death after the intent committed");
  }
}
/** A failure INSIDE the money transaction, after the ADV number was issued and the advance inserted. */
class FailsAfterInsert extends AdvanceRepository {
  override insertAdvance(a: AdvanceRecord): void {
    super.insertAdvance(a);
    throw new Error("simulated failure inside the money transaction");
  }
}

describe("crash safety — open intents are answered, never guessed", () => {
  it("an OPEN intent holds new advances for THAT customer only, and is never auto-closed", () => {
    const c = customer("أ");
    const other = customer("ب");
    const k = key();
    expect(() => new DiesAfterIntent(advanceDeps(h)).record(cash(c.id, k))).toThrow("simulated death");
    expect(count("advance_attempts", "resolution IS NULL")).toBe(1);
    expect(count("customer_advances")).toBe(0);
    expect(code(() => adv.record(cash(c.id)))).toBe("ADVANCE_UNRESOLVED");
    expect(adv.record(cash(other.id)).record.docNo).toBe(1);
    const p = adv.pending().find((x) => x.key === k);
    expect(p?.status).toBe("open");
    expect(count("advance_attempts", "resolution IS NULL")).toBe(1); // pending() wrote nothing
  });

  it("finishing an open intent records it under its ORIGINAL key; a retry of that key returns it", () => {
    const c = customer();
    const k = key();
    expect(() => new DiesAfterIntent(advanceDeps(h)).record(cash(c.id, k))).toThrow();
    const done = adv.finish(k);
    expect(done.record).toMatchObject({ key: k, docNo: 1, amountMinor: 2500n });
    expect(adv.record(cash(c.id, k)).duplicate).toBe(true);
    expect(count("customer_advances")).toBe(1);
  });

  it("closing an open intent is final: the key can never be recorded later; a new key then works", () => {
    const c = customer();
    const k = key();
    expect(() => new DiesAfterIntent(advanceDeps(h)).record(cash(c.id, k))).toThrow();
    adv.close(k);
    expect(adv.pending().some((p) => p.key === k)).toBe(false); // closed AND acknowledged
    expect(code(() => adv.record(cash(c.id, k)))).toBe("IDEMPOTENCY_CONFLICT");
    expect(code(() => adv.finish(k))).toBe("IDEMPOTENCY_CONFLICT");
    expect(adv.record(cash(c.id)).record.docNo).toBe(1);
  });

  it("a cashier cannot close another operator's open intent; the owner can", () => {
    const c = customer();
    const k = key();
    expect(() => new DiesAfterIntent(advanceDeps(h)).record(cash(c.id, k))).toThrow(); // started by the owner
    h.service.login("cashier-02", "2222");
    expect(code(() => adv.close(k))).toBe("NOT_AUTHORIZED");
    h.service.login("cashier-01", "1111");
    adv.close(k);
    expect(count("advance_attempts", "resolution = 'not_recorded'")).toBe(1);
  });

  it("🔴 a failure inside the money transaction consumes NO number; finishing then issues ADV-000001", () => {
    const c = customer();
    const k = key();
    const failing = makeAdvances(h, new FailsAfterInsert(h.db));
    expect(() => failing.record(cash(c.id, k))).toThrow("simulated failure");
    expect(count("customer_advances")).toBe(0);
    expect(lastAdvanceNo()).toBe(0);
    expect(count("advance_attempts", "resolution IS NULL")).toBe(1); // left OPEN: an unknown failure proves nothing
    expect(adv.finish(k).record.docNo).toBe(1);
  });

  it("recorded-but-unseen advances are listed with their receipt until acknowledged; they block nothing", () => {
    const c = customer();
    const r = adv.record(cash(c.id));
    const p = adv.pending();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ status: "recorded", key: r.record.key });
    expect(adv.record(cash(c.id)).record.docNo).toBe(2);
    adv.acknowledge(r.record.key);
    adv.acknowledge(r.record.key); // idempotent
    expect(adv.pending().map((x) => x.key)).not.toContain(r.record.key);
  });

  it("an open intent cannot be acknowledged as if it were settled", () => {
    const c = customer();
    const k = key();
    expect(() => new DiesAfterIntent(advanceDeps(h)).record(cash(c.id, k))).toThrow();
    expect(code(() => adv.acknowledge(k))).toBe("ADVANCE_UNRESOLVED");
  });
});

describe("database backstops (migration 20) — even direct SQL cannot cheat", () => {
  const raw = (sql: string, ...args: unknown[]) => () => h.db.prepare(sql).run(...args);
  const directAdvance = (k: string, fp: string, cust: string) =>
    raw(
      `INSERT INTO customer_advances (id, doc_no, customer_id, currency, amount_minor, method, idempotency_key, request_fingerprint,
                                      received_by, received_at, business_date) VALUES ('direct-1', 1, ?, 'USD', 100, 'cash', ?, ?,
                                      'cashier-01', '2026-11-11T10:00:00.000Z', '2026-11-11')`,
      cust,
      k,
      fp,
    );

  it("an advance without its open, identical intent is refused", () => {
    const c = customer();
    h.db.prepare("UPDATE document_numbers SET last_no = 1 WHERE kind = 'advance'").run();
    expect(directAdvance("direct-key-0001", "fp", c.id)).toThrow(/needs its open, identical attempt/);
  });

  it("an intent is frozen, resolved once, acknowledged once, never deleted, and never lies", () => {
    const c = customer();
    const k = key();
    expect(() => new DiesAfterIntent(advanceDeps(h)).record(cash(c.id, k))).toThrow();
    expect(raw("UPDATE advance_attempts SET amount_minor = 1 WHERE idempotency_key = ?", k)).toThrow(/resolved once/);
    expect(raw("DELETE FROM advance_attempts WHERE idempotency_key = ?", k)).toThrow(/cannot be deleted/);
    expect(raw("UPDATE advance_attempts SET resolution = 'recorded', resolved_at = 'x' WHERE idempotency_key = ?", k)).toThrow(/must match the ledger/);
    adv.close(k);
    expect(raw("UPDATE advance_attempts SET resolution = 'recorded' WHERE idempotency_key = ?", k)).toThrow(/resolved once/);
    expect(raw("UPDATE advance_attempts SET acknowledged_at = 'later' WHERE idempotency_key = ?", k)).toThrow(/acknowledged once/);
  });

  it("a key closed as not recorded can never carry an advance, even by direct SQL", () => {
    const c = customer();
    const k = key();
    expect(() => new DiesAfterIntent(advanceDeps(h)).record(cash(c.id, k))).toThrow();
    const fp = (h.db.prepare("SELECT request_fingerprint AS f FROM advance_attempts WHERE idempotency_key = ?").get(k) as { f: string }).f;
    adv.close(k);
    h.db.prepare("UPDATE document_numbers SET last_no = 1 WHERE kind = 'advance'").run();
    expect(directAdvance(k, fp, c.id)).toThrow(/needs its open, identical attempt/);
  });
});
