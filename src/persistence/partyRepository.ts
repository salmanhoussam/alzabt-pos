/**
 * The `parties` and `party_contact_history` tables. Prepared statements, no business rules.
 *
 * 🔴 WHAT THIS FILE REFUSES TO DECIDE. It does not decide who may create a supplier, whether a
 * same-named account is the same person, or whether an edit is worth recording — those are
 * business rules and they live in `partyService`. It exposes `findSameName` and `appendHistory`
 * separately so the service can take both in ONE transaction and this file stays statements.
 *
 * 🔴 AND IT HOLDS NO MONEY. There is no balance here because there is no balance column; see
 * migration 12's own note on why a derived balance is the approved design.
 */
import type { Db } from "./db";
import type { PartyContactField, PartyKind } from "../domain/party";

export interface PartyRow {
  readonly id: string;
  readonly kind: PartyKind;
  readonly display_name: string;
  readonly phone: string | null;
  readonly address: string | null;
  readonly note: string | null;
  readonly is_active: number;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PartyContactHistoryRow {
  readonly id: string;
  readonly party_id: string;
  readonly field: PartyContactField;
  readonly old_value: string | null;
  readonly new_value: string | null;
  readonly changed_by: string;
  readonly changed_at: string;
}

const COLUMNS = `id, kind, display_name, phone, address, note, is_active, created_by, created_at, updated_at`;
const HISTORY_COLUMNS = `id, party_id, field, old_value, new_value, changed_by, changed_at`;

function party(row: Record<string, unknown> | undefined): PartyRow | null {
  if (!row) return null;
  return {
    id: row.id as string,
    kind: row.kind as PartyKind,
    display_name: row.display_name as string,
    phone: (row.phone as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    is_active: Number(row.is_active),
    created_by: row.created_by as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function history(row: Record<string, unknown>): PartyContactHistoryRow {
  return {
    id: row.id as string,
    party_id: row.party_id as string,
    field: row.field as PartyContactField,
    old_value: (row.old_value as string | null) ?? null,
    new_value: (row.new_value as string | null) ?? null,
    changed_by: row.changed_by as string,
    changed_at: row.changed_at as string,
  };
}

export interface NewParty {
  readonly id: string;
  readonly kind: PartyKind;
  readonly displayName: string;
  readonly phone: string | null;
  readonly address: string | null;
  readonly note: string | null;
  readonly createdBy: string;
  readonly now: string;
}

export interface PartyPatch {
  readonly displayName?: string;
  readonly phone?: string | null;
  readonly address?: string | null;
  readonly note?: string | null;
  readonly isActive?: boolean;
}

export class PartyRepository {
  constructor(private readonly db: Db) {}

  insert(p: NewParty): PartyRow {
    this.db
      .prepare(
        `INSERT INTO parties (id, kind, display_name, phone, address, note, is_active,
                              created_by, created_at, updated_at)
         VALUES (@id, @kind, @displayName, @phone, @address, @note, 1, @createdBy, @now, @now)`,
      )
      .run(p);
    return this.findById(p.id)!;
  }

  findById(id: string): PartyRow | null {
    return party(this.db.prepare(`SELECT ${COLUMNS} FROM parties WHERE id = ?`).get(id) as Record<string, unknown>);
  }

  /**
   * One kind, newest first within the active group.
   *
   * 🔴 SCOPED BY KIND IN THE QUERY, not filtered afterwards. A customer picker that could ever show
   * a supplier is how receivables and payables get mixed, and the index is on (kind, …) so this is
   * also the cheap path.
   */
  listByKind(kind: PartyKind, includeArchived = false): PartyRow[] {
    const sql = includeArchived
      ? `SELECT ${COLUMNS} FROM parties WHERE kind = ? ORDER BY is_active DESC, display_name, id`
      : `SELECT ${COLUMNS} FROM parties WHERE kind = ? AND is_active = 1 ORDER BY display_name, id`;
    return (this.db.prepare(sql).all(kind) as Array<Record<string, unknown>>).map((r) => party(r)!);
  }

  /** Accounts of ONE kind whose name or phone contains the needle, compared case-insensitively. */
  search(kind: PartyKind, needle: string, includeArchived = false): PartyRow[] {
    const like = `%${needle}%`;
    const active = includeArchived ? "" : " AND is_active = 1";
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM parties
            WHERE kind = ?${active}
              AND (lower(trim(display_name)) LIKE lower(?) OR coalesce(phone, '') LIKE ?)
            ORDER BY is_active DESC, display_name, id`,
        )
        .all(kind, like, like) as Array<Record<string, unknown>>
    ).map((r) => party(r)!);
  }

  /**
   * Accounts of this kind that an operator would read as the same name. INFORMATION for the
   * service to show — this repository never acts on it, and nothing merges.
   */
  findSameName(kind: PartyKind, normalized: string): PartyRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM parties
            WHERE kind = ? AND replace(lower(trim(display_name)), '  ', ' ') = ?
            ORDER BY created_at, id`,
        )
        .all(kind, normalized) as Array<Record<string, unknown>>
    ).map((r) => party(r)!);
  }

  /** Applies only the keys present. An absent key leaves the stored value alone. */
  update(id: string, patch: PartyPatch, now: string): PartyRow {
    const sets: string[] = [];
    const values: Record<string, unknown> = { id, now };
    if (patch.displayName !== undefined) {
      sets.push("display_name = @displayName");
      values.displayName = patch.displayName;
    }
    for (const key of ["phone", "address", "note"] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = @${key}`);
        values[key] = patch[key];
      }
    }
    if (patch.isActive !== undefined) {
      sets.push("is_active = @isActive");
      values.isActive = patch.isActive ? 1 : 0;
    }
    if (sets.length === 0) return this.findById(id)!;
    this.db.prepare(`UPDATE parties SET ${sets.join(", ")}, updated_at = @now WHERE id = @id`).run(values);
    return this.findById(id)!;
  }

  appendHistory(row: PartyContactHistoryRow): void {
    this.db
      .prepare(
        `INSERT INTO party_contact_history (${HISTORY_COLUMNS})
         VALUES (@id, @party_id, @field, @old_value, @new_value, @changed_by, @changed_at)`,
      )
      .run(row);
  }

  historyFor(partyId: string): PartyContactHistoryRow[] {
    return (
      this.db
        .prepare(`SELECT ${HISTORY_COLUMNS} FROM party_contact_history WHERE party_id = ? ORDER BY changed_at, id`)
        .all(partyId) as Array<Record<string, unknown>>
    ).map(history);
  }

  countByKind(kind: PartyKind): number {
    const row = this.db.prepare(`SELECT count(*) AS n FROM parties WHERE kind = ?`).get(kind) as { n: bigint };
    return Number(row.n);
  }
}
