import { useEffect, useState } from "react";
import type { AppInfoDto } from "../../shared/ipcContract";
import { call, pos } from "../api";

/** Operator tools: catalog import/export, backup export, and installation identity. */
export function ToolsScreen(props: {
  onImportCatalog: () => void;
  onExportCatalog: () => void;
  onExportBackup: () => void;
}) {
  const [info, setInfo] = useState<AppInfoDto | null>(null);
  useEffect(() => {
    call(pos().getAppInfo()).then(setInfo).catch(() => setInfo(null));
  }, []);

  return (
    <div className="tools">
      <section className="card">
        <h2>Catalog</h2>
        <p className="muted">
          Export the product list, correct prices in Excel (save as “CSV UTF-8”), then import it again. Products are
          matched by their <code>source_id</code>; unchanged rows stay unchanged.
        </p>
        <div className="tool-actions">
          <button className="btn" onClick={props.onImportCatalog}>
            Import catalog
          </button>
          <button className="btn" onClick={props.onExportCatalog}>
            Export catalog
          </button>
        </div>
      </section>
      <section className="card">
        <h2>Backup</h2>
        <p className="muted">
          A verified backup is made automatically once a day and before every database update. Export a copy to keep
          it somewhere else, e.g. on a USB drive.
        </p>
        <div className="tool-actions">
          <button className="btn" onClick={props.onExportBackup}>
            Export backup
          </button>
        </div>
      </section>
      <section className="card about" data-testid="about">
        <h2>About</h2>
        <dl className="stats">
          <dt>Version</dt>
          <dd data-testid="about-version">{info?.version ?? "…"}</dd>
          <dt>Build</dt>
          <dd data-testid="about-build">{info?.build ?? "…"}</dd>
        </dl>
      </section>
    </div>
  );
}
