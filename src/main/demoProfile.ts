/**
 * Synthetic demo profile reservation primitive. Main must select a trusted,
 * synthetic-only parent before calling; paths or markers do not confer Demo
 * authority. No renderer input, app startup, database or session is wired here.
 *
 * Five fixed slots are reserved with exclusive mkdir. Reservations are never
 * removed automatically, including partial failures/crashes. Parent-path
 * checks do NOT solve same-user junction substitution (O-2).
 */
import { randomBytes } from "node:crypto";
import { claimVerifiedDemoLaunch, type VerifiedDemoLaunch } from "./demoLaunchRecords";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { openDatabase, type Db } from "../persistence/db";
import { LEDGER_FILE_NAME } from "./ledgerGuard";
import { isAbsolute, join, parse, resolve } from "node:path";

const ROOT_MARKER = ".alzabt-synthetic-demo-root";
const ROOT_TAG = "alzabt-synthetic-demo-root-v1";
const PROFILE_MARKER = ".alzabt-synthetic-demo-profile";
const SLOT_NAME = /^slot-[1-5]$/;
const ROOT_NAME = "synthetic-demo-root-v1";
const PROFILE_NAME = /^profile-[a-f0-9]{32}$/;
export const MAX_RETAINED_DEMO_PROFILES = 5;

/** Process-local identity: a forged or deserialized object has no reservation. */
export interface SyntheticDemoReservation { readonly path: string; readonly slot: number }
const liveReservations = new WeakMap<SyntheticDemoReservation, { readonly path: string; claimed: boolean }>();
const freshSyntheticLedgers = new WeakSet<Db>();
const syntheticLedgerProfiles = new WeakMap<Db, string>();

export class DemoProfileError extends Error {
  constructor(readonly reason: "unavailable" | "limit") {
    super(reason === "limit" ? "Demo retention limit reached." : "Demo profile unavailable.");
    this.name = "DemoProfileError";
  }
}
function unavailable(): never { throw new DemoProfileError("unavailable"); }

/** Reject symlinks/junctions on existing components; O-2 race remains open. */
function checkPath(path: string): string {
  if (!isAbsolute(path)) return unavailable();
  const full = resolve(path);
  const root = parse(full).root;
  const parts = full.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return unavailable();
  }
  const canonical = realpathSync(full);
  if (process.platform === "win32" ? canonical.toLowerCase() !== full.toLowerCase() : canonical !== full) return unavailable();
  return full;
}
function randomName(prefix: string): string { return prefix + randomBytes(16).toString("hex"); }

/**
 * parent must be a main-selected fresh synthetic test parent. This creates a
 * root at a fixed name under its trusted parent. It never replaces an existing
 * root; no cleanup is performed on partial failure. Main must retain the same
 * trusted parent across restarts or the five-slot limit is not global.
 */
export function createSyntheticDemoRoot(parent: string): string {
  try {
    const safeParent = checkPath(parent);
    const root = join(safeParent, ROOT_NAME);
    mkdirSync(root);
    writeFileSync(join(root, ROOT_MARKER), ROOT_TAG, { encoding: "utf8", flag: "wx" });
    return root;
  } catch {
    throw new DemoProfileError("unavailable");
  }
}

/** Read-only retention hint; the atomic reservation remains authoritative. */
export function syntheticDemoRetention(root: string): { readonly retained: number; readonly max: 5; readonly reached: boolean } {
  try {
    const { retained } = inspectSyntheticRoot(root);
    return { retained, max: 5, reached: retained >= MAX_RETAINED_DEMO_PROFILES };
  } catch {
    throw new DemoProfileError("unavailable");
  }
}

function inspectSyntheticRoot(root: string): { readonly safeRoot: string; readonly retained: number } {
  const safeRoot = checkPath(root);
  if ((safeRoot.slice(parse(safeRoot).root.length).split(/[\\\\/]+/).pop() ?? "") !== ROOT_NAME) return unavailable();
  const marker = join(safeRoot, ROOT_MARKER);
  const markerStat = lstatSync(marker);
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || readFileSync(marker, "utf8") !== ROOT_TAG) return unavailable();
  let retained = 0;
  for (const entry of readdirSync(safeRoot, { withFileTypes: true })) {
    if (entry.name === ROOT_MARKER) continue;
    if (!SLOT_NAME.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) return unavailable();
    retained++;
  }
  return { safeRoot, retained };
}

/**
 * Reserve one of five slots atomically across processes. Unknown root entries,
 * links, malformed marker and filesystem errors fail closed. A slot occupied
 * by an interrupted process remains occupied; no data is deleted or reused.
 */
export function reserveSyntheticDemoProfile(root: string): SyntheticDemoReservation {
  try {
    const { safeRoot } = inspectSyntheticRoot(root);
    for (let slot = 1; slot <= MAX_RETAINED_DEMO_PROFILES; slot++) {
      const slotPath = join(safeRoot, "slot-" + slot);
      try { mkdirSync(slotPath); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          const stat = lstatSync(slotPath);
          if (stat.isSymbolicLink() || !stat.isDirectory()) return unavailable();
          continue;
        }
        throw err;
      }
      const name = randomName("profile-");
      if (!PROFILE_NAME.test(name)) return unavailable();
      const profile = join(slotPath, name);
      mkdirSync(profile);
      writeFileSync(join(profile, PROFILE_MARKER), "alzabt-synthetic-profile-v1", { encoding: "utf8", flag: "wx" });
      const reservation = Object.freeze({ path: profile, slot });
      liveReservations.set(reservation, { path: profile, claimed: false });
      return reservation;
    }
    throw new DemoProfileError("limit");
  } catch (err) {
    if (err instanceof DemoProfileError) throw err;
    throw new DemoProfileError("unavailable");
  }
}

/**
 * Only an opaque reservation created by this process can initialize a ledger.
 * Exclusively create the file first; do not reopen an existing ledger. Uses
 * only existing app migrations. The caller MUST have established a safe,
 * synthetic-only parent. No marker or JS capability solves O-2.
 */
export function openNewSyntheticDemoLedger(reservation: SyntheticDemoReservation): Db {
  const state = liveReservations.get(reservation);
  if (!state || state.claimed) return unavailable();
  state.claimed = true; // one attempt, including failure; keep the reservation.
  try {
    const profile = checkPath(state.path);
    const marker = join(profile, PROFILE_MARKER);
    const markerStat = lstatSync(marker);
    if (markerStat.isSymbolicLink() || !markerStat.isFile() ||
      readFileSync(marker, "utf8") !== "alzabt-synthetic-profile-v1") return unavailable();
    const ledger = join(profile, LEDGER_FILE_NAME);
    const fd = openSync(ledger, "wx");
    closeSync(fd);
    const db = openDatabase(ledger, undefined, { fileMustExist: true });
    freshSyntheticLedgers.add(db);
    syntheticLedgerProfiles.set(db, profile);
    return db;
  } catch {
    throw new DemoProfileError("unavailable");
  }
}

/**
 * EPHEMERAL DEMO (owner decision 2026-11-25): a Demo shop that lives ONLY in memory.
 *
 * `:memory:` — no ledger file, no -wal / -journal (SQLite reports journal_mode "memory"), nothing to back up or
 * recover. The same migrations and the same validated services run on it as on a real ledger. It is registered as a
 * FRESH synthetic ledger so the existing seed safeguards (one consumer, branding binding) apply unchanged.
 *
 * `brandingParent` is the session folder that receives ONLY the synthetic logo copy (the logo vault reads files);
 * it must be a new, private, synthetic-only folder chosen by Main. No business data is ever written there.
 */
export function openEphemeralSyntheticDemoLedger(brandingParent: string): Db {
  const parent = checkPath(brandingParent);
  const db = openDatabase(":memory:");
  try {
    const mode = String(db.pragma("journal_mode", { simple: true })).toLowerCase();
    if (db.memory !== true || mode !== "memory") throw new Error("not in memory");
  } catch {
    db.close();
    throw new DemoProfileError("unavailable");
  }
  freshSyntheticLedgers.add(db);
  syntheticLedgerProfiles.set(db, parent);
  return db;
}

/**
 * One Main-private consumer can claim a newly opened synthetic ledger for
 * account setup. This object identity is not profile authority by itself; Main
 * still must prove its synthetic-only parent and preconditions before calling.
 */
export function consumeFreshSyntheticLedgerForSeed(db: Db): void {
  if (!freshSyntheticLedgers.has(db) || !db.open) return unavailable();
  freshSyntheticLedgers.delete(db);
}

/** Only a Db opened by the fresh-reservation factory has a profile binding. */
export function syntheticLedgerProfile(db: Db): string {
  const profile = syntheticLedgerProfiles.get(db);
  if (!profile || !db.open) return unavailable();
  return checkPath(profile); // no protection against O-2 substitutions
}

/**
 * Read-only freshness check for a signed handover. No marker alone grants
 * authority: Main must also verify/consume V8 records while holding the lock.
 * Windows same-user junction substitution remains O-2.
 */
export function isFreshSyntheticReservation(root:string, id:string):boolean {
  try {
    if(!new RegExp("^slot-[1-5]/profile-[a-f0-9]{32}$").test(id)) return false;
    const {safeRoot}=inspectSyntheticRoot(root);
    const [slot,name]=id.split("/");
    if(!slot || !name) return false;
    const slotPath=checkPath(join(safeRoot,slot));
    const children=readdirSync(slotPath,{withFileTypes:true});
    if(children.length!==1 || children[0]!.name!==name ||
       !children[0]!.isDirectory() || children[0]!.isSymbolicLink())return false;
    const profile=checkPath(join(slotPath,name));
    const entries=readdirSync(profile,{withFileTypes:true});
    if(entries.length!==1 || entries[0]!.name!==PROFILE_MARKER ||
       !entries[0]!.isFile() || entries[0]!.isSymbolicLink())return false;
    return readFileSync(join(profile,PROFILE_MARKER),"utf8")==="alzabt-synthetic-profile-v1";
  } catch {return false}
}

/** Main-only reconstitution from a consumed, process-local V8 proof. */
export function adoptVerifiedSyntheticReservation(root:string, proof:VerifiedDemoLaunch):
  {reservation:SyntheticDemoReservation;action:"enter"|"reset"} {
  const claimed=claimVerifiedDemoLaunch(proof,(id)=>isFreshSyntheticReservation(root,id));
  if(!claimed)return unavailable();
  const [slotPart,name]=claimed.reservationId.split("/");
  if(!slotPart || !name)return unavailable();
  const path=checkPath(join(root,slotPart,name));
  const slot=Number(slotPart.slice(5));
  const reservation=Object.freeze({path,slot});
  liveReservations.set(reservation,{path,claimed:false});
  return {reservation,action:claimed.action};
}

/** Checks an unclaimed reservation without opening its database. */
export function pendingSyntheticReservationPath(reservation:SyntheticDemoReservation):string {
  const state=liveReservations.get(reservation);
  if(!state || state.claimed)return unavailable();
  const profile=checkPath(state.path);
  const marker=join(profile,PROFILE_MARKER);
  const stat=lstatSync(marker);
  if(stat.isSymbolicLink() || !stat.isFile() ||
     readFileSync(marker,"utf8")!=="alzabt-synthetic-profile-v1")return unavailable();
  return profile;
}

/**
 * OWNER PREVIEW first start: the preview's own synthetic storage under a verified parent (LocalAppData).
 *
 * ROOT CAUSE of hosted run 45698905020 (2026-11-25): the first version created `synthetic-demo-root-v1` with a bare
 * mkdir, so it lacked the root marker that `inspectSyntheticRoot` requires — every fresh machine refused at startup
 * («synthetic handover unavailable»). The root is now created ONLY through `createSyntheticDemoRoot`, which writes the
 * marker exclusively. An EXISTING root is never repaired: without its marker it stays refused (fail closed).
 * Each level is created non-recursively and every existing component is checked for links.
 */
export function ensurePreviewSyntheticStorage(parent: string, baseName: string): { readonly base: string; readonly root: string; readonly control: string } {
  try {
    const safeParent = checkPath(parent);
    const base = join(safeParent, baseName);
    try { mkdirSync(base); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    const safeBase = checkPath(base);
    const root = join(safeBase, ROOT_NAME);
    let rootExists = true;
    try { lstatSync(root); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") rootExists = false; else throw err; }
    if (!rootExists) createSyntheticDemoRoot(safeBase);
    inspectSyntheticRoot(root); // marker + layout, whether just created or pre-existing
    const control = join(safeBase, "control");
    try { mkdirSync(control); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    return { base: safeBase, root: checkPath(root), control: checkPath(control) };
  } catch {
    throw new DemoProfileError("unavailable");
  }
}
