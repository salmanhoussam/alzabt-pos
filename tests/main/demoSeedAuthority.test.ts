import Database from "better-sqlite3";
import { createHash, randomBytes, randomInt, scryptSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SCRYPT } from "../../src/application/cashierAuth";
import { assertValidPin } from "../../src/domain/pinRule";
import { createSyntheticDemoRoot, openNewSyntheticDemoLedger, reserveSyntheticDemoProfile } from "../../src/main/demoProfile";
import { createSyntheticSeedAssembly } from "../../src/main/demoSeedAssembly";
import { createLedgerServices } from "../../src/main/ledgerServices";
import { emptyCatalog } from "../../src/domain/catalog";
import { FIXTURE_TERMINAL } from "../../src/fixtures/terminal";
import { claimSyntheticSeedAuthority, createSyntheticAccountSetup, type SyntheticSeedAuthority } from "../../src/main/demoSeedAccounts";
import { OperatorRepository } from "../../src/persistence/operatorRepository";
import { CatalogRepository } from "../../src/persistence/catalogRepository";
import { ProductImageRepository } from "../../src/persistence/productImageRepository";
import { verifyDemoImportedIdentities } from "../../src/main/demoSeedIdentity";

const root = mkdtempSync(join(process.cwd(), "node_modules", "synthetic-authority-test-"));
function pin(): string {
  for (;;) {
    const p = String(randomInt(100000, 1000000));
    try { assertValidPin(p); return p; } catch { /* retry synthetic-only random PIN */ }
  }
}
function initialized() {
  const parent = mkdtempSync(join(root, "case-"));
  const db = openNewSyntheticDemoLedger(reserveSyntheticDemoProfile(createSyntheticDemoRoot(parent)));
  const repo = new OperatorRepository(db);
  const ownerBootstrap = pin();
  const cashierBootstrap = pin();
  const setBootstrap = (id:string, credential:string) => {
    const salt = randomBytes(8).toString("hex");
    repo.setPin(id, salt, scryptSync(credential, Buffer.from(salt, "hex"), 32, SCRYPT).toString("hex"), "2026-01-01", {mustResetPin:true});
  };
  setBootstrap("cashier-01", ownerBootstrap);
  setBootstrap("cashier-02", cashierBootstrap);
  const setup = createSyntheticAccountSetup(db, (id) => id === "cashier-01" ? ownerBootstrap : cashierBootstrap);
  const ownerFinal = pin();
  let cashierFinal = pin();
  while (cashierFinal === ownerFinal) cashierFinal = pin();
  setup.completeOwner({name:"Synthetic owner", pin:ownerFinal});
  setup.completeCashier({name:"Synthetic cashier", pin:cashierFinal});
  return {db, repo, setup};
}

it("issues only after complete setup, rejects a forged token, and is single-use and revocable", () => {
  const {db, setup} = initialized();
  try {
    expect(() => claimSyntheticSeedAuthority({} as SyntheticSeedAuthority, db)).toThrow();
    const token = setup.takeSeedAuthority();
    const guard = claimSyntheticSeedAuthority(token, db);
    expect(guard.verifyOwner()).toMatchObject({id:"cashier-01",role:"owner"});
    expect(() => claimSyntheticSeedAuthority(token, db)).toThrow();
    expect(() => guard.verifyOwner()).toThrow();
    guard.revoke();
    expect(() => guard.verifyOwner()).toThrow();
    expect(() => claimSyntheticSeedAuthority(token, db)).toThrow();
  } finally {if(db.open) db.close();}
});

it("refuses a token bound to a different Db and consumes the attempted token", () => {
  const {db, setup} = initialized();
  const wrong = new Database(":memory:");
  try {
    const token = setup.takeSeedAuthority();
    expect(() => claimSyntheticSeedAuthority(token, wrong)).toThrow();
    expect(() => claimSyntheticSeedAuthority(token, db)).toThrow();
    expect(wrong.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({n:0});
  } finally {wrong.close(); if(db.open) db.close();}
});

it("revalidates the owner each time and revokes after deactivation", () => {
  const {db, repo, setup} = initialized();
  try {
    const guard = claimSyntheticSeedAuthority(setup.takeSeedAuthority(), db);
    expect(guard.verifyOwner().role).toBe("owner");
    repo.setActive("cashier-01", false, "2026-01-02T00:00:00.000Z");
    expect(() => guard.verifyOwner()).toThrow();
    repo.setActive("cashier-01", true, "2026-01-02T00:00:01.000Z");
    expect(() => guard.verifyOwner()).toThrow();
  } finally {if(db.open) db.close();}
});

it("revokes after the owner is demoted", () => {
  const {db, repo, setup} = initialized();
  try {
    const guard = claimSyntheticSeedAuthority(setup.takeSeedAuthority(), db);
    repo.setRole("cashier-02", "owner", "2026-01-02T00:00:00.000Z");
    repo.setRole("cashier-01", "cashier", "2026-01-02T00:00:01.000Z");
    expect(() => guard.verifyOwner()).toThrow();
    repo.setRole("cashier-01", "owner", "2026-01-02T00:00:02.000Z");
    expect(() => guard.verifyOwner()).toThrow();
  } finally {if(db.open) db.close();}
});

it("cannot obtain authority after partial setup and cannot retry that ledger", () => {
  const parent = mkdtempSync(join(root, "partial-"));
  const db = openNewSyntheticDemoLedger(reserveSyntheticDemoProfile(createSyntheticDemoRoot(parent)));
  const setup = createSyntheticAccountSetup(db, () => "bad");
  expect(() => setup.takeSeedAuthority()).toThrow();
  expect(db.open).toBe(false);
  expect(() => createSyntheticAccountSetup(db, () => "bad")).toThrow();
});

it("assembles normal services only on the claimed synthetic Db with no authenticated session", () => {
  const {db, setup} = initialized();
  try {
    const token = setup.takeSeedAuthority();
    const assembly = createSyntheticSeedAssembly(token, db);
    expect(Object.keys(assembly).sort()).toEqual(["cancel", "createCategory", "finish", "importCatalogCsv", "saveCompanyProfile", "setProductPrimaryImage", "updateProduct"].sort());
    expect("services" in assembly).toBe(false);
    expect("guard" in assembly).toBe(false);
    expect((db.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:bigint}).n).toBe(0n);
    expect(() => createSyntheticSeedAssembly(token, db)).toThrow();
    assembly.cancel();
    expect(db.open).toBe(false);
    expect(() => createSyntheticSeedAssembly(token, db)).toThrow();
  } finally {if(db.open) db.close();}
});

it("refuses assembly against a different Db and does not write either ledger", () => {
  const {db, setup} = initialized();
  const wrong = new Database(":memory:");
  try {
    const token = setup.takeSeedAuthority();
    expect(() => createSyntheticSeedAssembly(token, wrong)).toThrow();
    expect(() => createSyntheticSeedAssembly(token, db)).toThrow();
    expect(wrong.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({n:0});
    expect((db.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:bigint}).n).toBe(0n);
  } finally {wrong.close(); if(db.open) db.close();}
});

it("revokes the authority even if a failed owner recheck rolls back its transaction", () => {
  const {db, repo, setup} = initialized();
  try {
    const guard = claimSyntheticSeedAuthority(setup.takeSeedAuthority(), db);
    expect(() => db.transaction(() => {
      repo.setActive("cashier-01", false, "2026-01-02T00:00:00.000Z");
      guard.verifyOwner();
    }).immediate()).toThrow();
    expect(repo.findById("cashier-01")?.is_active).toBe(1);
    expect(() => guard.verifyOwner()).toThrow();
  } finally {if(db.open) db.close();}
});

it("uses the five shared operations on 22 synthetic source keys, 8 categories and 22 correctly associated placeholder blobs", () => {
  const {db, setup} = initialized();
  try {
    const writer = createSyntheticSeedAssembly(setup.takeSeedAuthority(), db);
    const keys = Array.from({length:22}, (_, i) => "seed-" + String(i + 1).padStart(2, "0"));
    const expected = keys.map((sourceId, i) => ({sourceId, sku:"SKU-" + String(i + 1).padStart(2, "0")})).reverse();
    const csv = new TextEncoder().encode(["source_id,name_ar,name_en,price,currency,base_unit,price_needs_review",
      ...keys.map((key, i) => key + ",Item " + (i+1) + ",English " + (i+1) + ",1.00,USD,piece,0")].join(String.fromCharCode(10)));
    writer.saveCompanyProfile({nameAr:"Synthetic shop"});
    const imported = writer.importCatalogCsv("synthetic.csv", csv);
    const ordered = verifyDemoImportedIdentities(csv, "USD", imported, expected, new CatalogRepository(db).listAll().reverse());
    expect(ordered.map((item) => item.sourceId)).toEqual(keys);
    const categories = Array.from({length:8}, (_, i) => writer.createCategory("Synthetic Category " + (i+1), null));
    const photos = new ProductImageRepository(db);
    for (const [i, item] of ordered.entries()) {
      const group = categories[i % categories.length]!;
      writer.updateProduct(item.productId, {nameAr:"Item " + (i+1), nameEn:"English " + (i+1), sku:item.sku, price:"1.00", baseUnit:"piece", master:{categoryId:group.id}}, true);
      // Opaque synthetic placeholder bytes. Real image decoding is a separate unmet gate.
      const bytes = Buffer.from("89504e470d0a1a0a" + (i+1).toString(16).padStart(2, "0").repeat(40), "hex");
      const image = writer.setProductPrimaryImage({productId:item.productId, bytes, mime:"image/png", widthPx:1, heightPx:1, origin:"desktop"});
      expect(image.product_id).toBe(item.productId);
      expect(image.sha256_hex).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(photos.readBytes(image.id)).toEqual(bytes);
      expect(new CatalogRepository(db).findById(item.productId)?.category_id).toBe(group.id);
    }
    expect((db.prepare("SELECT count(*) AS n FROM catalog_products").get() as {n:bigint}).n).toBe(22n);
    expect((db.prepare("SELECT count(*) AS n FROM catalog_product_images WHERE is_primary = 1").get() as {n:bigint}).n).toBe(22n);
    expect((db.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:bigint}).n).toBe(8n);
    const audit = db.prepare("SELECT DISTINCT actor_id, actor_tier FROM audit_events WHERE event_type IN ('CATALOG_IMPORTED','CATEGORY_CREATED','PRODUCT_UPDATED','PRODUCT_IMAGE_SET')").all();
    expect(audit.length).toBeGreaterThan(0);
    expect(audit).toEqual([{actor_id:"cashier-01", actor_tier:"owner"}]);
    expect("login" in writer).toBe(false);
    writer.cancel();
    expect(db.open).toBe(false);
    expect(() => writer.createCategory("After cancel", null)).toThrow();
  } finally {if(db.open) db.close();}
});

it("revokes the writer and closes the synthetic ledger on the first invalid write", () => {
  const {db, setup} = initialized();
  try {
    const writer = createSyntheticSeedAssembly(setup.takeSeedAuthority(), db);
    expect(() => writer.createCategory("", null)).toThrow("Synthetic demo seed operation failed.");
    expect(db.open).toBe(false);
    expect(() => writer.saveCompanyProfile({nameAr:"Must not write"})).toThrow();
    expect(() => writer.importCatalogCsv("anything.csv", new Uint8Array())).toThrow();
    expect(() => writer.createCategory("Must not write", null)).toThrow();
    expect(() => writer.updateProduct("x", {nameAr:"x", nameEn:null, sku:null, price:"1", baseUnit:"piece"}, true)).toThrow();
    expect(() => writer.setProductPrimaryImage({productId:"x", bytes:Buffer.from([1]), mime:"image/png", widthPx:1, heightPx:1, origin:"desktop"})).toThrow();
  } finally {if(db.open) db.close();}
});

it("revokes when the claimed owner row disappears", () => {
  const {db, setup} = initialized();
  try {
    const guard = claimSyntheticSeedAuthority(setup.takeSeedAuthority(), db);
    db.prepare("DELETE FROM operators WHERE id = ?").run("cashier-01");
    expect(() => guard.verifyOwner()).toThrow();
    expect(() => guard.verifyOwner()).toThrow();
  } finally {if(db.open) db.close();}
});

it("revokes when the terminal claim belongs to a different synthetic operator", () => {
  const {db, setup} = initialized();
  try {
    const guard = claimSyntheticSeedAuthority(setup.takeSeedAuthority(), db);
    db.prepare("UPDATE terminal_security_state SET claimed_by_operator_id = ? WHERE id = 'terminal'").run("cashier-02");
    expect(() => guard.verifyOwner()).toThrow();
    expect(() => guard.verifyOwner()).toThrow();
  } finally {if(db.open) db.close();}
});

it("revokes and closes on rejected seed catalog", () => {
  const {db, setup} = initialized();
  try {
    const writer = createSyntheticSeedAssembly(setup.takeSeedAuthority(), db);
    expect(() => writer.importCatalogCsv("synthetic.csv", new TextEncoder().encode("bad"))).toThrow();
    expect(db.open).toBe(false);
    expect(() => writer.createCategory("Must refuse", null)).toThrow();
  } finally {if(db.open) db.close();}
});

it("never opens a seed-instance session and does not expose seed writes in normal composition", () => {
  const {db, setup} = initialized();
  try {
    const guard = claimSyntheticSeedAuthority(setup.takeSeedAuthority(), db);
    const catalog = emptyCatalog(FIXTURE_TERMINAL.currency);
    const ports = {catalog, fallbackCatalog:catalog, appVersion:"test", logoVault:{freeze:() => null},
      isCurrentLedger:() => db.open, assertOpen:() => {}, audit:() => {}};
    const seed = createLedgerServices(db, {...ports, seedActor:guard});
    expect(() => seed.service.login("cashier-01", "invalid")).toThrow("Seed instance cannot sign in");
    expect(() => seed.service.completeBootstrapSetup("invalid", "x", "invalid")).toThrow("Seed instance cannot sign in");
    expect(seed.service.currentCashier()).toBeNull();
    expect(seed.service.currentRole()).toBeNull();
    guard.revoke();
    expect(() => seed.service.login("cashier-01", "invalid")).toThrow("Seed instance cannot sign in");
    expect(() => seed.service.seedCreateCategory("Must refuse", null)).toThrow();
    const normal = createLedgerServices(db, ports);
    expect(() => normal.service.seedCreateCategory("Must refuse", null)).toThrow();
    expect(() => normal.invoices.seedSaveCompanyProfile({nameAr:"Must refuse"})).toThrow();
    expect((db.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:bigint}).n).toBe(0n);
  } finally {if(db.open) db.close();}
});

it("rolls back a seed business write when its audit insert fails and closes its synthetic ledger", () => {
  const {db, setup} = initialized();
  const ledgerPath = db.name;
  const beforeAudit = (db.prepare("SELECT count(*) AS n FROM audit_events").get() as {n:bigint}).n;
  const writer = createSyntheticSeedAssembly(setup.takeSeedAuthority(), db);
  // TEMP trigger exists only on this test connection and is not a migration.
  db.exec("CREATE TEMP TRIGGER seed_test_audit_abort BEFORE INSERT ON main.audit_events BEGIN SELECT RAISE(ABORT, 'synthetic audit fault'); END");
  expect(() => writer.createCategory("Synthetic rollback", null)).toThrow();
  expect(db.open).toBe(false);
  expect(() => writer.createCategory("Synthetic after failure", null)).toThrow();
  const readOnly = new Database(ledgerPath, {readonly:true, fileMustExist:true});
  try {
    expect((readOnly.prepare("SELECT count(*) AS n FROM catalog_categories").get() as {n:number}).n).toBe(0);
    expect(BigInt((readOnly.prepare("SELECT count(*) AS n FROM audit_events").get() as {n:number}).n)).toBe(beforeAudit);
  } finally {readOnly.close();}
});

it("rejects an incomplete seed before normal services or a session, closes Db and refuses retry", () => {
  const {db, setup} = initialized();
  const writer = createSyntheticSeedAssembly(setup.takeSeedAuthority(), db);
  const bad = {csv:Buffer.from("bad"), mapping:Buffer.from("bad"), manifest:Buffer.from("bad"), profile:Buffer.from("bad"),
    sourceImage:() => Buffer.from("bad"), logoName:"synthetic.png",
    codec:{} as Parameters<typeof writer.finish>[0]["codec"]};
  expect(() => writer.finish(bad, "unused")).toThrow("Synthetic demo seed verification failed.");
  expect(db.open).toBe(false);
  expect(() => writer.finish(bad, "unused")).toThrow();
  expect(() => writer.createCategory("refused", null)).toThrow();
});
