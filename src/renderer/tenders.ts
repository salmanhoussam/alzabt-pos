import type { SaleTenderDto } from "../shared/ipcContract";
import { fmt } from "./api";

/**
 * SELL-SPLIT-CASH-WHISH (owner, 2026-11-09): how a sale paid by several tenders is named, in ONE place,
 * so History, the receipt and the customer statement can never disagree about it.
 *
 * Each part carries its own method word and amount; a Whish part also carries its reference. Never a
 * single method for a split sale (it has none — `paymentMethod` is null), and never "no method".
 */
export function tenderLabel(tender: SaleTenderDto, t: (key: string) => string): string {
  const word = tender.provider === "whish" ? t("method.whish") : t(`method.${tender.method}`);
  const reference = tender.reference ? ` · ${tender.reference}` : "";
  return `${word} ${fmt(tender.amount)}${reference}`;
}

/** "Cash 40.00 USD + Whish Money 60.00 USD · WH-1" */
export function tendersText(tenders: ReadonlyArray<SaleTenderDto>, t: (key: string) => string): string {
  return tenders.map((x) => tenderLabel(x, t)).join(" + ");
}
