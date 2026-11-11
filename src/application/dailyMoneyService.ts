/**
 * DAILY MONEY IN / OUT — the owner's view of one business day's money. READ-ONLY: it writes nothing,
 * opens no transaction and holds no state; every figure is folded from immutable ledger rows dated on
 * the requested day (see DailyMoneyRepository), so a past day never changes silently.
 *
 * 🔴 OWNER ONLY. Money per channel and per operator is sensitive; a cashier keeps Today's Sales and
 * nothing more (DEC-35x). The channel is owner-classified too; this re-reads the live role on every
 * call, so a role change takes effect at once.
 */
import { buildDailyMoney, type DailyMoneyReport } from "../domain/dailyMoney";
import { businessDateOf } from "../domain/businessDay";
import { DomainError } from "../domain/errors";
import type { DailyMoneyRepository } from "../persistence/dailyMoneyRepository";

export interface DailyMoneyActor {
  readonly id: string;
  readonly role: "owner" | "admin" | "cashier";
}

export interface DailyMoneyServiceDeps {
  readonly repository: DailyMoneyRepository;
  readonly actor: () => DailyMoneyActor | null;
  readonly terminal: { readonly timeZone: string; readonly currency: string };
  readonly now?: () => Date;
}

/**
 * DEC-35z: a REAL calendar date, strictly. `Date.parse("2026-02-31")` rolls over to 3 March instead of
 * refusing, so it is never used here: the parts are rebuilt as a UTC date and must come back identical
 * (2026-02-29 and 2026-04-31 refused; 2028-02-29 accepted). Business day and time zone are unchanged.
 */
export function isCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export class DailyMoneyService {
  private readonly now: () => Date;

  constructor(private readonly deps: DailyMoneyServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** `date` absent → today's business day in the terminal's time zone. */
  day(date?: unknown): DailyMoneyReport {
    const actor = this.deps.actor();
    if (!actor) throw new DomainError("NOT_LOGGED_IN", "Sign in first");
    if (actor.role !== "owner") throw new DomainError("NOT_AUTHORIZED", "Only the owner can see the day's money");
    const today = businessDateOf(this.now(), this.deps.terminal.timeZone);
    let d = today;
    if (date !== undefined && date !== null) {
      if (typeof date !== "string" || !isCalendarDate(date)) {
        throw new DomainError("INVALID_INPUT", "A business date is YYYY-MM-DD");
      }
      if (date > today) throw new DomainError("INVALID_INPUT", "A future business day has no money yet");
      d = date;
    }
    return buildDailyMoney(d, this.deps.terminal.currency, this.deps.repository.rows(d), this.deps.repository.sales(d), this.deps.repository.lateVoids(d));
  }
}
