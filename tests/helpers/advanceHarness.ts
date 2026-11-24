/**
 * The advance service on a REAL harness: same connection, same `transact`, the live operator from the
 * real session (so authorization is the product's own), the terminal's own currency and time zone.
 */
import { type AdvanceActor, AdvanceService, type AdvanceServiceDeps } from "../../src/application/advanceService";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { AdvanceRepository } from "../../src/persistence/advanceRepository";
import type { Harness } from "./harness";

export function advanceDeps(h: Harness, repo: AdvanceRepository = new AdvanceRepository(h.db)): AdvanceServiceDeps {
  return {
    advances: repo,
    ledger: h.ledgerStore,
    parties: h.partyStore,
    actor: (): AdvanceActor | null => {
      const cashier = h.service.currentCashier();
      const role = h.service.currentRole();
      return cashier && role ? { id: cashier.id, name: cashier.name, role } : null;
    },
    transact: (fn) => h.db.transaction(fn).immediate(),
    terminal: { timeZone: FIXTURE_TERMINAL.timeZone, currency: FIXTURE_TERMINAL.currency },
    now: h.clock.now,
    // DEC-35x: the REAL owner-only credit sale of the same harness (same connection, same transaction).
    creditSale: (input) => h.service.createCustomerCreditSale(input),
  };
}

export function makeAdvances(h: Harness, repo?: AdvanceRepository): AdvanceService {
  return new AdvanceService(advanceDeps(h, repo));
}
