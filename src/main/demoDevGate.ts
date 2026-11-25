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
/**
 * Which identity rule refused, as a SHORT code — or null when every rule holds. The rules are exactly the ones
 * `permitsSyntheticIdentity` always applied (it is now defined as «no refusal»); only the reason is new. Codes carry no
 * name, SID or path (run 45698905020 refused silently, which cost a hosted run to diagnose).
 */
export function syntheticIdentityRefusal(i:SyntheticGateIdentity):string|null {
  if(i.platform!=="win32" || i.packaged!==false || i.requested!==true)return "gate:build";
  if(i.user.toLowerCase()!=="alzabt-test")return "gate:identity";
  if(i.qualified.toLowerCase()!==(i.host.split(".")[0]!.toLowerCase()+"\\alzabt-test"))return "gate:hostname";
  if(!/^S-1-5-21-[0-9-]+$/i.test(i.sid))return "gate:identity";
  if(i.adminGroup!==false)return "gate:admin";
  return null;
}
export function permitsSyntheticIdentity(i:SyntheticGateIdentity):boolean {
  return syntheticIdentityRefusal(i)===null;
}
let lastRefusal:string|null=null;
/** The code of the last refusal of verifiedSyntheticTestHome in this process (null after a pass). */
export function syntheticGateRefusal():string|null {return lastRefusal}
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
  lastRefusal="gate:identity";
  const refuse=(code:string):null => {lastRefusal=code;return null};
  try {
    if(process.platform!=="win32" || packaged || !requested)return refuse("gate:build");
    const line=osTool("whoami.exe",["/user","/fo","csv","/nh"]).trim();
    const m=line.match(/^"([^"]+)","(S-1-[0-9-]+)"$/i);
    if(!m)return refuse("gate:identity");
    const groups=osTool("whoami.exe",["/groups","/fo","csv","/nh"]);
    const identity={platform:process.platform,packaged,requested,user:userInfo().username,qualified:m[1]!,
      host:hostname(),sid:m[2]!,adminGroup:/S-1-5-32-544/i.test(groups)};
    // Wrong identity is rejected before any account-profile registry read.
    const identityRefusal=syntheticIdentityRefusal(identity);
    if(identityRefusal)return refuse(identityRefusal);
    const expected="C:\\Users\\alzabt-test";
    let profile:string, roaming:string, local:string;
    try {profile=regValue("HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\"+identity.sid,"ProfileImagePath")}
    catch {return refuse("gate:profile-not-ready")}
    const shell="HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
    try {roaming=regValue(shell,"AppData");local=regValue(shell,"Local AppData")}
    catch {return refuse("gate:shell-folders")}
    const eq=(a:string|undefined,b:string)=>!!a && path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
    const under=(p:string)=>path.resolve(p).toLowerCase().startsWith(expected.toLowerCase()+"\\");
    if(!eq(profile,expected))return refuse("gate:profile");
    if(!eq(process.env.USERPROFILE,expected)||!eq(process.env.APPDATA,roaming)||!eq(process.env.LOCALAPPDATA,local))
      return refuse("gate:environment");
    if(!under(roaming)||!under(local))return refuse("gate:shell-folders");
    if(![expected,roaming,local].every(canonicalDirectory))return refuse("gate:path");
    lastRefusal=null;
    return expected;
  } catch {return refuse(lastRefusal??"gate:identity")}
}
