/**
 * The decisions the Customer directory makes, as pure functions.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THESE ARE NOT IN THE COMPONENTS. `vitest.config.mts` is `environment: "node"` and this
 * repository has no DOM harness, so anything decided inside a component is only reachable by an
 * installed-app E2E — which is exactly how `screenFor`'s ordering bug reached a shop once. Every
 * rule a reviewer would want to check lives here instead, tested in milliseconds.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import type { CustomerDto } from "../shared/ipcContract";
import { normalizedName } from "../domain/party";

/**
 * May this operator CHANGE a customer that already exists?
 *
 * 🔴 THE SCREEN ASKS THIS TO DECIDE WHAT TO DRAW, AND THE MAIN PROCESS DECIDES IT AGAIN. A hidden
 * button is not authorization — `channelPolicy` classifies `updateCustomerContact` and
 * `setCustomerActive` as "owner" and `PartyService.requireMutator` re-reads the live role — so this
 * function exists to avoid showing a control that would be refused, never to grant anything.
 */
export function mayMutateCustomers(role: string | null | undefined): boolean {
  return role === "owner";
}

/** May this operator add a customer? Any signed-in operator, so the till can take a name. */
export function mayCreateCustomers(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin" || role === "cashier";
}

/**
 * Accounts in a list that read as the same name as `displayName`.
 *
 * Used to warn, never to merge or to block. Compared with the same normalisation the service uses,
 * so the screen and the database agree about what "the same name" means.
 */
export function sameNamed(list: readonly CustomerDto[], displayName: string, exceptId?: string): CustomerDto[] {
  const target = normalizedName(displayName);
  return list.filter((c) => c.id !== exceptId && normalizedName(c.displayName) === target);
}

/**
 * What to show beside a customer so an operator can tell two same-named people apart.
 *
 * 🔴 IT RETURNS A DISTINGUISHING DETAIL, NOT AN INDEX. Labelling them "محمد علي 1" and "محمد علي 2"
 * would be a number the merchant has no way to recognise; the phone, then the address, then the
 * note, are things they actually know about the person. Empty when the two are genuinely
 * indistinguishable, which is itself the honest answer.
 */
export function disambiguator(customer: CustomerDto): string {
  return customer.phone ?? customer.address ?? customer.note ?? "";
}

/**
 * Is this name acceptable to send? Mirrors `partyName`'s rule so the operator is told BEFORE a
 * round trip, while the main process still refuses it independently.
 */
export function nameIsValid(raw: string): boolean {
  return raw.trim().length > 0;
}

/**
 * The patch to send for an edit: only the fields that actually changed.
 *
 * 🔴 AN UNTOUCHED FIELD MUST BE ABSENT, NOT RESENT. The contract is a patch precisely so a value
 * changed elsewhere while this form was open is not reverted to what the form happened to show, and
 * so an unchanged field writes no contact-history row.
 */
export function contactPatch(
  before: CustomerDto,
  form: { displayName: string; phone: string; address: string; note: string },
): {
  displayName?: string;
  phone?: string | null;
  address?: string | null;
  note?: string | null;
} {
  const patch: Record<string, string | null> = {};
  const name = form.displayName.trim();
  if (name !== before.displayName) patch.displayName = name;
  for (const [key, raw, old] of [
    ["phone", form.phone, before.phone],
    ["address", form.address, before.address],
    ["note", form.note, before.note],
  ] as const) {
    const next = raw.trim().length === 0 ? null : raw.trim();
    if (next !== old) patch[key] = next;
  }
  return patch;
}
