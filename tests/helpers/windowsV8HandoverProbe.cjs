/*
 * Explicit local synthetic-account test. No POS UI, network, printer or real
 * profile. Parent and successor are owned Electron test processes. Never
 * print or persist one-time handover arguments. A fresh test root is retained.
 */
const fs=require("node:fs");
const path=require("node:path");
const REPO="C:\\dev\\alzabt-pos-joint-codex";
const BASE="C:\\Users\\alzabt-test\\AppData\\Local\\Alzabt-Synthetic-Development";
const compiled=(name)=>require(path.join(REPO,"dist","main","main",name+".js"));
if(!process.versions.electron) {
  if(process.platform!=="win32" || !process.argv.includes("--run")) {
    console.error("STOP: use --run only from the isolated test account.");process.exitCode=1;
  } else {
    const gate=compiled("demoDevGate").verifiedSyntheticTestHome(false,true);
    if(!gate){console.error("STOP: test-account verification failed.");process.exitCode=1;}
    else {
      const {spawn}=require("node:child_process");
      const exe=path.join(REPO,"node_modules","electron","dist","electron.exe");
      const env={...process.env,ALZABT_POS_DISABLE_AUTOSTART:"1"};
      delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.ALZABT_POS_USER_DATA;
      const child=spawn(exe,[__filename,"--parent"],{cwd:REPO,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
      child.stdout.on("data",(b)=>process.stdout.write(b));
      child.stderr.on("data",(b)=>process.stderr.write(b));
      child.on("error",()=>{console.error("STOP: test Electron could not launch.");process.exitCode=1});
      child.on("close",(code,signal)=>{if(code!==0 || signal)process.exitCode=1});
    }
  }
} else {
  const {app}=require("electron");
  let rootOwned=false;
  const safeResult=(value)=>{if(!rootOwned)return;try{fs.writeFileSync(path.join(BASE,"result.json"),JSON.stringify(value,null,2),{flag:"wx"})}catch{}};
  const stop=(reason)=>{console.error("STOP:",reason);app.exit(1)};
  const home=compiled("demoDevGate").verifiedSyntheticTestHome(app.isPackaged,true);
  if(!home)stop("test-account verification failed.");
  else if(!app.requestSingleInstanceLock())stop("test product lock unavailable.");
  else {
    const args=process.argv;
    const index=args.indexOf("--successor");
    if(index<0) {
      try {
        fs.mkdirSync(BASE); // exclusive: NEVER reuse or delete an existing root
        rootOwned=true;
        fs.mkdirSync(path.join(BASE,"control"));
        const {createSyntheticDemoRoot,reserveSyntheticDemoProfile}=compiled("demoProfile");
        const {DemoLaunchRecords}=compiled("demoLaunchRecords");
        const root=createSyntheticDemoRoot(BASE);
        const reserved=reserveSyntheticDemoProfile(root);
        const id="slot-"+reserved.slot+"/"+path.basename(reserved.path);
        const handover=new DemoLaunchRecords(path.join(BASE,"control")).prepare("enter",id,Date.now());
        // This synthetic parent owns no ledger. Release the owned lock before
        // scheduling the local-development successor, as required by V8.
        app.releaseSingleInstanceLock();
        app.relaunch({args:[__filename,"--successor",handover.nonce,handover.key]});
        console.log("Synthetic test committed. Check result.json under the new test-account directory.");
        app.exit(0);
      } catch {
        safeResult({status:"FAIL",stage:"parent",reason:"synthetic preparation failed"});
        stop("synthetic preparation failed; existing root was not removed.");
      }
    } else {
      try {
        const nonce=args[index+1],key=args[index+2];
        const {resolveVerifiedSyntheticHandover}=compiled("demoHandoverStartup");
        const {selectVerifiedDemoProfile,startSelectedSyntheticDemo}=compiled("demoRuntime");
        const resolved=resolveVerifiedSyntheticHandover(true,nonce,key,Date.now());
        if(resolved.kind!=="ready")throw Error("handover rejected");
        rootOwned=true;
        const selected=selectVerifiedDemoProfile(resolved.proof);
        app.whenReady().then(()=>{
          let started;
          try {
            started=startSelectedSyntheticDemo(selected);
            const profile=app.getPath("userData"),sessionData=app.getPath("sessionData");
            const fixed=path.resolve(BASE).toLowerCase()+path.sep;
            if(!path.resolve(profile).toLowerCase().startsWith(fixed) ||
               path.resolve(sessionData).toLowerCase()!==path.resolve(profile).toLowerCase() ||
               !path.resolve(started.db.name).toLowerCase().startsWith(path.resolve(profile).toLowerCase()+path.sep))
              throw Error("synthetic profile mismatch");
            const count=(table)=>Number(started.db.prepare("SELECT count(*) AS n FROM "+table).get().n);
            const counts={products:count("catalog_products"),images:count("catalog_product_images"),categories:count("catalog_categories")};
            if(counts.products!==22 || counts.images!==22 || counts.categories!==8 ||
               started.services.service.currentRole()!=="owner")throw Error("synthetic seed mismatch");
            const replay=resolveVerifiedSyntheticHandover(true,nonce,key,Date.now());
            if(replay.kind!=="real")throw Error("replay accepted");
            started.services.service.logout();started.db.close();
            safeResult({status:"PASS",handoverCommitted:true,oneTimeReplayRejected:true,profileBeforeLedger:true,
              oneReservedLedgerOpened:true,counts,ownerSessionAfterVerification:true,
              rendererNetworkBlockerInstalled:true,actualNetworkTrace:"NOT RUN",uiJourney:"NOT RUN",o2:"OPEN"});
            app.exit(0);
          } catch {
            if(started?.db?.open)started.db.close();
            safeResult({status:"FAIL",stage:"successor",reason:"synthetic startup verification failed"});
            stop("synthetic startup verification failed.");
          }
        }).catch(()=>{safeResult({status:"FAIL",stage:"ready"});stop("Electron was not ready.")});
      } catch {
        safeResult({status:"FAIL",stage:"handover",reason:"unverified handover"});
        stop("unverified synthetic handover.");
      }
    }
  }
}
