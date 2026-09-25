/**
 * Public GitHub releases, stage ONLY. No credentials, shell, install or App access.
 *
 * Parent contract (trusted local JSON, never release-supplied):
 * { repository:"OWNER/CONFIRMED-REPO", currentVersion:"1.0.0",
 *   allowedFiles:["runtime/index.mjs","helper/ClaudeTW"], stageRoot:"/private/stage",
 *   assetName?:"ClaudeTW-runtime.tar.gz", manifestName?:"ClaudeTW.manifest.json",
 *   timeoutMs?:10000, downloadTimeoutMs?:60000, maxAssetBytes?:67108864,
 *   maxExpandedBytes?:134217728 }
 * stageRoot must already exist, be canonical, owned by this uid and mode 0700.
 * CLI: node claude-tw/update.mjs --check|--stage --config /trusted/config.json
 *
 * Manifest: {schema:1,packageType:"claudetw-runtime",tag:"v1.1.0",
 *   archive:{name:"ClaudeTW-runtime.tar.gz",size:123,sha256:"<64 hex>"},
 *   files:[{path:"runtime/index.mjs",size:42,sha256:"<64 hex>",mode:"644"}]}
 * Every allowedFiles entry is required. Modes: 644/755. Archive: gzip POSIX
 * ustar, regular files + optional parent directories only (no PAX/GNU extensions,
 * links, bundles, scripts executed, or implicit/unlisted payloads).
 *
 * OS design references (read-only):
 * App/Sources/Tatwo2/Facade/GitHubReleaseUpdateChecker.swift:
 *   ReleaseVersionCompare, public latest request (no credentials).
 * App/Sources/Tatwo2/Facade/InAppUpdater.swift: checksum/manifest size gates.
 * scripts/per-file-delta.py: schema/tag/files + path/size/sha256/octal mode.
 * Deliberate differences: strict 3-part SemVer; tar subset, not official App zip;
 * no install-ready/adopt flow. HTTPS repository trust is NOT a signing key;
 * manifest + GitHub digest cannot protect against a compromised publisher.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { lstat, realpath, mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MiB = 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const CDN = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const fail = (message) => { throw new Error(message); };
const requireThat = (condition, message) => { if (!condition) fail(message); };
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseVersion(raw) {
  requireThat(typeof raw === 'string' && raw.length <= 256, 'Invalid SemVer');
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(raw);
  requireThat(match, 'Invalid SemVer');
  const pre = match[4]?.split('.') ?? [];
  requireThat(pre.every((id) => !/^\d+$/.test(id) || !/^0\d/.test(id)), 'Invalid SemVer prerelease');
  return { core: match.slice(1, 4), pre };
}

const numericCompare = (a, b) => a.length === b.length ? (a === b ? 0 : a < b ? -1 : 1) : a.length < b.length ? -1 : 1;
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const n = numericCompare(x.core[i], y.core[i]);
    if (n) return n;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    return pn && qn ? numericCompare(p, q) : pn !== qn ? (pn ? -1 : 1) : p < q ? -1 : 1;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

export function safePayloadPath(name) {
  requireThat(typeof name === 'string' && name.length <= 240, 'Unsafe payload path');
  const parts = name.split('/');
  requireThat(parts.length >= 2 && ['runtime', 'helper'].includes(parts[0]) &&
    parts.every((part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) &&
      !/\.(app|asar|dmg|pkg)$/i.test(part)), 'Unsafe payload path');
  return name;
}

export function validateConfig(input) {
  requireThat(input && typeof input === 'object', 'Trusted config required');
  requireThat(typeof input.repository === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.repository), 'Explicit trusted repository required');
  parseVersion(input.currentVersion);
  requireThat(Array.isArray(input.allowedFiles) && input.allowedFiles.length > 0 && input.allowedFiles.length <= 512, 'Explicit allowedFiles required');
  const allowedFiles = input.allowedFiles.map(safePayloadPath);
  const folded = allowedFiles.map((name) => name.toLowerCase());
  requireThat(new Set(folded).size === folded.length, 'Duplicate allowed path');
  requireThat(!folded.some((name) => folded.some((other) => name.startsWith(`${other}/`))), 'File/directory path conflict');
  const c = {
    ...input, allowedFiles,
    assetName: input.assetName ?? 'ClaudeTW-runtime.tar.gz',
    manifestName: input.manifestName ?? 'ClaudeTW.manifest.json',
    timeoutMs: input.timeoutMs ?? 10_000,
    downloadTimeoutMs: input.downloadTimeoutMs ?? 60_000,
    maxAssetBytes: input.maxAssetBytes ?? 64 * MiB,
    maxExpandedBytes: input.maxExpandedBytes ?? 128 * MiB,
  };
  requireThat(typeof c.assetName === 'string' && typeof c.manifestName === 'string' &&
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.tar\.gz$/.test(c.assetName) &&
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(c.manifestName), 'Invalid asset name');
  for (const [key, max] of [['timeoutMs', 30_000], ['downloadTimeoutMs', 300_000],
    ['maxAssetBytes', 128 * MiB], ['maxExpandedBytes', 256 * MiB]]) {
    requireThat(integer(c[key], 1, max), `Invalid ${key}`);
  }
  return c;
}

function baseURL(raw) {
  requireThat(typeof raw === 'string' && raw.length < 8192 && !/[\s\\]/.test(raw), 'Unsafe URL');
  const u = new URL(raw);
  requireThat(u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash, 'Unsafe URL');
  return u;
}

/** Initial download URL must bind repository/tag/name; only redirects may use CDN. */
export function validateDownloadURL(raw, config, tag, name, redirect = false) {
  const u = baseURL(raw);
  const expected = `https://github.com/${config.repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  requireThat(raw === expected || (redirect && CDN.has(u.hostname)), 'Download URL outside trusted release');
  return u.href;
}

async function deadline(ms, operation) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Update request timed out')); }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function fetchBytes(url, { fetchImpl, signal, maxBytes, validateURL, allow404 = false,
  accept = 'application/octet-stream' }) {
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    validateURL(url, redirects > 0);
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
      headers: { Accept: accept, 'User-Agent': 'ClaudeTW-Updater' },
    });
    signal.throwIfAborted();
    requireThat(!response.redirected, 'Transport followed an unchecked redirect');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      requireThat(location && redirects < 4, 'Invalid or excessive redirects');
      url = new URL(location, url).href;
      continue;
    }
    if (response.status === 404 && allow404) { await response.body?.cancel(); return null; }
    if (response.status !== 200) { await response.body?.cancel(); fail(`GitHub HTTP ${response.status}`); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || !integer(Number(length), 0, maxBytes))) {
      await response.body?.cancel();
      fail('Download exceeds size limit');
    }
    const chunks = [];
    let size = 0;
    requireThat(response.body, 'Missing response body');
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.length;
      requireThat(size <= maxBytes, 'Download exceeds size limit');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  }
}

function assetDigest(asset) {
  if (asset.digest === undefined || asset.digest === null) return null;
  requireThat(typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest), 'Invalid GitHub asset digest');
  return asset.digest.slice(7);
}

function selectAsset(release, name, c, limit) {
  const matches = release.assets.filter((a) => a?.name === name);
  requireThat(matches.length === 1, 'Missing or duplicate release asset');
  const a = matches[0];
  requireThat(a.state === 'uploaded' && integer(a.id, 1, Number.MAX_SAFE_INTEGER) &&
    integer(a.size, 1, limit), 'Invalid release asset');
  validateDownloadURL(a.browser_download_url, c, release.tag_name, name);
  assetDigest(a);
  return { id: a.id, name, size: a.size, digest: a.digest ?? null, browser_download_url: a.browser_download_url };
}

export function verifyAsset(bytes, asset, expectedHash) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length === asset.size, 'Asset size mismatch');
  const actual = sha256(bytes), github = assetDigest(asset);
  if (expectedHash !== undefined) requireThat(SHA.test(expectedHash) && actual === expectedHash, 'Manifest asset SHA256 mismatch');
  if (github) requireThat(actual === github, 'GitHub asset SHA256 mismatch');
  return actual;
}

export function validateManifest(m, c, tag, asset) {
  requireThat(m?.schema === 1 && m.packageType === 'claudetw-runtime' && m.tag === tag, 'Manifest identity mismatch');
  requireThat(m.archive?.name === c.assetName && m.archive.name === asset.name && m.archive.size === asset.size &&
    typeof m.archive.sha256 === 'string' && SHA.test(m.archive.sha256), 'Invalid manifest archive');
  const github = assetDigest(asset);
  requireThat(!github || github === m.archive.sha256, 'Manifest/GitHub digest disagreement');
  requireThat(Array.isArray(m.files) && m.files.length === c.allowedFiles.length, 'Manifest file set mismatch');
  const allowed = new Set(c.allowedFiles), seen = new Set();
  let expanded = 0;
  for (const f of m.files) {
    safePayloadPath(f?.path);
    requireThat(Object.keys(f).sort().join(',') === 'mode,path,sha256,size', 'Unexpected manifest file fields');
    requireThat(allowed.has(f.path) && !seen.has(f.path), 'Unexpected or duplicate manifest file');
    requireThat(integer(f.size, 0, c.maxExpandedBytes) && typeof f.sha256 === 'string' && SHA.test(f.sha256) &&
      ['644', '755'].includes(f.mode), 'Invalid manifest file');
    seen.add(f.path);
    expanded += f.size;
    requireThat(expanded <= c.maxExpandedBytes, 'Expanded size exceeds limit');
  }
  return m;
}

export async function checkForUpdate(config, { fetchImpl = globalThis.fetch } = {}) {
  const c = validateConfig(config);
  return deadline(c.timeoutMs, async (signal) => {
    const api = `https://api.github.com/repos/${c.repository}/releases/latest`;
    const bytes = await fetchBytes(api, { fetchImpl, signal, maxBytes: 2 * MiB, allow404: true,
      accept: 'application/vnd.github+json',
      validateURL: (url) => { requireThat(url === api, 'Unexpected API redirect'); baseURL(url); } });
    if (!bytes) return { status: 'no-release', installed: false };
    const release = JSON.parse(bytes.toString('utf8'));
    requireThat(release.draft === false && release.prerelease === false &&
      integer(release.id, 1, Number.MAX_SAFE_INTEGER) && Array.isArray(release.assets), 'Invalid stable release');
    requireThat(parseVersion(release.tag_name).pre.length === 0, 'Prerelease is not a stable update');
    if (compareVersions(release.tag_name, c.currentVersion) <= 0) return { status: 'up-to-date', version: c.currentVersion, installed: false };
    const asset = selectAsset(release, c.assetName, c, c.maxAssetBytes);
    const manifestAsset = selectAsset(release, c.manifestName, c, MiB);
    const raw = await fetchBytes(manifestAsset.browser_download_url, { fetchImpl, signal, maxBytes: manifestAsset.size,
      validateURL: (url, redirect) => validateDownloadURL(url, c, release.tag_name, c.manifestName, redirect) });
    const manifestSha256 = verifyAsset(raw, manifestAsset);
    const manifest = validateManifest(JSON.parse(raw.toString('utf8')), c, release.tag_name, asset);
    return { status: 'update-available', installed: false, repository: c.repository,
      version: release.tag_name, releaseId: release.id, asset, manifest, manifestSha256 };
  });
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  requireThat(end < 0 || bytes.subarray(end).every((n) => n === 0), 'Invalid tar string padding');
  const value = bytes.subarray(0, end < 0 ? bytes.length : end);
  requireThat(value.every((n) => n >= 32 && n < 127), 'Invalid tar string');
  return value.toString('ascii');
}
function tarNumber(bytes) {
  const text = bytes.toString('ascii');
  requireThat(/^[0-7]+[\0 ]*$/.test(text), 'Invalid tar number');
  const value = Number.parseInt(text, 8);
  requireThat(Number.isSafeInteger(value), 'Invalid tar number');
  return value;
}

/** Validate the entire bounded archive BEFORE creating any output file. */
export function validateArchive(compressed, manifest, config) {
  const c = validateConfig(config);
  validateManifest(manifest, c, manifest.tag, { ...manifest.archive, digest: null });
  requireThat(Buffer.isBuffer(compressed) && compressed.length <= c.maxAssetBytes &&
    compressed.length === manifest.archive.size && sha256(compressed) === manifest.archive.sha256, 'Archive SHA256/size mismatch');
  // Headers, parent dirs and block padding have a separate small bounded budget.
  const tar = gunzipSync(compressed, { maxOutputLength: c.maxExpandedBytes + 2 * MiB });
  requireThat(tar.length % 512 === 0, 'Truncated tar');
  const expected = new Map(manifest.files.map((f) => [f.path, f]));
  const dirs = new Set();
  for (const name of expected.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const seen = new Set(), foldedDirs = new Map(), files = [];
  for (const name of dirs) {
    const folded = name.toLowerCase();
    requireThat(!foldedDirs.has(folded) || foldedDirs.get(folded) === name, 'Case-colliding directory');
    foldedDirs.set(folded, name);
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((n) => n === 0)) {
      requireThat(tar.length - offset >= 1024 && tar.subarray(offset).every((n) => n === 0), 'Invalid tar terminator');
      requireThat(files.length === expected.size, 'Missing archive files');
      return files;
    }
    requireThat(seen.size < 2048, 'Too many archive entries');
    requireThat(h.subarray(257, 263).equals(Buffer.from('ustar\0')) &&
      h.subarray(263, 265).equals(Buffer.from('00')), 'Only POSIX ustar supported');
    const sum = h.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    requireThat(tarNumber(h.subarray(148, 156)) === sum, 'Tar header checksum mismatch');
    const prefix = tarString(h.subarray(345, 500)), leaf = tarString(h.subarray(0, 100));
    let name = prefix ? `${prefix}/${leaf}` : leaf;
    const type = h[156], directory = type === 53;
    requireThat(type === 0 || type === 48 || directory, 'Links/special tar entries forbidden');
    requireThat(tarString(h.subarray(157, 257)) === '', 'Tar link forbidden');
    if (directory && name.endsWith('/')) name = name.slice(0, -1);
    requireThat(!seen.has(name.toLowerCase()), 'Duplicate archive path');
    seen.add(name.toLowerCase());
    const size = tarNumber(h.subarray(124, 136)), mode = tarNumber(h.subarray(100, 108));
    requireThat(size <= c.maxExpandedBytes && (mode === 0o644 || mode === 0o755), 'Invalid tar size/mode');
    const start = offset + 512, end = start + size, next = start + Math.ceil(size / 512) * 512;
    requireThat(next <= tar.length && tar.subarray(end, next).every((n) => n === 0), 'Truncated tar or nonzero padding');
    if (directory) {
      requireThat(dirs.has(name) && size === 0 && mode === 0o755, 'Unexpected archive directory');
    } else {
      safePayloadPath(name);
      const record = expected.get(name), bytes = tar.subarray(start, end);
      requireThat(record && record.size === size && Number.parseInt(record.mode, 8) === mode &&
        record.sha256 === sha256(bytes), 'Unexpected file or file integrity mismatch');
      files.push({ ...record, bytes });
    }
    offset = next;
  }
  fail('Missing tar terminator');
}

async function stageRoot(root) {
  requireThat(typeof root === 'string' && path.isAbsolute(root) &&
    !root.split(path.sep).some((part) => /\.app$/i.test(part)), 'Explicit non-App stageRoot required');
  const resolved = path.resolve(root), info = await lstat(resolved);
  requireThat(info.isDirectory() && !info.isSymbolicLink() && await realpath(resolved) === resolved &&
    info.uid === process.getuid() && (info.mode & 0o077) === 0, 'stageRoot must be canonical, owner-only directory');
  return resolved;
}

export async function stageUpdate(config, dependencies = {}) {
  const c = validateConfig(config), root = await stageRoot(c.stageRoot);
  // Never trust a cached check result supplied by the caller.
  const check = await checkForUpdate(c, dependencies);
  if (check.status !== 'update-available') return check;
  const compressed = await deadline(c.downloadTimeoutMs, (signal) => fetchBytes(check.asset.browser_download_url, {
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch, signal, maxBytes: check.asset.size,
    validateURL: (url, redirect) => validateDownloadURL(url, c, check.version, c.assetName, redirect),
  }));
  verifyAsset(compressed, check.asset, check.manifest.archive.sha256);
  const files = validateArchive(compressed, check.manifest, c);
  const folder = await mkdtemp(path.join(root, 'claudetw-stage-'));
  try {
    for (const file of files) {
      const destination = path.join(folder, file.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const mode = Number.parseInt(file.mode, 8);
      await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 });
      await chmod(destination, mode); // exact manifest mode, independent of process umask
      const info = await lstat(destination);
      requireThat(info.isFile() && info.size === file.size && (info.mode & 0o7777) === mode &&
        sha256(await readFile(destination)) === file.sha256, 'Staged file readback mismatch');
    }
    const receipt = { schema: 1, status: 'staged', installed: false, repository: c.repository,
      version: check.version, releaseId: check.releaseId, manifestSha256: check.manifestSha256,
      archiveSha256: check.manifest.archive.sha256, assetId: check.asset.id,
      githubDigest: check.asset.digest, files: check.manifest.files };
    // Commit marker LAST. Parent must reverify files and compatibility before adopt.
    await writeFile(path.join(folder, 'stage.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { ...receipt, stagePath: folder };
  } catch (error) {
    await rm(folder, { recursive: true, force: true }); // only our newly-created scratch tree
    throw error;
  }
}

export async function cli(args, dependencies = {}) {
  requireThat(args.length === 3 && ['--check', '--stage'].includes(args[0]) &&
    args[1] === '--config', 'Usage: update.mjs --check|--stage --config /trusted/config.json');
  const config = JSON.parse(await readFile(args[2], 'utf8'));
  return args[0] === '--check' ? checkForUpdate(config, dependencies) : stageUpdate(config, dependencies);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    // No response bodies, URLs, tokens, or headers in diagnostics.
    console.error(JSON.stringify({ status: 'error', installed: false,
      message: error instanceof SyntaxError ? 'Invalid update JSON' : error.message }));
    process.exitCode = 1;
  });
}
