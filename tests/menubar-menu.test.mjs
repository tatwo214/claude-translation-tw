/**
 * Source-contract checks only: deliberately NO Swift compilation, App launch,
 * UI interaction or HTTP. Native build/UI acceptance requires separate approval.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../claude-tw/menubar.swift', import.meta.url), 'utf8');
const updater = readFileSync(new URL('../claude-tw/update.mjs', import.meta.url), 'utf8');
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing Swift section: ${start}`);
  return source.slice(a, b);
};
const menu = between('private func buildMenu()', 'private func buildSystemMenu()');
const system = between('private func buildSystemMenu()', 'private func render()');
const render = between('private func render()', 'private func notice(');
const runUpdater = between('private func runUpdater(', 'private func handleUpdate(');
const handleUpdate = between('private func handleUpdate(', 'private func finishUpdate(');

test('status menu has exactly three fixed actions: translation search, update, GitHub', () => {
  const items = [...menu.matchAll(/NSMenuItem\(title: "([^"]+)", action: #selector\(([^)]+)\)/g)];
  assert.deepEqual(items.map((m) => [m[1], m[2]]), [
    ['翻譯檢索', 'translationSearch'], ['更新', 'checkUpdate'], ['GitHub', 'openGitHub'],
  ]);
  assert.deepEqual([...menu.matchAll(/menu\.addItem\(([^)]+)\)/g)].map((m) => m[1]),
    ['indexItem', 'updateItem', 'githubItem']);
  assert.doesNotMatch(menu, /label\(|separator\(|submenu|isHidden|toggleItem|countsItem|reportItem|heartbeatItem|errorsItem|actionItem/);
  assert.match(menu, /item\.menu = menu/);
  assert.doesNotMatch(render, /(?:indexItem|updateItem)\.title\s*=/, 'busy states belong in tooltips, not additional/renamed rows');
});

test('Hide and Quit live in the system application menu, never a fourth status row', () => {
  assert.match(system, /#selector\(NSApplication\.hide\(_:\)\).*keyEquivalent: "h"/);
  assert.match(system, /#selector\(quit\).*keyEquivalent: "q"/);
  assert.match(system, /NSApplication\.shared\.mainMenu = main/);
  assert.match(menu, /buildSystemMenu\(\)/);
  assert.doesNotMatch(menu, /menu\.addItem\(quitItem\)/);
  assert.match(source, /func applicationShouldTerminate[\s\S]*?rebuildingIndex \|\| changingState \|\| updating \? \.terminateCancel : \.terminateNow/);
  assert.match(source, /app\.setActivationPolicy\(\.accessory\)/);
});

test('translation search only delegates to existing guarded rebuild, without new-word claims', () => {
  const search = between('@objc private func translationSearch()', 'private func finishIndexNotice()');
  assert.match(search, /guard !rebuildingIndex && !changingState && !updating else/);
  assert.match(search, /showIndexResult = true\s+rebuildIndex\(\)/);
  assert.doesNotMatch(search, /runner\.run|writeState|fetch|NSWorkspace|open\(/);
  assert.match(source, /"--rebuild", "--runtime", runtimeURL\.path/);
  assert.match(source, /索引重建完成；未自動新增詞條/);
  const notice = between('private func finishIndexNotice()', '@objc private func checkUpdate()');
  assert.match(notice, /guard showIndexResult else/);
  assert.match(notice, /不會自動新增或翻譯未知詞條/);
  assert.doesNotMatch(source, /新詞(?:已|全部)?完成|所有文字已翻譯|翻譯檢索完成/);
});

test('GitHub opens only the confirmed constant URL, not response/config URLs', () => {
  assert.match(source, /let updateRepository = "tatwo214\/claude-translation-tw"/);
  assert.match(source, /let githubPage = URL\(string: "https:\/\/github\.com\/tatwo214\/claude-translation-tw"\)!/);
  const action = between('@objc private func openGitHub()', '@objc private func translationSearch()');
  assert.match(action, /NSWorkspace\.shared\.open\(githubPage\)/);
  assert.equal((source.match(/NSWorkspace\.shared\.open\(/g) ?? []).length, 1);
  assert.doesNotMatch(action, /reply|stagePath|config|runner\.run/);
});

test('updater launches only installed local script with enum check/stage and fixed config', () => {
  assert.match(source, /enum UpdateOperation: String \{\s+case check = "--check"\s+case stage = "--stage"/);
  assert.match(runUpdater, /appendingPathComponent\("update-config\.json"\)/);
  assert.match(runUpdater, /appendingPathComponent\("update\.mjs"\)/);
  assert.match(runUpdater, /config\?\["repository"\] as\? String == updateRepository/);
  assert.match(runUpdater, /values\.isRegularFile == true && values\.isSymbolicLink != true/);
  assert.match(runUpdater, /runner\.run\(node, arguments: \[scriptURL\.path, operation\.rawValue, "--config", configURL\.path\]/);
  assert.doesNotMatch(runUpdater, /writeState|write\(to:|createDirectory|Process\(\)|\/bin\/sh|stagePath|executableURL/);
  assert.match(updater, /args\[1\] === '--config'/);
  assert.match(updater, /\['--check', '--stage'\]/);
});

test('check precedes an explicit download-and-stage confirmation; never automatic install/adopt', () => {
  const check = between('@objc private func checkUpdate()', 'private func runUpdater(');
  assert.match(check, /guard !updating && !rebuildingIndex && !changingState else/);
  assert.match(check, /updating = true/);
  assert.match(check, /runUpdater\(\.check\)/);
  assert.doesNotMatch(check, /runUpdater\(\.stage\)/);
  assert.match(handleUpdate, /addButton\(withTitle: "下載並暫存"\)/);
  assert.match(handleUpdate, /addButton\(withTitle: "取消"\)/);
  assert.match(handleUpdate, /if alert\.runModal\(\) == \.alertFirstButtonReturn \{[\s\S]*?runUpdater\(\.stage\)/);
  assert.equal((source.match(/runUpdater\(\.stage\)/g) ?? []).length, 1);
  assert.doesNotMatch(source, /"--install"|"--adopt"|case install|case adopt|安裝成功|已安裝更新|更新安裝完成/);
});

test('exit code + typed installed:false + phase-specific reply required before success UI', () => {
  assert.match(runUpdater, /guard code == 0, let reply = UpdateReply\.parse\(output, operation: operation\) else/);
  const parser = between('struct UpdateReply: Decodable', 'func makeMascotIcon');
  assert.match(parser, /let installed: Bool/);
  assert.match(parser, /JSONDecoder\(\)\.decode\(UpdateReply\.self, from: data\)/);
  assert.match(parser, /reply\.installed == false else \{ return nil \}/);
  assert.match(parser, /reply\.repository == updateRepository/);
  assert.match(parser, /case \(\.check, "update-available"\): return reply/);
  assert.match(parser, /case \(\.stage, "staged"\):/);
  assert.match(parser, /default: return nil/);
  assert.match(handleUpdate, /case "staged":[\s\S]*?尚未安裝/);
  assert.match(handleUpdate, /未變更現用版本，也未啟動下載的檔案/);
  for (const name of ['up-to-date', 'no-release']) assert.ok(handleUpdate.includes(`case "${name}":`));
  assert.match(runUpdater, /更新尚未就緒/);
  assert.match(runUpdater, /更新作業未完成/);
  assert.doesNotMatch(runUpdater + handleUpdate, /NSWorkspace|\.open\(|executableURL|\.stagePath/);
});

test('full manifest output has a bounded read above legacy 8 KiB, remains asynchronous', () => {
  assert.match(source, /outputLimit: UInt64 = 8192/);
  assert.match(source, /size > outputLimit \? size - outputLimit : 0/);
  assert.match(runUpdater, /outputLimit: 2 \* 1024 \* 1024/);
  assert.match(source, /task\.terminationHandler = \{ finished in[\s\S]*?finished\.terminationStatus/);
  assert.match(runUpdater, /io\.async/);
  assert.match(runUpdater, /DispatchQueue\.main\.async/);
  assert.doesNotMatch(source, /waitUntilExit|availableData|Pipe\(\)/);
});

test('original icon unchanged and periodic refresh cannot trigger update networking', () => {
  const icon = between('func makeMascotIcon', 'class AppDelegate');
  assert.equal(createHash('sha256').update(icon).digest('hex'),
    'de3acd361911c35efd249fa27085606edb1e28e1a1deb4319b24fe1aea159338');
  const lifecycle = between('func applicationDidFinishLaunching', 'func applicationWillTerminate');
  const refresh = between('private func refresh()', 'private func buildMenu()');
  assert.doesNotMatch(lifecycle + refresh, /runUpdater|checkUpdate|runner\.run/);
  assert.match(source, /makeMascotIcon\(enabled: snapshot\.enabled && snapshot\.connected\)/);
  assert.match(render, /updateItem\.isEnabled = !updating && !rebuildingIndex && !changingState/);
});
