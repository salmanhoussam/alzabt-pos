
import {describe,expect,it,vi} from "vitest";
vi.mock("electron",()=>({BrowserWindow:vi.fn(),screen:{},session:{}}));
import {previewBounds} from "../../src/main/demoPreview";
describe("synthetic preview work-area bounds",()=>{
  it.each([
    ["thermal80",{x:0,y:0,width:1366,height:728},{x:473,y:0,width:420,height:728}],
    ["a5",{x:0,y:0,width:1024,height:728},{x:192,y:0,width:640,height:728}],
    ["a4",{x:-683,y:0,width:683,height:485},{x:-683,y:0,width:683,height:485}],
    ["thermal80",{x:100,y:50,width:1600,height:900},{x:690,y:70,width:420,height:860}],
  ] as const)("keeps %s inside its chosen display", (paper,work,expected)=>expect(previewBounds(paper,work)).toEqual(expected));
  it("refuses invalid work areas instead of constructing an unsafe window",()=>{
    for(const area of [{x:0,y:0,width:0,height:728},{x:0,y:0,width:420,height:NaN},{x:0,y:0,width:-1,height:600}])
      expect(()=>previewBounds("thermal80",area)).toThrow();
  });
});
