// Validation and manifest rebuilding for the app-data repo.
// No dependencies: the rules here mirror schemas/*.schema.json by hand.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_PACK_BYTES = 2 * 1024 * 1024; // matches jyotish-flow CONTENT_MAX_PACK_BYTES
export const NETWORK_POLICIES = ['offline-first', 'online-first', 'online-required'];

const SEMVER = /^\d+\.\d+\.\d+$/;
const APP_ID = /^[a-z0-9][a-z0-9_-]*$/;
const PACK_ID = /^[a-z0-9][a-z0-9._-]*$/;
const MESSAGE_STYLES = ['info', 'warning', 'promo'];
const ACTION_TYPES = ['url', 'dismiss', 'deeplink'];
const REPEATS = ['once', 'every-launch', 'daily', 'weekly', null];
const VERSION_OPERATORS = ['lt', 'lte', 'eq', 'gte', 'gt', 'between'];
const PLATFORMS = ['Android', 'iOS'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;
const isHttps = (v) => typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v);
const isIsoDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** `{ "en": "…", "hi": "…" }` with a non-empty `en`; `allowString` also accepts a plain string. */
function checkLocalized(value, path, errors, { allowString = false } = {}) {
  if (allowString && typeof value === 'string' && value.trim()) return;
  if (!isObject(value) || typeof value.en !== 'string' || !value.en.trim()) {
    errors.push(`${path}: must be ${allowString ? 'a string or ' : ''}{ "en": "…", … } with non-empty "en"`);
    return;
  }
  for (const [lang, text] of Object.entries(value)) {
    if (typeof text !== 'string') errors.push(`${path}.${lang}: must be a string`);
  }
}

export function validateNetwork(network, path, errors) {
  if (!isObject(network)) return errors.push(`${path}: must be an object`);
  if (!NETWORK_POLICIES.includes(network.policy)) {
    errors.push(`${path}.policy: must be one of ${NETWORK_POLICIES.join(', ')}`);
  }
  for (const key of ['timeoutMs', 'refreshHours', 'maxCacheAgeHours']) {
    if (network[key] !== undefined && !isInt(network[key], 1)) {
      errors.push(`${path}.${key}: must be a positive integer`);
    }
  }
}

/** The shared `update` block (schemas/update.schema.json). */
export function validateUpdate(update, path, errors) {
  if (!isObject(update)) return errors.push(`${path}: must be an object`);
  const platforms = ['android', 'ios'].filter((p) => update[p] !== undefined);
  if (platforms.length === 0) errors.push(`${path}: needs at least one of "android", "ios"`);
  for (const p of platforms) {
    const block = update[p];
    const bp = `${path}.${p}`;
    if (!isObject(block)) {
      errors.push(`${bp}: must be an object`);
      continue;
    }
    for (const key of ['minSupportedVersion', 'latestVersion']) {
      if (!SEMVER.test(block[key] ?? '')) errors.push(`${bp}.${key}: must be a version like 1.2.0`);
    }
    if (SEMVER.test(block.minSupportedVersion ?? '') && SEMVER.test(block.latestVersion ?? '')
      && compareSemver(block.latestVersion, block.minSupportedVersion) < 0) {
      errors.push(`${bp}: latestVersion must be >= minSupportedVersion`);
    }
    if (!isHttps(block.storeUrl)) errors.push(`${bp}.storeUrl: must be an https URL`);
  }
  if (update.forceMessage !== undefined) checkLocalized(update.forceMessage, `${path}.forceMessage`, errors);
  const available = update.available;
  if (available !== undefined) {
    const ap = `${path}.available`;
    if (!isObject(available)) return errors.push(`${ap}: must be an object`);
    for (const key of ['newFeaturesCount', 'bugFixesCount']) {
      if (available[key] !== undefined && !isInt(available[key])) errors.push(`${ap}.${key}: must be an integer >= 0`);
    }
    if (available.reminderIntervalHours !== undefined && !isInt(available.reminderIntervalHours, 1)) {
      errors.push(`${ap}.reminderIntervalHours: must be a positive integer`);
    }
    if (available.packageSizeLabel !== undefined && typeof available.packageSizeLabel !== 'string') {
      errors.push(`${ap}.packageSizeLabel: must be a string`);
    }
    if (available.notes !== undefined) checkLocalized(available.notes, `${ap}.notes`, errors);
  }
}

/** `shared/in-app-messages.json` (schemas/in-app-messages.schema.json). */
export function validateInAppMessages(doc, path, errors) {
  if (!isObject(doc) || !Array.isArray(doc.notifications)) {
    return errors.push(`${path}: must be { "notifications": [ … ] }`);
  }
  const ids = new Set();
  doc.notifications.forEach((m, i) => {
    const mp = `${path}.notifications[${i}]`;
    if (!isObject(m)) return errors.push(`${mp}: must be an object`);
    if (typeof m.id !== 'string' || !m.id) errors.push(`${mp}.id: required string`);
    else if (ids.has(m.id)) errors.push(`${mp}.id: duplicate "${m.id}"`);
    else ids.add(m.id);
    if (m.is_active !== undefined && typeof m.is_active !== 'boolean') errors.push(`${mp}.is_active: must be boolean`);
    if (!Array.isArray(m.apps) || m.apps.some((a) => typeof a !== 'string')) {
      errors.push(`${mp}.apps: must be an array of app ids or ["*"]`);
    }
    checkLocalized(m.title, `${mp}.title`, errors, { allowString: true });
    checkLocalized(m.body, `${mp}.body`, errors, { allowString: true });
    if (m.style !== undefined && !MESSAGE_STYLES.includes(m.style)) errors.push(`${mp}.style: must be one of ${MESSAGE_STYLES.join(', ')}`);
    if (m.priority !== undefined && !Number.isInteger(m.priority)) errors.push(`${mp}.priority: must be an integer`);
    if (m.platforms !== undefined && (!Array.isArray(m.platforms) || m.platforms.some((p) => !PLATFORMS.includes(p)))) {
      errors.push(`${mp}.platforms: must be an array of ${PLATFORMS.join(', ')}`);
    }
    if (m.versionTarget !== undefined) {
      const vt = m.versionTarget;
      if (!isObject(vt) || !VERSION_OPERATORS.includes(vt.operator) || !SEMVER.test(vt.version ?? '')) {
        errors.push(`${mp}.versionTarget: needs operator (${VERSION_OPERATORS.join(', ')}) and version`);
      } else if (vt.operator === 'between' && !SEMVER.test(vt.toVersion ?? '')) {
        errors.push(`${mp}.versionTarget.toVersion: required for "between"`);
      }
    }
    if (m.schedule !== undefined) {
      if (!isObject(m.schedule)) errors.push(`${mp}.schedule: must be an object`);
      else for (const key of ['startAt', 'endAt']) {
        if (m.schedule[key] !== undefined && !isIsoDate(m.schedule[key])) errors.push(`${mp}.schedule.${key}: must be an ISO 8601 date`);
      }
    }
    if (m.repeat !== undefined && !REPEATS.includes(m.repeat)) errors.push(`${mp}.repeat: invalid value`);
    if (m.dismissal !== undefined && !isObject(m.dismissal)) errors.push(`${mp}.dismissal: must be an object`);
    if (!Array.isArray(m.actions)) return errors.push(`${mp}.actions: must be an array`);
    m.actions.forEach((a, j) => {
      const acp = `${mp}.actions[${j}]`;
      if (!isObject(a)) return errors.push(`${acp}: must be an object`);
      if (typeof a.id !== 'string' || !a.id) errors.push(`${acp}.id: required string`);
      checkLocalized(a.label, `${acp}.label`, errors, { allowString: true });
      if (!ACTION_TYPES.includes(a.type)) errors.push(`${acp}.type: must be one of ${ACTION_TYPES.join(', ')}`);
      if (a.type === 'url' && !isHttps(a.url)) errors.push(`${acp}.url: https URL required for type "url"`);
      if (a.type === 'deeplink' && (typeof a.route !== 'string' || !a.route.startsWith('/'))) {
        errors.push(`${acp}.route: path starting with "/" required for type "deeplink"`);
      }
    });
  });
}

/** Resolves a manifest-relative URL to a file inside `root`, or null if it escapes. */
function resolveInside(root, manifestDir, url) {
  const target = resolve(manifestDir, url);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel.split(sep).includes('..')) return null;
  return target;
}

/**
 * Validates one manifest and returns the rebuilt copy (packs re-hashed,
 * versions bumped). `updatedAt` is left to the caller.
 */
export function rebuildManifest(root, appDir, manifest, errors) {
  const path = relative(root, join(appDir, 'manifest.json'));
  if (!isObject(manifest)) {
    errors.push(`${path}: must be a JSON object`);
    return manifest;
  }
  const out = structuredClone(manifest);
  const appName = appDir.split(sep).pop();
  if (out.schemaVersion !== 1) errors.push(`${path}.schemaVersion: must be 1`);
  if (!APP_ID.test(out.appId ?? '')) errors.push(`${path}.appId: must be a lowercase id`);
  else if (out.appId !== appName) errors.push(`${path}.appId: "${out.appId}" must match folder "${appName}"`);
  if (out.updatedAt !== undefined && !isIsoDate(out.updatedAt)) errors.push(`${path}.updatedAt: must be an ISO 8601 date`);
  validateNetwork(out.network, `${path}.network`, errors);
  if (out.update !== undefined) validateUpdate(out.update, `${path}.update`, errors);
  if (out.config !== undefined && !isObject(out.config)) errors.push(`${path}.config: must be an object`);

  if (out.endpoints !== undefined) {
    if (!isObject(out.endpoints)) errors.push(`${path}.endpoints: must be an object`);
    else for (const [key, url] of Object.entries(out.endpoints)) {
      if (typeof url !== 'string' || !url) errors.push(`${path}.endpoints.${key}: must be a URL string`);
      else if (/^[a-z]+:/i.test(url)) {
        if (!isHttps(url)) errors.push(`${path}.endpoints.${key}: absolute URLs must be https`);
      } else {
        const target = resolveInside(root, appDir, url);
        if (!target) errors.push(`${path}.endpoints.${key}: "${url}" points outside the repo`);
        else if (!existsSync(target)) errors.push(`${path}.endpoints.${key}: "${url}" does not exist`);
      }
    }
  }

  if (!Array.isArray(out.packs)) {
    errors.push(`${path}.packs: must be an array (use [] when the app has no packs)`);
    return out;
  }
  const ids = new Set();
  out.packs.forEach((pack, i) => {
    const pp = `${path}.packs[${i}]`;
    if (!isObject(pack)) return errors.push(`${pp}: must be an object`);
    if (!PACK_ID.test(pack.id ?? '')) errors.push(`${pp}.id: must be a lowercase id`);
    else if (ids.has(pack.id)) errors.push(`${pp}.id: duplicate "${pack.id}"`);
    else ids.add(pack.id);
    if (typeof pack.type !== 'string' || !pack.type) errors.push(`${pp}.type: required string`);
    if (!isInt(pack.schema, 1)) errors.push(`${pp}.schema: must be a positive integer`);
    if (pack.version !== undefined && !isInt(pack.version, 1)) errors.push(`${pp}.version: must be a positive integer`);
    if (pack.minAppVersion !== undefined && !SEMVER.test(pack.minAppVersion)) errors.push(`${pp}.minAppVersion: must be a version like 1.2.0`);
    if (pack.langs !== undefined && (!Array.isArray(pack.langs) || pack.langs.some((l) => typeof l !== 'string'))) {
      errors.push(`${pp}.langs: must be an array of language codes`);
    }
    if (typeof pack.url !== 'string' || !pack.url || /^[a-z]+:/i.test(pack.url)) {
      return errors.push(`${pp}.url: must be a path relative to the manifest (packs are hashed from this repo)`);
    }
    const file = resolveInside(appDir, appDir, pack.url);
    if (!file) return errors.push(`${pp}.url: "${pack.url}" must stay inside ${relative(root, appDir)}/`);
    if (!existsSync(file) || !statSync(file).isFile()) return errors.push(`${pp}.url: "${pack.url}" does not exist`);
    const bytes = readFileSync(file);
    try {
      JSON.parse(bytes.toString('utf8'));
    } catch (e) {
      return errors.push(`${pp}.url: "${pack.url}" is not valid JSON (${e.message})`);
    }
    if (bytes.length > MAX_PACK_BYTES) errors.push(`${pp}: ${bytes.length} bytes exceeds the ${MAX_PACK_BYTES}-byte pack limit`);
    const hash = sha256(bytes);
    if (!pack.version) pack.version = 1;
    else if (pack.sha256 && pack.sha256 !== hash) pack.version += 1;
    pack.sha256 = hash;
    pack.bytes = bytes.length;
  });
  return out;
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function readJson(file, root, errors) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${relative(root, file)}: not valid JSON (${e.message})`);
    return undefined;
  }
}

/**
 * Validates the whole repo and rewrites manifests whose packs changed or
 * whose formatting differs. Writes nothing when any error is found, or when
 * `check` is set. Returns `{ errors, changed }` (changed = repo-relative paths).
 */
export function build(root, { check = false, now = new Date() } = {}) {
  root = resolve(root);
  const errors = [];

  const messagesFile = join(root, 'shared', 'in-app-messages.json');
  if (!existsSync(messagesFile)) errors.push('shared/in-app-messages.json: missing');
  else {
    const doc = readJson(messagesFile, root, errors);
    if (doc !== undefined) validateInAppMessages(doc, 'shared/in-app-messages.json', errors);
  }

  const appsDir = join(root, 'apps');
  const appDirs = existsSync(appsDir)
    ? readdirSync(appsDir).map((d) => join(appsDir, d)).filter((d) => statSync(d).isDirectory())
    : [];
  if (appDirs.length === 0) errors.push('apps/: no app folders found');

  const pending = [];
  for (const appDir of appDirs) {
    const file = join(appDir, 'manifest.json');
    if (!existsSync(file)) {
      errors.push(`${relative(root, appDir)}/manifest.json: missing`);
      continue;
    }
    const raw = readFileSync(file, 'utf8');
    const manifest = readJson(file, root, errors);
    if (manifest === undefined) continue;
    const rebuilt = rebuildManifest(root, appDir, manifest, errors);
    const contentChanged = serialize({ ...rebuilt, updatedAt: null }) !== serialize({ ...manifest, updatedAt: null });
    if (contentChanged || !manifest.updatedAt) rebuilt.updatedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const text = serialize(rebuilt);
    if (text !== raw) pending.push({ file, text });
  }

  if (errors.length > 0) return { errors, changed: [] };
  if (!check) for (const { file, text } of pending) writeFileSync(file, text);
  return { errors, changed: pending.map(({ file }) => relative(root, file)) };
}

export const repoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..');
