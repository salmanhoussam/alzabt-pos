/*
 * Preparation for a local, synthetic-only test. Run only after owner review:
 * node windowsTestAccountLock.cjs --run
 * No PowerShell execution-policy changes, monitoring, profile cleanup or network.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomBytes } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const EXPECTED_USER = "alzabt-test";
const repo = "C:\\dev\\alzabt-pos-joint-codex";
const mainHash = "e47a365932f29b069ec8d44ad8a662de3538a85780aff86bfd6ce4872f54a2d5";
const exeHash = "4d313d128cb9d2412dc17a7beefb1d79269825e3a3ffa0af611c203c836a1ab6";
const w = path.win32;
const norm = (p) => w.resolve(p).replace(/[\\]+$/,"").toLowerCase();

function parseWhoami(line) {
  const match = String(line).trim().match(/^"([^"]+)","(S-1-[0-9-]+)"$/i);
  if (!match) throw Error("Cannot verify Windows identity.");
  return { name: match[1], sid: match[2] };
}
function validatePrincipal(c) {
  const expectedName = (c.hostname || "").split(".")[0].toLowerCase() + "\\" + EXPECTED_USER;
  if ((c.user || "").toLowerCase() !== EXPECTED_USER ||
      (c.qualified || "").toLowerCase() !== expectedName ||
      !/^S-1-5-21-[0-9-]+$/i.test(c.sid || "") ||
      c.adminGroupPresent) throw Error("Not the expected standard local account.");
}
function validateContext(c) {
  validatePrincipal(c);
  const expectedProfile = "C:\\Users\\alzabt-test";
  if (![c.profile,c.registered,c.userProfileEnv].every((p)=>p && norm(p)===norm(expectedProfile)))
    throw Error("The test profile identity is unverified.");
  const under = (p) => p && norm(p).startsWith(norm(expectedProfile)+"\\");
  if (!under(c.appData) || !under(c.localData) ||
      norm(c.appData)!==norm(c.shellAppData) || norm(c.localData)!==norm(c.shellLocalData))
    throw Error("Application-data paths do not match the test profile.");
  return true;
}
function expand(value, env) {
  return value.replace(/%([^%]+)%/g,(_,name)=>{
    const key=Object.keys(env).find((x)=>x.toLowerCase()===name.toLowerCase());
    if(!key || !env[key]) throw Error("An account folder variable is unavailable.");
    return env[key];
  });
}
function regValue(key, name) {
  const exe=w.join(process.env.SystemRoot || "C:\\Windows","System32","reg.exe");
  const text=execFileSync(exe,["query",key,"/v",name],{encoding:"utf8",windowsHide:true,timeout:10000});
  const found=text.split(/\r?\n/).map((x)=>x.trim()).find((x)=>x.toLowerCase().startsWith(name.toLowerCase()+" "));
  const match=found && found.match(/^[^\s]+(?:\s+[^\s]+)*?\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
  if(!match) throw Error("Cannot verify a Windows profile registry value.");
  return expand(match[1].trim(),process.env);
}
function verifyNoLinks(folder) {
  let part=w.parse(folder).root;
  const pieces=folder.slice(part.length).split(/[\\/]+/).filter(Boolean);
  if(!part || !fs.lstatSync(part).isDirectory()) throw Error("Invalid test path.");
  for(const segment of pieces) {
    part=w.join(part,segment);
    const stat=fs.lstatSync(part);
    if(stat.isSymbolicLink() || !stat.isDirectory()) throw Error("A test path is redirected.");
  }
  if(norm(fs.realpathSync.native(folder))!==norm(folder)) throw Error("A test path is not canonical.");
}
async function digest(file) {
  const h=createHash("sha256");
  for await(const chunk of fs.createReadStream(file))h.update(chunk);
  return h.digest("hex");
}
const sleep=(ms)=>new Promise((done)=>setTimeout(done,ms));
async function run() {
  if(process.platform!=="win32" || !process.argv.includes("--run"))
    throw Error("Preparation only. Run with --run in the test account.");
  const who=w.join(process.env.SystemRoot||"C:\\Windows","System32","whoami.exe");
  const identity=parseWhoami(execFileSync(who,["/user","/fo","csv","/nh"],{encoding:"utf8",windowsHide:true,timeout:10000}));
  const groups=execFileSync(who,["/groups","/fo","csv","/nh"],{encoding:"utf8",windowsHide:true,timeout:10000});
  const principal={user:os.userInfo().username,hostname:os.hostname(),qualified:identity.name,sid:identity.sid,
    adminGroupPresent:/S-1-5-32-544/i.test(groups)};
  // Reject the wrong token before reading any account-profile registry or path.
  validatePrincipal(principal);
  const profile=regValue("HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\"+identity.sid,"ProfileImagePath");
  const shell="HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
  const ctx={...principal,profile,registered:profile,userProfileEnv:process.env.USERPROFILE,
    appData:process.env.APPDATA,localData:process.env.LOCALAPPDATA,
    shellAppData:regValue(shell,"AppData"),shellLocalData:regValue(shell,"Local AppData")};
  validateContext(ctx);
  for(const p of [ctx.profile,ctx.appData,ctx.localData])verifyNoLinks(p);
  const exe=w.join(repo,"node_modules","electron","dist","electron.exe");
  const main=w.join(repo,"dist","main","main","main.js");
  const renderer=w.join(repo,"dist","renderer","index.html");
  const build=w.join(repo,"dist","build-info.json");
  if(!fs.statSync(renderer).isFile() || JSON.parse(fs.readFileSync(build,"utf8")).build!=="5d7a165-dirty" ||
     await digest(main)!==mainHash || await digest(exe)!==exeHash) throw Error("The reviewed test build is unavailable or changed.");
  const root=fs.mkdtempSync(w.join(ctx.localData,"Alzabt-Synthetic-Node-"));
  const temp=w.join(root,"temp");fs.mkdirSync(temp);
  console.log("Synthetic test directory:",root);
  console.log("No file-access trace is run; absence of reads is NOT proven.");
  const env={...process.env,ALZABT_POS_DISABLE_AUTOSTART:"1",TEMP:temp,TMP:temp};
  for(const key of ["ELECTRON_RUN_AS_NODE","NODE_OPTIONS","ALZABT_POS_DEMO_CATALOG"])delete env[key];
  const started=new Set();
  function launch(profile) {
    const diag=w.join(profile,"synthetic-diag.jsonl");
    const child=spawn(exe,["--disable-background-networking",repo],{cwd:repo,windowsHide:true,
      env:{...env,ALZABT_POS_USER_DATA:profile,ALZABT_POS_DIAG_LOG:diag},stdio:["ignore","pipe","pipe"]});
    started.add(child);child.stdout.resume();child.stderr.resume();
    const exited=new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>{started.delete(child);resolve({code,signal})})});
    return {child,exited,diag,profile};
  }
  async function ready(run) {
    for(let n=0;n<300;n++){
      if(run.child.exitCode!==null || run.child.signalCode!==null) throw Error("Synthetic POS exited before opening its test ledger.");
      if(fs.existsSync(run.diag) && fs.readFileSync(run.diag,"utf8").includes('"event":"ledger-open"')) return;
      await sleep(100);
    }
    throw Error("Synthetic POS startup timed out.");
  }
  async function killOwned(run) {
    if(run.child.exitCode===null && run.child.signalCode===null && !run.child.kill("SIGKILL"))
      throw Error("Unable to terminate the owned synthetic child.");
    return run.exited;
  }
  async function scenario(reverse) {
    const dir=fs.mkdtempSync(w.join(root,reverse?"B-first-":"A-first-"));
    const a=w.join(dir,"A"),b=w.join(dir,"B");fs.mkdirSync(a);fs.mkdirSync(b);
    const firstProfile=reverse?b:a,secondProfile=reverse?a:b;
    const first=launch(firstProfile);
    try {
      await ready(first);
      const second=launch(secondProfile);
      let timer;
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Second test process did not exit.")),15000)});
      let result;
      try{ result=await Promise.race([second.exited,timeout]); } finally { clearTimeout(timer); }
      if(first.child.exitCode!==null || result.code!==0 || fs.readdirSync(secondProfile).length!==0)
        throw Error("Lock test did not meet the synthetic refusal conditions.");
      const stopped=await killOwned(first);
      const restart=launch(secondProfile);
      try { await ready(restart); await killOwned(restart); }
      finally {if(restart.child.exitCode===null&&restart.child.signalCode===null)await killOwned(restart);}
      return {order:reverse?"B-then-A":"A-then-B",secondExit:result.code,secondProfileEmpty:true,firstTermination:stopped.signal||stopped.code,restartOpened:true};
    } finally {if(first.child.exitCode===null&&first.child.signalCode===null)await killOwned(first);}
  }
  try {
    const cases=[await scenario(false),await scenario(true)];
    const result={cases,account:"alzabt-test",build:"5d7a165-dirty",fileAccessTrace:"NOT RUN",
      gracefulRelaunch:"NOT RUN",actualDemoMode:"NOT RUN",oldNewCompatibility:"NOT RUN",
      crossUserExclusion:"NOT RUN",o2:"OPEN"};
    fs.writeFileSync(w.join(root,"results.json"),JSON.stringify(result,null,2),{flag:"wx"});
    console.log(JSON.stringify(result,null,2));
  } finally {
    for(const child of started)if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
  }
}
if(require.main===module) run().catch((err)=>{console.error("STOP:",err.message);process.exitCode=1});
module.exports={parseWhoami,validatePrincipal,validateContext};
