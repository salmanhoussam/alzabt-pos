/* Real Main -> Demo -> Main, synthetic account only. No debugger port or deletions. */
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const {spawn}=require("node:child_process");
const REPO="C:\\dev\\alzabt-pos-joint-codex";
const sha=crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
console.log("PROBE_SHA256="+sha);
if(process.platform!=="win32" || process.argv.length!==3 || process.argv[2]!=="--run") {
  console.error("STOP: run only in the synthetic test account with --run.");process.exitCode=1;
} else {
  const gate=require(path.join(REPO,"dist","main","main","demoDevGate.js"));
  if(!gate.verifiedSyntheticTestHome(false,true)) {
    console.error("STOP: test-account verification failed.");process.exitCode=1;
  } else {
    const base=path.join("C:\\Users\\alzabt-test\\AppData\\Local","Alzabt-Synthetic-Development");
    const stat=fs.lstatSync(base);
    if(stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(base).toLowerCase()!==path.resolve(base).toLowerCase())throw Error("Synthetic base unavailable");
    const id=crypto.randomBytes(16).toString("hex"),dir=path.join(base,"journey-"+id);
    fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,".synthetic-journey"),id,{encoding:"utf8",flag:"wx"});
    const env={...process.env,ALZABT_POS_DISABLE_AUTOSTART:"1"};
    for(const key of ["ELECTRON_RUN_AS_NODE","NODE_OPTIONS","DEBUG","PWDEBUG","ALZABT_POS_USER_DATA","ALZABT_POS_DIAG_LOG"])delete env[key];
    const exe=path.join(REPO,"node_modules","electron","dist","electron.exe");
    const child=spawn(exe,[REPO,"--alzabt-synthetic-dev","--alzabt-synthetic-journey="+id],
      {cwd:REPO,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    child.stdout.on("data",()=>{});child.stderr.on("data",()=>{});
    child.on("error",()=>{console.error("STOP: owned Electron could not launch.");process.exitCode=1;clearInterval(timer)});
    let entered=false,demo=false,finished=false,firstExited=false;
    child.on("close",()=>{firstExited=true});
    console.log("Synthetic test started. Confirm Enter and Exit in the application when requested.");
    const until=Date.now()+300000;
    const timer=setInterval(()=>{
      try {
        if(!entered && fs.existsSync(path.join(dir,"entry.json"))){entered=true;console.log("Please confirm Enter in the synthetic window.")}
        if(!demo && fs.existsSync(path.join(dir,"demo.json"))){demo=true;console.log("Demo IPC checks completed. Please confirm Exit in the synthetic window.")}
        const failed=path.join(dir,"failure.json"),done=path.join(dir,"done.json");
        if(fs.existsSync(failed)) {
          const r=JSON.parse(fs.readFileSync(failed,"utf8"));console.error("STOP: stage="+String(r.stage||"unknown"));process.exitCode=1;finished=true;
        } else if(fs.existsSync(done)) {
          const a=JSON.parse(fs.readFileSync(done,"utf8")),d=JSON.parse(fs.readFileSync(path.join(dir,"demo.json"),"utf8"));
          if(a.status!=="PASS"||d.status!=="CONFIRM_EXIT"||!d.watermarked||!d.externalBlocked)throw Error("Invalid result");
          console.log(JSON.stringify({status:"PASS",actualElectronMain:true,handover:true,products:d.products,images:d.images,
            categories:d.categories,sale:d.sale,receipt:d.receipt,preview:d.preview,invoice:d.invoice,invoicePreview:d.invoicePreview,logo:d.logo,watermarked:d.watermarked,
            blockedExternalOperations:d.externalBlocked,returnedToSyntheticEntry:true,actualNetworkTrace:"NOT RUN",
            customerUiJourney:"NOT RUN",o2:"OPEN"},null,2));finished=true;
        } else if(firstExited && !entered) {
          console.error("STOP: Electron exited before opening the synthetic entry.");process.exitCode=1;finished=true;
        } else if(Date.now()>until) {
          console.error("STOP: timed out. Close only the synthetic test window if it remains open.");process.exitCode=1;finished=true;
        }
      } catch {console.error("STOP: synthetic journey result unavailable.");process.exitCode=1;finished=true}
      if(finished)clearInterval(timer);
    },500);
  }
}