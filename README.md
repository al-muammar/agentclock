# agentclock

See how many Claude Code sessions you're running, how many are **actually working**,
and how long each one lives.

```sh
npx agentclock
```

No daemon, no install, nothing running in the background. agentclock reads what Claude
Code has already written to disk and derives the rest.

## Install

`npx agentclock` needs no install at all. To keep it around:

```sh
npm install -g agentclock
```

Node 18.17+, and no runtime dependencies — the install is one package.

## Why

Claude Code knows what your sessions are doing, but it doesn't keep a record. The
live status of each session vanishes when the session exits, and transcripts are
deleted after 30 days. agentclock turns what's on disk into an answer:

- How many sessions are open right now, and how many are working versus waiting on you
- How much of your day had an agent actually running
- How often you run agents in parallel — and how often you don't
- Which projects the time went to

**A session with five subagents counts as one session.** Subagents run inside their
parent and share its session id, so this falls out of the data model rather than
being a rule the tool applies.

## Usage

```sh
agentclock                # build the dashboard and open it
agentclock now            # what's running right now
agentclock watch          # live view, refreshing in place
agentclock timeline       # per-day activity timeline
agentclock stats          # historical summary in the terminal
agentclock pdf            # one-page PDF summary, for sharing
agentclock report --since 7d --anonymize -o week.html
```

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
npm run menubar:install
```

Puts `◐ 4` in the menu bar: how many agents are working right now. Click it for
the list — which sessions, in which projects, for how long — plus *Open
dashboard*, *Launch at login* and a smoothing setting.

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
there is no Xcode project and nothing to download. Because you compile it
yourself, macOS never quarantines it: no Gatekeeper prompt, no developer account.
`npm run menubar:uninstall` removes it.

### Options

| Flag | Meaning |
| --- | --- |
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

Two sources, both already on your disk:

| Source | Gives |
| --- | --- |
| `~/.claude/sessions/<pid>.json` | Live state — one file per running session, with a status of `busy`, `waiting` or `idle`. |
| `~/.claude/projects/<slug>/*.jsonl` | History — every completed turn records its exact duration, so past working time reconstructs precisely. |

Historical **busy** time is exact, not estimated: Claude Code writes a
`turn_duration` record carrying the real `durationMs` at the end of every turn, so a
turn that ended at 14:08:47 after six minutes becomes a span of 14:02:47–14:08:47.

Reading 700 MB of transcripts takes about 2.5 seconds, because a substring check
before `JSON.parse` means ~99% of lines are never parsed.

### History outlives Claude's cleanup

Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). Each run
records what it parsed to `~/.agentclock/archive.jsonl`, so sessions stay counted after
their transcripts are gone — and unchanged transcripts are skipped next time.

```
first run   532 files · 2834 ms
later run     0 files ·   54 ms
```

A few hundred KB for a year of sessions. Disable with `--no-archive`.

### Two honest limits

- **Historical `waiting` isn't recoverable.** Nothing in a transcript distinguishes
  "blocked on a permission prompt" from "went to lunch". `waiting` appears in
  `agentclock now` and `agentclock watch`, but historical charts show busy and idle only.
- **Sessions older than Claude Code 2.1.222 record no turn durations.** They're
  counted, but contribute no active time rather than a fabricated estimate. (An
  earlier draft estimated it from gaps between records; measured against ground
  truth that ran 44% low, so it was cut.)

## Requirements

Node 18.17+. Reads `CLAUDE_CONFIG_DIR` if you've relocated your Claude config.

Today agentclock reads Claude Code's data and nothing else. The name is deliberately
tool-neutral: the model it's built on — sessions, spans of real work, one count per
session regardless of subagents — isn't specific to Claude Code, so other agent CLIs
can be added as readers without reshaping anything downstream.

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
