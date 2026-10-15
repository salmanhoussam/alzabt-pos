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
  sessionUrl,
  type PhoneSession,
  type PhoneSessionEndReason,
  type PhoneSessionSpec,
} from "../domain/phoneSession";
import { selectLanAddress, type NetworkInterfaceMap } from "./lanAddress";
import { renderSessionQrSvg } from "./phoneSessionQr";
import {
  renderPairedPage,
  startPhoneSessionServer,
  type RunningPhoneSessionServer,
} from "./phoneSessionServer";
import type { Logger } from "./logger";
import type { PhoneSessionDto } from "../shared/ipcContract";

export interface PhoneSessionBridgeDeps {
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

    const running = await startPhoneSessionServer({
      session,
      host: selection.chosen.address,
      port: this.deps.port,
      renderPage: renderPairedPage,
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
