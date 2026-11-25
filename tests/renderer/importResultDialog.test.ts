/**
 * QW-IMPORT-DIALOG-AR (J1 Phase 6 proposal) — the import / export result box.
 *
 *  1. ENGLISH IS UNCHANGED, proved against a FROZEN COPY of the old App.tsx markup (`legacy` below, verbatim from the
 *     Phase 5 source): for every status, the new box's visible English text equals the old box's, character for
 *     character after the same whitespace collapsing a browser does.
 *  2. ARABIC IS NEW and uses the dictionary; no English title or label leaks into it.
 *  3. MAIN'S REASONS ARE VERBATIM: a rejected row's reason is shown exactly as Main wrote it, in both languages.
 *  4. EVERY FACT A TEST NEEDS IS AN ATTRIBUTE: status, operation, counts, each rejected line — language-free.
 */
import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { allKeys, translate } from "../../src/shared/i18n";

const ui = vi.hoisted(() => ({ lang: "en" as "ar" | "en" }));
vi.mock("../../src/renderer/i18n", async () => {
  const { translate: tr } = await import("../../src/shared/i18n");
  return { useT: () => ({ t: (k: string) => tr(ui.lang, k), lang: ui.lang, unit: (u: string) => u }) };
});
import { ImportResultDialog, fill, type ImportResult } from "../../src/renderer/components/ImportResultDialog";

const CASES = {
  imported: { status: "imported", rowCount: 4, inserted: 4, updated: 0, unchanged: 0, deactivated: 0, placeholderPrices: 1 },
  importedNoPlaceholder: { status: "imported", rowCount: 4, inserted: 0, updated: 0, unchanged: 4, deactivated: 0, placeholderPrices: 0 },
  rejected: { status: "rejected", rejected: [{ line: 2, reason: "price must be a positive decimal" }, { line: 5, reason: "missing source_id" }] },
  importFailed: { status: "error", titleKey: "import.title.importFailed", message: "Only the shop owner can do that" },
  exportFailed: { status: "error", titleKey: "import.title.exportFailed", message: "disk full" },
  backupFailed: { status: "error", titleKey: "import.title.backupFailed", message: "disk full" },
  catalogExported: { status: "exported", what: "catalog", fileName: "alzabt-catalog.csv", productCount: 4 },
  backupExported: { status: "exported", what: "backup", fileName: "alzabt-backup.sqlite" },
} satisfies Record<string, ImportResult>;
const byName = CASES as Record<string, ImportResult>;

/** The OLD box, copied verbatim from App.tsx (Phase 5) — the reference for «English is unchanged». */
const LEGACY_TITLES: Record<string, string> = { importFailed: "Catalog NOT imported", exportFailed: "Catalog NOT exported", backupFailed: "Backup NOT exported" };
function legacy(name: string, r: ImportResult) {
  const kids =
    r.status === "imported"
      ? [h("h2", { key: 1 }, "Catalog imported"),
         h("p", { key: 2 }, r.rowCount, " products in the file: ", r.inserted, " new, ", r.updated, " updated,", " ", r.unchanged, " unchanged, ", r.deactivated, " no longer listed (hidden)."),
         r.placeholderPrices > 0 ? h("p", { key: 3, className: "error" }, r.placeholderPrices, " products have a placeholder price (marked “price?”) — set their real prices and import again.") : null]
      : r.status === "rejected"
        ? [h("h2", { key: 1 }, "Catalog NOT imported"), h("p", { key: 2, className: "error" }, "Nothing was changed. Fix these rows and import again:"),
           h("ul", { key: 3 }, r.rejected.map((x) => h("li", { key: x.line }, "Line ", x.line, ": ", x.reason)))]
        : r.status === "error"
          ? [h("h2", { key: 1 }, LEGACY_TITLES[name]), h("p", { key: 2, className: "error" }, r.message)]
          : r.what === "catalog"
            ? [h("h2", { key: 1 }, "Catalog exported"), h("p", { key: 2 }, r.productCount, " products saved to ", h("strong", { dir: "auto" }, r.fileName), ". Edit prices in Excel, save as “CSV UTF-8”, then use Import catalog.")]
            : [h("h2", { key: 1 }, "Backup exported"), h("p", { key: 2 }, "A verified copy of the sales database was saved to ", h("strong", { dir: "auto" }, r.fileName), ".")];
  return renderToStaticMarkup(h("div", { className: "overlay" }, h("div", { className: "card dialog import-report" }, h(Fragment, null, ...kids), h("button", { className: "btn primary wide" }, "OK"))));
}

/** Visible text of each block element, as a browser would collapse it. */
const text = (html: string) =>
  html.replace(/<\/(h2|p|li|button)>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const render = (r: ImportResult) => renderToStaticMarkup(h(ImportResultDialog, { result: r, onClose: () => undefined }));

describe("English is byte-identical to the old App.tsx box", () => {
  for (const [name, r] of Object.entries(CASES)) {
    it(name, () => {
      ui.lang = "en";
      expect(text(render(r))).toEqual(text(legacy(name, r)));
    });
  }
});

it("negative control: the same comparison REJECTS a reference that differs by one count or one word", () => {
  ui.lang = "en";
  const r = CASES.imported;
  expect(text(render(r))).not.toEqual(text(legacy("imported", { ...r, updated: 1 })));
  expect(text(render(CASES.backupExported)).join("|").replace("verified", "checked")).not.toEqual(text(legacy("backupExported", CASES.backupExported)).join("|"));
});

describe("Arabic is translated, and Main's reasons stay verbatim", () => {
  it("every title, label and the OK button are Arabic; no English UI word leaks in", () => {
    ui.lang = "ar";
    for (const [name, r] of Object.entries(CASES)) {
      const t = text(render(r)).join(" | ");
      expect(t, name).toMatch(/[؀-ۿ]/);
      expect(t, name).not.toMatch(/\b(Catalog|Backup|products in the file|Line \d|Nothing was changed|OK)\b/);
      expect(render(r), name).toContain(">حسناً<");
    }
  });
  it("the imported summary names the counts in Arabic and quotes the Products screen's own price mark", () => {
    ui.lang = "ar";
    const html = render(CASES.imported);
    expect(text(html)).toContain(fill(translate("ar", "import.summary"), { rows: 4, inserted: 4, updated: 0, unchanged: 0, deactivated: 0 }));
    expect(html).toContain(`«${translate("ar", "products.priceNeedsReview")}»`);
  });
  it("a rejected row keeps Main's reason exactly, inside dir=auto, in BOTH languages", () => {
    for (const lang of ["ar", "en"] as const) {
      ui.lang = lang;
      const html = render(CASES.rejected);
      expect(html).toContain('<span dir="auto">price must be a positive decimal</span>');
      expect(html).toContain('<span dir="auto">missing source_id</span>');
    }
  });
});

describe("stable, language-free test identifiers", () => {
  const attrs = (html: string) => html.match(/<div class="card dialog import-report"[^>]*>/)![0];
  it("status and operation on every box", () => {
    ui.lang = "ar";
    const want: Record<string, [string, string]> = {
      imported: ["imported", "catalog-import"], rejected: ["rejected", "catalog-import"], importFailed: ["error", "catalog-import"],
      exportFailed: ["error", "catalog-export"], backupFailed: ["error", "backup-export"], catalogExported: ["exported", "catalog-export"],
      backupExported: ["exported", "backup-export"],
    };
    for (const [name, [status, what]] of Object.entries(want)) {
      const a = attrs(render(byName[name]!));
      expect(a, name).toContain('data-testid="import-report"');
      expect(a, name).toContain(`data-status="${status}"`);
      expect(a, name).toContain(`data-what="${what}"`);
    }
  });
  it("an imported box carries every count as an attribute", () => {
    const a = attrs(render(CASES.imported));
    for (const [k, v] of [["rows", 4], ["inserted", 4], ["updated", 0], ["unchanged", 0], ["deactivated", 0], ["placeholder-prices", 1]])
      expect(a).toContain(`data-${k}="${v}"`);
  });
  it("each rejected line is addressable by its number; title and OK have ids", () => {
    const html = render(CASES.rejected);
    expect(html).toContain('data-testid="import-report-rejected-row" data-line="2"');
    expect(html).toContain('data-testid="import-report-rejected-row" data-line="5"');
    expect(html).toContain('data-testid="import-report-title"');
    expect(html).toContain('data-testid="import-report-ok"');
  });
});

describe("dictionary and helper", () => {
  it("every import.* key exists in BOTH languages", () => {
    const keys = allKeys().filter((k) => k.startsWith("import."));
    expect(keys.length).toBe(12);
    for (const k of keys) for (const lang of ["ar", "en"] as const) expect(translate(lang, k), `${lang} ${k}`).not.toBe(k);
  });
  it("fill never hides a missing value: the placeholder stays visible", () => {
    expect(fill("{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });
});
