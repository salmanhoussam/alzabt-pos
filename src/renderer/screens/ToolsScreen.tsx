import { useEffect, useState } from "react";
import type { AppInfoDto } from "../../shared/ipcContract";
import { call, pos } from "../api";
import { useT } from "../i18n";
import { BackupRestoreSection } from "./BackupRestoreSection";
import { OperatorsSection } from "./OperatorsSection";
import { LbpRateSection } from "../lbpDisplay";

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

  // 🔴 QW-CASHIER-TOOLS (DEC-33 #4): a cashier sees no owner-only control. Every one of these channels is
  // `owner` in channelPolicy.ts and refused BEFORE its handler runs — that stays the authority; hiding
  // the buttons is the courtesy that stops a cashier meeting an English refusal box.
  const isOwner = props.operator.role === "owner";

  return (
    <div className="tools">
      {!isOwner && (
        <section className="card" data-testid="tools-owner-only">
          <p className="muted">{t("tools.ownerOnly")}</p>
        </section>
      )}
      {isOwner && (
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
      )}
      {isOwner && (
      <section className="card">
        <h2>{t("tools.backup")}</h2>
        <p className="muted small">{t("tools.backupNote")}</p>
        {/* What THIS database-only export does NOT carry: the logos live outside the .sqlite file.
            The full backup below (Track 2) carries them; the sentence points there. */}
        <p className="small" data-testid="backup-excludes">
          <span className="badge warn">{t("tools.noticeTag")}</span> {t("tools.backupExcludes")}
        </p>
        {/* The cold copy of the whole data folder: a support procedure, deliberately NOT a button
            (it cannot be done safely while the program runs). Since Track 2 it is no longer the
            only copy with the logos — the full backup is — and the sentence says so. */}
        <p className="muted small" data-testid="cold-copy-note">
          {t("tools.coldCopyNote")}
        </p>
        <div className="tool-actions">
          <button className="btn" data-testid="export-backup" onClick={props.onExportBackup}>
            {t("tools.exportBackup")}
          </button>
        </div>
      </section>
      )}
      {/* Owner only. Full backup and restore (Track 2); the three channels are refused for anyone
          else below the UI boundary — src/main/channelPolicy.ts and PosService.assertOwner. */}
      {isOwner && <BackupRestoreSection />}
      {/* Owner only. The channels are owner-only regardless of whether this renders. */}
      {isOwner && <OperatorsSection selfId={props.operator.id} />}
      {/* M5: the owner's LBP rate (display only). setLbpRate is owner-only in channelPolicy regardless. */}
      {isOwner && <LbpRateSection />}
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
