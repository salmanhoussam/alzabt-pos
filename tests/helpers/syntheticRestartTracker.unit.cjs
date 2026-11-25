const test=require("node:test");
const assert=require("node:assert/strict");
const {isSyntheticLog,eventFromLine}=require("./syntheticRestartTracker.cjs");
test("allows only the explicit synthetic test log path",()=>{
  assert.equal(isSyntheticLog("C:\\Users\\alzabt-test\\AppData\\Local\\Alzabt-Synthetic-Node-abc123\\A-first-xyz123\\A\\synthetic-diag.jsonl"),true);
  for(const p of ["C:\\Users\\salma\\AppData\\Local\\Alzabt-Synthetic-Node-abc123\\A-first-xyz123\\A\\synthetic-diag.jsonl",
    "C:\\Users\\alzabt-test\\AppData\\Local\\Alzabt-Synthetic-Node-abc123\\..\\private.jsonl",
    "C:\\Users\\alzabt-test\\AppData\\Local\\Alzabt-Synthetic-Node-abc123\\A-first-xyz123\\A\\other.jsonl"])
    assert.equal(isSyntheticLog(p),false);
});
test("emits only bounded lifecycle fields, discarding sensitive extras",()=>{
  assert.deepEqual(eventFromLine(JSON.stringify({event:"main-start",pid:10,ppid:3,t:123,argv:["secret"],userData:"private"})),
    {event:"main-start",pid:10,ppid:3,t:123});
  assert.equal(eventFromLine(JSON.stringify({event:"other",pid:10,ppid:3,t:123})),null);
  assert.equal(eventFromLine("bad"),null);
});
