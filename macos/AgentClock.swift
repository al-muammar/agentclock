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

func projectsDir() -> URL { claudeRoot().appendingPathComponent("projects") }

/// Where agentclock keeps its own state. Mirrors agentclockDir() in src/paths.ts,
/// AGENTCLOCK_DIR override included — the tests rely on it to point both
/// implementations at one fixture.
func agentclockDir() -> URL {
  if let override = ProcessInfo.processInfo.environment["AGENTCLOCK_DIR"],
    !override.trimmingCharacters(in: .whitespaces).isEmpty
  {
    return URL(fileURLWithPath: override.trimmingCharacters(in: .whitespaces)).standardized
  }
  return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".agentclock")
}

/// The quota snapshot the CLI writes. See src/usagecache.ts for the contract.
func quotaCachePath() -> URL { agentclockDir().appendingPathComponent("usage.json") }

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

// MARK: - Subagents

/// One subagent transcript belonging to a live session.
/// Mirrors LiveSubagent in src/types.ts.
struct LiveSubagent {
  var agentId: String
  var agentType: String?
  var startedAt: Double?  // epoch ms
  var lastWriteAt: Double  // epoch ms
  var running: Bool
}

/// Seconds an agent may go without writing before it stops counting. Same 30
/// minutes as STALE_CAP_MS in src/subagents.ts, and measured the same way: the
/// longest gap inside a real run was 1626s, so this never cuts off live work, but
/// it does stop an aborted agent counting forever.
let SUBAGENT_STALE_CAP: Double = 30 * 60

let TAIL_WINDOW = 256 * 1024
let PARENT_WINDOW = 4 * 1024 * 1024

/// Directory name Claude Code derives from a working directory.
///
/// Every character that is not alphanumeric becomes `-`. Deliberately walks UTF-16
/// code units rather than characters: the TypeScript is a JavaScript regex, which
/// is defined over UTF-16, so a surrogate pair must produce two dashes on both
/// sides or test/menubar.test.js will find the difference.
func slugFor(_ cwd: String) -> String {
  var trimmed = Substring(cwd)
  while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }

  var units: [UInt16] = []
  let dash = UInt16(45)
  for u in String(trimmed).utf16 {
    let isDigit = u >= 48 && u <= 57
    let isUpper = u >= 65 && u <= 90
    let isLower = u >= 97 && u <= 122
    units.append(isDigit || isUpper || isLower ? u : dash)
  }
  return String(decoding: units, as: UTF16.self)
}

func subagentsDir(_ s: LiveSession) -> URL {
  projectsDir().appendingPathComponent(slugFor(s.cwd)).appendingPathComponent(s.sessionId)
    .appendingPathComponent("subagents")
}

func parentTranscript(_ s: LiveSession) -> URL {
  projectsDir().appendingPathComponent(slugFor(s.cwd))
    .appendingPathComponent("\(s.sessionId).jsonl")
}

/// Read at most `length` bytes starting at `start`. Invalid UTF-8 at a window edge
/// is replaced rather than rejected, matching Buffer.toString('utf8').
func readWindow(_ url: URL, _ start: UInt64, _ length: Int) -> String? {
  if length <= 0 { return nil }
  guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
  defer { try? handle.close() }
  if start > 0 {
    guard (try? handle.seek(toOffset: start)) != nil else { return nil }
  }
  guard let data = try? handle.read(upToCount: length) else { return nil }
  return String(decoding: data, as: UTF8.self)
}

/// Last complete line of a chunk read from `offset`.
func lastCompleteLine(_ chunk: String, _ offset: UInt64) -> String? {
  var lines = chunk.split(separator: "\n", omittingEmptySubsequences: true)
  // A window that does not start at byte 0 almost certainly cuts the first line.
  if offset > 0 && lines.count > 1 { lines.removeFirst() }
  guard let last = lines.last else { return nil }
  return String(last)
}

/// Does this record mean the agent returned?
///
/// An assistant record with `stop_reason: "end_turn"` and no open tool call. 407 of
/// 474 real transcripts end that way; the rest are covered by the parent's
/// completion notification. Anything unrecognised is deliberately not terminal —
/// over-reporting an agent is the cheap mistake. Same rule as src/subagents.ts.
func isTerminalRecord(_ line: String) -> Bool {
  guard let data = line.data(using: .utf8) else { return false }
  guard let raw = try? JSONSerialization.jsonObject(with: data) else { return false }
  guard let d = raw as? [String: Any] else { return false }
  guard (d["type"] as? String) == "assistant" else { return false }
  guard let message = d["message"] as? [String: Any] else { return false }
  guard (message["stop_reason"] as? String) == "end_turn" else { return false }

  if let content = message["content"] as? [Any] {
    for part in content {
      if let p = part as? [String: Any], (p["type"] as? String) == "tool_use" { return false }
    }
  }
  return true
}

/// Value of a `"key":"value"` pair, or nil. Cheap enough to run on one line.
private func stringField(_ line: String, _ key: String) -> String? {
  let needle = "\"\(key)\":\""
  guard let start = line.range(of: needle) else { return nil }
  guard let end = line.range(of: "\"", range: start.upperBound..<line.endIndex) else { return nil }
  return String(line[start.upperBound..<end.lowerBound])
}

private let isoParser: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()

/// First record timestamp in epoch ms: when the agent was spawned.
func firstTimestamp(_ head: String) -> Double? {
  for line in head.split(separator: "\n", omittingEmptySubsequences: true) {
    guard let stamp = stringField(String(line), "timestamp") else { continue }
    if let d = isoParser.date(from: stamp) { return d.timeIntervalSince1970 * 1000 }
    // Claude Code has written whole-second stamps too; try without fractions.
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    if let d = plain.date(from: stamp) { return d.timeIntervalSince1970 * 1000 }
  }
  return nil
}

/// Agent ids the parent has been told are finished, from one chunk of transcript.
///
/// The parent records `<task-notification>` blocks carrying the agent id and a
/// status; both `completed` and `failed` mean the agent is no longer running.
/// Scanned as raw text rather than parsed JSON — the blocks live inside an escaped
/// string field, and parsing multi-megabyte records to reach them is not worth it.
func completedIds(in chunk: String, into ids: inout Set<String>) {
  var cursor = chunk.startIndex
  while let open = chunk.range(of: "<task-id>", range: cursor..<chunk.endIndex) {
    guard let close = chunk.range(of: "</task-id>", range: open.upperBound..<chunk.endIndex)
    else { return }
    let id = String(chunk[open.upperBound..<close.lowerBound])
    cursor = close.upperBound

    // The status follows within the same notification block; 2000 units is the
    // same bound the TypeScript regex uses.
    let limit = chunk.index(close.upperBound, offsetBy: 2000, limitedBy: chunk.endIndex)
      ?? chunk.endIndex
    guard let sOpen = chunk.range(of: "<status>", range: close.upperBound..<limit),
      let sClose = chunk.range(of: "</status>", range: sOpen.upperBound..<chunk.endIndex)
    else { continue }
    let status = String(chunk[sOpen.upperBound..<sClose.lowerBound])
    if !id.isEmpty && !status.isEmpty && status != "running" { ids.insert(id) }
  }
}

/// Completion notifications seen in a parent transcript, cached across polls.
///
/// Grown incrementally: a poll reads only the bytes appended since the last one, so
/// a session that runs for hours costs one bounded read at the start and a few
/// kilobytes thereafter. This is what keeps the refresh affordable at 2s.
final class ParentScanner {
  private struct Scan {
    var size: UInt64
    var ids: Set<String>
  }
  private var cache: [String: Scan] = [:]

  func completed(_ url: URL) -> Set<String> {
    let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
    guard let size = (attrs?[.size] as? NSNumber)?.uint64Value else {
      return []  // no transcript: nothing has been reported finished
    }

    let known = cache[url.path]
    // A shrunk file is a different file — start over rather than trust the offset.
    let resumable = known != nil && known!.size <= size
    let from = resumable ? known!.size : (size > UInt64(PARENT_WINDOW) ? size - UInt64(PARENT_WINDOW) : 0)
    var ids = resumable ? known!.ids : Set<String>()

    if size > from {
      // Overlap the previous read: a notification block straddling the boundary
      // would otherwise be split in half and matched by neither pass.
      let start = from > 4096 ? from - 4096 : 0
      if let chunk = readWindow(url, start, Int(size - start)) {
        completedIds(in: chunk, into: &ids)
      }
      // Unreadable parent: report nothing finished, which counts agents as running.
    }

    cache[url.path] = Scan(size: size, ids: ids)
    return ids
  }

  /// Drop cached scans for sessions that are no longer live.
  func forget(keeping live: Set<String>) {
    cache = cache.filter { live.contains($0.key) }
  }
}

let parentScanner = ParentScanner()

/// Every subagent transcript belonging to one live session, with a verdict.
///
/// An agent counts as running when nothing says it stopped: no terminal record, no
/// completion notification in the parent, and a write inside the stale cap. Every
/// failure path leaves `running` true, matching readLiveSessions above and
/// src/subagents.ts — showing a phantom is far cheaper than hiding real work.
func readLiveSubagents(_ session: LiveSession, now: Double = Date().timeIntervalSince1970 * 1000)
  -> [LiveSubagent]
{
  let dir = subagentsDir(session)
  guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else {
    return []  // this session never spawned an agent
  }

  var agents: [LiveSubagent] = []
  var candidates: [Int] = []

  for entry in entries.sorted() {
    guard entry.hasPrefix("agent-"), entry.hasSuffix(".jsonl") else { continue }
    let agentId = String(entry.dropFirst(6).dropLast(6))
    if agentId.isEmpty { continue }

    let file = dir.appendingPathComponent(entry)
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
      let modified = attrs[.modificationDate] as? Date,
      let size = (attrs[.size] as? NSNumber)?.uint64Value
    else { continue }  // deleted between listing and stat

    let lastWriteAt = modified.timeIntervalSince1970 * 1000
    var agent = LiveSubagent(
      agentId: agentId, agentType: nil, startedAt: nil, lastWriteAt: lastWriteAt, running: true)

    if (now - lastWriteAt) / 1000 > SUBAGENT_STALE_CAP {
      agent.running = false
      agents.append(agent)
      continue
    }

    let offset = size > UInt64(TAIL_WINDOW) ? size - UInt64(TAIL_WINDOW) : 0
    if let chunk = readWindow(file, offset, Int(size - offset)),
      let tail = lastCompleteLine(chunk, offset)
    {
      agent.agentType = stringField(tail, "attributionAgent")
      if isTerminalRecord(tail) { agent.running = false }
    }
    // Unreadable: falls through as running.

    agents.append(agent)
    if agent.running { candidates.append(agents.count - 1) }
  }

  if !candidates.isEmpty {
    let finished = parentScanner.completed(parentTranscript(session))
    for i in candidates where finished.contains(agents[i].agentId) {
      agents[i].running = false
    }

    // Only a still-running agent needs a start time, and it costs a second read.
    for i in candidates where agents[i].running {
      let file = dir.appendingPathComponent("agent-\(agents[i].agentId).jsonl")
      if let head = readWindow(file, 0, 64 * 1024) {
        agents[i].startedAt = firstTimestamp(head)
        // The opening record is the prompt and carries no type; the reply does.
        if agents[i].agentType == nil {
          agents[i].agentType = stringField(head, "attributionAgent")
        }
      }
    }
  }

  agents.sort {
    ($0.startedAt ?? $0.lastWriteAt) < ($1.startedAt ?? $1.lastWriteAt)
  }
  return agents
}

/// Running subagents for every live session, keyed by session id.
func readLiveSubagents(for sessions: [LiveSession]) -> [String: [LiveSubagent]] {
  let now = Date().timeIntervalSince1970 * 1000
  var out: [String: [LiveSubagent]] = [:]
  var live = Set<String>()
  for s in sessions {
    live.insert(parentTranscript(s).path)
    out[s.sessionId] = readLiveSubagents(s, now: now)
  }
  parentScanner.forget(keeping: live)
  return out
}

/// Is this session doing work? Mirrors isWorking() in src/types.ts: wider than
/// `isActive`, because a session can sit `waiting` while a background agent grinds,
/// and calling that "not working" makes the agent tally describe sessions the
/// session count leaves out.
func isWorking(_ s: LiveSession, _ agents: [LiveSubagent]) -> Bool {
  s.isActive || agents.contains { $0.running }
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
  ///
  /// Agents are not smoothed and do not need to be: their signal comes from files
  /// on disk rather than a status field, so it does not flicker at turn
  /// boundaries. They feed in through isWorking, which means a session held up
  /// only by a background agent cools down exactly like any other.
  func working(_ sessions: [LiveSession], _ agents: [String: [LiveSubagent]] = [:], now: Date = Date())
    -> [LiveSession]
  {
    let live = Set(sessions.map(\.sessionId))
    let busy = { (s: LiveSession) in isWorking(s, agents[s.sessionId] ?? []) }

    for s in sessions where busy(s) { lastActive[s.sessionId] = now }

    // Forget sessions that are gone, so the map cannot grow without bound.
    lastActive = lastActive.filter { live.contains($0.key) }

    if hold <= 0 { return sessions.filter(busy) }
    return sessions.filter { s in
      if busy(s) { return true }
      guard let seen = lastActive[s.sessionId] else { return false }
      return now.timeIntervalSince(seen) <= hold
    }
  }

  /// True when the session is only counted because of the hold, not because it is
  /// working this instant. The menu dims these so the smoothing is never a lie.
  func isCoolingDown(_ s: LiveSession, _ agents: [LiveSubagent] = []) -> Bool {
    !isWorking(s, agents) && lastActive[s.sessionId] != nil
  }
}

// MARK: - Quota

/// One limit scope, as written by the CLI.
///
/// Deliberately a reader and nothing more: the fetch, the credential and the
/// response parsing all live in TypeScript. This app does not make network calls,
/// and keeping it that way is what lets it stay a two-second timer over a file.
struct QuotaScope {
  var key: String
  var label: String
  var left: Int
  var resetsAt: Double?  // epoch ms
}

struct QuotaSnapshot {
  var scopes: [QuotaScope]
  var fetchedAt: Double  // epoch ms
  /// The scope closest to exhaustion — the one that decides when work stops.
  var binding: QuotaScope? { scopes.min(by: { $0.left < $1.left }) }
}

/// Per-session token burn, measured from transcripts by the CLI.
struct SessionBurn {
  var sessionId: String
  var output: Int
  var cacheRead: Int
  var subagentOutput: Int
  var messages: Int
}

struct UsageFile {
  var quota: QuotaSnapshot?
  var burn: [String: SessionBurn]
}

/// Read the snapshot. Absent, unreadable or malformed all mean "no quota to show",
/// never a crash and never a blank badge — the count is the thing that must survive.
func readUsageFile() -> UsageFile {
  guard let data = try? Data(contentsOf: quotaCachePath()),
    let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
    (root["v"] as? Int) == 1
  else { return UsageFile(quota: nil, burn: [:]) }

  var scopes: [QuotaScope] = []
  for raw in (root["scopes"] as? [[String: Any]]) ?? [] {
    guard let key = raw["key"] as? String, let left = raw["left"] as? Int else { continue }
    scopes.append(
      QuotaScope(
        key: key,
        label: (raw["label"] as? String) ?? key,
        left: left,
        resetsAt: raw["resetsAt"] as? Double))
  }

  var burn: [String: SessionBurn] = [:]
  for raw in (root["sessions"] as? [[String: Any]]) ?? [] {
    guard let id = raw["sessionId"] as? String else { continue }
    burn[id] = SessionBurn(
      sessionId: id,
      output: (raw["output"] as? Int) ?? 0,
      cacheRead: (raw["cacheRead"] as? Int) ?? 0,
      subagentOutput: (raw["subagentOutput"] as? Int) ?? 0,
      messages: (raw["messages"] as? Int) ?? 0)
  }

  let quota =
    scopes.isEmpty
    ? nil
    : QuotaSnapshot(scopes: scopes, fetchedAt: (root["fetchedAt"] as? Double) ?? 0)
  return UsageFile(quota: quota, burn: burn)
}

// MARK: - Snapshot

/// One refresh's worth of state, computed off the main thread and handed to
/// whatever is rendering it — the badge, the HUD, or both.
///
/// It exists so exactly one place decides what working, waiting and idle mean. Two
/// renderers each partitioning the session list would drift, and the first symptom
/// would be a badge that disagrees with the list behind it.
struct Snapshot {
  var sessions: [LiveSession] = []
  var subagents: [String: [LiveSubagent]] = [:]
  var workingIds: Set<String> = []
  /// Counted only because of the smoother's hold, not because they are working
  /// this instant. Rendered dimmed, so the smoothing is visible rather than a
  /// quiet fiction. Computed during the scan because the Smoother is owned by the
  /// timer queue and must not be asked questions from the main thread.
  var coolingIds: Set<String> = []
  var usage = UsageFile(quota: nil, burn: [:])

  /// Counted as working, oldest first.
  var working: [LiveSession] {
    sessions.filter { workingIds.contains($0.sessionId) }.sorted { $0.startedAt < $1.startedAt }
  }

  var waiting: [LiveSession] {
    sessions.filter { $0.status == "waiting" && !workingIds.contains($0.sessionId) }
  }

  var idle: [LiveSession] {
    sessions.filter { !workingIds.contains($0.sessionId) && $0.status != "waiting" }
  }

  /// Agents running inside the sessions being counted.
  ///
  /// Restricted to counted sessions on purpose: a number in parentheses that
  /// included work belonging to a session the badge says is not working would be
  /// unaccountable — the list behind the badge could not explain it.
  var fanOut: Int {
    sessions.filter { workingIds.contains($0.sessionId) }
      .reduce(0) { $0 + (subagents[$1.sessionId] ?? []).filter(\.running).count }
  }

  /// The scope closest to exhaustion. What the menu bar badge appends, because a
  /// badge is one line with no room to say which limit it means, and the limit that
  /// binds is the one that decides when work stops.
  var quotaLeft: Int? { usage.quota?.binding?.left }

  /// The five-hour window — what the HUD's tab shows.
  ///
  /// Deliberately not the binding scope: over a working day the weekly limit barely
  /// moves, so following the minimum pins the tab to a number that tells you nothing
  /// about whether you can keep going this afternoon. The card behind it lists both,
  /// and always includes the binding scope, so the one that actually bites is never
  /// more than a hover away.
  ///
  /// Falls back to the binding scope if the endpoint stops reporting `five_hour`, so
  /// a rename costs the preference rather than the number.
  var sessionQuota: QuotaScope? {
    guard let quota = usage.quota else { return nil }
    return quota.scopes.first { $0.key == "five_hour" } ?? quota.binding
  }

  /// Whether there is anything here worth lighting up for. The HUD rests at low
  /// opacity otherwise, which is what earns it a permanent place on the screen.
  var hasAttention: Bool { !workingIds.isEmpty || !waiting.isEmpty }
}

// MARK: - Formatting

/// "847", "231k", "1.2M" — mirrors tokens() in src/format.ts.
func tokenCount(_ n: Int) -> String {
  let v = Double(n)
  if n <= 0 { return "0" }
  if n < 1000 { return "\(n)" }
  if n < 1_000_000 { return String(format: n < 10_000 ? "%.1fk" : "%.0fk", v / 1000) }
  if n < 1_000_000_000 {
    return String(format: n < 10_000_000 ? "%.1fM" : "%.0fM", v / 1_000_000)
  }
  return String(format: "%.1fB", v / 1_000_000_000)
}

func duration(_ ms: Double) -> String {
  let total = Int(max(0, ms) / 1000)
  let h = total / 3600, m = (total % 3600) / 60
  if h >= 24 { return "\(h / 24)d \(h % 24)h" }
  if h > 0 { return "\(h)h \(m)m" }
  if m > 0 { return "\(m)m" }
  return "\(total)s"
}

// MARK: - The badge

/// `◐ 5` with nothing fanned out, `◐ 5 (12)` with twelve agents inside those five,
/// and ` · 42%` appended when a quota snapshot is on disk.
///
/// Quota is appended rather than leading: the session count is what this badge has
/// always meant, and a number that changes place depending on whether a cache file
/// happens to exist is a badge you cannot read at a glance. When there is no
/// snapshot the string is byte-for-byte what it was before quota existed.
func badgeTitle(_ working: Int, _ agents: Int, _ quotaLeft: Int? = nil) -> String {
  let base = agents > 0 ? "◐ \(working) (\(agents))" : "◐ \(working)"
  guard let left = quotaLeft else { return base }
  return "\(base) · \(left)%"
}

// MARK: - Headless modes

/// A snapshot with smoothing off, for the headless flags.
///
/// Hold is zero on purpose: these flags exist for test/menubar.test.js to compare
/// this implementation against the TypeScript, which has no smoother at all, so
/// they must report the raw instant rather than the badge's held view of it.
func headlessSnapshot() -> Snapshot {
  let sessions = readLiveSessions()
  let agents = readLiveSubagents(for: sessions)
  let working = Smoother(hold: 0).working(sessions, agents)
  return Snapshot(
    sessions: sessions, subagents: agents,
    workingIds: Set(working.map(\.sessionId)), coolingIds: [],
    usage: readUsageFile())
}

/// Emit the live sessions as JSON. Exists so test/menubar.test.js can compare this
/// implementation against readLiveSessions() from dist/, and so the scan can be
/// debugged without putting anything in the menu bar.
func emitJSON() {
  let sessions = readLiveSessions()
  let agents = readLiveSubagents(for: sessions)
  let payload = sessions
    .sorted { $0.sessionId < $1.sessionId }
    .map { s -> [String: Any] in
      var o: [String: Any] = [
        "pid": Int(s.pid), "sessionId": s.sessionId, "cwd": s.cwd,
        "startedAt": s.startedAt, "status": s.status, "kind": s.kind,
      ]
      if let n = s.name { o["name"] = n }
      if let w = s.waitingFor { o["waitingFor"] = w }
      o["agents"] = (agents[s.sessionId] ?? []).map { a -> [String: Any] in
        var e: [String: Any] = ["agentId": a.agentId, "running": a.running]
        if let t = a.agentType { e["agentType"] = t }
        return e
      }
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

/// How often to ask the CLI for a fresh quota snapshot.
///
/// The 130x argument that keeps Node out of the two-second tick is an argument
/// about cadence, not about spawning: quota moves on five-hour boundaries, so the
/// badge reads a file every two seconds and the fetch happens once a minute.
///
/// Measured at ~0.78s of CPU per refresh — Node startup, the incremental
/// transcript read for per-session burn, then the request — which is about 1.3% of
/// one core at this cadence. On the two-second tick the same work would be 40% of
/// a core, which is the whole reason it is not there. Anything faster than a
/// minute would also be rude to the endpoint.
let QUOTA_REFRESH_SECONDS: Double = 60

/// Where the numbers appear. The HUD is the default because a menu bar item can
/// only ever be one line of text, and on a notched Mac the system will silently
/// drop it when the bar runs out of room while `isVisible` keeps saying true.
enum DisplayMode: String {
  case hud
  case menubar
  case both

  static var current: DisplayMode {
    UserDefaults.standard.string(forKey: "display").flatMap(DisplayMode.init(rawValue:)) ?? .hud
  }

  var showsHUD: Bool { self != .menubar }
  var showsMenuBar: Bool { self != .hud }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, HUDDelegate {
  private var item: NSStatusItem?
  private var hud: HUDController?
  private var timer: DispatchSourceTimer?
  private let smoother = Smoother(hold: DEFAULT_HOLD)
  private var snapshot = Snapshot()
  private var lastTitle = ""
  private var lastQuotaRefresh: Double = 0
  private var refreshingQuota = false

  func applicationDidFinishLaunching(_ note: Notification) {
    if UserDefaults.standard.object(forKey: "hold") != nil {
      smoother.hold = UserDefaults.standard.double(forKey: "hold")
    }

    applyDisplayMode()

    let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    // Leeway matters: DispatchSourceTimer defaults to zero, which is the worst
    // possible energy profile. A second of slack lets macOS coalesce this wakeup
    // with others instead of waking the CPU on its own account.
    t.schedule(deadline: .now(), repeating: REFRESH_SECONDS, leeway: .seconds(1))
    t.setEventHandler { [weak self] in self?.refresh() }
    t.resume()
    timer = t
  }

  /// Build or tear down each renderer to match the preference.
  ///
  /// Both can be on at once, and at least one always is: `applyDisplayMode` is the
  /// only place that decides, so there is no path that leaves the app running with
  /// nothing on screen and no way to quit it.
  private func applyDisplayMode() {
    let mode = DisplayMode.current

    if mode.showsMenuBar, item == nil {
      let created = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
      // Monospaced digits, or the badge visibly jerks as the count crosses 9 -> 10.
      created.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
      created.button?.title = lastTitle.isEmpty ? "◌" : lastTitle
      let menu = NSMenu()
      menu.delegate = self
      created.menu = menu
      item = created
    } else if !mode.showsMenuBar, let existing = item {
      NSStatusBar.system.removeStatusItem(existing)
      item = nil
      lastTitle = ""
    }

    if mode.showsHUD, hud == nil {
      let controller = HUDController()
      controller.delegate = self
      controller.update(snapshot)
      hud = controller
    } else if !mode.showsHUD, let existing = hud {
      existing.teardown()
      hud = nil
    }
  }

  /**
   * Ask the CLI to refresh the quota snapshot, at most once a minute.
   *
   * Fire and forget, off the timer queue: the badge must never wait on a network
   * call. A missing CLI, a failed spawn or a fetch that cannot happen all leave
   * the previous snapshot in place, which is why the file is the source of truth
   * here rather than the process's exit code.
   */
  private func refreshQuotaIfDue(_ now: Double) {
    guard !refreshingQuota, now - lastQuotaRefresh >= QUOTA_REFRESH_SECONDS * 1000 else { return }
    refreshingQuota = true
    lastQuotaRefresh = now

    DispatchQueue.global(qos: .utility).async { [weak self] in
      defer { self?.refreshingQuota = false }
      guard let bin = AgentClockCLI.resolve() else { return }
      let p = Process()
      p.executableURL = URL(fileURLWithPath: bin)
      p.arguments = ["usage", "--json"]
      p.standardOutput = FileHandle.nullDevice
      p.standardError = FileHandle.nullDevice
      guard (try? p.run()) != nil else { return }
      p.waitUntilExit()
    }
  }

  private func refresh() {
    let found = readLiveSessions()
    let agents = readLiveSubagents(for: found)
    let working = smoother.working(found, agents)
    let counted = Set(working.map(\.sessionId))
    let next = Snapshot(
      sessions: found,
      subagents: agents,
      workingIds: counted,
      coolingIds: Set(
        found.filter { smoother.isCoolingDown($0, agents[$0.sessionId] ?? []) }.map(\.sessionId)),
      usage: readUsageFile())
    let title = badgeTitle(working.count, next.fanOut, next.quotaLeft)

    refreshQuotaIfDue(Date().timeIntervalSince1970 * 1000)

    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.snapshot = next
      // The HUD does its own guarding: it redraws cheaply and only resizes when the
      // pill's width actually changes.
      self.hud?.update(next)
      // The load-bearing line. Assigning an unchanged title still forces the status
      // item to redraw; guarding it measured a ~2.8x cut in idle CPU.
      guard title != self.lastTitle else { return }
      self.lastTitle = title
      self.item?.button?.title = title
    }
  }

  // MARK: Menu

  /// Built on open, so an unopened menu costs nothing.
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let now = Date().timeIntervalSince1970 * 1000

    // Quota leads: it is the number you open this menu to check, and it is the one
    // thing here that does not come off the local disk.
    if let quota = snapshot.usage.quota {
      if let binding = quota.binding {
        let head = NSMenuItem(
          title: "\(binding.left)% left of your \(binding.label)", action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
      }
      for scope in quota.scopes {
        let reset = scope.resetsAt.map { $0 > now ? "   resets in \(duration($0 - now))" : "" } ?? ""
        menu.addItem(disabled("      \(scope.label)   \(scope.left)% left\(reset)"))
      }
      // An old number must never pass for a current one.
      if quota.fetchedAt > 0, now - quota.fetchedAt > QUOTA_REFRESH_SECONDS * 4000 {
        menu.addItem(disabled("      measured \(duration(now - quota.fetchedAt)) ago"))
      }
      menu.addItem(.separator())
    }

    let running = { (s: LiveSession) in
      (self.snapshot.subagents[s.sessionId] ?? []).filter(\.running)
    }
    let working = snapshot.working
    let waiting = snapshot.waiting
    let others = snapshot.idle

    if snapshot.sessions.isEmpty {
      menu.addItem(disabled("No Claude Code sessions are running"))
    } else {
      let fanOut = snapshot.fanOut
      let header =
        fanOut > 0
        ? "\(working.count) working · \(fanOut) \(fanOut == 1 ? "agent" : "agents")"
        : "\(working.count) working"
      menu.addItem(disabled(header))
      for s in working {
        let mine = running(s)
        let cooling = snapshot.coolingIds.contains(s.sessionId)
        // Per-session burn, when the CLI has measured it. Exact token counts read
        // from this session's own transcript — never an estimate.
        let spend =
          snapshot.usage.burn[s.sessionId]
          .map { $0.output > 0 ? "   \(tokenCount($0.output))" : "" } ?? ""
        let row = NSMenuItem(
          title:
            "\(cooling ? "◐" : "●")  \(s.label)   \(s.projectLabel)   \(duration(now - s.startedAt))\(spend)",
          action: #selector(revealSession(_:)), keyEquivalent: "")
        row.target = self
        row.representedObject = s.cwd
        // A cooling-down session is counted but not working this instant; dim it so
        // the smoothing is visible rather than a quiet fiction.
        if cooling {
          row.attributedTitle = NSAttributedString(
            string: row.title, attributes: [.foregroundColor: NSColor.secondaryLabelColor])
        }
        menu.addItem(row)

        // Every agent in the badge's parenthetical gets a line here. Type and
        // elapsed time only — an agent's prompt is the user's own work.
        for a in mine {
          let since = a.startedAt ?? a.lastWriteAt
          let agentRow = NSMenuItem(
            title: "      └  \(a.agentType ?? "agent")   \(duration(now - since))",
            action: nil, keyEquivalent: "")
          agentRow.isEnabled = false
          menu.addItem(agentRow)
        }
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
    menu.addItem(displayMenu())
    // Also here, not only in the HUD's own menu: the status item is the easier
    // thing to click, and it is where someone goes looking when the HUD is on a
    // screen they want it off.
    if let screens = screenMenu() { menu.addItem(screens) }

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

  /// Which screen the HUD sits on. Absent on a one-screen Mac: a menu for a choice
  /// that does not exist is noise, and the item reappears the moment a display is
  /// plugged in.
  private func screenMenu() -> NSMenuItem? {
    let screens = NSScreen.screens
    guard screens.count > 1, let hud = hud else { return nil }
    let parent = NSMenuItem(title: "Screen", action: nil, keyEquivalent: "")
    let sub = NSMenu()
    for screen in screens {
      let i = NSMenuItem(
        title: screen.localizedName, action: #selector(setHUDScreen(_:)), keyEquivalent: "")
      i.target = self
      // By id, not by index: `NSScreen.screens` is rebuilt on every reconfiguration,
      // and a menu left open across one would otherwise point at the wrong display.
      i.representedObject = NSNumber(value: screen.displayID)
      i.state = hud.isOn(screen) ? .on : .off
      sub.addItem(i)
    }
    parent.submenu = sub
    return parent
  }

  private func displayMenu() -> NSMenuItem {
    let parent = NSMenuItem(title: "Show", action: nil, keyEquivalent: "")
    let sub = NSMenu()
    let choices: [(String, DisplayMode)] = [
      ("On the edge of the screen", .hud),
      ("In the menu bar", .menubar),
      ("Both", .both),
    ]
    for (label, mode) in choices {
      let i = NSMenuItem(title: label, action: #selector(setDisplayMode(_:)), keyEquivalent: "")
      i.target = self
      i.representedObject = mode.rawValue
      i.state = DisplayMode.current == mode ? .on : .off
      sub.addItem(i)
    }
    parent.submenu = sub
    return parent
  }

  /// The HUD's own menu. Shorter than the menu bar dropdown because the HUD already
  /// shows the list the dropdown exists to show — what is left is the controls.
  ///
  /// Quit lives here, and that is not a detail: with the status item switched off
  /// and no Dock tile, this menu is the only way out of the app.
  func hudContextMenu() -> NSMenu {
    let menu = NSMenu()
    let dash = NSMenuItem(
      title: "Open dashboard…", action: #selector(openDashboard), keyEquivalent: "")
    dash.target = self
    menu.addItem(dash)
    menu.addItem(.separator())
    menu.addItem(smoothingMenu())
    menu.addItem(displayMenu())
    if let screens = screenMenu() { menu.addItem(screens) }
    let login = NSMenuItem(
      title: "Launch at login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
    login.target = self
    login.state = LaunchAtLogin.enabled ? .on : .off
    menu.addItem(login)
    menu.addItem(.separator())
    menu.addItem(
      NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    return menu
  }

  func hudOpenDashboard() { openDashboard() }

  func hudReveal(_ cwd: String) {
    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: cwd)
  }

  @objc private func setHUDScreen(_ sender: NSMenuItem) {
    guard let id = (sender.representedObject as? NSNumber)?.uint32Value,
      let screen = NSScreen.screens.first(where: { $0.displayID == id })
    else { return }
    hud?.move(to: screen)
  }

  @objc private func setDisplayMode(_ sender: NSMenuItem) {
    guard let raw = sender.representedObject as? String else { return }
    UserDefaults.standard.set(raw, forKey: "display")
    applyDisplayMode()
    refresh()
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

/// Swift allows top-level statements only in `main.swift` or a single-file module,
/// and the HUD lives in its own file — so the entry point is an `@main` type rather
/// than a rename. `macos/AgentClock.swift` is named in package.json's `files`, in
/// test/menubar.test.js and in CLAUDE.md; none of that should move because a second
/// source file appeared.
@main
enum AgentClockApp {
  /// NSApplication holds its delegate weakly, so it lives here rather than on
  /// main()'s stack.
  private static let delegate = AppDelegate()

  static func main() {
    let args = CommandLine.arguments.dropFirst()
    if args.contains("--json") {
      emitJSON()
      exit(0)
    }
    if args.contains("--count") {
      print(headlessSnapshot().workingIds.count)
      exit(0)
    }
    // The exact string the menu bar would show. Exists so test/menubar.test.js can
    // assert on the badge itself rather than trusting it.
    if args.contains("--badge") {
      let s = headlessSnapshot()
      print(badgeTitle(s.workingIds.count, s.fanOut, s.quotaLeft))
      exit(0)
    }
    // The same for the HUD's pill, so the two renderers are held to the same counts.
    if args.contains("--hud") {
      print(hudSummary(headlessSnapshot()))
      exit(0)
    }
    // The quota snapshot as this app reads it. Exists so test/menubar.test.js can
    // hold the Swift reader equal to the TypeScript one on the same cache file.
    if args.contains("--usage") {
      let file = readUsageFile()
      var payload: [String: Any] = [:]
      if let q = file.quota {
        payload["fetchedAt"] = q.fetchedAt
        payload["scopes"] = q.scopes.map { s -> [String: Any] in
          var o: [String: Any] = ["key": s.key, "label": s.label, "left": s.left]
          if let r = s.resetsAt { o["resetsAt"] = r }
          return o
        }
        if let b = q.binding { payload["binding"] = b.key }
      }
      payload["sessions"] = file.burn.values
        .sorted { $0.sessionId < $1.sessionId }
        .map { ["sessionId": $0.sessionId, "output": $0.output, "cacheRead": $0.cacheRead] }
      let data = try! JSONSerialization.data(
        withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write("\n".data(using: .utf8)!)
      exit(0)
    }

    let app = NSApplication.shared
    app.delegate = delegate
    // Agent app: no Dock tile, no Force Quit entry. Equivalent to LSUIElement, and
    // set here too so the raw binary behaves the same as the bundle in development.
    app.setActivationPolicy(.accessory)
    app.run()
  }
}
