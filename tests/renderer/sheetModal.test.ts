/**
 * R4 (Abu Abbas, R3 review finding R3-1): the invoice sheet allows ONE modal at a time. The pure parts — which modals
 * are open, and whether one may open — are asserted here; focus behaviour is measured in a real DOM by the screen
 * scenarios (`scenarios-modal-r4.mjs`), because renderer tests have no DOM.
 */
import { describe, expect, it } from "vitest";
import { claimModal, modalSelector, openSheetModals, type SheetModal } from "../../src/renderer/screens/invoices/sheetModal";

const none: Record<SheetModal, boolean> = { finalized: false, exit: false, discard: false, confirm: false, customer: false, picker: false };

describe("openSheetModals", () => {
  it("lists exactly the open ones, in a fixed order", () => {
    expect(openSheetModals(none)).toEqual([]);
    expect(openSheetModals({ ...none, picker: true })).toEqual(["picker"]);
    expect(openSheetModals({ ...none, picker: true, confirm: true })).toEqual(["confirm", "picker"]);
  });
});

describe("claimModal", () => {
  it("opens when nothing is open, and records the claim at once", () => {
    const cur = { value: [] as readonly SheetModal[] };
    expect(claimModal(cur, "picker")).toBe(true);
    expect(cur.value).toEqual(["picker"]);
  });

  it("refuses a second, different modal in the same tick — the R3-1 shape (picker, then the issue confirmation)", () => {
    const cur = { value: [] as readonly SheetModal[] };
    expect(claimModal(cur, "picker")).toBe(true);
    expect(claimModal(cur, "confirm")).toBe(false);
    expect(cur.value).toEqual(["picker"]);
  });

  it("refuses every kind while another is open", () => {
    const kinds: SheetModal[] = ["finalized", "exit", "discard", "confirm", "customer", "picker"];
    for (const open of kinds) {
      for (const next of kinds) {
        const cur = { value: [open] as readonly SheetModal[] };
        expect(claimModal(cur, next), `${open} → ${next}`).toBe(open === next);
      }
    }
  });

  it("a stale list of two is never resolved in favour of opening anything", () => {
    const cur = { value: ["confirm", "picker"] as readonly SheetModal[] };
    expect(claimModal(cur, "confirm")).toBe(false);
    expect(claimModal(cur, "picker")).toBe(false);
  });
});

describe("modalSelector", () => {
  it("finds each dialog root; the customer finder keeps its own testid", () => {
    expect(modalSelector("picker")).toBe('[data-sheet-modal="picker"]');
    expect(modalSelector("customer")).toBe('[data-testid="customer-finder"]');
  });
});
