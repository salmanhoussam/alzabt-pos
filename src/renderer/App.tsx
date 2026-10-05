import { useEffect, useState } from "react";
import type { CashierDto, ImportCatalogResponse } from "../shared/ipcContract";
import { call, errorText, pos } from "./api";
import { HistoryScreen } from "./screens/HistoryScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { SellScreen } from "./screens/SellScreen";
import { TodayScreen } from "./screens/TodayScreen";

type Tab = "sell" | "today" | "history";

export function App() {
  const [cashier, setCashier] = useState<CashierDto | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("sell");
  // Bumped after a catalog import so the Sell screen reloads the catalog from the main process.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [importResult, setImportResult] = useState<ImportCatalogResponse | { status: "error"; message: string } | null>(null);

  useEffect(() => {
    call(pos().currentCashier())
      .then(setCashier)
      .catch(() => setCashier(null));
  }, []);

  if (cashier === undefined) return <div className="center muted">Loading…</div>;
  if (cashier === null) return <LoginScreen onLogin={setCashier} />;

  const logout = async () => {
    await call(pos().logout());
    setCashier(null);
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
      setImportResult({ status: "error", message: errorText(e) });
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <strong className="brand">Alzabt POS</strong>
        <nav className="tabs">
          <button className={tab === "sell" ? "tab active" : "tab"} onClick={() => setTab("sell")}>
            Sell
          </button>
          <button className={tab === "today" ? "tab active" : "tab"} onClick={() => setTab("today")}>
            Today's Sales
          </button>
          <button className={tab === "history" ? "tab active" : "tab"} onClick={() => setTab("history")}>
            History
          </button>
        </nav>
        <button className="btn ghost" onClick={importCatalog}>
          Import catalog
        </button>
        <span className="muted">{cashier.name}</span>
        <button className="btn ghost" onClick={logout}>
          Log out
        </button>
      </header>
      <main className="content">
        {tab === "sell" && <SellScreen key={catalogVersion} />}
        {tab === "today" && <TodayScreen />}
        {tab === "history" && <HistoryScreen />}
      </main>
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
                <h2>Catalog NOT imported</h2>
                <p className="error">{importResult.message}</p>
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
