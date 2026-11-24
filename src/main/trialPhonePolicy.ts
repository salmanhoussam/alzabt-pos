/** Invoice-only adapter; normal IPC validation still checks every other field. */
export function trialInvoiceSessionPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const request = payload as Record<string, unknown>;
  if (request.action !== "COMPANION" && request.action !== "INVOICE_BATCH") return null;
  return { ...request, action: "INVOICE_BATCH" };
}
