/**
 * The thumbnail hook, shared by every screen that shows product photos.
 *
 * 🔴 MOVED HERE UNCHANGED, NOT REWRITTEN. The Sell screen needs exactly this behaviour, and a
 * second implementation of it would be a second set of the six rules to keep in step — so the
 * Products screen's hook became the shared one rather than its twin. The rules themselves still
 * live in `thumbnails.ts` as pure functions, because this repository has no DOM harness.
 */
import { useEffect, useRef, useState } from "react";
import type { AdminProductDto } from "../shared/ipcContract";
import { call, pos } from "./api";
import { type ThumbnailCache, dataUrlFrom, thumbnailsToFetch } from "./thumbnails";

/**
 * Fetches the thumbnails of the rows on screen, and nothing else.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 EVERY DECISION HERE IS MADE BY `thumbnailsToFetch`, NOT BY THIS HOOK. The six rules — no
 * photo, offscreen, cached, replaced, in flight, failed — live in src/renderer/thumbnails.ts
 * because this repository has no DOM harness and a rule inside an effect is a rule nothing can
 * test. This hook is the wiring: it asks what to fetch, fetches it, and revokes what is no longer
 * reachable.
 *
 * 🔴 AND THEY ARE `data:` URLS, NOT `blob:` ONES. The renderer's CSP starts from
 * `default-src 'none'` and admits `img-src 'self' data:`, so a blob URL is blocked and the image
 * silently never decodes — which is how the first installed Windows run of this screen failed.
 * Widening the CSP was rejected; see `ThumbnailState`. A data URL is a string, released with the
 * state, so there is nothing to revoke.
 *
 * 🔴 A BROKEN PHOTO COSTS ONE FAILED READ. A corrupt blob is refused by `productImageBytes`'s
 * checksum guard — by design — and the row records `failed` at that version, which rule 6 then
 * never retries. Without that, one bad photo would re-request on every render for as long as the
 * screen is open and the row would never settle.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
export function useThumbnails(visible: readonly AdminProductDto[]): ThumbnailCache {
  const [cache, setCache] = useState<ThumbnailCache>(new Map());
  // Read inside the effect without making it a dependency: re-running on every cache change is
  // exactly the render loop the `loading`/`failed` states exist to prevent.
  const latest = useRef(cache);
  latest.current = cache;

  useEffect(() => {
    // Every row handed to this hook is on screen. A virtualised list would pass only the rendered
    // window; today the table renders what it filters, so `shown` IS the visible set.
    const wanted = thumbnailsToFetch(visible, new Set(visible.map((p) => p.id)), latest.current);
    if (wanted.length === 0) return;
    let live = true;

    // Mark them loading in one update, so a second render cannot start the same fetch again.
    setCache((prev) => {
      const next = new Map(prev);
      for (const r of wanted) next.set(r.productId, { kind: "loading", version: r.version });
      return next;
    });

    for (const request of wanted) {
      void (async () => {
        try {
          const got = await call(pos().getProductImageBytes({ imageId: request.imageId }));
          if (!live) return;
          const url = dataUrlFrom(new Uint8Array(got.bytes), got.meta.mime);
          setCache((prev) => {
            const next = new Map(prev);
            next.set(request.productId, { kind: "ready", version: request.version, url });
            return next;
          });
        } catch {
          if (!live) return;
          // 🔴 The placeholder, remembered. Not rethrown: one unreadable photo must not take down
          // the products screen, and the row below falls back to the ordinary empty state.
          setCache((prev) => {
            const next = new Map(prev);
            next.set(request.productId, { kind: "failed", version: request.version });
            return next;
          });
        }
      })();
    }

    return () => {
      live = false;
    };
  }, [visible]);

  return cache;
}
