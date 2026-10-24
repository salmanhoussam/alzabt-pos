/**
 * The invoice sheet's unsaved rows, and the one place a batch of them is frozen, sent and settled.
 *
 * 🔴 WHY THIS IS NOT REACT STATE. The sheet used to snapshot `draftRows` from the render in which an
 * async handler began, sent that snapshot, and when the answer came removed every sent row — also
 * judging "was it edited meanwhile?" against that same old render. An edit typed while the request was
 * in the air was therefore either lost or indistinguishable from what was saved. Here the current rows
 * live in ONE synchronously-updated object, so there is no stale closure to read:
 *
 *   - a batch is SNAPSHOT from the current rows at the instant it is built, so an edit made before
 *     that instant is in it;
 *   - from that instant its rows are FROZEN: `edit` and `remove` refuse them (returning false) until
 *     the batch is settled, so an edit attempted after dispatch cannot happen and therefore cannot be
 *     confused with what was saved;
 *   - on success the saved rows are removed; if a frozen row somehow differs from what was sent it is
 *     KEPT and reported, never silently dropped;
 *   - the batch key and payload stay frozen across UNCERTAIN failures and are re-sent as they were —
 *     a fresh key is minted only for a new batch, after a clean refusal or a success.
 *
 * Pure TypeScript with injected I/O, so the race is testable with a delayed fake IPC.
 */
export interface StoredRow<L> {
  readonly key: string;
  readonly line: L;
  readonly unitIncomplete: boolean;
}

export interface StoreDeps<L> {
  readonly isReady: (row: StoredRow<L>) => boolean;
  readonly newKey: () => string;
  /** "refused" = the service rolled back (nothing exists under the key); anything else is uncertain. */
  readonly classify: (err: unknown) => "refused" | "uncertain";
  readonly onChange: () => void;
}

interface Pending<L> {
  readonly key: string;
  readonly entries: ReadonlyArray<{ rowKey: string; line: L }>;
}

export class DraftRowStore<L, V> {
  private current: ReadonlyArray<StoredRow<L>> = [];
  private readonly frozen = new Set<string>();
  private pending: Pending<L> | null = null;
  private inFlight: Promise<V | null> | null = null;
  /** True once the latest flush actually wrote rows, so a later failure can say so truthfully. */
  rowsWritten = false;

  constructor(private readonly deps: StoreDeps<L>) {}

  get rows(): ReadonlyArray<StoredRow<L>> {
    return this.current;
  }
  isFrozen(key: string): boolean {
    return this.frozen.has(key);
  }
  frozenSnapshot(): ReadonlySet<string> {
    return new Set(this.frozen);
  }

  private commit(next: ReadonlyArray<StoredRow<L>>): void {
    this.current = next;
    this.deps.onChange();
  }

  add(row: StoredRow<L>): void {
    this.commit([...this.current, row]);
  }

  /** Returns false — and changes nothing — when the row is part of a batch being saved. */
  edit(key: string, fn: (row: StoredRow<L>) => StoredRow<L>): boolean {
    if (this.frozen.has(key)) return false;
    this.commit(this.current.map((r) => (r.key === key ? fn(r) : r)));
    return true;
  }

  remove(key: string): boolean {
    if (this.frozen.has(key)) return false;
    this.commit(this.current.filter((r) => r.key !== key));
    return true;
  }

  /**
   * Stores every completed row. `send` performs ONE addInvoiceLines call under the given key.
   * Resolves with the last view returned, or null when nothing needed sending.
   */
  async flush(
    send: (key: string, lines: ReadonlyArray<L>) => Promise<V>,
    errors: { unknown: () => Error; editedWhileSaving: () => Error },
  ): Promise<V | null> {
    // A caller that arrives while a flush runs waits for it and then looks again: rows that became
    // ready after that flush last looked would otherwise be missed by a "saved" claim.
    while (this.inFlight) await this.inFlight;
    const run = this.run(send, errors);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async run(
    send: (key: string, lines: ReadonlyArray<L>) => Promise<V>,
    errors: { unknown: () => Error; editedWhileSaving: () => Error },
  ): Promise<V | null> {
    let latest: V | null = null;
    this.rowsWritten = false;
    for (;;) {
      let batch = this.pending;
      if (!batch) {
        const ready = this.current.filter((r) => this.deps.isReady(r) && !this.frozen.has(r.key));
        if (ready.length === 0) return latest;
        batch = { key: this.deps.newKey(), entries: ready.map((r) => ({ rowKey: r.key, line: r.line })) };
        this.pending = batch;
      }
      const frozenBatch = batch;
      // Freeze at the instant the snapshot exists, before the first await.
      for (const e of frozenBatch.entries) this.frozen.add(e.rowKey);
      this.deps.onChange();
      const lines = frozenBatch.entries.map((e) => e.line);
      let result: V;
      try {
        try {
          result = await send(frozenBatch.key, lines);
        } catch (e) {
          if (this.deps.classify(e) === "refused") throw e;
          // Uncertain: the batch may be committed. Same key, same payload — the ledger answers.
          result = await send(frozenBatch.key, lines);
        }
      } catch (e) {
        if (this.deps.classify(e) === "refused") {
          this.pending = null; // rolled back: nothing exists under that key
          for (const x of frozenBatch.entries) this.frozen.delete(x.rowKey);
          this.deps.onChange();
          throw e;
        }
        // Still unknown: keep the batch, its key and its freeze, so the next Save repeats it exactly.
        throw errors.unknown();
      }
      this.pending = null;
      const mismatched = new Set<string>();
      for (const x of frozenBatch.entries) {
        const now = this.current.find((r) => r.key === x.rowKey);
        if (now && JSON.stringify(now.line) !== JSON.stringify(x.line)) mismatched.add(x.rowKey);
      }
      const sentKeys = new Set(frozenBatch.entries.map((x) => x.rowKey));
      for (const k of sentKeys) this.frozen.delete(k);
      this.commit(this.current.filter((r) => !sentKeys.has(r.key) || mismatched.has(r.key)));
      latest = result;
      this.rowsWritten = true;
      if (mismatched.size > 0) throw errors.editedWhileSaving();
    }
  }
}
