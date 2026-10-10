/**
 * The durable business audit contract — Migration 5.
 *
 * WHAT THIS IS. `audit_events` in SQLite is the AUTHORITATIVE record of who changed master data,
 * when, and from what to what. It is append-only, enforced by database triggers, and it is written
 * INSIDE the same transaction as the business mutation it describes: a mutation without its audit
 * row, or an audit row without its mutation, is impossible rather than merely discouraged.
 *
 * WHAT THIS IS NOT. The rotating JSON logfile (src/main/logger.ts) stays exactly as it is —
 * diagnostics, crashes and operational detail. It rotates and is eventually deleted, which is
 * precisely why it cannot be the accountability record. It keeps mirroring audit rows for field
 * support; it is no longer the record of truth.
 *
 * FAIL CLOSED is the rule of this file. Everything an audit row may contain is enumerated here. A
 * field that is not on a list is not dropped and ignored — it THROWS, which rolls back the business
 * transaction. Silently discarding an unexpected field would mean a mutation could succeed while
 * its account of itself was quietly incomplete, and that is the one failure an audit trail may
 * never have.
 *
 * NO SECRETS, EVER. A key that looks like a credential is rejected before anything else is even
 * considered, and every value must be a bounded scalar — no object, no array — so a secret cannot
 * be smuggled in nested inside a payload.
 */

/** The complete, bounded event registry. A new type needs a migration — never a free-form string. */
export const AUDIT_EVENT_TYPES = [
  "PRODUCT_CREATED",
  "PRODUCT_UPDATED",
  "PRODUCT_ACTIVATED",
  "PRODUCT_DEACTIVATED",
  "CATALOG_IMPORTED",
  // Migration 8 — managing an operator is itself an audited act. Six types, because "an operator
  // changed" would not say WHICH of six very different things happened, and the one that matters
  // most to read back later (a role change) would be indistinguishable from a rename.
  "OPERATOR_CREATED",
  "OPERATOR_RENAMED",
  "OPERATOR_PIN_RESET",
  "OPERATOR_ACTIVATED",
  "OPERATOR_DEACTIVATED",
  "OPERATOR_ROLE_CHANGED",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_ENTITY_TYPES = ["product", "catalog", "operator"] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * Which event types belong to which entity. The database CHECK spells the same pairing, so a row
 * that got past this code still cannot land.
 */
export const AUDIT_EVENTS_BY_ENTITY: Readonly<Record<AuditEntityType, ReadonlyArray<AuditEventType>>> =
  Object.freeze({
    product: Object.freeze([
      "PRODUCT_CREATED",
      "PRODUCT_UPDATED",
      "PRODUCT_ACTIVATED",
      "PRODUCT_DEACTIVATED",
    ]) as ReadonlyArray<AuditEventType>,
    catalog: Object.freeze(["CATALOG_IMPORTED"]) as ReadonlyArray<AuditEventType>,
    operator: Object.freeze([
      "OPERATOR_CREATED",
      "OPERATOR_RENAMED",
      "OPERATOR_PIN_RESET",
      "OPERATOR_ACTIVATED",
      "OPERATOR_DEACTIVATED",
      "OPERATOR_ROLE_CHANGED",
    ]) as ReadonlyArray<AuditEventType>,
  });

export const AUDIT_ACTOR_TIERS = ["owner", "admin", "cashier", "system", "unspecified"] as const;
export type AuditActorTier = (typeof AUDIT_ACTOR_TIERS)[number];

/**
 * 🔴 The tier every human action gets in V1, and the reason is honesty rather than caution.
 *
 * This build has NO role or permission model: `Cashier` is `{ id, name }`, the cashiers are a
 * TypeScript fixture, and nothing anywhere distinguishes an owner from a till operator. Writing
 * 'cashier' would assert a fact the application cannot know, and because the trail is append-only
 * that wrong assertion would be permanent — when price edits later become owner-only, history would
 * read "a cashier changed the price" for acts that were the owner's. Migration 4's rule applies
 * unchanged: unknown data stays unknown. Real tiers start being written prospectively, by the
 * permission work, and these rows are never rewritten.
 */
export const CURRENT_ACTOR_TIER: AuditActorTier = "unspecified";

/**
 * The fields an OPERATOR_* event may describe.
 *
 * 🔴 DELIBERATELY NO PIN FIELD, AND NOT EVEN `must_reset_pin`. `SECRET_KEY` below matches
 * /pin|…|hash/i and REJECTS such a key outright, so naming one here would be a contract breach the
 * moment it was used — the guard would throw and roll back the operator mutation. That is the
 * correct outcome and the reason this list is three fields long: an `OPERATOR_PIN_RESET` records
 * THAT a reset happened, by whom, to whom and when. The event type is the whole fact; there is
 * nothing about the credential to record, and no way to record it if there were.
 */
export const AUDITED_OPERATOR_FIELDS = ["is_active", "name", "role"] as const;
export type AuditedOperatorField = (typeof AUDITED_OPERATOR_FIELDS)[number];

/**
 * Metadata an OPERATOR_* event may carry.
 *
 * `origin` only, reusing the key PRODUCT_* events already use — "bootstrap_setup" distinguishes the
 * mandatory first-run reset from an owner resetting an employee's PIN later, which are the same
 * event type and genuinely different acts.
 */
export const AUDIT_OPERATOR_METADATA_KEYS = ["origin"] as const;

/** The actor used by actions the application takes on its own behalf. Nothing emits one yet. */
export const SYSTEM_ACTOR = Object.freeze({
  actorId: "system",
  actorName: "System",
  actorTier: "system" as AuditActorTier,
});

/**
 * The ONLY product fields an audit row may describe, sorted exactly as they are serialized.
 *
 * Excluded on purpose: `id`, `source` and `source_key` are the product's identity, never editable,
 * and already carried by `entity_id` and the metadata; `created_at` and `updated_at` are derivable
 * bookkeeping and would be pure noise in every diff.
 */
export const AUDITED_PRODUCT_FIELDS = [
  "base_unit",
  "currency",
  "is_active",
  "name_ar",
  "name_en",
  "price_needs_review",
  "selling_price_minor",
  "sku",
] as const;
export type AuditedProductField = (typeof AUDITED_PRODUCT_FIELDS)[number];

/**
 * Metadata keys a PRODUCT_* event may carry.
 *
 * `invoice_id` was added for invoice reconciliation (step 4): a catalog edit made while reviewing
 * invoice 61 must say which document it came from, or "why did this price change" is unanswerable.
 * It is ONE bounded scalar added to the allowlist — the fail-closed rule, the secret-key rejection
 * and the scalar-only value rule are untouched, and `origin` already existed, so the value
 * "invoice_reconciliation" needed no change at all.
 *
 * 🔴 NO NEW EVENT TYPE. A price changed during reconciliation is a PRODUCT_UPDATED, exactly like a
 * price changed on the product screen. A PRICE_CHANGED type would split one fact across two
 * vocabularies and double-count every "how many changes today" question.
 */
export const AUDIT_PRODUCT_METADATA_KEYS = [
  "catalog_import_id",
  "invoice_id",
  "origin",
  "source",
] as const;

/**
 * Metadata keys the CATALOG_IMPORTED summary may carry — the bounded summary only. CSV row
 * contents and the file itself are NEVER copied here.
 */
export const AUDIT_IMPORT_METADATA_KEYS = [
  "deactivated",
  "file_name",
  "file_sha256",
  "inserted",
  "origin",
  "row_count",
  "unchanged",
  "updated",
] as const;

/** Where an event came from. Correlates every per-product event of an import to that import. */
export const AUDIT_ORIGINS = ["manual_entry", "catalog_import"] as const;
export type AuditOrigin = (typeof AUDIT_ORIGINS)[number];

/** A key that looks like a credential. Checked FIRST, at every depth, on keys and on nothing else. */
const SECRET_KEY = /pin|password|passwd|token|secret|credential|api[_-]?key|hash/i;

/**
 * Every value an audit row may hold. Scalars only: no object and no array, which is what makes it
 * structurally impossible to nest a secret inside a payload.
 */
export type AuditScalar = string | number | bigint | boolean | null;

export interface AuditChange {
  readonly before: AuditScalar;
  readonly after: AuditScalar;
}

/** What a caller hands the audit repository. `id`, `seq` and the versions are added on the way in. */
export interface AuditDraft {
  readonly eventType: AuditEventType;
  readonly entityType: AuditEntityType;
  readonly entityId: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly actorTier: AuditActorTier;
  readonly occurredAt: Date;
  readonly businessDate: string;
  readonly changes: Readonly<Record<string, AuditChange>>;
  readonly metadata: Readonly<Record<string, AuditScalar>>;
}

/** One row as it is stored. */
export interface AuditRow {
  readonly id: string;
  readonly seq: number;
  readonly event_type: AuditEventType;
  readonly entity_type: AuditEntityType;
  readonly entity_id: string;
  readonly actor_id: string;
  readonly actor_name: string;
  readonly actor_tier: AuditActorTier;
  readonly occurred_at: string;
  readonly business_date: string;
  readonly changed_json: string;
  readonly metadata_json: string | null;
  readonly app_version: string;
  readonly schema_version: number;
}

/**
 * A breach of the audit contract: an unknown field, a credential-shaped key, a non-scalar value, a
 * float, a bad event/entity pairing.
 *
 * Deliberately NOT a DomainError: a DomainError is a message for the operator, and this is a
 * programming fault. It reaches the operator as the generic internal error, is written to the
 * diagnostic log in full, and — because it is thrown inside the business transaction — the mutation
 * it was describing is rolled back. That is the fail-closed behaviour.
 */
export class AuditContractError extends Error {
  constructor(
    readonly code:
      | "AUDIT_SECRET_FIELD"
      | "AUDIT_UNKNOWN_FIELD"
      | "AUDIT_UNSUPPORTED_VALUE"
      | "AUDIT_INVALID_EVENT"
      | "AUDIT_EMPTY_DIFF",
    message: string,
  ) {
    super(message);
    this.name = "AuditContractError";
  }
}

function assertNotSecret(key: string, where: string): void {
  if (SECRET_KEY.test(key)) {
    throw new AuditContractError(
      "AUDIT_SECRET_FIELD",
      `the audit trail refuses the credential-shaped field '${key}' in ${where}`,
    );
  }
}

/**
 * One scalar, normalised. `bigint` becomes a base-10 string so money never passes through a
 * JavaScript number; a non-integer number is refused outright, because there is no float anywhere
 * in this ledger and an audit row must not be the first one.
 */
function normalizeScalar(value: unknown, where: string): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new AuditContractError(
        "AUDIT_UNSUPPORTED_VALUE",
        `the audit trail refuses the non-integer value ${value} in ${where}`,
      );
    }
    return value;
  }
  throw new AuditContractError(
    "AUDIT_UNSUPPORTED_VALUE",
    `the audit trail accepts only scalars; ${where} received ${Array.isArray(value) ? "an array" : typeof value}`,
  );
}

/**
 * The deterministic serialization of a change set. Keys sorted, scalars normalised, unchanged
 * fields already absent (the caller omits them), and every key checked against the allowlist.
 */
export function serializeChanges(
  changes: Readonly<Record<string, AuditChange>>,
  allowed: ReadonlyArray<string>,
): string {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(changes).sort()) {
    assertNotSecret(key, "changed_json");
    if (!allowed.includes(key)) {
      throw new AuditContractError(
        "AUDIT_UNKNOWN_FIELD",
        `'${key}' is not an audited field; the audit trail refuses to record it`,
      );
    }
    const change = changes[key]!;
    if (change === null || typeof change !== "object" || !("before" in change) || !("after" in change)) {
      throw new AuditContractError(
        "AUDIT_UNSUPPORTED_VALUE",
        `changed_json['${key}'] must be { before, after }`,
      );
    }
    out[key] = {
      before: normalizeScalar(change.before, `changed_json['${key}'].before`),
      after: normalizeScalar(change.after, `changed_json['${key}'].after`),
    };
  }
  return JSON.stringify(out);
}

/** The same discipline for metadata: sorted, allowlisted, scalars only. Null when empty. */
export function serializeMetadata(
  metadata: Readonly<Record<string, AuditScalar>>,
  allowed: ReadonlyArray<string>,
): string | null {
  const keys = Object.keys(metadata).sort();
  if (keys.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    assertNotSecret(key, "metadata_json");
    if (!allowed.includes(key)) {
      throw new AuditContractError(
        "AUDIT_UNKNOWN_FIELD",
        `'${key}' is not an audit metadata key; the audit trail refuses to record it`,
      );
    }
    out[key] = normalizeScalar(metadata[key], `metadata_json['${key}']`);
  }
  return JSON.stringify(out);
}

/** Which allowlists apply to this event. */
export function allowlistsFor(eventType: AuditEventType): {
  readonly changes: ReadonlyArray<string>;
  readonly metadata: ReadonlyArray<string>;
} {
  if (eventType === "CATALOG_IMPORTED") {
    return { changes: [], metadata: AUDIT_IMPORT_METADATA_KEYS };
  }
  if (eventType.startsWith("OPERATOR_")) {
    return { changes: AUDITED_OPERATOR_FIELDS, metadata: AUDIT_OPERATOR_METADATA_KEYS };
  }
  return { changes: AUDITED_PRODUCT_FIELDS, metadata: AUDIT_PRODUCT_METADATA_KEYS };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates a draft and turns it into the exact row to insert. Everything the database CHECKs will
 * test is tested here first, so a contract breach fails with a message that names the field rather
 * than as an opaque SQLITE_CONSTRAINT.
 */
export function buildAuditRow(
  draft: AuditDraft,
  context: { readonly id: string; readonly seq: number; readonly appVersion: string; readonly schemaVersion: number },
): AuditRow {
  if (!AUDIT_EVENT_TYPES.includes(draft.eventType)) {
    throw new AuditContractError("AUDIT_INVALID_EVENT", `unknown audit event type '${draft.eventType}'`);
  }
  if (!AUDIT_ENTITY_TYPES.includes(draft.entityType)) {
    throw new AuditContractError("AUDIT_INVALID_EVENT", `unknown audit entity type '${draft.entityType}'`);
  }
  if (!AUDIT_EVENTS_BY_ENTITY[draft.entityType].includes(draft.eventType)) {
    throw new AuditContractError(
      "AUDIT_INVALID_EVENT",
      `${draft.eventType} does not belong to entity type '${draft.entityType}'`,
    );
  }
  if (!AUDIT_ACTOR_TIERS.includes(draft.actorTier)) {
    throw new AuditContractError("AUDIT_INVALID_EVENT", `unknown actor tier '${draft.actorTier}'`);
  }
  if (typeof draft.entityId !== "string" || draft.entityId.length === 0) {
    throw new AuditContractError("AUDIT_INVALID_EVENT", "an audit event must name the entity it describes");
  }
  if (typeof draft.actorId !== "string" || draft.actorId.length === 0 || draft.actorName.trim().length === 0) {
    throw new AuditContractError("AUDIT_INVALID_EVENT", "an audit event must name its actor");
  }
  const occurredAt = draft.occurredAt.toISOString();
  if (!ISO_UTC.test(occurredAt)) {
    throw new AuditContractError("AUDIT_INVALID_EVENT", `'${occurredAt}' is not a UTC instant`);
  }
  if (!BUSINESS_DATE.test(draft.businessDate)) {
    throw new AuditContractError("AUDIT_INVALID_EVENT", `'${draft.businessDate}' is not a business date`);
  }
  if (!Number.isSafeInteger(context.seq) || context.seq < 1) {
    throw new AuditContractError("AUDIT_INVALID_EVENT", `'${context.seq}' is not a valid sequence number`);
  }

  const lists = allowlistsFor(draft.eventType);
  const changed_json = serializeChanges(draft.changes, lists.changes);
  // A product event with an empty diff is not an event. The caller must not have built one; this is
  // the backstop, and `PosService.updateProduct` checks it before it gets here.
  if (draft.entityType === "product" && changed_json === "{}") {
    throw new AuditContractError(
      "AUDIT_EMPTY_DIFF",
      `${draft.eventType} on '${draft.entityId}' describes no change; it is not an event`,
    );
  }
  return {
    id: context.id,
    seq: context.seq,
    event_type: draft.eventType,
    entity_type: draft.entityType,
    entity_id: draft.entityId,
    actor_id: draft.actorId,
    actor_name: draft.actorName,
    actor_tier: draft.actorTier,
    occurred_at: occurredAt,
    business_date: draft.businessDate,
    changed_json,
    metadata_json: serializeMetadata(draft.metadata, lists.metadata),
    app_version: context.appVersion,
    schema_version: context.schemaVersion,
  };
}

/**
 * A diff of two states, over the audited fields only, with unchanged fields omitted. One helper so
 * that creation (`before` all null) and edit use the identical representation.
 */
export function diffAuditedFields(
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>>,
  fields: ReadonlyArray<string> = AUDITED_PRODUCT_FIELDS,
): Record<string, AuditChange> {
  const changes: Record<string, AuditChange> = {};
  for (const field of fields) {
    const b = (before ? before[field] : null) ?? null;
    const a = after[field] ?? null;
    const same =
      typeof b === "bigint" || typeof a === "bigint"
        ? String(b) === String(a)
        : b === a;
    if (before !== null && same) continue;
    changes[field] = { before: b as AuditScalar, after: a as AuditScalar };
  }
  return changes;
}
