/**
 * Main-only, synthetic-Db-bound on-screen preview. Not wired to IPC.
 * The caller must render trusted application documents, never renderer HTML.
 * O-2 stays open; a matching Db handle is not OS-level filesystem isolation.
 */
import { randomBytes } from "node:crypto";
import { BrowserWindow, screen, session } from "electron";
import type { Db } from "../persistence/db";
import { syntheticLedgerProfile } from "./demoProfile";

export type DemoPaper = "thermal80" | "a5" | "a4";
const MARK="data-alzabt-demo-mark";
export function markSyntheticPreview(html:string):string {
  if(!html || html.includes(MARK))throw new Error("Demo preview unavailable.");
  const bar='<div '+MARK+'="bar" style="padding:8px;border:2px dashed #c00;text-align:center;color:#a00">\u0646\u0633\u062e\u0629 \u062a\u062c\u0631\u064a\u0628\u064a\u0629 \u2014 DEMO</div>';
  const mark='<div '+MARK+'="mark" aria-hidden="true" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:2147483647;color:rgba(200,30,30,.18);font:700 42px Tahoma,Arial;transform:rotate(-28deg)">\u0646\u0633\u062e\u0629 \u062a\u062c\u0631\u064a\u0628\u064a\u0629 \u2014 DEMO</div>';
  const open=/<body\b[^>]*>/i.exec(html);
  if(!open)throw new Error("Demo preview unavailable.");
  const withBar=html.slice(0,open.index+open[0].length)+bar+html.slice(open.index+open[0].length);
  const close=withBar.toLowerCase().lastIndexOf("</body>");
  if(close<0)throw new Error("Demo preview unavailable.");
  return withBar.slice(0,close)+mark+withBar.slice(close);
}


/** Preview-only framing: do not alter the shared receipt document or print layout. */
export function frameSyntheticPreview(html:string,paper:DemoPaper):string {
  if(paper!=="thermal80")return html;
  if(!/<body\b[^>]*data-layout=["']thermal80["']/i.test(html))throw new Error("Demo preview unavailable.");
  const head=/<\/head\s*>/i.exec(html);
  if(!head)throw new Error("Demo preview unavailable.");
  const style='<style data-alzabt-preview-frame>body[data-layout="thermal80"]{margin-left:auto;margin-right:auto}</style>';
  return html.slice(0,head.index)+style+html.slice(head.index);
}


export type PreviewWorkArea = { readonly x:number; readonly y:number; readonly width:number; readonly height:number };
/** Sizes are device-independent screen coordinates, not document dimensions. */
export function previewBounds(paper:DemoPaper,area:PreviewWorkArea):PreviewWorkArea {
  if(![area.x,area.y,area.width,area.height].every(Number.isSafeInteger) || area.width<1 || area.height<1)
    throw new Error("Demo preview unavailable.");
  const desired=paper==="thermal80"?{width:420,height:860}:paper==="a5"?{width:640,height:860}:{width:860,height:1000};
  const width=Math.min(desired.width,area.width),height=Math.min(desired.height,area.height);
  return {x:area.x+Math.floor((area.width-width)/2),y:area.y+Math.floor((area.height-height)/2),width,height};
}

/** Opens only a data document in a new ephemeral, network-blocked session. */
export async function openSyntheticDemoPreview(db:Db, html:string, paper:DemoPaper, show=true):Promise<BrowserWindow> {
  syntheticLedgerProfile(db);
  if(paper!=="thermal80" && paper!=="a5" && paper!=="a4")throw new Error("Demo preview unavailable.");
  const marked=frameSyntheticPreview(markSyntheticPreview(html),paper);
  const url="data:text/html;charset=utf-8;base64,"+Buffer.from(marked,"utf8").toString("base64");
  // Measured older builds have a data-URL ceiling; fail instead of truncation.
  if(url.length>60000)throw new Error("Demo preview too large.");
  const isolated=session.fromPartition("demo-preview-"+randomBytes(16).toString("hex"));
  isolated.webRequest.onBeforeRequest((details,cb)=>{
    let allowed=false;
    try {const scheme=new URL(details.url).protocol;allowed=scheme==="data:"||scheme==="blob:"}catch{/* deny */}
    cb({cancel:!allowed});
  });
  isolated.on("will-download",(event)=>event.preventDefault());
  const focused=BrowserWindow.getFocusedWindow();
  const display=focused && !focused.isDestroyed()?screen.getDisplayMatching(focused.getBounds()):screen.getPrimaryDisplay();
  const bounds=previewBounds(paper,display.workArea);
  const win=new BrowserWindow({...bounds,show,webPreferences:{session:isolated,sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:false}});
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
  win.webContents.on("will-navigate",(event)=>event.preventDefault());
  win.webContents.on("before-input-event",(event,input)=>{
    if((input.control||input.meta) && (input.key.toLowerCase()==="p" || input.key.toLowerCase()==="s"))event.preventDefault();
  });
  try {await win.loadURL(url);return win}
  catch {win.destroy();throw new Error("Demo preview unavailable.")}
}
