/**
 * INV-CUSTOMER-PREFILL — what linking a customer account to a DRAFT invoice writes into the
 * invoice's printed customer fields.
 *
 * 🔴 ONLY EMPTY FIELDS, AND ONLY FROM THE ACCOUNT. The printed name, phone and address are the
 * invoice's own editable snapshot; the account is the identity. Linking an account fills a field
 * the operator left EMPTY (judged by what is typed in it now, not by the stored row, because a
 * value can be typed and not yet blurred) and never replaces anything the operator wrote. A field
 * the account has no value for is left out entirely, so the service keeps the row's value.
 *
 * 🔴 AND IT TRAVELS WITH THE LINK, IN ONE WRITE. The name used to be put into the input only, so it
 * reached the row on the next blur or save, and phone and address were never filled at all (field
 * request 2026-11-01: invoices #1/#2 linked to an account with phone and address stored both NULL).
 * The caller sends these keys in the same `updateInvoiceHeader` patch as `customerPartyId`, so the
 * link and its contact snapshot are stored together or not at all. An issued invoice refuses the
 * write as before (`INVOICE_NOT_DRAFT`).
 */
import type { InvoiceHeaderPatch } from "../../../shared/ipcContract";

/** What an account offers: exactly the contact fields of `CustomerDto`. */
export interface AccountContact {
  readonly displayName: string;
  readonly phone: string | null;
  readonly address: string | null;
}

/**
 * What each printed field holds RIGHT NOW in the sheet, or `undefined` when the field is not
 * rendered (then it is never filled — this function cannot know what it would overwrite).
 */
export interface TypedContact {
  readonly customerName: string | undefined;
  readonly customerPhone: string | undefined;
  readonly customerAddress: string | undefined;
}

export type ContactPrefill = Pick<InvoiceHeaderPatch, "customerName" | "customerPhone" | "customerAddress">;

const blank = (v: string | null | undefined): boolean => v === null || v === undefined || v.trim() === "";

export function accountPrefill(account: AccountContact, typed: TypedContact): ContactPrefill {
  const out: { customerName?: string; customerPhone?: string; customerAddress?: string } = {};
  const fill = (key: keyof TypedContact, value: string | null) => {
    const current = typed[key];
    if (current === undefined || !blank(current) || blank(value)) return;
    out[key] = value as string;
  };
  fill("customerName", account.displayName);
  fill("customerPhone", account.phone);
  fill("customerAddress", account.address);
  return out;
}
