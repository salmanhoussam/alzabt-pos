import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneSessionBridge } from "../../src/main/phoneSessionBridge";
import { PhoneInvoiceStaging } from "../../src/main/phoneInvoiceStaging";
import { trialInvoiceSessionPayload } from "../../src/main/trialPhonePolicy";

describe("synthetic trial phone listener", () => {
  it("only routes invoice actions, preserving other fields for normal validation", () => {
    expect(trialInvoiceSessionPayload({ action: "COMPANION", unexpected: "test" })).toEqual({ action: "INVOICE_BATCH", unexpected: "test" });
    expect(trialInvoiceSessionPayload({ action: "INVOICE_BATCH" })).toEqual({ action: "INVOICE_BATCH" });
    for (const value of [null, [], {}, { action: "NEW_PRODUCT" }, { action: "EDIT_PRODUCT" }]) {
      expect(trialInvoiceSessionPayload(value)).toBeNull();
    }
  });
  it("binds invoice sessions to loopback and closes them", async () => {
    const root = mkdtempSync(join(tmpdir(), "trial-phone-"));
    let encoded = "";
    const bridge = new PhoneSessionBridge({
      trialLoopback: true,
      interfaces: () => ({ public: [{ address: "192.168.2.10", family: "IPv4", internal: false }] }),
      invoiceStaging: new PhoneInvoiceStaging(root, { decodes: () => true }),
      randomToken: () => "a".repeat(64),
      renderQr: async (url) => { encoded = url; return "test"; },
    });
    try {
      const dto = await bridge.start({ action: "INVOICE_BATCH", productId: null, operatorId: "test" });
      expect(dto.host).toBe("127.0.0.1");
      expect(encoded).toBe(`http://127.0.0.1:${dto.port}/m/${"a".repeat(64)}`);
      const response = await fetch(encoded);
      expect(response.ok).toBe(true);
      expect(await response.text()).toContain("<html");
    } finally {
      await bridge.cancel();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
