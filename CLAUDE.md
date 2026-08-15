# cctrack

A CLI that reports how many Claude Code sessions ran, how many were actually
working, and for how long. It reads files Claude Code already writes — there is
no daemon and nothing resident.

## Commands

```sh
npm run build      # tsc → dist/ (tests import dist, so build before testing)
npm test           # builds, then runs node --test
npm run typecheck
```

## Shape

```
registry.ts     ~/.claude/sessions/<pid>.json   → live state
transcripts.ts  ~/.claude/projects/**/*.jsonl   → historical spans
spans.ts        merge / clip
stats.ts        spans → concurrency, days, projects, timeline
archive.ts      ~/.cctrack/archive.jsonl        → history past Claude's 30-day sweep
render/         term.ts (ANSI) · html.ts + svg.ts (self-contained report)
```

Everything downstream of `stats.ts` consumes **spans**: half-open `[start, end)`
intervals when a session was working.

## Invariants — don't break these

- **A session with N subagents counts as one.** Subagent transcripts live in
  `<slug>/<sessionId>/subagents/`; only files directly inside a project slug are
  enumerated. Never walk into `subagents/`.
- **Merge spans per session before any sweep.** This is what guarantees one
  session can never contribute more than 1 to a concurrency count.
- **Active time is exact or absent, never estimated.** It comes from Claude
  Code's own `turn_duration.durationMs`. Sessions predating 2.1.222 have none and
  must report zero with `hasTurnData: false` — do not infer it from timestamps. A
  gap-based heuristic was measured at −44% against ground truth and cut.
- **Carry unknown values verbatim.** An unrecognised session `status` becomes its
  own state and surfaces in the output; never coerce it into `busy` or `idle`.
  The on-disk formats are internal to Claude Code and change between versions.
- **Liveness and identity guards fail open.** Hiding a real session is far worse
  than showing a phantom one. See the `ps -o etime=` check in `registry.ts` —
  the earlier `lstart` version silently reported zero sessions.
- **Zero runtime dependencies.** devDependencies only. This is what makes
  `npx cctrack` start in under a second; adding a dep needs a real reason.
- **The HTML report stays self-contained.** No network, no external assets — it
  is handed around as a single file and must render identically offline. Script
  is allowed but only inline, and only where markup genuinely cannot do the job:
  timeline zoom and the hourly selector. Everything else degrades gracefully —
  with scripting off the full-day timeline still renders and days still expand,
  because the drill-down is `<details>`, not a click handler. No inline event
  attributes.
- **Nothing leaves the machine.** No telemetry, no network calls, ever.

## Conventions

- TypeScript, ESM, `strict` with `noUncheckedIndexedAccess`. Node 18.17+.
- Comments explain *why*, especially where a simpler approach was tried and
  failed. Skip comments that restate the code.
- Times are epoch ms. Day bucketing is **local** and splits at real local
  midnight, so DST shifts don't drift.
- Paths are user data: escape them before they reach HTML, and respect
  `--anonymize`.

## Verifying a change

- `npm test` must pass. New behaviour needs a test in the matching file:
  `transcripts` · `render` · `archive` · `timeline` · `core` · `cli`.
- **Changed the report? Render it and look at it, in both themes.** Markup
  checks alone missed chart tracks going white on dark — the fix was declaring
  `color-scheme: light dark`.
- Changed parsing or stats? Check it against a real `~/.claude` and compare the
  totals, not just that it runs. A full scan of ~700 MB should stay around 3s;
  if it doesn't, time the stages separately — the scan and the stats reduction
  have each been the culprit once.
