#!/usr/bin/env node
// Builds an ASAR candidate only. Never writes /Applications, signs, quits or kills apps.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as asar from '@electron/asar';
import {rewriteAsar,sha} from './asar-rewrite.mjs';
import {applyNativePatches,extraDescriptors} from './native-patches.mjs';
export const BASELINE='27510f3e7bf8e9a4c9ff09bab6268fd4d8893413841cec3682e81f64f73f5028';
export function patchSources(main,preload,bridge,translator,preloadTemplate,assets,nativeFormat,nativeDescriptors) {
  for (const [source,marker] of [[main,'CLAUDE_TW_MAIN_INJECT_V1'],[preload,'CLAUDE_TW_PRELOAD_V1']]) {
    if ((source.match(new RegExp('/\\* '+marker+' START \\*/','g'))||[]).length!==1) throw new Error('Legacy patch boundary mismatch: '+marker);
  }
  main=main.replace(/\/\* CLAUDE_TW_MAIN_INJECT_V1 START \*\/[\s\S]*?\/\* CLAUDE_TW_MAIN_INJECT_V1 END \*\//,'');
  preload=preload.replace(/\/\* CLAUDE_TW_PRELOAD_V1 START \*\/[\s\S]*?\/\* CLAUDE_TW_PRELOAD_V1 END \*\//,'');
  if (/CLAUDE_TW_(MAIN_INJECT|PRELOAD)_V1/.test(main+preload)) throw new Error('Legacy markers were not completely removed');
  const needle='function D3e(e){return le=new aA.WebContentsView(e),A_(le.webContents,Oh.CLAUDE_AI_WEB),le}';
  if(main.split(needle).length!==2) throw new Error('Main view creation boundary changed; review this app version');
  main=main.replace(needle,'function D3e(e){le=new aA.WebContentsView(e);A_(le.webContents,Oh.CLAUDE_AI_WEB);try{require("./claudetw-main.cjs").attach(le.webContents,async()=>{aA.Menu.setApplicationMenu(await eiA());if(qV&&rL)qV.next(rL)})}catch{console.error("[claude-tw] bridge unavailable")}return le}');
  const cleanTranslator=translator.replace(/^if \(typeof module.*$/m,'');
  preload+='\n/* CLAUDE_TW_PRELOAD_V2 START */\n'+preloadTemplate.replace('/* TRANSLATOR_SOURCE */',()=>cleanTranslator)+'\n/* CLAUDE_TW_PRELOAD_V2 END */\n';
  const result = {'.vite/build/index.js':main,'.vite/build/mainView.js':preload,'.vite/build/claudetw-main.cjs':bridge};
  if (typeof assets === 'string') result['.vite/build/claudetw-assets.cjs'] = assets;
  if (typeof nativeFormat === 'string' && typeof nativeDescriptors === 'string') {
    const factory='function Ee(){return C9e(),rL}';
    if(main.split(factory).length!==2)throw new Error('Native Intl boundary changed; review this app version');
    main=main.replace(factory,
      'function Ee(){C9e();try{return require("./claudetw-main.cjs").nativeIntl(rL,a9e)}catch{return rL}}');
    for(const [before,after] of [
      ['getInitialLocale(){const t=Ee();return{messages:t.messages,locale:t.locale}}',
       'getInitialLocale(){const t=Ee();try{return require("./claudetw-main.cjs").nativeLocale(t)}catch{return{messages:t.messages,locale:t.locale}}}'],
      ['(i=cde.getDispatcher(e))==null||i.dispatchLocaleChanged(t.locale,t.messages)',
       '(i=cde.getDispatcher(e))==null||(()=>{let n={locale:t.locale,messages:t.messages};try{n=require("./claudetw-main.cjs").nativeLocale(t)}catch{}i.dispatchLocaleChanged(n.locale,n.messages)})()']
    ]){
      if(main.split(before).length!==2)throw new Error('Native locale output boundary changed');
      main=main.replace(before,()=>after);
    }
    result['.vite/build/index.js']=applyNativePatches(main);
    result['.vite/build/claudetw-native-format.cjs']=nativeFormat;
    result['.vite/build/claudetw-native-descriptors.json']=JSON.stringify({...JSON.parse(nativeDescriptors),...extraDescriptors});
  }
  return result;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [input,output]=process.argv.slice(2);
  if(!input||!output)throw new Error('Usage: node scripts/patch-asar.mjs INPUT_ASAR NEW_OUTPUT_ASAR');
  if(sha(fs.readFileSync(input))!==BASELINE)throw new Error('Unreviewed input app hash; refusing patch');
  if(path.resolve(output).startsWith('/Applications/'))throw new Error('Never patch a live application');
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), read=name=>fs.readFileSync(path.join(root,'claude-tw',name),'utf8');
  const result=rewriteAsar(input,output,patchSources(asar.extractFile(input,'.vite/build/index.js').toString(),asar.extractFile(input,'.vite/build/mainView.js').toString(),read('main-bridge.cjs'),read('translator.js'),read('preload-bridge.js'),read('assets.cjs'),read('native-format.cjs'),read('native-descriptors.json')));
  console.log(JSON.stringify(result,null,2));
}
