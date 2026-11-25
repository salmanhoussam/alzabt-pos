/**
 * Main-only handover consumer, not yet wired to Electron startup or IPC.
 * The gate is explicit, non-packaged and limited to alzabt-test. O-2 is OPEN.
 */
import {app} from "electron";
import {join} from "node:path";
import {verifiedSyntheticTestHome} from "./demoDevGate";
import {DemoLaunchRecords} from "./demoLaunchRecords";
import {adoptVerifiedSyntheticReservation,isFreshSyntheticReservation} from "./demoProfile";
import type {SyntheticDemoReservation} from "./demoProfile";

declare const readyBrand: unique symbol;
export interface VerifiedDemoStart {readonly [readyBrand]:true}
const ready=new WeakMap<VerifiedDemoStart,SyntheticDemoReservation>();
export type HandoverResolution =
  | {readonly kind:"real"}
  | {readonly kind:"ready";readonly proof:VerifiedDemoStart};
/** Internal one-shot claim; a plain renderer object has no corresponding proof. */
export function claimVerifiedDemoStart(proof:VerifiedDemoStart):SyntheticDemoReservation|null {
  const reservation=ready.get(proof);
  if(!reservation)return null;
  ready.delete(proof);
  return reservation;
}

/**
 * The Main caller supplies an explicit test-only request. Neither flag, arguments nor renderer data select a profile:
 * the reservation is determined by verified, consumed records under the fixed
 * test home. Electron's native lock must already belong to this process.
 */
export function resolveVerifiedSyntheticHandover(requested:boolean, nonce:string, key:string, now:number):HandoverResolution {
  if(app.isPackaged || !app.hasSingleInstanceLock())return {kind:"real"};
  const home=verifiedSyntheticTestHome(app.isPackaged,requested);
  if(!home)return {kind:"real"};
  const base=join(home,"AppData","Local","Alzabt-Synthetic-Development");
  const demoRoot=join(base,"synthetic-demo-root-v1");
  try {
    const records=new DemoLaunchRecords(join(base,"control"));
    const proof=records.consume(nonce,key,now,(id)=>isFreshSyntheticReservation(demoRoot,id));
    if(!proof)return {kind:"real"};
    const adopted=adoptVerifiedSyntheticReservation(demoRoot,proof);
    // Caller must claim the proof and set userData/sessionData BEFORE
    // invoking startReservedSyntheticDemo or creating a renderer/session.
    const startProof=Object.freeze({}) as VerifiedDemoStart;
    ready.set(startProof,adopted.reservation);
    return {kind:"ready",proof:startProof};
  } catch {return {kind:"real"}}
}
