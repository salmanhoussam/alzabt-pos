import { DomainError } from "../domain/errors";
import type { IpcResult, PosApi } from "../shared/ipcContract";
import { formatDecimal } from "../domain/money";
import { fromMoneyDto } from "../shared/dto";
import type { MoneyDto } from "../shared/ipcContract";

declare global {
  interface Window {
    readonly pos: PosApi;
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Unwraps an IpcResult or throws an ApiError carrying the main process's error code. */
export async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new ApiError(result.error.code, result.error.message);
  return result.data;
}

export const pos = (): PosApi => window.pos;

export function fmt(m: MoneyDto): string {
  return `${formatDecimal(fromMoneyDto(m))} ${m.currency}`;
}

/** 128-bit random idempotency key for one checkout attempt. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The text an operator reads when something is refused.
 *
 * An ApiError carries the main process's own message. A DomainError is one the RENDERER raised
 * itself — `parseQuantity` is the first of these, and it must explain why a typed quantity was
 * refused rather than hide behind "Unexpected error", because the whole point of refusing a
 * fraction on a whole-only unit is that the operator is told instead of being handed a rounded
 * number. Anything else really is unexpected and is never shown verbatim.
 */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof DomainError) return err.message;
  return "Unexpected error";
}
