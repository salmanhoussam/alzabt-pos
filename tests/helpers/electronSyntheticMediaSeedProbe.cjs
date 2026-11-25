/* Offline synthetic decode/storage probe. Not the approved C2 selection or provenance gate. */
const fs=require("node:fs");
const path=require("node:path");
if (process.versions.electron) {
  const {app,session,nativeImage}=require("electron");
  const {createHash,randomBytes,randomInt,scryptSync}=require("node:crypto");
  const root=process.env.SYNTHETIC_MEDIA_PROBE_ROOT;
  const repo=process.env.SYNTHETIC_MEDIA_PROBE_REPO;
  if(!root || !repo || !path.isAbsolute(root) || !path.isAbsolute(repo)) process.exit(2);
  app.setPath("userData",path.join(root,"runtime"));
  app.setPath("sessionData",path.join(root,"runtime"));
  app.commandLine.appendSwitch("disable-background-networking");
  const mod=(name)=>require(path.join(repo,"dist","main",name));
  const {createSyntheticDemoRoot,reserveSyntheticDemoProfile,openNewSyntheticDemoLedger}=mod("main/demoProfile.js");
  const {createSyntheticAccountSetup}=mod("main/demoSeedAccounts.js");
  const {createSyntheticSeedAssembly}=mod("main/demoSeedAssembly.js");
  const {verifyDemoImportedIdentities}=mod("main/demoSeedIdentity.js");
  const {verifyDemoProductMedia,verifyStoredDemoProductMedia}=mod("main/demoSeedMedia.js");
  const {electronCodec}=mod("main/productPhoto.js");
  const {CatalogRepository}=mod("persistence/catalogRepository.js");
  const {ProductImageRepository}=mod("persistence/productImageRepository.js");
  const {OperatorRepository}=mod("persistence/operatorRepository.js");
  const {SCRYPT}=mod("application/cashierAuth.js");
  const {assertValidPin}=mod("domain/pinRule.js");
  function pin(){for(;;){const p=String(randomInt(100000,1000000));try{assertValidPin(p);return p}catch{}}}
  app.whenReady().then(()=>{
    session.defaultSession.webRequest.onBeforeRequest((_,done)=>done({cancel:true}));
    let db;
    try {
      const parent=path.join(root,"profile-parent");fs.mkdirSync(parent);
      db=openNewSyntheticDemoLedger(reserveSyntheticDemoProfile(createSyntheticDemoRoot(parent)));
      const operators=new OperatorRepository(db);
      const ownerBoot=pin(), cashierBoot=pin(), ownerPin=pin();
      let cashierPin=pin();while(cashierPin===ownerPin)cashierPin=pin();
      for(const [id,credential] of [["cashier-01",ownerBoot],["cashier-02",cashierBoot]]){
        const salt=randomBytes(8).toString("hex");
        operators.setPin(id,salt,scryptSync(credential,Buffer.from(salt,"hex"),32,SCRYPT).toString("hex"),
          "2026-01-01",{mustResetPin:true});
      }
      const setup=createSyntheticAccountSetup(db,(id)=>id==="cashier-01"?ownerBoot:cashierBoot);
      setup.completeOwner({name:"Synthetic owner",pin:ownerPin});
      setup.completeCashier({name:"Synthetic cashier",pin:cashierPin});
      const writer=createSyntheticSeedAssembly(setup.takeSeedAuthority(),db);
      writer.saveCompanyProfile({nameAr:"Synthetic shop"});
      const dir=path.join(repo,"tests","fixtures","demo-catalog","images");
      const credits=JSON.parse(fs.readFileSync(path.join(repo,"tests","fixtures","demo-catalog","image-credits.json"),"utf8"));
      const names=fs.readdirSync(dir).filter((name)=>/^[A-Z0-9-]+[.]jpg$/.test(name)).sort().slice(0,22);
      if(names.length!==22)throw Error("not enough synthetic fixture photos");
      const expected=names.map((name,i)=>({sourceId:"probe-"+String(i+1).padStart(2,"0"),sku:name.slice(0,-4)}));
      const csvRows=[...expected].reverse();
      const csv=Buffer.from(["source_id,name_ar,name_en,price,currency,base_unit,price_needs_review",
        ...csvRows.map((row,i)=>row.sourceId+",Synthetic "+(i+1)+",Item "+(i+1)+",1.00,USD,piece,0")].join("\n"));
      const result=writer.importCatalogCsv("synthetic-probe.csv",csv);
      const identities=verifyDemoImportedIdentities(csv,"USD",result,expected,new CatalogRepository(db).listAll().reverse());
      const categories=Array.from({length:8},(_,i)=>writer.createCategory("Synthetic Category "+(i+1),null));
      const photoStore=new ProductImageRepository(db);
      const codec=electronCodec(nativeImage);
      let checked=0;
      for(const [i,item] of identities.entries()){
        const category=categories[i%8];
        writer.updateProduct(item.productId,{nameAr:"Synthetic "+(i+1),nameEn:"Item "+(i+1),
          sku:item.sku,price:"1.00",baseUnit:"piece",master:{categoryId:category.id}},true);
        const name=item.sku+".jpg";
        const original=fs.readFileSync(path.join(dir,name));
        const credit=credits[item.sku];
        if(!credit || !credit.source_page || !credit.licence)throw Error("missing fixture credit");
        const manifest=[{sku:item.sku,file:name,sha256:createHash("sha256").update(original).digest("hex"),
          sourcePage:credit.source_page,licence:credit.licence}];
        // The test derives its hash from the input. It does NOT prove provenance or approval.
        const normalized=verifyDemoProductMedia(item.sku,name,original,manifest,codec);
        writer.setProductPrimaryImage({productId:item.productId,bytes:normalized.bytes,mime:normalized.mime,
          widthPx:normalized.widthPx,heightPx:normalized.heightPx,origin:"desktop"});
        const meta=photoStore.findPrimaryMeta(item.productId);
        const stored=meta?photoStore.readBytes(meta.id):null;
        verifyStoredDemoProductMedia(item.productId,normalized,meta,stored);
        const decoded=stored&&nativeImage.createFromBuffer(stored);
        if(!decoded || decoded.isEmpty() || decoded.getSize().width!==normalized.widthPx ||
          decoded.getSize().height!==normalized.heightPx)throw Error("stored decode failed");
        if(new CatalogRepository(db).findById(item.productId)?.category_id!==category.id)throw Error("category mismatch");
        checked++;
      }
      const count=(table)=>Number(db.prepare("SELECT count(*) AS n FROM "+table).get().n);
      if(checked!==22 || count("catalog_products")!==22 || count("catalog_product_images")!==22 ||
         count("catalog_categories")!==8)throw Error("unexpected counts");
      writer.cancel(); if(db.open)throw Error("cancel did not close");
      process.stdout.write("REPORT:"+JSON.stringify({products:22,photosDecodedAfterStorage:22,categories:8,
        source:"synthetic-fixture-subset-not-approved-c2",manifest:"test-derived-not-provenance",sessionIssued:false})+"\n",()=>app.exit(0));
    } catch(e) {
      if(db&&db.open)db.close();
      process.stderr.write("Synthetic media probe failed: "+(e instanceof Error?e.message:"unknown")+"\n",()=>app.exit(1));
    }
  }).catch(()=>app.exit(1));
} else {
  const {spawn}=require("node:child_process");
  const root=fs.mkdtempSync(path.join(process.cwd(),"node_modules","synthetic-media-seed-"));
  for(const name of ["runtime","appdata","localappdata","temp"])fs.mkdirSync(path.join(root,name));
  const exe=path.join(process.cwd(),"node_modules","electron","dist","electron.exe");
  const env={...process.env,SYNTHETIC_MEDIA_PROBE_ROOT:root,SYNTHETIC_MEDIA_PROBE_REPO:process.cwd(),
    APPDATA:path.join(root,"appdata"),LOCALAPPDATA:path.join(root,"localappdata"),
    TEMP:path.join(root,"temp"),TMP:path.join(root,"temp")};
  delete env.ELECTRON_RUN_AS_NODE;
  const cp=spawn(exe,["--user-data-dir="+path.join(root,"runtime"),"--disable-background-networking",__filename],
    {cwd:process.cwd(),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let out="",err="";
  cp.stdout.on("data",(x)=>{out+=x});cp.stderr.on("data",(x)=>{err+=x});
  cp.on("exit",(code,signal)=>{
    console.log("Synthetic media probe directory:",root);
    process.stdout.write(out);process.stderr.write(err);
    if(code!==0 || signal)process.exitCode=1;
  });
  cp.on("error",(err)=>{console.error(err.message);process.exitCode=1});
}
