# cctrack

See how many Claude Code sessions you're running, how many are **actually working**,
and how long each one lives.

```sh
npx cctrack
```

No daemon, no install, nothing running in the background. cctrack reads what Claude
Code has already written to disk and derives the rest.

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
cctrack now            # what's running right now
cctrack stats          # historical summary (last 30 days)
cctrack stats --all    # everything still on disk
```

### Options

| Flag | Meaning |
| --- | --- |
| `--since <window>` | Time window: `7d`, `24h`, `90m`. Default `30d`. |
| `--all` | No window — everything on disk. |
| `--anonymize` | Replace project and session names with stable pseudonyms. |
| `--json` | Machine-readable output. |
| `--verbose` | Report parse throughput. |

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

### Two honest limits

- **Historical `waiting` isn't recoverable.** Nothing in a transcript distinguishes
  "blocked on a permission prompt" from "went to lunch". `waiting` appears in
  `cctrack now`, but historical charts show busy and idle only.
- **Sessions older than Claude Code 2.1.222 record no turn durations.** They're
  counted, but contribute no active time rather than a fabricated estimate.

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
