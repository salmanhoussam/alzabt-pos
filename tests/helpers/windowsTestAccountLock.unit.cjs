/* Pure validation only. No POS, Windows account changes, file writes or tracing. */
const test=require("node:test");
const assert=require("node:assert/strict");
const {parseWhoami,validatePrincipal,validateContext}=require("./windowsTestAccountLock.cjs");
const slash=String.fromCharCode(92);
const name="TESTPC"+slash+"alzabt-test";
const user=parseWhoami('"'+name+'","S-1-5-21-1-2-3-1001"');
const home=["C:","Users","alzabt-test"].join(slash);
const app=[home,"AppData","Roaming"].join(slash);
const local=[home,"AppData","Local"].join(slash);
const good={user:"alzabt-test",hostname:"TESTPC",qualified:user.name,sid:user.sid,adminGroupPresent:false,
  profile:home,registered:home,userProfileEnv:home,appData:app,localData:local,shellAppData:app,shellLocalData:local};

test("accepts only the expected local standard account and matching test paths",()=>{
  assert.equal(validateContext(good),true);
});
test("rejects another user, a domain identity, and an administrator group",()=>{
  for(const bad of [{...good,user:"owner"},{...good,qualified:"DOMAIN"+slash+"alzabt-test"},{...good,adminGroupPresent:true}])
    assert.throws(()=>validatePrincipal(bad));
});
test("rejects profile or known-folder paths outside the intended test profile",()=>{
  for(const bad of [{...good,userProfileEnv:["C:","Users","owner"].join(slash)},
                    {...good,registered:["C:","Users","owner"].join(slash)},
                    {...good,shellAppData:["C:","Users","owner"].join(slash)}])
    assert.throws(()=>validateContext(bad));
});
test("rejects invalid whoami output",()=>assert.throws(()=>parseWhoami("invalid")));
