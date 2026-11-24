// This is the first main-process import. It cannot precede Electron's native startup.
import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareTrialProfile, TRIAL_APP_ID, TRIAL_APP_NAME } from "./trialIsolation";
import { requireLocalTrial } from "./trialLocalGate";

try {
  // This switch limits accidental use to the disposable runner workflow. These
  // environment variables are not authentication or an operating-system sandbox.
  // SQLite pathname checks do not prevent deliberate same-user replacement.
  const runnerFlags = ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "ALZABT_SYNTHETIC_RUNNER_ONLY", "RUNNER_TEMP"] as const;
  if (runnerFlags.some((name) => process.env[name] !== undefined)) {
    if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
        process.env.ALZABT_SYNTHETIC_RUNNER_ONLY !== "1" || !process.env.RUNNER_TEMP ||
        resolve(app.getPath("appData")) !== resolve(join(process.env.RUNNER_TEMP, "alzabt-trial-appdata"))) {
      throw new Error("Trial requires the disposable synthetic runner profile");
    }
  } else {
    requireLocalTrial({ platform: process.platform, packaged: app.isPackaged, appName: app.getName(),
      executablePath: process.execPath, home: app.getPath("home"), appData: app.getPath("appData"),
      localAppData: process.env.LOCALAPPDATA ?? "", windowsDir: process.env.SystemRoot ?? "" });
  }
  const profile = prepareTrialProfile({ appData: app.getPath("appData"), env: process.env, argv: process.argv,
    packaged: app.isPackaged, appName: app.getName(), executablePath: process.execPath });
  const logs = join(profile, "logs");
  const crashes = join(profile, "crashes");
  mkdirSync(logs, { recursive: true });
  mkdirSync(crashes, { recursive: true });
  app.setName(TRIAL_APP_NAME);
  app.setAppUserModelId(TRIAL_APP_ID);
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.setPath("logs", logs);
  app.setPath("crashDumps", crashes);
  for (const [name, expected] of [["userData", profile], ["sessionData", profile], ["logs", logs], ["crashDumps", crashes]] as const) {
    if (app.getPath(name) !== expected) throw new Error(`Trial ${name} path was not selected`);
  }
} catch (err) {
  console.error("TRIAL isolation refused startup", err);
  app.exit(1);
  throw err;
}
