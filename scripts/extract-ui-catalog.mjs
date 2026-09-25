#!/usr/bin/env node
// Build-time candidates only: no eval/import of assets, DOM, fetching, or writes.
// This is a conservative lexical/object-property parser, not a complete JS AST.
// Explicit defaultMessage data properties are the boundary, not arbitrary strings.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 256,
  maxTokens: 4_000_000,
  maxDepth: 256,
  maxLiteralChars: 16_384,
  maxOccurrences: 50_000,
  maxArchiveBytes: 256 * 1024 * 1024,
  maxHeaderBytes: 4 * 1024 * 1024,
  maxArchiveEntries: 20_000,
});

function limits(options = {}) {
  const result = { ...LIMITS };
  for (const [key, value] of Object.entries(options)) {
    if (!(key in LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) {
      throw new Error(`Invalid limit: ${key} (must be 1..${LIMITS[key] ?? 'known limit'})`);
    }
    result[key] = value;
  }
  return result;
}
const isWordStart = c => !!c && (/[A-Za-z_$]/u.test(c) || c.charCodeAt(0) > 127 || c === '\\');
const isWord = c => !!c && (isWordStart(c) || /[0-9]/u.test(c));
const prefixWords = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'instanceof', 'else', 'do']);
const controlWords = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
const operators = ['>>>=', '===', '!==', '**=', '>>>', '<<=', '>>=', '&&=', '||=', '??=', '...', '=>', '==', '!=', '<=', '>=', '++', '--', '&&', '||', '??', '?.', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
function allowsRegex(token) {
  if (token.type === 'word') return prefixWords.has(token.value);
  if (token.type !== 'punct') return false;
  return ![')', ']', '.', '?.', '++', '--'].includes(token.value);
}

class ScanError extends Error {
  constructor(reason, token) { super(reason); this.reason = reason; this.token = token; }
}

class Lexer {
  constructor(source, bounds) {
    this.s = source; this.bounds = bounds; this.i = 0; this.line = 1; this.column = 1; this.tokens = 0;
  }
  position() { return { offset: this.i, line: this.line, column: this.column }; }
  move(end) {
    while (this.i < end) {
      const c = this.s[this.i++];
      if (c === '\n' || c === '\u2028' || c === '\u2029' || (c === '\r' && this.s[this.i] !== '\n')) {
        this.line++; this.column = 1;
      } else this.column++;
    }
  }
  error(reason, at = this.position()) { throw new ScanError(reason, at); }
  quoted(quote, depth) {
    const at = this.position();
    this.move(this.i + 1);
    let value = '', reason = null, dynamic = false;
    const append = text => {
      if (value.length + text.length > this.bounds.maxLiteralChars) reason = 'literal-too-large';
      if (!reason && !dynamic) value += text;
    };
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === quote) {
        this.move(this.i + 1);
        return { ...at, type: 'string', value: reason || dynamic ? null : value,
          reason: reason ?? (dynamic ? 'dynamic-template' : null),
          form: quote === '`' ? 'template' : quote === '"' ? 'double-quoted' : 'single-quoted', end: this.i };
      }
      if (quote === '`' && c === '$' && this.s[this.i + 1] === '{') {
        dynamic = true;
        this.move(this.i + 2);
        this.interpolation(depth + 1);
        continue;
      }
      if (c === '\\') {
        this.move(this.i + 1);
        if (this.i === this.s.length) this.error('unterminated-string', at);
        const escape = this.s[this.i];
        this.move(this.i + 1);
        if (escape === '\r' || escape === '\n' || escape === '\u2028' || escape === '\u2029') {
          if (escape === '\r' && this.s[this.i] === '\n') this.move(this.i + 1);
          continue;
        }
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
        if (escape === 'x' || escape === 'u') {
          let digits = '', braced = false;
          if (escape === 'u' && this.s[this.i] === '{') {
            braced = true; this.move(this.i + 1);
            while (this.i < this.s.length && /[0-9a-fA-F]/u.test(this.s[this.i])) {
              if (digits.length < 7) digits += this.s[this.i];
              this.move(this.i + 1);
            }
            if (this.s[this.i] === '}') this.move(this.i + 1);
            else reason = 'invalid-escape';
          } else {
            const n = escape === 'x' ? 2 : 4;
            while (digits.length < n && this.i < this.s.length && /[0-9a-fA-F]/u.test(this.s[this.i])) {
              digits += this.s[this.i]; this.move(this.i + 1);
            }
            if (digits.length !== n) reason = 'invalid-escape';
          }
          const code = Number.parseInt(digits, 16);
          if (!digits.length || (braced && digits.length > 6) || code > 0x10ffff) reason = 'invalid-escape';
          if (!reason) append(String.fromCodePoint(code));
        } else if (/[1-9]/u.test(escape) || (escape === '0' && /[0-9]/u.test(this.s[this.i] ?? ''))) {
          reason = 'legacy-numeric-escape';
        } else append(Object.hasOwn(simple, escape) ? simple[escape] : escape);
        continue;
      }
      if (quote !== '`' && /[\r\n\u2028\u2029]/u.test(c)) this.error('unterminated-string', at);
      if (quote === '`' && c === '\r') {
        this.move(this.i + (this.s[this.i + 1] === '\n' ? 2 : 1)); append('\n');
      } else { append(c); this.move(this.i + 1); }
    }
    this.error('unterminated-string', at);
  }
  interpolation(depth) {
    if (depth > this.bounds.maxDepth) this.error('depth-limit');
    let braces = 1, regex = true;
    while (this.i < this.s.length) {
      const token = this.next(regex, depth);
      if (!token) break;
      if (token.type === 'punct' && token.value === '{') {
        if (++braces + depth > this.bounds.maxDepth) this.error('depth-limit', token);
      }
      if (token.type === 'punct' && token.value === '}') {
        if (--braces === 0) return;
      }
      regex = token.type === 'punct' && token.value === '}' ? null : allowsRegex(token);
    }
    this.error('unterminated-template-expression');
  }
  next(regexAllowed = true, depth = 0) {
    while (this.i < this.s.length) {
      const c = this.s[this.i], next = this.s[this.i + 1];
      if (/\s/u.test(c)) { this.move(this.i + 1); continue; }
      if ((c === '/' && next === '/') || (this.i === 0 && c === '#' && next === '!')) {
        while (this.i < this.s.length && !/[\r\n\u2028\u2029]/u.test(this.s[this.i])) this.move(this.i + 1);
        continue;
      }
      if (c === '/' && next === '*') {
        const end = this.s.indexOf('*/', this.i + 2);
        if (end < 0) this.error('unterminated-comment');
        this.move(end + 2); continue;
      }
      break;
    }
    if (this.i === this.s.length) return null;
    if (++this.tokens > this.bounds.maxTokens) this.error('token-limit');
    const at = this.position(), c = this.s[this.i];
    if (c === "'" || c === '"' || c === '`') return this.quoted(c, depth);
    if (isWordStart(c)) {
      const start = this.i;
      while (isWord(this.s[this.i])) this.move(this.i + 1);
      // Escaped identifiers are not resolved; strings/quoted keys ARE decoded.
      return { ...at, end: this.i, type: 'word', value: this.s.slice(start, this.i) };
    }
    if (/[0-9]/u.test(c)) {
      const start = this.i;
      while (this.i < this.s.length && /[A-Za-z0-9_.]/u.test(this.s[this.i])) this.move(this.i + 1);
      return { ...at, end: this.i, type: 'number', value: this.s.slice(start, this.i) };
    }
    // Without a full AST, slash after an unclassified statement/function block
    // can mean division OR a regexp. Never mine object-looking regexp contents.
    if (c === '/' && regexAllowed === null) this.error('ambiguous-slash-context', at);
    if (c === '/' && regexAllowed) {
      this.move(this.i + 1);
      let inClass = false;
      while (this.i < this.s.length) {
        const char = this.s[this.i];
        if (/[\r\n\u2028\u2029]/u.test(char)) this.error('unterminated-regexp', at);
        if (char === '\\') { this.move(Math.min(this.i + 2, this.s.length)); continue; }
        if (char === '[') inClass = true;
        if (char === ']') inClass = false;
        this.move(this.i + 1);
        if (char === '/' && !inClass) {
          while (isWord(this.s[this.i])) this.move(this.i + 1);
          return { ...at, end: this.i, type: 'regexp', value: null };
        }
      }
      this.error('unterminated-regexp', at);
    }
    const value = operators.find(op => this.s.startsWith(op, this.i)) ?? c;
    this.move(this.i + value.length);
    return { ...at, end: this.i, type: 'punct', value };
  }
}

function literal(token) {
  if (token?.type === 'string') return token;
  if (token?.type === 'group' && token.value === '(') return token.literal ?? null;
  return null;
}
function propertyKey(token) {
  if (token?.type === 'word' || token?.type === 'string') return token.value;
  if (token?.type === 'group' && token.value === '[') return token.literal?.value;
  return null;
}

function classify(text) {
  if (text.includes('{') || text.includes('}')) {
    // Preserve the entire decoded literal, including apostrophes, branches and
    // argument names. Do NOT guess argument names from plural branch text.
    return { reason: 'icu-or-braced-message' };
  }
  if (/<\/?[A-Za-z][^<>]*>/u.test(text)) return { reason: 'rich-text-message' };
  if (!text.trim() || !/[A-Za-z]/u.test(text)) return { reason: 'not-english-candidate' };
  for (const char of text) {
    if (/\p{Letter}/u.test(char) && !/\p{Script=Latin}/u.test(char)) return { reason: 'not-english-candidate' };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) return { reason: 'control-characters' };
  return { reason: null };
}

export function extractMessages(source, { file = '<memory>', ...options } = {}) {
  const bounds = limits(options);
  if (typeof source !== 'string') throw new TypeError('Source must be a string');
  if (Buffer.byteLength(source) > bounds.maxFileBytes) throw new Error('file-byte-limit');
  const lexer = new Lexer(source, bounds), occurrences = [], diagnostics = [];
  const root = { kind: 'root', simple: [], entry: [], count: 0, ternaries: 0 };
  const stack = [root];
  let previous = null, regex = true, objectExpected = false;
  function consume(frame, token) {
    if (frame.simple.length < 2) frame.simple.push(token);
    if (frame.kind === 'object') {
      if (frame.entry.length < 6) frame.entry.push(token);
      frame.count++;
    }
  }
  function endProperty(frame) {
    if (!frame.count) return;
    const [keyToken, colon, value] = frame.entry, key = propertyKey(keyToken);
    if (keyToken?.value === '...' || (keyToken?.value === '[' && key == null)) frame.ambiguous = true;
    if (key === 'defaultMessage' || key === 'id') {
      if (frame.messages.length + frame.ids.length >= bounds.maxOccurrences) throw new ScanError('occurrence-limit', keyToken);
      const token = frame.count === 3 && colon?.value === ':' ? literal(value) : null;
      const entry = { token, at: keyToken, reason: token ? token.reason : 'nonliteral',
        form: keyToken.type === 'word' ? 'identifier-key' : keyToken.type === 'string' ? 'quoted-key' : 'computed-literal-key' };
      frame[key === 'id' ? 'ids' : 'messages'].push(entry);
    } else if (['get', 'set'].includes(key) && propertyKey(colon) === 'defaultMessage') {
      frame.messages.push({ token: null, at: colon, reason: 'nonliteral', form: 'accessor' });
    }
    frame.entry = []; frame.count = 0;
  }
  function endObject(frame) {
    endProperty(frame);
    for (const entry of frame.messages) {
      if (occurrences.length >= bounds.maxOccurrences) throw new ScanError('occurrence-limit', entry.at);
      const provenance = { file, offset: entry.at.offset, line: entry.at.line, column: entry.at.column, form: entry.form };
      const id = frame.ids.length === 1 ? frame.ids[0].token?.value : null;
      if (typeof id === 'string') provenance.id = id;
      if (entry.token) provenance.literal = entry.token.form;
      const text = entry.token?.value;
      const result = typeof text === 'string' ? classify(text) : {};
      const reason = frame.ambiguous || frame.messages.length > 1 || frame.ids.length > 1
        ? 'ambiguous-descriptor' : entry.reason ?? result.reason ?? null;
      occurrences.push({ ...(typeof text === 'string' ? { text } : {}), ...result, reason, source: provenance });
    }
  }
  try {
    let token;
    while ((token = lexer.next(regex))) {
      const frame = stack.at(-1), value = token.value;
      if (token.type === 'punct' && ['{', '[', '('].includes(value)) {
        if (stack.length > bounds.maxDepth) throw new ScanError('depth-limit', token);
        // A return-newline block is not an object expression.
        const returnBreak = previous?.value === 'return' && previous.line !== token.line;
        const kind = value === '{' ? (objectExpected && !returnBreak ? 'object' : 'block') : 'group';
        const group = { ...token, type: 'group' };
        consume(frame, group);
        stack.push({ kind, open: value, group, simple: [], entry: [], count: 0,
          messages: [], ids: [], ambiguous: false, ternaries: 0,
          control: value === '(' && (controlWords.has(previous?.value) || previous?.forAwait === true) });
        previous = token; regex = true; objectExpected = value !== '{';
        continue;
      }
      if (token.type === 'punct' && ['}', ']', ')'].includes(value)) {
        if (stack.length === 1 || { '}': '{', ']': '[', ')': '(' }[value] !== frame.open) {
          throw new ScanError('unbalanced-delimiter', token);
        }
        if (frame.kind === 'object') endObject(frame);
        if (frame.simple.length === 1) frame.group.literal = literal(frame.simple[0]);
        frame.group.end = token.end;
        stack.pop();
        regex = frame.kind === 'block' ? null : frame.control;
        objectExpected = false; previous = token;
        continue;
      }
      if (token.type === 'punct' && value === ',' && frame.kind === 'object') endProperty(frame);
      else {
        if (token.type === 'punct' && value === ';' && frame.kind === 'object') frame.ambiguous = true;
        consume(frame, token);
      }
      objectExpected = token.type === 'punct' && ['=', '(', '[', ',', '?', '||', '&&', '??'].includes(value);
      if (value === '?' && token.type === 'punct') frame.ternaries++;
      if (value === ':' && token.type === 'punct') {
        objectExpected = (frame.kind === 'object' && frame.count === 2) || frame.ternaries > 0;
        if (frame.ternaries > 0) frame.ternaries--;
      }
      const memberName = previous?.type === 'punct' && (previous.value === '.' || previous.value === '?.');
      if (!memberName && token.type === 'word' && ['return', 'yield', 'default'].includes(value)) objectExpected = true;
      token.forAwait = token.type === 'word' && value === 'await' && previous?.value === 'for';
      regex = token.type === 'word' && memberName ? false
        : token.type === 'word' && ['of', 'await', 'yield'].includes(value) ? null : allowsRegex(token);
      previous = token;
    }
    if (stack.length !== 1) throw new ScanError('unclosed-delimiter', lexer.position());
  } catch (error) {
    if (!(error instanceof ScanError)) throw error;
    diagnostics.push({ reason: error.reason, offset: error.token.offset, line: error.token.line, column: error.token.column });
  }
  return { occurrences, diagnostics, complete: diagnostics.length === 0, tokens: lexer.tokens };
}

function newCatalog(bounds) {
  return { schema: 1, kind: 'ui-message-candidates', scope: 'static-defaultMessage-properties-only',
    limitations: [
      'Not DOM coverage or proof that every UI word is represented by a descriptor.',
      'Conservative lexer, not a full JavaScript AST; dynamic templates remain opaque.',
      'ICU/braced and rich-text messages require a separate parser/translation workflow.',
      'English candidacy is heuristic; no translation, approval, or runtime dictionary is produced.',
    ], offsetUnit: 'utf16-code-units', limits: bounds, files: [], messages: [], unsupported: [], summary: {} };
}

function collect(inputs, bounds) {
  const catalog = newCatalog(bounds), plain = new Map(), unsupported = new Map();
  let total = 0, occurrenceCount = 0;
  for (const input of inputs) {
    if (catalog.files.length >= bounds.maxFiles) throw new Error('file-count-limit');
    const meta = { file: input.file, bytes: input.bytes, complete: false, diagnostics: [] };
    catalog.files.push(meta);
    if (input.error) { meta.diagnostics.push({ reason: input.error }); continue; }
    if (input.bytes > bounds.maxFileBytes || input.bytes < 0) { meta.diagnostics.push({ reason: 'file-byte-limit' }); continue; }
    if (total + input.bytes > bounds.maxTotalBytes) { meta.diagnostics.push({ reason: 'total-byte-limit' }); continue; }
    total += input.bytes;
    let buffer;
    try { buffer = input.read(); } catch (error) {
      meta.diagnostics.push({ reason: 'read-error', message: error.message }); continue;
    }
    if (buffer.length !== input.bytes) { meta.diagnostics.push({ reason: 'size-changed' }); continue; }
    meta.sha256 = createHash('sha256').update(buffer).digest('hex');
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { meta.diagnostics.push({ reason: 'invalid-utf8' }); continue; }
    const extracted = extractMessages(source, { file: input.file, ...bounds });
    Object.assign(meta, { complete: extracted.complete, diagnostics: extracted.diagnostics, tokens: extracted.tokens,
      occurrences: extracted.occurrences.length });
    for (const entry of extracted.occurrences) {
      if (++occurrenceCount > bounds.maxOccurrences) throw new Error('catalog-occurrence-limit');
      const target = entry.reason ? unsupported : plain;
      const key = JSON.stringify([entry.reason, entry.text ?? entry.source]);
      if (!target.has(key)) {
        const { source: ignored, ...candidate } = entry;
        target.set(key, { ...candidate, sources: [] });
      }
      target.get(key).sources.push(entry.source);
    }
  }
  const sorted = map => [...map.values()].sort((a, b) => {
    const left = JSON.stringify([a.text ?? '', a.reason]), right = JSON.stringify([b.text ?? '', b.reason]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  catalog.messages = sorted(plain);
  catalog.unsupported = sorted(unsupported);
  const reasons = {};
  for (const entry of catalog.unsupported) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + entry.sources.length;
  catalog.summary = { files: catalog.files.length, completeFiles: catalog.files.filter(f => f.complete).length,
    bytesRead: total, occurrences: occurrenceCount, plainUnique: plain.size,
    plainOccurrences: catalog.messages.reduce((n, entry) => n + entry.sources.length, 0),
    unsupportedUnique: unsupported.size, unsupportedOccurrences: reasons,
    complete: catalog.files.every(f => f.complete) };
  return catalog;
}

function readBounded(file, expected, max) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== expected || stat.size > max) throw new Error('Not a stable bounded regular file');
    const data = Buffer.alloc(stat.size);
    let read = 0;
    while (read < data.length) {
      const n = fs.readSync(fd, data, read, data.length - read, read);
      if (!n) throw new Error('File changed during read');
      read += n;
    }
    if (fs.fstatSync(fd).size !== expected) throw new Error('File changed during read');
    return data;
  } finally { fs.closeSync(fd); }
}

export function catalogFiles(files, options = {}) {
  const bounds = limits(options);
  if (!Array.isArray(files) || !files.length || files.length > bounds.maxFiles) throw new Error('Expected bounded local JS file paths');
  const inputs = [...new Set(files)].map(file => {
    if (typeof file !== 'string' || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(file)) throw new Error('Local paths only; no URLs');
    const absolute = path.resolve(file);
    if (!/\.(?:js|mjs|cjs)$/u.test(absolute)) throw new Error(`Expected .js/.mjs/.cjs: ${absolute}`);
    try {
      const stat = fs.statSync(absolute);
      return { file: absolute, bytes: stat.size, error: stat.isFile() ? null : 'not-regular-file',
        read: () => readBounded(absolute, stat.size, bounds.maxFileBytes) };
    } catch (error) { return { file: absolute, bytes: 0, error: `stat-error: ${error.code}` }; }
  });
  return collect(inputs, bounds);
}

// For a caller-owned static-resource collector: no need to persist raw chunks.
// `file` is provenance only (it may be a public resource URL); it is NEVER fetched.
export function catalogSources(sources, options = {}) {
  const bounds = limits(options);
  if (!Array.isArray(sources) || !sources.length || sources.length > bounds.maxFiles) throw new Error('Expected bounded static sources');
  const names = new Set();
  const inputs = sources.map(({ file, source }) => {
    if (typeof file !== 'string' || !file || names.has(file) || typeof source !== 'string') {
      throw new Error('Expected unique source names and string source content');
    }
    names.add(file);
    return { file, bytes: Buffer.byteLength(source), read: () => Buffer.from(source, 'utf8') };
  });
  return collect(inputs, bounds);
}

export async function catalogAsar(archive, options = {}) {
  const bounds = limits(options), absolute = path.resolve(archive), stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > bounds.maxArchiveBytes) throw new Error('archive-byte-limit');
  // Bound the header allocation BEFORE letting the existing ASAR reader parse it.
  const fd = fs.openSync(absolute, 'r'), prefix = Buffer.alloc(8);
  try {
    if (fs.readSync(fd, prefix, 0, 8, 0) !== 8 || prefix.readUInt32LE(0) !== 4 ||
        prefix.readUInt32LE(4) > bounds.maxHeaderBytes || prefix.readUInt32LE(4) + 8 > stat.size) {
      throw new Error('invalid-or-oversized-asar-header');
    }
  } finally { fs.closeSync(fd); }
  const asar = await import('@electron/asar');
  asar.uncache(absolute);
  const { header, headerSize } = asar.getRawHeader(absolute);
  const inputs = [], pending = [{ node: header, name: '', depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const { node, name, depth } = pending.pop();
    if (++entries > bounds.maxArchiveEntries || depth > bounds.maxDepth) throw new Error('archive-entry-limit');
    if (!node || typeof node !== 'object') throw new Error('invalid-asar-entry');
    if (node.files) {
      for (const [part, child] of Object.entries(node.files)) {
        if (!part || part === '.' || part === '..' || /[/\\\0]/u.test(part)) throw new Error('unsafe-asar-path');
        pending.push({ node: child, name: name ? `${name}/${part}` : part, depth: depth + 1 });
      }
    } else if (/\.(?:js|mjs|cjs)$/u.test(name)) {
      const offset = Number(node.offset);
      const error = node.link ? 'linked-asset-not-read' : node.unpacked ? 'unpacked-asset-not-read'
        : !Number.isSafeInteger(node.size) || node.size < 0 || !Number.isSafeInteger(offset) || offset < 0 ||
          8 + headerSize + offset + node.size > stat.size ? 'invalid-asar-range' : null;
      inputs.push({ file: `${absolute}!/${name}`, bytes: node.size ?? 0, error,
        read: () => {
          const current = fs.statSync(absolute);
          if (current.size !== stat.size || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs) {
            throw new Error('Archive changed during extraction');
          }
          return asar.extractFile(absolute, name, false);
        } });
    }
  }
  inputs.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  try { return collect(inputs, bounds); } finally { asar.uncache(absolute); }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/extract-ui-catalog.mjs [--] FILE.js ...\n       node scripts/extract-ui-catalog.mjs --asar LOCAL_APP.asar\nJSON candidates go to stdout; no files are written, fetched, executed, or approved.');
    return;
  }
  const catalog = args[0] === '--asar' && args.length === 2
    ? await catalogAsar(args[1])
    : catalogFiles(args[0] === '--' ? args.slice(1) : args);
  process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
  if (!catalog.summary.complete) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`extract-ui-catalog: ${error.message}\n`); process.exitCode = 1;
  });
}
