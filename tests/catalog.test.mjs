import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import * as asar from '@electron/asar';
import { extractMessages, catalogSources, catalogFiles, catalogAsar, LIMITS } from '../scripts/extract-ui-catalog.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/extract-ui-catalog.mjs');
const texts = result => result.occurrences.filter(entry => !entry.reason).map(entry => entry.text);
const source = (text, file = 'synthetic.js') => ({ file, source: text });
const hash = data => createHash('sha256').update(data).digest('hex');
function fixture(t) {
  // Only generated synthetic assets, inside the worktree. No installed asset copies.
  const dir = fs.mkdtempSync(path.join(root, 'tests/.catalog-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, data) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return file;
  };
  return { dir, write };
}

test('extracts literal descriptors across native/remote bundler and descriptor shapes', () => {
  const input = `
    intl.formatMessage({defaultMessage:"Scheduled tasks",id:"schedule"});
    const policy = {title:{id:'policy',defaultMessage:'Allow desktop extensions'}};
    defineMessages({a:{"defaultMessage":"Document",id:"doc"}});
    const computed = {["defaultMessage"]:("Presentation"),["id"]:"slides"};
    const template = {defaultMessage:\`Make something new\`};
    (()=>({defaultMessage:"Arrow object"}))();
    function f() { return {defaultMessage:"Returned object"}; }
    (self.webpackChunk=self.webpackChunk||[]).push([[1],{
      42:(module)=>{module.exports={defaultMessage:"Remote chunk",id:"remote"}}
    }]);
    jsx(FormattedMessage,{id:"component",defaultMessage:"Visit the standalone homepage"});
  `;
  const result = extractMessages(input, { file: 'public-chunk.js' });
  assert.equal(result.complete, true);
  assert.deepEqual(texts(result), [
    'Scheduled tasks', 'Allow desktop extensions', 'Document', 'Presentation',
    'Make something new', 'Arrow object', 'Returned object', 'Remote chunk',
    'Visit the standalone homepage',
  ]);
  assert.equal(result.occurrences[3].source.id, 'slides');
  assert.equal(result.occurrences[3].source.form, 'computed-literal-key');
  assert.equal(result.occurrences[4].source.literal, 'template');
});

test('decodes JS quotes, unicode, escaped property keys and continuations without evaluation', () => {
  const input = String.raw`
    const a = {defaultMessage:'Don\'t lose \\ paths'};
    const b = {"default\u004dessage":"Say \"Hello\" \u{1F44B} \u0026 \x41"};
    const c = {defaultMessage:"Two\nlines\tindented"};
    const d = {defaultMessage:"Line \
joined"};
  `;
  const result = extractMessages(input);
  assert.equal(result.complete, true);
  assert.deepEqual(texts(result), [
    "Don't lose \\ paths", 'Say "Hello" 👋 & A', 'Two\nlines\tindented', 'Line joined',
  ]);
  const template = extractMessages('const d={defaultMessage:`Static \\` quote and \\\\ slash`};');
  assert.deepEqual(texts(template), ['Static ` quote and \\ slash']);
});

test('comments, strings, regexes, templates, labels and ordinary content are not UI descriptors', () => {
  const input = [
    '// const d={defaultMessage:"Comment fake"};',
    '/* {defaultMessage:"Block comment fake"} */',
    'const text = \'({defaultMessage:"String fake"})\';',
    'const template = `({defaultMessage:"Template fake"})`;',
    'const interpolated = `outer ${`nested ${"value"}`} {defaultMessage:"Template tail fake"}`;',
    'const rx = /\\{defaultMessage:"Regex fake"\\}/g;',
    'if (flag) /({defaultMessage:"Control regex fake"})/.test(input);',
    'const bracket = /[\\/{}]defaultMessage:"Class fake"/;',
    'const divided=obj.return / /({defaultMessage:"Member regex fake"})/.test(input);',
    'const dividedCall=get()() / /({defaultMessage:"Chained-call regex fake"})/.test(input);',
    'async function iter(){for await (const x of items) /({defaultMessage:"For await fake"})/.test(x)}',
    'function labels(){defaultMessage:"Label fake"}',
    'label: { defaultMessage: "Nested label fake"; }',
    'function newline(){return\n{defaultMessage:"ASI label fake"}}',
    'const content={text:"User document",message:"User chat",prompt:"User prompt"};',
    'obj.defaultMessage="Assignment is not a descriptor";',
    'const good={/* gap */defaultMessage /* gap */ : /* gap */ "Real UI"};',
  ].join('\n');
  const result = extractMessages(input);
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(texts(result), ['Real UI']);
});

test('ambiguous division/regexp grammar fails closed rather than extracting code-like regex contents', () => {
  for (const code of [
    'const f=function(){} / /({defaultMessage:"Fake"})/.test(x);',
    'const c=class{} / /({defaultMessage:"Fake"})/.test(x);',
    'let of=2; of / /({defaultMessage:"Fake"})/.test(x);',
  ]) {
    const result = extractMessages(code);
    assert.deepEqual(texts(result), []);
    assert.equal(result.complete, false);
    assert.equal(result.diagnostics[0].reason, 'ambiguous-slash-context');
  }
});

test('dynamic templates and expression values are explicitly unsupported, not executed or concatenated', () => {
  const input = [
    'globalThis.__catalogMustNotRun=true;',
    'throw new Error("MUST NOT EXECUTE");',
    'const a={defaultMessage: userText,id:"dynamic"};',
    'const b={defaultMessage:"Hello "+name};',
    'const c={defaultMessage:flag?"Choice A":"Choice B"};',
    'const d={defaultMessage:translate("Not evaluated")};',
    'const e={defaultMessage:`Hello ${name}`};',
    'const f={defaultMessage:`Hello ${(() => /}/.test("}") ? `${name}` : name)()}`};',
    'const g={defaultMessage:[{type:0,value:"Compiled AST"}]};',
    'const h={defaultMessage};',
    'const ok={defaultMessage:"Safe after expressions"};',
  ].join('\n');
  const result = extractMessages(input);
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  assert.equal(globalThis.__catalogMustNotRun, undefined);
  assert.deepEqual(texts(result), ['Safe after expressions']);
  assert.equal(result.occurrences.filter(entry => entry.reason === 'nonliteral').length, 6);
  assert.equal(result.occurrences.filter(entry => entry.reason === 'dynamic-template').length, 2);
  assert.equal(result.occurrences[0].source.id, 'dynamic');
});

test('ICU/plural/select, apostrophes and placeholder bytes stay intact in unsupported records', () => {
  const messages = [
    'Hello {name}',
    '{count, plural, =0 {No tasks} one {# task for {name}} other {# tasks}}',
    "{gender, select, female {Her inbox} male {His inbox} other {Their inbox}}",
    "Use '{' and '}' literally; {date, date, short}",
    'Balance: {amount, number, ::currency/USD}',
    "It's {count, plural, one {one task} other {many tasks}}",
  ];
  const code = messages.map((text, i) => `f({id:"icu-${i}",defaultMessage:${JSON.stringify(text)}});`).join('\n');
  const result = catalogSources([source(code)]);
  assert.equal(result.messages.length, 0);
  assert.deepEqual(result.unsupported.map(entry => entry.text).sort(), [...messages].sort());
  assert.ok(result.unsupported.every(entry => entry.reason === 'icu-or-braced-message'));
  assert.equal(result.summary.unsupportedOccurrences['icu-or-braced-message'], messages.length);
  assert.equal(result.summary.complete, true, 'complete scan does not mean ICU supported');
});

test('spreads, computed overrides, duplicate fields and accessors fail closed', () => {
  const code = `
    f({defaultMessage:"First",defaultMessage:"Last"});
    f({...other,defaultMessage:"Spread"});
    f({defaultMessage:"Overridable",[key]:"Other"});
    f({defaultMessage:"Duplicate IDs",id:"a",id:"b"});
    f({get defaultMessage(){return "Getter"}});
    f({defaultMessage(){return "Method"}});
  `;
  const result = extractMessages(code);
  assert.equal(result.complete, true);
  assert.deepEqual(texts(result), []);
  assert.equal(result.occurrences.filter(entry => entry.reason === 'ambiguous-descriptor').length, 5);
  assert.equal(result.occurrences.filter(entry => entry.reason === 'nonliteral').length, 2);
});

test('deduplicates safe strings across source files while retaining every id/location', () => {
  const first = '\nconst a={\n  defaultMessage:"Inbox triage",id:"first"};\nf({defaultMessage:"Inbox triage",id:"second"});';
  const second = 'f({"defaultMessage":"Inbox triage",id:"remote"});';
  const catalog = catalogSources([
    source(first, 'native.js'),
    source(second, 'https://public.example/assets/chunk.js'),
  ]);
  assert.equal(catalog.messages.length, 1);
  assert.equal(catalog.messages[0].sources.length, 3);
  assert.deepEqual(catalog.messages[0].sources.map(entry => entry.id), ['first', 'second', 'remote']);
  const provenance = catalog.messages[0].sources[0];
  assert.equal(provenance.offset, first.indexOf('defaultMessage'));
  assert.equal(provenance.line, 3);
  assert.equal(provenance.column, 3);
  assert.equal(catalog.files[0].sha256, hash(Buffer.from(first)));
  assert.equal(catalog.offsetUnit, 'utf16-code-units');
  assert.deepEqual(catalog, catalogSources([source(first, 'native.js'), source(second, 'https://public.example/assets/chunk.js')]));
});

test('rich text, non-English, empty literals and control characters are not safe plain candidates', () => {
  const code = [
    '<link>Learn more</link>', '你好', 'Claude 中文', '', '123', 'Hello\u0000',
  ].map(text => `f({defaultMessage:${JSON.stringify(text)}});`).join('');
  const catalog = catalogSources([source(code)]);
  assert.equal(catalog.messages.length, 0);
  assert.equal(catalog.summary.unsupportedOccurrences['rich-text-message'], 1);
  assert.equal(catalog.summary.unsupportedOccurrences['not-english-candidate'], 4);
  assert.equal(catalog.summary.unsupportedOccurrences['control-characters'], 1);
});

test('malformed/legacy escapes are reported instead of guessed', () => {
  const result = extractMessages(String.raw`f({defaultMessage:"Bad \uZZZZ"});f({defaultMessage:"Octal \123"});f({defaultMessage:"Bad \u{110000}"});`);
  assert.deepEqual(texts(result), []);
  assert.deepEqual(result.occurrences.map(entry => entry.reason), [
    'invalid-escape', 'legacy-numeric-escape', 'invalid-escape',
  ]);
});

test('syntax truncation is explicit partial coverage, never a silent successful catalog', () => {
  for (const tail of ['/*', '"unclosed', '/unterminated', 'f({defaultMessage:"Unclosed object"', ']', '`template ${name']) {
    const result = catalogSources([source(`f({defaultMessage:"Before truncation"});${tail}`)]);
    assert.equal(result.summary.complete, false, tail);
    assert.equal(result.files[0].diagnostics.length, 1, tail);
    assert.equal(result.messages[0].text, 'Before truncation');
    assert.equal(result.messages.some(entry => entry.text === 'Unclosed object'), false);
  }
});

test('bounded tokens, nesting, literal size, occurrences and aggregate bytes', () => {
  assert.throws(() => extractMessages('x'.repeat(101), { maxFileBytes: 100 }), /file-byte-limit/);
  assert.equal(extractMessages('f({defaultMessage:"Long enough"});', { maxTokens: 3 }).diagnostics[0].reason, 'token-limit');
  assert.equal(extractMessages('('.repeat(20) + ')'.repeat(20), { maxDepth: 4 }).diagnostics[0].reason, 'depth-limit');
  assert.equal(extractMessages('f({defaultMessage:"Long enough"});', { maxLiteralChars: 5 }).occurrences[0].reason, 'literal-too-large');
  assert.equal(extractMessages('f({defaultMessage:"One"});f({defaultMessage:"Two"});', { maxOccurrences: 1 }).diagnostics[0].reason, 'occurrence-limit');
  const catalog = catalogSources([source('a'.repeat(40), 'a.js'), source('b'.repeat(40), 'b.js')], { maxTotalBytes: 60 });
  assert.equal(catalog.summary.complete, false);
  assert.equal(catalog.files[1].diagnostics[0].reason, 'total-byte-limit');
  assert.throws(() => catalogSources([source('a', 'a.js'), source('b', 'b.js')], { maxFiles: 1 }), /bounded/);
  assert.throws(() => extractMessages('', { maxDepth: LIMITS.maxDepth + 1 }), /Invalid limit/);
  assert.throws(() => catalogSources([source('a', 'same.js'), source('b', 'same.js')]), /unique/);
});

test('long adversarial quoted/comment/regex content is handled without regex backtracking', { timeout: 5_000 }, () => {
  const decoy = '{defaultMessage:"Not a descriptor"}'.repeat(5000);
  const code = `/*${decoy}*/\nconst s=${JSON.stringify(decoy)};\nconst r=/[{}"]defaultMessage/;\nf({defaultMessage:"One real message"});`;
  const result = extractMessages(code);
  assert.equal(result.complete, true);
  assert.deepEqual(texts(result), ['One real message']);
});

test('reads actual local JS files, not their execution, and rejects URLs/non-JS paths', t => {
  const f = fixture(t);
  const marker = path.join(f.dir, 'must-not-exist');
  const code = `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},"NO");f({defaultMessage:"Local UI"});`;
  const file = f.write('chunk.js', code), before = hash(fs.readFileSync(file));
  const catalog = catalogFiles([file, file]);
  assert.equal(catalog.files.length, 1);
  assert.equal(catalog.messages[0].text, 'Local UI');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(hash(fs.readFileSync(file)), before);
  assert.throws(() => catalogFiles(['https://public.example/chunk.js']), /Local paths/);
  assert.throws(() => catalogFiles(['page.html']), /Expected .js/);
  const invalid = f.write('invalid.js', Buffer.from([0xff]));
  assert.equal(catalogFiles([invalid]).files[0].diagnostics[0].reason, 'invalid-utf8');
  assert.equal(catalogFiles([path.join(f.dir, 'missing.js')]).summary.complete, false);
  assert.equal(catalogFiles([file], { maxFileBytes: 1 }).files[0].diagnostics[0].reason, 'file-byte-limit');
});

test('CLI writes only JSON to stdout, signals partial scans and never fetches', t => {
  const f = fixture(t);
  const file = f.write('quoted name.js', 'f({defaultMessage:"CLI UI",id:"cli"});');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).messages[0].text, 'CLI UI');
  assert.deepEqual(fs.readdirSync(f.dir), ['quoted name.js']);
  const bad = f.write('bad.js', '/* unterminated');
  const partial = run(bad);
  assert.equal(partial.status, 2);
  assert.equal(JSON.parse(partial.stdout).summary.complete, false);
  assert.equal(run('https://public.example/chunk.js').status, 1);
  assert.equal(run().status, 1);
  assert.equal(run('--help').status, 0);
});

test('ASAR reads synthetic JS with provenance, never unpacks or changes the archive', async t => {
  const f = fixture(t);
  f.write('assets/native.js', 'f({defaultMessage:"Native UI",id:"native"});');
  f.write('assets/chunks/remote.mjs', 'f({defaultMessage:"Native UI",id:"duplicate"});f({defaultMessage:"Hello {name}"});');
  f.write('assets/not-js.txt', '{defaultMessage:"Do not read"}');
  const archive = path.join(f.dir, 'synthetic.asar');
  await finished(await asar.createPackage(path.join(f.dir, 'assets'), archive));
  const before = hash(fs.readFileSync(archive)), filesBefore = fs.readdirSync(f.dir);
  const catalog = await catalogAsar(archive);
  assert.equal(catalog.summary.complete, true, JSON.stringify(catalog.files.filter(file => !file.complete)));
  assert.equal(catalog.summary.files, 2);
  assert.equal(catalog.messages.length, 1);
  assert.equal(catalog.messages[0].sources.length, 2);
  assert.ok(catalog.messages[0].sources.every(entry => entry.file.startsWith(`${archive}!/`)));
  assert.equal(catalog.unsupported[0].text, 'Hello {name}');
  assert.equal(hash(fs.readFileSync(archive)), before);
  assert.deepEqual(fs.readdirSync(f.dir), filesBefore);
  await assert.rejects(catalogAsar(archive, { maxArchiveBytes: 1 }), /archive-byte-limit/);
  const malformed = f.write('bad.asar', Buffer.from([4, 0, 0, 0, 0xff, 0xff, 0xff, 0x7f]));
  await assert.rejects(catalogAsar(malformed), /invalid-or-oversized-asar-header/);
});

test('optional installed ASAR scan is read-only and prints metadata counts only', {
  skip: !process.env.CLAUDE_TW_CATALOG_ASAR,
}, async t => {
  const archive = process.env.CLAUDE_TW_CATALOG_ASAR;
  const before = fs.statSync(archive), catalog = await catalogAsar(archive), after = fs.statSync(archive);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(catalog.summary.complete, true, JSON.stringify(catalog.files.filter(file => !file.complete)));
  assert.ok(catalog.summary.plainUnique > 0);
  t.diagnostic(JSON.stringify(catalog.summary));
});
