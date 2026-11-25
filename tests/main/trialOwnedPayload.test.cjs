'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventory, makeInclude } = require('../../scripts/trial-owned-payload.cjs');

function fixture(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alzabt-owned-payload-'));
  try { return fn(temp); }
  finally {
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temp).startsWith('alzabt-owned-payload-')) throw new Error('Unexpected fixture path');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('inventories actual bytes and emits removals for owned paths only', () => fixture((root) => {
  fs.mkdirSync(path.join(root, 'resources'));
  fs.writeFileSync(path.join(root, 'trial.exe'), 'trial executable');
  fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'trial payload');
  const manifest = inventory(root), include = makeInclude(manifest);
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.dirs.length, 1);
  assert.match(include, /Delete "\$INSTDIR\\trial\.exe"/);
  assert.match(include, /Delete "\$INSTDIR\\resources\\app\.asar"/);
  assert.doesNotMatch(include, /RMDir\s+\/r/i);
  assert.ok(include.lastIndexOf('StdUtils.HashFile') < include.indexOf('Delete "$INSTDIR'));
  assert.match(include, /TRIAL preserves an unknown directory entry/);
  const firstDelete = include.indexOf('Delete "$INSTDIR');
  const rootEnumeration = include.indexOf('FindFirstFileW(w "$INSTDIR\\*"');
  const nestedEnumeration = include.indexOf('FindFirstFileW(w "$INSTDIR\\resources\\*"');
  assert.ok(rootEnumeration >= 0 && nestedEnumeration >= 0 && nestedEnumeration < firstDelete);
  assert.ok(include.indexOf('TRIAL directory enumeration failed.') < firstDelete);
  assert.match(include, /\$1 != 18/); // only ERROR_NO_MORE_FILES ends a successful enumeration
  assert.match(include, /\$6 == "app\.asar"/);
  assert.match(include, /\$6 == "\.alzabt-trial-registry-proof"/);
  assert.match(include, /Delete "\$INSTDIR\\\.alzabt-trial-registry-proof"/);
  assert.doesNotMatch(include, /Delete "\$INSTDIR\\unknown/);
  fs.writeFileSync(path.join(root, 'trial.exe'), 'changed executable');
  assert.notEqual(inventory(root).files.find((entry) => entry.path === 'trial.exe').sha256,
    manifest.files.find((entry) => entry.path === 'trial.exe').sha256);
}));

test('refuses reserved names, hard links and unrepresentable names', () => fixture((root) => {
  fs.writeFileSync(path.join(root, 'safe.exe'), 'content');
  fs.writeFileSync(path.join(root, 'Uninstall fake.exe'), 'collision');
  assert.throws(() => inventory(root), /Reserved/);
  fs.unlinkSync(path.join(root, 'Uninstall fake.exe'));
  fs.writeFileSync(path.join(root, '.alzabt-trial-registry-proof'), 'collision');
  assert.throws(() => inventory(root), /Reserved registry proof/);
  fs.unlinkSync(path.join(root, '.alzabt-trial-registry-proof'));
  fs.writeFileSync(path.join(root, 'dollar$.txt'), 'bad NSIS interpolation');
  assert.throws(() => inventory(root), /Unsupported payload name/);
  fs.unlinkSync(path.join(root, 'dollar$.txt'));
  for (const name of ["single'quote.txt", 'back`tick.txt']) {
    fs.writeFileSync(path.join(root, name), 'bad NSIS quoting');
    assert.throws(() => inventory(root), /Unsupported payload name/);
    fs.unlinkSync(path.join(root, name));
  }
  fs.linkSync(path.join(root, 'safe.exe'), path.join(root, 'linked.exe'));
  assert.throws(() => inventory(root), /Unsupported payload entry/);
}));

test('refuses untrusted manifest traversal and malformed hashes', () => {
  assert.throws(() => makeInclude({ version: 1, files: [{ path: '../x', sha256: 'a'.repeat(64) }], dirs: [] }), /Invalid manifest path/);
  assert.throws(() => makeInclude({ version: 1, files: [{ path: 'x', sha256: 'broken' }], dirs: [] }), /Invalid manifest hash/);
  assert.throws(() => makeInclude({ version: 1, files: [{ path: '.alzabt-trial-registry-proof', sha256: 'a'.repeat(64) }], dirs: [] }), /Reserved manifest/);
});
