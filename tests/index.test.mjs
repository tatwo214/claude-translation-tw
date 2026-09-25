import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildIndex } from '../claude-tw/index.mjs';

const script = fileURLToPath(new URL('../claude-tw/index.mjs', import.meta.url));
const appVersion = '1.2.3';
const appHash = 'a'.repeat(64);
const hash = (text) => createHash('sha256').update(text).digest('hex');

function fixture(t) {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), 'claudetw-index-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const write = (name, value) => writeFileSync(path.join(runtimeDir, name), JSON.stringify(value));
  const read = (name) => JSON.parse(readFileSync(path.join(runtimeDir, name), 'utf8'));
  const bytes = (name) => readFileSync(path.join(runtimeDir, name), 'utf8');
  const build = (extra = {}) => buildIndex({ runtimeDir, appVersion, appHash, ...extra });
  write('approved-app.json', { schema: 2, appVersion, appHash });
  write('overrides.json', { Settings: '設定', Chat: '聊天' });
  return { runtimeDir, write, read, bytes, build };
}

function report(extra = {}) {
  return {
    schema: 2, unknownCount: 7, mismatchCount: 0, appVersion,
    revision: 'b'.repeat(64), reportedAt: new Date().toISOString(), ...extra
  };
}

test('bundled UI supplements persist across restart and explicit overrides win', (t) => {
  const f=fixture(t);
  f.write('native-overrides.json', {'Quit':'結束','Chat':'對話'});
  f.write('web-overrides.json', {'Browse skills':'瀏覽技能'});
  assert.equal(f.build().knownCount,4);
  assert.deepEqual(f.read('snapshot.json').dictionary, {
    'Browse skills':'瀏覽技能', Chat:'聊天', Quit:'結束', Settings:'設定'
  });
  const before=f.bytes('snapshot.json');
  f.write('web-overrides.json',{'Browse skills':null});
  assert.equal(f.build().state,'error');
  assert.equal(f.bytes('snapshot.json'),before);
});

test('persists deterministic schema-2 snapshots and returns the persisted status', (t) => {
  const f = fixture(t);
  const approval = f.bytes('approved-app.json');
  assert.equal(f.build().state, 'ready');
  const first = f.read('snapshot.json');
  assert.equal(first.schema, 2);
  assert.equal(first.appVersion, appVersion);
  assert.equal(first.appHash, appHash);
  assert.deepEqual(first.dictionary, { Chat: '聊天', Settings: '設定' });
  assert.equal(first.revision, hash(JSON.stringify(first.dictionary)));
  assert.ok(Number.isFinite(Date.parse(first.builtAt)));
  f.write('overrides.json', { Chat: '聊天', Settings: '設定' });
  const status = f.build();
  assert.deepEqual(status, f.read('status.json'));
  assert.equal(status.knownCount, 2);
  assert.equal(status.unknownCount, 0);
  assert.equal(f.read('snapshot.json').revision, first.revision);
  assert.equal(f.bytes('approved-app.json'), approval);
  assert.equal(readdirSync(f.runtimeDir).some((name) => name.endsWith('.tmp')), false);
  f.write('overrides.json', { Chat: '對話' });
  assert.equal(f.build().knownCount, 1);
  assert.notEqual(f.read('snapshot.json').revision, first.revision);
});

test('persistence survives a new Node process and importing has no side effects', (t) => {
  const f = fixture(t);
  f.build();
  const before = readdirSync(f.runtimeDir);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../claude-tw/index.mjs', import.meta.url).href)})`
  ], { cwd: f.runtimeDir, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.deepEqual(readdirSync(f.runtimeDir), before);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { buildIndex } from ${JSON.stringify(new URL('../claude-tw/index.mjs', import.meta.url).href)};
    console.log(JSON.stringify(buildIndex(${JSON.stringify({ runtimeDir: f.runtimeDir, appVersion, appHash })})));
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), f.read('status.json'));
  assert.equal(f.read('snapshot.json').dictionary.Chat, '聊天');
});

test('missing, malformed, old-schema and mismatched approval never approve or replace a snapshot', async (t) => {
  for (const approval of [
    undefined, '{', null, [], { schema: 1, appVersion, appHash },
    { schema: 2, appVersion: '1.2.4', appHash },
    { schema: 2, appVersion, appHash: 'c'.repeat(64) },
    { schema: 2, appVersion, appHash: appHash.toUpperCase() }
  ]) {
    await t.test(JSON.stringify(approval) ?? 'missing', (t) => {
      const f = fixture(t);
      f.build();
      const snapshot = f.bytes('snapshot.json');
      if (approval === undefined) rmSync(path.join(f.runtimeDir, 'approved-app.json'));
      else if (approval === '{') writeFileSync(path.join(f.runtimeDir, 'approved-app.json'), approval);
      else f.write('approved-app.json', approval);
      const before = approval === undefined ? undefined : f.bytes('approved-app.json');
      assert.equal(f.build().state, 'unsupported');
      assert.equal(f.bytes('snapshot.json'), snapshot);
      if (approval === undefined) assert.ok(!readdirSync(f.runtimeDir).includes('approved-app.json'));
      else assert.equal(f.bytes('approved-app.json'), before);
    });
  }
});

test('actual version/hash must match exactly and invalid actual identities cannot build', (t) => {
  const f = fixture(t);
  for (const extra of [
    { appVersion: '1.2.4' }, { appHash: 'd'.repeat(64) },
    { appVersion: undefined }, { appHash: '' }, { appHash: undefined }
  ]) {
    assert.equal(f.build(extra).state, 'unsupported');
    assert.ok(!readdirSync(f.runtimeDir).includes('snapshot.json'));
  }
  f.write('approved-app.json', { schema: 2, appVersion, appHash: '' });
  assert.equal(f.build({ appHash: '' }).state, 'unsupported');
});

test('invalid overrides preserve the previous snapshot byte-for-byte', async (t) => {
  const invalid = [
    '{', 'null', '[]', '"text"', '{"Chat":null}', '{"Chat":3}',
    '{"Chat":{}}', '{"Chat":[]}', '{"Chat":true}', '{"": "空"}', '{"Chat":""}',
    '{"__proto__":"禁止"}', '{"constructor":"禁止"}', '{"prototype":"禁止"}',
    JSON.stringify({ ['x'.repeat(2001)]: '長' }),
    JSON.stringify({ Chat: '長'.repeat(1001) }),
    JSON.stringify(Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [`Key ${i}`, '值'])))
  ];
  for (const [i, input] of invalid.entries()) {
    await t.test(`invalid input ${i}`, (t) => {
      const f = fixture(t);
      f.build();
      const previous = f.bytes('snapshot.json');
      writeFileSync(path.join(f.runtimeDir, 'overrides.json'), input);
      const status = f.build();
      assert.equal(status.state, 'error');
      assert.equal(status.knownCount, 2);
      assert.equal(f.bytes('snapshot.json'), previous);
      assert.equal({}.polluted, undefined);
    });
  }
});

test('accepts exact size boundaries and an empty dictionary', (t) => {
  const f = fixture(t);
  const dictionary = Object.fromEntries(Array.from({ length: 19999 }, (_, i) => [`Key ${i}`, '值']));
  dictionary['x'.repeat(2000)] = '長'.repeat(1000);
  f.write('overrides.json', dictionary);
  assert.equal(f.build().knownCount, 20000);
  f.write('overrides.json', {});
  assert.equal(f.build().knownCount, 0);
  assert.deepEqual(f.read('snapshot.json').dictionary, {});
});

test('rejects 2000 valid Unicode entries over the bridge byte cap and preserves snapshot and counts', (t) => {
  const f = fixture(t);
  f.write('renderer-report.json', report({ mismatchCount: 1 }));
  assert.equal(f.build().state, 'needs-index');
  const previous = f.bytes('snapshot.json');
  const approval = f.bytes('approved-app.json');
  const reportBytes = f.bytes('renderer-report.json');
  const dictionary = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [
    `Key ${i} ${'x'.repeat(100)}`, '長'.repeat(400)
  ]));
  assert.equal(Object.keys(dictionary).length, 2000);
  assert.ok(Object.entries(dictionary).every(([source, value]) => source.length <= 500 && value.length <= 1000));
  const serialized = `${JSON.stringify({ ...f.read('snapshot.json'), dictionary }, null, 2)}\n`;
  assert.ok(serialized.length < 2_000_000, 'character count alone would incorrectly allow this snapshot');
  assert.ok(Buffer.byteLength(serialized) > 2_000_000);
  f.write('overrides.json', dictionary);
  const status = f.build();
  assert.equal(status.state, 'error');
  assert.match(status.message, /2[_,]?000[_,]?000/);
  assert.equal(status.knownCount, 2);
  assert.equal(status.unknownCount, 7);
  assert.equal(f.bytes('snapshot.json'), previous);
  assert.equal(f.bytes('approved-app.json'), approval);
  assert.equal(f.bytes('renderer-report.json'), reportBytes);
  assert.equal(readdirSync(f.runtimeDir).some((name) => name.endsWith('.tmp')), false);
});

test('missing overrides needs an index and preserves the last snapshot', (t) => {
  const f = fixture(t);
  f.build();
  const previous = f.bytes('snapshot.json');
  rmSync(path.join(f.runtimeDir, 'overrides.json'));
  assert.equal(f.build().state, 'needs-index');
  assert.equal(f.bytes('snapshot.json'), previous);
});

test('unknown counts survive changed revisions, repeat builds and absent reports', (t) => {
  const f = fixture(t);
  f.build();
  f.write('renderer-report.json', report({ text: 'PRIVATE RENDERER CONTENT' }));
  const reportBytes = f.bytes('renderer-report.json');
  f.write('overrides.json', { Chat: '對話', New: '新增', Settings: '設定' });
  for (let i = 0; i < 2; i++) {
    const status = f.build();
    assert.equal(status.state, 'needs-index');
    assert.equal(status.unknownCount, 7);
    assert.equal(status.knownCount, 3);
  }
  assert.equal(f.bytes('renderer-report.json'), reportBytes);
  assert.doesNotMatch(f.bytes('snapshot.json') + f.bytes('status.json'), /PRIVATE RENDERER CONTENT/);
  rmSync(path.join(f.runtimeDir, 'renderer-report.json'));
  assert.equal(f.build().unknownCount, 7);
  f.write('renderer-report.json', report({ unknownCount: 0 }));
  assert.equal(f.build().state, 'ready');
  assert.equal(f.read('status.json').unknownCount, 0);
});

test('mismatch counts keep needs-index without being added to unknown counts', (t) => {
  const f = fixture(t);
  f.write('renderer-report.json', report({ unknownCount: 0, mismatchCount: 2 }));
  const status = f.build();
  assert.equal(status.state, 'needs-index');
  assert.equal(status.unknownCount, 0);
  assert.equal(f.build().state, 'needs-index');
});

test('blank mismatch revision recovers missing or corrupt snapshots without clearing renderer counts', async (t) => {
  for (const snapshotState of ['missing', 'corrupt']) {
    for (const unknownCount of [0, 7]) {
      await t.test(`${snapshotState}, unknownCount=${unknownCount}`, (t) => {
        const f = fixture(t);
        if (snapshotState === 'corrupt') {
          writeFileSync(path.join(f.runtimeDir, 'snapshot.json'), '{');
        }
        const approval = f.bytes('approved-app.json');
        f.write('renderer-report.json', report({ revision: '', mismatchCount: 1, unknownCount }));
        const reportBytes = f.bytes('renderer-report.json');
        for (let i = 0; i < 2; i++) {
          const status = f.build();
          assert.equal(status.state, 'needs-index');
          assert.equal(status.knownCount, 2);
          assert.equal(status.unknownCount, unknownCount);
          const snapshot = f.read('snapshot.json');
          assert.equal(snapshot.schema, 2);
          assert.equal(snapshot.appVersion, appVersion);
          assert.equal(snapshot.appHash, appHash);
          assert.deepEqual(snapshot.dictionary, { Chat: '聊天', Settings: '設定' });
          assert.equal(snapshot.revision, hash(JSON.stringify(snapshot.dictionary)));
        }
        assert.equal(f.bytes('approved-app.json'), approval);
        assert.equal(f.bytes('renderer-report.json'), reportBytes);
        f.write('renderer-report.json', report({
          revision: f.read('snapshot.json').revision, mismatchCount: 0, unknownCount: 0
        }));
        assert.equal(f.build().state, 'ready');
      });
    }
  }
});

test('blank mismatch revision cannot grant or bypass installer approval', async (t) => {
  for (const approvalState of ['missing', 'wrong-version', 'wrong-hash']) {
    await t.test(approvalState, (t) => {
      const f = fixture(t);
      f.write('renderer-report.json', report({ revision: '', mismatchCount: 1 }));
      if (approvalState === 'missing') rmSync(path.join(f.runtimeDir, 'approved-app.json'));
      else f.write('approved-app.json', {
        schema: 2,
        appVersion: approvalState === 'wrong-version' ? '9.0' : appVersion,
        appHash: approvalState === 'wrong-hash' ? 'c'.repeat(64) : appHash
      });
      const before = approvalState === 'missing' ? undefined : f.bytes('approved-app.json');
      assert.equal(f.build().state, 'unsupported');
      assert.ok(!readdirSync(f.runtimeDir).includes('snapshot.json'));
      if (approvalState === 'missing') assert.ok(!readdirSync(f.runtimeDir).includes('approved-app.json'));
      else assert.equal(f.bytes('approved-app.json'), before);
    });
  }
});

test('another app version report cannot replace this app count', (t) => {
  const f = fixture(t);
  f.write('renderer-report.json', report());
  f.build();
  f.write('renderer-report.json', report({ appVersion: '9.0', unknownCount: 0 }));
  assert.equal(f.build().unknownCount, 7);
});

test('malformed reports preserve snapshot and last trusted unknown count', async (t) => {
  for (const value of [
    '{', null, [], report({ schema: 1 }), report({ unknownCount: -1 }),
    report({ unknownCount: '7' }), report({ unknownCount: Number.MAX_SAFE_INTEGER + 1 }),
    report({ mismatchCount: 0.5 }), report({ revision: 'invalid' }),
    report({ reportedAt: 'invalid' }), report({ appVersion: null }),
    report({ revision: '', mismatchCount: 0 }),
    report({ revision: '', mismatchCount: -1 }),
    report({ revision: '', mismatchCount: '1' }),
    report({ revision: '', mismatchCount: 0.5 }),
    report({ revision: '', mismatchCount: Number.MAX_SAFE_INTEGER + 1 }),
    report({ revision: '', mismatchCount: 1, unknownCount: '7' }),
    report({ revision: '', mismatchCount: 1, schema: '2' }),
    report({ revision: '', mismatchCount: 1, appVersion: '' }),
    report({ revision: '', mismatchCount: 1, reportedAt: 'invalid' }),
    report({ revision: ' ', mismatchCount: 1 }),
    report({ revision: 'invalid', mismatchCount: 1 }),
    report({ revision: null, mismatchCount: 1 }),
    report({ revision: undefined, mismatchCount: 1 })
  ]) {
    await t.test(JSON.stringify(value), (t) => {
      const f = fixture(t);
      f.write('renderer-report.json', report());
      f.build();
      const previous = f.bytes('snapshot.json');
      if (value === '{') writeFileSync(path.join(f.runtimeDir, 'renderer-report.json'), value);
      else f.write('renderer-report.json', value);
      const status = f.build();
      assert.equal(status.state, 'error');
      assert.equal(status.unknownCount, 7);
      assert.equal(f.bytes('snapshot.json'), previous);
    });
  }
});

test('failed atomic publish leaves no temporary file and reports error', (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.runtimeDir, 'snapshot.json'));
  writeFileSync(path.join(f.runtimeDir, 'snapshot.json', 'preserve'), 'existing');
  assert.equal(f.build().state, 'error');
  assert.equal(readFileSync(path.join(f.runtimeDir, 'snapshot.json', 'preserve'), 'utf8'), 'existing');
  assert.equal(readdirSync(f.runtimeDir).some((name) => name.endsWith('.tmp')), false);
});

test('CLI rejects bad arguments without writing runtime state', (t) => {
  const f = fixture(t);
  for (const args of [[], ['--rebuild', '--app'], ['--rebuild', '--wat'], ['--rebuild', '--rebuild']]) {
    const child = spawnSync(process.execPath, [script, '--runtime', f.runtimeDir, ...args], { encoding: 'utf8' });
    assert.equal(child.status, 2);
    assert.match(child.stderr, /Usage:/);
    assert.ok(!readdirSync(f.runtimeDir).includes('status.json'));
  }
});

test('CLI treats unreadable apps as unsupported and never creates approval', (t) => {
  const f = fixture(t);
  rmSync(path.join(f.runtimeDir, 'approved-app.json'));
  const child = spawnSync(process.execPath, [
    script, '--rebuild', '--runtime', f.runtimeDir, '--app', path.join(f.runtimeDir, 'Missing.app')
  ], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).state, 'unsupported');
  assert.ok(!readdirSync(f.runtimeDir).includes('approved-app.json'));
  assert.ok(!readdirSync(f.runtimeDir).includes('snapshot.json'));
});

test('CLI reads a fixture app using PlistBuddy and hashes actual ASAR bytes', { skip: process.platform !== 'darwin' }, (t) => {
  const f = fixture(t);
  const app = path.join(f.runtimeDir, 'Fixture App.app');
  mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${appVersion}</string></dict></plist>`);
  const asar = path.join(app, 'Contents', 'Resources', 'app.asar');
  writeFileSync(asar, 'offline fixture ASAR bytes');
  f.write('approved-app.json', { schema: 2, appVersion, appHash: hash('offline fixture ASAR bytes') });
  const run = () => spawnSync(process.execPath, [
    script, '--rebuild', '--runtime', f.runtimeDir, '--app', app
  ], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).state, 'ready');
  assert.equal(f.read('snapshot.json').appHash, hash('offline fixture ASAR bytes'));
  for (const snapshotState of ['missing', 'corrupt']) {
    if (snapshotState === 'missing') rmSync(path.join(f.runtimeDir, 'snapshot.json'));
    else writeFileSync(path.join(f.runtimeDir, 'snapshot.json'), '{');
    f.write('renderer-report.json', report({ revision: '', mismatchCount: 1, unknownCount: 0 }));
    for (let i = 0; i < 2; i++) {
      const recovered = run();
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).state, 'needs-index');
      assert.equal(f.read('snapshot.json').revision, hash(JSON.stringify(f.read('snapshot.json').dictionary)));
    }
    f.write('renderer-report.json', report({
      revision: f.read('snapshot.json').revision, mismatchCount: 0, unknownCount: 0
    }));
    const confirmed = run();
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.equal(JSON.parse(confirmed.stdout).state, 'ready');
  }
  const previous = f.bytes('snapshot.json');
  writeFileSync(asar, 'updated app');
  const second = run();
  assert.equal(second.status, 1);
  assert.equal(JSON.parse(second.stdout).state, 'unsupported');
  assert.equal(f.bytes('snapshot.json'), previous);
});
