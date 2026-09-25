// Real Chromium / isolated world; sanitized stock captures + synthetic negatives.
// No App/profile/GUI access. Browser plugin not available; existing CDP harness.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const evidence=fs.mkdtempSync(path.join(root,'evidence/settings-browser-'));
const profile=fs.mkdtempSync(path.join(evidence,'synthetic-profile-'));
const source=fs.readFileSync(path.join(root,'claude-tw/translator.js'),'utf8');
const sourceSha256=createHash('sha256').update(source).digest('hex');
const shapeSource=fs.readFileSync(path.join(root,'tests/fixtures/public/settings-stock.json'),'utf8');
const fixture=JSON.parse(shapeSource);
const dictionary=Object.assign({},...['native-overrides.json','web-overrides.json','overrides.json'].map(n=>JSON.parse(fs.readFileSync(path.join(root,'claude-tw',n)))));
assert.equal(Object.hasOwn(dictionary,'and'),false,'No global conjunction dictionary');
// Build only captured structures; deliberately synthetic ids aid assertions.
function buildSettings(page,fixture) {
  const data=n=>fixture[n].data;
  const node=shape=>{
    const el=document.createElement(shape.tag||'div');el.className=shape.cls||'';
    if(shape.role)el.setAttribute('role',shape.role);
    if(shape.test)el.setAttribute('data-testid',shape.test);
    if(shape.pathname)el.setAttribute('href',shape.pathname);
    return el;
  };
  const children=(el,items)=>{for(const item of items){
    if(!item.tag)el.append(document.createTextNode(item.text));
    else {const child=node(item);child.append(document.createTextNode(item.text||''));el.append(child);}
  }};
  const chain=(shapes,id,items)=>{
    const leaf=node(shapes[0]);if(id)leaf.id=id;if(items)children(leaf,items);
    let outer=leaf;for(const shape of shapes.slice(1)){const p=node(shape);p.append(outer);outer=p;}
    return {leaf,outer};
  };
  const memory=page==='memory';
  const full=memory?data('settings-memory-stock-valid.txt'):data(`settings-resume-${page}-fragments-valid.txt`);
  const target=memory?full.rows[0]:full.targets[0];
  const sectionIndex=target.ancestors.findIndex(a=>a.tag==='SECTION');
  const rootShape=target.ancestors[sectionIndex+1],scrollShape=target.ancestors[sectionIndex+2];
  const dialog=document.createElement('div');dialog.id='settings';dialog.setAttribute('role','dialog');
  const nav=document.createElement('nav');nav.id='settings-nav';
  const ul=document.createElement('ul');nav.append(ul);
  for(const [test,label] of [['general-settings','General'],['data-privacy-controls','Privacy'],['memory-settings','Memory'],[null,'Capabilities']]){
    const li=document.createElement('li');if(test)li.setAttribute('data-testid',test);
    const b=document.createElement('button');b.id=`nav-${label.toLowerCase()}`;
    if(label==='Capabilities'){
      const captured=data('settings-capabilities-nav-leaves.txt').selected[0];b.className=captured.cls;
      for(const shape of captured.children){const child=node(shape);if(shape.hidden)child.setAttribute('aria-hidden',shape.hidden);child.append(document.createTextNode(shape.text));b.append(child);}
    }else b.append(document.createTextNode(label));
    if(label.toLowerCase()===page)b.setAttribute('aria-current','page');li.append(b);ul.append(li);
  }
  dialog.append(nav);
  const scroll=node(scrollShape),content=node(rootShape);scroll.id='scroll';content.id='content';scroll.append(content);dialog.append(scroll);
  const section=node(target.ancestors[sectionIndex]);section.id='stock-section';
  const group=node(target.ancestors[sectionIndex-1]);group.id='stock-group';section.append(group);content.append(section);
  const shapes=memory?full.rows:data(`resume-${page}-shapes.txt`).shapes.filter(s=>s.tag==='SPAN'&&s.cls.includes('settings-row-title'));
  const descriptions=memory?full.rows.map(r=>r.descriptions[0]):full.fragments.filter(f=>f.ancestors.some(a=>a.cls==='text-body text-muted'));
  let descriptionIndex=0;
  const specs=[];
  for(const [i,s] of shapes.entries()){
    const a=memory?s.ancestors:[s,...s.parents];
    const built=chain(a.slice(0,4),`title-${i}`,[{text:s.text}]);const row=built.outer;row.id=`row-${i}`;
    const hasDescription=memory||!['Export data','Shared chats','Shared artifacts','Uploaded files','Artifacts'].includes(s.text);
    if(hasDescription){
      const f=memory?descriptions[i]:descriptions[descriptionIndex++];
      const columnIndex=f.ancestors.findIndex(a=>a.cls==='flex min-w-0 flex-1 flex-col justify-center gap-1');
      const desc=chain(f.ancestors.slice(0,columnIndex),`prose-${i}`,f.children);
      built.leaf.parentElement.parentElement.append(desc.outer);
      specs.push({id:`prose-${i}`,children:f.children});
      [...desc.leaf.querySelectorAll('a')].forEach((a,j)=>a.id=`help-${i}-${j}`);
    }
    if(s.text==='Help improve our AI models'){
      const f=descriptions[1],relative=node(f.ancestors[5]);relative.append(row);group.append(relative);
    }else group.append(row);
    specs.push({id:`title-${i}`,children:[{text:s.text}]});
    if(s.text==='Tool access mode'){
      const f=full.fragments.find(f=>f.children[0].text==='Load tools when needed');
      const idx=f.ancestors.findIndex(a=>a.role==='group');const c=chain(f.ancestors.slice(0,idx),'action',f.children);row.append(c.outer);
      specs.push({id:'action',children:f.children});
    }
    if(s.text==='Import memory from other AI providers'||s.text==='Export data'){
      const f=(memory?data('settings-resume-memory-shapes-valid.txt'):data('resume-privacy-shapes.txt')).shapes.find(f=>f.text===(memory?'Start import':'Export data')&&f.tag==='SPAN'&&!f.cls.includes('settings-row-title'));
      if(f){const idx=f.parents.findIndex(a=>a.role==='group');const c=chain([f,...f.parents.slice(0,idx)],'action',[{text:f.text}]);row.append(c.outer);specs.push({id:'action',children:[{text:f.text}]});}
    }
  }
  if(page==='privacy'){
    const intro=full.fragments[0];const c=chain(intro.ancestors.slice(0,3),'intro',intro.children);content.prepend(c.outer);specs.push({id:'intro',children:intro.children});
    for(const name of ['How we protect your data','How we use your data']){
      const s=data('resume-privacy-shapes.txt').shapes.find(s=>s.text===name);const c=chain([s,...s.parents],`accordion-${name.includes('protect')?'protect':'use'}`,[{text:name}]);content.insertBefore(c.outer,section);specs.push({id:c.leaf.id,children:[{text:name}]});
    }
  }
  const heading=memory?null:data(`resume-${page}-shapes.txt`).shapes.find(s=>s.tag==='H3');
  if(heading){const c=chain([heading,...heading.parents.slice(0,2)],'section-heading',[{text:heading.text}]);section.prepend(c.outer);specs.push({id:'section-heading',children:[{text:heading.text}]});}
  if(memory){
    // memory-stock-heading-ascii-valid capture: one Text, direct root H2.
    // Live text is 記憶; English here exercises the existing Memory dictionary key.
    const h=document.createElement('h2');h.id='memory-heading';
    h.className='mb-md flex shrink-0 items-center gap-2 pl-md pt-1 text-heading-semibold text-primary';
    h.textContent='Memory';content.prepend(h);specs.push({id:h.id,children:[{text:'Memory'}]});
  }
  if(memory&&new URLSearchParams(location.search).has('unknown-memory')){
    // Deliberately unknown BEFORE the first observer delivery, not a recognized
    // root that changes class later. All text here is synthetic dictionary bait.
    content.className='synthetic-unknown-memory-root';
    const trap=document.createElement('p');trap.id='initial-private-prose';
    trap.textContent='Let Claude take screenshots and control your keyboard and mouse in apps you allow.';
    const sibling=document.createElement('section');sibling.id='initial-private-sibling';
    const control=document.createElement('button');control.id='initial-private-control';control.textContent='Cancel';control.title='Cancel';
    content.append(trap);sibling.append(control);scroll.append(sibling);
    // Both actual nav and content have overflow-y-auto scroll containers.
    const navScroll=document.createElement('div');navScroll.className='overflow-y-auto';navScroll.append(ul);nav.append(navScroll);
    const aside=document.createElement('aside');aside.innerHTML='<div class="overflow-y-auto"><button id="aside-control">Cancel</button></div>';dialog.append(aside);
  }
  document.body.replaceChildren(dialog);
  const outside=document.createElement('div');outside.id='outside';document.body.append(outside);
  window.specs=specs;window.stockPage=page;
  return specs;
}
const html=page=>`<!doctype html><html><head><meta charset="utf-8"><title>ClaudeTW settings fixture</title></head><body><script>(${buildSettings.toString()})(${JSON.stringify(page)},${JSON.stringify(fixture)});requestAnimationFrame(()=>{window.firstFrame=document.querySelector('#title-0').textContent;window.memoryHeadingFirstFrame=document.getElementById('memory-heading')?.textContent;window.memoryFirstFrame=['initial-private-prose','initial-private-control'].map(id=>document.getElementById(id)?.textContent);});</script></body></html>`;
const server=http.createServer((req,res)=>{const page=new URL(req.url,'http://fixture').searchParams.get('page')||'privacy';res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html(page));});
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
  await send('Page.addScriptToEvaluateOnNewDocument',{worldName:'claudetw-settings-test',source:`${source}
    const opts=new URLSearchParams(location.search);
    if(opts.has('no-navigation'))Object.defineProperty(globalThis,'navigation',{value:undefined,configurable:true});
    globalThis.cfg={schema:2,enabled:!opts.has('disabled'),compatible:!opts.has('incompatible'),
      revision:'fixture',dictionary:opts.has('empty')?{}:${JSON.stringify(dictionary)}};
    globalThis.tw=installClaudeTW({bootstrap:()=>cfg,refresh:async()=>cfg,report:r=>globalThis.lastReport=r});`});
  async function navigate(route='/epitaxy') {
    const start=events.length;await send('Page.navigate',{url:origin+route});contextId=null;
    for(let i=0;i<100;i++) {
      contextId=events.slice(start).find(e=>e.method==='Runtime.executionContextCreated'&&e.params.context.name==='claudetw-settings-test')?.params.context.id;
      if(contextId&&await evaluate('!!document.getElementById("title-0")',true))break;
      await delay(30);
    }
    assert.ok(contextId,'Isolated world');await frame();
    assert.equal(await evaluate('location.href'),origin+route);
    assert.equal(await evaluate('document.title'),'ClaudeTW settings fixture');
  }
  const load=page=>navigate(`/epitaxy?page=${page}`);
  const run=async code=>{await evaluate(code);await frame();};
  const target=s=>dictionary[s.trim()]||s.trim();
  const expectedChildren=(items,translated)=>items.map(c=>{
    if(!translated)return c.text;
    const key=c.text.trim();
    // No silent pass from a missing stock dictionary entry. Punctuation and
    // the raw capture's aggregate nested-link text are intentionally preserved.
    if(key&&!['and','.','Learn more(opens in new tab)'].includes(key))assert.ok(Object.hasOwn(dictionary,key),`Missing stock dictionary key: ${key}`);
    const value=key==='and'?'與':target(c.text);
    return c.text.replace(/\S(?:[\s\S]*\S)?/,value);
  }).join('');
  async function assertPage(translated=true) {
    for(const spec of await evaluate('specs'))await assertText(spec.id,expectedChildren(spec.children,translated));
  }
  await check('Memory stock H2 exact direct-root shape translates before first frame; private sibling headings stay original',async()=>{
    await load('memory');await assertText('memory-heading',dictionary.Memory);
    assert.equal(await evaluate('memoryHeadingFirstFrame'),dictionary.Memory);
    await run(`const h=document.getElementById('memory-heading');window.originalMemoryHeading=h;window.originalMemoryText=h.firstChild;const root=document.getElementById('content');for(const [id,nested,privateMarker] of [['plain-private-heading',false,false],['nested-private-heading',true,false],['marked-private-heading',false,true]]){const clone=h.cloneNode(true);clone.id=id;clone.textContent='Memory';if(privateMarker)clone.setAttribute('data-claude-tw-private','');if(nested){const wrapper=document.createElement('div');wrapper.append(clone);root.append(wrapper);}else{if(!privateMarker)clone.className='';root.append(clone);}}h.title='Memory'`);
    for(const id of ['plain-private-heading','nested-private-heading','marked-private-heading'])await assertText(id,'Memory');
    assert.equal(await evaluate(`document.getElementById('memory-heading').title`),'Memory');
    assert.equal(await evaluate(`originalMemoryHeading===document.getElementById('memory-heading')&&originalMemoryText===originalMemoryHeading.firstChild`),true);
    await assertText('nav-memory',dictionary.Memory);
  });
  await check('Memory H2 duplicate exact candidates fail closed; wrong tag/class, nesting and navigation loss restore owned text',async()=>{
    await load('memory');
    await run(`const clone=document.getElementById('memory-heading').cloneNode(true);clone.id='ambiguous-heading';clone.textContent='Memory';document.getElementById('content').append(clone)`);
    await assertText('memory-heading','Memory');await assertText('ambiguous-heading','Memory');
    await run(`document.getElementById('ambiguous-heading').remove()`);await assertText('memory-heading',dictionary.Memory);
    for(const code of [
      `document.getElementById('memory-heading').classList.add('unobserved')`,
      `document.getElementById('memory-heading').append(document.createTextNode(''))`,
      `const h=document.getElementById('memory-heading');const wrapper=document.createElement('div');h.replaceWith(wrapper);wrapper.append(h)`,
      `document.getElementById('nav-memory').removeAttribute('aria-current')`,
    ]){await load('memory');await run(code);await assertText('memory-heading','Memory');}
    await load('memory');
    await run(`const h=document.getElementById('memory-heading');const wrong=document.createElement('h3');wrong.id=h.id;wrong.className=h.className;wrong.textContent='Memory';h.replaceWith(wrong)`);
    await assertText('memory-heading','Memory');
    await load('memory');
    await run(`document.getElementById('memory-heading').firstChild.nodeValue='Synthetic custom heading'`);
    await assertText('memory-heading','Synthetic custom heading');
    await load('memory');
    await run(`document.getElementById('memory-heading').firstChild.nodeValue=${JSON.stringify(dictionary.Memory)};document.getElementById('nav-memory').removeAttribute('aria-current')`);
    await assertText('memory-heading',dictionary.Memory); // framework-owned Chinese is not English-restored
  });
  await check('initial unknown Memory roots: every same-dialog scroll child protected before first frame, stock still closed',async()=>{
    const prose='Let Claude take screenshots and control your keyboard and mouse in apps you allow.';
    assert.ok(dictionary[prose]&&dictionary[prose]!==prose);assert.ok(dictionary.Cancel&&dictionary.Cancel!=='Cancel');
    await navigate('/epitaxy?page=memory&unknown-memory');
    await assertPage(false);await assertText('initial-private-prose',prose);await assertText('initial-private-control','Cancel');
    assert.equal(await evaluate(`document.getElementById('initial-private-control').title`),'Cancel');
    assert.deepEqual(await evaluate('memoryFirstFrame'),[prose,'Cancel']);
    await assertText('nav-general',dictionary.General);
    await assertText('nav-memory',dictionary.Memory);await assertText('aside-control',dictionary.Cancel);
    await run(`document.getElementById('nav-general').firstChild.nodeValue='General'`);await assertText('nav-general',dictionary.General);
    await run(`document.getElementById('outside').innerHTML='<div role="dialog"><div class="overflow-y-auto"><button id="other-dialog-control">Cancel</button></div></div>'`);
    await assertText('other-dialog-control',dictionary.Cancel);
    await run(`document.getElementById('content').className='another-unknown-root';document.getElementById('nav-memory').removeAttribute('aria-current');document.getElementById('nav-privacy').setAttribute('aria-current','page')`);
    await assertText('initial-private-prose',prose);await assertText('initial-private-control','Cancel');await assertPage(false);
    await run(`document.getElementById('nav-privacy').removeAttribute('aria-current');document.getElementById('nav-memory').setAttribute('aria-current','page');document.getElementById('initial-private-sibling').innerHTML='<button id="replacement-private-control">Cancel</button>'`);
    await assertText('replacement-private-control','Cancel');
    await run(`const fresh=document.createElement('article');fresh.innerHTML='<button id="new-private-root">Cancel</button>';document.getElementById('scroll').append(fresh)`);
    await assertText('new-private-root','Cancel');
  });
  await check('Memory nav/root race: new protection rescans generic owned text/attrs; exact stock proof still required',async()=>{
    const prose='Let Claude take screenshots and control your keyboard and mouse in apps you allow.';
    await load('privacy');
    await run(`const root=document.createElement('div');root.id='racing-root';root.className='unverified';const p=document.createElement('p');p.id='racing-prose';p.textContent=${JSON.stringify(prose)};const b=document.createElement('button');b.id='racing-control';b.textContent='Cancel';b.title='Cancel';root.append(p,b);document.getElementById('scroll').append(root)`);
    await assertText('racing-prose',dictionary[prose]);await assertText('racing-control',dictionary.Cancel);
    await run(`document.getElementById('nav-privacy').removeAttribute('aria-current');document.getElementById('nav-memory').setAttribute('aria-current','page')`);
    await assertText('racing-prose',prose);await assertText('racing-control','Cancel');
    assert.equal(await evaluate(`document.getElementById('racing-control').title`),'Cancel');await assertPage(false);
    await run(`document.getElementById('racing-root').className='changed';document.getElementById('nav-memory').removeAttribute('aria-current')`);
    await assertText('racing-prose',prose);await assertText('racing-control','Cancel');
    await navigate('/epitaxy?page=memory&unknown-memory');
    const memoryClass=fixture['settings-memory-stock-valid.txt'].data.rows[0].ancestors[6].cls;
    await run(`document.getElementById('content').className=${JSON.stringify(memoryClass)}`);
    await assertPage();await assertText('initial-private-prose',prose);await assertText('initial-private-control','Cancel');
  });
  await check('owned stock Text added then detached in one batch cannot crash scan or skip later nodes',async()=>{
    for(const [page,raw] of [['privacy','Location metadata'],['memory','Search and reference chats'],['capabilities','Tool access mode']]){
      await load(page);await assertText('title-0',dictionary[raw]);const start=events.length;
      await run(`window.detachedStock=document.getElementById('title-0').firstChild;const outside=document.getElementById('outside');outside.append(detachedStock);detachedStock.remove();const next=document.createElement('button');next.id='same-batch-next';next.textContent='Cancel';outside.append(next)`);
      assert.deepEqual(events.slice(start).filter(e=>e.method==='Runtime.exceptionThrown'),[]);
      assert.equal(await evaluate('detachedStock.parentElement'),null);
      assert.equal(await evaluate('detachedStock.nodeValue'),raw);await assertText('same-batch-next',dictionary.Cancel);
    }
  });
  await check('Privacy captured seven leaves, labels, prose, links, headings and actions translate before first frame',async()=>{
    await load('privacy');await assertPage();
    assert.equal(await evaluate('firstFrame'),dictionary['Location metadata']);
    assert.equal(await evaluate(`document.getElementById('intro').childNodes.length`),7);
    assert.deepEqual(await evaluate(`Array.from(document.getElementById('intro').querySelectorAll('a'),a=>a.getAttribute('href'))`),['/','/legal/privacy']);
    assert.equal(await evaluate(`document.getElementById('intro').childNodes[1].nodeValue`),'. ');
  });
  await check('local conjunction only in exact introduction, no global and translation',async()=>{
    await run(`document.getElementById('outside').innerHTML='<button id="and">and</button>'`);await assertText('and','and');
    await run(`document.getElementById('intro').childNodes[1].nodeValue='! '`);
    await assertText('title-0','Location metadata');
    assert.equal(await evaluate(`document.getElementById('intro').childNodes[4].nodeValue`),' and ');
    await run(`document.getElementById('intro').childNodes[1].nodeValue='. '`);await assertPage();
  });
  await check('Capabilities captured selected nav leaves authorize all six stock rows/prose/combobox and Visuals',async()=>{
    await load('capabilities');await assertPage();
    assert.equal(await evaluate('firstFrame'),dictionary['Tool access mode']);
    assert.equal(await evaluate(`document.getElementById('nav-capabilities').firstChild.textContent`),'');
    await run(`document.getElementById('nav-capabilities').lastChild.firstChild.nodeValue='Capabilities'`);await assertPage();
  });
  await check('Capabilities exact nav child gate: no aggregate glyph stripping, wrong shape/role/hidden/duplicate selection rejected',async()=>{
    for(const code of [
      `document.getElementById('nav-capabilities').textContent='能力'`,
      `document.getElementById('nav-capabilities').lastChild.className='unverified'`,
      `document.getElementById('nav-capabilities').lastChild.setAttribute('role','button')`,
      `document.getElementById('nav-capabilities').setAttribute('role','unknown')`,
      `document.getElementById('nav-capabilities').lastChild.setAttribute('aria-hidden','true')`,
      `document.getElementById('nav-capabilities').firstChild.removeAttribute('aria-hidden')`,
      `document.getElementById('nav-capabilities').lastChild.firstChild.nodeValue='Synthetic custom page'`,
      `document.getElementById('nav-capabilities').lastChild.append(document.createTextNode(''))`,
      `document.getElementById('nav-capabilities').parentElement.setAttribute('data-testid','unknown')`,
      `document.getElementById('nav-general').setAttribute('aria-current','page')`,
    ]){await load('capabilities');await run(code);await assertPage(false);}
  });
  await check('Capabilities stock sentinel + own row prose required; custom same-name/fake sibling and nested dialog cannot borrow',async()=>{
    await load('capabilities');
    await run(`document.getElementById('prose-1').firstChild.nodeValue='Synthetic custom value'`);await assertText('title-1','Connector search');
    await run(`document.getElementById('content').insertAdjacentHTML('beforeend','<button id="fake-cap">Switch models when a message is flagged</button><span id="fake-tools">Load tools when needed</span>')`);
    await assertText('fake-cap','Switch models when a message is flagged');await assertText('fake-tools','Load tools when needed');
    await run(`document.getElementById('row-0').remove()`);await assertText('title-2','Switch models when a message is flagged');
    await load('capabilities');
    await run(`const nested=document.createElement('div');nested.setAttribute('role','dialog');const content=document.getElementById('content');content.replaceWith(nested);nested.append(content)`);await assertPage(false);
    await load('capabilities');await run(`document.getElementById('content').setAttribute('data-testid','message')`);await assertPage(false);
  });
  await check('Memory four captured stock rows/descriptions and Start import; private sibling excluded',async()=>{
    await load('memory');await assertPage();
    const trap='An unrelated sufficiently long exact dictionary trap';
    await evaluate(`cfg={...cfg,revision:'traps',dictionary:{...cfg.dictionary,[${JSON.stringify(trap)}]:'不可翻譯'}};tw.update(cfg)`,true);
    await run(`const sibling=document.createElement('div');sibling.id='generated';sibling.innerHTML='<button id="generated-title">Search and reference chats</button><p id="generated-trap">${trap}</p><span id="generated-description">Allow Claude to generate memory from your chats.</span>';document.getElementById('content').append(sibling)`);
    await assertText('generated-title','Search and reference chats');await assertText('generated-trap',trap);
    await assertText('generated-description','Allow Claude to generate memory from your chats.');
    await run(`document.getElementById('content').className='unknown-memory-layout'`);
    await assertText('generated-trap',trap);await assertText('generated-title','Search and reference chats');
    await run(`document.getElementById('nav-memory').removeAttribute('aria-current')`);await assertText('generated-trap',trap);
  });
  await check('Memory Learn more preserves nested accessibility element identities (synthetic nested-shape challenge)',async()=>{
    await load('memory');
    await run(`const a=document.getElementById('help-1-0');a.replaceChildren(document.createTextNode('Learn more'));const sr=document.createElement('span');sr.className='sr-only';sr.textContent='(opens in new tab)';a.append(sr);window.kept=[a,a.firstChild,sr,sr.firstChild]`);
    await assertText('help-1-0',dictionary['Learn more']+'(opens in new tab)');
    assert.equal(await evaluate(`kept[0]===document.getElementById('help-1-0')&&kept[1]===kept[0].firstChild&&kept[2]===kept[0].lastChild&&kept[3]===kept[2].firstChild`),true);
    await run(`document.getElementById('nav-memory').removeAttribute('aria-current')`);
    await assertText('help-1-0','Learn more(opens in new tab)');
  });
  await check('scope loss and regain: nav, modal role, root shape and private/hidden markers restore all owned leaves',async()=>{
    for(const page of ['privacy','memory','capabilities'])for(const [id,attr,value] of [
      ['nav-'+page,'aria-current','false'],['settings','role','region'],['content','class','unverified'],
      ['content','data-claude-tw-private',''],['content','hidden',''],['settings-nav','aria-hidden','true']]) {
      await load(page);
      const before=await evaluate(`document.getElementById(${JSON.stringify(id)}).getAttribute(${JSON.stringify(attr)})`);
      await run(`document.getElementById(${JSON.stringify(id)}).setAttribute(${JSON.stringify(attr)},${JSON.stringify(value)})`);await assertPage(false);
      await run(before===null?`document.getElementById(${JSON.stringify(id)}).removeAttribute(${JSON.stringify(attr)})`:
        `document.getElementById(${JSON.stringify(id)}).setAttribute(${JSON.stringify(attr)},${JSON.stringify(before)})`);await assertPage();
    }
  });
  await check('selection-first races: stale other page cannot borrow selected nav; stock content arrival enables',async()=>{
    for(const [from,to] of [['privacy','memory'],['memory','privacy'],['privacy','capabilities'],['capabilities','privacy'],['memory','capabilities'],['capabilities','memory']]){
      await load(from);
      await run(`document.getElementById('nav-${from}').removeAttribute('aria-current');document.getElementById('nav-${to}').setAttribute('aria-current','page')`);await assertPage(false);
      await evaluate(`(${buildSettings.toString()})(${JSON.stringify(to)},${JSON.stringify(fixture)})`);await frame();await assertPage();
    }
    await load('memory');
    await run(`document.getElementById('prose-0').firstChild.nodeValue='Synthetic private content';document.getElementById('nav-memory').removeAttribute('aria-current')`);
    await run(`document.getElementById('nav-memory').setAttribute('aria-current','page')`);await assertText('title-0','Search and reference chats');
    await run(`document.getElementById('prose-0').firstChild.nodeValue='Allow Claude to search for relevant details in past chats. '`);await assertPage();
  });
  await check('nested dialogs and fake sibling labels/prose/actions cannot borrow nav or stock row authority',async()=>{
    for(const page of ['privacy','memory']){
      await load(page);
      await run(`const d=document.createElement('div');d.id='nested';d.setAttribute('role','dialog');const content=document.getElementById('content');document.getElementById('scroll').replaceWith(d);d.append(content);`);
      await assertPage(false);
      await load(page);
      await run(`const title=document.getElementById('title-0');const fake=document.createElement('div');fake.id='fake';fake.append(title.cloneNode(true));fake.firstChild.id='fake-title';fake.firstChild.textContent=stockPage==='privacy'?'Location metadata':'Search and reference chats';fake.innerHTML+='<button id="fake-action">Start import</button><p id="fake-prose">Allow Claude to generate memory from your chats.</p>';document.getElementById('content').append(fake)`);
      await assertText('fake-title',page==='privacy'?'Location metadata':'Search and reference chats');await assertText('fake-action','Start import');await assertText('fake-prose','Allow Claude to generate memory from your chats.');
      await run(`document.getElementById('title-1').firstChild.nodeValue='Synthetic custom row';`);
      await assertText('prose-1',page==='privacy'?'Allow the use of your chats and coding sessions to train and improve Anthropic AI models. Learn more.':'Allow Claude to generate memory from your chats. Learn more(opens in new tab)');
    }
  });
  await check('same-name custom row requires its own observed title/prose pair; no borrowing a sibling description',async()=>{
    await load('memory');
    await run(`document.getElementById('prose-1').firstChild.nodeValue='Synthetic private prose'`);
    await assertText('title-1','Generate memory from chats');await assertText('title-0',dictionary['Search and reference chats']);
    await run(`document.getElementById('prose-1').firstChild.nodeValue='Allow Claude to generate memory from your chats.'`);
    await assertText('title-1',dictionary['Generate memory from chats']);
    await run(`document.getElementById('stock-group').append(document.getElementById('prose-1'))`);await assertText('title-1','Generate memory from chats');
  });
  await check('chat/input/draft/dynamic links private first; stock attrs never translated',async()=>{
    for(const page of ['privacy','memory']){
      for(const [tag,attrs] of [['div','data-testid="message"'],['div','contenteditable="true"'],['a','href="/chat/synthetic"'],['pre',''],['div','data-session-id="synthetic"']]){
        await load(page);await run(`const wrap=document.createElement('${tag}');wrap.innerHTML='<${tag} ${attrs}></${tag}>';const holder=wrap.firstChild;const title=document.getElementById('title-0');document.getElementById('row-0').replaceWith(holder);holder.append(title);`);
        await assertText('title-0',page==='privacy'?'Location metadata':'Search and reference chats');
      }
      await load(page);await run(`document.getElementById('title-0').title=stockPage==='privacy'?'Location metadata':'Search and reference chats';document.getElementById('outside').innerHTML='<textarea id="draft">Generate memory from chats</textarea><input id="input" value="Location metadata">'`);
      assert.equal(await evaluate(`document.getElementById('title-0').title`),page==='privacy'?'Location metadata':'Search and reference chats');await assertText('draft','Generate memory from chats');
    }
  });
  await check('detached/moved rows restore, and same-task framework Chinese remains framework-owned',async()=>{
    await load('memory');await run(`window.saved=document.getElementById('row-1');saved.remove()`);
    assert.equal(await evaluate(`saved.querySelector('.settings-row-title').textContent`),'Generate memory from chats');
    await run(`document.getElementById('outside').append(saved)`);await assertText('title-1','Generate memory from chats');
    await load('privacy');await evaluate(`document.getElementById('title-0').firstChild.nodeValue=${JSON.stringify(dictionary['Location metadata'])};cfg={...cfg,enabled:false};tw.update(cfg)`,true);
    await assertText('title-0',dictionary['Location metadata']);await assertText('title-1','Help improve our AI models');
  });
  await check('disabled/incompatible and re-enabled lifecycle',async()=>{
    for(const page of ['privacy','memory','capabilities']){
      await load(page);await evaluate(`cfg={...cfg,enabled:false};tw.update(cfg)`,true);await assertPage(false);
      await evaluate(`cfg={...cfg,enabled:true};tw.update(cfg)`,true);await assertPage();
      await evaluate(`cfg={...cfg,compatible:false};tw.update(cfg)`,true);await assertPage(false);
    }
  });
  await check('Connected browsers exact desktop stock leaf only; custom names/attributes/nested dialogs excluded',async()=>{
    await load('privacy');
    const connected=fixture['settings-connected-ancestors-valid.txt'].data.targets[0];
    await run(`document.body.replaceChildren();const shapes=${JSON.stringify(connected.ancestors)};let leaf,outer;for(const shape of shapes){const n=document.createElement(shape.tag);n.className=shape.cls;if(shape.role)n.setAttribute('role',shape.role);if(!leaf){leaf=n;leaf.id='connected';n.textContent='Connected browsers';}else n.append(outer);outer=n;}document.body.append(outer);const main=leaf.closest('main');const desktop=document.createElement('section');desktop.id='general-desktop';main.prepend(desktop);window.connectedLeaf=leaf;window.desktopMarker=desktop;window.connectedMain=main;`);
    await assertText('connected',dictionary['Connected browsers']);
    await run(`const privateList=document.createElement('div');privateList.innerHTML='<span id="browser-name">Connected browsers</span><button id="browser-button">Connected browsers</button>';connectedLeaf.parentElement.append(privateList);connectedLeaf.title='Connected browsers';`);
    await assertText('browser-name','Connected browsers');await assertText('browser-button','Connected browsers');
    assert.equal(await evaluate('connectedLeaf.title'),'Connected browsers');
    await run(`desktopMarker.remove()`);await assertText('connected','Connected browsers');
    await run(`connectedMain.prepend(desktopMarker)`);await assertText('connected',dictionary['Connected browsers']);
    await run(`const nested=document.createElement('div');nested.setAttribute('role','dialog');const scroll=connectedMain.parentElement;scroll.replaceWith(nested);nested.append(scroll);`);
    // Marker inside the same nested dialog remains a valid independent desktop
    // context; moving only the marker outside must not authorize that dialog.
    await run(`document.body.append(desktopMarker)`);await assertText('connected','Connected browsers');
    await run(`connectedMain.prepend(desktopMarker)`);await assertText('connected',dictionary['Connected browsers']);
    for(const [attr,value] of [['class','other'],['data-testid','message'],['contenteditable','true']]){
      const old=await evaluate(`connectedLeaf.getAttribute(${JSON.stringify(attr)})`);
      await run(`connectedLeaf.setAttribute(${JSON.stringify(attr)},${JSON.stringify(value)})`);await assertText('connected','Connected browsers');
      await run(old===null?`connectedLeaf.removeAttribute(${JSON.stringify(attr)})`:`connectedLeaf.setAttribute(${JSON.stringify(attr)},${JSON.stringify(old)})`);await assertText('connected',dictionary['Connected browsers']);
    }
  });
  await check('no feedback loop/network/runtime errors; synthetic screenshot only',async()=>{
    await load('privacy');await frame();const before=await evaluate('tw.stats().flushes',true);await delay(1100);
    assert.equal(await evaluate('tw.stats().flushes',true),before);assert.deepEqual(blockedRequests,[]);
    assert.deepEqual(events.filter(e=>e.method==='Runtime.exceptionThrown'||(e.method==='Log.entryAdded'&&['error','warning'].includes(e.params.entry.level))),[]);
    const image=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,'settings.png'),Buffer.from(image.data,'base64'));
  });
  const receipt={pass:true,livePass:false,sourceSha256,dictionarySha256:createHash('sha256').update(JSON.stringify(dictionary)).digest('hex'),shapeSha256:createHash('sha256').update(shapeSource).digest('hex'),checks,environment:'Chromium headless / isolated world / synthetic-only profile'};
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({...receipt,evidence:path.relative(root,evidence)},null,2));
  await send('Browser.close').catch(()=>{});
} catch(error){
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({pass:false,livePass:false,sourceSha256,checks,error:String(error)},null,2));console.error('Evidence:',path.relative(root,evidence));throw error;
} finally {
  for(const call of calls.values())clearTimeout(call.timer);ws?.close();
  if(chrome.exitCode===null){const exited=once(chrome,'exit');chrome.kill('SIGTERM');await exited.catch(()=>{});}
  server.close();fs.rmSync(profile,{recursive:true,force:true});
}
