import {mkdirSync,mkdtempSync,readdirSync} from "node:fs";
import {basename,join} from "node:path";
import {beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({packaged:false,lock:true,ready:false,home:"",paths:{} as Record<string,string>}));
vi.mock("electron",()=>({
  app:{get isPackaged(){return state.packaged},hasSingleInstanceLock:()=>state.lock,isReady:()=>state.ready,
    setPath:(key:string,value:string)=>{state.paths[key]=value},getPath:(key:string)=>state.paths[key]},
  session:{},nativeImage:{},
}));
vi.mock("../../src/main/demoDevGate",()=>({verifiedSyntheticTestHome:()=>state.home||null}));
import {DemoLaunchRecords} from "../../src/main/demoLaunchRecords";
import {createSyntheticDemoRoot,reserveSyntheticDemoProfile} from "../../src/main/demoProfile";
import {resolveVerifiedSyntheticHandover,type VerifiedDemoStart} from "../../src/main/demoHandoverStartup";
import {selectVerifiedDemoProfile} from "../../src/main/demoRuntime";
beforeEach(()=>{state.packaged=false;state.lock=true;state.ready=false;state.home="";state.paths={}});
it("rejects a forged or packaged proof without changing app paths",()=>{
  expect(()=>selectVerifiedDemoProfile({} as VerifiedDemoStart)).toThrow();
  state.packaged=true;
  expect(()=>selectVerifiedDemoProfile({} as VerifiedDemoStart)).toThrow();
  expect(state.paths).toEqual({});
});
it("selects the consumed synthetic reservation before a ledger exists and rejects reuse",()=>{
  const home=mkdtempSync(join(process.cwd(),"node_modules","synthetic-runtime-test-"));
  state.home=home;
  const base=join(home,"AppData","Local","Alzabt-Synthetic-Development");
  mkdirSync(base,{recursive:true});
  const control=join(base,"control");mkdirSync(control);
  const root=createSyntheticDemoRoot(base);
  const reserved=reserveSyntheticDemoProfile(root);
  const id="slot-"+reserved.slot+"/"+basename(reserved.path);
  const records=new DemoLaunchRecords(control);
  const launch=records.prepare("enter",id,1000);
  const result=resolveVerifiedSyntheticHandover(true,launch.nonce,launch.key,1001);
  expect(result.kind).toBe("ready");
  if(result.kind!=="ready")throw Error("missing proof");
  selectVerifiedDemoProfile(result.proof);
  expect(state.paths.userData).toBe(reserved.path);
  expect(state.paths.sessionData).toBe(reserved.path);
  expect(readdirSync(reserved.path)).toEqual([".alzabt-synthetic-demo-profile"]);
  expect(()=>selectVerifiedDemoProfile(result.proof)).toThrow();
});
