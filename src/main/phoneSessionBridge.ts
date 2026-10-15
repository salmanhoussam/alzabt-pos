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
import {
  PHONE_SESSION_TOKEN_BYTES,
  createSession,
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
import { parsePhoneSubmission } from "../domain/phoneSubmission";
import type { MasterForm } from "../shared/productMasterForm";
import type { PhoneFormData, PosService } from "../application/posService";
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
<title>الزبط</title>
<style>body{margin:0;padding:24px;font-family:system-ui,sans-serif;line-height:1.6}</style>
<p>تم ربط الهاتف بالصندوق، لكن إدخال الأصناف غير متاح على هذا الصندوق.</p>
</html>
`;

export interface PhoneSessionBridgeDeps {
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

  constructor(private readonly deps: PhoneSessionBridgeDeps = {}) {}

  private get now(): () => number {
    return this.deps.now ?? (() => Date.now());
  }

  async start(spec: PhoneSessionSpec): Promise<PhoneSessionDto> {
    // Replace, never accumulate. See the header.
    await this.cancel();

    const interfaces = (this.deps.interfaces ?? networkInterfaces)() as NetworkInterfaceMap;
    const selection = selectLanAddress(interfaces);
    if (selection.kind === "none") {
      // 🔴 NO LOOPBACK FALLBACK. A QR pointing at 127.0.0.1 resolves, on the phone, to the phone —
      // a blank page with nothing to explain it. Refusing with a sentence the merchant can act on
      // is the correct outcome of "this machine is not on a network".
      throw new DomainError("NOT_AVAILABLE", selection.reason);
    }

    const randomToken =
      this.deps.randomToken ?? (() => randomBytes(PHONE_SESSION_TOKEN_BYTES).toString("hex"));
    const session = createSession(spec, this.now(), randomToken);

    // 🔴 THE FORM DATA IS READ ONCE, HERE, BEFORE THE SOCKET OPENS — and `servedMaster` is kept so
    // a later save can be diffed against WHAT THE PHONE WAS SHOWN rather than against storage as
    // it stands at save time. Diffing against current storage would revert any field changed at
    // the till while the phone was open, which is the exact failure the desktop's own patch
    // builder documents.
    const service = this.deps.service;
    let form: PhoneFormData | null = null;
    let servedMaster: MasterForm | null = null;
    if (service) {
      form = service.phoneSessionForm(spec);
      servedMaster = form.master;
    }

    const running = await startPhoneSessionServer({
      session,
      host: selection.chosen.address,
      port: this.deps.port,
      renderPage: () => {
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
                const row = service.savePhoneProduct(spec, submission, servedMaster);
                this.lastSaved = { id: row.id, action: spec.action };
                return { ok: true };
              } catch (err) {
                if (err instanceof DomainError) {
                  return { ok: false, code: err.code, message: err.message };
                }
                this.deps.logger?.error("phone-save-internal", { error: err });
                return { ok: false, code: "INTERNAL", message: "تعذّر الحفظ. حاول مرة أخرى." };
              }
            },
          }
        : {}),
      now: this.now,
      logger: this.deps.logger,
      onEnded: (reason) => this.forget(reason),
    });

    // 🔴 THE URL IS BUILT AFTER `listen`, because the port is only real once the OS has assigned
    // it. Encoding a QR from the REQUESTED port would silently produce `:0` in production.
    const url = sessionUrl(running.host, running.port, session.token);
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
    this.running = null;
    this.session = null;
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
      action: session.action,
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
