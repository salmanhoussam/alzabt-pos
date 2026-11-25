/**
 * Synthetic, non-distributable development gate. No launch/session authority.
 * Actual account evidence comes from OS token and its registered profile.
 * O-2 and same-user tampering remain OPEN.
 */
import {execFileSync} from "node:child_process";
import {lstatSync,realpathSync} from "node:fs";
import {hostname,userInfo} from "node:os";
import {win32 as path} from "node:path";

export interface SyntheticGateIdentity {
  readonly platform:string; readonly packaged:boolean; readonly requested:boolean;
  readonly user:string; readonly qualified:string; readonly host:string;
  readonly sid:string; readonly adminGroup:boolean;
}
export function permitsSyntheticIdentity(i:SyntheticGateIdentity):boolean {
  return i.platform==="win32" && i.packaged===false && i.requested===true &&
    i.user.toLowerCase()==="alzabt-test" &&
    i.qualified.toLowerCase()===(i.host.split(".")[0]!.toLowerCase()+"\\alzabt-test") &&
    /^S-1-5-21-[0-9-]+$/i.test(i.sid) && i.adminGroup===false;
}
function osTool(name:string,args:string[]):string {
  return execFileSync(path.join("C:\\Windows\\System32",name),args,{encoding:"utf8",windowsHide:true,timeout:10000});
}
function regValue(key:string,name:string):string {
  const text=osTool("reg.exe",["query",key,"/v",name]);
  const line=text.split(/\r?\n/).map((s)=>s.trim()).find((s)=>s.toLowerCase().startsWith(name.toLowerCase()+" "));
  const m=line?.match(/^[^\s]+(?:\s+[^\s]+)*?\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
  if(!m)throw Error("profile unavailable");
  return m[1]!.replace(/%USERPROFILE%/gi,"C:\\Users\\alzabt-test");
}
function canonicalDirectory(dir:string):boolean {
  const resolved=path.resolve(dir);let current=path.parse(resolved).root;
  for(const component of resolved.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
    current=path.join(current,component);
    const stat=lstatSync(current);
    if(stat.isSymbolicLink()||!stat.isDirectory())return false;
  }
  return path.resolve(realpathSync.native(resolved)).toLowerCase()===resolved.toLowerCase();
}
/**
 * Invoked only after product lock, never with renderer data. Returns the fixed
 * test profile root or null. Must not be the sole proof for launch records.
 */
export function verifiedSyntheticTestHome(packaged:boolean,requested:boolean):string|null {
  try {
    if(process.platform!=="win32" || packaged || !requested)return null;
    const line=osTool("whoami.exe",["/user","/fo","csv","/nh"]).trim();
    const m=line.match(/^"([^"]+)","(S-1-[0-9-]+)"$/i);
    if(!m)return null;
    const groups=osTool("whoami.exe",["/groups","/fo","csv","/nh"]);
    const identity={platform:process.platform,packaged,requested,user:userInfo().username,qualified:m[1]!,
      host:hostname(),sid:m[2]!,adminGroup:/S-1-5-32-544/i.test(groups)};
    // Wrong identity is rejected before any account-profile registry read.
    if(!permitsSyntheticIdentity(identity))return null;
    const expected="C:\\Users\\alzabt-test";
    const profile=regValue("HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\"+identity.sid,"ProfileImagePath");
    const shell="HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
    const roaming=regValue(shell,"AppData"),local=regValue(shell,"Local AppData");
    const eq=(a:string|undefined,b:string)=>!!a && path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
    const under=(p:string)=>path.resolve(p).toLowerCase().startsWith(expected.toLowerCase()+"\\");
    if(!eq(profile,expected)||!eq(process.env.USERPROFILE,expected)||
       !eq(process.env.APPDATA,roaming)||!eq(process.env.LOCALAPPDATA,local)||
       !under(roaming)||!under(local))return null;
    if(![expected,roaming,local].every(canonicalDirectory))return null;
    return expected;
  } catch {return null}
}
