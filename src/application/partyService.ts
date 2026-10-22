/**
 * Customer and supplier accounts — creating them, finding them, and correcting their details.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 AN ACCOUNT DIRECTORY, NOT AN ACCOUNTING LEDGER. Nothing here records money. No balance is
 * read, written or returned, because the approved design derives every balance from auditable
 * postings that are a LATER slice. A method called `balanceOf` would have to invent its answer
 * today, so there is none.
 *
 * 🔴 WHO MAY DO WHAT — IT SPLITS TWICE. Registering a CUSTOMER is part of serving one, so any
 * signed-in operator may create and read customers. A SUPPLIER is the shop's own purchasing
 * relationship, so every supplier operation is owner-only. And CHANGING an account that already
 * exists — renaming, re-contacting, archiving — is owner-only for BOTH kinds, because once a later
 * slice hangs obligations off these ids a quietly renamed account is a quietly altered financial
 * relationship. The role is re-read LIVE on every call, so a demotion takes effect on the next
 * action with no logout, exactly as the existing channels behave.
 *
 * 🔴 NOTHING EVER MERGES. `findDuplicateNames` exists so a UI can say "an account with this name
 * already exists" and let the operator decide. Creation is never refused for a shared name and two
 * same-named accounts stay two accounts: two customers really can both be "محمد علي", and reusing
 * one person's account for another would mix two strangers' debts the moment the next slice lands.
 *
 * 🔴 A CORRECTION IS AN APPEND, NOT AN OVERWRITE. `updateContact` writes the new value AND a
 * history row per changed field, in one transaction. A field whose value did not actually change
 * writes no history, which the table's own CHECK (old_value IS NOT new_value) also enforces.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { DomainError } from "../domain/errors";
import {
  MAX_PARTY_ADDRESS,
  MAX_PARTY_NOTE,
  MAX_PARTY_PHONE,
  type PartyContactField,
  type PartyKind,
  normalizedName,
  partyName,
  partyOptional,
} from "../domain/party";
import type { PartyContactHistoryRow, PartyRepository, PartyRow } from "../persistence/partyRepository";

/** Who is acting. Supplied by the POS service, which owns the session and the live role. */
export interface PartyActor {
  readonly id: string;
  readonly name: string;
  readonly role: "owner" | "admin" | "cashier";
}

export interface PartyServiceDeps {
  readonly parties: PartyRepository;
  /** The live operator, re-read on every call. `null` means nobody is signed in. */
  readonly actor: () => PartyActor | null;
  /** `db.transaction(fn).immediate()` — the one connection, the one transaction. */
  readonly transact: <T>(fn: () => T) => T;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface PartyDraft {
  readonly kind: PartyKind;
  readonly displayName: unknown;
  readonly phone?: unknown;
  readonly address?: unknown;
  readonly note?: unknown;
}

/** What a caller may correct. An absent key means "leave it as it is". */
export interface PartyContactPatch {
  readonly displayName?: unknown;
  readonly phone?: unknown;
  readonly address?: unknown;
  readonly note?: unknown;
}

export class PartyService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: PartyServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  }

  // ── Authorization ───────────────────────────────────────────────────────────────────────────

  private requireOperator(): PartyActor {
    const actor = this.deps.actor();
    if (!actor) throw new DomainError("NOT_LOGGED_IN", "Sign in first");
    return actor;
  }

  /**
   * The operator allowed to touch accounts of this kind.
   *
   * 🔴 THE GATE IS THE KIND, not the method name. One function decides it for create, update and
   * archive, so a later method cannot accidentally be laxer than this one.
   */
  private requireFor(kind: PartyKind): PartyActor {
    const actor = this.requireOperator();
    if (kind === "supplier" && actor.role !== "owner") {
      throw new DomainError("NOT_AUTHORIZED", "Only the shop owner can do that");
    }
    return actor;
  }

  /**
   * The operator allowed to CHANGE an account that already exists — owner only, for both kinds.
   *
   * 🔴 S1B NARROWED THIS, AND THE NARROWING IS THE POINT. S1A had one gate: any signed-in operator
   * could do anything to a customer, including renaming or archiving one. Taking a new customer's
   * name at the till is part of serving them, so CREATING stays open to a cashier — but editing or
   * archiving an account that already exists is administration, and once a later slice hangs
   * obligations off these ids, a quietly renamed or archived account is a quietly altered financial
   * relationship. So reading and creating use `requireFor`; everything that mutates an existing row
   * uses this. The change only ever REMOVES permission from a cashier.
   */
  private requireMutator(kind: PartyKind): PartyActor {
    const actor = this.requireFor(kind);
    if (actor.role !== "owner") {
      throw new DomainError("NOT_AUTHORIZED", "Only the shop owner can do that");
    }
    return actor;
  }

  // ── Reading ─────────────────────────────────────────────────────────────────────────────────

  /** Accounts of one kind. Reading a supplier list is owner-only, like changing it. */
  list(kind: PartyKind, includeArchived = false): PartyRow[] {
    this.requireFor(kind);
    return this.deps.parties.listByKind(kind, includeArchived);
  }

  search(kind: PartyKind, query: unknown, includeArchived = false): PartyRow[] {
    this.requireFor(kind);
    if (typeof query !== "string") throw new DomainError("INVALID_INPUT", "A search needs text");
    const needle = query.trim();
    // An empty search is the whole list, not an error and not zero results.
    if (needle.length === 0) return this.deps.parties.listByKind(kind, includeArchived);
    return this.deps.parties.search(kind, needle, includeArchived);
  }

  /**
   * One account by its durable id.
   *
   * 🔴 THE KIND IS CHECKED AFTER THE LOOKUP, so asking for a supplier by a customer's id is a
   * refusal rather than a quietly returned customer. An id is not a kind.
   */
  get(kind: PartyKind, id: unknown): PartyRow {
    this.requireFor(kind);
    if (typeof id !== "string" || id.length === 0) throw new DomainError("INVALID_INPUT", "An account id is required");
    const row = this.deps.parties.findById(id);
    if (!row || row.kind !== kind) throw new DomainError("PARTY_NOT_FOUND", "That account no longer exists");
    return row;
  }

  /** Accounts that READ as the same name. Information for the operator; never acted on here. */
  findDuplicateNames(kind: PartyKind, displayName: unknown): PartyRow[] {
    this.requireFor(kind);
    return this.deps.parties.findSameName(kind, normalizedName(partyName(displayName)));
  }

  history(kind: PartyKind, id: unknown): PartyContactHistoryRow[] {
    const row = this.get(kind, id);
    return this.deps.parties.historyFor(row.id);
  }

  // ── Writing ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Creates an account and returns it, with any same-named accounts alongside.
   *
   * The duplicates are REPORTED, not refused: see this file's header. The caller decides, and if it
   * decides the new account is right, nothing further is needed — it already exists.
   */
  create(draft: PartyDraft): { readonly party: PartyRow; readonly sameName: ReadonlyArray<PartyRow> } {
    const actor = this.requireFor(draft.kind);
    const displayName = partyName(draft.displayName);
    const phone = partyOptional(draft.phone, "phone", MAX_PARTY_PHONE);
    const address = partyOptional(draft.address, "address", MAX_PARTY_ADDRESS);
    const note = partyOptional(draft.note, "note", MAX_PARTY_NOTE);
    const now = this.now().toISOString();

    return this.deps.transact(() => {
      // Read BEFORE the insert so the new row is not reported as its own duplicate.
      const sameName = this.deps.parties.findSameName(draft.kind, normalizedName(displayName));
      const party = this.deps.parties.insert({
        id: this.newId(),
        kind: draft.kind,
        displayName,
        phone,
        address,
        note,
        createdBy: actor.id,
        now,
      });
      return { party, sameName };
    });
  }

  /**
   * Corrects contact details. The new value is stored AND a history row is written per changed
   * field, in one transaction.
   *
   * 🔴 THE HISTORY IS WHAT MAKES THIS SAFE. The approved requirement is that correcting a phone
   * number must not rewrite financial history. Nothing here touches a sale, an invoice or a
   * posting — and the previous value survives as a row, so "what number did we have in March" has
   * an answer.
   */
  updateContact(kind: PartyKind, id: unknown, patch: PartyContactPatch): PartyRow {
    const existing = this.get(kind, id);
    const actor = this.requireMutator(kind);
    const now = this.now().toISOString();

    const next: Partial<Record<PartyContactField, string | null>> = {};
    if (patch.displayName !== undefined) next.display_name = partyName(patch.displayName);
    if (patch.phone !== undefined) next.phone = partyOptional(patch.phone, "phone", MAX_PARTY_PHONE);
    if (patch.address !== undefined) next.address = partyOptional(patch.address, "address", MAX_PARTY_ADDRESS);
    if (patch.note !== undefined) next.note = partyOptional(patch.note, "note", MAX_PARTY_NOTE);

    return this.deps.transact(() => {
      const changed: Array<[PartyContactField, string | null, string | null]> = [];
      for (const field of Object.keys(next) as PartyContactField[]) {
        const before = existing[field] ?? null;
        const after = next[field] ?? null;
        if (before !== after) changed.push([field, before, after]);
      }
      if (changed.length === 0) return existing;

      const row = this.deps.parties.update(
        existing.id,
        {
          ...(next.display_name !== undefined && next.display_name !== null ? { displayName: next.display_name } : {}),
          ...(next.phone !== undefined ? { phone: next.phone } : {}),
          ...(next.address !== undefined ? { address: next.address } : {}),
          ...(next.note !== undefined ? { note: next.note } : {}),
        },
        now,
      );
      for (const [field, oldValue, newValue] of changed) {
        this.deps.parties.appendHistory({
          id: this.newId(),
          party_id: existing.id,
          field,
          old_value: oldValue,
          new_value: newValue,
          changed_by: actor.id,
          changed_at: now,
        });
      }
      return row;
    });
  }

  /**
   * Archives or restores an account. There is no delete, by schema trigger as well as by design:
   * an account an operator named is a record of a real relationship, and a later obligation will
   * point at it.
   */
  setActive(kind: PartyKind, id: unknown, isActive: unknown): PartyRow {
    const existing = this.get(kind, id);
    this.requireMutator(kind);
    if (typeof isActive !== "boolean") throw new DomainError("INVALID_INPUT", "'isActive' must be true or false");
    const now = this.now().toISOString();
    return this.deps.transact(() => this.deps.parties.update(existing.id, { isActive }, now));
  }
}
