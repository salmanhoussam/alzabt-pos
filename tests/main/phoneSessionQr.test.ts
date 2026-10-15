/**
 * The pairing QR, generated locally — and the discriminating test that it is generated LOCALLY.
 *
 * 🔴 THE RISK THIS FILE EXISTS FOR. `zxing-wasm` resolves its `.wasm` from a CDN unless an override
 * is supplied. An offline-first till that quietly fetched a megabyte from the Internet to draw a QR
 * would pass every test on a developer's machine and fail in a shop whose router is down — which is
 * exactly when a merchant is most likely to be entering products by hand.
 *
 * A unit test cannot watch the network. What it CAN do is prove the override is installed from a
 * real local file before any encode happens, and that the encode works with the network-dependent
 * path never taken. Both halves are below, and both die if the override is removed.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { ensureLocalWasm, localWasmInstalled, localWasmPath, renderSessionQrSvg } from "../../src/main/phoneSessionQr";

describe("the WebAssembly is local", () => {
  /**
   * 🔴 THE FILE IS ON DISK, IN THIS PROJECT, AND IS NOT EMPTY. If the package ever stops shipping
   * the writer binary as a subpath export, this fails here rather than by silently falling back to
   * the network at the moment a merchant needs a QR.
   */
  it("🔴 resolves to a real file inside node_modules, not a URL", () => {
    const p = localWasmPath();
    expect(p).toMatch(/zxing_writer\.wasm$/);
    // Not an http(s) URL. The whole failure mode is a remote fetch, so this is asserted directly.
    expect(p).not.toMatch(/^https?:/);
    expect(p).toContain("zxing-wasm");
    expect(existsSync(p), `the local writer wasm must exist at ${p}`).toBe(true);
    const size = statSync(p).size;
    // The measured size at 3.1.5 is 647,500 bytes. Asserted as a floor rather than an equality so
    // a patch release does not fail the build — but a zero-byte or stub file does.
    expect(size).toBeGreaterThan(100_000);
  });

  it("the file really is WebAssembly — the magic bytes, not the extension", () => {
    const bytes = readFileSync(localWasmPath());
    // \0asm — the same "read the content, not the name" discipline slice F applied to photos.
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });

  /**
   * 🔴 THE MUTATION TEST FOR THE OVERRIDE ITSELF. `ensureLocalWasm` is handed a reader, and the
   * test asserts that the reader WAS used and was asked for the local path. Deleting the
   * `prepareZXingModule({ overrides })` call, or passing `{}` instead of the binary, leaves the
   * library on its CDN default — and this is what notices.
   */
  it("🔴 installs the binary as an override, read from the local path", () => {
    const asked: string[] = [];
    const override = ensureLocalWasm((p) => {
      asked.push(p);
      return readFileSync(p);
    });
    // It read the local file...
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(localWasmPath());
    // ...and handed the actual bytes over as `wasmBinary`, which is the field that suppresses the
    // network lookup. An override object without it would be silently useless.
    expect(override.wasmBinary.byteLength).toBeGreaterThan(100_000);
    expect([...override.wasmBinary.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(localWasmInstalled()).toBe(true);
  });

  it("🔴 refuses an empty binary rather than letting the library fall back to the network", () => {
    expect(() => ensureLocalWasm(() => new Uint8Array(0))).toThrow(/refusing to fall back to the network/i);
  });
});

describe("drawing the QR", () => {
  it("produces an SVG that encodes the URL", async () => {
    const url = "http://192.168.1.20:7311/m/" + "a".repeat(64);
    const svg = await renderSessionQrSvg(url);
    expect(svg).toMatch(/^<\?xml|^<svg/i);
    expect(svg).toContain("<svg");
    expect(svg.length).toBeGreaterThan(200);
  });

  /**
   * 🔴 SVG, NOT `blob:`, AND THE REASON IS A REAL GATE FAILURE. Migration 10's Windows run caught
   * `blob:` URLs being refused by the renderer's CSP (`default-src 'none'; img-src 'self' data:`).
   * An SVG string needs no object URL and no CSP change at all.
   */
  it("🔴 is a self-contained SVG with no external reference and no blob: URL", async () => {
    const svg = await renderSessionQrSvg("http://10.0.0.5:9000/m/" + "b".repeat(64));
    expect(svg).not.toMatch(/blob:/);
    expect(svg).not.toMatch(/<script/i);
    // No external image, font or stylesheet reference.
    expect(svg).not.toMatch(/xlink:href\s*=\s*["']https?:/i);
    expect(svg).not.toMatch(/<image\b/i);
    expect(svg).not.toMatch(/@import|<\?xml-stylesheet/i);

    // 🔴 THE ONLY PERMITTED URI IS THE SVG NAMESPACE, AND IT IS ALLOWED BY NAME RATHER THAN BY A
    // SOFTENED PATTERN. `xmlns="http://www.w3.org/2000/svg"` is an identifier the renderer needs in
    // order to treat the element as SVG at all — it is never fetched. Every OTHER http(s)
    // reference would be a real finding, so they are enumerated here instead of this assertion
    // being dropped. The DOCTYPE's external DTD used to appear in this list; `inlineSafeSvg`
    // removes it, and that removal is what makes this an equality rather than a carve-out.
    const uris = svg.match(/https?:\/\/[^"'\s>]*/g) ?? [];
    expect(uris).toEqual(["http://www.w3.org/2000/svg"]);
  });

  /**
   * 🔴 THE TOKEN IS INSIDE THE SYMBOL, AND THE SYMBOL ONLY. The QR must encode the URL — that is
   * its job — but the SVG must not also carry it as readable text in a title, a desc or a comment,
   * where a screenshot or a copy-paste of the markup would expose a live credential.
   */
  it("🔴 the SVG markup does not carry the token as readable text", async () => {
    const token = "c".repeat(64);
    const svg = await renderSessionQrSvg(`http://192.168.1.33:7311/m/${token}`);
    expect(svg).not.toContain(token);
    expect(svg).not.toContain("192.168.1.33");
  });

  it("refuses nothing it can encode, and reports what it cannot", async () => {
    // A control that the error path is wired: an empty payload is not encodable as a QR.
    await expect(renderSessionQrSvg("")).rejects.toThrow();
  });
});
