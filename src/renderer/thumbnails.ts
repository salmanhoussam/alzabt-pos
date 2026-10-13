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
 * 🔴 RULE 4 IS WHY THE CACHE IS KEYED ON A CONTENT HASH. `imageVersion` is the sha256 of the
 * stored bytes, so "has this photo changed" is answered exactly rather than guessed from a
 * timestamp — and replacing a photo with one byte different invalidates it.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import type { AdminProductDto } from "../shared/ipcContract";

/** What the screen holds for one product's thumbnail. Keyed by product id. */
export type ThumbnailState =
  /** Bytes in hand, for this exact `version`. `url` is an object URL the screen must revoke. */
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
 * The object URLs to revoke after a cache update — the ones nothing can reach any more.
 *
 * 🔴 AN UNREVOKED OBJECT URL IS A LEAK THAT LASTS AS LONG AS THE DOCUMENT. `URL.createObjectURL`
 * pins its blob in memory until `revokeObjectURL`, and this screen creates one per photo and
 * re-creates it every time a photo is replaced. A shop with a thousand photographed products, left
 * open on the products screen all day, would accumulate every version it ever displayed.
 *
 * "Unreachable" means: the product is gone from the list, or its entry now holds a different URL.
 */
export function urlsToRevoke(previous: ThumbnailCache, next: ThumbnailCache): string[] {
  const out: string[] = [];
  for (const [productId, state] of previous) {
    if (state.kind !== "ready") continue;
    const now = next.get(productId);
    if (now === undefined || now.kind !== "ready" || now.url !== state.url) out.push(state.url);
  }
  return out;
}

/** Every URL the cache currently holds — what a screen revokes when it unmounts. */
export function allUrls(cache: ThumbnailCache): string[] {
  return [...cache.values()].filter((s): s is ThumbnailState & { kind: "ready" } => s.kind === "ready").map((s) => s.url);
}
