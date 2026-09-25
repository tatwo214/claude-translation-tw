import fs from 'node:fs';
import crypto from 'node:crypto';
import * as asar from '@electron/asar';
export const sha = data => crypto.createHash('sha256').update(data).digest('hex');
export function rewriteAsar(input, output, replacements) {
  if (input === output || fs.existsSync(output)) throw new Error('Output must be a fresh candidate, never the input');
  const raw = asar.getRawHeader(input), header = structuredClone(raw.header), original = fs.readFileSync(input);
  const start = 8 + raw.headerSize;
  for (const name of Object.keys(replacements)) {
    if (name.includes('..') || name.startsWith('/')) throw new Error('Invalid archive path');
    let parent=header; const parts=name.split('/');
    for (const part of parts.slice(0,-1)) parent=parent.files[part] ||= {files:{}};
    parent.files[parts.at(-1)] ||= {};
  }
  const chunks=[], hashes={};let offset=0;
  function walk(node,prefix='') {
    for(const [name,entry] of Object.entries(node.files)) {
      const key=prefix+name;
      if(entry.files){walk(entry,key+'/');continue;}
      if(entry.unpacked || entry.link) {if(Object.hasOwn(replacements,key))throw new Error('Cannot replace native/unpacked/link entry');continue;}
      const content = Object.hasOwn(replacements,key)?Buffer.from(replacements[key]):original.subarray(start+Number(entry.offset),start+Number(entry.offset)+entry.size);
      if(!Object.hasOwn(replacements,key) && content.length!==entry.size)throw new Error('Truncated source');
      hashes[key]=sha(content);entry.offset=String(offset);entry.size=content.length;
      if(Object.hasOwn(replacements,key)) {
        const blockSize=4194304,blocks=[];
        for(let i=0;i<content.length;i+=blockSize)blocks.push(sha(content.subarray(i,i+blockSize)));
        entry.integrity={algorithm:'SHA256',hash:hashes[key],blockSize,blocks};
      }
      offset+=content.length;chunks.push(content);
    }
  }
  walk(header);
  const text=Buffer.from(JSON.stringify(header)),payloadSize=Math.ceil((4+text.length)/4)*4;
  const prefix=Buffer.alloc(16);[4,4+payloadSize,payloadSize,text.length].forEach((n,i)=>prefix.writeUInt32LE(n,i*4));
  fs.writeFileSync(output,Buffer.concat([prefix,text,Buffer.alloc(payloadSize-4-text.length),...chunks]),{flag:'wx'});
  for(const [key,hash] of Object.entries(hashes))if(sha(asar.extractFile(output,key))!==hash)throw new Error('ASAR readback failed: '+key);
  return {hash:sha(fs.readFileSync(output)),headerHash:sha(text),verifiedEntries:Object.keys(hashes).length,changed:Object.keys(replacements)};
}
