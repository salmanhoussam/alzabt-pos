/**
 * DEC-35z+ COL — records ONE cash collection in a SEPARATE Node process and kills itself (SIGKILL /
 * TerminateProcess) at a chosen point, so the parent test can reopen the ledger and see what a real
 * abrupt death leaves. Nothing runs after the kill: no finally, no rollback handler, no db.close().
 *
 * usage: node --import tsx collectionCrashChild.ts <mode> <dbPath> <customerId> <obligationId> <key>
 *   inside-tx      die INSIDE the money transaction, AFTER the settlement and its COL document were
 *                  written, BEFORE the commit
 *   after-commit   die right after the collection committed — the reply is lost
 *   run            NOT a crash — collect env AMOUNT (default 100) and print the outcome as one JSON line
 */
import { writeSync } from "node:fs";
import { LedgerRepository } from "../../src/persistence/ledgerRepository";
import { makeHarness } from "./harness";

const [mode, dbPath, customerId, obligationId, key] = process.argv.slice(2);
if (!mode || !dbPath || !customerId || !obligationId || !key) throw new Error("usage: collectionCrashChild <mode> <dbPath> <customerId> <obligationId> <key>");

const die = (): never => {
  writeSync(2, "KILL-POINT-REACHED\n");
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

class DieAfterDocument extends LedgerRepository {
  override insertCollectionDocument(d: Parameters<LedgerRepository["insertCollectionDocument"]>[0]): void {
    super.insertCollectionDocument(d);
    die();
  }
}

const h = makeHarness(dbPath, mode === "inside-tx" ? { ledgerRepository: (db) => new DieAfterDocument(db) } : {});
const draft = {
  customerId,
  obligationId,
  partyId: customerId,
  idempotencyKey: key,
  amountMinor: BigInt(process.env.AMOUNT ?? "100"),
  method: "cash" as const,
  channel: "cash" as const,
};
if (mode === "run") {
  try {
    const r = h.ledger.collect(draft);
    writeSync(1, JSON.stringify({ ok: true, settlementId: r.record.id, duplicate: r.duplicate }) + String.fromCharCode(10));
  } catch (e) {
    writeSync(1, JSON.stringify({ ok: false, code: (e as { code?: string }).code ?? String((e as Error).message) }) + String.fromCharCode(10));
  }
  h.db.close();
  process.exit(0);
}
if (mode === "inside-tx") h.ledger.collect(draft);
else if (mode === "after-commit") {
  h.ledger.collect(draft);
  die();
} else throw new Error(`unknown mode ${mode}`);
throw new Error("the child was supposed to die before this line");
