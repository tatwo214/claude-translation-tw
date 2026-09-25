/* Isolated-world only. Never exposes ipcRenderer to the remote page. */
;(() => {
  if (!['https://claude.ai','https://claude.com'].includes(location.origin) || window.top !== window) return;
  try {
    const ipc = require('electron').ipcRenderer;
    const bridge = {
      bootstrap:()=>ipc.sendSync('claudetw:bootstrap:v2'),
      refresh:()=>ipc.invoke('claudetw:refresh:v2'),
      report:value=>ipc.send('claudetw:report:v2',value)
    };
    /* TRANSLATOR_SOURCE */
    installClaudeTW(bridge);
    // Index the app's public UI bundles, not DOM text, conversation contents,
    // attachments, cookies or page state. The main process validates again.
    let lastAssets = '';
    function reportAssets() {
      const urls = [...document.scripts].map(s => s.src)
        .concat(performance.getEntriesByType('resource').map(r => r.name));
      const scripts = [...new Set(urls.filter(s =>
        /^https:\/\/claude\.(?:ai|com)\/_next\/static\/[A-Za-z0-9_./()[\]@-]+\.js$/.test(s) ||
        /^https:\/\/assets-proxy\.anthropic\.com\/claude-ai\/v2\/assets\/v1\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(s)
      ))].sort().slice(0, 1500);
      const fingerprint = scripts.join('\n');
      if (fingerprint === lastAssets) return;
      lastAssets = fingerprint;
      ipc.send('claudetw:assets:v2', scripts);
    }
    setTimeout(reportAssets, 0);
    setInterval(reportAssets, 5000);
  } catch { console.error('[claude-tw] offline preload unavailable'); }
})();
