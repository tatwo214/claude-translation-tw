#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isVersion = (value) => typeof value === 'string' && value.trim().length > 0;
const digest = (value) => createHash('sha256').update(value).digest('hex');

function readJSON(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function optionalJSON(file) {
  try {
    return readJSON(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Sort independently of locale and insertion order. Never merge untrusted keys
// into an object's prototype, and validate the entire input before publishing.
function dictionaryFrom(input) {
  if (!isObject(input)) throw new Error('Invalid dictionary');
  const keys = Object.keys(input).sort();
  if (keys.length > 20000) throw new Error('Dictionary exceeds 20000 entries');
  const dictionary = Object.create(null);
  for (const source of keys) {
    const value = input[source];
    // Public directory descriptions can exceed a short UI label (observed 948+
    // characters). Keep a bounded entry and the existing total snapshot byte cap.
    if (forbiddenKeys.has(source) || !source.trim() || source.length > 2000 ||
        typeof value !== 'string' || !value.trim() || value.length > 1000) {
      throw new Error('Invalid dictionary entry');
    }
    dictionary[source] = value;
  }
  return dictionary;
}

function atomicJSON(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  let created = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try { unlinkSync(temporary); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

function previousCounts(runtimeDir, appVersion, appHash) {
  let knownCount = 0;
  let unknownCount = 0;
  try {
    const snapshot = readJSON(path.join(runtimeDir, 'snapshot.json'));
    if (snapshot.schema === 2 && snapshot.appVersion === appVersion && snapshot.appHash === appHash) {
      const dictionary = dictionaryFrom(snapshot.dictionary);
      if (snapshot.revision === digest(JSON.stringify(dictionary))) {
        knownCount = Object.keys(dictionary).length;
      }
    }
  } catch { /* A corrupt cache is not an input dictionary or an approval. */ }
  try {
    const status = readJSON(path.join(runtimeDir, 'status.json'));
    if (status.schema === 2 && status.appVersion === appVersion && isCount(status.unknownCount)) {
      unknownCount = status.unknownCount;
    }
  } catch { /* No previously persisted count available. */ }
  return { knownCount, unknownCount };
}

function validReport(report) {
  return isObject(report) && report.schema === 2 &&
    isCount(report.unknownCount) && isCount(report.mismatchCount) &&
    isVersion(report.appVersion) &&
    // The bridge has no revision when a missing/corrupt snapshot causes a mismatch.
    (isHash(report.revision) || (report.revision === '' && report.mismatchCount > 0)) &&
    typeof report.reportedAt === 'string' && Number.isFinite(Date.parse(report.reportedAt));
}

/**
 * Rebuild the offline curated dictionary, returning the persisted status.
 * appVersion/appHash are the actual installed identity, supplied by a trusted
 * caller (the CLI reads them itself). This function never grants approval.
 * Missing/mismatched approval => unsupported; missing overrides => needs-index;
 * invalid inputs => error, with the previous snapshot left byte-for-byte intact.
 * A valid same-version report remains relevant across dictionary revisions:
 * rebuilding curated entries does not establish that unknown UI was translated.
 */
export function buildIndex({ runtimeDir = scriptDir, appVersion, appHash } = {}) {
  runtimeDir = path.resolve(runtimeDir);
  mkdirSync(runtimeDir, { recursive: true });
  const version = typeof appVersion === 'string' ? appVersion : '';
  const counts = previousCounts(runtimeDir, version, appHash);
  let mismatchCount = 0;
  let reportError = false;
  try {
    const report = optionalJSON(path.join(runtimeDir, 'renderer-report.json'));
    if (report !== undefined) {
      if (!validReport(report)) throw new Error('Invalid renderer report');
      if (report.appVersion === version) {
        // Read counts and identity only; never collect or copy renderer text.
        counts.unknownCount = report.unknownCount;
        mismatchCount = report.mismatchCount;
      }
    }
  } catch {
    reportError = true;
  }

  const finish = (state, message) => {
    const status = {
      schema: 2, state, message, ...counts, appVersion: version,
      updatedAt: new Date().toISOString()
    };
    atomicJSON(path.join(runtimeDir, 'status.json'), status);
    return status;
  };

  let approved;
  try {
    approved = readJSON(path.join(runtimeDir, 'approved-app.json'));
  } catch {
    return finish('unsupported', 'Installer approval is missing or invalid.');
  }
  if (!isObject(approved) || approved.schema !== 2 ||
      !isVersion(appVersion) || !isHash(appHash) ||
      approved.appVersion !== appVersion || approved.appHash !== appHash) {
    return finish('unsupported', 'Installed app version or ASAR hash is not approved.');
  }
  if (reportError) {
    return finish('error', 'Renderer report is invalid; previous snapshot preserved.');
  }

  let dictionary;
  try {
    const input = optionalJSON(path.join(runtimeDir, 'overrides.json'));
    if (input === undefined) {
      return finish('needs-index', 'Curated overrides are missing; previous snapshot preserved.');
    }
    // Persist bundled UI translations independently of user-maintained overrides.
    // Explicit overrides win; malformed supplements never replace a valid snapshot.
    const merged = Object.create(null);
    for (const name of ['native-overrides.json', 'web-overrides.json']) {
      const supplement = optionalJSON(path.join(runtimeDir, name));
      if (supplement !== undefined) Object.assign(merged, dictionaryFrom(supplement));
    }
    Object.assign(merged, dictionaryFrom(input));
    dictionary = dictionaryFrom(merged);
  } catch {
    return finish('error', 'Curated overrides are invalid; previous snapshot preserved.');
  }

  const snapshot = {
    schema: 2,
    revision: digest(JSON.stringify(dictionary)),
    appVersion,
    appHash,
    dictionary,
    builtAt: new Date().toISOString()
  };
  // Match the bridge's read cap, including atomicJSON's indentation and newline.
  if (Buffer.byteLength(`${JSON.stringify(snapshot, null, 2)}\n`) > 2_000_000) {
    return finish('error', 'Dictionary snapshot exceeds 2,000,000 bytes; previous snapshot preserved.');
  }
  try {
    atomicJSON(path.join(runtimeDir, 'snapshot.json'), snapshot);
  } catch {
    return finish('error', 'Unable to publish dictionary snapshot.');
  }
  counts.knownCount = Object.keys(dictionary).length;
  return counts.unknownCount > 0 || mismatchCount > 0
    ? finish('needs-index', 'Curated dictionary rebuilt; renderer still reports unknown or mismatched UI.')
    : finish('ready', 'Curated dictionary is ready.');
}

function parseArgs(args) {
  const options = { runtimeDir: scriptDir, app: '/Applications/Claude.app' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error('Duplicate argument');
    seen.add(flag);
    if (flag === '--rebuild') continue;
    if (flag !== '--runtime' && flag !== '--app') throw new Error('Unknown argument');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing argument value');
    options[flag === '--runtime' ? 'runtimeDir' : 'app'] = path.resolve(value);
  }
  if (!seen.has('--rebuild')) throw new Error('Missing --rebuild');
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    console.error('Usage: node index.mjs --rebuild [--runtime PATH] [--app PATH]');
    process.exitCode = 2;
    return;
  }
  let appVersion = '';
  let appHash = '';
  try {
    const { stdout } = await promisify(execFile)('/usr/libexec/PlistBuddy', [
      '-c', 'Print :CFBundleShortVersionString', path.join(options.app, 'Contents', 'Info.plist')
    ], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    appVersion = stdout.trim();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(options.app, 'Contents', 'Resources', 'app.asar'))) {
      hash.update(chunk);
    }
    appHash = hash.digest('hex');
  } catch {
    // An unreadable identity cannot authorize a build, even with an old approval.
  }
  const status = buildIndex({ runtimeDir: options.runtimeDir, appVersion, appHash });
  console.log(JSON.stringify(status));
  process.exitCode = status.state === 'error' || status.state === 'unsupported' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Unable to persist index status.');
    process.exitCode = 1;
  });
}
