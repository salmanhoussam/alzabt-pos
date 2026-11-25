/**
 * V8 transition coordinator; not wired to Electron, IPC or distribution.
 * All ports are owned by trusted Main. Profile and filesystem trust must be
 * established separately; K-1 is restricted to the synthetic test account.
 */
type Action="enter"|"exit"|"reset";
type Code="INVALID_INPUT"|"DEMO_UNAVAILABLE"|"DEMO_RETENTION_LIMIT"|"DEMO_ACTION_NOT_ALLOWED"|"DEMO_BUSY"|"DEMO_LIFECYCLE_FAILED";
type Reply={ok:true;data:{status:"restarting"|"cancelled"}} | {ok:false;error:{code:Code;message:string}};
export class DemoRetentionLimit extends Error {}
export interface DemoLifecyclePorts {
  readonly mode:"real"|"demo";
  readonly devEnabled:boolean;
  readonly retention:()=>{readonly reached:boolean};
  readonly confirm:(action:Action,signal:AbortSignal)=>Promise<boolean>;
  readonly reserve:()=>string;
  readonly prepare:(action:"enter"|"reset",reservationId:string)=>{nonce:string;key:string};
  readonly endSession:()=>void;
  readonly closeLedger:()=>void;
  readonly releaseLock:()=>void;
  readonly restart:(credentials:{nonce:string;key:string}|null)=>void;
  readonly quit:()=>void;
  /** Main queues teardown only after returning the IPC response. */
  readonly defer:(f:()=>void)=>void;
  /** Tests may use a shorter bound. Production must supply 60000. */
  readonly confirmationTimeoutMs:number;
}
const refusal=(code:Code):Reply=>({ok:false,error:{code,message:"Demo operation unavailable."}});
const success=(status:"restarting"|"cancelled"):Reply=>({ok:true,data:{status}});
function actionOf(value:unknown):Action|null {
  if(!value || typeof value!=="object" || Array.isArray(value))return null;
  const obj=value as Record<string,unknown>;
  if(Object.keys(obj).length!==1 || !Object.prototype.hasOwnProperty.call(obj,"action"))return null;
  return obj.action==="enter"||obj.action==="exit"||obj.action==="reset"?obj.action:null;
}
export class DemoLifecycle {
  private busy=false;
  constructor(private readonly ports:DemoLifecyclePorts) {}
  async request(senderIsMainTopFrame:boolean,payload:unknown):Promise<Reply> {
    const action=actionOf(payload);
    if(!senderIsMainTopFrame || !action)return refusal("INVALID_INPUT");
    if(this.busy)return refusal("DEMO_BUSY");
    if(this.ports.devEnabled!==true || (this.ports.mode!=="real" && this.ports.mode!=="demo") ||
      !Number.isSafeInteger(this.ports.confirmationTimeoutMs) || this.ports.confirmationTimeoutMs<1 ||
      this.ports.confirmationTimeoutMs>60000)return refusal("DEMO_UNAVAILABLE");
    if((this.ports.mode==="real" && action!=="enter") ||
       (this.ports.mode==="demo" && action==="enter"))return refusal("DEMO_ACTION_NOT_ALLOWED");
    this.busy=true;
    let committed=false;
    try {
      if(action!=="exit" && this.ports.retention().reached)return refusal("DEMO_RETENTION_LIMIT");
      const controller=new AbortController();
      let timer:ReturnType<typeof setTimeout>|undefined;
      const timeout=new Promise<false>((resolve)=>{timer=setTimeout(()=>{controller.abort();resolve(false)},this.ports.confirmationTimeoutMs)});
      let confirmed:boolean;
      try {confirmed=await Promise.race([this.ports.confirm(action,controller.signal),timeout])}
      finally {if(timer)clearTimeout(timer)}
      if(!confirmed)return success("cancelled");
      let credentials:{nonce:string;key:string}|null=null;
      if(action!=="exit") {
        const id=this.ports.reserve();
        credentials=this.ports.prepare(action,id);
      }
      committed=true;
      this.ports.defer(()=>{
        try {
          this.ports.endSession();
          this.ports.closeLedger();
          this.ports.releaseLock();
          this.ports.restart(credentials);
        } finally {this.ports.quit()}
      });
      return success("restarting");
    } catch(e) {
      if(committed) {
        try{this.ports.quit()}catch{/* fail closed */}
      }
      return refusal(e instanceof DemoRetentionLimit?"DEMO_RETENTION_LIMIT":"DEMO_LIFECYCLE_FAILED");
    } finally {if(!committed)this.busy=false}
  }
}

/** Main supplies dialog.showMessageBox for the trusted application window.
 * The coordinator owns the timeout and aborts this signal; no renderer data
 * selects the dialog, its buttons or its result. */
export function createNativeDemoConfirmation(
  show: (options: import("electron").MessageBoxOptions) => Promise<{response:number}>,
): DemoLifecyclePorts["confirm"] {
  return async (action,signal) => {
    if(signal.aborted)return false;
    const message = action === "enter" ? "Enter the synthetic demo?" :
      action === "reset" ? "Start a fresh synthetic demo?" : "Exit the synthetic demo?";
    try {
      const result=await show({type:"question",message,buttons:["Continue","Cancel"],
        defaultId:1,cancelId:1,noLink:true,signal});
      return !signal.aborted && result.response===0;
    } catch (err) {
      if(signal.aborted)return false;
      throw err;
    }
  };
}