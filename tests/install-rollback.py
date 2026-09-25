"""Fault injection against installer control flow; sandboxed files, no real apps/processes."""
from pathlib import Path
import tempfile,unittest,hashlib,json,shutil,subprocess,sys
from unittest.mock import patch
SOURCE=(Path(__file__).resolve().parent.parent/'scripts/local-install.py').read_text()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def manifest(root):return {str(p.relative_to(root)):['file',sha(p),p.stat().st_mode&0o777] for p in sorted(root.rglob('*')) if p.is_file()}
class Rollback(unittest.TestCase):
 def exercise(self,failure):
  with tempfile.TemporaryDirectory(prefix='ctw-install-test-') as folder:
   root=Path(folder);app=root/'installed/Claude.app';stage=root/'staging';runtime=root/'ClaudeTW/runtime';helper=runtime.parent/'ClaudeTW.app';candidate=stage/'Claude.app'
   for d in [app,candidate,helper,runtime,root/'claude-tw',root/'evidence',root/'archive']:d.mkdir(parents=True)
   for a,label in [(app,'old'),(candidate,'new')]:
    p=a/'Contents/Resources/app.asar';p.parent.mkdir(parents=True);p.write_text(label)
   h=helper/'Contents/MacOS/ClaudeTW';h.parent.mkdir(parents=True);h.write_text('old helper');h.chmod(0o755)
   (stage/'ClaudeTW').write_text('new helper');(stage/'ClaudeTW').chmod(0o755)
   names=['translator.js','main-bridge.cjs','preload-bridge.js','index.mjs','overrides.json','native-overrides.json','web-overrides.json','native-format.cjs','native-descriptors.json','assets.cjs','update.mjs','wake.sh','serve.mjs']
   for n in names:(root/'claude-tw'/n).write_text('new '+n)
   for n in ['translator.js','wake.sh','state.json','renderer-report.json','patch-heartbeat.json']:(runtime/n).write_text('old '+n)
   (runtime/'wake.sh').chmod(0o755)
   before_app,before_helper,before_runtime=manifest(app),manifest(helper),manifest(runtime)
   receipt={'baseline':sha(app/'Contents/Resources/app.asar'),'candidateManifest':manifest(candidate),'appVersion':'1','asarHash':sha(candidate/'Contents/Resources/app.asar')}
   (root/'evidence/candidate-receipt.json').write_text(json.dumps(receipt))
   source=SOURCE.replace("ROOT=Path(__file__).resolve().parent.parent",f"ROOT=Path({str(root)!r})").replace("Path('/Applications/Claude.app')",f"Path({str(app)!r})").replace("(Path.home()/'.local/share/claude-tw').resolve()",f"Path({str(runtime)!r})").replace("Path.home()/'AI/TATWO OS/archive'",f"Path({str(root/'archive')!r})")
   def fake_run(args,**kwargs):
    if args[0]=='/usr/bin/pgrep':return subprocess.CompletedProcess(args,1,stdout='')
    if args[0]=='/bin/cp':shutil.copytree(args[-2],args[-1]);return subprocess.CompletedProcess(args,0,stdout='')
    if args[0]=='/opt/homebrew/bin/node':
     if failure=='interrupt':raise KeyboardInterrupt('test interrupt')
     raise subprocess.CalledProcessError(1,args)
    return subprocess.CompletedProcess(args,0,stdout='')
   with patch.object(subprocess,'run',side_effect=fake_run),patch.object(sys,'argv',['local-install.py','--install-reviewed']):
    with self.assertRaises(KeyboardInterrupt if failure=='interrupt' else subprocess.CalledProcessError):exec(compile(source,'installer-under-test','exec'),{'__file__':str(root/'scripts/local-install.py'),'__name__':'__main__'})
   self.assertEqual(manifest(app),before_app)
   self.assertEqual(manifest(helper),before_helper)
   self.assertEqual(manifest(runtime),before_runtime)
   self.assertFalse((stage/'previous.app').exists())
   backups=list((root/'archive').iterdir());self.assertEqual(len(backups),1)
   self.assertTrue((backups[0]/'failed-install.app').is_dir())
 def test_failed_index_restores_app_helper_runtime_and_modes(self):self.exercise('node')
 def test_interrupt_restores_app_helper_runtime_and_modes(self):self.exercise('interrupt')
if __name__=='__main__':unittest.main()
