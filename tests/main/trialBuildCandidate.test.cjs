'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCandidate, requireReady } = require('../../scripts/trial-build-candidate.cjs');
const { expected } = require('../../scripts/trial-template-candidate.cjs');

const sha = 'a'.repeat(40);
const approved = () => ({ platform: 'win32', head: sha, status: '', source: '; synthetic reviewed source\n', env: {
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY: 'salmanhoussam/alzabt-pos', GITHUB_REF: 'refs/heads/codex/functional-trial-installer-20261124-r3', GITHUB_SHA: sha,
} });

test('refuses the active compile and process barriers and mismatched source', () => {
  const context = approved();
  assert.doesNotThrow(() => requireReady(context));
  assert.throws(() => requireReady({ ...context, source: '!error "TRIAL NSIS LIFECYCLE NOT APPROVED: blocked"' }), /barriers/);
  assert.throws(() => requireReady({ ...context, source: 'Abort "TRIAL lifecycle is not approved; no process will be terminated."' }), /barriers/);
  assert.throws(() => requireReady({ ...context, head: 'b'.repeat(40) }), /exact clean source/);
  assert.throws(() => requireReady({ ...context, status: ' M src/main/main.ts' }), /exact clean source/);
  assert.throws(() => requireReady({ ...context, env: { ...context.env, GITHUB_REPOSITORY: 'other/repo' } }), /exact clean source/);
});

function fixture(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alzabt-build-candidate-'));
  try {
    fs.mkdirSync(path.join(temp, 'build'));
    const source = path.resolve(__dirname, '../../node_modules/app-builder-lib');
    const builder = path.join(temp, 'node_modules', 'app-builder-lib');
    fs.mkdirSync(path.join(builder, 'templates', 'nsis', 'include'), { recursive: true });
    fs.copyFileSync(path.join(source, 'package.json'), path.join(builder, 'package.json'));
    for (const name of Object.keys(expected)) fs.copyFileSync(path.join(source, 'templates', 'nsis', name), path.join(builder, 'templates', 'nsis', name));
    return fn(temp);
  } finally {
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temp).startsWith('alzabt-build-candidate-')) throw new Error('Unexpected fixture path');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('builds the include from final payload and invokes only the prepackaged tree', () => fixture((root) => {
  const calls = [];
  const result = buildCandidate(root, (args) => {
    calls.push(args);
    const payload = path.join(root, 'release', 'win-unpacked');
    if (calls.length === 1) {
      fs.mkdirSync(payload, { recursive: true });
      fs.writeFileSync(path.join(payload, 'trial.exe'), 'synthetic payload');
    } else {
      assert.equal(args[args.indexOf('--prepackaged') + 1], payload);
      assert.match(fs.readFileSync(path.join(root, 'build', 'trial-payload-generated.nsh'), 'utf8'), /Delete "\$INSTDIR\\trial\.exe"/);
      const installerTemplate = fs.readFileSync(path.join(root, 'node_modules/app-builder-lib/templates/nsis/installer.nsi'), 'utf8');
      assert.match(installerTemplate, /Trial candidate: no output-path mutation/);
      fs.writeFileSync(path.join(root, 'release', 'Alzabt-POS-TRIAL-TEST-ONLY-Setup-0.1.1.exe'), 'synthetic artifact');
    }
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('--dir'));
  assert.equal(JSON.parse(fs.readFileSync(result.manifest, 'utf8')).files[0].path, 'trial.exe');
  assert.ok(fs.existsSync(result.installer));
}));

test('refuses a payload changed while the synthetic installer is built', () => fixture((root) => {
  let count = 0;
  assert.throws(() => buildCandidate(root, () => {
    const payload = path.join(root, 'release', 'win-unpacked');
    if (++count === 1) {
      fs.mkdirSync(payload, { recursive: true });
      fs.writeFileSync(path.join(payload, 'trial.exe'), 'original');
    } else {
      fs.writeFileSync(path.join(payload, 'trial.exe'), 'changed');
    }
  }), /payload changed/);
}));
