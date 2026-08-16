# Changelog

Notable changes to agentclock. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **agentclock reads more than one coding agent.** Codex joins Claude Code, in one
  report: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, honouring `CODEX_HOME`.
  Working time comes from Codex's own `task_complete` event — `started_at` and
  `completed_at`, else `duration_ms`, else the `task_started` line paired with the
  `task_complete` line — so "active time is exact or absent" is unchanged.
- `--agent <ids>` narrows any command to `claude`, `codex`, or a list. With no
  flag, every agent found on the machine is read.
- `agentclock agents` lists what is installed, where it lives, and whether it can
  report live state.
- The dashboard gains a per-agent breakdown, an agent tag wherever a row could come
  from either agent, and a heading naming the agents it covers. `stats` gains a
  **by agent** block, `now` an agent column. The one-pager titles and footnotes
  itself the same way.

### Changed

- Sessions are keyed by agent *and* id everywhere — the archive and the concurrency
  sweep both. Agents mint ids independently, and a bare id would let one agent's
  session close another's interval.
- The archive is now `v: 2`, carrying the agent. `v: 1` lines still load, as Claude
  Code sessions, because that is all agentclock could read when it wrote them.
  Nothing needs migrating by hand.
- `registry.ts` and `transcripts.ts` are gone. Adapters live in `src/agents/`, the
  scan loop in `src/scan.ts`, and the pid/`ps` helpers in `src/proc.ts`. Adding an
  agent is one file plus one line in `src/agents/index.ts`.
- **`agentclock now --json` changed shape**, from a bare array of sessions to
  `{ "sessions": [...], "blind": [...] }`, where `blind` names the selected agents
  that cannot report live state. A script doing `agentclock now --json | jq length`
  wants `.sessions | length` now. The array alone could not say the difference
  between "Codex has nothing running" and "Codex cannot be asked". Each session
  object also gains an `agent` field.
- The macOS menu bar app is unaffected: it reads `~/.claude/sessions` directly
  rather than shelling out to the CLI. `test/menubar.test.js` now cross-checks it
  against `src/agents/claude.ts`, which is where the liveness rules moved.

### Notes

Concurrency still counts **sessions**, not agents: a Claude Code session and a Codex
session working at the same moment count as two, and a session running five
subagents still counts as one.

Two things Codex cannot do are stated rather than papered over. It publishes no live
registry, so `now` and `watch` name it as unreadable instead of showing an empty list
that would read as "no Codex sessions are running". And cold rollouts are
zstd-compressed, which Node 18 cannot decompress, so the skipped count is printed.

Gemini CLI and Amp are not shipped because their session files carry no per-turn
timing — every session would report zero working time. opencode and Cursor are not
shipped because they store history in SQLite, which would cost a runtime dependency.

## [0.2.0] — 2026-08-16

### Added

- `agentclock pdf` writes a one-page A4 summary meant to be handed to someone
  else: the vital numbers, then the most productive day in the window — its
  agent work, wall clock, sessions, peak concurrency and busiest hour, a
  24-hour strip of what was running over the per-hour agent counts, and where
  that day's time went. Below that, work per day and the projects that took it.
  Honours `--since`, `--all`, `--anonymize`, `-o` and `--no-open`.
- `npm run link:local` and `npm run unlink:local` — `npm link` with a build in
  front, so a checkout or a git worktree can be run as the real `agentclock`
  command.

### Notes

The PDF is emitted directly, in PDF 1.4, with no library and no headless
browser: zero runtime dependencies is worth more than the code it would save.
Text is real Helvetica with AFM widths, so right-aligned columns line up, and
it stays selectable. One page is a hard rule — a section that cannot fit is
summed into an "N others" row rather than spilling onto a second sheet.

## [0.1.0] — 2026-08-16

First public release.

### Added

- `agentclock now` — what is running right now, read from
  `~/.claude/sessions/`.
- `agentclock stats` — historical summary in the terminal: sessions, agent
  work, concurrency, days and projects.
- `agentclock report` (the default) — a self-contained HTML dashboard that
  renders offline with no network and no external assets.
- `agentclock timeline` — per-day activity, expandable into per-session lanes,
  with timeline zoom (`--hours`) and per-hour parallel counts.
- `agentclock watch` — live view refreshing in place, at `--interval` seconds.
- A durable archive at `~/.agentclock/archive.jsonl`, so history outlives
  Claude Code's 30-day transcript sweep. `--no-archive` opts out.
- `--since`, `--all`, `--anonymize`, `--json` and `--verbose` across the
  commands.

### Notes

A session with N subagents counts as one. Active time comes from Claude Code's
own `turn_duration.durationMs` — it is exact or absent, never estimated.
Nothing is sent anywhere.

[Unreleased]: https://github.com/al-muammar/agentclock/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/al-muammar/agentclock/releases/tag/v0.2.0
[0.1.0]: https://github.com/al-muammar/agentclock/releases/tag/v0.1.0
