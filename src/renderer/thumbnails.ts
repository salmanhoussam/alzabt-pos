/**
 * WHICH product photos the products screen should fetch, as a pure function.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS A MODULE AND NOT AN EFFECT INSIDE ProductsScreen.
 *
 * This repository has no DOM harness — `vitest.config.mts` says `environment: "node"` — and that
 * absence has already cost it a real defect: `App.tsx` rendered the setup screen forever because of
 * the ORDER of two early returns, 717 unit tests passed through it, and only the Windows gate
 * caught it. The answer taken then is the answer taken here: the decision becomes a pure exported
 * function, tested in milliseconds, and the component is left with nothing but wiring.
 *
 * So the rules below are not documentation of what an effect happens to do. They are the thing
 * itself, and `tests/renderer/thumbnails.test.ts` is where they are enforced:
 *
 *   1. a product with no photo is NEVER fetched — `hasImage` already decided the placeholder
 *   2. a photo that is not on screen is NEVER fetched
 *   3. a photo already in the cache at its CURRENT version is never fetched again
 *   4. a photo whose version has changed IS fetched again, because the owner replaced it
 *   5. a fetch already in flight is not started twice
 *   6. a photo that failed is not retried in a loop — one attempt, then the placeholder
 *
 * There is no seventh rule about releasing URLs: see `ThumbnailState` for why these are `data:`
 * URLs, which the state releases by holding nothing but a string.
 *
 * 🔴 RULE 4 IS WHY THE CACHE IS KEYED ON A CONTENT HASH. `imageVersion` is the sha256 of the
 * stored bytes, so "has this photo changed" is answered exactly rather than guessed from a
 * timestamp — and replacing a photo with one byte different invalidates it.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import type { AdminProductDto } from "../shared/ipcContract";

/** What the screen holds for one product's thumbnail. Keyed by product id. */
export type ThumbnailState =
  /**
   * Bytes in hand, for this exact `version`, as a `data:` URL.
   *
   * 🔴 A `data:` URL AND NOT A `blob:` ONE, AND THE WINDOWS GATE IS WHY. The renderer's CSP is
   * `default-src 'none'; … img-src 'self' data:` (src/renderer/index.html) — deliberately minimal
   * for an offline till — so a `blob:` URL is BLOCKED and the image silently never decodes. The
   * first installed run of e2e/product-master.mjs failed on exactly that, with a PNG an independent
   * decoder reads without complaint.
   *
   * The alternative was to add `blob:` to `img-src`. It was rejected: widening the one CSP that
   * starts from 'none' is a real change to what the untrusted side of the bridge may load, and it
   * would have been made to save a base64 encode on a 40-pixel thumbnail. The invoice logo already
   * renders as a `data:` URI for the same reason, so this follows a precedent rather than setting
   * one.
   *
   * The consequence is that there is nothing to revoke: a `data:` URL is a string, released with
   * the state that holds it. Only the few photos on screen are ever fetched, so what is held is a
   * screenful.
   */
  | { readonly kind: "ready"; readonly version: string; readonly url: string }
  /** A fetch is in flight for this `version`. */
  | { readonly kind: "loading"; readonly version: string }
  /**
   * This `version` could not be loaded — refused by the checksum guard, gone, or an internal
   * error. The row shows its ordinary placeholder.
   *
   * 🔴 A FAILURE IS REMEMBERED ON PURPOSE. Without it, a corrupt photo would be requested again on
   * every render for as long as the screen is open: the list would hammer the main process and the
   * operator would see a row that never settles. One broken photo must cost one failed read.
   */
  | { readonly kind: "failed"; readonly version: string };

export type ThumbnailCache = ReadonlyMap<string, ThumbnailState>;

/** One product's photo worth fetching: what to ask for, and what to key the answer under. */
export interface ThumbnailRequest {
  readonly productId: string;
  readonly imageId: string;
  readonly version: string;
}

/**
 * The photos to fetch right now — nothing more.
 *
 * `visible` is the set of product ids actually rendered. A screen that paginates or virtualises
 * passes the ids on screen; one that renders everything passes them all, and then rule 1 alone
 * still means an unphotographed catalog costs zero reads.
 */
export function thumbnailsToFetch(
  products: readonly AdminProductDto[],
  visible: ReadonlySet<string>,
  cache: ThumbnailCache,
): ThumbnailRequest[] {
  const out: ThumbnailRequest[] = [];
  for (const p of products) {
    // Rule 1. `hasImage`, `primaryImageId` and `imageVersion` all derive from one metadata row in
    // `toAdminProductDto`, so they cannot disagree — but this reads the two it actually needs
    // rather than trusting the flag, because a null id is unaskable whatever the flag says.
    if (p.primaryImageId === null || p.imageVersion === null) continue;
    if (!visible.has(p.id)) continue; // Rule 2
    const held = cache.get(p.id);
    // Rules 3, 5 and 6: anything already recorded AT THIS VERSION is settled, whichever way.
    if (held && held.version === p.imageVersion) continue;
    // Rule 4: no record, or a record for a version the owner has since replaced.
    out.push({ productId: p.id, imageId: p.primaryImageId, version: p.imageVersion });
  }
  return out;
}

/**
 * `bytes` as a `data:` URL the CSP admits.
 *
 * 🔴 CHUNKED, NOT `String.fromCharCode(...bytes)`. The spread form passes every byte as an
 * argument and blows the call-stack argument limit somewhere around a hundred thousand of them —
 * which a normalized photo is comfortably past. It would work on a small test fixture and throw on
 * a real shop photo, which is the worst shape a bug can have.
 */
export function dataUrlFrom(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
