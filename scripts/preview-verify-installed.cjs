'use strict';

// Read-only comparison of the installed trial tree to the build manifest. This
// establishes byte equality under the accidental-interference model; it does
// not prevent a same-user replacement race or prove NSIS installer provenance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validName } = require('./preview-owned-payload.cjs');

const EXE = 'Alzabt POS R5 PREVIEW.exe';
const UNINSTALLER = 'Uninstall Alzabt POS R5 PREVIEW.exe';
const REGISTRY_PROOF = '.alzabt-trial-registry-proof';
const HASH = /^[a-f0-9]{64}$/i;
function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function checkRelative(name) {
  return typeof name === 'string' && name.length > 0 && name.split('/').every(validName);
}
function verifyInstalled(root, manifest, uninstallerHash, registryProof) {
  if (!path.isAbsolute(root) || path.parse(path.resolve(root)).root === path.resolve(root)) throw new Error('Invalid installed root');
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest.dirs)) throw new Error('Invalid trial payload manifest');
  if (!HASH.test(uninstallerHash || '')) throw new Error('Missing uninstaller identity hash');
  if (!/^[a-f0-9]{128}$/i.test(registryProof || '')) throw new Error('Missing expected registry proof');
  const expected = new Map();
  const add = (name, value) => {
    if (!checkRelative(name)) throw new Error('Invalid manifest path');
    const key = name.toLowerCase();
    if (expected.has(key) || key === UNINSTALLER.toLowerCase() || key === REGISTRY_PROOF) throw new Error('Duplicate or reserved manifest path');
    expected.set(key, { name, ...value });
  };
  for (const dir of manifest.dirs) add(dir, { type: 'directory' });
  for (const file of manifest.files) {
    if (!file || !HASH.test(file.sha256 || '') || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid manifest file');
    add(file.path, { type: 'file', size: file.size, sha256: file.sha256.toLowerCase() });
  }
  if (!expected.has(EXE.toLowerCase())) throw new Error('Trial executable missing from build manifest');
  for (let ancestor = path.resolve(root); ; ancestor = path.dirname(ancestor)) {
    const stat = fs.lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked or invalid installed ancestor');
    if (path.dirname(ancestor) === ancestor) break;
  }
  const seen = new Set();
  let uninstaller = null;
  let proofSeen = false;
  function visit(dir, prefix) {
    const directory = fs.lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Linked or invalid installed directory');
    for (const name of fs.readdirSync(dir)) {
      if (!validName(name)) throw new Error('Invalid installed path');
      const relative = prefix ? `${prefix}/${name}` : name;
      const key = relative.toLowerCase();
      if (seen.has(key)) throw new Error('Case-colliding installed path');
      seen.add(key);
      const target = path.join(dir, name), stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error('Linked installed path');
      if (key === UNINSTALLER.toLowerCase()) {
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid uninstaller');
        uninstaller = hashFile(target);
        if (uninstaller !== uninstallerHash.toLowerCase()) throw new Error('Uninstaller differs from its recorded identity');
        continue;
      }
      if (key === REGISTRY_PROOF) {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 128) throw new Error('Invalid registry proof file');
        const bytes = fs.readFileSync(target);
        const text = bytes.toString('latin1');
        if (!/^[a-f0-9]{128}$/i.test(text) || text.toLowerCase() !== registryProof.toLowerCase()) throw new Error('Registry proof differs from current trial registration');
        proofSeen = true;
        continue;
      }
      const entry = expected.get(key);
      if (!entry) throw new Error(`Unexpected installed path: ${relative}`);
      if (entry.type === 'directory') {
        if (!stat.isDirectory()) throw new Error(`Expected directory: ${relative}`);
        visit(target, relative);
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size || hashFile(target) !== entry.sha256) throw new Error(`Installed payload mismatch: ${relative}`);
      }
    }
  }
  visit(path.resolve(root), '');
  if (!uninstaller || !proofSeen || [...expected.keys()].some((key) => !seen.has(key))) throw new Error('Installed payload is incomplete');
  return { executableSha256: expected.get(EXE.toLowerCase()).sha256, uninstallerSha256: uninstaller };
}

if (require.main === module) {
  if (process.argv.length !== 6) throw new Error('usage: node preview-verify-installed.cjs <root> <manifest> <recorded-uninstaller-sha256> <registry-proof>');
  const manifest = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  process.stdout.write(JSON.stringify(verifyInstalled(process.argv[2], manifest, process.argv[4], process.argv[5])) + '\n');
}
module.exports = { EXE, UNINSTALLER, REGISTRY_PROOF, verifyInstalled };
