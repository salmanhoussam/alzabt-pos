import { useEffect, useReducer, useRef, useState } from "react";
import type { CashierDto } from "../shared/ipcContract";
import { type ImportResult, ImportResultDialog } from "./components/ImportResultDialog";
import { BuildLine } from "./BuildLine";
import { call, errorText, pos } from "./api";
import { HistoryScreen } from "./screens/HistoryScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { SetupScreen } from "./screens/SetupScreen";
import { CreateAccountLegacyNote, WelcomeScreen } from "./screens/WelcomeScreen";
import { EntryStateLoader, INITIAL_ENTRY_UI, entryUiReducer, offersDemo, preLoginScreen, readEntryState, showsCreateNote } from "./entryState";
import { type DemoAction, type DemoLifecycleOutcome, demoLifecycleAvailable, demoShellFor, requestDemoLifecycle } from "./demoControl";
import { DemoBanner, DemoUnavailable } from "./components/DemoBanner";
import { DemoModeProvider } from "./demoMode";
import { SellScreen } from "./screens/SellScreen";
import { type SellDraft, draftFor } from "./sellDraft";
import { TodayScreen } from "./screens/TodayScreen";
import { ProductsScreen } from "./screens/ProductsScreen";
import { InvoicesScreen } from "./screens/InvoicesScreen";
import { CustomersScreen } from "./screens/CustomersScreen";
import { ToolsScreen } from "./screens/ToolsScreen";
import { useT } from "./i18n";
import { appModalOwner, useAppModalOwner } from "./appModal";

type Tab = "sell" | "today" | "history" | "products" | "customers" | "invoices" | "tools";

// QW-IMPORT-DIALOG-AR: the result box and its types live in components/ImportResultDialog.tsx (translated, test ids).

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
  // Bumped when Sell's tab is clicked while Sell is already open: that click focuses the tab button
  // and remounts nothing, so the Sell screen is asked to put focus back in its search field (a scan
  // typed into a tab button would go nowhere).
  const [sellFocusRequest, setSellFocusRequest] = useState(0);
  /**
   * R5 (Abu Abbas F1): while an invoice dialog or an issue in flight owns interaction, the shell is inert AND every shell
   * action refuses when it runs — a dispatched click still reaches the handler, so `inert` alone is not the guard.
   */
  const modalOwner = useAppModalOwner();
  const shellFree = () => appModalOwner() === null;
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  // SELL-CART-LOST-ON-TAB: the Sell screen's unfinished cart, kept while another tab is open. Memory
  // only, ONE operator's — handed back only to them (`draftFor`), dropped on sign-out and on a catalogue
  // import. See ./sellDraft.ts for what it does and does not keep.
  const [sellDraft, setSellDraft] = useState<SellDraft | null>(null);
  // FIRST-RUN WELCOME (joint C1). `entry` is main's routing HINT (./entryState.ts) — never authority.
  // Until the channel is bound (X1) or on any failure it is LEGACY_ENTRY: this shell then behaves
  // exactly as before (plain login). `preLogin` is the operator's own choice on the Welcome screen.
  // C1-R1: the read is bounded (ENTRY_STATE_TIMEOUT_MS → LEGACY_ENTRY) and the loader drops any
  // answer superseded by a newer decision. C1-R2: setup and logout are reducer events, so a start-up
  // hint is never reused after the terminal was claimed or an operator signed out.
  const [entryUi, dispatchEntry] = useReducer(entryUiReducer, INITIAL_ENTRY_UI);
  const { entry, preLogin } = entryUi;
  const entryLoader = useRef<EntryStateLoader | null>(null);
  if (entryLoader.current === null) entryLoader.current = new EntryStateLoader(() => readEntryState(pos()));
  const loadEntry = () => {
    void entryLoader.current!.load().then((state) => {
      if (state !== null) dispatchEntry({ type: "loaded", entry: state });
    });
  };

  // TRY DEMO (joint C2). Entering, leaving and restarting are main's decisions (BR-C-06, proposed);
  // the renderer only asks, and draws no action while the channel is absent.
  const [demoPending, setDemoPending] = useState<DemoAction | null>(null);
  const [demoOutcome, setDemoOutcome] = useState<DemoLifecycleOutcome | null>(null);
  const [demoSlow, setDemoSlow] = useState(false);
  const onDemoAction = (action: DemoAction) => {
    setDemoPending(action);
    setDemoOutcome(null);
    setDemoSlow(false);
    void requestDemoLifecycle(pos(), action, undefined, () => setDemoSlow(true)).then((outcome) => {
      // "restarting": main is about to replace this window — keep the pending note up until it does.
      if (outcome.status !== "restarting") {
        setDemoPending(null);
        setDemoSlow(false);
      }
      setDemoOutcome(outcome);
    });
  };

  useEffect(() => {
    call(pos().currentCashier())
      .then(setCashier)
      .catch(() => setCashier(null));
    loadEntry();
    const loader = entryLoader.current;
    return () => loader?.invalidate();
  }, []);

  const screen = screenFor(cashier, setup);

  // 🔴 DEMO-FALLBACK: ONE app-wide, permanent warning while the sample catalog is live — on EVERY tab
  // (Sell and its sale confirmation, Today, History, …), because demo sales appear in all of them.
  // Re-read from the main process on every tab change and after an import, so it disappears the
  // moment a real product exists. A read failure hides nothing it knows about: it only ever shows
  // the banner on `demo === true`, which the main process sets under the explicit switch alone.
  const [demoCatalog, setDemoCatalog] = useState(false);
  // SHOWCASE MARKER: a separate, display-only banner for a tooling-prepared showcase profile.
  const [showcaseProfile, setShowcaseProfile] = useState(false);
  useEffect(() => {
    if (screen !== "app") return;
    call(pos().getCatalog())
      .then((c) => {
        setDemoCatalog(c.demo === true);
        setShowcaseProfile(c.showcaseProfile === true);
      })
      .catch(() => {
        setDemoCatalog(false);
        setShowcaseProfile(false);
      });
  }, [screen, tab, catalogVersion]);

  // These three stay keyed on `cashier` itself so TypeScript narrows it for the till below, while
  // `screen` is the authority for the one decision that was wrong.
  //
  // 🔴 NOTHING MECHANICAL CHECKS THAT THE TWO AGREE. An earlier version of this comment claimed the
  // unit test did; it does not — `appScreen.test.ts` exercises `screenFor` in isolation and this
  // repository has no DOM harness to mount the component. An independent review caught the
  // overstatement. The agreement holds by inspection: `screen === "setup"` already implies
  // `cashier === null`, so the `&& setup !== null` below is narrowing rather than a second
  // condition, and the login branch is reached only when `setup` is absent. If these inline
  // conditions are ever edited, that reasoning has to be redone by hand.
  if (cashier === undefined || entry === undefined) return <div className="center muted">Loading…</div>;

  // TRY DEMO: the demo process carries a permanent banner on every screen, and NEVER offers a login
  // or setup form — main signs the demo in (D-6); no session means main refused it.
  const demoShell = demoShellFor(entry.profile, cashier !== null);
  const canControlDemo = demoLifecycleAvailable(pos());
  const demoBanner =
    demoShell === "not-demo" ? null : (
      <DemoBanner canControl={canControlDemo} pending={demoPending} slow={demoSlow} outcome={demoOutcome} onAction={onDemoAction} />
    );
  if (demoShell === "demo-no-session")
    return (
      <div className="app">
        {demoBanner}
        <main className="content">
          <DemoUnavailable canExit={canControlDemo} />
        </main>
        <BuildLine />
      </div>
    );

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
              // C1-R2: this terminal is claimed now; drop any start-up hint still in flight.
              entryLoader.current!.invalidate();
              dispatchEntry({ type: "setup-complete" });
            }}
          />
        </main>
        <BuildLine />
      </div>
    );

  // FIRST-RUN WELCOME: only when main's hint says this real terminal is unclaimed AND first-run
  // eligible, and the operator has not chosen yet. «إنشاء حساب» → the EXISTING setup path with an
  // explanation (O-1 open: no new authentication). The demo choice is not drawn in C1 (X2/C2).
  if (cashier === null && preLoginScreen(entry, preLogin) === "welcome")
    return (
      <div className="app">
        <main className="content">
          <WelcomeScreen
            onCreateAccount={() => dispatchEntry({ type: "choose-create" })}
            onLogin={() => dispatchEntry({ type: "choose-login" })}
            onDemo={offersDemo(entry) && canControlDemo ? () => onDemoAction("enter") : undefined}
            demoPending={demoPending === "enter"}
            demoSlow={demoSlow}
            demoOutcome={demoOutcome}
          />
        </main>
        <BuildLine />
      </div>
    );

  const welcomeEligible = preLoginScreen(entry, null) === "welcome";

  if (cashier === null)
    return (
      <div className="app">
        <main className="content">
          {showsCreateNote(entryUi) && <CreateAccountLegacyNote onBack={() => dispatchEntry({ type: "back" })} />}
          {welcomeEligible && !entryUi.fromCreate && (
            <div className="welcome-back-row">
              <button type="button" className="btn small" data-testid="welcome-back" onClick={() => dispatchEntry({ type: "back" })}>
                {t("welcome.back")}
              </button>
            </div>
          )}
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
    // Signing out ends the cart with the session: the next operator never inherits it.
    setSellDraft(null);
    setCashier(null);
    setSetup(null);
    setTab("sell");
    // C1-R2: never route the next logged-out screen from the hint read at start-up.
    entryLoader.current!.invalidate();
    dispatchEntry({ type: "logout" });
    loadEntry();
  };

  const importCatalog = async () => {
    try {
      const result = await call(pos().importCatalog());
      if (result.status === "cancelled") return;
      setImportResult(result);
      if (result.status === "imported") {
        // A new catalogue starts a fresh till, as it always did (the kept cart is dropped with it).
        setSellDraft(null);
        setCatalogVersion((v) => v + 1);
        setTab("sell");
      }
    } catch (e) {
      setImportResult({ status: "error", titleKey: "import.title.importFailed", message: errorText(e) });
    }
  };

  const exportCatalog = async () => {
    try {
      const result = await call(pos().exportCatalog());
      if (result.status === "cancelled") return;
      setImportResult({ status: "exported", what: "catalog", fileName: result.fileName, productCount: result.productCount });
    } catch (e) {
      setImportResult({ status: "error", titleKey: "import.title.exportFailed", message: errorText(e) });
    }
  };

  const exportBackup = async () => {
    try {
      const result = await call(pos().exportBackup());
      if (result.status === "cancelled") return;
      setImportResult({ status: "exported", what: "backup", fileName: result.fileName });
    } catch (e) {
      setImportResult({ status: "error", titleKey: "import.title.backupFailed", message: errorText(e) });
    }
  };

  return (
    <DemoModeProvider value={demoShell !== "not-demo"}>
    <div className="app">
      <header className="topbar" inert={modalOwner !== null}>
        <strong className="brand">{t("app.name")}</strong>
        <nav className="tabs">
          {(["sell", "today", "history", "products", "customers", "invoices", "tools"] as const).map((name) => (
            <button
              key={name}
              className={tab === name ? "tab active" : "tab"}
              onClick={() => {
                if (!shellFree()) return;
                if (name === "sell" && tab === "sell") setSellFocusRequest((n) => n + 1);
                setTab(name);
              }}
              data-testid={`tab-${name}`}
            >
              {t(`nav.${name}`)}
            </button>
          ))}
        </nav>
        <span className="muted" dir="auto" data-testid="session-name">
          {cashier.name}
        </span>
        {/* DISPLAY ONLY (DEC-35zz++ #7): the LIVE role beside the name, so a seeded owner named «Cashier One» is not read
            as a cashier. Nothing is renamed; the id and the audit history are untouched; access is decided in main. */}
        {(cashier.role === "owner" || cashier.role === "cashier") && (
          <span className={`role-badge role-${cashier.role}`} data-testid="role-badge" data-role={cashier.role}>
            {t(`ops.role.${cashier.role}`)}
          </span>
        )}
        <button
          className="btn ghost"
          onClick={() => shellFree() && setLanguage(lang === "ar" ? "en" : "ar")}
          data-testid="lang-toggle"
          lang={lang === "ar" ? "en" : "ar"}
        >
          {t("lang.toggle")}
        </button>
        {/* F-1: in the demo, logout would leave a login screen where every sign-in is refused (a dead
            end). The demo is left through the banner's «الخروج من التجربة» (main confirms). */}
        {demoShell === "not-demo" && (
          <button className="btn ghost" onClick={() => shellFree() && logout()} data-testid="logout">
            {t("action.logout")}
          </button>
        )}
      </header>
      {demoBanner}
      {demoCatalog && (
        <p className="demo-banner" role="alert" data-testid="demo-banner">
          {t("sell.demoBanner")}
        </p>
      )}
      {showcaseProfile && (
        <p className="demo-banner showcase-banner" role="status" data-testid="showcase-banner">
          {t("app.showcaseBanner")}
        </p>
      )}
      <main className="content">
        {tab === "sell" && (
          <SellScreen
            key={catalogVersion}
            focusRequest={sellFocusRequest}
            role={cashier?.role}
            draft={draftFor(sellDraft, cashier.id)}
            onDraftChange={(d) => setSellDraft({ operatorId: cashier.id, ...d })}
          />
        )}
        {tab === "today" && <TodayScreen role={cashier?.role} demo={demoShell !== "not-demo"} />}
        {tab === "history" && <HistoryScreen role={cashier?.role} />}
        {tab === "products" && <ProductsScreen operator={cashier} />}
        {tab === "customers" && <CustomersScreen operator={cashier} />}
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
      {importResult && <ImportResultDialog result={importResult} onClose={() => setImportResult(null)} />}
    </div>
    </DemoModeProvider>
  );
}
