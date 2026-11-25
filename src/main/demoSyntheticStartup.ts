/**
 * In-process synthetic bootstrap only. Not wired to Electron startup, IPC,
 * renderer, environment or launch arguments. A Main caller must first prove
 * that the opaque reservation belongs to an authorized synthetic environment.
 * The process-local reservation is NOT proof against Windows O-2 races.
 */
import { randomBytes, randomInt, scryptSync } from "node:crypto";
import { assertValidPin } from "../domain/pinRule";
import { SCRYPT } from "../application/cashierAuth";
import { OperatorRepository } from "../persistence/operatorRepository";
import { openEphemeralSyntheticDemoLedger, openNewSyntheticDemoLedger, type SyntheticDemoReservation } from "./demoProfile";
import type { Db } from "../persistence/db";
import { createSyntheticAccountSetup } from "./demoSeedAccounts";
import { bootstrapSyntheticSeed } from "./demoSeedBootstrap";

function newPin():string {
  for(let n=0;n<128;n++) {
    const pin=String(randomInt(100000,1000000));
    try { assertValidPin(pin); return pin; } catch { /* try a different synthetic PIN */ }
  }
  throw new Error("Synthetic credential generation failed.");
}
type SeedAssets = Omit<Parameters<typeof bootstrapSyntheticSeed>[2],"ownerPin">;

/** Uses one newly reserved ledger; no existing profile is opened or migrated. */
export function startReservedSyntheticDemo(reservation:SyntheticDemoReservation, assets:SeedAssets) {
  return seedFreshSyntheticDemo(openNewSyntheticDemoLedger(reservation), assets);
}

/**
 * EPHEMERAL DEMO (owner decision 2026-11-25): a brand-new in-memory shop on every start — the original 22 products,
 * photos, categories, stock and USD prices, seeded through the SAME validated paths. Nothing of it survives the
 * process: closing the app IS the reset.
 */
export function startEphemeralSyntheticDemo(brandingParent:string, assets:SeedAssets) {
  return seedFreshSyntheticDemo(openEphemeralSyntheticDemoLedger(brandingParent), assets);
}

/** The one seeding routine for a FRESH synthetic ledger, whichever storage it lives in. */
function seedFreshSyntheticDemo(db:Db, assets:SeedAssets) {
  try {
    const credentials = new Set<string>();
    const uniquePin=():string => {
      for(let n=0;n<128;n++) {
        const pin=newPin();
        if(!credentials.has(pin)){credentials.add(pin);return pin}
      }
      throw new Error("Synthetic credential generation failed.");
    };
    const ownerBootstrap=uniquePin();
    const cashierBootstrap=uniquePin();
    const ownerPin=uniquePin();
    const cashierPin=uniquePin();
    const store=new OperatorRepository(db);
    for(const [id,pin] of [["cashier-01",ownerBootstrap],["cashier-02",cashierBootstrap]] as const) {
      const salt=randomBytes(8).toString("hex");
      const hash=scryptSync(pin,Buffer.from(salt,"hex"),32,SCRYPT).toString("hex");
      store.setPin(id,salt,hash,new Date().toISOString(),{mustResetPin:true});
    }
    const setup=createSyntheticAccountSetup(db,(id)=>{
      if(id==="cashier-01")return ownerBootstrap;
      if(id==="cashier-02")return cashierBootstrap;
      throw new Error("Unexpected synthetic operator.");
    });
    setup.completeOwner({name:"Synthetic owner",pin:ownerPin});
    setup.completeCashier({name:"Synthetic cashier",pin:cashierPin});
    const services=bootstrapSyntheticSeed(db,setup.takeSeedAuthority(),{...assets,ownerPin});
    return {db,services};
  } catch (cause) {
    if(db.open)db.close();
    // Generic message for every caller; the underlying cause is kept for Main's log and for tests.
    throw new Error("Synthetic demo startup failed.", { cause });
  }
}
