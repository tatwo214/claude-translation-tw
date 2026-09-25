'use strict';

// Pure adapter: no Electron dependency, I/O, timers, global formatter patches,
// output-string replacement, or mutation of the shared Intl/messages object.
const wrappers = new WeakMap();
const CONFIG_FIELDS = [
  'formats', 'defaultFormats', 'timeZone', 'defaultRichTextElements',
  'fallbackOnEmptyString', 'onError', 'onWarn', 'wrapRichTextChunksInFragment'
];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownValue = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_ENTRIES = 2000;

function catalogFrom(input) {
  if (!isObject(input)) return new Map();
  const keys = Object.keys(input);
  if (keys.length > MAX_ENTRIES) return new Map();
  const catalog = new Map();
  for (const id of keys) {
    const source = ownValue(input, id);
    // Invalid entries cannot authorize a descriptor. Long native dialog
    // templates need not disable otherwise valid catalog entries.
    if (id && id.length <= 500 && !forbidden.has(id) &&
        typeof source === 'string' && source.length > 0 && source.length <= 10000 &&
        !forbidden.has(source)) catalog.set(id, source);
  }
  return catalog;
}

/**
 * approvedDescriptors is a trusted, immutable { [id]: exactEnglishDefaultMessage }
 * catalog packaged from the pinned native source, NOT user/menu/renderer text.
 *
 * getSnapshot() is synchronous and returns the existing bridge schema-2 shape.
 * createIntl is the supplied native a9e factory, not an additional ICU engine.
 * Call at Ee()'s return boundary. One stable Proxy per original Intl; only
 * formatMessage is intercepted. One translated Intl is cached per original
 * instance/current revision (old revisions are replaced, never accumulated).
 *
 * Replacing injected dependencies resets that instance's cache. Locale changes
 * naturally create another original Intl and therefore another independent entry.
 */
function wrapIntl(intl, createIntl, getSnapshot, approvedDescriptors) {
  if (!isObject(intl)) return intl;
  let state = wrappers.get(intl);
  if (!state) {
    state = { cache: null, catalog: new Map() };
    const selectFormatter = descriptor => {
      if (!isObject(descriptor)) return null;
      const id = ownValue(descriptor, 'id');
      const source = ownValue(descriptor, 'defaultMessage');
      if (typeof id !== 'string' || typeof source !== 'string' ||
          !state.catalog.has(id) || state.catalog.get(id) !== source ||
          typeof state.createIntl !== 'function' || typeof state.getSnapshot !== 'function') {
        return null;
      }
      const snapshot = state.getSnapshot();
      if (!isObject(snapshot) || snapshot.schema !== 2 ||
          snapshot.enabled !== true || snapshot.compatible !== true ||
          typeof snapshot.revision !== 'string' || !snapshot.revision ||
          snapshot.revision.length > 128 || !isObject(snapshot.dictionary)) {
        state.cache = null;
        return null;
      }
      if (!state.cache || state.cache.revision !== snapshot.revision) {
        const messages = Object.create(null);
        for (const [key, english] of state.catalog) {
          const value = ownValue(snapshot.dictionary, english);
          if (typeof value === 'string' && value.trim() && value.length <= 1000) {
            messages[key] = value;
          }
        }
        // Remember a failed factory for this revision as well: repeated
        // formatting must not continuously retry a broken native factory.
        const cache = { revision: snapshot.revision, messages, translated: null, errorSerial: 0 };
        state.cache = cache;
        if (Object.keys(messages).length) {
          const config = {};
          for (const key of CONFIG_FIELDS) {
            if (key in intl) config[key] = Reflect.get(intl, key, intl);
          }
          Object.assign(config, { locale: 'zh-TW', defaultLocale: 'zh-TW', messages });
          // Native FormatJS may report an ICU error and return defaultMessage
          // instead of throwing. Do not forward translation errors/warnings:
          // those can embed private interpolation values in native telemetry.
          config.onError = () => { cache.errorSerial++; };
          config.onWarn = () => {};
          const candidate = state.createIntl(config);
          if (candidate !== intl && candidate !== state.proxy && isObject(candidate) &&
              typeof candidate.formatMessage === 'function' && cache.errorSerial === 0) cache.translated = candidate;
        }
      }
      return state.cache.translated && Object.hasOwn(state.cache.messages, id) ? state.cache : null;
    };
    const formatMessage = function (...args) {
      const original = () => {
        const descriptor=args[0];
        const id=isObject(descriptor)?ownValue(descriptor,'id'):null;
        const source=isObject(descriptor)?ownValue(descriptor,'defaultMessage'):null;
        if(typeof id==='string' && id.startsWith('claudetw.native.literal.') &&
           typeof source==='string' && state.catalog?.get(id)===source) {
          // These IDs replace formerly hardcoded English, not upstream catalog
          // entries. Even while disabled, never send them to the shared Intl:
          // a non-English upstream locale would report missing IDs to telemetry.
          if(!state.english) {
            const messages=Object.create(null), config={};
            for(const [key,text] of state.catalog)
              if(key.startsWith('claudetw.native.literal.'))messages[key]=text;
            for(const key of CONFIG_FIELDS)if(key in intl)config[key]=Reflect.get(intl,key,intl);
            Object.assign(config,{locale:'en-US',defaultLocale:'en-US',messages,onError:()=>{},onWarn:()=>{}});
            state.english=state.createIntl(config);
          }
          return Reflect.apply(state.english.formatMessage,state.english,args);
        }
        return Reflect.apply(Reflect.get(intl, 'formatMessage', intl), intl, args);
      };
      let cache;
      try {
        cache = selectFormatter(args[0]);
      } catch {
        return original();
      }
      if (!cache) return original();
      const errorSerial = cache.errorSerial;
      let result, failed = false;
      try {
        // Keep descriptor, values, rich-text callbacks, options and argument
        // count exactly as supplied. The separate catalog takes lookup priority
        // without mutating descriptor.defaultMessage or the original catalog.
        result = Reflect.apply(cache.translated.formatMessage, cache.translated, args);
        failed = cache.errorSerial !== errorSerial;
      } catch {
        failed = true;
      }
      // Never catch/retry the original formatter: its own exceptions and
      // callback side effects must retain exactly-once behavior.
      return failed ? original() : result;
    };
    state.proxy = new Proxy(intl, {
      get(target, key) {
        if (key !== 'formatMessage') return Reflect.get(target, key, target);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        // Respect Proxy invariants if a caller freezes the original instance.
        if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) {
          return descriptor.value;
        }
        if (typeof Reflect.get(target, key, target) !== 'function') {
          return Reflect.get(target, key, target);
        }
        return formatMessage;
      }
    });
    wrappers.set(intl, state);
  }
  if (state.createIntl !== createIntl || state.getSnapshot !== getSnapshot ||
      state.approvedDescriptors !== approvedDescriptors) {
    state.createIntl = createIntl;
    state.getSnapshot = getSnapshot;
    state.approvedDescriptors = approvedDescriptors;
    try { state.catalog = catalogFrom(approvedDescriptors); } catch { state.catalog = new Map(); }
    state.cache = null;
    state.english = null;
  }
  return state.proxy;
}

module.exports = { wrapIntl };
