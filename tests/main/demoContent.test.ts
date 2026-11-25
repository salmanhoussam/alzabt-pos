/**
 * Joint C1 — the demo's CONTENT and its seed plan, tested against fake ports only (contract J0-CODEX-1;
 * Claude-owned per K-1). Path / profile / reset / policy / session tests are Codex's (X1/X2), not here.
 *
 * P1 the selection: exactly 22 active fixture SKUs over 8 categories.
 * P2 the photos: every selected SKU has a real JPEG, credited CC0 / public domain, unique by SHA-256.
 * P3 fail closed: a failing port stops the seed; nothing after it runs; no report is returned.
 * P4 the image-name rule: only `<SKU>.jpg` from the fixture manifest crosses the port — never a path.
 * Plus: the seed module imports nothing (no Electron / fs / dialog / IPC) — asserted on the parsed AST.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  DEMO_EXPECTED,
  DEMO_IMAGE_NAME,
  DemoSeedError,
  type DemoDefinition,
  type DemoSeedPorts,
  type FixtureCatalog,
  csvRowOrder,
  cutCatalogCsv,
  demoImageName,
  fixtureImageManifest,
  seedDemoLedger,
  selectDemoProducts,
  usedCategories,
} from "../../src/main/demoSeed";

const ROOT = join(__dirname, "..", "..");
const FIXTURE_DIR = join(ROOT, "tests", "fixtures", "demo-catalog");
const definition = JSON.parse(readFileSync(join(ROOT, "resources", "demo", "demo-profile.json"), "utf8")) as DemoDefinition;
const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "catalog.json"), "utf8")) as FixtureCatalog;
const catalogCsv = new Uint8Array(readFileSync(join(FIXTURE_DIR, "alzabt-demo-catalog-import.csv")));
const credits = JSON.parse(readFileSync(join(FIXTURE_DIR, "image-credits.json"), "utf8")) as Record<
  string,
  { file: string; licence: string; source_page: string }
>;

type Call = { port: keyof DemoSeedPorts; args: unknown[] };

/** C1-R3: failures are asserted by their fixed STAGE code, never by message text. */
function stageOf(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(DemoSeedError);
    return (e as DemoSeedError).stage;
  }
  throw new Error("expected a DemoSeedError");
}
async function stageOfAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(DemoSeedError);
    return (e as DemoSeedError).stage;
  }
  throw new Error("expected a DemoSeedError");
}

/** A recording fake: every port succeeds unless `failAt` names it (optionally on its n-th call). */
function fakePorts(opts: { failAt?: keyof DemoSeedPorts; failOnCall?: number; importIds?: (n: number) => string[] } = {}) {
  const calls: Call[] = [];
  const count: Partial<Record<keyof DemoSeedPorts, number>> = {};
  const hit = (port: keyof DemoSeedPorts, args: unknown[]) => {
    calls.push({ port, args });
    count[port] = (count[port] ?? 0) + 1;
    if (opts.failAt === port && (opts.failOnCall === undefined || opts.failOnCall === count[port])) {
      throw new Error(`fake ${port} refused`);
    }
  };
  let category = 0;
  const ports: DemoSeedPorts = {
    completeOwnerSetup: async (...a) => (hit("completeOwnerSetup", a), { operatorId: "op-owner" }),
    completeCashierSetup: async (...a) => (hit("completeCashierSetup", a), { operatorId: "op-cashier" }),
    saveCompanyProfile: async (...a) => void hit("saveCompanyProfile", a),
    importCatalogCsv: async (csv) => {
      hit("importCatalogCsv", [csv]);
      const rows = new TextDecoder().decode(csv).split("\n").slice(1).filter((l) => l.trim() !== "").length;
      return { productIds: opts.importIds ? opts.importIds(rows) : Array.from({ length: rows }, (_, i) => `prod-${i + 1}`) };
    },
    ensureCategory: async (...a) => (hit("ensureCategory", a), { categoryId: `cat-${++category}` }),
    updateProductDetails: async (...a) => void hit("updateProductDetails", a),
    setProductImageFromFixture: async (...a) => void hit("setProductImageFromFixture", a),
  };
  return { ports, calls };
}

const inputs = { definition, fixture, catalogCsv };

describe("P1 — the 22-product selection", () => {
  it("selects exactly the 22 defined SKUs, all active fixture products, over the 8 fixture categories", () => {
    const selected = selectDemoProducts(definition, fixture);
    expect(selected).toHaveLength(DEMO_EXPECTED.products);
    expect(selected.map((p) => p.sku)).toEqual(definition.skus);
    expect(selected.every((p) => p.active)).toBe(true);
    expect(usedCategories(fixture, selected).map(([key]) => key).sort()).toEqual(
      ["bakery", "beverages", "cafe", "canned", "cleaning", "dairy", "groceries", "produce"],
    );
  });

  it("refuses 21 products, a duplicate, an unknown SKU, an inactive one and bad or shared PINs", () => {
    const withPatch = (patch: Partial<DemoDefinition>) => ({ ...definition, ...patch });
    expect(() => selectDemoProducts(withPatch({ skus: definition.skus.slice(1) }), fixture)).toThrow(DemoSeedError);
    expect(stageOf(() => selectDemoProducts(withPatch({ skus: [...definition.skus.slice(1), definition.skus[1]!] }), fixture))).toBe("definition-sku-duplicate");
    expect(stageOf(() => selectDemoProducts(withPatch({ skus: [...definition.skus.slice(1), "NOPE-1"] }), fixture))).toBe("definition-sku-unknown");
    const inactive = { ...fixture, products: fixture.products.map((p) => (p.sku === "COF-ESP" ? { ...p, active: false } : p)) };
    expect(stageOf(() => selectDemoProducts(definition, inactive))).toBe("definition-sku-inactive");
    expect(stageOf(() => selectDemoProducts(withPatch({ owner: { name: "x", pin: "1111" } }), fixture))).toBe("definition-pin");
    expect(stageOf(() => selectDemoProducts(withPatch({ cashier: { name: "x", pin: definition.owner.pin } }), fixture))).toBe("definition-pin-shared");
    expect(stageOf(() => selectDemoProducts(withPatch({ skus: definition.skus.slice(1) }), fixture))).toBe("definition-count");
  });
});

describe("P2 — the photos are real, credited and distinct", () => {
  it("every selected SKU has a JPEG in the fixture, credited CC0 / public domain, with a unique SHA-256", () => {
    const hashes = new Set<string>();
    for (const sku of definition.skus) {
      const credit = credits[sku];
      expect(credit, `${sku} credited`).toBeDefined();
      expect(credit!.file).toBe(`${sku}.jpg`);
      expect(["CC0", "Public domain"]).toContain(credit!.licence);
      expect(credit!.source_page).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
      const bytes = readFileSync(join(FIXTURE_DIR, "images", credit!.file));
      expect([...bytes.subarray(0, 3)], `${sku} is a JPEG`).toEqual([0xff, 0xd8, 0xff]);
      hashes.add(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(hashes.size).toBe(DEMO_EXPECTED.photos);
  });
});

describe("the catalog CSV cut", () => {
  it("keeps the header and exactly the 22 selected rows, and its row order maps back to the products", () => {
    const selected = selectDemoProducts(definition, fixture);
    const cut = cutCatalogCsv(catalogCsv, new Set(selected.map((p) => p.source_id)));
    const lines = new TextDecoder().decode(cut).split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1 + DEMO_EXPECTED.products);
    expect(lines[0]).toContain("source_id");
    expect(csvRowOrder(cut, selected).map((p) => p.source_id).sort()).toEqual(selected.map((p) => p.source_id).sort());
  });

  it("refuses when a selected row is missing from the CSV", () => {
    expect(() => cutCatalogCsv(catalogCsv, new Set(["CAFE-001", "NOT-THERE"]))).toThrow(DemoSeedError);
    expect(stageOf(() => cutCatalogCsv(catalogCsv, new Set(["CAFE-001", "NOT-THERE"])))).toBe("csv-rows");
  });
});

describe("the seed through fake ports", () => {
  it("writes owner, cashier, shop, 22 products, 8 categories and 22 photos — and returns IDs and counts only", async () => {
    const { ports, calls } = fakePorts();
    const report = await seedDemoLedger(ports, inputs);
    expect(report).toEqual({
      ownerOperatorId: "op-owner",
      cashierOperatorId: "op-cashier",
      productIds: Array.from({ length: 22 }, (_, i) => `prod-${i + 1}`),
      photosSet: 22,
      categories: 8,
    });
    // Nothing credential-like leaves the module in its report.
    expect(JSON.stringify(report)).not.toContain(definition.owner.pin);
    expect(JSON.stringify(report)).not.toContain(definition.cashier.pin);
    const order = calls.map((c) => c.port);
    expect(order.slice(0, 4)).toEqual(["completeOwnerSetup", "completeCashierSetup", "saveCompanyProfile", "importCatalogCsv"]);
    expect(order.filter((p) => p === "ensureCategory")).toHaveLength(8);
    expect(order.filter((p) => p === "updateProductDetails")).toHaveLength(22);
    expect(order.filter((p) => p === "setProductImageFromFixture")).toHaveLength(22);
    expect(calls.find((c) => c.port === "saveCompanyProfile")!.args[1]).toBe("fixture");
  });

  it("P4 — only `<SKU>.jpg` names from the manifest cross the image port: never a path", async () => {
    const { ports, calls } = fakePorts();
    await seedDemoLedger(ports, inputs);
    const names = calls.filter((c) => c.port === "setProductImageFromFixture").map((c) => c.args[1] as string);
    expect(names).toHaveLength(22);
    for (const n of names) {
      expect(n).toMatch(DEMO_IMAGE_NAME);
      expect(n).not.toMatch(/[\\/:]|\.\./);
    }
    expect(new Set(names)).toEqual(new Set(definition.skus.map((s) => `${s}.jpg`)));
  });

  it("P4 — a SKU that would form a path or a non-manifest name is refused BEFORE any port is called", async () => {
    const manifest = fixtureImageManifest(fixture);
    expect(stageOf(() => demoImageName("../evil", manifest))).toBe("image-name");
    expect(stageOf(() => demoImageName("cof-esp", manifest))).toBe("image-name");
    expect(stageOf(() => demoImageName("ZZZ-1", manifest))).toBe("image-manifest");
    const evil = { ...fixture, products: fixture.products.map((p) => (p.sku === "COF-ESP" ? { ...p, sku: "COF-ESP/../X" } : p)) };
    const evilDef = { ...definition, skus: definition.skus.map((s) => (s === "COF-ESP" ? "COF-ESP/../X" : s)) };
    const { ports, calls } = fakePorts();
    await expect(seedDemoLedger(ports, { definition: evilDef, fixture: evil, catalogCsv })).rejects.toThrow(DemoSeedError);
    expect(calls).toHaveLength(0);
  });

  it.each<[keyof DemoSeedPorts, number | undefined]>([
    ["completeOwnerSetup", undefined],
    ["completeCashierSetup", undefined],
    ["saveCompanyProfile", undefined],
    ["importCatalogCsv", undefined],
    ["ensureCategory", 3],
    ["updateProductDetails", 7],
    ["setProductImageFromFixture", 22],
  ])("P3 — %s failing (call %s) stops the seed: DemoSeedError, nothing after it, no report", async (port, n) => {
    const { ports, calls } = fakePorts({ failAt: port, failOnCall: n });
    await expect(seedDemoLedger(ports, inputs)).rejects.toThrow(DemoSeedError);
    const last = calls[calls.length - 1]!;
    expect(last.port).toBe(port);
  });

  it("refuses an import that returns the wrong number of IDs, or duplicates", async () => {
    expect(await stageOfAsync(() => seedDemoLedger(fakePorts({ importIds: (n) => Array.from({ length: n - 1 }, (_, i) => `p${i}`) }).ports, inputs))).toBe("import-ids");
    await expect(seedDemoLedger(fakePorts({ importIds: (n) => Array.from({ length: n }, () => "same") }).ports, inputs)).rejects.toThrow(DemoSeedError);
  });

  it("refuses when owner and cashier come back as the same operator", async () => {
    const { ports } = fakePorts();
    const same: DemoSeedPorts = { ...ports, completeCashierSetup: async () => ({ operatorId: "op-owner" }) };
    expect(await stageOfAsync(() => seedDemoLedger(same, inputs))).toBe("operators-distinct");
  });
});

describe("C1-R3 — no raw port text, path, secret or rejected input ever leaves the seed", () => {
  const SENTINEL = "C:\Users\merchant\secret-ledger.sqlite pin=999999 token=sk-SENTINEL-42";
  const leaks = (e: unknown): string[] => {
    const err = e as DemoSeedError & Record<string, unknown>;
    const surfaces = [err.message, String(err), JSON.stringify(err), err.stack ?? "", JSON.stringify(Object.getOwnPropertyNames(err).map((k) => [k, String(err[k])]))];
    return surfaces.filter((t) => t.includes("SENTINEL") || t.includes("999999") || t.includes("secret-ledger") || t.includes("merchant"));
  };
  const PORT_STAGES: Array<[keyof DemoSeedPorts, string, number | undefined]> = [
    ["completeOwnerSetup", "owner-setup", undefined],
    ["completeCashierSetup", "cashier-setup", undefined],
    ["saveCompanyProfile", "company-profile", undefined],
    ["importCatalogCsv", "catalog-import", undefined],
    ["ensureCategory", "category", 2],
    ["updateProductDetails", "product-details", 5],
    ["setProductImageFromFixture", "product-photo", 9],
  ];

  it.each(PORT_STAGES)("%s throwing a sentinel → stage %s, neutral message, no `cause`, no leak", async (port, stage, n) => {
    const { ports } = fakePorts();
    let calls = 0;
    const sentinelPorts: DemoSeedPorts = {
      ...ports,
      [port]: async () => {
        calls++;
        if (n === undefined || calls === n) throw new Error(SENTINEL);
        return (ports[port] as (...a: unknown[]) => Promise<unknown>)("x", "y");
      },
    };
    let caught: unknown;
    try {
      await seedDemoLedger(sentinelPorts, inputs);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DemoSeedError);
    const err = caught as DemoSeedError;
    expect(err.stage).toBe(stage);
    expect(err.code).toBe("DEMO_SEED_FAILED");
    expect(err.message).toBe(`Demo seed failed (${stage}).`);
    expect("cause" in err).toBe(false);
    expect(leaks(err)).toEqual([]);
  });

  it("a non-Error rejection (a bare string with a path) is dropped the same way", async () => {
    const { ports } = fakePorts();
    const bad: DemoSeedPorts = { ...ports, importCatalogCsv: () => Promise.reject(SENTINEL) };
    const stage = await stageOfAsync(() => seedDemoLedger(bad, inputs));
    expect(stage).toBe("catalog-import");
  });

  it("rejected INPUT values (an unknown SKU carrying a path) are not echoed either", () => {
    const evil = { ...definition, skus: [...definition.skus.slice(1), "C:\Users\merchant\SENTINEL"] };
    let caught: unknown;
    try {
      selectDemoProducts(evil, fixture);
    } catch (e) {
      caught = e;
    }
    expect((caught as DemoSeedError).stage).toBe("definition-sku-unknown");
    expect(leaks(caught)).toEqual([]);
  });

  it("the error carries only fixed fields: name, message, stack, code, stage", () => {
    const err = new DemoSeedError("catalog-import");
    expect(Object.getOwnPropertyNames(err).sort()).toEqual(["code", "message", "name", "stack", "stage"]);
    expect(err.name).toBe("DemoSeedError");
  });
});

describe("the seed module has no authority of its own", () => {
  it("imports NOTHING — no Electron, fs, path, dialog or IPC (parsed from the source, not grepped)", () => {
    const file = join(ROOT, "src", "main", "demoSeed.ts");
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const imports = sf.statements.filter((s) => ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s));
    const requires: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === "require") requires.push(n.getText(sf));
      if (n.kind === ts.SyntaxKind.ImportKeyword && ts.isCallExpression(n.parent)) requires.push(n.parent.getText(sf));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(imports.map((s) => s.getText(sf))).toEqual([]);
    expect(requires).toEqual([]);
  });
});

describe("the pinned media manifest (BR-C-05 V3 §2 — what main's media check verifies against)", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "resources", "demo", "demo-media-manifest.json"), "utf8")) as {
    media: Array<{ sku: string; file: string; sha256: string; bytes: number; sourcePage: string; licence: string }>;
  };

  it("lists exactly the 22 demo SKUs, in the definition's order, one entry each", () => {
    expect(manifest.media.map((m) => m.sku)).toEqual(definition.skus);
    expect(new Set(manifest.media.map((m) => m.file)).size).toBe(22);
  });

  it("every hash, size and credit is re-derived from the shipped files — any drift fails here", () => {
    for (const m of manifest.media) {
      expect(m.file).toBe(`${m.sku}.jpg`);
      expect(m.file).toMatch(DEMO_IMAGE_NAME);
      const bytes = readFileSync(join(FIXTURE_DIR, "images", m.file));
      expect(createHash("sha256").update(bytes).digest("hex"), m.sku).toBe(m.sha256);
      expect(bytes.length).toBe(m.bytes);
      expect(m.sourcePage).toBe(credits[m.sku]!.source_page);
      expect(m.licence).toBe(credits[m.sku]!.licence);
      expect(["CC0", "Public domain"]).toContain(m.licence);
    }
  });

  it("each product's image is its OWN: no two SKUs share a hash (association by identity, never by position)", () => {
    expect(new Set(manifest.media.map((m) => m.sha256)).size).toBe(22);
  });
});
