'use strict';
// Only public, versioned application JavaScript. Never accept page URLs,
// attachment URLs, queries, fragments, account endpoints or arbitrary hosts.
const ORIGINS = new Set(['https://claude.ai', 'https://claude.com', 'https://assets-proxy.anthropic.com']);
const MAX_ASSETS = 1500;
function assetURL(input) {
  if (typeof input !== 'string' || input.length > 1024) return null;
  try {
    const u = new URL(input);
    if (!ORIGINS.has(u.origin) || u.username || u.password || u.search || u.hash) return null;
    const staticPath = u.origin === 'https://assets-proxy.anthropic.com'
      ? /^\/claude-ai\/v2\/assets\/v1\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(u.pathname)
      : /^\/_next\/static\/[A-Za-z0-9_./()[\]@-]+\.js$/.test(u.pathname);
    if (!staticPath) return null;
    if (u.pathname.includes('/../') || u.pathname.includes('/./') || input.includes('%')) return null;
    // Reject normalized traversal too, rather than silently changing the URL.
    if (u.href !== input) return null;
    return u.href;
  } catch { return null; }
}
function assetList(input) {
  if (!Array.isArray(input) || input.length > MAX_ASSETS) return [];
  return [...new Set(input.map(assetURL).filter(Boolean))].sort();
}
function mergeAssets(previous, incoming) {
  return [...new Set([...assetList(previous), ...assetList(incoming)])].sort().slice(0, MAX_ASSETS);
}
module.exports = { assetURL, assetList, mergeAssets, MAX_ASSETS };
