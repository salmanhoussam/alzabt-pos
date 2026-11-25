/** Unpackaged, Main-only synthetic entry for the dedicated Standard User.
 * O-2 path substitution remains OPEN. Never use this for merchant profiles. */
import {app} from "electron";
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from "node:fs";
import {join,parse,resolve} from "node:path";
import Database from "better-sqlite3";
import {MIGRATIONS} from "../persistence/migrations";
import {schemaVersion,verifyAppliedMigrations} from "../persistence/db";
import {syntheticGateRefusal,verifiedSyntheticTestHome} from "./demoDevGate";
import {ensurePreviewSyntheticStorage,syntheticDemoRetention} from "./demoProfile";
import {DemoLaunchRecords} from "./demoLaunchRecords";
import {LEDGER_FILE_NAME} from "./ledgerGuard";
import {isOwnerPreviewBuild,syntheticBuildAllowed,syntheticStorageName} from "./syntheticBuild";

function checkedDirectory(path:string):string {
  const full=resolve(path);let current=parse(full).root;
  for(const part of full.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
    current=join(current,part);const stat=lstatSync(current);
    if(stat.isSymbolicLink() || !stat.isDirectory())throw Error("Synthetic environment unavailable.");
  }
  if(realpathSync(full).toLowerCase()!==full.toLowerCase())throw Error("Synthetic environment unavailable.");
  return full;
}
export function openSyntheticDevEnvironment(prepareEntry=true) {
  if(!syntheticBuildAllowed() || !app.hasSingleInstanceLock() || app.isReady())throw Error("Synthetic environment unavailable.");
  const home=verifiedSyntheticTestHome(false,true);
  if(!home)throw Error(syntheticGateRefusal()??"gate:identity");
  // Development: these two directories were created by the owner-run disposable V8 probe; an absent or
  // unrecognised root is refused; no existing directory is reset.
  // OWNER PREVIEW: its OWN folder (never the development one, never a shop's), created on first start one level at
  // a time with a NON-recursive mkdir under the verified LocalAppData, then checked exactly like the development one.
  const local=join(home,"AppData","Local");
  const baseName=syntheticStorageName();
  // The root MUST come from createSyntheticDemoRoot (marker); see ensurePreviewSyntheticStorage (run 45698905020).
  if(isOwnerPreviewBuild()) {
    try {ensurePreviewSyntheticStorage(checkedDirectory(local),baseName)}
    catch {throw Error("gate:storage")}
  }
  const base=checkedDirectory(join(local,baseName));
  const root=checkedDirectory(join(base,"synthetic-demo-root-v1"));
  syntheticDemoRetention(root);
  const control=checkedDirectory(join(base,"control"));
  new DemoLaunchRecords(control);
  const entry=join(base,"synthetic-entry-v1"), marker=join(entry,".alzabt-synthetic-entry-v1");
  // A Demo handover must not open or create the separate entry ledger.
  if(prepareEntry) {
  if(!existsSync(entry)) {
    mkdirSync(entry);
    writeFileSync(marker,"alzabt-synthetic-entry-v1",{encoding:"utf8",flag:"wx"});
  }
  checkedDirectory(entry);
  const markerStat=lstatSync(marker);
  if(!markerStat.isFile() || markerStat.isSymbolicLink() || readFileSync(marker,"utf8")!=="alzabt-synthetic-entry-v1")
    throw Error("Synthetic environment unavailable.");
  const ledger=join(entry,LEDGER_FILE_NAME);
  if(existsSync(ledger)) {
    const stat=lstatSync(ledger);
    if(!stat.isFile() || stat.isSymbolicLink())throw Error("Synthetic environment unavailable.");
    const db=new Database(ledger,{readonly:true,fileMustExist:true});
    try {
      verifyAppliedMigrations(db,MIGRATIONS);
      if(schemaVersion(db)!==MIGRATIONS.length)throw Error("Synthetic entry migration refused.");
    } finally {db.close();}
  }
  }
  return Object.freeze({entry,root,control});
}