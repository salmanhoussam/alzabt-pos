/**
 * The unsaved-row store against a DELAYED fake IPC — behavioural coverage of the race, not a React
 * render. What it proves is the logic the sheet delegates to; that the sheet wires it to disabled
 * inputs is covered by the source assertions in flushOutcome.test.ts, and the rendered interaction
 * has no component test (no DOM environment in this project).
 */
import { describe, expect, it } from "vitest";
import { DraftRowStore, type StoredRow } from "../../src/renderer/screens/invoices/draftRowStore";

type Line = { d: string; q: string };
type View = { n: number };
const ok = (r: StoredRow<Line>) => r.line.d !== "" && r.line.q !== "";
const row = (key: string, d: string, q = "1"): StoredRow<Line> => ({ key, line: { d, q }, unitIncomplete: false });
const errors = { unknown: () => new Error("unknown"), editedWhileSaving: () => new Error("edited") };

function make() {
  let k = 0;
  const calls: Array<{ key: string; lines: Line[] }> = [];
  const store = new DraftRowStore<Line, View>({
    isReady: ok,
    newKey: () => `key-${++k}`,
    classify: (e) => (e instanceof Error && e.message === "refused" ? "refused" : "uncertain"),
    onChange: () => undefined,
  });
  return { store, calls };
}
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("rows are frozen from the instant the batch is snapshotted", () => {
  it("🔴 an edit made BEFORE the snapshot is in the batch; one attempted AFTER dispatch is refused", async () => {
    const { store, calls } = make();
    store.add(row("a", "first"));
    expect(store.edit("a", (r) => ({ ...r, line: { ...r.line, d: "edited before" } }))).toBe(true);

    const gate = deferred<View>();
    const flushing = store.flush((key, lines) => {
      calls.push({ key, lines: [...lines] });
      return gate.promise;
    }, errors);
    await tick();

    expect(calls[0]!.lines).toEqual([{ d: "edited before", q: "1" }]);
    // Dispatched. Every way of changing the row is refused, and the row is visibly frozen.
    expect(store.isFrozen("a")).toBe(true);
    expect(store.edit("a", (r) => ({ ...r, line: { ...r.line, d: "too late" } }))).toBe(false);
    expect(store.remove("a")).toBe(false);
    expect(store.rows.find((r) => r.key === "a")!.line.d).toBe("edited before");

    gate.resolve({ n: 1 });
    await flushing;
    expect(store.rows).toHaveLength(0); // exactly what was sent was removed
    expect(store.isFrozen("a")).toBe(false);
  });

  it("a row added while a batch is in the air is not sent with it, and is not lost", async () => {
    const { store, calls } = make();
    store.add(row("a", "one"));
    const gate = deferred<View>();
    const flushing = store.flush((key, lines) => {
      calls.push({ key, lines: [...lines] });
      return calls.length === 1 ? gate.promise : Promise.resolve({ n: 2 });
    }, errors);
    await tick();
    store.add(row("b", "two")); // typed while saving
    gate.resolve({ n: 1 });
    await flushing; // the same flush picks up the now-ready row as its own, separately keyed batch
    expect(calls).toHaveLength(2);
    expect(calls[0]!.lines).toEqual([{ d: "one", q: "1" }]);
    expect(calls[1]!.lines).toEqual([{ d: "two", q: "1" }]);
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
    expect(store.rows).toHaveLength(0);
  });

  it("a second caller waits for the first and then sends what became ready meanwhile", async () => {
    const { store, calls } = make();
    store.add(row("a", "one"));
    const gate = deferred<View>();
    const first = store.flush((key, lines) => {
      calls.push({ key, lines: [...lines] });
      return calls.length === 1 ? gate.promise : Promise.resolve({ n: 2 });
    }, errors);
    await tick();
    const second = store.flush((key, lines) => {
      calls.push({ key, lines: [...lines] });
      return Promise.resolve({ n: 3 });
    }, errors);
    store.add(row("b", "two"));
    gate.resolve({ n: 1 });
    await Promise.all([first, second]);
    expect(store.rows).toHaveLength(0);
    expect(calls.flatMap((c) => c.lines.map((l) => l.d)).sort()).toEqual(["one", "two"]); // each exactly once
  });
});

describe("the batch key survives uncertainty", () => {
  it("🔴 a lost response is re-sent under the SAME key and the SAME payload", async () => {
    const { store, calls } = make();
    store.add(row("a", "one"));
    store.add(row("b", "one")); // identical content stays two rows
    let n = 0;
    await store.flush((key, lines) => {
      calls.push({ key, lines: [...lines] });
      return n++ === 0 ? Promise.reject(new Error("ipc lost")) : Promise.resolve({ n: 1 });
    }, errors);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(calls[1]!.lines).toEqual(calls[0]!.lines);
    expect(calls[0]!.lines).toHaveLength(2);
    expect(store.rows).toHaveLength(0);
  });

  it("🔴 still unknown: the rows stay frozen, and the next Save repeats the SAME key — never a new one", async () => {
    const { store, calls } = make();
    store.add(row("a", "one"));
    const down = (key: string, lines: ReadonlyArray<Line>) => {
      calls.push({ key, lines: [...lines] });
      return Promise.reject(new Error("ipc lost"));
    };
    await expect(store.flush(down, errors)).rejects.toThrow("unknown");
    expect(store.isFrozen("a")).toBe(true);
    expect(store.edit("a", (r) => r)).toBe(false);
    await expect(store.flush(down, errors)).rejects.toThrow("unknown");
    expect(new Set(calls.map((c) => c.key)).size).toBe(1);
    expect(calls).toHaveLength(4);
    await store.flush(async (key, lines) => {
      calls.push({ key, lines: [...lines] });
      return { n: 1 };
    }, errors);
    expect(calls[4]!.key).toBe(calls[0]!.key);
    expect(store.rows).toHaveLength(0);
    expect(store.isFrozen("a")).toBe(false);
  });

  it("a clean refusal thaws the rows, keeps them, and the next batch gets a NEW key", async () => {
    const { store, calls } = make();
    store.add(row("a", "one"));
    await expect(
      store.flush((key, lines) => {
        calls.push({ key, lines: [...lines] });
        return Promise.reject(new Error("refused"));
      }, errors),
    ).rejects.toThrow("refused");
    expect(store.rows).toHaveLength(1);
    expect(store.isFrozen("a")).toBe(false);
    expect(store.edit("a", (r) => ({ ...r, line: { ...r.line, d: "fixed" } }))).toBe(true);
    await store.flush(async (key, lines) => {
      calls.push({ key, lines: [...lines] });
      return { n: 1 };
    }, errors);
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
    expect(calls[1]!.lines[0]!.d).toBe("fixed");
  });

  it("incomplete rows are never sent and stay editable", async () => {
    const { store, calls } = make();
    store.add(row("a", "", "1"));
    await store.flush(async (key, lines) => {
      calls.push({ key, lines: [...lines] });
      return { n: 1 };
    }, errors);
    expect(calls).toHaveLength(0);
    expect(store.edit("a", (r) => r)).toBe(true);
  });
});
