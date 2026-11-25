'use strict';

// Candidate generator, not a deletion tool. Run on the final win-unpacked tree
// immediately before electron-builder --prepackaged, and verify that same tree
// has not changed when the installer is produced. The generated NSIS include is
// bound into both the generated uninstaller and final installer compilation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const REGISTRY_PROOF = '.alzabt-trial-registry-proof';

function validName(name) {
  return /^[\x20-\x7e]+$/.test(name) && !/[<>:"'`/\\|?*!$]/.test(name) &&
    !/[ .]$/.test(name) && name !== '.' && name !== '..' &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name);
}

function inventory(root) {
  const base = path.resolve(root);
  if (!path.isAbsolute(root) || path.parse(base).root === base) throw new Error('Expected an absolute payload directory');
  const files = [], dirs = [];
  function visit(dir, prefix) {
    const parent = fs.lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(`Unsupported payload directory: ${dir}`);
    const folded = new Set();
    for (const name of fs.readdirSync(dir).sort()) {
      if (!validName(name) || folded.has(name.toLowerCase())) throw new Error(`Unsupported payload name: ${name}`);
      folded.add(name.toLowerCase());
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative.split('/')[0].toLowerCase().startsWith('uninstall ')) throw new Error('Reserved uninstaller name');
      if (relative.toLowerCase() === REGISTRY_PROOF) throw new Error('Reserved registry proof name');
      const absolute = path.join(dir, name), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Linked payload: ${relative}`);
      if (stat.isDirectory()) { dirs.push(relative); visit(absolute, relative); }
      else if (stat.isFile() && stat.nlink === 1) {
        const bytes = fs.readFileSync(absolute);
        files.push({ path: relative, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      } else throw new Error(`Unsupported payload entry: ${relative}`);
    }
  }
  visit(base, '');
  if (!files.length) throw new Error('Empty payload refused');
  return { version: 1, files, dirs };
}

function makeInclude(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.dirs) || !manifest.files.length) throw new Error('Invalid payload manifest');
  const entries = [...manifest.files.map((v) => v.path), ...manifest.dirs];
  if (new Set(entries.map((v) => v.toLowerCase())).size !== entries.length || entries.some((v) => typeof v !== 'string' || v.split('/').some((n) => !validName(n)))) throw new Error('Invalid manifest path');
  if (entries.some((entry) => entry.toLowerCase() === REGISTRY_PROOF || entry.split('/')[0].toLowerCase().startsWith('uninstall '))) throw new Error('Reserved manifest path');
  if (manifest.files.some((v) => !/^[a-f0-9]{64}$/.test(v.sha256))) throw new Error('Invalid manifest hash');
  const directories = new Set(manifest.dirs);
  for (const entry of entries) {
    const parent = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '';
    if (parent && !directories.has(parent)) throw new Error('Manifest is missing an ancestor directory');
  }
  const win = (v) => v.replaceAll('/', '\\');
  const out = ['; generated from the final trial-only payload; do not edit', '!macro customRemoveFiles', '  SetOutPath $TEMP'];
  // Enumerate every existing owned directory before deleting any file. Windows'
  // ERROR_FILE_NOT_FOUND means an empty directory; FindNextFileW must finish
  // with ERROR_NO_MORE_FILES. Other failures are not treated as an empty tree.
  // WIN32_FIND_DATAW contains cFileName at byte 44, and is 592 bytes on Windows.
  function enumerate(relative, permitted) {
    const dir = `$INSTDIR${relative ? '\\' + win(relative) : ''}`;
    out.push(`  !insertmacro trialCheckDirectoryAncestors "${dir}"`,
      `  System::Call 'kernel32::GetFileAttributesW(w "${dir}") i.r0 ?e'`, '  Pop $1',
      '  ${if} $0 == -1', '    ${if} $1 != 2', '    ${andIf} $1 != 3',
      '      Abort "TRIAL cannot inspect an owned directory."', '    ${endif}',
      '  ${else}', '    System::Alloc 592', '    Pop $4',
      '    ${if} $4 == 0', '      Abort "TRIAL cannot allocate directory enumeration."', '    ${endif}',
      `    System::Call 'kernel32::FindFirstFileW(w "${dir}\\*", p r4) p.r0 ?e'`, '    Pop $1',
      '    ${if} $0 == -1', '      System::Free $4', '      ${if} $1 != 2',
      '        Abort "TRIAL cannot enumerate an owned directory."', '      ${endif}',
      '    ${else}', '      ${Do}', '        IntOp $5 $4 + 44', '        System::Call "*$5(&w260 .r6)"',
      '        StrCpy $7 0', '        ${if} $6 == "."', '        ${orIf} $6 == ".."');
    for (const name of permitted) out.push(`        \${orIf} $6 == "${name}"`);
    out.push('          StrCpy $7 1', '        ${endif}', '        ${if} $7 != 1',
      "          System::Call 'kernel32::FindClose(p r0) i.r2'", '          System::Free $4',
      '          Abort "TRIAL preserves an unknown directory entry."', '        ${endif}',
      "        System::Call 'kernel32::FindNextFileW(p r0, p r4) i.r2 ?e'", '        Pop $1',
      '        ${if} $2 == 0', '          ${if} $1 != 18',
      "            System::Call 'kernel32::FindClose(p r0) i.r2'", '            System::Free $4',
      '            Abort "TRIAL directory enumeration failed."', '          ${endif}',
      '          ${ExitDo}', '        ${endif}', '      ${Loop}',
      "      System::Call 'kernel32::FindClose(p r0) i.r2 ?e'", '      Pop $1', '      System::Free $4',
      '      ${if} $2 == 0', '        Abort "TRIAL cannot close directory enumeration."',
      '      ${endif}', '    ${endif}', '  ${endif}');
  }
  for (const directory of ['', ...manifest.dirs]) {
    const children = entries.filter((entry) => {
      const parent = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '';
      return parent === directory;
    }).map((entry) => entry.split('/').pop());
    if (!directory) children.push('${UNINSTALL_FILENAME}', REGISTRY_PROOF);
    enumerate(directory, children);
  }
  // Inspect every owned file before deleting any. A missing file is permitted
  // so a previous interrupted uninstall can be retried; changed files refuse.
  for (const f of manifest.files) {
    const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    out.push(`  !insertmacro trialCheckDirectoryAncestors "$INSTDIR${parent ? '\\' + win(parent) : ''}"`,
      `  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\\${win(f.path)}") i.r0 ?e'`, '  Pop $1',
      '  ${if} $0 == -1', '    ${if} $1 != 2', '    ${andIf} $1 != 3', '      Abort "TRIAL cannot inspect owned file."', '    ${endif}',
      '  ${else}', '    IntOp $1 $0 & 0x410', '    ${if} $1 != 0', '      Abort "TRIAL refuses redirected or directory payload."', '    ${endif}',
      `    \${StdUtils.HashFile} $0 "SHA2-256" "$INSTDIR\\${win(f.path)}"`,
      `    \${if} $0 != "${f.sha256}"`, '      Abort "TRIAL refuses a changed payload file."', '    ${endif}', '  ${endif}');
  }
  for (const f of manifest.files) {
    out.push(`  \${if} \${FileExists} "$INSTDIR\\${win(f.path)}"`, '    ClearErrors',
      `    Delete "$INSTDIR\\${win(f.path)}"`, '    ${if} ${Errors}', '      Abort "TRIAL could not remove an owned file."', '    ${endif}', '  ${endif}');
  }
  for (const d of [...manifest.dirs].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))) {
    out.push(`  !insertmacro trialCheckDirectoryAncestors "$INSTDIR\\${win(d)}"`,
      `  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\\${win(d)}") i.r0 ?e'`, '  Pop $1',
      '  ${if} $0 == -1', '    ${if} $1 != 2', '    ${andIf} $1 != 3', '      Abort "TRIAL cannot inspect owned directory."', '    ${endif}',
      '  ${else}', '    ClearErrors', `    RMDir "$INSTDIR\\${win(d)}"`,
      '    ${if} ${Errors}', '      Abort "TRIAL preserves an unknown or busy file."', '    ${endif}', '  ${endif}');
  }
  // Recheck root before deleting the uninstaller, refusing enumeration errors.
  enumerate('', ['${UNINSTALL_FILENAME}', REGISTRY_PROOF]);
  out.push('  ClearErrors', `  Delete "$INSTDIR\\${REGISTRY_PROOF}"`, '  ${if} ${Errors}', '    Abort "TRIAL could not remove its registry proof."', '  ${endif}',
    '  ClearErrors', '  Delete "$INSTDIR\\${UNINSTALL_FILENAME}"', '  ${if} ${Errors}', '    Abort "TRIAL could not remove its uninstaller."', '  ${endif}',
    '  ClearErrors', '  RMDir "$INSTDIR"', '  ${if} ${Errors}', '    Abort "TRIAL installation directory could not be removed."', '  ${endif}', '!macroend', '');
  return out.join('\n');
}

if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('usage: node scripts/trial-owned-payload.cjs <absolute-final-win-unpacked> <output-include>');
  const manifest = inventory(process.argv[2]);
  fs.writeFileSync(process.argv[3], makeInclude(manifest), { flag: 'wx' });
  process.stdout.write(`trial payload files=${manifest.files.length} dirs=${manifest.dirs.length} manifest-sha256=${crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}\n`);
}
module.exports = { validName, inventory, makeInclude };
