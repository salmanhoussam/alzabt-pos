import { useEffect, useState } from "react";
import type { CashierDto, ImportCatalogResponse } from "../shared/ipcContract";
import { BuildLine } from "./BuildLine";
import { call, errorText, pos } from "./api";
import { HistoryScreen } from "./screens/HistoryScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { SetupScreen } from "./screens/SetupScreen";
import { SellScreen } from "./screens/SellScreen";
import { TodayScreen } from "./screens/TodayScreen";
import { ProductsScreen } from "./screens/ProductsScreen";
import { InvoicesScreen } from "./screens/InvoicesScreen";
import { ToolsScreen } from "./screens/ToolsScreen";
import { useT } from "./i18n";

type Tab = "sell" | "today" | "history" | "products" | "invoices" | "tools";

type ExportNotice = { status: "exported"; what: "catalog" | "backup"; fileName: string; productCount?: number };
type ErrorNotice = { status: "error"; title: string; message: string };

/** Which of the shell's four screens is showing. */
export type Screen = "loading" | "setup" | "login" | "app";

/**
 * The shell's screen decision, as a pure function — exported so its ORDER is testable.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 A LIVE SESSION WINS OVER AN OUTSTANDING SETUP TICKET, and getting that precedence wrong is
 * exactly the defect this function was extracted to fix. The shell used to ask `if (setup !== null)`
 * FIRST and never clear `setup`, so completing mandatory setup set the cashier and then re-rendered
 * SetupScreen anyway — forever. On the first run of every installation and every upgrade, an
 * operator would set their real PIN, press the button, and sit on the same screen; only restarting
 * the app let them in, because `currentCashier()` then answered with the session they already had.
 *
 * All 717 unit tests passed through it: the bug lived in the ORDER of two early returns, which no
 * service test can see and this repository has no DOM harness to mount. The installed-app E2E is
 * what caught it, on the first Windows gate this branch ever ran.
 *
 * So the rule is stated here once, where it can be asserted: a ticket is not a session, and the
 * moment a session exists the ticket is spent.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
export function screenFor(cashier: CashierDto | null | undefined, setup: unknown): Screen {
  if (cashier === undefined) return "loading";
  if (cashier !== null) return "app";
  return setup !== null && setup !== undefined ? "setup" : "login";
}

export function App() {
  const { t, lang, setLanguage } = useT();
  const [cashier, setCashier] = useState<CashierDto | null | undefined>(undefined);
  /** An outstanding bootstrap setup. Non-null means the till is unreachable until it completes. */
  const [setup, setSetup] = useState<{ readonly ticket: string; readonly name: string } | null>(null);
  const [tab, setTab] = useState<Tab>("sell");
  // Bumped after a catalog import so the Sell screen reloads the catalog from the main process.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [importResult, setImportResult] = useState<ImportCatalogResponse | ExportNotice | ErrorNotice | null>(null);

  useEffect(() => {
    call(pos().currentCashier())
      .then(setCashier)
      .catch(() => setCashier(null));
  }, []);

  const screen = screenFor(cashier, setup);

  // These three stay keyed on `cashier` itself so TypeScript narrows it for the till below;
  // `screen` is the authority for the one decision that was wrong, and the unit test asserts the
  // two cannot disagree.
  if (cashier === undefined) return <div className="center muted">Loading…</div>;

  // 🔴 MANDATORY SETUP COMES BEFORE THE APPLICATION, and it is not merely rendered first: there is
  // no session behind it, so every other channel refuses regardless of what this renderer shows.
  // The condition is `screenFor`'s, not an inline `setup !== null` — see that function for the
  // defect this ordering exists to prevent.
  if (screen === "setup" && setup !== null)
    return (
      <div className="app">
        <main className="content">
          <SetupScreen
            ticket={setup.ticket}
            operatorName={setup.name}
            // The ticket is spent the moment a session exists. `screenFor` already refuses to show
            // this screen once `cashier` is set, so clearing it is belt-and-braces rather than the
            // fix — it keeps a used ticket from sitting in renderer memory.
            onReady={(c) => {
              setSetup(null);
              setCashier(c);
            }}
          />
        </main>
        <BuildLine />
      </div>
    );

  if (cashier === null)
    return (
      <div className="app">
        <main className="content">
          <LoginScreen
            onOutcome={(r) => {
              if (r.status === "setup") setSetup({ ticket: r.ticket, name: r.name });
              else setCashier(r.cashier);
            }}
          />
        </main>
        <BuildLine />
      </div>
    );

  const logout = async () => {
    await call(pos().logout());
    setCashier(null);
    setSetup(null);
    setTab("sell");
  };

  const importCatalog = async () => {
    try {
      const result = await call(pos().importCatalog());
      if (result.status === "cancelled") return;
      setImportResult(result);
      if (result.status === "imported") {
        setCatalogVersion((v) => v + 1);
        setTab("sell");
      }
    } catch (e) {
      setImportResult({ status: "error", title: "Catalog NOT imported", message: errorText(e) });
    }
  };

  const exportCatalog = async () => {
    try {
      const result = await call(pos().exportCatalog());
      if (result.status === "cancelled") return;
      setImportResult({ status: "exported", what: "catalog", fileName: result.fileName, productCount: result.productCount });
    } catch (e) {
      setImportResult({ status: "error", title: "Catalog NOT exported", message: errorText(e) });
    }
  };

  const exportBackup = async () => {
    try {
      const result = await call(pos().exportBackup());
      if (result.status === "cancelled") return;
      setImportResult({ status: "exported", what: "backup", fileName: result.fileName });
    } catch (e) {
      setImportResult({ status: "error", title: "Backup NOT exported", message: errorText(e) });
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <strong className="brand">{t("app.name")}</strong>
        <nav className="tabs">
          {(["sell", "today", "history", "products", "invoices", "tools"] as const).map((name) => (
            <button
              key={name}
              className={tab === name ? "tab active" : "tab"}
              onClick={() => setTab(name)}
              data-testid={`tab-${name}`}
            >
              {t(`nav.${name}`)}
            </button>
          ))}
        </nav>
        <span className="muted" dir="auto">
          {cashier.name}
        </span>
        <button
          className="btn ghost"
          onClick={() => setLanguage(lang === "ar" ? "en" : "ar")}
          data-testid="lang-toggle"
          lang={lang === "ar" ? "en" : "ar"}
        >
          {t("lang.toggle")}
        </button>
        <button className="btn ghost" onClick={logout} data-testid="logout">
          {t("action.logout")}
        </button>
      </header>
      <main className="content">
        {tab === "sell" && <SellScreen key={catalogVersion} />}
        {tab === "today" && <TodayScreen />}
        {tab === "history" && <HistoryScreen />}
        {tab === "products" && <ProductsScreen />}
        {tab === "invoices" && <InvoicesScreen />}
        {tab === "tools" && (
          <ToolsScreen
            onImportCatalog={importCatalog}
            onExportCatalog={exportCatalog}
            onExportBackup={exportBackup}
            operator={cashier}
          />
        )}
      </main>
      <BuildLine />
      {importResult && (
        <div className="overlay">
          <div className="card dialog import-report">
            {importResult.status === "imported" && (
              <>
                <h2>Catalog imported</h2>
                <p>
                  {importResult.rowCount} products in the file: {importResult.inserted} new, {importResult.updated} updated,{" "}
                  {importResult.unchanged} unchanged, {importResult.deactivated} no longer listed (hidden).
                </p>
                {importResult.placeholderPrices > 0 && (
                  <p className="error">
                    {importResult.placeholderPrices} products have a placeholder price (marked “price?”) — set their real
                    prices and import again.
                  </p>
                )}
              </>
            )}
            {importResult.status === "rejected" && (
              <>
                <h2>Catalog NOT imported</h2>
                <p className="error">Nothing was changed. Fix these rows and import again:</p>
                <ul>
                  {importResult.rejected.map((r) => (
                    <li key={r.line}>
                      Line {r.line}: {r.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {importResult.status === "error" && (
              <>
                <h2>{importResult.title}</h2>
                <p className="error">{importResult.message}</p>
              </>
            )}
            {importResult.status === "exported" && importResult.what === "catalog" && (
              <>
                <h2>Catalog exported</h2>
                <p>
                  {importResult.productCount} products saved to <strong dir="auto">{importResult.fileName}</strong>. Edit
                  prices in Excel, save as “CSV UTF-8”, then use Import catalog.
                </p>
              </>
            )}
            {importResult.status === "exported" && importResult.what === "backup" && (
              <>
                <h2>Backup exported</h2>
                <p>
                  A verified copy of the sales database was saved to <strong dir="auto">{importResult.fileName}</strong>.
                </p>
              </>
            )}
            <button className="btn primary wide" onClick={() => setImportResult(null)}>
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
