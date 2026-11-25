/**
 * DEC-35z16 (PILOT): the pure rules of a phone invoice batch and the INVOICE_BATCH session shape.
 */
import { describe, expect, it } from "vitest";
import {
  PHONE_INVOICE_MAX_BATCH_BYTES,
  PHONE_INVOICE_MAX_PER_BATCH,
  PHONE_INVOICE_MAX_STAGED_BYTES,
  decideUpload,
  isCaptureKey,
  isInvoiceId,
  type BatchInvoice,
} from "../../src/domain/phoneInvoiceBatch";
import {
  PHONE_INVOICE_SESSION_TTL_MS,
  PHONE_SESSION_TTL_MS,
  authorizes,
  createSession,
  parseRoute,
} from "../../src/domain/phoneSession";

const TOKEN = "a".repeat(64);
const key = (n: number) => n.toString(16).padStart(32, "0");
const item = (n: number, bytes = 1000): BatchInvoice => ({
  id: key(1000 + n),
  mime: "image/jpeg",
  bytes,
  sha256: `sha-${n}`,
  captureKey: key(n),
  receivedAtMs: n,
});

describe("decideUpload", () => {
  it("accepts a new photo", () => {
    expect(decideUpload([], { bytes: 10, sha256: "x", captureKey: key(1) }, 0)).toEqual({ kind: "accept" });
  });
  it("🔴 a retried capture key is a REPLAY answered with the same id — even when the batch is full", () => {
    const full = Array.from({ length: PHONE_INVOICE_MAX_PER_BATCH }, (_, i) => item(i + 1));
    expect(decideUpload(full, { bytes: 10, sha256: "new", captureKey: key(5) }, 0)).toEqual({ kind: "replay", id: key(1005) });
  });
  it("🔴 the same bytes under another key are a DUPLICATE, never stored twice", () => {
    expect(decideUpload([item(1)], { bytes: 1000, sha256: "sha-1", captureKey: key(9) }, 0)).toEqual({ kind: "duplicate", id: key(1001) });
  });
  it("refuses past the per-batch count", () => {
    const full = Array.from({ length: PHONE_INVOICE_MAX_PER_BATCH }, (_, i) => item(i + 1));
    expect(decideUpload(full, { bytes: 1, sha256: "n", captureKey: key(99) }, 0)).toEqual({ kind: "limit", which: "count" });
  });
  it("refuses past the batch byte cap and the whole-staging cap", () => {
    expect(decideUpload([item(1, PHONE_INVOICE_MAX_BATCH_BYTES - 5)], { bytes: 10, sha256: "n", captureKey: key(2) }, 0)).toEqual({ kind: "limit", which: "batch_bytes" });
    expect(decideUpload([], { bytes: 10, sha256: "n", captureKey: key(2) }, PHONE_INVOICE_MAX_STAGED_BYTES - 5)).toEqual({ kind: "limit", which: "staged_bytes" });
  });
  it("refuses a capture key that is not 32 lower-case hex", () => {
    expect(() => decideUpload([], { bytes: 1, sha256: "x", captureKey: "ABC" }, 0)).toThrow();
    expect(isCaptureKey(key(1))).toBe(true);
    expect(isCaptureKey("../../x")).toBe(false);
    expect(isInvoiceId(key(1).toUpperCase().replace(/0/g, "A"))).toBe(false);
  });
});

describe("INVOICE_BATCH session", () => {
  it("names no product, lasts 30 minutes (a product session still lasts 10)", () => {
    const s = createSession({ action: "INVOICE_BATCH", productId: null, operatorId: "op" }, 1000, () => TOKEN);
    expect(s.expiresAtMs - s.createdAtMs).toBe(PHONE_INVOICE_SESSION_TTL_MS);
    const p = createSession({ action: "NEW_PRODUCT", productId: null, operatorId: "op" }, 1000, () => TOKEN);
    expect(p.expiresAtMs - p.createdAtMs).toBe(PHONE_SESSION_TTL_MS);
    expect(() => createSession({ action: "INVOICE_BATCH", productId: "p1", operatorId: "op" }, 1, () => TOKEN)).toThrow();
  });
  it("🔴 authorizes no product action — the token's powers are fixed at creation", () => {
    const s = createSession({ action: "INVOICE_BATCH", productId: null, operatorId: "op" }, 1, () => TOKEN);
    expect(authorizes(s, "NEW_PRODUCT", null)).toBe(false);
    expect(authorizes(s, "EDIT_PRODUCT", "p1")).toBe(false);
  });
  it("routes: three literal invoice suffixes; the delete id must be 32 hex; product routes unchanged", () => {
    const id = key(7);
    expect(parseRoute(`/m/${TOKEN}/invoice`)).toEqual({ kind: "invoice", token: TOKEN });
    expect(parseRoute(`/m/${TOKEN}/finish`)).toEqual({ kind: "finish", token: TOKEN });
    expect(parseRoute(`/m/${TOKEN}/invoice/${id}/delete`)).toEqual({ kind: "invoiceDelete", token: TOKEN, invoiceId: id });
    expect(parseRoute(`/m/${TOKEN}/invoice/../../x/delete`)).toEqual({ kind: "unknown" });
    expect(parseRoute(`/m/${TOKEN}/invoice/${id.slice(1)}/delete`)).toEqual({ kind: "unknown" });
    expect(parseRoute(`/m/${TOKEN}/invoices`)).toEqual({ kind: "unknown" });
    expect(parseRoute(`/m/${TOKEN}`)).toEqual({ kind: "page", token: TOKEN });
    expect(parseRoute(`/m/${TOKEN}/photo`)).toEqual({ kind: "photo", token: TOKEN });
    expect(parseRoute(`/m/${TOKEN}/barcode`)).toEqual({ kind: "barcode", token: TOKEN });
  });
});
