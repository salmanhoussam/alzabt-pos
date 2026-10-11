# Alzabt POS — mobile LAN product entry: architecture study

> **STUDY ONLY. NOTHING IMPLEMENTED.** No migration written, no production file touched, no
> dependency added to the product. The one prototype lives in `/tmp` and is thrown away; the active
> Product Master branch (`feat/product-master-v1`, `2cd28bf`) is untouched and was verified so.
>
> Measured 2026-10-11 against `main` at `e32a3a4` (schema v9 in flight on the feature branch).

---

## A · Current repository constraints — measured, not recalled

| Fact | Value | Why it matters here |
| :--- | :--- | :--- |
| Runtime dependencies | **ONE**: `better-sqlite3 ^13.0.3` | Every dependency proposed below is weighed against a product that currently ships one |
| Electron / Node | **44.5.1** / **Node 24.21.0** in main | `node:http` is available with zero additions |
| Renderer CSP | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'` | 🔴 `connect-src 'none'` — the desktop renderer cannot make a network request at all, by policy |
| `fetch` / `XMLHttpRequest` in the app | **zero occurrences** | The product is offline by construction, not by habit |
| HTTP servers / listeners | **zero** (`createServer`, `.listen(`, `node:net`, `dgram`: no hits) | A LAN listener would be this product's **first** inbound network surface |
| `webPreferences` | `contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true` | The security posture a phone bridge must not undermine |
| `barcode` in src | **zero** (only three comments naming it as deliberately absent) | Greenfield; `productAdmin.test.ts:102` asserts the column is absent, so adding it is a visible transition |
| `nativeImage` usage | **zero so far** | Measured feasible in the earlier study; still unused |
| Unit vocabulary | `BASE_UNITS` in `src/domain/catalog.ts` — `piece, box, pack, kg, meter, other` | §18's "one authoritative list" already exists; the phone must read it, never restate it |

**Consequence that shapes everything below:** this application has never opened a port. Adding one
is a bigger step than adding a screen, and the study is honest that this is the single largest
security change the product has made since operator accounts.

---

## B · Recommended architecture — the phone is a FORM, the POS is the BRAIN

```
PHONE (any browser, plain HTTP, no install)        POS (Electron main, Node 24)
┌─────────────────────────────┐                   ┌──────────────────────────────────┐
│ one HTML page, served by    │  GET /m/<token>   │ node:http, bound to ONE LAN IP,  │
│ the POS itself              │ ◄──────────────── │ started on an explicit click     │
│                             │                   │                                  │
│ Arabic-first product form   │  POST /m/<token>  │ validate → SAME domain rules as  │
│ <input file capture> photo  │ ────────────────► │ the desktop → SAME service →      │
│ <input file capture> barcode│    (multipart)    │ nativeImage normalize            │
│ NO camera API. NO scanner.  │                   │ zxing-wasm DECODE the barcode    │
│ NO secure context needed.   │                   │ zxing-wasm WRITE the QR          │
└─────────────────────────────┘                   └──────────────────────────────────┘
```

**The decisive design move: decoding happens on the POS, not on the phone.** That one choice
removes the entire secure-context problem (§C), removes any JS library from the phone, keeps the
phone page small enough to serve from memory, and means a shop with an old Android phone gets the
same accuracy as a new iPhone.

---

## C · Browser vs PWA vs native app — and why the browser wins on measured facts

### The facts that decide it

**1 · A live camera in a browser over plain-HTTP LAN is not available on iOS, at all.**
`getUserMedia` requires a secure context; in an insecure context `navigator.mediaDevices` is
**undefined**, and `http://192.168.x.x` is not a secure context (only HTTPS, `file://` and
`localhost` qualify). Safari enforces this.

**2 · `BarcodeDetector` does not rescue it.** Chromium on Android ships it; **iOS Safari has it
disabled by default** (17.0–26.6), Firefox does not implement it, and it is **secure-context only**
— so it fails on an HTTP LAN origin even on Android.

**3 · But `<input type="file" accept="image/*" capture>` is a FILE INPUT, not a camera API.** It
needs no secure context and no permission prompt beyond the OS picker, and it opens the camera on
both iOS and Android. This is the one capture path that works everywhere the shop might point a
phone at the QR.

### The comparison

| | **A · LAN browser page** | **B · LAN PWA** | **C · Native companion app** |
| :--- | :--- | :--- | :--- |
| Merchant setup | **scan, done** | scan, then "Add to Home Screen", then trust it | install, sign, pair, update |
| Android | ✅ | ✅ | ✅ |
| iPhone | ✅ | ⚠️ service workers need HTTPS; a changing LAN IP makes the install near-useless | ⚠️ signing + **iOS 14+ Local Network permission prompt**, plus App Store or sideloading |
| No Internet | ✅ everything served by the POS | ✅ | ✅ |
| Photo quality | OS camera via file capture — the phone's real camera app | same | marginally better control |
| **Live barcode scan** | ❌ not on HTTP | ❌ same constraint | ✅ the only real advantage |
| Photo-based barcode | ✅ decoded on the POS | ✅ | ✅ |
| Security surface | one temporary port, one token, upload-only | same + a cached app that outlives the session | a permanent app with stored pairing |
| Firewall friction | one prompt, once | same | same |
| Deployment / updates | **the POS serves the page — it updates itself** | cache invalidation on a changing origin | two app stores, two signing identities |
| Maintenance | one codebase | one codebase + PWA lifecycle | **a second application** |
| Code reuse | the same domain validation, literally | same | re-implemented, drifts |
| Reliability | depends on LAN only | depends on LAN + SW cache | depends on LAN + install state |
| Multi-terminal future | token names its POS — fine | fine | pairing per terminal, worse |

### Recommendation

**A · the temporary LAN browser page, for V1.** The only thing B and C buy is a live camera
scanner, and the photo-based path answers the same need at a fraction of the cost. A PWA whose
origin is `http://192.168.1.20:7311` is a bad PWA: the origin changes when DHCP moves the POS, and
every service-worker benefit needs the HTTPS this design deliberately avoids. A native app is a
second product to sign, ship, support and keep in step with Product Master — for a scanner.

**When C would become right, stated now so the decision is checkable later:** if the shop reports
that photographing barcodes is too slow for bulk entry (dozens of products in a sitting), a live
scanner is worth a companion app. That is a measurement, not a guess — and the browser path will
have produced the number.

---

## D · Recommended V1 scope

| In V1 | Out of V1 |
| :--- | :--- |
| New product **and** edit existing, both from the QR | multi-terminal sync |
| Arabic/English name, SKU, unit, price, category, brand | category administration from the phone (see §17) |
| Arabic/English description, online visibility | specifications, inventory, barcode *multiples* |
| Photo: take or choose, replace, remove | live camera preview |
| Barcode: photograph it, POS decodes, merchant corrects | OCR of any kind |
| One active phone per token | two phones editing one product |

---

## E · QR / pairing lifecycle — exact

```
1  OWNER clicks "Add Product from Phone" (or "Continue on Phone" on an open product)
2  IPC channel (owner-only, service-enforced) asks main to open a session
3  main: pick the LAN interface (§21) · bind node:http to THAT IP only · random port
4  main: token = randomBytes(32).hex   — never a uuid, never derived from the product id
5  main: session = { token, terminalId, action: NEW_PRODUCT | EDIT_PRODUCT, productId?,
                     operatorId, createdAt, expiresAt = +10min, boundClient: null, used: false }
6  main: QR encodes ONLY  http://<ip>:<port>/m/<token>     (zxing-wasm writer, §N)
7  desktop shows the QR + the product name + "افتح الكاميرا على الهاتف وامسح الرمز"
8  phone GET /m/<token>  → first requester BINDS the session (IP+UA recorded) → HTML form
9  phone POST /m/<token> → validated → written through the SAME service the desktop uses
10 session invalidated · listener closed · desktop refreshes from the database
```

**Invalidated on:** success · explicit cancel · expiry (10 min) · desktop navigating away from the
product · app quit · a second client attempting to bind · any 3 malformed requests.

**The QR carries nothing but an opaque token.** No PIN, no operator name, no database path, no
product name, no internal id. A photographed QR is worth nothing after the session ends.

---

## F · LAN server lifecycle — temporary, and that is the recommendation

**No permanently-open server.** It starts on an explicit click and stops on any of the invalidation
events above, so the product's attack surface is zero bytes for 99.9% of the trading day. A
permanent service would be *simpler* in exactly one way — no repeated firewall prompt — and that
single convenience is not worth a port open all day on a shop PC that also holds the ledger.

One honest cost of the temporary model: **the firewall prompt may appear on first use** (§G), and
possibly again after an app update changes the binary.

---

## G · Windows Firewall — findings, and the one thing that must be measured on real Windows

What the evidence supports:

- A process that begins **listening on a non-loopback interface** triggers the Windows Firewall
  prompt on first run; clicking *Allow access* is what makes inbound connections work, and without
  it connections from another host are blocked.
- Binding only `127.0.0.1` avoids the prompt entirely — **and is useless here**, because the phone
  is another host. `127.0.0.1` must never appear in the QR.
- Adding or changing a rule requires **administrator rights** (`netsh advfirewall firewall add
  rule`, `New-NetFirewallRule`). The product installs **per-user without admin**, so a silent
  installer-time firewall rule would mean asking for elevation the installer does not currently
  need.
- The **Private vs Public** profile matters: a rule allowed for Private does nothing on a network
  Windows has classified Public, and shop Wi-Fi is often Public by accident.
- There is a reported failure mode where an already-allowed listener silently stops accepting
  inbound connections with no notification.

**Recommendation:** do **not** add a firewall rule at install time. Let Windows prompt on first use,
and design the UX for it honestly:

```
إذا ظهرت رسالة من Windows تسأل عن السماح لـ Alzabt POS بالاتصال بالشبكة:
اختر "الشبكات الخاصة" ثم السماح.
بدون ذلك لن يستطيع الهاتف الوصول إلى الصندوق.
```

Plus a **"الهاتف لا يستطيع الوصول؟"** link that shows the bound IP and port and names the two
usual causes: the Windows prompt was dismissed, or the network is marked Public.

🔴 **Unverified here.** This environment is Linux. Whether the prompt appears for an
`electron.exe` that has already been allowed once, what happens after an update changes the
binary's signature, and the Public-profile behaviour must be measured on the real installed build.
That is test 22 in §T and it is a **gate**, not a nicety: without it we would be claiming a feature
works on a machine we never tried it on.

---

## H · iPhone findings

| | |
| :--- | :--- |
| Opens an `http://192.168.x.x:port` page | ✅ |
| `<input type="file" accept="image/*" capture>` | ✅ camera and library both reachable |
| `getUserMedia` on that origin | ❌ **`navigator.mediaDevices` is undefined** — insecure context |
| `BarcodeDetector` | ❌ disabled by default through 26.6, and secure-context only |
| Local Network permission | **not applicable to Safari**; it applies to native apps (iOS 14+), which is a cost of option C, not A |
| In-app browsers (WhatsApp, Instagram) | ⚠️ `navigator.mediaDevices` can be undefined even on HTTPS — another reason not to depend on it |

## I · Android findings

| | |
| :--- | :--- |
| Opens the LAN page | ✅ |
| File capture | ✅ |
| `getUserMedia` on HTTP LAN | ❌ insecure context, same rule |
| `BarcodeDetector` | ✅ Chromium ≥ ~88 — but **secure-context only**, so still unavailable on our origin |
| Samsung Internet / Firefox Android | ⚠️ varies; the file-capture path does not |

**Therefore the design uses no browser camera API on either platform.** Not as a compromise — as
the only choice that is the same on both.

---

## J · Offline / no-Internet proof

Everything the phone receives is produced locally:

- the HTML, CSS and the few lines of JS are **inlined by the POS** — no CDN, no Google Fonts, no
  external anything (the desktop renderer's own CSP already forbids remote assets);
- the QR is generated **locally** by `zxing-wasm`'s writer from a local `.wasm`, measured below;
- barcode decoding runs **locally** in Electron's main process;
- the token is validated **in memory on the POS**. No cloud validation exists to fail.

Measured in the prototype: both `.wasm` files were loaded from disk via `prepareZXingModule({
overrides: { wasmBinary } })`, so the library never reaches for its CDN default. That override is
**mandatory** in the implementation, and should be asserted by a test that fails if it is removed.

---

## K · Mobile Product Master UI

One scrolling column, Arabic-first, RTL, large tap targets, numeric keyboards where they belong,
and **the same field vocabulary as the desktop form** — not the desktop layout at 390px.

```
┌──────────────────────────────┐
│ الزبط — إضافة صنف            │   ← and the product's name when editing
├──────────────────────────────┤
│ الاسم بالعربية *             │
│ [__________________________] │
│ الاسم بالإنجليزية            │
│ [__________________________] │
├──────────────────────────────┤
│ الباركود                     │
│ [_________________] (LTR)    │   ← inputmode="numeric", dir="ltr", <bdi> when shown
│ [  📷 صوّر الباركود  ]        │
├──────────────────────────────┤
│ التصنيف    [ عدد        ▼ ]  │
│ الماركة    [______________]  │
│ الوحدة     [ حبة        ▼ ]  │   ← BASE_UNITS, served from the POS
│ السعر      [_________] ل.ل   │   ← inputmode="decimal", dir="ltr"
│ SKU        [_________] (LTR)  │
├──────────────────────────────┤
│ الوصف بالعربية               │
│ [__________________________] │
│ الوصف بالإنجليزية            │
│ [__________________________] │
├──────────────────────────────┤
│ صورة الصنف                   │
│ [ 📷 صوّر ]  [ 🖼 اختر صورة ] │
│  (preview, with إزالة)       │
├──────────────────────────────┤
│ ☐ يظهر في الكاتالوج الإلكتروني│
├──────────────────────────────┤
│ [       حفظ الصنف        ]   │  ← sticky at the bottom
│ [        إلغاء           ]   │
└──────────────────────────────┘
```

Every number, SKU, barcode and price is `dir="ltr"` inside an RTL page — the same bidi discipline
the desktop screens are being held to, for the same reason: a price that renders backwards is
wrong, not merely ugly.

---

## L · Photo workflow

```
phone: <input type="file" accept="image/*" capture>  →  multipart POST (body cap ~12 MB)
POS:   sniff real magic bytes (never trust the filename or the declared MIME)
       → nativeImage.createFromBuffer  → fails?  reject as "not an image"
       → resize to a max edge (≈1600px) → toJPEG(quality) for photographs
       → sha256, byte_size, dimensions
       → store in catalog_product_images per the approved child-table model
       → desktop shows the preview; the phone shows its own
```

The source file on the phone is never referenced again, and no absolute path is stored.

🔴 **`nativeImage` could not be re-measured in this environment** — Electron falls back to Node mode
with no display, so `nativeImage` is undefined. The earlier architecture study measured
`createFromBuffer`, `resize`, `toJPEG`, `toPNG` as working and **no `toWEBP`**; this study inherits
that rather than re-deriving it, and flags that it is inherited. **WEBP must not be promised.**

---

## M · Barcode workflow — photograph it, decode on the POS

```
phone: [ صوّر الباركود ]  →  <input type="file" accept="image/*" capture>  →  POST
POS:   nativeImage decode → zxing-wasm readBarcodes({ tryHarder: true })
       → hit:  return { value, format } → phone fills the field, merchant can EDIT it
       → miss: "ما قدرنا نقرأ الباركود. جرّب صورة أوضح أو اكتبه بإيدك."
```

**The merchant can always type or correct it.** That is not a courtesy; it is required, because the
decoder will sometimes fail — see the honest number in §N.

Live scanning (option B of §13) is **rejected for V1** on the measured secure-context facts in §C,
not on effort.

---

## N · Barcode / QR technology — one dependency does both jobs

### 🔴 The finding that removes a whole dependency

`zxing-wasm` ships a **writer** as well as a reader. The QR code the desktop displays can be
generated by the same package that decodes the barcodes — so **no separate QR dependency is
needed**. §12 asked whether one was necessary; the answer is no.

### Measured in Electron's own Node runtime, offline, with local `.wasm`

```
EAN-13    1295B PNG -> decoded "5901234123457" (EAN13)      OK
EAN-8      986B PNG -> decoded "96385074"      (EAN8)       OK
UPC-A     1311B PNG -> decoded "0036000291452" (EAN13)      see below
Code128   1634B PNG -> decoded "ALZ-7781-A"    (Code128)    OK
Code39    1234B PNG -> decoded "ALZ123"        (Code39)     OK
QRCode     717B PNG -> decoded "http://..."    (QRCode)     OK
reader wasm 966,895 B   ·   writer wasm 647,500 B
```

🔴 **The UPC-A line is not a failure, and my first assertion about it was wrong.** A UPC-A is a
12-digit EAN-13 with a leading zero: typing `036000291452` and reading back `0036000291452` is the
*same number*, correctly decoded. My equality check was naive — the same class of error this
project keeps catching. **It is a real requirement for §14:** normalization must treat a 12-digit
UPC-A and its 13-digit EAN-13 form as one barcode, or the shop will create duplicates.

### The package

| | |
| :--- | :--- |
| `zxing-wasm` | **3.1.5**, published **2026-10-06** (five days before this study) |
| License | MIT |
| Runtime dependencies | `type-fest`, `@types/emscripten` — **both type-only**, no runtime code |
| Installed footprint | **4 packages, 5.0 MB** (`zxing-wasm`, `type-fest`, `tagged-tag`, `@types`) |
| Entry points | `reader` / `writer` / `full` — import only what is used |
| Electron compatibility | ✅ measured in Electron 44's Node 24 runtime |
| Offline | ✅ with the `wasmBinary` override; **without it the library fetches a CDN** |

**Honest accuracy number, which changes the UX rather than the choice:** an independent benchmark
over 7,894 real-world images reported ~**67% recall** for `zxing-wasm` against ~85% for a
commercial decoder. Roughly one in three difficult real photographs will not decode. That is
precisely why manual correction is mandatory and why the failure message above is written in the
merchant's own terms rather than as an error code.

### QR generation alternatives, measured from the registry rather than from search blurbs

| package | version | last modified | runtime deps | verdict |
| :--- | :--- | :--- | :--- | :--- |
| `qrcode` | 1.5.4 | 2025-11-13 | **3** (`pngjs`, `yargs`, `dijkstrajs`) | `yargs` for a CLI we would never call — rejected |
| `qrcode-encoder` | 1.3.0 | 2026-05-12 | none | the best standalone, but unnecessary |
| `qrcode-svg` | 1.1.0 | **2022-06-25** | none | stale |
| `qr-image` | 3.2.0 | **2023-02-12** | none | stale |
| **`zxing-wasm` writer** | 3.1.5 | **2026-10-06** | type-only | ✅ **already needed for decoding** |

**Recommendation: add exactly one dependency, `zxing-wasm`, and use both of its halves.** The
product goes from one runtime dependency to two.

---

## O · Security / threat model

| Threat | Mitigation |
| :--- | :--- |
| Guessing a token | 32 random bytes from `randomBytes`; not derivable from a product id |
| A photographed / shared QR | 10-minute expiry, one-time, invalidated on completion and on navigation away |
| A second phone on the same QR | **first GET binds the session**; a second client is refused with a message naming the first |
| Replay after success | session deleted; the port is closed |
| CSRF | the token lives in the **path**, there are no cookies, and there is no ambient authority to ride on; `Origin`/`Referer` are not trusted either way |
| Uploading a non-image | magic-byte sniffing **and** `nativeImage` decode must both succeed; declared MIME and filename are ignored |
| Oversized body | hard cap (~12 MB), enforced by counting bytes as they arrive and destroying the socket — never by trusting `Content-Length` |
| Path traversal | **no path is ever taken from a request.** The only routes are `/m/<token>` and `/m/<token>/image`; no filesystem path is constructed from input |
| Reading the database | the listener exposes no read API beyond the one product the token names, and no SQL path at all |
| Generic IPC proxy | 🔴 **explicitly forbidden.** The HTTP surface calls named service methods, never a channel name taken from a request |
| Cashier initiating a session | initiation is an **owner-only IPC channel**, enforced in the service, not by hiding a button |
| Wrong-product attachment | the token *is* the product binding; the phone never names a product id |
| DoS / port scanning | 3 malformed requests end the session; unknown paths get 404 with no body; the port is open for minutes a day |
| Listener outliving the flow | closed on save, cancel, expiry, navigation away and app quit — asserted by test, not by convention |

**What the phone can never do:** sales, history, voids, operators, backup, settings, catalog
browsing, arbitrary product reads, or any write outside the one product its token names.

---

## P · Disconnect / recovery behaviour

**Nothing durable is written until Save.** The mobile edit is client-side state plus one in-memory
session on the POS — option A of §19, chosen because it cannot leave a half-created product. The
phone leaving Wi-Fi, locking, refreshing, or the POS closing all cost the merchant their typing and
nothing else.

Honest text when it happens:

```
انقطع الاتصال مع صندوق الزبط.
لم يتم حفظ الصنف.
```

A refresh inside the expiry window re-serves the form with the session's data where the POS has it;
after expiry the phone says so plainly rather than appearing to work.

---

## Q · Multiple phones

**One active client per token.** The first `GET` binds; a second is refused:

```
هذا الرمز مستخدم على هاتف آخر.
اطلب رمزاً جديداً من الصندوق.
```

No last-write-wins. Taking over requires a new QR from the desktop — an explicit operator action.

---

## R · Integration with desktop Product Master

**One model, one service, many surfaces.** The phone POSTs into the *same* `ProductDraft`
validation and the *same* service methods the desktop form calls. The phone's validation is UX
only; the authoritative rules stay in `src/domain` and `src/application`.

Consequences, stated so they cannot be quietly violated:

- the phone must **fetch** `BASE_UNITS` and the category list from the POS, never restate them;
- a field the desktop refuses the phone must refuse identically;
- there is **no "mobile product" table, no mobile-only column, and no second write path.**

---

## S · Integration with the online catalog

Everything entered from the phone — barcode, category, brand, descriptions, photo, visibility —
lands in `catalog_products` / `catalog_product_images` and is therefore in the export the moment it
is saved. **No separate mobile catalog exists.** Barcode joins the JSON contract as its own public
field, distinct from SKU.

---

## T · Real-device test plan for Salman

**Phone A — Android. Phone B — iPhone.** Both on the shop Wi-Fi, **Internet physically
disconnected** (unplug the WAN cable or disable the router's uplink — not just "it feels offline").

```
SETUP
 1  POS and phone on the same Wi-Fi/LAN
 2  disconnect the Internet; confirm a browser cannot reach any website
HAPPY PATH
 3  Products → Add Product from Phone
 4  QR appears, with the bound IP and port visible
 5  scan with the phone camera app
 6  the product page opens
 7  type an Arabic name          8  choose a category
 9  set unit and price          10  take a product photo
11  photograph a real barcode on a real product
12  type an Arabic description  13  tick "يظهر في الكاتالوج الإلكتروني"
14  Save
15  the desktop shows the product immediately, with the photo
16  close and reopen the POS    17  the product and photo survive
18  Export Online Catalog contains it
19  the exported image opens and matches     20  the barcode survives
EDIT MODE
21  open an existing product → Continue on Phone → enrich it → Save
SECURITY
22  🔴 note EXACTLY what Windows asked on first use, and what happened if you dismissed it
23  scan the same QR a second time                 → must refuse
24  wait past expiry, then scan                    → must refuse
25  scan on phone B while phone A has it open      → must refuse, naming the other phone
26  navigate away on the desktop, then Save on the phone → must refuse
27  close the POS mid-edit, then Save              → must fail cleanly, nothing half-saved
28  upload a huge photo and a non-image file       → must refuse both
NETWORK REALITY
29  POS on Ethernet, phone on Wi-Fi, same router   → must work
30  mark the Windows network Public, retry         → record what happens
31  restart the router, retry
```

🔴 **Mobile LAN entry is not "ready" until 22, 30 and the Internet-disconnected run are done on the
real shop PC with real phones.** CI cannot produce any of them.

---

## U · Dependencies required

**One: `zxing-wasm` (MIT).** Reader for barcode decoding, writer for QR generation. Four packages,
5.0 MB installed, no runtime code dependencies, local `.wasm` mandatory. Nothing else — the HTTP
server is `node:http`, the image work is `nativeImage`, the token is `node:crypto`.

## V · Migration implications — **none in this study**

When implemented, barcode needs **one additive column** and should ride the Product Master
migration boundary rather than opening its own:

```
ALTER TABLE catalog_products ADD COLUMN barcode TEXT;
CREATE UNIQUE INDEX catalog_products_barcode ON catalog_products (barcode) WHERE barcode IS NOT NULL;
```

**ONE primary barcode for V1**, not many — matching the one-primary-image decision and the shop's
actual need. Nullable, unique when present (a partial index, exactly as `sku` already does),
separate from SKU, normalized for the UPC-A/EAN-13 equivalence found in §N, and exported.

🔴 Whether this lands **inside migration 9** (if Product Master has not merged when barcode is
approved) or as migration 10 depends on timing, and that is a decision to take then, not now.
`productAdmin.test.ts` asserts `barcode` is absent today, so its arrival is a visible transition.

## W · Implementation scope

| Phase | Work | Risk |
| :--- | :--- | :--- |
| 1 | `zxing-wasm` + offline `.wasm` + decode service + tests | low — measured |
| 2 | barcode column, normalization, desktop field, export | low — additive |
| 3 | LAN session manager: interface pick, token, lifecycle, IPC | **medium** — first listener in the product |
| 4 | the HTTP surface + the served mobile page | **medium** — new attack surface |
| 5 | mobile form (photo + barcode + full fields) | medium — bidi and layout |
| 6 | installed-app E2E: every refusal path, upload via the real endpoint | medium |
| 7 | **real-device validation** | 🔴 **blocked on Salman and a Windows machine** |

Phases 1–2 are independent of the LAN work and can ship with Product Master. Phases 3–4 are where
the genuine risk lives and deserve their own review pass.

---

## X · Decisions required from Salman

| # | Decision | My recommendation |
| :--- | :--- | :--- |
| 1 | Browser page vs PWA vs native app | **browser page.** Revisit native only if bulk entry proves too slow |
| 2 | Temporary listener vs persistent service | **temporary**, started by an explicit click |
| 3 | QR dependency | **none** — `zxing-wasm`'s writer does it |
| 4 | Barcode decoder | **`zxing-wasm` on the POS**, not in the phone browser |
| 5 | Live camera scanning | **no for V1** — unavailable on iOS over HTTP, by rule |
| 6 | One barcode or many | **one primary**, nullable, unique when present |
| 7 | Add Category from the phone | **no** — choose from existing only; keep administration on the desktop |
| 8 | Save model | **client-side until Save** — no durable half-product |
| 9 | Firewall | **no installer rule, no elevation.** Let Windows prompt; write honest UX and a help link |
| 10 | Sequence | barcode (1–2) with Product Master; LAN entry (3–7) after the catalog export |

---

## Confirmed / Side findings / Unknowns

**Confirmed by execution.** `zxing-wasm` 3.1.5 decodes EAN-13, EAN-8, UPC-A (as EAN-13), Code128,
Code39 and QR in Electron 44's Node runtime with local `.wasm` and no network; its writer produces
a 717-byte PNG QR for a LAN URL. Registry-measured maintenance and dependency facts for all five QR
candidates. The repository has one runtime dependency, no listener, no `fetch`, and a renderer CSP
of `connect-src 'none'`.

**Side findings.** (1) `zxing-wasm` fetches a CDN for its `.wasm` unless overridden — a silent
online dependency in an offline product, and it must be asserted against. (2) The UPC-A/EAN-13
leading-zero equivalence is a real normalization requirement that a naive implementation will miss.
(3) `qrcode`, the obvious QR package, pulls `yargs` for a CLI the product would never invoke.

**Unknowns.** (1) 🔴 **Windows Firewall behaviour** — prompt text, Private vs Public, behaviour
after an update changes the binary. Linux here; must be measured on the shop PC. (2) 🔴
**`nativeImage` in this environment** — not re-verifiable without a display; inherited from the
earlier study and explicitly not re-proved. (3) Real decode rates on real Lebanese hardware-product
barcodes photographed by a real phone in shop lighting; the ~67% benchmark figure is a warning, not
a measurement of this shop. (4) iOS/Android behaviour is from documented platform rules, not from
devices in hand.

---

ALZABT MOBILE LAN PRODUCT ENTRY STUDY COMPLETE — FULL PRODUCT FORM + PHOTO + BARCODE — OFFLINE LAN — IMPLEMENTATION NOT STARTED.
