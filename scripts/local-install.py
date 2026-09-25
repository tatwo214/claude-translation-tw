#!/usr/bin/env python3
"""Install this reviewed candidate only when Claude & ClaudeTW are already closed.
Never closes/kills a process. Backups are verified before live mutation.
"""
from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess,tarfile,sys
ROOT=Path(__file__).resolve().parent.parent
APP=Path('/Applications/Claude.app');STAGE=ROOT/'staging';CANDIDATE=STAGE/'Claude.app'
RUNTIME=(Path.home()/'.local/share/claude-tw').resolve();HELPER=RUNTIME.parent/'ClaudeTW.app'
FILES=['translator.js','main-bridge.cjs','preload-bridge.js','index.mjs','overrides.json','native-overrides.json','web-overrides.json','native-format.cjs','native-descriptors.json','assets.cjs','update.mjs','wake.sh','serve.mjs']
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def run(*args):return subprocess.run(args,check=True,capture_output=True,text=True).stdout
def manifest(app):return {str(p.relative_to(app)):['link',str(p.readlink())] if p.is_symlink() else ['file',sha(p),p.stat().st_mode&0o777] for p in sorted(app.rglob('*')) if p.is_symlink() or p.is_file()}
if '--install-reviewed' not in __import__('sys').argv:raise SystemExit('Requires --install-reviewed after independent review and testing')
for name in ['Claude','ClaudeTW']:
 if subprocess.run(['/usr/bin/pgrep','-x',name],capture_output=True).returncode==0:raise SystemExit(name+' is running; no live changes made')
if not RUNTIME.is_dir() or not HELPER.is_dir():raise SystemExit('Existing ClaudeTW installation required')
receipt=json.loads((ROOT/'evidence/candidate-receipt.json').read_text())
if sha(APP/'Contents/Resources/app.asar')!=receipt['baseline']:raise SystemExit('Live baseline changed')
if manifest(CANDIDATE)!=receipt['candidateManifest']:raise SystemExit('Candidate changed after validation')
run('/usr/bin/codesign','--verify','--deep','--strict',str(CANDIDATE))
helper_bin=STAGE/'ClaudeTW'
if not helper_bin.is_file():raise SystemExit('Compile reviewed helper first')
backup=Path.home()/'AI/TATWO OS/archive'/('claudetw-before-update-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));backup.mkdir()
archive=backup/'runtime-and-helper.tar.gz'
existing=[name for name in FILES+['state.json','snapshot.json','status.json','approved-app.json','renderer-report.json','patch-heartbeat.json','menubar-bin'] if (RUNTIME/name).exists()]
with tarfile.open(archive,'w:gz') as t:
 for name in existing:t.add(RUNTIME/name,arcname='runtime/'+name)
 t.add(HELPER,arcname='ClaudeTW.app')
with tarfile.open(archive) as t:
 for name in existing:
  if hashlib.sha256(t.extractfile('runtime/'+name).read()).hexdigest()!=sha(RUNTIME/name):raise SystemExit('Runtime backup readback failed')
helper_backup=backup/'ClaudeTW.app'
run('/bin/cp','-cR',str(HELPER),str(helper_backup))
if manifest(helper_backup)!=manifest(HELPER):raise SystemExit('Helper clone backup readback failed')
previous=STAGE/'previous.app'
if previous.exists():raise SystemExit('Previous installation not yet retired')
# Full previous bundle stays intact here until installed behavior has been checked.
backup_record={'archive':str(archive),'archiveSha256':sha(archive),'previousApp':str(previous),'newFiles':[name for name in FILES+['snapshot.json','status.json','approved-app.json','renderer-report.json','patch-heartbeat.json'] if name not in existing]}
(backup/'RESTORE.json').write_text(json.dumps(backup_record,indent=2))
(backup/'RESTORE.md').write_text('先正常關閉 Claude 和 ClaudeTW；勿強制停止工作。將 staging/previous.app 搬回 /Applications/Claude.app（先封存新版），將壓縮包的 runtime/ 檔案還原至既有 runtime，ClaudeTW.app 還原至其上層。移除本收據 newFiles 中本次新增的檔案。完成後核對舊版 ASAR 雜湊，再開啟 Claude。若 previous.app 已在驗證後回收，使用 claude-before-prepaint-20260924-185503/Claude.app 完整備份。\n')
try:
 # Old renderer reports are transient and were backed up; don't poison first rebuild.
 for name in ['renderer-report.json','patch-heartbeat.json']:
  if (RUNTIME/name).exists():(RUNTIME/name).unlink()
 for name in FILES:
  target=RUNTIME/name;tmp=target.with_name(name+'.v2-install.tmp');shutil.copy2(ROOT/'claude-tw'/name,tmp);os.replace(tmp,target)
 os.chmod(RUNTIME/'wake.sh',0o755)
 helper_target=HELPER/'Contents/MacOS/ClaudeTW';tmp=helper_target.with_name('ClaudeTW.new');shutil.copy2(helper_bin,tmp);os.replace(tmp,helper_target)
 run('/usr/bin/codesign','--force','--sign','-',str(HELPER));run('/usr/bin/codesign','--verify','--deep','--strict',str(HELPER))
 os.rename(APP,previous);os.rename(CANDIDATE,APP)
 (RUNTIME/'approved-app.json').write_text(json.dumps({'schema':2,'appVersion':receipt['appVersion'],'appHash':receipt['asarHash']}))
 run('/opt/homebrew/bin/node',str(RUNTIME/'index.mjs'),'--rebuild','--runtime',str(RUNTIME))
 run('/usr/bin/codesign','--verify','--deep','--strict',str(APP))
 result={'installed':True,'appVersion':receipt['appVersion'],'asarHash':sha(APP/'Contents/Resources/app.asar'),'backup':str(backup),'runtime':str(RUNTIME),'helperHash':sha(helper_target),'remaining':'Real installed UI verification; not published'}
 (ROOT/'evidence/install-receipt.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
except BaseException:
 # Preserve every candidate; restore original paths without force-killing anything.
 if previous.exists():
  if APP.exists():os.rename(APP,backup/'failed-install.app')
  os.rename(previous,APP)
 with tarfile.open(archive) as t:
  for name in existing:
   member=t.getmember('runtime/'+name)
   target=RUNTIME/name
   target.write_bytes(t.extractfile(member).read())
   os.chmod(target,member.mode)
 if HELPER.exists():os.rename(HELPER,backup/'failed-helper.app')
 os.rename(helper_backup,HELPER)
 for name in backup_record['newFiles']:
  if (RUNTIME/name).exists():(RUNTIME/name).unlink()
 if sha(APP/'Contents/Resources/app.asar')!=receipt['baseline']:
  print('ROLLBACK HASH MISMATCH: '+str(backup/'RESTORE.md'),file=sys.stderr)
 else:
  run('/usr/bin/codesign','--verify','--deep','--strict',str(APP))
  run('/usr/bin/codesign','--verify','--deep','--strict',str(HELPER))
  print('Original app/helper restored and verified. '+str(backup/'RESTORE.md'),file=sys.stderr)
 raise
