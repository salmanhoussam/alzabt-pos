/**
 * QW-IMPORT-DIALOG-AR (J1 Phase 6 proposal, 2026-11-20) — the catalog import / export and backup-export result box.
 *
 * Moved out of App.tsx unchanged in behaviour so it can be tested, and translated. Three things are deliberate:
 *
 * 🔴 STABLE TEST IDS FIRST. Sixteen E2E waits, five assertions and ten «OK» clicks read this box by its ENGLISH text
 *    ("Catalog imported", "4 products in the file: 4 new", "Line 2", the "OK" button). They passed only because the box
 *    was English in an Arabic UI. Every fact they need is now an attribute: `data-status`, `data-what`, the counts, each
 *    rejected row's `data-line` — so a test never depends on the language.
 * 🔴 THE ENGLISH WORDING IS BYTE-IDENTICAL to what App.tsx showed before; Arabic is added, nothing is reworded.
 * 🔴 MAIN'S PER-ROW REASONS ARE SHOWN VERBATIM (`dir="auto"`). They are written by the import parser in Main
 *    (catalogImport.ts) and are NOT translated here; localizing them is a separate, coordinated change (QW-CSV-TEMPLATE).
 */
import type { ImportCatalogResponse } from "../../shared/ipcContract";
import { useT } from "../i18n";

export type ExportNotice = { status: "exported"; what: "catalog" | "backup"; fileName: string; productCount?: number };
/** A failure title is a KEY, so it is translated at render time, not frozen in the language of the moment. */
export type ErrorNotice = { status: "error"; titleKey: "import.title.importFailed" | "import.title.exportFailed" | "import.title.backupFailed"; message: string };
export type ImportResult = Exclude<ImportCatalogResponse, { status: "cancelled" }> | ExportNotice | ErrorNotice;

/** "{n} new" — replaces {name} placeholders; a missing value leaves the placeholder visible (never silent). */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (all, k: string) => (k in values ? String(values[k]) : all));
}

/** A sentence with ONE {file} slot rendered as <strong>; the rest is plain text in the sentence's own order. */
function WithFile({ text, file }: { text: string; file: string }) {
  const at = text.indexOf("{file}");
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <strong dir="auto">{file}</strong>
      {text.slice(at + "{file}".length)}
    </>
  );
}

export function ImportResultDialog({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const { t } = useT();
  /** Which operation this box reports — the same vocabulary for success and failure, so a test can ask «which». */
  const what =
    result.status === "exported"
      ? result.what === "catalog" ? "catalog-export" : "backup-export"
      : result.status === "error"
        ? { "import.title.importFailed": "catalog-import", "import.title.exportFailed": "catalog-export", "import.title.backupFailed": "backup-export" }[result.titleKey]
        : "catalog-import";
  const counts =
    result.status === "imported"
      ? {
          "data-rows": result.rowCount,
          "data-inserted": result.inserted,
          "data-updated": result.updated,
          "data-unchanged": result.unchanged,
          "data-deactivated": result.deactivated,
          "data-placeholder-prices": result.placeholderPrices,
        }
      : {};
  return (
    <div className="overlay">
      <div className="card dialog import-report" data-testid="import-report" data-status={result.status} data-what={what} {...counts}>
        {result.status === "imported" && (
          <>
            <h2 data-testid="import-report-title">{t("import.title.imported")}</h2>
            <p data-testid="import-report-summary">
              {fill(t("import.summary"), {
                rows: result.rowCount,
                inserted: result.inserted,
                updated: result.updated,
                unchanged: result.unchanged,
                deactivated: result.deactivated,
              })}
            </p>
            {result.placeholderPrices > 0 && (
              <p className="error" data-testid="import-report-placeholders">
                {/* The mark is the Products screen's own label, so the sentence names exactly what the owner will see. */}
                {fill(t("import.placeholderPrices"), { n: result.placeholderPrices, mark: t("products.priceNeedsReview") })}
              </p>
            )}
          </>
        )}
        {result.status === "rejected" && (
          <>
            <h2 data-testid="import-report-title">{t("import.title.importFailed")}</h2>
            <p className="error">{t("import.rejectedLead")}</p>
            <ul data-testid="import-report-rejected">
              {result.rejected.map((r) => (
                <li key={r.line} data-testid="import-report-rejected-row" data-line={r.line}>
                  {fill(t("import.line"), { line: r.line })}: <span dir="auto">{r.reason}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {result.status === "error" && (
          <>
            <h2 data-testid="import-report-title">{t(result.titleKey)}</h2>
            <p className="error" dir="auto">{result.message}</p>
          </>
        )}
        {result.status === "exported" && result.what === "catalog" && (
          <>
            <h2 data-testid="import-report-title">{t("import.title.catalogExported")}</h2>
            <p>
              <WithFile text={fill(t("import.catalogSaved"), { n: result.productCount ?? "" })} file={result.fileName} />
            </p>
          </>
        )}
        {result.status === "exported" && result.what === "backup" && (
          <>
            <h2 data-testid="import-report-title">{t("import.title.backupExported")}</h2>
            <p>
              <WithFile text={t("import.backupSaved")} file={result.fileName} />
            </p>
          </>
        )}
        <button className="btn primary wide" onClick={onClose} data-testid="import-report-ok">
          {t("action.ok")}
        </button>
      </div>
    </div>
  );
}
