/**
 * Operator accounts: authentication, the mandatory first-run setup, and the owner's management of
 * everyone else. Migration 8.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS REPLACES. `src/fixtures/cashiers.ts` — a frozen TypeScript array compiled into the
 * build, whose own header says "NOT real accounts" — WAS the account store. The shop therefore ran
 * on two accounts named "Cashier One" and "Cashier Two" whose PINs are 1111 and 2222 and are
 * published in this repository, and changing a name or a PIN meant editing source, rebuilding and
 * reinstalling.
 *
 * 🔴 WHERE AUTHORIZATION LIVES. Not here, and not in the renderer. Every restricted channel is
 * refused by one fail-closed table in `src/main/ipcHandlers.ts` before any service method runs, so
 * a channel nobody classified is refused rather than quietly permitted. This class owns the rules
 * that a table cannot express — "the last active owner", "not your own role" — because those need
 * to read the table at the moment they are asked.
 *
 * 🔴 THE SETUP TICKET IS DELIBERATELY ALMOST USELESS. It names ONE operator, it opens NO session,
 * it is consumed the instant a reset succeeds, and `completeSetup` is the only method that accepts
 * it. It cannot manage operators, cannot sell, and cannot be presented to any other channel —
 * there is nowhere else to present it.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import {
  AUDITED_OPERATOR_FIELDS,
  type AuditActorTier,
  type AuditDraft,
  diffAuditedFields,
} from "../domain/audit";
import { businessDateOf } from "../domain/businessDay";
import { DomainError } from "../domain/errors";
import { assertValidPin } from "../domain/pinRule";
import { SCRYPT, pinMatches } from "./cashierAuth";
import type { OperatorRepository, OperatorRole } from "../persistence/operatorRepository";
import type { OperatorRow } from "../persistence/operatorRepository";
import type { AuditRepository } from "../persistence/auditRepository";
import type { TerminalConfig } from "../fixtures/terminal";

/** The session identity, plus the role every authorization decision is made from. */
export interface OperatorSession {
  readonly id: string;
  readonly name: string;
  readonly role: OperatorRole;
}

/** What an operator looks like to the UI. No salt, no hash, no PIN — there is nothing to show. */
export interface OperatorView {
  readonly id: string;
  readonly name: string;
  readonly role: OperatorRole;
  readonly isActive: boolean;
  readonly mustResetPin: boolean;
}

export type LoginOutcome =
  | { readonly kind: "session"; readonly session: OperatorSession }
  /** A legacy bootstrap credential matched. No session exists; setup is the only way forward. */
  | { readonly kind: "setup"; readonly ticket: string; readonly operatorId: string; readonly name: string };

export interface OperatorServiceDeps {
  readonly operators: OperatorRepository;
  /** For the business date on an audit row — the SAME zone every other audit row uses. */
  readonly terminal: TerminalConfig;
  readonly audit?: AuditRepository;
  readonly transact?: <T>(fn: () => T) => T;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Random salt bytes. Injectable so a test can make a hash reproducible; never for production. */
  readonly salt?: () => string;
}

export function toOperatorView(row: OperatorRow): OperatorView {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    isActive: row.is_active === 1,
    mustResetPin: row.must_reset_pin === 1,
  };
}

export class OperatorService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly salt: () => string;

  /**
   * The one outstanding setup ticket, or null.
   *
   * 🔴 ONE SLOT, IN MEMORY, DELIBERATELY. It dies with the process, so a restart cannot resume a
   * half-finished setup — which is the behaviour wanted: the operator logs in again with the
   * bootstrap PIN and starts over. A single slot also means a second bootstrap login invalidates
   * the first ticket rather than leaving two live.
   */
  private ticket: { readonly token: string; readonly operatorId: string } | null = null;

  constructor(private readonly deps: OperatorServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.salt = deps.salt ?? (() => randomBytes(8).toString("hex"));
  }

  // ── Reading ───────────────────────────────────────────────────────────────────────────────────

  /** Who may appear on the login screen. An inactive operator is not offered and cannot sign in. */
  listForLogin(): ReadonlyArray<{ readonly id: string; readonly name: string }> {
    return this.deps.operators.listActive().map((o) => ({ id: o.id, name: o.name }));
  }

  /**
   * The credential a login attempt is made against, plus the name the lockout message needs.
   *
   * Returns a row even when it is INACTIVE, on purpose: the lockout must count a failed attempt
   * against a deactivated account exactly as it would against a live one, and `authenticate`
   * refuses the inactive account afterwards with the same generic message as an unknown id. Doing
   * it the other way round would make "wrong PIN" and "deactivated" distinguishable by timing.
   */
  credentialFor(
    id: string,
  ): { id: string; name: string; credential: { pinSaltHex: string; pinHashHex: string } } | null {
    const row = this.deps.operators.findById(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      credential: { pinSaltHex: row.pin_salt_hex, pinHashHex: row.pin_hash_hex },
    };
  }

  /** Everyone, for the owner's management list. */
  listAll(): OperatorView[] {
    return this.deps.operators.listAll().map(toOperatorView);
  }

  // ── Authentication ────────────────────────────────────────────────────────────────────────────

  /**
   * Verifies a PIN against an operator row and says what the caller may do next.
   *
   * The lockout policy is NOT applied here — `PosService.login` owns it, unchanged, so a bootstrap
   * credential is rate-limited exactly like an ordinary one. This method is the part that knows
   * about roles and `must_reset_pin`.
   */
  authenticate(operatorId: string, pin: string): LoginOutcome {
    const row = this.deps.operators.findById(operatorId);
    // The generic refusal for both "no such operator" and "inactive": the login screen must not
    // become a way to enumerate who exists.
    if (!row || row.is_active !== 1) {
      throw new DomainError("INVALID_CREDENTIALS", "Operator or PIN is incorrect");
    }
    if (!pinMatches({ pinSaltHex: row.pin_salt_hex, pinHashHex: row.pin_hash_hex }, pin)) {
      throw new DomainError("INVALID_CREDENTIALS", "Operator or PIN is incorrect");
    }
    if (row.must_reset_pin === 1) {
      // 🔴 NO SESSION. The credential was correct and it is a bootstrap credential, so the only
      // thing it buys is the setup form.
      const token = randomBytes(24).toString("hex");
      this.ticket = { token, operatorId: row.id };
      return { kind: "setup", ticket: token, operatorId: row.id, name: row.name };
    }
    return { kind: "session", session: { id: row.id, name: row.name, role: row.role } };
  }

  /**
   * Finishes mandatory setup: the operator's real name and their own private PIN.
   *
   * 🔴 TWO AUDIT EVENTS WHEN THE NAME ACTUALLY CHANGED, not one ambiguous one. A rename and a PIN
   * reset are different facts and read back differently a year later; collapsing them would make
   * "when did this person get their name" unanswerable. When the name is unchanged — the operator
   * kept it — no OPERATOR_RENAMED is written, because an event describing no change is not an
   * event.
   *
   * Returns the session, so the normal application may start — and this is the ONLY path from a
   * bootstrap credential to a session.
   */
  completeSetup(ticket: string, name: string, pin: string): OperatorSession {
    const held = this.ticket;
    if (!held || held.token !== ticket) {
      throw new DomainError("SETUP_REQUIRED", "Sign in again to set up this account");
    }
    const row = this.deps.operators.findById(held.operatorId);
    if (!row) throw new DomainError("OPERATOR_NOT_FOUND", "That operator no longer exists");
    if (row.must_reset_pin !== 1) {
      // Belt and braces: the ticket should already be gone, but a cleared flag means someone else
      // finished this setup and a second completion must not rewrite their PIN.
      this.ticket = null;
      throw new DomainError("SETUP_NOT_REQUIRED", "This account has already been set up");
    }

    const cleanName = this.requireFreeName(name, row.id);
    assertValidPin(pin);

    const instant = this.now();
    const session = this.inTransaction(() => {
      if (cleanName !== row.name) {
        const renamed = this.deps.operators.rename(row.id, cleanName, instant.toISOString());
        this.writeAudit("OPERATOR_RENAMED", renamed, row, instant, {
          id: row.id,
          name: cleanName,
          role: row.role,
        }, "bootstrap_setup");
      }
      const withPin = this.deps.operators.setPin(row.id, ...this.hash(pin), instant.toISOString());
      // No field diff: AUDITED_OPERATOR_FIELDS cannot name a PIN field, because the audit domain's
      // SECRET_KEY rejects any key matching /pin|…|hash/i. The event type IS the fact.
      this.writeAudit("OPERATOR_PIN_RESET", withPin, withPin, instant, { id: row.id, name: cleanName, role: withPin.role }, "bootstrap_setup");
      return { id: withPin.id, name: withPin.name, role: withPin.role };
    });

    // Consumed only after the transaction committed. A failed setup leaves the ticket usable, so a
    // refused PIN does not force the operator back through the login screen.
    this.ticket = null;
    return session;
  }

  /** Forgets any outstanding ticket. Called on logout, so a ticket never outlives its screen. */
  clearSetup(): void {
    this.ticket = null;
  }

  // ── Management (owner-only; the channel guard has already refused anyone else) ─────────────────

  create(actor: OperatorSession, input: { name: string; role: OperatorRole; pin: string }): OperatorView {
    const name = this.requireFreeName(input.name, null);
    const role = this.requireAssignableRole(input.role);
    assertValidPin(input.pin);
    const instant = this.now();
    const id = this.newId();
    return this.inTransaction(() => {
      const [saltHex, hashHex] = this.hash(input.pin);
      const row = this.deps.operators.insert({
        id,
        name,
        role,
        pinSaltHex: saltHex,
        pinHashHex: hashHex,
        // A created operator sets their OWN PIN on first login: the owner typed this one, so the
        // owner knows it, and an employee's PIN must not be known to anyone else.
        mustResetPin: true,
        now: instant.toISOString(),
      });
      this.writeAudit("OPERATOR_CREATED", row, null, instant, actor);
      return toOperatorView(row);
    });
  }

  rename(actor: OperatorSession, id: string, name: string): OperatorView {
    const row = this.require(id);
    const clean = this.requireFreeName(name, id);
    if (clean === row.name) return toOperatorView(row);
    const instant = this.now();
    return this.inTransaction(() => {
      const next = this.deps.operators.rename(id, clean, instant.toISOString());
      this.writeAudit("OPERATOR_RENAMED", next, row, instant, actor);
      return toOperatorView(next);
    });
  }

  resetPin(actor: OperatorSession, id: string, pin: string): OperatorView {
    const row = this.require(id);
    assertValidPin(pin);
    const instant = this.now();
    return this.inTransaction(() => {
      const next = this.deps.operators.setPin(id, ...this.hash(pin), instant.toISOString());
      this.writeAudit("OPERATOR_PIN_RESET", next, next, instant, actor);
      return toOperatorView(next);
    });
  }

  setActive(actor: OperatorSession, id: string, active: boolean): OperatorView {
    const row = this.require(id);
    if (!active) this.assertNotLastOwner(row, "deactivated");
    if (row.is_active === (active ? 1 : 0)) return toOperatorView(row);
    const instant = this.now();
    return this.inTransaction(() => {
      const next = this.deps.operators.setActive(id, active, instant.toISOString());
      this.writeAudit(active ? "OPERATOR_ACTIVATED" : "OPERATOR_DEACTIVATED", next, row, instant, actor);
      return toOperatorView(next);
    });
  }

  setRole(actor: OperatorSession, id: string, role: OperatorRole): OperatorView {
    const row = this.require(id);
    const next = this.requireAssignableRole(role);
    // 🔴 An operator may not change their OWN role, owner included. Otherwise the last owner can
    // demote themselves and the shop locks itself out of its own terminal.
    if (actor.id === id) {
      throw new DomainError("SELF_ROLE_CHANGE", "An operator cannot change their own role");
    }
    if (row.role === "owner" && next !== "owner") this.assertNotLastOwner(row, "demoted");
    if (row.role === next) return toOperatorView(row);
    const instant = this.now();
    return this.inTransaction(() => {
      const updated = this.deps.operators.setRole(id, next, instant.toISOString());
      this.writeAudit("OPERATOR_ROLE_CHANGED", updated, row, instant, actor);
      return toOperatorView(updated);
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────

  private require(id: string): OperatorRow {
    const row = this.deps.operators.findById(id);
    if (!row) throw new DomainError("OPERATOR_NOT_FOUND", "That operator no longer exists");
    return row;
  }

  /**
   * 🔴 'admin' IS RESERVED AND NOT ASSIGNABLE. The schema CHECK admits it so that widening it later
   * costs no table rebuild, but v1 has no admin behaviour, and a role with no defined permissions
   * is worse than no role — the operator would be told they are an admin and find they can do
   * exactly what a cashier can.
   */
  private requireAssignableRole(role: string): OperatorRole {
    if (role !== "owner" && role !== "cashier") {
      throw new DomainError("INVALID_INPUT", "A role must be owner or cashier");
    }
    return role;
  }

  /**
   * A name nobody else already uses.
   *
   * 🔴 THE SERVICE IS THE GUARD, NOT THE INDEX. `operators_name` is UNIQUE on the raw column, so
   * SQLite would happily accept "Cashier One" and "cashier one" as two rows. The repository's
   * lookup is `lower(trim(...))`, so this check is the one that actually prevents two operators
   * reading as the same person in an audit row.
   */
  private requireFreeName(name: unknown, allowId: string | null): string {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new DomainError("INVALID_INPUT", "An operator needs a name");
    }
    const clean = name.trim();
    if (clean.length > 60) throw new DomainError("INVALID_INPUT", "That name is too long");
    const existing = this.deps.operators.findByName(clean);
    if (existing && existing.id !== allowId) {
      throw new DomainError("DUPLICATE_OPERATOR_NAME", `Another operator is already called '${clean}'`);
    }
    return clean;
  }

  /** Counted in SQL at the moment it is asked, never from a list fetched earlier. */
  private assertNotLastOwner(row: OperatorRow, what: string): void {
    if (row.role !== "owner" || row.is_active !== 1) return;
    if (this.deps.operators.countActiveOwners() <= 1) {
      throw new DomainError(
        "LAST_OWNER_PROTECTED",
        `The last active owner cannot be ${what} — add another owner first`,
      );
    }
  }

  /** scrypt with a fresh per-operator salt. Returns [saltHex, hashHex]; no plaintext is kept. */
  private hash(pin: string): [string, string] {
    const saltHex = this.salt();
    const hashHex = scryptSync(pin, Buffer.from(saltHex, "hex"), 32, SCRYPT).toString("hex");
    return [saltHex, hashHex];
  }

  private inTransaction<T>(fn: () => T): T {
    return this.deps.transact ? this.deps.transact(fn) : fn();
  }

  /**
   * One audit row for one operator act.
   *
   * `before` null means "created"; `before === after` means there is no field diff to describe,
   * which is the PIN-reset case. The field allowlist (`AUDITED_OPERATOR_FIELDS`) is three names
   * long and cannot include anything matching /pin|…|hash/i, so credential material cannot reach
   * `changed_json` even by mistake — the audit domain throws, which rolls back the mutation.
   */
  private writeAudit(
    eventType: AuditDraft["eventType"],
    after: OperatorRow,
    before: OperatorRow | null,
    instant: Date,
    actor: OperatorSession | { id: string; name: string; role: OperatorRole },
    origin?: string,
  ): void {
    if (!this.deps.audit) return;
    const state = (r: OperatorRow) => ({ is_active: r.is_active, name: r.name, role: r.role });
    const changes =
      before === null
        ? diffAuditedFields(null, state(after), AUDITED_OPERATOR_FIELDS)
        : before === after
          ? {}
          : diffAuditedFields(state(before), state(after), AUDITED_OPERATOR_FIELDS);
    const draft: AuditDraft = {
      eventType,
      entityType: "operator",
      entityId: after.id,
      actorId: actor.id,
      actorName: actor.name,
      actorTier: actor.role as AuditActorTier,
      occurredAt: instant,
      businessDate: businessDateOf(instant, this.deps.terminal.timeZone),
      changes,
      metadata: origin ? { origin } : {},
    };
    this.deps.audit.append(draft, this.newId());
  }
}
