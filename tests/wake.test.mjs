import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const wakeSource = fs.readFileSync(path.join(root, 'claude-tw/wake.sh'), 'utf8');
const swiftSource = fs.readFileSync(path.join(root, 'claude-tw/menubar.swift'), 'utf8');
const mac = process.platform === 'darwin';
const shell = fs.existsSync('/bin/zsh') ? '/bin/zsh' : null;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Exercise the real wake script, substituting ONLY OS launch/process probes.
// No production test switches, real HOME writes, or actual App launches.
function harness(t, { sibling = true, fallback = true, state } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudetw-wake-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home with space ' quote");
  const runtime = path.join(home, 'AI/寫好的專案/ClaudeTW/runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.join(home, '.local/share'), { recursive: true });
  fs.symlinkSync(runtime, path.join(home, '.local/share/claude-tw'));
  const helper = path.join(path.dirname(runtime), 'ClaudeTW.app');
  const fallbackHelper = path.join(home, 'Applications/ClaudeTW.app');
  if (sibling) fs.mkdirSync(helper);
  if (fallback) fs.mkdirSync(fallbackHelper, { recursive: true });
  const statePath = path.join(runtime, 'state.json');
  if (state !== undefined) fs.writeFileSync(statePath, JSON.stringify(state));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const callsFile = path.join(dir, 'calls.jsonl');
  const open = path.join(bin, 'open-stub.mjs');
  const pgrep = path.join(bin, 'pgrep-stub.mjs');
  fs.writeFileSync(open, `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.WAKE_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(Number(process.env.WAKE_TEST_OPEN_EXIT || 0));
`, { mode: 0o700 });
  fs.writeFileSync(pgrep, `#!${process.execPath}
const name = process.argv.at(-1);
process.exit(process.env[name === 'Claude' ? 'WAKE_TEST_CLAUDE' : 'WAKE_TEST_HELPER'] === '1' ? 0 : 1);
`, { mode: 0o700 });
  const script = path.join(dir, 'wake-under-test.sh');
  fs.writeFileSync(script, wakeSource
    .replaceAll('/usr/bin/open', quote(open))
    .replaceAll('/usr/bin/pgrep', quote(pgrep)));
  return {
    runtime, statePath, helper, fallbackHelper,
    calls: () => fs.existsSync(callsFile)
      ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : [],
    run: (args = [], env = {}) => spawnSync(shell, [script, ...args], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`,
        CLAUDE_TW_AUTO_HELPER: '1', WAKE_TEST_CALLS: callsFile,
        WAKE_TEST_CLAUDE: '0', WAKE_TEST_HELPER: '0', WAKE_TEST_OPEN_EXIT: '0', ...env },
    }),
  };
}

test('wake is valid zsh and contains no server/network/process-killing loop', { skip: !shell }, () => {
  const result = spawnSync(shell, ['-n'], { input: wakeSource, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(wakeSource, /\bcurl\b|\bpkill\b|\bnohup\b|serve\.mjs|https?:\/\/|\bwhile\b/);
  assert.match(wakeSource, /CLAUDE_TW_AUTO_HELPER:-1/);
  assert.match(wakeSource, /pwd -P/);
});

test('interval wake does nothing unless Claude is running', { skip: !shell }, t => {
  const h = harness(t, { state: { enabled: true, keep: 'unchanged' } });
  const before = fs.readFileSync(h.statePath, 'utf8');
  const result = h.run(['--if-claude-running']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.calls(), []);
  assert.equal(fs.readFileSync(h.statePath, 'utf8'), before);
});

test('active Claude wakes resolved sibling with open -g even when translation is disabled', { skip: !shell }, t => {
  const h = harness(t, { state: { enabled: false } });
  const result = h.run(['--if-claude-running'], { WAKE_TEST_CLAUDE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.calls(), [['-g', h.helper]]);
  assert.equal(JSON.parse(fs.readFileSync(h.statePath)).enabled, false);
});

test('default and explicit wake select sibling ahead of fallback without launching Claude', { skip: !shell }, t => {
  const h = harness(t);
  assert.equal(h.run([], { CLAUDE_TW_AUTO_HELPER: '' }).status, 0);
  assert.equal(h.run(['wake']).status, 0);
  assert.deepEqual(h.calls(), [['-g', h.helper], ['-g', h.helper]]);
  assert.equal(fs.existsSync(h.statePath), false);
});

test('missing sibling uses Applications fallback', { skip: !shell }, t => {
  const h = harness(t, { sibling: false });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(h.calls(), [['-g', h.fallbackHelper]]);
});

test('auto-launch opt-out and already-running helper are no-ops', { skip: !shell }, t => {
  const h = harness(t);
  assert.equal(h.run([], { CLAUDE_TW_AUTO_HELPER: '0' }).status, 0);
  assert.equal(h.run([], { WAKE_TEST_HELPER: '1' }).status, 0);
  assert.deepEqual(h.calls(), []);
});

test('--enable atomically merges state and may open Claude, never a server', { skip: !shell }, t => {
  const initial = { enabled: false, schema: 2, proxyPort: 1234, custom: { list: ['keep', 7] } };
  const h = harness(t, { state: initial });
  const oldInode = fs.statSync(h.statePath).ino;
  fs.chmodSync(h.statePath, 0o600);
  const result = h.run(['--enable']);
  assert.equal(result.status, 0, result.stderr);
  const { updatedAt, ...saved } = JSON.parse(fs.readFileSync(h.statePath, 'utf8'));
  assert.deepEqual(saved, { ...initial, enabled: true });
  assert.ok(Number.isFinite(Date.parse(updatedAt)));
  assert.notEqual(fs.statSync(h.statePath).ino, oldInode, 'atomic rename replaces inode');
  assert.equal(fs.statSync(h.statePath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(h.runtime), ['state.json']);
  assert.deepEqual(h.calls(), [['-g', h.helper], ['/Applications/Claude.app']]);
});

test('--enable creates missing state but does not reopen running Claude', { skip: !shell }, t => {
  const h = harness(t);
  const result = h.run(['--enable'], { WAKE_TEST_CLAUDE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(h.statePath)).enabled, true);
  assert.deepEqual(h.calls(), [['-g', h.helper]]);
});

for (const bad of ['{"enabled":', 'null', '[]', '"not an object"']) {
  test(`--enable leaves malformed/non-object state untouched: ${bad}`, { skip: !shell }, t => {
    const h = harness(t);
    fs.writeFileSync(h.statePath, bad);
    const result = h.run(['--enable']);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(h.statePath, 'utf8'), bad);
    assert.deepEqual(h.calls(), []);
  });
}

test('missing helper, failed open and unsupported arguments fail visibly', { skip: !shell }, t => {
  const h = harness(t, { sibling: false, fallback: false });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /helper not found/);
  assert.deepEqual(h.calls(), []);
  assert.equal(h.run(['--unknown']).status, 64);
  fs.mkdirSync(h.helper);
  assert.equal(h.run([], { WAKE_TEST_OPEN_EXIT: '9' }).status, 9);
});

test('native menu keeps exact baseline flag/check drawing and offline async guards', () => {
  const icon = swiftSource.slice(swiftSource.indexOf('func makeMascotIcon'), swiftSource.indexOf('class AppDelegate'));
  assert.equal(createHash('sha256').update(icon).digest('hex'),
    'de3acd361911c35efd249fa27085606edb1e28e1a1deb4319b24fe1aea159338');
  assert.doesNotMatch(swiftSource, /stopProxy|startProxy|proxyAlive|serve\.mjs|osascript|\bcurl\b|\bpkill\b|waitUntilExit|availableData|\/bin\/(?:ba)?sh/);
  assert.match(swiftSource, /resolvingSymlinksInPath\(\)/);
  assert.match(swiftSource, /NSWorkspace\.didLaunchApplicationNotification/);
  assert.match(swiftSource, /重新整合翻譯索引/);
  assert.match(swiftSource, /"--rebuild", "--runtime", runtimeURL\.path/);
  assert.match(swiftSource, /data\.write\(to: url, options: \.atomic\)/);
  assert.match(swiftSource, /task\.terminationHandler = \{ finished in[\s\S]*?finished\.terminationStatus/);
  assert.equal((swiftSource.match(/\.terminationStatus/g) ?? []).length, 1);
  assert.match(swiftSource, /補丁：未連線／需重開 Claude/);
  assert.match(swiftSource, /NSRunningApplication\(processIdentifier: pid\)/);
  assert.match(swiftSource, /app\.bundleIdentifier == "com\.anthropic\.claudefordesktop"/);
  assert.match(swiftSource, /fresh\(heartbeatAt, within: 5\)/);
  assert.match(swiftSource, /fresh\(\$0, within: 90\)/);
  assert.match(swiftSource, /JSONDecoder\(\)\.decode\(IndexMetadata\.self/);
  assert.match(swiftSource, /indexItem\.toolTip = snapshot\.detail/);
  assert.doesNotMatch(swiftSource, /detailItem|\.title = snapshot\.(?:detail|reportDetail|heartbeatDetail)/);
  assert.match(swiftSource, /makeMascotIcon\(enabled: snapshot\.enabled && snapshot\.connected\)/);
  assert.match(swiftSource, /RunLoop\.main\.add\(poll, forMode: \.common\)/);
});

test('startup and Claude launch each request the safe async indexer, not timer refresh', () => {
  const lifecycle = swiftSource.slice(swiftSource.indexOf('func applicationDidFinishLaunching'),
    swiftSource.indexOf('func applicationWillTerminate'));
  assert.match(lifecycle, /NSWorkspace\.didLaunchApplicationNotification[\s\S]*?self\?\.rebuildIndex\(\)/);
  assert.equal((lifecycle.match(/rebuildIndex\(\)/g) ?? []).length, 2);
  assert.match(lifecycle, /\n        rebuildIndex\(\)\n        let poll = Timer/);
  assert.match(lifecycle, /Timer\(timeInterval: 1, repeats: true\) \{ \[weak self\] _ in self\?\.refresh\(\) \}/);
  const refresh = swiftSource.slice(swiftSource.indexOf('private func refresh()'),
    swiftSource.indexOf('private func buildMenu()'));
  assert.doesNotMatch(refresh, /rebuildIndex|runner\.run/);
  assert.match(swiftSource, /guard !rebuildingIndex && !changingState else \{ return \}/);
  assert.doesNotMatch(swiftSource, /"--approve"|write.*approved-app\.json/);
});

test('Swift isolated model and async child runner work without starting an App', {
  skip: !mac || !fs.existsSync('/usr/bin/swiftc'),
  timeout: 90_000,
}, t => {
  const evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const dir = fs.mkdtempSync(path.join(evidence, 'wake-model-'));
  // Preserve compiler/source evidence; fixtures are isolated below this directory.
  const runtime = path.join(dir, 'runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'state.json'), JSON.stringify({ enabled: false, custom: { keep: 42 } }));
  const main = swiftSource.slice(0, swiftSource.indexOf('func makeMascotIcon')) + `
let fixture = URL(fileURLWithPath: CommandLine.arguments[1])
func save(_ name: String, _ value: [String: Any]) throws {
    try JSONSerialization.data(withJSONObject: value).write(to: fixture.appendingPathComponent(name), options: .atomic)
}
func check(_ value: @autoclosure () -> Bool, _ label: String) {
    if !value() { fputs("FAIL: \\(label)\\n", stderr); exit(1) }
}
try writeState(enabled: true, runtime: fixture)
var stored = try readObject(fixture.appendingPathComponent("state.json"))
check(stored["enabled"] as? Bool == true, "toggle enabled")
check((stored["custom"] as? [String: Int])?["keep"] == 42, "preserve custom fields")
try writeState(enabled: false, runtime: fixture)
stored = try readObject(fixture.appendingPathComponent("state.json"))
check(stored["enabled"] as? Bool == false, "toggle disabled")
check((stored["custom"] as? [String: Int])?["keep"] == 42, "preserve custom fields twice")
var status: [String: Any] = ["schema": 2, "state": "ready", "message": "saved",
    "knownCount": 80, "unknownCount": 0, "appVersion": "1.2.3", "updatedAt": "2026-09-25T00:00:00Z"]
try save("status.json", status)
var savedMetadata: [String: Any] = ["schema": 2, "appVersion": "1.2.3",
    "revision": "current-revision", "builtAt": "2026-09-25T00:00:02Z",
    "dictionary": ["Ignored": "The menu decodes metadata only"]]
try save("snapshot.json", savedMetadata)
var snapshot = MenuSnapshot.load(runtime: fixture)
check(snapshot.index == "索引：已儲存（待連線）", "saved offline index is not live readiness")
check(snapshot.heartbeat == "補丁：未連線／需重開 Claude", "no heartbeat cannot imply running")
let report: [String: Any] = ["schema": 2, "unknownCount": 7, "mismatchCount": 2,
    "appVersion": "1.2.3", "revision": "old-revision", "reportedAt": "2026-09-25T00:00:01Z"]
try save("renderer-report.json", report)
snapshot = MenuSnapshot.load(runtime: fixture)
check(snapshot.counts == "已知：80｜未知：7", "rebuild must not erase renderer unknown count")
check(snapshot.index.contains("待整合"), "renderer pending is visible despite ready index")
check(snapshot.report.contains("不符 2"), "mismatch visible")
check(snapshot.reportDetail.contains("old-revision"), "revision available in tooltip")
check(!snapshot.report.contains("old-revision"), "revision is not in menu title")
for state in ["needs-index", "unsupported", "error"] {
    status["state"] = state
    try save("status.json", status)
    snapshot = MenuSnapshot.load(runtime: fixture)
    check(!snapshot.index.contains("就緒"), "non-ready states not shown as ready")
    check(snapshot.counts.contains("未知：7"), "unknown persists across failures")
}
try save("patch-heartbeat.json", ["schema": 2, "appVersion": "1.2.3",
    "appHash": String(repeating: "a", count: 64), "startedAt": "2026-09-25T00:00:00Z"])
snapshot = MenuSnapshot.load(runtime: fixture)
check(!snapshot.connected, "historical heartbeat is not proof of live translation")
check(snapshot.heartbeat == "補丁：未連線／需重開 Claude", "historical heartbeat requests reopen")

let now = isoDate("2026-09-25T00:00:10.000Z")!
let started = isoDate("2026-09-25T00:00:00Z")!
var beat: [String: Any] = ["schema": 2, "appVersion": "1.2.3",
    "appHash": String(repeating: "a", count: 64), "pid": 4242,
    "startedAt": "2026-09-25T00:00:00Z", "reportedAt": "2026-09-25T00:00:09.100Z"]
var freshReport: [String: Any] = ["schema": 2, "appVersion": "1.2.3", "revision": "current-revision",
    "reportedAt": "2026-09-25T00:00:09.000Z", "unknownCount": 0, "mismatchCount": 0,
    "appliedCount": 60, "flushCount": 12, "maxScanMs": 1.25]
func loadFresh(_ matches: Bool = true) -> MenuSnapshot {
    MenuSnapshot.load(runtime: fixture, now: now, runningClaude: { pid, date in
        matches && pid == 4242 && date == started
    })
}
status["state"] = "ready"
try save("status.json", status)
try save("renderer-report.json", freshReport)
try save("patch-heartbeat.json", beat)
snapshot = loadFresh()
check(snapshot.connected && snapshot.heartbeat == "補丁：已連線", "fresh reports and matching PID connect")
check(snapshot.index == "索引：就緒（離線）", "ready only when bridge is live")
check(snapshot.reportDetail.contains("60") && snapshot.reportDetail.contains("1.25"), "renderer metrics available in tooltip")
check(!snapshot.heartbeat.contains("2026") && !snapshot.report.contains("2026"), "timestamps not in menu titles")
check(!loadFresh(false).connected, "missing or non-Claude process disconnects")
check(!isRunningClaude(ProcessInfo.processInfo.processIdentifier, started), "test CLI is not Claude")

// Only an exact, post-build, recent report can replace persisted pending counts.
status["state"] = "needs-index"
status["unknownCount"] = 17
status["message"] = "Old mismatch / unknown report; long diagnostic stays in tooltip"
try save("status.json", status)
snapshot = loadFresh()
check(snapshot.index == "索引：就緒（離線）", "matching fresh report clears old needs-index")
check(snapshot.counts == "已知：80｜未知：0", "actual matching zero replaces stale maximum")
check(snapshot.detail.contains("Old mismatch"), "diagnostic remains available in tooltip")
check(!snapshot.index.contains("Old mismatch"), "diagnostic is not a visible menu line")
freshReport["unknownCount"] = 3
try save("renderer-report.json", freshReport)
snapshot = loadFresh()
check(snapshot.counts == "已知：80｜未知：3" && snapshot.index == "索引：待整合", "new nonzero unknown count replaces old count but stays pending")
freshReport["unknownCount"] = 0
freshReport["mismatchCount"] = 1
try save("renderer-report.json", freshReport)
check(loadFresh().index == "索引：待整合", "current mismatch prevents readiness even with zero unknown")
freshReport["mismatchCount"] = 0
freshReport["revision"] = "old-revision"
try save("renderer-report.json", freshReport)
snapshot = loadFresh()
check(snapshot.counts == "已知：80｜未知：17" && snapshot.index == "索引：待整合", "rebuild plus old revision cannot erase pending unknowns")
freshReport["unknownCount"] = 23
try save("renderer-report.json", freshReport)
check(loadFresh().counts == "已知：80｜未知：23", "unmatched report preserves the conservative maximum")
freshReport["unknownCount"] = 0
freshReport["revision"] = "current-revision"
freshReport["reportedAt"] = "2026-09-25T00:00:01Z"
try save("renderer-report.json", freshReport)
check(loadFresh().counts == "已知：80｜未知：17", "matching revision but pre-build report cannot clear unknowns")
freshReport["reportedAt"] = "2026-09-25T00:00:02Z"
try save("renderer-report.json", freshReport)
check(loadFresh().index == "索引：就緒（離線）", "report at exact build time is admissible")
freshReport["reportedAt"] = "2026-09-25T00:00:09Z"
freshReport["appVersion"] = "2.0.0"
try save("renderer-report.json", freshReport)
check(loadFresh().counts == "已知：80｜未知：17", "report must match status appVersion")
freshReport["appVersion"] = "1.2.3"
try save("renderer-report.json", freshReport)
savedMetadata["appVersion"] = "2.0.0"
try save("snapshot.json", savedMetadata)
check(loadFresh().counts == "已知：80｜未知：17", "snapshot identity must also match")
savedMetadata["appVersion"] = "1.2.3"
try save("snapshot.json", ["schema": 2])
check(loadFresh().counts == "已知：80｜未知：17", "missing snapshot metadata cannot clear unknowns")
try save("snapshot.json", savedMetadata)
freshReport["unknownCount"] = -1
try save("renderer-report.json", freshReport)
check(loadFresh().counts == "已知：80｜未知：17", "invalid current counts cannot clear unknowns")
freshReport["unknownCount"] = 0
try save("renderer-report.json", freshReport)
for state in ["unsupported", "error"] {
    status["state"] = state
    try save("status.json", status)
    check(!loadFresh().index.contains("就緒"), "renderer cannot override indexer errors or unsupported version")
}
status["state"] = "needs-index"
try save("status.json", status)
for age in [90.0, 91.0] {
    freshReport["reportedAt"] = ISO8601DateFormatter().string(from: now.addingTimeInterval(-age))
    try save("renderer-report.json", freshReport)
    snapshot = loadFresh()
    check(snapshot.connected && snapshot.heartbeat == "補丁：已連線", "fresh heartbeat remains connected while renderer is throttled")
    check(!snapshot.rendererFresh && snapshot.report.contains("背景／舊回報"), "stale renderer is labeled background/old")
    check(snapshot.counts == "已知：80｜未知：17" && snapshot.index == "索引：待整合", "expired renderer cannot clear status counts")
}
freshReport["reportedAt"] = "2026-09-25T00:00:11Z"
try save("renderer-report.json", freshReport)
check(loadFresh().connected && !loadFresh().rendererFresh, "future report is not fresh but does not disconnect main process")
freshReport["reportedAt"] = "2026-09-25T00:00:09Z"
try save("renderer-report.json", ["schema": 1])
check(loadFresh().connected, "absent valid renderer report does not require restarting Claude")
try save("renderer-report.json", freshReport)
status["state"] = "ready"
status["unknownCount"] = 0
try save("status.json", status)

for date in ["2026-09-25T00:00:05.000Z", "2026-09-25T00:00:11Z", "invalid"] {
    beat["reportedAt"] = date
    try save("patch-heartbeat.json", beat)
    snapshot = loadFresh()
    check(!snapshot.connected && !snapshot.index.contains("就緒"), "expired, future, malformed heartbeat cannot show ready")
}
beat["reportedAt"] = "2026-09-25T00:00:09Z"
try save("patch-heartbeat.json", beat)
freshReport["reportedAt"] = "2026-09-25T00:00:05Z"
try save("renderer-report.json", freshReport)
check(loadFresh().connected && loadFresh().rendererFresh, "renderer five seconds old remains fresh within its separate ninety-second window")
freshReport["reportedAt"] = "2026-09-25T00:00:09Z"
freshReport["appVersion"] = "2.0.0"
try save("renderer-report.json", freshReport)
check(loadFresh().connected && !loadFresh().index.contains("就緒"), "different report version does not affect heartbeat connectivity or imply readiness")
freshReport["appVersion"] = "1.2.3"
try save("renderer-report.json", freshReport)
for pid in [-1, 0, 4243, Int(Int32.max) + 1] {
    beat["pid"] = pid
    try save("patch-heartbeat.json", beat)
    check(!loadFresh().connected, "wrong or invalid PID disconnects")
}
beat.removeValue(forKey: "pid")
try save("patch-heartbeat.json", beat)
check(!loadFresh().connected, "old heartbeat without PID disconnects")
beat["pid"] = 4242
beat["startedAt"] = "2026-09-24T23:00:00Z"
try save("patch-heartbeat.json", beat)
check(!loadFresh().connected, "PID reused by a new launch does not validate the old heartbeat")
try Data("{".utf8).write(to: fixture.appendingPathComponent("state.json"))
do {
    try writeState(enabled: true, runtime: fixture)
    check(false, "malformed state must not be overwritten")
} catch {}
let malformed = try String(contentsOf: fixture.appendingPathComponent("state.json"), encoding: .utf8)
check(malformed == "{", "malformed bytes retained")
try save("status.json", ["schema": 1])
snapshot = MenuSnapshot.load(runtime: fixture)
check(!snapshot.errors.isEmpty, "bad schema error visible")
let runner = ProcessRunner()
var mainQueueWasResponsive = false
DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { mainQueueWasResponsive = true }
runner.run(URL(fileURLWithPath: CommandLine.arguments[2]),
           arguments: ["-e", "setTimeout(() => { process.stdout.write('x'.repeat(200000)); process.stderr.write('TAIL'); process.exitCode=7; }, 250)"]) { code, output in
    check(Thread.isMainThread, "completion is on main thread")
    check(mainQueueWasResponsive, "main queue stays responsive while child runs")
    check(code == 7, "exit status observed after exit")
    check(output.hasSuffix("TAIL") && output.utf8.count <= 8192, "large output drained and bounded")
    runner.run(fixture.appendingPathComponent("missing-executable"), arguments: []) { code, output in
        check(code == -1 && !output.isEmpty, "spawn failure delivered honestly")
        print("Swift model + nonblocking Process tests passed")
        exit(0)
    }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
    fputs("FAIL: async process timeout\\n", stderr)
    exit(1)
}
RunLoop.main.run()
`;
  const source = path.join(dir, 'model-test.swift');
  const binary = path.join(dir, 'model-test');
  fs.writeFileSync(source, main);
  const compile = spawnSync('/usr/bin/swiftc', [source, '-o', binary,
    '-module-cache-path', path.join(evidence, 'swift-module-cache')], { encoding: 'utf8', timeout: 60_000 });
  fs.writeFileSync(path.join(dir, 'compile.log'), compile.stdout + compile.stderr);
  assert.equal(compile.status, 0, compile.stderr);
  const run = spawnSync(binary, [runtime, process.execPath], { encoding: 'utf8', timeout: 20_000 });
  fs.writeFileSync(path.join(dir, 'test.log'), run.stdout + run.stderr);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /tests passed/);
  t.diagnostic(`isolated Swift evidence: ${path.relative(root, dir)}`);
});
