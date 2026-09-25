// Real headless Chromium, isolated world, disposable synthetic profile only.
// Uses reduced structural fixtures and synthetic counts, never private App data.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const root = path.resolve(import.meta.dirname,'..');
const evidence = fs.mkdtempSync(path.join(root,'evidence/code-stats-browser-'));
const profile = fs.mkdtempSync(path.join(evidence,'synthetic-profile-'));
const source = fs.readFileSync(path.join(root,'claude-tw/translator.js'),'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const shapeSource = fs.readFileSync(path.join(root,'tests/fixtures/public/code-stats-shapes.json'),'utf8');
const captured = JSON.parse(shapeSource);
assert.equal(captured.route,'/epitaxy');
const [hour,comparison] = captured.shapes;
// Synthetic values: structural fixture intentionally contains no observed usage.
hour.text='1 PM';
comparison.text='You’ve used ~217× more tokens than The Hobbit.';
const dune = 'You’ve used ~109× more tokens than Dune.';
const valid = [
  [hour,'1 PM','下午 1 點'], [hour,'12 AM','上午 12 點'], [hour,'12 PM','下午 12 點'],
  [hour,'9 AM','上午 9 點'], [comparison,comparison.text,'你使用的 token 數比 The Hobbit 多 ~217×。'],
  [comparison,dune,'你使用的 token 數比 Dune 多 ~109×。'],
  [comparison,'You’ve used ~000217× more tokens than Dune.','你使用的 token 數比 Dune 多 ~000217×。'],
  [comparison,'You’ve used ~9007199254740993× more tokens than The Hobbit.','你使用的 token 數比 The Hobbit 多 ~9007199254740993×。'],
  [comparison,'You’ve used ~123456789012345678× more tokens than Dune.','你使用的 token 數比 Dune 多 ~123456789012345678×。'],
  [hour,' \n1 PM\t ',' \n下午 1 點\t '],
  [comparison,`\n ${dune} \t`,`\n 你使用的 token 數比 Dune 多 ~109×。 \t`],
];
const invalid = [
  [hour,'0 PM'], [hour,'13 AM'], [hour,'01 PM'], [hour,'1:30 PM'], [hour,'1 pm'], [hour,'1 PM extra'],
  [comparison,"You've used ~217× more tokens than The Hobbit."],
  [comparison,'You’ve used ~1.5× more tokens than Dune.'],
  [comparison,'You’ve used ~1,217× more tokens than Dune.'],
  [comparison,'You’ve used ~217x more tokens than Dune.'],
  [comparison,'You’ve used ~1234567890123456789× more tokens than Dune.'],
  [comparison,'You’ve used ~109× more tokens than Dune. extra'],
  [comparison,'You’ve used ~109× more tokens than My private document.'],
  [comparison,'You’ve used ~109× more tokens than Foundation.'],
];
// Every full source deliberately maps to an incorrect value. None may override
// preserving templates or grant permission to unsupported payloads/contexts.
const dictionary = Object.fromEntries([...valid,...invalid].map(([,raw]) => [raw.trim(),'錯誤：改掉數字和名稱']));
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const leaf = (r,id,text=r.text) =>
  `<${r.parent.tag} class="${esc(r.parent.cls)}"><${r.tag} id="${id}" class="${esc(r.cls)}">${esc(text)}</${r.tag}></${r.parent.tag}>`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>ClaudeTW stats fixture</title></head><body>
  <div id="desktop-pane" role="region" class="dframe-pane dframe-pane-primary min-w-0 relative flex flex-col">
  <div data-testid="epitaxy-stats-card" id="stats">
    ${leaf(hour,'peak')}${leaf(comparison,'comparison')}${leaf(comparison,'dune',dune)}
  </div></div><div id="outside"></div>
  <script>requestAnimationFrame(()=>{window.firstFrame=Object.fromEntries(['peak','comparison','dune'].map(id=>[id,document.getElementById(id).textContent]));});</script>
  </body></html>`;
const server = http.createServer((_req,res) => {
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
  '--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--disable-component-update','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank',
],{stdio:'ignore'});
let ws,seq=0,contextId,send;
const calls=new Map(),events=[],checks=[],blockedRequests=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try {
  let port;
  for(let i=0;i<100;i++) {
    try {port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;} catch {}
    await delay(100);
  }
  assert.ok(port,'Own synthetic Chromium started');
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(ws,'open');
  send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{calls.delete(id);reject(new Error(`CDP timeout: ${method}`));},15000);
    calls.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
  });
  ws.onmessage=event=>{
    const m=JSON.parse(event.data);
    if(m.id) {
      const c=calls.get(m.id);if(!c)return;calls.delete(m.id);clearTimeout(c.timer);
      m.error?c.reject(new Error(JSON.stringify(m.error))):c.resolve(m.result);
    } else {
      events.push(m);
      if(m.method==='Fetch.requestPaused') {
        const {requestId,request}=m.params;
        if(request.url.startsWith(origin+'/'))send('Fetch.continueRequest',{requestId}).catch(()=>{});
        else {blockedRequests.push(request.url);send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'}).catch(()=>{});}
      }
    }
  };
  const evaluate=async(expression,isolated=false)=>{
    const r=await send('Runtime.evaluate',{expression,...(isolated?{contextId}:{}),returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;
  };
  const frame=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const assertText=async(id,text)=>assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`),text,id);
  const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS',name);};
  await send('Page.enable');await send('Runtime.enable');await send('Log.enable');
  await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  await send('Emulation.setDeviceMetricsOverride',{width:1000,height:700,deviceScaleFactor:1,mobile:false});
  await send('Page.addScriptToEvaluateOnNewDocument',{worldName:'claudetw-stats-test',source:`${source}
    const opts=new URLSearchParams(location.search);
    if(opts.has('no-navigation'))Object.defineProperty(globalThis,'navigation',{value:undefined,configurable:true});
    globalThis.cfg={schema:2,enabled:!opts.has('disabled'),compatible:!opts.has('incompatible'),
      revision:'fixture',dictionary:opts.has('empty')?{}:${JSON.stringify(dictionary)}};
    globalThis.tw=installClaudeTW({bootstrap:()=>cfg,refresh:async()=>cfg,report:r=>globalThis.lastReport=r});`});
  async function navigate(route='/epitaxy') {
    const start=events.length;await send('Page.navigate',{url:origin+route});contextId=null;
    for(let i=0;i<100;i++) {
      contextId=events.slice(start).find(e=>e.method==='Runtime.executionContextCreated'&&e.params.context.name==='claudetw-stats-test')?.params.context.id;
      if(contextId&&await evaluate('!!document.getElementById("dune")',true))break;
      await delay(30);
    }
    assert.ok(contextId,'Isolated world');await frame();
    assert.equal(await evaluate('location.href'),origin+route);
    assert.equal(await evaluate('document.title'),'ClaudeTW stats fixture');
  }
  const replace=async(markup)=>{
    await evaluate(`document.getElementById('stats').innerHTML=${JSON.stringify(markup)}`);await frame();
  };
  const base=async(translated=true)=>{
    await assertText('peak',translated?'下午 1 點':hour.text);
    await assertText('comparison',translated?'你使用的 token 數比 The Hobbit 多 ~217×。':comparison.text);
    await assertText('dune',translated?'你使用的 token 數比 Dune 多 ~109×。':dune);
  };
  await check('first frame, empty dictionary, fixed The Hobbit and Dune preserving templates',async()=>{
    await navigate('/epitaxy?empty');await base();
    assert.deepEqual(await evaluate('window.firstFrame'),{
      peak:'下午 1 點',comparison:'你使用的 token 數比 The Hobbit 多 ~217×。',dune:'你使用的 token 數比 Dune 多 ~109×。',
    });
  });
  await check('dictionary cannot override hours, leading zeros, >safe-integer amounts, 18 digits or whitespace',async()=>{
    await navigate();
    for(const [r,raw,target] of valid) {await replace(leaf(r,'sample',raw));await assertText('sample',target);}
  });
  await check('unsupported grammar, arbitrary titles and suffixes stay unchanged despite exact dictionary traps',async()=>{
    for(const [r,raw] of invalid) {await replace(leaf(r,'sample',raw));await assertText('sample',raw);}
  });
  await check('exact /epitaxy only; new/settings/detail/trailing-slash never authorize dictionary fallback',async()=>{
    for(const route of ['/new','/settings','/epitaxy/','/epitaxy/private-id','/customize/skills']) {
      await navigate(route);await base(false);
      await replace(`<button>${leaf(comparison,'sample')}</button>`);await assertText('sample',comparison.text);
    }
  });
  await check('main-world route-only replaceState/pushState/back restores and reapplies unchanged nodes',async()=>{
    await navigate();
    for(const route of ['/new','/epitaxy/','/epitaxy/private-id']) {
      await evaluate(`history.replaceState(null,'',${JSON.stringify(route)})`);await frame();await base(false);
      await evaluate(`history.replaceState(null,'','/epitaxy')`);await frame();await base();
    }
    await evaluate(`history.pushState(null,'','/new')`);await frame();await base(false);
    await evaluate('history.back()');
    for(let i=0;i<100&&await evaluate('location.pathname')!=='/epitaxy';i++)await delay(20);
    await frame();await base();
  });
  await check('card missing/wrong marker or moved outside restores; returning reapplies',async()=>{
    await navigate();
    await evaluate(`document.getElementById('stats').removeAttribute('data-testid')`);await frame();await base(false);
    await evaluate(`document.getElementById('stats').setAttribute('data-testid','wrong-card')`);await frame();await base(false);
    await evaluate(`document.getElementById('stats').setAttribute('data-testid','epitaxy-stats-card')`);await frame();await base();
    await evaluate(`document.getElementById('outside').append(document.getElementById('comparison').parentElement)`);await frame();
    await assertText('comparison',comparison.text);
    await evaluate(`document.getElementById('stats').append(document.getElementById('comparison').parentElement)`);await frame();
    await assertText('comparison','你使用的 token 數比 The Hobbit 多 ~217×。');
  });
  await check('only exact observed OUTER desktop region allowed; card/inner region, unknown role, button and chat rejected',async()=>{
    await navigate();await base();
    for(const [attr,value] of [['role','button'],['role','group'],['role','unknown'],
      ['class','dframe-pane'],['data-testid','message']]) {
      await navigate();
      await evaluate(`document.getElementById('desktop-pane').setAttribute(${JSON.stringify(attr)},${JSON.stringify(value)})`);
      await frame();await base(false);
    }
    await navigate();
    await evaluate(`document.getElementById('stats').setAttribute('role','region');document.getElementById('stats').className='dframe-pane dframe-pane-primary min-w-0 relative flex flex-col'`);
    await frame();await base(false);
    await navigate();
    for(const wrap of [
      '<div role="region" class="dframe-pane dframe-pane-primary min-w-0 relative flex flex-col">',
      '<button>', '<div role="button">', '<div data-testid="message">']) {
      await replace(`${wrap}${leaf(hour,'sample')}</${wrap.startsWith('<button')?'button':'div'}>`);
      await assertText('sample',hour.text);
    }
    await navigate();
    await evaluate(`const pane=document.getElementById('desktop-pane');pane.className=pane.className.split(' ').reverse().join(' ')`);
    await frame();await base();
  });
  await check('observed leaf/parent class sets only, order independent; wrong tag/extra or missing class rejected',async()=>{
    await navigate();
    for(const r of [hour,comparison]) {
      await replace(leaf({...r,cls:r.cls.split(' ').reverse().join(' '),
        parent:{...r.parent,cls:r.parent.cls.split(' ').reverse().join(' ')}},'sample'));
      await assertText('sample',r===hour?'下午 1 點':'你使用的 token 數比 The Hobbit 多 ~217×。');
      for(const altered of [{...r,tag:'DIV'},{...r,parent:{...r.parent,tag:'SECTION'}},
        {...r,cls:r.cls+' extra'},{...r,cls:r.cls.split(' ').slice(1).join(' ')},
        {...r,parent:{...r.parent,cls:r.parent.cls+' extra'}}]) {
        await replace(leaf(altered,'sample'));await assertText('sample',r.text);
      }
    }
  });
  await check('multi-text or nested markup never flattened; controls cannot bypass structural gate',async()=>{
    await navigate();
    await evaluate(`document.getElementById('peak').append(document.createTextNode(''))`);await frame();
    await assertText('peak','1 PM');
    await replace(leaf(comparison,'sample').replace(esc(comparison.text),`<b>${esc(comparison.text)}</b>`));
    await assertText('sample',comparison.text);
    await replace(`<button>${leaf(comparison,'sample')}</button>`);
    // A role-less button ancestor is not an authorization source; use a wrong
    // leaf shape to prove the generic control fallback cannot override its gate.
    await evaluate(`document.getElementById('sample').className='wrong'`);await frame();
    await assertText('sample',comparison.text);
  });
  await check('private/chat/draft/code/session/anchor/role/hidden contexts never translate',async()=>{
    await navigate();
    for(const [tag,attrs] of [['div','data-testid="message"'],['code',''],['pre',''],
      ['div','contenteditable="true"'],['div','contenteditable="false"'],['div','data-session-id="synthetic"'],
      ['a','href="/chat/synthetic"'],['a','href="/help"'],['div','role="group"'],
      ['div','hidden'],['div','aria-hidden="true"']]) {
      await replace(`<${tag} ${attrs}>${leaf(hour,'privateHour')}${leaf(comparison,'privateComparison')}</${tag}>`);
      await assertText('privateHour',hour.text);await assertText('privateComparison',comparison.text);
    }
  });
  await check('context/class changes remove owned overlays; exact context restoration re-enables',async()=>{
    for(const [attr,value] of [['role','group'],['hidden',''],['aria-hidden','true'],['data-claude-tw-private','']]) {
      await navigate();await evaluate(`document.getElementById('stats').setAttribute(${JSON.stringify(attr)},${JSON.stringify(value)})`);
      await frame();await base(false);
      await evaluate(`document.getElementById('stats').removeAttribute(${JSON.stringify(attr)})`);await frame();await base();
    }
    await evaluate(`window.peakClass=document.getElementById('peak').className;document.getElementById('peak').className='changed'`);
    await frame();await assertText('peak',hour.text);
    await evaluate(`document.getElementById('peak').className=peakClass`);await frame();await base();
  });
  await check('title/aria-label/placeholder/alt unchanged even with matching numeric dictionary keys',async()=>{
    await navigate();
    for(const [id,raw] of [['peak',hour.text],['comparison',comparison.text],['dune',dune]]) {
      await evaluate(`for(const a of ['title','aria-label','placeholder','alt'])document.getElementById(${JSON.stringify(id)}).setAttribute(a,${JSON.stringify(raw)})`);
      await frame();
      for(const a of ['title','aria-label','placeholder','alt']) {
        assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).getAttribute(${JSON.stringify(a)})`),raw);
      }
    }
    await base();
  });
  await check('detached rows restore before private reuse; framework numeric changes become the new source',async()=>{
    await navigate();
    await evaluate(`window.saved=document.getElementById('comparison').parentElement;saved.remove()`);await frame();
    assert.equal(await evaluate('saved.textContent'),comparison.text);
    await evaluate(`document.getElementById('outside').setAttribute('data-testid','message');document.getElementById('outside').append(saved)`);
    await frame();await assertText('comparison',comparison.text);
    await navigate();
    await evaluate(`document.getElementById('comparison').firstChild.nodeValue='You’ve used ~205× more tokens than The Hobbit.'`);
    await frame();await assertText('comparison','你使用的 token 數比 The Hobbit 多 ~205×。');
    await evaluate('cfg={...cfg,enabled:false};tw.update(cfg)',true);
    await assertText('comparison','You’ve used ~205× more tokens than The Hobbit.');
  });
  await check('pending framework-owned Chinese survives same-task route exit and disable',async()=>{
    await navigate();
    await evaluate(`document.getElementById('peak').firstChild.nodeValue='下午 1 點';history.replaceState(null,'','/new')`);
    await frame();await assertText('peak','下午 1 點');await assertText('comparison',comparison.text);
    await navigate();
    await evaluate(`document.getElementById('comparison').firstChild.nodeValue='你使用的 token 數比 The Hobbit 多 ~217×。';cfg={...cfg,enabled:false};tw.update(cfg)`,true);
    await assertText('comparison','你使用的 token 數比 The Hobbit 多 ~217×。');await assertText('peak',hour.text);
  });
  await check('disabled/incompatible/missing native Navigation API all fail closed',async()=>{
    for(const flag of ['disabled','incompatible','no-navigation']) {
      await navigate('/epitaxy?'+flag);await base(false);
      if(flag==='no-navigation')assert.equal(await evaluate('typeof navigation',true),'undefined');
    }
    await navigate();await evaluate('cfg={...cfg,enabled:false};tw.update(cfg)',true);await base(false);
    await evaluate('cfg={...cfg,enabled:true};tw.update(cfg)',true);await base();
    await evaluate('cfg={...cfg,compatible:false};tw.update(cfg)',true);await base(false);
    await evaluate('cfg={...cfg,compatible:true};tw.update(cfg)',true);await base();
  });
  await check('no feedback loop/network/errors; report contains counters only; screenshot is synthetic',async()=>{
    await frame();const before=await evaluate('tw.stats().flushes',true);await delay(1100);
    assert.equal(await evaluate('tw.stats().flushes',true),before);
    const report=await evaluate('lastReport',true);
    assert.deepEqual(Object.keys(report).sort(),['unknownCount','mismatchCount','appliedCount','flushCount','maxScanMs','revision'].sort());
    for(const [key,value] of Object.entries(report))if(key!=='revision')assert.equal(typeof value,'number');
    assert.deepEqual(blockedRequests,[]);
    assert.deepEqual(events.filter(e=>e.method==='Runtime.exceptionThrown'||
      (e.method==='Log.entryAdded'&&['error','warning'].includes(e.params.entry.level))),[]);
    const image=await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(evidence,'code-stats.png'),Buffer.from(image.data,'base64'));
  });
  const receipt={pass:true,livePass:false,sourceSha256,
    shapeSha256:createHash('sha256').update(shapeSource).digest('hex'),
    environment:'Chromium headless / isolated world / synthetic-only profile',
    checks,firstFrame:true,stats:await evaluate('tw.stats()',true)};
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({...receipt,evidence:path.relative(root,evidence)},null,2));
  await send('Browser.close').catch(()=>{});
} catch(error) {
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({pass:false,livePass:false,sourceSha256,checks,error:String(error)},null,2));
  console.error('Evidence:',path.relative(root,evidence));throw error;
} finally {
  for(const call of calls.values())clearTimeout(call.timer);
  ws?.close();
  if(chrome.exitCode===null){const exited=once(chrome,'exit');chrome.kill('SIGTERM');await exited.catch(()=>{});}
  server.close();fs.rmSync(profile,{recursive:true,force:true});
}
