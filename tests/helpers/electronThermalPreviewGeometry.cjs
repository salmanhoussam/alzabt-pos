
/* Synthetic standalone Electron geometry: no POS, databases, printer or Demo slots. */
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),cp=require("node:child_process");
const root=path.resolve(__dirname,"../.."),candidate="C:/dev/alzabt-agent-collaboration/J1-PREVIEW-CANDIDATE-2026-11-20";
if(!process.versions.electron){
  if(process.argv[2]!=="--run"||process.argv.slice(3).some(a=>a!=="--integrated")||process.argv.length>4)throw Error("Use --run [--integrated] for synthetic geometry only.");
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"alzabt-preview-geometry-"));
  for(const d of ["roaming","local","runtime"])fs.mkdirSync(path.join(tmp,d));
  const env={...process.env,APPDATA:path.join(tmp,"roaming"),LOCALAPPDATA:path.join(tmp,"local"),USERPROFILE:tmp,
    SYNTHETIC_GEOMETRY_HOME:tmp,NODE_PATH:path.join(root,"node_modules")};
  delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const exe=path.join(root,"node_modules/electron/dist/electron.exe");
  const r=cp.spawnSync(exe,[__filename,"--worker",...(process.argv.includes("--integrated")?["--integrated"]:[]),"--user-data-dir="+path.join(tmp,"runtime")],{cwd:root,env,encoding:"utf8",timeout:60000,windowsHide:true});
  if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);
  if(r.error)throw r.error;process.exitCode=r.status===null?1:r.status;
}else{
  const {app,BrowserWindow,session}=require("electron");
  process.on("uncaughtException",(e)=>{console.error("FAIL synthetic geometry: "+e.message);app.exit(1)});
  const tmp=process.env.SYNTHETIC_GEOMETRY_HOME;
  if(process.argv[2]!=="--worker"||!tmp||!path.basename(tmp).startsWith("alzabt-preview-geometry-"))throw Error("Synthetic test home required.");
  app.setPath("userData",path.join(tmp,"runtime"));app.setPath("sessionData",path.join(tmp,"runtime"));
  app.commandLine.appendSwitch("disable-background-networking");
  const buildRoot=process.argv.includes("--integrated")?root:candidate;
  const {renderSaleReceiptDocument}=require(path.join(buildRoot,"dist/main/main/saleReceiptDocument.js"));
  // The geometry test never opens a ledger. Fail if that unused dependency is invoked.
  const profileModule=path.join(buildRoot,"dist/main/main/demoProfile.js");
  require.cache[profileModule]={id:profileModule,filename:profileModule,loaded:true,exports:{syntheticLedgerProfile:()=>{throw Error("Ledger access forbidden in geometry test")}}};
  const {markSyntheticPreview,frameSyntheticPreview}=require(path.join(buildRoot,"dist/main/main/demoPreview.js"));
  const money={minor:"1523",currency:"USD"};
  const receipt={sale:{receiptNumber:1,completedAt:"2026-11-20T00:00:00Z",cashierName:"Synthetic",sourceType:"pos",
    paymentStatus:"paid",paymentMethod:"cash",externalPayment:null,total:money,
    lines:[{lineNo:1,productName:"Synthetic product",sku:null,quantityMilli:1000,unitPrice:money,lineTotal:money}]},
    customerName:null,advanceApplied:null,void:null};
  app.whenReady().then(async()=>{
    session.defaultSession.webRequest.onBeforeRequest((d,done)=>done({cancel:!d.url.startsWith("data:")}));
    const w=new BrowserWindow({width:420,height:860,useContentSize:true,show:false,
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    try{
      const raw=renderSaleReceiptDocument({receipt,layout:"thermal80",copy:false,shopName:"Synthetic store",timeZone:"UTC"});
      const marked=markSyntheticPreview(raw),framed=frameSyntheticPreview(marked,"thermal80");
      async function measure(html){
        await w.loadURL("data:text/html;charset=utf-8;base64,"+Buffer.from(html).toString("base64"));
        return w.webContents.executeJavaScript("(()=>{const b=document.body.getBoundingClientRect();return {viewport:innerWidth,left:b.left,right:innerWidth-b.right,width:b.width,text:document.body.innerText,marks:document.querySelectorAll('[data-alzabt-demo-mark]').length};})()");
      }
      const before=await measure(marked),after=await measure(framed);
      const centred=Math.abs(after.left-after.right)<2,moved=before.left-after.left>25;
      const sameWidth=Math.abs(before.width-after.width)<1,sameText=before.text===after.text,watermarks=after.marks===2;
      const ok=centred&&moved&&sameWidth&&sameText&&watermarks&&frameSyntheticPreview(marked,"a5")===marked;
      console.log(JSON.stringify({status:ok?"PASS":"FAIL",before:{left:before.left,right:before.right,width:before.width},
        after:{left:after.left,right:after.right,width:after.width},sameWidth,sameText,watermarks,
        noPrinterOrPdf:true,realPosLaunched:false,demoSlotsConsumed:0},null,2));
      w.destroy();app.exit(ok?0:1);
    }catch(e){console.error("FAIL synthetic geometry: "+e.message);w.destroy();app.exit(1)}
  }).catch(e=>{console.error(e.message);app.exit(1)});
}