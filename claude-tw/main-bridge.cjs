'use strict';
// Called ONLY for the pinned main WebContentsView, before loadURL/preload.
const {ipcMain,app} = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { assetList, mergeAssets } = require('./claudetw-assets.cjs');
const runtime = path.join(os.homedir(),'.local/share/claude-tw');
const allowed = new WeakSet();
const versions = {schema:2,appVersion:app.getVersion(),appHash:crypto.createHash('sha256').update(require('original-fs').readFileSync(app.getAppPath())).digest('hex')};
const readCache = new Map();
const read = (name,fallback={}) => {
  try {
    const p=path.join(runtime,name), stat=fs.statSync(p);
    if(stat.size>2000000){readCache.delete(name);return fallback;}
    // Atomic replacement changes inode; in-place writes change timestamps.
    // No metadata => no cache (also keeps limited test/mocked filesystems honest).
    const stamp=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs];
    const cacheable=stamp.every(Number.isFinite), key=stamp.join(':');
    const cached=readCache.get(name);
    if(cacheable && cached?.key===key)return cached.value;
    const value=JSON.parse(fs.readFileSync(p,'utf8'));
    if(cacheable)readCache.set(name,{key,value});
    return value;
  } catch {readCache.delete(name);return fallback;}
};
function write(name,data) {try {const p=path.join(runtime,name),tmp=p+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o600});fs.renameSync(tmp,p);}catch{}}
function valid(event) {
  if (!allowed.has(event.sender) || event.senderFrame !== event.sender.mainFrame) return false;
  try {return ['https://claude.ai','https://claude.com'].includes(new URL(event.senderFrame.url).origin);}catch{return false;}
}
function snapshot() {
  const saved = read('snapshot.json'), approved = read('approved-app.json'), state = read('state.json');
  const compatible = saved.schema===2 && approved.schema===2 && saved.appVersion===versions.appVersion && approved.appVersion===versions.appVersion && saved.appHash===versions.appHash && approved.appHash===versions.appHash;
  return {schema:2,enabled:state.enabled===true,compatible,revision:compatible?saved.revision:'',dictionary:compatible?saved.dictionary:{}};
}
ipcMain.on('claudetw:bootstrap:v2',(event)=>{event.returnValue = valid(event)?snapshot():{schema:2,enabled:false,compatible:false};});
ipcMain.handle('claudetw:refresh:v2',(event)=>valid(event)?snapshot():{schema:2,enabled:false,compatible:false});
let lastAssetReport = 0;
ipcMain.on('claudetw:assets:v2', (event, input) => {
  if (!valid(event) || Date.now() - lastAssetReport < 900) return;
  lastAssetReport = Date.now();
  const incoming = assetList(input);
  if (!incoming.length) return;
  const saved = read('asset-manifest.json');
  const previous = saved.schema === 1 && saved.appVersion === versions.appVersion &&
    saved.appHash === versions.appHash ? saved.assets : [];
  const assets = mergeAssets(previous, incoming);
  write('asset-manifest.json', {
    schema: 1, appVersion: versions.appVersion, appHash: versions.appHash,
    assets, observedAt: new Date().toISOString()
  });
});
let lastReport=0;
ipcMain.on('claudetw:report:v2',(event,report)=>{
  if(!valid(event)||Date.now()-lastReport<900||!report||typeof report!=='object')return;
  lastReport=Date.now();
  const number=(key,max=1000000)=>Number.isFinite(report[key])?Math.max(0,Math.min(max,report[key])):0;
  const saved=snapshot();
  write('renderer-report.json',{schema:2,appVersion:versions.appVersion,revision:saved.revision,reportedAt:new Date().toISOString(),unknownCount:number('unknownCount',500),mismatchCount:saved.compatible?number('mismatchCount',500):1,appliedCount:number('appliedCount'),flushCount:number('flushCount'),maxScanMs:number('maxScanMs',10000)});
  heartbeat();
});
const startedAt = new Date().toISOString();
let nativeRefresh = null, nativeState = null, refreshingNative = false;
function heartbeat(){
  write('patch-heartbeat.json',{...versions,pid:process.pid,startedAt,reportedAt:new Date().toISOString()});
  if(!nativeRefresh)return;
  const s=snapshot(), key=JSON.stringify([s.enabled,s.compatible,s.revision]);
  if(nativeState===null){nativeState=key;return;}
  if(key===nativeState || refreshingNative)return;
  nativeState=key;refreshingNative=true;
  Promise.resolve().then(nativeRefresh).catch(()=>{}).finally(()=>{refreshingNative=false;});
}
setInterval(heartbeat,2000).unref();
exports.attach = (contents,onNativeChange) => {
  allowed.add(contents);
  if(typeof onNativeChange==='function')nativeRefresh=onNativeChange;
  heartbeat();
};
exports.snapshot = snapshot;
exports.nativeIntl = (intl, createIntl) => {
  try {
    return require('./claudetw-native-format.cjs').wrapIntl(
      intl, createIntl, snapshot, require('./claudetw-native-descriptors.json')
    );
  } catch { return intl; }
};
let localeCache = null;
exports.nativeLocale = intl => {
  const original={locale:intl.locale,messages:intl.messages};
  try {
    const s=snapshot();
    if(!s.enabled || !s.compatible){localeCache=null;return original;}
    if(localeCache?.source===intl.messages && localeCache.locale===intl.locale &&
       localeCache.revision===s.revision)return localeCache.result;
    const descriptors=require('./claudetw-native-descriptors.json');
    const messages=Object.assign(Object.create(null),intl.messages);
    let count=0;
    for(const [id,source] of Object.entries(descriptors)){
      if(!Object.hasOwn(s.dictionary,source))continue;
      const target=s.dictionary[source];
      if(typeof target!=='string' || !target.trim() || target.length>1000)continue;
      messages[id]=target;count++;
    }
    // Return translated messages only. Changing the renderer locale could make
    // missing inline IDs generate new upstream MissingTranslation diagnostics.
    const result=count?{locale:intl.locale,messages}:original;
    localeCache={source:intl.messages,locale:intl.locale,revision:s.revision,result};
    return result;
  } catch {return original;}
};
