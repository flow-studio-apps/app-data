// Run: node --test tools/
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { build, compareSemver, repoRoot, sha256, validateInAppMessages, validateUpdate } from './lib.mjs';

const NOW = new Date('2026-10-01T10:00:00Z');
let root;

const readManifest = (app = 'demo') => JSON.parse(readFileSync(join(root, 'apps', app, 'manifest.json'), 'utf8'));
const writeManifest = (m, app = 'demo') => {
  mkdirSync(join(root, 'apps', app), { recursive: true });
  writeFileSync(join(root, 'apps', app, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
};
const baseManifest = (extra = {}) => ({
  schemaVersion: 1,
  appId: 'demo',
  updatedAt: '2026-09-29T00:00:00Z',
  network: { policy: 'offline-first' },
  update: { android: { minSupportedVersion: '1.0.0', latestVersion: '1.1.0', storeUrl: 'https://example.com/app' } },
  config: {},
  endpoints: { inAppMessages: '../../shared/in-app-messages.json' },
  packs: [],
  ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'app-data-'));
  mkdirSync(join(root, 'shared'));
  writeFileSync(join(root, 'shared', 'in-app-messages.json'), '{ "notifications": [] }\n');
  writeManifest(baseManifest());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('the real repo is valid and up to date', () => {
  const { errors, changed } = build(repoRoot(), { check: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(changed, []);
});

test('a valid, unchanged repo writes nothing', () => {
  const { errors, changed } = build(root, { now: NOW });
  assert.deepEqual(errors, []);
  assert.deepEqual(changed, []);
});

test('a new pack gets version 1, sha256, bytes and a new updatedAt', () => {
  mkdirSync(join(root, 'apps/demo/packs'));
  writeFileSync(join(root, 'apps/demo/packs/rules.json'), '{"a":1}\n');
  writeManifest(baseManifest({ packs: [{ id: 'rules', type: 'festival-rules', schema: 1, url: 'packs/rules.json' }] }));

  const { errors, changed } = build(root, { now: NOW });
  assert.deepEqual(errors, []);
  assert.deepEqual(changed, ['apps/demo/manifest.json']);
  const [pack] = readManifest().packs;
  assert.equal(pack.version, 1);
  assert.equal(pack.sha256, sha256(Buffer.from('{"a":1}\n')));
  assert.equal(pack.bytes, 8);
  assert.equal(readManifest().updatedAt, '2026-10-01T10:00:00Z');

  // Second run: nothing changed, nothing written, version stays.
  assert.deepEqual(build(root, { now: new Date('2026-10-02T00:00:00Z') }).changed, []);
  assert.equal(readManifest().packs[0].version, 1);
});

test('changed pack content bumps the version exactly once', () => {
  mkdirSync(join(root, 'apps/demo/packs'));
  writeFileSync(join(root, 'apps/demo/packs/rules.json'), '{"a":1}');
  writeManifest(baseManifest({ packs: [{ id: 'rules', type: 'x', schema: 1, url: 'packs/rules.json', version: 3 }] }));
  build(root, { now: NOW });
  assert.equal(readManifest().packs[0].version, 3);

  writeFileSync(join(root, 'apps/demo/packs/rules.json'), '{"a":2}');
  build(root, { now: NOW });
  assert.equal(readManifest().packs[0].version, 4);
  build(root, { now: NOW });
  assert.equal(readManifest().packs[0].version, 4);
});

test('--check reports stale manifests without writing', () => {
  mkdirSync(join(root, 'apps/demo/packs'));
  writeFileSync(join(root, 'apps/demo/packs/p.json'), '[]');
  writeManifest(baseManifest({ packs: [{ id: 'p', type: 'x', schema: 1, url: 'packs/p.json' }] }));
  const before = readFileSync(join(root, 'apps/demo/manifest.json'), 'utf8');
  const { errors, changed } = build(root, { check: true, now: NOW });
  assert.deepEqual(errors, []);
  assert.deepEqual(changed, ['apps/demo/manifest.json']);
  assert.equal(readFileSync(join(root, 'apps/demo/manifest.json'), 'utf8'), before);
});

test('one invalid file blocks every write', () => {
  // A valid app whose pack changed would normally be rewritten…
  mkdirSync(join(root, 'apps/demo/packs'));
  writeFileSync(join(root, 'apps/demo/packs/p.json'), '[]');
  writeManifest(baseManifest({ packs: [{ id: 'p', type: 'x', schema: 1, url: 'packs/p.json' }] }));
  const before = readFileSync(join(root, 'apps/demo/manifest.json'), 'utf8');
  // …but another app is broken.
  writeManifest(baseManifest({ appId: 'other', network: { policy: 'sometimes' } }), 'other');

  const { errors, changed } = build(root, { now: NOW });
  assert.deepEqual(changed, []);
  assert.ok(errors.some((e) => e.includes('network.policy')));
  assert.equal(readFileSync(join(root, 'apps/demo/manifest.json'), 'utf8'), before);
});

test('manifest errors are reported', () => {
  const cases = [
    [{ appId: 'wrong' }, 'must match folder'],
    [{ schemaVersion: 2 }, 'schemaVersion'],
    [{ packs: undefined }, 'packs: must be an array'],
    [{ endpoints: { inAppMessages: '../../shared/missing.json' } }, 'does not exist'],
    [{ endpoints: { appInfo: 'http://insecure.example.com/a.json' } }, 'must be https'],
    [{ endpoints: { x: '../../../outside.json' } }, 'outside the repo'],
    [{ packs: [{ id: 'p', type: 'x', schema: 1, url: 'packs/none.json' }] }, 'does not exist'],
    [{ packs: [{ id: 'p', type: 'x', schema: 1, url: 'https://example.com/p.json' }] }, 'relative to the manifest'],
    [{ packs: [{ id: 'p', type: 'x', schema: 1, url: '../other/p.json' }] }, 'must stay inside'],
  ];
  for (const [extra, expected] of cases) {
    writeManifest(baseManifest(extra));
    const { errors } = build(root, { now: NOW });
    assert.ok(errors.some((e) => e.includes(expected)), `expected "${expected}" in ${JSON.stringify(errors)}`);
  }
});

test('invalid JSON pack, duplicate pack ids and oversized packs are rejected', () => {
  mkdirSync(join(root, 'apps/demo/packs'));
  writeFileSync(join(root, 'apps/demo/packs/bad.json'), '{ nope');
  writeFileSync(join(root, 'apps/demo/packs/big.json'), `"${'x'.repeat(2 * 1024 * 1024)}"`);
  writeFileSync(join(root, 'apps/demo/packs/ok.json'), '{}');
  writeManifest(baseManifest({
    packs: [
      { id: 'bad', type: 'x', schema: 1, url: 'packs/bad.json' },
      { id: 'big', type: 'x', schema: 1, url: 'packs/big.json' },
      { id: 'ok', type: 'x', schema: 1, url: 'packs/ok.json' },
      { id: 'ok', type: 'x', schema: 1, url: 'packs/ok.json' },
    ],
  }));
  const { errors } = build(root, { now: NOW });
  assert.ok(errors.some((e) => e.includes('not valid JSON')));
  assert.ok(errors.some((e) => e.includes('pack limit')));
  assert.ok(errors.some((e) => e.includes('duplicate "ok"')));
});

test('update block rules', () => {
  const errs = (u) => {
    const e = [];
    validateUpdate(u, 'update', e);
    return e;
  };
  const android = { minSupportedVersion: '1.0.0', latestVersion: '1.2.0', storeUrl: 'https://x.test' };
  assert.deepEqual(errs({ android, forceMessage: { en: 'Update', hi: 'अपडेट' }, available: { reminderIntervalHours: 24 } }), []);
  assert.ok(errs({}).some((e) => e.includes('at least one')));
  assert.ok(errs({ android: { ...android, latestVersion: '0.9.0' } }).some((e) => e.includes('>= minSupportedVersion')));
  assert.ok(errs({ android: { ...android, latestVersion: 'v1' } }).some((e) => e.includes('latestVersion')));
  assert.ok(errs({ android: { ...android, storeUrl: 'market://x' } }).some((e) => e.includes('storeUrl')));
  assert.ok(errs({ android, forceMessage: 'plain' }).some((e) => e.includes('forceMessage')));
  assert.ok(errs({ android, available: { reminderIntervalHours: 0 } }).some((e) => e.includes('reminderIntervalHours')));
});

test('in-app message rules', () => {
  const errs = (doc) => {
    const e = [];
    validateInAppMessages(doc, 'm', e);
    return e;
  };
  const message = {
    id: 'hello',
    apps: ['*'],
    title: { en: 'Hi', hi: 'नमस्ते' },
    body: 'Plain text is allowed',
    style: 'info',
    versionTarget: { operator: 'between', version: '1.0.0', toVersion: '1.2.0' },
    schedule: { startAt: '2026-10-01T00:00:00Z' },
    repeat: null,
    actions: [
      { id: 'open', label: 'Open', type: 'url', url: 'https://x.test' },
      { id: 'go', label: 'Go', type: 'deeplink', route: '/settings' },
      { id: 'close', label: 'Close', type: 'dismiss' },
    ],
  };
  assert.deepEqual(errs({ notifications: [message] }), []);
  assert.ok(errs([]).length > 0);
  assert.ok(errs({ notifications: [message, message] }).some((e) => e.includes('duplicate')));
  assert.ok(errs({ notifications: [{ ...message, style: 'loud' }] }).some((e) => e.includes('style')));
  assert.ok(errs({ notifications: [{ ...message, versionTarget: { operator: 'between', version: '1.0.0' } }] }).some((e) => e.includes('toVersion')));
  assert.ok(errs({ notifications: [{ ...message, actions: [{ id: 'a', label: 'A', type: 'url', url: 'http://x' }] }] }).some((e) => e.includes('https')));
  assert.ok(errs({ notifications: [{ ...message, actions: [{ id: 'a', label: 'A', type: 'deeplink', route: 'x' }] }] }).some((e) => e.includes('route')));
});

test('compareSemver compares numerically', () => {
  assert.ok(compareSemver('1.10.0', '1.9.0') > 0);
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
});

test('copying the real repo into a temp dir builds cleanly', () => {
  for (const dir of ['shared', 'apps']) cpSync(join(repoRoot(), dir), join(root, dir), { recursive: true, force: true });
  rmSync(join(root, 'apps', 'demo'), { recursive: true });
  assert.deepEqual(build(root, { now: NOW }), { errors: [], changed: [] });
});
