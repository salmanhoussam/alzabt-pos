// CANDIDATE ONLY. The NSIS compilation and lifecycle abort barriers remain.
// This transformation is not an approval to compile or execute an installer.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const expected = {
  'installer.nsi': '8811964416d122612c3e7601728af5d3f998d677918df829a4e8b4c739c8b9f8',
  'uninstaller.nsh': '9ee2dac4593478083e8aa6f8487287ce9401006ccd50ecc538871d133ea4a42c',
  'multiUser.nsh': '9aca256695c289ec8a875143101fae8c6236bc8c6a7cf369bbe8b4986e09c9cb',
  'include/installer.nsh': '0e319437dd01dcbf911f3f48f664fde0cefbaef704f1cdb1739f63d563f5d4a0',
};
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');

function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Template anchor is missing or ambiguous');
  return source.replace(before, after);
}

function transform(name, bytes) {
  if (!expected[name] || digest(bytes) !== expected[name]) throw new Error(`Unrecognized template bytes: ${name}`);
  const source = bytes.toString('utf8');
  if (name === 'installer.nsi') {
    // The install section already sets $INSTDIR after initMultiUser/customInit.
    // BUILD_UNINSTALLER reaches WriteUninstaller without touching $INSTDIR.
    return once(source, 'Function .onInit\n  Call setInstallSectionSpaceRequired\n\n  SetOutPath $INSTDIR\n',
      'Function .onInit\n  Call setInstallSectionSpaceRequired\n\n  # Trial candidate: no output-path mutation before the fresh-only guard.\n');
  }
  if (name === 'multiUser.nsh') {
    // Resolve the folder without creating a potentially redirected location.
    // If lookup fails the upstream macro falls back to $LocalAppData\Programs;
    // the fixed-path guard must still validate the resulting $INSTDIR.
    return once(source, 'System::Call \'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1\'',
      'System::Call \'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i 0, p 0, *p .r2)i.r1\'');
  }
  if (name === 'include/installer.nsh') {
    // An updater cache is unnecessary in this offline fresh-only trial. The
    // stock copy would write outside the validated installation directory.
    return once(source, '!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"',
      '# Trial does not create an updater installer cache.');
  }
  // Validate the original uninstaller $INSTDIR before initMultiUser can replace it.
  // No output path is needed here; the normal uninstall section later moves to $TEMP.
  return once(source, 'Function un.onInit\n  SetOutPath $INSTDIR\n',
    'Function un.onInit\n  !ifmacrondef customTrialUnInitBeforePath\n    !error "Trial early uninstaller guard is required"\n  !endif\n  !insertmacro customTrialUnInitBeforePath\n');
}

function prepare(root) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== 'app-builder-lib' || metadata.version !== '26.15.3') throw new Error('Unexpected app-builder-lib version');
  const dir = path.join(root, 'templates', 'nsis');
  return Object.fromEntries(Object.keys(expected).map((name) => [name, transform(name, fs.readFileSync(path.join(dir, name)))]));
}

// The installer build invokes this only in a fresh private npm-ci checkout.
// Validate *all* inputs before writing any transformed template. The build
// remains blocked by !error until the full lifecycle is independently reviewed.
function applyToLocalBuilder(projectRoot) {
  const root = path.resolve(projectRoot, 'node_modules', 'app-builder-lib');
  if (fs.realpathSync(root).toLowerCase() !== root.toLowerCase()) throw new Error('Linked builder tree refused');
  for (const name of Object.keys(expected)) {
    const target = path.join(root, 'templates', 'nsis', name);
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || fs.realpathSync(target).toLowerCase() !== target.toLowerCase()) throw new Error('Linked builder template refused');
  }
  const output = prepare(root);
  for (const [name, contents] of Object.entries(output)) {
    const target = path.join(root, 'templates', 'nsis', name);
    fs.writeFileSync(target, contents, { flag: 'w' });
    process.stdout.write(`trial NSIS template ${name} original=${expected[name]} result=${digest(contents)}\n`);
  }
}

if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') throw new Error('usage: node scripts/trial-template-candidate.cjs --apply');
  applyToLocalBuilder(process.cwd());
}
module.exports = { expected, digest, transform, prepare, applyToLocalBuilder };
