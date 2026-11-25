import {expect,it,vi} from "vitest";
import {demoAvailability} from "../../src/main/entryState";
it("never probes retention when development gate or lifecycle is unavailable",()=>{
  const read=vi.fn(()=>({retained:0,max:5 as const,reached:false}));
  expect(demoAvailability(false,true,read)).toEqual({demoAvailable:false});
  expect(demoAvailability(true,false,read)).toEqual({demoAvailable:false});
  expect(read).not.toHaveBeenCalled();
});
it("signals only a valid, trusted slot count and disables at five",()=>{
  expect(demoAvailability(true,true,()=>({retained:4,max:5,reached:false}))).toEqual(
    {demoAvailable:true,demoRetention:{retained:4,max:5,reached:false}});
  expect(demoAvailability(true,true,()=>({retained:5,max:5,reached:true}))).toEqual(
    {demoAvailable:false,demoRetention:{retained:5,max:5,reached:true}});
  for(const r of [{retained:-1,max:5 as const,reached:false},{retained:6,max:5 as const,reached:true},
    {retained:5,max:5 as const,reached:false},{retained:0.5,max:5 as const,reached:false}])
    expect(demoAvailability(true,true,()=>r)).toEqual({demoAvailable:false});
  expect(demoAvailability(true,true,()=>{throw Error("synthetic");})).toEqual({demoAvailable:false});
});
