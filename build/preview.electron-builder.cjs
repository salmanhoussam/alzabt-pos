/**
 * OWNER-ONLY R5 PREVIEW installer (owner decision 2026-11-25). NOT a release, NOT for a merchant machine.
 *
 * Build: `npm run dist:preview` (this file is passed with --config; the standard package.json `build` is untouched).
 *
 * Identity: every field differs from the shop product («Alzabt POS», com.alzabt.pos) AND from the R3 trial
 * («Alzabt POS TRIAL TEST ONLY», com.alzabt.pos.trial.testonly, GUID d12ac5c3-…), so it cannot upgrade, replace or
 * share data with either:
 *   productName  «Alzabt POS R5 PREVIEW»          appId  com.alzabt.pos.r5preview.owneronly
 *   name         alzabt-pos-r5-preview             GUID   7b0f3e52-4c8a-4f61-9a3d-5e2b8c71d4a9
 *   install dir  %LOCALAPPDATA%\Programs\alzabt-pos-r5-preview (enforced by build/preview-installer.nsh)
 *   data         %LOCALAPPDATA%\Alzabt-R5-Owner-Preview (src/main/syntheticBuild.ts), only for Windows user alzabt-test
 *   auto-start   none (src/main/main.ts skips it in the preview)
 *
 * The flavor mark `alzabtFlavor: "owner-preview"` goes into the PACKAGED package.json through extraMetadata; it is what
 * src/main/syntheticBuild.ts reads. The Demo modules are INCLUDED here (the standard build excludes them).
 */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "resources", "demo", "demo-media-manifest.json"), "utf8"));
const demoImages = manifest.media.map((m) => m.file);
if (demoImages.length !== 22) throw new Error(`preview build: expected 22 demo images, found ${demoImages.length}`);

module.exports = {
  appId: "com.alzabt.pos.r5preview.owneronly",
  productName: "Alzabt POS R5 PREVIEW",
  extraMetadata: {
    name: "alzabt-pos-r5-preview",
    productName: "Alzabt POS R5 PREVIEW",
    alzabtFlavor: "owner-preview",
  },
  npmRebuild: false,
  directories: { output: "release-preview" },
  files: ["dist/**/*", "package.json"],
  asarUnpack: ["node_modules/better-sqlite3/**"],
  extraResources: [
    { from: "resources/demo", to: "demo-assets/catalog", filter: ["demo-22-import.csv", "product-image-mapping.json"] },
    { from: "resources/demo", to: "demo-assets/config", filter: ["demo-media-manifest.json", "demo-logo.png", "demo-profile.json"] },
    { from: "tests/fixtures/demo-catalog/images", to: "demo-assets/images", filter: demoImages },
  ],
  win: { target: "nsis" },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    include: "build/preview-installer.nsh",
    artifactName: "Alzabt-POS-R5-PREVIEW-OWNER-ONLY-Setup-${version}.${ext}",
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
    guid: "7b0f3e52-4c8a-4f61-9a3d-5e2b8c71d4a9",
    allowElevation: false,
    packElevateHelper: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Alzabt POS R5 PREVIEW",
  },
  publish: null,
};
