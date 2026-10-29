import type { RestorePreviewDto } from "../../shared/ipcContract";

/**
 * May the owner press "restore" yet?
 *
 * 🔴 A COURTESY, NOT THE CONTROL. Main refuses an incomplete backup without `acceptMissingAssets`
 * and refuses a hash that is not the preview it holds; this only keeps the button honest about it.
 * A pure module so the rule is asserted without a DOM, like receiptAllocation.ts.
 */
export function canApplyRestore(preview: RestorePreviewDto | null, confirmed: boolean, acceptedMissing: boolean): boolean {
  if (!preview || !confirmed) return false;
  return preview.complete || acceptedMissing;
}
