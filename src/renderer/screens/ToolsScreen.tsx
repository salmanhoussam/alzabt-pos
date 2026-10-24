import { useEffect, useState } from "react";
import type { AppInfoDto } from "../../shared/ipcContract";
import { call, pos } from "../api";
import { useT } from "../i18n";
import { OperatorsSection } from "./OperatorsSection";

/** Operator tools: catalog import/export, backup export, and installation identity. */
export function ToolsScreen(props: {
  onImportCatalog: () => void;
  onExportCatalog: () => void;
  onExportBackup: () => void;
  /** The signed-in operator. Operator management renders for an owner only — a courtesy; the
   *  channels themselves are refused below the UI boundary (src/main/channelPolicy.ts). */
  readonly operator: { readonly id: string; readonly role?: string };
}) {
  const { t } = useT();
  const [info, setInfo] = useState<AppInfoDto | null>(null);
  useEffect(() => {
    call(pos().getAppInfo()).then(setInfo).catch(() => setInfo(null));
  }, []);

  return (
    <div className="tools">
      <section className="card">
        <h2>{t("tools.catalog")}</h2>
        <p className="muted small">{t("tools.catalogNote")}</p>
        {/* 🔴 NOT MUTED, AND THAT IS THE POINT. A merchant who reads "export" as "backup" can lose
            every hand-typed product and every photo believing they are safe. The legacy CSV is a
            price list — the sentence that says so is ordinary text, not a de-emphasised footnote. */}
        <p className="small" data-testid="catalog-not-backup">
          <span className="badge warn">{t("tools.noticeTag")}</span> {t("tools.catalogNotBackup")}
        </p>
        <div className="tool-actions">
          <button className="btn" data-testid="import-catalog" onClick={props.onImportCatalog}>
            {t("tools.importCatalog")}
          </button>
          <button className="btn" data-testid="export-catalog" onClick={props.onExportCatalog}>
            {t("tools.exportCatalog")}
          </button>
        </div>
      </section>
      <section className="card">
        <h2>{t("tools.backup")}</h2>
        <p className="muted small">{t("tools.backupNote")}</p>
        {/* What the database backup does NOT carry. Frozen invoice logos live outside the .sqlite
            file, so a database-only restore can leave a historical invoice with no branding. */}
        <p className="small" data-testid="backup-excludes">
          <span className="badge warn">{t("tools.noticeTag")}</span> {t("tools.backupExcludes")}
        </p>
        {/* The third artifact, and the only complete one. It is deliberately NOT a button: it
            cannot be done safely while the application is running (the ledger is in WAL mode), so
            the honest thing to show is the procedure's existence, not a control that would lie. */}
        <p className="muted small" data-testid="cold-copy-note">
          {t("tools.coldCopyNote")}
        </p>
        <div className="tool-actions">
          <button className="btn" data-testid="export-backup" onClick={props.onExportBackup}>
            {t("tools.exportBackup")}
          </button>
        </div>
      </section>
      {/* Owner only. The channels are owner-only regardless of whether this renders. */}
      {props.operator.role === "owner" && <OperatorsSection selfId={props.operator.id} />}
      <section className="card about" data-testid="about">
        <h2>{t("tools.about")}</h2>
        <dl className="stats">
          <dt>{t("tools.version")}</dt>
          <dd data-testid="about-version"><bdi dir="ltr">{info?.version ?? "…"}</bdi></dd>
          <dt>{t("tools.build")}</dt>
          <dd data-testid="about-build"><bdi dir="ltr">{info?.build ?? "…"}</bdi></dd>
        </dl>
      </section>
    </div>
  );
}
