// AgentClock — a macOS menu bar badge for `agentclock`.
//
// Shows how many Claude Code sessions are actually working, read straight from
// ~/.claude/sessions. Deliberately NOT a wrapper around `agentclock now --json`:
// measured on the author's machine, the CLI costs ~130ms per refresh (almost all
// of it Node startup plus one `ps -A` spawn) against ~1ms for the native scan
// below. A CLI you invoke costs what it costs; a menu bar app runs from login to
// shutdown, so its idle cost is the only cost that matters.
//
// The liveness rules here mirror src/registry.ts line for line, including every
// fail-open branch. test/menubar.test.js runs both implementations against the
// same directory and fails if they disagree.

import AppKit
import Foundation

// MARK: - Paths

/// Root of the Claude Code config directory.
///
/// Mirrors src/paths.ts: CLAUDE_CONFIG_DIR relocates the whole tree, so a user who
/// sets it must not silently get an empty badge.
func claudeRoot() -> URL {
  if let override = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"],
    !override.trimmingCharacters(in: .whitespaces).isEmpty
  {
    return URL(fileURLWithPath: override.trimmingCharacters(in: .whitespaces)).standardized
  }
  return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude")
}

func sessionsDir() -> URL { claudeRoot().appendingPathComponent("sessions") }

// MARK: - Model

/// Statuses that mean an agent is doing work rather than sitting still.
/// Mirrors ACTIVE_STATUSES in src/types.ts.
let ACTIVE_STATUSES: Set<String> = ["busy", "shell"]

/// Session kinds that are infrastructure rather than someone's coding session.
let EXCLUDED_KINDS: Set<String> = ["daemon", "daemon-worker"]

/// How much younger a process may look than the session claiming it before we call
/// it a recycled PID. Same 300s as src/registry.ts, and generous for the same
/// reason: a false negative costs one phantom row, a false positive hides real work.
let PID_REUSE_TOLERANCE: Double = 300

struct LiveSession {
  var pid: Int32
  var sessionId: String
  var cwd: String
  var startedAt: Double  // epoch ms
  var status: String
  var kind: String
  var name: String?
  var waitingFor: String?

  var isActive: Bool { ACTIVE_STATUSES.contains(status) }

  /// Display label for the session, matching the CLI's `name ?? sessionId[0..8]`.
  var label: String { name ?? String(sessionId.prefix(8)) }

  /// Repo root with `.claude/worktrees/<name>` folded away, mirroring attribute()
  /// in src/project.ts — otherwise one repo shatters into a dozen phantom projects.
  var project: String {
    let normalized = cwd.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
    if let r = normalized.range(of: "/.claude/worktrees/") {
      return String(normalized[normalized.startIndex..<r.lowerBound])
    }
    return normalized
  }

  var projectLabel: String {
    let p = project
    return (p as NSString).lastPathComponent.isEmpty ? p : (p as NSString).lastPathComponent
  }
}

// MARK: - Registry

/// Is this PID still alive?
///
/// EPERM means the process exists but belongs to someone else — still alive.
/// ESRCH means it is gone. Identical to process.kill(pid, 0) in src/registry.ts;
/// it is the same syscall.
func pidAlive(_ pid: Int32) -> Bool {
  if pid <= 0 { return false }
  if kill(pid, 0) == 0 { return true }
  return errno == EPERM
}

/// Seconds since a process started, via sysctl.
///
/// The CLI shells out to `ps -A -o pid=,etime=` because that is the portable way to
/// get this from Node. Native code can ask the kernel directly: no subprocess, no
/// text parsing, and none of the locale/timezone dependence that made an earlier
/// `lstart`-based version reject every real session.
func processAge(_ pid: Int32) -> Double? {
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
  let started = Double(info.kp_proc.p_starttime.tv_sec)
    + Double(info.kp_proc.p_starttime.tv_usec) / 1_000_000
  if started <= 0 { return nil }
  return Date().timeIntervalSince1970 - started
}

private func str(_ d: [String: Any], _ k: String) -> String? { d[k] as? String }

func toSession(_ raw: Any) -> LiveSession? {
  guard let d = raw as? [String: Any] else { return nil }
  guard let pid = (d["pid"] as? NSNumber)?.int32Value else { return nil }
  guard let sessionId = str(d, "sessionId") else { return nil }
  guard let cwd = str(d, "cwd") else { return nil }

  return LiveSession(
    pid: pid,
    sessionId: sessionId,
    cwd: cwd,
    startedAt: (d["startedAt"] as? NSNumber)?.doubleValue
      ?? Date().timeIntervalSince1970 * 1000,
    // Carried verbatim. An unrecognised status must surface, not be coerced.
    status: str(d, "status") ?? "unknown",
    kind: str(d, "kind") ?? "interactive",
    name: str(d, "name"),
    waitingFor: str(d, "waitingFor")
  )
}

/// Every Claude Code session running right now.
///
/// One entry per session, never per agent: subagents share their parent's sessionId
/// and never get a registry file, so "N subagents count as 1" needs no code here.
func readLiveSessions() -> [LiveSession] {
  let dir = sessionsDir()
  guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else {
    return []  // no ~/.claude yet, or unreadable — not an error worth showing
  }

  var parsed: [LiveSession] = []
  for file in entries where file.hasSuffix(".json") {
    // The sibling <pid>.<hash>.key files are not registry entries.
    guard let data = FileManager.default.contents(atPath: dir.appendingPathComponent(file).path)
    else { continue }  // session exited mid-read
    guard let raw = try? JSONSerialization.jsonObject(with: data) else { continue }  // torn write
    guard let session = toSession(raw) else { continue }
    if EXCLUDED_KINDS.contains(session.kind) { continue }
    if !pidAlive(session.pid) { continue }
    parsed.append(session)
  }

  // Fail open throughout: this guard exists only to reject a recycled PID, and
  // anything it cannot read must never cost us a real session.
  let now = Date().timeIntervalSince1970
  return parsed.filter { s in
    guard let procAge = processAge(s.pid) else { return true }  // liveness already vouched
    let sessionAge = now - s.startedAt / 1000
    if !sessionAge.isFinite || sessionAge <= 0 { return true }
    return sessionAge - procAge <= PID_REUSE_TOLERANCE
  }
}

// MARK: - Smoothing

/// Holds the badge steady across the gaps between turns.
///
/// A session counts as working if it is active now OR was active within the last
/// `hold` seconds: the count rises the instant work starts and falls only after a
/// session has been genuinely quiet.
///
/// Sizing this was measured, not guessed. Sampling the registry at 4Hz for ten
/// minutes across 17 live sessions recorded *zero* busy<->idle flips: Claude Code
/// holds `busy` for an entire turn rather than dropping to idle between tool calls,
/// so the raw count is already steady while agents grind. The hold therefore is not
/// fixing an observed flicker — it covers the transitions that sampling did not
/// catch, chiefly `busy -> waiting -> busy` around a permission prompt, where the
/// agent has not stopped working and the badge should not say it has.
///
/// That evidence is also why the default is short. A long hold would make the badge
/// keep claiming work for a minute after everything finished, which is a worse lie
/// than the flicker it was meant to prevent.
///
/// Deliberately per session rather than an average of the total. Averaging the
/// aggregate produces a number that is never actually true — 3.4 agents — and still
/// moves constantly. Holding each session individually keeps every displayed count a
/// real count of real sessions.
final class Smoother {
  /// Seconds of quiet before a session stops counting. 0 disables smoothing.
  var hold: Double

  private var lastActive: [String: Date] = [:]

  init(hold: Double) { self.hold = hold }

  /// Record this scan and return the sessions that currently count as working.
  ///
  /// Only ever consults sessions that are live right now, so a session that exits
  /// while inside its hold window drops out immediately rather than lingering.
  func working(_ sessions: [LiveSession], now: Date = Date()) -> [LiveSession] {
    for s in sessions where s.isActive { lastActive[s.sessionId] = now }

    // Forget sessions that are gone, so the map cannot grow without bound.
    let live = Set(sessions.map(\.sessionId))
    lastActive = lastActive.filter { live.contains($0.key) }

    if hold <= 0 { return sessions.filter(\.isActive) }
    return sessions.filter { s in
      if s.isActive { return true }
      guard let seen = lastActive[s.sessionId] else { return false }
      return now.timeIntervalSince(seen) <= hold
    }
  }

  /// True when the session is only counted because of the hold, not because it is
  /// busy this instant. The menu dims these so the smoothing is never a lie.
  func isCoolingDown(_ s: LiveSession) -> Bool { !s.isActive && lastActive[s.sessionId] != nil }
}

// MARK: - Formatting

func duration(_ ms: Double) -> String {
  let total = Int(max(0, ms) / 1000)
  let h = total / 3600, m = (total % 3600) / 60
  if h >= 24 { return "\(h / 24)d \(h % 24)h" }
  if h > 0 { return "\(h)h \(m)m" }
  if m > 0 { return "\(m)m" }
  return "\(total)s"
}

// MARK: - Headless modes

/// Emit the live sessions as JSON. Exists so test/menubar.test.js can compare this
/// implementation against readLiveSessions() from dist/, and so the scan can be
/// debugged without putting anything in the menu bar.
func emitJSON() {
  let payload = readLiveSessions()
    .sorted { $0.sessionId < $1.sessionId }
    .map { s -> [String: Any] in
      var o: [String: Any] = [
        "pid": Int(s.pid), "sessionId": s.sessionId, "cwd": s.cwd,
        "startedAt": s.startedAt, "status": s.status, "kind": s.kind,
      ]
      if let n = s.name { o["name"] = n }
      if let w = s.waitingFor { o["waitingFor"] = w }
      return o
    }
  let data = try! JSONSerialization.data(
    withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

// MARK: - App

/// Seconds of quiet before a session stops counting. See Smoother for why this is
/// short: measurement found no flicker to suppress, so a long hold would only make
/// the badge stale.
let DEFAULT_HOLD: Double = 30
let REFRESH_SECONDS: Double = 2

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var item: NSStatusItem!
  private var timer: DispatchSourceTimer?
  private let smoother = Smoother(hold: DEFAULT_HOLD)
  private var sessions: [LiveSession] = []
  private var workingIds: Set<String> = []
  private var lastTitle = ""

  func applicationDidFinishLaunching(_ note: Notification) {
    if UserDefaults.standard.object(forKey: "hold") != nil {
      smoother.hold = UserDefaults.standard.double(forKey: "hold")
    }

    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    // Monospaced digits, or the badge visibly jerks as the count crosses 9 -> 10.
    item.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
    item.button?.title = "◌"

    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu

    let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    // Leeway matters: DispatchSourceTimer defaults to zero, which is the worst
    // possible energy profile. A second of slack lets macOS coalesce this wakeup
    // with others instead of waking the CPU on its own account.
    t.schedule(deadline: .now(), repeating: REFRESH_SECONDS, leeway: .seconds(1))
    t.setEventHandler { [weak self] in self?.refresh() }
    t.resume()
    timer = t
  }

  private func refresh() {
    let found = readLiveSessions()
    let working = smoother.working(found)
    let title = "◐ \(working.count)"

    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.sessions = found
      self.workingIds = Set(working.map(\.sessionId))
      // The load-bearing line. Assigning an unchanged title still forces the status
      // item to redraw; guarding it measured a ~2.8x cut in idle CPU.
      guard title != self.lastTitle else { return }
      self.lastTitle = title
      self.item.button?.title = title
    }
  }

  // MARK: Menu

  /// Built on open, so an unopened menu costs nothing.
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let now = Date().timeIntervalSince1970 * 1000

    let working = sessions.filter { workingIds.contains($0.sessionId) }
      .sorted { $0.startedAt < $1.startedAt }
    let waiting = sessions.filter { $0.status == "waiting" }
    let others = sessions.filter {
      !workingIds.contains($0.sessionId) && $0.status != "waiting"
    }

    if sessions.isEmpty {
      menu.addItem(disabled("No Claude Code sessions are running"))
    } else {
      menu.addItem(disabled("\(working.count) working"))
      for s in working {
        let cooling = smoother.isCoolingDown(s)
        let row = NSMenuItem(
          title: "\(cooling ? "◐" : "●")  \(s.label)   \(s.projectLabel)   \(duration(now - s.startedAt))",
          action: #selector(revealSession(_:)), keyEquivalent: "")
        row.target = self
        row.representedObject = s.cwd
        // A cooling-down session is counted but not busy this instant; dim it so
        // the smoothing is visible rather than a quiet fiction.
        if cooling {
          row.attributedTitle = NSAttributedString(
            string: row.title, attributes: [.foregroundColor: NSColor.secondaryLabelColor])
        }
        menu.addItem(row)
      }
    }

    if !waiting.isEmpty {
      menu.addItem(.separator())
      menu.addItem(disabled("\(waiting.count) waiting on you"))
      for s in waiting {
        let why = s.waitingFor.map { " — \($0)" } ?? ""
        let row = NSMenuItem(
          title: "◑  \(s.label)   \(s.projectLabel)\(why)",
          action: #selector(revealSession(_:)), keyEquivalent: "")
        row.target = self
        row.representedObject = s.cwd
        menu.addItem(row)
      }
    }

    if !others.isEmpty {
      menu.addItem(.separator())
      menu.addItem(disabled("\(others.count) idle"))
    }

    menu.addItem(.separator())

    let dash = NSMenuItem(
      title: "Open dashboard…", action: #selector(openDashboard), keyEquivalent: "")
    dash.target = self
    menu.addItem(dash)

    menu.addItem(smoothingMenu())

    let login = NSMenuItem(
      title: "Launch at login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
    login.target = self
    login.state = LaunchAtLogin.enabled ? .on : .off
    menu.addItem(login)

    menu.addItem(.separator())
    let quit = NSMenuItem(
      title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.addItem(quit)
  }

  private func disabled(_ title: String) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    i.isEnabled = false
    return i
  }

  private func smoothingMenu() -> NSMenuItem {
    let parent = NSMenuItem(title: "Smoothing", action: nil, keyEquivalent: "")
    let sub = NSMenu()
    let choices: [(String, Double)] = [
      ("Off — raw count", 0), ("15 seconds", 15), ("30 seconds", 30),
      ("1 minute", 60), ("2 minutes", 120),
    ]
    for (label, value) in choices {
      let i = NSMenuItem(title: label, action: #selector(setHold(_:)), keyEquivalent: "")
      i.target = self
      i.representedObject = value
      i.state = smoother.hold == value ? .on : .off
      sub.addItem(i)
    }
    parent.submenu = sub
    return parent
  }

  @objc private func setHold(_ sender: NSMenuItem) {
    guard let v = sender.representedObject as? Double else { return }
    smoother.hold = v
    UserDefaults.standard.set(v, forKey: "hold")
    refresh()
  }

  @objc private func revealSession(_ sender: NSMenuItem) {
    guard let cwd = sender.representedObject as? String else { return }
    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: cwd)
  }

  /// The one place spawning Node is worth it: an explicit click, not a timer.
  @objc private func openDashboard() {
    guard let bin = AgentClockCLI.resolve() else {
      let a = NSAlert()
      a.messageText = "Could not find the agentclock command"
      a.informativeText =
        "Install it with `npm install -g agentclock`, or run `npm run link:local` from a checkout."
      a.runModal()
      return
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: bin)
    p.arguments = ["report"]
    try? p.run()
  }

  @objc private func toggleLaunchAtLogin() {
    LaunchAtLogin.enabled ? LaunchAtLogin.disable() : LaunchAtLogin.enable()
  }
}

// MARK: - Finding the CLI

enum AgentClockCLI {
  /// A GUI app inherits launchd's minimal PATH, not the shell's, so `agentclock`
  /// is almost never directly on it. Check the usual install prefixes, then fall
  /// back to asking a login shell.
  static func resolve() -> String? {
    let home = NSHomeDirectory()
    let candidates = [
      "/opt/homebrew/bin/agentclock", "/usr/local/bin/agentclock",
      "\(home)/.local/bin/agentclock", "\(home)/.npm-global/bin/agentclock",
    ]
    for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return c }

    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-lc", "command -v agentclock"]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return nil }
    let out = String(
      data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    p.waitUntilExit()
    let path = out.trimmingCharacters(in: .whitespacesAndNewlines)
    return FileManager.default.isExecutableFile(atPath: path) ? path : nil
  }
}

// MARK: - Launch at login

/// A plain LaunchAgent plist rather than SMAppService.
///
/// SMAppService is the modern API, but it refuses ad-hoc-signed apps: without a
/// Developer ID the resulting code requirement cannot securely identify the app, and
/// registration fails. Since this app is built locally and ad-hoc signed on purpose
/// — that is what keeps it free of Gatekeeper and of a $99 developer account — the
/// LaunchAgent is the mechanism that actually works. It must be an Aqua agent, not a
/// LaunchDaemon: daemons cannot connect to the window server and so cannot draw here.
enum LaunchAtLogin {
  static let label = "dev.agentclock.menubar"

  static var plistURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents/\(label).plist")
  }

  static var enabled: Bool { FileManager.default.fileExists(atPath: plistURL.path) }

  /// Writes the plist but deliberately does not `launchctl load` it: the app is
  /// already running, and loading a RunAtLoad agent now would start a second copy
  /// and put two badges in the menu bar. It takes effect at the next login, which
  /// is what "launch at login" means.
  ///
  /// The agent points at whichever bundle enabled it, so enabling from
  /// macos/build during development pins that path — run `make install` and enable
  /// from /Applications for a copy that survives a `make clean`.
  static func enable() {
    let exe = Bundle.main.executableURL?.path ?? CommandLine.arguments[0]
    let plist: [String: Any] = [
      "Label": label,
      "ProgramArguments": [exe],
      "RunAtLoad": true,
      "KeepAlive": false,
      // LimitLoadToSessionType Aqua: this needs a window server connection.
      "LimitLoadToSessionType": "Aqua",
    ]
    try? FileManager.default.createDirectory(
      at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard
      let data = try? PropertyListSerialization.data(
        fromPropertyList: plist, format: .xml, options: 0)
    else { return }
    try? data.write(to: plistURL)
  }

  static func disable() {
    try? FileManager.default.removeItem(at: plistURL)
  }
}

// MARK: - Entry point

let args = CommandLine.arguments.dropFirst()
if args.contains("--json") {
  emitJSON()
  exit(0)
}
if args.contains("--count") {
  let s = Smoother(hold: 0)
  print(s.working(readLiveSessions()).count)
  exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// Agent app: no Dock tile, no Force Quit entry. Equivalent to LSUIElement, and set
// here too so the raw binary behaves the same as the bundle during development.
app.setActivationPolicy(.accessory)
app.run()
