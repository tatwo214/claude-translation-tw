// Real installed Electron runtime in ONE disposable cloned bundle with a synthetic profile.
import fs from 'node:fs';import path from 'node:path';import * as asar from '@electron/asar';import {execFileSync,spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';import {sha} from '../scripts/asar-rewrite.mjs';
import {finished} from 'node:stream/promises';
const root=path.resolve(import.meta.dirname,'..'),runId=randomUUID();
const receipt=path.join(root,'evidence/electron-results.json'),runReceipt=path.join(root,'evidence',`electron-results-${runId}.json`);
const metadata={runId,startedAt:new Date().toISOString(),sourceHashes:{},installedVersion:null};
const sourceCache=new Map();
const read=name=>{
 const relative='claude-tw/'+name;
 if(!sourceCache.has(relative)){
  const bytes=fs.readFileSync(path.join(root,relative));
  metadata.sourceHashes[relative]=sha(bytes);sourceCache.set(relative,bytes.toString('utf8'));
 }
 return sourceCache.get(relative);
};
function atomicJSON(file,value){
 const pending=file+'.'+runId+'.tmp';let created=false,fd;
 try{
  fd=fs.openSync(pending,'wx');created=true;
  fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.closeSync(fd);fd=undefined;
  fs.renameSync(pending,file);
 }catch(error){
  if(fd!==undefined)try{fs.closeSync(fd);}catch(cleanupError){console.error('Receipt fd cleanup:',cleanupError);}
  if(created)try{fs.rmSync(pending,{force:true});}catch(cleanupError){console.error('Receipt cleanup:',cleanupError);}
  throw error;
 }
}
function publish(value){
 atomicJSON(runReceipt,value);
 atomicJSON(receipt,value);
}
let stage,child,closed,childClosed=false,childError,timeout,hardTimeout,timedOut=false,result,failure;
const logFDs=[],cleanupErrors=[];
const running=()=>child?.pid!==undefined&&!childClosed&&child.exitCode===null&&child.signalCode===null;
const signalOwned=signal=>{if(running())try{child.kill(signal);}catch(error){childError??=error;}};
async function waitForClose(ms){
 let timer;
 try{return await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]);}
 finally{clearTimeout(timer);}
}
try {
// Preserve evidence, then invalidate any previous pass before fallible setup.
try{fs.renameSync(receipt,path.join(root,'evidence',`electron-results-before-${runId}.json`));}
catch(error){if(error.code!=='ENOENT')throw error;}
publish({...metadata,status:'running',pass:false});
for(const relative of ['tests/electron.mjs','scripts/asar-rewrite.mjs']){
 metadata.sourceHashes[relative]=sha(fs.readFileSync(path.join(root,relative)));
}
metadata.installedVersion=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString','/Applications/Claude.app/Contents/Info.plist'],{encoding:'utf8'}).trim();
for(const name of ['native-overrides.json','web-overrides.json','overrides.json','assets.cjs','main-bridge.cjs','preload-bridge.js','translator.js'])read(name);
publish({...metadata,status:'running',pass:false});
stage=fs.mkdtempSync(path.join(root,'staging/electron-test-'));
const app=path.join(stage,'CTW Harness.app'),src=path.join(stage,'src'),runtime=path.join(stage,'runtime'),resultPath=path.join(stage,'result.json'),home=path.join(stage,'home');
for(const dir of [src,runtime,home,path.join(stage,'profile')])fs.mkdirSync(dir);
const dictionary=Object.assign({},...['native-overrides.json','web-overrides.json','overrides.json'].map(n=>JSON.parse(read(n))));
const runtimeNeedle="path.join(os.homedir(),'.local/share/claude-tw')",bridgeSource=read('main-bridge.cjs');
if(bridgeSource.split(runtimeNeedle).length!==2)throw new Error('Bridge runtime isolation needle must occur exactly once');
const bridge=bridgeSource.replace(runtimeNeedle,()=>JSON.stringify(runtime)).replace("['https://claude.ai','https://claude.com']", "['null']");
if(/os\s*\.\s*homedir\s*\(/.test(bridge)||bridge.includes('.local/share/claude-tw'))throw new Error('Bridge still references real HOME/runtime');
fs.writeFileSync(path.join(src,'package.json'),JSON.stringify({name:'ctw-harness',version:'2.0.0',main:'main.cjs'}));
fs.writeFileSync(path.join(src,'claudetw-assets.cjs'),read('assets.cjs'));
fs.writeFileSync(path.join(src,'bridge.cjs'),bridge);
fs.writeFileSync(path.join(src,'preload.cjs'),read('preload-bridge.js').replace("['https://claude.ai','https://claude.com']","['null']").replace('/* TRANSLATOR_SOURCE */',()=>read('translator.js').replace(/^if \(typeof module.*$/m,'')));
const html=`<!doctype html><meta charset="utf-8"><button id="first">New session</button><div data-testid="message" id="private">Save</div><script>requestAnimationFrame(()=>{window.firstFrame=document.querySelector('#first').textContent})</script>`;
fs.writeFileSync(path.join(src,'main.cjs'),`
const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
app.setPath('userData',${JSON.stringify(path.join(stage,'profile'))});app.setName('CTW synthetic test');
process.on('unhandledRejection',e=>{fs.writeFileSync(${JSON.stringify(path.join(stage,'error.txt'))},String(e.stack));app.exit(1)});
process.on('uncaughtException',e=>{fs.writeFileSync(${JSON.stringify(path.join(stage,'error.txt'))},String(e.stack));app.exit(1)});
app.whenReady().then(async()=>{
const appHash=crypto.createHash('sha256').update(require('original-fs').readFileSync(app.getAppPath())).digest('hex'), appVersion=app.getVersion();
const runtime=${JSON.stringify(runtime)}, dictionary=${JSON.stringify(dictionary)};
for(const [name,value] of Object.entries({'state.json':{enabled:true},'approved-app.json':{schema:2,appHash,appVersion},'snapshot.json':{schema:2,appHash,appVersion,revision:'a'.repeat(64),dictionary}}))fs.writeFileSync(path.join(runtime,name),JSON.stringify(value));

const w=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
w.webContents.on('console-message',(_e,_l,msg)=>fs.appendFileSync(${JSON.stringify(path.join(stage,'console.txt'))},msg+'\\n'));
require('./bridge.cjs').attach(w.webContents);
await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(${JSON.stringify(html)}));
await new Promise(r=>setTimeout(r,1500));
const result=await w.webContents.executeJavaScript('({firstFrame:window.firstFrame,current:document.querySelector("#first").textContent,private:document.querySelector("#private").textContent,exposed:typeof window.ipcRenderer})');
result.report=JSON.parse(fs.readFileSync(path.join(runtime,'renderer-report.json'),'utf8'));result.pass=result.firstFrame==='新增對話'&&result.current==='新增對話'&&result.private==='Save'&&result.exposed==='undefined';
result.runId=${JSON.stringify(runId)};
fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result,null,2));app.exit(result.pass?0:1);
});
`);
 execFileSync('/bin/cp',['-cR','/Applications/Claude.app',app]);
 const dest=path.join(app,'Contents/Resources/app.asar');await finished(await asar.createPackage(src,dest));
 const headerHash=sha(asar.getRawHeader(dest).headerString),info=path.join(app,'Contents/Info.plist');
 execFileSync('python3',['-c',`import plistlib,sys\np=sys.argv[1]\nd=plistlib.load(open(p,'rb'))\nd['CFBundleIdentifier']='org.local.claudetw-harness'\nfor k in ['CFBundleURLTypes','CFBundleDocumentTypes','NSUserActivityTypes','ElectronTeamID']:d.pop(k,None)\nd['ElectronAsarIntegrity']['Resources/app.asar']['hash']=sys.argv[2]\nplistlib.dump(d,open(p,'wb'),sort_keys=False)`,info,headerHash]);
 execFileSync('/usr/bin/codesign',['--force','--sign','-','--preserve-metadata=identifier,entitlements,flags,runtime',app],{stdio:'pipe'});
 // Chromium test-only mock keychain; never use the real account keychain/profile.
 for(const name of ['stdout.log','stderr.log'])logFDs.push(fs.openSync(path.join(stage,name),'w'));
 child=spawn(path.join(app,'Contents/MacOS/Claude'),['--use-mock-keychain','--disable-background-networking','--disable-component-update','--user-data-dir='+path.join(stage,'profile')],{env:{...process.env,HOME:home},stdio:['ignore',...logFDs]});
 closed=new Promise(resolve=>{
  child.on('error',error=>{childError??=error;});
  child.once('close',(code,signal)=>{childClosed=true;resolve({code,signal});});
 });
 timeout=setTimeout(()=>{timedOut=true;signalOwned('SIGTERM');},25000);
 // Only this owned disposable child; a blocked security service may ignore TERM.
 hardTimeout=setTimeout(()=>signalOwned('SIGKILL'),30000);
 const outcome=await waitForClose(35000);
 if(childError)throw childError;
 if(!outcome||timedOut||outcome.code!==0||!fs.existsSync(resultPath))throw new Error('Electron fixture failed ('+runId+'): '+JSON.stringify({outcome,timedOut}));
 result=JSON.parse(fs.readFileSync(resultPath,'utf8'));
 if(result?.pass!==true||result?.runId!==runId)throw new Error('Invalid Electron result/pass/runId: '+runId);
}catch(error){failure=error;}
finally{
 clearTimeout(timeout);clearTimeout(hardTimeout);
 // Even spawn errors get a close event; do not remove a live child's stage.
 if(child&&!childClosed){
  signalOwned('SIGTERM');await waitForClose(1000);
  if(!childClosed){signalOwned('SIGKILL');await waitForClose(5000);}
 }
 for(const fd of logFDs)try{fs.closeSync(fd);}catch(error){cleanupErrors.push(error);}
 if(stage){
  for(const f of ['error.txt','console.txt','stdout.log','stderr.log'])try{
   if(fs.existsSync(path.join(stage,f)))fs.copyFileSync(path.join(stage,f),path.join(root,'evidence',`electron-${runId}-${f}`));
  }catch(error){cleanupErrors.push(error);}
  if(!child||childClosed){
   try{fs.rmSync(stage,{recursive:true,force:true});}catch(error){cleanupErrors.push(error);}
  }else cleanupErrors.push(new Error('Child exit unconfirmed; retained stage: '+stage));
 }
}
for(const error of cleanupErrors)console.error('Electron cleanup:',error);
if(cleanupErrors.length)failure??=new AggregateError(cleanupErrors,'Electron cleanup failed');
// Both terminal states replace running; only a validated, cleaned-up run passes.
const finalReceipt={...result,...metadata,status:failure?'failed':'passed',pass:!failure,finishedAt:new Date().toISOString(),
 ...(failure?{error:String(failure.stack||failure)}:{}),
 ...(cleanupErrors.length?{cleanupErrors:cleanupErrors.map(error=>String(error.stack||error))}:{})};
try{
 publish(finalReceipt);
}catch(error){
 console.error('Electron receipt publication:',error);
 failure??=error;
 // If a terminal write failed, do not leave the per-run receipt claiming pass.
 try{publish({...finalReceipt,status:'failed',pass:false,error:String(failure.stack||failure)});}
 catch(receiptError){console.error('Failure receipt publication:',receiptError);}
}
if(failure)throw failure;
console.log(JSON.stringify(finalReceipt,null,2));
