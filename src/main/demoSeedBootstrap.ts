/**
 * Main-only synthetic seed orchestration; not wired to startup or IPC.
 * Callers must prove the reserved profile is synthetic-only (O-2 remains open)
 * and supply reviewed asset bytes from an independently confined source.
 */
import { SYNTHETIC_DEMO_LOGO } from "./demoConstants";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../persistence/db";
import { CatalogRepository } from "../persistence/catalogRepository";
import { FIXTURE_TERMINAL } from "../fixtures/terminal";
import { syntheticLedgerProfile } from "./demoProfile";
import type { SyntheticSeedAuthority } from "./demoSeedAccounts";
import { createSyntheticSeedAssembly } from "./demoSeedAssembly";
import { verifyDemoImportedIdentities } from "./demoSeedIdentity";
import { verifyDemoProductMedia, type ReviewedDemoMedia } from "./demoSeedMedia";
import type { ImageCodec } from "./photoNormalize";

type Category = {key:string; name_ar:string; name_en:string};
type Product = {csvDataRow:number; source_id:string; sku:string; name_ar:string; name_en:string;
  category:string; price:string; unit:string; barcode:string; image:string; sha256:string; bytes:number;
  sourcePage:string; licence:string};
type Profile = {shop: {nameAr:string; nameEn:string; tagline:string; address:string; phone1:string}};
const sha = (b:Uint8Array):string => createHash("sha256").update(b).digest("hex");
const hashes = {
  csv:"565102cb1801274494a8ea5f2523aa3551eb9dba87b9a9aa05f829f70359d7d9",
  mapping:"11f391fc76e5ff14d19131af24e38bed6e468fd418fa1889f41adfd77dc03d8b",
  manifest:"6834b0a0e7e13bdbc71f05be162aaaa0c3a94fe218bc4b4dcdda8ce6b5858996",
  logo:"ce5f0cfbc9e5ad6a275c815b966f3d8b4a47b5c903f299addb2b6d9bdd648881",
  profile:"ae8f9975746cb906f587dfb3a6e5753c8e1361b1d52909fdcf4ab73077adf512",
} as const;

export function bootstrapSyntheticSeed(db:Db, authority:SyntheticSeedAuthority, input:{
  readonly csv:Buffer; readonly mapping:Buffer; readonly manifest:Buffer; readonly logo:Buffer;
  readonly profile:Buffer; readonly sourceImage:(sku:string)=>Buffer; readonly codec:ImageCodec;
  readonly ownerPin:string;
}) {
  const writer=createSyntheticSeedAssembly(authority,db);
  try {
    for(const key of ["csv","mapping","manifest","logo","profile"] as const) {
      if(!Buffer.isBuffer(input[key]) || sha(input[key])!==hashes[key]) throw new Error("asset hash mismatch");
    }
    if(input.codec.decode(input.logo).isEmpty()) throw new Error("logo decode failed");
    const mapping=JSON.parse(input.mapping.toString("utf8")) as {products:Product[]; categoriesUsed:Category[]};
    const manifest=(JSON.parse(input.manifest.toString("utf8")) as {media:ReviewedDemoMedia[]}).media;
    const profile=JSON.parse(input.profile.toString("utf8")) as Profile;
    if(mapping.products.length!==22 || mapping.categoriesUsed.length!==8 || manifest.length!==22) throw new Error("invalid counts");
    const expected=mapping.products.map((p)=>({sourceId:p.source_id,sku:p.sku}));
    const imported=writer.importCatalogCsv("synthetic-demo.csv",input.csv);
    const identities=verifyDemoImportedIdentities(input.csv,FIXTURE_TERMINAL.currency,imported,expected,new CatalogRepository(db).listAll());
    const categories=new Map<string,string>();
    for(const category of mapping.categoriesUsed) {
      if(categories.has(category.key)) throw new Error("duplicate category");
      categories.set(category.key,writer.createCategory(category.name_ar,category.name_en).id);
    }
    const bySource=new Map(mapping.products.map((p)=>[p.source_id,p]));
    for(const [i,identity] of identities.entries()) {
      const product=bySource.get(identity.sourceId);
      if(!product || product.csvDataRow!==i+1 || product.sku!==identity.sku ||
        product.image!=="images/"+identity.sku+".jpg") throw new Error("identity mismatch");
      const categoryId=categories.get(product.category);
      if(!categoryId) throw new Error("category mismatch");
      writer.updateProduct(identity.productId,{nameAr:product.name_ar,nameEn:product.name_en||null,
        sku:identity.sku,price:product.price,baseUnit:product.unit,
        master:{categoryId,barcode:product.barcode}},true);
      const source=input.sourceImage(identity.sku);
      if(source.length!==product.bytes) throw new Error("image size mismatch");
      const normalized=verifyDemoProductMedia(identity.sku,identity.sku+".jpg",source,manifest,input.codec);
      writer.setProductPrimaryImage({productId:identity.productId,bytes:normalized.bytes,mime:normalized.mime,
        widthPx:normalized.widthPx,heightPx:normalized.heightPx,origin:"desktop"});
    }
    const branding=join(syntheticLedgerProfile(db),"branding");
    mkdirSync(branding); // brand-new reserved profile; never reuse existing content
    const logoName=SYNTHETIC_DEMO_LOGO;
    writeFileSync(join(branding,logoName),input.logo,{flag:"wx"});
    writer.saveCompanyProfile({...profile.shop,logoPath:logoName});
    return writer.finish({csv:input.csv,mapping:input.mapping,manifest:input.manifest,profile:input.profile,
      sourceImage:input.sourceImage,logoName,codec:input.codec},input.ownerPin);
  } catch {
    writer.cancel();
    throw new Error("Synthetic demo bootstrap failed.");
  }
}
