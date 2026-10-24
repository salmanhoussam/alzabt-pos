/**
 * Durable exactly-once posting of one batch of invoice-draft lines (migration 15).
 *
 * 🔴 THE RISK. A batch that COMMITS and then loses its response left a sheet still holding the rows
 * as unsaved; sending them again inserted them twice, and the service could not tell, because two
 * identical lines are legitimate. The caller now names the batch and the ledger remembers the name,
 * atomically with the lines. Every test below runs against the real SQLite runtime.
 *
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { type Harness, type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
let h: Harness;

function open(): void {
  h = makeHarness(t.dbPath);
  h.service.login("cashier-01", "1111");
}
beforeEach(() => {
  t = tempDir();
  open();
  h.invoices.saveCompanyProfile({ nameAr: "متجر اختباري" });
});
afterEach(() => {
  h.db.close();
  t.cleanup();
});

const row = (description: string, quantity = "1", unitPrice = "2.00") => ({
  description,
  unitLabel: "حبة",
  canonicalUnit: null,
  productId: null,
  quantity,
  unitPrice,
});
const lines = (id: string) => h.invoices.getInvoice(id).lines;
const batches = (id?: string): number => {
  const r = (
    id
      ? h.db.prepare("SELECT count(*) AS n FROM invoice_line_batches WHERE invoice_id = ?").get(id)
      : h.db.prepare("SELECT count(*) AS n FROM invoice_line_batches").get()
  ) as { n: bigint };
  return Number(r.n);
};
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "NO_ERROR";
};
/** The transport: the service commits, then the answer never reaches the caller. */
function sendLosingResponse(id: string, rows: ReturnType<typeof row>[], key: string): void {
  h.invoices.addLines(id, rows, key);
  throw new Error("response lost");
}

describe("a batch is written once, with its identity, atomically", () => {
  it("writes an ordered multi-line batch and exactly one marker", () => {
    const { invoice } = h.invoices.createDraft();
    const view = h.invoices.addLines(invoice.id, [row("أ"), row("ب"), row("ج")], "batch-key-0001");
    expect(view.lines.map((l) => l.description)).toEqual(["أ", "ب", "ج"]);
    expect(batches(invoice.id)).toBe(1);
    const marker = h.db.prepare("SELECT line_count AS n, length(request_fingerprint) AS f FROM invoice_line_batches").get() as {
      n: number | bigint;
      f: number | bigint;
    };
    expect(Number(marker.n)).toBe(3);
    expect(Number(marker.f)).toBe(64);
  });

  it("two identical lines submitted together stay TWO lines", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [row("نفس الصنف"), row("نفس الصنف")], "batch-key-0002");
    expect(lines(invoice.id)).toHaveLength(2);
  });

  it("a key is mandatory and must be well formed", () => {
    const { invoice } = h.invoices.createDraft();
    expect(refusal(() => h.invoices.addLines(invoice.id, [row("أ")], "short"))).toBe("INVALID_INPUT");
    expect(refusal(() => h.invoices.addLines(invoice.id, [row("أ")], "has spaces in it!"))).toBe("INVALID_INPUT");
    expect(lines(invoice.id)).toHaveLength(0);
  });
});

describe("replay and conflict", () => {
  it("🔴 the same key and payload never inserts again — and a changed key is a NEW batch", () => {
    const { invoice } = h.invoices.createDraft();
    const batch = [row("أ"), row("ب")];
    h.invoices.addLines(invoice.id, batch, "batch-key-0003");
    const again = h.invoices.addLines(invoice.id, batch, "batch-key-0003");
    expect(again.lines).toHaveLength(2);
    expect(batches(invoice.id)).toBe(1);
    h.invoices.addLines(invoice.id, batch, "batch-key-0004"); // an intentional second batch
    expect(lines(invoice.id)).toHaveLength(4);
  });

  it("the same key with a changed payload is IDEMPOTENCY_CONFLICT and writes nothing", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [row("أ")], "batch-key-0005");
    for (const changed of [[row("ب")], [row("أ", "2")], [row("أ"), row("أ")], [row("أ", "1", "3.00")]]) {
      expect(refusal(() => h.invoices.addLines(invoice.id, changed, "batch-key-0005"))).toBe("IDEMPOTENCY_CONFLICT");
    }
    expect(lines(invoice.id)).toHaveLength(1);
  });

  it("the same key against a DIFFERENT invoice is a conflict", () => {
    const a = h.invoices.createDraft().invoice;
    const b = h.invoices.createDraft().invoice;
    h.invoices.addLines(a.id, [row("أ")], "batch-key-0006");
    expect(refusal(() => h.invoices.addLines(b.id, [row("أ")], "batch-key-0006"))).toBe("IDEMPOTENCY_CONFLICT");
    expect(lines(b.id)).toHaveLength(0);
  });
});

describe("lost response and restart", () => {
  it("🔴 a response lost AFTER COMMIT is recovered by re-sending under the same key — without trusting counts", () => {
    const { invoice } = h.invoices.createDraft();
    const batch = [row("أ"), row("ب")];
    expect(() => sendLosingResponse(invoice.id, batch, "batch-key-0007")).toThrow("response lost");
    expect(lines(invoice.id)).toHaveLength(2);
    const recovered = h.invoices.addLines(invoice.id, batch, "batch-key-0007");
    expect(recovered.lines).toHaveLength(2); // no duplicates
    expect(batches(invoice.id)).toBe(1);
  });

  it("survives closing and reopening the database", () => {
    const { invoice } = h.invoices.createDraft();
    const batch = [row("أ"), row("أ")];
    expect(() => sendLosingResponse(invoice.id, batch, "batch-key-0008")).toThrow();
    h.db.close();
    open();
    expect(h.invoices.addLines(invoice.id, batch, "batch-key-0008").lines).toHaveLength(2);
    expect(refusal(() => h.invoices.addLines(invoice.id, [row("غير")], "batch-key-0008"))).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("an absent key — a refusal before commit — leaves no lines and no marker, and the SAME key then works", () => {
    const { invoice } = h.invoices.createDraft();
    expect(refusal(() => h.invoices.addLines(invoice.id, [row("جيد"), row("سيّئ", "abc")], "batch-key-0009"))).not.toBe("NO_ERROR");
    expect(lines(invoice.id)).toHaveLength(0);
    expect(batches()).toBe(0);
    h.invoices.addLines(invoice.id, [row("جيد"), row("سيّئ")], "batch-key-0009");
    expect(lines(invoice.id)).toHaveLength(2);
  });

  it("🔴 a failure AFTER the lines but BEFORE the marker commits neither", () => {
    const { invoice } = h.invoices.createDraft();
    h.db.exec(
      "CREATE TRIGGER test_marker_fails BEFORE INSERT ON invoice_line_batches BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    expect(() => h.invoices.addLines(invoice.id, [row("أ"), row("ب")], "batch-key-0010")).toThrow();
    expect(lines(invoice.id)).toHaveLength(0);
    expect(batches()).toBe(0);
    h.db.exec("DROP TRIGGER test_marker_fails");
    h.invoices.addLines(invoice.id, [row("أ"), row("ب")], "batch-key-0010");
    expect(lines(invoice.id)).toHaveLength(2);
  });
});

describe("a batch is history, not a recipe", () => {
  it("🔴 a replay does not recreate lines edited or deleted since", () => {
    const { invoice } = h.invoices.createDraft();
    const batch = [row("أ"), row("ب")];
    const first = h.invoices.addLines(invoice.id, batch, "batch-key-0011");
    h.invoices.removeLine(invoice.id, first.lines[0]!.id);
    const replay = h.invoices.addLines(invoice.id, batch, "batch-key-0011");
    expect(replay.lines.map((l) => l.description)).toEqual(["ب"]);
    expect(batches(invoice.id)).toBe(1);
  });

  it("after finalization a replay is still answered, a new key is refused, and the document is unchanged", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [row("أ", "1", "10.00")], "batch-key-0012");
    const final = h.invoices.finalizeInvoice(invoice.id).invoice;
    const replay = h.invoices.addLines(invoice.id, [row("أ", "1", "10.00")], "batch-key-0012");
    expect(replay.invoice.total_minor).toBe(final.total_minor);
    expect(replay.invoice.invoice_number).toBe(final.invoice_number);
    expect(replay.lines).toHaveLength(1);
    expect(refusal(() => h.invoices.addLines(invoice.id, [row("ب")], "batch-key-0013"))).toBe("INVOICE_NOT_DRAFT");
    expect(batches(invoice.id)).toBe(1);
  });

  it("discarding a draft removes its markers with it", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [row("أ")], "batch-key-0014");
    h.invoices.discardDraft(invoice.id);
    expect(batches()).toBe(0);
    expect(h.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("the marker is immutable", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [row("أ")], "batch-key-0015");
    expect(() => h.db.prepare("UPDATE invoice_line_batches SET line_count = 9").run()).toThrow(/immutable/);
  });
});

describe("damaged records are never reported as success", () => {
  it("an inconsistent recorded size is LEDGER_INTEGRITY", () => {
    const { invoice } = h.invoices.createDraft();
    h.invoices.addLines(invoice.id, [row("أ")], "batch-key-0016");
    h.db.exec("DROP TRIGGER invoice_line_batches_immutable");
    h.db.exec("UPDATE invoice_line_batches SET line_count = 5");
    expect(refusal(() => h.invoices.addLines(invoice.id, [row("أ")], "batch-key-0016"))).toBe("LEDGER_INTEGRITY");
  });

  it("a malformed fingerprint cannot even be stored", () => {
    const { invoice } = h.invoices.createDraft();
    expect(() =>
      h.db
        .prepare(
          "INSERT INTO invoice_line_batches (id, invoice_id, idempotency_key, request_fingerprint, line_count, created_at) VALUES ('x', ?, 'batch-key-0017', 'not-hex', 1, 'now')",
        )
        .run(invoice.id),
    ).toThrow();
  });
});
