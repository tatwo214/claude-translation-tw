#!/usr/bin/env python3
"""Prepare ONE local candidate; no live app/runtime/process changes."""
from pathlib import Path
import hashlib,json,plistlib,subprocess
ROOT=Path(__file__).resolve().parent.parent
APP=Path('/Applications/Claude.app')
STAGE=ROOT/'staging'
CANDIDATE=STAGE/'Claude.app'
BASELINE='27510f3e7bf8e9a4c9ff09bab6268fd4d8893413841cec3682e81f64f73f5028'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def manifest(app):
 return {str(p.relative_to(app)):['link',str(p.readlink())] if p.is_symlink() else ['file',sha(p),p.stat().st_mode&0o777] for p in sorted(app.rglob('*')) if p.is_symlink() or p.is_file()}
def run(*args): return subprocess.run(args,check=True,capture_output=True,text=True).stdout
if CANDIDATE.exists(): raise SystemExit('Candidate already exists: do not accumulate copies or overwrite it')
if sha(APP/'Contents/Resources/app.asar')!=BASELINE: raise SystemExit('Installed app changed; stop and review')
record=json.loads((ROOT/'evidence/asar-build.json').read_text())
if sha(STAGE/'app.asar')!=record['hash']: raise SystemExit('ASAR receipt mismatch')
before=manifest(APP)
run('/bin/cp','-cR',str(APP),str(CANDIDATE))
if manifest(CANDIDATE)!=before: raise SystemExit('Clone differs')
(CANDIDATE/'Contents/Resources/app.asar').write_bytes((STAGE/'app.asar').read_bytes())
p=CANDIDATE/'Contents/Info.plist';info=plistlib.loads(p.read_bytes());info['ElectronAsarIntegrity']['Resources/app.asar']['hash']=record['headerHash'];p.write_bytes(plistlib.dumps(info,sort_keys=False))
run('/usr/bin/codesign','--force','--sign','-','--preserve-metadata=identifier,entitlements,flags,runtime',str(CANDIDATE))
run('/usr/bin/codesign','--verify','--deep','--strict',str(CANDIDATE))
after=manifest(CANDIDATE)
allow={'Contents/Resources/app.asar','Contents/Info.plist','Contents/_CodeSignature/CodeResources','Contents/MacOS/Claude'}
# Outer signature may change bytes in the main executable, but not code or entitlements.
changed=[k for k in before.keys()|after.keys() if before.get(k)!=after.get(k)]
if set(changed)-allow: raise SystemExit('Unexpected changed paths: '+str(set(changed)-allow))
for app in [APP,CANDIDATE]:
 ent=run('/usr/bin/codesign','-d','--entitlements',':-',str(app))
 if app==APP:original_ent=plistlib.loads(ent.encode())
 elif original_ent!=plistlib.loads(ent.encode()):raise SystemExit('Entitlements changed')
result={'candidate':str(CANDIDATE),'baseline':BASELINE,'asarHash':record['hash'],'headerHash':record['headerHash'],'appVersion':info['CFBundleShortVersionString'],'changedBundleEntries':changed,'unchangedBundleEntries':len(before)-len(changed),'nativeFrameworksUnchanged':True,'entitlementsUnchanged':True,'candidateManifest':after}
(ROOT/'evidence/candidate-receipt.json').write_text(json.dumps(result,indent=2))
print(json.dumps({k:v for k,v in result.items() if k!='candidateManifest'},indent=2))
