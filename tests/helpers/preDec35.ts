import { LedgerService } from "../../src/application/ledgerService";
import { PosService } from "../../src/application/posService";

/**
 * A STAND-IN FOR A BUILD RELEASED BEFORE DEC-35 (P3, owner 2026-11-07) — test code only.
 *
 * Card, Other and bank-transfer payments are no longer accepted for NEW money. But ledgers written by
 * earlier builds hold such rows, and the tests that prove how those rows are READ (statements, daily
 * totals, receipts, replays, restore) need them to exist. In the field only an older build can write
 * them; here these two subclasses play that build: identical services, except the ONE protected check
 * that P3 added is a no-op.
 *
 * 🔴 NEVER USED TO TEST CURRENT BEHAVIOUR. A test that asks "does the shop accept X today?" uses the real
 * services (the default harness). `tests/application/acceptedPayments.test.ts` proves that nothing in
 * src/ subclasses the services or overrides the check, and that main.ts builds the plain services.
 */
export class PreDec35PosService extends PosService {
  protected override assertAcceptedNewSale(): void {}
}

export class PreDec35LedgerService extends LedgerService {
  protected override assertAcceptedNewCollection(): void {}
}
