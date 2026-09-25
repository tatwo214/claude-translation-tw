import test from 'node:test';
import assert from 'node:assert/strict';
import assets from '../claude-tw/assets.cjs';

test('index accepts only exact public static application JS URLs', () => {
  const valid = 'https://claude.ai/_next/static/chunks/app/[locale]/page-a123.js';
  assert.equal(assets.assetURL(valid), valid);
  const vite='https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-DnA32MeC.js';
  assert.equal(assets.assetURL(vite),vite);
  for (const bad of [
    'https://claude.ai/api/organizations/private',
    'https://claude.ai/chat/private',
    'https://claude.ai/_next/static/a.js?token=secret',
    'https://claude.ai/_next/static/a.js#private',
    'https://claude.ai/_next/static/../api/a.js',
    'https://claude.ai/_next/static/%2e%2e/a.js',
    'https://claude.ai/_next/static/a.json',
    'https://claude.ai.evil.invalid/_next/static/a.js',
    'https://user:password@claude.ai/_next/static/a.js',
    'http://claude.ai/_next/static/a.js', 'file:///tmp/a.js',
    'data:text/javascript,secret', null, {},
    vite+'?token=private',
    vite.replace('assets-proxy.anthropic.com','assets-proxy.anthropic.com.evil.invalid'),
    vite.replace('/v1/','/v1/../'),
    'https://assets-proxy.anthropic.com/api/private.js',
  ]) assert.equal(assets.assetURL(bad), null, String(bad));
});

test('bounded sanitized manifest merges and deduplicates without retaining rejected data', () => {
  const a = 'https://claude.ai/_next/static/chunks/a.js';
  const b = 'https://claude.com/_next/static/chunks/b.js';
  assert.deepEqual(assets.mergeAssets([b, a], [a, '/private']), [a, b]);
  assert.deepEqual(assets.assetList(Array(1501).fill(a)), []);
  assert.deepEqual(assets.assetList({ [a]: 'ignored' }), []);
});
