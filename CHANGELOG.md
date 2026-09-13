# Changelog

Notable changes to agentclock. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The macOS app now lives on the **right edge of your screen** rather than in the
  menu bar: a narrow black tab flush against the edge — rounded on its left side,
  square where it meets the edge — with a teal dot per working session stacked one
  above the next, a number for the idle ones, and a ring for
  the limit closest to running out. Point at it and it opens into the full readout
  — every quota scope with its reset countdown, each working session with its
  project, uptime, spend and agents, and anything waiting on you pulled to the top.
  Click to pin it open, click a row to reveal that session in Finder, right-click
  for the settings.
- The strip fades back when nothing is working, is draggable along the edge and
  remembers where you put it, stays visible over full-screen apps, and never takes
  focus. It needs no macOS permissions at all.
- Quota appears at the foot of both the strip and the card, with the percentage
  and the reset countdown for your session and weekly limits. The strip follows the
  **session limit** — the five-hour window — because across a working day the weekly
  number barely moves. The menu bar badge still follows whichever limit is closest
  to running out.

### Changed

- *Show* in the menu picks where the numbers appear: on the screen edge (the new
  default), in the menu bar as before, or both at once. The menu bar badge itself
  is unchanged.

## [0.5.0] — 2026-09-14

### Added

- `agentclock usage` reports how much of your quota is left: the limit closest to
  running out, then every scope the server knows about with its reset time. An
  unfamiliar limit shows up under its own key rather than being hidden.
- The same number rides on the menu bar badge — `◐ 4 (9) · 42%` — with the full
  breakdown in the dropdown. The badge is unchanged until you have run
  `agentclock usage` at least once.
- Underneath the quota, what your live sessions are actually spending: exact
  output and cache-read token counts read from the transcripts on your disk, plus
  how much of each session's output came from subagents working inside it.
  Subagent tokens roll into their parent and never become a session of their own.
- `--cached` reports the last snapshot without fetching; `--json` gives you the
  lot. `agentclock now` picks up a one-line quota summary when a snapshot exists,
  and never fetches on its own.

### Changed

- **agentclock now makes one network call.** The invariant was "no telemetry, no
  network calls, ever"; it is now "one network call, and only this one".
  `agentclock usage` asks Anthropic's `/api/oauth/usage` — the endpoint Claude
  Code's own `/usage` calls — using the credential Claude Code already stores in
  your Keychain, and sends nothing but that token. Every other number in the tool
  is still read from files on your disk. There is still no telemetry, no third
  party, and nothing about your code, your projects or your sessions leaves the
  machine.

  The exception exists because remaining quota is the one number that is not on
  disk anywhere, and cannot be estimated: across 40 recorded limit hits the
  five-hour window held anywhere from 2,745 to 1,053,232 output tokens when the
  limit fired — a 380× spread with no threshold in it. A local guess would warn
  constantly and stay silent when it mattered, so there isn't one.

  The first run prompts macOS for access to the Claude Code credential, through
  Apple-signed `/usr/bin/security`. Choose "Always Allow" and it won't ask again.
  Every other command still works with no credential at all.

### Notes

- The token is read, used and dropped — never logged, never cached, never written
  to disk. The snapshot in `~/.agentclock/usage.json` holds percentages, reset
  times and token counts.
- Everything fails open. A dead endpoint, an expired credential or a denied
  Keychain prompt shows the last snapshot with its age; a corrupt one costs the
  percentage and never the session count.
- The menu bar app still makes no network calls of its own. It runs
  `agentclock usage` once a minute and reads the snapshot on its normal
  two-second tick, which costs about 1.3% of one core on top of the app's own
  tenth of a percent — and only once you have used the command.
- `/api/oauth/usage` is internal to Claude Code and carries no compatibility
  promise. Parsing is deliberately defensive: an unrecognised shape costs the
  quota figures, not the run.

## [0.4.0] — 2026-08-28

### Added

- Live views now count the subagents running inside each session, not just the
  sessions. The menu bar badge reads `◐ 5 (12)` — five sessions working, twelve
  agents inside them — and its dropdown lists each agent under its session.
  `agentclock now` gains an `AGENTS` column and a line per running agent, and
  `now --json` gains an `agents` array on every session.

### Changed

- **A session counts as working when its only worker is a background agent.**
  Previously the count was sessions whose status is `busy` or `shell`; a session
  sitting `waiting` or `idle` while a background agent ground away was counted as
  not working. That made the agent tally describe sessions the session count left
  out. Expect the badge number to be slightly higher than before.

### Notes

- History is unchanged: a session with N subagents still counts as one
  everywhere in the report, the PDF and the archive. Subagent transcripts carry
  no `turn_duration`, so there is no exact agent time to report and none is
  invented.

## [0.3.0] — 2026-08-16

### Added

- `agentclock menubar` installs a macOS menu bar badge showing how many agents
  are working right now — the same count as the "N working" line, not the
  number of sessions you have open. Click it for the list: which sessions, in
  which projects, for how long, plus the ones waiting on you. It also offers
  *Open dashboard*, *Launch at login*, and a smoothing setting.
  `agentclock menubar uninstall` removes it.

### Notes

The menu bar app is optional, installed separately, and is the one resident
piece of agentclock — the CLI itself still starts nothing and leaves nothing
running. It costs about 20 MB of memory and 0.17% of one core, because it reads
`~/.claude/sessions` natively rather than running the CLI on a timer: ~1 ms per
refresh against ~130 ms to spawn Node.

It ships as Swift **source** and is compiled on your machine by one `swiftc`
call, so it needs the Xcode Command Line Tools but no Xcode project. That is
also what keeps it out of Gatekeeper's way: locally compiled code is never
quarantined, so there is no "unidentified developer" prompt and no developer
account. No binary is published to npm.

The count is smoothed — a session keeps counting until it has been quiet for
30 seconds, which covers the pause around a permission prompt. Sessions in that
tail are dimmed in the dropdown, so the smoothing is visible rather than
implied. Adjustable in the menu, off included.

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
own `turn_duration.durationMs` — it is exact or absent, never estimated. Only
`agentclock usage` touches the network, and only to read your own quota; nothing
about your code, your projects or your sessions is sent anywhere.

[Unreleased]: https://github.com/al-muammar/agentclock/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/al-muammar/agentclock/releases/tag/v0.5.0
[0.4.0]: https://github.com/al-muammar/agentclock/releases/tag/v0.4.0
[0.3.0]: https://github.com/al-muammar/agentclock/releases/tag/v0.3.0
[0.2.0]: https://github.com/al-muammar/agentclock/releases/tag/v0.2.0
[0.1.0]: https://github.com/al-muammar/agentclock/releases/tag/v0.1.0
