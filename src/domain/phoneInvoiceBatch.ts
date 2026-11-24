/**
 * DEC-35z16 (owner, PILOT): the rules of a phone invoice batch. Pure — no I/O, no clock of its own.
 *
 * One phone session collects several SEPARATE supplier-invoice photos. Each upload is one invoice;
 * nothing here ever merges two of them. The till reviews each one on its own, through the existing
 * Photo Invoice review, and nothing reaches the ledger before that review's explicit confirmation.
 *
 * 🔴 PILOT TRANSPORT. The phone surface is plain HTTP on the shop LAN. That gives no confidentiality
 * against another device on the same network; the owner accepted it for a synthetic-data pilot only
 * (DEC-35z16) and the commercial decision stays OPEN. Nothing here pretends otherwise.
 */
import { DomainError } from "./errors";

/** At most this many invoices in one batch. A shop delivery day, not an archive import. */
export const PHONE_INVOICE_MAX_PER_BATCH = 20;
/** At most this many bytes in one batch (the per-upload cap is the phone surface's 12 MB). */
export const PHONE_INVOICE_MAX_BATCH_BYTES = 120 * 1024 * 1024;
/**
 * At most this many bytes waiting in the whole staging folder, across every unreviewed batch.
 * 🔴 THE DISK BOUND, so an 8 GB shop PC cannot be filled by invoices nobody reviews.
 */
export const PHONE_INVOICE_MAX_STAGED_BYTES = 300 * 1024 * 1024;
/** Pending invoices older than this are flagged «قديمة» in the till's queue. Never deleted silently. */
export const PHONE_INVOICE_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** One accepted upload, as the staging manifest records it. No image bytes, no OCR text. */
export interface BatchInvoice {
  /** Server-assigned: 16 random bytes, lower-case hex. The phone never chooses an id. */
  readonly id: string;
  readonly mime: "image/jpeg" | "image/png";
  readonly bytes: number;
  readonly sha256: string;
  /** The phone's per-photo retry key, so a retried upload is recognised rather than stored twice. */
  readonly captureKey: string;
  readonly receivedAtMs: number;
  /**
   * PHONE-INVOICE-ORIENTATION-01: the operator's clockwise quarter-turns (0..3) for THIS invoice, applied
   * after the photo's own EXIF orientation. Absent = 0 (manifests written before the fix).
   */
  quarterTurns?: number;
}

export type UploadDecision =
  | { readonly kind: "accept" }
  /** The same capture key again: a retry whose answer was lost. Answer with the SAME id, store nothing. */
  | { readonly kind: "replay"; readonly id: string }
  /** The same photo bytes under a different key: refused, so one invoice is not reviewed twice. */
  | { readonly kind: "duplicate"; readonly id: string }
  | { readonly kind: "limit"; readonly which: "count" | "batch_bytes" | "staged_bytes" };

/** A capture key is 16 random bytes from the phone, as 32 lower-case hex. Anything else is refused. */
export function isCaptureKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/** An invoice id has exactly the server's shape. Checked before it is ever used to name a file. */
export function isInvoiceId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/**
 * May this upload join the batch?
 *
 * Order matters: a replay is recognised BEFORE the limits, so a phone that retries its 20th photo
 * after a lost answer is told "received" rather than "full".
 */
export function decideUpload(
  items: readonly BatchInvoice[],
  upload: { readonly bytes: number; readonly sha256: string; readonly captureKey: string },
  stagedBytesElsewhere: number,
): UploadDecision {
  if (!isCaptureKey(upload.captureKey)) throw new DomainError("INVALID_INPUT", "A capture key is 32 lower-case hex characters");
  const replay = items.find((i) => i.captureKey === upload.captureKey);
  if (replay) return { kind: "replay", id: replay.id };
  const dup = items.find((i) => i.sha256 === upload.sha256);
  if (dup) return { kind: "duplicate", id: dup.id };
  if (items.length >= PHONE_INVOICE_MAX_PER_BATCH) return { kind: "limit", which: "count" };
  const batchBytes = items.reduce((s, i) => s + i.bytes, 0);
  if (batchBytes + upload.bytes > PHONE_INVOICE_MAX_BATCH_BYTES) return { kind: "limit", which: "batch_bytes" };
  if (stagedBytesElsewhere + batchBytes + upload.bytes > PHONE_INVOICE_MAX_STAGED_BYTES) return { kind: "limit", which: "staged_bytes" };
  return { kind: "accept" };
}

/** The Arabic sentence the phone shows for each refusal. Operation-specific (text-context rule). */
export const INVOICE_REFUSAL_AR: Record<"duplicate" | "count" | "batch_bytes" | "staged_bytes", string> = {
  duplicate: "هذه الصورة أُرسلت قبل قليل في هذه الدفعة — لم تُرسَل مرة ثانية.",
  count: `اكتملت الدفعة (${PHONE_INVOICE_MAX_PER_BATCH} فاتورة). اضغط «إنهاء والمتابعة على الكمبيوتر» ثم ابدأ دفعة جديدة.`,
  batch_bytes: "حجم الدفعة بلغ الحدّ. اضغط «إنهاء والمتابعة على الكمبيوتر» ثم ابدأ دفعة جديدة.",
  staged_bytes: "فواتير كثيرة بانتظار المراجعة على الكمبيوتر. راجِعها أولاً ثم أرسل المزيد.",
};
