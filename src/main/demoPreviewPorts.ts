/** Main-only preview ports. Never pass renderer HTML; never invoke a printer or PDF writer. */
import type {BrowserWindow} from "electron";
import type {Db} from "../persistence/db";
import type {InvoiceService} from "../application/invoiceService";
import type {SaleReceiptDto} from "../shared/ipcContract";
import {toInvoiceViewDto} from "../shared/dto";
import {FIXTURE_TERMINAL} from "../fixtures/terminal";
import {renderInvoiceDocument} from "./invoiceDocument";
import {renderSaleReceiptDocument} from "./saleReceiptDocument";
import {readSyntheticFrozenLogo} from "./demoLogoVault";
import {openSyntheticDemoPreview} from "./demoPreview";

export function createSyntheticPreviewPorts(db:Db,invoices:InvoiceService,show=true) {
  const windows=new Set<BrowserWindow>();
  const retain=(window:BrowserWindow):void=>{
    windows.add(window);window.once("closed",()=>windows.delete(window));
  };
  return {
    printInvoice:async(invoiceId:string)=>{
      const view=toInvoiceViewDto(invoices.getInvoice(invoiceId));
      if(view.invoice.status!=="final")throw new Error("Demo preview unavailable.");
      const logo=readSyntheticFrozenLogo(db,view.invoice.issuer?.logoAsset??null);
      if(!logo)throw new Error("Demo preview unavailable.");
      const html=renderInvoiceDocument(view,{logoUrl:"data:image/png;base64,"+logo.toString("base64")});
      retain(await openSyntheticDemoPreview(db,html,"a4",show));
      return {status:"previewed" as const,logoMissing:false,logoUnverified:false};
    },
    printSaleReceipt:async(doc:SaleReceiptDto,layout:"thermal80"|"a5",copy:boolean)=>{
      const name=invoices.getCompanyProfile()?.name_ar??null;
      const html=renderSaleReceiptDocument({receipt:doc,layout,copy,shopName:name,timeZone:FIXTURE_TERMINAL.timeZone});
      retain(await openSyntheticDemoPreview(db,html,layout,show));
      return "previewed" as const;
    },
    /** Main-owned test/cleanup visibility; never returned to the renderer. */
    windows:()=>Array.from(windows),
  };
}
