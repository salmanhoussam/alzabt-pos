/**
 * Decoding a photographed barcode, locally, in the main process.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE DECODE HAPPENS HERE, NOT ON THE PHONE, and that is the approved architecture rather than
 * a convenience. A live camera scanner in a browser needs `getUserMedia` or `BarcodeDetector`, and
 * both are secure-context only — unavailable on `http://192.168.x.x` on iOS AND on Android. So the
 * phone photographs the label with a plain file input and the till reads it. A shop with an old
 * Android phone then gets exactly the same accuracy as one with a new iPhone.
 *
 * 🔴 SAME DEPENDENCY, OTHER HALF. `zxing-wasm` 3.1.5 — exact-pinned — already draws the pairing QR
 * through its writer. This is its reader. No second barcode library was added, and the writer's
 * own no-CDN proof is untouched.
 *
 * 🔴 AND THE READER FETCHES ITS `.wasm` FROM A CDN BY DEFAULT, exactly as the writer does. That is
 * the single most dangerous fact about this dependency in an offline-first till: it would work on
 * a developer's machine and fail in a shop whose router is down — which is precisely when a
 * merchant is entering products by hand. The local override is mandatory and is held by tests that
 * fail if it is removed.
 *
 * 🔴 THIS MODULE DOES NOT CANONICALIZE. A decoded value goes back to the form as text and reaches
 * storage through `domain/barcode.ts`, the one module that owns the UPC-A → EAN-13 rule. Two
 * places normalizing a barcode is how a typed code and a photographed one become two products.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

/** Where the reader's WebAssembly lives, resolved through the package's own subpath export. */
export function localReaderWasmPath(): string {
  return require.resolve("zxing-wasm/reader/zxing_reader.wasm");
}

export interface LocalReaderWasm {
  readonly wasmBinary: Uint8Array;
}

let installed = false;

/**
 * Install the local-WASM override exactly once.
 *
 * Idempotent, and lazy: a till that never photographs a barcode never pays for the ~970 KB.
 */
export function ensureLocalReaderWasm(readFile: (p: string) => Uint8Array = readFileSync): LocalReaderWasm {
  const wasmBinary = readFile(localReaderWasmPath());
  if (wasmBinary.byteLength === 0) {
    throw new Error("zxing-wasm: the local reader .wasm is empty; refusing to fall back to the network");
  }
  const overrides: LocalReaderWasm = { wasmBinary };
  prepareZXingModule({ overrides, fireImmediately: false });
  installed = true;
  return overrides;
}

/** Whether the reader override has been installed in this process. Read by the discriminating test. */
export function localReaderWasmInstalled(): boolean {
  return installed;
}

/**
 * What a decode attempt produced.
 *
 * 🔴 A MISS IS NOT AN ERROR. An independent benchmark over ~7,900 real photographs put this
 * decoder's recall near 67%: roughly one difficult real photo in three will not read. So "no
 * barcode found" is an ordinary outcome the merchant recovers from by typing it, and it must
 * never cost them the draft they are in the middle of. The phone session stays live and the form
 * keeps everything else the merchant typed.
 */
export type BarcodeScan =
  | { readonly found: true; readonly value: string; readonly format: string }
  | { readonly found: false };

/**
 * The formats a shop's products actually carry.
 *
 * Restricting the set is accuracy, not tidiness: asking the decoder for every symbology it knows
 * invites a confident misread of a nearby pattern as some exotic format. These four are what the
 * approved contract names and what the fixtures prove.
 */
const FORMATS = ["EAN-13", "EAN-8", "UPC-A", "Code128"] as const;

/**
 * Read a barcode out of a photograph.
 *
 * `tryHarder` is on because the input is a hand-held photo of a curved label in shop lighting, not
 * a clean render. It costs time this path can afford — a merchant has just taken a picture.
 */
export async function decodeBarcodePhoto(bytes: Buffer): Promise<BarcodeScan> {
  if (!installed) ensureLocalReaderWasm();
  const results = await readBarcodes(new Blob([new Uint8Array(bytes)], { type: "image/*" }), {
    formats: [...FORMATS],
    tryHarder: true,
  });

  for (const r of results) {
    const text = typeof r.text === "string" ? r.text : "";
    if (text === "") continue;
    // 🔴 THE RAW TEXT, UNTOUCHED. No trimming, no case folding, no check-digit repair — Code 128
    // is case-sensitive and a "helpful" fix here would silently change a real product's code.
    return { found: true, value: text, format: String(r.format ?? "") };
  }
  return { found: false };
}
