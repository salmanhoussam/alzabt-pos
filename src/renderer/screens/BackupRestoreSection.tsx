import { useState } from "react";
import type {
  BackupMissingAssetDto,
  FullBackupExportResponse,
  RestorePreviewDto,
  RestoreRefusalReason,
} from "../../shared/ipcContract";
import { call, errorText, pos } from "../api";
import { useT } from "../i18n";
import { canApplyRestore } from "./restoreDecision";

const COUNT_KEYS = ["sales", "invoices", "parties", "obligations", "settlements", "receipts", "operators"] as const;

function MissingList(props: { readonly items: ReadonlyArray<BackupMissingAssetDto>; readonly testid: string }) {
  const { t } = useT();
  return (
    <ul className="small" data-testid={props.testid}>
      {props.items.map((m, i) => (
        <li key={`${m.kind}-${i}`}>
          {t(`backup.missing.${m.kind}`)} — <bdi dir="ltr">{m.name}</bdi> ({t(`backup.reason.${m.reason}`)})
        </li>
      ))}
    </ul>
  );
}

/**
 * Full backup and restore, owner only (Track 2 phase 3). Rendered by ToolsScreen for an owner;
 * all three channels are refused below the UI boundary for anyone else.
 *
 * Opening a folder only PREVIEWS it: nothing is staged until the owner confirms, and confirming
 * restarts the program, which performs the restore before it opens any data.
 */
export function BackupRestoreSection() {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<FullBackupExportResponse | null>(null);
  const [preview, setPreview] = useState<RestorePreviewDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [acceptedMissing, setAcceptedMissing] = useState(false);
  const [refusal, setRefusal] = useState<{ reason: RestoreRefusalReason; detail: string | null } | null>(null);
  const [staged, setStaged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const createBackup = () =>
    run(async () => {
      setExported(null);
      const result = await call(pos().exportFullBackup());
      if (result.status !== "cancelled") setExported(result);
    });

  const chooseBackup = () =>
    run(async () => {
      setPreview(null);
      setRefusal(null);
      setConfirmed(false);
      setAcceptedMissing(false);
      const result = await call(pos().inspectRestoreBackup());
      if (result.status === "ready") setPreview(result.preview);
      else if (result.status === "refused") setRefusal({ reason: result.reason, detail: result.detail });
    });

  const applyRestore = () =>
    run(async () => {
      if (!preview) return;
      const result = await call(
        pos().applyRestore({ manifestSha256: preview.manifestSha256, acceptMissingAssets: !preview.complete && acceptedMissing }),
      );
      if (result.status === "staged") {
        setStaged(true);
      } else {
        setPreview(null);
        setRefusal({ reason: result.reason, detail: result.detail });
      }
    });

  return (
    <>
      <section className="card" data-testid="full-backup-section">
        <h2>{t("fullBackup.title")}</h2>
        <p className="muted small">{t("fullBackup.note")}</p>
        <div className="tool-actions">
          <button className="btn" disabled={busy} onClick={() => void createBackup()} data-testid="full-backup-create">
            {t("fullBackup.create")}
          </button>
        </div>
        {exported?.status === "saved" && (
          <div data-testid="full-backup-result">
            <p>
              <strong>{t("fullBackup.savedTitle")}</strong>
            </p>
            <dl className="stats">
              <dt>{t("fullBackup.folder")}</dt>
              <dd data-testid="full-backup-folder"><bdi dir="ltr">{exported.folderName}</bdi></dd>
              <dt>{t("fullBackup.location")}</dt>
              <dd data-testid="full-backup-location"><bdi dir="ltr">{exported.location}</bdi></dd>
            </dl>
            {exported.complete ? (
              <p className="small" data-testid="full-backup-complete">{t("fullBackup.complete")}</p>
            ) : (
              <>
                <p className="small" data-testid="full-backup-incomplete">
                  <span className="badge warn">{t("tools.noticeTag")}</span> {t("fullBackup.incomplete")}
                </p>
                <MissingList items={exported.missingAssets} testid="full-backup-missing" />
              </>
            )}
            {exported.settings !== "included" && <p className="muted small">{t(`backup.settings.${exported.settings}`)}</p>}
          </div>
        )}
        {exported?.status === "failed" && (
          <p className="error" data-testid="full-backup-failed">{t(`fullBackup.failed.${exported.reason}`)}</p>
        )}
      </section>

      <section className="card" data-testid="restore-section">
        <h2>{t("restore.title")}</h2>
        <p className="small">
          <span className="badge warn">{t("tools.noticeTag")}</span> {t("restore.note")}
        </p>
        <div className="tool-actions">
          <button className="btn" disabled={busy || staged} onClick={() => void chooseBackup()} data-testid="restore-choose">
            {t("restore.choose")}
          </button>
        </div>
        {refusal && (
          <p className="error" data-testid="restore-refused">
            {t(`restore.refused.${refusal.reason}`)}
            {refusal.detail && (
              <>
                {" "}
                <span className="muted">({t("restore.supportCode")}: <bdi dir="ltr">{refusal.detail}</bdi>)</span>
              </>
            )}
          </p>
        )}
        {error && <p className="error" data-testid="restore-error">{error}</p>}
      </section>

      {preview && (
        <div className="overlay">
          <div className="card dialog" data-testid="restore-preview">
            <h3>{t("restore.previewTitle")}</h3>
            <dl className="stats">
              <dt>{t("restore.createdAt")}</dt>
              <dd data-testid="restore-created"><bdi dir="ltr">{preview.createdAt.replace("T", " ").slice(0, 16)} UTC</bdi></dd>
              <dt>{t("restore.appVersion")}</dt>
              <dd><bdi dir="ltr">{preview.appVersion}</bdi></dd>
              <dt>{t("restore.schema")}</dt>
              <dd data-testid="restore-schema"><bdi dir="ltr">{preview.schemaVersion}</bdi></dd>
              {COUNT_KEYS.map((k) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{t(`restore.count.${k}`)}</dt>
                  <dd data-testid={`restore-count-${k}`}><bdi dir="ltr">{preview.counts[k] ?? "—"}</bdi></dd>
                </div>
              ))}
            </dl>
            {preview.schemaVersion < preview.appSchemaVersion && <p className="muted small">{t("restore.schemaUpgrade")}</p>}
            {preview.complete ? (
              <p className="small" data-testid="restore-complete">{t("restore.complete")}</p>
            ) : (
              <>
                <p className="small" data-testid="restore-incomplete">
                  <span className="badge warn">{t("tools.noticeTag")}</span> {t("restore.incomplete")}
                </p>
                <MissingList items={preview.missingAssets} testid="restore-missing" />
                <p className="small">{t("restore.incompleteEffect")}</p>
              </>
            )}
            {preview.settings !== "included" && <p className="muted small">{t(`backup.settings.${preview.settings}`)}</p>}
            <p className="small">{t("restore.note")}</p>

            <label className="small">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="restore-confirm" />
              {t("restore.confirm")}
            </label>
            {!preview.complete && (
              <label className="small">
                <input
                  type="checkbox"
                  checked={acceptedMissing}
                  onChange={(e) => setAcceptedMissing(e.target.checked)}
                  data-testid="restore-accept-missing"
                />
                {t("restore.confirmIncomplete")}
              </label>
            )}

            {staged ? (
              <p className="small" data-testid="restore-staged">{t("restore.staged")}</p>
            ) : (
              <div className="inv-actions">
                <button
                  className="btn primary"
                  disabled={busy || !canApplyRestore(preview, confirmed, acceptedMissing)}
                  onClick={() => void applyRestore()}
                  data-testid="restore-apply"
                >
                  {t("restore.apply")}
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => setPreview(null)} data-testid="restore-cancel">
                  {t("restore.cancel")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
