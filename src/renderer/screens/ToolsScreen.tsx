import { useEffect, useState } from "react";
import type { AppInfoDto } from "../../shared/ipcContract";
import { call, pos } from "../api";
import { useT } from "../i18n";

/** Operator tools: catalog import/export, backup export, and installation identity. */
export function ToolsScreen(props: {
  onImportCatalog: () => void;
  onExportCatalog: () => void;
  onExportBackup: () => void;
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
        <div className="tool-actions">
          <button className="btn" data-testid="export-backup" onClick={props.onExportBackup}>
            {t("tools.exportBackup")}
          </button>
        </div>
      </section>
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
