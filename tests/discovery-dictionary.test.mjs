import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const dictionary=Object.assign({},...['native-overrides','web-overrides','overrides']
  .map(name=>JSON.parse(readFileSync(new URL(`../claude-tw/${name}.json`,import.meta.url),'utf8'))));

test('observed discovery controls and desktop settings have non-identity translations',()=>{
  for(const key of [
    'Skills','Yours','Discover','Show all','From Anthropic','Data',
    'New skills','Most installed skills','New plugins','Most installed plugins',
    'Curated by Anthropic','Top connectors','Trending connectors','New connectors',
    'Files & documents','Pipelines & jobs','Contacts & leads','Tickets & tasks',
    'Desktop app version','Design systems','Browser use','Connected browsers',
    'Automatically start Claude when you log in to your computer.',
    'Message Claude from anywhere on your desktop.',
    'Speak to Claude from anywhere on your desktop.',
    'Show Claude in the menu bar.'
  ]){
    assert.equal(typeof dictionary[key],'string',key);
    assert.notEqual(dictionary[key],key,key);
  }
  assert.equal(dictionary.Yours,'我的');
  assert.equal(dictionary.Skills,'技能');
  assert.equal(dictionary.System,'系統');
});

test('long public skill description is retained, not truncated into a new key',()=>{
  const keys=Object.keys(dictionary).filter(k=>k.startsWith('Use this skill when the user wants intellectual understanding'));
  assert.equal(keys.length,1);
  assert.equal(keys[0].length,969);
  assert.ok(keys[0].endsWith('("was X really as harsh as people say")'));
  assert.match(dictionary[keys[0]],/不適用情況/);
  assert.match(dictionary[keys[0]],/嚴苛/);
});

test('brand names and skill identifiers are not translated as public directory titles',()=>{
  for(const key of ['Render','Amazon Selling Partner','Pendo Orchestrate','Postiz',
    'learn','doc-coauthoring','web-artifacts-builder','Google Drive','Gmail','Figma']){
    if(Object.hasOwn(dictionary,key))assert.equal(dictionary[key],key,key);
  }
});
