/** Local synthetic journey probe. This module is excluded from distribution.
 * It is observation/test code only: no K, paths or credentials reach the renderer. */
import {app,BrowserWindow} from "electron";
import {existsSync,lstatSync,readFileSync,realpathSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import type {openSyntheticDevEnvironment} from "./demoDevEntry";
import {syntheticBuildAllowed} from "./syntheticBuild";
type Environment=ReturnType<typeof openSyntheticDevEnvironment>;
const PREFIX="--alzabt-synthetic-journey=";
export function journeyFlag(args:readonly string[]):string|null {
  const flags=args.filter(x=>x.startsWith(PREFIX));
  return flags.length===1 && /^[a-f0-9]{32}$/.test(flags[0]!.slice(PREFIX.length))?flags[0]!:null;
}
function location(env:Environment,flag:string):string {
  const id=flag.slice(PREFIX.length), base=dirname(env.entry), dir=resolve(join(base,"journey-"+id));
  const stat=lstatSync(dir), marker=join(dir,".synthetic-journey");
  if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(dir).toLowerCase()!==dir.toLowerCase())throw Error("Probe unavailable");
  const m=lstatSync(marker);
  if(!m.isFile()||m.isSymbolicLink()||readFileSync(marker,"utf8")!==id)throw Error("Probe unavailable");
  return dir;
}
export function runSyntheticJourneyProbe(win:BrowserWindow,env:Environment,mode:"real"|"demo"|"unavailable"):void {
  if(!syntheticBuildAllowed() || !app.hasSingleInstanceLock())return;
  const flag=journeyFlag(process.argv);if(!flag)return;
  let dir:string;
  try{dir=location(env,flag)}catch{return}
  const write=(name:string,result:Record<string,unknown>)=>writeFileSync(join(dir,name),JSON.stringify(result),{encoding:"utf8",flag:"wx"});
  const finish=(name:string,result:Record<string,unknown>)=>{try{write(name,result)}catch{};app.quit()};
  if(mode==="unavailable"){finish("failure.json",{status:"FAIL",stage:"seed"});return}
  win.webContents.once("did-finish-load",()=>{
    if(mode==="real" && existsSync(join(dir,"demo.json"))) {
      const code='(async()=>{const e=await window.pos.getEntryState(),c=await window.pos.currentCashier();return !!e.ok&&e.data.profile==="real"&&!!c.ok&&c.data===null;})()';
      void win.webContents.executeJavaScript(code).then((ok:unknown)=>finish("done.json",{status:ok===true?"PASS":"FAIL",syntheticEntryReturned:ok===true})).catch(()=>finish("failure.json",{status:"FAIL",stage:"entry-return"}));
      return;
    }
    if(mode==="real") {
      try{write("entry.json",{status:"CONFIRM_ENTER"})}catch{app.quit();return}
      const code='(async()=>{const r=await window.pos.requestDemoLifecycle({action:"enter"});return !!r.ok&&r.data.status==="restarting";})()';
      void win.webContents.executeJavaScript(code).then((ok:unknown)=>{if(ok!==true)finish("failure.json",{status:"FAIL",stage:"enter-cancelled"})}).catch(()=>finish("failure.json",{status:"FAIL",stage:"enter"}));
      return;
    }
    const code=`(async()=>{
      const p=window.pos,e=await p.getEntryState(),c=await p.currentCashier(),catalog=await p.getCatalog();
      if(!e.ok||e.data.profile!=="demo"||!c.ok||!c.data||!catalog.ok||catalog.data.products.length!==22)return {ok:false,stage:"startup"};
      const categories=await p.listCategories();
      if(!categories.ok||categories.data.length!==8)return {ok:false,stage:"categories"};
      const metadata=await Promise.all(catalog.data.products.map(x=>p.getProductImageMeta({productId:x.id})));
      if(metadata.some((m,i)=>!m.ok||!m.data||m.data.productId!==catalog.data.products[i].id))return {ok:false,stage:"images"};
      const item=catalog.data.products[0];
      const sale=await p.createSale({idempotencyKey:"synthetic-journey-0001",lines:[{productId:item.id,quantityMilli:1000}],paymentMethod:"cash",expectedTotalMinor:item.price.minor});
      if(!sale.ok)return {ok:false,stage:"sale"};
      const history=await p.getSaleHistory({limit:20}),receipt=await p.getSaleReceipt({saleId:sale.data.sale.id});
      const preview=await p.printSaleReceipt({saleId:sale.data.sale.id,layout:"thermal80",copy:false});
      const draft=await p.createInvoiceDraft();
      if(!draft.ok)return {ok:false,stage:"invoice-draft"};
      const invoiceId=draft.data.invoice.id;
      const line=await p.addInvoiceLine({invoiceId,line:{description:"Synthetic",unitLabel:"piece",canonicalUnit:null,productId:null,quantity:"1",unitPrice:"1.00"}});
      if(!line.ok)return {ok:false,stage:"invoice-line"};
      const issued=await p.finalizeInvoice({invoiceId});
      if(!issued.ok||issued.data.invoice.invoiceNumber!==1001||!issued.data.invoice.issuer?.logoAsset)return {ok:false,stage:"invoice-final"};
      const invoicePreview=await p.printInvoice({invoiceId});
      const backup=await p.exportBackup(),picker=await p.pickInvoiceLogo(),phone=await p.startPhoneSession({action:"NEW_PRODUCT"});
      const pdf=await p.saveSaleReceiptPdf({saleId:sale.data.sale.id,layout:"thermal80",copy:false}),invoicePdf=await p.saveInvoicePdf({invoiceId});
      const denied=[backup,picker,phone,pdf,invoicePdf].every(x=>!x.ok&&x.error.code==="DEMO_RESTRICTED");
      return {ok:!!history.ok&&history.data.some(x=>x.sale.id===sale.data.sale.id)&&!!receipt.ok&&!!preview.ok&&preview.data.status==="previewed"&&!!invoicePreview.ok&&invoicePreview.data.status==="previewed"&&denied,
        products:22,images:22,categories:8,sale:!!sale.ok,receipt:!!receipt.ok,preview:!!preview.ok&&preview.data.status==="previewed",invoice:true,invoicePreview:true,externalBlocked:denied};
    })()`;
    void win.webContents.executeJavaScript(code).then((result:unknown)=>{
      const r=result as Record<string,unknown>;
      if(!r||r.ok!==true){finish("failure.json",{status:"FAIL",stage:typeof r?.stage==="string"?r.stage:"demo-ipc"});return}
      const previews=BrowserWindow.getAllWindows().filter(w=>w!==win && w.webContents.getURL().startsWith("data:text/html"));
      let watermarked=0,logo=false;
      for(const preview of previews) {
        const url=preview.webContents.getURL();
        const body=Buffer.from(url.slice(url.indexOf(",")+1),"base64").toString("utf8");
        if((body.match(/data-alzabt-demo-mark/g)||[]).length===2)watermarked++;
        if(body.includes("data:image/png;base64,"))logo=true;
        preview.close();
      }
      if(watermarked!==2||!logo){finish("failure.json",{status:"FAIL",stage:"watermark-or-logo"});return}
      try{write("demo.json",{status:"CONFIRM_EXIT",products:22,images:22,categories:8,sale:true,receipt:true,preview:true,invoice:true,invoicePreview:true,logo:true,watermarked:true,externalBlocked:true})}
      catch{app.quit();return}
      const exit='(async()=>{const r=await window.pos.requestDemoLifecycle({action:"exit"});return !!r.ok&&r.data.status==="restarting";})()';
      void win.webContents.executeJavaScript(exit).then((ok:unknown)=>{if(ok!==true)finish("failure.json",{status:"FAIL",stage:"exit-cancelled"})}).catch(()=>finish("failure.json",{status:"FAIL",stage:"exit"}));
    }).catch(()=>finish("failure.json",{status:"FAIL",stage:"demo-ipc"}));
  });
}