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

class DieAfterCorrection extends AdvanceService {
  protected override afterCorrectionCommitted(): void {
    die();
  }
}

const h = makeHarness(dbPath);
const draft = { customerId, amountMinor: 2500n, channel: "cash", idempotencyKey: key };
// G2 modes: the 3rd argument is then the ADVANCE id; the correction lowers 2500 → 2000 (declared).
const correction = { advanceId: customerId, kind: "replaced", amountMinor: 2000n, confirmNotReceived: true, reason: "المبلغ أقل", idempotencyKey: key };
if (mode === "correct-inside-tx") new AdvanceService(advanceDeps(h, new DieInsideMoneyTx(h.db))).correct(correction);
else if (mode === "correct-after-commit") new DieAfterCorrection(advanceDeps(h)).correct(correction);
else if (mode === "after-intent") new DieAfterIntent(advanceDeps(h)).record(draft);
else if (mode === "inside-money-tx") new AdvanceService(advanceDeps(h, new DieInsideMoneyTx(h.db))).record(draft);
else if (mode === "after-money-commit") new DieAfterMoney(advanceDeps(h)).record(draft);
else throw new Error(`unknown mode ${mode}`);
throw new Error("the child was supposed to die before this line");
