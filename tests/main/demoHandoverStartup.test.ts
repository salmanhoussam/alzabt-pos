import {beforeEach,expect,it,vi} from "vitest";
const stubs=vi.hoisted(()=>({packaged:false,lock:false,gate:vi.fn(()=>null as string|null)}));
vi.mock("electron",()=>({app:{get isPackaged(){return stubs.packaged},hasSingleInstanceLock:()=>stubs.lock}}));
vi.mock("../../src/main/demoDevGate",()=>({verifiedSyntheticTestHome:stubs.gate}));
import {resolveVerifiedSyntheticHandover} from "../../src/main/demoHandoverStartup";
beforeEach(()=>{stubs.packaged=false;stubs.lock=false;stubs.gate.mockClear()});
it("returns real without inspecting a profile for packaged builds or absent instance lock",()=>{
  stubs.packaged=true;
  expect(resolveVerifiedSyntheticHandover(true,"n","k",1)).toEqual({kind:"real"});
  stubs.packaged=false;
  expect(resolveVerifiedSyntheticHandover(true,"n","k",1)).toEqual({kind:"real"});
  expect(stubs.gate).not.toHaveBeenCalled();
});
it("returns real if Main cannot establish the synthetic test identity",()=>{
  stubs.lock=true;
  expect(resolveVerifiedSyntheticHandover(true,"n","k",1)).toEqual({kind:"real"});
  expect(stubs.gate).toHaveBeenCalledTimes(1);
});
