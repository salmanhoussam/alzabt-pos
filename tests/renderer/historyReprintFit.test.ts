/**
 * J1-PHASE5 U-3 — wiring: History's reprint asks LedgerReceipt for fit mode, and the detail is the column that gives it
 * a height. Asserted on the parsed source (ast-free but structural: the exact JSX element and prop), because
 * HistoryScreen needs a live session to mount. The geometry is measured in the real app (claude-ux-scaling).
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Comments are removed first, so a comment that merely MENTIONS the code can never satisfy these assertions.
const code = (f: string) =>
  readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const src = code("src/renderer/screens/HistoryScreen.tsx");
const ledger = code("src/renderer/screens/LedgerReceipt.tsx");

it("the reprint is rendered with copy AND fit, inside .history-detail", () => {
  expect(src).toMatch(/<LedgerReceipt saleId=\{open\.sale\.id\} copy fit \/>/);
  const detail = src.indexOf('className="history-detail"');
  const reprint = src.indexOf("<LedgerReceipt saleId={open.sale.id} copy fit />");
  expect(detail).toBeGreaterThan(-1);
  expect(reprint).toBeGreaterThan(detail);
});

it("LedgerReceipt forwards fit to Receipt only when given (completed sale keeps its default)", () => {
  expect(ledger).toMatch(/\{\.\.\.\(fit !== undefined \? \{ fit \} : \{\}\)\}/);
});
