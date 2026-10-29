/**
 * Saving a product from the phone, end to end over a real socket, against a real ledger.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE CENTRAL CLAIM THESE TESTS EXIST TO HOLD: nothing durable exists until Save.
 *
 * It is easy to write a phone flow that creates a row when the session opens (to have an id to
 * attach things to) or when the form loads (to "reserve" the product). Either leaves a half-product
 * in a real shop's catalogue whenever a merchant walks away — and it would be invisible, because
 * the happy path looks identical. So the count is asserted at every stage BEFORE the save, not
 * only after it.
 *
 * 🔴 AND THE PATCH SEMANTICS. The hardest thing in this slice is not creating a product, it is
 * editing one without erasing the fields the form did not touch. The tests below assert the
 * surviving values by name rather than counting fields, because a snapshot-overwrite bug passes
 * any count.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { networkInterfaces as realInterfaces } from "node:os";
import { PhoneSessionBridge } from "../../src/main/phoneSessionBridge";
import type { NetworkInterfaceMap } from "../../src/main/lanAddress";
import { makeHarness, tempDir, type Harness } from "../helpers/harness";

const OWNER = { cashierId: "cashier-01", pin: "1111" };
const CASHIER = { cashierId: "cashier-02", pin: "2222" };
const TOKEN = "f".repeat(64);

/** This machine's real LAN IPv4 — loopback is excluded by `selectLanAddress` on purpose. */
const LAN = (() => {
  for (const addrs of Object.values(realInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !/^127\./.test(a.address)) return a.address;
    }
  }
  return null;
})();

const IFACES: NetworkInterfaceMap = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [{ address: LAN ?? "127.0.0.1", family: "IPv4", internal: false }],
};

interface Reply {
  readonly status: number;
  readonly body: string;
  json: () => { ok?: boolean; code?: string; message?: string };
}

function request(host: string, port: number, method: string, path: string, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body ?? "";
    const head =
      `${method} ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: iPhone\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` +
      `Connection: close\r\n\r\n`;
    const socket: Socket = connect({ host, port }, () => socket.write(head + payload));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => (data += c));
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] ?? 0);
      const split = data.indexOf("\r\n\r\n");
      const text = split >= 0 ? data.slice(split + 4) : "";
      resolve({
        status,
        body: text,
        json: () => {
          try {
            return JSON.parse(text);
          } catch {
            return {};
          }
        },
      });
    });
    socket.setTimeout(6000, () => {
      socket.destroy();
      reject(new Error("timed out talking to the phone listener"));
    });
  });
}

async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: LAN ?? "127.0.0.1", port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** The submission the phone's own script builds — same shape, so the tests exercise the real path. */
function submission(over: {
  product?: Partial<Record<"nameAr" | "nameEn" | "sku" | "price" | "baseUnit", unknown>>;
  master?: Partial<Record<"categoryId" | "barcode" | "brand" | "descriptionAr" | "descriptionEn" | "isOnlineVisible", unknown>>;
} = {}): string {
  return JSON.stringify({
    product: { nameAr: "مفتاح", nameEn: "", sku: "", price: "12.50", baseUnit: "piece", ...over.product },
    master: {
      categoryId: "",
      barcode: "",
      brand: "",
      descriptionAr: "",
      descriptionEn: "",
      isOnlineVisible: false,
      ...over.master,
    },
  });
}

function countProducts(h: Harness): number {
  return Number((h.db.prepare("SELECT count(*) AS n FROM catalog_products").get() as { n: number | bigint }).n);
}

interface Fixture {
  readonly h: Harness;
  readonly bridge: PhoneSessionBridge;
  readonly cleanup: () => Promise<void>;
}

function fixture(): Fixture {
  const t = tempDir();
  const h = makeHarness(t.dbPath, { login: false });
  const bridge = new PhoneSessionBridge({
    service: h.service,
    interfaces: () => IFACES,
    randomToken: () => TOKEN,
    // No WebAssembly: this file is about the save path, not the QR.
    renderQr: async () => "<svg data-fake-qr='1'></svg>",
  });
  return {
    h,
    bridge,
    cleanup: async () => {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    },
  };
}

describe("NEW_PRODUCT — nothing durable until Save", () => {
  it("🔴 starting the session creates NO product", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const before = countProducts(f.h);
      await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      expect(countProducts(f.h)).toBe(before);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 opening the form creates NO product — and the form really was served", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const before = countProducts(f.h);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));

      const page = await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      expect(page.status).toBe(200);
      // CONTROL: this is the real form, so "no product was created" is not passing because the
      // page failed to render.
      expect(page.body).toContain('data-testid="phone-nameAr"');
      expect(page.body).toContain('data-testid="phone-save"');
      expect(countProducts(f.h)).toBe(before);
    } finally {
      await f.cleanup();
    }
  });

  it("a valid Save creates EXACTLY one product, with the fields submitted", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const before = countProducts(f.h);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);

      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}`,
        submission({
          product: { nameAr: "مفتاح إنجليزي", nameEn: "Wrench", sku: "WR-1", price: "12.50", baseUnit: "piece" },
          master: { brand: "Stanley", descriptionAr: "مفتاح قوي", isOnlineVisible: true, barcode: "036000291452" },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(countProducts(f.h)).toBe(before + 1);

      const row = f.h.db
        .prepare("SELECT * FROM catalog_products ORDER BY created_at DESC LIMIT 1")
        .get() as Record<string, unknown>;
      expect(row.name_ar).toBe("مفتاح إنجليزي");
      expect(row.name_en).toBe("Wrench");
      expect(row.sku).toBe("WR-1");
      expect(Number(row.selling_price_minor)).toBe(1250);
      expect(row.base_unit).toBe("piece");
      expect(row.brand).toBe("Stanley");
      expect(row.description_ar).toBe("مفتاح قوي");
      expect(Number(row.is_online_visible)).toBe(1);
      // 🔴 THE BARCODE WENT THROUGH THE ONE CANONICALIZER: a 12-digit UPC-A is stored as its
      // 13-digit EAN-13 form. A phone that pre-processed it would create duplicates.
      expect(row.barcode).toBe("0036000291452");
    } finally {
      await f.cleanup();
    }
  });

  /**
   * 🔴 THE IDEMPOTENCY TEST. A flaky phone retries and a merchant double-taps. Two products from
   * one session would be a real shop's duplicate, and the session — not a database constraint — is
   * what has to refuse it, because a product may legitimately have no SKU and no barcode to clash
   * on.
   */
  it("🔴 a repeated Save cannot create a second product", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      const before = countProducts(f.h);

      const first = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(first.status).toBe(200);
      expect(countProducts(f.h)).toBe(before + 1);

      // The listener closes behind a success, so the replay cannot even connect — which is the
      // strongest possible refusal. Either outcome is acceptable; a SECOND PRODUCT is not.
      let second: Reply | null = null;
      try {
        second = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      } catch {
        second = null;
      }
      if (second) expect(second.json().ok).not.toBe(true);
      expect(countProducts(f.h)).toBe(before + 1);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 a FAILED Save leaves no durable half-product, and the session stays usable", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      const before = countProducts(f.h);

      // A price of zero: refused by `validateProductDraft`, which is the authority.
      const bad = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission({ product: { price: "0" } }));
      expect(bad.status).toBe(422);
      expect(bad.json().ok).toBe(false);
      expect(countProducts(f.h)).toBe(before);

      // 🔴 AND THE SESSION IS STILL ALIVE: the merchant corrects the price and saves. Ending the
      // session on a validation error would send them back to the till for a new QR and lose
      // everything they typed.
      expect(await isListening(dto.port)).toBe(true);
      const good = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission({ product: { price: "9.99" } }));
      expect(good.status).toBe(200);
      expect(countProducts(f.h)).toBe(before + 1);
    } finally {
      await f.cleanup();
    }
  });
});

describe("EDIT_PRODUCT — the bound product, and only that one", () => {
  function seed(h: Harness) {
    h.service.login(OWNER.cashierId, OWNER.pin);
    const cat = h.service.createCategory("عدد", "Tools");
    const target = h.service.createProduct({
      nameAr: "مفتاح",
      nameEn: "Wrench",
      sku: "WR-1",
      price: "10.00",
      baseUnit: "piece",
      master: {
        categoryId: cat.id,
        brand: "Stanley",
        descriptionAr: "وصف أصلي",
        descriptionEn: "Original",
        barcode: "5901234123457",
        isOnlineVisible: true,
      },
    });
    const other = h.service.createProduct({
      nameAr: "مطرقة",
      nameEn: "Hammer",
      sku: "HM-1",
      price: "20.00",
      baseUnit: "piece",
    });
    return { cat, target, other };
  }

  it("the form loads the bound product's authoritative values", async () => {
    const f = fixture();
    try {
      const { target } = seed(f.h);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", target.id));
      const page = await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      expect(page.status).toBe(200);
      expect(page.body).toContain("مفتاح");
      expect(page.body).toContain("Stanley");
      expect(page.body).toContain("5901234123457");
      expect(page.body).toContain("وصف أصلي");
      // The other product is not on this page at all.
      expect(page.body).not.toContain("مطرقة");
      expect(page.body).not.toContain("HM-1");
    } finally {
      await f.cleanup();
    }
  });

  /**
   * 🔴 THE WRONG-PRODUCT TEST. The submission carries a product id for a DIFFERENT product. It must
   * not redirect the edit — and the mechanism is stronger than a check: `parsePhoneSubmission`
   * refuses an unknown field outright, so there is no parameter for the id to occupy, and
   * `savePhoneProduct` reads the id from the session instead.
   */
  it("🔴 a productId in the request cannot redirect the edit — it is REFUSED outright", async () => {
    const f = fixture();
    try {
      const { target, other } = seed(f.h);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", target.id));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);

      const hostile = JSON.stringify({
        product: {
          nameAr: "مُختطف",
          nameEn: "",
          sku: "",
          price: "1.00",
          baseUnit: "piece",
          productId: other.id,
        },
        master: {
          categoryId: "",
          barcode: "",
          brand: "",
          descriptionAr: "",
          descriptionEn: "",
          isOnlineVisible: false,
        },
      });
      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, hostile);
      expect(res.status).toBe(422);
      expect(res.json().code).toBe("INVALID_INPUT");
      expect(res.json().message).toMatch(/unexpected fields/i);

      // NEITHER product changed.
      const a = f.h.db.prepare("SELECT name_ar FROM catalog_products WHERE id = ?").get(target.id) as { name_ar: string };
      const b = f.h.db.prepare("SELECT name_ar FROM catalog_products WHERE id = ?").get(other.id) as { name_ar: string };
      expect(a.name_ar).toBe("مفتاح");
      expect(b.name_ar).toBe("مطرقة");
    } finally {
      await f.cleanup();
    }
  });

  it("a valid Save updates the bound product and leaves the other untouched", async () => {
    const f = fixture();
    try {
      const { target, other } = seed(f.h);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", target.id));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);

      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}`,
        submission({
          product: { nameAr: "مفتاح معدّل", nameEn: "Wrench", sku: "WR-1", price: "14.00", baseUnit: "piece" },
          master: {
            categoryId: "",
            barcode: "5901234123457",
            brand: "Stanley",
            descriptionAr: "وصف أصلي",
            descriptionEn: "Original",
            isOnlineVisible: true,
          },
        }),
      );
      expect(res.status).toBe(200);

      const row = f.h.db.prepare("SELECT * FROM catalog_products WHERE id = ?").get(target.id) as Record<string, unknown>;
      expect(row.name_ar).toBe("مفتاح معدّل");
      expect(Number(row.selling_price_minor)).toBe(1400);
      const untouched = f.h.db.prepare("SELECT name_ar, selling_price_minor FROM catalog_products WHERE id = ?").get(other.id) as Record<string, unknown>;
      expect(untouched.name_ar).toBe("مطرقة");
      expect(Number(untouched.selling_price_minor)).toBe(2000);
    } finally {
      await f.cleanup();
    }
  });

  /**
   * 🔴 ABSENT IS NOT NULL, PROVEN AT THE PHONE'S OWN SUBMISSION. The form resubmits the enrichment
   * values it was SHOWN. Because the POS diffs against what it served, an untouched field produces
   * no patch key and `keep()` preserves what storage holds.
   *
   * This is the test a snapshot-overwrite implementation fails: it would send six nulls for six
   * untouched fields and wipe the enrichment.
   */
  it("🔴 changing ONLY the price preserves every enrichment field", async () => {
    const f = fixture();
    try {
      const { cat, target } = seed(f.h);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", target.id));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);

      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}`,
        submission({
          product: { nameAr: "مفتاح", nameEn: "Wrench", sku: "WR-1", price: "33.00", baseUnit: "piece" },
          // Exactly what the form was shown.
          master: {
            categoryId: cat.id,
            barcode: "5901234123457",
            brand: "Stanley",
            descriptionAr: "وصف أصلي",
            descriptionEn: "Original",
            isOnlineVisible: true,
          },
        }),
      );
      expect(res.status).toBe(200);

      const row = f.h.db.prepare("SELECT * FROM catalog_products WHERE id = ?").get(target.id) as Record<string, unknown>;
      expect(Number(row.selling_price_minor)).toBe(3300);
      // Every one of these would be NULL under a destructive overwrite.
      expect(row.category_id).toBe(cat.id);
      expect(row.brand).toBe("Stanley");
      expect(row.description_ar).toBe("وصف أصلي");
      expect(row.description_en).toBe("Original");
      expect(row.barcode).toBe("5901234123457");
      expect(Number(row.is_online_visible)).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 an EMPTIED field really does clear — the other half of the contract", async () => {
    const f = fixture();
    try {
      const { cat, target } = seed(f.h);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", target.id));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);

      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}`,
        submission({
          product: { nameAr: "مفتاح", nameEn: "Wrench", sku: "WR-1", price: "10.00", baseUnit: "piece" },
          master: {
            categoryId: cat.id,
            barcode: "5901234123457",
            // The owner emptied the brand box. That is an instruction, not an omission.
            brand: "",
            descriptionAr: "وصف أصلي",
            descriptionEn: "Original",
            isOnlineVisible: true,
          },
        }),
      );
      expect(res.status).toBe(200);
      const row = f.h.db.prepare("SELECT brand, description_ar FROM catalog_products WHERE id = ?").get(target.id) as Record<string, unknown>;
      expect(row.brand).toBeNull();
      // And the field next to it is untouched, so this was a clear and not a wipe.
      expect(row.description_ar).toBe("وصف أصلي");
    } finally {
      await f.cleanup();
    }
  });

  /**
   * 🔴 THE INACTIVE-CATEGORY ASYMMETRY, OVER THE PHONE. A product keeps a category that was
   * retired after it was assigned; a NEW assignment to a retired category is refused. Both halves,
   * because an implementation that enforced only the second would silently drop a real product's
   * category on the first phone save.
   */
  it("🔴 a retired category the product already carries SURVIVES a phone save", async () => {
    const f = fixture();
    try {
      const { cat, target } = seed(f.h);
      f.h.service.setCategoryActive(cat.id, false);

      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", target.id));
      const page = await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      // The form still SHOWS it, marked as retired — `categoryChoices`' own contract.
      expect(page.body).toContain("عدد");
      expect(page.body).toContain("متوقّف");

      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}`,
        submission({
          product: { nameAr: "مفتاح", nameEn: "Wrench", sku: "WR-1", price: "11.00", baseUnit: "piece" },
          master: {
            categoryId: cat.id,
            barcode: "5901234123457",
            brand: "Stanley",
            descriptionAr: "وصف أصلي",
            descriptionEn: "Original",
            isOnlineVisible: true,
          },
        }),
      );
      expect(res.status).toBe(200);
      const row = f.h.db.prepare("SELECT category_id FROM catalog_products WHERE id = ?").get(target.id) as { category_id: string };
      expect(row.category_id).toBe(cat.id);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 NEWLY selecting a retired category is REFUSED", async () => {
    const f = fixture();
    try {
      seed(f.h);
      const retired = f.h.service.createCategory("قديم", "Old");
      f.h.service.setCategoryActive(retired.id, false);
      const fresh = f.h.service.createProduct({
        nameAr: "صنف",
        nameEn: null,
        sku: null,
        price: "5.00",
        baseUnit: "piece",
      });

      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", fresh.id));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      const res = await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}`,
        submission({
          product: { nameAr: "صنف", nameEn: "", sku: "", price: "5.00", baseUnit: "piece" },
          master: { categoryId: retired.id },
        }),
      );
      expect(res.status).toBe(422);
      expect(res.json().code).toBe("CATEGORY_INACTIVE");
      const row = f.h.db.prepare("SELECT category_id FROM catalog_products WHERE id = ?").get(fresh.id) as { category_id: string | null };
      expect(row.category_id).toBeNull();
    } finally {
      await f.cleanup();
    }
  });
});

describe("the authoritative vocabularies reach the page", () => {
  it("🔴 the units are BASE_UNITS, not a list the page invented", async () => {
    const { BASE_UNITS } = await import("../../src/domain/catalog");
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      const page = await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      for (const u of BASE_UNITS) {
        expect(page.body, `the unit '${u}' must be offered`).toContain(`value="${u}"`);
      }
      // And nothing beyond them: every <option> inside the unit select is a real BASE_UNIT.
      const select = /<select id="baseUnit"[^>]*>([\s\S]*?)<\/select>/.exec(page.body);
      expect(select).not.toBeNull();
      const offered = [...(select![1]!.matchAll(/value="([^"]*)"/g))].map((m) => m[1]!);
      expect(offered.sort()).toEqual([...BASE_UNITS].sort());
    } finally {
      await f.cleanup();
    }
  });

  it("the categories and brand suggestions come from the ledger", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      f.h.service.createCategory("دهان", "Paint");
      f.h.service.createProduct({
        nameAr: "سلك",
        nameEn: null,
        sku: null,
        price: "3.00",
        baseUnit: "meter",
        master: { brand: "Hilti" },
      });

      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      const page = await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      expect(page.body).toContain("دهان");
      expect(page.body).toContain("Hilti");
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 the page is entirely local — no CDN, no remote font, no external URL", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      const page = await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      expect(page.body).not.toMatch(/https?:\/\//);
      expect(page.body).not.toMatch(/\/\/(cdn|fonts|unpkg|jsdelivr|googleapis)/i);
      expect(page.body).not.toMatch(/@import|<link\b/i);
      // The token is in the URL the phone already has; it must not also be in the page.
      expect(page.body).not.toContain(TOKEN);
    } finally {
      await f.cleanup();
    }
  });
});

describe("hostile and malformed submissions", () => {
  async function post(f: Fixture, body: string): Promise<Reply> {
    f.h.service.login(OWNER.cashierId, OWNER.pin);
    const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
    await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
    return request(dto.host, dto.port, "POST", `/m/${TOKEN}`, body);
  }

  const cases: ReadonlyArray<readonly [string, string]> = [
    ["not JSON at all", "<<<not json>>>"],
    ["an empty body", ""],
    ["an array instead of an object", "[]"],
    ["a bare string", '"hello"'],
    ["no product group", JSON.stringify({ master: {} })],
    ["no master group", JSON.stringify({ product: {} })],
    ["an extra top-level field", JSON.stringify({ product: {}, master: {}, isActive: false })],
    ["an extra product field", JSON.stringify({ product: { nameAr: "x", id: "1" }, master: {} })],
    ["an extra master field", JSON.stringify({ product: { nameAr: "x" }, master: { hasImage: true } })],
    ["a numeric name", JSON.stringify({ product: { nameAr: 42 }, master: {} })],
    ["an object as a price", JSON.stringify({ product: { nameAr: "x", price: {} }, master: {} })],
    ["a non-boolean visibility", JSON.stringify({ product: { nameAr: "x" }, master: { isOnlineVisible: "yes" } })],
  ];

  for (const [label, body] of cases) {
    it(`refuses ${label}, and writes nothing`, async () => {
      const f = fixture();
      try {
        const before = countProducts(f.h);
        const res = await post(f, body);
        expect(res.status, label).toBeGreaterThanOrEqual(400);
        expect(res.json().ok).not.toBe(true);
        expect(countProducts(f.h), label).toBe(before);
      } finally {
        await f.cleanup();
      }
    });
  }

  it("refuses a missing name, a bad price and an unknown unit — each by its own code", async () => {
    for (const [body, code] of [
      [submission({ product: { nameAr: "   " } }), "INVALID_INPUT"],
      [submission({ product: { price: "abc" } }), "INVALID_AMOUNT"],
      [submission({ product: { price: "-5" } }), "INVALID_AMOUNT"],
      [submission({ product: { baseUnit: "furlong" } }), "UNSUPPORTED_UNIT"],
      [submission({ master: { categoryId: "cat-nope" } }), "CATEGORY_NOT_FOUND"],
    ] as const) {
      const f = fixture();
      try {
        const before = countProducts(f.h);
        const res = await post(f, body);
        expect(res.status).toBe(422);
        expect(res.json().code, body).toBe(code);
        expect(countProducts(f.h)).toBe(before);
      } finally {
        await f.cleanup();
      }
    }
  });

  it("🔴 an oversized body is refused and nothing is written", async () => {
    const f = fixture();
    try {
      const before = countProducts(f.h);
      // Well past PHONE_SUBMISSION_MAX_BYTES but under the transport cap, so it is the
      // submission limit under test rather than the socket's.
      const huge = submission({ product: { nameAr: "م".repeat(90_000) } });
      const res = await post(f, huge);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(countProducts(f.h)).toBe(before);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 an expired session refuses a save with a readable sentence, not a bare 404", async () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    let clock = Date.now();
    const bridge = new PhoneSessionBridge({
      service: h.service,
      interfaces: () => IFACES,
      randomToken: () => TOKEN,
      renderQr: async () => "<svg/>",
      now: () => clock,
    });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await bridge.start(h.service.authorizePhoneSession("NEW_PRODUCT", null));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      const before = countProducts(h);

      clock += 11 * 60 * 1000;
      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(res.status).toBe(404);
      expect(res.json().code).toBe("SESSION_CLOSED");
      // 🔴 Arabic, and specific to THIS situation — not a generic "could not understand".
      expect(res.json().message).toContain("انتهت صلاحية");
      expect(countProducts(h)).toBe(before);
    } finally {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    }
  });
});

describe("after a successful save", () => {
  it("🔴 the listener closes and a replay cannot connect", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      expect(await isListening(dto.port)).toBe(true);

      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(res.status).toBe(200);

      await new Promise((r) => setTimeout(r, 80));
      expect(await isListening(dto.port)).toBe(false);
      expect(f.bridge.isOpen()).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 the desktop learns WHICH product was saved — once", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      expect(f.bridge.status().state).toBe("waiting");

      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      expect(f.bridge.status().state).toBe("claimed");

      await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      await new Promise((r) => setTimeout(r, 60));

      const first = f.bridge.status();
      expect(first.state).toBe("saved");
      expect(first.savedProductId).not.toBeNull();
      expect(first.action).toBe("NEW_PRODUCT");
      // The saved product really is in the ledger under that id.
      const row = f.h.db
        .prepare("SELECT id FROM catalog_products WHERE id = ?")
        .get(first.savedProductId) as { id: string } | undefined;
      expect(row?.id).toBe(first.savedProductId);

      // 🔴 REPORTED ONCE, AND THE SECOND POLL SAYS `closed`. Both halves matter, and the second
      // one is what broke the desktop dialog: a component that branched on the live poll value
      // alone showed the success banner for one second and then fell through to rendering the QR
      // again, for a session that no longer existed. The dialog now latches the terminal state;
      // this assertion is the reason it has to.
      expect(f.bridge.status().state).toBe("closed");
      expect(f.bridge.status().savedProductId).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  it("an EDIT save reports the bound product id", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const p = f.h.service.createProduct({
        nameAr: "مفتاح",
        nameEn: null,
        sku: null,
        price: "10.00",
        baseUnit: "piece",
      });
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("EDIT_PRODUCT", p.id));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      await request(
        dto.host,
        dto.port,
        "POST",
        `/m/${TOKEN}`,
        submission({ product: { nameAr: "مفتاح", price: "15.00" } }),
      );
      await new Promise((r) => setTimeout(r, 60));
      const st = f.bridge.status();
      expect(st.state).toBe("saved");
      expect(st.savedProductId).toBe(p.id);
      expect(st.action).toBe("EDIT_PRODUCT");
    } finally {
      await f.cleanup();
    }
  });
});

describe("authorization still holds at SAVE time", () => {
  /**
   * 🔴 THE ESCALATION THIS CLOSES, AND IT IS SUBTLE ENOUGH TO HAVE BEEN MISSED.
   *
   * `createProduct` requires only a logged-in operator — its owner gate has always been the
   * channel table, and the channel table is exactly what the LAN listener skips. So without a
   * check at save time: an owner opens a phone session, logs out, a CASHIER logs in at the till,
   * and the phone's save writes a product under the cashier's session. An owner-only act,
   * performed by a cashier, with the cashier's name on the audit row.
   */
  it("🔴 a CASHIER logged in at the till cannot complete an owner's phone session", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      const before = countProducts(f.h);

      // The till changes hands while the phone is still open.
      f.h.service.logout();
      f.h.service.login(CASHIER.cashierId, CASHIER.pin);

      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(res.status).toBe(422);
      expect(res.json().code).toBe("NOT_AUTHORIZED");
      expect(countProducts(f.h)).toBe(before);
    } finally {
      await f.cleanup();
    }
  });

  it("🔴 nobody logged in at the till cannot complete a phone session either", async () => {
    const f = fixture();
    try {
      f.h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await f.bridge.start(f.h.service.authorizePhoneSession("NEW_PRODUCT", null));
      await request(dto.host, dto.port, "GET", `/m/${TOKEN}`);
      const before = countProducts(f.h);

      f.h.service.logout();
      const res = await request(dto.host, dto.port, "POST", `/m/${TOKEN}`, submission());
      expect(res.status).toBe(422);
      expect(["NOT_LOGGED_IN", "NOT_AUTHORIZED"]).toContain(res.json().code);
      expect(countProducts(f.h)).toBe(before);
    } finally {
      await f.cleanup();
    }
  });
});
