import {beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({packaged:false,locked:true,ready:false,paths:{} as Record<string,string>,
  disabled:vi.fn(),open:vi.fn(),resolve:vi.fn(),select:vi.fn(),handlers:new Map<string,Function>()}));
vi.mock("electron",()=>({app:{get isPackaged(){return state.packaged},hasSingleInstanceLock:()=>state.locked,
  isReady:()=>state.ready,setPath:(k:string,v:string)=>{state.paths[k]=v},getPath:(k:string)=>state.paths[k]},
  dialog:{showMessageBox:async()=>({response:1})},ipcMain:{handle:(name:string,handler:Function)=>state.handlers.set(name,handler)}}));
vi.mock("../../src/main/diagnostics",()=>({disableDiagnostics:state.disabled}));
vi.mock("../../src/main/demoDevEntry",()=>({openSyntheticDevEnvironment:state.open}));
vi.mock("../../src/main/demoHandoverStartup",()=>({resolveVerifiedSyntheticHandover:state.resolve}));
vi.mock("../../src/main/demoRuntime",()=>({selectVerifiedDemoProfile:state.select}));
vi.mock("../../src/main/demoLaunchRecords",()=>({DemoLaunchRecords:class {}}));
vi.mock("../../src/main/demoProfile",()=>({DemoProfileError:class extends Error{},
  reserveSyntheticDemoProfile:vi.fn(),syntheticDemoRetention:()=>({reached:false})}));
import {prepareSyntheticStartup,registerSyntheticLifecycle} from "../../src/main/demoDevMain";
const environment={entry:"synthetic-entry",root:"synthetic-root",control:"synthetic-control"};
beforeEach(()=>{state.packaged=false;state.locked=true;state.ready=false;state.paths={};state.handlers.clear();
  state.disabled.mockReset();state.open.mockReset().mockReturnValue(environment);state.resolve.mockReset();state.select.mockReset()});
it("leaves ordinary and packaged startup alone",()=>{
  expect(prepareSyntheticStartup(["electron","app"])).toEqual({kind:"ordinary"});
  state.packaged=true;
  expect(prepareSyntheticStartup(["electron","app","--alzabt-synthetic-dev"])).toEqual({kind:"ordinary"});
  expect(state.open).not.toHaveBeenCalled();expect(state.disabled).not.toHaveBeenCalled();
});
it("routes malformed, unverified and replayed handovers only to the fixed synthetic entry",()=>{
  expect(prepareSyntheticStartup(["app","--alzabt-synthetic-handover","bad","bad"])).toMatchObject({kind:"selected",env:environment});
  const hex="a".repeat(64);state.resolve.mockReturnValue({kind:"real"});
  expect(prepareSyntheticStartup(["app","--alzabt-synthetic-handover",hex,hex])).toMatchObject({kind:"selected",env:environment});
  expect(state.select).not.toHaveBeenCalled();
  expect(state.paths).toEqual({userData:"synthetic-entry",sessionData:"synthetic-entry"});
});
it("selects only the fixed verified synthetic entry and ignores inherited overrides",()=>{
  expect(prepareSyntheticStartup(["app","--alzabt-synthetic-dev"])).toMatchObject({kind:"selected",env:environment});
  expect(state.paths).toEqual({userData:"synthetic-entry",sessionData:"synthetic-entry"});
  expect(state.disabled).toHaveBeenCalledOnce();
});
it("uses only a consumed proof for Demo, not the entry path",()=>{
  const proof={},token={};state.resolve.mockReturnValue({kind:"ready",proof});state.select.mockReturnValue(token);
  const hex="a".repeat(64);
  expect(prepareSyntheticStartup(["app","--alzabt-synthetic-handover",hex,hex])).toMatchObject({kind:"selected",selected:token});
  expect(state.open).toHaveBeenCalledWith(false);
  expect(state.select).toHaveBeenCalledWith(proof);expect(state.paths).toEqual({});
});
it("registers a Main-owned lifecycle that rejects another sender and honours cancellation",async()=>{
  const frame={url:"file://synthetic"};const wc={mainFrame:frame};const win={webContents:wc,isDestroyed:()=>false};
  registerSyntheticLifecycle({env:environment,mode:"demo",service:null,getWindow:()=>win as never,
    rendererUrl:"file://synthetic",closeLedger:vi.fn()});
  const handler=state.handlers.get("pos:requestDemoLifecycle")!;
  expect(await handler({sender:{},senderFrame:frame},{action:"exit"})).toMatchObject({error:{code:"INVALID_INPUT"}});
  expect(await handler({sender:wc,senderFrame:frame},{action:"exit"})).toEqual({ok:true,data:{status:"cancelled"}});
});
it("never registers lifecycle IPC in packaged or unlocked processes",()=>{
  const ports={env:environment,mode:"demo" as const,service:null,getWindow:()=>null,rendererUrl:"file://synthetic",closeLedger:vi.fn()};
  state.packaged=true;
  expect(()=>registerSyntheticLifecycle(ports)).toThrow();
  expect(state.handlers.size).toBe(0);
  state.packaged=false;state.locked=false;
  expect(()=>registerSyntheticLifecycle(ports)).toThrow();
  expect(state.handlers.size).toBe(0);
});