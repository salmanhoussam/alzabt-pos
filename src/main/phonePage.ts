/**
 * The page the phone actually sees. One file, served from memory, entirely local.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 NO CDN, NO REMOTE FONT, NO FRAMEWORK, AND THE LAST ONE IS A MEASURED CHOICE RATHER THAN
 * MINIMALISM FOR ITS OWN SAKE. The repository's React is a devDependency bundled by Vite for the
 * renderer; there is no build step that would produce a second bundle for this page, and adding one
 * to render eleven inputs would mean shipping a framework over a shop's Wi-Fi to a phone. The page
 * is ~8 KB of HTML with inline CSS and about a hundred lines of plain JS. It must render and save
 * with the Internet physically disconnected, and the only way to be sure of that is to depend on
 * nothing.
 *
 * 🔴 THE BROWSER'S VALIDATION IS UX ONLY. Everything here — `required`, `inputmode`, the disabled
 * Save button — exists so the merchant is not told "invalid" after a round trip. The authority is
 * `parsePhoneSubmission` + `validateProductDraft` + `PosService`, and the page is written assuming
 * a hostile client could skip all of it, because one can.
 *
 * 🔴 THE VOCABULARIES ARE INJECTED, NEVER RESTATED. Units, categories and brands arrive as data
 * from `PosService.phoneSessionForm`. There is no unit list and no category rule in this file;
 * `categoryChoices` is applied by the caller, from the one shared module the desktop uses.
 *
 * 🔴 BIDI: the page is RTL and Arabic-first, but every number, SKU and barcode input is
 * `dir="ltr"`. A price that renders backwards is wrong, not merely ugly — the same discipline the
 * desktop screens are held to, and the exact class of defect the translation lesson recorded
 * (innerText returns DOM order, so a backwards line passes every text assertion).
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import type { PhoneFormData } from "../application/posService";
import { categoryChoices } from "../shared/productMasterForm";

/** HTML-escape. Every injected value goes through it — names, brands, descriptions, ids. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize data for the page's own script.
 *
 * 🔴 `</script>` AND `<!--` ARE NEUTRALISED, not assumed absent. A product named `</script>` is a
 * perfectly legal thing for a merchant to type, and the browser's HTML parser ends the script
 * block on that text wherever it appears — including inside a JSON string. The escapes below are
 * the standard ones; ` `/` ` are included because they are literal line terminators in
 * JavaScript and would break the literal.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The Arabic labels. One place, so the page cannot drift into half-translation. */
const AR = {
  titleNew: "إضافة صنف جديد",
  titleEdit: "تعديل صنف",
  sectionBasic: "المعلومات الأساسية",
  sectionOnline: "الكاتالوج الإلكتروني",
  sectionPhoto: "صورة الصنف",
  nameAr: "الاسم بالعربية",
  nameEn: "الاسم بالإنجليزية",
  sku: "رمز الصنف (SKU)",
  barcode: "الباركود",
  unit: "الوحدة",
  price: "السعر",
  category: "التصنيف",
  categoryNone: "بدون تصنيف",
  categoryRetired: "(متوقّف)",
  brand: "الماركة",
  descAr: "الوصف بالعربية",
  descEn: "الوصف بالإنجليزية",
  onlineVisible: "يظهر في الكاتالوج الإلكتروني",
  save: "حفظ الصنف",
  saving: "جارٍ الحفظ…",
  required: "مطلوب",
  photoTake: "التقط صورة",
  photoChoose: "اختر صورة",
  photoUploading: "جارٍ إرسال الصورة…",
  photoReady: "الصورة جاهزة وستُحفظ مع الصنف.",
  photoCurrent: "للصنف صورة حالية. إن لم تلتقط صورة جديدة، تبقى كما هي.",
  // 🔴 WHAT TO DO, NOT WHAT A FORMAT IS. This used to explain iPhone image encoding to a cashier
  // holding a phone — a sentence nobody can act on while photographing a shelf. The real limit is
  // unchanged and still enforced by `photoNormalize.ts`; when a picture is refused, the refusal
  // itself now says what to do next (`phoneMediaText.ts`), which is where that guidance belongs.
  photoHint: "صورة واضحة للصنف، بإضاءة جيدة.",
  photoRetry: "حاول مرة أخرى",
  // 🔴 ITS OWN SENTENCE, AND IT SAYS THE SAVE IS SAFE. A preview is a courtesy; failing to draw
  // one must never read as "your photo was lost", because at this point the till already has it.
  photoPreviewFailed: "تعذّر عرض المعاينة على الهاتف. الصورة وصلت الصندوق وستُحفظ مع الصنف.",
  barcodeScan: "صوّر الباركود",
  barcodeScanning: "جارٍ قراءة الباركود…",
  barcodeFound: "تمّت القراءة",
  barcodeNotFound: "ما قدرنا نقرأ الباركود. جرّب صورة أوضح أو اكتبه بإيدك.",
  barcodeEditable: "يمكنك تصحيح الرقم بإيدك.",
  savedNew: "تم حفظ الصنف بنجاح.",
  savedEdit: "تم تحديث الصنف بنجاح.",
  savedNote: "يمكنك إغلاق هذه الصفحة. انتهت صلاحية هذا الرمز.",
  offlineNote: "لا تحتاج إلى إنترنت — الصندوق هو الذي يخدم هذه الصفحة.",
  errorPrefix: "لم يتم الحفظ:",
  errorNetwork: "انقطع الاتصال مع برنامج «عالضبط». لم يتم حفظ الصنف.",
};

/**
 * The unit's Arabic label.
 *
 * 🔴 A LABEL MAP, NOT A UNIT LIST. The authoritative vocabulary is `data.units`, which comes from
 * `BASE_UNITS`; this only translates it for display, and a unit with no entry here falls back to
 * its own key rather than disappearing from the dropdown. That fallback is what keeps a new
 * `BASE_UNITS` member sellable from the phone on the day it is added, instead of silently absent.
 */
const UNIT_AR: Readonly<Record<string, string>> = Object.freeze({
  piece: "حبة",
  box: "علبة",
  pack: "ربطة",
  kg: "كيلو",
  meter: "متر",
  other: "أخرى",
});

export function renderPhoneFormPage(data: PhoneFormData): string {
  const editing = data.action === "EDIT_PRODUCT";
  const title = editing ? AR.titleEdit : AR.titleNew;
  const p = data.product;

  const assigned = data.master.categoryId;
  const choices = categoryChoices(
    data.categories.map((c) => ({ ...c, isActive: c.isActive })),
    assigned,
  );

  const unitOptions = data.units
    .map(
      (u) =>
        `<option value="${esc(u)}"${(p?.baseUnit ?? "piece") === u ? " selected" : ""}>${esc(UNIT_AR[u] ?? u)}</option>`,
    )
    .join("");

  const categoryOptions = [
    `<option value=""${assigned === "" ? " selected" : ""}>${esc(AR.categoryNone)}</option>`,
    ...choices.map(
      ({ category, retired }) =>
        `<option value="${esc(category.id)}"${category.id === assigned ? " selected" : ""}>${esc(
          category.nameAr,
        )}${retired ? " " + esc(AR.categoryRetired) : ""}</option>`,
    ),
  ].join("");

  // The brand suggestions the shop has already typed — the SAME source the desktop's datalist uses.
  const brandOptions = data.brands.map((b) => `<option value="${esc(b)}"></option>`).join("");

  const bootstrap = jsonForScript({
    action: data.action,
    product: p,
    master: data.master,
    savedMessage: editing ? AR.savedEdit : AR.savedNew,
  });

  return `<!doctype html>
<html lang="ar" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>عالضبط — ${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#faf9f7; --fg:#1a1a1a; --card:#ffffff; --line:#d9d6d0;
          --accent:#1f6f4a; --muted:#6b6b6b; --danger:#a4282b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#f3f3f3; --card:#20242a; --line:#3a4047; --muted:#a0a6ad;
            --accent:#4ea87a; --danger:#ef7b7e; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:0 0 7rem; background:var(--bg); color:var(--fg); line-height:1.6;
         font-family: system-ui, -apple-system, "Segoe UI", "Noto Naskh Arabic", sans-serif;
         -webkit-text-size-adjust:100%; }
  header { padding:1rem 1rem .5rem; }
  h1 { font-size:1.3rem; margin:0; }
  .sub { color:var(--muted); font-size:.85rem; margin:.25rem 0 0; }
  main { padding:0 1rem; max-width:34rem; margin:0 auto; }
  fieldset { border:1px solid var(--line); border-radius:14px; background:var(--card);
             margin:1rem 0; padding:.75rem 1rem 1rem; }
  legend { font-weight:600; font-size:.95rem; padding:0 .4rem; }
  label { display:block; margin-top:.85rem; font-size:.9rem; font-weight:500; }
  .req { color:var(--danger); font-weight:400; font-size:.8rem; }
  input[type=text], input[type=number], select, textarea {
    width:100%; margin-top:.3rem; padding:.7rem .75rem; font-size:1rem; font-family:inherit;
    color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:10px;
  }
  /* 🔴 Numbers, codes and prices read left-to-right inside an RTL page. */
  input.ltr { direction:ltr; text-align:left; }
  textarea { min-height:5rem; resize:vertical; }
  .row { display:flex; gap:.75rem; }
  .row > div { flex:1 1 0; min-width:0; }
  .check { display:flex; align-items:center; gap:.6rem; margin-top:1rem; font-weight:500; }
  .check input { width:1.35rem; height:1.35rem; margin:0; }
  .note { color:var(--muted); font-size:.85rem; margin:.5rem 0 0; }
  .media-row { display:flex; gap:.6rem; flex-wrap:wrap; margin-top:.6rem; }
  .btn-file { flex:1 1 auto; min-width:8rem; text-align:center; padding:.75rem .9rem;
              border:1px solid var(--line); border-radius:10px; background:var(--bg);
              font-weight:500; font-size:.95rem; }
  .preview { margin-top:.7rem; }
  /* object-fit contain, never cover: the merchant must be able to see whether the photo is
     portrait and whether the whole product is in frame. Slice F held the desktop preview to the
     same rule, for the same reason. */
  .preview img { width:100%; max-height:14rem; object-fit:contain; border-radius:10px;
                 background:rgba(127,127,127,.12); }
  .note.ok { color:var(--accent); font-weight:500; }
  .note.bad { color:var(--danger); font-weight:500; }
  footer { position:fixed; inset-inline:0; bottom:0; padding:.75rem 1rem;
           padding-bottom: calc(.75rem + env(safe-area-inset-bottom));
           background:var(--card); border-top:1px solid var(--line); }
  button { width:100%; max-width:34rem; margin:0 auto; display:block; padding:.95rem 1rem;
           font-size:1.05rem; font-weight:600; font-family:inherit; color:#fff;
           background:var(--accent); border:0; border-radius:12px; }
  button[disabled] { opacity:.55; }
  #msg { margin:1rem 0 0; padding:.8rem 1rem; border-radius:10px; font-weight:500; display:none; }
  #msg.err { display:block; background:rgba(164,40,43,.12); color:var(--danger); }
  #done { display:none; padding:1rem; }
  #done.on { display:block; }
  #done h2 { color:var(--accent); font-size:1.15rem; margin:0 0 .4rem; }
  body.saved form, body.saved footer, body.saved header .sub { display:none; }
</style>

<header>
  <h1>${esc(title)}</h1>
  <p class="sub">${esc(AR.offlineNote)}</p>
</header>

<main>
  <div id="done"><h2 data-testid="phone-saved"></h2><p class="note">${esc(AR.savedNote)}</p></div>

  <form id="f" novalidate>
    <div id="msg" role="alert" data-testid="phone-error"></div>

    <fieldset>
      <legend>${esc(AR.sectionBasic)}</legend>

      <label for="nameAr">${esc(AR.nameAr)} <span class="req">${esc(AR.required)}</span></label>
      <input id="nameAr" name="nameAr" type="text" data-testid="phone-nameAr"
             value="${esc(p?.nameAr ?? "")}" required>

      <label for="nameEn">${esc(AR.nameEn)}</label>
      <input id="nameEn" name="nameEn" type="text" class="ltr" data-testid="phone-nameEn"
             value="${esc(p?.nameEn ?? "")}">

      <div class="row">
        <div>
          <label for="price">${esc(AR.price)} <span class="req">${esc(AR.required)}</span></label>
          <input id="price" name="price" type="text" class="ltr" inputmode="decimal"
                 data-testid="phone-price" value="${esc(p?.priceDecimal ?? "")}" required>
        </div>
        <div>
          <label for="baseUnit">${esc(AR.unit)} <span class="req">${esc(AR.required)}</span></label>
          <select id="baseUnit" name="baseUnit" data-testid="phone-unit">${unitOptions}</select>
        </div>
      </div>

      <label for="sku">${esc(AR.sku)}</label>
      <input id="sku" name="sku" type="text" class="ltr" data-testid="phone-sku"
             value="${esc(p?.sku ?? "")}">

      <label for="barcode">${esc(AR.barcode)}</label>
      <input id="barcode" name="barcode" type="text" class="ltr" inputmode="numeric"
             data-testid="phone-barcode" value="${esc(data.master.barcode)}">
      <!-- The field above stays editable after a decode, always: real-world recall is about two
           in three, so a merchant will need to correct it. -->
      <div class="media-row">
        <label class="btn-file" for="barcodeFile" data-testid="phone-barcode-scan">📷 ${esc(AR.barcodeScan)}</label>
        <input id="barcodeFile" type="file" accept="image/*" capture="environment"
               data-testid="phone-barcode-input" hidden>
      </div>
      <p id="barcodeStatus" class="note" data-testid="phone-barcode-status"></p>
    </fieldset>

    <fieldset>
      <legend>${esc(AR.sectionOnline)}</legend>

      <label for="categoryId">${esc(AR.category)}</label>
      <select id="categoryId" name="categoryId" data-testid="phone-category">${categoryOptions}</select>

      <label for="brand">${esc(AR.brand)}</label>
      <input id="brand" name="brand" type="text" list="brands" data-testid="phone-brand"
             value="${esc(data.master.brand)}">
      <datalist id="brands">${brandOptions}</datalist>

      <label for="descriptionAr">${esc(AR.descAr)}</label>
      <textarea id="descriptionAr" name="descriptionAr" data-testid="phone-descAr">${esc(
        data.master.descriptionAr,
      )}</textarea>

      <label for="descriptionEn">${esc(AR.descEn)}</label>
      <textarea id="descriptionEn" name="descriptionEn" class="ltr" data-testid="phone-descEn">${esc(
        data.master.descriptionEn,
      )}</textarea>

      <div class="check">
        <input id="isOnlineVisible" name="isOnlineVisible" type="checkbox"
               data-testid="phone-online"${data.master.isOnlineVisible ? " checked" : ""}>
        <label for="isOnlineVisible" style="margin:0">${esc(AR.onlineVisible)}</label>
      </div>
    </fieldset>

    <fieldset>
      <legend>${esc(AR.sectionPhoto)}</legend>
      ${p?.hasPhoto ? `<p class="note" data-testid="phone-photo-current">${esc(AR.photoCurrent)}</p>` : ""}

      <!-- A file input, not a live camera API. The capture attribute opens the camera on iOS and
           Android and needs no secure context; the live-camera and in-browser-scanner APIs are
           secure-context only and are undefined on a plain-HTTP LAN origin on both platforms.
           Their names are deliberately not written here, so a test can assert this page contains
           no reference to them. -->
      <div class="media-row">
        <label class="btn-file" for="photoFile" data-testid="phone-photo-take">📷 ${esc(AR.photoTake)}</label>
        <input id="photoFile" type="file" accept="image/*" capture="environment"
               data-testid="phone-photo-input" hidden>
        <label class="btn-file" for="photoPick" data-testid="phone-photo-choose">🖼 ${esc(AR.photoChoose)}</label>
        <input id="photoPick" type="file" accept="image/*" data-testid="phone-photo-pick" hidden>
      </div>
      <div id="photoPreviewWrap" class="preview" hidden>
        <img id="photoPreview" alt="" data-testid="phone-photo-preview">
      </div>
      <p id="photoStatus" class="note" data-testid="phone-photo-status"></p>
      <!-- Separate from photoStatus on purpose: that line reports the UPLOAD, which is the
           authoritative fact, and this one reports only whether a local preview could be drawn.
           One element reporting both would make a cosmetic failure look like a lost photo. -->
      <p id="photoPreviewNote" class="note" data-testid="phone-photo-preview-status"></p>
      <p class="note">${esc(AR.photoHint)}</p>
    </fieldset>
  </form>
</main>

<footer>
  <button id="save" type="button" data-testid="phone-save">${esc(AR.save)}</button>
</footer>

<script>
(function () {
  "use strict";
  var DATA = ${bootstrap};
  var form = document.getElementById("f");
  var btn = document.getElementById("save");
  var msg = document.getElementById("msg");
  var done = document.getElementById("done");

  function val(id) { var el = document.getElementById(id); return el ? el.value : ""; }

  function body() {
    return {
      product: {
        nameAr: val("nameAr"),
        nameEn: val("nameEn"),
        sku: val("sku"),
        price: val("price"),
        baseUnit: val("baseUnit")
      },
      master: {
        categoryId: val("categoryId"),
        barcode: val("barcode"),
        brand: val("brand"),
        descriptionAr: val("descriptionAr"),
        descriptionEn: val("descriptionEn"),
        isOnlineVisible: document.getElementById("isOnlineVisible").checked
      }
    };
  }

  function fail(text) {
    msg.textContent = ${jsonForScript(AR.errorPrefix)} + " " + text;
    msg.className = "err";
    btn.disabled = false;
    btn.textContent = ${jsonForScript(AR.save)};
    msg.scrollIntoView({ block: "center" });
  }

  // ── Media: the phone sends a file, the till does the work ───────────────────────────────────
  //
  // 🔴 THE BROWSER NEVER DECODES OR RESIZES ANYTHING. It posts the bytes the OS camera produced
  // to the session's own scoped endpoint and shows what the till answers. No canvas, no
  // compression, no barcode library — that is the whole point of the architecture, and it is why
  // an old Android phone gets the same result as a new iPhone.

  function setNote(el, text, cls) {
    el.textContent = text;
    el.className = "note" + (cls ? " " + cls : "");
  }

  function post(path, file, onDone) {
    var xhr = new XMLHttpRequest();
    // The session's own URL, relative — the token never appears in this script.
    xhr.open("POST", window.location.pathname + path, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.onload = function () {
      var res = null;
      try { res = JSON.parse(xhr.responseText); } catch (e) { res = null; }
      onDone(xhr.status, res);
    };
    xhr.onerror = function () { onDone(0, null); };
    xhr.send(file);
  }

  var photoStatus = document.getElementById("photoStatus");
  var previewWrap = document.getElementById("photoPreviewWrap");
  var preview = document.getElementById("photoPreview");
  var previewNote = document.getElementById("photoPreviewNote");

  // ── The local preview ────────────────────────────────────────────────────────────────────────
  //
  // 🔴 A data: URL, NOT AN OBJECT URL, AND THE SERVED PAGE'S OWN CSP IS THE REASON.
  // This page is served with  default-src 'none'; img-src 'self' data:  — and a blob: URL from
  // URL.createObjectURL is NOT admitted by that policy, so the browser refuses to load it: the
  // <img> stays blank at zero size, while createObjectURL itself throws nothing and the status
  // line still says the photo is ready. The merchant photographs a product, is told it is saved,
  // and sees no picture — silently. That is what run 38901097239 hit, and only a REAL browser
  // could see it; every fetch-driven check before it renders nothing and passed.
  //
  // The CSP is not widened to fix this. data: is already admitted, costs one base64 copy of a
  // photo the phone is holding anyway, and keeps img-src 'self' data: exactly as it is — a
  // policy line is a poor thing to trade for a courtesy image.
  //
  // 🔴 AND THE PREVIEW IS NEVER THE AUTHORITY. It is drawn only after the till has answered 200,
  // it reports its own failures on its own line, and nothing about it can lose the draft, end the
  // session or change what was staged. A phone that cannot draw a preview can still save.
  function previewFailed() {
    previewWrap.hidden = true;
    // Cleared by attribute: setting src to the empty string resolves against the page and would
    // fetch this page again.
    preview.removeAttribute("src");
    setNote(previewNote, ${jsonForScript(AR.photoPreviewFailed)}, "bad");
  }

  function showPreview(file) {
    var reader;
    try {
      reader = new FileReader();
    } catch (e) {
      previewFailed();
      return;
    }
    reader.onload = function () {
      var url = typeof reader.result === "string" ? reader.result : "";
      // Anything that is not a data: URL is refused rather than assigned — the CSP would block it
      // and the merchant would get a blank box with no explanation.
      if (url.indexOf("data:image/") !== 0) {
        previewFailed();
        return;
      }
      preview.src = url;
      previewWrap.hidden = false;
      setNote(previewNote, "", "");
    };
    reader.onerror = function () { previewFailed(); };
    reader.onabort = function () { previewFailed(); };
    try {
      reader.readAsDataURL(file);
    } catch (e) {
      previewFailed();
    }
  }

  function sendPhoto(file) {
    if (!file) return;
    setNote(photoStatus, ${jsonForScript(AR.photoUploading)}, "");
    post("/photo", file, function (status, res) {
      if (status === 200 && res && res.ok) {
        setNote(photoStatus, ${jsonForScript(AR.photoReady)}, "ok");
        showPreview(file);
        return;
      }
      // 🔴 A REFUSED PHOTO COSTS THE PHOTO, NEVER THE DRAFT. The form keeps everything typed and
      // the merchant can pick another file.
      setNote(photoStatus, ((res && res.message) ? res.message : ${jsonForScript(AR.photoRetry)}), "bad");
    });
  }

  ["photoFile", "photoPick"].forEach(function (id) {
    var input = document.getElementById(id);
    if (input) input.addEventListener("change", function () { sendPhoto(input.files && input.files[0]); });
  });

  var barcodeStatus = document.getElementById("barcodeStatus");
  var barcodeInput = document.getElementById("barcodeFile");
  if (barcodeInput) {
    barcodeInput.addEventListener("change", function () {
      var file = barcodeInput.files && barcodeInput.files[0];
      if (!file) return;
      setNote(barcodeStatus, ${jsonForScript(AR.barcodeScanning)}, "");
      post("/barcode", file, function (status, res) {
        if (status === 200 && res && res.ok && res.found) {
          // Populate the field — and LEAVE IT EDITABLE. The merchant corrects it if the decoder
          // misread, which it will for roughly one difficult label in three.
          document.getElementById("barcode").value = res.value;
          setNote(
            barcodeStatus,
            ${jsonForScript(AR.barcodeFound)} + (res.format ? " (" + res.format + ")" : "") +
              " — " + ${jsonForScript(AR.barcodeEditable)},
            "ok"
          );
          return;
        }
        if (status === 200 && res && res.ok) {
          // 🔴 A MISS IS NOT A FAILURE. The draft, the session and manual entry all survive, and
          // Save is never blocked by it.
          setNote(barcodeStatus, ${jsonForScript(AR.barcodeNotFound)}, "bad");
          return;
        }
        setNote(barcodeStatus, ((res && res.message) ? res.message : ${jsonForScript(AR.barcodeNotFound)}), "bad");
      });
    });
  }

  btn.addEventListener("click", function () {
    // 🔴 UX ONLY. The till refuses an empty name regardless; this just avoids a round trip.
    if (val("nameAr").trim() === "" || val("price").trim() === "") {
      fail(${jsonForScript(AR.required)});
      return;
    }
    msg.className = "";
    btn.disabled = true;
    btn.textContent = ${jsonForScript(AR.saving)};

    var xhr = new XMLHttpRequest();
    // 🔴 THE SAME URL THIS PAGE WAS SERVED FROM, relative — so the token never appears in this
    // script, and the page cannot be made to post somewhere else by editing one string.
    xhr.open("POST", window.location.pathname, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = function () {
      var res = null;
      try { res = JSON.parse(xhr.responseText); } catch (e) { res = null; }
      if (xhr.status === 200 && res && res.ok) {
        document.querySelector("[data-testid=phone-saved]").textContent = DATA.savedMessage;
        done.className = "on";
        document.body.className = "saved";
        window.scrollTo(0, 0);
        return;
      }
      fail((res && res.message) ? res.message : String(xhr.status));
    };
    xhr.onerror = function () { fail(${jsonForScript(AR.errorNetwork)}); };
    xhr.send(JSON.stringify(body()));
  });

  if (form) form.addEventListener("submit", function (e) { e.preventDefault(); });
})();
</script>
</html>
`;
}
