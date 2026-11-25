'use strict';

// Review candidate only. This never removes the source barriers. The CLI is
// restricted to the separately authorized disposable hosted Windows job, and
// refuses to start while either lifecycle barrier remains in the source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { applyToLocalBuilder } = require('./preview-template-candidate.cjs');
const { inventory, makeInclude } = require('./preview-owned-payload.cjs');

const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const REF = 'refs/heads/claude/r5-owner-preview-20261125';

function requireReady({ platform, env, source, head, status }) {
  if (platform !== 'win32' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      env.RUNNER_OS !== 'Windows' || env.GITHUB_EVENT_NAME !== 'push' ||
      env.GITHUB_REPOSITORY !== 'salmanhoussam/alzabt-pos' || env.GITHUB_REF !== REF ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') || head !== env.GITHUB_SHA || status.trim()) {
    throw new Error('Trial build requires the exact clean source on the authorized hosted Windows branch');
  }
  if (/^\s*!error\s+"TRIAL NSIS LIFECYCLE NOT APPROVED/m.test(source) ||
      /Abort\s+"TRIAL lifecycle is not approved; no process will be terminated\."/.test(source)) {
    throw new Error('Trial installer lifecycle barriers remain active');
  }
}

// The caller supplies a builder invocation so tests can use synthetic files;
// the CLI supplies only the locally installed, pinned electron-builder CLI.
function buildCandidate(project, runBuilder) {
  const output = path.join(project, 'release');
  const payload = path.join(output, 'win-unpacked');
  const generated = path.join(project, 'build', 'preview-payload-generated.nsh');
  if (fs.existsSync(output) || fs.existsSync(generated)) throw new Error('Trial build requires fresh output and generated-include paths');

  // First create final unpacked bytes without compiling or executing NSIS.
  // OWNER PREVIEW: every builder call uses the preview identity (build/preview.electron-builder.cjs).
  runBuilder(['--config', 'build/preview.electron-builder.cjs', '--win', '--x64', '--dir', '--publish', 'never']);
  const before = inventory(payload);
  const json = JSON.stringify(before);
  const include = makeInclude(before);
  fs.writeFileSync(generated, include, { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'preview-payload-manifest.json'), json + '\n', { flag: 'wx' });
  console.log(`Trial payload inventory SHA-256 ${digest(json)}`);
  console.log(`Trial generated include SHA-256 ${digest(include)}`);

  // Pin and transform the templates actually read by the standard builder.
  // The default Windows builder executes an intermediate uninstaller producer
  // during the next phase; the independently reviewed authorization must name it.
  applyToLocalBuilder(project);
  runBuilder(['--config', 'build/preview.electron-builder.cjs', '--win', 'nsis', '--x64', '--prepackaged', payload, '--publish', 'never']);
  if (JSON.stringify(inventory(payload)) !== json) throw new Error('Prepackaged preview payload changed during installer build');
  const installer = path.join(output, 'Alzabt-POS-R5-PREVIEW-OWNER-ONLY-Setup-0.1.1.exe');
  const stat = fs.lstatSync(installer);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Expected preview installer is not an ordinary file');
  console.log(`Trial installer SHA-256 ${digest(fs.readFileSync(installer))}`);
  return { installer, manifest: path.join(output, 'preview-payload-manifest.json') };
}

function command(exe, args, options) {
  const result = spawnSync(exe, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Trial build command failed: ${result.status}`);
  return result.stdout;
}

if (require.main === module) {
  if (process.argv.length !== 2) throw new Error('This candidate accepts no arguments');
  const project = process.cwd();
  const head = command('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8', windowsHide: true }).trim();
  const status = command('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: project, encoding: 'utf8', windowsHide: true });
  requireReady({ platform: process.platform, env: process.env, source: fs.readFileSync(path.join(project, 'build', 'preview-installer.nsh'), 'utf8'), head, status });
  if (!process.env.GITHUB_WORKSPACE || fs.realpathSync(project).toLowerCase() !== fs.realpathSync(process.env.GITHUB_WORKSPACE).toLowerCase()) {
    throw new Error('Trial build must run in the checked-out hosted workspace');
  }
  const cli = path.join(project, 'node_modules', 'electron-builder', 'cli.js');
  buildCandidate(project, (args) => command(process.execPath, [cli, ...args], { cwd: project, env: process.env, stdio: 'inherit', windowsHide: true }));
}

module.exports = { requireReady, buildCandidate, digest };
