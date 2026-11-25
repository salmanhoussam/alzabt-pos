/* Test-only log observer: no process control, network, or writes. */
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {execFileSync}=require("node:child_process");
const {parseWhoami,validatePrincipal}=require("./windowsTestAccountLock.cjs");
const w=path.win32;
const allowed=new Set(["main-start","window-ready","exit","single-instance-lock"]);
function isSyntheticLog(file) {
  const root="C:\\Users\\alzabt-test\\AppData\\Local";
  const rel=w.relative(root,w.resolve(file));
  return /^Alzabt-Synthetic-Node-[A-Za-z0-9]+\\(?:A-first|B-first)-[A-Za-z0-9]+\\[AB]\\synthetic-diag\.jsonl$/i.test(rel);
}
function eventFromLine(line) {
  try {
    const item=JSON.parse(line);
    if(!allowed.has(item.event) || !Number.isSafeInteger(item.pid) || item.pid<=0 ||
       !Number.isSafeInteger(item.ppid) || item.ppid<0 || !Number.isFinite(item.t)) return null;
    return {event:item.event,pid:item.pid,ppid:item.ppid,t:item.t};
  } catch { return null; }
}
function verifyPath(file) {
  if(!isSyntheticLog(file))throw Error("Not an approved synthetic diagnostic path.");
  let part=w.parse(file).root;
  for(const segment of file.slice(part.length).split(/[\\/]+/).filter(Boolean)) {
    part=w.join(part,segment);
    const stat=fs.lstatSync(part);
    if(stat.isSymbolicLink())throw Error("Redirected synthetic path.");
  }
  if(w.resolve(fs.realpathSync.native(file)).toLowerCase()!==w.resolve(file).toLowerCase())
    throw Error("Noncanonical synthetic path.");
}
function run() {
  if(process.platform!=="win32" || process.argv.length!==4 || process.argv[2]!=="--log")
    throw Error("Use --log with an existing synthetic test diagnostic.");
  const who=w.join(process.env.SystemRoot||"C:\\Windows","System32","whoami.exe");
  const identity=parseWhoami(execFileSync(who,["/user","/fo","csv","/nh"],{encoding:"utf8",windowsHide:true}));
  const groups=execFileSync(who,["/groups","/fo","csv","/nh"],{encoding:"utf8",windowsHide:true});
  validatePrincipal({user:os.userInfo().username,hostname:os.hostname(),qualified:identity.name,sid:identity.sid,
    adminGroupPresent:/S-1-5-32-544/i.test(groups)});
  const file=w.resolve(process.argv[3]);
  verifyPath(file);
  let offset=0, remainder="";
  const poll=()=>{
    try {
      verifyPath(file);
      const size=fs.statSync(file).size;
      if(size<offset || size>4*1024*1024) throw Error("Synthetic log rotated or exceeded the size limit.");
      if(size===offset)return;
      const fd=fs.openSync(file,"r");
      let bytes, read;
      try{bytes=Buffer.alloc(size-offset);read=fs.readSync(fd,bytes,0,bytes.length,offset);}
      finally{fs.closeSync(fd);}
      offset+=read;
      const lines=(remainder+bytes.subarray(0,read).toString("utf8")).split(/\r?\n/);
      remainder=lines.pop();
      if(remainder.length>16384)throw Error("Synthetic log line is too long.");
      for(const line of lines){const event=eventFromLine(line);if(event)console.log(JSON.stringify(event));}
    } catch(e) {console.error("STOP:",e.message);clearInterval(timer);process.exitCode=1;}
  };
  console.log("Synthetic log observer only; PID events are not verified process identity.");
  const timer=setInterval(poll,500);
  poll();
}
if(require.main===module){try{run()}catch(e){console.error("STOP:",e.message);process.exitCode=1;}}
module.exports={isSyntheticLog,eventFromLine};
