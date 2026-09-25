import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  parseVersion, compareVersions, safePayloadPath, validateConfig, validateDownloadURL,
  sha256, verifyAsset, validateManifest, validateArchive, checkForUpdate, stageUpdate, cli,
} from '../claude-tw/update.mjs';

// All HTTP is injected: a missing fixture is an error, never a real fetch.
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error('Real network forbidden in updater tests'); }; });
test.after(() => { globalThis.fetch = originalFetch; });
const repository = 'test-owner/claudetw-fixture';
const root = path.resolve(import.meta.dirname, '..');
const defaults = {
  repository, currentVersion: '1.0.0', allowedFiles: ['runtime/index.mjs', 'helper/ClaudeTW'],
  timeoutMs: 1000, downloadTimeoutMs: 1000,
};
const payload = [
  { path: 'runtime/index.mjs', bytes: Buffer.from('export const fixture = true;\n'), mode: '644' },
  { path: 'helper/ClaudeTW', bytes: Buffer.from('not an executable: staged bytes only\n'), mode: '755' },
];

function tar(entries = payload, { terminator = true } = {}) {
  const chunks = [];
  for (const f of entries) {
    const h = Buffer.alloc(512), bytes = f.bytes ?? Buffer.alloc(0);
    h.write(f.path, 0, 100);
    h.write(`${(f.mode ?? '644').padStart(7, '0')}\0`, 100, 8);
    h.write('0000000\0', 108, 8); h.write('0000000\0', 116, 8);
    h.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    h.write('00000000000\0', 136, 12);
    h.fill(32, 148, 156); h[156] = (f.type ?? '0').charCodeAt(0);
    if (f.link) h.write(f.link, 157, 100);
    h.write('ustar\0', 257, 6); h.write('00', 263, 2);
    if (f.prefix) h.write(f.prefix, 345, 155);
    const sum = h.reduce((a, n) => a + n, 0);
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    chunks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  if (terminator) chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function fixture({ entries = payload, tag = 'v1.1.0', rawTar, config = {} } = {}) {
  const compressed = gzipSync(rawTar ?? tar(entries));
  const c = validateConfig({ ...defaults, ...config });
  const manifest = {
    schema: 1, packageType: 'claudetw-runtime', tag,
    archive: { name: c.assetName, size: compressed.length, sha256: sha256(compressed) },
    files: payload.map(({ path, bytes, mode }) => ({ path, size: bytes.length, mode, sha256: sha256(bytes) })),
  };
  const downloadURL = (name) => `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`;
  const asset = (name, bytes, id) => ({ name, id, state: 'uploaded', size: bytes.length,
    digest: `sha256:${sha256(bytes)}`, browser_download_url: downloadURL(name) });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const release = { id: 123, tag_name: tag, draft: false, prerelease: false,
    assets: [asset(c.assetName, compressed, 1), asset(c.manifestName, manifestBytes, 2)] };
  const api = `https://api.github.com/repos/${repository}/releases/latest`;
  const routes = new Map([
    [api, () => new Response(JSON.stringify(release))],
    [downloadURL(c.manifestName), () => new Response(manifestBytes)],
    [downloadURL(c.assetName), () => new Response(compressed)],
  ]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.method, 'GET');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
    assert.equal(options.headers.Accept, url === api ? 'application/vnd.github+json' : 'application/octet-stream');
    assert.ok(options.signal instanceof AbortSignal);
    const route = routes.get(url);
    assert.ok(route, `Unmocked HTTP request: ${url}`);
    return route();
  };
  return { c, compressed, manifest, release, api, routes, calls, fetchImpl, downloadURL };
}

async function scratch(t) {
  // Test scratch stays in this workroom, never App/profile/system temp directories.
  const directory = await mkdtemp(path.join(root, '.update-test-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('SemVer: stable/prerelease precedence, build ignored, no numeric overflow', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta',
    '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1);
    assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1);
  }
  assert.equal(compareVersions('v1.0.0+build.2', '1.0.0+build.99'), 0);
  assert.equal(compareVersions('9999999999999999999999.0.0', '999999999999999999999.0.0'), 1);
  assert.equal(compareVersions('1.0.0-9999999999999999999999', '1.0.0-999999999999999999999'), 1);
});

test('SemVer rejects malformed, leading zero, whitespace and non-3-part input', () => {
  for (const text of ['', 'v', 'latest', '1.2', '1.2.3.4', '01.2.3', '1.2.3-01', '1.2.3-',
    '1.2.3+', '1.2.3+a+b', ' 1.2.3', '1.2.3\n', '1.2.3-rc..1', null]) {
    assert.throws(() => parseVersion(text), /SemVer/);
  }
});

test('trusted config required; no guessed repository or unbounded resource knobs', () => {
  for (const changes of [{ repository: undefined }, { repository: '../repo' }, { repository: 'a/b/c' },
    { allowedFiles: [] }, { allowedFiles: ['runtime/a', 'runtime/A'] },
    { allowedFiles: ['runtime/a', 'runtime/A/b'] }, { timeoutMs: Infinity },
    { maxAssetBytes: 129 * 1024 * 1024 }, { maxExpandedBytes: -1 },
    { manifestName: '../manifest.json' }, { assetName: 'Claude.app.zip' }]) {
    assert.throws(() => validateConfig({ ...defaults, ...changes }));
  }
});

test('payload paths reject traversal, bundles, encodings, hidden names and ambiguous separators', () => {
  for (const name of ['/runtime/a', '../runtime/a', 'runtime/../a', 'runtime//a', 'runtime/./a',
    'runtime/a\\b', 'runtime/%2e%2e/a', 'runtime/a\0b', 'runtime/.hidden',
    'runtime/Claude.app/a', 'runtime/app.asar', 'runtime/a.pkg', 'other/a', 'runtime/é.js']) {
    assert.throws(() => safePayloadPath(name), /Unsafe/);
  }
  assert.equal(safePayloadPath('runtime/sub/file.mjs'), 'runtime/sub/file.mjs');
});

test('download origin/repository/tag/name bound; CDN only on HTTPS validated redirects', () => {
  const f = fixture(), good = f.downloadURL(f.c.assetName);
  assert.equal(validateDownloadURL(good, f.c, f.release.tag_name, f.c.assetName), good);
  for (const bad of [good.replace('https:', 'http:'), good.replace('github.com', 'github.com.evil.test'),
    good.replace(repository, 'other/repo'), good.replace('v1.1.0', 'v2.0.0'),
    good + '?token=x', good + '#x', good.replace('github.com', 'user:pass@github.com'),
    good.replace('github.com', 'github.com:444'), 'https://release-assets.githubusercontent.com/blob']) {
    assert.throws(() => validateDownloadURL(bad, f.c, f.release.tag_name, f.c.assetName));
  }
  assert.equal(validateDownloadURL('https://release-assets.githubusercontent.com/blob?sig=fixture',
    f.c, f.release.tag_name, f.c.assetName, true), 'https://release-assets.githubusercontent.com/blob?sig=fixture');
});

test('check validates manifest and digest but never downloads archive or stages', async () => {
  const f = fixture(), result = await checkForUpdate(f.c, f);
  assert.equal(result.status, 'update-available');
  assert.equal(result.installed, false);
  assert.equal(result.version, 'v1.1.0');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(result.manifest, f.manifest);
});

test('latest 404, same, older and prerelease-installed to stable have explicit statuses', async () => {
  const f = fixture();
  f.routes.set(f.api, () => new Response(null, { status: 404 }));
  assert.equal((await checkForUpdate(f.c, f)).status, 'no-release');
  for (const currentVersion of ['1.1.0', '1.1.0+new-build', '2.0.0']) {
    const x = fixture({ config: { currentVersion } });
    assert.equal((await checkForUpdate(x.c, x)).status, 'up-to-date');
    assert.equal(x.calls.length, 1);
  }
  const x = fixture({ config: { currentVersion: '1.1.0-rc.1' } });
  assert.equal((await checkForUpdate(x.c, x)).status, 'update-available');
});

test('draft, prerelease, malformed release and asset metadata fail closed', async () => {
  for (const mutate of [
    (r) => { r.draft = true; }, (r) => { r.prerelease = true; },
    (r) => { r.tag_name = '1.1.0-rc.1'; }, (r) => { r.id = null; },
    (r) => { r.assets.push(r.assets[0]); }, (r) => { r.assets.pop(); },
    (r) => { r.assets[0].state = 'new'; }, (r) => { r.assets[0].size = 0; },
    (r) => { r.assets[0].digest = 'md5:no'; },
    (r) => { r.assets[0].browser_download_url = 'https://evil.test/runtime.tar.gz'; },
  ]) {
    const f = fixture(); mutate(f.release);
    await assert.rejects(checkForUpdate(f.c, f));
  }
});

test('manifest/GitHub digests both checked; missing optional digest does not skip manifest hash', async () => {
  const f = fixture();
  f.release.assets.forEach((a) => { delete a.digest; });
  assert.equal((await checkForUpdate(f.c, f)).status, 'update-available');
  assert.throws(() => verifyAsset(f.compressed, f.release.assets[0], '0'.repeat(64)), /Manifest asset/);
  const g = fixture(); g.release.assets[1].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(checkForUpdate(g.c, g), /GitHub asset/);
  const h = fixture(); h.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(checkForUpdate(h.c, h), /disagreement/);
  assert.throws(() => verifyAsset(f.compressed.subarray(1), f.release.assets[0]), /size mismatch/);
});

test('manifest exact tag, package type, file allowlist, SHA, size, mode; links never accepted', () => {
  for (const mutate of [
    (m) => { m.tag = 'v9.0.0'; }, (m) => { m.packageType = 'official-claude'; },
    (m) => { m.archive.name = 'other.tar.gz'; }, (m) => { m.archive.sha256 = 'no'; },
    (m) => { m.files[0].path = 'runtime/unlisted.js'; },
    (m) => { m.files[1] = m.files[0]; }, (m) => { m.files.pop(); },
    (m) => { m.files[0].mode = '4755'; }, (m) => { m.files[0].size = -1; },
    (m) => { m.files[0].symlink = '/tmp'; }, (m) => { m.files[0].sha256 = 'no'; },
  ]) {
    const f = fixture(); mutate(f.manifest);
    assert.throws(() => validateManifest(f.manifest, f.c, f.release.tag_name, f.release.assets[0]));
  }
});

test('redirects are manual, credential-free, bounded; reject API moves and external hosts', async () => {
  const f = fixture(), source = f.downloadURL(f.c.manifestName);
  const cdn = 'https://release-assets.githubusercontent.com/fixture';
  f.routes.set(cdn, f.routes.get(source));
  f.routes.set(source, () => new Response(null, { status: 302, headers: { location: cdn } }));
  assert.equal((await checkForUpdate(f.c, f)).status, 'update-available');
  assert.equal(f.calls.length, 3);
  for (const target of ['https://evil.test/x', 'http://objects.githubusercontent.com/x',
    'https://u:p@objects.githubusercontent.com/x', 'https://raw.githubusercontent.com/x']) {
    const x = fixture();
    x.routes.set(source, () => new Response(null, { status: 302, headers: { location: target } }));
    await assert.rejects(checkForUpdate(x.c, x));
    assert.equal(x.calls.length, 2);
  }
  const moved = fixture();
  moved.routes.set(moved.api, () => new Response(null, { status: 301, headers: { location: 'https://api.github.com/repos/a/b/releases/latest' } }));
  await assert.rejects(checkForUpdate(moved.c, moved), /API redirect/);
  const loop = fixture();
  loop.routes.set(source, () => new Response(null, { status: 302, headers: { location: source } }));
  await assert.rejects(checkForUpdate(loop.c, loop), /redirects/);
});

test('latest timeout includes a fetch ignoring abort and a stalled body', async () => {
  const c = { ...defaults, timeoutMs: 15 };
  await assert.rejects(checkForUpdate(c, { fetchImpl: () => new Promise(() => {}) }), /timed out/);
  const body = new ReadableStream({ start() {} });
  await assert.rejects(checkForUpdate(c, { fetchImpl: async () => new Response(body) }), /timed out/);
});

test('reject oversized headers/streams, HTTP errors, malformed JSON and manifest truncation', async () => {
  for (const response of [
    () => new Response('x', { headers: { 'content-length': '9999999999999' } }),
    () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1)),
    () => new Response('rate limited', { status: 403 }),
    () => new Response('{broken'),
  ]) {
    const f = fixture(); f.routes.set(f.api, response);
    await assert.rejects(checkForUpdate(f.c, f));
  }
  const f = fixture(); f.routes.set(f.downloadURL(f.c.manifestName), () => new Response('{}'));
  await assert.rejects(checkForUpdate(f.c, f), /size mismatch/);
});

test('strict tar: valid regular files and optional parent directories', () => {
  const f = fixture({ entries: [
    { path: 'runtime/', type: '5', mode: '755' }, payload[0],
    { path: 'helper/', type: '5', mode: '755' }, payload[1],
  ] });
  const files = validateArchive(f.compressed, f.manifest, f.c);
  assert.deepEqual(files.map((x) => x.path), defaults.allowedFiles);
  assert.equal(files[0].bytes.toString(), payload[0].bytes.toString());
});

test('strict tar: traversal/prefix traversal, links, devices, PAX, GNU, unexpected/duplicate paths', () => {
  for (const extra of [
    { path: '../escaped' }, { path: '/absolute' }, { path: 'a', prefix: '../' },
    { path: 'runtime/index.mjs', type: '2', link: '/etc/passwd' },
    { path: 'runtime/index.mjs', type: '1', link: 'helper/ClaudeTW' },
    ...['3', '4', '6', 'x', 'g', 'L', 'K'].map((type) => ({ path: 'runtime/index.mjs', type })),
    { path: 'runtime/unexpected' }, { path: 'runtime/Claude.app/x' },
    { path: 'unused/', type: '5', mode: '755' }, payload[0],
  ]) {
    const f = fixture({ entries: [...payload, extra] });
    assert.throws(() => validateArchive(f.compressed, f.manifest, f.c));
  }
});

test('strict tar: missing files, changed bytes/mode, missing terminator, corrupt header/padding', () => {
  const damaged = tar(); damaged[0] ^= 1;
  const padding = tar(); padding[512 + payload[0].bytes.length] = 1;
  const tail = Buffer.concat([tar(), Buffer.from('not-zero'.padEnd(512, '\\0'))]);
  for (const options of [
    { entries: [payload[0]] },
    { entries: [{ ...payload[0], bytes: Buffer.from('changed') }, payload[1]] },
    { entries: [{ ...payload[0], mode: '755' }, payload[1]] },
    { rawTar: tar(payload, { terminator: false }) }, { rawTar: damaged }, { rawTar: padding },
    { rawTar: tail }, { rawTar: tar().subarray(0, -1) },
  ]) {
    const f = fixture(options);
    assert.throws(() => validateArchive(f.compressed, f.manifest, f.c));
  }
});

test('bounded decompression rejects gzip bombs and invalid gzip, even with matching archive SHA', () => {
  const bomb = fixture({ rawTar: Buffer.alloc(3 * 1024 * 1024), config: { maxExpandedBytes: 1024 } });
  assert.throws(() => validateArchive(bomb.compressed, bomb.manifest, bomb.c), /larger than/);
  const f = fixture(), bad = Buffer.from('not gzip');
  f.manifest.archive = { ...f.manifest.archive, size: bad.length, sha256: sha256(bad) };
  assert.throws(() => validateArchive(bad, f.manifest, f.c));
});

test('case-colliding parent directories rejected on case-insensitive macOS paths', () => {
  const f = fixture({ config: { allowedFiles: ['runtime/A/x', 'runtime/a/y'] } });
  f.manifest.files = f.manifest.files.map((file, i) => ({ ...file, path: f.c.allowedFiles[i] }));
  assert.throws(() => validateArchive(f.compressed, f.manifest, f.c), /Case-colliding directory/);
});

test('stage only: exact payload + commit receipt, readback verified, no fake installed', async (t) => {
  const stageRoot = await scratch(t), f = fixture({ config: { stageRoot } });
  const result = await stageUpdate(f.c, f);
  assert.equal(result.status, 'staged');
  assert.equal(result.installed, false);
  assert.equal(result.repository, repository);
  assert.ok(result.stagePath.startsWith(stageRoot + path.sep));
  const receipt = JSON.parse(await readFile(path.join(result.stagePath, 'stage.json')));
  assert.equal(receipt.archiveSha256, sha256(f.compressed));
  assert.equal(receipt.githubDigest, `sha256:${sha256(f.compressed)}`);
  assert.equal(receipt.assetId, 1);
  for (const p of payload) {
    assert.deepEqual(await readFile(path.join(result.stagePath, p.path)), p.bytes);
    assert.equal((await lstat(path.join(result.stagePath, p.path))).mode & 0o7777, Number.parseInt(p.mode, 8));
  }
  assert.equal((await lstat(result.stagePath)).mode & 0o077, 0);
  assert.deepEqual((await readdir(result.stagePath)).sort(), ['helper', 'runtime', 'stage.json']);
  assert.equal(f.calls.length, 3);
  // A repeat creates a distinct stage; never overwrites previous work.
  const second = await stageUpdate(f.c, f);
  assert.notEqual(second.stagePath, result.stagePath);
  assert.equal(JSON.parse(await readFile(path.join(result.stagePath, 'stage.json'))).status, 'staged');
});

test('unsafe stage roots refused before networking (symlink, writable, App, absent)', async (t) => {
  const stageRoot = await scratch(t), alias = path.join(stageRoot, 'alias');
  await symlink(stageRoot, alias);
  const world = path.join(stageRoot, 'world'); await mkdir(world); await chmod(world, 0o777);
  for (const name of [alias, world, path.join(stageRoot, 'Claude.app'), path.join(stageRoot, 'absent'), 'relative', undefined]) {
    const f = fixture({ config: { stageRoot: name } });
    await assert.rejects(stageUpdate(f.c, f));
    assert.equal(f.calls.length, 0);
  }
});

test('failed integrity/extraction and download timeout leave no stage/receipt', async (t) => {
  const stageRoot = await scratch(t);
  const bad = fixture({ entries: [...payload, { path: '../outside' }], config: { stageRoot } });
  await assert.rejects(stageUpdate(bad.c, bad));
  const changed = fixture({ config: { stageRoot } });
  changed.routes.set(changed.downloadURL(changed.c.assetName), () => new Response(Buffer.alloc(changed.compressed.length)));
  await assert.rejects(stageUpdate(changed.c, changed), /SHA256/);
  const slow = fixture({ config: { stageRoot, downloadTimeoutMs: 15 } });
  slow.routes.set(slow.downloadURL(slow.c.assetName), () => new Promise(() => {}));
  await assert.rejects(stageUpdate(slow.c, slow), /timed out/);
  assert.deepEqual(await readdir(stageRoot), []);
});

test('stage independently rechecks release and does not downgrade/create a stage', async (t) => {
  const stageRoot = await scratch(t), f = fixture({ config: { stageRoot } });
  assert.equal((await checkForUpdate(f.c, f)).status, 'update-available');
  f.release.tag_name = 'v0.9.0';
  assert.equal((await stageUpdate(f.c, f)).status, 'up-to-date');
  assert.deepEqual(await readdir(stageRoot), []);
  assert.equal(f.calls.length, 3);
});

test('CLI requires explicit runtime config and exposes check/stage without an install verb', async (t) => {
  const stageRoot = await scratch(t), f = fixture({ config: { stageRoot } });
  const configFile = path.join(stageRoot, 'config.json');
  await writeFile(configFile, JSON.stringify(f.c));
  assert.equal((await cli(['--check', '--config', configFile], f)).status, 'update-available');
  assert.equal((await cli(['--stage', '--config', configFile], f)).status, 'staged');
  for (const args of [[], ['--install'], ['--check'], ['--check', '--config', configFile, '--token=x']]) {
    await assert.rejects(cli(args, f), /Usage/);
  }
});
