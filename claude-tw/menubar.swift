import Cocoa

// Resolve the compatibility symlink before passing paths to the offline indexer.
let runtimeURL = URL(fileURLWithPath: NSHomeDirectory())
    .appendingPathComponent(".local/share/claude-tw", isDirectory: true)
    .resolvingSymlinksInPath()

func readObject(_ url: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: url)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw NSError(domain: "ClaudeTW", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(url.lastPathComponent) 不是 JSON 物件"])
    }
    return object
}

func writeState(enabled: Bool, runtime: URL = runtimeURL) throws {
    let url = runtime.appendingPathComponent("state.json")
    try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
    // Fail closed for malformed existing state; never replace unrelated fields.
    var state = FileManager.default.fileExists(atPath: url.path) ? try readObject(url) : [:]
    state["enabled"] = enabled
    state["updatedAt"] = ISO8601DateFormatter().string(from: Date())
    let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
    try data.write(to: url, options: .atomic)
}

func nodeExecutable() -> URL? {
    let paths = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":")
        .map { String($0) + "/node" } + ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    return paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
        .map { URL(fileURLWithPath: $0) }
}

// A regular file, not an undrained pipe: a verbose child cannot block waiting for
// the UI. Both output and terminationStatus are read ONLY after termination.
final class ProcessRunner {
    private let queue = DispatchQueue(label: "ClaudeTW.process")
    private var running: [UUID: Process] = [:]

    func run(_ executable: URL, arguments: [String], outputLimit: UInt64 = 8192,
             completion: @escaping (Int32, String) -> Void) {
        queue.async {
            let id = UUID()
            let log = FileManager.default.temporaryDirectory.appendingPathComponent("claudetw-\(id).log")
            guard FileManager.default.createFile(atPath: log.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]),
                  let output = try? FileHandle(forWritingTo: log) else {
                DispatchQueue.main.async { completion(-1, "無法建立程序輸出檔") }
                return
            }
            let task = Process()
            task.executableURL = executable
            task.arguments = arguments
            task.standardInput = FileHandle.nullDevice
            task.standardOutput = output
            task.standardError = output
            task.terminationHandler = { finished in
                self.queue.async {
                    try? output.close()
                    var message = ""
                    if let input = try? FileHandle(forReadingFrom: log) {
                        let size = (try? input.seekToEnd()) ?? 0
                        try? input.seek(toOffset: size > outputLimit ? size - outputLimit : 0)
                        let data = (try? input.readToEnd()) ?? Data()
                        message = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                        try? input.close()
                    }
                    let code = finished.terminationStatus
                    self.running.removeValue(forKey: id)
                    try? FileManager.default.removeItem(at: log)
                    let result = message
                    DispatchQueue.main.async { completion(code, result) }
                }
            }
            self.running[id] = task
            do {
                try task.run()
            } catch {
                task.terminationHandler = nil
                self.running.removeValue(forKey: id)
                try? output.close()
                try? FileManager.default.removeItem(at: log)
                DispatchQueue.main.async { completion(-1, error.localizedDescription) }
            }
        }
    }
}

func isoDate(_ value: Any?) -> Date? {
    guard let text = value as? String else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: text) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: text)
}

func isRunningClaude(_ pid: Int32, _ startedAt: Date) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid),
          !app.isTerminated, app.processIdentifier == pid,
          app.bundleIdentifier == "com.anthropic.claudefordesktop",
          app.bundleURL?.lastPathComponent == "Claude.app",
          let launched = app.launchDate else { return false }
    // Reject a heartbeat from an earlier process that happened to reuse this PID.
    return launched <= startedAt
}

// Decode only identity/build metadata; the menu never loads or rebuilds the dictionary.
struct IndexMetadata: Decodable {
    let schema: Int
    let revision: String
    let appVersion: String
    let builtAt: String
}

struct MenuSnapshot {
    var enabled = false
    var connected = false
    var rendererFresh = false
    var index = "索引：尚未建立"
    var detail = ""
    var counts = "已知：—｜未知：—"
    var report = "畫面回報：尚未收到"
    var reportDetail = ""
    var heartbeat = "補丁：未連線／需重開 Claude"
    var heartbeatDetail = ""
    var errors: [String] = []

    static func load(runtime: URL = runtimeURL, now: Date = Date(),
                     runningClaude: (Int32, Date) -> Bool = isRunningClaude) -> MenuSnapshot {
        var result = MenuSnapshot()
        func object(_ name: String) -> [String: Any]? {
            let url = runtime.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { return nil }
            do {
                let value = try readObject(url)
                guard value["schema"] as? Int == 2 else {
                    result.errors.append("\(name)：不支援的格式")
                    return nil
                }
                return value
            } catch {
                result.errors.append("\(name)：\(error.localizedDescription)")
                return nil
            }
        }
        let stateURL = runtime.appendingPathComponent("state.json")
        if FileManager.default.fileExists(atPath: stateURL.path) {
            do {
                let state = try readObject(stateURL)
                guard let enabled = state["enabled"] as? Bool else {
                    throw NSError(domain: "ClaudeTW", code: 2,
                                  userInfo: [NSLocalizedDescriptionKey: "enabled 欄位無效"])
                }
                result.enabled = enabled
            } catch { result.errors.append("設定：\(error.localizedDescription)") }
        }
        let status = object("status.json")
        let report = object("renderer-report.json")
        let heartbeat = object("patch-heartbeat.json")
        var metadata: IndexMetadata?
        let snapshotURL = runtime.appendingPathComponent("snapshot.json")
        if FileManager.default.fileExists(atPath: snapshotURL.path) {
            do {
                let decoded = try JSONDecoder().decode(IndexMetadata.self, from: Data(contentsOf: snapshotURL))
                if decoded.schema == 2 {
                    metadata = decoded
                } else { result.errors.append("snapshot.json：不支援的格式") }
            } catch { result.errors.append("snapshot.json：\(error.localizedDescription)") }
        }
        func fresh(_ date: Date, within seconds: TimeInterval) -> Bool {
            let age = now.timeIntervalSince(date)
            return age >= 0 && age < seconds
        }
        let reportAt = isoDate(report?["reportedAt"])
        result.rendererFresh = reportAt.map { fresh($0, within: 90) } ?? false
        if let heartbeat = heartbeat {
            result.heartbeatDetail = """
            版本：\(heartbeat["appVersion"] as? String ?? "—")
            雜湊：\(heartbeat["appHash"] as? String ?? "—")
            PID：\(heartbeat["pid"].map { String(describing: $0) } ?? "—")
            啟動：\(heartbeat["startedAt"] as? String ?? "—")
            回報：\(heartbeat["reportedAt"] as? String ?? "—")
            """
            if let pid = heartbeat["pid"] as? Int, pid > 0, pid <= Int(Int32.max),
               let started = isoDate(heartbeat["startedAt"]),
               let heartbeatAt = isoDate(heartbeat["reportedAt"]), fresh(heartbeatAt, within: 5),
               started <= heartbeatAt,
               let version = heartbeat["appVersion"] as? String, !version.isEmpty,
               let hash = heartbeat["appHash"] as? String, !hash.isEmpty,
               runningClaude(Int32(pid), started) {
                result.connected = true
                result.heartbeat = "補丁：已連線"
            }
        }
        func count(_ object: [String: Any]?, _ key: String) -> Int? {
            guard let value = object?[key] as? Int, value >= 0 else { return nil }
            return value
        }
        if let status = status {
            let labels = ["ready": "就緒（離線）", "needs-index": "待整合", "unsupported": "版本不支援", "error": "錯誤"]
            result.index = "索引：" + (labels[status["state"] as? String ?? ""] ?? "狀態格式錯誤")
            let version = status["appVersion"] as? String ?? "—"
            let updated = status["updatedAt"] as? String ?? "—"
            result.detail = "\(status["message"] as? String ?? "")｜版本 \(version)｜更新 \(updated)"
        }
        // A rebuild alone cannot clear unknowns/mismatches. Only a recent report
        // for THIS snapshot, produced after its build, can supersede old status.
        var reportMatchesCurrent = false
        if result.rendererFresh, let metadata = metadata,
           !metadata.revision.isEmpty,
           metadata.revision == report?["revision"] as? String,
           !metadata.appVersion.isEmpty,
           metadata.appVersion == status?["appVersion"] as? String,
           metadata.appVersion == report?["appVersion"] as? String,
           let builtAt = isoDate(metadata.builtAt), let reportAt = reportAt, reportAt >= builtAt,
           count(report, "unknownCount") != nil, count(report, "mismatchCount") != nil {
            reportMatchesCurrent = true
        }
        let unknown = reportMatchesCurrent ? count(report, "unknownCount")
            : [count(status, "unknownCount"), count(report, "unknownCount")].compactMap { $0 }.max()
        result.counts = "已知：\(count(status, "knownCount").map(String.init) ?? "—")｜未知：\(unknown.map(String.init) ?? "—")"
        let state = status?["state"] as? String
        if state == "ready" || (state == "needs-index" && reportMatchesCurrent) {
            if (unknown ?? 0) > 0 || (count(report, "mismatchCount") ?? 0) > 0 {
                result.index = "索引：待整合"
            } else if !result.connected {
                result.index = "索引：已儲存（待連線）"
            } else if heartbeat?["appVersion"] as? String != status?["appVersion"] as? String {
                result.index = "索引：版本不同，待確認"
            } else if reportMatchesCurrent {
                result.index = "索引：就緒（離線）"
            } else {
                result.index = "索引：已儲存（待畫面確認）"
            }
        }
        if let report = report {
            let version = report["appVersion"] as? String ?? "—"
            let revision = report["revision"].map { String(describing: $0) } ?? "—"
            let date = report["reportedAt"] as? String ?? "—"
            result.report = "畫面：未知 \(count(report, "unknownCount").map(String.init) ?? "—")／不符 \(count(report, "mismatchCount").map(String.init) ?? "—")"
            if !result.rendererFresh {
                result.report += "（背景／舊回報）"
            } else if !reportMatchesCurrent { result.report += "（待比對）" }
            result.reportDetail = """
            版本：\(version)
            索引：\(revision)
            回報：\(date)
            已套用：\(count(report, "appliedCount").map(String.init) ?? "—")
            刷新次數：\(count(report, "flushCount").map(String.init) ?? "—")
            最長掃描：\(report["maxScanMs"].map { String(describing: $0) } ?? "—") ms
            """
        }
        return result
    }
}

// Parent provisions this trusted local config; the menu never invents a version,
// file allowlist or staging directory, and never creates/rewrites the config.
let updateRepository = "tatwo214/claude-translation-tw"
let githubPage = URL(string: "https://github.com/tatwo214/claude-translation-tw")!

enum UpdateOperation: String {
    case check = "--check"
    case stage = "--stage"
}

struct UpdateReply: Decodable {
    let status: String
    let installed: Bool
    let repository: String?
    let version: String?
    let stagePath: String?

    static func parse(_ output: String, operation: UpdateOperation) -> UpdateReply? {
        guard let data = output.data(using: .utf8),
              let reply = try? JSONDecoder().decode(UpdateReply.self, from: data),
              reply.installed == false else { return nil }
        if reply.status == "no-release" || reply.status == "up-to-date" { return reply }
        guard reply.repository == updateRepository, let version = reply.version,
              version.count <= 256,
              version.range(of: #"^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$"#,
                            options: .regularExpression) != nil else { return nil }
        switch (operation, reply.status) {
        case (.check, "update-available"): return reply
        case (.stage, "staged"):
            guard let stage = reply.stagePath, stage.hasPrefix("/"),
                  !stage.contains("\n"), !stage.contains("\0") else { return nil }
            return reply
        default: return nil
        }
    }
}

func makeMascotIcon(enabled: Bool) -> NSImage {
    let size = NSSize(width: 26, height: 20)
    let image = NSImage(size: size)
    image.lockFocus()
    defer { image.unlockFocus() }

    NSGraphicsContext.current?.imageInterpolation = .high
    NSColor.clear.setFill()
    NSRect(origin: .zero, size: size).fill()

    let alpha: CGFloat = enabled ? 1.0 : 0.45
    let red = NSColor(calibratedRed: 0.86, green: 0.07, blue: 0.13, alpha: alpha)
    let blue = NSColor(calibratedRed: 0.04, green: 0.20, blue: 0.55, alpha: alpha)
    let white = NSColor(calibratedWhite: 1.0, alpha: alpha)

    let badgeRect = NSRect(x: 3, y: 1, width: 20, height: 18)
    let badge = NSBezierPath(roundedRect: badgeRect, xRadius: 5, yRadius: 5)

    red.setFill()
    badge.fill()

    NSGraphicsContext.saveGraphicsState()
    badge.addClip()
    blue.setFill()
    NSBezierPath(rect: NSRect(x: 3, y: 10, width: 9.5, height: 9)).fill()
    NSGraphicsContext.restoreGraphicsState()

    let sunCenter = NSPoint(x: 7.8, y: 14.4)
    white.setFill()
    for index in 0..<12 {
        let angle = CGFloat(index) * CGFloat.pi / 6
        let inner: CGFloat = 3.0
        let outer: CGFloat = 4.4
        let half: CGFloat = CGFloat.pi / 18
        let p1 = NSPoint(x: sunCenter.x + cos(angle - half) * inner, y: sunCenter.y + sin(angle - half) * inner)
        let p2 = NSPoint(x: sunCenter.x + cos(angle) * outer, y: sunCenter.y + sin(angle) * outer)
        let p3 = NSPoint(x: sunCenter.x + cos(angle + half) * inner, y: sunCenter.y + sin(angle + half) * inner)
        let ray = NSBezierPath()
        ray.move(to: p1)
        ray.line(to: p2)
        ray.line(to: p3)
        ray.close()
        ray.fill()
    }
    NSBezierPath(ovalIn: NSRect(x: sunCenter.x - 2.2, y: sunCenter.y - 2.2, width: 4.4, height: 4.4)).fill()

    let check = NSBezierPath()
    check.move(to: NSPoint(x: 13.0, y: 7.0))
    check.line(to: NSPoint(x: 16.3, y: 3.8))
    check.line(to: NSPoint(x: 22.2, y: 11.0))
    white.setStroke()
    check.lineWidth = 2.6
    check.lineCapStyle = .round
    check.lineJoinStyle = .round
    check.stroke()

    image.isTemplate = false
    return image
}

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private var timer: Timer?
    private var launchObserver: NSObjectProtocol?
    private let io = DispatchQueue(label: "ClaudeTW.files")
    private let runner = ProcessRunner()
    private var snapshot = MenuSnapshot()
    private var refreshing = false
    private var changingState = false
    private var rebuildingIndex = false
    private var actionMessage: String?
    private var actionDetail: String?
    private var showIndexResult = false
    private var updating = false
    private var updateMessage = "檢查更新；僅下載與暫存，尚未提供安裝"
    private var indexItem: NSMenuItem!
    private var updateItem: NSMenuItem!
    private var quitItem: NSMenuItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: 30)
        item.button?.toolTip = "Claude 繁體中文（離線字典）"
        buildMenu()
        refresh()
        // The existing launch agent wakes this helper; once alive, observe Claude
        // launches without a shell polling loop or starting a translation server.
        launchObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleURL?.lastPathComponent == "Claude.app" else { return }
            self?.refresh()
            self?.rebuildIndex()
        }
        // One safe check per startup/Claude launch, never per status-poll tick.
        // This is independent of dictionary preload and cannot approve an app.
        rebuildIndex()
        let poll = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(poll, forMode: .common)
        timer = poll
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        if let observer = launchObserver { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        return rebuildingIndex || changingState || updating ? .terminateCancel : .terminateNow
    }

    func menuWillOpen(_ menu: NSMenu) { refresh() }

    private func refresh() {
        guard !refreshing else { return }
        refreshing = true
        io.async {
            let next = MenuSnapshot.load()
            DispatchQueue.main.async {
                self.snapshot = next
                self.refreshing = false
                self.render()
            }
        }
    }

    private func buildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        indexItem = NSMenuItem(title: "翻譯檢索", action: #selector(translationSearch), keyEquivalent: "r")
        indexItem.target = self
        menu.addItem(indexItem)
        updateItem = NSMenuItem(title: "更新", action: #selector(checkUpdate), keyEquivalent: "u")
        updateItem.target = self
        menu.addItem(updateItem)
        let githubItem = NSMenuItem(title: "GitHub", action: #selector(openGitHub), keyEquivalent: "")
        githubItem.target = self
        menu.addItem(githubItem)
        item.menu = menu
        buildSystemMenu()
        render()
    }

    // Standard app Hide/Quit remain outside the three-row status menu. No global
    // shortcuts, extra status-menu rows or arbitrary downloaded executable actions.
    private func buildSystemMenu() {
        let main = NSMenu()
        let application = NSMenuItem()
        main.addItem(application)
        let system = NSMenu(title: "ClaudeTW")
        system.autoenablesItems = false
        let hide = NSMenuItem(title: "隱藏 ClaudeTW", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        hide.target = NSApplication.shared
        system.addItem(hide)
        system.addItem(.separator())
        quitItem = NSMenuItem(title: "結束 ClaudeTW", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        system.addItem(quitItem)
        application.submenu = system
        NSApplication.shared.mainMenu = main
    }

    private func render() {
        item.button?.title = ""
        item.button?.image = makeMascotIcon(enabled: snapshot.enabled && snapshot.connected)
        item.button?.imagePosition = .imageOnly
        indexItem.toolTip = snapshot.detail
        if rebuildingIndex { indexItem.toolTip = "重新整合翻譯索引中；不會自動新增詞條" }
        indexItem.isEnabled = !rebuildingIndex && !changingState && !updating
        updateItem.toolTip = updateMessage
        updateItem.isEnabled = !updating && !rebuildingIndex && !changingState
        quitItem.isEnabled = !rebuildingIndex && !changingState && !updating
    }

    private func notice(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "好")
        NSApplication.shared.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func openGitHub() {
        if !NSWorkspace.shared.open(githubPage) {
            notice("無法開啟 GitHub", "請稍後再試。")
        }
    }

    @objc private func translationSearch() {
        guard !rebuildingIndex && !changingState && !updating else { return }
        showIndexResult = true
        rebuildIndex() // Existing action only; no new-word discovery/translation claim.
    }

    private func finishIndexNotice() {
        guard showIndexResult else { return }
        showIndexResult = false
        notice(actionMessage ?? "索引作業已結束",
               "此動作沿用既有索引重建，不會自動新增或翻譯未知詞條。")
    }

    @objc private func checkUpdate() {
        guard !updating && !rebuildingIndex && !changingState else { return }
        updating = true
        updateMessage = "正在檢查更新；未安裝任何更新"
        render()
        runUpdater(.check)
    }

    private func runUpdater(_ operation: UpdateOperation) {
        io.async {
            let configURL = runtimeURL.appendingPathComponent("update-config.json")
            let scriptURL = runtimeURL.appendingPathComponent("update.mjs")
            // Local trusted script/config only. URLs and artifact paths from the
            // child JSON can never choose a command, executable or browser target.
            let filesReady = [configURL, scriptURL].allSatisfy { url in
                guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else { return false }
                return values.isRegularFile == true && values.isSymbolicLink != true
            }
            let config: [String: Any]? = filesReady ? (try? readObject(configURL)) : nil
            let node = nodeExecutable()
            DispatchQueue.main.async {
                guard filesReady, config?["repository"] as? String == updateRepository, let node = node else {
                    self.finishUpdate("更新尚未就緒", "需要本機 update.mjs、Node.js 與指定倉庫的 update-config.json；未安裝任何更新。")
                    return
                }
                // check JSON can include the full manifest; the old 8 KiB log tail
                // is insufficient. Keep a bounded 2 MiB output read, never a pipe.
                self.runner.run(node, arguments: [scriptURL.path, operation.rawValue, "--config", configURL.path],
                                outputLimit: 2 * 1024 * 1024) { code, output in
                    guard code == 0, let reply = UpdateReply.parse(output, operation: operation) else {
                        self.finishUpdate("更新作業未完成", "檢查或驗證失敗；未安裝任何更新。請確認設定與連線後再試。")
                        return
                    }
                    self.handleUpdate(reply)
                }
            }
        }
    }

    private func handleUpdate(_ reply: UpdateReply) {
        switch reply.status {
        case "update-available":
            let alert = NSAlert()
            alert.messageText = "有可用更新 \(reply.version ?? "")"
            alert.informativeText = "只會下載、驗證並暫存最新穩定版本，尚未提供安裝功能；不會啟動下載的檔案。"
            alert.addButton(withTitle: "下載並暫存")
            alert.addButton(withTitle: "取消").keyEquivalent = "\u{1b}"
            NSApplication.shared.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn {
                updateMessage = "正在下載、驗證並暫存；尚未安裝"
                render()
                runUpdater(.stage)
            } else {
                updating = false
                updateMessage = "已取消下載；未安裝任何更新"
                render()
            }
        case "staged":
            finishUpdate("已暫存 \(reply.version ?? "")（尚未安裝）", "下載與驗證已完成；目前沒有安裝功能，未變更現用版本，也未啟動下載的檔案。")
        case "up-to-date":
            finishUpdate("目前沒有較新的穩定版本", "本次未安裝任何更新。")
        case "no-release":
            finishUpdate("尚無可用版本", "倉庫尚未公開或尚未發布版本；本次未安裝任何更新。")
        default:
            finishUpdate("更新回報無效", "未安裝任何更新。")
        }
    }

    private func finishUpdate(_ title: String, _ detail: String) {
        updating = false
        updateMessage = title
        render()
        notice(title, detail)
    }

    @objc private func toggle() {
        guard !changingState && !rebuildingIndex else { return }
        changingState = true
        let enabled = !snapshot.enabled
        render()
        io.async {
            do {
                try writeState(enabled: enabled)
                let next = MenuSnapshot.load()
                DispatchQueue.main.async {
                    self.snapshot = next
                    self.changingState = false
                    self.actionMessage = enabled ? "翻譯設定已開啟" : "翻譯設定已關閉"
                    self.actionDetail = "套用情況以補丁連線與畫面回報為準"
                    self.render()
                    if enabled {
                        self.runner.run(URL(fileURLWithPath: "/usr/bin/open"), arguments: ["/Applications/Claude.app"]) { code, output in
                            if code != 0 {
                                self.actionMessage = "Claude 開啟失敗（\(code)）"
                                self.actionDetail = "設定已儲存。\n\(output)"
                                self.render()
                            }
                        }
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.changingState = false
                    self.actionMessage = "設定儲存失敗（詳見提示）"
                    self.actionDetail = error.localizedDescription
                    self.render()
                }
            }
        }
    }

    @objc private func rebuildIndex() {
        guard !rebuildingIndex && !changingState else { return }
        guard !updating else { return }
        rebuildingIndex = true
        actionMessage = "正在驗證版本與核准紀錄…"
        actionDetail = "未完成前保留原索引、待整合狀態及未知數"
        render()
        io.async {
            let node = nodeExecutable()
            DispatchQueue.main.async {
                guard let node = node else {
                    self.rebuildingIndex = false
                    self.actionMessage = "重建失敗：找不到 Node.js"
                    self.actionDetail = "原索引與未知數保留"
                    self.render()
                    self.finishIndexNotice()
                    return
                }
                // The indexer owns installed-version and approved-app.json exact
                // hash validation. Never bypass its approval gate in the helper.
                self.runner.run(node, arguments: [runtimeURL.appendingPathComponent("index.mjs").path,
                                                  "--rebuild", "--runtime", runtimeURL.path]) { code, output in
                    self.rebuildingIndex = false
                    self.actionMessage = code == 0
                        ? "索引重建完成；未自動新增詞條"
                        : "索引重建失敗（\(code)）；原索引保留"
                    self.actionDetail = output.isEmpty ? "未提供程序輸出；未知文字仍保留待處理" : output
                    self.render()
                    self.refresh()
                    self.finishIndexNotice()
                }
            }
        }
    }

    @objc private func quit() {
        guard !rebuildingIndex && !changingState else { return }
        guard !updating else { return }
        NSApplication.shared.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
