import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  applyNativePatches, extraDescriptors, extraTranslations
} from '../scripts/native-patches.mjs';

// The review plan is an independent input fixture, not a production dependency.
// Only isolated, known snippets are executed below, with mocked dependencies.
// Tests never load/execute an ASAR, Electron, the real main, or application data.
const plan = JSON.parse(fs.readFileSync(
  new URL('./fixtures/public/native-hardcoded-plan.json', import.meta.url), 'utf8'
));
const consentPrefix = 'const g=i==="read"?"preview":"open";return(await aA.dialog.showMessageBox(e,{';
const consentSuffix = '}))';
const proposals = plan.proposals.map(p => {
  if (p.id !== 'file-access-consent') return p;
  const replacement = p.replacement
    .replace('):Ee().formatMessage({id:"claudetw.native.literal.file-open-question"',
      '):i==="open"?Ee().formatMessage({id:"claudetw.native.literal.file-open-question"')
    .replace(',detail:i===', ':`Allow Claude to ${g} this file?`,detail:i===')
    .replace('):Ee().formatMessage({id:"claudetw.native.literal.file-open-detail"',
      '):i==="open"?Ee().formatMessage({id:"claudetw.native.literal.file-open-detail"')
    + ':`${t}\n\nThis will allow Claude to ${g} the file${i==="open"?" with your default application":""}.`';
  return { ...p, needle: consentPrefix + p.needle + consentSuffix,
    replacement: consentPrefix + replacement + consentSuffix };
});
const active = proposals.filter(p => !p.id.startsWith('native-renderer-'));
const deferred = proposals.filter(p => p.id.startsWith('native-renderer-'));
// Explicit review corrections; leave the historical evidence plan unchanged.
const reviewedTranslations = {
  'claudetw.native.literal.workspace-cleanup-detail':
    '以下是占用空間最大的閒置{sessionCount, plural, one {工作階段} other {工作階段}}：\n\n{sessionList}\n\n清理後將從 Claude 工作區釋放約 {size} 的工作檔案空間。工作階段紀錄與輸出檔案會保留，但繼續這些工作階段時，可能因缺少工作檔案而出現非預期行為。',
  'claudetw.native.literal.artifact-run-task-detail':
    '即時作品「{artifact}」要求執行排程任務「{task}」。',
  'claudetw.native.literal.artifact-connector-detail':
    '即時作品「{artifact}」要求呼叫可修改資料的連接器工具「{tool}」。這項要求並非由你的點擊或按鍵操作觸發。'
};
const prefix = '\n/* unchanged: 私人 $& $` $\' */\n';
const start = id => `\n/* fixture:${id}:start */\n`;
const end = id => `\n/* fixture:${id}:end */\n`;
const fixture = prefix + proposals.map(p => start(p.id) + p.needle + end(p.id)).join('');
const patched = applyNativePatches(fixture);
function fragment(id) {
  const from = patched.indexOf(start(id)) + start(id).length;
  return patched.slice(from, patched.indexOf(end(id), from));
}

test('exactly 12 approved-plan patches; both renderer boundaries remain byte-identical', () => {
  assert.equal(active.length, 12);
  assert.equal(deferred.length, 2);
  let expected = fixture;
  for (const p of active) {
    const replacement = p.id === 'workspace-session-row'
      ? p.replacement.replace('returnEe()', 'return Ee()') : p.replacement;
    expected = expected.replace(p.needle, () => replacement);
    assert.equal(fragment(p.id), replacement, p.id);
  }
  assert.equal(patched, expected);
  for (const p of deferred) assert.equal(fragment(p.id), p.needle);
  assert.ok(!patched.includes('.nativeLocale('));
  assert.equal(applyNativePatches(fixture), patched, 'deterministic');
});

test('preflight rejects every missing, duplicate, drifted and partially patched needle', () => {
  for (const p of active) {
    const escapedId = p.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const error = new RegExp(escapedId);
    assert.throws(() => applyNativePatches(fixture.replace(p.needle, '')), error);
    assert.throws(() => applyNativePatches(fixture + p.needle), error);
    assert.throws(() => applyNativePatches(fixture.replace(p.needle, p.needle.slice(1))), error);
    assert.throws(() => applyNativePatches(fixture.replace(p.needle, () => fragment(p.id))), error);
  }
  assert.throws(() => applyNativePatches(patched), /needle missing/);
  assert.equal(fixture.startsWith(prefix), true, 'caller input is unchanged');
});

test('renderer needles are neither required nor uniqueness-checked', () => {
  let absent = fixture, duplicated = fixture;
  for (const p of deferred) {
    absent = absent.replace(p.needle, '');
    duplicated += p.needle;
  }
  assert.doesNotThrow(() => applyNativePatches(absent));
  const result = applyNativePatches(duplicated);
  for (const p of deferred) assert.equal(result.split(p.needle).length - 1, 2);
});

test('file-consent needle pins complete g mapping and dialog boundary', () => {
  for (const mapping of [
    'const g=i==="read"?"open":"preview";',
    'const g=i==="open"?"open":"preview";',
    'const g=operationForMode(i);'
  ]) {
    const changed = fixture.replace('const g=i==="read"?"preview":"open";', mapping);
    assert.throws(() => applyNativePatches(changed), /needle missing: file-access-consent/);
  }
  const bodyOnly = fixture.replace(consentPrefix, '').replace(consentSuffix + end('file-access-consent'),
    end('file-access-consent'));
  assert.throws(() => applyNativePatches(bodyOnly), /needle missing: file-access-consent/);
  assert.ok(fragment('file-access-consent').startsWith(consentPrefix));
  assert.ok(fragment('file-access-consent').endsWith(consentSuffix));
});

test('pure string transformer rejects other types and never executes supplied source', () => {
  for (const value of [undefined, null, 1, {}, [], Buffer.from(fixture), new String(fixture)]) {
    assert.throws(() => applyNativePatches(value), TypeError);
  }
  const untrusted = 'throw new Error("must not execute");\nnot valid JavaScript!;\n';
  assert.ok(applyNativePatches(untrusted + fixture).startsWith(untrusted));
  const moduleSource = fs.readFileSync(new URL('../scripts/native-patches.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(moduleSource, /\beval\s*\(|new\s+Function\s*\(|\bvm\.|^\s*import\s/m);
  assert.doesNotMatch(moduleSource, /readFile|writeFile|fetch\s*\(|child_process/);
});

test('exports only immutable explicit descriptor pairs and literal translations', () => {
  assert.equal(Object.keys(extraDescriptors).length, 31);
  assert.equal(Object.keys(extraTranslations).length, 38);
  assert.ok(Object.isFrozen(extraDescriptors));
  assert.ok(Object.isFrozen(extraTranslations));
  const seen = new Map();
  for (const p of active) {
    const re = /Ee\(\)\.formatMessage\(\{id:("(?:\\.|[^"\\])*"),defaultMessage:("(?:\\.|[^"\\])*")\}/g;
    for (const m of fragment(p.id).matchAll(re)) {
      const [id, source] = [JSON.parse(m[1]), JSON.parse(m[2])];
      assert.equal(extraDescriptors[id], source);
      assert.equal(typeof extraTranslations[source], 'string');
      seen.set(id, source);
    }
  }
  assert.deepEqual(Object.fromEntries(seen), extraDescriptors);
  for (const p of plan.proposedLiteralDescriptors) {
    assert.equal(extraDescriptors[p.id], p.english);
    assert.equal(extraTranslations[p.english], reviewedTranslations[p.id] ?? p.zhTW);
  }
  for (const p of plan.roleLabels) assert.equal(extraTranslations[p.english], p.zhTW);
  for (const [source, value] of Object.entries(extraTranslations)) {
    assert.ok(source.length > 0 && source.length <= 500);
    assert.ok(value.length > 0 && value.length <= 1000);
    assert.ok(!['__proto__', 'prototype', 'constructor'].includes(source));
  }
});

test('cleanup translation retains ICU plural branches and all original parameters', () => {
  const source = extraDescriptors['claudetw.native.literal.workspace-cleanup-detail'];
  const translation = extraTranslations[source];
  assert.ok(translation.startsWith(
    '以下是占用空間最大的閒置{sessionCount, plural, one {工作階段} other {工作階段}}：'
  ));
  function parameters(template) {
    const simplified = template.replace(
      /\{(\w+), plural, one \{[^{}]*\} other \{[^{}]*\}\}/g, '{$1}'
    );
    return [...simplified.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  }
  assert.deepEqual(parameters(translation), parameters(source));
  assert.deepEqual(parameters(translation), ['sessionCount', 'sessionList', 'size']);
});

test('live artifact uses 即時作品 consistently and retains private-value tokens', () => {
  const rows = Object.entries(extraTranslations).filter(([source]) => source.includes('live artifact'));
  assert.equal(rows.length, 2);
  for (const [source, translation] of rows) {
    assert.ok(translation.startsWith('即時作品'));
    assert.deepEqual(
      [...translation.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(),
      [...source.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
    );
  }
  assert.ok(Object.values(extraTranslations).every(value => !value.includes('即時成品')));
});

function roleHarness({ mac = true, snapshot } = {}) {
  let state = snapshot ?? { schema: 2, enabled: true, compatible: true, dictionary: extraTranslations };
  const click = () => 'original action';
  const accelerator = 'CmdOrCtrl+Shift+V';
  let tree, builds = 0;
  function templates() {
    tree = [
      { label: 'Claude', submenu: [
        { role: 'services', submenu: [{ role: 'hide', label: 'Hide Claude', click }] },
        { role: 'hide', click, accelerator, enabled: false },
        { role: 'hideOthers' }, { role: 'unhide' },
        { role: 'hide', label: 'Private document {name}', click },
        { label: 'Hide Claude', click }, { type: 'separator' }
      ] },
      { label: 'File', submenu: [{ role: 'hide', label: 'Hide Claude', click }] },
      { label: 'Edit', submenu: [
        { role: 'pasteAndMatchStyle', label: 'Paste and Match Style',
          click, accelerator, visible: false, acceleratorWorksWhenHidden: true },
        { role: 'copy', label: 'Copy', click },
        { label: 'recent documents', submenu: [{ role: 'minimize', label: 'Minimize' }] }
      ] },
      { label: 'Debug', submenu: [{ role: 'hide', label: 'Hide Claude', click }] },
      { role: 'window', label: 'Window', submenu: [
        { role: 'minimize' }, { role: 'front' }, { label: 'Private window title', click }
      ] },
      { label: 'Help', submenu: [{ role: 'front', label: 'Bring All to Front' }] }
    ];
    return tree;
  }
  const context = vm.createContext({
    Or: mac, M8r: async () => templates(), N8r: async () => templates(),
    require(name) {
      assert.equal(name, './claudetw-main.cjs');
      return { snapshot() { if (state instanceof Error) throw state; return state; } };
    },
    aA: { Menu: { buildFromTemplate(input) {
      builds++;
      assert.equal(input, tree);
      return { items: input };
    } } }
  });
  vm.runInContext(fragment('application-menu-roles'), context);
  return { run: () => context.eiA(), update: value => { state = value; },
    click, accelerator, builds: () => builds };
}

test('mock Menu localizes all seven roles only in exact app/edit/window root scopes', async () => {
  const h = roleHarness();
  const { items: t } = await h.run();
  assert.equal(h.builds(), 1);
  for (const [role, item] of [
    ['services', t[0].submenu[0]], ['hide', t[0].submenu[1]],
    ['hideOthers', t[0].submenu[2]], ['unhide', t[0].submenu[3]],
    ['pasteAndMatchStyle', t[2].submenu[0]],
    ['minimize', t[4].submenu[0]], ['front', t[4].submenu[1]]
  ]) assert.equal(item.label, plan.roleLabels.find(p => p.role === role).zhTW);
  for (const item of [t[0].submenu[1], t[2].submenu[0]]) {
    assert.equal(item.click, h.click);
    assert.equal(item.accelerator, h.accelerator);
  }
  assert.equal(t[0].submenu[1].enabled, false);
  assert.equal(t[2].submenu[0].visible, false);
  assert.equal(t[2].submenu[0].acceleratorWorksWhenHidden, true);
  assert.equal(t[0].submenu[6].type, 'separator');
  assert.equal(t[0].submenu[0].submenu[0].label, 'Hide Claude', 'services descendants');
  assert.equal(t[0].submenu[4].label, 'Private document {name}', 'custom role label');
  assert.equal(t[0].submenu[5].label, 'Hide Claude', 'roleless private name');
  assert.equal(t[1].submenu[0].label, 'Hide Claude', 'File root');
  assert.equal(t[2].submenu[1].label, 'Copy', 'other roles');
  assert.equal(t[2].submenu[2].submenu[0].label, 'Minimize', 'recent document descendants');
  assert.equal(t[3].submenu[0].label, 'Hide Claude', 'Debug root');
  assert.equal(t[4].label, 'Window', 'root label');
  assert.equal(t[4].submenu[2].label, 'Private window title');
  assert.equal(t[5].submenu[0].label, 'Bring All to Front', 'Help root');
});

test('mock Menu fails closed for inactive/bad snapshots and preserves non-macOS templates', async () => {
  const good = { schema: 2, enabled: true, compatible: true, dictionary: extraTranslations };
  const cases = [
    null, {}, new Error('bridge unavailable'), { ...good, schema: 1 },
    { ...good, enabled: false }, { ...good, enabled: 'true' },
    { ...good, compatible: false }, { ...good, compatible: 1 },
    { ...good, dictionary: {} }, { ...good, dictionary: 'invalid' },
    { ...good, dictionary: Object.create(extraTranslations) }
  ];
  for (const snapshot of cases) {
    const h = roleHarness();
    h.update(snapshot);
    const { items } = await h.run();
    assert.equal(Object.hasOwn(items[0].submenu[1], 'label'), false);
    assert.equal(items[2].submenu[0].label, 'Paste and Match Style');
    assert.equal(h.builds(), 1);
  }
  for (const label of ['', 4, null, {}, '字'.repeat(1001)]) {
    const h = roleHarness({ snapshot: { ...good, dictionary: { 'Hide Claude': label } } });
    assert.equal(Object.hasOwn((await h.run()).items[0].submenu[1], 'label'), false);
  }
  const windows = roleHarness({ mac: false });
  const result = await windows.run();
  assert.equal(Object.hasOwn(result.items[0].submenu[1], 'label'), false);
  assert.equal(result.items[2].submenu[0].label, 'Paste and Match Style');
});

test('normal upstream menu rebuild picks up refresh and restores defaults on disable', async () => {
  const h = roleHarness();
  assert.equal((await h.run()).items[0].submenu[1].label, '隱藏 Claude');
  h.update({ schema: 2, enabled: true, compatible: true, dictionary: { 'Hide Claude': '隱藏應用程式' } });
  assert.equal((await h.run()).items[0].submenu[1].label, '隱藏應用程式');
  h.update({ schema: 2, enabled: false, compatible: true, dictionary: extraTranslations });
  assert.equal(Object.hasOwn((await h.run()).items[0].submenu[1], 'label'), false);
  assert.equal(h.builds(), 3);
});

// Synthetic formatter: verifies descriptor identity and records exact values.
// It only implements the one known plural and simple value tokens for fixtures.
// Substituted values are returned as text, never recursively parsed.
function formatter(translated = true) {
  const calls = [];
  const Ee = () => ({ formatMessage(descriptor, values) {
    assert.equal(extraDescriptors[descriptor.id], descriptor.defaultMessage);
    calls.push({ descriptor, values });
    const template = translated ? extraTranslations[descriptor.defaultMessage] : descriptor.defaultMessage;
    return template.replace(
      /\{sessionCount, plural, one \{([^{}]*)\} other \{([^{}]*)\}\}|\{(\w+)\}/g,
      (match, one, other, key) => key ? String(values[key]) : values.sessionCount === 1 ? one : other
    );
  } });
  return { Ee, calls };
}
function options(id, bindings = {}, translated = true) {
  const f = formatter(translated);
  const context = vm.createContext({ ...bindings, Ee: f.Ee });
  const code = id === 'file-access-consent'
    ? fragment(id).slice(consentPrefix.length, -consentSuffix.length)
    : fragment(id).replace(/^r=/, '');
  // Compile only a whitelisted fixture expression, never a supplied main source.
  const value = vm.runInContext(code.startsWith('{') ? `(${code})` : `({${code}})`, context);
  return { value, calls: f.calls };
}

test('microphone button labels preserve order and surrounding callbacks/navigation bytes', () => {
  for (const [id, english, chinese] of [
    ['microphone-before-use-buttons', ['Open System Settings', 'Cancel'], ['開啟系統設定', '取消']],
    ['microphone-hotkey-buttons', ['Open System Settings', 'Open Claude Settings', 'Cancel'],
      ['開啟系統設定', '開啟 Claude 設定', '取消']]
  ]) {
    assert.deepEqual(Array.from(options(id).value.buttons), chinese);
    assert.deepEqual(Array.from(options(id, {}, false).value.buttons), english);
    const p = active.find(p => p.id === id);
    const tail = '}).then(i=>{i.response===0?openSettings():i.response===1&&navigate("/settings/desktop")});';
    const wrapped = fixture.replace(p.needle, `aA.dialog.showMessageBox({${p.needle}${tail}`);
    assert.ok(applyNativePatches(wrapped).includes(fragment(id) + tail));
  }
});

test('file read/open dialog preserves path values, English fallback and denial default', () => {
  const path = '/private/Cancel/{artifact}/<strong>病歷</strong>.pdf';
  for (const mode of ['read', 'open']) {
    const { value, calls } = options('file-access-consent', { t: path, i: mode });
    assert.equal(value.type, 'question');
    assert.equal(value.defaultId, 0);
    assert.equal(value.cancelId, 0);
    assert.deepEqual(Array.from(value.buttons), ['取消', '允許']);
    assert.ok(value.detail.startsWith(path + '\n\n'));
    assert.equal(calls.find(c => c.values)?.values.path, path);
    const original = plan.proposals.find(p => p.id === 'file-access-consent').needle;
    const old = vm.runInNewContext(`({${original}})`, { t: path, i: mode, g: mode === 'read' ? 'preview' : 'open' });
    const fallback = options('file-access-consent', { t: path, i: mode }, false).value;
    assert.equal(JSON.stringify(fallback), JSON.stringify(old));
  }
});

test('unknown file modes preserve original message/detail without claiming default-app access', () => {
  const path = '/private/Cancel/{path}/record.pdf';
  const original = plan.proposals.find(p => p.id === 'file-access-consent').needle;
  for (const mode of [undefined, null, '', 'READ', 'preview', 'write', 'reveal', false, 0, {}, ['open']]) {
    const g = mode === 'read' ? 'preview' : 'open';
    const old = vm.runInNewContext(`({${original}})`, { t: path, i: mode, g });
    const { value, calls } = options('file-access-consent', { t: path, i: mode, g });
    assert.equal(value.message, old.message);
    assert.equal(value.detail, old.detail);
    assert.ok(!value.detail.includes('default application'));
    assert.equal(value.defaultId, old.defaultId);
    assert.equal(value.cancelId, old.cancelId);
    assert.equal(calls.some(c => /file-(?:preview|open)-/.test(c.descriptor.id)), false);
  }
});

test('complete file-consent block keeps original response mapping, values and approval actions', async () => {
  const original = active.find(p => p.id === 'file-access-consent').needle;
  // Exact original response tail; actions are spies, never actual authorization.
  const tail = '.response===0?(S.info(`checkFileAccessConsent: user declined to ${g} ${t}`),!1):(Ii.recordUserFileAccessApproval(A,r),!0)';
  async function run(block, mode, response) {
    const calls = [], approvals = [], logs = [];
    const window = {}, path = '/private/{g}/Allow.pdf', account = {}, resolved = {};
    const context = vm.createContext({
      Ee: formatter().Ee,
      aA: { dialog: { async showMessageBox(...args) { calls.push(args); return { response }; } } },
      S: { info: (...args) => logs.push(args) },
      Ii: { recordUserFileAccessApproval: (...args) => approvals.push(args) }
    });
    vm.runInContext(`async function consent(e,A,t,i,r){${block}${tail}}`, context);
    const result = await context.consent(window, account, path, mode, resolved);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], window);
    assert.equal(calls[0][1].defaultId, 0);
    assert.equal(calls[0][1].cancelId, 0);
    assert.ok(calls[0][1].detail.startsWith(path + '\n\n'));
    if (response === 0) assert.equal(approvals.length, 0);
    else {
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0][0], account);
      assert.equal(approvals[0][1], resolved);
    }
    return { result, logs, approvalCount: approvals.length };
  }
  for (const mode of ['read', 'open', 'unknown', null, undefined]) {
    for (const response of [0, 1, 2, -1]) {
      assert.deepEqual(await run(fragment('file-access-consent'), mode, response),
        await run(original, mode, response));
    }
  }
});

test('workspace dialogs retain byte counts, private list, safe defaults and full warning', () => {
  const nm = n => `${n} MB`;
  const list = '  • Cancel {size} <secret>\n  • My private session';
  const bindings = { i: { freeBytes: 10, totalBytes: 100 }, nm, a: list, s: 25, o: [{}, {}], g: 'sessions' };
  for (const id of ['workspace-cleanup-unavailable', 'workspace-cleanup-no-candidates', 'workspace-cleanup-confirm']) {
    const { value, calls } = options(id, bindings);
    assert.equal(value.type, 'warning');
    assert.ok(value.message.includes('10 MB') && value.message.includes('100 MB'));
    const old = vm.runInNewContext(`({${active.find(p => p.id === id).needle}})`, bindings);
    assert.equal(JSON.stringify(options(id, bindings, false).value), JSON.stringify(old));
    if (id === 'workspace-cleanup-confirm') {
      assert.equal(value.defaultId, 1);
      assert.equal(value.cancelId, 1);
      assert.deepEqual(Array.from(value.buttons), ['清理', '取消']);
      assert.ok(value.detail.includes(list));
      assert.ok(value.detail.startsWith('以下是占用空間最大的閒置工作階段：'));
      assert.ok(value.detail.includes('工作階段紀錄與輸出檔案會保留'));
      const detail = calls.find(c => c.values?.sessionList);
      assert.equal(detail.values.sessionList, list);
      assert.equal(detail.values.sessionCount, 2);
      assert.equal(detail.values.size, '25 MB');
    } else assert.deepEqual(Array.from(value.buttons), ['好']);
  }
});

test('session row executes return Ee, keeps private title literal and does not mutate sessions', () => {
  const f = formatter();
  const title = 'Cancel {relativeTime} <tag>private</tag>';
  const session = Object.freeze({ title, archived: true, modTime: 10, sizeBytes: 25 });
  const context = vm.createContext({
    Ee: f.Ee, o: Object.freeze([session]), r: 20, nm: n => `${n} MB`, AGr: () => '剛剛'
  });
  vm.runInContext('let ' + fragment('workspace-session-row'), context);
  const rows = vm.runInContext('a', context);
  assert.equal(rows[0], `  • ${title}（已封存） — 25 MB，上次使用：剛剛`);
  assert.equal(f.calls.at(-1).values.title, title);
  assert.equal(session.title, title);
  assert.doesNotMatch(fragment('workspace-session-row'), /returnEe/);
});

test('relative-time thresholds and English fallback stay equivalent to original AGr', () => {
  const original = active.find(p => p.id === 'workspace-relative-time').needle;
  const baseline = vm.createContext({});
  vm.runInContext(original, baseline);
  const fallback = vm.createContext({ Ee: formatter(false).Ee });
  vm.runInContext(fragment('workspace-relative-time'), fallback);
  const chinese = vm.createContext({ Ee: formatter(true).Ee });
  vm.runInContext(fragment('workspace-relative-time'), chinese);
  for (const seconds of [-1, 0, 59, 60, 119, 120, 3599, 3600, 7199, 7200, 86399, 86400, 172800]) {
    assert.equal(fallback.AGr(seconds), baseline.AGr(seconds), String(seconds));
  }
  assert.equal(chinese.AGr(-1), '剛剛');
  assert.equal(chinese.AGr(120), '2 分鐘前');
  assert.equal(chinese.AGr(3600), '1 小時前');
  assert.equal(chinese.AGr(172800), '2 天前');
});

test('artifact consent keeps exact private value references, checkbox and response indices', () => {
  const name = 'Cancel {tool} <b>Private</b>';
  const task = 'Allow {artifact}';
  for (const [id, bindings, button] of [
    ['artifact-run-scheduled-task', { i: name, A: task }, '執行'],
    ['artifact-connector-consent', { t: name, A: task }, '允許']
  ]) {
    const { value, calls } = options(id, bindings);
    assert.equal(value.defaultId, 1);
    assert.equal(value.cancelId, 1);
    assert.deepEqual(Array.from(value.buttons), [button, '取消']);
    assert.ok(value.message.includes(name));
    assert.ok(value.detail.includes(task));
    for (const c of calls.filter(c => c.values)) {
      assert.equal(c.values.artifact, name);
      if (c.values.task !== undefined) assert.equal(c.values.task, task);
      if (c.values.tool !== undefined) assert.equal(c.values.tool, task);
    }
    if (id === 'artifact-run-scheduled-task') {
      assert.equal(value.checkboxChecked, false);
      assert.equal(value.checkboxLabel, '不再詢問這個任務');
    } else assert.ok(value.detail.includes('可修改資料') && value.detail.includes('並非由你的點擊或按鍵操作觸發'));
    const old = vm.runInNewContext(`(${active.find(p => p.id === id).needle.slice(2)})`, bindings);
    assert.equal(JSON.stringify(options(id, bindings, false).value), JSON.stringify(old));
  }
});

test('dialog option patches preserve surrounding actions byte-for-byte', () => {
  const id = 'artifact-run-scheduled-task';
  const p = active.find(p => p.id === id);
  const suffix = ',click:originalClick,accelerator:"CmdOrCtrl+R",enabled:originalEnabled';
  const tail = ';if(response!==0)return false;recordApproval(originalKey);return true;';
  const input = fixture.replace(p.needle, () => p.needle + suffix + tail);
  assert.equal(applyNativePatches(input), patched.replace(fragment(id), () => fragment(id) + suffix + tail));
});

test('session error localizes only title and preserves exception detail and dialog function', () => {
  const f = formatter();
  const detail = 'Cancel {path} /private/error';
  const calls = [];
  const showErrorBox = (...args) => { calls.push(args); return 'original return'; };
  for (const s of [new Error(detail), detail]) {
    const context = vm.createContext({ Ee: f.Ee, s, Error, aA: { dialog: { showErrorBox } } });
    assert.equal(vm.runInContext(fragment('resume-session-error-title'), context), 'original return');
    assert.deepEqual(calls.at(-1), ['無法開啟工作階段', detail]);
    assert.equal(context.aA.dialog.showErrorBox, showErrorBox);
  }
});
