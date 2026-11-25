/**
 * Approved local synthetic staging reader, Main-only and dev-only.
 * Inputs are verified by the seed against pinned hashes before any session.
 * Windows same-user path substitution remains O-2.
 */
import {lstatSync,readFileSync,realpathSync} from "node:fs";
import {join,parse,resolve} from "node:path";
import {nativeImage} from "electron";
import {electronCodec} from "./productPhoto";
import type {startReservedSyntheticDemo} from "./demoSyntheticStartup";
const STAGE="C:/dev/alzabt-agent-collaboration/c2-demo-assets-staging-2026-11-18";
const COMPANY="C:/dev/alzabt-agent-collaboration/c2-demo-company-defaults-2026-11-19/config/demo-profile.json";
function file(path:string,maximum:number):Buffer {
  const full=resolve(path);let part=parse(full).root;
  for(const segment of full.slice(part.length).split(/[\\\\/]+/).filter(Boolean)) {
    part=join(part,segment);
    if(lstatSync(part).isSymbolicLink())throw Error("Synthetic asset unavailable.");
  }
  const canonical=realpathSync(full);
  if(process.platform==="win32" ? canonical.toLowerCase()!==full.toLowerCase() : canonical!==full)
    throw Error("Synthetic asset unavailable.");
  const stat=lstatSync(path);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size<1 || stat.size>maximum)throw Error("Synthetic asset unavailable.");
  const bytes=readFileSync(path);
  if(bytes.length!==stat.size)throw Error("Synthetic asset unavailable.");
  return bytes;
}
export function loadSyntheticDemoAssets():Parameters<typeof startReservedSyntheticDemo>[1] {
  try {
    return {
      csv:file(join(STAGE,"catalog","demo-22-import.csv"),100000),
      mapping:file(join(STAGE,"catalog","product-image-mapping.json"),100000),
      manifest:file(join(STAGE,"config","demo-media-manifest.json"),100000),
      logo:file(join(STAGE,"config","demo-logo.png"),1000000),
      profile:file(COMPANY,100000),
      sourceImage:(sku:string)=>{
        if(!/^[A-Z0-9-]+$/.test(sku))throw Error("Synthetic asset unavailable.");
        return file(join(STAGE,"images",sku+".jpg"),5000000);
      },
      codec:electronCodec(nativeImage),
    };
  } catch {throw Error("Synthetic asset unavailable.")}
}
