import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({packaged:false,locked:true,ready:false,home:""}));
vi.mock("electron",()=>({app:{get isPackaged(){return state.packaged},hasSingleInstanceLock:()=>state.locked,isReady:()=>state.ready}}));
vi.mock("../../src/main/demoDevGate",()=>({verifiedSyntheticTestHome:()=>state.home||null}));
import {openSyntheticDevEnvironment} from "../../src/main/demoDevEntry";
import {createSyntheticDemoRoot} from "../../src/main/demoProfile";
beforeEach(()=>{state.packaged=false;state.locked=true;state.ready=false;state.home=""});
function home() {
  const p=mkdtempSync(join(process.cwd(),"node_modules","synthetic-dev-entry-"));
  const base=join(p,"AppData","Local","Alzabt-Synthetic-Development");
  mkdirSync(base,{recursive:true});mkdirSync(join(base,"control"));createSyntheticDemoRoot(base);
  state.home=p;return base;
}
it("rejects packaged, unlocked, ready and unidentified contexts before profile access",()=>{
  for(const key of ["packaged","ready"] as const){state[key]=true;expect(()=>openSyntheticDevEnvironment()).toThrow();state[key]=false}
  state.locked=false;expect(()=>openSyntheticDevEnvironment()).toThrow();state.locked=true;
  expect(()=>openSyntheticDevEnvironment()).toThrow();
});
it("creates only an identified synthetic entry and safely reopens its marker",()=>{
  const base=home();const first=openSyntheticDevEnvironment();
  expect(first.entry).toBe(join(base,"synthetic-entry-v1"));
  expect(readFileSync(join(first.entry,".alzabt-synthetic-entry-v1"),"utf8")).toBe("alzabt-synthetic-entry-v1");
  expect(openSyntheticDevEnvironment()).toEqual(first);
});
it("refuses an existing unknown entry without overwriting it",()=>{
  const base=home();const entry=join(base,"synthetic-entry-v1");mkdirSync(entry);
  const marker=join(entry,".alzabt-synthetic-entry-v1");writeFileSync(marker,"unknown");
  expect(()=>openSyntheticDevEnvironment()).toThrow();expect(readFileSync(marker,"utf8")).toBe("unknown");
});
it("does not create or open an entry ledger while preparing a Demo handover",()=>{
  const base=home();const result=openSyntheticDevEnvironment(false);
  expect(result.entry).toBe(join(base,"synthetic-entry-v1"));
  expect(existsSync(result.entry)).toBe(false);
});
it("does not migrate an existing invalid entry ledger",()=>{
  const base=home();const entry=openSyntheticDevEnvironment().entry;
  const ledger=join(entry,"alzabt-pos-ledger.sqlite");writeFileSync(ledger,"synthetic-invalid-ledger");
  expect(()=>openSyntheticDevEnvironment()).toThrow();
  expect(readFileSync(ledger,"utf8")).toBe("synthetic-invalid-ledger");
  expect(entry).toBe(join(base,"synthetic-entry-v1"));
});