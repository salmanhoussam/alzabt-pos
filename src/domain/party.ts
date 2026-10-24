/**
 * A party: a customer the shop sells to, or a supplier it buys from. Identity only.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE HOLDS NO MONEY, AND THAT IS THE DESIGN. There is no balance, no currency, no credit
 * limit and no total here. Every balance in the approved design is DERIVED from auditable postings
 * (obligations, settlements, adjustments), which are a later slice. A convenience field here would
 * have silently pre-decided that design and created a second source of truth that drifts.
 *
 * 🔴 A NAME IS NOT AN IDENTITY. Two customers may genuinely both be "محمد علي", so the name is
 * neither unique nor a key — the durable id is. `sameNameAs` exists so a service can TELL the
 * operator an account with this name already exists; nothing here merges, and nothing refuses a
 * name for being taken.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { DomainError } from "./errors";

/** Which side of the ledger this account will eventually sit on. Fixed when the party is created. */
export const PARTY_KINDS = ["customer", "supplier"] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export function isPartyKind(value: unknown): value is PartyKind {
  return typeof value === "string" && (PARTY_KINDS as readonly string[]).includes(value);
}

/** The four fields an operator may correct after the account exists. */
export const PARTY_CONTACT_FIELDS = ["display_name", "phone", "address", "note"] as const;
export type PartyContactField = (typeof PARTY_CONTACT_FIELDS)[number];

export const MAX_PARTY_NAME = 120;
export const MAX_PARTY_PHONE = 40;
export const MAX_PARTY_ADDRESS = 300;
export const MAX_PARTY_NOTE = 500;

/**
 * The display name, trimmed.
 *
 * 🔴 TRIMMED BUT NEVER TRANSLITERATED OR CASE-FOLDED FOR STORAGE. What the merchant typed is what
 * the merchant reads back: "Ahmad" stays "Ahmad" and "أحمد" stays "أحمد". Case- and
 * whitespace-insensitivity belongs to SEARCH (`normalizedName`), not to storage.
 */
export function partyName(raw: unknown): string {
  if (typeof raw !== "string") throw new DomainError("INVALID_INPUT", "An account needs a name");
  const name = raw.trim();
  if (name.length === 0) throw new DomainError("INVALID_INPUT", "An account needs a name");
  if (name.length > MAX_PARTY_NAME) {
    throw new DomainError("INVALID_INPUT", `A name must be at most ${MAX_PARTY_NAME} characters`);
  }
  return name;
}

/**
 * An optional field: absent, or real text.
 *
 * 🔴 EMPTY AND ABSENT ARE THE SAME THING, AND BOTH BECOME NULL. The column refuses a blank string
 * precisely so there is one representation of "not given"; a UI that sends "" for an untouched box
 * must not create a row the schema would reject.
 */
export function partyOptional(raw: unknown, field: string, max: number): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new DomainError("INVALID_INPUT", `'${field}' must be text`);
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.length > max) {
    throw new DomainError("INVALID_INPUT", `'${field}' must be at most ${max} characters`);
  }
  return value;
}

/**
 * The form a SEARCH compares, and the form a same-name warning compares. Never stored.
 *
 * Case-folded, inner whitespace collapsed, and Arabic-Indic digits normalised to 0-9 so a phone or
 * a name typed with ٠١٢ matches one typed with 012 — the same rule the rest of the product applies
 * to typed input.
 */
export function normalizedName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Would these two names look like the same account to an operator? Information, never a merge. */
export function sameNameAs(a: string, b: string): boolean {
  return normalizedName(a) === normalizedName(b);
}
