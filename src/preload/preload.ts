/**
 * Preload — runs sandboxed, so it may require only "electron". It exposes exactly the PosApi
 * business methods as `window.pos`; the renderer gets no ipcRenderer, no channel names and no
 * way to call anything else.
 *
 * Channel strings are repeated here (a sandboxed preload cannot require project files); the
 * `satisfies typeof CHANNELS` check makes the compiler fail if they ever drift from the contract.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { CHANNELS, PosApi } from "../shared/ipcContract";

const CH = {
  listCashiers: "pos:listCashiers",
  login: "pos:login",
  logout: "pos:logout",
  currentCashier: "pos:currentCashier",
  getCatalog: "pos:getCatalog",
  createSale: "pos:createSale",
  voidSale: "pos:voidSale",
  getTodaySales: "pos:getTodaySales",
  getSaleHistory: "pos:getSaleHistory",
  importCatalog: "pos:importCatalog",
  exportCatalog: "pos:exportCatalog",
  exportBackup: "pos:exportBackup",
  getAppInfo: "pos:getAppInfo",
  listProducts: "pos:listProducts",
  createProduct: "pos:createProduct",
  updateProduct: "pos:updateProduct",
  setProductActive: "pos:setProductActive",
  getSettings: "pos:getSettings",
  setTerminalLanguage: "pos:setTerminalLanguage",
} as const satisfies typeof CHANNELS;

const api: PosApi = {
  listCashiers: () => ipcRenderer.invoke(CH.listCashiers),
  login: (req) => ipcRenderer.invoke(CH.login, { cashierId: req.cashierId, pin: req.pin }),
  logout: () => ipcRenderer.invoke(CH.logout),
  currentCashier: () => ipcRenderer.invoke(CH.currentCashier),
  getCatalog: () => ipcRenderer.invoke(CH.getCatalog),
  createSale: (req) => ipcRenderer.invoke(CH.createSale, req),
  voidSale: (req) => ipcRenderer.invoke(CH.voidSale, { saleId: req.saleId, reason: req.reason }),
  getTodaySales: () => ipcRenderer.invoke(CH.getTodaySales),
  getSaleHistory: (req) => ipcRenderer.invoke(CH.getSaleHistory, { limit: req.limit }),
  importCatalog: () => ipcRenderer.invoke(CH.importCatalog),
  exportCatalog: () => ipcRenderer.invoke(CH.exportCatalog),
  exportBackup: () => ipcRenderer.invoke(CH.exportBackup),
  getAppInfo: () => ipcRenderer.invoke(CH.getAppInfo),
  listProducts: () => ipcRenderer.invoke(CH.listProducts),
  createProduct: (req) => ipcRenderer.invoke(CH.createProduct, { draft: req.draft }),
  updateProduct: (req) => ipcRenderer.invoke(CH.updateProduct, { id: req.id, draft: req.draft, isActive: req.isActive }),
  setProductActive: (req) => ipcRenderer.invoke(CH.setProductActive, { id: req.id, isActive: req.isActive }),
  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  setTerminalLanguage: (req) => ipcRenderer.invoke(CH.setTerminalLanguage, { language: req.language }),
};

contextBridge.exposeInMainWorld("pos", Object.freeze(api));
