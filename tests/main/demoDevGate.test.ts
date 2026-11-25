import {expect,it} from "vitest";
import {permitsSyntheticIdentity,verifiedSyntheticTestHome,type SyntheticGateIdentity} from "../../src/main/demoDevGate";
const good:SyntheticGateIdentity={platform:"win32",packaged:false,requested:true,user:"alzabt-test",
  qualified:"TESTPC\\alzabt-test",host:"TESTPC",sid:"S-1-5-21-1-2-3-1001",adminGroup:false};
it("requires the explicitly requested unpackaged local standard test identity",()=>{
  expect(permitsSyntheticIdentity(good)).toBe(true);
  for(const bad of [{...good,packaged:true},{...good,requested:false},{...good,user:"owner"},
    {...good,qualified:"DOMAIN\\alzabt-test"},{...good,adminGroup:true},{...good,platform:"linux"},
    {...good,sid:"S-1-5-18"}])expect(permitsSyntheticIdentity(bad)).toBe(false);
});
it("returns no test home when the dev gate is off or the build is packaged",()=>{
  expect(verifiedSyntheticTestHome(false,false)).toBeNull();
  expect(verifiedSyntheticTestHome(true,true)).toBeNull();
});
