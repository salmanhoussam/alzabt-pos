'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { inventory } = require('../../scripts/trial-owned-payload.cjs');
const { EXE, UNINSTALLER, REGISTRY_PROOF, verifyInstalled } = require('../../scripts/trial-verify-installed.cjs');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const proof = 'a'.repeat(64) + 'b'.repeat(64);
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alzabt-installed-verification-'));
  fs.mkdirSync(path.join(root, 'resources'));
  fs.writeFileSync(path.join(root, EXE), 'synthetic trial executable');
  fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'synthetic app payload');
  const manifest = inventory(root);
  fs.writeFileSync(path.join(root, UNINSTALLER), 'synthetic uninstaller');
  fs.writeFileSync(path.join(root, REGISTRY_PROOF), proof);
  return { root, manifest, uninstaller: digest('synthetic uninstaller') };
}
function withFixture(fn) {
  const item = fixture();
  try { fn(item); } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
}
test('binds every installed payload byte to the build inventory and separately checks the uninstaller record', () => withFixture(({ root, manifest, uninstaller }) => {
  const result = verifyInstalled(root, manifest, uninstaller, proof);
  assert.equal(result.executableSha256, digest('synthetic trial executable'));
  assert.equal(result.uninstallerSha256, uninstaller);
}));
test('rejects changed or missing payload files and an unrelated added file', () => withFixture(({ root, manifest, uninstaller }) => {
  const exe = path.join(root, EXE);
  fs.writeFileSync(exe, 'changed trial executable');
  assert.throws(() => verifyInstalled(root, manifest, uninstaller, proof), /mismatch/);
  fs.writeFileSync(exe, 'synthetic trial executable');
  const asset = path.join(root, 'resources', 'app.asar');
  fs.unlinkSync(asset);
  assert.throws(() => verifyInstalled(root, manifest, uninstaller, proof), /incomplete/);
  fs.writeFileSync(asset, 'synthetic app payload');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'keep me');
  assert.throws(() => verifyInstalled(root, manifest, uninstaller, proof), /Unexpected/);
}));
test('rejects a changed uninstaller and malformed or traversal manifests', () => withFixture(({ root, manifest, uninstaller }) => {
  assert.throws(() => verifyInstalled(root, manifest, '0'.repeat(64), proof), /uninstaller/i);
  assert.throws(() => verifyInstalled(root, { ...manifest, files: [...manifest.files, { path: '../outside', size: 0, sha256: '0'.repeat(64) }] }, uninstaller, proof), /Invalid manifest/);
  assert.throws(() => verifyInstalled(root, { ...manifest, files: manifest.files.filter((entry) => entry.path !== EXE) }, uninstaller, proof), /executable/i);
}));
test('requires an ordinary registry proof matching both current registry hashes', () => withFixture(({ root, manifest, uninstaller }) => {
  const marker = path.join(root, REGISTRY_PROOF);
  fs.unlinkSync(marker);
  assert.throws(() => verifyInstalled(root, manifest, uninstaller, proof), /incomplete/);
  fs.writeFileSync(marker, 'c'.repeat(128));
  assert.throws(() => verifyInstalled(root, manifest, uninstaller, proof), /Registry proof differs/);
  fs.writeFileSync(marker, Buffer.alloc(128, 0xe1));
  assert.throws(() => verifyInstalled(root, manifest, uninstaller, proof), /Registry proof differs/);
  fs.writeFileSync(marker, proof + '0');
  assert.throws(() => verifyInstalled(root, manifest, uninstaller, proof), /Invalid registry proof/);
}));
