/* Test-account-only actual Electron Main/IPC probe. No debugging port or deletion. */
const fs=require("node:fs");
const path=require("node:path");
const {spawn}=require("node:child_process");
const REPO="C:\\dev\\alzabt-pos-joint-codex";
if(process.platform!=="win32" || process.argv.length!==3 || process.argv[2]!=="--run") {
  console.error("STOP: run only in the synthetic test account with --run.");process.exitCode=1;
} else {
  const gate=require(path.join(REPO,"dist","main","main","demoDevGate.js"));
  if(!gate.verifiedSyntheticTestHome(false,true)) {
    console.error("STOP: test-account verification failed.");process.exitCode=1;
  } else {
    const parent=fs.mkdtempSync(path.join("C:\\Users\\alzabt-test\\AppData\\Local","Alzabt-Synthetic-Main-Probe-"));
    const forbiddenOverride=path.join(parent,"must-not-create-profile");
    const forbiddenDiag=path.join(parent,"must-not-write-diagnostic.jsonl");
    const env={...process.env,ALZABT_POS_USER_DATA:forbiddenOverride,ALZABT_POS_DIAG_LOG:forbiddenDiag,ALZABT_POS_DISABLE_AUTOSTART:"1"};
    delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.DEBUG;delete env.PWDEBUG;
    const exe=path.join(REPO,"node_modules","electron","dist","electron.exe");
    const child=spawn(exe,[REPO,"--alzabt-synthetic-dev","--alzabt-synthetic-main-probe"],
      {cwd:REPO,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let out="",timedOut=false;
    child.stdout.on("data",(b)=>{if(out.length<65536)out+=b.toString("utf8")});
    child.stderr.on("data",()=>{});
    child.on("error",()=>{console.error("STOP: owned Electron could not launch.");process.exitCode=1});
    const timer=setTimeout(()=>{timedOut=true;child.kill()},65000);
    child.on("close",(code,signal)=>{
      clearTimeout(timer);
      const line=out.split(/\r?\n/).find((s)=>s.startsWith("SYNTHETIC_MAIN_PROBE:"));
      let report;
      try{report=JSON.parse(line.slice("SYNTHETIC_MAIN_PROBE:".length))}catch{}
      const ignored=!fs.existsSync(forbiddenOverride)&&!fs.existsSync(forbiddenDiag);
      if(timedOut || code!==0 || signal || report?.status!=="PASS" || !ignored){
        console.error("STOP: synthetic Main/IPC probe failed; no existing files were removed.");process.exitCode=1;return;
      }
      console.log(JSON.stringify({status:"PASS",actualElectronMain:true,syntheticEntry:true,untrustedExtraRejected:true,
        inheritedProfileIgnored:true,inheritedDiagnosticIgnored:true,debugControlPort:"NOT OPENED BY PROBE",
        demoHandover:"NOT RUN",seed:"NOT RUN",networkTrace:"NOT RUN",uiJourney:"NOT RUN",o2:"OPEN"},null,2));
    });
  }
}