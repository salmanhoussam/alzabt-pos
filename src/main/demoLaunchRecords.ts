/**
 * V8 Main-only launch-record primitive; NOT wired to startup or IPC.
 * Main must supply an already trusted, synthetic-only directory, hold the
 * product lock when consuming, and enforce the unpackaged test-account gate.
 * This code does not solve same-user substitution or memory inspection (O-2).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";

type Action = "enter" | "reset";
declare const verifiedBrand: unique symbol;
export interface VerifiedDemoLaunch { readonly [verifiedBrand]: true }
const verified = new WeakMap<VerifiedDemoLaunch,{reservationId:string;action:Action}>();
/** Consume a process-local proof once, and recheck freshness before profile adoption. */
export function claimVerifiedDemoLaunch(token:VerifiedDemoLaunch, fresh:(id:string)=>boolean):
  {reservationId:string;action:Action}|null {
  const value=verified.get(token);
  if(!value)return null;
  verified.delete(token);
  try{return fresh(value.reservationId)?value:null}catch{return null}
}
type Intent = {version:1;action:Action;reservationId:string;nonce:string;createdAt:number;expiresAt:number};
type Commit = {version:1;nonce:string;reservationId:string;action:Action;intentSha256:string;keyHash:string;committedAt:number};
const HEX=/^[a-f0-9]{64}$/;
const RESERVATION=/^slot-[1-5]\/profile-[a-f0-9]{32}$/;
const hash=(value:Uint8Array):string=>createHash("sha256").update(value).digest("hex");
const equal=(a:string,b:string):boolean=>HEX.test(a)&&HEX.test(b)&&timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));
const safeNumber=(x:unknown):x is number=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=0;
const exact=(o:unknown,keys:string[]):o is Record<string,unknown>=>
  !!o && typeof o==="object" && !Array.isArray(o) && Object.keys(o).sort().join("|")===keys.sort().join("|");
function trustedDir(dir:string):string {
  if(!isAbsolute(dir))throw Error("control unavailable");
  const full=resolve(dir);let cursor=parse(full).root;
  for(const part of full.slice(cursor.length).split(/[\\\\/]+/).filter(Boolean)) {
    cursor=join(cursor,part);const stat=lstatSync(cursor);
    if(stat.isSymbolicLink()||!stat.isDirectory())throw Error("control unavailable");
  }
  const real=realpathSync(full);
  if(process.platform==="win32"?real.toLowerCase()!==full.toLowerCase():real!==full)throw Error("control unavailable");
  return full;
}
function same(a:unknown,b:unknown):boolean {return JSON.stringify(a)===JSON.stringify(b)}
export class DemoLaunchRecords {
  private readonly root:string;
  constructor(dir:string) {this.root=trustedDir(dir)}
  private path(nonce:string,kind:"intent"|"commit",state:"tmp"|"pending"|"used"|"void"):string {
    if(!HEX.test(nonce))throw Error("invalid record");
    return join(this.root,kind+"-"+nonce+"."+state);
  }
  private write(nonce:string,kind:"intent"|"commit",bytes:Buffer):void {
    trustedDir(this.root);
    const temporary=this.path(nonce,kind,"tmp"), pending=this.path(nonce,kind,"pending");
    if(existsSync(pending)||existsSync(this.path(nonce,kind,"used"))||existsSync(this.path(nonce,kind,"void")))
      throw Error("record exists");
    const fd=openSync(temporary,"wx");
    try {writeFileSync(fd,bytes);fsyncSync(fd)} finally {closeSync(fd)}
    renameSync(temporary,pending);
  }
  private read(nonce:string,kind:"intent"|"commit",state:"pending"|"used"):Buffer {
    trustedDir(this.root);
    const file=this.path(nonce,kind,state);const stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error("invalid record");
    return readFileSync(file);
  }
  private invalidate(nonce:string):void {
    for(const kind of ["intent","commit"] as const) {
      try {
        const from=this.path(nonce,kind,"pending"),to=this.path(nonce,kind,"void");
        if(existsSync(from)&&!existsSync(to))renameSync(from,to);
      } catch { /* best effort only; never authority */ }
    }
  }
  /**
   * Persist intent and commit, flush and read back. Returns K only after C.
   * Failure preserves any reserved slot and never reports a handover.
   */
  prepare(action:Action,reservationId:string,now:number):{nonce:string;key:string} {
    if((action!=="enter"&&action!=="reset")||!RESERVATION.test(reservationId)||!safeNumber(now)||
       !Number.isSafeInteger(now+120000))throw Error("invalid handover");
    const nonce=randomBytes(32).toString("hex");
    try {
      const intent:Intent={version:1,action,reservationId,nonce,createdAt:now,expiresAt:now+120000};
      const intentBytes=Buffer.from(JSON.stringify(intent),"utf8");
      this.write(nonce,"intent",intentBytes);
      const key=randomBytes(32).toString("hex");
      const commit:Commit={version:1,nonce,reservationId,action,intentSha256:hash(intentBytes),
        keyHash:hash(Buffer.from(key,"hex")),committedAt:now};
      this.write(nonce,"commit",Buffer.from(JSON.stringify(commit),"utf8"));
      const rereadIntent=this.read(nonce,"intent","pending");
      const rereadCommit=this.read(nonce,"commit","pending");
      if(!rereadIntent.equals(intentBytes)||!same(JSON.parse(rereadCommit.toString("utf8")),commit))
        throw Error("commit not verified");
      return {nonce,key};
    } catch {
      this.invalidate(nonce);
      throw Error("Synthetic handover unavailable.");
    }
  }
  /**
   * Caller must already hold the app lock. Positive verification and
   * one-time rename/readback precede returning the opaque reservation id.
   */
  consume(nonce:string,key:string,now:number,isFreshReservation:(id:string)=>boolean):VerifiedDemoLaunch|null {
    try {
      if(!HEX.test(nonce)||!HEX.test(key)||!safeNumber(now))return null;
      const intentBytes=this.read(nonce,"intent","pending");
      const commitBytes=this.read(nonce,"commit","pending");
      const i:unknown=JSON.parse(intentBytes.toString("utf8"));
      const c:unknown=JSON.parse(commitBytes.toString("utf8"));
      if(!exact(i,["version","action","reservationId","nonce","createdAt","expiresAt"])||
         !exact(c,["version","nonce","reservationId","action","intentSha256","keyHash","committedAt"]))return null;
      if(i.version!==1||(i.action!=="enter"&&i.action!=="reset")||typeof i.reservationId!=="string"||
         !RESERVATION.test(i.reservationId)||i.nonce!==nonce||!safeNumber(i.createdAt)||!safeNumber(i.expiresAt)||
         i.expiresAt!==i.createdAt+120000||now<i.createdAt||now>i.expiresAt||
         c.version!==1||c.nonce!==nonce||c.reservationId!==i.reservationId||c.action!==i.action||
         typeof c.intentSha256!=="string"||!equal(c.intentSha256,hash(intentBytes))||
         typeof c.keyHash!=="string"||!equal(c.keyHash,hash(Buffer.from(key,"hex")))||
         !safeNumber(c.committedAt)||c.committedAt<i.createdAt||c.committedAt>i.expiresAt)return null;
      if(!isFreshReservation(i.reservationId))return null;
      for(const kind of ["intent","commit"] as const) {
        const used=this.path(nonce,kind,"used");
        if(existsSync(used))return null;
        renameSync(this.path(nonce,kind,"pending"),used);
      }
      if(!this.read(nonce,"intent","used").equals(intentBytes)||!this.read(nonce,"commit","used").equals(commitBytes))
        return null;
      const token=Object.freeze({}) as VerifiedDemoLaunch;
      verified.set(token,{reservationId:i.reservationId,action:i.action});
      return token;
    } catch {return null}
  }
}
