/* Offline, read-only staged C2 asset verification against a synthetic POS ledger. */
const fs=require("node:fs");
const path=require("node:path");
if (process.versions.electron) {
  const {app,session,nativeImage,BrowserWindow}=require("electron");
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
  const {verifyDemoSeedReadback}=mod("main/demoSeedReadback.js");
  const {electronCodec}=mod("main/productPhoto.js");
  const {CatalogRepository}=mod("persistence/catalogRepository.js");
  const {CategoryRepository}=mod("persistence/categoryRepository.js");
  const {ProductImageRepository}=mod("persistence/productImageRepository.js");
  const {OperatorRepository}=mod("persistence/operatorRepository.js");
  const {CompanyProfileRepository}=mod("persistence/companyProfileRepository.js");
  const {SCRYPT}=mod("application/cashierAuth.js");
  const {assertValidPin}=mod("domain/pinRule.js");
  const {parseDecimal}=mod("domain/money.js");
  function pin(){for(;;){const p=String(randomInt(100000,1000000));try{assertValidPin(p);return p}catch{}}}
  app.whenReady().then(async()=>{
    session.defaultSession.webRequest.onBeforeRequest((_,done)=>done({cancel:true}));
    let db;
    try {
      const parent=path.join(root,"profile-parent");fs.mkdirSync(parent);
      const reservation=reserveSyntheticDemoProfile(createSyntheticDemoRoot(parent));
      if(process.env.SYNTHETIC_STARTUP_MODE!=="0") {
        const stage="C:\\dev\\alzabt-agent-collaboration\\c2-demo-assets-staging-2026-11-18";
        const asset=(relative)=>fs.readFileSync(path.join(stage,...relative.split("/")));
        const {startReservedSyntheticDemo}=mod("main/demoSyntheticStartup.js");
        let startupReservation=reservation;
        if(process.env.SYNTHETIC_STARTUP_MODE==="handover") {
          const {DemoLaunchRecords}=mod("main/demoLaunchRecords.js");
          const {isFreshSyntheticReservation,adoptVerifiedSyntheticReservation}=mod("main/demoProfile.js");
          const control=path.join(parent,"control");fs.mkdirSync(control);
          const records=new DemoLaunchRecords(control);
          const id="slot-"+reservation.slot+"/"+path.basename(reservation.path);
          const issued=records.prepare("enter",id,Date.now());
          const proof=records.consume(issued.nonce,issued.key,Date.now(),(candidate)=>isFreshSyntheticReservation(path.join(parent,"synthetic-demo-root-v1"),candidate));
          if(!proof)throw Error("synthetic handover rejected");
          startupReservation=adoptVerifiedSyntheticReservation(path.join(parent,"synthetic-demo-root-v1"),proof).reservation;
          if(records.consume(issued.nonce,issued.key,Date.now(),()=>true))throw Error("synthetic handover replay accepted");
        }
        const bad=process.env.SYNTHETIC_STARTUP_MODE==="fail";
        let started;
        try {
          const {loadSyntheticDemoAssets}=mod("main/demoAssets.js");
          const assets=loadSyntheticDemoAssets();
          started=startReservedSyntheticDemo(startupReservation,{...assets,
            sourceImage:(sku)=>{const data=assets.sourceImage(sku);if(bad && sku==="COF-LAT")data[data.length-1]^=1;return data},
          });
        } catch(e) {
          if(!bad)throw e;
          let retryRejected=false;try{startReservedSyntheticDemo(startupReservation,{})}catch{retryRejected=true}
          if(!retryRejected)throw Error("failed reservation reused");
          process.stdout.write("REPORT:"+JSON.stringify({startupPartialFailureRejected:true,retryRejected:true,sessionIssued:false})+"\n",()=>app.exit(0));
          return;
        }
        if(bad)throw Error("corrupt startup was accepted");
        db=started.db;
        if(started.services.service.currentCashier()?.id!=="cashier-01" || started.services.service.currentRole()!=="owner")throw Error("startup owner session");
        const count=(table)=>Number(db.prepare("SELECT count(*) AS n FROM "+table).get().n);
        if(count("catalog_products")!==22 || count("catalog_product_images")!==22 || count("catalog_categories")!==8)throw Error("startup counts");
        let retryRejected=false;try{startReservedSyntheticDemo(startupReservation,{})}catch{retryRejected=true}
        if(!retryRejected || !db.open)throw Error("reservation reuse not rejected safely");
        started.services.service.logout();db.close();
        process.stdout.write("REPORT:"+JSON.stringify({singleReservedStartup:true,handoverVerified:process.env.SYNTHETIC_STARTUP_MODE==="handover",products:22,images:22,categories:8,ownerSessionAfterVerifiedSeed:true,reuseRejected:true})+"\n",()=>app.exit(0));
        return;
      }
      db=openNewSyntheticDemoLedger(reservation);
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
      if(process.env.SYNTHETIC_BOOTSTRAP_MODE!=="0") {
        const stage="C:\\dev\\alzabt-agent-collaboration\\c2-demo-assets-staging-2026-11-18";
        const asset=(relative)=>fs.readFileSync(path.join(stage,...relative.split("/")));
        const {bootstrapSyntheticSeed}=mod("main/demoSeedBootstrap.js");
        const bad=process.env.SYNTHETIC_BOOTSTRAP_MODE==="fail";
        let normal;
        try {
          normal=bootstrapSyntheticSeed(db,setup.takeSeedAuthority(),{
            csv:asset("catalog/demo-22-import.csv"),mapping:asset("catalog/product-image-mapping.json"),
            manifest:asset("config/demo-media-manifest.json"),logo:asset("config/demo-logo.png"),
            profile:fs.readFileSync("C:\\\\dev\\\\alzabt-agent-collaboration\\\\c2-demo-company-defaults-2026-11-19\\\\config\\\\demo-profile.json"),ownerPin,codec:electronCodec(nativeImage),
            sourceImage:(sku)=>{const data=asset("images/"+sku+".jpg");if(bad && sku==="COF-LAT")data[data.length-1]^=1;return data},
          });
        } catch(e) {
          if(!bad || db.open)throw e;
          process.stdout.write("REPORT:"+JSON.stringify({bootstrapPartialFailureRejected:true,dbClosed:true,sessionIssued:false})+"\n",()=>app.exit(0));
          return;
        }
        if(bad)throw Error("corrupt bootstrap was accepted");
        if(normal.service.currentCashier()?.id!=="cashier-01" || normal.service.currentRole()!=="owner")throw Error("bootstrap login failed");
        const count=(table)=>Number(db.prepare("SELECT count(*) AS n FROM "+table).get().n);
        if(count("catalog_products")!==22 || count("catalog_product_images")!==22 || count("catalog_categories")!==8)throw Error("bootstrap counts");
        const {createIpcHandlers}=mod("main/ipcHandlers.js");
        const {invokeWithDemoPolicy,restrictDemoIpcOptions}=mod("main/demoPolicy.js");
        let forbiddenBackupCalls=0;
        const handlers=createIpcHandlers(normal.service,restrictDemoIpcOptions({invoices:normal.invoices,dailyMoney:normal.dailyMoney,
          advances:normal.advanceService,saleReceipts:normal.saleReceiptService,afterSale:()=>{forbiddenBackupCalls++}}));
        const daily=invokeWithDemoPolicy("demo","getDailyMoney",()=>handlers.getDailyMoney({}));
        if(!daily.ok)throw Error("synthetic daily money failed");
        const companyEdit={nameAr:"Synthetic editable",nameEn:"Demo",legalName:null,tagline:null,address:null,phone1:null,phone2:null,email:null,
          logoPath:"synthetic-demo-logo.png",taxpayerNumber:null,commercialRegister:null,vatNumber:null,taxEnabled:false,taxRatePercent:null,taxLabel:null};
        const edit=invokeWithDemoPolicy("demo","saveCompanyProfile",()=>handlers.saveCompanyProfile(companyEdit),companyEdit);
        if(!edit.ok)throw Error("synthetic company edit failed");
        let unsafeCalled=false;
        const denied=invokeWithDemoPolicy("demo","saveCompanyProfile",()=>{unsafeCalled=true;return {ok:true}},{...companyEdit,logoPath:"../bad.png"});
        if(denied.ok || unsafeCalled)throw Error("unsafe synthetic company edit passed");
        const category=invokeWithDemoPolicy("demo","createCategory",()=>handlers.createCategory({nameAr:"Synthetic category",nameEn:null}));
        if(!category.ok)throw Error("synthetic category create failed");
        const product=invokeWithDemoPolicy("demo","createProduct",()=>handlers.createProduct({draft:{nameAr:"Synthetic item",nameEn:null,sku:"SYNTHETIC-NEW",price:"2.00",baseUnit:"piece"}}));
        if(!product.ok)throw Error("synthetic product create failed");
        const edited=invokeWithDemoPolicy("demo","updateProduct",()=>handlers.updateProduct({id:product.data.id,
          draft:{nameAr:"Synthetic item",nameEn:null,sku:"SYNTHETIC-NEW",price:"2.50",baseUnit:"piece"},isActive:true}));
        if(!edited.ok || edited.data.price.minor!=="250")throw Error("synthetic product edit failed");
        const sale=invokeWithDemoPolicy("demo","createSale",()=>handlers.createSale({
          idempotencyKey:"synthetic-sale-key-0001",lines:[{productId:product.data.id,quantityMilli:1000}],
          paymentMethod:"cash",expectedTotalMinor:"250"}));
        if(!sale.ok || forbiddenBackupCalls!==0)throw Error("synthetic sale failed or called backup");
        const receipt=invokeWithDemoPolicy("demo","getSaleReceipt",()=>handlers.getSaleReceipt({saleId:sale.data.sale.id}));
        if(!receipt.ok)throw Error("synthetic receipt read failed");
        const history=invokeWithDemoPolicy("demo","getSaleHistory",()=>handlers.getSaleHistory({limit:20}));
        if(!history.ok || !history.data.some((row)=>row.sale.id===sale.data.sale.id))throw Error("synthetic sale history failed");
        const draft=normal.invoices.createDraft();
        normal.invoices.addLine(draft.invoice.id,{description:"Synthetic",unitLabel:"piece",quantity:"1",unitPrice:"1.00",productId:null});
        normal.invoices.finalizeInvoice(draft.invoice.id);
        const issued=normal.invoices.getInvoice(draft.invoice.id).invoice;
        const issuer=JSON.parse(issued.issuer_snapshot_json);
        if(Number(issued.invoice_number)!==1001 || Number(issued.tax_minor)!==0)throw Error("approved company invoice defaults not applied");
        const expectedLogo="ce5f0cfbc9e5ad6a275c815b966f3d8b4a47b5c903f299addb2b6d9bdd648881";
        const expectedName=expectedLogo.slice(0,32)+".png";
        if(issuer.logo_asset!==expectedName)throw Error("invoice did not freeze the approved demo logo");
        const frozen=fs.readFileSync(path.join(reservation.path,"branding","frozen",expectedName));
        if(createHash("sha256").update(frozen).digest("hex")!==expectedLogo || nativeImage.createFromBuffer(frozen).isEmpty())throw Error("frozen logo mismatch");
        // Keep this synthetic test app alive when a preview window closes.
        const keeper=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:false}});
        const {openSyntheticDemoPreview}=mod("main/demoPreview.js");
        const {renderInvoiceDocument}=mod("main/invoiceDocument.js");
        const {renderSaleReceiptDocument}=mod("main/saleReceiptDocument.js");
        const {toInvoiceViewDto}=mod("shared/dto.js");
        const {createSyntheticPreviewPorts}=mod("main/demoPreviewPorts.js");
        const previewPorts=createSyntheticPreviewPorts(db,normal.invoices,false);
        let unsafePrinterCalls=0;
        const stripped=restrictDemoIpcOptions({invoices:normal.invoices,saleReceipts:normal.saleReceiptService,
          printInvoice:async()=>{unsafePrinterCalls++;return {status:"printed",logoMissing:false,logoUnverified:false}}});
        const previewHandlers=createIpcHandlers(normal.service,{...stripped,
          printInvoice:previewPorts.printInvoice,printSaleReceipt:previewPorts.printSaleReceipt});
        const invoiceResponse=await invokeWithDemoPolicy("demo","printInvoice",()=>previewHandlers.printInvoice({invoiceId:draft.invoice.id}));
        if(!invoiceResponse.ok || invoiceResponse.data.status!=="previewed" || unsafePrinterCalls)throw Error("invoice preview route failed");
        const invoicePreview=previewPorts.windows()[0];
        if(!invoicePreview)throw Error("invoice preview window missing");
        const previewUrl=invoicePreview.webContents.getURL();
        if(!previewUrl.startsWith("data:text/html"))throw Error("preview URL unavailable");
        const previewBody=Buffer.from(previewUrl.slice(previewUrl.indexOf(",")+1),"base64").toString("utf8");
        if((previewBody.match(/data-alzabt-demo-mark/g)||[]).length!==2 || !previewBody.includes("data:image/png;base64,"))
          throw Error("preview source watermark or logo missing");
        const invoiceCapture=await invoicePreview.webContents.capturePage();
        if(invoiceCapture.isEmpty())throw Error("invoice preview capture empty");
        const countMarks=async(win)=>{
          const debuggerPort=win.webContents.debugger;
          debuggerPort.attach("1.3");
          try{
            const tree=await debuggerPort.sendCommand("DOM.getDocument",{depth:0});
            const found=await debuggerPort.sendCommand("DOM.querySelectorAll",{nodeId:tree.root.nodeId,selector:"[data-alzabt-demo-mark]"});
            return found.nodeIds.length;
          } finally {debuggerPort.detach()}
        };
        const invoiceMarks=await countMarks(invoicePreview);
        invoicePreview.destroy();
        if(invoiceMarks!==2)throw Error("invoice watermark missing");
        const noLogoHtml=renderInvoiceDocument(toInvoiceViewDto(normal.invoices.getInvoice(draft.invoice.id)),{logoUrl:null});
        const noLogoPreview=await openSyntheticDemoPreview(db,noLogoHtml,"a4",false);
        const noLogoCapture=await noLogoPreview.webContents.capturePage();
        noLogoPreview.destroy();
        if(noLogoCapture.isEmpty() || invoiceCapture.toBitmap().equals(noLogoCapture.toBitmap()))throw Error("invoice logo had no rendered pixel effect");
        const receiptResponse=await invokeWithDemoPolicy("demo","printSaleReceipt",()=>previewHandlers.printSaleReceipt({
          saleId:sale.data.sale.id,layout:"thermal80",copy:false}));
        if(!receiptResponse.ok || receiptResponse.data.status!=="previewed" || unsafePrinterCalls)throw Error("receipt preview route failed");
        const pdf=invokeWithDemoPolicy("demo","saveInvoicePdf",()=>{unsafePrinterCalls++;return {ok:true}});
        if(pdf.ok || unsafePrinterCalls)throw Error("synthetic PDF route not denied");
        const receiptPreview=previewPorts.windows()[0];
        if(!receiptPreview)throw Error("receipt preview window missing");
        const receiptCapture=await receiptPreview.webContents.capturePage();
        const receiptMarks=await countMarks(receiptPreview);
        receiptPreview.destroy();
        if(receiptCapture.isEmpty() || receiptMarks!==2)throw Error("receipt watermark missing");
        normal.service.logout();db.close();
        process.stdout.write("REPORT:"+JSON.stringify({bootstrapCompleted:true,products:22,images:22,categories:8,sessionAfterVerifiedSeed:true,companyTextEdit:true,dailyMoney:true,unsafeLogoDenied:true,syntheticProductCategoryEdit:true,saleReceiptHistory:true,afterSaleBackupBlocked:true,invoiceFinalized:true,firstInvoiceNumber:1001,taxDisabled:true,frozenLogoVerified:true,invoicePreviewCapture:true,receiptPreviewCapture:true,previewOnlyIpc:true,pdfDenied:true})+"\n",()=>app.exit(0));
        return;
      }
      const writer=createSyntheticSeedAssembly(setup.takeSeedAuthority(),db);
      const stage="C:\\dev\\alzabt-agent-collaboration\\c2-demo-assets-staging-2026-11-18";
      const sumsPath=path.join(stage,"SHA256SUMS.txt");
      const sha=(buf)=>createHash("sha256").update(buf).digest("hex");
      const expectedSums="13443277a0b8f4eaac335da372762190efe5c9fb1d6dce3062d21af331436a2a";
      const verifyStage=()=>{
        const bytes=fs.readFileSync(sumsPath);
        if(sha(bytes)!==expectedSums)throw Error("staged hash-list mismatch");
        const lines=bytes.toString("utf8").trim().split(/\r?\n/);
        if(lines.length!==33)throw Error("staged file count mismatch");
        const seen=new Set();
        for(const line of lines) {
          const match=/^([0-9a-f]{64})  ([A-Za-z0-9_./-]+)$/.exec(line);
          if(!match || match[2].split("/").some((p)=>p===".."||p==="."))throw Error("invalid staged entry");
          const file=path.join(stage,...match[2].split("/"));
          if(!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || seen.has(match[2]))throw Error("invalid staged file");
          seen.add(match[2]);
          if(sha(fs.readFileSync(file))!==match[1])throw Error("staged content mismatch");
        }
        if([...seen].filter((p)=>p.startsWith("images/")).length!==22)throw Error("staged image count mismatch");
      };
      verifyStage();
      const mapping=JSON.parse(fs.readFileSync(path.join(stage,"catalog","product-image-mapping.json"),"utf8"));
      const manifest=JSON.parse(fs.readFileSync(path.join(stage,"config","demo-media-manifest.json"),"utf8")).media;
      const credits=JSON.parse(fs.readFileSync(path.join(stage,"provenance","image-credits.json"),"utf8"));
      if(mapping.products.length!==22 || mapping.categoriesUsed.length!==8 || manifest.length!==22)throw Error("staged count mismatch");
      if(sha(fs.readFileSync(path.join(stage,"catalog","product-image-mapping.json")))!=="11f391fc76e5ff14d19131af24e38bed6e468fd418fa1889f41adfd77dc03d8b")throw Error("mapping hash mismatch");
      if(sha(fs.readFileSync(path.join(stage,"config","demo-media-manifest.json")))!=="6834b0a0e7e13bdbc71f05be162aaaa0c3a94fe218bc4b4dcdda8ce6b5858996")throw Error("manifest hash mismatch");
      const logo=fs.readFileSync(path.join(stage,"config","demo-logo.png"));
      if(sha(logo)!=="ce5f0cfbc9e5ad6a275c815b966f3d8b4a47b5c903f299addb2b6d9bdd648881" || nativeImage.createFromBuffer(logo).isEmpty())throw Error("logo hash/decode failed");
      // Synthetic test ledger only: use the same basename convention the POS renderer resolves.
      const brand=path.join(reservation.path,"branding");
      fs.mkdirSync(brand);
      const logoName="synthetic-demo-logo.png";
      const targetLogo=path.join(brand,logoName);
      fs.writeFileSync(targetLogo,logo,{flag:"wx"});
      const profileBytes=fs.readFileSync("C:\\\\dev\\\\alzabt-agent-collaboration\\\\c2-demo-company-defaults-2026-11-19\\\\config\\\\demo-profile.json");
      const shop=JSON.parse(profileBytes.toString("utf8")).shop;
      writer.saveCompanyProfile({...shop,logoPath:logoName});
      const company=new CompanyProfileRepository(db).find();
      if(!company || company.name_ar!==shop.nameAr || company.logo_path!==logoName)throw Error("logo profile association failed");
      const storedLogo=fs.readFileSync(path.join(brand,company.logo_path));
      if(sha(storedLogo)!==sha(logo) || nativeImage.createFromBuffer(storedLogo).isEmpty())throw Error("stored logo readback failed");
      const csv=fs.readFileSync(path.join(stage,"catalog","demo-22-import.csv"));
      if(sha(csv)!=="565102cb1801274494a8ea5f2523aa3551eb9dba87b9a9aa05f829f70359d7d9")throw Error("CSV hash mismatch");
      const expected=mapping.products.map((p)=>({sourceId:p.source_id,sku:p.sku}));
      if(new Set(expected.map((p)=>p.sourceId)).size!==22 || new Set(expected.map((p)=>p.sku)).size!==22)throw Error("duplicate staged identity");
      const result=writer.importCatalogCsv("synthetic-c2.csv",csv);
      const identities=verifyDemoImportedIdentities(csv,"USD",result,[...expected].reverse(),new CatalogRepository(db).listAll().reverse());
      const categories=new Map();
      for(const c of mapping.categoriesUsed){
        if(categories.has(c.key))throw Error("duplicate category");
        categories.set(c.key,writer.createCategory(c.name_ar,c.name_en));
      }
      const photoStore=new ProductImageRepository(db);
      const catalogStore=new CatalogRepository(db);
      const codec=electronCodec(nativeImage);
      const bySource=new Map(mapping.products.map((p)=>[p.source_id,p]));
      const saved=new Map();
      let checked=0;
      for(const [i,item] of identities.entries()){
        const product=bySource.get(item.sourceId);
        if(!product || product.csvDataRow!==i+1 || product.sku!==item.sku)throw Error("CSV identity mismatch");
        const category=categories.get(product.category);
        if(!category)throw Error("category mismatch");
        writer.updateProduct(item.productId,{nameAr:product.name_ar,nameEn:product.name_en || null,
          sku:item.sku,price:product.price,baseUnit:product.unit,master:{categoryId:category.id,barcode:product.barcode}},true);
        const name=item.sku+".jpg";
        if(product.image!=="images/"+name)throw Error("image association mismatch");
        const original=fs.readFileSync(path.join(stage,"images",name));
        const entry=manifest.filter((m)=>m.sku===item.sku || m.file===name);
        const credit=credits[item.sku];
        if(entry.length!==1 || !credit || entry[0].sha256!==product.sha256 ||
           entry[0].bytes!==product.bytes || original.length!==product.bytes ||
           entry[0].sourcePage!==product.sourcePage || entry[0].licence!==product.licence ||
           credit.source_page!==product.sourcePage || credit.licence!==product.licence)throw Error("provenance metadata mismatch");
        const normalized=verifyDemoProductMedia(item.sku,name,original,manifest,codec);
        if(i===0){
          const corrupted=Buffer.from(original);corrupted[corrupted.length-1]^=1;
          let rejected=false;try{verifyDemoProductMedia(item.sku,name,corrupted,manifest,codec)}catch{rejected=true}
          if(!rejected)throw Error("source integrity rejection failed");
        }
        writer.setProductPrimaryImage({productId:item.productId,bytes:normalized.bytes,mime:normalized.mime,
          widthPx:normalized.widthPx,heightPx:normalized.heightPx,origin:"desktop"});
        saved.set(item.productId,{normalized,product,category});
        checked++;
      }
      for(const item of identities){
        const {normalized,product,category}=saved.get(item.productId);
        const row=catalogStore.findById(item.productId);
        if(!row || row.source_key!==product.source_id || row.sku!==product.sku ||
           row.category_id!==category.id || row.name_ar!==product.name_ar ||
           row.name_en!==(product.name_en||null) || row.barcode!==product.barcode ||
           row.base_unit!==product.unit || row.currency!=="USD" || row.is_active!==1n ||
           row.selling_price_minor!==parseDecimal(product.price,"USD").minor)throw Error("product readback mismatch");
        const meta=photoStore.findPrimaryMeta(item.productId);
        const stored=meta?photoStore.readBytes(meta.id):null;
        verifyStoredDemoProductMedia(item.productId,normalized,meta,stored);
        const decoded=stored&&nativeImage.createFromBuffer(stored);
        if(!decoded || decoded.isEmpty() || decoded.getSize().width!==normalized.widthPx ||
          decoded.getSize().height!==normalized.heightPx)throw Error("stored decode failed");
      }
      const categoryStore=new CategoryRepository(db);
      for(const definition of mapping.categoriesUsed) {
        const savedCategory=categories.get(definition.key);
        const row=savedCategory && categoryStore.findById(savedCategory.id);
        if(!row || row.name_ar!==definition.name_ar || row.name_en!==definition.name_en ||
           row.is_active!==1)throw Error("category readback mismatch");
      }
      const count=(table)=>Number(db.prepare("SELECT count(*) AS n FROM "+table).get().n);
      if(checked!==22 || count("catalog_products")!==22 || count("catalog_product_images")!==22 ||
         count("catalog_categories")!==8)throw Error("unexpected database counts");
      const readbackInput={csv,profile:profileBytes,mapping:fs.readFileSync(path.join(stage,"catalog","product-image-mapping.json")),
        manifest:fs.readFileSync(path.join(stage,"config","demo-media-manifest.json")),
        sourceImage:(sku)=>fs.readFileSync(path.join(stage,"images",sku+".jpg")),
        logoName,codec};
      verifyDemoSeedReadback(db,readbackInput);
      let failuresRejected=0;
      const mustReject=(input)=>{let rejected=false;try{verifyDemoSeedReadback(db,input)}catch{rejected=true}
        if(!rejected)throw Error("expected readback refusal");failuresRejected++};
      mustReject({...readbackInput,logoName:"wrong-synthetic-logo.png"});
      mustReject({...readbackInput,mapping:Buffer.from("invalid")});
      mustReject({...readbackInput,sourceImage:()=>Buffer.from("invalid")});
      const rollback=Symbol("rollback");
      try{db.transaction(()=>{db.prepare("DELETE FROM catalog_product_images WHERE product_id=?").run(identities[0].productId);
        mustReject(readbackInput);throw rollback})()}catch(e){if(e!==rollback)throw e}
      try{db.transaction(()=>{db.prepare("UPDATE catalog_products SET sku=? WHERE id=?").run("BAD-SYNTHETIC",identities[0].productId);
        mustReject(readbackInput);throw rollback})()}catch(e){if(e!==rollback)throw e}
      try{db.transaction(()=>{db.prepare("UPDATE catalog_products SET category_id=? WHERE id=?").run(categories.get(mapping.categoriesUsed[1].key).id,identities[0].productId);
        mustReject(readbackInput);throw rollback})()}catch(e){if(e!==rollback)throw e}
      try{db.transaction(()=>{
        const p=photoStore.findPrimaryMeta(identities[0].productId);
        const bytes=Buffer.from(photoStore.readBytes(p.id));bytes[bytes.length-1]^=1;
        db.prepare("UPDATE catalog_product_images SET bytes=? WHERE id=?").run(bytes,p.id);
        mustReject(readbackInput);throw rollback})()}catch(e){if(e!==rollback)throw e}
      verifyDemoSeedReadback(db,readbackInput);
      verifyStage();
      if(process.env.SYNTHETIC_SEED_EXPECT_REJECTION==="1"){
        let rejected=false;
        try{writer.finish({...readbackInput,logoName:"wrong-synthetic-logo.png"},ownerPin)}catch{rejected=true}
        if(!rejected || db.open)throw Error("failed finish did not close");
        try{writer.finish(readbackInput,ownerPin);throw Error("retry unexpectedly accepted")}catch(e){
          if(e.message==="retry unexpectedly accepted")throw e;
        }
        process.stdout.write("REPORT:"+JSON.stringify({failedFinishRejected:true,dbClosed:true,retryRejected:true,sessionIssued:false})+"\n",()=>app.exit(0));
      } else {
        const normal=writer.finish(readbackInput,ownerPin);
        if(normal.service.currentCashier()?.id!=="cashier-01" || normal.service.currentRole()!=="owner")throw Error("owner session verification failed");
        let refused=false;try{writer.createCategory("must not write",null)}catch{refused=true}
        if(!refused || !db.open)throw Error("seed reference remains active or closed normal db");
        refused=false;try{writer.finish(readbackInput,ownerPin)}catch{refused=true}
        if(!refused || !db.open)throw Error("finish retry not rejected safely");
        normal.service.logout();
        if(normal.service.currentCashier()!==null)throw Error("logout failed");
        const afterLogout=invokeWithDemoPolicy("demo","createCategory",()=>handlers.createCategory({nameAr:"Must refuse",nameEn:null}));
        if(afterLogout.ok)throw Error("unauthenticated category write passed");
        const companyAfterLogout=invokeWithDemoPolicy("demo","saveCompanyProfile",()=>handlers.saveCompanyProfile(companyEdit),companyEdit);
        if(companyAfterLogout.ok)throw Error("unauthenticated company edit passed");
        db.close();
        process.stdout.write("REPORT:"+JSON.stringify({products:22,photosDecodedAfterStorage:22,categories:8,
          source:"staged-c2",manifest:"pinned-hash-and-recorded-metadata-not-legal-review",logoDecoded:true,logoBoundToSyntheticCompany:true,productionReadbackPassed:true,readbackFaultsRejected:failuresRejected,sessionIssuedAfterVerification:true,revokedWriterRefused:true})+"\n",()=>app.exit(0));
      }
    } catch(e) {
      if(db&&db.open)db.close();
      process.stderr.write("Synthetic media probe failed: "+(e instanceof Error?e.message:"unknown")+"\n",()=>app.exit(1));
    }
  }).catch(()=>app.exit(1));
} else {
  const {spawn}=require("node:child_process");
  const root=fs.mkdtempSync(path.join(process.cwd(),"node_modules","synthetic-c2-seed-"));
  for(const name of ["runtime","appdata","localappdata","temp"])fs.mkdirSync(path.join(root,name));
  const exe=path.join(process.cwd(),"node_modules","electron","dist","electron.exe");
  const env={...process.env,SYNTHETIC_MEDIA_PROBE_ROOT:root,SYNTHETIC_MEDIA_PROBE_REPO:process.cwd(),
    APPDATA:path.join(root,"appdata"),LOCALAPPDATA:path.join(root,"localappdata"),
    TEMP:path.join(root,"temp"),TMP:path.join(root,"temp"),
    SYNTHETIC_SEED_EXPECT_REJECTION:process.argv.includes("--reject-finish")?"1":"0",
    SYNTHETIC_BOOTSTRAP_MODE:process.argv.includes("--bootstrap-fail")?"fail":process.argv.includes("--bootstrap")?"ok":"0",
    SYNTHETIC_STARTUP_MODE:process.argv.includes("--handover")?"handover":process.argv.includes("--startup-fail")?"fail":process.argv.includes("--startup")?"ok":"0"};
  delete env.ELECTRON_RUN_AS_NODE;
  const cp=spawn(exe,["--user-data-dir="+path.join(root,"runtime"),"--disable-background-networking",__filename],
    {cwd:process.cwd(),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let out="",err="";
  cp.stdout.on("data",(x)=>{out+=x});cp.stderr.on("data",(x)=>{err+=x});
  cp.on("close",(code,signal)=>{
    console.log("Synthetic media probe directory:",root);
    process.stdout.write(out);process.stderr.write(err);
    if(code!==0 || signal || !out.includes("REPORT:") || err.includes("Synthetic media probe failed:"))process.exitCode=1;
  });
  cp.on("error",(err)=>{console.error(err.message);process.exitCode=1});
}
