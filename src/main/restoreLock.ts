/**
 * The restore lock: once a restore is STAGED, nothing may change the shop's data until the program
 * restarts and the restore engine runs (Track 2 phase 3, P0).
 *
 * ═══════════════════════════════════════════════════════════
 * 🔴 WHY. Staging copies a backup aside and the restart replaces the live ledger with it. Anything
 * written between the two — a sale, a collection, a phone-saved product — would be silently thrown
 * away by the restore, or worse, be half-present if the restart never comes. So the moment staging
 * succeeds, every write is refused.
 *
 * WHERE IT BITES, and why in two places rather than one:
 *   1. the IPC wrapper (ipcHandlers.ts) refuses every channel but three reads, BEFORE authorization
 *      and before any payload is examined — the renderer's whole surface;
 *   2. every transaction provider main.ts hands to a service checks it first — which is the path the
 *      phone LAN server takes (it calls the service directly, never through IPC), and any future
 *      caller that does the same.
 * main.ts also closes the phone surface the instant staging succeeds.
 *
 * 🔴 IT DOES NOT DEPEND ON THE RESTART HAPPENING. The lock is engaged in memory on staging AND
 * reads whether a restore journal exists on disk, so if the relaunch fails or the program is closed
 * by hand, it stays shut for the rest of this process — and the next start runs the restore first.
 * ═══════════════════════════════════════════════════════════
 */
import { DomainError } from "../domain/errors";

export class RestoreLock {
  private staged = false;

  /** `pending` answers whether a restore journal exists on disk right now. */
  constructor(private readonly pending: () => boolean) {}

  /** Called once staging has succeeded and been verified. There is no way to release it. */
  engage(): void {
    this.staged = true;
  }

  get engaged(): boolean {
    return this.staged || this.pending();
  }

  /** Throws when a restore is staged. Called before every write transaction. */
  assertOpen(): void {
    if (this.engaged) {
      throw new DomainError("NOT_AVAILABLE", "A backup restore is waiting for the program to restart; nothing can be changed until then");
    }
  }
}
