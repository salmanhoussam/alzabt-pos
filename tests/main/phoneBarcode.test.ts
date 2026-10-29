/**
 * Reading a photographed barcode — against FIXED fixtures with known payloads.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THE EXPECTED VALUES ARE HARD-CODED AND THE IMAGES ARE ON DISK. A test that generated a
 * barcode with zxing's writer and then read it back with zxing's reader proves the two halves
 * agree with each other — which they would even if both were wrong about EAN-13. These fixtures
 * were written once, into `tests/fixtures/barcodes/`, and the test knows what each one says
 * without running an encoder.
 *
 * The four formats are the ones the approved contract names: EAN-13 and EAN-8 (retail), UPC-A
 * (North American retail, which is where the canonicalization rule comes from) and Code 128 (what
 * a shop prints itself, and the case-sensitive one).
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeBarcode } from "../../src/domain/barcode";
import {
  decodeBarcodePhoto,
  ensureLocalReaderWasm,
  localReaderWasmInstalled,
  localReaderWasmPath,
} from "../../src/main/phoneBarcode";

const FIXTURES = join(__dirname, "..", "fixtures", "barcodes");
const bytes = (name: string) => readFileSync(join(FIXTURES, `${name}.png`));

describe("the reader's WebAssembly is local", () => {
  /**
   * 🔴 THE SAME RISK AS THE WRITER'S, AND IT IS WORTH REPEATING THE PROOF RATHER THAN ASSUMING THE
   * WRITER'S OVERRIDE COVERS IT. `zxing-wasm/reader` is a separate entry point with its own module
   * and its own CDN default: installing the writer's binary does nothing for it. An offline till
   * that silently reached the Internet to read a barcode would work in development and fail in a
   * shop whose router is down.
   */
  it("🔴 resolves to a real local file, not a URL", () => {
    const p = localReaderWasmPath();
    expect(p).toMatch(/zxing_reader\.wasm$/);
    expect(p).not.toMatch(/^https?:/);
    expect(p).toContain("zxing-wasm");
    expect(statSync(p).size).toBeGreaterThan(100_000);
  });

  it("the file really is WebAssembly — the magic bytes, not the extension", () => {
    const b = readFileSync(localReaderWasmPath());
    expect([...b.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });

  it("🔴 installs the binary as an override, read from the local path", () => {
    const asked: string[] = [];
    const override = ensureLocalReaderWasm((p) => {
      asked.push(p);
      return readFileSync(p);
    });
    expect(asked).toEqual([localReaderWasmPath()]);
    expect(override.wasmBinary.byteLength).toBeGreaterThan(100_000);
    expect([...override.wasmBinary.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(localReaderWasmInstalled()).toBe(true);
  });

  it("🔴 refuses an empty binary rather than letting the library fall back to the network", () => {
    expect(() => ensureLocalReaderWasm(() => new Uint8Array(0))).toThrow(/refusing to fall back to the network/i);
  });
});

describe("decoding the four formats", () => {
  it("EAN-13", async () => {
    const r = await decodeBarcodePhoto(bytes("ean13"));
    expect(r.found).toBe(true);
    expect(r.found && r.value).toBe("5901234123457");
    expect(r.found && r.format).toBe("EAN13");
  });

  it("EAN-8", async () => {
    const r = await decodeBarcodePhoto(bytes("ean8"));
    expect(r.found).toBe(true);
    expect(r.found && r.value).toBe("96385074");
    expect(r.found && r.format).toBe("EAN8");
  });

  /**
   * 🔴 THE UPC-A CASE, WHICH IS THE WHOLE REASON THE CANONICALIZATION RULE EXISTS. The fixture
   * encodes the 12 digits `036000291452`; the decoder reports the 13-digit `0036000291452`,
   * because a UPC-A IS an EAN-13 with a leading zero. A shop that typed the 12-digit form and a
   * shop that photographed the label must end up with ONE product, and that only happens because
   * both go through `domain/barcode.ts` — which this asserts directly.
   */
  it("🔴 UPC-A decodes to its EAN-13 form, and matches what TYPING the 12 digits produces", async () => {
    const r = await decodeBarcodePhoto(bytes("upca"));
    expect(r.found).toBe(true);
    expect(r.found && r.value).toBe("0036000291452");

    const fromPhoto = normalizeBarcode(r.found ? r.value : "");
    const fromKeyboard = normalizeBarcode("036000291452");
    expect(fromPhoto?.value).toBe("0036000291452");
    // 🔴 THE TWO ROUTES CONVERGE. If they ever diverged, a shop would get duplicate products for
    // one physical item and only notice at stocktake.
    expect(fromPhoto?.value).toBe(fromKeyboard?.value);
    expect(fromKeyboard?.paddedFromUpcA).toBe(true);
    // And the photographed 13-digit form needed no padding — the two arrive by different routes.
    expect(fromPhoto?.paddedFromUpcA).toBe(false);
  });

  /**
   * 🔴 CASE IS PRESERVED. Code 128 is case-sensitive, so "helpfully" upper-casing a decoded value
   * would silently change a real product's code. `Alz-7781-A` must come back exactly.
   */
  it("🔴 Code 128 keeps its case exactly", async () => {
    const r = await decodeBarcodePhoto(bytes("code128"));
    expect(r.found).toBe(true);
    expect(r.found && r.value).toBe("Alz-7781-A");
    expect(r.found && r.value).not.toBe("ALZ-7781-A");
    expect(r.found && r.value).not.toBe("alz-7781-a");
    expect(r.found && r.format).toBe("Code128");
    // And the normalizer leaves it alone too — no case folding anywhere in the chain.
    expect(normalizeBarcode("Alz-7781-A")?.value).toBe("Alz-7781-A");
  });
});

describe("a photograph with no barcode in it", () => {
  /**
   * 🔴 A MISS IS A RESULT, NOT AN ERROR — and this is load-bearing for the merchant. An
   * independent benchmark put this decoder near 67% recall on real photographs, so roughly one
   * difficult label in three will not read. If that threw, the phone would show a fault for
   * ordinary behaviour, and a session carrying a half-typed product could be lost over it.
   */
  it("🔴 returns found:false instead of throwing", async () => {
    const r = await decodeBarcodePhoto(readFileSync(join(__dirname, "..", "fixtures", "photos", "shelf.jpg")));
    expect(r.found).toBe(false);
  });

  it("rubbish bytes and an empty buffer do not throw either", async () => {
    await expect(decodeBarcodePhoto(Buffer.from("not an image at all", "utf8"))).resolves.toEqual({ found: false });
    await expect(decodeBarcodePhoto(Buffer.alloc(0))).resolves.toEqual({ found: false });
  });

  it("a truncated barcode image does not throw", async () => {
    const whole = bytes("ean13");
    const half = whole.subarray(0, Math.floor(whole.length / 2));
    const r = await decodeBarcodePhoto(half);
    expect(typeof r.found).toBe("boolean");
  });
});
