import {afterEach,expect,it,vi} from "vitest";
import {DemoLifecycle,DemoRetentionLimit,type DemoLifecyclePorts} from "../../src/main/demoLifecycle";
function make(mode:"real"|"demo"="real"){
  const actions:string[]=[];let deferred:(()=>void)|undefined;
  const ports:DemoLifecyclePorts={
    mode,devEnabled:true,retention:()=>({reached:false}),
    confirm:async()=>true,reserve:()=>{actions.push("reserve");return "synthetic"},
    prepare:()=>{actions.push("commit");return {nonce:"n",key:"k"}},
    endSession:()=>actions.push("session"),closeLedger:()=>actions.push("ledger"),
    releaseLock:()=>actions.push("lock"),restart:()=>actions.push("restart"),quit:()=>actions.push("quit"),
    defer:(fn)=>{deferred=fn},confirmationTimeoutMs:60000,
  };
  return {ports,actions,flush:()=>deferred?.()};
}
afterEach(()=>vi.useRealTimers());
it("rejects untrusted, malformed, forbidden and duplicate requests",async()=>{
  const f=make();const lifecycle=new DemoLifecycle(f.ports);
  expect(await lifecycle.request(false,{action:"enter"})).toMatchObject({error:{code:"INVALID_INPUT"}});
  expect(await lifecycle.request(true,{action:"enter",path:"bad"})).toMatchObject({error:{code:"INVALID_INPUT"}});
  expect(await lifecycle.request(true,{action:"exit"})).toMatchObject({error:{code:"DEMO_ACTION_NOT_ALLOWED"}});
  expect(await lifecycle.request(true,{action:"enter"})).toEqual({ok:true,data:{status:"restarting"}});
  expect(await lifecycle.request(true,{action:"enter"})).toMatchObject({error:{code:"DEMO_BUSY"}});
  expect(f.actions).toEqual(["reserve","commit"]);
  f.flush();expect(f.actions).toEqual(["reserve","commit","session","ledger","lock","restart","quit"]);
});
it("preserves the old session on reservation or commit failure",async()=>{
  for(const failure of ["reserve","prepare"] as const){
    const f=make();const p={...f.ports,[failure]:()=>{throw Error("synthetic")}};
    expect(await new DemoLifecycle(p).request(true,{action:"enter"})).toMatchObject({error:{code:"DEMO_LIFECYCLE_FAILED"}});
    expect(f.actions).not.toContain("session");expect(f.actions).not.toContain("ledger");
  }
  const f=make();const p={...f.ports,reserve:()=>{throw new DemoRetentionLimit()}};
  expect(await new DemoLifecycle(p).request(true,{action:"enter"})).toMatchObject({error:{code:"DEMO_RETENTION_LIMIT"}});
});
it("times out while responsive and ignores a late confirmation",async()=>{
  vi.useFakeTimers();const f=make();let answer:(value:boolean)=>void=()=>{};
  const p={...f.ports,confirmationTimeoutMs:10,confirm:()=>new Promise<boolean>((resolve)=>{answer=resolve})};
  const response=new DemoLifecycle(p).request(true,{action:"enter"});
  await vi.advanceTimersByTimeAsync(10);
  expect(await response).toEqual({ok:true,data:{status:"cancelled"}});
  answer(true);await Promise.resolve();
  expect(f.actions).toEqual([]);
});
it("allows trusted Demo exit without reserving or requiring a session",async()=>{
  const f=make("demo");
  expect(await new DemoLifecycle(f.ports).request(true,{action:"exit"})).toEqual({ok:true,data:{status:"restarting"}});
  expect(f.actions).toEqual([]);f.flush();
  expect(f.actions).toEqual(["session","ledger","lock","restart","quit"]);
});
it("always quits after post-commit teardown or restart failure",async()=>{
  const f=make("demo");let queued:(()=>void)|undefined;
  const p={...f.ports,closeLedger:()=>{throw Error("synthetic")},defer:(fn:()=>void)=>{queued=fn}};
  expect(await new DemoLifecycle(p).request(true,{action:"exit"})).toEqual({ok:true,data:{status:"restarting"}});
  expect(()=>queued?.()).toThrow();expect(f.actions).toEqual(["session","quit"]);
});

it("fails closed at gate and capacity without showing confirmation or reserving",async()=>{
  const f=make();const confirm=vi.fn(async()=>true);
  expect(await new DemoLifecycle({...f.ports,devEnabled:false,confirm}).request(true,{action:"enter"}))
    .toMatchObject({error:{code:"DEMO_UNAVAILABLE"}});
  expect(await new DemoLifecycle({...f.ports,retention:()=>({reached:true}),confirm}).request(true,{action:"enter"}))
    .toMatchObject({error:{code:"DEMO_RETENTION_LIMIT"}});
  expect(confirm).not.toHaveBeenCalled();expect(f.actions).toEqual([]);
});
it("cancellation and a failed dialog do not reserve or end the session",async()=>{
  const f=make();
  expect(await new DemoLifecycle({...f.ports,confirm:async()=>false}).request(true,{action:"enter"}))
    .toEqual({ok:true,data:{status:"cancelled"}});
  expect(await new DemoLifecycle({...f.ports,confirm:async()=>{throw Error("synthetic")}}).request(true,{action:"enter"}))
    .toMatchObject({error:{code:"DEMO_LIFECYCLE_FAILED"}});
  expect(f.actions).toEqual([]);
});
it("reset uses a fresh reservation and rejects a concurrent request while confirming",async()=>{
  const f=make("demo");let answer:(v:boolean)=>void=()=>{};
  const lifecycle=new DemoLifecycle({...f.ports,confirm:()=>new Promise<boolean>((resolve)=>{answer=resolve})});
  const first=lifecycle.request(true,{action:"reset"});
  expect(await lifecycle.request(true,{action:"exit"})).toMatchObject({error:{code:"DEMO_BUSY"}});
  answer(true);expect(await first).toEqual({ok:true,data:{status:"restarting"}});
  expect(f.actions).toEqual(["reserve","commit"]);
});

it("native confirmation passes the abort signal and refuses late approval",async()=>{
  const {createNativeDemoConfirmation}=await import("../../src/main/demoLifecycle");
  const controller=new AbortController();
  let answer:(value:{response:number})=>void=()=>{};
  const show=vi.fn((_options:import("electron").MessageBoxOptions)=>new Promise<{response:number}>((resolve)=>{answer=resolve}));
  const pending=createNativeDemoConfirmation(show)("reset",controller.signal);
  expect(show).toHaveBeenCalledTimes(1);
  expect(show.mock.calls[0]![0]).toMatchObject({type:"question",cancelId:1,signal:controller.signal});
  controller.abort();
  answer({response:0});
  expect(await pending).toBe(false);
  expect(await createNativeDemoConfirmation(show)("exit",controller.signal)).toBe(false);
  expect(show).toHaveBeenCalledTimes(1);
});
it("native confirmation accepts only the explicit continue response",async()=>{
  const {createNativeDemoConfirmation}=await import("../../src/main/demoLifecycle");
  const signal=new AbortController().signal;
  expect(await createNativeDemoConfirmation(async()=>({response:0}))("enter",signal)).toBe(true);
  expect(await createNativeDemoConfirmation(async()=>({response:1}))("enter",signal)).toBe(false);
  await expect(createNativeDemoConfirmation(async()=>{throw Error("dialog failed")})("enter",signal)).rejects.toThrow();
});