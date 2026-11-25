import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect,it,vi } from "vitest";
const fault=vi.hoisted(()=>({readCommit:false,voidRename:false}));
vi.mock("node:fs",async(importOriginal)=>{
  const fs=await importOriginal<typeof import("node:fs")>();
  return {...fs,
    readFileSync:(...args:Parameters<typeof fs.readFileSync>)=>{
      const path=String(args[0]);
      if(fault.readCommit && path.includes("commit-") && path.endsWith(".pending"))throw Error("synthetic readback fault");
      return (fs.readFileSync as (...a:unknown[])=>unknown)(...args);
    },
    renameSync:(from:Parameters<typeof fs.renameSync>[0],to:Parameters<typeof fs.renameSync>[1])=>{
      if(fault.voidRename && String(to).endsWith(".void"))throw Error("synthetic void fault");
      return fs.renameSync(from,to);
    },
  };
});
import { DemoLaunchRecords } from "../../src/main/demoLaunchRecords";
it("refuses replay after persisted commit, readback failure and failed invalidation",()=>{
  const dir=mkdtempSync(join(process.cwd(),"node_modules","synthetic-v8-fault-"));
  const records=new DemoLaunchRecords(dir);
  fault.readCommit=true;fault.voidRename=true;
  try {expect(()=>records.prepare("enter","slot-1/profile-"+"a".repeat(32),1000)).toThrow();}
  finally {fault.readCommit=false;fault.voidRename=false;}
  const names=readdirSync(dir);
  expect(names.filter((x)=>x.endsWith(".pending"))).toHaveLength(2);
  const intent=names.find((x)=>x.startsWith("intent-")&&x.endsWith(".pending"))!;
  const nonce=intent.slice("intent-".length,-".pending".length);
  expect(records.consume(nonce,"0".repeat(64),1001,()=>true)).toBeNull();
});
