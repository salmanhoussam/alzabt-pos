/**
 * Samsung recovery: gallery selection is single-photo; queue tests also exercise synthetic multiple-file events.
 *
 * These tests RUN the served page's own script (not a copy of it) against a minimal fake DOM and a fake
 * till whose every answer the test controls, so partial failure, a lost answer, a duplicate, the batch
 * limit and an expired session are each driven deliberately. The real-browser proof is
 * e2e/phone-invoice-batch.mjs; this file proves the ordering and retry rules that a browser run cannot
 * provoke on demand.
 *
 * 🔴 The rule under test throughout: the phone never says «استُلمت» for a photo the till has not answered
 * ok for, and a retry re-sends the SAME capture key, so the till can recognise a send it already stored.
 */
import { describe, expect, it } from "vitest";
import { renderPhoneInvoicePage } from "../../src/main/phoneInvoicePage";

interface Node {
  id: string;
  tag: string;
  textContent: string;
  className: string;
  hidden: boolean;
  disabled: boolean;
  src: string;
  alt: string;
  type: string;
  value: string;
  files: unknown[];
  attrs: Record<string, string>;
  children: Node[];
  onclick: null | (() => void);
  listeners: Record<string, ((e: { target: Node }) => void)[]>;
  appendChild(c: Node): Node;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | undefined;
  addEventListener(ev: string, fn: (e: { target: Node }) => void): void;
  click(): void;
}

function node(tag: string, id = ""): Node {
  const n: Node = {
    id,
    tag,
    textContent: "",
    className: "",
    hidden: false,
    disabled: false,
    src: "",
    alt: "",
    type: "",
    value: "",
    files: [],
    attrs: {},
    children: [],
    onclick: null,
    listeners: {},
    appendChild(c) {
      n.children.push(c);
      return c;
    },
    setAttribute(k, v) {
      n.attrs[k] = v;
    },
    getAttribute(k) {
      return n.attrs[k];
    },
    addEventListener(ev, fn) {
      (n.listeners[ev] ??= []).push(fn);
    },
    click() {
      n.onclick?.();
    },
  };
  // textContent = "" clears children, as in a real DOM
  let text = "";
  Object.defineProperty(n, "textContent", {
    get: () => text,
    set: (v: string) => {
      text = v;
      n.children = [];
    },
  });
  return n;
}

interface Call {
  readonly url: string;
  readonly key: string | undefined;
  readonly body: unknown;
  respond(status: number, json: unknown): Promise<void>;
  fail(): Promise<void>;
}

interface Photo {
  readonly name: string;
  readonly size: number;
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function runPage(opts: { items?: { id: string; bytes: number }[]; max?: number; confirm?: boolean; session?: Map<string, string>; diagnostic?: boolean; hash?: string; storageThrows?: boolean; storageSetThrows?: boolean } = {}) {
  const html = renderPhoneInvoicePage({ items: opts.items ?? [], maxPerBatch: opts.max ?? 20 });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("no script");
  const hiddenInMarkup = new Set<string>();
  const disabledInMarkup = new Set<string>();
  for (const m of html.matchAll(/<[a-zA-Z]+[^>]*\bid="([a-zA-Z]+)"[^>]*>/g)) {
    if (/\shidden(\s|>)/.test(m[0])) hiddenInMarkup.add(m[1]!);
    if (/\sdisabled(\s|>)/.test(m[0])) disabledInMarkup.add(m[1]!);
  }
  const nodes = new Map<string, Node>();
  const el = (id: string): Node => {
    let n = nodes.get(id);
    if (!n) {
      n = node("x", id);
      n.hidden = hiddenInMarkup.has(id);
      n.disabled = disabledInMarkup.has(id);
      nodes.set(id, n);
    }
    return n;
  };
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchStub = (url: string, init: { headers?: Record<string, string>; body?: unknown }) =>
    new Promise((resolve, reject) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push({
        url,
        key: init.headers?.["X-Capture-Key"],
        body: init.body,
        respond: async (status, json) => {
          inFlight -= 1;
          resolve({ status, json: () => Promise.resolve(json) });
          await settle();
          await settle();
        },
        fail: async () => {
          inFlight -= 1;
          reject(new TypeError("Failed to fetch"));
          await settle();
          await settle();
        },
      });
    });
  let urls = 0;
  const urlStub = { createObjectURL: () => `blob:x/${++urls}`, revokeObjectURL: () => undefined };
  let keyN = 0;
  const cryptoStub = {
    getRandomValues: (a: Uint8Array) => {
      keyN += 1;
      a.fill(keyN % 256);
      return a;
    },
  };
  const confirms: string[] = [];
  const confirmStub = (m: string) => {
    confirms.push(m);
    return opts.confirm ?? true;
  };
  const docListeners: Record<string, (() => void)[]> = {};
  const winListeners: Record<string, (() => void)[]> = {};
  const timers: (() => void)[] = [];
  const documentStub = { getElementById: el, createElement: (t: string) => node(t), hidden: false,
    addEventListener: (name: string, fn: () => void) => { (docListeners[name] ??= []).push(fn); } };
  const session = opts.session ?? new Map<string, string>();
  const windowStub = {
    get sessionStorage() {
      if (opts.storageThrows) throw new Error("storage blocked");
      return { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { if (opts.storageSetThrows) throw new Error("quota"); session.set(k, v); }, removeItem: (k: string) => void session.delete(k) };
    },
    addEventListener: (name: string, fn: () => void) => { (winListeners[name] ??= []).push(fn); },
    setTimeout: (fn: () => void) => { timers.push(fn); },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("window", "document", "location", "fetch", "URL", "crypto", "confirm", script)(
    windowStub,
    documentStub,
    { pathname: "/m/" + "a".repeat(64), hash: opts.hash ?? (opts.diagnostic ? "#upload-diagnostics" : "") },
    fetchStub,
    urlStub,
    cryptoStub,
    confirmStub,
  );
  const choose = async (input: "gal" | "cam", photos: Photo[]) => {
    const i = el(input);
    i.files = photos;
    for (const fn of i.listeners.change ?? []) fn({ target: i });
    await settle();
  };
  return {
    el,
    calls,
    confirms,
    session,
    diagnostics: () => el("diagHistory").textContent,
    fireWindow: (event: string) => (winListeners[event] ?? []).forEach((fn) => fn()),
    fireDocument: (event: string, hidden: boolean) => { documentStub.hidden = hidden; (docListeners[event] ?? []).forEach((fn) => fn()); },
    runTimers: () => { while (timers.length) timers.shift()!(); },
    fireNode: (id: string, event: string) => (el(id).listeners[event] ?? []).forEach((fn) => fn({ target: el(id) })),
    get maxInFlight() {
      return maxInFlight;
    },
    choose,
    status: () => el("status").textContent,
    queueStates: () => el("queue").children.map((c) => c.attrs["data-state"]),
    received: () => el("list").children.length,
  };
}

const photo = (n: number, size = 2_500_000): Photo => ({ name: `inv-${n}.jpg`, size });
const ok = (id: string, count: number) => ({ ok: true, id, replay: false, count });
const id = (c: string) => c.repeat(32);

describe("the served invoice page supports individual gallery picks and queued uploads", () => {
  it("offers a single-file gallery input and keeps the camera a single shot", () => {
    const html = renderPhoneInvoicePage({ items: [], maxPerBatch: 20 });
    expect(html).toMatch(/<input id="gal" type="file" accept="image\/\*" data-testid="inv-gallery">/);
    expect(html).toContain("اختيار صورة واحدة من المعرض — افتحه مجدداً لكل فاتورة");
    expect(html).toContain("ثم افتح المعرض مجدداً لإضافة فواتير أخرى");
    expect(html).toMatch(/<input id="cam" type="file" accept="image\/\*" capture="environment" data-testid="inv-camera">/);
    expect(() => new Function(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!)).not.toThrow();
  });

  it("receives three separate gallery selections and finishes the batch", async () => {
    const p = runPage({ diagnostic: true });
    const gallery = p.el("gal");
    const first = photo(1), second = photo(2);
    p.fireNode("galLabel", "click");
    p.fireNode("gal", "click");
    gallery.value = "selected";
    await p.choose("gal", [first]);
    expect(gallery.value).toBe("");
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.body).toBe(first);
    await p.calls[0]!.respond(200, ok(id("a"), 1));
    expect(p.el("n").textContent).toBe("1");
    expect(p.el("gal")).toBe(gallery);
    expect(gallery.disabled).toBe(false);
    p.fireNode("galLabel", "click");
    p.fireNode("gal", "click");
    gallery.value = "selected";
    await p.choose("gal", [second]);
    expect(gallery.value).toBe("");
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]!.body).toBe(second);
    expect(p.calls[1]!.key).not.toBe(p.calls[0]!.key);
    await p.calls[1]!.respond(200, ok(id("b"), 2));
    expect(p.el("n").textContent).toBe("2");
    expect(p.received()).toBe(2);
    expect(gallery.disabled).toBe(false);
    const third = photo(3);
    p.fireNode("galLabel", "click");
    p.fireNode("gal", "click");
    gallery.value = "selected";
    await p.choose("gal", [third]);
    expect(gallery.value).toBe("");
    expect(p.calls).toHaveLength(3);
    expect(p.calls[2]!.body).toBe(third);
    await p.calls[2]!.respond(200, ok(id("c"), 3));
    expect(p.el("n").textContent).toBe("3");
    expect(p.received()).toBe(3);
    expect(p.el("finish").disabled).toBe(false);
    p.el("finish").click();
    await settle();
    expect(p.calls).toHaveLength(4);
    expect(p.calls[3]!.url.endsWith("/finish")).toBe(true);
    await p.calls[3]!.respond(200, { ok: true });
    expect(p.el("live").hidden).toBe(true);
    expect(p.el("done").hidden).toBe(false);
    expect(p.el("done").textContent).toContain("3");
  });

  it("sends three picked photos ONE AT A TIME, each with its own key, and says «استُلمت» only after each answer", async () => {
    const p = runPage();
    await p.choose("gal", [photo(1), photo(2), photo(3)]);
    expect(p.calls).toHaveLength(1);
    expect(p.status()).not.toContain("✔");
    expect(p.received()).toBe(0);
    expect(p.el("finish").disabled).toBe(true);
    await p.calls[0]!.respond(200, ok(id("a"), 1));
    expect(p.received()).toBe(1);
    expect(p.calls).toHaveLength(2);
    await p.calls[1]!.respond(200, ok(id("b"), 2));
    await p.calls[2]!.respond(200, ok(id("c"), 3));
    expect(p.maxInFlight).toBe(1);
    expect(new Set(p.calls.map((c) => c.key)).size).toBe(3);
    expect(p.calls.every((c) => /^[0-9a-f]{32}$/.test(c.key ?? ""))).toBe(true);
    expect(p.received()).toBe(3);
    expect(p.el("n").textContent).toBe("3");
    expect(p.status()).toContain("استُلمت 3 صور");
    expect(p.el("progress").textContent).toBe("أُرسلت 3 من 3");
    expect(p.el("finish").disabled).toBe(false);
    expect(p.el("retry").hidden).toBe(true);
  });

  it("partial failure: a lost connection stops the run, the failed photo is NOT counted, and a retry re-sends the SAME key", async () => {
    const p = runPage();
    await p.choose("gal", [photo(1), photo(2), photo(3)]);
    await p.calls[0]!.respond(200, ok(id("a"), 1));
    const keyOf2 = p.calls[1]!.key;
    await p.calls[1]!.fail();
    expect(p.calls).toHaveLength(2); // the third is NOT fired into a dead network
    expect(p.received()).toBe(1);
    expect(p.queueStates()).toEqual(["fail", "wait"]);
    expect(p.el("retry").hidden).toBe(false);
    expect(p.status()).toContain("إعادة المحاولة");
    expect(p.status()).not.toContain("✔");
    expect(p.el("finish").disabled).toBe(true); // a photo is still waiting to be sent
    p.el("retry").click();
    await settle();
    expect(p.calls[2]!.key).toBe(keyOf2);
    // the till had in fact stored it (only the answer was lost): it answers with the SAME id, as a replay
    await p.calls[2]!.respond(200, { ok: true, id: id("b"), replay: true, count: 2 });
    await p.calls[3]!.respond(200, ok(id("c"), 3));
    expect(p.received()).toBe(3);
    expect(p.el("n").textContent).toBe("3");
  });

  it("a replayed answer for a photo the phone already lists is not listed twice", async () => {
    const p = runPage();
    await p.choose("gal", [photo(1)]);
    await p.calls[0]!.respond(200, ok(id("a"), 1));
    await p.choose("gal", [photo(1)]);
    await p.calls[1]!.respond(200, { ok: true, id: id("a"), replay: true, count: 1 });
    expect(p.received()).toBe(1);
  });

  it("a duplicate is refused with the till's reason and does not stop the others", async () => {
    const p = runPage({ items: [{ id: id("a"), bytes: 10 }] });
    await p.choose("gal", [photo(1), photo(2), photo(3)]);
    await p.calls[0]!.respond(409, { ok: false, code: "DUPLICATE", message: "هذه الصورة أُرسلت قبل قليل." });
    await p.calls[1]!.respond(200, ok(id("b"), 2));
    await p.calls[2]!.respond(200, ok(id("c"), 3));
    expect(p.received()).toBe(3);
    expect(p.queueStates()).toEqual(["refused"]);
    expect(p.el("queue").children[0]!.children.map((c) => c.textContent).join(" ")).toContain("أُرسلت قبل قليل");
    expect(p.el("retry").hidden).toBe(true); // a refusal is not retried — it would be refused again
    expect(p.status()).toContain("لم تُقبل 1");
    expect(p.el("progress").textContent).toBe("أُرسلت 2 من 3 · لم تُقبل 1");
  });

  it("a single duplicate still shows the till's own sentence (the one-photo flow is unchanged)", async () => {
    const p = runPage({ items: [{ id: id("a"), bytes: 10 }] });
    await p.choose("gal", [photo(1)]);
    await p.calls[0]!.respond(409, { ok: false, code: "DUPLICATE", message: "هذه الصورة أُرسلت قبل قليل." });
    expect(p.status()).toBe("هذه الصورة أُرسلت قبل قليل.");
    expect(p.received()).toBe(1);
  });

  it("the batch limit: picking more than fits sends only what fits and says so", async () => {
    const items = Array.from({ length: 19 }, (_, i) => ({ id: String(i % 10).repeat(32), bytes: 10 }));
    const p = runPage({ items, max: 20 });
    await p.choose("gal", [photo(1), photo(2), photo(3)]);
    expect(p.el("limitNote").hidden).toBe(false);
    expect(p.el("limitNote").textContent).toContain("تُرسل أول 1 فقط");
    expect(p.calls).toHaveLength(1);
    await p.calls[0]!.respond(200, ok(id("f"), 20));
    expect(p.calls).toHaveLength(1);
    expect(p.el("gal").disabled).toBe(true);
    expect(p.el("cam").disabled).toBe(true);
  });

  it("the till's LIMIT answer refuses the rest of the run without sending them", async () => {
    const p = runPage();
    await p.choose("gal", [photo(1), photo(2), photo(3)]);
    await p.calls[0]!.respond(409, { ok: false, code: "LIMIT", message: "اكتملت سعة الدفعة." });
    expect(p.calls).toHaveLength(1);
    expect(p.queueStates()).toEqual(["refused", "refused", "refused"]);
  });

  it("session expiry mid-run: stops, and tells the truth about what reached the till", async () => {
    const p = runPage();
    await p.choose("gal", [photo(1), photo(2), photo(3)]);
    await p.calls[0]!.respond(200, ok(id("a"), 1));
    await p.calls[1]!.respond(404, { ok: false, code: "SESSION_CLOSED", message: "انتهت هذه الجلسة." });
    expect(p.calls).toHaveLength(2);
    expect(p.el("live").hidden).toBe(true);
    expect(p.el("done").hidden).toBe(false);
    expect(p.el("done").textContent).toContain("وصل إلى الكمبيوتر 1 فاتورة");
    expect(p.el("done").textContent).toContain("2 صور لم تصل");
    expect(p.el("done").textContent).not.toContain("✔");
  });

  it("a till fault (5xx) is retryable, not a refusal", async () => {
    const p = runPage();
    await p.choose("gal", [photo(1), photo(2)]);
    const k = p.calls[0]!.key;
    await p.calls[0]!.respond(500, { ok: false, code: "INTERNAL", message: "تعذّر الحفظ." });
    expect(p.queueStates()).toEqual(["fail", "wait"]);
    expect(p.el("retry").hidden).toBe(false);
    p.el("retry").click();
    await settle();
    expect(p.calls[1]!.key).toBe(k);
  });

  it("finishing with photos that never reached the till asks first", async () => {
    const p = runPage({ confirm: false });
    await p.choose("gal", [photo(1), photo(2)]);
    await p.calls[0]!.respond(200, ok(id("a"), 1));
    await p.calls[1]!.fail();
    expect(p.el("finish").disabled).toBe(false);
    p.el("finish").click();
    await settle();
    expect(p.confirms.at(-1)).toContain("لم تُرسل");
    expect(p.calls).toHaveLength(2); // declined → no /finish
  });

  it("the camera still sends one photo and offers «تصوير فاتورة أخرى»", async () => {
    const p = runPage();
    await p.choose("cam", [photo(1)]);
    await p.calls[0]!.respond(200, ok(id("a"), 1));
    expect(p.status()).toBe("✔ استُلمت الفاتورة رقم 1 على الكمبيوتر.");
    expect(p.el("another").hidden).toBe(false);
  });

  // OWNER REAL-PHONE BUG (Samsung Internet, 9879dcf): 3 gallery photos chosen, the page came back unchanged and the
  // till logged NO request. Each case below returned SILENTLY before the fix.
  it("an empty selection from the gallery is SAID, never silent", async () => {
    const p = runPage();
    await p.choose("gal", []);
    expect(p.status()).toContain("لم يصل من المعرض أي صورة");
    expect(p.calls).toHaveLength(0);
  });

  it("a page RELOADED while the gallery was open says so (the selection was lost)", async () => {
    const session = new Map<string, string>();
    const first = runPage({ session });
    first.el("galLabel").listeners.click?.forEach((fn) => fn({ target: first.el("galLabel") }));
    expect(session.has("inv-picking")).toBe(true);
    const reloaded = runPage({ session });
    await settle();
    expect(reloaded.status()).toContain("أُعيد تحميل الصفحة أثناء اختيار الصور");
    expect(session.has("inv-picking")).toBe(false);
  });

  it("a normal pick clears the flag, so a later reload is not misreported", async () => {
    const session = new Map<string, string>();
    const p = runPage({ session });
    p.el("galLabel").listeners.click?.forEach((fn) => fn({ target: p.el("galLabel") }));
    await p.choose("gal", [photo(1)]);
    expect(session.has("inv-picking")).toBe(false);
    expect(p.calls).toHaveLength(1);
  });

  it("a selection the browser cannot read is SAID with its error, never silent", async () => {
    const p = runPage();
    const bad = { get length(): number { throw new Error("NotReadableError"); } };
    const i = p.el("gal");
    (i as unknown as { files: unknown }).files = bad;
    for (const fn of i.listeners.change ?? []) fn({ target: i });
    await settle();
    expect(p.status()).toContain("تعذّر قراءة الصور المختارة");
    expect(p.status()).toContain("NotReadableError");
  });
});


describe("temporary opt-in invoice upload diagnostics", () => {
  it("is hidden by default and visible with explicit opt-in", () => {
    const normal = runPage();
    expect(normal.el("diagPanel").hidden).toBe(true);
    expect(normal.session.has("inv-diag-v1")).toBe(false);
    expect(runPage({ hash: "#upload-diagnostics-extra" }).el("diagPanel").hidden).toBe(true);
    const pilot = runPage({ diagnostic: true });
    expect(pilot.el("diagPanel").hidden).toBe(false);
    expect(pilot.diagnostics()).toContain("1. تهيئة الصفحة اكتملت");
  });

  it("reports the picker, lifecycle, count, request, status and acknowledgement without private fields", async () => {
    const p = runPage({ diagnostic: true });
    const secret = "secret-filename-token-pin-url";
    p.fireNode("galLabel", "click");
    p.fireNode("gal", "click");
    p.fireDocument("visibilitychange", true);
    p.fireDocument("visibilitychange", false);
    await p.choose("gal", [{ name: secret, size: 12 }]);
    p.runTimers();
    expect(p.diagnostics()).not.toContain("لم يُرصد تغيير للملف بعد");
    await p.calls[0]!.respond(200, { ...ok(id("a"), 1), message: secret });
    for (const part of ["2.", "3.", "4.", "5.", "6. عدد الملفات لدى المعالج: 1", "7.", "8.", "9. وصل رد HTTP — الحالة: 200", "10. أكد الخادم"]) {
      expect(p.diagnostics()).toContain(part);
    }
    expect(p.diagnostics()).not.toContain(secret);
    expect(p.session.get("inv-diag-v1")).not.toContain(secret);
    expect(p.session.get("inv-diag-v1")).not.toContain("aaaa");
    expect(p.session.get("inv-diag-v1")).not.toContain("/m/");
  });

  it("reports return without change as uncertain and does not send anything", () => {
    const p = runPage({ diagnostic: true });
    p.fireNode("gal", "click"); p.fireWindow("blur"); p.fireWindow("focus"); p.runTimers();
    expect(p.diagnostics()).toContain("لم يُرصد تغيير للملف بعد؛ السبب غير معروف");
    expect(p.calls).toHaveLength(0);
    const cancelled = runPage({ diagnostic: true });
    cancelled.fireNode("gal", "click"); cancelled.fireNode("gal", "cancel");
    expect(cancelled.diagnostics()).toContain("أبلغ المتصفح عن إلغاء المنتقي");
    expect(cancelled.calls).toHaveLength(0);
  });

  it("bounds and validates stored history, keeps it over reload, and tolerates unavailable storage", async () => {
    const session = new Map<string, string>();
    session.set("inv-diag-v1", JSON.stringify([{ c: "init", v: "secret" }, { c: "secret" }, { c: "files", v: 1 }]));
    const first = runPage({ diagnostic: true, session });
    expect(first.diagnostics()).toContain("عدد الملفات لدى المعالج: 1");
    expect(first.diagnostics()).not.toContain("secret");
    for (let n = 0; n < 40; n++) first.fireWindow("blur");
    expect(JSON.parse(session.get("inv-diag-v1")!)).toHaveLength(30);
    const reload = runPage({ diagnostic: true, session });
    expect(reload.diagnostics()).toContain("تهيئة الصفحة اكتملت");
    expect(JSON.parse(session.get("inv-diag-v1")!)).toHaveLength(30);
    const blocked = runPage({ diagnostic: true, storageThrows: true });
    await blocked.choose("gal", [photo(1)]);
    expect(blocked.calls).toHaveLength(1);
    expect(blocked.diagnostics()).toContain("8. بدأت محاولة طلب الرفع");
    const quota = runPage({ diagnostic: true, storageSetThrows: true });
    await quota.choose("gal", [photo(1)]);
    expect(quota.calls).toHaveLength(1);
    expect(quota.diagnostics()).toContain("8. بدأت محاولة طلب الرفع");
  });

  it("does not infer a reload cause or expose a file-reading error in diagnostic mode", async () => {
    const session = new Map<string, string>();
    const first = runPage({ diagnostic: true, session });
    first.fireNode("galLabel", "click");
    const reloaded = runPage({ diagnostic: true, session });
    await settle();
    expect(reloaded.status()).toContain("السبب غير معروف");
    expect(reloaded.status()).not.toContain("لتوفير الذاكرة");
    const i = reloaded.el("gal");
    (i as unknown as { files: unknown }).files = { get length(): number { throw new Error("secret-private-filename"); } };
    for (const fn of i.listeners.change ?? []) fn({ target: i });
    expect(reloaded.status()).not.toContain("secret-private-filename");
    expect(reloaded.diagnostics()).not.toContain("secret-private-filename");
    expect(session.get("inv-diag-v1")).not.toContain("secret-private-filename");
  });

  it("distinguishes rejection and network failure without recording server messages", async () => {
    const p = runPage({ diagnostic: true });
    await p.choose("gal", [photo(1)]);
    await p.calls[0]!.respond(409, { ok: false, message: "secret server body" });
    expect(p.diagnostics()).toContain("الحالة: 409");
    expect(p.diagnostics()).toContain("لم يؤكد الخادم الاستلام");
    expect(p.diagnostics()).not.toContain("secret server body");
    const q = runPage({ diagnostic: true });
    await q.choose("gal", [photo(1)]);
    await q.calls[0]!.fail();
    expect(q.diagnostics()).toContain("فشل طلب الرفع أو لم يصل رد");
  });
});
