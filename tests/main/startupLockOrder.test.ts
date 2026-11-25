import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

/** Check the executable startup statements, not function declarations that only define callbacks. */
function lockBeforeProfile(sourceText: string): boolean {
  const file = ts.createSourceFile("main.ts", sourceText, ts.ScriptTarget.Latest, true);
  let lockAt = -1;
  let selectionAt = -1;
  let refusedSafe = false;
  for (const [index, stmt] of file.statements.entries()) {
    if (ts.isVariableStatement(stmt) && stmt.getText(file).includes("app.requestSingleInstanceLock()")) lockAt = index;
    if (ts.isIfStatement(stmt) && stmt.expression.getText(file) === "!gotSingleInstanceLock") {
      selectionAt = index;
      const noProfileAccess = !/setPath|createFileLogger|startTill|userData/.test(stmt.thenStatement.getText(file));
      const allowed = !!stmt.elseStatement && /setPath/.test(stmt.elseStatement.getText(file)) &&
        /createFileLogger/.test(stmt.elseStatement.getText(file)) && /startTill/.test(stmt.elseStatement.getText(file));
      refusedSafe = noProfileAccess && allowed;
    }
    if (lockAt < 0 && !ts.isFunctionDeclaration(stmt) && !ts.isClassDeclaration(stmt)) {
      const text = stmt.getText(file);
      if (text.includes("app.setPath(") || text.includes("createFileLogger(") ||
          (text.includes("app.getPath(") && text.includes("userData"))) return false;
    }
  }
  return lockAt >= 0 && selectionAt > lockAt && refusedSafe;
}
it("acquires the product lock before override and logger setup", () => {
  expect(lockBeforeProfile(readFileSync("src/main/main.ts","utf8"))).toBe(true);
});
it("rejects a synthetic startup that writes profile data before the lock", () => {
  const bad = 'app.setPath("userData","synthetic"); const gotSingleInstanceLock=app.requestSingleInstanceLock(); if (!gotSingleInstanceLock) { app.quit(); } else { app.setPath("userData","synthetic"); createFileLogger("x"); startTill(); }';
  expect(lockBeforeProfile(bad)).toBe(false);
});
it("rejects a synthetic refused branch that initializes a profile logger", () => {
  const bad = 'const gotSingleInstanceLock=app.requestSingleInstanceLock(); if (!gotSingleInstanceLock) { createFileLogger("x"); app.quit(); } else { app.setPath("userData","synthetic"); createFileLogger("x"); startTill(); }';
  expect(lockBeforeProfile(bad)).toBe(false);
});
