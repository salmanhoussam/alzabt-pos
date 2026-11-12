/**
 * Records ONE cash advance in a SEPARATE Node process and kills itself (SIGKILL / TerminateProcess) at
 * a chosen point, so the parent test can reopen the ledger and see what a real abrupt death leaves.
 * Nothing runs after the kill: no finally, no rollback handler, no db.close().
 *
 * usage: node --import tsx advanceCrashChild.ts <mode> <dbPath> <customerId> <key>
 *   after-intent          die right after Tx1 (the intent) committed — before any money row
 *   inside-money-tx       die inside Tx2, AFTER the ADV number was issued and the advance inserted,
 *                         BEFORE the commit
 *   after-money-commit    die right after Tx2 committed — before the receipt could be shown
 *   correct-inside-tx     G2: die inside the correction transaction, AFTER the correction row, the
 *                         successor's ADV number and the successor were written, BEFORE the commit
 *   correct-after-commit  G2: die right after the correction committed — before the reply
 *   apply-inside-tx       DEC-35x: die inside the application transaction, AFTER the settlement was
 *                         written, BEFORE the application row and the commit (3rd arg = advance id,
 *                         env APPLY_DEBT = the obligation id; 1000 applied)
 *   apply-after-commit    DEC-35x: die right after the application committed — before the reply
 *   sale-inside-tx        DEC-35x: sell on an advance and die AFTER the sale + receivable were written,
 *                         BEFORE the application and the commit (3rd arg = advance id, env SALE_CUSTOMER)
 *   sale-after-commit     DEC-35y: sell on an advance, die right AFTER the commit — the reply is lost
 *   sale-run              DEC-35y: NOT a crash — sell on an advance (env SALE_AMOUNT) and print the outcome
 *                         as one JSON line; used to race two real processes on one advance
 *   refund-inside-tx      DEC-35z+: refund 400 from the advance (3rd arg = advance id) and die INSIDE the
 *                         transaction, AFTER the REF number was issued, BEFORE the refund row and commit
 *   refund-after-commit   DEC-35z+: refund 400, die right AFTER the commit — the reply is lost
 *   refund-run            DEC-35z+: NOT a crash — refund env REFUND_AMOUNT and print the outcome as one
 *                         JSON line; used to race two real processes on one advance
 */
import { writeSync } from "node:fs";
import { AdvanceService } from "../../src/application/advanceService";
import { AdvanceRepository, type AdvanceRecord } from "../../src/persistence/advanceRepository";
import { advanceDeps } from "./advanceHarness";
import { makeHarness } from "./harness";

const [mode, dbPath, customerId, key] = process.argv.slice(2);
if (!mode || !dbPath || !customerId || !key) throw new Error("usage: advanceCrashChild <mode> <dbPath> <customerId> <key>");

const die = (): never => {
  writeSync(2, "KILL-POINT-REACHED\n");
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

class DieInsideMoneyTx extends AdvanceRepository {
  override insertAdvance(a: AdvanceRecord): void {
    super.insertAdvance(a);
    die();
  }
}
class DieAfterIntent extends AdvanceService {
  protected override afterIntentCommitted(): void {
    die();
  }
}
class DieAfterMoney extends AdvanceService {
  protected override afterAdvanceCommitted(): void {
    die();
  }
}

class DieInsideApply extends AdvanceService {
  protected override afterApplicationSettlementWritten(): void {
    die();
  }
}
class DieAfterApply extends AdvanceService {
  override applyToDebt(d: Parameters<AdvanceService["applyToDebt"]>[0]): ReturnType<AdvanceService["applyToDebt"]> {
    super.applyToDebt(d);
    return die();
  }
}

class DieInsideSale extends AdvanceService {
  protected override afterSaleOnAdvanceWritten(): void {
    die();
  }
}

class DieAfterSale extends AdvanceService {
  override sellOnAdvance(d: Parameters<AdvanceService["sellOnAdvance"]>[0]): ReturnType<AdvanceService["sellOnAdvance"]> {
    super.sellOnAdvance(d);
    return die();
  }
}

class DieInsideRefund extends AdvanceService {
  protected override afterRefundNumberIssued(): void {
    die();
  }
}
class DieAfterRefund extends AdvanceService {
  protected override afterRefundCommitted(): void {
    die();
  }
}

class DieAfterCorrection extends AdvanceService {
  protected override afterCorrectionCommitted(): void {
    die();
  }
}

const h = makeHarness(dbPath);
const draft = { customerId, amountMinor: 2500n, channel: "cash", idempotencyKey: key };
// G2 modes: the 3rd argument is then the ADVANCE id; the correction lowers 2500 → 2000 (declared).
const correction = { advanceId: customerId, kind: "replaced", amountMinor: 2000n, confirmNotReceived: true, reason: "المبلغ أقل", idempotencyKey: key };
const apply = { advanceId: customerId, obligationId: process.env.APPLY_DEBT ?? "", amountMinor: 1000n, idempotencyKey: key };
const saleDraft = (amount: bigint) => ({ idempotencyKey: key, customerId: process.env.SALE_CUSTOMER ?? "", lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n, advanceId: customerId, amountMinor: amount });
if (mode === "sale-run") {
  try {
    const r = new AdvanceService(advanceDeps(h)).sellOnAdvance(saleDraft(BigInt(process.env.SALE_AMOUNT ?? "200")));
    writeSync(1, JSON.stringify({ ok: true, saleId: r.sale.id, duplicate: r.duplicate }) + String.fromCharCode(10));
  } catch (e) {
    writeSync(1, JSON.stringify({ ok: false, code: (e as { code?: string }).code ?? String((e as Error).message) }) + String.fromCharCode(10));
  }
  h.db.close();
  process.exit(0);
}
// DEC-35zz++ Option A: env REFUND_CONFIRM_REPEAT=1 sends the owner's "new refund" confirmation (a 2nd refund of the same advance today).
const refundDraft = (amount: bigint) => ({ advanceId: customerId, amountMinor: amount, reason: "الزبون طلب استرداد", idempotencyKey: key, ...(process.env.REFUND_CONFIRM_REPEAT === "1" ? { confirmRepeat: true } : {}) });
if (mode === "refund-run") {
  try {
    const r = new AdvanceService(advanceDeps(h)).refund(refundDraft(BigInt(process.env.REFUND_AMOUNT ?? "400")));
    writeSync(1, JSON.stringify({ ok: true, docNo: r.refund.docNo, duplicate: r.duplicate }) + String.fromCharCode(10));
  } catch (e) {
    writeSync(1, JSON.stringify({ ok: false, code: (e as { code?: string }).code ?? String((e as Error).message) }) + String.fromCharCode(10));
  }
  h.db.close();
  process.exit(0);
}
if (mode === "refund-inside-tx") new DieInsideRefund(advanceDeps(h)).refund(refundDraft(400n));
else if (mode === "refund-after-commit") new DieAfterRefund(advanceDeps(h)).refund(refundDraft(400n));
else if (mode === "sale-after-commit") new DieAfterSale(advanceDeps(h)).sellOnAdvance(saleDraft(200n));
else if (mode === "sale-inside-tx")
  new DieInsideSale(advanceDeps(h)).sellOnAdvance({ idempotencyKey: key, customerId: process.env.SALE_CUSTOMER ?? "", lines: [{ productId: "prod-0001", quantityMilli: 2000 }], expectedTotalMinor: 500n, advanceId: customerId, amountMinor: 200n });
else if (mode === "apply-inside-tx") new DieInsideApply(advanceDeps(h)).applyToDebt(apply);
else if (mode === "apply-after-commit") new DieAfterApply(advanceDeps(h)).applyToDebt(apply);
else if (mode === "correct-inside-tx") new AdvanceService(advanceDeps(h, new DieInsideMoneyTx(h.db))).correct(correction);
else if (mode === "correct-after-commit") new DieAfterCorrection(advanceDeps(h)).correct(correction);
else if (mode === "after-intent") new DieAfterIntent(advanceDeps(h)).record(draft);
else if (mode === "inside-money-tx") new AdvanceService(advanceDeps(h, new DieInsideMoneyTx(h.db))).record(draft);
else if (mode === "after-money-commit") new DieAfterMoney(advanceDeps(h)).record(draft);
else throw new Error(`unknown mode ${mode}`);
throw new Error("the child was supposed to die before this line");
