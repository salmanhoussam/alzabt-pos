import { useEffect, useState } from "react";
import type { AppInfoDto } from "../shared/ipcContract";
import { call, pos } from "./api";

/** "Alzabt POS 0.1.1 · Build 1a2b3c4" — always visible, so field support can identify the install. */
export function BuildLine() {
  const [info, setInfo] = useState<AppInfoDto | null>(null);
  useEffect(() => {
    call(pos().getAppInfo())
      .then(setInfo)
      .catch(() => setInfo({ version: "unknown", build: "unknown" }));
  }, []);
  if (!info) return null;
  return (
    <footer className="buildline muted" data-testid="build-line">
      Alzabt POS {info.version} · Build {info.build}
    </footer>
  );
}
