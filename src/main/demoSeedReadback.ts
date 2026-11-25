/**
 * Independent readback only. This module issues no session or profile authority.
 * Caller must already hold the exact reserved synthetic Db and obtain assets
 * through a trusted Main-only adapter. The logo is read via the synthetic Db
 * profile binding. O-2 remains open.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { syntheticLedgerProfile } from "./demoProfile";
import { validateImport, decodeUtf8Strict } from "../domain/catalogImport";
import { parseDecimal } from "../domain/money";
import type { Db } from "../persistence/db";
import { CatalogRepository, CSV_SOURCE, productIdFor } from "../persistence/catalogRepository";
import { CategoryRepository } from "../persistence/categoryRepository";
import { CompanyProfileRepository } from "../persistence/companyProfileRepository";
import { ProductImageRepository } from "../persistence/productImageRepository";
import { verifyDemoProductMedia, verifyStoredDemoProductMedia, type ReviewedDemoMedia } from "./demoSeedMedia";
import type { ImageCodec } from "./photoNormalize";

const MAPPING_HASH = "11f391fc76e5ff14d19131af24e38bed6e468fd418fa1889f41adfd77dc03d8b";
const MANIFEST_HASH = "6834b0a0e7e13bdbc71f05be162aaaa0c3a94fe218bc4b4dcdda8ce6b5858996";
const CSV_HASH = "565102cb1801274494a8ea5f2523aa3551eb9dba87b9a9aa05f829f70359d7d9";
const PROFILE_HASH = "ae8f9975746cb906f587dfb3a6e5753c8e1361b1d52909fdcf4ab73077adf512";
const LOGO_HASH = "ce5f0cfbc9e5ad6a275c815b966f3d8b4a47b5c903f299addb2b6d9bdd648881";
type Category = {key:string; name_ar:string; name_en:string};
type Product = {csvDataRow:number; source_id:string; sku:string; name_ar:string; name_en:string;
  category:string; price:string; unit:string; barcode:string; image:string; sha256:string; bytes:number;
  sourcePage:string; licence:string};
type Mapping = {categoriesUsed:Category[]; products:Product[]};
const sha = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const fail = (): never => { throw new Error("Synthetic demo readback failed."); };

/** The exact approved assets are pinned by hash; failures never issue authority. */
export function verifyDemoSeedReadback(db: Db, input: {
  readonly csv: Buffer;
  readonly mapping: Buffer;
  readonly manifest: Buffer;
  readonly profile: Buffer;
  readonly sourceImage: (sku:string) => Buffer;
  readonly logoName: string;
  readonly codec: ImageCodec;
}): void {
  try {
    if (!db.open || sha(input.csv)!==CSV_HASH || sha(input.mapping)!==MAPPING_HASH ||
        sha(input.manifest)!==MANIFEST_HASH || sha(input.profile)!==PROFILE_HASH || !/^[A-Za-z0-9_-]+\.png$/.test(input.logoName)) fail();
    const branding=join(syntheticLedgerProfile(db),"branding");
    const dirStat=lstatSync(branding);
    const logoPath=join(branding,input.logoName);
    const logoStat=lstatSync(logoPath);
    if(dirStat.isSymbolicLink() || !dirStat.isDirectory() || logoStat.isSymbolicLink() || !logoStat.isFile()) fail();
    const storedLogo=readFileSync(logoPath);
    if(sha(storedLogo)!==LOGO_HASH || input.codec.decode(storedLogo).isEmpty()) fail();
    const mapping = JSON.parse(input.mapping.toString("utf8")) as Mapping;
    const manifest = (JSON.parse(input.manifest.toString("utf8")) as {media:ReviewedDemoMedia[]}).media;
    const parsed = validateImport(decodeUtf8Strict(input.csv), "USD");
    if (parsed.rejected.length || parsed.rows.length!==22 || mapping.products.length!==22 ||
        mapping.categoriesUsed.length!==8 || manifest.length!==22) fail();
    const count=(table:string):number => Number((db.prepare("SELECT count(*) AS n FROM " + table).get() as {n:bigint}).n);
    if(count("catalog_products")!==22 || count("catalog_product_images")!==22 ||
       count("catalog_categories")!==8) fail();
    const company=new CompanyProfileRepository(db).find();
    const expectedShop=(JSON.parse(input.profile.toString("utf8")) as {shop:{
      nameAr:string; nameEn:string; tagline:string; address:string; phone1:string; email:string;
      taxEnabled:boolean; startNumber:number;
    }}).shop;
    if(!company || company.logo_path!==input.logoName || company.name_ar!==expectedShop.nameAr ||
      company.name_en!==expectedShop.nameEn || company.tagline!==expectedShop.tagline ||
      company.address!==expectedShop.address || company.phone1!==expectedShop.phone1 ||
      company.email!==expectedShop.email || company.legal_name!==null || company.phone2!==null ||
      company.taxpayer_number!==null || company.commercial_register!==null || company.vat_number!==null ||
      company.tax_label!==null || Number(company.tax_enabled)!==0 || Number(company.tax_rate_bp)!==0 ||
      expectedShop.taxEnabled!==false || expectedShop.startNumber!==1001 ||
      Number(company.next_invoice_number)!==1001) fail();
    const categories=new CategoryRepository(db).listAll();
    const byCategory = new Map<string,string>();
    for(const category of mapping.categoriesUsed) {
      const matches=categories.filter((row)=>row.name_ar===category.name_ar &&
        row.name_en===category.name_en && row.is_active===1);
      if(matches.length!==1 || byCategory.has(category.key)) fail();
      byCategory.set(category.key,matches[0]!.id);
    }
    const catalog=new CatalogRepository(db);
    const photos=new ProductImageRepository(db);
    const ids=new Set<string>(); const skus=new Set<string>();
    for(const [i,item] of mapping.products.entries()) {
      if(item.csvDataRow!==i+1 || parsed.rows[i]?.sourceId!==item.source_id ||
        ids.has(item.source_id) || skus.has(item.sku) || item.image!=="images/"+item.sku+".jpg") fail();
      ids.add(item.source_id); skus.add(item.sku);
      const row=catalog.findById(productIdFor(CSV_SOURCE,item.source_id));
      if(!row) return fail();
      if(row.source!==CSV_SOURCE || row.source_key!==item.source_id || row.sku!==item.sku ||
        row.name_ar!==item.name_ar || row.name_en!==(item.name_en||null) ||
        row.category_id!==byCategory.get(item.category) || row.barcode!==item.barcode ||
        row.base_unit!==item.unit || row.currency!=="USD" || row.is_active!==1n ||
        row.selling_price_minor!==parseDecimal(item.price,"USD").minor) fail();
      const matching=manifest.filter((m)=>m.sku===item.sku || m.file===item.sku+".jpg");
      if(matching.length!==1 || matching[0]!.sha256!==item.sha256 ||
        matching[0]!.sourcePage!==item.sourcePage || matching[0]!.licence!==item.licence) fail();
      const source=input.sourceImage(item.sku);
      if(source.length!==item.bytes) fail();
      const normalized=verifyDemoProductMedia(item.sku,item.sku+".jpg",source,manifest,input.codec);
      const meta=photos.findPrimaryMeta(row.id);
      const stored=meta ? photos.readBytes(meta.id) : null;
      verifyStoredDemoProductMedia(row.id,normalized,meta,stored);
      if(!stored || input.codec.decode(stored).isEmpty()) fail();
    }
    if(ids.size!==22 || skus.size!==22) fail();
  } catch { fail(); }
}
