/**
 * The one live phone session a till may have, and everything that ends it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 ONE AT A TIME, ENFORCED HERE RATHER THAN HOPED FOR. `start` closes whatever was open before
 * it opens anything. Two QRs on one counter is a state neither the merchant nor this code could
 * reason about — and worse, the OLD session would still be live and claimable while the desktop
 * showed only the new one.
 *
 * 🔴 THIS IS THE MECHANISM, NOT THE PERMISSION. It takes an already-authorized `PhoneSessionSpec`.
 * `PosService.authorizePhoneSession` is what refused a cashier, and it did so before this file was
 * reached. Nothing here re-decides who may do it, so there is no second, drifting copy of the rule.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { DomainError } from "../domain/errors";
import { phonePhotoRefusalText } from "./phoneMediaText";
import {
  PHONE_SESSION_TOKEN_BYTES,
  createSession,
  effectiveAction,
  isLive,
  sessionUrl,
  type PhoneSession,
  type PhoneSessionAction,
  type PhoneSessionEndReason,
  type PhoneSessionSpec,
} from "../domain/phoneSession";
import { selectLanAddress, type NetworkInterfaceMap } from "./lanAddress";
import { renderSessionQrSvg } from "./phoneSessionQr";
import {
  startPhoneSessionServer,
  type PhoneSaveOutcome,
  type RunningPhoneSessionServer,
} from "./phoneSessionServer";
import { renderPhoneFormPage } from "./phonePage";
import { renderPhoneInvoicePage, renderPhoneLandingPage } from "./phoneInvoicePage";
import { PHONE_INVOICE_MAX_PER_BATCH } from "../domain/phoneInvoiceBatch";
import type { PhoneInvoiceStaging } from "./phoneInvoiceStaging";
import { parsePhoneSubmission } from "../domain/phoneSubmission";
import type { MasterForm } from "../shared/productMasterForm";
import type { PhoneFormData, PosService, StagedPhonePhoto } from "../application/posService";
import type { BarcodeScan } from "./phoneBarcode";
import type { NormalizedPhoto } from "./photoNormalize";
import type { Logger } from "./logger";
import type { PhoneSessionDto, PhoneSessionState } from "../shared/ipcContract";

/**
 * The pairing-only page, for a terminal wired without a service.
 *
 * 🔴 IT IS NOT A FORM WITH DEAD INPUTS. A page that looked like the real thing and then refused
 * every save would be worse than one that says plainly what it can do — this is the H1 shape,
 * which only a headless test or a mis-wired terminal ever sees.
 */
const PAIRED_WITHOUT_FORM_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>عالضبط</title>
<style>body{margin:0;padding:24px;font-family:system-ui,sans-serif;line-height:1.6}</style>
<p>تم ربط الهاتف بالصندوق، لكن إدخال الأصناف غير متاح على هذا الصندوق.</p>
</html>
`;

export interface PhoneSessionBridgeDeps {
  /** Synthetic hosted-runner trial only; binds exclusively to this runner's loopback. */
  readonly trialLoopback?: boolean;
  /**
   * The authoritative Product Master service. Slice H2.
   *
   * 🔴 THE BRIDGE HOLDS IT; THE LISTENER DOES NOT. The listener is handed one `save(body)` closure
   * built here, so the HTTP surface still cannot name a method or reach a repository — what it can
   * do is exactly one thing, decided before any request arrived. Absent means the phone can pair
   * but not save, which is the H1 shape and what every pairing-only test still gets.
   */
  readonly service?: PosService;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Injected so a test can present a Windows adapter list this Linux box could never produce. */
  readonly interfaces?: () => NetworkInterfaceMap;
  /** Injected so a test can pin a token. Production uses `node:crypto`. */
  readonly randomToken?: () => string;
  /** Injected so a test need not instantiate 647 KB of WebAssembly to check the lifecycle. */
  readonly renderQr?: (url: string) => Promise<string>;
  /**
   * Slice I1. F's pipeline, injected. Absent means this terminal cannot accept a phone photo and
   * the route answers NOT_AVAILABLE — which is what every pairing-only test gets, so none of them
   * can stage anything by accident.
   *
   * 🔴 IT IS F'S PIPELINE, NOT A SECOND ONE. `main.ts` wires
   * `assertStorable(normalizeProductPhoto(bytes, electronCodec(nativeImage)))` — the same decode,
   * EXIF orientation, resize policy, JPEG ladder, transparency rule and output cap the desktop
   * picker has used since slice F. Nothing about images is reimplemented here.
   */
  readonly normalizePhoto?: (bytes: Buffer) => NormalizedPhoto;
  /** Slice I1. zxing's reader, injected so a test need not load a megabyte of WebAssembly. */
  readonly decodeBarcode?: (bytes: Buffer) => Promise<BarcodeScan>;
  /** DEC-35z16 (PILOT). Absent means an INVOICE_BATCH session is refused as NOT_AVAILABLE. */
  readonly invoiceStaging?: PhoneInvoiceStaging;
  /** Fixed port for tests; production passes nothing and the OS picks a free one. */
  readonly port?: number;
}

export class PhoneSessionBridge {
  private running: RunningPhoneSessionServer | null = null;
  private session: PhoneSession | null = null;
  /**
   * The product the last successful phone save produced, kept until the desktop reads it.
   *
   * 🔴 IT SURVIVES `forget()`, deliberately. The session ends the instant a save succeeds — that
   * is the replay guarantee — so if this were cleared with it, the desktop's next poll would see
   * a closed session with no idea whether it closed because the merchant saved or because the code
   * expired. Those two need different messages, so the outcome outlives the session.
   */
  private lastSaved: { readonly id: string; readonly action: PhoneSessionAction } | null = null;
  /**
   * The photo this session has uploaded but not yet saved. Slice I1.
   *
   * 🔴 MEMORY, BOUND TO THE SESSION, AND CLEARED BY `forget()` — which every end path already runs
   * (save, cancel, expiry, navigation, app quit, second client, malformed budget). So there is no
   * end state in which staged bytes outlive their session, and no durable draft that could be
   * orphaned by a merchant simply walking away. A second upload REPLACES this rather than
   * accumulating.
   */
  private stagedPhoto: StagedPhonePhoto | null = null;
  /** DEC-35z16: the open invoice batch of the live session, if it is one. */
  private batch: { readonly id: string; finished: boolean } | null = null;
  /** DEC-35z16: how the last invoice batch ended, kept until the desktop reads it (once). */
  private lastBatch: { readonly count: number; readonly finished: boolean } | null = null;

  constructor(private readonly deps: PhoneSessionBridgeDeps = {}) {}

  private get now(): () => number {
    return this.deps.now ?? (() => Date.now());
  }

  async start(spec: PhoneSessionSpec): Promise<PhoneSessionDto> {
    // Replace, never accumulate. See the header.
    await this.cancel();

    const interfaces = (this.deps.interfaces ?? networkInterfaces)() as NetworkInterfaceMap;
    const selection = this.deps.trialLoopback
      ? { kind: "single" as const, chosen: { interfaceName: "synthetic runner loopback", address: "127.0.0.1", rank: 0, note: "test only" } }
      : selectLanAddress(interfaces);
    if (selection.kind === "none") {
      // 🔴 NO LOOPBACK FALLBACK. A QR pointing at 127.0.0.1 resolves, on the phone, to the phone —
      // a blank page with nothing to explain it. Refusing with a sentence the merchant can act on
      // is the correct outcome of "this machine is not on a network".
      throw new DomainError("NOT_AVAILABLE", selection.reason);
    }

    const randomToken =
      this.deps.randomToken ?? (() => randomBytes(PHONE_SESSION_TOKEN_BYTES).toString("hex"));
    const session = createSession(spec, this.now(), randomToken);

    // DEC-35z16 (PILOT): an invoice batch takes its own path BEFORE any product form is read, so the
    // product path below is untouched line for line.
    if (spec.action === "INVOICE_BATCH") return this.startInvoiceBatch(session, selection);

    // 🔴 THE FORM DATA IS READ ONCE, HERE, BEFORE THE SOCKET OPENS — and `servedMaster` is kept so
    // a later save can be diffed against WHAT THE PHONE WAS SHOWN rather than against storage as
    // it stands at save time. Diffing against current storage would revert any field changed at
    // the till while the phone was open, which is the exact failure the desktop's own patch
    // builder documents.
    const service = this.deps.service;
    // DEC-35z17: a COMPANION is a NEW_PRODUCT session for the product half — the SAME save path, the same
    // spec shape — whose form is read when the phone CHOOSES «إضافة صنف», not before (nothing is shown
    // to a phone that has not chosen). For every other session `productSpec` IS `spec`.
    const companion = spec.action === "COMPANION";
    const productSpec: PhoneSessionSpec = companion ? { action: "NEW_PRODUCT", productId: null, operatorId: spec.operatorId } : spec;
    let form: PhoneFormData | null = null;
    let servedMaster: MasterForm | null = null;
    if (service && !companion) {
      form = service.phoneSessionForm(spec);
      servedMaster = form.master;
    }
    const staging = this.deps.invoiceStaging;

    const running = await startPhoneSessionServer({
      session,
      host: selection.chosen.address,
      port: this.deps.port,
      renderPage: (view) => {
        // DEC-35z17: the landing page until the phone chooses; the invoice page once it chose invoices.
        if (companion && view.action === "COMPANION") return renderPhoneLandingPage();
        if (companion && view.action === "INVOICE_BATCH" && staging && this.batch) {
          return renderPhoneInvoicePage({ items: staging.items(this.batch.id), maxPerBatch: PHONE_INVOICE_MAX_PER_BATCH });
        }
        if (!form) {
          // Pairing without a service: there is no form to render and no save to perform. Honest
          // rather than a half-page with dead inputs.
          return PAIRED_WITHOUT_FORM_HTML;
        }
        return renderPhoneFormPage(form);
      },
      // 🔴 ONE CLOSURE, BOUND TO THIS SESSION'S SPEC. The product id and the action come from
      // `spec`; nothing a request contains can change either, because neither is a parameter the
      // body can reach.
      ...(service
        ? {
            save: (body: Buffer): PhoneSaveOutcome => {
              try {
                const submission = parsePhoneSubmission(body);
                // 🔴 THE STAGED PHOTO JOINS THE SAVE HERE, and the service commits both in ONE
                // transaction. No staged photo means the product's existing photo is untouched —
                // absent is not null, for media as much as for text.
                const row = service.savePhoneProduct(productSpec, submission, servedMaster, this.stagedPhoto);
                this.lastSaved = { id: row.id, action: productSpec.action };
                return { ok: true };
              } catch (err) {
                if (err instanceof DomainError) {
                  return { ok: false, code: err.code, message: err.message };
                }
                this.deps.logger?.error("phone-save-internal", { error: err });
                return { ok: false, code: "INTERNAL", message: "تعذّر الحفظ. حاول مرة أخرى." };
              }
            },
            ...(this.deps.normalizePhoto
              ? {
                  stagePhoto: (body: Buffer) => {
                    try {
                      // F decides what a valid photo is. Everything — the magic-byte sniff, the
                      // decode-result check, the orientation fix, the resize and the caps — is
                      // its code, not a copy of it.
                      const photo = this.deps.normalizePhoto!(body);
                      this.stagedPhoto = {
                        bytes: photo.bytes,
                        mime: photo.mime,
                        widthPx: photo.widthPx,
                        heightPx: photo.heightPx,
                      };
                      // 🔴 THE ANSWER CARRIES NO BYTES, NO PATH AND NO FILENAME — only what the
                      // form needs to say "a photo is ready".
                      return {
                        ok: true as const,
                        data: {
                          staged: true,
                          mime: photo.mime,
                          widthPx: photo.widthPx,
                          heightPx: photo.heightPx,
                          byteSize: photo.bytes.length,
                        },
                      };
                    } catch (err) {
                      if (err instanceof DomainError) {
                        // 🔴 THE SESSION AND THE DRAFT SURVIVE. A refused photo costs the photo,
                        // never the form the merchant has been filling in.
                        //
                        // 🔴 AND IT IS SAID IN THE PAGE'S OWN LANGUAGE. `err.message` is English —
                        // `photoNormalize.ts` writes it for logs and for the desktop — and this
                        // page is Arabic, so forwarding it verbatim showed a shop
                        // "Choose a JPEG or PNG image (an iPhone HEIC photo…)" on an Arabic phone.
                        // The CODE is unchanged, because the form's behaviour is keyed on it.
                        return {
                          ok: false as const,
                          code: err.code,
                          message: phonePhotoRefusalText(err.reason),
                        };
                      }
                      this.deps.logger?.error("phone-photo-internal", { error: err });
                      return { ok: false as const, code: "INTERNAL", message: "تعذّرت معالجة الصورة." };
                    }
                  },
                }
              : {}),
            ...(this.deps.decodeBarcode
              ? {
                  scanBarcode: async (body: Buffer) => {
                    try {
                      const scan = await this.deps.decodeBarcode!(body);
                      // 🔴 A MISS IS A RESULT, NOT A FAILURE. Roughly one difficult real photo in
                      // three will not decode, so `found: false` is an ordinary 200 the form shows
                      // as "type it in" — refusing it would read to the merchant as a fault.
                      //
                      // 🔴 AND NOTHING IS PERSISTED. The value goes back as draft text and reaches
                      // storage only through the normal Save, where `domain/barcode.ts`
                      // canonicalizes it exactly as a typed one.
                      return scan.found
                        ? { ok: true as const, data: { found: true, value: scan.value, format: scan.format } }
                        : { ok: true as const, data: { found: false } };
                    } catch (err) {
                      this.deps.logger?.error("phone-barcode-internal", { error: err });
                      return { ok: false as const, code: "INTERNAL", message: "تعذّرت قراءة الباركود." };
                    }
                  },
                }
              : {}),
          }
        : {}),
      // DEC-35z17: the companion's invoice half, and its one choice. The server gates every route by the
      // LOCKED purpose, so a product-locked companion never reaches these and vice versa.
      ...(companion && staging
        ? {
            ...this.invoiceCallbacks(staging, () => this.batch),
            choosePurpose: (purpose: "NEW_PRODUCT" | "INVOICE_BATCH") => {
              if (purpose === "NEW_PRODUCT") {
                if (!service) return { ok: false as const, code: "NOT_AVAILABLE", message: "إدخال الأصناف غير متاح على هذا الصندوق." };
                try {
                  form = service.phoneSessionForm(productSpec);
                  servedMaster = form.master;
                } catch (err) {
                  if (err instanceof DomainError) return { ok: false as const, code: err.code, message: "تعذّر فتح نموذج الصنف. اطلب رمزاً جديداً من الكمبيوتر." };
                  throw err;
                }
                return { ok: true as const, data: { purpose } };
              }
              this.batch = { id: staging.openBatch(), finished: false };
              return { ok: true as const, data: { purpose } };
            },
          }
        : {}),
      now: this.now,
      logger: this.deps.logger,
      onEnded: (reason) => this.forget(reason),
    });

    // 🔴 THE URL IS BUILT AFTER `listen`, because the port is only real once the OS has assigned
    // it. Encoding a QR from the REQUESTED port would silently produce `:0` in production.
    const url = this.deps.trialLoopback
      ? sessionUrl("192.0.2.1", running.port, session.token).replace("192.0.2.1", "127.0.0.1")
      : sessionUrl(running.host, running.port, session.token);
    const renderQr = this.deps.renderQr ?? renderSessionQrSvg;

    let qrSvg: string;
    try {
      qrSvg = await renderQr(url);
    } catch (err) {
      // A session whose QR could not be drawn is unusable and must not be left listening.
      await running.stop("cancelled");
      throw err;
    }

    this.running = running;
    this.session = session;

    return {
      action: session.action,
      host: running.host,
      port: running.port,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      qrSvg,
      addressAmbiguous: selection.kind === "ambiguous",
      addressCandidates:
        selection.kind === "ambiguous"
          ? selection.candidates.map((c) => ({
              interfaceName: c.interfaceName,
              address: c.address,
              note: c.note,
            }))
          : [],
    };
  }

  /**
   * DEC-35z16 (owner, PILOT): one phone session → several supplier-invoice photos → «إنهاء» → the till's
   * review queue. Photos are staged ON DISK (`PhoneInvoiceStaging`) the moment they arrive; the phone
   * is told «استُلمت» only after the write. Nothing here creates a product or touches the ledger.
   *
   * The QR / DTO tail repeats the product path's few lines on purpose: that path stays byte-for-byte
   * as it was, and this one can be removed in one place if the pilot is not accepted.
   */
  private async startInvoiceBatch(
    session: PhoneSession,
    selection: Exclude<ReturnType<typeof selectLanAddress>, { kind: "none" }>,
  ): Promise<PhoneSessionDto> {
    const staging = this.deps.invoiceStaging;
    if (!staging) throw new DomainError("NOT_AVAILABLE", "Supplier invoices from a phone are not available on this terminal");
    const batchId = staging.openBatch();
    const batch = { id: batchId, finished: false };
    let running: RunningPhoneSessionServer;
    try {
      running = await startPhoneSessionServer({
        session,
        host: selection.chosen.address,
        port: this.deps.port,
        renderPage: () => renderPhoneInvoicePage({ items: staging.items(batchId), maxPerBatch: PHONE_INVOICE_MAX_PER_BATCH }),
        ...this.invoiceCallbacks(staging, () => batch),
        now: this.now,
        logger: this.deps.logger,
        onEnded: (reason) => this.forget(reason),
      });
    } catch (err) {
      staging.abandon(batchId);
      throw err;
    }
    const url = this.deps.trialLoopback
      ? sessionUrl("192.0.2.1", running.port, session.token).replace("192.0.2.1", "127.0.0.1")
      : sessionUrl(running.host, running.port, session.token);
    let qrSvg: string;
    try {
      qrSvg = await (this.deps.renderQr ?? renderSessionQrSvg)(url);
    } catch (err) {
      await running.stop("cancelled");
      throw err;
    }
    this.running = running;
    this.session = session;
    this.batch = batch;
    return {
      action: session.action,
      host: running.host,
      port: running.port,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      qrSvg,
      addressAmbiguous: selection.kind === "ambiguous",
      addressCandidates:
        selection.kind === "ambiguous"
          ? selection.candidates.map((c) => ({ interfaceName: c.interfaceName, address: c.address, note: c.note }))
          : [],
    };
  }

  /** DEC-35z16/17: the three invoice routes' callbacks, shared by an INVOICE_BATCH session and a companion locked to invoices. */
  private invoiceCallbacks(staging: PhoneInvoiceStaging, getBatch: () => { readonly id: string; finished: boolean } | null) {
    const closed = { ok: false as const, code: "SESSION_CLOSED", message: "انتهت هذه الدفعة. ابدأ دفعة جديدة من الكمبيوتر." };
    return {
      receiveInvoice: (body: Buffer, captureKey: string) => {
        const batch = getBatch();
        if (!batch) return closed;
        const r = staging.add(batch.id, body, captureKey);
        return r.ok ? { ok: true as const, data: { id: r.id, count: r.count, replay: r.replay } } : r;
      },
      deleteInvoice: (invoiceId: string) => {
        const batch = getBatch();
        if (!batch) return closed;
        const r = staging.removeFromOpen(batch.id, invoiceId);
        return r.ok ? { ok: true as const, data: { id: r.id, count: r.count } } : r;
      },
      finishBatch: () => {
        const batch = getBatch();
        if (!batch) return closed;
        if (staging.items(batch.id).length === 0) {
          return { ok: false as const, code: "EMPTY", message: "لم تُرسَل أي فاتورة بعد. صوّر فاتورة أولاً." };
        }
        const count = staging.finish(batch.id);
        batch.finished = true;
        return { ok: true as const, data: { count } };
      },
    };
  }

  /** Close on the owner's explicit cancel. False when nothing was open. */
  async cancel(): Promise<boolean> {
    return this.end("cancelled");
  }

  /**
   * Close because the desktop left the product being edited.
   *
   * Separate from `cancel` only so the log and any future desktop message tell the truth about
   * which of the two happened — the approved contract names navigation as its own invalidation.
   */
  async navigatedAway(): Promise<boolean> {
    return this.end("navigated_away");
  }

  /**
   * Close because the application is quitting.
   *
   * 🔴 WIRED INTO `will-quit`, NOT LEFT TO THE PROCESS DYING. A listener that is merely killed with
   * the process leaves a socket in TIME_WAIT and, far worse, means the ONLY thing guaranteeing the
   * surface is gone is the OS. An explicit close makes "the app is shut, so the port is shut" a
   * property this code owns and a test can assert.
   */
  async appClosing(): Promise<boolean> {
    return this.end("app_closed");
  }

  private async end(reason: PhoneSessionEndReason): Promise<boolean> {
    const running = this.running;
    if (!running) return false;
    await running.stop(reason);
    this.forget(reason);
    return true;
  }

  private forget(_reason: PhoneSessionEndReason): void {
    // DEC-35z16: a batch the phone did not finish (timeout, cancel, quit, malformed budget) is KEPT as
    // `incomplete` — its photos wait in the queue; nothing is dropped. Reported to the dialog once.
    const batch = this.batch;
    if (batch && this.deps.invoiceStaging) {
      const count = batch.finished
        ? this.deps.invoiceStaging.items(batch.id).length
        : this.deps.invoiceStaging.abandon(batch.id);
      this.lastBatch = { count, finished: batch.finished };
    }
    this.batch = null;
    this.running = null;
    this.session = null;
    // 🔴 THE STAGED PHOTO DIES WITH THE SESSION, whatever ended it.
    this.stagedPhoto = null;
  }

  /** Whether a photo is staged right now. For the desktop and for assertions. */
  hasStagedPhoto(): boolean {
    return this.stagedPhoto !== null;
  }

  /**
   * What the desktop's dialog polls. Slice H2.
   *
   * 🔴 IT CARRIES NO TOKEN, and `savedProductId` is consumed once: reading it clears it, so a
   * success is reported to the dialog exactly once and a later poll cannot re-announce a save the
   * owner already saw.
   */
  status(): PhoneSessionState {
    const session = this.session;
    const saved = this.lastSaved;
    const lastBatch = this.lastBatch;
    if (lastBatch) {
      // DEC-35z16: the batch's end is reported exactly once, like a product save.
      this.lastBatch = null;
      return {
        state: lastBatch.finished ? "batch_ready" : "closed",
        savedProductId: null,
        action: "INVOICE_BATCH",
        expiresAt: null,
        claimed: false,
        invoiceCount: lastBatch.count,
      };
    }
    if (session && this.batch && this.deps.invoiceStaging && isLive(session, this.now())) {
      return {
        state: session.boundClient === null ? "waiting" : "claimed",
        savedProductId: null,
        action: effectiveAction(session) ?? "COMPANION",
        expiresAt: new Date(session.expiresAtMs).toISOString(),
        claimed: session.boundClient !== null,
        invoiceCount: this.deps.invoiceStaging.items(this.batch.id).length,
      };
    }
    if (saved) {
      this.lastSaved = null;
      return { state: "saved", savedProductId: saved.id, action: saved.action, expiresAt: null, claimed: false };
    }
    if (!session || !this.running) {
      return { state: "closed", savedProductId: null, action: null, expiresAt: null, claimed: false };
    }
    if (!isLive(session, this.now())) {
      return { state: "closed", savedProductId: null, action: null, expiresAt: null, claimed: false };
    }
    return {
      state: session.boundClient === null ? "waiting" : "claimed",
      savedProductId: null,
      action: effectiveAction(session) ?? "COMPANION",
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      claimed: session.boundClient !== null,
    };
  }

  /** Whether a surface is open right now. For the desktop and for assertions. */
  isOpen(): boolean {
    return this.running !== null;
  }

  /** The bound port, or null. Tests reach the real listener through this. */
  openPort(): number | null {
    return this.running?.port ?? null;
  }

  /** The bound host, or null. */
  openHost(): string | null {
    return this.running?.host ?? null;
  }
}
