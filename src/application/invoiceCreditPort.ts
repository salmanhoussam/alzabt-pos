/**
 * The composition of an invoice's credit port from the live party and ledger services.
 *
 * Kept in one place so the application and the test harness build it IDENTICALLY — a test that
 * wired a laxer port than the product would prove nothing about the product.
 */
import { DomainError } from "../domain/errors";
import type { InvoiceCreditPort } from "./invoiceService";
import type { LedgerService } from "./ledgerService";
import type { PartyService } from "./partyService";
import type { PosService } from "./posService";

export function makeInvoiceCreditPort(sources: {
  readonly session: Pick<PosService, "requireLiveRole">;
  /** Lazy: the invoice service is constructed before the party and ledger services. */
  readonly parties: () => PartyService | null;
  readonly ledger: () => LedgerService | null;
}): InvoiceCreditPort {
  const parties = (): PartyService => {
    const p = sources.parties();
    if (!p) throw new DomainError("NOT_AVAILABLE", "Customer accounts are not available on this terminal");
    return p;
  };
  const ledger = (): LedgerService => {
    const l = sources.ledger();
    if (!l) throw new DomainError("NOT_AVAILABLE", "Customer accounts are not available on this terminal");
    return l;
  };
  return {
    requireLiveOwner() {
      // The DURABLE role, re-read — not a variable set at login.
      if (sources.session.requireLiveRole() !== "owner") {
        throw new DomainError("CREDIT_OWNER_ONLY", "Only the shop owner can issue an invoice on a customer account");
      }
    },
    activeCustomer: (id) => parties().activeCustomerForSale(id),
    postReceivable: ({ customerId, saleId, currency, amountMinor }) => {
      const posted = ledger().postObligation({
        partyId: customerId,
        direction: "receivable",
        sourceKind: "sale",
        sourceRef: saleId,
        currency,
        amountMinor,
      });
      return { id: posted.record.id, duplicate: posted.duplicate };
    },
    receivableForSale: (saleId) => {
      const o = ledger().findSaleObligation(saleId);
      return o
        ? { id: o.id, partyId: o.partyId, direction: o.direction, currency: o.currency, amountMinor: o.amountMinor }
        : null;
    },
  };
}
