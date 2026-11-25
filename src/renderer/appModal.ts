/**
 * R5 (Abu Abbas, R4 review F1 + R5 contract invariant 1): the ONE application-level owner of interaction.
 *
 * 🔴 WHY. R4 isolated the invoice sheet's own background, but the app shell (the tabs, the language switch, logout)
 * lives OUTSIDE the sheet and stayed live while an invoice dialog — or an issue in flight — owned the screen. A tab
 * click there unmounts the sheet in the middle of its work. While an owner is set, the shell is `inert` (keyboard,
 * pointer, assistive technology) AND every shell action refuses at execution (a dispatched event still arrives).
 *
 * A plain external store (no context), so the sheet can claim it synchronously inside an event handler — before
 * React re-renders — exactly like the sheet's own `claimModal`.
 */
import { useSyncExternalStore } from "react";

let owner: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Sets the owner. Idempotent for the same id; a different id replaces it (one owner exists: the open invoice). */
export function claimAppModal(id: string): void {
  if (owner === id) return;
  owner = id;
  emit();
}

/** Clears the owner — only if `id` still holds it, so a late cleanup can never release someone else's claim. */
export function releaseAppModal(id: string): void {
  if (owner !== id) return;
  owner = null;
  emit();
}

/** The current owner, read synchronously at the moment an action runs. */
export function appModalOwner(): string | null {
  return owner;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For rendering: the shell re-renders when the owner changes. */
export function useAppModalOwner(): string | null {
  return useSyncExternalStore(subscribe, appModalOwner, appModalOwner);
}
