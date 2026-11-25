/* Runs the built, unpackaged POS only against newly created synthetic profiles. */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const root = fs.mkdtempSync(path.join(process.cwd(),"node_modules","synthetic-actual-pos-lock-"));
const electron = path.join(process.cwd(),"node_modules","electron","dist","electron.exe");
const envBase = { ...process.env, APPDATA:path.join(root,"appdata"), LOCALAPPDATA:path.join(root,"localappdata"),
  TEMP:path.join(root,"temp"), TMP:path.join(root,"temp"),
  ALZABT_POS_DISABLE_AUTOSTART:"1" };
delete envBase.ELECTRON_RUN_AS_NODE;
for (const d of [envBase.APPDATA,envBase.LOCALAPPDATA,envBase.TEMP]) fs.mkdirSync(d,{recursive:true});
const started = new Set();
const observed = [];
const watcher = fs.watch(root,{recursive:true},(event,file)=>observed.push({event,file:String(file)}));

function launch(common, profile, tag) {
  const diag = path.join(profile,"synthetic-diag.jsonl");
  const env = {...envBase, ALZABT_POS_USER_DATA:profile, ALZABT_POS_DIAG_LOG:diag};
  // Explicitly pin Chromium startup to the synthetic root. Never omit this:
  // APPDATA overrides alone have not been proved to redirect every Windows path.
  const args = ["--user-data-dir="+common, "--disable-background-networking", process.cwd()];
  const cp = spawn(electron,args,
    {cwd:process.cwd(), env, windowsHide:true, stdio:["ignore","pipe","pipe"]});
  started.add(cp);
  let errorText="";
  cp.stdout.on("data",()=>{});
  cp.stderr.on("data",(x)=>{errorText+=x;});
  const exited = new Promise((resolve)=>cp.on("exit",(code,signal)=>{started.delete(cp);resolve({code,signal})}));
  return {cp,exited,diag,tag,errorText:()=>errorText.slice(0,500)};
}
const pause = (ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function waitReady(process) {
  for(let i=0;i<200;i++){
    if(fs.existsSync(process.diag)) {
      const text=fs.readFileSync(process.diag,"utf8");
      if(text.includes('"event":"ledger-open"')) return;
      if(text.includes('"event":"startup-failure"')) throw new Error("synthetic POS startup failed");
    }
    if(process.cp.exitCode !== null) throw new Error("synthetic POS exited before ledger open");
    await pause(100);
  }
  throw new Error("synthetic POS ledger-open timeout: "+process.tag+" "+process.errorText());
}
async function stopOwned(process) {
  if(process.cp.exitCode===null && process.cp.signalCode===null) {
    if(!process.cp.kill("SIGKILL")) throw new Error("failed to terminate our synthetic POS child");
  }
  return process.exited;
}
async function scenario(firstRole,secondRole) {
  const dir=fs.mkdtempSync(path.join(root,"case-"));
  const common=path.join(dir,"common"), profiles={normal:path.join(dir,"normal"),demo:path.join(dir,"demo")};
  for(const d of [common,profiles.normal,profiles.demo]) fs.mkdirSync(d);
  const first=launch(common,profiles[firstRole],firstRole);
  try {
    await waitReady(first);
    const second=launch(common,profiles[secondRole],secondRole);
    const exit=await Promise.race([second.exited,pause(15000).then(()=>{throw new Error("second did not exit");})]);
    assert.equal(first.cp.exitCode,null);
    assert.equal(exit.code,0);
    assert.deepEqual(fs.readdirSync(profiles[secondRole]),[]);
    const firstKilled=await stopOwned(first);
    const restart=launch(common,profiles[secondRole],secondRole+"-restart");
    try {
      await waitReady(restart);
      const restartKilled=await stopOwned(restart);
      return {firstRole,secondRole,secondExit:exit,secondProfileEmpty:true,firstKilled,restartOpenedSyntheticLedger:true,restartKilled};
    } finally { if(restart.cp.exitCode===null && restart.cp.signalCode===null) await stopOwned(restart); }
  } finally { if(first.cp.exitCode===null && first.cp.signalCode===null) await stopOwned(first); }
}
(async()=>{
  const cases=[await scenario("normal","demo"),await scenario("demo","normal")];
  watcher.close();
  fs.writeFileSync(path.join(root,"results.json"),JSON.stringify({root,cases,observed},null,2),{flag:"wx"});
  console.log(JSON.stringify({root,cases,observedEvents:observed.length}));
})().catch(async(err)=>{
  for(const child of started) if(child.exitCode===null && child.signalCode===null) child.kill("SIGKILL");
  watcher.close();
  console.error(err.stack);
  process.exitCode=1;
});
