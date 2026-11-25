/** Development-only Main adapter. Excluded from distributable artifacts. */
import {app,dialog,ipcMain,type BrowserWindow} from "electron";
import {basename} from "node:path";
import type {PosService} from "../application/posService";
import {disableDiagnostics} from "./diagnostics";
import {openSyntheticDevEnvironment} from "./demoDevEntry";
import {resolveVerifiedSyntheticHandover} from "./demoHandoverStartup";
import {selectVerifiedDemoProfile,type SelectedDemoStart} from "./demoRuntime";
import {DemoLifecycle,DemoRetentionLimit,createNativeDemoConfirmation} from "./demoLifecycle";
import {DemoProfileError,reserveSyntheticDemoProfile,syntheticDemoRetention} from "./demoProfile";
import {DemoLaunchRecords} from "./demoLaunchRecords";
import {journeyFlag} from "./demoJourneyProbe";
import {isOwnerPreviewBuild,syntheticBuildAllowed} from "./syntheticBuild";

type Environment=ReturnType<typeof openSyntheticDevEnvironment>;
export type SyntheticStartup = {kind:"ordinary"}|{kind:"refused"}|{kind:"selected";env:Environment;selected?:SelectedDemoStart};
/** Called only after obtaining the product lock and before any profile access. */
export function prepareSyntheticStartup(args:readonly string[]):SyntheticStartup {
  if(!syntheticBuildAllowed() || !app.hasSingleInstanceLock() || app.isReady())return {kind:"ordinary"};
  const flag="--alzabt-synthetic-handover";
  const positions=args.flatMap((arg,index)=>arg===flag?[index]:[]);
  // OWNER PREVIEW: the packaged preview IS the synthetic entry (no flag); if its identity gate refuses, the
  // preview refuses to start (kind "refused" -> exit) instead of opening an ordinary, real-looking ledger.
  const requested=positions.length>0 || args.includes("--alzabt-synthetic-dev") || isOwnerPreviewBuild();
  if(!requested)return {kind:"ordinary"};
  disableDiagnostics();
  try {
    let selected:SelectedDemoStart|undefined;
    if(positions.length===1) {
      const i=positions[0]!, nonce=args[i+1], key=args[i+2];
      if(nonce && key && /^[a-f0-9]{64}$/.test(nonce) && /^[a-f0-9]{64}$/.test(key)) {
        const result=resolveVerifiedSyntheticHandover(true,nonce,key,Date.now());
        if(result.kind==="ready")selected=selectVerifiedDemoProfile(result.proof);
      }
    }
    // V8 invalid or replayed handovers return to the real entry. In this
    // development build that entry is always the verified synthetic one.
    const env=openSyntheticDevEnvironment(!selected);
    if(!selected) {
      app.setPath("userData",env.entry);
      app.setPath("sessionData",env.entry);
      if(app.getPath("userData")!==env.entry || app.getPath("sessionData")!==env.entry)throw Error("Invalid entry");
    }
    return {kind:"selected",env,selected};
  } catch {return {kind:"refused"}}
}
export function registerSyntheticLifecycle(ports:{
  env:Environment; mode:"real"|"demo"; service:PosService|null;
  getWindow:()=>BrowserWindow|null; rendererUrl:string; closeLedger:()=>void;
}):void {
  if(!syntheticBuildAllowed() || !app.hasSingleInstanceLock())throw Error("Synthetic lifecycle unavailable");
  const {env,mode,service}=ports;
  const records=new DemoLaunchRecords(env.control);
  const lifecycle=new DemoLifecycle({
    mode,devEnabled:true,retention:()=>syntheticDemoRetention(env.root),
    confirm:createNativeDemoConfirmation((options)=>{
      const win=ports.getWindow();if(!win||win.isDestroyed())throw Error("Window unavailable");
      return dialog.showMessageBox(win,options);
    }),
    reserve:()=>{
      try {const r=reserveSyntheticDemoProfile(env.root);return "slot-"+r.slot+"/"+basename(r.path)}
      catch(err){if(err instanceof DemoProfileError && err.reason==="limit")throw new DemoRetentionLimit();throw err}
    },
    prepare:(action,id)=>records.prepare(action,id,Date.now()),
    endSession:()=>{service?.logout()},closeLedger:ports.closeLedger,
    releaseLock:()=>app.releaseSingleInstanceLock(),
    restart:(credentials)=>{
      // A packaged executable takes its arguments directly; the unpackaged one needs the app path first.
      const args=app.isPackaged?["--alzabt-synthetic-dev"]:[app.getAppPath(),"--alzabt-synthetic-dev"];
      const flag=journeyFlag(process.argv);if(flag)args.push(flag);
      if(credentials)args.push("--alzabt-synthetic-handover",credentials.nonce,credentials.key);
      app.relaunch({args});
    },
    quit:()=>app.quit(),defer:(fn)=>{setImmediate(fn)},confirmationTimeoutMs:60000,
  });
  ipcMain.handle("pos:requestDemoLifecycle",(event,payload:unknown)=>{
    const win=ports.getWindow();
    const trusted=win!==null && event.sender===win.webContents &&
      event.senderFrame===win.webContents.mainFrame && event.senderFrame?.url===ports.rendererUrl;
    return lifecycle.request(trusted,payload);
  });
}
/** Fixed one-shot Main/IPC observation. No debugger server or remote control. */
export function runSyntheticMainProbe(win:BrowserWindow,env:Environment):void {
  if(!syntheticBuildAllowed() || !app.hasSingleInstanceLock() || !process.argv.includes("--alzabt-synthetic-main-probe"))return;
  let done=false;
  const finish=(result:Record<string,unknown>)=>{
    if(done)return;done=true;clearTimeout(timeout);
    console.log("SYNTHETIC_MAIN_PROBE:"+JSON.stringify(result));
    app.quit();
  };
  const timeout=setTimeout(()=>finish({status:"FAIL",stage:"timeout"}),45000);
  win.webContents.once("did-finish-load",()=>{
    const code='(async()=>{const p=window.pos;if(!p||typeof p.requestDemoLifecycle!=="function")return {ok:false};const e=await p.getEntryState();const r=await p.requestDemoLifecycle({action:"enter",unexpected:"x"});return {ok:!!e?.ok&&e.data.profile==="real"&&r?.ok===false&&r.error?.code==="INVALID_INPUT"};})()';
    void win.webContents.executeJavaScript(code).then((result:unknown)=>{
      const rendererOk=!!result && typeof result==="object" && (result as {ok?:unknown}).ok===true;
      const pathOk=app.getPath("userData")===env.entry && app.getPath("sessionData")===env.entry;
      finish({status:rendererOk&&pathOk?"PASS":"FAIL",actualElectronMain:true,
        syntheticEntry:pathOk,untrustedExtraRejected:rendererOk});
    }).catch(()=>finish({status:"FAIL",stage:"ipc"}));
  });
}