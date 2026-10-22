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
  | "owner"
  /**
   * Owner, OR a cashier the owner has explicitly granted "may create products" (migration 11).
   *
   * 🔴 THIS LEVEL CANNOT BE DECIDED FROM THE ROLE ALONE, which is why it exists as its own value
   * rather than being folded into "session". The guard resolves it by asking the SERVICE, which
   * re-reads the durable operator row — so this table still classifies every channel, and the
   * per-operator half of the answer lives in the one place that owns it.
   *
   * It is deliberately NOT a general "cashier may do product things" level. Exactly two channels
   * carry it, and the service refuses the half of `startPhoneSession` (EDIT_PRODUCT) that a
   * cashier may not reach.
   */
  | "create-products";

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
 * So the set is SEVEN, each one named with the reason it cannot wait for a session: the five above
 * plus `login` itself and `logout`, which must work from a half-broken state and reveals nothing.
 * It is a list of individually justified exceptions, not a category called "pre-session" that future
 * channels can drift into — which is what was actually being guarded against.
 *
 * 🔴 This prose said SIX while PUBLIC_REASON held seven entries, and an independent review caught
 * it. A wrong count matters more here than it normally would: this list IS the control for the
 * category, so a reader who trusts the number would be auditing a set one smaller than the real one.
 *
 * 🔴 TOTALS, MEASURED — AND ONLY ONE OF THESE THREE NUMBERS IS A SECURITY CLAIM.
 * Product Master (migration 9) added ten channels, so the table grew:
 *
 *     before Product Master:  7 public · 22 session · 24 owner · 53 total
 *     after  Product Master:  7 public · 24 session · 32 owner · 63 total
 *     after  list thumbnails: 7 public · 26 session · 30 owner · 63 total
 *     after  online catalog: 7 public · 26 session · 31 owner · 64 total   (slice G3)
 *     after  phone sessions: 7 public · 26 session · 33 owner · 66 total   (slice H1)
 *     after  the phone form: 7 public · 26 session · 34 owner · 67 total   (slice H2)
 *
 * THE PUBLIC SET DID NOT MOVE, which is the only one of the three numbers that is a security
 * claim — the four new reads (listCategories, listBrands and, once the products list had to show
 * thumbnails, getProductImageMeta and getProductImageBytes) are session, and all six Product
 * Master MUTATIONS are owner. The session/owner totals are reported for the
 * reader's orientation and are NOT what any test asserts: `channelPolicy.test.ts` derives
 * everything from the table and pins the public set BY NAME, so a drift fails by naming the
 * channel that drifted rather than by a number nobody can interpret.
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

  // Product Master READS a cashier needs to make sense of the products list: a product shows the
  // NAME of its category, not its id, and the Brand field offers what the shop has already typed.
  // Both are read-only, both return the minimum read model, and neither can change anything.
  //
  // 🔴 Why these two and not the rest: every other Product Master channel either MUTATES master
  // data or returns a photo, and both are owner acts. "A cashier can see it on the list" is the
  // whole of the justification, and it does not extend to anything below.
  listCategories: "session",
  listBrands: "session",

  // 🔴 THE PHOTO READS ARE SESSION — A RECLASSIFICATION, AND THE OLD VALUE IS NAMED. Both were
  // `owner`, justified as "the only V1 surface that reads a photo is the owner's Add/Edit form".
  // That stopped being true when the products LIST was required to show thumbnails: a cashier may
  // read that list, so either a cashier may fetch the photos on it or the feature is owner-only in
  // practice and every cashier sees placeholders.
  //
  // What this exposes is the shop's own product photograph — bound for a public website — to an
  // operator already looking at that product's name, SKU and price on the same row. The list gives
  // out no bytes at all: it carries `hasImage`, `primaryImageId` and a content hash, and the
  // renderer asks for the few photos actually on screen.
  getProductImageMeta: "session",
  getProductImageBytes: "session",

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
  // 🔴 CREATE IS NO LONGER OWNER-ONLY, AND THE CHANNEL SAYS SO HONESTLY. An owner may always;
  // a cashier may only with the explicit durable grant. The service decides — `createProduct`
  // calls `requireProductCreator()` itself — so a forged call that reaches the service still
  // fails, and this entry is the renderer-facing half of the same rule rather than the whole of
  // it. Editing an EXISTING product stays an owner act: a price edit is not a creation.
  createProduct: "create-products",
  updateProduct: "owner",
  setProductActive: "owner",
  // Replaces or exports the whole price list.
  importCatalog: "owner",
  exportCatalog: "owner",
  // Slice G. Owner, like every other export: it reads the whole catalogue and writes files
  // outside the application, and a cashier has no business doing either.
  exportOnlineCatalog: "owner",
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
  // Product Master (migration 9). Master data and the shop's own photographs.
  //
  // 🔴 THE MUTATIONS ARE OWNER. Changing a product's photo is a master-data act, like its price.
  createCategory: "owner",
  // ── Customer directory (S1B) ──────────────────────────────────────────────────────────────────
  //
  // 🔴 "session" FOR READ AND CREATE, "owner" FOR EVERY CHANGE. A cashier takes a new customer's
  // name at the till, so searching, opening and creating are open to any signed-in operator;
  // renaming, re-contacting and archiving an account that already exists are administration.
  //
  // 🔴 AND DELIBERATELY NOT "create-products". That level is a per-operator product capability, and
  // whether an employee may add Products has nothing to do with whether they may write down a
  // customer's name. Reusing it would have tied two unrelated permissions together forever.
  searchCustomers: "session",
  getCustomer: "session",
  createCustomer: "session",
  updateCustomerContact: "owner",
  setCustomerActive: "owner",
  renameCategory: "owner",
  setCategoryActive: "owner",
  deleteCategory: "owner",
  setProductImage: "owner",
  removeProductImage: "owner",
  // Phone entry over the LAN (slice H1).
  //
  // 🔴 OWNER, AND THE SERVICE CHECKS AGAIN. `startPhoneSession` opens this product's only inbound
  // network surface — a strictly bigger act than editing a price, so there is no reading on which
  // a cashier should reach it. `PosService.authorizePhoneSession` enforces owner independently,
  // because the listener it opens calls the service directly and never passes back through here.
  //
  // `cancelPhoneSession` is owner too. Letting a cashier close a surface they could not open is a
  // smaller hole than the alternative, but it is still an operator acting on an owner's session,
  // and expiry already guarantees the surface closes without anyone's help.
  // 🔴 THE ACTION DECIDES, AND THE ACTION IS NOT VISIBLE HERE. A NEW_PRODUCT session may be opened
  // by a granted cashier; an EDIT_PRODUCT session may not. A static table cannot express "it
  // depends on the payload", so this admits the narrower set of operators and
  // `authorizePhoneSession` refuses the EDIT half for anyone who is not an owner. Cancel and state
  // stay owner-only: a cashier who opened a create session does not need to inspect or close
  // anyone's, and expiry closes it without help.
  startPhoneSession: "create-products",
  cancelPhoneSession: "owner",
  // Owner too. It reports whether a phone has claimed the code and which product was just saved —
  // the shape of an owner's in-flight administrative act, and nothing a cashier has a use for.
  phoneSessionState: "owner",
  // Operator management. An owner must not be demotable by an employee.
  listOperators: "owner",
  createOperator: "owner",
  renameOperator: "owner",
  resetOperatorPin: "owner",
  setOperatorActive: "owner",
  setOperatorRole: "owner",
  // Granting the create capability is itself an owner act — otherwise the permission could grant
  // itself onwards.
  setOperatorMayCreateProducts: "owner",
});

/** The classification, or a throw. An unknown channel is REFUSED, never defaulted. */
export function accessFor(channel: string): Access {
  const access = (CHANNEL_POLICY as Record<string, Access | undefined>)[channel];
  if (!access) {
    throw new Error(`channel '${channel}' has no authorization classification; refusing it`);
  }
  return access;
}
