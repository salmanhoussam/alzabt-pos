import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function privateMethods(file: string, expected: ReadonlySet<string>): void {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && expected.has(node.name.text)) {
      expect(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)).toBe(true);
      found.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source(file));
  expect(found).toEqual(expected);
}

/** Inspect static and runtime imports. Nonliteral runtime paths fail closed. */
function prohibitedImports(file: ts.SourceFile): string[] {
  const violations: string[] = [];
  const check = (node: ts.Expression | undefined): void => {
    if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      violations.push("<nonliteral>");
    } else if (/demoSeed|demoProfile|demoSyntheticStartup|demoLogoVault|demoLaunchRecords|demoLifecycle|demoPreview|demoDevGate|demoHandoverStartup|demoAssets|demoRendererPolicy|demoRuntime|ledgerServices|seedActor/i.test(node.text)) {
      violations.push(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      check(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      check(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const e = node.expression;
      const isRequire = ts.isIdentifier(e) && e.text === "require";
      const isRequireProperty = ts.isPropertyAccessExpression(e) &&
        ((ts.isIdentifier(e.expression) && e.expression.text === "require" && e.name.text === "resolve") ||
         (ts.isIdentifier(e.expression) && e.expression.text === "module" && e.name.text === "require"));
      if (e.kind === ts.SyntaxKind.ImportKeyword || isRequire || isRequireProperty) check(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}
function rendererFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes:true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...rendererFiles(path));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

it("keeps the audited acting context and all extracted bodies internal", () => {
  const file = source("src/application/posService.ts");
  const constructors: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "actingOperator") constructors.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(constructors).toHaveLength(1);
  expect(constructors[0]!.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false).toBe(false);
  privateMethods("src/application/posService.ts", new Set(["importCatalogCsvAs", "updateProductAs", "createCategoryAs", "writeProductPrimaryImage"]));
  privateMethods("src/application/invoiceService.ts", new Set(["saveCompanyProfileValidated"]));
});

it("inspects the actual nonempty renderer, IPC and preload file sets", () => {
  const renderer = rendererFiles("src/renderer");
  expect(renderer.length).toBeGreaterThan(0);
  expect(renderer.some((name) => name.endsWith(".tsx"))).toBe(true);
  const files = ["src/main/ipcHandlers.ts", "src/preload/preload.ts", ...renderer];
  for (const file of files) expect(prohibitedImports(source(file)), file).toEqual([]);
});

it.each([
  ['import {x} from "../main/demoSeedAccounts";', "../main/demoSeedAccounts"],
  ['export * from "../main/demoProfile";', "../main/demoProfile"],
  ['import("../main/ledgerServices");', "../main/ledgerServices"],
  ['import type {SeedActor} from "../application/seedActor";', "../application/seedActor"],
  ['require("../main/demoSeedIdentity");', "../main/demoSeedIdentity"],
  ['import("../main/demoSyntheticStartup");', "../main/demoSyntheticStartup"],
  ['import("../main/demoDevGate");', "../main/demoDevGate"],
  ['import("../main/demoLifecycle");', "../main/demoLifecycle"],
  ['import("../main/demoPreview");', "../main/demoPreview"],
  ['import {x} from "../main/demoLogoVault";', "../main/demoLogoVault"],
  ['require.resolve("../main/demoProfile");', "../main/demoProfile"],
  ['module.require("../main/demoSeedMedia");', "../main/demoSeedMedia"],
  ['import thing = require("../main/demoSeedAccounts");', "../main/demoSeedAccounts"],
  ['import(computedPath);', "<nonliteral>"],
  ['require(computedPath);', "<nonliteral>"],
])("rejects a prohibited import in synthetic fixture %s", (code, expected) => {
  const fixture = ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  expect(prohibitedImports(fixture)).toContain(expected);
});

it("the real POS startup never supplies a seed actor to service assembly", () => {
  const file = source("src/main/main.ts");
  let calls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createLedgerServices") {
      calls++;
      const ports = node.arguments[1];
      expect(ports && ts.isObjectLiteralExpression(ports)).toBe(true);
      if (ports && ts.isObjectLiteralExpression(ports)) {
        for (const property of ports.properties) {
          expect(ts.isSpreadAssignment(property)).toBe(false);
          expect(property.getText(file)).not.toContain("seedActor");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(calls).toBe(1);
});
