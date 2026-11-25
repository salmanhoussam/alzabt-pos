import {test} from "node:test";
import {strict as assert} from "node:assert";
import {observedSyntheticLockRefusal} from "../../e2e/_crashRefusal.mjs";
test("requires marker, live first process, clean exit and no second-profile files",()=>{
  const good={firstAlive:true,exit:{code:0,signal:null},refusalMarker:true,windowMs:null,profileExists:false,diagExists:false};
  assert.equal(observedSyntheticLockRefusal(good),true);
  for(const bad of [{...good,refusalMarker:false},{...good,firstAlive:false},{...good,exit:null},
    {...good,exit:{code:1,signal:null}},{...good,windowMs:30},{...good,profileExists:true},{...good,diagExists:true}])
    assert.equal(observedSyntheticLockRefusal(bad),false);
});
