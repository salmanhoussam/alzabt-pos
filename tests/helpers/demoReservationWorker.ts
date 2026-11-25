/** Synthetic-only test worker; no ledger is opened. */
import { DemoProfileError, reserveSyntheticDemoProfile } from "../../src/main/demoProfile";
try {
  reserveSyntheticDemoProfile(process.argv[2] ?? "");
  process.stdout.write("OK");
} catch (err) {
  process.stdout.write(err instanceof DemoProfileError && err.reason === "limit" ? "LIMIT" : "ERROR");
}
