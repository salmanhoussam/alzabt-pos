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
  /**
   * The terminal's un-claimed bootstrap OWNER, or null once the installation has been claimed.
   *
   * 🔴 A STATE, ASKED IN SQL, NOT A HARDCODED ID. "An active owner whose PIN is still the seeded
   * bootstrap credential" is true on a fresh install and on a real v7 -> v8 upgrade alike, and it
   * becomes false for ever the moment that owner completes setup — because `setPin` clears the flag
   * and no path ever re-arms it for an owner. Keying on `cashier-01` by name would have been a
   * rule about one literal rather than about the terminal's condition.
   *
   * Only ONE row can satisfy this: migration 8 seeds exactly one owner with the flag set, and
   * `create` cannot make an owner (roles are assigned afterwards, and only by an owner who has
   * therefore already completed setup). The `LIMIT 1` is belt and braces, not a choice.
   */
  findBootstrapOwner(): OperatorRow | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM operators WHERE role = 'owner' AND must_reset_pin = 1 AND is_active = 1 LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    return normalise(row);
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
