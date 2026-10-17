/**
 * The mobile form's local photo preview — by RUNNING the script the phone is actually served.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXECUTES THE PAGE INSTEAD OF GREPPING IT. The defect that made this file necessary
 * was invisible to every string assertion and to all 87 `fetch`-driven Windows checks that ran
 * before it: the page called `URL.createObjectURL` for the preview <img>, the served CSP admits
 * `img-src 'self' data:` and NOT `blob:`, so the browser refused the load. `createObjectURL` threw
 * nothing, the upload really had succeeded, the status line really did say «جاهزة» — and the
 * merchant saw a blank box. Only a real browser could see it, and run 38901097239 died there
 * after thirty seconds of waiting for an image the policy had forbidden.
 *
 * So this harness pulls the <script> out of the real `renderPhoneFormPage` output and runs it
 * against a minimal DOM. It is not a mock of the page: it is the page's own code, executing. A
 * test that merely asserted the string "readAsDataURL" appears would pass against a page that
 * never calls it, and would have passed against the broken version too if the comment explaining
 * object URLs had been worded differently.
 *
 * 🔴 `URL.createObjectURL` IS A TRAP HERE, NOT AN OMISSION. The stub throws if anything calls it,
 * so "the preview no longer needs an object URL" is proven by the code running to completion
 * rather than by the word being absent.
 *
 * The REAL visual proof stays the Windows browser E2E (`e2e/phone-entry.mjs` §7b), which
 * photographs the rendered page. This is the fast guard that fails in milliseconds instead.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";
import { renderPhoneFormPage } from "../../src/main/phonePage";
import type { PhoneFormData } from "../../src/application/posService";

const FORM: PhoneFormData = {
  action: "NEW_PRODUCT",
  units: ["piece", "kg"],
  currency: "USD",
  categories: [{ id: "c1", nameAr: "أدوات", nameEn: "Tools", isActive: true }],
  brands: ["Stanley"],
  product: null,
  master: {
    categoryId: "",
    barcode: "",
    brand: "",
    descriptionAr: "",
    descriptionEn: "",
    isOnlineVisible: false,
  },
};

/** A DOM element with only what the served script touches. */
interface El {
  id: string;
  textContent: string;
  className: string;
  hidden: boolean;
  value: string;
  disabled: boolean;
  checked: boolean;
  files: unknown[] | null;
  src?: string;
  readOnly: boolean;
  listeners: Record<string, ((...a: unknown[]) => void)[]>;
  addEventListener(type: string, fn: (...a: unknown[]) => void): void;
  removeAttribute(name: string): void;
  setAttribute(name: string, v: string): void;
  getAttribute(name: string): string | null;
  scrollIntoView(): void;
  fire(type: string): void;
}

function element(id: string): El {
  const el: El = {
    id,
    textContent: "",
    className: "",
    hidden: false,
    value: "",
    disabled: false,
    checked: false,
    files: null,
    readOnly: false,
    listeners: {},
    addEventListener(type, fn) {
      (el.listeners[type] ??= []).push(fn);
    },
    removeAttribute(name) {
      if (name === "src") delete el.src;
    },
    setAttribute(name, v) {
      if (name === "src") el.src = v;
    },
    getAttribute(name) {
      return name === "src" ? (el.src ?? null) : null;
    },
    scrollIntoView() {},
    fire(type) {
      for (const fn of el.listeners[type] ?? []) fn();
    },
  };
  return el;
}

interface FakeReader {
  result: unknown;
  onload: null | (() => void);
  onerror: null | (() => void);
  onabort: null | (() => void);
  readAsDataURL(file: unknown): void;
}

interface Harness {
  readonly el: (id: string) => El;
  /** Drive the real listener the page installed on the photo input. */
  readonly choosePhoto: (file: unknown) => void;
  readonly xhrs: { url: string; body: unknown; respond: (status: number, payload: unknown) => void }[];
  readonly readers: FakeReader[];
  readonly objectUrlCalls: number;
}

/**
 * Run the served page's own script against a minimal DOM and return handles into it.
 *
 * `new Function` with the globals as PARAMETERS, so the script sees these and the test process's
 * real `document`/`FileReader` are never touched.
 */
function runPage(opts: { readerBehaviour?: "ok" | "error" | "abort" | "throw" | "nonData" } = {}): Harness {
  const html = renderPhoneFormPage(FORM);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("the served page carries no <script> to run");

  // 🔴 THE HARNESS TAKES ITS INITIAL STATE FROM THE REAL MARKUP, not from a convenient default.
  // The preview wrapper ships `hidden` in the served HTML, and a fake DOM that quietly started it
  // visible would make "the preview appeared" pass without anything ever un-hiding it.
  const hiddenInMarkup = new Set<string>();
  for (const m of html.matchAll(/<[a-zA-Z]+[^>]*\bid="([a-zA-Z]+)"[^>]*>/g)) {
    if (/\shidden(\s|>)/.test(m[0])) hiddenInMarkup.add(m[1]!);
  }

  const nodes = new Map<string, El>();
  const el = (id: string): El => {
    let n = nodes.get(id);
    if (!n) {
      n = element(id);
      n.hidden = hiddenInMarkup.has(id);
      nodes.set(id, n);
    }
    return n;
  };

  const xhrs: Harness["xhrs"] = [];
  const readers: FakeReader[] = [];
  let objectUrlCalls = 0;

  class FakeXhr {
    status = 0;
    responseText = "";
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    private url = "";
    open(_m: string, url: string): void {
      this.url = url;
    }
    setRequestHeader(): void {}
    send(body: unknown): void {
      xhrs.push({
        url: this.url,
        body,
        respond: (status, payload) => {
          this.status = status;
          this.responseText = JSON.stringify(payload);
          this.onload?.();
        },
      });
    }
  }

  class FakeFileReader implements FakeReader {
    result: unknown = null;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    onabort: null | (() => void) = null;
    readAsDataURL(_file: unknown): void {
      readers.push(this);
      const how = opts.readerBehaviour ?? "ok";
      if (how === "throw") throw new Error("readAsDataURL refused");
      queueMicrotask(() => {
        if (how === "error") return void this.onerror?.();
        if (how === "abort") return void this.onabort?.();
        this.result = how === "nonData" ? "blob:http://10.0.0.5/abc" : "data:image/jpeg;base64,/9j/AAA=";
        this.onload?.();
      });
    }
  }

  const documentStub = {
    getElementById: (id: string) => el(id),
    querySelector: () => el("querySelector"),
    body: el("body"),
  };
  const windowStub = { location: { pathname: "/m/" + "a".repeat(64) }, scrollTo: () => {} };
  const urlStub = {
    createObjectURL: () => {
      objectUrlCalls += 1;
      throw new Error("createObjectURL must not be used: img-src does not admit blob:");
    },
    revokeObjectURL: () => {
      objectUrlCalls += 1;
      throw new Error("revokeObjectURL must not be used");
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function("window", "document", "XMLHttpRequest", "FileReader", "URL", script);
  run(windowStub, documentStub, FakeXhr, FakeFileReader, urlStub);

  return {
    el,
    choosePhoto: (file) => {
      const input = el("photoFile");
      input.files = [file];
      input.fire("change");
    },
    xhrs,
    readers,
    get objectUrlCalls() {
      return objectUrlCalls;
    },
  };
}

/** Let the queued microtasks the fake reader schedules actually run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the page the phone is served asks for nothing the policy refuses", () => {
  /**
   * 🔴 THE HEADER IS ONE HALF; THIS IS THE OTHER. `phoneSessionServer.test.ts` pins that img-src
   * admits `data:` and not `blob:`. A page that still called `createObjectURL` for an <img> would
   * be broken under that correct header, and the two can only drift apart silently.
   *
   * Comments are stripped before the assertion, because the prose above legitimately explains why
   * object URLs are avoided and would otherwise match the very pattern being banned.
   */
  it("🔴 the rendered form builds no object URL and reads the preview with a FileReader", () => {
    const html = renderPhoneFormPage(FORM);
    const code = html.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code).not.toMatch(/createObjectURL/);
    expect(code).not.toMatch(/revokeObjectURL/);
    expect(code).not.toMatch(/blob:/);
    expect(code).toMatch(/readAsDataURL/);
  });

  it("the preview image and its own status line are both present, and start hidden", () => {
    const html = renderPhoneFormPage(FORM);
    expect(html).toContain('data-testid="phone-photo-preview"');
    expect(html).toContain('data-testid="phone-photo-preview-status"');
    // 🔴 The wrapper ships hidden: a merchant must not meet an empty frame before choosing a
    // photo, and the harness below reads this same attribute rather than assuming it.
    expect(html).toMatch(/<div id="photoPreviewWrap"[^>]*\shidden(\s|>)/);
  });
});

describe("the photo preview is drawn from a data: URL", () => {
  it("🔴 the preview src is a data: URL and never a blob:, and the wrapper is shown", async () => {
    const h = runPage();
    h.choosePhoto({ type: "image/jpeg" });

    // The upload goes first and is the authority; the preview only follows a real 200.
    expect(h.xhrs).toHaveLength(1);
    expect(h.xhrs[0]!.url).toMatch(/\/photo$/);
    expect(h.el("photoPreviewWrap").hidden).toBe(true);

    h.xhrs[0]!.respond(200, { ok: true });
    await settle();

    const src = h.el("photoPreview").src ?? "";
    expect(src.startsWith("data:image/")).toBe(true);
    expect(src).not.toMatch(/^blob:/);
    expect(h.el("photoPreviewWrap").hidden).toBe(false);
    // The upload line still reports the upload, and the preview line is silent on success.
    expect(h.el("photoStatus").textContent).toContain("جاهزة");
    expect(h.el("photoPreviewNote").textContent).toBe("");
  });

  /**
   * 🔴 THE DISCRIMINATING HALF. The stub throws on any object-URL call, so this passing means the
   * path genuinely does not need one — not merely that a grep found no match.
   */
  it("🔴 no object URL is created or revoked anywhere in the path", async () => {
    const h = runPage();
    h.choosePhoto({ type: "image/jpeg" });
    h.xhrs[0]!.respond(200, { ok: true });
    await settle();
    expect(h.objectUrlCalls).toBe(0);
    expect(h.readers).toHaveLength(1);
  });

  it("a second photo replaces the preview rather than stacking one", async () => {
    const h = runPage();
    h.choosePhoto({ type: "image/jpeg" });
    h.xhrs[0]!.respond(200, { ok: true });
    await settle();
    const first = h.el("photoPreview").src;

    h.choosePhoto({ type: "image/png" });
    h.xhrs[1]!.respond(200, { ok: true });
    await settle();
    expect(h.readers).toHaveLength(2);
    expect(h.el("photoPreview").src).toBe(first);
    expect(h.el("photoPreviewWrap").hidden).toBe(false);
  });
});

describe("a preview that cannot be drawn costs the preview and nothing else", () => {
  /**
   * 🔴 THE WHOLE POINT OF SPLITTING THE TWO LINES. At this moment the till HAS the photo — it
   * answered 200 and staged the bytes. Telling the merchant the save failed because a thumbnail
   * did not render would be a lie that costs them the draft they are in the middle of.
   */
  for (const how of ["error", "abort", "throw", "nonData"] as const) {
    it(`🔴 FileReader ${how}: the draft, the session and the staged upload all survive`, async () => {
      const h = runPage({ readerBehaviour: how });
      h.el("nameAr").value = "مفتاح";
      h.el("price").value = "17.25";
      h.el("barcode").value = "5901234123457";

      h.choosePhoto({ type: "image/jpeg" });
      h.xhrs[0]!.respond(200, { ok: true });
      await settle();

      // The preview reports its own failure, readably, on its own line.
      expect(h.el("photoPreviewNote").textContent).toContain("تعذّر عرض المعاينة");
      expect(h.el("photoPreviewNote").className).toContain("bad");
      // No broken image is left behind: hidden, and with no src to fetch.
      expect(h.el("photoPreviewWrap").hidden).toBe(true);
      expect(h.el("photoPreview").src).toBeUndefined();

      // 🔴 THE UPLOAD REMAINS AUTHORITATIVE AND REMAINS SUCCESSFUL.
      expect(h.el("photoStatus").textContent).toContain("جاهزة");
      expect(h.el("photoStatus").className).toContain("ok");

      // The draft is untouched — nothing was cleared, nothing was disabled.
      expect(h.el("nameAr").value).toBe("مفتاح");
      expect(h.el("price").value).toBe("17.25");
      expect(h.el("barcode").value).toBe("5901234123457");
      expect(h.el("save").disabled).toBe(false);

      // And the session was never told anything: the only request made was the upload itself.
      expect(h.xhrs).toHaveLength(1);
    });
  }

  it("🔴 retry works — a later photo still previews after an earlier one failed", async () => {
    // The first reader errors; the page must not be left in a state that refuses the next one.
    const h = runPage({ readerBehaviour: "error" });
    h.choosePhoto({ type: "image/jpeg" });
    h.xhrs[0]!.respond(200, { ok: true });
    await settle();
    expect(h.el("photoPreviewWrap").hidden).toBe(true);

    // A second attempt goes through the same code path and is accepted.
    h.choosePhoto({ type: "image/jpeg" });
    expect(h.xhrs).toHaveLength(2);
    h.xhrs[1]!.respond(200, { ok: true });
    await settle();
    expect(h.readers).toHaveLength(2);
    expect(h.el("photoStatus").textContent).toContain("جاهزة");
  });

  /**
   * 🔴 A REFUSED UPLOAD DRAWS NO PREVIEW AT ALL. Preview success must never be able to imply
   * upload success, so the order is asserted: a non-200 reaches the reader never.
   */
  it("🔴 a refused upload shows the till's reason and never previews", async () => {
    const h = runPage();
    h.choosePhoto({ type: "image/jpeg" });
    h.xhrs[0]!.respond(422, { ok: false, code: "PHOTO_UNREADABLE", message: "الصورة غير مقروءة" });
    await settle();

    expect(h.readers).toHaveLength(0);
    expect(h.el("photoPreviewWrap").hidden).toBe(true);
    expect(h.el("photoPreview").src).toBeUndefined();
    expect(h.el("photoStatus").textContent).toBe("الصورة غير مقروءة");
    expect(h.el("photoStatus").className).toContain("bad");
  });
});
