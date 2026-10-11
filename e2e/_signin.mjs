/**
 * Signing in to the INSTALLED app: mandatory setup, the owner-first ceremony, and the 6–8 digit rule.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS. Migration 8 seeds `operators` with `must_reset_pin = 1` for both
 * accounts — on an upgraded ledger AND on a fresh one, because the seed is an unconditional
 * INSERT. So `login('cashier-01', '1111')` does not open a session: it returns a SETUP ticket and
 * the app shows SetupScreen. The unit harness clears that flag through the repository; an E2E
 * script cannot, because it drives the real executable and the flag is on real disk.
 *
 * 🔴 AND THE PIN IT CHOOSES IS NOT 1111 ANY MORE. A newly chosen PIN must be 6–8 digits
 * (`domain/pinRule.ts`), so the old trick of re-setting the same bootstrap value is now refused by
 * the service. Every script therefore ends up on `E2E_PIN` after setup, and anything that signs in
 * again has to know that.
 *
 * 🔴 WHICH IT DISCOVERS BY TRYING, NOT BY REMEMBERING. An earlier design kept a Set of operators
 * already carried through setup — and that was wrong for `invoice-logo.mjs`, which creates a SECOND
 * profile part way through: the same operator NAME is past setup in one profile and untouched in
 * the other, so remembering by name would type the wrong PIN at a fresh door. Attempting the
 * bootstrap credential first and falling back on refusal is profile-agnostic and cannot get this
 * wrong. It costs one failed attempt, and the lockout allows five before it bites, with a success
 * resetting the count.
 *
 * One consequence every caller inherits: completing setup writes ONE `OPERATOR_PIN_RESET` audit row
 * per profile (one, not two, because the name is kept). A script asserting an absolute
 * audit_events total must account for it — and must name its old value rather than loosen.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The disposable PIN every E2E profile ends up on. Six digits, so it satisfies the real rule, and
 * deliberately not a bootstrap value — `1111` is now invalid as a NEW PIN and the product refuses
 * it, which is the point of rule 3.
 */
export const E2E_PIN = "246813";

const keypad = async (page, pin) => {
  for (const d of pin) await page.locator(".keypad").getByRole("button", { name: d, exact: true }).click();
  await page.locator('[data-testid="login-submit"]').click();
};

/** Fills the mandatory-setup form with E2E_PIN, keeping the operator's existing name. */
async function completeSetup(page) {
  await page.locator('[data-testid="setup-pin"]').fill(E2E_PIN);
  await page.locator('[data-testid="setup-confirm"]').fill(E2E_PIN);
  await page.locator('[data-testid="setup-submit"]').click();
  try {
    await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
  } catch (err) {
    // 🔴 ON TIMEOUT, SAY WHY. The first Windows gate this helper ever ran failed exactly here and
    // the log said only "waiting for [data-testid=cart]" — true, useless, and worth a whole gate
    // cycle to diagnose. The cause was a renderer defect (a live session losing to a spent setup
    // ticket, see screenFor in App.tsx) and any of these facts would have named it immediately.
    const diag = await page
      .evaluate(() => ({
        stillOnSetup: !!document.querySelector('[data-testid="setup-screen"]'),
        error: document.querySelector('[data-testid="setup-error"]')?.textContent ?? null,
        mismatch: !!document.querySelector('[data-testid="setup-mismatch"]'),
        pinInvalid: !!document.querySelector('[data-testid="setup-pin-invalid"]'),
        submitDisabled: document.querySelector('[data-testid="setup-submit"]')?.disabled ?? null,
        root: document.getElementById("root")?.innerHTML?.slice(0, 1500) ?? "NO ROOT",
      }))
      .catch((e) => ({ evaluateFailed: String(e) }));
    console.log("SETUP STUCK:", JSON.stringify(diag));
    await page.screenshot({ path: "e2e-output/setup-stuck.png" }).catch(() => {});
    throw err;
  }
}

/**
 * Clicks an operator and lands on the till, whatever state this profile is in:
 * a bootstrap account needing setup, or one already carried through it by an earlier launch.
 *
 * Returns "setup" when it went through SetupScreen, "session" when the bootstrap credential opened
 * the door directly, and "resumed" when the profile was already past setup — so a caller that
 * cares can assert which path it took instead of guessing.
 */
export async function signIn(page, name, bootstrapPin) {
  await page.waitForSelector('[data-testid="select-cashier"]', { timeout: 30000 });
  await page.getByRole("button", { name }).click();
  await keypad(page, bootstrapPin);

  // Whichever arrives first decides. Waiting for the cart alone is what used to hang.
  await page.waitForSelector('[data-testid="cart"], [data-testid="setup-screen"], .login .error', {
    timeout: 30000,
  });
  if (await page.locator('[data-testid="setup-screen"]').count()) {
    await completeSetup(page);
    return "setup";
  }
  if (await page.locator('[data-testid="cart"]').count()) return "session";

  // Refused: this profile is already past setup, so the live credential is E2E_PIN. The PIN field
  // clears itself on a refusal, so the operator stays selected and only the digits are retyped.
  await keypad(page, E2E_PIN);
  await page.waitForSelector('[data-testid="cart"]', { timeout: 30000 });
  return "resumed";
}
