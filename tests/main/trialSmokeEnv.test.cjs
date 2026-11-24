const test = require("node:test");
const assert = require("node:assert/strict");

const goodEnv = () => ({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
  ALZABT_SYNTHETIC_RUNNER_ONLY: "1", RUNNER_TEMP: "C:\\temp\\runner",
  APPDATA: "C:\\temp\\runner\\alzabt-trial-appdata", SYSTEMROOT: "C:\\Windows" });

test("local mode removes every hosted flag from the Electron child and uses the real roaming path", async () => {
  const { selectTrialAppEnvironment, RUNNER_FLAGS } = await import("../../e2e/trial-smoke-env.mjs");
  const env = { ...goodEnv(), APPDATA: "C:\\Users\\alzabt-test\\AppData\\Roaming" };
  const child = selectTrialAppEnvironment(env, "local", env.APPDATA);
  for (const flag of RUNNER_FLAGS) assert.equal(child[flag], undefined);
  assert.equal(child.APPDATA, env.APPDATA);
  assert.equal(env.GITHUB_ACTIONS, "true", "the harness environment is not mutated");
  assert.throws(() => selectTrialAppEnvironment(env, "local", "C:\\Users\\salma\\AppData\\Roaming"));
});

test("runner mode retains the complete hosted contract and rejects partial flags or a wrong profile", async () => {
  const { selectTrialAppEnvironment } = await import("../../e2e/trial-smoke-env.mjs");
  assert.equal(selectTrialAppEnvironment(goodEnv(), "runner").GITHUB_ACTIONS, "true");
  assert.throws(() => selectTrialAppEnvironment({ ...goodEnv(), RUNNER_TEMP: "" }, "runner"));
  assert.throws(() => selectTrialAppEnvironment({ ...goodEnv(), APPDATA: "C:\\Users\\salma\\AppData\\Roaming" }, "runner"));
  assert.throws(() => selectTrialAppEnvironment(goodEnv(), "unknown"));
});

test("local smoke rejects an administrator or another account even when the account name looks plausible", async () => {
  const { requireStandardLocalAccount } = await import("../../e2e/trial-smoke-env.mjs");
  const user = '"PC\\alzabt-test","S-1-5-21-1-2-3-1001"';
  const groups = '"Everyone","Well-known group","S-1-1-0","Enabled"\n"Local","Well-known group","S-1-5-113","Enabled"\n"Users","Alias","S-1-5-32-545","Enabled"\n"Medium","Label","S-1-16-8192","Enabled"';
  assert.doesNotThrow(() => requireStandardLocalAccount("PC", user, groups));
  assert.throws(() => requireStandardLocalAccount("PC", user, groups + '\n"Administrators","Alias","S-1-5-32-544","Deny only"'));
  assert.throws(() => requireStandardLocalAccount("PC", user.replace("PC\\", "DOMAIN\\"), groups));
  assert.throws(() => requireStandardLocalAccount("PC", user, groups.replace("S-1-16-8192", "S-1-16-12288")));
});
