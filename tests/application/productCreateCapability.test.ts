/**
 * The narrow "may create products" capability — migration 11 — through the REAL service.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS CAPABILITY IS, AND WHAT IT DELIBERATELY IS NOT. One named cashier may ADD new
 * products, from the desktop and from a phone, and may give a product they are creating its first
 * photo. They may not edit an existing product, replace or remove an existing photo, retire a
 * product, open an EDIT_PRODUCT phone session, or touch categories. Creating is not administering,
 * and the distance between the two is the whole point of the grant.
 *
 * 🔴 AND IT IS NOT A NAME. Authorization never reads "Cashier Two": the fixture account named
 * "Cashier One" is in fact the OWNER (migration 8 seeds it `role = 'owner'`), names are mutable
 * through `renameOperator`, and new operators get a `randomUUID` rather than a readable id. The
 * permission is a column on the operator's own row, and the tests below prove it survives a rename
 * and a reopen, and that revoking it takes effect on the very next action.
 *
 * Every refusal here is asserted against the SERVICE, not the channel table. The phone's HTTP
 * listener calls these methods directly and never passes through `channelPolicy`, so a capability
 * the channel alone enforced would be no capability at all.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { makeHarness, tempDir } from "../helpers/harness";

/** Migration 8 seeds these two. `cashier-01` is the OWNER despite its name; `cashier-02` is not. */
const OWNER = { cashierId: "cashier-01", pin: "1111" };
const CASHIER = { cashierId: "cashier-02", pin: "2222" };

const draft = (sku: string) => ({
  nameAr: "صنف",
  nameEn: "Item",
  sku,
  price: "4.00",
  baseUnit: "piece" as const,
});

/** Run `fn` against a fresh harness with no session, closing the database whatever happens. */
function withShop(fn: (h: ReturnType<typeof makeHarness>) => void): void {
  const t = tempDir();
  const h = makeHarness(t.dbPath, { login: false });
  try {
    fn(h);
  } finally {
    h.db.close();
    t.cleanup?.();
  }
}

/** The code of the DomainError `fn` throws, or null if it did not throw. */
function refusal(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof DomainError ? e.code : `not-a-domain-error: ${String(e)}`;
  }
}

const ownerSession = { id: "cashier-01", name: "Cashier One", role: "owner" as const };

describe("the owner is unaffected by any of this", () => {
  it("creates products, opens both kinds of phone session, and administers as before", () => {
    withShop((h) => {
      h.service.login(OWNER.cashierId, OWNER.pin);
      expect(h.service.canCreateProducts()).toBe(true);

      const p = h.service.createProduct(draft("OWN-1"));
      expect(p.id).toBeTruthy();
      // Both phone actions, which is the half a cashier never gets.
      expect(h.service.authorizePhoneSession("NEW_PRODUCT", null).action).toBe("NEW_PRODUCT");
      expect(h.service.authorizePhoneSession("EDIT_PRODUCT", p.id).action).toBe("EDIT_PRODUCT");
      // And ordinary administration — asserted on the stored row, not on the returned shape.
      h.service.setProductActive(p.id, false);
      const active = h.db
        .prepare("SELECT is_active AS a FROM catalog_products WHERE id = ?")
        .get(p.id) as { a: bigint };
      expect(Number(active.a)).toBe(0);
    });
  });

  it("🔴 does not need the flag, and cannot be given it", () => {
    withShop((h) => {
      h.service.login(OWNER.cashierId, OWNER.pin);
      // The owner's own row says `false` and the owner may create anyway: authority is the ROLE.
      const owner = h.operators.listAll().find((o) => o.id === "cashier-01");
      expect(owner?.mayCreateProducts).toBe(false);
      expect(h.service.canCreateProducts()).toBe(true);
      // 🔴 Setting it on an owner is REFUSED rather than quietly stored. A switch that appears to
      // do something and decides nothing is worse than no switch.
      //
      // A SECOND owner has to ask, because the self-check fires first and would hide this rule —
      // `cashier-01` setting it on `cashier-01` is refused for being themselves, which proves
      // something else entirely.
      h.operators.create(ownerSession, { name: "مالك ثانٍ", role: "cashier", pin: "778899" });
      const second = h.operators.listAll().find((o) => o.name === "مالك ثانٍ")!;
      // A new operator must set their own PIN before they can be made an owner, so the promotion
      // goes through the same ceremony a real second owner would.
      h.operators.resetPin(ownerSession, second.id, "112233");
      h.service.logout();
      const setup = h.service.login(second.id, "112233");
      expect(setup.kind).toBe("setup");
      if (setup.kind !== "setup") return;
      h.service.completeBootstrapSetup(setup.ticket, "مالك ثانٍ", "445566");
      h.service.logout();
      h.service.login(OWNER.cashierId, OWNER.pin);
      h.operators.setRole(ownerSession, second.id, "owner");
      const secondSession = { id: second.id, name: "مالك ثانٍ", role: "owner" as const };
      expect(refusal(() => h.operators.setMayCreateProducts(secondSession, "cashier-01", true))).toBe(
        "INVALID_INPUT",
      );
      // And the self-rule is real too, named separately so neither can hide the other.
      expect(refusal(() => h.operators.setMayCreateProducts(ownerSession, "cashier-01", true))).toBe(
        "SELF_PERMISSION_CHANGE",
      );
    });
  });
});

describe("a cashier with the capability OFF — the default", () => {
  it("🔴 is refused the desktop create, at the SERVICE", () => {
    withShop((h) => {
      h.service.login(CASHIER.cashierId, CASHIER.pin);
      expect(h.service.canCreateProducts()).toBe(false);
      expect(refusal(() => h.service.createProduct(draft("NO-1")))).toBe("NOT_AUTHORIZED");
    });
  });

  it("🔴 is refused a NEW_PRODUCT phone session — the path that skips the channel table", () => {
    withShop((h) => {
      h.service.login(CASHIER.cashierId, CASHIER.pin);
      expect(refusal(() => h.service.authorizePhoneSession("NEW_PRODUCT", null))).toBe("NOT_AUTHORIZED");
    });
  });

  it("🔴 an UPGRADE grants nobody anything — both seeded rows arrive with it off", () => {
    withShop((h) => {
      // Migration 11's column defaults to 0, so a shop that upgrades finds its cashier exactly as
      // restricted as before. The grant is an act an owner performs, never a side effect of
      // installing a build.
      expect(h.operators.listAll().map((o) => [o.id, o.mayCreateProducts])).toEqual([
        ["cashier-01", false],
        ["cashier-02", false],
      ]);
    });
  });

  it("a newly created operator also starts with it off", () => {
    withShop((h) => {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const made = h.operators.create(ownerSession, { name: "ثالث", role: "cashier", pin: "432156" });
      expect(made.mayCreateProducts).toBe(false);
    });
  });
});

describe("a cashier with the capability ON", () => {
  /** Grant the capability to `cashier-02` and sign in as them. */
  const granted = (h: ReturnType<typeof makeHarness>) => {
    h.service.login(OWNER.cashierId, OWNER.pin);
    h.operators.setMayCreateProducts(ownerSession, "cashier-02", true);
    h.service.logout();
    h.service.login(CASHIER.cashierId, CASHIER.pin);
  };

  it("🔴 creates a product from the desktop", () => {
    withShop((h) => {
      granted(h);
      expect(h.service.canCreateProducts()).toBe(true);
      const made = h.service.createProduct(draft("YES-1"));
      expect(made.id).toBeTruthy();
    });
  });

  it("🔴 the audit names the CASHIER who created it — never the owner", () => {
    withShop((h) => {
      granted(h);
      const made = h.service.createProduct(draft("YES-2"));
      const row = h.db
        .prepare(
          `SELECT actor_id, actor_name, actor_tier, event_type FROM audit_events
            WHERE entity_id = ? AND event_type = 'PRODUCT_CREATED'`,
        )
        .get(made.id) as { actor_id: string; actor_name: string; actor_tier: string };
      expect(row.actor_id).toBe("cashier-02");
      expect(row.actor_name).toBe("Cashier Two");
      expect(row.actor_tier).toBe("cashier");
    });
  });

  it("🔴 opens a NEW_PRODUCT phone session bound to THEIR OWN id", () => {
    withShop((h) => {
      granted(h);
      const spec = h.service.authorizePhoneSession("NEW_PRODUCT", null);
      expect(spec.action).toBe("NEW_PRODUCT");
      expect(spec.productId).toBeNull();
      // The session belongs to the cashier who opened it, so the save is attributed to them.
      expect(spec.operatorId).toBe("cashier-02");
    });
  });

  // ── and NONE of the adjacent powers ──────────────────────────────────────────────────────────

  it("🔴 is STILL refused an EDIT_PRODUCT phone session", () => {
    withShop((h) => {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const existing = h.service.createProduct(draft("OWNED-1"));
      h.operators.setMayCreateProducts(ownerSession, "cashier-02", true);
      h.service.logout();
      h.service.login(CASHIER.cashierId, CASHIER.pin);
      expect(refusal(() => h.service.authorizePhoneSession("EDIT_PRODUCT", existing.id))).toBe(
        "NOT_AUTHORIZED",
      );
    });
  });

  it("🔴 is STILL refused the photo of a product that already exists", () => {
    withShop((h) => {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const existing = h.service.createProduct(draft("OWNED-2"));
      h.operators.setMayCreateProducts(ownerSession, "cashier-02", true);
      h.service.logout();
      h.service.login(CASHIER.cashierId, CASHIER.pin);
      // 🔴 THE DISTINCTION THE WHOLE DESIGN TURNS ON. Creating a product with its first photo is
      // permitted; reaching for the photo of a product that already exists is not, and the two
      // live in different methods so that widening one cannot silently widen the other.
      expect(
        refusal(() =>
          h.service.setProductPrimaryImage({
            productId: existing.id,
            bytes: Buffer.from([0xff, 0xd8, 0xff]),
            mime: "image/jpeg",
            widthPx: 10,
            heightPx: 10,
            origin: "desktop",
          }),
        ),
      ).toBe("NOT_AUTHORIZED");
    });
  });

  it("🔴 is STILL refused category administration", () => {
    withShop((h) => {
      granted(h);
      expect(refusal(() => h.service.createCategory("تصنيف", "Category"))).toBe("NOT_AUTHORIZED");
    });
  });
});

describe("the permission is DURABLE, and live", () => {
  it("🔴 survives a rename — the grant is on the row, not on the name", () => {
    withShop((h) => {
      h.service.login(OWNER.cashierId, OWNER.pin);
      h.operators.setMayCreateProducts(ownerSession, "cashier-02", true);
      h.operators.rename(ownerSession, "cashier-02", "اسم جديد تماماً");
      h.service.logout();

      h.service.login(CASHIER.cashierId, CASHIER.pin);
      expect(h.service.canCreateProducts()).toBe(true);
      expect(h.service.createProduct(draft("REN-1")).id).toBeTruthy();
    });
  });

  it("🔴 survives closing and reopening the database — it is stored, not remembered", () => {
    const t = tempDir();
    const first = makeHarness(t.dbPath, { login: false });
    try {
      first.service.login(OWNER.cashierId, OWNER.pin);
      first.operators.setMayCreateProducts(ownerSession, "cashier-02", true);
    } finally {
      first.db.close();
    }
    const second = makeHarness(t.dbPath, { login: false });
    try {
      second.service.login(CASHIER.cashierId, CASHIER.pin);
      expect(second.service.canCreateProducts()).toBe(true);
    } finally {
      second.db.close();
      t.cleanup?.();
    }
  });

  it("🔴 revoking it takes effect on the NEXT action — no logout, no restart", () => {
    withShop((h) => {
      h.service.login(OWNER.cashierId, OWNER.pin);
      h.operators.setMayCreateProducts(ownerSession, "cashier-02", true);
      h.service.logout();
      h.service.login(CASHIER.cashierId, CASHIER.pin);
      expect(h.service.createProduct(draft("LIVE-1")).id).toBeTruthy();

      // The owner revokes it from another terminal while this session stays open. The service
      // re-reads the durable row on every decision, so the very next create is refused.
      h.operators.setMayCreateProducts(ownerSession, "cashier-02", false);
      expect(h.service.canCreateProducts()).toBe(false);
      expect(refusal(() => h.service.createProduct(draft("LIVE-2")))).toBe("NOT_AUTHORIZED");
    });
  });

  it("🔴 a DEACTIVATED cashier loses it, grant or no grant", () => {
    withShop((h) => {
      h.service.login(OWNER.cashierId, OWNER.pin);
      h.operators.setMayCreateProducts(ownerSession, "cashier-02", true);
      h.service.logout();
      h.service.login(CASHIER.cashierId, CASHIER.pin);
      expect(h.service.canCreateProducts()).toBe(true);

      h.operators.setActive(ownerSession, "cashier-02", false);
      // The existing operator-deactivation rule still applies and reaches this first.
      expect(refusal(() => h.service.createProduct(draft("DEAD-1")))).toBe("OPERATOR_INACTIVE");
    });
  });

  it("🔴 granting and revoking are each recorded, as different events", () => {
    withShop((h) => {
      h.service.login(OWNER.cashierId, OWNER.pin);
      h.operators.setMayCreateProducts(ownerSession, "cashier-02", true);
      h.operators.setMayCreateProducts(ownerSession, "cashier-02", false);
      const events = (
        h.db
          .prepare(
            `SELECT event_type FROM audit_events WHERE entity_id = 'cashier-02'
               AND event_type LIKE 'OPERATOR_PRODUCT_CREATE%' ORDER BY seq`,
          )
          .all() as Array<{ event_type: string }>
      ).map((r) => r.event_type);
      expect(events).toEqual(["OPERATOR_PRODUCT_CREATE_GRANTED", "OPERATOR_PRODUCT_CREATE_REVOKED"]);
    });
  });

  it("setting it to what it already is records nothing — the trail holds acts, not clicks", () => {
    withShop((h) => {
      h.service.login(OWNER.cashierId, OWNER.pin);
      h.operators.setMayCreateProducts(ownerSession, "cashier-02", false);
      const n = h.db
        .prepare(
          `SELECT count(*) AS n FROM audit_events WHERE event_type LIKE 'OPERATOR_PRODUCT_CREATE%'`,
        )
        .get() as { n: bigint };
      expect(Number(n.n)).toBe(0);
    });
  });
});
