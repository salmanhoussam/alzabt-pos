/**
 * The shop's own identity, and the invoice number sequence that belongs to it.
 *
 * 🔴 ONE ROW, PINNED BY A CHECK. `company_profile.id` may only be 'company', so a second identity
 * cannot exist even if a caller tried to insert one.
 *
 * 🔴 NO TRANSACTION OF ITS OWN, by the same reasoning as `AuditRepository` and
 * `CatalogRepository.setActive`: `allocateInvoiceNumber` must run inside the caller's
 * `BEGIN IMMEDIATE` — the same transaction that marks the invoice final — or the number could be
 * consumed by a finalization that then rolls back. A narrower transaction here would only add a
 * savepoint and prove nothing.
 *
 * 🔴 THE NUMBER IS INDEPENDENT OF `sales.receipt_number`. A shop continuing a paper invoice book
 * starts at 61 while its till receipts are at 4,312; the two sequences never meet.
 */
import type { Db } from "./db";

/** The profile as stored. Every optional field is NULL when not given, never "". */
export interface CompanyProfileRow {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string | null;
  readonly legal_name: string | null;
  readonly tagline: string | null;
  readonly address: string | null;
  readonly phone1: string | null;
  readonly phone2: string | null;
  readonly email: string | null;
  readonly logo_path: string | null;
  readonly taxpayer_number: string | null;
  readonly commercial_register: string | null;
  readonly vat_number: string | null;
  readonly tax_enabled: bigint;
  readonly tax_rate_bp: bigint;
  readonly tax_label: string | null;
  readonly next_invoice_number: bigint;
  readonly created_at: string;
  readonly updated_at: string;
}

/** What a caller may write. Identity (`id`) and the timestamps are not among the fields. */
export interface CompanyProfileInput {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly legalName: string | null;
  readonly tagline: string | null;
  readonly address: string | null;
  readonly phone1: string | null;
  readonly phone2: string | null;
  readonly email: string | null;
  readonly logoPath: string | null;
  /**
   * Three DIFFERENT official identifiers, deliberately three fields. A taxpayer number, a
   * commercial register number and a VAT registration number are not the same thing, and printing
   * one under another's label would be a false statement on a commercial document.
   */
  readonly taxpayerNumber: string | null;
  readonly commercialRegister: string | null;
  readonly vatNumber: string | null;
  readonly taxEnabled: boolean;
  readonly taxRateBp: number;
  readonly taxLabel: string | null;
}

const COLUMNS = `id, name_ar, name_en, legal_name, tagline, address, phone1, phone2, email, logo_path,
                 taxpayer_number, commercial_register, vat_number, tax_enabled, tax_rate_bp, tax_label,
                 next_invoice_number, created_at, updated_at`;

export class CompanyProfileRepository {
  constructor(private readonly db: Db) {}

  /** The profile, or null when the shop has not filled it in yet. */
  find(): CompanyProfileRow | null {
    return (
      (this.db
        .prepare(`SELECT ${COLUMNS} FROM company_profile WHERE id = 'company'`)
        .get() as CompanyProfileRow | undefined) ?? null
    );
  }

  /**
   * Creates or replaces the profile. `next_invoice_number` is NOT written here — it is the
   * sequence's own state and moves only through `allocateInvoiceNumber` or the explicit
   * `setNextInvoiceNumber`, so saving a new phone number can never rewind the numbering.
   */
  save(input: CompanyProfileInput, now: Date, startNumber: number): CompanyProfileRow {
    const stamp = now.toISOString();
    const existing = this.find();
    const bind = {
      nameAr: input.nameAr,
      nameEn: input.nameEn,
      legalName: input.legalName,
      tagline: input.tagline,
      address: input.address,
      phone1: input.phone1,
      phone2: input.phone2,
      email: input.email,
      logoPath: input.logoPath,
      taxpayerNumber: input.taxpayerNumber,
      commercialRegister: input.commercialRegister,
      vatNumber: input.vatNumber,
      taxEnabled: input.taxEnabled ? 1 : 0,
      taxRateBp: input.taxRateBp,
      taxLabel: input.taxLabel,
      now: stamp,
    };

    if (existing) {
      this.db
        .prepare(
          `UPDATE company_profile
              SET name_ar = @nameAr, name_en = @nameEn, legal_name = @legalName, tagline = @tagline,
                  address = @address, phone1 = @phone1, phone2 = @phone2, email = @email,
                  logo_path = @logoPath, taxpayer_number = @taxpayerNumber,
                  commercial_register = @commercialRegister, vat_number = @vatNumber,
                  tax_enabled = @taxEnabled, tax_rate_bp = @taxRateBp, tax_label = @taxLabel,
                  updated_at = @now
            WHERE id = 'company'`,
        )
        .run(bind);
    } else {
      this.db
        .prepare(
          `INSERT INTO company_profile (${COLUMNS})
           VALUES ('company', @nameAr, @nameEn, @legalName, @tagline, @address, @phone1, @phone2,
                   @email, @logoPath, @taxpayerNumber, @commercialRegister, @vatNumber, @taxEnabled,
                   @taxRateBp, @taxLabel, @startNumber, @now, @now)`,
        )
        .run({ ...bind, startNumber });
    }
    const row = this.find();
    if (!row) throw new Error("company_profile: the profile could not be read back");
    return row;
  }

  /**
   * Moves the sequence's starting point. The SERVICE refuses this once any invoice has been
   * finalized; the repository only performs it, because "is it still safe to renumber" is a
   * business rule, not SQL.
   */
  setNextInvoiceNumber(next: number, now: Date): CompanyProfileRow {
    this.db
      .prepare("UPDATE company_profile SET next_invoice_number = ?, updated_at = ? WHERE id = 'company'")
      .run(next, now.toISOString());
    const row = this.find();
    if (!row) throw new Error("company_profile: the profile could not be read back");
    return row;
  }

  /**
   * Hands out the next invoice number and advances the sequence, both inside the CALLER's
   * transaction. Read-then-write is safe here for the same reason `SaleRepository`'s receipt
   * numbers are: one writer, one PC, `BEGIN IMMEDIATE` — which takes the write lock before the
   * read, so no second finalization can interleave between the read and the update.
   */
  allocateInvoiceNumber(now: Date): number {
    const row = this.db
      .prepare("SELECT next_invoice_number AS n FROM company_profile WHERE id = 'company'")
      .get() as { n: bigint } | undefined;
    if (!row) throw new Error("company_profile: no profile — an invoice cannot be numbered");
    const allocated = Number(row.n);
    this.db
      .prepare(
        "UPDATE company_profile SET next_invoice_number = ?, updated_at = ? WHERE id = 'company'",
      )
      .run(allocated + 1, now.toISOString());
    return allocated;
  }
}
