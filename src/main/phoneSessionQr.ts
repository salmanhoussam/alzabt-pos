/**
 * The QR code the desktop shows, generated locally.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 `zxing-wasm` FETCHES ITS `.wasm` FROM A CDN BY DEFAULT. That was measured during the approved
 * study and it is the single most dangerous fact about this dependency: an offline-first till that
 * silently reaches the Internet to draw a QR would work perfectly on a developer's machine and
 * fail in a shop whose router is down — which is precisely when the merchant is most likely to be
 * entering products by hand.
 *
 * So the override is NOT optional and NOT a default that can be left off. `loadLocalWasm()` reads
 * the binary from `node_modules`/the packaged app with `fs.readFileSync` and hands it over as
 * `wasmBinary`. `tests/main/phoneSessionQr.test.ts` holds this with a test that FAILS if the
 * override stops being passed — not by watching the network, which a unit test cannot do, but by
 * asserting the override is installed before any encode is attempted.
 *
 * 🔴 ONE DEPENDENCY, BOTH JOBS. `zxing-wasm`'s writer draws this QR; its reader will decode
 * barcodes in slice I. That is why no QR-specific package was added — the study measured `qrcode`
 * pulling `yargs` for a CLI this product would never invoke.
 *
 * H1 uses the `writer` subpath only. The reader's `.wasm` is a megabyte this slice has no use for.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";
import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";

/** Where the writer's WebAssembly binary lives, resolved through the package's own subpath export. */
export function localWasmPath(): string {
  // `require.resolve` rather than a hand-built path: the package declares
  // `./writer/zxing_writer.wasm` as an export, so this keeps working when electron-builder
  // relocates `node_modules` into the app bundle.
  return require.resolve("zxing-wasm/writer/zxing_writer.wasm");
}

/** The module override this file installs. Exported so a test can assert its SHAPE, not its bytes. */
export interface LocalWasmOverride {
  readonly wasmBinary: Uint8Array;
}

let installed = false;

/**
 * Install the local-WASM override exactly once.
 *
 * Idempotent on purpose: the QR is generated per session, and re-reading 647 KB from disk on every
 * click is waste. `fireImmediately: false` keeps module instantiation lazy, so a terminal that
 * never opens a phone session never pays for the WebAssembly at all.
 */
export function ensureLocalWasm(readFile: (p: string) => Uint8Array = readFileSync): LocalWasmOverride {
  const wasmBinary = readFile(localWasmPath());
  if (wasmBinary.byteLength === 0) {
    throw new Error("zxing-wasm: the local writer .wasm is empty; refusing to fall back to the network");
  }
  const overrides: LocalWasmOverride = { wasmBinary };
  prepareZXingModule({ overrides, fireImmediately: false });
  installed = true;
  return overrides;
}

/** Whether the override has been installed in this process. Read by the discriminating test. */
export function localWasmInstalled(): boolean {
  return installed;
}

/**
 * Draw the session URL as an SVG QR code.
 *
 * 🔴 SVG, NOT PNG, AND THE REASON IS THE RENDERER'S OWN CSP. `index.html` ships
 * `default-src 'none'; img-src 'self' data:` — migration 10's gate already caught `blob:` URLs
 * being blocked here, and the fix then was the same as the choice now: an inline, self-contained
 * payload. An SVG string can be placed in the DOM directly, needs no object URL, needs no
 * loosening of the CSP, and scales to whatever size the dialog gives it without re-encoding.
 *
 * 🔴 IT ENCODES THE URL IT IS GIVEN AND NOTHING ELSE. No label, no product name, no operator name
 * is drawn into or alongside the symbol here — a QR that carried a product name would put shop
 * data on a photographable surface for no gain.
 */
export async function renderSessionQrSvg(url: string): Promise<string> {
  if (!installed) ensureLocalWasm();
  const result = await writeBarcode(url, { format: "QRCode" });
  if (result.error) {
    throw new Error(`zxing-wasm could not draw the pairing QR: ${result.error}`);
  }
  const svg = result.svg;
  if (typeof svg !== "string" || svg.trim() === "") {
    throw new Error("zxing-wasm returned no SVG for the pairing QR");
  }
  return inlineSafeSvg(svg);
}

/**
 * Strip the XML prolog and the DOCTYPE, returning the bare `<svg>` element.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS NOT COSMETIC. The encoder emits a standalone SVG *document*:
 *
 *     <?xml version="1.0" standalone="no"?>
 *     <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"
 *       "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
 *
 * That DOCTYPE names an EXTERNAL DTD on w3.org. Browsers do not fetch it for inline SVG, so
 * nothing would visibly break — which is exactly why it is worth removing rather than tolerating:
 * an offline-first product should not ship markup that *points* at the network at all, and an XML
 * prolog is invalid partway through an HTML document in any case. Found by the test asserting the
 * markup carries no `http://`, which was right to object.
 *
 * What remains is `xmlns="http://www.w3.org/2000/svg"` — an XML NAMESPACE, which is an identifier
 * and never a fetch. It is required for the element to render, so it stays, and the test allows
 * that one URI by name rather than by a blanket match.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
export function inlineSafeSvg(svg: string): string {
  const start = svg.indexOf("<svg");
  if (start < 0) throw new Error("zxing-wasm returned markup with no <svg> element");
  return svg.slice(start).trim();
}
