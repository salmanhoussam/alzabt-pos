/**
 * E2E — the Product Master workspace against the REAL app, for VISUAL review.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 THIS SCRIPT EXISTS TO PRODUCE EVIDENCE NO UNIT TEST CAN. 922 unit tests, a clean typecheck and
 * a clean build say nothing about whether a screen READS correctly: whether Arabic is aligned,
 * whether a 13-digit barcode reorders beside it, whether a thumbnail is cropped or stretched,
 * whether a row's height explodes, whether a dropdown shows the retired category it is supposed to.
 * Those are answered by looking, and the screenshots below are what there is to look at.
 *
 * 🔴 THE PHOTO IN THESE SCREENSHOTS IS NOW REAL, and the caveat that used to stand here is gone.
 * Until slice F there was no producer, so one row was written by raw SQL and this header said so,
 * so nobody would read a screenshot as proof that importing a photo worked. The producer exists:
 * the photo below is a real fixture file, chosen through the real dialog, decoded and normalized by
 * the shipped pipeline. `e2e/product-photo.mjs` proves that path in full; this script's job is
 * still what a screenshot is for — whether the screen READS correctly.
 *
 * Selectors are data-testid, never visible text — the terminal's default language is Arabic.
 *
 * Run: node e2e/product-master.mjs        (CI sets E2E_EXECUTABLE to the installed .exe)
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { _electron as electron } from "playwright-core";
import { signIn } from "./_signin.mjs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED = process.env.E2E_EXECUTABLE;
const ELECTRON = PACKAGED ?? createRequire(import.meta.url)("electron");
const APP_ARGS = PACKAGED ? [] : [APP];
const SHOTS = join(APP, "e2e-output") + "/";
mkdirSync(SHOTS, { recursive: true });
const EXTRA_ARGS = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];

const home = mkdtempSync(join(tmpdir(), "pos-e2e-master-"));
const env = { ...process.env, ALZABT_POS_USER_DATA: join(home, "userData") };
const Database = createRequire(import.meta.url)("better-sqlite3");
const LEDGER = join(home, "userData", "alzabt-pos-ledger.sqlite");

const log = (...a) => console.log("•", ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  log("PASS", msg);
};

async function launch() {
  const app = await electron.launch({ executablePath: ELECTRON, args: [...EXTRA_ARGS, ...APP_ARGS], env });
  const page = await app.firstWindow();
  await signIn(page, "Cashier One", "1111");
  await page.locator('[data-testid="tab-products"]').click();
  return { app, page };
}

/** A real PNG: solid colour, correct zlib stream, correct CRC32 per chunk. */

/**
 * 🔴 IS ANY OF THESE ACTUALLY DRAWN UNDER THE ACTION BAR?
 *
 * The real question E2.1 exists to answer, and a selector cannot answer it: an element can be in
 * the document, on screen, and still have Save and Cancel drawn across it.
 *
 * 🔴 AND THE FIRST VERSION OF THIS CHECK WAS WRONG, WHICH IS WORTH KEEPING. It compared raw
 * `getBoundingClientRect()` values — and a rect is the LAYOUT box, reported in full even when
 * `overflow` clips the element. So a field scrolled below the visible part of the form reported
 * coordinates beneath the footer while being invisible there, and the check failed on a layout
 * that was correct. It was measuring where a thing WOULD be, not where it is drawn.
 *
 * Each element's rect is now intersected with the scroll container's own box first — its visible
 * portion — and only that is compared against the footer. Offenders come back by name, so a
 * failure says WHICH field was buried.
 */
const coveredByFooter = (page, ids) =>
  page.evaluate((names) => {
    const footer = document.querySelector('[data-testid="form-footer"]');
    const box = document.querySelector(".form-scroll");
    if (footer === null) return ["NO FOOTER FOUND"];
    if (box === null) return ["NO SCROLL REGION FOUND"];
    const f = footer.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const hits = [];
    for (const name of names) {
      const el = document.querySelector(`[data-testid="${name}"]`);
      if (el === null) continue;
      const r = el.getBoundingClientRect();
      // The part of the element the viewer can actually see: its rect clipped to the scroll box.
      const top = Math.max(r.top, b.top);
      const bottom = Math.min(r.bottom, b.bottom);
      const left = Math.max(r.left, b.left);
      const right = Math.min(r.right, b.right);
      if (bottom <= top || right <= left) continue; // entirely scrolled out: nothing is drawn
      if (left < f.right && right > f.left && top < f.bottom && bottom > f.top) hits.push(name);
    }
    return hits;
  }, ids);

/**
 * 🔴 THE STRUCTURAL GUARANTEE, measured once: the scrolling region ENDS above the action bar.
 *
 * This is what makes the clipped check above non-vacuous. If the footer ever goes back to being
 * `position: sticky` INSIDE the scroll box — the arrangement that caused the defect — the two
 * boxes overlap and this fails immediately, whatever any individual field happens to be doing.
 */
const footerIsBelowTheScrollRegion = (page) =>
  page.evaluate(() => {
    const footer = document.querySelector('[data-testid="form-footer"]');
    const box = document.querySelector(".form-scroll");
    if (footer === null || box === null) return { ok: false, why: "missing footer or scroll region" };
    const f = footer.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return { ok: b.bottom <= f.top + 1, scrollBottom: Math.round(b.bottom), footerTop: Math.round(f.top) };
  });

/** Scrolls the form's own region, not the page. */
const scrollForm = (page, to) =>
  page.evaluate((y) => {
    const box = document.querySelector(".form-scroll");
    if (box !== null) box.scrollTop = y === "end" ? box.scrollHeight : y;
    return box === null ? -1 : box.scrollTop;
  }, to);

async function addProduct(page, { nameAr, nameEn, sku, price, unit, barcode, brand, descAr, online, category }) {
  await page.locator('[data-testid="add-product"]').click();
  await page.locator('[data-testid="field-nameAr"]').fill(nameAr);
  const inputs = page.locator(".product-form input");
  if (nameEn !== undefined) await inputs.nth(1).fill(nameEn);
  if (sku !== undefined) await inputs.nth(2).fill(sku);
  if (barcode !== undefined) await page.locator('[data-testid="field-barcode"]').fill(barcode);
  if (brand !== undefined) await page.locator('[data-testid="field-brand"]').fill(brand);
  if (category !== undefined) await page.locator('[data-testid="field-category"]').selectOption(category);
  await page.locator('[data-testid="field-price"]').fill(price);
  await page.locator('[data-testid="field-unit"]').selectOption(unit);
  if (descAr !== undefined) await page.locator('[data-testid="field-descAr"]').fill(descAr);
  if (online) await page.locator('[data-testid="field-online"]').check();
  await page.locator('[data-testid="save-product"]').click();
  await page.locator(".dialog .btn.primary.wide").click();
}

const rows = (page) => page.locator('[data-testid="product-row"]');

/**
 * R1 — IS EVERY CELL READABLE, AND IS EVERY OWNER CONTROL ACTUALLY CLICKABLE?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 TWO LESSONS ARE BUILT INTO THIS, BOTH PAID FOR.
 *
 * 1 · DOM TEXT CANNOT SEE CLIPPING. `innerText` returns "7.50 USD" whether the cell draws it in
 *     full or hides its first digit under a button — which is exactly what the Arabic owner screen
 *     did (run 39573996462). Only rectangles tell those apart.
 *
 * 2 · RECTANGLES CANNOT SEE INTERCEPTION. The first R1 attempt checked actions against price and
 *     unit only, passed its own geometry, and still broke the product: the STATE column's badges
 *     overflowed onto the Edit button and ate its clicks (run 39577792181). Two boxes can be
 *     mathematically disjoint while a third element paints over the one you care about. So every
 *     cell is compared against every other, and each control is HIT-TESTED with
 *     `document.elementFromPoint` at its centre and at interior points — the browser's own answer
 *     to "what would a click land on", which is the question Playwright was really asking.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
const CELLS = ["col-thumb", "col-name", "col-codes", "col-category", "col-price", "col-unit", "col-state", "col-actions"];

async function productRowGeometry(page) {
  return page.evaluate((cells) => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
    };
    // A pixel of slack absorbs sub-pixel rounding; anything more is a real intersection.
    const overlaps = (a, b) =>
      a !== null && b !== null && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

    return [...document.querySelectorAll('[data-testid="product-row"]')].map((tr, i) => {
      const found = {};
      for (const c of cells) found[c] = tr.querySelector(`td.${c}`);

      const boxes = {};
      for (const c of cells) boxes[c] = box(found[c]);

      // Every pair, not a chosen two. Named so a failure says WHICH columns collided.
      const collisions = [];
      for (let a = 0; a < cells.length; a++) {
        for (let b = a + 1; b < cells.length; b++) {
          if (overlaps(boxes[cells[a]], boxes[cells[b]])) collisions.push(`${cells[a]}×${cells[b]}`);
        }
      }

      // Content wider than its own cell is content the operator cannot fully read.
      const overflowing = cells.filter((c) => {
        const el = found[c];
        return el !== null && el.scrollWidth > el.clientWidth + 1;
      });

      // 🔴 THE VISIBLE STRIP IS NOT THE WINDOW. `.admin-table-scroll` clips its own overflow, so a
      // button can have a perfectly good box, sit entirely inside its own cell, and still be
      // unreachable until the operator scrolls the table. That is a SCROLLING fact, not a layout
      // defect, and the two are reported separately below — conflating them is what made the old
      // check call ordinary horizontal scrolling a failure.
      const scroller = tr.closest(".admin-table-scroll");
      const scBox = scroller === null ? null : scroller.getBoundingClientRect();
      const sv =
        scBox === null
          ? null
          : { left: Math.max(Math.round(scBox.left), 0), right: Math.min(Math.round(scBox.right), window.innerWidth) };
      const scroll =
        scroller === null
          ? null
          : {
              scrollWidth: Math.round(scroller.scrollWidth),
              clientWidth: Math.round(scroller.clientWidth),
              scrollLeft: Math.round(scroller.scrollLeft),
              overflowX: getComputedStyle(scroller).overflowX,
              scrollable: scroller.scrollWidth > scroller.clientWidth + 1,
            };

      const priceRun = found["col-price"]?.querySelector("bdi") ?? null;
      const pc = boxes["col-price"];
      const pr = box(priceRun);

      // 🔴 HIT-TESTING: what would a click actually land on? Centre plus four interior points, so a
      // badge covering only part of a button is caught too.
      const buttons = found["col-actions"] ? [...found["col-actions"].querySelectorAll("button")] : [];
      const actionsCellButtons = buttons;
      const hits = buttons.map((btn) => {
        const r = btn.getBoundingClientRect();
        const probes = [
          [r.left + r.width / 2, r.top + r.height / 2],
          [r.left + r.width * 0.25, r.top + r.height / 2],
          [r.left + r.width * 0.75, r.top + r.height / 2],
          [r.left + r.width / 2, r.top + r.height * 0.25],
          [r.left + r.width / 2, r.top + r.height * 0.75],
        ];
        const blockedBy = [];
        for (const [x, y] of probes) {
          const top = document.elementFromPoint(Math.round(x), Math.round(y));
          if (top === null) { blockedBy.push("offscreen"); continue; }
          if (top !== btn && !btn.contains(top)) {
            const id = top.getAttribute("data-testid");
            blockedBy.push(id ? `${top.tagName.toLowerCase()}[${id}]` : top.tagName.toLowerCase());
          }
        }
        const cell = boxes["col-actions"];
        return {
          testid: btn.getAttribute("data-testid"),
          box: box(btn),
          clickable: blockedBy.length === 0,
          blockedBy: [...new Set(blockedBy)],
          // 🔴 B · INSIDE ITS OWN CELL. 16px-wide cell, buttons rendering past it and under the
          // neighbouring column, is exactly what "no two cells overlap" could not see.
          insideCell:
            cell !== null &&
            r.left >= cell.left - 1 && r.right <= cell.right + 1 &&
            r.top >= cell.top - 1 && r.bottom <= cell.bottom + 1,
          // 🔴 C · IS IT IN THE VISIBLE STRIP RIGHT NOW? Only a button that IS determines whether
          // `clickable` above is a claim about the layout at all: `elementFromPoint` answers
          // `null` for anything outside the window, which reads identically to "covered".
          inScrollView:
            sv !== null && r.left >= sv.left - 1 && r.right <= sv.right + 1 && r.top >= 0 && r.bottom <= window.innerHeight,
          needsScroll:
            sv === null ? null : Math.round(r.left < sv.left ? sv.left - r.left : r.right > sv.right ? r.right - sv.right : 0),
        };
      });

      // 🔴 A · IS THIS STILL A TABLE CELL? The whole defect was a `<td>` turned into a flex
      // container, which stops the column algorithm sizing it. Read the computed value rather
      // than trusting the class list.
      const actionsEl = found["col-actions"];
      const wrapper = actionsEl?.querySelector(".admin-actions") ?? null;
      const head = document.querySelector("thead th.col-actions");
      const hb = head ? head.getBoundingClientRect() : null;
      const ab = boxes["col-actions"];

      const rowBox = box(tr);

      return {
        row: i,
        rowHeight: rowBox?.height ?? null,
        // 🔴 ONE LINE OF BUTTONS, OR THE ROW GROWS. Three stacked buttons measured 137px against a
        // contract of under 110 (run 39618284936) — a third fewer products on screen, with nothing
        // overlapping and every button clickable. Geometry alone could not call that wrong.
        actionsLines: (() => {
          const btns = actionsCellButtons;
          if (btns.length < 2) return 1;
          const tops = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top)));
          return tops.size;
        })(),
        actionsDisplay: actionsEl ? getComputedStyle(actionsEl).display : null,
        wrapperDisplay: wrapper ? getComputedStyle(wrapper).display : null,
        wrapperIsChild: wrapper !== null && wrapper.parentElement === actionsEl,
        // The header cell and the body cell must describe the SAME column.
        headerAligned: hb !== null && ab !== null && Math.abs(hb.left - ab.left) <= 2 && Math.abs(hb.right - ab.right) <= 2,
        headerBox: hb ? { left: Math.round(hb.left), right: Math.round(hb.right) } : null,
        priceText: (priceRun?.textContent ?? "").trim(),
        unitText: (found["col-unit"]?.textContent ?? "").trim(),
        stateText: (found["col-state"]?.textContent ?? "").trim(),
        nameText: (found["col-name"]?.textContent ?? "").trim().slice(0, 40),
        widths: Object.fromEntries(cells.map((c) => [c, boxes[c]?.width ?? null])),
        scroll,
        scrollView: sv,
        collisions,
        overflowing,
        priceFitsCell: pc !== null && pr !== null && pr.left >= pc.left - 1 && pr.right <= pc.right + 1 && pr.width > 0,
        buttons: hits,
      };
    });
  }, CELLS);
}

/** Assert every row reads cleanly AND every control is genuinely clickable. Names the geometry. */
async function assertNoClipping(page, where) {
  const g = await productRowGeometry(page);
  assert(g.length > 0, `${where}: there are rows to measure (${g.length})`);
  log(`R1 ${where} column widths: ${JSON.stringify(g[0].widths)}`);
  for (const r of g) {
    const id = `${where} row ${r.row} ("${r.priceText}")`;
    assert(r.priceText.length > 0, `${id}: the price renders text`);
    assert(r.priceFitsCell, `${id}: the price run fits INSIDE its cell`);
    assert(r.unitText.length > 0, `${id}: the unit renders text ("${r.unitText}")`);
    assert(r.stateText.length > 0, `${id}: the state renders text ("${r.stateText}")`);
    assert(
      r.overflowing.length === 0,
      `🔴 ${id}: NO cell hides its own content — overflowing: ${r.overflowing.join(", ") || "none"} · widths ${JSON.stringify(r.widths)}`,
    );
    assert(
      r.collisions.length === 0,
      `🔴 ${id}: NO two cells overlap — collisions: ${r.collisions.join(", ") || "none"} · widths ${JSON.stringify(r.widths)}`,
    );
    assert(
      r.rowHeight !== null && r.rowHeight < 110,
      `🔴 ${id}: the row stays under the long-standing 110px contract (${r.rowHeight}px, action buttons on ${r.actionsLines} line(s))`,
    );
    assert(
      r.actionsLines === 1 || r.buttons.length < 2,
      `🔴 ${id}: the action buttons sit on ONE line (${r.actionsLines} lines, cell width ${r.widths["col-actions"]})`,
    );
    assert(
      r.actionsDisplay === "table-cell",
      `🔴 ${id}: the actions cell is still a TABLE CELL, not a flex container (display: ${r.actionsDisplay})`,
    );
    if (r.buttons.length > 0) {
      assert(r.wrapperIsChild === true, `${id}: the flex layout sits on a child wrapper of the cell`);
      assert(r.wrapperDisplay === "flex", `${id}: and that wrapper is the flex container (display: ${r.wrapperDisplay})`);
    }
    assert(
      r.headerAligned,
      `${id}: the header and body actions cells describe the same column (head ${JSON.stringify(r.headerBox)} body width ${r.widths["col-actions"]})`,
    );
    for (const b of r.buttons) {
      assert(
        b.insideCell,
        `🔴 ${id}: "${b.testid}" stays INSIDE its own actions cell — button ${JSON.stringify(b.box)} cell width ${r.widths["col-actions"]}`,
      );
      if (b.inScrollView) {
        assert(
          b.clickable,
          `🔴 ${id}: "${b.testid}" is actually clickable — elementFromPoint hit ${b.blockedBy.join(", ")} instead (box ${JSON.stringify(b.box)})`,
        );
      } else {
        // 🔴 NOT A DEFECT, AND NOT TAKEN ON TRUST EITHER. A control outside the strip is reachable
        // by the ordinary horizontal scrolling the container exists for — but only if the container
        // really can scroll that far, which is asserted here, and only if the scroll then actually
        // lands the click, which `revealAction` + a real Playwright click prove below. This branch
        // never excuses a control that is covered WHERE IT SITS: that case is the branch above.
        // 🔴 THE MESSAGE HAS TO READ TRUE WHEN IT PASSES. `assert` here prints "PASS <message>", so
        // a message phrased as the failure produces a log line that states the opposite of what
        // happened — this one printed "…the container CANNOT scroll to it" on every success.
        // Evidence that contradicts itself is worse than no evidence.
        assert(
          r.scroll !== null && r.scroll.scrollable,
          `${id}: "${b.testid}" sits ${b.needsScroll}px outside the visible strip, and the container CAN scroll to it (${JSON.stringify(r.scroll)})`,
        );
        log(
          `R1 ${id}: "${b.testid}" needs ${b.needsScroll}px of ordinary horizontal scrolling ` +
            `(strip ${r.scroll.clientWidth}px of ${r.scroll.scrollWidth}px, overflow-x: ${r.scroll.overflowX})`,
        );
      }
    }
  }
  return g;
}


/**
 * R1 · REVEAL AN ACTION BY SCROLLING THE REAL CONTAINER — THEN HIT-TEST, THEN CLICK.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS CORRECTS. At the default window the eight columns measure ~978px inside a ~944px
 * strip, so the LAST control in the run starts just outside `.admin-table-scroll`. The previous
 * check hit-tested it at the initial scroll offset — where `elementFromPoint` answers `null` —
 * and reported a layout defect. It was not one: scrolling that strip is what the container is for.
 * The defect was the SEQUENCE, so the sequence is what changed here.
 *
 * 🔴 AND WHY NOTHING HERE ASSUMES A DIRECTION. The screen is `dir="rtl"` in Arabic and `ltr` in
 * English, and `scrollLeft` does not mean the same thing in both: Chrome reports a NEGATIVE range
 * in RTL, other engines have used a reversed positive one. So this never decides which way to go
 * from the writing direction. It computes the shortfall from real rectangles, applies it, MEASURES
 * whether the button actually moved, and only if it did not does it try the opposite sign. A
 * container that cannot move at all is reported as exactly that, not looped over.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
async function revealAction(page, sku, testid) {
  return page.evaluate(
    ({ sku, testid }) => {
      const row = [...document.querySelectorAll('[data-testid="product-row"]')].find((tr) =>
        (tr.textContent ?? "").includes(sku),
      );
      if (row === undefined) return { ok: false, why: `no product row contains "${sku}"` };
      const btn = row.querySelector(`[data-testid="${testid}"]`);
      if (btn === null) return { ok: false, why: `row "${sku}" carries no "${testid}" control` };
      const sc = btn.closest(".admin-table-scroll");
      if (sc === null) return { ok: false, why: `"${testid}" has no .admin-table-scroll ancestor to scroll` };

      // The strip the operator can actually see: the container's own box, clipped by the window.
      const strip = () => {
        const c = sc.getBoundingClientRect();
        return { left: Math.max(c.left, 0), right: Math.min(c.right, window.innerWidth) };
      };
      const inside = () => {
        const r = btn.getBoundingClientRect();
        const s = strip();
        return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= 0 && r.bottom <= window.innerHeight;
      };

      const scrolledFrom = Math.round(sc.scrollLeft);
      const steps = [];
      for (let i = 0; i < 12 && !inside(); i++) {
        const r = btn.getBoundingClientRect();
        const s = strip();
        const delta = Math.round(r.left < s.left ? r.left - s.left : r.right - s.right);
        if (delta === 0) break;
        const slBefore = sc.scrollLeft;
        const leftBefore = r.left;
        sc.scrollLeft = slBefore + delta;
        let moved = btn.getBoundingClientRect().left - leftBefore;
        const step = { delta, slFrom: Math.round(slBefore), slTo: Math.round(sc.scrollLeft), moved: Math.round(moved), reversed: false };
        if (Math.abs(moved) < 1) {
          sc.scrollLeft = slBefore - delta;
          moved = btn.getBoundingClientRect().left - leftBefore;
          step.reversed = true;
          step.slTo = Math.round(sc.scrollLeft);
          step.moved = Math.round(moved);
        }
        steps.push(step);
        if (Math.abs(moved) < 1) break; // genuinely immovable — report it rather than spin
      }

      const r = btn.getBoundingClientRect();
      const s = strip();
      // The browser's own answer to "what would a click land on", asked only now that the button
      // is where the operator would have scrolled it to.
      const probes = [
        [0.5, 0.5],
        [0.25, 0.5],
        [0.75, 0.5],
        [0.5, 0.25],
        [0.5, 0.75],
      ].map(([fx, fy]) => {
        const x = Math.round(r.left + r.width * fx);
        const y = Math.round(r.top + r.height * fy);
        const top = document.elementFromPoint(x, y);
        return {
          x,
          y,
          ok: top !== null && (top === btn || btn.contains(top)),
          hit: top === null ? "nothing" : (top.getAttribute("data-testid") ?? top.tagName.toLowerCase()),
        };
      });

      return {
        ok: true,
        dir: document.documentElement.dir,
        inside: inside(),
        scrolledFrom,
        scrolledTo: Math.round(sc.scrollLeft),
        steps,
        strip: { left: Math.round(s.left), right: Math.round(s.right) },
        box: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) },
        scroll: {
          scrollWidth: Math.round(sc.scrollWidth),
          clientWidth: Math.round(sc.clientWidth),
          overflowX: getComputedStyle(sc).overflowX,
          scrollable: sc.scrollWidth > sc.clientWidth + 1,
        },
        probes,
        blockers: [...new Set(probes.filter((pr) => !pr.ok).map((pr) => pr.hit))],
      };
    },
    { sku, testid },
  );
}

/** The row's own state, as the operator reads it — class and badge text, not an internal flag. */
const rowState = (page, sku) =>
  page.evaluate((s) => {
    const tr = [...document.querySelectorAll('[data-testid="product-row"]')].find((x) => (x.textContent ?? "").includes(s));
    if (tr === undefined) return null;
    return {
      inactive: tr.classList.contains("row-inactive"),
      state: (tr.querySelector("td.col-state")?.textContent ?? "").trim(),
    };
  }, sku);

/**
 * Is the scrollable strip usable, or is something painting over it?
 *
 * 🔴 Asked at four real points inside the strip rather than from its CSS. `overflow-x: auto` is a
 * declaration; what the operator can reach is a hit test.
 */
const stripUsable = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector(".admin-table-scroll");
    if (sc === null) return { ok: false, why: "no .admin-table-scroll on this screen" };
    const c = sc.getBoundingClientRect();
    const left = Math.max(c.left, 0);
    const right = Math.min(c.right, window.innerWidth);
    const bottom = Math.min(c.bottom, window.innerHeight);
    const hits = [];
    for (const y of [c.top + 8, (c.top + bottom) / 2]) {
      for (const x of [left + 8, right - 8]) {
        const top = document.elementFromPoint(Math.round(x), Math.round(y));
        hits.push({
          x: Math.round(x),
          y: Math.round(y),
          inScroller: top !== null && sc.contains(top),
          hit: top === null ? "nothing" : (top.getAttribute("data-testid") ?? top.tagName.toLowerCase()),
        });
      }
    }
    return { ok: true, overflowX: getComputedStyle(sc).overflowX, box: { left: Math.round(left), right: Math.round(right) }, hits };
  });

/**
 * R1 · THE WHOLE ACCEPTANCE, IN ONE ORDER, IN ONE WRITING DIRECTION.
 *
 * 🔴 RUN IN BOTH DIRECTIONS ON PURPOSE. Arabic is RTL and English is LTR, the offscreen action is
 * at the opposite end of the run in each, and `scrollLeft` behaves differently between them — so a
 * pass in one direction is a pass in one direction. The toggle is restored afterwards, because
 * every later assertion on this screen reads the state badge this click changes.
 */
async function proveActionsReachable(page, { sku, where, deactivated, activated, shot }) {
  // 1 · WITHOUT SCROLLING AT ALL: the two actions the owner uses constantly are already there.
  const geom = await productRowGeometry(page);
  const immediate = geom.flatMap((r) =>
    r.buttons.filter((b) => b.testid === "product-edit" || b.testid === "product-edit-phone").map((b) => ({ row: r.row, ...b })),
  );
  assert(immediate.length > 0, `${where}: there are Edit / Edit-phone controls to measure`);
  for (const b of immediate) {
    assert(
      b.inScrollView,
      `🔴 ${where}: "${b.testid}" on row ${b.row} is immediately accessible with NO scrolling (short by ${b.needsScroll}px, box ${JSON.stringify(b.box)})`,
    );
    assert(b.clickable, `🔴 ${where}: "${b.testid}" on row ${b.row} is clickable exactly where it sits`);
  }
  log(`R1 ${where}: ${immediate.length} Edit / Edit-phone controls reachable with no scrolling`);

  // 2 · THE STRIP ITSELF IS USABLE — nothing is painting over the area to be scrolled.
  const usable = await stripUsable(page);
  assert(usable.ok, `${where}: ${usable.why ?? "the table strip exists"}`);
  assert(
    usable.overflowX === "auto" || usable.overflowX === "scroll",
    `${where}: the table strip really is the scroller (overflow-x: ${usable.overflowX})`,
  );
  assert(
    usable.hits.every((h) => h.inScroller),
    `🔴 ${where}: no other UI layer covers the scrollable strip — ${JSON.stringify(usable.hits)}`,
  );

  // 3 · SCROLL THE REAL CONTAINER, and prove the button ended up genuinely inside the strip.
  const before = await rowState(page, sku);
  assert(before !== null, `${where}: the row "${sku}" is on screen`);
  const reveal = await revealAction(page, sku, "product-deactivate");
  assert(reveal.ok, `${where}: ${reveal.why ?? "the deactivate control was found"}`);
  log(`R1 ${where} reveal(product-deactivate, dir=${reveal.dir}): ${JSON.stringify(reveal)}`);
  assert(reveal.scroll.scrollable, `${where}: the strip has something to scroll (${JSON.stringify(reveal.scroll)})`);
  assert(
    reveal.inside,
    `🔴 ${where}: after scrolling, "product-deactivate" is INSIDE the visible strip (box ${JSON.stringify(reveal.box)} strip ${JSON.stringify(reveal.strip)})`,
  );
  // 4 · AND ONLY THERE, the hit test — the browser's own answer, not a rectangle of mine.
  assert(
    reveal.blockers.length === 0,
    `🔴 ${where}: nothing covers it where it now sits — elementFromPoint hit ${reveal.blockers.join(", ")} (${JSON.stringify(reveal.probes)})`,
  );
  if (shot !== undefined) await page.screenshot({ path: SHOTS + shot });

  // 5 · THE REAL CLICK, interception ON, no `force`. And then: did it DO anything?
  const target = rows(page).filter({ hasText: sku });
  assert((await target.count()) === 1, `${where}: exactly one row is ${sku}`);
  await target.locator('[data-testid="product-deactivate"]').click();
  const dialog = page.locator(".overlay .card.dialog p").first();
  await dialog.waitFor({ state: "visible", timeout: 30000 });
  const said = (await dialog.textContent()) ?? "";
  assert(
    said.includes(deactivated),
    `🔴 ${where}: the click really deactivated the product — the shop was told "${said.trim()}"`,
  );
  await page.locator(".dialog .btn.primary.wide").click();
  await page.waitForFunction(
    (s) => {
      const tr = [...document.querySelectorAll('[data-testid="product-row"]')].find((x) => (x.textContent ?? "").includes(s));
      return tr !== undefined && tr.classList.contains("row-inactive");
    },
    sku,
    { timeout: 30000 },
  );
  const after = await rowState(page, sku);
  assert(
    after !== null && after.inactive && after.state !== before.state,
    `🔴 ${where}: the row itself changed — "${before.state}" → "${after?.state}"`,
  );
  log(`R1 ${where}: deactivate reached by ordinary scrolling and it WORKED ("${before.state}" → "${after.state}")`);

  // 6 · PUT IT BACK. Everything after this reads the state badge.
  const back = await revealAction(page, sku, "product-deactivate");
  assert(back.ok && back.inside, `${where}: the control is reachable again to restore the product`);
  await target.locator('[data-testid="product-deactivate"]').click();
  const again = page.locator(".overlay .card.dialog p").first();
  await again.waitFor({ state: "visible", timeout: 30000 });
  const saidBack = (await again.textContent()) ?? "";
  assert(saidBack.includes(activated), `${where}: and re-activating says so ("${saidBack.trim()}")`);
  await page.locator(".dialog .btn.primary.wide").click();
  await page.waitForFunction(
    (s) => {
      const tr = [...document.querySelectorAll('[data-testid="product-row"]')].find((x) => (x.textContent ?? "").includes(s));
      return tr !== undefined && !tr.classList.contains("row-inactive");
    },
    sku,
    { timeout: 30000 },
  );
  const restored = await rowState(page, sku);
  assert(
    restored !== null && restored.state === before.state,
    `${where}: the product is left exactly as it was found ("${restored?.state}" vs "${before.state}")`,
  );

  // 🔴 AND THE VIEW IS PUT BACK TOO, because the very next line of this script photographs this
  // screen under a filename that says "products". A capture of a table left scrolled by a test
  // would be a picture of the test, not of the screen the shop opens.
  const parked = await page.evaluate((from) => {
    const sc = document.querySelector(".admin-table-scroll");
    if (sc === null) return null;
    sc.scrollLeft = from;
    return Math.round(sc.scrollLeft);
  }, reveal.scrolledFrom);
  assert(
    parked === reveal.scrolledFrom,
    `${where}: the table is returned to the offset it was found at (${parked} vs ${reveal.scrolledFrom})`,
  );
  return reveal;
}

/**
 * Is this element actually ON SCREEN — inside the window, with a real box?
 *
 * 🔴 MEASURED, NOT ASKED. `locator.isIntersectingViewport` does not exist in this playwright-core
 * (it is an ElementHandle method), and the first run failed on exactly that. A rect against
 * `innerWidth`/`innerHeight` is the thing being claimed anyway: an element inside a scrollable
 * dialog always has a box, and whether that box is within the window is what "obvious on opening"
 * means.
 */
const onScreen = (page, testid) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el === null) return false;
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= window.innerHeight &&
      r.right <= window.innerWidth
    );
  }, testid);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · Categories first — the owner's list, and a RETIRED one, which §W wants visible
// ════════════════════════════════════════════════════════════════════════════════════════════════
let { app, page } = await launch();

await page.locator('[data-testid="manage-categories"]').click();
await page.locator('[data-testid="cat-empty"]').waitFor();
// The manager stays open across each save; only the confirmation overlay comes and goes.
for (const [ar, en] of [["عدد", "Tools"], ["دهان", "Paint"], ["سباكة", "Plumbing"]]) {
  await page.locator('[data-testid="cat-nameAr"]').fill(ar);
  await page.locator('.cat-add input[lang="en"]').fill(en);
  await page.locator('[data-testid="cat-add"]').click();
  await page.locator(".dialog .btn.primary.wide").click();
}
assert((await page.locator('[data-testid="cat-row"]').count()) === 3, "three categories exist");

// Retire the last one, so the dropdown's retired case can be photographed later.
await page.locator('[data-testid="cat-row"]').last().locator("button").first().click();
await page.locator(".dialog .btn.primary.wide").click();
await page.screenshot({ path: SHOTS + "PM1-categories-arabic.png" });
await page.locator('[data-testid="cat-close"]').click();
log("PM1 — category management, one retired");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Add Product — the three sections, with the empty photo state (§W 2, 5, 6, 7)
// ════════════════════════════════════════════════════════════════════════════════════════════════
await page.locator('[data-testid="add-product"]').click();
await page.locator('[data-testid="photo-new-product"]').waitFor();
await page.screenshot({ path: SHOTS + "PM2-add-product-sections.png" });
// The same rule for Add: a merchant adding a product must see all three sections at once.
assert(
  await onScreen(page, "photo-panel"),
  "the photo section is visible on the Add form without scrolling",
);
assert(
  await onScreen(page, "save-product"),
  "Save is visible on the Add form without scrolling",
);

// 🔴 THE FORM OPENS AT THE TOP.
assert((await scrollForm(page, 0)) === 0, "the Add form opens scrolled to the top");

// 🔴 NO FIELD PASSES UNDER SAVE/CANCEL — AT ANY SCROLL POSITION. This is the defect E2.1 exists
// to close: the footer used to be sticky INSIDE the scrolling card, so content ran beneath it.
const WATCHED = [
  "field-nameAr",
  "field-barcode",
  "field-category",
  "field-brand",
  "field-price",
  "field-unit",
  "field-descAr",
  "field-descEn",
  "field-online",
  "photo-panel",
];
{
  const g = await footerIsBelowTheScrollRegion(page);
  assert(g.ok, `the scroll region ends above the action bar (bottom ${g.scrollBottom} vs footer top ${g.footerTop})`);
}
for (const position of [0, 150, 300, "end"]) {
  await scrollForm(page, position);
  const buried = await coveredByFooter(page, WATCHED);
  assert(buried.length === 0, `nothing is drawn under the action bar at scroll ${position} (${buried.join(", ") || "none"})`);
}
await scrollForm(page, "end");
await page.screenshot({ path: SHOTS + "E2.1-D-add-product-lower.png" });
await scrollForm(page, 0);
await page.screenshot({ path: SHOTS + "E2.1-C-add-product-top.png" });
log("C/D — Add Product top and lower, nothing under the action bar at any scroll");

// 🔴 AND A NATIVE DROPDOWN OPENED AT THE BOTTOM DOES NOT COLLIDE WITH IT.
await scrollForm(page, "end");
await page.locator('[data-testid="field-category"]').scrollIntoViewIfNeeded();
await page.locator('[data-testid="field-category"]').click();
assert(
  (await coveredByFooter(page, ["field-category"])).length === 0,
  "the category select is not under the action bar when opened near the bottom",
);
await page.screenshot({ path: SHOTS + "E2.1-H-footer-with-dropdown.png" });
log("H — the action bar with a native dropdown open");
await page.keyboard.press("Escape");
await scrollForm(page, 0);
assert(
  (await page.locator('[data-testid="field-barcode"]').count()) === 1,
  "the Add form has a barcode field (§W 6)",
);
assert(
  (await page.locator('[data-testid="field-online"]').count()) === 1,
  "the Add form has the online-catalogue section (§W 7)",
);
// 🔴 The empty state is a PICTURE FRAME with a glyph, not a dashed box that reads as an input.
assert(
  (await page.locator('[data-testid="photo-new-product"] .photo-glyph').count()) === 1,
  "the empty photo state draws a photo glyph, not an empty square",
);
await page.locator('[data-testid="photo-new-product"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: SHOTS + "E2.1-G-empty-photo-state.png" });
log("G — the empty photo state");
// 🔴 The chooser offers both ACTIVE categories and not the retired one — on a NEW product there is
// no assigned category, so a retired one must not be on offer at all.
const options = await page.locator('[data-testid="field-category"] option').allTextContents();
assert(options.length === 3, `the chooser offers 'no category' + two active ones, got ${options.length}`);
assert(!options.join("|").includes("متوقّف"), "a retired category is NOT offered for a new product");
log("PM2 — Add Product, three sections, empty photo state");
await page.locator('[data-testid="cancel-product"]').click();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Two products: one that will have a photo, one that will not (§W 1)
// ════════════════════════════════════════════════════════════════════════════════════════════════
await addProduct(page, {
  nameAr: "مفك براغي",
  nameEn: "Screwdriver",
  sku: "SKU-100",
  price: "7.50",
  unit: "piece",
  barcode: "036000291452",
  brand: "Bosch",
  descAr: "مفك براغي متوسط الحجم",
  online: true,
});
await addProduct(page, { nameAr: "دهان أبيض", nameEn: "White paint", sku: "SKU-200", price: "22.00", unit: "piece" });
assert((await rows(page).count()) === 2, "two products exist");

// 🔴 The 12-digit UPC-A became the 13-digit canonical form, visible on the row.
const barcodeText = await page.locator('[data-testid="row-barcode"]').first().textContent();
assert(barcodeText.trim() === "0036000291452", `the row shows the canonical barcode, got '${barcodeText}'`);

// The barcode is SEARCHABLE — by the canonical form the row displays.
await page.locator('[data-testid="product-search"]').fill("0036000291452");
assert((await rows(page).count()) === 1, "searching the barcode finds exactly that product");
await page.screenshot({ path: SHOTS + "PM6-barcode-search.png" });
await page.locator('[data-testid="product-search"]').fill("");
log("PM6 — barcode canonicalised and searchable");

await app.close();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · Give ONE product a photo THROUGH THE REAL PRODUCER, then look at the list (§W 1) and the
//     Edit form (§W 3)
//
// 🔴 THIS USED TO BE A RAW SQL INSERT, AND IT NO LONGER IS. Slice E had no producer — there is
// deliberately no channel that accepts image bytes from the renderer — so the only way a photo
// could exist was to write the row directly, and the header said so, so nobody would read these
// screenshots as proof that importing a photo worked. Slice F built the producer, so the photo in
// every screenshot below now arrives the way a shop's photo arrives: a real file, chosen in the
// real dialog, decoded and normalized by the real pipeline.
//
// The only stub is `dialog.showOpenDialogSync`, which `main.ts` looks up at call time precisely so
// a test can aim it. `e2e/product-photo.mjs` is where that path is proven in full.
// ════════════════════════════════════════════════════════════════════════════════════════════════
({ app, page } = await launch());
await rows(page).first().waitFor();
{
  const fixture = join(APP, "tests", "fixtures", "photos", "shelf.jpg");
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialogSync = () => [f];
  }, fixture);
  // 🔴 THE RIGHT PRODUCT, NAMED. Everything below asserts "exactly one row has a thumbnail and
  // exactly one has the placeholder", which an `nth(0)` would satisfy while photographing whichever
  // product happened to sort first. The SKU is rendered in the row, so the row is found by it.
  const target = rows(page).filter({ hasText: "SKU-100" });
  assert((await target.count()) === 1, "exactly one row is SKU-100");

  // 🔴 MEASURED BEFORE THE FIRST CLICK, NOT AFTER IT. The previous attempt put this check further
  // down the script, so when the state badge covered the Edit button the run died HERE — at an
  // ordinary click, 84 lines before the geometry it would have explained. A layout assertion that
  // runs after the interaction it protects is an assertion that never runs.
  await assertNoClipping(page, "Arabic owner (pre-click)");

  // And then the real thing: Playwright's own click, with interception left ON. A forced click
  // would prove only that the coordinates exist.
  await target.locator('[data-testid="product-edit"]').click();
  await page.locator('[data-testid="photo-panel"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="photo-add"]').click();
  await page.locator('[data-testid="photo-preview"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="photo-preview"]');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
  await page.locator('.product-form [data-testid="cancel-product"]').click();
  await page.locator('[data-testid="photo-panel"]').waitFor({ state: "detached" });
  log("one product photographed through the REAL producer");
}
await page.locator('[data-testid="thumb-image"]').first().waitFor({ timeout: 15000 });

assert((await page.locator('[data-testid="thumb-image"]').count()) === 1, "exactly one row shows a thumbnail");
assert((await page.locator('[data-testid="thumb-empty"]').count()) === 1, "exactly one row shows the placeholder");

// 🔴 THE THUMBNAIL IS A REAL DECODE, not a broken-image box. `naturalWidth` is 0 for an image the
// browser could not decode, so this is the one check that distinguishes "rendered" from "present".
//
// 🔴 AND IT WAITS FOR THE DECODE. The first run of this script failed here with 0x0 against a PNG
// an independent decoder reads fine: `waitFor()` resolves when the element ATTACHES, and
// `naturalWidth` stays 0 until the browser has finished decoding. Measuring at attach time is
// measuring a race — and it would have read as "the image is broken", which is a different and
// much more alarming conclusion than "not yet".
await page.waitForFunction(
  () => {
    const img = document.querySelector('[data-testid="thumb-image"]');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  },
  undefined,
  { timeout: 15000 },
);
const natural = await page.locator('[data-testid="thumb-image"]').first().evaluate((img) => ({
  w: img.naturalWidth,
  h: img.naturalHeight,
  box: img.getBoundingClientRect().width,
}));
// 🔴 THIS ASSERTION CHANGED VALUE IN SLICE F, and the old one is named. It read
// `w === 96 && h === 96` because the photo was a generated 96x96 PNG written by raw SQL. The photo
// now comes through the real producer, so the number is the normalization policy's output for the
// `shelf.jpg` fixture. Both halves are kept deliberately: `> 0` is the only honest test that a
// browser DECODED an image at all (it reports 0 for one it could not), and the exact size says the
// real photo is behind it rather than some other image that merely decoded.
assert(natural.w > 0 && natural.h > 0, `the thumbnail really decoded (was: exactly 96x96, got ${natural.w}x${natural.h})`);
assert(natural.w === 1600 && natural.h === 1200, `and it is the real normalized photo (got ${natural.w}x${natural.h})`);
// 🔴 AND THE DISPLAYED BOX IS STILL SMALL, which is the check E2.1 actually cared about: a
// 1600px-wide source must not become a catalogue card. This is the assertion the size change above
// could otherwise have quietly weakened.
assert(natural.box > 20 && natural.box < 80, `the thumbnail is small (${natural.box}px), not a catalogue card`);

// 🔴 ROW HEIGHT DOES NOT EXPLODE, AND EVERY ROW MATCHES. Two things could break this: a thumbnail
// sized by its image, and a cell that grows when the data is richer.
//
// 🔴 THE SECOND ONE REALLY HAPPENED, and this assertion is why it was found rather than shipped:
// the barcode started on its own line under the SKU, and the installed run measured 69px against
// 57px — a product WITH a barcode was taller than one without. The fix was the layout (both codes
// on one line, the cell `nowrap`), not this tolerance.
const heights = await rows(page).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
assert(Math.abs(heights[0] - heights[1]) <= 2, `rows are the same height: ${heights.join(" vs ")}`);
assert(heights.every((h) => h < 110), `no row-height explosion: ${heights.join(", ")}`);

// 🔴 AND THE LIST CARRIED NO BYTES. The DTO the renderer holds has a flag, an id and a hash.
const listShape = await page.evaluate(async () => {
  const r = await window.pos.listProducts();
  const row = r.data[0];
  return { keys: Object.keys(row).filter((k) => /image|photo|bytes/i.test(k)), hasBinary: Object.values(r.data.flatMap((x) => Object.values(x))).some((v) => v instanceof Uint8Array) };
});
assert(!listShape.hasBinary, "no value in any listProducts row is binary");
log("list photo state:", listShape.keys.join(", "));

await page.screenshot({ path: SHOTS + "PM3-products-list-mixed-photos.png" });
// ── R1 · A REALISTIC ROW BEFORE MEASURING ───────────────────────────────────────────────────────
// Two short fixtures prove nothing about a shop's real catalogue: the defect showed up on a LONG
// Arabic name beside a LONG price, which is what crowds the row. Added through the real form.
await addProduct(page, {
  nameAr: "مفك براغي كهربائي لاسلكي",
  nameEn: "Cordless electric screwdriver",
  sku: "SKU-LONG-9001",
  price: "99999.00",
  unit: "piece",
});
await page.waitForSelector('[data-testid="product-row"]');

const arGeom = await assertNoClipping(page, "Arabic owner");

// 🔴 CLICKABLE IS NOT THE SAME AS "IT WORKED". Hit-testing says a click would land on the button;
// this says the button then DID something. Run on the long-name row, which is the one that crowds
// the layout, with interception left on.
const longRow = rows(page).filter({ hasText: "SKU-LONG-9001" });
assert((await longRow.count()) === 1, "the long-name row is present for the click test");
await longRow.locator('[data-testid="product-edit"]').click();
await page.locator('[data-testid="form-footer"]').waitFor({ state: "visible", timeout: 30000 });
assert(true, "🔴 the Owner Edit action really fires on the crowded row — the form opened");
await page.locator('[data-testid="cancel-product"]').click();
await page.locator('[data-testid="product-row"]').first().waitFor();
log("R1 Arabic owner geometry: " + JSON.stringify(arGeom.map((r) => ({ price: r.priceText, unit: r.unitText, widths: r.widths, buttons: r.buttons.length, strip: r.scroll }))));

// ── R1 · DEACTIVATE IS REACHED BY ORDINARY HORIZONTAL SCROLLING, IN RTL ─────────────────────────
const arReveal = await proveActionsReachable(page, {
  sku: "SKU-LONG-9001",
  where: "Arabic owner (RTL)",
  deactivated: "أُوقف الصنف",
  activated: "أُعيد تفعيل",
  shot: "E2.1-R1-A-deactivate-after-scroll-arabic.png",
});
log(`R1 Arabic: ${arReveal.scroll.clientWidth}px strip holding ${arReveal.scroll.scrollWidth}px of columns, scrolled ${arReveal.scrolledFrom} → ${arReveal.scrolledTo}`);

await page.screenshot({ path: SHOTS + "E2.1-B-products-arabic.png" });

// 🔴 THE TABLE STARTS HIGHER. Two explanatory paragraphs pushed it a long way down on every visit;
// the number is measured rather than eyeballed so a future paragraph cannot creep back in.
const tableTop = await page.evaluate(() => {
  const t = document.querySelector(".admin-table");
  return t === null ? -1 : Math.round(t.getBoundingClientRect().top);
});
assert(tableTop > 0 && tableTop < 330, `the product table starts high on the screen (${tableTop}px from the top)`);
// 🔴 THE TECHNICAL SOURCE BADGE IS GONE — and the check names what it allows rather than banning
// a CSS class. `.badge.faint` is also the ONLINE badge, which is deliberate and explained, so the
// first version of this line failed on the thing it was supposed to keep. What must be absent is
// an UNIDENTIFIED faint badge: anything carrying that look without a testid saying what it means.
const unexplained = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="product-row"] .badge.faint')]
    .filter((b) => b.getAttribute("data-testid") === null)
    .map((b) => b.textContent.trim()),
);
assert(unexplained.length === 0, `no unexplained badge on the products rows (found: ${unexplained.join(", ")})`);
// CONTROL: the online badge IS still there, so the line above is not passing because badges vanished.
assert(
  (await page.locator('[data-testid="badge-online"]').count()) === 1,
  "the online badge survives — exactly one product is marked online",
);
log("B — Arabic products list; table top at", tableTop, "px");

// Edit the photographed product: the preview must be there immediately (§W 3).
await rows(page).first().locator("button").first().click();
await page.locator('[data-testid="photo-preview"]').waitFor({ timeout: 15000 });
// Same race as the thumbnail above: attached is not decoded.
await page.waitForFunction(
  () => {
    const img = document.querySelector('[data-testid="photo-preview"]');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  },
  undefined,
  { timeout: 15000 },
);
const preview = await page.locator('[data-testid="photo-preview"]').evaluate((img) => ({
  w: img.naturalWidth,
  box: Math.round(img.getBoundingClientRect().width),
}));
// Same change as the thumbnail above: was `=== 96` against the generated seed, now the real
// normalized photo. The property is that it DECODED, which `naturalWidth > 0` is the only honest
// test of — a browser reports 0 for an image it could not decode.
assert(preview.w === 1600, `the form preview is a real decode of the real photo (was: 96, got ${preview.w})`);
assert(preview.box > 100, `the preview is large enough to judge (${preview.box}px)`);

// 🔴 "OBVIOUS ON OPENING" MEANS ON SCREEN, NOT MERELY IN THE DOM — and this assertion exists
// because the first green run was not good enough. Every selector passed while the installed
// screenshot showed the Edit form ending at the Category field: the photo preview, the online
// section and Save were all below the fold at the shop's real 1008x681. A DOM check cannot see
// that; a measured rect can.
assert(
  await onScreen(page, "photo-preview"),
  "the photo preview is VISIBLE when Edit opens, not a scroll away",
);
assert(
  await onScreen(page, "save-product"),
  "Save is visible without scrolling the dialog",
);

// 🔴 THE SCREENSHOT IS TAKEN HERE, BEFORE ANYTHING SCROLLS, and the first green run is why.
// PM4 was captured further down — after `scrollIntoViewIfNeeded` had moved the dialog to reach the
// online control — so the one screenshot that exists to show "Edit Product with an existing image"
// did not contain the image. The assertions were all true at the moment they ran; the EVIDENCE was
// taken of a different moment. A passing check and a screenshot of the wrong scroll position look
// identical in a green log.
await page.screenshot({ path: SHOTS + "PM4-edit-product-with-photo.png" });
await page.screenshot({ path: SHOTS + "E2.1-E-edit-product-with-image.png" });
log("PM4/E — Edit Product with an existing photo, unscrolled");

// The Edit form opens at the top too, even though an Add form was opened and scrolled before it.
assert((await scrollForm(page, 0)) === 0, "the Edit form opens at the top, not where the last one was left");

// And nothing is under the action bar here either, at any scroll position.
for (const position of [0, 200, "end"]) {
  await scrollForm(page, position);
  const buried = await coveredByFooter(page, [
    "field-nameAr",
    "field-barcode",
    "field-category",
    "field-brand",
    "field-price",
    "field-descAr",
    "field-online",
    "photo-preview",
    "photo-remove",
  ]);
  assert(buried.length === 0, `Edit: nothing drawn under the action bar at scroll ${position} (${buried.join(", ") || "none"})`);
}
{
  const g = await footerIsBelowTheScrollRegion(page);
  assert(g.ok, `Edit: the scroll region ends above the action bar (${g.scrollBottom} vs ${g.footerTop})`);
}
await scrollForm(page, 0);
// 🔴 THE ONLINE CONTROL IS NOT ASSERTED ON SCREEN, AND THAT IS A STATED LIMIT RATHER THAN A
// QUIETLY DROPPED CHECK. BASIC INFORMATION alone is ~630px of controls on a 1008x681 shop screen,
// so the dialog scrolls and SOMETHING must be below the fold. What the brief names as needing to
// be immediately obvious is the PHOTO state, and that is what is asserted above. The online
// section is reached by scrolling, and photographed as such below.
await page.locator('[data-testid="field-online"]').scrollIntoViewIfNeeded();
assert(await onScreen(page, "field-online"), "the online-catalogue control is reachable by scrolling");
await page.screenshot({ path: SHOTS + "PM10-online-catalogue-section.png" });
log("PM10 — the online catalogue section");
// 🔴 THIS ASSERTION FLIPPED IN SLICE F, AND THE OLD VALUE IS NAMED RATHER THAN QUIETLY REPLACED.
// Through E2.1 it read `isDisabled() === true` with the comment "the producer is slice F" — and it
// was right then: the channel answered NOT_AVAILABLE, so the button admitted it. The producer now
// exists, so the truthful assertion is the opposite one. A baseline cannot assert a thing's absence
// and also survive its creation; what it can do is say which it is asserting and why.
assert(await page.locator('[data-testid="photo-add"]').isEnabled(), "Add/Replace photo is ENABLED (was: disabled, until slice F)");
assert((await page.locator('[data-testid="photo-remove"]').count()) === 1, "Remove photo is offered");

// The retired category IS on offer here, because this product could be assigned one... it is not,
// so it must not be. Assign it an active one and confirm the brand datalist carries a suggestion.
const brandSuggestions = await page.locator("#brand-suggestions option").allTextContents();
log("brand suggestions:", brandSuggestions.length);

await page.locator('[data-testid="field-brand"]').scrollIntoViewIfNeeded();
await page.locator('[data-testid="field-brand"]').click();
assert(await onScreen(page, "field-brand"), "the brand field is on screen for its screenshot");
await page.screenshot({ path: SHOTS + "PM5-brand-suggestions.png" });
log("PM5 — brand field with suggestions");
await page.locator('[data-testid="cancel-product"]').click();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The retired category on a product that already carries it (§W 4)
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const db = new Database(LEDGER);
  const retired = db.prepare("SELECT id FROM catalog_categories WHERE is_active = 0").get();
  const target = db.prepare("SELECT id FROM catalog_products WHERE sku = 'SKU-200'").get();
  db.close();
  assert(retired !== undefined && target !== undefined, "a retired category and a second product exist");
  // Assigning it through SQL rather than the UI on purpose: the SERVICE correctly REFUSES a new
  // assignment of a retired category, which is the invariant. What §W asks to see is the other
  // half — a product that already carries one keeps it and can still be edited.
  await app.close();
  const w = new Database(LEDGER);
  // Same hazard as the corruption step below: an UPDATE matching nothing SUCCEEDS, so the one
  // thing worth asserting about a raw setup write is that it actually hit a row.
  const assigned = w.prepare("UPDATE catalog_products SET category_id = ? WHERE id = ?").run(retired.id, target.id);
  w.close();
  assert(assigned.changes === 1, `the retired category was really assigned (changed ${assigned.changes})`);
}

({ app, page } = await launch());
// 🔴 THE PRODUCT BY NAME, NOT BY POSITION — and this is the SECOND time this exact trap has been
// paid for in this file. `rows(page).last()` meant SKU-200 only until `d3eed98` appended
// SKU-LONG-9001 for R1, which sorts last (`ORDER BY source, CAST(source_key AS INTEGER),
// source_key`). From then on this block opened the long-name fixture, asked it about a retired
// category it was never given, and the §W assertion below became a question about the wrong
// product — while the price edit it performs landed on the wrong product too. No run caught it
// because every run since died earlier at R1. The row's own `product-edit` testid replaces
// `.locator("button").first()` for the same reason the deactivate testid exists.
//
// Scoped to the CODES cell with a word-bounded SKU rather than a bare `hasText`, so neither a
// longer SKU nor a product whose NAME happens to contain the digits can satisfy it.
const retiredRow = rows(page).filter({ has: page.locator("td.col-codes", { hasText: /\bSKU-200\b/ }) });
// 🔴 WAIT FOR THIS PRODUCT, NOT FOR "A ROW" — and this is the defect that cost run 39643859710.
// `locator.count()` is an immediate query; it does not auto-wait. The positional selector it
// replaced ended in `.click()`, which DOES auto-wait, so the missing wait was invisible until the
// thing hiding it was removed. `launch()` signs in, clicks the products tab and returns, and the
// list loads asynchronously — so the count ran against an empty table and saw zero rows.
//
// Waiting for `rows().first()` would be the same mistake one level up: two other products load
// first, so "a row exists" would be satisfied without SKU-200 being there at all. The wait is on
// the target itself.
await retiredRow.first().waitFor({ state: "visible", timeout: 30000 });
assert((await retiredRow.count()) === 1, "exactly one row is SKU-200 — the product §W gave the retired category to");
await retiredRow.locator('[data-testid="product-edit"]').click();
await page.locator('[data-testid="field-category"]').waitFor();
// And the form that opened really is that product's, not merely a row that matched.
const openedName = await page.locator('[data-testid="field-nameAr"]').inputValue();
assert(openedName === "دهان أبيض", `the Edit form that opened is SKU-200's own ("${openedName}")`);
const retiredOptions = await page.locator('[data-testid="field-category"] option').allTextContents();
assert(
  retiredOptions.some((o) => o.includes("متوقّف")),
  `the product's own retired category is shown and marked: ${retiredOptions.join(" | ")}`,
);
await page.screenshot({ path: SHOTS + "E2.1-F-edit-retired-category.png" });
await page.locator('[data-testid="field-category"]').click();
await page.screenshot({ path: SHOTS + "PM7-category-dropdown-retired.png" });
log("PM7 — the category chooser, including a retired assigned one");

// 🔴 AND RE-SAVING IT KEEPS THE RETIRED CATEGORY. This is the asymmetry the service implements;
// proving it through the real app closes the loop a unit test opened.
await page.locator('[data-testid="field-price"]').fill("23.00");
await page.locator('[data-testid="save-product"]').click();
await page.locator(".dialog .btn.primary.wide").click();
{
  await app.close();
  const db = new Database(LEDGER, { readonly: true });
  const after = db.prepare("SELECT category_id, selling_price_minor FROM catalog_products WHERE sku = 'SKU-200'").get();
  const retired = db.prepare("SELECT id FROM catalog_categories WHERE is_active = 0").get();
  const untouched = db.prepare("SELECT selling_price_minor FROM catalog_products WHERE sku = 'SKU-LONG-9001'").get();
  db.close();
  assert(after.category_id === retired.id, "re-saving a product with a RETIRED category keeps it");
  // 🔴 THE EDIT LANDED ON THE PRODUCT THIS BLOCK IS ABOUT — asserted, not logged. The price was
  // READ here and only printed, which is precisely why nothing noticed that `rows().last()` had
  // been typing 23.00 into SKU-LONG-9001 for four commits while this block went on asking the
  // database about SKU-200. A value fetched and not asserted is not a check.
  assert(
    Number(after.selling_price_minor) === 2300,
    `the price edit landed on SKU-200 itself (USD exponent 2 → 2300, got ${after.selling_price_minor})`,
  );
  // And the other half of the same fact: the R1 fixture still carries the long price the layout
  // measurements depend on. If the edit ever strays again, this says so in the same breath.
  assert(
    Number(untouched.selling_price_minor) === 9999900,
    `and SKU-LONG-9001 was NOT the product edited (expected 9999900, got ${untouched.selling_price_minor})`,
  );
}

/**
 * The controlled catalogue this script has built by this point, BY IDENTITY:
 *   SKU-100         — the photographed, barcoded, online product   (added above, §3)
 *   SKU-200         — the plain second product, §W's subject        (added above, §3)
 *   SKU-LONG-9001   — the long Arabic name + long price R1 fixture  (added above, §R1)
 * Nothing else creates a product in this script and the profile is a fresh temp directory, so this
 * list is exhaustive rather than a minimum.
 */
const FIXTURE_SKUS = ["SKU-100", "SKU-200", "SKU-LONG-9001"];
/** Filled from the ledger while the app is closed, below. */
let ledgerSkus = [];

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · A CORRUPT photo must not break the screen
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  // 🔴 THE IMAGE IS FOUND BY ITS PRODUCT, NOT BY A HARD-CODED ID — and the id this used to carry,
  // 'e2e-photo-1', belonged to the raw-SQL seed slice F deleted. The real producer generates its
  // own id, so the UPDATE matched ZERO ROWS: nothing was corrupted, the thumbnail loaded perfectly,
  // and the step sat waiting for a placeholder that was never going to appear.
  //
  // 🔴 AND `.changes` IS ASSERTED, which is the real lesson. An UPDATE that matches nothing
  // SUCCEEDS — a setup step that silently did nothing is indistinguishable from one that worked,
  // and the failure then surfaces 15 seconds later as a timeout on an unrelated-looking selector.
  const db = new Database(LEDGER);
  const image = db
    .prepare(
      `SELECT i.id FROM catalog_product_images i
         JOIN catalog_products p ON p.id = i.product_id
        WHERE p.sku = 'SKU-100' AND i.is_primary = 1`,
    )
    .get();
  assert(image !== undefined, "the photographed product has a stored primary image to corrupt");
  const result = db.prepare("UPDATE catalog_product_images SET bytes = ? WHERE id = ?").run(Buffer.from("not an image"), image.id);
  // Measured here, with the app closed, so the screen can be compared against something that did
  // not come from the screen.
  ledgerSkus = db.prepare("SELECT sku FROM catalog_products").all().map((r) => r.sku).sort();
  db.close();
  assert(result.changes === 1, `the corruption changed exactly one row (changed ${result.changes})`);
  log("corrupted the stored photo behind the application's back:", image.id);
}

({ app, page } = await launch());
await rows(page).first().waitFor();
// The checksum guard refuses it, the row falls back to a placeholder, and the LIST STILL WORKS.
await page.locator('[data-testid="thumb-failed"]').first().waitFor({ timeout: 15000 });
// 🔴 IDENTITY, NOT A COUNT — and `=== 3` would have been the same mistake with a different digit.
// The literal `=== 2` was correct until `d3eed98` added SKU-LONG-9001 for R1, and nothing noticed
// because a number carries no record of WHICH products it was counting. A count cannot tell a
// missing product from a duplicated one, and it cannot tell either from an unexpected third.
//
// So the fixture population is named, and the screen is compared against it AND against the
// ledger read above — three sources that must agree, rather than one number that must be right.
const renderedSkus = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="product-row"]')].map((tr) =>
    (tr.querySelector("td.col-codes bdi")?.textContent ?? "").trim(),
  ),
);
const sortedRendered = [...renderedSkus].sort();
assert(
  JSON.stringify(sortedRendered) === JSON.stringify([...FIXTURE_SKUS].sort()),
  `every fixture product still renders, exactly once each, with one photo unreadable — rendered: ${renderedSkus.join(", ") || "(none)"}`,
);
assert(
  JSON.stringify(sortedRendered) === JSON.stringify(ledgerSkus),
  `and the screen shows exactly what the ledger holds (screen: ${sortedRendered.join(", ")} · ledger: ${ledgerSkus.join(", ")})`,
);
// The corrupt photo is the only casualty: one failed placeholder, and every other row still draws.
assert(
  (await page.locator('[data-testid="thumb-failed"]').count()) === 1,
  "exactly one row falls back to the failed-photo placeholder",
);
await page.screenshot({ path: SHOTS + "PM8-corrupt-photo-falls-back.png" });
log("PM8 — a corrupt photo falls back to the placeholder and breaks nothing");

// ── 7 · English / LTR, so the mirrored layout is reviewable too ──────────────────────────────────
// 🔴 THROUGH THE REAL TOGGLE, NOT THROUGH window.pos. Calling `setTerminalLanguage` directly
// persists the choice and returns the new settings, but nothing re-reads them: the document's `dir`
// is set by the app's own language state, so the call succeeded and the screen stayed RTL. The
// first run of this script asserted on the document and failed — correctly. The UI toggle is the
// path a merchant takes and the one that actually flips the document.
await page.locator('[data-testid="lang-toggle"]').click();
await page.waitForFunction(() => document.documentElement.dir === "ltr", undefined, { timeout: 15000 });
await page.locator('[data-testid="tab-products"]').click();
await rows(page).first().waitFor();
assert((await page.evaluate(() => document.documentElement.dir)) === "ltr", "the document is ltr in English");
const addLabel = await page.locator('[data-testid="add-product"]').innerText();
assert(!/[\u0600-\u06ff]/.test(addLabel), `the screen is really English ("${addLabel.trim()}")`);

// 🔴 ROW HEIGHTS IN ENGLISH TOO — and this check exists because the Arabic one could not see it.
// The English capture showed "23.00 USD" wrapping across two lines while "7.50 USD" did not, so
// the rows were uneven again in the other language. A layout measured in one direction is measured
// in one direction.
const enHeights = await rows(page).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
// 🔴 ALL THREE ROWS, AND NOT BY PRETENDING THEY ARE EQUAL. This compared [0] and [1] only, so when
// the run logged "66 vs 65 vs 89" it reported the two it looked at and said nothing about the
// third. The long-name product legitimately wraps to more lines and is legitimately taller;
// forcing equality would be inventing a contract nobody agreed to. What must hold for EVERY row is
// the long-standing maximum, and that the two comparable rows stay comparable.
assert(
  enHeights.length === FIXTURE_SKUS.length,
  `every fixture row is measured in English (${enHeights.length} of ${FIXTURE_SKUS.length}: ${enHeights.join(", ")})`,
);
assert(
  Math.abs(enHeights[0] - enHeights[1]) <= 2,
  `the two short-name English rows are the same height: ${enHeights[0]} vs ${enHeights[1]}`,
);
assert(enHeights.every((h) => h < 110), `NO row-height explosion in English, long name included: ${enHeights.join(", ")}`);
// And the taller row is taller because its NAME wraps, not because its price or unit was pushed
// out of shape — `assertNoClipping` below measures that for all three rows.
await page.screenshot({ path: SHOTS + "PM9-products-english-ltr.png" });
const enGeom = await assertNoClipping(page, "English owner");
log("R1 English owner geometry: " + JSON.stringify(enGeom.map((r) => ({ price: r.priceText, unit: r.unitText, widths: r.widths, buttons: r.buttons.length, strip: r.scroll }))));

// 🔴 THE SAME PROOF IN LTR. The offscreen end swaps sides and `scrollLeft` does not mean the same
// thing here, so this is a second measurement, not a repeat of the first.
const enReveal = await proveActionsReachable(page, {
  sku: "SKU-LONG-9001",
  where: "English owner (LTR)",
  deactivated: "Product deactivated",
  activated: "Product activated",
  shot: "E2.1-R1-B-deactivate-after-scroll-english.png",
});
log(`R1 English: ${enReveal.scroll.clientWidth}px strip holding ${enReveal.scroll.scrollWidth}px of columns, scrolled ${enReveal.scrolledFrom} → ${enReveal.scrolledTo}`);

await page.screenshot({ path: SHOTS + "E2.1-A-products-english.png" });
log("PM9/A — the same screen in English/LTR");

// ── I · THE NARROWEST SUPPORTED WINDOW ──────────────────────────────────────────────────────────
// main.ts pins minWidth 1024 / minHeight 640, so this is the smallest a shop can make it. The
// layout has to hold there, not merely at the runner's default.
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setSize(1024, 640);
});
await page.waitForFunction(() => window.innerWidth <= 1024, undefined, { timeout: 10000 });
await rows(page).first().waitFor();
await assertNoClipping(page, "narrowest window");
// 🔴 AND AT THE SMALLEST SUPPORTED SIZE the last action is still reachable — measured, not assumed
// from the wider window passing. No click here: the click is proven in both writing directions
// above, and this is the reach that 1024px puts under the most pressure.
{
  const narrowReveal = await revealAction(page, "SKU-LONG-9001", "product-deactivate");
  assert(narrowReveal.ok, `1024x640: ${narrowReveal.why ?? "the deactivate control was found"}`);
  log("R1 narrowest reveal: " + JSON.stringify(narrowReveal));
  assert(
    narrowReveal.inside,
    `🔴 1024x640: "product-deactivate" reaches the visible strip (box ${JSON.stringify(narrowReveal.box)} strip ${JSON.stringify(narrowReveal.strip)})`,
  );
  assert(narrowReveal.blockers.length === 0, `🔴 1024x640: nothing covers it there — ${narrowReveal.blockers.join(", ")}`);
  const narrowUsable = await stripUsable(page);
  assert(
    narrowUsable.ok && narrowUsable.hits.every((h) => h.inScroller),
    `🔴 1024x640: the scrollable strip is not covered — ${JSON.stringify(narrowUsable)}`,
  );
  await page.screenshot({ path: SHOTS + "E2.1-R1-C-deactivate-after-scroll-1024.png" });
}

await page.screenshot({ path: SHOTS + "E2.1-I-narrowest-window-list.png" });
const narrowHeights = await rows(page).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
// 🔴 SAY WHAT IS ACTUALLY BEING COMPARED. This printed "rows stay even at 1024x640: 66 vs 65 vs 89"
// — a claim of evenness beside a number that is not even, because it compares [0] and [1] and
// reports all three. The long-name row wraps to more lines and is legitimately taller; the
// contract is the maximum, which is asserted for every row.
assert(
  narrowHeights.length === FIXTURE_SKUS.length,
  `every fixture row is measured at 1024x640 (${narrowHeights.length} of ${FIXTURE_SKUS.length}: ${narrowHeights.join(", ")})`,
);
assert(
  Math.abs(narrowHeights[0] - narrowHeights[1]) <= 2,
  `the two short-name rows stay equal at 1024x640: ${narrowHeights[0]} vs ${narrowHeights[1]}`,
);
assert(
  narrowHeights.every((h) => h < 110),
  `NO row-height explosion at 1024x640, long name included: ${narrowHeights.join(", ")}`,
);
// 🔴 The modal still works at the minimum size: nothing under the action bar, Save reachable.
await rows(page).first().locator("button").first().click();
await page.locator('[data-testid="form-footer"]').waitFor();
assert(await onScreen(page, "save-product"), "Save is on screen at 1024x640");
for (const position of [0, "end"]) {
  await scrollForm(page, position);
  const buried = await coveredByFooter(page, ["field-nameAr", "field-price", "field-online", "photo-panel"]);
  assert(buried.length === 0, `1024x640: nothing under the action bar at scroll ${position} (${buried.join(", ") || "none"})`);
}
await scrollForm(page, 0);
await page.screenshot({ path: SHOTS + "E2.1-I-narrowest-window-form.png" });
log("I — the narrowest supported window, 1024x640");
await page.locator('[data-testid="cancel-product"]').click();

// ── R1 · THE CASHIER'S VIEW OF THE SAME TABLE ───────────────────────────────────────────────────
//
// 🔴 WHY THE CASHIER MATTERS HERE. The clipping was never about the data: the SAME prices rendered
// correctly for a cashier and were cut for the owner, because the owner's row carries three extra
// controls and the cashier's carries none. So the cashier is the control case — if the fix is
// real, both roles read cleanly, and the owner-only controls are still absent for the cashier.
//
// 🔴 AND WHY `may_create_products` CANNOT CHANGE THIS MEASUREMENT. That capability governs the
// TOOLBAR's "add" button, not anything inside a row; the per-row Edit / phone / deactivate controls
// are gated on `isOwner` alone (ProductsScreen.tsx). Row geometry therefore cannot vary with it,
// and the capability's own authorization is proven elsewhere
// (tests/application/productCreateCapability.test.ts, and the service re-check at every save).
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
// 🔴 LOG OUT FIRST — `change-cashier` LIVES ON A DIFFERENT SCREEN. This clicked `change-cashier`
// while the app was signed in on the Products screen, where that control does not exist at all
// (`LoginScreen.tsx` renders it, and only once an operator is already selected). The click failed,
// `.catch(() => undefined)` swallowed the failure, and the only symptom was a 30-second timeout on
// the NEXT line naming a selector that was never going to appear — run 39656633002.
//
// `operator-accounts.mjs` uses the same pair legitimately, because it is already ON the login
// screen. The difference is the screen, so the correction is to go to it. And nothing is swallowed
// here any more: a failed logout click must say so where it happens, not 30 seconds later as
// somebody else's missing selector. After logout the screen mounts fresh with no operator
// selected, so `select-cashier` is the prompt that appears and `change-cashier` is not needed.
await page.locator('[data-testid="logout"]').click();
await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
await signIn(page, "Cashier Two", "2222");
await page.locator('[data-testid="tab-products"]').click();
await page.locator('[data-testid="product-row"]').first().waitFor({ timeout: 30000 });

// 🔴 AND IT REALLY IS A DIFFERENT OPERATOR. Everything below is a statement about what a CASHIER
// sees; if the switch had silently left Cashier One signed in, the owner-control assertions would
// be measuring the wrong person and failing for the right reason by accident.
const whoami = (await page.locator(".topbar span.muted").first().innerText()).trim();
assert(whoami === "Cashier Two", `the signed-in operator really is the cashier ("${whoami}")`);

const cashierGeom = await assertNoClipping(page, "cashier");
log("R1 cashier geometry: " + JSON.stringify(cashierGeom.map((r) => ({ price: r.priceText, unit: r.unitText, buttons: r.buttons.length }))));

// The owner-only row controls are genuinely gone — which is also what makes this a control and not
// a repeat of the owner measurement.
for (const id of ["product-edit", "product-edit-phone"]) {
  assert((await page.locator(`[data-testid="${id}"]`).count()) === 0, `a cashier sees no ${id} control`);
}
// 🔴 `r.buttons.length`, NOT `r.buttonCount`. The CELLS rewrite renamed this field and these two
// lines kept reading the old one, so `undefined === 0` was false and this assertion would have
// failed on a cashier screen that was perfectly correct. It never surfaced because every run so
// far died earlier. Reported rather than quietly corrected.
assert(
  cashierGeom.every((r) => r.buttons.length === 0),
  `and no per-row action buttons at all (${cashierGeom.map((r) => r.buttons.length).join(", ")})`,
);
await page.screenshot({ path: SHOTS + "E2.1-J-products-cashier.png" });
log("J — the same table as a cashier: no owner controls, prices and units intact");

await app.close();
log("screenshots in", SHOTS);
console.log("\nPRODUCT MASTER E2E PASSED");
