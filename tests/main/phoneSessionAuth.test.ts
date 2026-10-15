/**
 * Who may open the phone surface, and what the surface is scoped to — through the REAL service,
 * the REAL channels and a REAL socket.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE OWNER CHECK IS TESTED AT THE SERVICE AND NOT ONLY AT THE CHANNEL.
 *
 * `channelPolicy.test.ts` already proves a cashier is refused `startPhoneSession` through the IPC
 * table. That is the outer door. But the listener this slice opens answers HTTP inside the main
 * process and calls service methods DIRECTLY — it never passes through `ipcMain`, so it never
 * passes through `channelPolicy` either. If the only owner check lived in that table, the service
 * would be wide open to the one caller that skips it.
 *
 * So the test below calls `service.authorizePhoneSession` with a cashier session and no session at
 * all, bypassing the channel exactly as the listener does, and requires a refusal from the service
 * itself. Contract #4 in the project's own list says this; this file is what holds it.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import { DomainError } from "../../src/domain/errors";
import { createIpcHandlers } from "../../src/main/ipcHandlers";
import { PhoneSessionBridge } from "../../src/main/phoneSessionBridge";
import { PHONE_SESSION_TTL_MS } from "../../src/domain/phoneSession";
import { networkInterfaces as realInterfaces } from "node:os";
import type { NetworkInterfaceMap } from "../../src/main/lanAddress";
import { makeHarness, tempDir } from "../helpers/harness";

/** `cashier-01` is the OWNER in every harness; `cashier-02` is a real cashier. */
const OWNER = { cashierId: "cashier-01", pin: "1111" };
const CASHIER = { cashierId: "cashier-02", pin: "2222" };

/**
 * The address these tests bind.
 *
 * 🔴 IT IS THIS MACHINE'S REAL LAN ADDRESS, NOT LOOPBACK, and that is forced rather than chosen:
 * `selectLanAddress` excludes `127.*` outright (two independent layers refuse loopback), so a
 * loopback fixture would make every bridge test fail with "no reachable address" — which is
 * exactly the behaviour its own test asserts. So the fixture presents the real adapter, the
 * listener binds it, and the test connects to it over the real stack.
 *
 * If a machine genuinely has no LAN address the bridge tests cannot run there, and they say so
 * loudly rather than passing vacuously.
 */
const LAN_ADDRESS = (() => {
  for (const addrs of Object.values(realInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !/^127\./.test(a.address)) return a.address;
    }
  }
  return null;
})();

const LAN_IFACES: NetworkInterfaceMap = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [{ address: LAN_ADDRESS ?? "127.0.0.1", family: "IPv4", internal: false }],
};

const TOKEN = "e".repeat(64);

async function isListening(port: number, host: string = LAN_ADDRESS ?? "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
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

/** A bridge that needs no WebAssembly and binds loopback, so the lifecycle is what is under test. */
function testBridge() {
  return new PhoneSessionBridge({
    interfaces: () => LAN_IFACES,
    randomToken: () => TOKEN,
    renderQr: async () => "<svg data-fake-qr='1'></svg>",
  });
}

describe("only an owner may open the phone surface", () => {
  it("the OWNER can authorize a new-product session", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const spec = h.service.authorizePhoneSession("NEW_PRODUCT", null);
      expect(spec.action).toBe("NEW_PRODUCT");
      expect(spec.productId).toBeNull();
      expect(spec.operatorId).toBe("cashier-01");
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  /**
   * 🔴 THE CASHIER REFUSAL AT THE SERVICE — the half `channelPolicy` cannot cover, because the
   * listener does not go through it.
   */
  it("🔴 a CASHIER is refused BY THE SERVICE, not merely by the channel table", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const login = h.service.login(CASHIER.cashierId, CASHIER.pin);
      expect(login.kind).toBe("session");

      // Called directly, exactly as the LAN listener would.
      let thrown: unknown;
      try {
        h.service.authorizePhoneSession("NEW_PRODUCT", null);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      expect((thrown as DomainError).code).toBe("NOT_AUTHORIZED");

      // And for the edit path too — a cashier must not reach it by naming a product either.
      expect(() => h.service.authorizePhoneSession("EDIT_PRODUCT", "manual:000001")).toThrow(DomainError);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  it("🔴 with NO session at all it is refused", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      let thrown: unknown;
      try {
        h.service.authorizePhoneSession("NEW_PRODUCT", null);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      // Not logged in is its own refusal, distinct from "you are not the owner".
      expect(["NOT_LOGGED_IN", "NOT_AUTHORIZED"]).toContain((thrown as DomainError).code);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  it("the CHANNEL refuses a cashier too — both doors, independently", async () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const ipc = createIpcHandlers(h.service, { phoneSessions: testBridge() });
      h.service.login(CASHIER.cashierId, CASHIER.pin);
      const r = (await ipc.startPhoneSession({ action: "NEW_PRODUCT" })) as {
        ok: boolean;
        error?: { code: string };
      };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("NOT_AUTHORIZED");
    } finally {
      h.db.close();
      t.cleanup();
    }
  });
});

describe("the product binding is resolved by the service, not sent by the phone", () => {
  it("an EDIT session names a real product", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      // A REAL row in `catalog_products`. The fixture catalog (`prod-0001`) is the startup JSON
      // catalog, not the Product Master table `findById` reads — using it would have made this
      // test pass for the wrong reason, or in this case fail for an unrelated one.
      const product = h.service.createProduct({
        nameAr: "مفتاح",
        nameEn: null,
        sku: null,
        price: "5.00",
        baseUnit: "piece",
      });
      const spec = h.service.authorizePhoneSession("EDIT_PRODUCT", product.id);
      expect(spec.action).toBe("EDIT_PRODUCT");
      expect(spec.productId).toBe(product.id);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  /**
   * 🔴 A TOKEN IS NEVER MINTED FOR A PRODUCT THAT DOES NOT EXIST. Resolving at creation rather than
   * at save time means the phone never has to be trusted with an id, and a typo cannot produce a
   * live session bound to nothing.
   */
  it("🔴 an unknown product is refused before any session or socket exists", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      let thrown: unknown;
      try {
        h.service.authorizePhoneSession("EDIT_PRODUCT", "manual:does-not-exist");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      expect((thrown as DomainError).code).toBe("PRODUCT_NOT_FOUND");
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  it("🔴 the WRONG ACTION/PRODUCT combinations are refused", () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      // An edit with no product.
      expect(() => h.service.authorizePhoneSession("EDIT_PRODUCT", null)).toThrow(DomainError);
      expect(() => h.service.authorizePhoneSession("EDIT_PRODUCT", "   ")).toThrow(DomainError);
      // A new product that names an existing one.
      expect(() => h.service.authorizePhoneSession("NEW_PRODUCT", "manual:000001")).toThrow(DomainError);
      // A third action that is not in the enumeration.
      expect(() =>
        h.service.authorizePhoneSession("DELETE_PRODUCT" as unknown as "NEW_PRODUCT", null),
      ).toThrow(DomainError);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  it("the channel refuses an unknown action before the service is reached", async () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const ipc = createIpcHandlers(h.service, { phoneSessions: testBridge() });
      h.service.login(OWNER.cashierId, OWNER.pin);
      for (const action of ["", "new_product", "NEW", "DROP TABLE", null, 1, {}]) {
        const r = (await ipc.startPhoneSession({ action })) as { ok: boolean; error?: { code: string } };
        expect(r.ok, JSON.stringify(action)).toBe(false);
        expect(r.error?.code).toBe("INVALID_INPUT");
      }
    } finally {
      h.db.close();
      t.cleanup();
    }
  });
});

describe("the channel's answer", () => {
  /**
   * 🔴 THE DTO MUST NOT CARRY THE TOKEN. The desktop needs a picture and an address; it does not
   * need the credential, and a renderer that held one could leak it through a screenshot, a log, or
   * a devtools inspection. The token lives only inside the QR symbol.
   */
  it("🔴 returns the QR and the address, and NEVER the token or the operator", async () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    const bridge = testBridge();
    try {
      const ipc = createIpcHandlers(h.service, { phoneSessions: bridge });
      h.service.login(OWNER.cashierId, OWNER.pin);
      const r = (await ipc.startPhoneSession({ action: "NEW_PRODUCT" })) as {
        ok: boolean;
        data: Record<string, unknown>;
      };
      expect(r.ok).toBe(true);
      const dto = r.data;

      // What it DOES carry.
      expect(dto.action).toBe("NEW_PRODUCT");
      expect(dto.host).toBe(LAN_ADDRESS);
      expect(typeof dto.port).toBe("number");
      expect(dto.qrSvg).toContain("<svg");
      expect(new Date(dto.expiresAt as string).getTime()).toBeGreaterThan(Date.now());

      // 🔴 What it must NOT carry — asserted over the SERIALIZED DTO, so a field added in a nested
      // object in future is caught too.
      const json = JSON.stringify(dto);
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain("cashier-01");
      expect(json).not.toContain("1111");
      expect(Object.keys(dto).sort()).toEqual(
        ["action", "addressAmbiguous", "addressCandidates", "expiresAt", "host", "port", "qrSvg"].sort(),
      );
      expect(dto.expiresAt).toBe(
        new Date(Math.floor(new Date(dto.expiresAt as string).getTime())).toISOString(),
      );
    } finally {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    }
  });

  it("expiry is ten minutes out, from the DTO the desktop actually receives", async () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    const bridge = testBridge();
    try {
      const ipc = createIpcHandlers(h.service, { phoneSessions: bridge });
      h.service.login(OWNER.cashierId, OWNER.pin);
      const before = Date.now();
      const r = (await ipc.startPhoneSession({ action: "NEW_PRODUCT" })) as { data: { expiresAt: string } };
      const ttl = new Date(r.data.expiresAt).getTime() - before;
      expect(ttl).toBeGreaterThan(PHONE_SESSION_TTL_MS - 5000);
      expect(ttl).toBeLessThanOrEqual(PHONE_SESSION_TTL_MS + 1000);
    } finally {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    }
  });

  it("without the bridge wired, the channel says NOT_AVAILABLE rather than half-working", async () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      const ipc = createIpcHandlers(h.service);
      h.service.login(OWNER.cashierId, OWNER.pin);
      const r = (await ipc.startPhoneSession({ action: "NEW_PRODUCT" })) as {
        ok: boolean;
        error?: { code: string };
      };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("NOT_AVAILABLE");
      // 🔴 And this is why every headless test is safe: no socket can be opened by accident.
      const c = (await ipc.cancelPhoneSession(undefined)) as { ok: boolean; data: { closed: boolean } };
      expect(c.ok).toBe(true);
      expect(c.data.closed).toBe(false);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });
});

describe("the bridge's lifecycle", () => {
  it("🔴 cancel through the CHANNEL closes the real socket", async () => {
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    const bridge = testBridge();
    try {
      const ipc = createIpcHandlers(h.service, { phoneSessions: bridge });
      h.service.login(OWNER.cashierId, OWNER.pin);
      const r = (await ipc.startPhoneSession({ action: "NEW_PRODUCT" })) as { data: { port: number } };
      const port = r.data.port;
      expect(await isListening(port)).toBe(true);

      const c = (await ipc.cancelPhoneSession(undefined)) as { data: { closed: boolean } };
      expect(c.data.closed).toBe(true);
      expect(await isListening(port)).toBe(false);
      expect(bridge.isOpen()).toBe(false);
    } finally {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    }
  });

  /**
   * 🔴 THE APP-CLOSE INVALIDATION, WHICH `main.ts` WIRES INTO `will-quit`. A listener that is only
   * killed with the process relies on the OS to shut the surface; this makes it a property the code
   * owns.
   */
  it("🔴 appClosing() closes the socket — the will-quit path", async () => {
    const bridge = testBridge();
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await bridge.start(h.service.authorizePhoneSession("NEW_PRODUCT", null));
      expect(await isListening(dto.port)).toBe(true);

      expect(await bridge.appClosing()).toBe(true);
      expect(await isListening(dto.port)).toBe(false);
      expect(bridge.isOpen()).toBe(false);
      // Idempotent: quitting twice is not an error.
      expect(await bridge.appClosing()).toBe(false);
    } finally {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    }
  });

  it("🔴 navigating away closes it — the contract's own invalidation", async () => {
    const bridge = testBridge();
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const dto = await bridge.start(h.service.authorizePhoneSession("NEW_PRODUCT", null));
      expect(await bridge.navigatedAway()).toBe(true);
      expect(await isListening(dto.port)).toBe(false);
    } finally {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    }
  });

  /**
   * 🔴 ONE SURFACE AT A TIME. Starting a second session must close the first — otherwise the OLD
   * token stays live and claimable while the desktop shows only the new QR, which is an open port
   * nobody is looking at.
   */
  it("🔴 a second start closes the first listener", async () => {
    const bridge = testBridge();
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const first = await bridge.start(h.service.authorizePhoneSession("NEW_PRODUCT", null));
      expect(await isListening(first.port)).toBe(true);

      const product = h.service.createProduct({
        nameAr: "مفتاح",
        nameEn: null,
        sku: null,
        price: "5.00",
        baseUnit: "piece",
      });
      const second = await bridge.start(h.service.authorizePhoneSession("EDIT_PRODUCT", product.id));
      expect(await isListening(first.port)).toBe(false);
      expect(await isListening(second.port)).toBe(true);
      expect(second.action).toBe("EDIT_PRODUCT");
    } finally {
      await bridge.cancel();
      h.db.close();
      t.cleanup();
    }
  });

  /**
   * 🔴 NO NETWORK MEANS A REFUSAL WITH A SENTENCE, NOT A LOOPBACK QR. A machine with nothing but
   * loopback must not produce a session at all.
   */
  it("🔴 refuses to open a session when there is no reachable address", async () => {
    const bridge = new PhoneSessionBridge({
      interfaces: () => ({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] }),
      randomToken: () => TOKEN,
      renderQr: async () => "<svg/>",
    });
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const spec = h.service.authorizePhoneSession("NEW_PRODUCT", null);
      await expect(bridge.start(spec)).rejects.toThrow(DomainError);
      expect(bridge.isOpen()).toBe(false);
    } finally {
      h.db.close();
      t.cleanup();
    }
  });

  /**
   * 🔴 A SESSION WHOSE QR COULD NOT BE DRAWN MUST NOT BE LEFT LISTENING. Without the rollback in
   * `start`, a failing encoder would leave an orphan port open with a live token and no way for the
   * desktop to show or cancel it.
   */
  it("🔴 a failing QR encoder leaves NO listener behind", async () => {
    const bridge = new PhoneSessionBridge({
      interfaces: () => LAN_IFACES,
      randomToken: () => TOKEN,
      renderQr: async () => {
        throw new Error("encoder exploded");
      },
    });
    const t = tempDir();
    const h = makeHarness(t.dbPath, { login: false });
    try {
      h.service.login(OWNER.cashierId, OWNER.pin);
      const spec = h.service.authorizePhoneSession("NEW_PRODUCT", null);
      await expect(bridge.start(spec)).rejects.toThrow(/encoder exploded/);
      expect(bridge.isOpen()).toBe(false);
      expect(bridge.openPort()).toBeNull();
    } finally {
      h.db.close();
      t.cleanup();
    }
  });
});
