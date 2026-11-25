/**
 * Main-private synthetic account ceremony. Never imported into preload or
 * exposed over IPC. It establishes no PosService or authenticated session.
 *
 * A brand on the Db is a necessary but not sufficient boundary: the caller
 * must also prove the parent is trusted and synthetic-only (O-2 remains open).
 * This component is not wired into the app's startup.
 */
import { ledgerEmptiness } from "../persistence/ledgerEmptiness";
import { OperatorService } from "../application/operatorService";
import { assertValidPin } from "../domain/pinRule";
import { FIXTURE_TERMINAL } from "../fixtures/terminal";
import { AuditRepository } from "../persistence/auditRepository";
import { schemaVersion, type Db } from "../persistence/db";
import { MIGRATIONS } from "../persistence/migrations";
import { BOOTSTRAP_OWNER_ID, OperatorRepository } from "../persistence/operatorRepository";
import { consumeFreshSyntheticLedgerForSeed } from "./demoProfile";

const CASHIER_ID = "cashier-02";
export class SyntheticAccountSetupError extends Error {
  constructor() { super("Demo account setup failed."); this.name = "SyntheticAccountSetupError"; }
}
export interface SyntheticAccountInput {
  readonly name: string;
  readonly pin: string;
}
declare const authorityBrand: unique symbol;
/** Opaque identity; only this module can register a usable authority. */
export interface SyntheticSeedAuthority { readonly [authorityBrand]: true }
export interface SyntheticSeedGuard {
  verifyOwner(): { readonly id: string; readonly name: string; readonly role: "owner" };
  revoke(): void;
}
type AuthorityState = { readonly db: Db; readonly ownerId: string; state: "issued" | "claimed" | "revoked" };
const authorities = new WeakMap<SyntheticSeedAuthority, AuthorityState>();

export interface SyntheticAccountSetup {
  completeOwner(input: SyntheticAccountInput): { readonly operatorId: string };
  completeCashier(input: SyntheticAccountInput): { readonly operatorId: string };
  takeSeedAuthority(): SyntheticSeedAuthority;
}

/**
 * Claim once and bind by Db object identity. A wrong-Db attempt consumes a
 * genuine authority. This is a prerequisite only: it does not create a writer,
 * select a profile, prove O-2 or issue a session.
 */
export function claimSyntheticSeedAuthority(authority: SyntheticSeedAuthority, db: Db): SyntheticSeedGuard {
  const state = authorities.get(authority);
  if (!state) throw new SyntheticAccountSetupError();
  if (state.state !== "issued") {
    state.state = "revoked";
    throw new SyntheticAccountSetupError();
  }
  if (state.db !== db || !db.open) {
    state.state = "revoked";
    throw new SyntheticAccountSetupError();
  }
  state.state = "claimed";
  const revoke = (): void => { state.state = "revoked"; };
  return Object.freeze({
    verifyOwner: () => {
      try {
        if (state.state !== "claimed" || !db.open) throw new SyntheticAccountSetupError();
        const store = new OperatorRepository(db);
        const owner = store.findById(state.ownerId);
        if (!owner || owner.is_active !== 1 || owner.role !== "owner" || owner.must_reset_pin !== 0 ||
          store.terminalClaim()?.byOperatorId !== state.ownerId) throw new SyntheticAccountSetupError();
        return { id: owner.id, name: owner.name, role: "owner" as const };
      } catch {
        revoke();
        throw new SyntheticAccountSetupError();
      }
    },
    revoke,
  });
}

/**
 * bootstrapCredential is a trusted main-supplied function. Its output and
 * OperatorService's in-memory ticket never cross this module or get logged.
 * The one-shot factory cannot be used with a pre-existing or forged Db.
 */
export function createSyntheticAccountSetup(
  db: Db,
  bootstrapCredential: (operatorId: string) => string,
): SyntheticAccountSetup {
  consumeFreshSyntheticLedgerForSeed(db);
  try {
  const store = new OperatorRepository(db);
  const audit = new AuditRepository(db, { appVersion: "demo", schemaVersion: schemaVersion(db) });
  const operator = new OperatorService({
    operators: store, audit, terminal: FIXTURE_TERMINAL,
    transact: (fn) => db.transaction(fn).immediate(),
    // O-1 P1: the Demo's fresh synthetic ledger gets its owner through the SAME enrollment as a real new shop.
    ledgerEmpty: () => ledgerEmptiness(db).empty,
  });
  let ownerSession: { readonly id: string; readonly name: string; readonly role: "owner" } | null = null;
  let stage: "owner" | "cashier" | "done" | "issued" | "failed" = "owner";
  const stop = (): never => {
    stage = "failed";
    operator.clearSetup();
    if (db.open) db.close();
    throw new SyntheticAccountSetupError();
  };
  const verify = (id: string, role: "owner" | "cashier", setup: boolean): void => {
    const row = store.findById(id);
    if (!row || row.role !== role || row.is_active !== 1 || row.must_reset_pin !== (setup ? 1 : 0)) stop();
  };
  const complete = (input: SyntheticAccountInput, id: string, role: "owner" | "cashier"): { readonly operatorId: string } => {
    try {
      if (stage !== role || schemaVersion(db) !== MIGRATIONS.length) return stop();
      assertValidPin(input.pin);
      // The cashier row is checked AFTER the owner reactivates it (below); enrollment retired it (D-O2).
      if (role === "owner") verify(id, role, true);
      if (store.terminalClaimed() !== (role === "cashier")) return stop();
      // 🔴 O-1 P1 (owner R9, 2026-11-25): NO published PIN and NO bypass, also in the Demo. The previous version
      // signed in with the published bootstrap credential (`bootstrapCredential`) and set up the seeded cashier after
      // the claim — the very gap R-A2 closes. Now the Demo walks the production paths a real shop uses:
      //   owner   -> OperatorService.enrollOwner (empty + unclaimed, re-checked in its transaction)
      //   cashier -> the OWNER reactivates the seeded cashier row and sets its PIN (resetPin => must_reset_pin = 1),
      //              then the cashier signs in with that PIN and completes their own setup.
      // ⚠️ Codex-owned module: flagged for Abu Abbas's review.
      let completed: { readonly id: string; readonly role: string };
      if (role === "owner") {
        const enrolled = operator.enrollOwner(input.name, input.pin);
        if (enrolled.role !== "owner") return stop();
        ownerSession = { id: enrolled.id, name: enrolled.name, role: "owner" };
        completed = enrolled;
      } else {
        if (!ownerSession) return stop();
        operator.setActive(ownerSession, id, true);
        operator.resetPin(ownerSession, id, input.pin);
        verify(id, role, true);
        const auth = operator.authenticate(id, input.pin);
        if (auth.kind !== "setup" || auth.operatorId !== id) return stop();
        // This returns an OperatorSession-shaped value but OperatorService holds
        // no session. Do not create or populate a PosService here.
        completed = operator.completeSetup(auth.ticket, input.name, input.pin);
      }
      if (completed.id !== id || completed.role !== role) return stop();
      verify(id, role, false);
      if (store.terminalClaim()?.byOperatorId !== BOOTSTRAP_OWNER_ID) return stop();
      stage = role === "owner" ? "cashier" : "done";
      return { operatorId: id };
    } catch {
      return stop();
    }
  };
  return Object.freeze({
    completeOwner: (input: SyntheticAccountInput) => complete(input, BOOTSTRAP_OWNER_ID, "owner"),
    completeCashier: (input: SyntheticAccountInput) => complete(input, CASHIER_ID, "cashier"),
    takeSeedAuthority: () => {
      if (stage !== "done" || !db.open || store.terminalClaim()?.byOperatorId !== BOOTSTRAP_OWNER_ID) return stop();
      verify(BOOTSTRAP_OWNER_ID, "owner", false);
      verify(CASHIER_ID, "cashier", false);
      stage = "issued";
      const authority = Object.freeze({}) as SyntheticSeedAuthority;
      authorities.set(authority, { db, ownerId: BOOTSTRAP_OWNER_ID, state: "issued" });
      return authority;
    },
  });
  } catch {
    if (db.open) db.close();
    throw new SyntheticAccountSetupError();
  }
}
