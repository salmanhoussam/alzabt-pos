/**
 * The audit payload contract — and it FAILS CLOSED.
 *
 * 🔴 CONTRACT CHANGE. An earlier design dropped an unexpected field and carried on. That is the one
 * behaviour an audit trail may not have: the mutation would succeed while its account of itself was
 * quietly incomplete. An unknown field now THROWS, and because the throw happens inside the
 * business transaction the mutation is rolled back. These tests assert the throwing, not the
 * dropping.
 */
import { describe, expect, it } from "vitest";
import {
  AUDITED_PRODUCT_FIELDS,
  AUDIT_ACTOR_TIERS,
  AUDIT_EVENT_TYPES,
  AuditContractError,
  CURRENT_ACTOR_TIER,
  buildAuditRow,
  diffAuditedFields,
  serializeChanges,
  serializeMetadata,
} from "../../src/domain/audit";

const base = {
  eventType: "PRODUCT_UPDATED",
  entityType: "product",
  entityId: "manual:000001",
  actorId: "cashier-01",
  actorName: "Cashier One",
  actorTier: CURRENT_ACTOR_TIER,
  occurredAt: new Date("2026-10-07T09:00:00.000Z"),
  businessDate: "2026-10-07",
} as const;

const build = (changes: Record<string, unknown>, metadata: Record<string, unknown> = {}) =>
  buildAuditRow({ ...base, changes, metadata } as never, {
    id: "evt-1",
    seq: 1,
    appVersion: "test",
    schemaVersion: 5,
  });

describe("the registry is bounded", () => {
  // 🔴 TRANSITION, 2026-10-10. This named exactly FIVE types; migration 8 added the six
  // OPERATOR_* ones. The assertion's point is unchanged and is NOT weakened: the registry is
  // exhaustive and bounded, and PRICE_CHANGED / UNIT_CHANGED are still absent — a price changed
  // during reconciliation is a PRODUCT_UPDATED, exactly as before.
  it("names exactly eleven event types — PRICE_CHANGED and UNIT_CHANGED are NOT among them", () => {
    expect([...AUDIT_EVENT_TYPES]).toEqual([
      "PRODUCT_CREATED",
      "PRODUCT_UPDATED",
      "PRODUCT_ACTIVATED",
      "PRODUCT_DEACTIVATED",
      "CATALOG_IMPORTED",
      "OPERATOR_CREATED",
      "OPERATOR_RENAMED",
      "OPERATOR_PIN_RESET",
      "OPERATOR_ACTIVATED",
      "OPERATOR_DEACTIVATED",
      "OPERATOR_ROLE_CHANGED",
    ]);
    expect(AUDIT_EVENT_TYPES).not.toContain("PRICE_CHANGED");
    expect(AUDIT_EVENT_TYPES).not.toContain("UNIT_CHANGED");
  });

  it("the current actor tier is 'unspecified', because this build cannot know one", () => {
    expect(CURRENT_ACTOR_TIER).toBe("unspecified");
    expect([...AUDIT_ACTOR_TIERS]).toEqual(["owner", "admin", "cashier", "system", "unspecified"]);
  });

  it("the product allowlist is exactly eight fields, and excludes identity and bookkeeping", () => {
    expect([...AUDITED_PRODUCT_FIELDS]).toEqual([
      "base_unit",
      "currency",
      "is_active",
      "name_ar",
      "name_en",
      "price_needs_review",
      "selling_price_minor",
      "sku",
    ]);
    for (const excluded of ["id", "source", "source_key", "created_at", "updated_at"]) {
      expect(AUDITED_PRODUCT_FIELDS, excluded).not.toContain(excluded);
    }
  });

  it("an unknown event type, entity type or tier is refused", () => {
    expect(() => build({ sku: { before: null, after: "A" } })).not.toThrow();
    expect(() =>
      buildAuditRow({ ...base, eventType: "PRICE_CHANGED", changes: {}, metadata: {} } as never, {
        id: "x",
        seq: 1,
        appVersion: "t",
        schemaVersion: 5,
      }),
    ).toThrow(AuditContractError);
    expect(() =>
      buildAuditRow({ ...base, entityType: "invoice", changes: {}, metadata: {} } as never, {
        id: "x",
        seq: 1,
        appVersion: "t",
        schemaVersion: 5,
      }),
    ).toThrow(/entity type/);
    expect(() =>
      buildAuditRow({ ...base, actorTier: "manager", changes: { sku: { before: null, after: "A" } }, metadata: {} } as never, {
        id: "x",
        seq: 1,
        appVersion: "t",
        schemaVersion: 5,
      }),
    ).toThrow(/actor tier/);
  });

  it("a PRODUCT_* event on the catalog, or CATALOG_IMPORTED on a product, is refused", () => {
    expect(() =>
      buildAuditRow(
        { ...base, entityType: "catalog", changes: { sku: { before: null, after: "A" } }, metadata: {} } as never,
        { id: "x", seq: 1, appVersion: "t", schemaVersion: 5 },
      ),
    ).toThrow(/does not belong to entity type/);
    expect(() =>
      buildAuditRow(
        { ...base, eventType: "CATALOG_IMPORTED", changes: {}, metadata: {} } as never,
        { id: "x", seq: 1, appVersion: "t", schemaVersion: 5 },
      ),
    ).toThrow(/does not belong to entity type/);
  });
});

describe("🔴 fail closed on an unexpected field", () => {
  it("an unknown change key THROWS — it is not dropped", () => {
    expect(() => build({ cost_price_minor: { before: null, after: "1" } })).toThrow(AuditContractError);
    expect(() => build({ cost_price_minor: { before: null, after: "1" } })).toThrow(/not an audited field/);
  });

  it("an unknown metadata key THROWS", () => {
    expect(() =>
      build({ sku: { before: null, after: "A" } }, { origin: "manual_entry", operator_notes: "hi" }),
    ).toThrow(/not an audit metadata key/);
  });

  it("every credential-shaped key is refused, in changes and in metadata", () => {
    for (const key of [
      "pin",
      "PIN",
      "pinHashHex",
      "pin_hash",
      "password",
      "passwd",
      "token",
      "access_token",
      "secret",
      "credential",
      "apikey",
      "api_key",
      "API-Key",
      "hash",
    ]) {
      expect(() => build({ [key]: { before: null, after: "x" } }), `changes.${key}`).toThrow(
        /credential-shaped field/,
      );
      expect(() => build({ sku: { before: null, after: "A" } }, { [key]: "x" }), `metadata.${key}`).toThrow(
        /credential-shaped field/,
      );
    }
  });

  it("a secret-shaped key is refused BEFORE the allowlist, so the error names it as a credential", () => {
    try {
      build({ pinHashHex: { before: null, after: "deadbeef" } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuditContractError);
      expect((err as AuditContractError).code).toBe("AUDIT_SECRET_FIELD");
    }
  });

  it("a non-scalar value is refused — a secret cannot be nested inside a payload", () => {
    expect(() => build({ sku: { before: null, after: { pinHashHex: "x" } } })).toThrow(/only scalars/);
    expect(() => build({ sku: { before: null, after: ["a"] } })).toThrow(/an array/);
    expect(() => build({ sku: { before: null, after: () => 1 } })).toThrow(/only scalars/);
  });

  it("a float is refused — there is no float in this ledger, and audit is not the first", () => {
    expect(() => build({ selling_price_minor: { before: null, after: 4.5 } })).toThrow(/non-integer/);
  });

  it("a change that is not { before, after } is refused", () => {
    expect(() => build({ sku: "A" as never })).toThrow(/must be \{ before, after \}/);
    expect(() => build({ sku: null as never })).toThrow(/must be \{ before, after \}/);
  });

  it("a product event with an empty diff is refused — nothing is not an event", () => {
    expect(() => build({})).toThrow(/describes no change/);
  });

  it("a malformed business date or sequence is refused", () => {
    expect(() =>
      buildAuditRow({ ...base, businessDate: "2026-10", changes: { sku: { before: null, after: "A" } }, metadata: {} } as never, {
        id: "x",
        seq: 1,
        appVersion: "t",
        schemaVersion: 5,
      }),
    ).toThrow(/business date/);
    expect(() =>
      buildAuditRow({ ...base, changes: { sku: { before: null, after: "A" } }, metadata: {} } as never, {
        id: "x",
        seq: 0,
        appVersion: "t",
        schemaVersion: 5,
      }),
    ).toThrow(/sequence number/);
  });
});

describe("the serialization is deterministic", () => {
  it("keys are sorted, whatever order they arrive in", () => {
    const a = serializeChanges(
      { sku: { before: null, after: "B" }, base_unit: { before: "piece", after: "kg" } },
      AUDITED_PRODUCT_FIELDS,
    );
    const b = serializeChanges(
      { base_unit: { before: "piece", after: "kg" }, sku: { before: null, after: "B" } },
      AUDITED_PRODUCT_FIELDS,
    );
    expect(a).toBe(b);
    expect(a).toBe('{"base_unit":{"before":"piece","after":"kg"},"sku":{"before":null,"after":"B"}}');
  });

  it("bigint becomes a decimal string, boolean stays a boolean, undefined becomes null", () => {
    expect(
      serializeChanges(
        {
          selling_price_minor: { before: 400n, after: 70000n },
          is_active: { before: true, after: false },
          name_en: { before: undefined as never, after: null },
        },
        AUDITED_PRODUCT_FIELDS,
      ),
    ).toBe(
      '{"is_active":{"before":true,"after":false},' +
        '"name_en":{"before":null,"after":null},' +
        '"selling_price_minor":{"before":"400","after":"70000"}}',
    );
  });

  it("empty metadata is null, not an empty object", () => {
    expect(serializeMetadata({}, ["origin"])).toBeNull();
  });
});

describe("diffAuditedFields", () => {
  const before = {
    base_unit: "piece",
    currency: "USD",
    is_active: true,
    name_ar: "صنف",
    name_en: "Item",
    price_needs_review: false,
    selling_price_minor: 400n,
    sku: "SYN-1",
  };

  it("a creation records the whole audited state with every before null", () => {
    const changes = diffAuditedFields(null, before);
    expect(Object.keys(changes).sort()).toEqual([...AUDITED_PRODUCT_FIELDS]);
    expect(Object.values(changes).every((c) => c.before === null)).toBe(true);
  });

  it("an edit records only what moved", () => {
    const changes = diffAuditedFields(before, { ...before, selling_price_minor: 700n, name_en: "Thing" });
    expect(Object.keys(changes).sort()).toEqual(["name_en", "selling_price_minor"]);
  });

  it("identical states produce an empty diff, bigint and string spellings compared as values", () => {
    expect(diffAuditedFields(before, { ...before })).toEqual({});
    expect(diffAuditedFields(before, { ...before, selling_price_minor: "400" })).toEqual({});
  });
});
