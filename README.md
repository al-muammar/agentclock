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

**In history, a session with five subagents counts as one session.** Subagents run
inside their parent and share its session id, so this falls out of the data model
rather than being a rule the tool applies.

**Live, you see both.** `agentclock now` and the macOS app show how many
agents are running inside each session — `◐ 5 (12)` is five sessions working with
twelve agents between them. A session whose only worker is a background agent
counts as working, because it is.

## Usage

```sh
agentclock                # build the dashboard and open it
agentclock now            # what's running right now
agentclock usage          # how much of your quota is left
agentclock watch          # live view, refreshing in place
agentclock timeline       # per-day activity timeline
agentclock stats          # historical summary in the terminal
agentclock pdf            # one-page PDF summary, for sharing
agentclock menubar        # install the macOS screen-edge HUD
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

### How much is left

```sh
agentclock usage
```

```
  97% left of your session limit   resets in 4h 16m

  session limit  ██████████   97% left   resets in 4h 16m
  weekly limit   ██████████   98% left   resets in 6d 14h

  TOKENS IN LIVE SESSIONS
  SESSION                    OUTPUT   CACHE RD    AGENTS
  api-retry-backoff-4c         244k        66M         ·
  flaky-test-triage-e1          95k        15M       33k
                               339k                total
```

The headline is whichever limit binds first — the one closest to running out,
which is the one that decides when work stops. Below it, every scope the server
reports, including ones agentclock doesn't have a name for: an unfamiliar limit
shows up under its own key rather than being hidden.

Underneath, what your live sessions are actually spending. Those are exact token
counts read from the transcripts on your disk — output, cache reads, and how much
of the output came from subagents working inside each session. Subagent tokens are
rolled into their parent, never counted as a session of their own.

The quota half needs the network and your Claude Code credential; see
[Privacy](#privacy). `--cached` reports the last snapshot without fetching, and
`--json` gives you the lot. When a fetch can't happen, the last snapshot is shown
with its age rather than nothing at all.

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

### The macOS app

```sh
agentclock menubar             # build and install it
agentclock menubar uninstall   # remove it again
```

By default it puts a narrow black tab against the **right edge of your screen** —
flush with the edge, rounded on its left side, square where it meets the edge. A
teal dot for each session that is working, stacked one per session, a number for
the ones sitting idle, and a ring for how much of your **session limit** is left —
the five-hour window, the one that decides whether you can keep going this
afternoon. Being on
the edge makes it a target you cannot miss: throw the pointer right and it opens. Point at it
and it opens into the full readout — every quota scope with its reset countdown,
each working session with its project, its uptime, what it has spent and which
agents it has out, and anything waiting on you pulled to the top. Click to pin it
open, click a row to reveal that session's directory in Finder, right-click for the
settings.

The strip carries larger type than the card does, deliberately: it is read at a
glance, from across a desk, and it is the only part on screen all the time. The
card is read with the pointer already on it, and puts quota at its foot — the same
place the strip does, so nothing moves when it opens.

The card lists your session and weekly limits with their percentages and reset
countdowns. `agentclock usage` in the terminal still shows every scope the server
reports, including ones agentclock has no name for; the card keeps to the two you
watch, plus whichever limit is currently the one binding.

The menu bar badge, if you turn it on, still follows the limit closest to running
out rather than the session one — it is a single line of text with no room to say
which limit it means, so it shows the one that decides when work stops.

With nothing running it fades back to almost nothing, and it never takes focus —
you can hover it mid-sentence and keep typing.

Prefer the menu bar? *Show → In the menu bar* puts the old badge back: `◐ 4`, or
`◐ 4 (9)` when there are subagents running inside those four, or `◐ 4 (9) · 42%`
once `agentclock usage` has fetched your quota. *Both* runs the two together.

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

The app itself makes no network calls. For quota it runs `agentclock usage` once a
minute and reads the snapshot from `~/.agentclock/usage.json` on its normal
two-second tick, so the fetch, the credential and the parsing all stay in one place
instead of being reimplemented in Swift. Quota moves on five-hour boundaries, so
once a minute is plenty. That refresh costs about **0.8 seconds of CPU**, or
roughly 1.3% of one core at that cadence — on top of the app's own tenth of a
percent, and only once you have used `agentclock usage`. On the two-second tick the
same work would be 40% of a core, which is why it isn't there.

The count is **smoothed**: a session keeps counting until it has been quiet for 30
seconds, so the number rises the instant work starts and falls only once an agent
has genuinely stopped. Mostly this covers `busy → waiting → busy` around a
permission prompt, where the agent hasn't stopped working and the badge shouldn't
say it has. Sampling the registry at 4 Hz for ten minutes recorded no raw
flicker at all — Claude Code holds `busy` for a whole turn rather than toggling
between tool calls — which is why the window is deliberately short rather than a
minute. Sessions in the tail are dimmed — a faded dot on the pill, a faded row in
the card — so the smoothing is visible rather than a quiet fiction. Adjust it under
*Smoothing*, or turn it off.

The pill is draggable along the edge and remembers where you put it. It stays
visible over full-screen apps and across Spaces, and it needs no macOS permissions
at all — no Accessibility, no Screen Recording. That last part is not incidental:
the app is ad-hoc signed and recompiled on your machine, so every upgrade looks
like new code to macOS, and any permission you granted would have to be granted
again.

Requires macOS 11+ and the Xcode Command Line Tools (`xcode-select --install`) —
there is no Xcode project and nothing to download. `agentclock menubar` says so
if they are missing rather than failing with a compiler error.

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

### Privacy

Everything except `agentclock usage` is read from files on your disk and goes
nowhere. There is no telemetry, and nothing about your code, your projects or your
sessions is ever sent anywhere.

`agentclock usage` is the one command that makes a network call. It asks
Anthropic's `/api/oauth/usage` — the same endpoint Claude Code's own `/usage`
uses — for your remaining quota, sending only the OAuth token Claude Code has
already stored in your Keychain. It is read-only: agentclock never writes to that
credential, and the token is never logged, never cached and never written to disk.
The cache it does write, `~/.agentclock/usage.json`, holds percentages, reset times
and token counts.

The reason for the exception is that remaining quota is the one number that is not
on your disk. It is a server-side accounting of your token use under a weighting
that isn't published, and it can't be reconstructed locally: across 40 recorded
limit hits, the five-hour window held anywhere from 2,745 to 1,053,232 output
tokens when the limit fired — a 380× spread with no threshold in it. A local guess
would warn constantly and stay quiet when it mattered, so there isn't one.

The first run prompts macOS for access to the Claude Code credential, via
Apple-signed `/usr/bin/security`. Choose "Always Allow" and it won't ask again.
Every other command works with no credential at all.

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

The macOS app lives in `macos/` and builds with one `swiftc` call — two source
files, `AgentClock.swift` (the data and the menu bar badge) and `HUD.swift` (the
edge panel):

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
