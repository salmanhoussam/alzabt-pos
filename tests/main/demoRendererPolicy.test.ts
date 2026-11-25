import {mkdirSync,mkdtempSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {expect,it,vi} from "vitest";
import {isSyntheticRendererRequestAllowed,installSyntheticRendererBlocker} from "../../src/main/demoRendererPolicy";
it("permits only built renderer files and data/blob; blocks sibling files and network",()=>{
  const parent=mkdtempSync(join(process.cwd(),"node_modules","synthetic-renderer-policy-"));
  const root=join(parent,"renderer");mkdirSync(root);
  const asset=join(root,"index.html"),other=join(parent,"private-synthetic.txt");
  writeFileSync(asset,"synthetic",{flag:"wx"});writeFileSync(other,"synthetic",{flag:"wx"});
  expect(isSyntheticRendererRequestAllowed(pathToFileURL(asset).href,root)).toBe(true);
  expect(isSyntheticRendererRequestAllowed(pathToFileURL(other).href,root)).toBe(false);
  for(const url of ["https://example.invalid/","http://127.0.0.1/","ws://127.0.0.1/","invalid"])
    expect(isSyntheticRendererRequestAllowed(url,root)).toBe(false);
  expect(isSyntheticRendererRequestAllowed("data:text/plain,synthetic",root)).toBe(true);
  expect(isSyntheticRendererRequestAllowed("blob:null/synthetic",root)).toBe(true);
  let handler:((d:{url:string},cb:(r:{cancel:boolean})=>void)=>void)|undefined;
  installSyntheticRendererBlocker({onBeforeRequest:(f)=>{handler=f}},root);
  const done=vi.fn();handler!({url:"https://example.invalid/"},done);
  expect(done).toHaveBeenCalledWith({cancel:true});
});
