# agentclock

See how many coding-agent sessions you're running, how many are **actually working**,
and how long each one lives. Reads **Claude Code** and **Codex**, together, in one
report.

```sh
npx agentclock
```

No daemon, no install, nothing running in the background. agentclock reads what your
agents have already written to disk and derives the rest.

## Install

`npx agentclock` needs no install at all. To keep it around:

```sh
npm install -g agentclock
```

Node 18.17+, and no runtime dependencies — the install is one package.

## Why

Your agents know what their sessions are doing, but none of them keeps a record. Live
status vanishes when a session exits, and Claude Code deletes transcripts after 30
days. agentclock turns what's on disk into an answer:

- How many sessions are open right now, and how many are working versus waiting on you
- How much of your day had an agent actually running
- How often you run agents in parallel — and how often you don't
- Which projects the time went to, and which agent did it

**A session with five subagents counts as one session.** Subagents run inside their
parent and share its session id, so this falls out of the data model rather than
being a rule the tool applies. **Concurrency is per session, not per agent**: a Claude
Code session and a Codex session working at the same moment count as two.

## Usage

```sh
agentclock                # build the dashboard and open it
agentclock now            # what's running right now
agentclock watch          # live view, refreshing in place
agentclock timeline       # per-day activity timeline
agentclock stats          # historical summary in the terminal
agentclock pdf            # one-page PDF summary, for sharing
agentclock agents         # which agents are installed and readable
agentclock menubar        # install the macOS menu bar badge
agentclock report --since 7d --anonymize -o week.html
agentclock stats --agent codex
```

Without `--agent`, every agent found on the machine is read. Name one — or several,
`--agent claude,codex` — to narrow it.

`agentclock timeline` shows one row per day, midnight to midnight, so you can see
*when* agents were working rather than just how long:

```
             00      03      06      09      12      15      18      21
  Sat 15 Aug ██······················▇▃···▇████████▁·▁██·▇█████▃▁▅████  20h 31m  peak 5
  Fri 14 Aug ·▇··▃·····················▃▅···▇█▇····▅▇·····▃··········▅   2h 47m  peak 2
```

The dashboard has the same view with colour intensity for how many agents were
running at once, plus:

- **Click any day** to expand it into one lane per session, and a row of
  parallel-agent counts for each hour.
- **Drag across any row** to zoom into that interval, or use the presets.
  Double-click or press Esc to reset. `--hours 9-18` sets it from the CLI and
  works in the terminal view too.
- **Hourly distribution** with a day selector: pick all days or one day, and
  switch between sessions active, agents at once, and time worked. An hour
  counts a session if it was working at any point inside it, however briefly.

Zoom and the selector are the only things that use script; it is inline, and the
report still makes no network requests. With scripting off the full-day timeline
renders and days still expand.

### The one-pager

```sh
agentclock pdf --since 7d --anonymize -o week.pdf
```

`agentclock pdf` writes a single A4 page — the vital numbers, then the most
productive day in the window: how much work it held, how many sessions, how many
agents overlapped, which hour was busiest, and where its time went. Below that,
work per day and the projects that took it. It goes to `~/.agentclock/one-pager.pdf`
unless `-o` says otherwise.

It is a real PDF, written directly: no headless browser, no PDF library, and the
text stays selectable. That keeps the install a single package with no runtime
dependencies.

### The macOS menu bar app

```sh
agentclock menubar             # build and install it
agentclock menubar uninstall   # remove it again
```

Puts `◐ 4` in the menu bar: how many Claude Code sessions are working right now —
Codex publishes no live state, so nothing can badge it. Click it for
the list — which sessions, in which projects, for how long — plus *Open
dashboard*, *Launch at login* and a smoothing setting.

The app ships as source and is compiled on your machine — one `swiftc` call,
about five seconds. That is deliberate: code compiled locally is never
quarantined, so there is no Gatekeeper prompt, no notarization and no developer
account. It also means the npm package stays source-only rather than carrying a
prebuilt binary.

<!-- The pitch above is "no daemon, nothing resident", so be explicit here. -->
This is the one resident piece, and it is optional and installed separately — it
is not part of the npm package and `npx agentclock` never starts it. It costs
about **20 MB of memory and a tenth of a percent of one core**, because it reads
`~/.claude/sessions` directly rather than running the CLI on a timer: ~1 ms per
refresh against ~130 ms to spawn Node.

The count is **smoothed**: a session keeps counting until it has been quiet for 30
seconds, so the number rises the instant work starts and falls only once an agent
has genuinely stopped. Mostly this covers `busy → waiting → busy` around a
permission prompt, where the agent hasn't stopped working and the badge shouldn't
say it has. Sampling the registry at 4 Hz for ten minutes recorded no raw
flicker at all — Claude Code holds `busy` for a whole turn rather than toggling
between tool calls — which is why the window is deliberately short rather than a
minute. Sessions in the tail are dimmed in the dropdown, so the smoothing is
visible rather than a quiet fiction. Adjust it under *Smoothing*, or turn it off.

Requires macOS 11+ and the Xcode Command Line Tools (`xcode-select --install`) —
there is no Xcode project and nothing to download. `agentclock menubar` says so
if they are missing rather than failing with a compiler error.

### Options

| Flag | Meaning |
| --- | --- |
| `--agent <ids>` | Only these agents: `claude`, `codex`. Default: every one found. |
| `--since <window>` | Time window: `7d`, `24h`, `90m`. Default `30d`. |
| `--all` | No window — everything on disk. |
| `--anonymize` | Replace project and session names with stable pseudonyms. |
| `-o, --out <file>` | Where to write the dashboard or the PDF. |
| `--no-open` | Write the file without opening it. |
| `--hours <range>` | Zoom the timeline to a slice of the day: `9-18`, `09:30-13:00`. |
| `--interval <seconds>` | Refresh rate for `watch`. Default `2`. |
| `--no-archive` | Don't read or update `~/.agentclock/archive.jsonl`. |
| `--json` | Machine-readable output. |
| `--verbose` | Report parse throughput. |

Sharing a report? `--anonymize` replaces repository paths and session names with
stable pseudonyms — the same project always gets the same label, so the report is
still readable, just not about anyone in particular.

## How it works

Everything comes from files already on your disk:

| Source | Agent | Gives |
| --- | --- | --- |
| `~/.claude/sessions/<pid>.json` | Claude Code | Live state — one file per running session, with a status of `busy`, `waiting` or `idle`. |
| `~/.claude/projects/<slug>/*.jsonl` | Claude Code | History — every completed turn records its exact duration. |
| `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Codex | History — the turn-completion event carries the turn's own start, end and duration. |

Historical **busy** time is exact, not estimated. Claude Code writes a
`turn_duration` record carrying the real `durationMs` at the end of every turn, so a
turn that ended at 14:08:47 after six minutes becomes a span of 14:02:47–14:08:47.
Codex writes a `task_complete` event carrying `started_at`, `completed_at` and
`duration_ms`, which says the same thing.

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured if you've relocated either tree.

Reading 700 MB of session files takes about 3 seconds, because a substring check
before `JSON.parse` means ~99% of lines are never parsed.

### Adding an agent

One file in `src/agents/`, one line in `src/agents/index.ts`. An adapter finds files
and turns one into a session; everything downstream — spans, stats, timeline, both
renderers, the archive — treats the agent as an opaque string. The contract is in
`src/agents/types.ts`, and it holds adapters to the two rules the tool rests on: never
emit a record for a subagent, and never reconstruct working time the agent didn't
measure itself.

Agents whose sessions carry no per-turn timing (Gemini CLI, Amp) or that store
history in SQLite (opencode, Cursor — a runtime dependency agentclock doesn't take)
aren't shipped for those reasons, not for lack of a seam.

### History outlives Claude's cleanup

Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). Each run
records what it parsed to `~/.agentclock/archive.jsonl`, so sessions stay counted after
their transcripts are gone — and unchanged transcripts are skipped next time.

```
first run   532 files · 2834 ms
later run     0 files ·   54 ms
```

A few hundred KB for a year of sessions. Disable with `--no-archive`.

### Honest limits

- **Historical `waiting` isn't recoverable.** Nothing in a session file distinguishes
  "blocked on a permission prompt" from "went to lunch". `waiting` appears in
  `agentclock now` and `agentclock watch`, but historical charts show busy and idle only.
- **Codex publishes no live session registry**, so it can't appear in `now` or
  `watch`. agentclock says so in the output rather than letting its absence read as
  "no Codex sessions are running". Calling a recently-touched rollout "working" would
  invent a status Codex never reported.
- **Sessions from agent versions that record no turn durations** — Claude Code before
  2.1.222, or a Codex rollout predating the turn-completion event — are counted, but
  contribute no active time rather than a fabricated estimate. (An earlier draft
  estimated it from gaps between records; measured against ground truth that ran 44%
  low, so it was cut.)
- **Codex compresses cold rollouts to `.jsonl.zst`.** Node 18 has no zstd, so those
  are skipped — and the count is printed, never swallowed.

## Requirements

Node 18.17+, and no runtime dependencies.

Nothing is sent anywhere. Everything stays on your machine.

## Development

```sh
npm install
npm run build
npm test
```

To run the checkout you are working in as the real `agentclock` command:

```sh
npm run link:local     # build, then point the global agentclock here
npm run unlink:local   # remove the global link again
```

It is `npm link` with a build in front of it, so it works from a git worktree
too — run it in the worktree and `agentclock` is that branch until you run it
somewhere else. The link points at the directory, so a later `npm run build`
there is picked up with no re-linking. Deleting a checkout that is currently
linked leaves a dangling `agentclock`; `npm run unlink:local` first, or just
re-link from wherever you want it.

The menu bar app lives in `macos/` and builds with one `swiftc` call:

```sh
npm run menubar:build       # -> macos/build/AgentClock.app
make -C macos run           # run it in the foreground, ^C to stop
```

It reimplements `readLiveSessions()` in Swift, which is a real duplication —
`test/menubar.test.js` runs both against the same fixture directory and fails if
they ever disagree. That test skips itself off macOS, so the Linux CI legs are
unaffected.

## License

MIT
