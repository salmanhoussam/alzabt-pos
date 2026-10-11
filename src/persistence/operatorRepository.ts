/**
 * The `operators` table. Prisma-free, prepared statements, no business rules.
 *
 * 🔴 WHAT THIS FILE REPLACES. Until migration 8 the account store was `src/fixtures/cashiers.ts` —
 * a frozen TypeScript array compiled into the build, whose own header says "NOT real accounts".
 * Changing an operator's name or PIN meant editing source, rebuilding and reinstalling, and the
 * two accounts it shipped have PINs that are published in this repository.
 *
 * Mutable master data, NOT ledger: rows are updated in place and deactivated, never deleted. No
 * sale references them — `sales.cashier_id` is a plain TEXT snapshot with no foreign key — so
 * nothing here can alter a past sale, which is the same discipline the catalog already follows.
 */
import type { Db } from "./db";

export type OperatorRole = "owner" | "admin" | "cashier";

/**
 * The one operator migration 8 seeds as the terminal's bootstrap OWNER.
 *
 * 🔴 EXPLICIT, AND DELIBERATELY NOT A SEARCH. While the terminal is unclaimed, exactly this id may
 * enter the ownership ceremony. The previous build searched for "an active owner with a bootstrap
 * credential, lowest id first", which let a randomUUID decide who owned a shop's terminal. The
 * seeded identity is a fact written into migration 8's own SQL, so it is named here as one.
 *
 * It governs the unclaimed terminal ONLY. Once claimed, this constant is never consulted again —
 * ownership is a role, held by whoever the owner says, and this id has no standing privilege.
 */
export const BOOTSTRAP_OWNER_ID = "cashier-01";

export interface OperatorRow {
  readonly id: string;
  readonly name: string;
  readonly role: OperatorRole;
  readonly pin_salt_hex: string;
  readonly pin_hash_hex: string;
  readonly must_reset_pin: number;
  readonly is_active: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS = `id, name, role, pin_salt_hex, pin_hash_hex, must_reset_pin, is_active,
                 created_at, updated_at`;

/** A row as the rest of the app sees it — bigints normalised, secrets still present. */
function normalise(row: Record<string, unknown> | undefined): OperatorRow | null {
  if (!row) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    role: row.role as OperatorRole,
    pin_salt_hex: row.pin_salt_hex as string,
    pin_hash_hex: row.pin_hash_hex as string,
    must_reset_pin: Number(row.must_reset_pin),
    is_active: Number(row.is_active),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export class OperatorRepository {
  constructor(private readonly db: Db) {}

  findById(id: string): OperatorRow | null {
    return normalise(
      this.db.prepare(`SELECT ${COLUMNS} FROM operators WHERE id = ?`).get(id) as Record<string, unknown>,
    );
  }

  /** Case- and space-insensitive, because two operators must not read as the same person. */
  findByName(name: string): OperatorRow | null {
    return normalise(
      this.db
        .prepare(`SELECT ${COLUMNS} FROM operators WHERE lower(trim(name)) = lower(trim(?))`)
        .get(name) as Record<string, unknown>,
    );
  }

  /** Every operator, active first then by name — what the owner's management list shows. */
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // 🔴 THE TERMINAL'S OWNERSHIP STATE — ASKED, NEVER INFERRED.
  //
  // What stood here was `findBootstrapOwner()`: a query that deduced whether the terminal had been
  // claimed from the shape of the `operators` rows —
  //
  //     role = 'owner' AND must_reset_pin = 1 AND is_active = 1
  //       AND NOT EXISTS (SELECT 1 FROM operators WHERE must_reset_pin = 0)
  //     ORDER BY id LIMIT 1
  //
  // Three independent reviews narrowed its comment, and the fourth proved the predicate itself
  // wrong by execution. `NOT EXISTS (… must_reset_pin = 0)` means "nobody currently holds a
  // credential they chose themselves" — an ACCOUNT fact, which `resetPin` can un-make at any time.
  // With two owners, an owner who resets a colleague's PIN and then their own satisfies it again,
  // and `ORDER BY id` then handed the exemption to the LOWEST id rather than to the person acting.
  // Real ids are randomUUID, whose first hex character sorts before `cashier-01`'s 'c' for twelve
  // of sixteen values, so roughly three times in four the acting owner was refused their own setup
  // screen and the only way back in was to sign in AS the colleague with the temporary PIN they had
  // just typed — the exact impersonation the temporary-PIN rule exists to prevent, writing audit
  // rows attributed to the wrong person.
  //
  // Each narrowing of that comment was true and none of them helped, because the defect was not in
  // the wording: a terminal fact was being read out of account facts. So the state is now durable
  // and explicit, and the two questions never answer each other again:
  //
  //     must_reset_pin    does THIS PERSON still need to choose a private credential?
  //     terminal_claimed  has THIS TERMINAL already been claimed by its real owner?
  //
  // No ordering. No subquery over `operators`. No lowest-id search. One row, one column, asked.
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * True once the real owner has completed the one-time installation/upgrade ownership ceremony.
   *
   * Fails CLOSED: if the singleton row is somehow absent, this answers `false`, which arms the
   * ceremony rather than opening the terminal. Migration 8 seeds the row, so absence means a
   * hand-edited database — and the safe reading of a missing security record is "not satisfied".
   */
  terminalClaimed(): boolean {
    const row = this.db
      .prepare(`SELECT terminal_claimed FROM terminal_security_state WHERE id = 'terminal'`)
      .get() as Record<string, unknown> | undefined;
    return row ? Number(row.terminal_claimed) === 1 : false;
  }

  /**
   * Who claimed the terminal and when.
   *
   * 🔴 READ BY TESTS TODAY, AND BY NOTHING ELSE. The previous sentence here said "for the operators
   * screen", which no screen does — an independent review caught it by grepping for the callers.
   * That is the same defect class as the comments this whole change exists to correct: a sentence
   * asserting a consumer that is not there. It is kept because the claim record is what the
   * ceremony's regression tests assert against, and because surfacing it on the operators screen is
   * a real future use — but the comment now says what is true, not what sounds complete.
   */
  terminalClaim(): { readonly claimedAt: string; readonly byOperatorId: string } | null {
    const row = this.db
      .prepare(
        `SELECT claimed_at, claimed_by_operator_id FROM terminal_security_state
          WHERE id = 'terminal' AND terminal_claimed = 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      claimedAt: row.claimed_at as string,
      byOperatorId: row.claimed_by_operator_id as string,
    };
  }

  /**
   * Marks the terminal claimed. Called ONLY from inside the setup transaction, so the flag and the
   * owner's final credential commit together or not at all.
   *
   * 🔴 `WHERE terminal_claimed = 0` makes this idempotent AND one-way at the SQL level: a second
   * call matches no row, so a claim can never be re-attributed, and nothing in this file can set
   * the flag back to 0 — there is no such statement anywhere in the application.
   */
  claimTerminal(operatorId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE terminal_security_state
            SET terminal_claimed = 1, claimed_at = ?, claimed_by_operator_id = ?
          WHERE id = 'terminal' AND terminal_claimed = 0`,
      )
      .run(now, operatorId);
  }

  listAll(): OperatorRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM operators ORDER BY is_active DESC, name`)
        .all() as Array<Record<string, unknown>>
    ).map((r) => normalise(r)!);
  }

  /** Only operators who may authenticate — what the login screen offers. */
  listActive(): OperatorRow[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM operators WHERE is_active = 1 ORDER BY name`)
        .all() as Array<Record<string, unknown>>
    ).map((r) => normalise(r)!);
  }

  /**
   * How many ACTIVE owners exist.
   *
   * The one question the "last owner" rules are built on. Counted in SQL rather than by filtering a
   * list in TypeScript, so the check reads the table at the moment it is asked.
   */
  countActiveOwners(): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM operators WHERE is_active = 1 AND role = 'owner'")
      .get() as { n: bigint };
    return Number(row.n);
  }

  insert(row: {
    readonly id: string;
    readonly name: string;
    readonly role: OperatorRole;
    readonly pinSaltHex: string;
    readonly pinHashHex: string;
    readonly mustResetPin: boolean;
    readonly now: string;
  }): OperatorRow {
    this.db
      .prepare(
        `INSERT INTO operators (${COLUMNS})
         VALUES (@id, @name, @role, @pinSaltHex, @pinHashHex, @mustResetPin, 1, @now, @now)`,
      )
      .run({ ...row, mustResetPin: row.mustResetPin ? 1 : 0 });
    return this.findById(row.id)!;
  }

  rename(id: string, name: string, now: string): OperatorRow {
    this.db.prepare("UPDATE operators SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
    return this.findById(id)!;
  }

  /**
   * Replaces the credential and sets `must_reset_pin` in the same statement.
   *
   * 🔴 ONE STATEMENT ON PURPOSE. A new hash written without setting the flag correctly would either
   * leave an operator permanently trapped in setup, or leave a credential someone else chose live
   * as an ordinary one. Neither half is ever correct alone, so both move together or not at all.
   *
   * 🔴 AND THE CALLER MUST SAY WHICH KIND OF CREDENTIAL THIS IS. It used to hard-code
   * `must_reset_pin = 0`, which was right for setup and wrong for an owner's reset: the owner typed
   * that PIN, so they know it, and nothing ever forced the employee off it. An independent review
   * found that an owner could then sign in as that employee and ring a sale the ledger attributes
   * to them — impersonation inside the one record operator accounts exist to make trustworthy.
   *
   *   `mustResetPin: false`  the operator chose this themselves, in setup. Final.
   *   `mustResetPin: true`   somebody else chose it. Temporary: it buys the setup form only.
   */
  setPin(
    id: string,
    pinSaltHex: string,
    pinHashHex: string,
    now: string,
    opts: { readonly mustResetPin: boolean },
  ): OperatorRow {
    this.db
      .prepare(
        `UPDATE operators
            SET pin_salt_hex = ?, pin_hash_hex = ?, must_reset_pin = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(pinSaltHex, pinHashHex, opts.mustResetPin ? 1 : 0, now, id);
    return this.findById(id)!;
  }

  setActive(id: string, active: boolean, now: string): OperatorRow {
    this.db
      .prepare("UPDATE operators SET is_active = ?, updated_at = ? WHERE id = ?")
      .run(active ? 1 : 0, now, id);
    return this.findById(id)!;
  }

  setRole(id: string, role: OperatorRole, now: string): OperatorRow {
    this.db.prepare("UPDATE operators SET role = ?, updated_at = ? WHERE id = ?").run(role, now, id);
    return this.findById(id)!;
  }
}
