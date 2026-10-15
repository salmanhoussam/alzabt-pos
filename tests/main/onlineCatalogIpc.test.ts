/**
 * Slice G3 — the Online Catalogue export across the real IPC bridge.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 AUTHORIZATION IS TESTED TWICE, ON PURPOSE, because it is enforced twice.
 *
 * `channelPolicy` refuses a cashier at the bridge, and `onlineCatalogSnapshot()` refuses one again
 * inside the service. Testing only the bridge would leave the service's guard unproven — and the
 * service's guard is the one that matters for slice H, whose LAN listener calls the service
 * directly and never passes through `ipcMain` at all.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNELS } from "../../src/shared/ipcContract";
import { CHANNEL_POLICY } from "../../src/main/channelPolicy";
import { createIpcHandlers, syncHandlers } from "../../src/main/ipcHandlers";
import type { OnlineCatalogSnapshot } from "../../src/application/posService";
import { type TempDir, makeHarness, tempDir } from "../helpers/harness";

let t: TempDir;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

type Res = { ok: boolean; error?: { code: string }; data?: unknown };
const code = (r: unknown) => (r as Res).error?.code;
const data = <T>(r: unknown): T => {
  const res = r as Res;
  if (!res.ok) throw new Error(`expected ok, got ${res.error?.code}`);
  return res.data as T;
};

interface Ctx {
  readonly h: ReturnType<typeof makeHarness>;
  readonly ipc: ReturnType<typeof syncHandlers>;
  readonly seen: OnlineCatalogSnapshot[];
}

function withApp(
  as: "owner" | "cashier" | "none",
  fn: (ctx: Ctx) => void,
  opts: { exporter?: "normal" | "cancel" | "absent" } = {},
): void {
  const h = makeHarness(t.dbPath, { login: false });
  const seen: OnlineCatalogSnapshot[] = [];
  const mode = opts.exporter ?? "normal";
  try {
    const ipc = syncHandlers(
      createIpcHandlers(h.service, {
        ...(mode === "absent"
          ? {}
          : {
              exportOnlineCatalog: (snapshot: OnlineCatalogSnapshot) => {
                seen.push(snapshot);
                return mode === "cancel"
                  ? null
                  : {
                      folderName: "Alzabt-Shop-Export-test",
                      products: snapshot.document.products.length,
                      images: snapshot.images.length,
                      incomplete: 0,
                    };
              },
            }),
      }),
    );
    if (as === "owner") ipc.login({ cashierId: "cashier-01", pin: "1111" });
    if (as === "cashier") ipc.login({ cashierId: "cashier-02", pin: "2222" });
    fn({ h, ipc, seen });
  } finally {
    h.db.close();
  }
}

/** One active, online-visible product, through the real service. */
function publishOne(h: ReturnType<typeof makeHarness>): string {
  const p = h.service.createProduct({
    nameAr: "صنف",
    nameEn: "Item",
    sku: "S-1",
    price: "4.00",
    baseUnit: "piece",
  } as never);
  h.service.updateProduct(
    p.id,
    { nameAr: "صنف", nameEn: "Item", sku: "S-1", price: "4.00", baseUnit: "piece", master: { isOnlineVisible: true } } as never,
    true,
  );
  return p.id;
}

describe("authorization", () => {
  it("🔴 the channel is classified OWNER, and the policy knows it", () => {
    expect(CHANNEL_POLICY.exportOnlineCatalog).toBe("owner");
    expect(CHANNELS.exportOnlineCatalog).toBe("pos:exportOnlineCatalog");
  });

  it("an OWNER exports", () => {
    withApp("owner", ({ h, ipc, seen }) => {
      publishOne(h);
      const result = data<{ products: number; folderName: string }>(ipc.exportOnlineCatalog(undefined));
      expect(result.products).toBe(1);
      expect(result.folderName).toBe("Alzabt-Shop-Export-test");
      expect(seen).toHaveLength(1);
    });
  });

  it("🔴 a CASHIER is refused, and the exporter is never reached", () => {
    withApp("cashier", ({ h, ipc, seen }) => {
      publishOne(h);
      expect(code(ipc.exportOnlineCatalog(undefined))).toBe("NOT_AUTHORIZED");
      // The refusal happens BEFORE anything could be written — not after a package appeared.
      expect(seen, "a refused export must not reach the writer at all").toEqual([]);
    });
  });

  it("an UNAUTHENTICATED terminal is refused", () => {
    withApp("none", ({ ipc, seen }) => {
      expect(code(ipc.exportOnlineCatalog(undefined))).toBeTruthy();
      expect(seen).toEqual([]);
    });
  });

  it("🔴 CONTROL — the same call succeeds for an owner, so the refusals are not vacuous", () => {
    withApp("owner", ({ h, ipc }) => {
      publishOne(h);
      expect((ipc.exportOnlineCatalog(undefined) as Res).ok).toBe(true);
    });
  });
});

describe("the channel's shape", () => {
  it("takes NO payload — a renderer cannot name a destination", () => {
    withApp("owner", ({ ipc }) => {
      expect(code(ipc.exportOnlineCatalog({ parentDir: "C:\\\\Users\\\\hussein" } as never))).toBe("INVALID_INPUT");
    });
  });

  it("🔴 returns no path — only a folder NAME and counts", () => {
    withApp("owner", ({ h, ipc }) => {
      publishOne(h);
      const result = data<Record<string, unknown>>(ipc.exportOnlineCatalog(undefined));
      expect(Object.keys(result).sort()).toEqual(["folderName", "images", "incomplete", "products"]);
      const text = JSON.stringify(result);
      expect(text).not.toMatch(/[A-Za-z]:\\\\|\/home\/|\/Users\//);
    });
  });

  it("a cancelled picker answers null — not an error, and nothing was written", () => {
    withApp(
      "owner",
      ({ h, ipc }) => {
        publishOne(h);
        const res = ipc.exportOnlineCatalog(undefined) as Res;
        expect(res.ok).toBe(true);
        expect(res.data).toBeNull();
      },
      { exporter: "cancel" },
    );
  });

  it("without an exporter wired the channel fails CLOSED", () => {
    withApp(
      "owner",
      ({ h, ipc }) => {
        publishOne(h);
        expect(code(ipc.exportOnlineCatalog(undefined))).toBe("NOT_AVAILABLE");
      },
      { exporter: "absent" },
    );
  });
});

describe("what reaches the writer", () => {
  it("🔴 the snapshot carries the document and the image ids, and no bytes", () => {
    withApp("owner", ({ h, ipc, seen }) => {
      publishOne(h);
      ipc.exportOnlineCatalog(undefined);
      const snapshot = seen[0]!;
      expect(Object.keys(snapshot).sort()).toEqual(["document", "images"]);
      expect(JSON.stringify(snapshot)).not.toContain("bytes");
      expect(snapshot.document.schema_version).toBe(1);
    });
  });

  it("an empty catalogue is still a successful export, reported as zero", () => {
    withApp("owner", ({ ipc, seen }) => {
      const result = data<{ products: number }>(ipc.exportOnlineCatalog(undefined));
      expect(result.products).toBe(0);
      expect(seen[0]!.document.products).toEqual([]);
    });
  });
});
