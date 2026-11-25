import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSyntheticDemoRoot, reserveSyntheticDemoProfile, openNewSyntheticDemoLedger } from "../../src/main/demoProfile";
import { createSyntheticLogoVault } from "../../src/main/demoLogoVault";

const fixtures="C:/dev/alzabt-agent-collaboration/c2-demo-assets-staging-2026-11-18/config/demo-logo.png";
const expected="ce5f0cfbc9e5ad6a275c815b966f3d8b4a47b5c903f299addb2b6d9bdd648881";
function sample() {
  const parent=mkdtempSync(join(process.cwd(),"node_modules","synthetic-logo-vault-"));
  const reservation=reserveSyntheticDemoProfile(createSyntheticDemoRoot(parent));
  const db=openNewSyntheticDemoLedger(reservation);
  const dir=join(reservation.path,"branding");
  mkdirSync(dir);
  const bytes=readFileSync(fixtures);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
  writeFileSync(join(dir,"synthetic-demo-logo.png"),bytes,{flag:"wx"});
  return {db,dir,bytes};
}
it("freezes only the approved logo into its reserved profile and reuses matching bytes",()=>{
  const {db,dir,bytes}=sample();
  try{
    const vault=createSyntheticLogoVault(db);
    const name=expected.slice(0,32)+".png";
    expect(vault.freeze("synthetic-demo-logo.png")).toBe(name);
    expect(vault.freeze("synthetic-demo-logo.png")).toBe(name);
    expect(readFileSync(join(dir,"frozen",name))).toEqual(bytes);
    expect(vault.freeze("../synthetic-demo-logo.png")).toBeNull();
    expect(vault.freeze("other.png")).toBeNull();
  } finally {db.close();}
});
it("refuses a forged Db and a tampered source image",()=>{
  const db=new Database(":memory:");
  expect(createSyntheticLogoVault(db).freeze("synthetic-demo-logo.png")).toBeNull();
  db.close();
  const sampleDb=sample();
  try{
    writeFileSync(join(sampleDb.dir,"synthetic-demo-logo.png"),Buffer.from("invalid"));
    expect(createSyntheticLogoVault(sampleDb.db).freeze("synthetic-demo-logo.png")).toBeNull();
  } finally {sampleDb.db.close();}
});
it("does not accept an existing frozen file with wrong bytes",()=>{
  const {db,dir}=sample();
  try{
    const frozen=join(dir,"frozen");
    mkdirSync(frozen);
    writeFileSync(join(frozen,expected.slice(0,32)+".png"),Buffer.from("invalid"));
    expect(createSyntheticLogoVault(db).freeze("synthetic-demo-logo.png")).toBeNull();
    expect(readFileSync(join(frozen,expected.slice(0,32)+".png"),"utf8")).toBe("invalid");
  } finally {db.close();}
});
