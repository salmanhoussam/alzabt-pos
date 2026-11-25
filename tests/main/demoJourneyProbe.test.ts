import {expect,it,vi} from "vitest";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";
vi.mock("electron",()=>({app:{isPackaged:false,hasSingleInstanceLock:()=>true},BrowserWindow:{}}));
import {journeyFlag} from "../../src/main/demoJourneyProbe";
it("accepts only one fixed-format synthetic journey identifier",()=>{
  const valid="--alzabt-synthetic-journey="+"a".repeat(32);
  expect(journeyFlag(["app",valid])).toBe(valid);
  for(const values of [[],[valid,valid],["--alzabt-synthetic-journey=../profile"],
    ["--alzabt-synthetic-journey="+"g".repeat(32)],["--alzabt-synthetic-journey="+"a".repeat(31)]])
    expect(journeyFlag(values)).toBeNull();
});
it("contains a syntactically valid fixed renderer probe",()=>{
  const source=readFileSync("src/main/demoJourneyProbe.ts","utf8");
  const match=source.match(/const code=`([\s\S]*?)`;/);
  expect(match).not.toBeNull();
  expect(()=>new Script(match![1]!)).not.toThrow();
});