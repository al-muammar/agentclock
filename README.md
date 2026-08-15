# cctrack

See how many Claude Code sessions you're running, how many are **actually working**,
and how long each one lives.

```sh
npx cctrack
```

No daemon, no install, nothing running in the background. cctrack reads what Claude
Code has already written to disk and derives the rest.

## Install

`npx cctrack` needs no install at all. To keep it around:

```sh
npm install -g cctrack
```

Node 18.17+, and no runtime dependencies — the install is one package.

## Why

Claude Code knows what your sessions are doing, but it doesn't keep a record. The
live status of each session vanishes when the session exits, and transcripts are
deleted after 30 days. cctrack turns what's on disk into an answer:

- How many sessions are open right now, and how many are working versus waiting on you
- How much of your day had an agent actually running
- How often you run agents in parallel — and how often you don't
- Which projects the time went to

**A session with five subagents counts as one session.** Subagents run inside their
parent and share its session id, so this falls out of the data model rather than
being a rule the tool applies.

## Usage

```sh
cctrack                # build the dashboard and open it
cctrack now            # what's running right now
cctrack watch          # live view, refreshing in place
cctrack timeline       # per-day activity timeline
cctrack stats          # historical summary in the terminal
cctrack report --since 7d --anonymize -o week.html
```

`cctrack timeline` shows one row per day, midnight to midnight, so you can see
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

### Options

| Flag | Meaning |
| --- | --- |
| `--since <window>` | Time window: `7d`, `24h`, `90m`. Default `30d`. |
| `--all` | No window — everything on disk. |
| `--anonymize` | Replace project and session names with stable pseudonyms. |
| `-o, --out <file>` | Where to write the dashboard. |
| `--no-open` | Write the dashboard without opening it. |
| `--hours <range>` | Zoom the timeline to a slice of the day: `9-18`, `09:30-13:00`. |
| `--interval <seconds>` | Refresh rate for `watch`. Default `2`. |
| `--no-archive` | Don't read or update `~/.cctrack/archive.jsonl`. |
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
records what it parsed to `~/.cctrack/archive.jsonl`, so sessions stay counted after
their transcripts are gone — and unchanged transcripts are skipped next time.

```
first run   532 files · 2834 ms
later run     0 files ·   54 ms
```

A few hundred KB for a year of sessions. Disable with `--no-archive`.

### Two honest limits

- **Historical `waiting` isn't recoverable.** Nothing in a transcript distinguishes
  "blocked on a permission prompt" from "went to lunch". `waiting` appears in
  `cctrack now` and `cctrack watch`, but historical charts show busy and idle only.
- **Sessions older than Claude Code 2.1.222 record no turn durations.** They're
  counted, but contribute no active time rather than a fabricated estimate. (An
  earlier draft estimated it from gaps between records; measured against ground
  truth that ran 44% low, so it was cut.)

## Requirements

Node 18.17+. Reads `CLAUDE_CONFIG_DIR` if you've relocated your Claude config.

Nothing is sent anywhere. Everything stays on your machine.

## Development

```sh
npm install
npm run build
npm test
```

## License

MIT
