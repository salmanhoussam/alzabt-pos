/**
 * Synthetic-only logo vault on the exact reserved Db profile.
 * This is not evidence against Windows path substitution (O-2).
 */
import { SYNTHETIC_DEMO_LOGO } from "./demoConstants";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../persistence/db";
import type { LogoVault } from "../application/invoiceService";
import { syntheticLedgerProfile } from "./demoProfile";

const NAME = SYNTHETIC_DEMO_LOGO;
const EXPECTED = "ce5f0cfbc9e5ad6a275c815b966f3d8b4a47b5c903f299addb2b6d9bdd648881";
const sha = (b:Buffer):string => createHash("sha256").update(b).digest("hex");
function regular(path:string):boolean {
  const stat=lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}
export function createSyntheticLogoVault(db:Db):LogoVault {
  return Object.freeze({
    freeze: (storedName:string):string|null => {
      try {
        if (storedName!==NAME) return null;
        const brand=join(syntheticLedgerProfile(db),"branding");
        const brandStat=lstatSync(brand);
        if(!brandStat.isDirectory() || brandStat.isSymbolicLink()) return null;
        const source=join(brand,NAME);
        if(!regular(source)) return null;
        const bytes=readFileSync(source);
        if(sha(bytes)!==EXPECTED) return null;
        const frozen=join(brand,"frozen");
        try { mkdirSync(frozen); } catch(e) {
          if((e as NodeJS.ErrnoException).code!=="EEXIST") return null;
        }
        const dirStat=lstatSync(frozen);
        if(!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
        const name=EXPECTED.slice(0,32)+".png";
        const target=join(frozen,name);
        if(!existsSync(target)) {
          try { writeFileSync(target,bytes,{flag:"wx"}); } catch(e) {
            if((e as NodeJS.ErrnoException).code!=="EEXIST") return null;
          }
        }
        if(!regular(target) || sha(readFileSync(target))!==EXPECTED) return null;
        return name;
      } catch { return null; }
    },
  });
}

/** Read only the exact pinned synthetic frozen asset; never accept arbitrary paths. */
export function readSyntheticFrozenLogo(db:Db,storedName:string|null):Buffer|null {
  try {
    if(storedName!==EXPECTED.slice(0,32)+".png")return null;
    const brand=join(syntheticLedgerProfile(db),"branding");
    const frozen=join(brand,"frozen");
    for(const dir of [brand,frozen]){
      const stat=lstatSync(dir);
      if(stat.isSymbolicLink() || !stat.isDirectory())return null;
    }
    const file=join(frozen,storedName);
    if(!regular(file))return null;
    const bytes=readFileSync(file);
    return sha(bytes)===EXPECTED?bytes:null;
  } catch{return null}
}
