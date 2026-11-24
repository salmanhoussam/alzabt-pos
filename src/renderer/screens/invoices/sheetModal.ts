/**
 * R4 (Abu Abbas, R3 review finding R3-1 — the issue confirmation behind the product picker): ONE modal at a time on
 * the invoice sheet, and while it is open nothing behind it can be reached.
 *
 * 🔴 WHY. The sheet's dialogs (product picker, issue confirmation, exit, discard, customer finder, issued notice) are
 * sibling overlays. R3 made the sheet inert only while the CONFIRMATION was open. With the PICKER open, Tab left the
 * picker, reached «إصدار» underneath, opened the confirmation beneath the picker (which stayed on top), reached
 * «إصدار» inside the hidden confirmation and issued — an irreversible act confirmed on a dialog nobody could see.
 *
 * Three layers, none of which relies on the others:
 *  1. EXCLUSIVITY — `claimModal` refuses to open a dialog while another is open. It reads a ref that the opener
 *     itself updates synchronously, so two openers racing inside one render (a queued action and a click) cannot
 *     both succeed. The sheet also refuses to ISSUE unless the confirmation is the only modal (the action boundary).
 *  2. ISOLATION — the sheet makes every background section `inert` while any modal is open (keyboard, pointer and
 *     assistive technology). No overlay sits inside an inert section.
 *  3. FOCUS — `useModalFocus`: focus enters the dialog on its SAFE control, Tab and Shift+Tab cycle inside it (the
 *     app shell outside the sheet is not inert, so this is what keeps the keyboard in), and focus returns to the
 *     control that opened it when it closes. The same mechanics as the History void dialog.
 */
import { useEffect, useRef, type RefObject } from "react";

export type SheetModal = "finalized" | "exit" | "discard" | "confirm" | "customer" | "picker";

/** Every open modal, in a fixed order. More than one is a defect the sheet refuses to issue under. */
export function openSheetModals(state: Readonly<Record<SheetModal, boolean>>): SheetModal[] {
  return (["finalized", "exit", "discard", "confirm", "customer", "picker"] as const).filter((k) => state[k]);
}

/**
 * May `kind` open now? Only when nothing else is open (re-opening the same one is harmless). On success the claim is
 * written into `current` IMMEDIATELY — before React re-renders — so a second opener in the same tick is refused.
 */
export function claimModal(current: { value: readonly SheetModal[] }, kind: SheetModal): boolean {
  if (current.value.some((k) => k !== kind)) return false;
  current.value = [kind];
  return true;
}

/** The dialog root of each modal, inside the sheet. The customer finder is its own component and keeps its testid. */
export function modalSelector(kind: SheetModal): string {
  return kind === "customer" ? '[data-testid="customer-finder"]' : `[data-sheet-modal="${kind}"]`;
}

/** The control that has focus right now — what a modal hands focus back to when it closes. */
export function focusedControl(): HTMLElement | null {
  const a = document.activeElement;
  return a instanceof HTMLElement && a !== document.body ? a : null;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function focusablesIn(box: HTMLElement): HTMLElement[] {
  return Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.closest("[inert]") === null);
}

/**
 * Focus entry, containment and restoration for the active modal (`null` = none). Focus enters on the element marked
 * `data-modal-initial` (the SAFE choice: cancel / keep / search), or the first focusable one. Escape is NOT added
 * here: each dialog keeps exactly the Escape behaviour it had (the customer finder closes on it; the others ignore it).
 */
export function useModalFocus(
  active: SheetModal | null,
  rootRef: RefObject<HTMLElement | null>,
  /** Set by the opener BEFORE it opens: by the time this effect runs the opener is inert and Chrome has moved focus. */
  openerRef: { current: HTMLElement | null },
): void {
  const invoker = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (active === null) return;
    const dialog = () => rootRef.current?.querySelector<HTMLElement>(modalSelector(active)) ?? null;
    const was = document.activeElement;
    invoker.current = openerRef.current ?? (was instanceof HTMLElement && was !== document.body ? was : null);
    openerRef.current = null;
    const box = dialog();
    if (box && !box.contains(document.activeElement)) {
      (box.querySelector<HTMLElement>("[data-modal-initial]") ?? focusablesIn(box)[0])?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const d = dialog();
      if (!d) return;
      const items = focusablesIn(d);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const at = document.activeElement;
      if (!(at instanceof Node) || !d.contains(at)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // R5 (Abu Abbas F1): focus that lands OUTSIDE the dialog by any other route — a script's focus(), a click that
    // slipped past the overlay, the app shell — is handed straight back to the dialog's safe control. The Tab trap
    // above only governs Tab; this governs every way focus can move.
    const onFocusIn = (e: FocusEvent) => {
      const d = dialog();
      if (!d) return;
      if (e.target instanceof Node && d.contains(e.target)) return;
      (d.querySelector<HTMLElement>("[data-modal-initial]") ?? focusablesIn(d)[0])?.focus();
    };
    // Capture: the trap sees Tab before any handler inside the dialog can act on it.
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn, true);
      const back = invoker.current;
      invoker.current = null;
      // By now the background is no longer inert (the commit that closed the modal removed it). Restore only when
      // focus was lost with the dialog — never steal it from wherever the operator has since put it.
      const now = document.activeElement;
      const lost = now === null || now === document.body || !now.isConnected;
      if (back && back.isConnected && back.closest("[inert]") === null && lost) back.focus();
    };
  }, [active, rootRef, openerRef]);
}
