import Database from "better-sqlite3";
import {mkdtempSync} from "node:fs";
import {join} from "node:path";
import {expect,it,vi} from "vitest";
import {readFileSync} from "node:fs";
import {SAMPLES} from "../../scripts/invoiceSampleFixtures";
import {renderInvoiceDocument} from "../../src/main/invoiceDocument";
vi.mock("electron",()=>({BrowserWindow:vi.fn(),session:{fromPartition:vi.fn()}}));
import {frameSyntheticPreview,markSyntheticPreview,openSyntheticDemoPreview} from "../../src/main/demoPreview";
import {createSyntheticDemoRoot,reserveSyntheticDemoProfile,openNewSyntheticDemoLedger} from "../../src/main/demoProfile";
it("marks a complete trusted document exactly once and rejects malformed input",()=>{
  const result=markSyntheticPreview("<html><body><p>synthetic</p></body></html>");
  expect(result.match(/data-alzabt-demo-mark/g)).toHaveLength(2);
  expect(result).not.toContain(String.fromCharCode(0x00b7));
  expect(result.match(/\u0646\u0633\u062e\u0629 \u062a\u062c\u0631\u064a\u0628\u064a\u0629 \u2014 DEMO/g)).toHaveLength(2);
  expect(()=>markSyntheticPreview(result)).toThrow();
  expect(()=>markSyntheticPreview("<html>synthetic</html>")).toThrow();
});
it("rejects a forged Db and an oversized document before opening any window",async()=>{
  const fake=new Database(":memory:");
  try{await expect(openSyntheticDemoPreview(fake,"<html><body>x</body></html>","a4",false)).rejects.toThrow()}
  finally{fake.close()}
  const parent=mkdtempSync(join(process.cwd(),"node_modules","synthetic-preview-test-"));
  const db=openNewSyntheticDemoLedger(reserveSyntheticDemoProfile(createSyntheticDemoRoot(parent)));
  try{await expect(openSyntheticDemoPreview(db,"<html><body>"+"x".repeat(60000)+"</body></html>","a4",false)).rejects.toThrow("too large")}
  finally{db.close()}
});

it("keeps a 45-line synthetic invoice with its approved logo within the actual preview limit",()=>{
  const sample=SAMPLES.find(s=>s.name==="D-multipage");
  expect(sample).toBeDefined();
  const logo="data:image/png;base64,"+readFileSync("resources/demo/demo-logo.png").toString("base64");
  const marked=markSyntheticPreview(renderInvoiceDocument(sample!.v,{logoUrl:logo}));
  const url="data:text/html;charset=utf-8;base64,"+Buffer.from(marked,"utf8").toString("base64");
  expect(sample!.v.lines.length).toBeGreaterThanOrEqual(40);
  expect(marked.match(/data-alzabt-demo-mark/g)).toHaveLength(2);
  expect(url.length).toBeLessThanOrEqual(60000);
});
it("centres only the thermal preview without changing receipt facts or A5/A4",()=>{
  const doc='<html dir="rtl"><head><style>body{width:72mm;margin:0}</style></head><body data-layout="thermal80"><span data-field="total">15.23</span></body></html>';
  const marked=markSyntheticPreview(doc);
  const framed=frameSyntheticPreview(marked,"thermal80");
  const style='<style data-alzabt-preview-frame>body[data-layout="thermal80"]{margin-left:auto;margin-right:auto}</style>';
  expect(framed.replace(style,"")).toBe(marked);
  expect(framed).toContain('data-field="total">15.23');
  expect(framed.match(/data-alzabt-demo-mark/g)).toHaveLength(2);
  expect(frameSyntheticPreview(marked,"a5")).toBe(marked);
  expect(frameSyntheticPreview(marked,"a4")).toBe(marked);
  expect(()=>frameSyntheticPreview("<html><body>no head</body></html>","thermal80")).toThrow();
});
