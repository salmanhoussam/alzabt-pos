/**
 * Who may call each IPC channel. ONE table, fail closed, enforced before any service method runs.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE AUTHORIZATION. Hiding a button is a courtesy — the renderer is the untrusted side
 * of the bridge and a `page.evaluate` on `window.pos` reaches every channel directly. A restricted
 * action is restricted because this table says so and `wrap` refuses it, not because the UI chose
 * not to draw it.
 *
 * 🔴 FAIL CLOSED, TWICE. `Record<ChannelName, Access>` makes an unclassified channel a COMPILE
 * error, and `accessFor` throws for a name it does not know, so a channel that somehow reached the
 * bridge without classification is refused rather than quietly permitted. The compile-time half is
 * the one that actually prevents the mistake; the runtime half is for the case where types were
 * bypassed.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { CHANNELS } from "../shared/ipcContract";

export type ChannelName = keyof typeof CHANNELS;

export type Access =
  /** Callable with NO session. Every member is named and justified in PUBLIC_REASON below. */
  | "public"
  /** Any signed-in operator, owner or cashier. */
  | "session"
  /** Owner only. */
  | "owner";

/**
 * Why each public channel is public.
 *
 * 🔴 SALMAN ASKED FOR EXACTLY THREE — listCashiers, login, completeBootstrapSetup — and three is
 * not achievable without breaking the login screen that shipped in UI unification v1. Measured, not
 * assumed: before any session exists the renderer also calls `getSettings` (the app reads its
 * language before it can render anything at all, the login screen included),
 * `setTerminalLanguage` (the PRE-AUTH language toggle, which was a deliberate approved feature of
 * that redesign) and `currentCashier` (App.tsx asking "is anyone signed in?" at startup, which must
 * be answerable with "no").
 *
 * So the set is SIX, each one named with the reason it cannot wait for a session. It is a list of
 * individually justified exceptions, not a category called "pre-session" that future channels can
 * drift into — which is what was actually being guarded against.
 */
export const PUBLIC_REASON: Readonly<Record<string, string>> = Object.freeze({
  listCashiers: "the login screen must offer who to sign in as; returns {id, name} and nothing else",
  login: "the door itself",
  completeBootstrapSetup: "mandatory first-run setup, reachable only with a one-operator setup ticket",
  currentCashier: "App.tsx asks at startup whether anyone is signed in; 'no' is a valid answer",
  getSettings: "the app reads its language before it can render anything, including the login screen",
  setTerminalLanguage: "the pre-auth language toggle on the login screen (UI unification v1)",
  logout: "must always work, including from a half-broken state, and reveals nothing",
});

/**
 * Every channel, classified.
 *
 * 🔴 `Record<ChannelName, Access>` IS THE ENFORCEMENT. Add a channel to `CHANNELS` without adding
 * it here and the build fails. That is deliberately not a runtime check that someone could ship
 * past.
 */
export const CHANNEL_POLICY: Readonly<Record<ChannelName, Access>> = Object.freeze({
  // ── Public: no session. Each justified in PUBLIC_REASON. ──────────────────────────────────────
  listCashiers: "public",
  login: "public",
  completeBootstrapSetup: "public",
  currentCashier: "public",
  logout: "public",
  getSettings: "public",
  setTerminalLanguage: "public",

  // ── Any signed-in operator: the cashier's daily work ──────────────────────────────────────────
  getCatalog: "session",
  createSale: "session",
  getTodaySales: "session",
  getSaleHistory: "session",
  listProducts: "session",
  getAppInfo: "session",

  // The invoice workflow a cashier needs for daily selling. A finalized invoice IS a sale
  // (migration 7), so this is selling, not administration — while the shop's IDENTITY and its
  // numbering stay owner-only below.
  createInvoiceDraft: "session",
  getInvoice: "session",
  updateInvoiceHeader: "session",
  setInvoiceTax: "session",
  addInvoiceLine: "session",
  addInvoiceLines: "session",
  updateInvoiceLine: "session",
  removeInvoiceLine: "session",
  discardInvoiceDraft: "session",
  finalizeInvoice: "session",
  listInvoices: "session",
  listInvoiceDrafts: "session",
  findInvoiceByNumber: "session",
  searchInvoices: "session",
  printInvoice: "session",
  saveInvoicePdf: "session",

  // ── Owner only ────────────────────────────────────────────────────────────────────────────────
  // Reversing money.
  voidSale: "owner",
  // Master data: a price edit is an owner act.
  createProduct: "owner",
  updateProduct: "owner",
  setProductActive: "owner",
  // Replaces or exports the whole price list.
  importCatalog: "owner",
  exportCatalog: "owner",
  // 🔴 The export is EVERY sale the shop ever made. A data-exfiltration surface, not a convenience.
  exportBackup: "owner",
  // The shop's legal identity and its invoice numbering.
  getCompanyProfile: "owner",
  saveCompanyProfile: "owner",
  setNextInvoiceNumber: "owner",
  pickInvoiceLogo: "owner",
  // Reconciliation, including the read. A cashier who can see a queue they cannot resolve is a
  // dead end; Salman closed this as owner-only in v1.
  listReconciliation: "owner",
  listReconciliationQueue: "owner",
  resolveKeepCatalog: "owner",
  resolveKeepInvoiceOnly: "owner",
  resolveLinkProduct: "owner",
  resolveCreateProduct: "owner",
  resolveUpdateCatalog: "owner",
  // Operator management. An owner must not be demotable by an employee.
  listOperators: "owner",
  createOperator: "owner",
  renameOperator: "owner",
  resetOperatorPin: "owner",
  setOperatorActive: "owner",
  setOperatorRole: "owner",
});

/** The classification, or a throw. An unknown channel is REFUSED, never defaulted. */
export function accessFor(channel: string): Access {
  const access = (CHANNEL_POLICY as Record<string, Access | undefined>)[channel];
  if (!access) {
    throw new Error(`channel '${channel}' has no authorization classification; refusing it`);
  }
  return access;
}
