/**
 * Per-cashier PIN lockout state. Unlike the ledger tables this is mutable operational state.
 * `update` runs its read-modify-write inside one BEGIN IMMEDIATE transaction.
 */
import { CLEAR_PIN_STATE, type PinLockoutState } from "../domain/pinLockout";
import type { Db } from "./db";

interface PinRow {
  failed_attempts: bigint;
  locked_until: string | null;
}

export class PinStateRepository {
  constructor(private readonly db: Db) {}

  get(cashierId: string): PinLockoutState {
    const row = this.db
      .prepare("SELECT failed_attempts, locked_until FROM cashier_pin_state WHERE cashier_id = ?")
      .get(cashierId) as PinRow | undefined;
    return row ? { failedAttempts: Number(row.failed_attempts), lockedUntil: row.locked_until } : CLEAR_PIN_STATE;
  }

  /** Reads the current state, lets `fn` decide the next one, and stores it — atomically. */
  update<T>(cashierId: string, now: Date, fn: (current: PinLockoutState) => { next: PinLockoutState; result: T }): T {
    return this.db
      .transaction(() => {
        const { next, result } = fn(this.get(cashierId));
        if (next.failedAttempts === 0 && next.lockedUntil === null) {
          this.db.prepare("DELETE FROM cashier_pin_state WHERE cashier_id = ?").run(cashierId);
        } else {
          this.db
            .prepare(
              `INSERT INTO cashier_pin_state (cashier_id, failed_attempts, locked_until, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT (cashier_id) DO UPDATE SET failed_attempts = excluded.failed_attempts,
                 locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
            )
            .run(cashierId, next.failedAttempts, next.lockedUntil, now.toISOString());
        }
        return result;
      })
      .immediate();
  }
}
