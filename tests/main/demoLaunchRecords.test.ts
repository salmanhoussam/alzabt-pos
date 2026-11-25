import { mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect,it } from "vitest";
import { claimVerifiedDemoLaunch, DemoLaunchRecords } from "../../src/main/demoLaunchRecords";
const reservation="slot-1/profile-"+"a".repeat(32);
function fixture(){
  const dir=mkdtempSync(join(process.cwd(),"node_modules","synthetic-launch-records-"));
  return {dir,records:new DemoLaunchRecords(dir)};
}
it("persists no key and consumes exactly one verified, fresh reservation",()=>{
  const {dir,records}=fixture();
  const launch=records.prepare("enter",reservation,1000);
  const bytes=readdirSync(dir).map((f)=>readFileSync(join(dir,f),"utf8")).join("");
  expect(bytes).not.toContain(launch.key);
  const proof=records.consume(launch.nonce,launch.key,1001,(id)=>id===reservation);
  expect(proof).not.toBeNull();
  expect(claimVerifiedDemoLaunch(proof!,()=>true)).toEqual({reservationId:reservation,action:"enter"});
  expect(claimVerifiedDemoLaunch(proof!,()=>true)).toBeNull();
  expect(records.consume(launch.nonce,launch.key,1001,()=>true)).toBeNull();
});
it("rejects guessed keys, expiration, time reversal and nonfresh slots without consuming",()=>{
  const {records}=fixture();const a=records.prepare("reset",reservation,1000);
  expect(records.consume(a.nonce,"0".repeat(64),1001,()=>true)).toBeNull();
  expect(records.consume(a.nonce,a.key,121001,()=>true)).toBeNull();
  expect(records.consume(a.nonce,a.key,999,()=>true)).toBeNull();
  expect(records.consume(a.nonce,a.key,1001,()=>false)).toBeNull();
  const proof=records.consume(a.nonce,a.key,1001,()=>true);
  expect(proof).not.toBeNull();
  expect(claimVerifiedDemoLaunch(proof!,()=>true)).toEqual({reservationId:reservation,action:"reset"});
});
it("fails closed if the commit is missing, modified, or a consumed target already exists",()=>{
  const missing=fixture();const a=missing.records.prepare("enter",reservation,1000);
  renameSync(join(missing.dir,"commit-"+a.nonce+".pending"),join(missing.dir,"commit-"+a.nonce+".hidden"));
  expect(missing.records.consume(a.nonce,a.key,1001,()=>true)).toBeNull();
  const altered=fixture();const b=altered.records.prepare("enter",reservation,1000);
  writeFileSync(join(altered.dir,"commit-"+b.nonce+".pending"),"{}");
  expect(altered.records.consume(b.nonce,b.key,1001,()=>true)).toBeNull();
  const blocked=fixture();const c=blocked.records.prepare("enter",reservation,1000);
  writeFileSync(join(blocked.dir,"intent-"+c.nonce+".used"),"synthetic");
  expect(blocked.records.consume(c.nonce,c.key,1001,()=>true)).toBeNull();
});
it("rejects invalid ids, unknown actions and invalid token input",()=>{
  const {records}=fixture();
  expect(()=>records.prepare("enter","../outside",1000)).toThrow();
  expect(()=>records.prepare("wrong" as never,reservation,1000)).toThrow();
  expect(records.consume("../outside","bad",1000,()=>true)).toBeNull();
});
