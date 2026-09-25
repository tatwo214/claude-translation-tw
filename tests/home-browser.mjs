// Tests only: captured public stock ancestry; synthetic private counterexamples.
// Real headless Chromium / isolated world / disposable profile, never the App.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const evidence=fs.mkdtempSync(path.join(root,'evidence/home-browser-'));
const profile=fs.mkdtempSync(path.join(evidence,'synthetic-profile-'));
const source=fs.readFileSync(path.join(root,'claude-tw/translator.js'),'utf8');
const sourceSha256=createHash('sha256').update(source).digest('hex');
const webBytes=fs.readFileSync(path.join(root,'claude-tw/web-overrides.json'));
const webSha256=createHash('sha256').update(webBytes).digest('hex');
const shapeSource=fs.readFileSync(path.join(root,'tests/fixtures/public/home-stock.json'),'utf8');
const fixture=JSON.parse(shapeSource);
const dictionaryHashes={};
const dictionary=Object.assign({},...['native-overrides.json','web-overrides.json','overrides.json'].map(n=>{
  const bytes=fs.readFileSync(path.join(root,'claude-tw',n));
  dictionaryHashes[n]=createHash('sha256').update(bytes).digest('hex');
  return JSON.parse(bytes);
}));
const entries=Object.entries(fixture.dictionaryEntries),keys=entries.map(([key])=>key);
assert.equal(keys.length,10);
for(const [key,value] of entries)assert.equal(dictionary[key],value,`Merged source dictionary: ${key}`);
assert.deepEqual(fixture.excludedVideoLabels,['Dispatch','Online','Chat with Cowork']);
for(const key of fixture.excludedVideoLabels)assert.equal(keys.includes(key),false);
function buildHome(fixture) {
  const opts=new URLSearchParams(location.search),context=opts.get('private');
  const host=document.createElement(context==='code'?'pre':'div');host.id='stock-fixture';
  const attributes={chat:['data-testid','message'],custom:['data-testid','project-name'],session:['data-session-id','synthetic'],draft:['contenteditable','true'],transcript:['data-testid','transcript-row']};
  if(attributes[context])host.setAttribute(...attributes[context]);
  const descriptors=[],identities=[];
  const make=shape=>{const el=document.createElement(shape.tag);el.className=shape.cls||'';if(shape.role)el.setAttribute('role',shape.role);if(shape.test)el.setAttribute('data-testid',shape.test);return el;};
  for(const c of fixture.captures.filter(c=>c.route===location.pathname)){
    const chain=c.chain.map(i=>fixture.nodes[i]),leaf=make(chain[0]);leaf.id=c.id;
    if(!c.children){leaf.append(document.createTextNode(c.text));descriptors.push({id:c.id,key:c.text});}
    else {
      // Captured P children: disclaimer Text + A with aggregate text.
      const prose=c.children[0].text;leaf.append(document.createTextNode(prose));
      descriptors.push({id:c.id,key:prose.trim()});
      const link=make(c.children[1]);link.id='dispatch-safety';link.setAttribute('href',fixture.syntheticOnly.href);
      const linkKey='Learn how to use this safely';
      if(opts.has('unsplit-link'))link.append(document.createTextNode(c.children[1].text));
      else {
        // Explicitly SYNTHETIC: actual A inner childNodes were not captured.
        link.append(document.createTextNode(linkKey));
        const sr=document.createElement('span');sr.id='synthetic-safety-sr';sr.className='sr-only';sr.append(document.createTextNode('(opens in new tab)'));link.append(sr);
        identities.push({id:sr.id,node:sr,children:[...sr.childNodes]});
      }
      window.safetyEvents=0;link.addEventListener('fixture-check',()=>window.safetyEvents++);
      leaf.append(link);descriptors.push({id:link.id,key:linkKey});identities.push({id:link.id,node:link,children:[...link.childNodes]});
    }
    identities.push({id:leaf.id,node:leaf,children:[...leaf.childNodes]});
    let outer=leaf;for(const shape of chain.slice(1)){const parent=make(shape);parent.append(outer);outer=parent;}
    host.append(outer);
  }
  document.body.replaceChildren(host);
  const outside=document.createElement('div');outside.id='outside';document.body.append(outside);
  window.descriptors=descriptors;
  window.readStock=()=>Object.fromEntries(descriptors.map(({id,key})=>[key,document.getElementById(id).firstChild.nodeValue.trim()]));
  window.stockIdentitiesIntact=()=>identities.every(({id,node,children})=>node===document.getElementById(id)&&children.length===node.childNodes.length&&children.every((child,i)=>child===node.childNodes[i]));
  requestAnimationFrame(()=>window.firstFrame=readStock());
}
const html=`<!doctype html><html><head><meta charset="utf-8"><title>ClaudeTW home fixture</title></head><body><script>(${buildHome.toString()})(${JSON.stringify(fixture)});</script></body></html>`;
const server=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);});
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
  await send('Page.addScriptToEvaluateOnNewDocument',{worldName:'claudetw-home-test',source:`${source}
    const opts=new URLSearchParams(location.search);
    if(opts.has('no-navigation'))Object.defineProperty(globalThis,'navigation',{value:undefined,configurable:true});
    globalThis.cfg={schema:2,enabled:!opts.has('disabled'),compatible:!opts.has('incompatible'),
      revision:'fixture',dictionary:opts.has('empty')?{}:${JSON.stringify(dictionary)}};
    globalThis.tw=installClaudeTW({bootstrap:()=>cfg,refresh:async()=>cfg,report:r=>globalThis.lastReport=r});`});
  async function navigate(route) {
    const start=events.length;await send('Page.navigate',{url:origin+route});contextId=null;
    for(let i=0;i<100;i++) {
      contextId=events.slice(start).find(e=>e.method==='Runtime.executionContextCreated'&&e.params.context.name==='claudetw-home-test')?.params.context.id;
      if(contextId&&await evaluate('!!document.getElementById("stock-fixture")',true))break;
      await delay(30);
    }
    assert.ok(contextId,'Isolated world');await frame();
    assert.equal(await evaluate('location.href'),origin+route);
    assert.equal(await evaluate('document.title'),'ClaudeTW home fixture');
  }
  const firstFrames={};
  async function expectedStock(translated) {
    const descriptors=await evaluate('descriptors');
    assert.equal(descriptors.length,5,'Five stock strings per route');
    return Object.fromEntries(descriptors.map(({key})=>[key,translated?dictionary[key]:key]));
  }
  async function assertStock(translated,first=false) {
    assert.deepEqual(await evaluate(first?'firstFrame':'readStock()'),await expectedStock(translated));
  }
  for(const route of ['/new','/cowork/agent']) {
    await check(`${route}: five approved strings translated in first animation frame`,async()=>{
      await navigate(route);
      await assertStock(true,true);await assertStock(true);
      firstFrames[route]=await evaluate('firstFrame');
      assert.equal(await evaluate('stockIdentitiesIntact()'),true);
    });
  }
  await check('nine captured keys plus one synthetic-inner-link key covered; media labels not counted',async()=>{
    assert.deepEqual(Object.keys(Object.assign({},...Object.values(firstFrames))).sort(),keys.slice().sort());
    assert.equal(await evaluate('!!document.querySelector("video")'),false);
  });
  await check('disclaimer whitespace, nested A/Text/synthetic accessibility nodes and listener preserved',async()=>{
    const prose=fixture.captures.find(c=>c.children).children[0].text;
    assert.equal(await evaluate('document.getElementById("stock-8").firstChild.nodeValue'),dictionary[prose.trim()]+' ');
    await assertText('dispatch-safety',dictionary['Learn how to use this safely']+'(opens in new tab)');
    await assertText('synthetic-safety-sr','(opens in new tab)');
    assert.equal(await evaluate('document.getElementById("dispatch-safety").getAttribute("href")'),fixture.syntheticOnly.href);
    assert.equal(await evaluate('stockIdentitiesIntact()'),true);
    await evaluate('document.getElementById("dispatch-safety").dispatchEvent(new Event("fixture-check"))');
    assert.equal(await evaluate('safetyEvents'),1);
  });
  await check('unexpanded anchor evidence limitation: aggregate-only Text is not guessed/split',async()=>{
    await navigate('/cowork/agent?unsplit-link');
    const expected=await expectedStock(true);
    expected['Learn how to use this safely']=fixture.captures.find(c=>c.children).children[1].text;
    assert.deepEqual(await evaluate('firstFrame'),expected);
    assert.deepEqual(await evaluate('readStock()'),expected);
    assert.equal(await evaluate('stockIdentitiesIntact()'),true);
  });
  for(const context of ['chat','code','custom','session','draft','transcript']) {
    await check(`synthetic ${context} private ancestor: all ten same-name strings untouched`,async()=>{
      for(const route of ['/new','/cowork/agent']) {
        await navigate(`${route}?private=${context}`);
        await assertStock(false,true);await assertStock(false);
        assert.equal(await evaluate('stockIdentitiesIntact()'),true);
      }
    });
  }
  await check('synthetic dynamic chat/project/code links protect all ten custom titles',async()=>{
    await navigate('/new');
    const values=JSON.stringify(keys);
    await evaluate(`(()=>{
      const outside=document.getElementById('outside');
      for(const route of ['/chat/synthetic','/project/synthetic','/epitaxy/synthetic']) {
        for(const key of ${values}) {
          const a=document.createElement('a');a.href=route;
          const h=document.createElement('h3');h.textContent=key;a.append(h);outside.append(a);
        }
      }
    })()`);
    await frame();
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#outside h3")].map(e=>e.textContent)'),[...keys,...keys,...keys]);
  });
  await check('private context added/removed restores originals then retranslates without replacing nodes',async()=>{
    for(const route of ['/new','/cowork/agent']) {
      await navigate(route);await assertStock(true);
      await evaluate('document.getElementById("stock-fixture").setAttribute("data-testid","message")');
      await frame();await assertStock(false);
      await evaluate('document.getElementById("stock-fixture").removeAttribute("data-testid")');
      await frame();await assertStock(true);
      assert.equal(await evaluate('stockIdentitiesIntact()'),true);
    }
  });
  await check('disabled/incompatible/empty dictionary keep originals in first frame',async()=>{
    for(const route of ['/new','/cowork/agent']) for(const flag of ['disabled','incompatible','empty']) {
      await navigate(`${route}?${flag}`);await assertStock(false,true);await assertStock(false);
    }
  });
  await check('disable restores all ten originals and retains disclaimer children',async()=>{
    for(const route of ['/new','/cowork/agent']) {
      await navigate(route);await assertStock(true);
      await evaluate('cfg={...cfg,enabled:false};tw.update(cfg)',true);
      await assertStock(false);
      assert.equal(await evaluate('stockIdentitiesIntact()'),true);
    }
  });
  const suggestions=fixture.captures.slice(2,5).map(c=>({id:c.id,key:c.text}));
  const assertSuggestions=async translated=>{
    for(const {id,key} of suggestions)await assertText(id,translated?dictionary[key]:key);
  };
  await check('three prompt-like keys: unmarked h/p/span/button/Cowork-link titles blocked on every tested route',async()=>{
    // Purely synthetic task-title counterexamples, not captured private data.
    for(const route of ['/new','/cowork/agent','/cowork/task/synthetic','/chat/synthetic','/settings']) {
      await navigate(route);
      const expected=await evaluate(`(()=>{
        const keys=${JSON.stringify(suggestions.map(s=>s.key))},out=[];
        for(const tag of ['h1','h2','h3','p','span','button','a']) for(const key of keys) {
          const el=document.createElement(tag);el.textContent=key;
          if(tag==='a')el.setAttribute('href','/cowork/task/synthetic');
          document.getElementById('outside').append(el);out.push(key);
        }
        return out;
      })()`);
      await frame();
      assert.deepEqual(await evaluate('[...document.getElementById("outside").children].map(el=>el.textContent)'),expected);
    }
  });
  await check('three prompt-like keys: all ATTRS blocked even on exact stock leaves',async()=>{
    await navigate('/new');
    await evaluate(`(()=>{
      for(const {id,key} of ${JSON.stringify(suggestions)})
        for(const attr of ['aria-label','title','placeholder','alt'])document.getElementById(id).setAttribute(attr,key);
    })()`);
    await frame();await assertSuggestions(true);
    for(const {id,key} of suggestions)for(const attr of ['aria-label','title','placeholder','alt'])
      assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).getAttribute(${JSON.stringify(attr)})`),key);
  });
  await check('route-only navigation restores three prompts; return to /new translates original nodes',async()=>{
    await navigate('/new');
    for(const route of ['/cowork/task/synthetic','/new/','/cowork/agent','/epitaxy']) {
      await evaluate(`history.replaceState(null,'',${JSON.stringify(route)})`);await frame();await assertSuggestions(false);
      await evaluate("history.replaceState(null,'','/new')");await frame();await assertSuggestions(true);
      assert.equal(await evaluate('stockIdentitiesIntact()'),true);
    }
  });
  await check('each captured chain level is required; loss of class/role structure restores',async()=>{
    for(let level=0;level<6;level++) {
      await navigate('/new');
      await evaluate(`window.changed=${JSON.stringify(suggestions)}.map(({id})=>{
        let el=document.getElementById(id);for(let n=0;n<${level};n++)el=el.parentElement;
        const cls=el.className;el.classList.add('synthetic-unknown');return {el,cls};
      })`);
      await frame();await assertSuggestions(false);
      await evaluate('changed.forEach(({el,cls})=>el.className=cls)');
      await frame();await assertSuggestions(true);
    }
    await evaluate(`document.getElementById('stock-2').parentElement.setAttribute('role','button')`);
    await frame();await assertText('stock-2',suggestions[0].key);
  });
  await check('single Text required; detached/moved suggestion overlays restored before private reuse',async()=>{
    await navigate('/new');
    await evaluate(`window.extra=document.createTextNode('');document.getElementById('stock-2').append(extra)`);
    await frame();await assertText('stock-2',suggestions[0].key);
    await evaluate('extra.remove()');await frame();await assertSuggestions(true);
    await evaluate(`window.saved=document.getElementById('stock-2');saved.remove()`);
    await frame();assert.equal(await evaluate('saved.textContent'),suggestions[0].key);
    await evaluate('document.getElementById("outside").append(saved)');
    await frame();await assertText('stock-2',suggestions[0].key);
    await evaluate(`window.link=document.createElement('a');link.href='/cowork/task/synthetic';
      const leaf=document.getElementById('stock-3'),outer=leaf.closest('ul').parentElement.parentElement;
      outer.replaceWith(link);link.append(outer)`);
    await frame();await assertText('stock-3',suggestions[1].key);
  });
  await check('missing route events fails closed only for the three scoped prompts',async()=>{
    await navigate('/new?no-navigation');
    await assertSuggestions(false);
    await assertText('stock-0',dictionary['Project or folder']);await assertText('stock-1',dictionary['Ideas for you']);
  });
  await check('exact suggestion shape cannot bypass protected Yours pane on /new',async()=>{
    await navigate('/new');
    await evaluate(`document.getElementById('stock-fixture').id='customize-pane'`);
    await frame();await assertSuggestions(false);
  });
  await check('no observer feedback loop, page errors or external page requests',async()=>{
    await navigate('/cowork/agent');await frame();
    const before=await evaluate('tw.stats().flushes',true);await delay(1100);
    assert.equal(await evaluate('tw.stats().flushes',true),before);
    assert.deepEqual(blockedRequests,[]);
    assert.deepEqual(events.filter(e=>e.method==='Runtime.exceptionThrown'||
      (e.method==='Log.entryAdded'&&['error','warning'].includes(e.params.entry.level))),[]);
  });
  await check('translator and all three source dictionaries unchanged during test',async()=>{
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,'claude-tw/translator.js'))).digest('hex'),sourceSha256);
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,'claude-tw/web-overrides.json'))).digest('hex'),webSha256);
    for(const [name,hash] of Object.entries(dictionaryHashes))
      assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,'claude-tw',name))).digest('hex'),hash);
  });
  const receipt={pass:true,livePass:false,sourceSha256,webSha256,dictionaryHashes,
    fixtureSha256:createHash('sha256').update(shapeSource).digest('hex'),
    testSha256:createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex'),
    environment:'Headless Chromium / isolated world / disposable synthetic profile / loopback fixture only',
    checks,firstFrames,scopeBlocker:null,
    limitations:[fixture.syntheticOnly.unexpandedAnchor,
      'Actual link href was not captured; fixture href is synthetic.',
      'Captured ancestor chains are reproduced independently, not claimed to reconstruct the full page.',
      'Dispatch / Online / Chat with Cowork video pixels are excluded from DOM coverage.',
      'No App GUI, installed translation or live acceptance tested.'],
    stats:await evaluate('tw.stats()',true)};
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify({...receipt,evidence:path.relative(root,evidence)},null,2));
  await send('Browser.close').catch(()=>{});
} catch(error) {
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({pass:false,livePass:false,sourceSha256,webSha256,checks,error:String(error)},null,2)+'\n');
  console.error('Evidence:',path.relative(root,evidence));throw error;
} finally {
  for(const call of calls.values())clearTimeout(call.timer);
  ws?.close();
  if(chrome.exitCode===null){const exited=once(chrome,'exit');chrome.kill('SIGTERM');await exited.catch(()=>{});}
  server.close();fs.rmSync(profile,{recursive:true,force:true});
}
