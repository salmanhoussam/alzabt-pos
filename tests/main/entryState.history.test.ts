import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { probeMerchantData } from "../../src/main/demoCatalog";
import { probeEntryData, readRealEntryState } from "../../src/main/entryState";

// Only a synthetic in-memory schema. No app migrations, disk profiles or merchant data.
describe("entry-state historical sales", () => {
  it("treats old fallback sales as usage while retaining the demo fallback decision", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE catalog_products (id TEXT); CREATE TABLE parties (id TEXT); CREATE TABLE invoices (id TEXT); CREATE TABLE sales (id TEXT); CREATE TABLE sale_lines (product_id TEXT)");
      const entry = () => readRealEntryState(() => false, () => probeEntryData(db));
      expect(entry().firstRunEligible).toBe(true);
      db.prepare("INSERT INTO sales VALUES (?)").run("synthetic-sale");
      db.prepare("INSERT INTO sale_lines VALUES (?)").run("prod-0001");
      expect(probeMerchantData(db, ["prod-0001"]).merchantSaleLines).toBe(0);
      expect(probeEntryData(db).merchantSaleLines).toBe(1);
      expect(entry().firstRunEligible).toBe(false);
      expect(entry()).toEqual({ profile: "real", terminalClaimed: false, firstRunEligible: false, demoAvailable: false });
    } finally { db.close(); }
  });

  it("counts a historical sale even if its line is unavailable or has no product id", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE catalog_products (id TEXT); CREATE TABLE parties (id TEXT); CREATE TABLE invoices (id TEXT); CREATE TABLE sales (id TEXT); CREATE TABLE sale_lines (product_id TEXT); INSERT INTO sales VALUES ('synthetic'); INSERT INTO sale_lines VALUES (NULL)");
      expect(readRealEntryState(() => false, () => probeEntryData(db)).firstRunEligible).toBe(false);
    } finally { db.close(); }
  });

  it("fails closed when a historical-sale count cannot be read", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE catalog_products (id TEXT); CREATE TABLE parties (id TEXT); CREATE TABLE invoices (id TEXT); CREATE TABLE sale_lines (product_id TEXT)");
      expect(readRealEntryState(() => false, () => probeEntryData(db)).firstRunEligible).toBe(false);
    } finally { db.close(); }
  });
});
