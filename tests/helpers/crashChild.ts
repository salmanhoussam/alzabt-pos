/**
 * Runs in a SEPARATE Node process and kills itself with SIGKILL at a chosen point, so the parent
 * test can open the database afterwards and observe what a real abrupt process death leaves
 * behind. SIGKILL cannot be caught: no finally-block, no rollback handler and no db.close() runs.
 *
 * usage: node --import tsx crashChild.ts <mode> <dbPath>
 *   kill-mid-transaction   die after header + 2 lines are written inside the real transaction
 *   kill-no-transaction    NEGATIVE CONTROL: same point, but the steps run without a transaction
 *   commit-then-kill       complete a sale normally, then die immediately without closing the DB
 */
import { writeSync } from "node:fs";
import type { Db } from "../../src/persistence/db";
import { type NewSaleHeader, type NewSaleLine, SaleRepository } from "../../src/persistence/saleRepository";
import { makeHarness } from "./harness";

const [mode, dbPath] = process.argv.slice(2);
if (!mode || !dbPath) throw new Error("usage: crashChild <mode> <dbPath>");

export const KILL_POINT_MARKER = "KILL-POINT-REACHED";

const die = (): never => {
  // Synchronous write, so the parent can prove the kill happened at the intended point — on
  // Windows a killed process reports an exit code, not a signal.
  writeSync(2, `${KILL_POINT_MARKER}\n`);
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

class KillAfterSecondLine extends SaleRepository {
  protected override insertSaleLine(saleId: string, line: NewSaleLine): void {
    super.insertSaleLine(saleId, line);
    if (line.lineNo === 2) die();
  }
}

class KillAfterSecondLineNoTx extends KillAfterSecondLine {
  override commitSale(header: NewSaleHeader, lines: ReadonlyArray<NewSaleLine>): number {
    const receipt = this.nextReceiptNumber();
    this.insertSaleHeader(header, receipt, lines.length);
    for (const line of lines) this.insertSaleLine(header.id, line);
    return receipt;
  }
}

const repositories: Record<string, ((db: Db) => SaleRepository) | undefined> = {
  "kill-mid-transaction": (db) => new KillAfterSecondLine(db),
  "kill-no-transaction": (db) => new KillAfterSecondLineNoTx(db),
  "commit-then-kill": undefined,
};
if (!(mode in repositories)) throw new Error(`unknown mode ${mode}`);

const { service } = makeHarness(dbPath, { repository: repositories[mode] });
service.createSale({
  idempotencyKey: `crash-child-${mode}`,
  lines: [
    { productId: "prod-0001", quantity: 2 },
    { productId: "prod-0005", quantity: 1 },
    { productId: "prod-0007", quantity: 3 },
  ],
  paymentMethod: "cash",
  expectedTotalMinor: 1955n,
});
// Only commit-then-kill gets here.
die();
