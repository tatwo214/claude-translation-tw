#!/usr/bin/env node
// Explicit build-time public asset fetcher. No account/DOM access, asset execution,
// raw asset writes, approval changes, or import-time requests.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assets from '../claude-tw/assets.cjs';
import { catalogSources, LIMITS as EXTRACT_LIMITS } from './extract-ui-catalog.mjs';

export const LIMITS = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 256,
  timeoutMs: 15_000,
});
const JS_TYPES = new Set([
  'application/javascript', 'text/javascript', 'application/ecmascript',
  'text/ecmascript', 'application/x-javascript',
]);
class Failure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new Failure(code); };

export const DEPENDENCY_LIMIT = 1500;
const DEPENDENCY_BASE = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/';
const dependencyFile = /^(?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,64}\.js$/u;

function dependencyURL(literal, parent) {
  // Only a bare sibling filename or ./filename. Reject BEFORE URL resolution:
  // normalization must not make traversal, escapes, queries or hosts acceptable.
  if (typeof literal !== 'string' || literal.length > 512 || !dependencyFile.test(literal)) return null;
  const resolved = new URL(literal, parent).href;
  return resolved.startsWith(DEPENDENCY_BASE) ? assets.assetURL(resolved) : null;
}

// Small conservative lexer, not a JS evaluator/AST. Strings with escapes and all
// templates are opaque to discovery. Templates' interpolations are skipped too.
// Stop at ambiguous slash contexts instead of mining regex contents as imports.
function dependencyLexer(source) {
  let i = 0, count = 0;
  function next(previous = null, depth = 0) {
    if (depth > 256 || ++count > EXTRACT_LIMITS.maxTokens) throw Error('dependency-scan-limit');
    while (i < source.length) {
      if (/\s/u.test(source[i])) { i++; continue; }
      if (source.startsWith('//', i)) {
        while (i < source.length && !/[\r\n\u2028\u2029]/u.test(source[i])) i++;
      } else if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        if (end < 0) throw Error('dependency-unterminated-comment');
        i = end + 2;
      } else break;
    }
    if (i >= source.length) return null;
    const start = i, c = source[i++];
    if (c === '"' || c === "'") {
      let escaped = false;
      while (i < source.length) {
        const ch = source[i++];
        if (ch === c) return {
          kind: 'string', value: !escaped && i - start <= 514 ? source.slice(start + 1, i - 1) : null,
        };
        if (/[\r\n\u2028\u2029]/u.test(ch)) throw Error('dependency-unterminated-string');
        if (ch === '\\') {
          escaped = true;
          if (source[i] === '\r' && source[i + 1] === '\n') i++;
          i++;
        }
      }
      throw Error('dependency-unterminated-string');
    }
    if (c === '`') {
      while (i < source.length) {
        const ch = source[i++];
        if (ch === '\\') { i++; continue; }
        if (ch === '`') return { kind: 'opaque', value: null };
        if (ch === '$' && source[i] === '{') {
          i++;
          let braces = 1, prior = null;
          while (braces) {
            const token = next(prior, depth + braces);
            if (!token) throw Error('dependency-unterminated-template');
            if (token.kind === 'punct' && token.value === '{') braces++;
            if (token.kind === 'punct' && token.value === '}') braces--;
            prior = token;
          }
        }
      }
      throw Error('dependency-unterminated-template');
    }
    if (/[A-Za-z_$\u0080-\uffff]/u.test(c)) {
      while (i < source.length && /[A-Za-z0-9_$\u0080-\uffff]/u.test(source[i])) i++;
      return { kind: 'word', value: source.slice(start, i) };
    }
    if (/[0-9]/u.test(c)) {
      while (i < source.length && /[A-Za-z0-9_.]/u.test(source[i])) i++;
      return { kind: 'opaque', value: null };
    }
    if (c === '/') {
      if (previous?.kind === 'punct' && [')', '}', '++', '--'].includes(previous.value)) {
        throw Error('dependency-ambiguous-slash');
      }
      const regex = !previous ||
        (previous.kind === 'word' && ['return', 'throw', 'case', 'void', 'typeof', 'delete',
          'yield', 'await', 'in', 'of', 'else', 'do', 'break', 'continue', 'debugger'].includes(previous.value)) ||
        (previous.kind === 'punct' && ![']', '.', '?.', '++', '--'].includes(previous.value));
      if (regex) {
        let inClass = false;
        while (i < source.length) {
          const ch = source[i++];
          if (/[\r\n\u2028\u2029]/u.test(ch)) throw Error('dependency-unterminated-regexp');
          if (ch === '\\') { i++; continue; }
          if (ch === '[') inClass = true;
          if (ch === ']') inClass = false;
          if (ch === '/' && !inClass) {
            while (i < source.length && /[A-Za-z]/u.test(source[i])) i++;
            return { kind: 'opaque', value: null };
          }
        }
        throw Error('dependency-unterminated-regexp');
      }
    }
    const pair = source.slice(start, start + 2);
    if (['?.', '++', '--', '=>'].includes(pair)) { i++; return { kind: 'punct', value: pair }; }
    return { kind: 'punct', value: c };
  }
  return next;
}

function scanAssetDependencies(source, url) {
  const found = new Set(), forms = { import: 0, from: 0, dynamicImport: 0, literalArray: 0 };
  const result = { dependencies: [], complete: true, truncated: false, reason: null, forms };
  if (!assets.assetURL(url) || !url.startsWith(DEPENDENCY_BASE)) return result;
  if (typeof source !== 'string' || source.length > LIMITS.maxFileBytes ||
      Buffer.byteLength(source) > LIMITS.maxFileBytes) {
    return { ...result, complete: false, reason: 'dependency-source-limit' };
  }
  function add(candidate, form) {
    if (!candidate) return;
    if (!found.has(candidate) && found.size === DEPENDENCY_LIMIT) {
      result.complete = false; result.truncated = true; result.reason = 'dependency-count-limit';
      return;
    }
    forms[form]++;
    found.add(candidate);
  }
  const next = dependencyLexer(source), history = [], arrays = [];
  try {
    let token = next();
    while (token) {
      const following = next(token);
      const previous = history.at(-1), before = history.at(-2), earlier = history.at(-3);
      const punct = (t, value) => t?.kind === 'punct' && t.value === value;
      const word = (t, value) => t?.kind === 'word' && t.value === value;
      const member = t => punct(t, '.') || punct(t, '?.');
      if (token.kind === 'string') {
        const candidate = dependencyURL(token.value, url);
        const boundary = !following || punct(following, ';') ||
          (following.kind === 'word' && ['with', 'assert', 'import', 'export', 'const', 'let', 'var', 'function', 'class'].includes(following.value));
        if (word(previous, 'import') && !member(before) && boundary) add(candidate, 'import');
        if (word(previous, 'from') && !member(before) && boundary) add(candidate, 'from');
        if (punct(previous, '(') && word(before, 'import') && !member(earlier) && punct(following, ')')) {
          add(candidate, 'dynamicImport');
        }
      }
      // Vite dependency tables are string-only arrays, sometimes containing CSS
      // too. Commit only on a matching ], never concatenations/spreads/variables.
      // These are candidates, not proof that a particular array is used at runtime.
      if (punct(token, '[')) {
        if (arrays.length >= 256) throw Error('dependency-depth-limit');
        const expressionStart = !previous || (previous.kind === 'punct' &&
          ['=', '(', ',', ':', '[', '?', '=>'].includes(previous.value)) || word(previous, 'return');
        if (arrays.length) arrays.at(-1).valid = false;
        arrays.push({ valid: expressionStart, wantValue: true, entries: new Set(), overflow: false });
      } else if (punct(token, ']') && arrays.length) {
        const frame = arrays.pop();
        if (frame.valid) {
          for (const candidate of frame.entries) add(candidate, 'literalArray');
          if (frame.overflow) {
            result.complete = false; result.truncated = true; result.reason = 'dependency-count-limit';
          }
        }
      } else if (arrays.length) {
        const frame = arrays.at(-1);
        if (frame.valid && token.kind === 'string' && frame.wantValue) {
          const candidate = dependencyURL(token.value, url);
          if (candidate && !frame.entries.has(candidate)) {
            if (frame.entries.size < DEPENDENCY_LIMIT) frame.entries.add(candidate);
            else frame.overflow = true;
          }
          frame.wantValue = false;
        } else if (frame.valid && punct(token, ',') && !frame.wantValue) frame.wantValue = true;
        else frame.valid = false;
      }
      history.push(token);
      if (history.length > 3) history.shift();
      token = following;
    }
    if (arrays.length) throw Error('dependency-unclosed-array');
  } catch (error) {
    result.complete = false;
    result.reason = error.message; // only fixed lexer errors, never source excerpts
  }
  result.dependencies = [...found].sort();
  return result;
}

// Pure, bounded URL[] API. No fetch, execution, writes, import resolution, or
// recursive following. At most 1500 candidates; fetchCatalog also reports scan
// limits/ambiguity in dependencyDiscovery. Only unescaped single/double-quoted
// sibling names ending -<8..64 URL-safe hash>.js are considered.
export function discoverAssetDependencies(source, url) {
  return scanAssetDependencies(source, url).dependencies;
}

function lowerLimits(input, defaults) {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(defaults, key) || !Number.isSafeInteger(value) ||
        value < 1 || value > defaults[key]) throw new Error(`Invalid limit: ${key}`);
    result[key] = value;
  }
  return result;
}

function validateManifest(manifest, maxFiles) {
  if (!manifest || manifest.schema !== 1 ||
      typeof manifest.appVersion !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(manifest.appVersion) ||
      typeof manifest.appHash !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.appHash) ||
      !Array.isArray(manifest.assets) || !manifest.assets.length ||
      manifest.assets.length > maxFiles) throw new Error('Invalid asset manifest');
  // assetList deliberately filters invalid entries; here even ONE invalid URL
  // rejects the whole input, before any request. Snapshot caller-owned arrays.
  const urls = [];
  for (const url of manifest.assets) {
    if (!assets.assetURL(url)) throw new Error('Invalid asset URL');
    urls.push(url);
  }
  if (new Set(urls).size !== urls.length) throw new Error('Duplicate asset URL');
  return { schema: 1, appVersion: manifest.appVersion, appHash: manifest.appHash, assets: urls };
}

function cancel(stream) {
  // Cancellation must not keep the deadline pending on a broken transport.
  try { Promise.resolve(stream?.cancel()).catch(() => {}); } catch { /* best effort */ }
}

async function download(url, fetchImpl, bounds, budget, result) {
  const controller = new AbortController();
  let reader, response, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      cancel(reader ?? response?.body);
      reject(new Failure('timeout'));
    }, bounds.timeoutMs);
  });
  const work = (async () => {
    response = await fetchImpl(url, {
      method: 'GET', credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', referrer: '',
      headers: { Accept: 'application/javascript, text/javascript' },
      signal: controller.signal,
    });
    if (controller.signal.aborted) { cancel(response?.body); fail('timeout'); }
    if (!response || response.redirected ||
        (response.url && response.url !== url) ||
        (response.status >= 300 && response.status < 400)) fail('redirect-rejected');
    result.httpStatus = response.status;
    if (response.status !== 200) fail('http-status');
    const type = (response.headers?.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    result.contentType = JS_TYPES.has(type) ? type : null;
    if (!JS_TYPES.has(type)) fail('non-javascript-content-type');
    const charset = /(?:^|;)\s*charset\s*=\s*"?([^";\s]+)/iu.exec(response.headers.get('content-type'));
    if (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset[1].toLowerCase())) fail('unsupported-charset');
    if (!response.body || typeof response.body.getReader !== 'function') fail('missing-stream');
    reader = response.body.getReader();
    // One bounded allocation instead of retaining arbitrarily many tiny chunks.
    const data = Buffer.allocUnsafe(Math.min(bounds.maxFileBytes, bounds.maxTotalBytes - budget.bytesRead));
    for (;;) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) fail('timeout');
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('invalid-stream-chunk');
      // Fetch bodies are already decoded by the transport (including gzip/br).
      // Count ACTUAL decoded bytes, never Content-Length, which may be encoded.
      // Failed files also spend the shared budget. A violating chunk is counted
      // but never retained; a transport can deliver one chunk past the limit.
      result.bytesRead += value.byteLength;
      budget.bytesRead += value.byteLength;
      if (budget.bytesRead > bounds.maxTotalBytes) fail('total-byte-limit');
      if (result.bytesRead > bounds.maxFileBytes) fail('file-byte-limit');
      if (value.byteLength) data.set(value, result.bytesRead - value.byteLength);
    }
    if (!result.bytesRead) fail('empty-body');
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(0, result.bytesRead)); }
    catch { fail('invalid-utf8'); }
    const start = source.trimStart();
    // Defense against HTML login/error pages mislabeled as JavaScript. This is
    // NOT a full JS syntax validator (module/webpack code is not evaluated).
    // Minified JS can legally contain raw control characters in string/regexp
    // literals (observed public bundles use U+0001/U+0004/U+001F delimiters).
    // Do not treat every such byte anywhere in the source as binary. Retain
    // conservative NUL/leading-control rejection; this is sniffing, not parsing
    // or proof that every remaining control character is in a legal JS context.
    if (/^(?:<!|<\?|<\/?[A-Za-z]|[\u0001-\u0008\u000e-\u001f])/u.test(start) ||
        source.includes('\0')) fail('non-javascript-body');
    if (start[0] === '{' || start[0] === '[') {
      let json = false;
      try { JSON.parse(start); json = true; } catch { /* JS need not be JSON */ }
      if (json) fail('non-javascript-body');
    }
    return source;
  })();
  try { return await Promise.race([work, deadline]); }
  finally {
    clearTimeout(timer);
    controller.abort();
    cancel(reader ?? response?.body);
    // A late fetch/read resolution cannot consume budget or add candidates.
    work.catch(() => {});
  }
}

/**
 * fetchCatalog(manifest, {fetchImpl = globalThis.fetch, ...lowerLimits,
 *                         extractorLimits = {}}) -> Promise<report>
 *
 * fetchImpl is a trusted WHATWG-fetch-compatible transport: decoded streaming
 * bytes, no ambient auth/cookie jar, and redirect:error support are required.
 * Tests inject fixtures; this module never loads an asset as code.
 * Identity is structurally checked, NOT authenticated/approved against an app.
 * report.catalog is the unmodified catalogSources result (or null if no inputs
 * or aggregation failed). report.complete AND report.summary.complete include
 * every fetch/scan failure; catalog.summary.complete covers only supplied JS.
 * report.dependencies contains at most 1500 deduplicated URLs, never followed.
 * dependencyDiscovery reports incomplete/truncated dependency scans separately;
 * per-URL forms count recognized references, not full runtime dependency coverage.
 * Completion means processing this manifest, NEVER full UI/DOM coverage.
 */
export async function fetchCatalog(manifest, options = {}) {
  const { fetchImpl = globalThis.fetch, extractorLimits = {}, ...requested } = options;
  const bounds = lowerLimits(requested, LIMITS);
  const scanBounds = lowerLimits(extractorLimits, EXTRACT_LIMITS);
  const identity = validateManifest(manifest, bounds.maxFiles);
  if (typeof fetchImpl !== 'function') throw new Error('Expected fetch implementation');
  const sources = [], results = [], budget = { bytesRead: 0 }, dependencies = new Set();
  const dependencyDiscovery = { complete: true, truncated: false, limit: DEPENDENCY_LIMIT };
  for (const url of identity.assets) {
    const result = { url, ok: false, bytesRead: 0, error: null };
    results.push(result);
    if (budget.bytesRead >= bounds.maxTotalBytes) {
      result.error = 'total-byte-limit';
      continue;
    }
    try {
      const source = await download(url, fetchImpl, bounds, budget, result);
      const discovery = scanAssetDependencies(source, url);
      const { dependencies: candidates, ...metadata } = discovery;
      result.dependencyDiscovery = metadata;
      if (!discovery.complete) dependencyDiscovery.complete = false;
      if (discovery.truncated) dependencyDiscovery.truncated = true;
      for (const candidate of candidates) {
        if (!dependencies.has(candidate) && dependencies.size === DEPENDENCY_LIMIT) {
          dependencyDiscovery.complete = false;
          dependencyDiscovery.truncated = true;
          break;
        }
        dependencies.add(candidate);
      }
      sources.push({ file: url, source });
      result.ok = true;
    } catch (error) {
      // Never echo transport exception messages (may contain URLs, headers/body).
      result.error = error instanceof Failure ? error.code : 'fetch-or-stream-error';
    }
  }
  let catalog = null, error = null;
  if (sources.length) {
    try {
      catalog = catalogSources(sources, scanBounds);
      for (const file of catalog.files) {
        if (!file.complete) {
          const result = results.find(item => item.url === file.file);
          result.ok = false;
          result.error = 'extraction-incomplete';
        }
      }
    } catch {
      error = 'catalog-aggregation-failed';
      for (const result of results) {
        if (result.ok) { result.ok = false; result.error = error; }
      }
    }
  }
  const complete = results.every(result => result.ok) && catalog?.summary.complete === true && dependencyDiscovery.complete;
  return {
    schema: 1, kind: 'fetched-ui-message-candidates',
    appVersion: identity.appVersion, appHash: identity.appHash,
    limits: bounds, complete, error, results, catalog,
    dependencies: [...dependencies].sort(), dependencyDiscovery,
    summary: {
      assets: results.length, succeeded: results.filter(result => result.ok).length,
      failed: results.filter(result => !result.ok).length,
      bytesRead: budget.bytesRead, plainUnique: catalog?.summary.plainUnique ?? 0,
      unsupportedUnique: catalog?.summary.unsupportedUnique ?? 0, complete,
    },
  };
}

async function readManifest(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const max = 512 * 1024;
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw new Error('Invalid manifest file');
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > max) throw new Error('Manifest byte limit');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { await handle.close(); }
}

// Injectable only for offline tests; no CLI transport override or URL input.
export async function runCLI(args, { fetchImpl = globalThis.fetch, stdout = process.stdout } = {}) {
  if (args.length === 1 && args[0] === '--help') {
    stdout.write('Usage: node scripts/fetch-ui-catalog.mjs --manifest FILE --output NEW_JSON\n');
    return 0;
  }
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--manifest', '--output'].includes(flag) || flag in flags ||
        !value || value.startsWith('--')) throw new Error('Expected --manifest FILE --output NEW_JSON');
    flags[flag] = value;
  }
  if (!flags['--manifest'] || !flags['--output']) throw new Error('Expected --manifest FILE --output NEW_JSON');
  const output = path.resolve(flags['--output']);
  try {
    await fs.lstat(output);
    throw new Error('Output already exists');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = await readManifest(flags['--manifest']);
  validateManifest(manifest, LIMITS.maxFiles);
  const report = await fetchCatalog(manifest, { fetchImpl });
  // Exclusive creation also rejects dangling symlinks and concurrent creators.
  const handle = await fs.open(output, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); }
  finally { await handle.close(); }
  stdout.write(`${JSON.stringify(report.summary)}\n`);
  return report.complete ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCLI(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    // No exception detail: parsing or transport failures can include raw input.
    process.stderr.write('fetch-ui-catalog: failed (check manifest, limits, and new output path)\n');
    process.exitCode = 1;
  });
}
