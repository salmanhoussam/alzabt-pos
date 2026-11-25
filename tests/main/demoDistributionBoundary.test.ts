import { readFileSync, readdirSync } from "node:fs";
import { expect,it } from "vitest";
it("explicitly excludes synthetic lifecycle, profile and startup JS and source maps from packaged files",()=>{
  const pkg=JSON.parse(readFileSync("package.json","utf8")) as {build:{files:string[]}};
  const patterns=pkg.build.files;
  for(const module of ["demoLaunchRecords","demoLifecycle","demoProfile","demoSyntheticStartup",
    "demoSeedAccounts","demoSeedAssembly","demoSeedBootstrap","demoSeedIdentity","demoSeedMedia",
    "demoSeedReadback","demoLogoVault","demoPreview","demoPreviewPorts","demoJourneyProbe","demoDevMain","demoDevEntry","demoDevGate","demoHandoverStartup","demoAssets","demoRendererPolicy","demoRuntime"])
    expect(patterns).toContain("!dist/main/main/"+module+".*");
  expect(patterns).toContain("!dist/main/preload/preload-demo.*");
  expect(patterns).toContain("dist/**/*");
});

it("the installed electron-builder matcher excludes those modules but retains the ordinary Main bundle",()=>{
  const {FileMatcher}=require("app-builder-lib/out/fileMatcher") as {
    FileMatcher:new (from:string,to:string,expand:(x:string)=>string,patterns:string[])=>{createFilter:()=> (file:string,stat:{isDirectory:()=>boolean})=>boolean}
  };
  const path=require("node:path") as typeof import("node:path");
  const pkg=JSON.parse(readFileSync("package.json","utf8")) as {build:{files:string[]}};
  const root=process.cwd();
  const filter=new FileMatcher(root,root,(x)=>x,pkg.build.files).createFilter();
  const stat={isDirectory:()=>false};
  for(const module of ["demoLaunchRecords","demoLifecycle","demoProfile","demoSyntheticStartup",
    "demoSeedAccounts","demoSeedAssembly","demoSeedBootstrap","demoSeedIdentity","demoSeedMedia","demoSeedReadback","demoLogoVault","demoPreview","demoPreviewPorts","demoJourneyProbe","demoDevMain","demoDevEntry","demoDevGate","demoHandoverStartup","demoAssets","demoRendererPolicy","demoRuntime"])
    for(const suffix of [".js",".js.map"])
      expect(filter(path.join(root,"dist","main","main",module+suffix),stat),module+suffix).toBe(false);
  expect(filter(path.join(root,"dist","main","preload","preload-demo.js"),stat)).toBe(false);
  expect(filter(path.join(root,"dist","main","preload","preload.js"),stat)).toBe(true);
  expect(filter(path.join(root,"dist","main","main","main.js"),stat)).toBe(true);
  expect(filter(path.join(root,"dist","main","main","demoPolicy.js"),stat)).toBe(true);
});

it("keeps the distributable preload free of the Demo lifecycle bridge",()=>{
  const normal=readFileSync("src/preload/preload.ts","utf8");
  const demo=readFileSync("src/preload/preload-demo.ts","utf8");
  const extra='api.requestDemoLifecycle = (req) => ipcRenderer.invoke("pos:requestDemoLifecycle", req);\n';
  expect(normal).not.toContain("pos:requestDemoLifecycle");
  expect(demo).toContain(extra);
  expect(demo.replace(extra,"")).toBe(normal);
});
it("rejects any unclassified demo module from packaged artifacts",()=>{
  const pkg=JSON.parse(readFileSync("package.json","utf8")) as {build:{files:string[]}};
  const normal=new Set(["demoCatalog","demoPolicy","demoConstants"]);
  const modules=readdirSync("src/main").filter(name=>/^demo.*\.ts$/.test(name)).map(name=>name.slice(0,-3));
  expect(modules.length).toBeGreaterThan(3);
  for(const name of modules)if(!normal.has(name))expect(pkg.build.files,name).toContain("!dist/main/main/"+name+".*");
});