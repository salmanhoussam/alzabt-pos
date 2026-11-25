/**
 * Synthetic Demo renderer request restriction. Main supplies its own
 * compiled renderer root; renderer data cannot grant a new filesystem root.
 * Same-user path replacement remains O-2.
 */
import {lstatSync,realpathSync} from "node:fs";
import {isAbsolute,relative,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
function same(a:string,b:string):boolean {
  return process.platform==="win32"?a.toLowerCase()===b.toLowerCase():a===b;
}
export function isSyntheticRendererRequestAllowed(rawUrl:string,rendererRoot:string):boolean {
  try {
    const url=new URL(rawUrl);
    if(url.protocol==="data:" || url.protocol==="blob:")return true;
    if(url.protocol!=="file:" || !isAbsolute(rendererRoot))return false;
    const root=resolve(rendererRoot), path=resolve(fileURLToPath(url));
    const rel=relative(root,path);
    if(!rel || rel===".." || rel.startsWith(".."+sep) || isAbsolute(rel))return false;
    const rootStat=lstatSync(root), fileStat=lstatSync(path);
    if(rootStat.isSymbolicLink() || !rootStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile())return false;
    const realRoot=realpathSync(root), realFile=realpathSync(path);
    if(!same(realRoot,root) || !same(realFile,path))return false;
    return true;
  } catch {return false}
}
export function installSyntheticRendererBlocker(
  webRequest:{onBeforeRequest:(f:(d:{url:string},done:(r:{cancel:boolean})=>void)=>void)=>void},
  rendererRoot:string,
):void {
  webRequest.onBeforeRequest((d,done)=>done({cancel:!isSyntheticRendererRequestAllowed(d.url,rendererRoot)}));
}
