/** Synthetic subprocess for transaction interruption and competing issuance tests. */
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { makeHarness } from "./harness";

const [dbPath, requestPath, readyPath, goPath] = process.argv.slice(2) as [string, string, string, string];
const request = JSON.parse(readFileSync(requestPath, "utf8")) as { id: string; token: string; mode: string; payment?: { method: "cash" } };
const h = makeHarness(dbPath);
writeFileSync(readyPath, "ready");
const until = Date.now() + 15000;
while (!existsSync(goPath)) {
  if (Date.now() > until) process.exit(72);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const deps = (h.invoices as unknown as { deps: { transact: (fn: () => unknown) => unknown } }).deps;
const original = deps.transact;
if (request.mode === "before") deps.transact = (fn) => original(() => { fn(); writeSync(1, "BEFORE_COMMIT\n"); process.exit(70); });
if (request.mode === "after") deps.transact = (fn) => { const result = original(fn); writeSync(1, "AFTER_COMMIT\n"); process.exit(71); return result; };
if (request.mode === "hold") deps.transact = (fn) => original(() => {
  const result = fn(); writeFileSync(goPath + ".holding", "transaction open");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  return result;
});
if (request.mode === "wait") {
  const end = Date.now() + 15000;
  while (!existsSync(goPath + ".holding")) {
    if (Date.now() > end) process.exit(73);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const start = Date.now();
try {
  const result = h.invoices.finalizeInvoice(request.id, { issueOnAccount: true, confirmedDraft: request.token, payment: request.payment });
  writeSync(1, JSON.stringify({ outcome: "success", number: String(result.invoice.invoice_number), elapsedMs: Date.now() - start }) + "\n");
} catch (e) {
  writeSync(1, JSON.stringify({ outcome: "refused", code: (e as { code?: string }).code ?? String(e) }) + "\n");
} finally { h.db.close(); }
