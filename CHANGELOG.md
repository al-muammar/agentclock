# Changelog

Notable changes to agentclock. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
