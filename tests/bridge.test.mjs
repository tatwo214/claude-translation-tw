import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';import assets from '../claude-tw/assets.cjs';
const source=fs.readFileSync(new URL('../claude-tw/main-bridge.cjs',import.meta.url),'utf8');
function fixture(){
 const hash=crypto.createHash('sha256').update('test-asar').digest('hex');
 const files={'approved-app.json':{schema:2,appVersion:'1',appHash:hash},'snapshot.json':{schema:2,appVersion:'1',appHash:hash,revision:'a'.repeat(64),dictionary:{Save:'儲存'}},'state.json':{enabled:true}},handlers={},writes={};
 const mocks={'electron':{app:{getVersion:()=>'1',getAppPath:()=>'/app.asar'},ipcMain:{on:(c,f)=>handlers[c]=f,handle:(c,f)=>handlers[c]=f}},'node:fs':{statSync:()=>({size:100}),readFileSync:p=>p==='/app.asar'?Buffer.from('test-asar'):JSON.stringify(files[path.basename(p)]),writeFileSync:(p,data)=>writes[path.basename(p)]=JSON.parse(data),renameSync:()=>{}},'node:path':path,'node:os':{homedir:()=>'/tmp/test'},'node:crypto':crypto};
 mocks['original-fs']=mocks['node:fs'];
 mocks['./claudetw-assets.cjs']=assets;
 const context={require:name=>mocks[name],exports:{},process:{pid:42},setInterval:()=>({unref(){}}),URL,console};vm.runInNewContext(source,context);
 const frame={url:'https://claude.ai/code'},sender={mainFrame:frame};context.exports.attach(sender);
 const event={sender,senderFrame:frame};
 return {files,handlers,event,writes,exports:context.exports,mocks};
}
test('bootstrap local snapshot available synchronously',()=>{const f=fixture();f.handlers['claudetw:bootstrap:v2'](f.event);assert.equal(f.event.returnValue.enabled,true);assert.equal(f.event.returnValue.dictionary.Save,'儲存');});
test('bootstrap preserves long catalogue keys through snapshot IPC',()=>{
 for (const length of [969,2000]) {
  const f=fixture(),key='Public description '.padEnd(length,'x');
  f.files['snapshot.json'].dictionary[key]='完整公開介紹';
  f.handlers['claudetw:bootstrap:v2'](f.event);
  assert.equal(f.event.returnValue.compatible,true);
  assert.equal(f.event.returnValue.dictionary[key],'完整公開介紹');
  assert.equal(Object.keys(f.event.returnValue.dictionary).find(k=>k!== 'Save').length,length);
 }
});
test('reject subframes, other origins and unattached views',()=>{for(const alter of [f=>f.event.senderFrame={url:'https://claude.ai/code'},f=>f.event.senderFrame.url='https://evil.example',f=>f.event.sender={mainFrame:f.event.senderFrame}]){const f=fixture();alter(f);f.handlers['claudetw:bootstrap:v2'](f.event);assert.equal(f.event.returnValue.enabled,false);}});
test('hash/version mismatch yields no dictionary',()=>{const f=fixture();f.files['snapshot.json'].appHash='b'.repeat(64);f.handlers['claudetw:bootstrap:v2'](f.event);assert.equal(f.event.returnValue.compatible,false);assert.equal(Object.keys(f.event.returnValue.dictionary).length,0);});
test('renderer report cannot persist text/path or spoof revision',()=>{const f=fixture();f.handlers['claudetw:report:v2'](f.event,{unknownCount:999999,mismatchCount:0,private:'SECRET',revision:'evil',path:'/private'});const data=Object.values(f.writes).find(x=>x.unknownCount!==undefined);assert.equal(data.unknownCount,500);assert.equal(data.revision,'a'.repeat(64));assert(!JSON.stringify(f.writes).includes('SECRET'));assert(!JSON.stringify(f.writes).includes('/private'));});
test('asset index records only validated public JS resources, not account URLs',()=>{
 const f=fixture(), url='https://claude.ai/_next/static/chunks/page-123.js';
 f.handlers['claudetw:assets:v2'](f.event,[url,'https://claude.ai/api/private?token=SECRET','https://evil.example/_next/static/chunks/a.js']);
 const manifest=Object.values(f.writes).find(x=>x.assets);
 assert.deepEqual(manifest.assets,[url]);assert(!JSON.stringify(f.writes).includes('SECRET'));
});
test('unattached views cannot add UI assets',()=>{
 const f=fixture();f.event.sender={mainFrame:f.event.senderFrame};
 f.handlers['claudetw:assets:v2'](f.event,['https://claude.ai/_next/static/chunks/page.js']);
 assert(!Object.values(f.writes).some(x=>x.assets));
});
test('native snapshot cache invalidates on file identity changes and fails closed on read errors',()=>{
 const f=fixture(),stats={},reads={};
 const io=f.mocks['node:fs'],read=io.readFileSync;
 io.statSync=p=>{const n=path.basename(p);if(stats[n]===false)throw new Error('missing');return {dev:1,ino:stats[n]||1,size:100,mtimeMs:1,ctimeMs:1};};
 io.readFileSync=p=>{const n=path.basename(p);reads[n]=(reads[n]||0)+1;return read(p);};
 assert.equal(f.exports.snapshot().enabled,true);
 for(let i=0;i<100;i++)f.exports.snapshot();
 assert.equal(reads['snapshot.json'],1);
 f.files['state.json']={enabled:false};stats['state.json']=2;
 assert.equal(f.exports.snapshot().enabled,false);
 stats['approved-app.json']=false;
 assert.equal(f.exports.snapshot().compatible,false);
});
test('native renderer gets an independent approved catalog, never mutates shared Intl',()=>{
 const f=fixture();
 f.mocks['./claudetw-native-descriptors.json']={save:'Save',unknown:'Missing'};
 const messages=Object.freeze({save:'Save',private:'USER VALUE'});
 const intl={locale:'en-US',messages};
 const projected=f.exports.nativeLocale(intl);
 assert.equal(projected.locale,'en-US');
 assert.equal(projected.messages.save,'儲存');
 assert.equal(projected.messages.private,'USER VALUE');
 assert.equal(intl.locale,'en-US');assert.equal(messages.save,'Save');
 assert.equal(f.exports.nativeLocale(intl),projected);
 f.files['state.json'].enabled=false;
 const disabled=f.exports.nativeLocale(intl);
 assert.equal(disabled.locale,'en-US');assert.equal(disabled.messages,messages);
});
test('native menu refresh reacts once to revision change and not private renderer strings',async()=>{
 const f=fixture();let changes=0;
 f.exports.attach(f.event.sender,()=>{changes++;});
 f.files['snapshot.json'].revision='b'.repeat(64);
 f.handlers['claudetw:report:v2'](f.event,{unknownCount:0});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(changes,1);
 f.exports.attach(f.event.sender);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(changes,1);
});
