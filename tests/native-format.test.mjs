import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { wrapIntl } = createRequire(import.meta.url)('../claude-tw/native-format.cjs');

const descriptor = Object.freeze({ id: 'open', defaultMessage: 'Open {name}', description: 'Static UI' });
const approved = Object.freeze({ open: 'Open {name}', copy: 'Copy' });

// Synthetic native engine: deliberately gives messages[id] priority over
// defaultMessage. It records exact argument references, not copied values.
function fixture() {
  const calls = [], configs = [];
  const onError = () => {}, onWarn = () => {};
  const formats = { number: { money: { style: 'currency', currency: 'TWD' } } };
  const defaultFormats = { date: { short: { year: 'numeric' } } };
  const rich = { strong: value => ['strong', value] };
  const createIntl = config => {
    configs.push(config);
    return {
      ...config,
      formatMessage(...args) {
        calls.push({ owner: this, args });
        const [d, values] = args;
        const template = Object.hasOwn(this.messages, d.id) ? this.messages[d.id] : d.defaultMessage;
        if (template === 'THROW') throw new Error('invalid translated ICU');
        if (template === 'RICH') return values.strong(values.name);
        return template.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? `{${key}}`));
      },
      formatNumber: value => `original-number:${value}`,
      $t: () => 'original-alias'
    };
  };
  const intl = createIntl({
    locale: 'en-US', defaultLocale: 'en', messages: { open: 'ORIGINAL {name}', copy: 'Copy', private: 'PRIVATE' },
    formats, defaultFormats, timeZone: 'Asia/Taipei', defaultRichTextElements: rich,
    fallbackOnEmptyString: false, onError, onWarn, wrapRichTextChunksInFragment: true
  });
  let snapshot = {
    schema: 2, enabled: true, compatible: true, revision: 'r1',
    dictionary: { 'Open {name}': '開啟 {name}', Copy: '複製', 'private project': '不得翻譯' }
  };
  const getSnapshot = () => snapshot;
  const proxy = wrapIntl(intl, createIntl, getSnapshot, approved);
  return { intl, proxy, createIntl, getSnapshot, calls, configs, update: patch => { snapshot = { ...snapshot, ...patch }; } };
}

test('separate approved id catalog wins lookup priority without mutating the original', () => {
  const f = fixture();
  const originalMethod = f.intl.formatMessage;
  const originalMessages = f.intl.messages;
  Object.freeze(originalMessages);
  assert.equal(f.proxy.formatMessage(descriptor, { name: 'Budget.pdf' }), '開啟 Budget.pdf');
  assert.equal(f.intl.formatMessage(descriptor, { name: 'Budget.pdf' }), 'ORIGINAL Budget.pdf');
  assert.equal(f.intl.formatMessage, originalMethod);
  assert.equal(f.intl.messages, originalMessages);
  assert.equal(f.intl.locale, 'en-US');
  assert.equal(f.intl.defaultLocale, 'en');
  assert.equal(descriptor.defaultMessage, 'Open {name}');
  const translated = f.configs[1];
  assert.equal(translated.locale, 'zh-TW');
  assert.equal(translated.defaultLocale, 'zh-TW');
  assert.deepEqual({ ...translated.messages }, { open: '開啟 {name}', copy: '複製' });
  assert.equal(Object.hasOwn(translated.messages, 'private'), false);
  for (const key of [
    'formats', 'defaultFormats', 'timeZone', 'defaultRichTextElements',
    'fallbackOnEmptyString', 'wrapRichTextChunksInFragment'
  ]) assert.equal(translated[key], f.intl[key]);
});

test('stable Proxy only intercepts formatMessage; other properties and methods are original', () => {
  const f = fixture();
  assert.equal(wrapIntl(f.intl, f.createIntl, f.getSnapshot, approved), f.proxy);
  assert.equal(f.proxy.formatMessage, f.proxy.formatMessage);
  assert.equal(f.proxy.formatNumber, f.intl.formatNumber);
  assert.equal(f.proxy.$t, f.intl.$t);
  assert.equal(f.proxy.messages, f.intl.messages);
  assert.equal(f.proxy.formats, f.intl.formats);
  assert.deepEqual(Reflect.ownKeys(f.proxy), Reflect.ownKeys(f.intl));
  assert.equal(f.proxy.formatNumber(12), 'original-number:12');
  assert.equal(f.configs.length, 1, 'wrapping itself must not create a formatter or read a snapshot');
});

test('values, private strings, rich callbacks, options and extra argument references are unchanged', () => {
  const f = fixture();
  const name = 'Copy /private/客戶{secret}.pdf';
  const strong = value => ({ tag: 'strong', value });
  const values = Object.freeze({ name, strong });
  const options = Object.freeze({ ignoreTag: false, custom: {} });
  const extra = {};
  assert.equal(f.proxy.formatMessage(descriptor, values, options, extra), `開啟 ${name}`);
  const call = f.calls.at(-1);
  assert.equal(call.args[0], descriptor);
  assert.equal(call.args[1], values);
  assert.equal(call.args[2], options);
  assert.equal(call.args[3], extra);
  f.update({ revision: 'r2', dictionary: { 'Open {name}': 'RICH' } });
  assert.deepEqual(f.proxy.formatMessage(descriptor, values, options), { tag: 'strong', value: name });
  assert.equal(f.calls.at(-1).args[1].strong, strong);
  assert.deepEqual(values, { name, strong });
  const copy = Object.freeze({ id: 'copy', defaultMessage: 'Copy' });
  f.update({ revision: 'r3', dictionary: { Copy: '複製' } });
  assert.equal(f.proxy.formatMessage(copy), '複製');
  assert.equal(f.calls.at(-1).args.length, 1);
});

test('only exact approved id plus defaultMessage pairs are intercepted', () => {
  const f = fixture();
  for (const d of [
    { id: 'open', defaultMessage: 'Different {name}' },
    { id: 'open', defaultMessage: ['Open {name}'] },
    { id: 'open' },
    { id: 'unknown', defaultMessage: 'Open {name}' },
    { id: 'private', defaultMessage: 'private project' },
    Object.assign(Object.create({ id: 'open' }), { defaultMessage: 'Open {name}' })
  ]) {
    const values = { name: 'Copy' }, options = {};
    f.proxy.formatMessage(d, values, options);
    const call = f.calls.at(-1);
    assert.equal(call.owner, f.intl);
    assert.equal(call.args[0], d);
    assert.equal(call.args[1], values);
    assert.equal(call.args[2], options);
  }
  assert.equal(f.configs.length, 1);
});

test('disabled, incompatible and malformed snapshots delegate to original', () => {
  for (const patch of [
    { enabled: false }, { compatible: false }, { enabled: 'true' }, { compatible: 1 },
    { schema: 1 }, { revision: '' }, { revision: 123 }, { revision: 'r'.repeat(129) },
    { dictionary: null }, { dictionary: [] }
  ]) {
    const f = fixture();
    f.proxy.formatMessage(descriptor, { name: 'x' });
    f.update(patch);
    assert.equal(f.proxy.formatMessage(descriptor, { name: 'x' }), 'ORIGINAL x');
    assert.equal(f.calls.at(-1).owner, f.intl);
    assert.equal(f.intl.locale, 'en-US');
  }
});

test('revision cache is single-entry per instance and reflects updates/removals', () => {
  const f = fixture();
  f.proxy.formatMessage(descriptor, { name: 'x' });
  f.proxy.formatMessage(descriptor, { name: 'y' });
  assert.equal(f.configs.length, 2);
  f.update({ revision: 'r2', dictionary: { 'Open {name}': '打開 {name}' } });
  assert.equal(f.proxy.formatMessage(descriptor, { name: 'x' }), '打開 x');
  assert.equal(f.configs.length, 3);
  f.update({ revision: 'r1', dictionary: { 'Open {name}': '開啟 {name}' } });
  f.proxy.formatMessage(descriptor, { name: 'x' });
  assert.equal(f.configs.length, 4, 'older revision must not be retained in an unbounded cache');
  f.update({ revision: 'r3', dictionary: {} });
  assert.equal(f.proxy.formatMessage(descriptor, { name: 'x' }), 'ORIGINAL x');
  assert.equal(f.configs.length, 4);
  f.update({ revision: 'r4', dictionary: { 'Open {name}': '開啟 {name}' } });
  f.proxy.formatMessage(descriptor, { name: 'x' });
  f.update({ enabled: false });
  assert.equal(f.proxy.formatMessage(descriptor, { name: 'x' }), 'ORIGINAL x');
  f.update({ enabled: true });
  assert.equal(f.proxy.formatMessage(descriptor, { name: 'x' }), '開啟 x');
});

test('new locale instances have independent caches and preserved original configuration', () => {
  const f = fixture();
  const second = f.createIntl({ ...f.intl, locale: 'ja-JP', timeZone: 'UTC', messages: { open: '日本語 {name}' } });
  const other = wrapIntl(second, f.createIntl, f.getSnapshot, approved);
  assert.notEqual(other, f.proxy);
  assert.equal(other.formatMessage(descriptor, { name: 'x' }), '開啟 x');
  assert.equal(f.configs.at(-1).timeZone, 'UTC');
  assert.equal(f.proxy.formatMessage(descriptor, { name: 'x' }), '開啟 x');
  assert.equal(f.configs.at(-1).timeZone, 'Asia/Taipei');
  f.update({ enabled: false });
  assert.equal(other.formatMessage(descriptor, { name: 'x' }), '日本語 x');
  assert.equal(f.proxy.formatMessage(descriptor, { name: 'x' }), 'ORIGINAL x');
  assert.equal(second.locale, 'ja-JP');
});

test('factory and translated formatter failures delegate original references, then recover on new revision', () => {
  const f = fixture();
  let failures = 0;
  const factory = () => { failures++; throw new Error('factory failed'); };
  const wrapped = wrapIntl(f.intl, factory, f.getSnapshot, approved);
  const values = { name: 'private' }, options = {};
  assert.equal(wrapped.formatMessage(descriptor, values, options), 'ORIGINAL private');
  assert.equal(wrapped.formatMessage(descriptor, values, options), 'ORIGINAL private');
  assert.equal(failures, 1);
  assert.equal(f.calls.at(-1).args[1], values);
  assert.equal(f.calls.at(-1).args[2], options);
  assert.equal(wrapIntl(f.intl, f.createIntl, f.getSnapshot, approved), wrapped);
  f.update({ revision: 'r2', dictionary: { 'Open {name}': 'THROW' } });
  assert.equal(wrapped.formatMessage(descriptor, values, options), 'ORIGINAL private');
  f.update({ revision: 'r3', dictionary: { 'Open {name}': '開啟 {name}' } });
  assert.equal(wrapped.formatMessage(descriptor, values, options), '開啟 private');
});

test('snapshot exceptions, invalid factories and missing translation values fail closed', () => {
  const f = fixture();
  for (const create of [null, () => null, () => ({}), () => f.intl, () => f.proxy]) {
    const wrapped = wrapIntl(f.intl, create, f.getSnapshot, approved);
    assert.equal(wrapped.formatMessage(descriptor, { name: 'x' }), 'ORIGINAL x');
  }
  let wrapped = wrapIntl(f.intl, f.createIntl, () => { throw new Error('unavailable'); }, approved);
  assert.equal(wrapped.formatMessage(descriptor, { name: 'x' }), 'ORIGINAL x');
  wrapped = wrapIntl(f.intl, f.createIntl, f.getSnapshot, approved);
  for (const [i, dictionary] of [
    {}, { 'Open {name}': null }, { 'Open {name}': 42 }, { 'Open {name}': '' },
    { 'Open {name}': '字'.repeat(1001) }, Object.create({ 'Open {name}': '不得使用' }),
    Object.defineProperty({}, 'Open {name}', { get() { assert.fail('must not invoke dictionary getter'); } })
  ].entries()) {
    f.update({ revision: `r${i}`, dictionary });
    assert.equal(wrapped.formatMessage(descriptor, { name: 'x' }), 'ORIGINAL x');
  }
});

test('approved catalog is bounded, own-data-only and cannot authorize arbitrary private keys', () => {
  const f = fixture();
  const inherited = Object.create(approved);
  const getter = Object.defineProperty({}, 'open', { enumerable: true, get() { assert.fail('catalog getter'); } });
  const huge = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`id${i}`, 'Copy']));
  huge.open = 'Open {name}';
  for (const catalog of [null, [], inherited, getter, huge, { open: 123 }]) {
    const wrapped = wrapIntl(f.intl, f.createIntl, f.getSnapshot, catalog);
    assert.equal(wrapped.formatMessage(descriptor, { name: 'x' }), 'ORIGINAL x');
  }
  assert.equal(wrapIntl(null, f.createIntl, f.getSnapshot, approved), null);
});

test('frozen original method obeys Proxy invariants and remains safely original', () => {
  const f = fixture();
  Object.freeze(f.intl);
  assert.equal(f.proxy.formatMessage, f.intl.formatMessage);
  assert.equal(f.proxy.formatMessage(descriptor, { name: 'x' }), 'ORIGINAL x');
  assert.equal(f.intl.locale, 'en-US');
});

test('original exceptions propagate unchanged and never cause a second original call', () => {
  for (const scenario of ['unknown', 'disabled', 'factory-failure', 'translated-failure', 'bad-descriptor']) {
    const error = new Error('original error');
    let calls = 0;
    const intl = { formatMessage() { calls++; throw error; } };
    const createIntl = () => {
      if (scenario === 'factory-failure') throw new Error('factory');
      return { formatMessage() { throw new Error('translation'); } };
    };
    const getSnapshot = () => ({
      schema: 2, enabled: scenario !== 'disabled', compatible: true, revision: 'r1',
      dictionary: { 'Open {name}': '開啟 {name}' }
    });
    const proxy = wrapIntl(intl, createIntl, getSnapshot, approved);
    const d = scenario === 'unknown' ? { id: 'unknown', defaultMessage: 'unknown' } :
      scenario === 'bad-descriptor' ? null : descriptor;
    assert.throws(() => proxy.formatMessage(d), caught => caught === error);
    assert.equal(calls, 1, scenario);
  }
});

test('native soft ICU failures never forward private diagnostics and fall back once', () => {
  const f = fixture();
  const errors = [];
  const error = new Error('native ICU error');
  f.intl.onError = (...args) => errors.push(args);
  f.intl.onWarn = (...args) => errors.push(args);
  const factory = config => ({
    formatMessage() {
      config.onError(error);
      config.onWarn('PRIVATE interpolation value');
      return 'Open {name}'; // Native FormatJS can return this on invalid ICU.
    }
  });
  const proxy = wrapIntl(f.intl, factory, f.getSnapshot, approved);
  const values = { name: 'Budget.pdf' }, options = {};
  assert.equal(proxy.formatMessage(descriptor, values, options), 'ORIGINAL Budget.pdf');
  assert.equal(errors.length, 0);
  assert.equal(f.calls.at(-1).args[1], values);
  assert.equal(f.calls.at(-1).args[2], options);
  assert.equal(f.calls.filter(call => call.owner === f.intl).length, 1);
});

test('injected literal IDs use a silent independent English fallback while disabled', () => {
  const f=fixture(),id='claudetw.native.literal.question';
  const d={id,defaultMessage:'Open {name}'}, values={name:'PRIVATE.txt'};
  f.intl.locale='fr-FR';
  f.intl.onError=()=>assert.fail('new literal ID must not reach official telemetry');
  f.intl.formatMessage=()=>assert.fail('new literal ID must not reach the shared formatter');
  f.update({enabled:false});
  const p=wrapIntl(f.intl,f.createIntl,f.getSnapshot,{[id]:'Open {name}'});
  assert.equal(p.formatMessage(d,values),'Open PRIVATE.txt');
  assert.equal(f.calls.at(-1).args[1],values);
  assert.equal(f.intl.locale,'fr-FR');
  const count=f.configs.length;
  p.formatMessage(d,values);assert.equal(f.configs.length,count,'fallback cache is bounded');
  f.update({enabled:true,revision:'active',dictionary:{'Open {name}':'開啟 {name}'}});
  assert.equal(p.formatMessage(d,values),'開啟 PRIVATE.txt');
  f.update({compatible:false});
  assert.equal(p.formatMessage(d,values),'Open PRIVATE.txt');
});
