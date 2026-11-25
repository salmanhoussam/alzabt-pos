import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

// Fail if any startup diagnostic captures process.argv, including nested properties.
function startupDiagnosticIsPrivate(source: string): boolean {
  const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  let count = 0;
  let unsafe = false;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "diag" &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "main-start") {
      count++;
      for (const arg of node.arguments.slice(1)) {
        if (/\bprocess\s*\.\s*argv\b/.test(arg.getText(file))) unsafe = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return count === 1 && !unsafe;
}
it("startup diagnostic excludes command-line arguments", () => {
  expect(startupDiagnosticIsPrivate(readFileSync("src/main/main.ts", "utf8"))).toBe(true);
});
it("rejects an exposed argument vector and absent diagnostic", () => {
  expect(startupDiagnosticIsPrivate('diag("main-start", { argv: process.argv });')).toBe(false);
  expect(startupDiagnosticIsPrivate('const x = 1;')).toBe(false);
});
