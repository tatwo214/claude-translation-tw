// Real Chromium, isolated world + NEW synthetic profile, following browser.mjs.
// No installed Claude, user profile, private Yours data, dictionary edits or login.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const evidence = fs.mkdtempSync(path.join(root, 'evidence/customize-browser-'));
const profile = fs.mkdtempSync(path.join(evidence, 'synthetic-profile-'));
const source = fs.readFileSync(path.join(root, 'claude-tw/translator.js'), 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const sources = Object.fromEntries([
  ['/customize/skills', 'customize-public-catalog.txt'],
  ['/customize/connectors', 'connectors-public-catalog.txt'],
  ['/customize/plugins', 'plugins-public-catalog.txt'],
].map(([route, name]) => {
  const text = fs.readFileSync(path.join(root, 'tests/fixtures/public', name), 'utf8');
  const data = JSON.parse(text.split('CTW_STATIC_SHAPES:')[1]);
  assert.equal(data.route, route);
  return [route, data];
}));
// Deliberately independent fixture dictionary; production translations belong to
// the parent's separate dictionary task. Trap entries prove scope is restrictive.
const dictionary = {
  Skills: '技能', Yours: '你的', Discover: '探索', Save: '儲存',
  'From Anthropic': '來自 Anthropic', Data: '資料', 'New skills': '新技能',
  'Most installed skills': '最多人安裝的技能', Categories: '分類', Engineering: '工程',
  APIs: 'API', 'Files & documents': '檔案與文件', 'New plugins': '新外掛',
  'Most installed plugins': '最多人安裝的外掛', 'Curated by Anthropic': '由 Anthropic 精選',
  'Claude for legal': '法律工作用 Claude', 'Top connectors': '熱門連接器', 'New connectors': '新連接器',
  'Build for the Claude Directory': '為 Claude 目錄打造工具',
  'Google Drive': 'Google 雲端硬碟', 'by Nevo David': '不應改動作者姓名', 'Show all':'顯示全部',
  '2.9M installs': '不應改動數字', '2,859,421 installs across all of Claude': '不應改動數字',
  'Desktop app version': '桌面應用程式版本', 'Run on startup': '登入時啟動',
  'Quick access shortcut': '快速存取快捷鍵', 'Voice shortcut': '語音快捷鍵',
  'Menu bar': '選單列', 'Keep computer awake': '讓電腦保持喚醒', 'Learn more': '深入瞭解',
  Theme:'主題', 'Chat font':'聊天字型', Motion:'動態效果', Language:'語言', Style:'風格', Speed:'速度',
  'Response completions':'回覆完成', 'Scheduled tasks':'排程任務', 'Code notifications':'Code 通知',
  'Emails from Claude Code cloud sessions':'Claude Code 雲端工作階段的電子郵件', 'Dispatch messages':'Dispatch 訊息',
  'Query, chart and explain your data — SQL, spreadsheets and dashboards in one place.': '查詢、繪製圖表並解釋資料，集中處理 SQL、試算表及儀表板。',
};
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const settingsShapes = JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/public/settings-shapes.txt'),'utf8').split('CTW_STATIC_SHAPES:')[1]);
const desktopLabels = ['Desktop app version','Run on startup','Quick access shortcut','Voice shortcut','Menu bar','Keep computer awake'];
const generalLabels = ['Theme','Chat font','Motion','Language','Style','Speed','Response completions','Scheduled tasks','Code notifications','Emails from Claude Code cloud sessions','Dispatch messages'];
const generalShapes = JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/public/settings-general-labels.txt'),'utf8').split('CTW_STATIC_SHAPES:')[1]);
const generalRows = generalLabels.map((text,i) => {
  const r = generalShapes.labels.find(r => r.text === text);
  assert.equal(r?.tag,'SPAN'); assert.equal(r.section,''); assert.equal(r.group,'');
  return `<div role="group"><span id="general${i}" class="${esc(r.cls)}">${esc(text)}</span></div>`;
}).join('');
const settingShape = (text,id) => {
  const entry = settingsShapes.shapes.find(s => s.text === text);
  assert.ok(entry, `Observed settings shape: ${text}`);
  return entry.parents.slice(0,-1).reduce((html,p,i) =>
    `<${p.tag} class="${esc(p.cls)}"${p.role ? ` role="${esc(p.role)}"` : ''}${i===0 ? ` id="${id}"` : ''}>${html}</${p.tag}>`,esc(text));
};
function settingsFixture() {
  return `<div id="portal-root"><div role="dialog" id="desktopDialog">
    <nav><ul><li data-testid="general-settings" id="generalMarker"></li></ul></nav><main>
    <section>${generalRows}
      <span class="settings-row-title" id="wrongStartupSection">Run on startup</span>
      <div data-testid="message"><span class="settings-row-title" id="privateGeneral">Theme</span></div>
      <div contenteditable="true"><span class="settings-row-title" id="draftGeneral">Theme</span></div>
      <input class="settings-row-title" id="inputGeneral" value="Theme">
      <a href="/chat/synthetic"><span class="settings-row-title" id="linkedGeneral">Theme</span></a>
      <span id="plainGeneral">Theme</span>
    </section>
    <section id="general-desktop">
      ${desktopLabels.map((s,i)=>settingShape(s,`setting${i}`)).join('')}
      <span id="customSetting" class="settings-row-title">Save</span>
      <span id="plainSetting">Menu bar</span>
      <div data-testid="message"><span class="settings-row-title" id="chatSetting">Menu bar</span></div>
      <div contenteditable="true"><span class="settings-row-title" id="draftSetting">Menu bar</span></div>
      <input class="settings-row-title" id="inputSetting" value="Menu bar">
      <a href="/chat/synthetic"><span class="settings-row-title" id="linkedSetting">Menu bar</span></a>
      <section id="nested-other"><span class="settings-row-title" id="nestedSetting">Menu bar</span></section>
    </section>
    <section><span class="settings-row-title" id="otherSectionSetting">Menu bar</span>
      ${settingShape('Learn more','settingsHelp')}
      <a class="cds-text-link" id="settingsHelp2">Learn more</a>
      <a class="cds-text-link" href="/chat/synthetic" id="dynamicHelp">Learn more</a>
      <a id="wrongHelpClass">Learn more</a><a class="cds-text-link" id="wrongHelpKey">Save</a>
      <div data-testid="message"><a class="cds-text-link" id="privateHelp">Learn more</a></div>
      <div contenteditable="true"><a class="cds-text-link" id="draftHelp">Learn more</a></div>
    </section>
    <div role="dialog"><a class="cds-text-link" id="nestedDialogHelp">Learn more</a></div>
    </main></div>
    <div role="dialog" id="otherDialog"><span class="settings-row-title" id="otherDialogSetting">Menu bar</span>
      <span class="settings-row-title" id="otherGeneral">Theme</span>
      <span class="settings-row-title" id="otherGeneralLong">Emails from Claude Code cloud sessions</span>
      <a class="cds-text-link" id="otherDialogHelp">Learn more</a></div>
    <span class="settings-row-title" id="outsideSetting">Menu bar</span>
    <a class="cds-text-link" id="outsideHelp">Learn more</a>
  </div>`;
}
const shape = (row, id, overrides = {}) => {
  const attrs = { class: row.cls, ...(row.role ? { role: row.role } : {}), id, ...overrides };
  const attrsText = Object.entries(attrs).map(([k,v]) => `${k}="${esc(v)}"`).join(' ');
  return `<${row.parent.tag} class="${esc(row.parent.cls)}"><${row.tag} ${attrsText}>${esc(row.text)}</${row.tag}></${row.parent.tag}>`;
};
const skillRows = sources['/customize/skills'].catalog;
const row = (text, rows = skillRows) => {
  const value = rows.find((r) => r.text === text);
  assert.ok(value, `Actual source shape exists: ${text}`);
  return value;
};
const author = row('by Nevo David'), compact = row('2.9M installs');
const total = row('2,859,421 installs across all of Claude'), title = row('Engineering');
const from = row('From Anthropic'), heading = row('Data');
const renderDescription = skillRows.find(r => r.text.startsWith('Deploy, debug, and monitor applications on Render:'));
const learnDescription = skillRows.find(r => r.text.startsWith('Use this skill when the user wants intellectual understanding'));
assert.ok(renderDescription); assert.ok(learnDescription); assert.ok(learnDescription.text.length > 900);
dictionary[renderDescription.text] = '在 Render 上部署、偵錯及監控應用程式。';
dictionary[learnDescription.text] = '協助使用者理解概念、機制與學習路徑。';
const wanted = {
  '/customize/skills': ['From Anthropic','Data','New skills','Most installed skills','Categories','Engineering','APIs','Files & documents','by Nevo David','2.9M installs','2,859,421 installs across all of Claude'],
  '/customize/plugins': ['From Anthropic','Data','New plugins','Categories','Engineering','by Nevo David','2.9M installs','2,859,421 installs across all of Claude','Build for the Claude Directory'],
  '/customize/connectors': ['Curated by Anthropic','Claude for legal','Top connectors','New connectors','by Google','Build for the Claude Directory'],
};
function expected(text) {
  if (text.startsWith('by ')) return `作者：${text.slice(3)}`;
  if (text === '2.9M installs') return '2.9M 次安裝';
  if (text === '2,859,421 installs across all of Claude') return '在 Claude 中共安裝 2,859,421 次';
  return dictionary[text];
}
function page(route, yours = false) {
  const actual = wanted[route] ? route : '/customize/skills', rows = sources[actual].catalog;
  const cases = wanted[actual].map((text, i) => ({ ...row(text, rows), id: `catalog${i}` }));
  const inside = cases.map((r) => shape(r, r.id)).join('');
  const connectorLink = sources['/customize/connectors'].catalog.find((r) => r.text === 'Google Drive');
  return `<!doctype html><html><head><meta charset="utf-8"><title>ClaudeTW public catalogue fixture</title>
    <style>body{font:16px system-ui;margin:24px}header{display:flex;gap:20px}#customize-pane{margin-top:20px}#customize-pane>div,#customize-pane>span{display:block;margin:6px 0}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden}</style></head><body>
    <header id="tabs"><button role="tab" aria-selected="true" id="skillsTab">Skills</button>
    <span role="radio" aria-checked="${yours}" id="yours" tabindex="0">Yours</span>
    <span role="radio" aria-checked="${!yours}" id="discover" tabindex="0">Discover</span></header>
    <span role="radio" aria-checked="false" id="generalRadio">Save</span>
    <section id="customize-pane">${inside}
      ${shape(title, 'sameNameSkill')}${shape(from, 'scopedLabel')}
      ${shape(author, 'scopedAuthor')}${shape(compact, 'scopedCount')}${shape(total, 'scopedTotal')}
      ${shape({ ...author, text: 'by Nevo  David' }, 'spacedAuthor')}
      ${shape({ ...author, cls: 'block min-w-0' }, 'wrongAuthorShape')}
      ${shape({ ...compact, parent: {tag:'DIV',cls:''} }, 'wrongCountShape')}
      <span id="arbitraryShort">Data</span>
      ${shape(row('Query, chart and explain your data — SQL, spreadsheets and dashboards in one place.'), 'longDescription')}
      ${shape(renderDescription,'renderDescription')}${shape(learnDescription,'learnDescription')}
      <p id="paragraphDescription">${esc(renderDescription.text)}</p>
      <button id="showAll" title="Show all" aria-label="Show all">Show all</button>
      <input id="catalogInput" value="Data" placeholder="Search">
      <div data-testid="message">${shape(title, 'privateChat')}${shape(author, 'privateAuthor')}</div>
      <div data-claude-tw-private>${shape(heading, 'explicitPrivate')}</div>
      <textarea id="draft">Engineering</textarea><input id="input" value="Engineering">
      <div contenteditable="true" id="editable">Engineering<span role="radio" aria-checked="true">Discover</span></div>
      <a href="/chat/synthetic-only">${shape(title, 'dynamicLink')}</a>
      <a href="/customize/skills/synthetic-private">${shape(title, 'otherLink')}</a>
      ${shape(connectorLink, 'connectorLink', {href:'/connectors/synthetic-only'})}
    </section>
    ${shape(author, 'outsideAuthor')}${shape(compact, 'outsideCount')}${shape(from, 'outsideLabel')}
    ${shape(heading,'outsideHeading')}
    <div data-testid="message"><span role="radio" aria-checked="true" id="privateRadio">Discover</span></div>
    ${settingsFixture()}
    <script>
    const select = publicView => {
      document.getElementById('yours').setAttribute('aria-checked',String(!publicView));
      document.getElementById('discover').setAttribute('aria-checked',String(publicView));
    };
    document.getElementById('yours').onclick = () => select(false);
    document.getElementById('discover').onclick = () => select(true);
    requestAnimationFrame(()=>{window.firstFrame=Object.fromEntries(['skillsTab','yours','discover','scopedLabel','scopedAuthor','scopedCount','scopedTotal'].map(id=>[id,document.getElementById(id).textContent]));});
    </script></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(page(url.pathname, url.searchParams.get('view') === 'yours'));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
], {stdio:'ignore'});
let ws, seq = 0, send, contextId;
const calls = new Map(), events = [], checks = [], blockedRequests = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch {}
    await delay(100);
  }
  assert.ok(port, 'Own synthetic Chromium started');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await once(ws, 'open');
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    calls.set(id, {resolve, reject, timer});
    ws.send(JSON.stringify({id, method, params}));
  });
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const c = calls.get(m.id); if (!c) return;
      calls.delete(m.id); clearTimeout(c.timer);
      m.error ? c.reject(new Error(JSON.stringify(m.error))) : c.resolve(m.result);
    } else {
      events.push(m);
      if (m.method === 'Fetch.requestPaused') {
        const {requestId, request} = m.params;
        if (request.url.startsWith(origin + '/')) send('Fetch.continueRequest', {requestId}).catch(() => {});
        else { blockedRequests.push(request.url); send('Fetch.failRequest', {requestId, errorReason:'BlockedByClient'}).catch(() => {}); }
      }
    }
  };
  const evaluate = async (expression, isolated = false) => {
    const r = await send('Runtime.evaluate', {expression, ...(isolated ? {contextId} : {}), returnByValue:true, awaitPromise:true});
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const frame = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const text = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const assertText = async (id, value) => assert.equal(await text(id), value, id);
  const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS', name); };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Fetch.enable', {patterns:[{urlPattern:'*',requestStage:'Request'}]});
  await send('Emulation.setDeviceMetricsOverride', {width:1000,height:900,deviceScaleFactor:1,mobile:false});
  await send('Page.addScriptToEvaluateOnNewDocument', {worldName:'claudetw-customize-test',source:`${source}
    globalThis.cfg={schema:2,enabled:true,compatible:true,revision:'fixture',dictionary:${JSON.stringify(dictionary)}};
    globalThis.tw=installClaudeTW({bootstrap:()=>cfg,refresh:async()=>cfg,report:r=>globalThis.lastReport=r});`});
  async function navigate(route) {
    const from = events.length;
    await send('Page.navigate', {url:origin + route});
    contextId = null;
    for (let i = 0; i < 100; i++) {
      contextId = events.slice(from).find((e) => e.method === 'Runtime.executionContextCreated' &&
        e.params.context.name === 'claudetw-customize-test')?.params.context.id;
      if (contextId && await evaluate('Boolean(document.querySelector("#outsideLabel"))', true)) break;
      await delay(30);
    }
    assert.ok(contextId, 'Isolated world');
    await frame();
    assert.equal(await evaluate('location.href'), origin + route);
    assert.equal(await evaluate('document.title'), 'ClaudeTW public catalogue fixture');
    assert.equal(await evaluate('typeof navigation?.addEventListener', true), 'function', 'Native route event available');
  }
  async function scope(publicView) {
    for (const [id, raw, translated] of [
      ['sameNameSkill','Engineering','工程'], ['scopedLabel','From Anthropic','來自 Anthropic'],
      ['scopedAuthor','by Nevo David','作者：Nevo David'], ['scopedCount','2.9M installs','2.9M 次安裝'],
      ['scopedTotal','2,859,421 installs across all of Claude','在 Claude 中共安裝 2,859,421 次'],
      ['arbitraryShort','Data',dictionary.Data], ['otherLink','Engineering',dictionary.Engineering],
      ['connectorLink','Google Drive',dictionary['Google Drive']],
      ['longDescription',row('Query, chart and explain your data — SQL, spreadsheets and dashboards in one place.').text,
        dictionary['Query, chart and explain your data — SQL, spreadsheets and dashboards in one place.']],
      ['renderDescription',renderDescription.text,dictionary[renderDescription.text]],
      ['learnDescription',learnDescription.text,dictionary[learnDescription.text]],
      ['paragraphDescription',renderDescription.text,dictionary[renderDescription.text]],
      ['showAll','Show all',dictionary['Show all']],
    ]) await assertText(id, publicView ? translated : raw);
    for (const attr of ['title','aria-label']) assert.equal(await evaluate(`document.getElementById("showAll").getAttribute("${attr}")`),
      publicView ? dictionary['Show all'] : 'Show all');
    assert.equal(await evaluate('document.getElementById("catalogInput").value'),'Data');
    assert.equal(await evaluate('document.getElementById("catalogInput").getAttribute("placeholder")'),'Search');
  }
  async function negatives() {
    for (const [id, value] of [
      ['privateChat','Engineering'], ['privateAuthor','by Nevo David'], ['explicitPrivate','Data'],
      ['draft','Engineering'], ['editable','EngineeringDiscover'], ['privateRadio','Discover'],
      ['dynamicLink','Engineering'],
      ['outsideAuthor','by Nevo David'], ['outsideCount','2.9M installs'], ['outsideLabel','From Anthropic'],
      ['wrongAuthorShape','by Nevo David'], ['wrongCountShape','2.9M installs'],
      ['outsideHeading','資料'],
    ]) await assertText(id, value);
    assert.equal(await evaluate('document.getElementById("input").value'), 'Engineering');
  }
  for (const route of Object.keys(sources)) {
    await check(`public exact route ${route}, outside-pane radios, first frame`, async () => {
      await navigate(route);
      await assertText('skillsTab','技能'); await assertText('yours','你的'); await assertText('discover','探索');
      await assertText('generalRadio','儲存');
      for (const [i, value] of wanted[route].entries()) await assertText(`catalog${i}`, expected(value));
      await scope(true); await negatives();
      await assertText('spacedAuthor', '作者：Nevo  David');
      assert.deepEqual(await evaluate('window.firstFrame'), {
        skillsTab:'技能',yours:'你的',discover:'探索',scopedLabel:'來自 Anthropic',
        scopedAuthor:'作者：Nevo David',scopedCount:'2.9M 次安裝',scopedTotal:'在 Claude 中共安裝 2,859,421 次',
      });
    });
    await check(`${route}: Discover -> Yours restores before next paint; back to Discover`, async () => {
      await evaluate('document.getElementById("yours").click()'); await frame();
      await scope(false); await negatives();
      for (const [i, value] of wanted[route].entries()) await assertText(`catalog${i}`, value);
      await evaluate('document.getElementById("discover").click()'); await frame();
      await scope(true);
    });
    await check(`${route}: initial Yours same-name synthetic private skills untouched`, async () => {
      await navigate(route + '?view=yours'); await scope(false); await negatives();
    });
    await check(`${route}: checked Discover before public landing arrives cannot translate stale Yours`, async () => {
      // Keep Data and all same-name private descriptions, but remove public
      // landing markers before changing only the radio selection.
      await evaluate(`document.querySelectorAll('#customize-pane h2,#customize-pane h3').forEach(el=>{
        if(el.textContent!=='Data')el.remove();
      });window.raceOldData=document.getElementById('arbitraryShort');
      window.raceOldDescription=document.getElementById('learnDescription');`);
      await frame(); await scope(false);
      await evaluate('document.getElementById("discover").click()'); await frame(); await scope(false);
      const marker = route === '/customize/skills' ? 'New skills' :
        route === '/customize/plugins' ? 'New plugins' : 'Top connectors';
      const wrongMarker = route === '/customize/skills' ? 'New plugins' : 'New skills';
      await evaluate(`document.getElementById('customize-pane').insertAdjacentHTML('beforeend',${JSON.stringify(
        `<span>${marker}</span><h2>${marker}</h2><h3>${marker}</h3><h3>${wrongMarker}</h3><div data-claude-tw-private><h3>${marker}</h3></div>` +
        `<a href="/chat/private"><h3>${marker}</h3></a><h3 hidden>${marker}</h3>`
      )})`);
      await frame(); await scope(false);
      // Public heading + new public content arrive together, replacing the old
      // private nodes; no observed production private content is used.
      await evaluate(`{
        const doc=new DOMParser().parseFromString(${JSON.stringify(page(route))},'text/html');
        document.getElementById('customize-pane').replaceChildren(...doc.getElementById('customize-pane').childNodes);
      }`);
      await frame(); await scope(true);
      assert.equal(await evaluate('raceOldData.textContent'),'Data');
      assert.equal(await evaluate('raceOldDescription.textContent'),learnDescription.text);
      // A subsequent scan sees translated heading text and must retain scope.
      await evaluate('document.getElementById("showAll").setAttribute("title","Show all")');
      await frame(); await scope(true);
    });
    await check(`${route}: only observed landing heading tag/parent shape authorizes public scope`, async () => {
      await navigate(route);
      await evaluate(`document.querySelectorAll('#customize-pane h2,#customize-pane h3').forEach(el=>el.remove())`);
      await frame(); await scope(false);
      const markers = sources[route].catalog.filter(r => ['H2','H3'].includes(r.tag) &&
        ['New skills','Most installed skills','New plugins','Most installed plugins','Top connectors'].includes(r.text));
      assert.ok(markers.length);
      for (const marker of markers) {
        await evaluate(`document.getElementById('customize-pane').insertAdjacentHTML('beforeend',${JSON.stringify(shape(marker,'landingMarker'))})`);
        await frame(); await scope(true);
        await evaluate(`document.getElementById('landingMarker').className=${JSON.stringify(marker.cls.split(' ').reverse().join(' '))}`);
        await frame(); await scope(true);
        await evaluate(`document.getElementById('landingMarker').parentElement.className='wrong-parent'`);
        await frame(); await scope(false);
        await evaluate(`document.getElementById('landingMarker').parentElement.className=${JSON.stringify(marker.parent.cls)}`);
        await frame(); await scope(true);
        await evaluate(`document.getElementById('landingMarker').parentElement.remove()`);
        await frame(); await scope(false);
      }
    });
  }
  await navigate('/customize/skills');
  const screenshot = async (name) => fs.writeFileSync(path.join(evidence,name),
    Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await screenshot('discover.png');
  await check('main-world replaceState without DOM writes restores within next frame', async () => {
    await evaluate('history.replaceState(null,"","/new")'); await frame(); await scope(false);
    await evaluate('history.replaceState(null,"","/customize/skills")'); await frame(); await scope(true);
  });
  await check('unknown customize route, suffix, detail and similar prefix are not public', async () => {
    for (const route of ['/customize/unknown','/customize/skills/','/customize/skills/private','/customize/skills-extra']) {
      await evaluate(`history.replaceState(null,"",${JSON.stringify(route)})`); await frame(); await scope(false);
    }
    await evaluate('history.replaceState(null,"","/customize/skills")'); await frame(); await scope(true);
  });
  await check('pushState + back traversal invalidate scope without DOM changes', async () => {
    await evaluate('history.pushState(null,"","/chat/synthetic-only")'); await frame(); await scope(false);
    await evaluate('history.back()');
    for (let i=0;i<100 && await evaluate('location.pathname') !== '/customize/skills';i++) await delay(20);
    await frame(); await scope(true);
  });
  await check('aria-checked-only mutation, ambiguous pair and renamed radio fail closed', async () => {
    await evaluate('document.getElementById("yours").setAttribute("aria-checked","true")'); await frame(); await scope(false);
    await evaluate('document.getElementById("yours").setAttribute("aria-checked","false")'); await frame(); await scope(true);
    await evaluate('document.getElementById("discover").firstChild.nodeValue="Other"'); await frame(); await scope(false);
    await evaluate('document.getElementById("discover").firstChild.nodeValue="探索"'); await frame(); await scope(true);
    // The Chinese write above belongs to the framework. Re-own a fresh English
    // label before testing disable/restore; never expect framework text restored.
    await evaluate('document.getElementById("discover").firstChild.nodeValue="Discover"'); await frame();
  });
  await check('removing/privatizing header cannot leave stale catalogue overlays', async () => {
    await evaluate('document.getElementById("tabs").setAttribute("data-claude-tw-private","")'); await frame(); await scope(false);
    await evaluate('document.getElementById("tabs").removeAttribute("data-claude-tw-private")'); await frame(); await scope(true);
    await evaluate('window.savedHeader=document.getElementById("tabs");savedHeader.remove()'); await frame(); await scope(false);
    await evaluate('document.body.prepend(savedHeader)'); await frame(); await scope(true);
  });
  await check('pane ID/context changes restore owned overlays', async () => {
    await evaluate('document.getElementById("customize-pane").id="renamed-pane"'); await frame(); await scope(false);
    await evaluate('document.getElementById("renamed-pane").id="customize-pane"'); await frame(); await scope(true);
    await evaluate('document.getElementById("customize-pane").setAttribute("data-claude-tw-private","")'); await frame(); await scope(false);
    await evaluate('document.getElementById("customize-pane").removeAttribute("data-claude-tw-private")'); await frame(); await scope(true);
  });
  await check('changed observed class restores; exact shape can re-enable', async () => {
    await evaluate('window.authorClass=document.getElementById("scopedAuthor").className;document.getElementById("scopedAuthor").className="changed"');
    await frame(); await assertText('scopedAuthor','by Nevo David');
    await evaluate('document.getElementById("scopedAuthor").className=authorClass'); await frame();
    await assertText('scopedAuthor','作者：Nevo David');
  });
  await check('node recycling / framework Chinese pending before route event is not overwritten', async () => {
    await evaluate('document.getElementById("sameNameSkill").firstChild.nodeValue="My private title";document.getElementById("scopedLabel").firstChild.nodeValue="來自 Anthropic";history.replaceState(null,"","/customize/unknown")');
    await frame();
    await assertText('sameNameSkill','My private title'); await assertText('scopedLabel','來自 Anthropic');
    await assertText('scopedAuthor','by Nevo David');
    await evaluate('history.replaceState(null,"","/customize/skills");document.getElementById("sameNameSkill").firstChild.nodeValue="Engineering";document.getElementById("scopedLabel").firstChild.nodeValue="From Anthropic"');
    await frame(); await scope(true);
  });
  await check('Yours node reuse matches dictionary but stays private, no stale overlay', async () => {
    await evaluate('document.getElementById("yours").click();document.getElementById("sameNameSkill").firstChild.nodeValue="Data"');
    await frame(); await assertText('sameNameSkill','Data'); await assertText('scopedAuthor','by Nevo David');
    await screenshot('yours.png');
    await evaluate('document.getElementById("sameNameSkill").firstChild.nodeValue="Engineering";document.getElementById("discover").click()');
    await frame(); await scope(true);
  });
  await check('detached public nodes lose overlays before later private reuse', async () => {
    await evaluate('window.savedSkill=document.getElementById("sameNameSkill");savedSkill.parentElement.remove()');
    await frame();
    assert.equal(await evaluate('savedSkill.textContent'),'Engineering');
    await evaluate('document.getElementById("yours").click();document.getElementById("customize-pane").append(savedSkill)');
    await frame(); await assertText('sameNameSkill','Engineering');
  });
  await check('public descriptions/control attributes moved into chat restore their original values', async () => {
    await navigate('/customize/skills');
    await scope(true);
    await evaluate('document.getElementById("privateChat").parentElement.append(document.getElementById("renderDescription"),document.getElementById("learnDescription"),document.getElementById("showAll"))');
    await frame();
    await assertText('renderDescription',renderDescription.text); await assertText('learnDescription',learnDescription.text);
    await assertText('showAll','Show all');
    assert.equal(await evaluate('document.getElementById("showAll").title'),'Show all');
    assert.equal(await evaluate('document.getElementById("showAll").getAttribute("aria-label")'),'Show all');
  });
  await check('disable/re-enable and revision changes restore/reapply safely', async () => {
    // Prior detach/reinsert intentionally drops ownership of disconnected nodes.
    // Use a fresh document to test restoration of still-owned header labels.
    await navigate('/customize/skills');
    await evaluate('cfg={...cfg,enabled:false};tw.update(cfg)', true); await scope(false);
    await assertText('discover','Discover');
    await evaluate('cfg={...cfg,enabled:true,revision:"next"};tw.update(cfg)', true); await scope(true);
    await evaluate('cfg={...cfg,compatible:false};tw.update(cfg)', true); await scope(false);
    await evaluate('cfg={...cfg,compatible:true};tw.update(cfg)', true); await scope(true);
  });
  await check('remote plugins settings: six exact System labels and only the observed help link', async () => {
    await navigate('/customize/plugins');
    for (const [i,key] of desktopLabels.entries()) await assertText(`setting${i}`,dictionary[key]);
    for (const id of ['settingsHelp','settingsHelp2']) await assertText(id,dictionary['Learn more']);
    for (const id of ['plainSetting','chatSetting','draftSetting','linkedSetting','nestedSetting',
      'otherSectionSetting','otherDialogSetting','outsideSetting']) await assertText(id,'Menu bar');
    for (const id of ['dynamicHelp','wrongHelpClass','privateHelp','draftHelp','nestedDialogHelp',
      'otherDialogHelp','outsideHelp']) await assertText(id,'Learn more');
    await assertText('customSetting','Save'); await assertText('wrongHelpKey','Save');
    assert.equal(await evaluate('document.getElementById("inputSetting").value'),'Menu bar');
  });
  await check('settings scope removal/private marker restores labels AND sibling-section help', async () => {
    await evaluate('document.getElementById("general-desktop").id="other-desktop"'); await frame();
    for (const [i,key] of desktopLabels.entries()) await assertText(`setting${i}`,key);
    await assertText('settingsHelp','Learn more');
    await evaluate('document.getElementById("other-desktop").id="general-desktop"'); await frame();
    for (const [i,key] of desktopLabels.entries()) await assertText(`setting${i}`,dictionary[key]);
    // Help lives in a sibling subtree; an explicit full scan is not required.
    await assertText('settingsHelp',dictionary['Learn more']);
    await evaluate('document.getElementById("desktopDialog").setAttribute("data-claude-tw-private","")'); await frame();
    await assertText('setting0','Desktop app version'); await assertText('settingsHelp','Learn more');
    await evaluate('document.getElementById("desktopDialog").removeAttribute("data-claude-tw-private")'); await frame();
    await assertText('setting0',dictionary['Desktop app version']); await assertText('settingsHelp',dictionary['Learn more']);
    await evaluate('document.getElementById("desktopDialog").removeAttribute("role")'); await frame();
    await assertText('setting0','Desktop app version'); await assertText('settingsHelp','Learn more');
    await evaluate('document.getElementById("desktopDialog").setAttribute("role","dialog")'); await frame();
    await assertText('setting0',dictionary['Desktop app version']); await assertText('settingsHelp',dictionary['Learn more']);
  });
  await check('eleven exact general labels require the same-dialog general-settings nav marker', async () => {
    for (const [i,key] of generalLabels.entries()) await assertText(`general${i}`,dictionary[key]);
    for (const id of ['privateGeneral','draftGeneral','linkedGeneral','plainGeneral','otherGeneral']) await assertText(id,'Theme');
    await assertText('otherGeneralLong','Emails from Claude Code cloud sessions');
    await assertText('wrongStartupSection','Run on startup');
    assert.equal(await evaluate('document.getElementById("inputGeneral").value'),'Theme');
    await evaluate('document.getElementById("generalMarker").setAttribute("data-testid","account-settings")'); await frame();
    for (const [i,key] of generalLabels.entries()) await assertText(`general${i}`,key);
    await assertText('setting0',dictionary['Desktop app version']);
    await evaluate('document.getElementById("generalMarker").setAttribute("data-testid","general-settings")'); await frame();
    for (const [i,key] of generalLabels.entries()) await assertText(`general${i}`,dictionary[key]);
    await evaluate('document.getElementById("generalMarker").setAttribute("data-claude-tw-private","")'); await frame();
    for (const [i,key] of generalLabels.entries()) await assertText(`general${i}`,key);
    await evaluate('document.getElementById("generalMarker").removeAttribute("data-claude-tw-private")'); await frame();
    for (const [i,key] of generalLabels.entries()) await assertText(`general${i}`,dictionary[key]);
    await assertText('wrongStartupSection','Run on startup');
  });
  await check('full-page /settings fallback preserves all 17 labels; customize without modal markers stays closed', async () => {
    for (const route of ['/settings','/settings/general','/customize/plugins']) {
      await navigate(route);
      const labels = [...desktopLabels,...generalLabels];
      await evaluate(`{
        const box=document.createElement('section');box.id='fullPageSettings';
        box.innerHTML=${JSON.stringify(labels.map((key,i) =>
          `<span class="settings-row-title" id="fallback${i}">${esc(key)}</span>`).join('') +
          '<div data-testid="message"><span class="settings-row-title" id="fallbackChat">Theme</span></div>' +
          '<div contenteditable="true"><span class="settings-row-title" id="fallbackDraft">Theme</span></div>' +
          '<a href="/chat/private"><span class="settings-row-title" id="fallbackLink">Theme</span></a>')};
        document.body.append(box);
      }`);
      await frame();
      for (const [i,key] of labels.entries()) await assertText(`fallback${i}`,route.startsWith('/settings') ? dictionary[key] : key);
      for (const id of ['fallbackChat','fallbackDraft','fallbackLink']) await assertText(id,'Theme');
    }
  });
  await check('author/count-like ATTRS never use dictionary replacements, even on observed template shapes', async () => {
    await navigate('/customize/skills');
    for (const [id,raw] of [['scopedAuthor','by Nevo David'],['scopedCount','2.9M installs'],
      ['scopedTotal','2,859,421 installs across all of Claude'],['showAll','by Nevo David']]) {
      await evaluate(`for(const attr of ['title','aria-label','alt','placeholder'])document.getElementById(${JSON.stringify(id)}).setAttribute(attr,${JSON.stringify(raw)})`);
      await frame();
      for (const attr of ['title','aria-label','alt','placeholder']) {
        assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).getAttribute(${JSON.stringify(attr)})`),raw);
      }
    }
    await assertText('scopedAuthor','作者：Nevo David');
    await assertText('scopedCount','2.9M 次安裝');
    await assertText('scopedTotal','在 Claude 中共安裝 2,859,421 次');
    await assertText('showAll',dictionary['Show all']);
  });
  await check('author/count payload outside public pane cannot enter generic long-copy/control/settings dictionary fallback', async () => {
    const payloads = ['by Nevo David','2.9M installs','2,859,421 installs across all of Claude'];
    for (const route of ['/new','/settings','/customize/plugins']) {
      await navigate(route);
      const html = payloads.map((raw,i) => `<p id="outsidePayload${i}">${esc(raw)}</p><button id="outsidePayloadButton${i}">${esc(raw)}</button>`).join('');
      await evaluate(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(html)})`);
      await frame();
      for (const [i,raw] of payloads.entries()) {
        await assertText(`outsidePayload${i}`,raw); await assertText(`outsidePayloadButton${i}`,raw);
      }
    }
  });
  await check('restore consumes pending same-task framework Chinese writes on text AND attributes', async () => {
    for (const operation of ['disable','revision','restore']) {
      await navigate('/customize/skills');
      // Same isolated-world task: no MutationObserver delivery between the
      // framework writes (identical to owned output) and the restoration.
      await evaluate(`{
        document.getElementById('scopedLabel').firstChild.nodeValue='來自 Anthropic';
        document.getElementById('showAll').setAttribute('title','顯示全部');
        ${operation === 'disable' ? 'cfg={...cfg,enabled:false};tw.update(cfg);' :
          operation === 'revision' ? 'cfg={...cfg,revision:"revision-drain"};tw.update(cfg);' : 'tw.restore();'}
      }`,true);
      await assertText('scopedLabel','來自 Anthropic');
      assert.equal(await evaluate('document.getElementById("showAll").title'),'顯示全部');
      await assertText('scopedAuthor',operation === 'revision' ? '作者：Nevo David' : 'by Nevo David');
    }
  });
  await check('mutation cycles settle; no framework overlay or console/runtime errors', async () => {
    await frame();
    const before = await evaluate('tw.stats().flushes', true);
    await delay(150);
    assert.equal(await evaluate('tw.stats().flushes', true), before, 'No observer feedback loop');
    assert.equal(await evaluate('!!document.querySelector("vite-error-overlay,nextjs-portal")'), false);
    const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && ['error','warning'].includes(e.params.entry.level)));
    assert.deepEqual(errors, []);
    assert.deepEqual(blockedRequests, [], 'Renderer made no non-local request');
  });
  const receipt = {pass:true,livePass:false,environment:'Chromium headless / isolated world / synthetic-only profile',
    sourceSha256,routes:Object.keys(sources),checks,firstFrame:true,privateYoursFixtureOnly:true,
    nativeNavigationEvents:true,screenshots:['discover.png','yours.png'],stats:await evaluate('tw.stats()',true)};
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({...receipt,evidence:path.relative(root,evidence)},null,2));
  await send('Browser.close').catch(()=>{});
} catch (error) {
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({pass:false,livePass:false,sourceSha256,checks,error:String(error)},null,2));
  console.error('Evidence:',path.relative(root,evidence));
  throw error;
} finally {
  for (const call of calls.values()) clearTimeout(call.timer);
  ws?.close();
  if (chrome.exitCode === null) { const exited=once(chrome,'exit');chrome.kill('SIGTERM');await exited.catch(()=>{}); }
  server.close();
  fs.rmSync(profile,{recursive:true,force:true});
}
