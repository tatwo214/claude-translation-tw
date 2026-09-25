import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fetchCatalog, runCLI, LIMITS, discoverAssetDependencies, DEPENDENCY_LIMIT } from '../scripts/fetch-ui-catalog.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = n => `https://claude.ai/_next/static/chunks/${n}.js`;
const manifest = (urls = [url(1)]) => ({
  schema: 1, appVersion: '1.2.3', appHash: 'a'.repeat(64), assets: urls,
});
const js = text => `intl.formatMessage({defaultMessage:${JSON.stringify(text)},id:"fixture"});`;
const response = (source = js('Scheduled tasks'), options = {}) => new Response(source, {
  headers: { 'content-type': 'application/javascript; charset=utf-8' }, ...options,
});
const fixtureFetch = source => async () => response(source);
const errorOf = result => result.results[0].error;
const assetBase = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/';
const assetEntry = `${assetBase}index-DnA32MeC.js`;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, 'tests/.fetch-catalog-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'manifest.json'), output = path.join(dir, 'catalog.json');
  fs.writeFileSync(input, JSON.stringify(manifest()));
  return { dir, input, output, args: ['--manifest', input, '--output', output] };
}

test('public GET only, aggregates candidates/provenance and preserves unsupported ICU', async () => {
  const urls = [url(1), 'https://claude.com/_next/static/chunks/other.js'];
  const calls = [];
  const result = await fetchCatalog(manifest(urls), {
    fetchImpl: async (address, options) => {
      calls.push(address);
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.referrer, '');
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.deepEqual(Object.keys(options.headers), ['Accept']);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.body, undefined);
      return response(js('Scheduled tasks') + js('Hello {name}'));
    },
  });
  assert.deepEqual(calls, urls);
  assert.equal(result.complete, true);
  assert.equal(result.summary.complete, true);
  assert.equal(result.summary.succeeded, 2);
  assert.equal(result.catalog.messages.length, 1);
  assert.deepEqual(result.catalog.messages[0].sources.map(s => s.file), urls);
  assert.equal(result.catalog.unsupported[0].text, 'Hello {name}');
  assert.equal(result.catalog.unsupported[0].reason, 'icu-or-braced-message');
  assert.equal(JSON.stringify(result).includes('intl.formatMessage'), false);
});

test('invalid manifest/identities and ANY malicious URL fail before first request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error('must not fetch'); };
  const malicious = [
    'https://example.com/_next/static/a.js',
    'http://claude.ai/_next/static/a.js',
    'https://claude.ai/api/account',
    'https://claude.ai/_next/static/a.js?token=secret',
    'https://claude.ai/_next/static/a.js#fragment',
    'https://user:pass@claude.ai/_next/static/a.js',
    'https://claude.ai/_next/static/../a.js',
    'https://claude.ai/_next/static/%61.js',
    'https://claude.ai/_next/static/a.json',
    'https://claude.ai.evil.test/_next/static/a.js',
    'file:///tmp/asset.js', '//claude.ai/_next/static/a.js', null,
  ];
  for (const bad of malicious) {
    await assert.rejects(fetchCatalog(manifest([url(1), bad]), { fetchImpl }), /Invalid asset URL/);
  }
  for (const bad of [
    null, {}, { ...manifest(), schema: 2 }, { ...manifest(), appHash: 'x' },
    { ...manifest(), appVersion: '' }, { ...manifest(), appVersion: '1\nCookie:x' },
    manifest([]), manifest(Array.from({ length: 257 }, (_, i) => url(i))),
    manifest([url(1), url(1)]), manifest(new Array(2)),
  ]) await assert.rejects(fetchCatalog(bad, { fetchImpl }));
  assert.equal(calls, 0);
});

test('observed Vite entry uses shared allowlist without fetching imports or broadening extraction', async () => {
  const entry = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-DnA32MeC.js';
  const calls = [];
  // Synthetic contents, NOT a copy or assertion about the real entry's format.
  const source = `
    import {fixture} from "./fixture-dependency.js";
    const ordinary = "Literal UI outside descriptors";
    const literalUI = "Another unrecognized literal UI";
    const message = {defaultMessage:"Fixture UI message",id:"fixture-message"};
    export {message, fixture, ordinary, literalUI};
  `;
  const result = await fetchCatalog(manifest([entry]), {
    fetchImpl: async (address, options) => {
      calls.push(address);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      return response(source);
    },
  });
  assert.deepEqual(calls, [entry]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.catalog.messages.map(item => item.text), ['Fixture UI message']);
  assert.equal(result.catalog.messages[0].sources[0].file, entry);
  assert.equal(result.catalog.scope, 'static-defaultMessage-properties-only');
});

test('observed asset origin does not admit query, account, alternate paths or lookalike hosts', async () => {
  const base = 'https://assets-proxy.anthropic.com';
  const entry = `${base}/claude-ai/v2/assets/v1/index-DnA32MeC.js`;
  const badURLs = [
    `${entry}?v=1`, `${entry}#fragment`, `${entry}.map`,
    `${base}/api/account`, `${base}/_next/static/index.js`,
    `${base}/claude-ai/v2/assets/v2/index.js`,
    `${base}/claude-ai/v2/assets/v1/nested/index.js`,
    `${base}/claude-ai/v2/assets/v1/../index.js`,
    `${base}/claude-ai/v2/assets/v1/%69ndex.js`,
    entry.replace('https:', 'http:'),
    entry.replace('assets-proxy.anthropic.com', 'assets-proxy.anthropic.com.evil.test'),
    entry.replace('https://', 'https://user:password@'),
  ];
  for (const bad of badURLs) {
    await assert.rejects(fetchCatalog(manifest([entry, bad]), {
      fetchImpl: () => assert.fail('whole manifest must be checked before fetching'),
    }), /Invalid asset URL/);
  }
});

test('only lower limits are allowed, validated before requests', async () => {
  assert.deepEqual(LIMITS, { maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxFiles: 256, timeoutMs: 15000 });
  const fetchImpl = () => assert.fail('must not request');
  for (const options of [
    { maxFileBytes: LIMITS.maxFileBytes + 1 }, { maxTotalBytes: Infinity },
    { timeoutMs: 15001 }, { maxFiles: 257 }, { timeoutMs: 0 },
    { headers: { Cookie: 'x' } }, { extractorLimits: { maxTokens: 0 } },
  ]) await assert.rejects(fetchCatalog(manifest(), { fetchImpl, ...options }), /Invalid limit/);
});

test('redirect options plus defensive redirect, final URL, and HTTP checks', async () => {
  const fixtures = [
    new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
    { ...{}, status: 200, redirected: true },
    { status: 200, url: 'https://evil.test/x.js' },
    response('error', { status: 404 }),
  ];
  for (const value of fixtures) {
    const result = await fetchCatalog(manifest(), { fetchImpl: async () => value });
    assert.equal(result.complete, false);
    assert.match(errorOf(result), /redirect-rejected|http-status/);
  }
  const rejected = await fetchCatalog(manifest(), {
    fetchImpl: async () => { throw new Error('redirect secret cookie'); },
  });
  assert.equal(errorOf(rejected), 'fetch-or-stream-error');
  assert.equal(JSON.stringify(rejected).includes('secret'), false);
});

test('rejects HTML, JSON, binary, missing/wrong MIME and non-UTF8', async () => {
  for (const value of [
    response('<html>Login</html>'),
    response('\uFEFF  <!DOCTYPE html><html>Login</html>'),
    response('<?xml version="1.0"?>'),
    response('{"account":"private"}'), response('[1,2]'), response('x\0x'),
    response(new Uint8Array([0xff, 0xfe, 0xfd])),
    response(js('Hello'), { headers: { 'content-type': 'text/html' } }),
    response(js('Hello'), { headers: { 'content-type': 'application/json' } }),
    response(js('Hello'), { headers: {} }),
    response(js('Hello'), { headers: { 'content-type': 'text/javascript; charset=latin1' } }),
    response(''),
  ]) {
    const result = await fetchCatalog(manifest(), { fetchImpl: async () => value });
    assert.equal(result.complete, false);
    assert.equal(result.catalog, null);
    assert.equal(result.summary.failed, 1);
  }
});

test('raw non-NUL controls in static JS strings and regexps do not mark the bundle as binary', async () => {
  // Synthetic delimiters/regexp, not copied asset contents; never evaluated.
  // These are actual control characters in the response, not backslash escapes.
  const source = [
    'const delimiter = "\u0001";',
    'const separator = \'\u001f\';',
    'const terminalControl = "\u0004";',
    'const pattern = /[\u0001-\u0008\u000e-\u001f]/g;',
    js('Fixture control character bundle'),
  ].join('\n');
  const result = await fetchCatalog(manifest(), { fetchImpl: fixtureFetch(source) });
  assert.equal(result.complete, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].bytesRead, Buffer.byteLength(source));
  assert.deepEqual(result.catalog.messages.map(item => item.text), ['Fixture control character bundle']);
  assert.deepEqual(result.catalog.files[0].diagnostics, []);
});

test('control-byte fix retains HTML, leading-control, NUL and fatal UTF-8 refusal', async () => {
  for (const source of [
    '\u0001<html>Login</html>',
    '\uFEFF \u001f<!DOCTYPE html><html>Login</html>',
    '\u0004' + js('Not accepted'),
    '<html>\u0004Login</html>',
    js('Hello') + '\0',
    'const s = "\0";' + js('Conservative NUL rejection'),
  ]) {
    const result = await fetchCatalog(manifest(), { fetchImpl: fixtureFetch(source) });
    assert.equal(errorOf(result), 'non-javascript-body');
    assert.equal(result.complete, false);
    assert.equal(result.catalog, null);
  }
  const invalid = await fetchCatalog(manifest(), {
    fetchImpl: fixtureFetch(Buffer.concat([Buffer.from('const s = "\u0004";'), Buffer.from([0xc3, 0x28])])),
  });
  assert.equal(errorOf(invalid), 'invalid-utf8');
  assert.equal(invalid.complete, false);
});

test('bounded decoded streaming bytes, not compressed Content-Length; cancels excess', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(32)); c.enqueue(new Uint8Array(33)); },
    cancel() { cancelled = true; },
  });
  const result = await fetchCatalog(manifest(), {
    maxFileBytes: 64,
    fetchImpl: async () => response(stream, {
      headers: { 'content-type': 'text/javascript', 'content-encoding': 'gzip', 'content-length': '1' },
    }),
  });
  assert.equal(errorOf(result), 'file-byte-limit');
  assert.equal(result.summary.bytesRead, 65);
  assert.equal(cancelled, true);
});

test('exact byte limit accepted with multibyte UTF-8 and chunk boundaries', async () => {
  const body = Buffer.from(js('Hello café'));
  let i = 0;
  const result = await fetchCatalog(manifest(), {
    maxFileBytes: body.length, maxTotalBytes: body.length,
    fetchImpl: async () => response(new ReadableStream({
      pull(c) { if (i < body.length) c.enqueue(body.subarray(i, ++i)); else c.close(); },
    })),
  });
  assert.equal(result.complete, true);
  assert.equal(result.summary.bytesRead, body.length);
  assert.equal(result.catalog.messages[0].text, 'Hello café');
});

test('compressed fixture expands beyond limit and fails on decoded bytes', async () => {
  const encoded = gzipSync(Buffer.from(js('Hello') + ' '.repeat(8192)));
  assert.ok(encoded.byteLength < 512);
  const result = await fetchCatalog(manifest(), {
    maxFileBytes: 512,
    fetchImpl: async () => response(
      new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip')),
      { headers: {
        'content-type': 'application/javascript',
        'content-encoding': 'gzip', 'content-length': String(encoded.byteLength),
      } },
    ),
  });
  assert.equal(errorOf(result), 'file-byte-limit');
  assert.ok(result.summary.bytesRead > 512);
  assert.equal(result.complete, false);
});

test('failed downloads consume total budget; later URLs are summarized without requests', async () => {
  let calls = 0;
  const result = await fetchCatalog(manifest([url(1), url(2), url(3)]), {
    maxFileBytes: 8, maxTotalBytes: 20,
    fetchImpl: async () => { calls++; return response('x'.repeat(11)); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.results.map(r => r.error), ['file-byte-limit', 'total-byte-limit', 'total-byte-limit']);
  assert.equal(result.summary.bytesRead, 22);
  assert.equal(result.complete, false);
});

test('partial download failure retains successful candidates but is never complete', async () => {
  const result = await fetchCatalog(manifest([url(1), url(2)]), {
    fetchImpl: async address => address === url(1) ? response() : response('<html>bad</html>'),
  });
  assert.equal(result.catalog.messages[0].text, 'Scheduled tasks');
  assert.equal(result.catalog.summary.complete, true);
  assert.equal(result.complete, false);
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.summary.failed, 1);
});

test('timeout covers uncooperative fetch and body reads; late response is discarded', async () => {
  let signal, resolveFetch, cancelled = false;
  const pending = fetchCatalog(manifest(), {
    timeoutMs: 15,
    fetchImpl: async (_, options) => {
      signal = options.signal;
      return new Promise(resolve => { resolveFetch = resolve; });
    },
  });
  const result = await pending;
  assert.equal(errorOf(result), 'timeout');
  assert.equal(signal.aborted, true);
  resolveFetch(response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(result.summary.bytesRead, 0);

  const stalled = await fetchCatalog(manifest(), {
    timeoutMs: 15,
    fetchImpl: async () => ({
      status: 200, headers: new Headers({ 'content-type': 'text/javascript' }),
      body: { getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: () => new Promise(() => {}),
      }) },
    }),
  });
  assert.equal(errorOf(stalled), 'timeout');
});

test('body errors and extractor interruption are honest failures', async () => {
  const broken = await fetchCatalog(manifest(), {
    fetchImpl: async () => response(new ReadableStream({
      start(c) { c.error(new Error('private raw payload')); },
    })),
  });
  assert.equal(errorOf(broken), 'fetch-or-stream-error');
  assert.equal(JSON.stringify(broken).includes('private'), false);
  const interrupted = await fetchCatalog(manifest(), {
    fetchImpl: fixtureFetch(js('Hello')), extractorLimits: { maxTokens: 2 },
  });
  assert.equal(interrupted.complete, false);
  assert.equal(errorOf(interrupted), 'extraction-incomplete');
  const overflow = await fetchCatalog(manifest(), {
    fetchImpl: fixtureFetch(js('Hello') + js('World')),
    extractorLimits: { maxOccurrences: 1 },
  });
  assert.equal(overflow.complete, false);
  assert.equal(overflow.summary.failed, 1);
  const aggregateFailure = await fetchCatalog(manifest([url(1), url(2)]), {
    fetchImpl: fixtureFetch(js('Hello')), extractorLimits: { maxFiles: 1 },
  });
  assert.equal(aggregateFailure.error, 'catalog-aggregation-failed');
  assert.equal(aggregateFailure.catalog, null);
  assert.equal(aggregateFailure.complete, false);
  assert.equal(aggregateFailure.summary.failed, 2);
});

test('CLI fixture writes only candidate JSON, summary stdout, refuses overwrite before fetch', async t => {
  const f = fixture(t);
  let stdout = '', calls = 0;
  const options = {
    fetchImpl: async () => { calls++; return response(); },
    stdout: { write(value) { stdout += value; } },
  };
  assert.equal(await runCLI(f.args, options), 0);
  const output = fs.readFileSync(f.output, 'utf8');
  assert.equal(JSON.parse(output).complete, true);
  assert.equal(JSON.parse(stdout).succeeded, 1);
  assert.equal(output.includes('intl.formatMessage'), false);
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['catalog.json', 'manifest.json']);
  await assert.rejects(runCLI(f.args, options), /already exists/);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(f.output, 'utf8'), output);
});

test('CLI incomplete exit 2, symlink/racing output protection and bounded input', async t => {
  const f = fixture(t);
  const quiet = { write() {} };
  assert.equal(await runCLI(f.args, { fetchImpl: fixtureFetch('<html>bad</html>'), stdout: quiet }), 2);
  assert.equal(JSON.parse(fs.readFileSync(f.output, 'utf8')).complete, false);
  fs.unlinkSync(f.output);
  fs.symlinkSync(path.join(f.dir, 'missing'), f.output);
  await assert.rejects(runCLI(f.args, { fetchImpl: () => assert.fail('no fetch') }), /already exists/);
  fs.unlinkSync(f.output);
  await assert.rejects(runCLI(f.args, {
    fetchImpl: async () => { fs.writeFileSync(f.output, 'another writer'); return response(); },
    stdout: quiet,
  }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'another writer');
  fs.unlinkSync(f.output);
  fs.writeFileSync(f.input, ' '.repeat(512 * 1024 + 1));
  await assert.rejects(runCLI(f.args, { fetchImpl: () => assert.fail('no fetch') }), /manifest file/);
});

test('import is inert even with valid CLI-looking argv; assets never executed', async () => {
  const moduleURL = new URL('../scripts/fetch-ui-catalog.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = () => { throw Error("unexpected request"); };
    process.argv = ["node", "some-other-script", "--manifest", "x", "--output", "y"];
    await import(${JSON.stringify(moduleURL)});
    console.log("inert");
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'inert');
  delete globalThis.__catalogAssetExecuted;
  const result = await fetchCatalog(manifest(), {
    fetchImpl: fixtureFetch('globalThis.__catalogAssetExecuted=true;' + js('Hello')),
  });
  assert.equal(result.complete, true);
  assert.equal(globalThis.__catalogAssetExecuted, undefined);
});

test('dependency discovery supports static imports/from/dynamic imports and Vite string arrays', () => {
  const source = `
    import "./side-Abc12345.js";
    import {thing as other} from './module-Abc12345.js';
    export {thing} from "./reexport-Abc12345.js";
    const load = () => import(/* preload */ "./lazy-Abc12345.js");
    const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=[
      "table-Abc12345.js", "./style-Abc12345.css", "./side-Abc12345.js",
    ])))=>i.map(i=>d[i]);
  `;
  assert.deepEqual(discoverAssetDependencies(source, assetEntry),
    ['lazy', 'module', 'reexport', 'side', 'table'].map(name => `${assetBase}${name}-Abc12345.js`));
});

test('dependency discovery rejects query/traversal/host/path/dynamic and unhashed names', () => {
  const bad = [
    '../outside-Abc12345.js', './sub/inside-Abc12345.js', '/root-Abc12345.js',
    '//evil.test/outside-Abc12345.js', `${assetBase}absolute-Abc12345.js`,
    'https://evil.test/remote-Abc12345.js', './file-Abc12345.js?q=1',
    './file-Abc12345.js#hash', './file-%41bc12345.js', './file-Abc12345.js.map',
    './file-short.js', './unhashed.js', '././file-Abc12345.js',
  ];
  const source = bad.map(value => `import(${JSON.stringify(value)});`).join('\n') + `
    import("./concat-Abc12345.js" + suffix);
    import(\`./template-Abc12345.js\`);
    import(\`./dynamic-\${name}.js\`);
    import(variable);
    object.import("./member-Abc12345.js");
    object?.import("./optional-Abc12345.js");
    const mixed = ["./mixed-Abc12345.js", variable];
    const concat = ["./array-Abc12345.js" + variable];
    const spread = ["./spread-Abc12345.js", ...more];
    const escaped = import("./escape-\\u0041bc12345.js");
  `;
  assert.deepEqual(discoverAssetDependencies(source, assetEntry), []);
  for (const parent of [
    url(1), 'https://evil.test/index-Abc12345.js',
    `${assetEntry}?q=1`, `${assetBase}nested/index-Abc12345.js`,
  ]) assert.deepEqual(discoverAssetDependencies('import("./valid-Abc12345.js");', parent), []);
});

test('dependency discovery does not mine comments, strings, regexes, templates or member indexing', () => {
  const source = String.raw`
    // import("./comment-Abc12345.js")
    /* const deps = ["./comment-Abc12345.js"]; */
    const text = 'import("./string-Abc12345.js")';
    const re = /import(".\/regexp-Abc12345.js")/;
    if (ready) {} else /import(".\/else-Abc12345.js")/.test(text);
    do /import(".\/do-Abc12345.js")/.test(text); while (ready);
    const re2 = /["'` + '`' + String.raw`]/;
    const template = ` + '`raw import("./template-Abc12345.js") ${`nested import("./nested-Abc12345.js")`}`;' + `
    obj["./property-Abc12345.js"];
    import("./real-Abc12345.js");
  `;
  assert.deepEqual(discoverAssetDependencies(source, assetEntry), [`${assetBase}real-Abc12345.js`]);
});

test('dependency candidates are not followed and are deduplicated across fetched files', async () => {
  const urls = [assetEntry, `${assetBase}second-Abc12345.js`], calls = [];
  const result = await fetchCatalog(manifest(urls), {
    fetchImpl: async address => {
      calls.push(address);
      return response('import("./shared-Abc12345.js");' + js('Fixture UI'));
    },
  });
  assert.deepEqual(calls, urls);
  assert.deepEqual(result.dependencies, [`${assetBase}shared-Abc12345.js`]);
  assert.equal(result.complete, true);
  assert.equal(result.dependencyDiscovery.complete, true);
  assert.equal(result.results[0].dependencyDiscovery.forms.dynamicImport, 1);
});

test('dependency discovery caps at 1500 per file AND report; truncation is explicit', async () => {
  assert.equal(DEPENDENCY_LIMIT, 1500);
  const names = Array.from({ length: 1501 }, (_, i) => `chunk${i}-Abc12345.js`);
  const source = `const deps = ${JSON.stringify(names)};`;
  assert.equal(discoverAssetDependencies(source, assetEntry).length, 1500);
  const one = await fetchCatalog(manifest([assetEntry]), { fetchImpl: fixtureFetch(source) });
  assert.equal(one.dependencies.length, 1500);
  assert.equal(one.dependencyDiscovery.truncated, true);
  assert.equal(one.complete, false);
  const two = await fetchCatalog(manifest([assetEntry, `${assetBase}other-Abc12345.js`]), {
    fetchImpl: async address => response(`const deps = ${JSON.stringify(
      address === assetEntry ? names.slice(0, 1000) : names.slice(1000),
    )};`),
  });
  assert.equal(two.dependencies.length, 1500);
  assert.equal(two.dependencyDiscovery.truncated, true);
  assert.equal(two.complete, false);
});

test('dependency scanning is bounded and ambiguous/truncated code is not reported complete', async () => {
  assert.deepEqual(discoverAssetDependencies(' '.repeat(LIMITS.maxFileBytes + 1), assetEntry), []);
  const result = await fetchCatalog(manifest([assetEntry]), {
    fetchImpl: fixtureFetch('import("./first-Abc12345.js"); if (ready) /import(".\\/fake-Abc12345.js")/;'),
  });
  assert.deepEqual(result.dependencies, [`${assetBase}first-Abc12345.js`]);
  assert.equal(result.dependencyDiscovery.complete, false);
  assert.equal(result.results[0].dependencyDiscovery.reason, 'dependency-ambiguous-slash');
  assert.equal(result.complete, false);
  assert.deepEqual(discoverAssetDependencies('const d=["./pending-Abc12345.js"', assetEntry), []);
  assert.deepEqual(discoverAssetDependencies('const x=`' + '${'.repeat(300), assetEntry), []);
});
