// Real Chromium DOM / isolated-world / first animation-frame test. Separate synthetic profile only.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';import {once} from 'node:events';
const root=path.resolve(import.meta.dirname,'..'),profile=fs.mkdtempSync(path.join(root,'evidence/browser-profile-'));
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><html><body><div class="[data-transcript-width=m]_&:[--max-content-width:960px] [&_.user-message]:text-primary"><nav><button id="new">New session</button><a href="/chat/private"><span id="userTitle">New session</span></a></nav><h1>Settings</h1><p id="desc">Let Claude take screenshots and control your keyboard and mouse in apps you allow.</p><button id="cancel" title="Close">Cancel</button><div data-testid="message"><p id="chat">Save</p></div><textarea id="draft" placeholder="Write a message…">Cancel</textarea><div contenteditable="true" id="editor">New session</div><pre id="code">Save</pre><button id="unknown">Newly invented control</button><div id="host"></div><div data-testid="epitaxy-stats-card"><span id="staticStats">Sessions</span><span id="staticValue">54</span></div><div data-testid="draft-rail-place"><span id="staticLocal">Local</span></div><span data-testid="rail-preset-trigger" id="staticManual">Manual</span><header><h1 id="greeting">What’s up next, Fixture?</h1></header><div contenteditable="true"><p id="tipPlaceholder" class="is-editor-empty" data-placeholder="Describe a task or ask a question"></p></div><span data-composer-placeholder id="overlayPlaceholder">Describe a task or ask a question</span><div data-testid="transcript-rows"><div data-testid="transcript-row"><h2 id="realHeading">Settings</h2><summary id="realTool">Save</summary></div></div><div data-session-id="synthetic"><button id="realSession">New session</button></div><nav><a href="/epitaxy/synthetic"><span id="realLink">Settings</span></a></nav><div class="assistant-message"><button id="semanticPrivate">Save</button></div><div class="transcript-body"><button id="semanticTranscript">Cancel</button></div></div><script>requestAnimationFrame(()=>{window.firstFrame={new:document.querySelector('#new').textContent,cancel:document.querySelector('#cancel').textContent};});</script></body></html>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let ws,seq=0;const calls=new Map();const events=[];
try{
 let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert(port,'Chrome started');const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await once(ws,'open');
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const c=calls.get(m.id);calls.delete(m.id);m.error?c.reject(m.error):c.resolve(m.result);}else events.push(m);};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;calls.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async(expression,contextId)=>{const r=await send('Runtime.evaluate',{expression,contextId,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await send('Page.enable');await send('Runtime.enable');
 const dictionary=Object.assign({},...['native-overrides.json','web-overrides.json','overrides.json'].map(n=>JSON.parse(fs.readFileSync(path.join(root,'claude-tw',n)))));
 const translator=fs.readFileSync(path.join(root,'claude-tw/translator.js'),'utf8');
 await send('Page.addScriptToEvaluateOnNewDocument',{worldName:'claudetw-isolated-test',source:`${translator}\nglobalThis.cfg={schema:2,enabled:true,compatible:true,revision:'test',dictionary:${JSON.stringify(dictionary)}};globalThis.tw=installClaudeTW({bootstrap:()=>cfg,refresh:async()=>cfg,report:r=>globalThis.lastReport=r});`});
 await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/epitaxy`});
 let ctx;for(let i=0;i<100;i++){ctx=events.find(e=>e.method==='Runtime.executionContextCreated'&&e.params.context.name==='claudetw-isolated-test')?.params.context.id;if(ctx && await evaluate('Boolean(document.querySelector("#new"))',ctx))break;await new Promise(r=>setTimeout(r,50));}
 await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',ctx);
 const first=await evaluate('window.firstFrame');assert.deepEqual(first,{new:'新增對話',cancel:'取消'});
 assert.equal(await evaluate('document.querySelector("#semanticPrivate").textContent'),'Save');
 assert.equal(await evaluate('document.querySelector("#semanticTranscript").textContent'),'Cancel');
 assert.equal(await evaluate('document.querySelector("#overlayPlaceholder").textContent'),'描述任務或提問');
 for (const [id,text] of [['realHeading','Settings'],['realTool','Save'],['realSession','New session'],['realLink','Settings']]) assert.equal(await evaluate('document.getElementById('+JSON.stringify(id)+').textContent'),text);
 const initial=await evaluate(`Object.fromEntries(['new','chat','draft','editor','code','userTitle','desc','unknown'].map(id=>[id,document.getElementById(id).textContent]))`);
 assert.equal(await evaluate('document.querySelector("#staticStats").textContent'),'工作階段');
 assert.equal(await evaluate('document.querySelector("#staticValue").textContent'),'54');
 assert.equal(await evaluate('document.querySelector("#staticLocal").textContent'),'本機');
 assert.equal(await evaluate('document.querySelector("#staticManual").textContent'),'手動');
 assert.equal(await evaluate('document.querySelector("#greeting").textContent'),'接下來要做什麼，Fixture？');
 assert.equal(await evaluate('document.querySelector("#tipPlaceholder").getAttribute("data-placeholder")'),'Describe a task or ask a question');
 assert.equal(await evaluate('getComputedStyle(document.querySelector("#tipPlaceholder"),"::before").content'),'"描述任務或提問"');
 assert.equal(initial.chat,'Save');assert.equal(initial.draft,'Cancel');assert.equal(initial.editor,'New session');assert.equal(initial.code,'Save');assert.equal(initial.userTitle,'New session');assert.equal(initial.unknown,'Newly invented control');assert.match(initial.desc,/允許 Claude/);
 assert.equal(await evaluate('document.querySelector("#draft").getAttribute("placeholder")'),'輸入訊息…');
 // Normalized keys can differ from raw DOM whitespace. A successful lookup
 // must actually replace the label, rather than falsely counting a no-op.
 await evaluate(`document.querySelector('#host').innerHTML='<button id="spaced" title="  New  session  ">  New  session  </button>'`);
 await evaluate('new Promise(r=>requestAnimationFrame(r))',ctx);
 assert.equal(await evaluate('document.querySelector("#spaced").textContent'),'  新增對話  ');
 assert.equal(await evaluate('document.querySelector("#spaced").title'),'  新增對話  ');
 // Screenshot regressions: split text around an inline command; new static UI
 // keys must not make matching user-created chat/task titles translatable.
 await evaluate(`document.querySelector('#host').innerHTML='<h1 id="scheduleTitle">Scheduled tasks</h1><p id="scheduleHelp">Run tasks on a schedule or whenever you need them. Type <code>/schedule</code> in any existing task to set one up.</p><button id="sort">Sort by <span>Next run</span></button><h2 id="artifactTitle">Artifacts</h2><h3 id="makeNew">Make something new</h3><button id="documentKind">Document</button><button id="presentationKind">Presentation</button><p id="artifactHelp">New slides and Design projects are created as artifacts.</p><button id="artifactHome">Visit the standalone homepage</button><a href="/chat/fixture-private"><h2 id="privateArtifact">Artifacts</h2></a><div data-session-id="fixture-private"><h2 id="privateBriefing">Daily briefing</h2></div>'`);
 await evaluate('new Promise(r=>requestAnimationFrame(r))',ctx);
 for (const [id,text] of [
   ['scheduleTitle','排程任務'],['sort','排序依據 下次執行'],
   ['artifactTitle','作品'],['makeNew','建立新作品'],
   ['documentKind','文件'],['presentationKind','簡報'],
   ['artifactHelp','新的簡報與設計專案都會建立為作品。'],
   ['artifactHome','前往獨立首頁'],['privateArtifact','Artifacts'],
   ['privateBriefing','Daily briefing'],
 ]) assert.equal(await evaluate('document.getElementById('+JSON.stringify(id)+').textContent'),text);
 assert.equal(await evaluate('document.querySelector("#scheduleHelp").textContent'),'依排程或隨時執行任務。輸入 /schedule 即可在任何現有任務中設定排程。');
 await evaluate(`history.replaceState(null,'','/scheduled-task');document.querySelector('#host').innerHTML='<p id="emptySchedule">No scheduled tasks yet.</p><div><span id="keepAwake">Keep awake</span><button role="switch" aria-checked="false"></button></div><a href="/artifacts/private"><h2 id="privateDocument">Document</h2></a><a href="/scheduled-task/private"><h3 id="privateTaskRow">Daily briefing</h3></a><input id="taskSearch" placeholder="Search scheduled tasks" value="Daily briefing"><div data-session-id="private"><p id="privateEmpty">No scheduled tasks yet.</p></div><div role="list"><p id="privateRow">No scheduled tasks yet.</p></div>'`);
 await evaluate('new Promise(r=>requestAnimationFrame(r))',ctx);
 for (const [id,text] of [['emptySchedule','尚無排程任務。'],['keepAwake','保持喚醒'],['privateDocument','Document'],['privateTaskRow','Daily briefing'],['privateEmpty','No scheduled tasks yet.'],['privateRow','No scheduled tasks yet.']]) {
   assert.equal(await evaluate('document.getElementById('+JSON.stringify(id)+').textContent'),text);
 }
 assert.equal(await evaluate('document.querySelector("#host [role=switch]").getAttribute("aria-checked")'),'false');
 assert.equal(await evaluate('document.querySelector("#taskSearch").getAttribute("placeholder")'),'搜尋排程任務');
 assert.equal(await evaluate('document.querySelector("#taskSearch").value'),'Daily briefing');
 await evaluate(`history.replaceState(null,'','/scheduled-task/private');document.querySelector('#host').innerHTML='<p id="detailCopy">No scheduled tasks yet.</p>'`);
 await evaluate('new Promise(r=>requestAnimationFrame(r))',ctx);
 assert.equal(await evaluate('document.querySelector("#detailCopy").textContent'),'No scheduled tasks yet.');
 await evaluate(`history.replaceState(null,'','/new');document.querySelector('#host').innerHTML='<div class="font-display"><span class="select-none" id="homeStockGreeting">Here we go!</span></div><span id="homeUnscoped">Here we go!</span><div data-testid="message"><div class="font-display"><span class="select-none" id="homePrivate">Here we go!</span></div></div><span id="modelUpdate">Claude Opus 5.5 works best with the latest desktop app.</span>'`);
 await evaluate('new Promise(r=>requestAnimationFrame(r))',ctx);
 assert.equal(await evaluate('document.querySelector("#homeStockGreeting").textContent'),'開始吧！');
 assert.equal(await evaluate('document.querySelector("#homeUnscoped").textContent'),'Here we go!');
 assert.equal(await evaluate('document.querySelector("#homePrivate").textContent'),'Here we go!');
 assert.equal(await evaluate('document.querySelector("#modelUpdate").textContent'),'搭配最新版桌面應用程式，Claude Opus 5.5 的效果最佳。');
 await evaluate(`history.replaceState(null,'','/epitaxy')`);
 await evaluate(`document.querySelector('#new').firstChild.nodeValue='Save';document.querySelector('#cancel').setAttribute('title','Back');document.querySelector('#host').innerHTML='<div role="menu"><button id="later">Delete</button></div>'`);
 await evaluate('new Promise(r=>requestAnimationFrame(r))',ctx);
 assert.equal(await evaluate('document.querySelector("#new").textContent'),'儲存');assert.equal(await evaluate('document.querySelector("#later").textContent'),'刪除');assert.equal(await evaluate('document.querySelector("#cancel").title'),'返回');
 // Disable while React overwrites the text; restore must not put stale English back.
 await evaluate(`document.querySelector('#new').firstChild.nodeValue='Fresh dynamic value';cfg={...cfg,enabled:false};tw.update(cfg);`,ctx);
 assert.equal(await evaluate('document.querySelector("#new").textContent'),'Fresh dynamic value');assert.equal(await evaluate('document.querySelector("#cancel").textContent'),'Cancel');
 await evaluate(`cfg={...cfg,enabled:true};tw.update(cfg);`,ctx);
 // Performance: bulk menu DOM, all 1000 keys translated by the next frame, no network.
 const perf=await evaluate(`(async()=>{let t=performance.now();const f=document.createDocumentFragment();for(let i=0;i<1000;i++){let b=document.createElement('button');b.textContent='Save';f.append(b);}document.querySelector('#host').replaceChildren(f);await new Promise(r=>requestAnimationFrame(r));return {elapsedMs:performance.now()-t,translated:[...document.querySelectorAll('#host button')].every(b=>b.textContent==='儲存'),stats:tw.stats()};})()`,ctx);
 assert.equal(perf.translated,true);assert.ok(perf.stats.maxScanMs<100, "single scan must stay below 100ms in fixture");
 // A reused row gains the real production privacy attribute after rendering.
 await evaluate(`const box=document.createElement('div');box.id='latePrivate';box.innerHTML='<button>Save</button>';document.body.append(box);`);
 await evaluate('new Promise(r=>requestAnimationFrame(r))',ctx);
 assert.equal(await evaluate('document.querySelector("#latePrivate button").textContent'),'儲存');
 await evaluate(`document.querySelector('#latePrivate').setAttribute('data-session-id','synthetic-late');`);
 await evaluate('new Promise(r=>requestAnimationFrame(r))',ctx);
 assert.equal(await evaluate('document.querySelector("#latePrivate button").textContent'),'Save');
 // A translated control moved into a message must lose our old overlay.
 await evaluate(`const moved=document.querySelector('#cancel');const privateBox=document.createElement('div');privateBox.dataset.testid='message';document.body.append(privateBox);privateBox.append(moved);`);
 await evaluate('new Promise(r=>requestAnimationFrame(r))',ctx);
 assert.equal(await evaluate('document.querySelector("#cancel").textContent'),'Cancel');
 // If React deliberately writes a Chinese string, disabling must preserve it.
 await evaluate(`const b=document.querySelector('#host button');b.firstChild.nodeValue='儲存';`);
 await evaluate('new Promise(r=>requestAnimationFrame(r))',ctx);
 await evaluate(`cfg={...cfg,enabled:false};tw.update(cfg)`,ctx);
 assert.equal(await evaluate('document.querySelector("#host button").textContent'),'儲存');
 await evaluate(`cfg={...cfg,compatible:false};tw.update(cfg)`,ctx);assert.equal(await evaluate('document.querySelector("#cancel").textContent'),'Cancel');
 const receipt={pass:true,firstFrame:first,privateContentUnchanged:true,screenshotStaticFixture:true,splitCommandPreserved:true,matchingPrivateTitlesPreserved:true,codeStaticControls:true,codePlaceholder:true,headingNamePreserved:true,nodeReuse:true,attributeReuse:true,movedPrivateContext:true,frameworkChinesePreserved:true,toggleRestore:true,versionMismatchFailClosed:true,offlineDictionaryEntries:Object.keys(dictionary).length,performance:perf};
 fs.writeFileSync(path.join(root,'evidence/browser-results.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
 await send('Browser.close').catch(()=>{});
} finally {ws?.close();if(chrome.exitCode===null){chrome.kill('SIGTERM');await once(chrome,'exit').catch(()=>{});}server.close();fs.rmSync(profile,{recursive:true,force:true});}
