import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    // 🔴 THE HOOK BUDGET MUST MATCH THE TEST BUDGET, because they do the same work.
    //
    // testTimeout was deliberately raised to 30s for Windows, where creating a temp directory and
    // opening a SQLite ledger is slow. hookTimeout was left at vitest's stock 10s — so the very
    // same `tempDir() + makeHarness()` got 30 seconds inside a test and 10 inside a beforeEach.
    //
    // That inconsistency stayed invisible while the suite had 45 files, and surfaced the moment a
    // 46th was added: vitest spawns one worker per file, and three unrelated files' beforeEach
    // hooks timed out at exactly 10000ms on the Windows runner while every assertion in them was
    // untouched. Raising this weakens nothing — no assertion changes and no check is skipped; it
    // stops the instrument from holding setup to a stricter deadline than the thing it sets up.
    hookTimeout: 30000,
  },
});
