/**
 * The shop's own details, as they will be printed on future invoices.
 *
 * 🔴 TWO THINGS THIS SCREEN SAYS OUT LOUD, because getting either wrong would be a false statement
 * on a commercial document:
 *
 *   - The three official numbers are THREE FIELDS. A taxpayer number, a commercial register number
 *     and a VAT registration number are different things, and the form never implies otherwise.
 *   - Printing them does NOT make an invoice legally or tax compliant. The note under them says so
 *     in both languages, so nobody reads the feature as a compliance claim.
 *
 * 🔴 AND SAVING ONLY AFFECTS FUTURE INVOICES. Every finalized invoice carries its own frozen issuer
 * snapshot, so changing a phone number here cannot change an invoice already in a customer's hands.
 * The screen states that where the operator will read it — next to the Save button, not in a manual.
 */
import { useEffect, useState } from "react";
import type { CompanyProfileDto, SaveCompanyProfileRequest } from "../../../shared/ipcContract";
import { call, errorText, pos } from "../../api";
import { useT } from "../../i18n";

const EMPTY: SaveCompanyProfileRequest = {
  nameAr: "",
  nameEn: null,
  legalName: null,
  tagline: null,
  address: null,
  phone1: null,
  phone2: null,
  email: null,
  logoPath: null,
  taxpayerNumber: null,
  commercialRegister: null,
  vatNumber: null,
  taxEnabled: false,
  taxRatePercent: null,
  taxLabel: null,
};

function formOf(p: CompanyProfileDto): SaveCompanyProfileRequest {
  return {
    nameAr: p.nameAr,
    nameEn: p.nameEn,
    legalName: p.legalName,
    tagline: p.tagline,
    address: p.address,
    phone1: p.phone1,
    phone2: p.phone2,
    email: p.email,
    logoPath: p.logoPath,
    taxpayerNumber: p.taxpayerNumber,
    commercialRegister: p.commercialRegister,
    vatNumber: p.vatNumber,
    taxEnabled: p.taxEnabled,
    taxRatePercent: p.taxRatePercent,
    taxLabel: p.taxLabel,
  };
}

export function CompanyProfileForm({ onSaved }: { onSaved?: (p: CompanyProfileDto) => void }) {
  const { t } = useT();
  const [form, setForm] = useState<SaveCompanyProfileRequest>(EMPTY);
  const [saved, setSaved] = useState<CompanyProfileDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextNumber, setNextNumber] = useState("");

  useEffect(() => {
    call(pos().getCompanyProfile())
      .then((p) => {
        if (p) {
          setSaved(p);
          setForm(formOf(p));
          setNextNumber(String(p.nextInvoiceNumber));
        }
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof SaveCompanyProfileRequest>(key: K, value: SaveCompanyProfileRequest[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setNotice(null);
  };
  /** An optional text field: blank means "not given", never an empty string in storage. */
  const text = (key: keyof SaveCompanyProfileRequest, value: string) =>
    set(key, (value.trim() === "" ? null : value) as SaveCompanyProfileRequest[typeof key]);

  const save = async () => {
    setError(null);
    try {
      const result = await call(pos().saveCompanyProfile(form));
      setSaved(result);
      setForm(formOf(result));
      setNextNumber(String(result.nextInvoiceNumber));
      setNotice(t("inv.company.saved"));
      onSaved?.(result);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const chooseLogo = async () => {
    setError(null);
    try {
      const result = await call(pos().pickInvoiceLogo());
      if (result.status === "chosen") set("logoPath", result.logoPath);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const applyNumbering = async () => {
    setError(null);
    try {
      const parsed = Number(nextNumber.trim());
      const result = await call(pos().setNextInvoiceNumber({ nextInvoiceNumber: parsed }));
      setSaved(result);
      setNotice(t("inv.company.saved"));
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (loading) return <div className="center muted">…</div>;

  const issued = saved !== null && saved.nextInvoiceNumber > 1;

  return (
    <div className="inv-company">
      <h2>{t("inv.company.title")}</h2>

      <section className="inv-fieldset">
        <label className="field">
          <span>{t("inv.company.nameAr")}</span>
          <input value={form.nameAr} onChange={(e) => set("nameAr", e.target.value)} data-testid="company-name-ar" />
        </label>
        <label className="field">
          <span>{t("inv.company.nameEn")}</span>
          <input dir="ltr" value={form.nameEn ?? ""} onChange={(e) => text("nameEn", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("inv.company.legalName")}</span>
          <input value={form.legalName ?? ""} onChange={(e) => text("legalName", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("inv.company.tagline")}</span>
          <input value={form.tagline ?? ""} onChange={(e) => text("tagline", e.target.value)} />
        </label>
        <label className="field wide">
          <span>{t("inv.company.address")}</span>
          <input value={form.address ?? ""} onChange={(e) => text("address", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("inv.company.phone1")}</span>
          <input dir="ltr" value={form.phone1 ?? ""} onChange={(e) => text("phone1", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("inv.company.phone2")}</span>
          <input dir="ltr" value={form.phone2 ?? ""} onChange={(e) => text("phone2", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("inv.company.email")}</span>
          <input dir="ltr" value={form.email ?? ""} onChange={(e) => text("email", e.target.value)} />
        </label>
      </section>

      <section className="inv-fieldset">
        <h3>{t("inv.company.logo")}</h3>
        <div className="inv-logo-row">
          <span className="muted" dir="ltr" data-testid="company-logo-name">
            {form.logoPath ?? t("inv.company.logoNone")}
          </span>
          <button className="btn" onClick={chooseLogo} data-testid="company-logo-choose">
            {t("inv.company.logoChoose")}
          </button>
          {form.logoPath && (
            <button className="btn ghost" onClick={() => set("logoPath", null)}>
              {t("inv.company.logoRemove")}
            </button>
          )}
        </div>
      </section>

      <section className="inv-fieldset">
        <h3>{t("inv.company.ids")}</h3>
        {/* Three separate fields, three separate labels. */}
        <label className="field">
          <span>{t("inv.company.taxpayer")}</span>
          <input dir="ltr" value={form.taxpayerNumber ?? ""} onChange={(e) => text("taxpayerNumber", e.target.value)} data-testid="company-taxpayer" />
        </label>
        <label className="field">
          <span>{t("inv.company.register")}</span>
          <input dir="ltr" value={form.commercialRegister ?? ""} onChange={(e) => text("commercialRegister", e.target.value)} data-testid="company-register" />
        </label>
        <label className="field">
          <span>{t("inv.company.vat")}</span>
          <input dir="ltr" value={form.vatNumber ?? ""} onChange={(e) => text("vatNumber", e.target.value)} data-testid="company-vat" />
        </label>
        <p className="muted small" data-testid="company-ids-note">
          {t("inv.company.idsNote")}
        </p>
      </section>

      <section className="inv-fieldset">
        <h3>{t("inv.company.tax")}</h3>
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={form.taxEnabled}
            onChange={(e) => set("taxEnabled", e.target.checked)}
            data-testid="company-tax-enabled"
          />
          <span>{t("inv.company.taxEnabled")}</span>
        </label>
        {form.taxEnabled ? (
          <>
            <label className="field">
              <span>{t("inv.company.taxRate")}</span>
              <input
                dir="ltr"
                inputMode="decimal"
                value={form.taxRatePercent ?? ""}
                onChange={(e) => text("taxRatePercent", e.target.value)}
                data-testid="company-tax-rate"
              />
            </label>
            <label className="field">
              <span>{t("inv.company.taxLabel")}</span>
              <input value={form.taxLabel ?? ""} onChange={(e) => text("taxLabel", e.target.value)} />
            </label>
          </>
        ) : (
          <p className="muted small">{t("inv.company.taxOffNote")}</p>
        )}
      </section>

      <section className="inv-fieldset">
        <h3>{t("inv.company.numbering")}</h3>
        <label className="field">
          <span>{t("inv.company.nextNumber")}</span>
          <input
            dir="ltr"
            inputMode="numeric"
            value={nextNumber}
            disabled={issued}
            onChange={(e) => setNextNumber(e.target.value)}
            data-testid="company-next-number"
          />
        </label>
        {issued ? (
          <p className="muted small" data-testid="numbering-locked">
            {t("inv.company.numberingLocked")}
          </p>
        ) : (
          <button className="btn" onClick={applyNumbering} disabled={!saved}>
            {t("action.save")}
          </button>
        )}
      </section>

      {/* The header as it will print. Not a mock: the same fields, in the same order as the PDF. */}
      <section className="inv-fieldset">
        <h3>{t("inv.company.preview")}</h3>
        <div className="inv-header-preview" data-testid="company-preview">
          <strong>{form.nameAr || "—"}</strong>
          {form.nameEn && <div dir="ltr">{form.nameEn}</div>}
          {form.legalName && <div>{form.legalName}</div>}
          {form.tagline && <div className="muted">{form.tagline}</div>}
          <div className="muted small">
            {[form.address, form.phone1, form.phone2, form.email].filter(Boolean).join(" · ")}
          </div>
          <div className="muted small">
            {[
              form.taxpayerNumber && `${t("inv.company.taxpayer")}: ${form.taxpayerNumber}`,
              form.commercialRegister && `${t("inv.company.register")}: ${form.commercialRegister}`,
              form.vatNumber && `${t("inv.company.vat")}: ${form.vatNumber}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      </section>

      <div className="inv-actions">
        <button className="btn primary" onClick={save} data-testid="company-save">
          {t("action.save")}
        </button>
        {/* Where the operator will actually read it. */}
        <span className="muted small">{t("inv.company.saved")}</span>
      </div>

      {notice && <p className="notice" data-testid="company-notice">{notice}</p>}
      {error && <p className="error" data-testid="company-error">{error}</p>}
    </div>
  );
}
