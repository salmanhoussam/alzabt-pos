import { useEffect, useState } from "react";
import type { CashierDto } from "../shared/ipcContract";
import { call, pos } from "./api";
import { HistoryScreen } from "./screens/HistoryScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { SellScreen } from "./screens/SellScreen";
import { TodayScreen } from "./screens/TodayScreen";

type Tab = "sell" | "today" | "history";

export function App() {
  const [cashier, setCashier] = useState<CashierDto | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("sell");

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
        <span className="muted">{cashier.name}</span>
        <button className="btn ghost" onClick={logout}>
          Log out
        </button>
      </header>
      <main className="content">
        {tab === "sell" && <SellScreen />}
        {tab === "today" && <TodayScreen />}
        {tab === "history" && <HistoryScreen />}
      </main>
    </div>
  );
}
