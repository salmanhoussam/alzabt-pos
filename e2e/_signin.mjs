/**
 * Signing in to the INSTALLED app, after migration 8 made mandatory setup part of the first login.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS. Migration 8 seeds `operators` with `must_reset_pin = 1` for both
 * accounts — on an upgraded ledger AND on a fresh one, because the seed is an unconditional
 * INSERT. So `login('cashier-01', '1111')` no longer opens a session: it returns a SETUP ticket and
 * the app shows SetupScreen. Nine E2E scripts were written against the old door and would wait for
 * `[data-testid="cart"]` until the timeout killed them.
 *
 * The unit harness clears the flag through the repository (tests/helpers/harness.ts says so in its
 * own comment). An E2E script CANNOT: it drives the real executable, the flag is on real disk, and
 * the only way past it is the screen a real operator sees. That asymmetry is the whole reason this
 * helper is a separate module rather than a copy in each script.
 *
 * 🔴 AND IT COMPLETES SETUP WITH THE SAME PIN ON PURPOSE. `completeSetup` validates only that the
 * PIN is 4–8 digits (`assertValidPin`); nothing refuses reusing the bootstrap value, and nothing
 * requires the name to change. So re-setting 1111 gets a script whose subject is invoices or
 * products through the door with its own PIN logic untouched, and every later login in that script
 * keeps working. The REAL setup flow — a different PIN, a changed name, the refusals — is proven
 * where it belongs, in operator-accounts.mjs, with a PIN that is genuinely new.
 *
 * One consequence every caller inherits: completing setup writes ONE `OPERATOR_PIN_RESET` audit
 * row per profile (one, not two, because the name is kept). A script asserting an absolute
 * audit_events total must account for it — and must name its old value rather than loosen the
 * assertion.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

/** True once the setup screen has been dealt with for this profile, per operator name. */
const settled = new Set();

/**
 * Clicks an operator, types a PIN on the keypad, and lands on the till — completing mandatory
 * setup on the way if this profile still demands it.
 *
 * Returns "setup" when it went through SetupScreen, "session" when the door opened directly, so a
 * caller that cares can assert which path it took instead of guessing.
 */
export async function signIn(page, name, pin) {
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await page.getByRole("button", { name }).click();
  for (const d of pin) await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
  await page.locator('[data-testid="login-submit"]').click();

  // Whichever arrives first decides. Waiting for the cart alone is what used to hang.
  await page.waitForSelector('[data-testid="cart"], [data-testid="setup-screen"]', { timeout: 30000 });
  if ((await page.locator('[data-testid="setup-screen"]').count()) === 0) {
    await page.waitForSelector('[data-testid="cart"]');
    return "session";
  }

  // Mandatory setup. The name field arrives prefilled with the operator's current name; it is left
  // exactly as it is, so no OPERATOR_RENAMED row is written and the login button keeps its label.
  await page.locator('[data-testid="setup-pin"]').fill(pin);
  await page.locator('[data-testid="setup-confirm"]').fill(pin);
  await page.locator('[data-testid="setup-submit"]').click();
  await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
  settled.add(name);
  return "setup";
}

/** Whether `signIn` has already carried this operator through mandatory setup in this process. */
export const wentThroughSetup = (name) => settled.has(name);
