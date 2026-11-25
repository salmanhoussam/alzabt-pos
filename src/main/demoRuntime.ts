/**
 * Internal development runtime steps, not wired to Main startup or renderer.
 * Caller must not fall back to a real profile after any selection failure.
 * The account gate / V8 record verification are prerequisites, not O-2 proof.
 */
import {app,session} from "electron";
import {join,resolve} from "node:path";
import {claimVerifiedDemoStart,type VerifiedDemoStart} from "./demoHandoverStartup";
import {pendingSyntheticReservationPath,type SyntheticDemoReservation} from "./demoProfile";
import {installSyntheticRendererBlocker} from "./demoRendererPolicy";
import {loadSyntheticDemoAssets} from "./demoAssets";
import {startReservedSyntheticDemo} from "./demoSyntheticStartup";

declare const selectedBrand:unique symbol;
export interface SelectedDemoStart {readonly [selectedBrand]:true}
const selected=new WeakMap<SelectedDemoStart,{reservation:SyntheticDemoReservation;path:string}>();
function same(a:string,b:string):boolean {
  const x=resolve(a),y=resolve(b);
  return process.platform==="win32"?x.toLowerCase()===y.toLowerCase():x===y;
}
/** Must execute after the product lock but before app.whenReady/renderer/Db. */
export function selectVerifiedDemoProfile(proof:VerifiedDemoStart):SelectedDemoStart {
  if(app.isPackaged || !app.hasSingleInstanceLock() || app.isReady())throw Error("Synthetic demo unavailable.");
  const reservation=claimVerifiedDemoStart(proof);
  if(!reservation)throw Error("Synthetic demo unavailable.");
  const path=pendingSyntheticReservationPath(reservation);
  try {
    app.setPath("userData",path);
    app.setPath("sessionData",path);
    if(!same(app.getPath("userData"),path) || !same(app.getPath("sessionData"),path))throw Error("path mismatch");
    const token=Object.freeze({}) as SelectedDemoStart;
    selected.set(token,{reservation,path});
    return token;
  } catch {throw Error("Synthetic demo unavailable.")}
}
/** Called once after app.whenReady, before any window or session permission. */
export function startSelectedSyntheticDemo(token:SelectedDemoStart) {
  const state=selected.get(token);
  if(!state)throw Error("Synthetic demo unavailable.");
  selected.delete(token);
  if(app.isPackaged || !app.hasSingleInstanceLock() || !app.isReady() ||
     !same(app.getPath("userData"),state.path) || !same(app.getPath("sessionData"),state.path))
    throw Error("Synthetic demo unavailable.");
  installSyntheticSessionRestrictions();
  // No restore, daily backup, phone service, autostart, file-picker or print ports.
  return startReservedSyntheticDemo(state.reservation,loadSyntheticDemoAssets());
}

/** Reapply before any unavailable window if bootstrap failed before installation. */
export function installSyntheticSessionRestrictions():void {
  if(app.isPackaged || !app.hasSingleInstanceLock() || !app.isReady())throw Error("Synthetic demo unavailable.");
  const active=session.defaultSession;
  installSyntheticRendererBlocker(active.webRequest,join(__dirname,"..","..","renderer"));
  active.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  active.setPermissionCheckHandler(()=>false);
  active.setDevicePermissionHandler(()=>false);
  active.on("will-download",(event)=>event.preventDefault());
}
