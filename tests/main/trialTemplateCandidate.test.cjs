// Read-only tests of pinned templates and the candidate transformation. These do
// not compile NSIS or exercise Windows installer behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const candidate = require('../../scripts/trial-template-candidate.cjs');

const root = path.resolve(__dirname, '../../node_modules/app-builder-lib');
const source = (name) => fs.readFileSync(path.join(root, 'templates/nsis', name));

test('pinned templates transform without an output-path mutation before guards', () => {
  const output = candidate.prepare(root);
  const init = output['installer.nsi'].split('Function .onInit')[1].split('FunctionEnd')[0];
  assert.doesNotMatch(init, /SetOutPath\s+\$INSTDIR/);
  assert.ok(init.indexOf('!insertmacro preInit') < init.indexOf('!ifdef BUILD_UNINSTALLER'));
  assert.ok(init.indexOf('WriteUninstaller') < init.indexOf('!insertmacro initMultiUser'));
  assert.ok(init.indexOf('!insertmacro initMultiUser') < init.indexOf('!insertmacro customInit'));
  const uninit = output['uninstaller.nsh'].split('Function un.onInit')[1].split('FunctionEnd')[0];
  assert.doesNotMatch(uninit, /SetOutPath\s+\$INSTDIR/);
  assert.ok(uninit.indexOf('!insertmacro customTrialUnInitBeforePath') < uninit.indexOf('!insertmacro initMultiUser'));
  assert.ok(uninit.indexOf('!insertmacro initMultiUser') < uninit.indexOf('!insertmacro customUnInit'));
  const lookup = output['multiUser.nsh'].split('\n').find((line) => line.includes('SHGetKnownFolderPath('));
  assert.ok(lookup);
  assert.match(lookup, /i 0, p 0/);
  assert.doesNotMatch(lookup, /KF_FLAG_CREATE/);
  assert.doesNotMatch(output['include/installer.nsh'], /!insertmacro copyFile "\$EXEPATH" "\$LOCALAPPDATA\\\$\{APP_INSTALLER_STORE_FILE\}"/);
});

test('rejects changed, unknown and already-transformed template bytes', () => {
  const original = source('installer.nsi');
  assert.throws(() => candidate.transform('installer.nsi', Buffer.concat([original, Buffer.from(' ')])), /Unrecognized/);
  assert.throws(() => candidate.transform('other.nsi', original), /Unrecognized/);
  assert.throws(() => candidate.transform('installer.nsi', Buffer.from(candidate.transform('installer.nsi', original))), /Unrecognized/);
  assert.throws(() => candidate.transform('multiUser.nsh', Buffer.concat([source('multiUser.nsh'), Buffer.from(' ')])), /Unrecognized/);
});

// TRANSITION (barrier removal): this test asserted the compile barrier and the unconditional process Abort while
// the lifecycle was unreviewed. After the independent review and its fixes, the spec is: NO compile barrier, and a
// NON-TERMINATING process check (refuse while a trial process exists, never kill) — plus every fresh-only guard.
test('source has no compile barrier, a non-terminating process check and the fresh-only checks', () => {
  const include = fs.readFileSync(path.resolve(__dirname, '../../build/trial-installer.nsh'), 'utf8');
  assert.doesNotMatch(include, /^!error "TRIAL NSIS LIFECYCLE NOT APPROVED/m);
  assert.doesNotMatch(include, /Abort "TRIAL lifecycle is not approved/);
  assert.match(include, /!macro customCheckAppRunning\s+;[^\n]*\n\s*!insertmacro trialRefuseRunning\s+!macroend/);
  assert.doesNotMatch(include, /KillProcess|taskkill|Stop-Process/i);
  assert.match(include, /\$\{if\} \$\{isForceRun\}[\s\S]*?Abort "TRIAL refuses automatic launch\."/);
  assert.match(include, /!ifdef ENABLE_LOGGING_ELECTRON_BUILDER[\s\S]*?!error "TRIAL refuses electron-builder pre-guard installer logging"/);
  for (const key of ['INSTALL_REGISTRY_KEY', 'UNINSTALL_REGISTRY_KEY', 'UNINSTALL_REGISTRY_KEY_2']) {
    assert.ok(include.includes(`!insertmacro trialRequireAbsentKey "\${${key}}"`));
  }
  assert.match(include, /GetFileAttributesW/);
  assert.match(include, /!macro customTrialUnInitBeforePath/);
  assert.match(include, /TRIAL refuses a redirected path ancestor/);
  assert.match(include, /QueryDosDeviceW/);
  assert.match(include, /TRIAL refuses a substituted or unsupported local drive/);
  assert.match(include, /!insertmacro trialCheckDirectoryAncestors "\$LOCALAPPDATA\\Programs"/);
  assert.match(include, /!insertmacro trialCheckDirectoryAncestors "\$INSTDIR"/);
  assert.match(include, /TRIAL installation registration refused/);
  assert.match(include, /reg\.exe" export "HKCU\\\$\{INSTALL_REGISTRY_KEY\}"/);
  assert.match(include, /reg\.exe" export "HKCU\\\$\{UNINSTALL_REGISTRY_KEY\}"/);
  assert.match(include, /TRIAL refuses changed registry keys/);
  assert.match(include, /GetFileInformationByHandle/);
  assert.match(include, /TRIAL refuses a hard-linked registry proof/);
  assert.match(include, /FileSeek \$R5 0 END \$0[\s\S]*?\$0 != 128[\s\S]*?FileSeek \$R5 0 SET[\s\S]*?FileRead \$R5 \$R8/);
});

test('applies only to an isolated pristine template tree and rejects mismatches before writes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alzabt-template-fixture-'));
  try {
    const builder = path.join(temp, 'node_modules', 'app-builder-lib');
    fs.mkdirSync(path.join(builder, 'templates', 'nsis', 'include'), { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(builder, 'package.json'));
    for (const name of Object.keys(candidate.expected)) {
      fs.copyFileSync(path.join(root, 'templates', 'nsis', name), path.join(builder, 'templates', 'nsis', name));
    }
    const target = path.join(builder, 'templates', 'nsis', 'multiUser.nsh');
    fs.appendFileSync(target, ' ');
    const originalInstaller = fs.readFileSync(path.join(builder, 'templates', 'nsis', 'installer.nsi'));
    assert.throws(() => candidate.applyToLocalBuilder(temp), /Unrecognized/);
    assert.deepEqual(fs.readFileSync(path.join(builder, 'templates', 'nsis', 'installer.nsi')), originalInstaller);
    fs.copyFileSync(path.join(root, 'templates', 'nsis', 'multiUser.nsh'), target);
    candidate.applyToLocalBuilder(temp);
    assert.throws(() => candidate.applyToLocalBuilder(temp), /Unrecognized/);
    assert.notEqual(candidate.digest(fs.readFileSync(path.join(builder, 'templates', 'nsis', 'installer.nsi'))), candidate.expected['installer.nsi']);
  } finally {
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temp).startsWith('alzabt-template-fixture-')) throw new Error('Unexpected fixture path');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
