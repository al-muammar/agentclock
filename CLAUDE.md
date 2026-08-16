# agentclock

A CLI that reports how many coding-agent sessions ran, how many were actually
working, and for how long. It reads files the agents already write — there is no
daemon and nothing resident. Ships adapters for Claude Code and Codex.

## Commands

```sh
npm run build      # tsc → dist/ (tests import dist, so build before testing)
npm test           # builds, then runs node --test
npm run typecheck
npm run link:local # build, then make this checkout the global `agentclock`
```

`link:local` is `npm link` with a build in front, and it works from a worktree —
the global command follows whichever checkout linked last. `unlink:local` undoes
it. Delete a linked worktree without unlinking and `agentclock` dangles.

## Releasing

`.claude/skills/release/SKILL.md` is the whole procedure: bump, changelog,
release PR, CI, tag the merged commit, publish, GitHub Release. Two things it
exists to stop you forgetting — the version lives in **`package.json`,
`package-lock.json` and `src/cli.ts`** and all three must agree (`--version`
reads the constant, not the manifest, so the manifest stays out of the bundle;
`test/cli.test.js` fails a half-done bump), and the tag goes on the **merged**
commit, never a local one, so it can only ever name a tree CI went green on.

## Shape

```
agents/types.ts   the AgentAdapter contract
agents/claude.ts  ~/.claude/projects/**/*.jsonl + sessions/<pid>.json
agents/codex.ts   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
agents/index.ts   registry · --agent selection · live snapshot
scan.ts           adapter-agnostic scan, bounded concurrency
proc.ts           pid liveness + `ps` ages, shared by any adapter
spans.ts          merge / clip
stats.ts          spans → concurrency, days, projects, agents, timeline
archive.ts        ~/.agentclock/archive.jsonl → history past Claude's 30-day sweep
render/           term.ts (ANSI) · html.ts + svg.ts (self-contained report)
                  pdf.ts (PDF primitives) + onepager.ts (one-page summary)

macos/            AgentClock.swift — menu bar badge, and a SECOND implementation
                  of the Claude liveness rules. Ships as SOURCE in the npm
                  package and is compiled on the user's machine by
                  `agentclock menubar`. One swiftc call, no Xcode project.
                  test/menubar.test.js runs it against agents/claude.ts on one
                  fixture and fails if they disagree — change one, change both.
```

Everything downstream of `scan.ts` consumes **spans**: half-open `[start, end)`
intervals when a session was working. Nothing downstream of the adapters knows an
agent's name — `SessionRecord.agent` is an opaque string all the way through.

## Invariants — don't break these

- **A session with N subagents counts as one.** Subagent transcripts live in
  `<slug>/<sessionId>/subagents/`; only files directly inside a project slug are
  enumerated. Never walk into `subagents/`. Any new adapter owes the same.
- **Merge spans per session before any sweep.** This is what guarantees one
  session can never contribute more than 1 to a concurrency count.
- **Sessions are keyed by agent *and* id.** Agents mint ids independently, so the
  archive, the concurrency sweep and everything else key on `<agent>:<sessionId>`.
  A bare id would let one agent's session cancel out another's.
- **Active time is exact or absent, never estimated.** It comes from the agent's
  own timing: Claude Code's `turn_duration.durationMs`, Codex's `task_complete`
  (`started_at`/`completed_at`, else `duration_ms`, else the `task_started` line
  paired with the `task_complete` line — all three are Codex's own event stream).
  A session whose agent recorded none must report zero with `hasTurnData: false` —
  do not infer it from timestamps. A gap-based heuristic was measured at −44%
  against ground truth and cut.
- **A missing capability is stated, not faked.** Codex publishes no live registry,
  so `now`/`watch` name it as unreadable rather than showing an empty list that
  reads as "nothing is running". Same for the `.jsonl.zst` rollouts Node 18 cannot
  decompress: the count is printed, never swallowed.
- **Carry unknown values verbatim.** An unrecognised session `status` becomes its
  own state and surfaces in the output; never coerce it into `busy` or `idle`.
  Every on-disk format here is internal to its agent and changes between versions
  — parse defensively and accept both spellings when one gets renamed.
- **Liveness and identity guards fail open.** Hiding a real session is far worse
  than showing a phantom one. See the `ps -o etime=` check in `proc.ts` — the
  earlier `lstart` version silently reported zero sessions.
- **Zero runtime dependencies.** devDependencies only. This is what makes
  `npx agentclock` start in under a second; adding a dep needs a real reason.
- **One hue, and it means magnitude.** The teal ramp encodes how many agents are
  working. Agent *identity* is carried by the monochrome `.tag` chip, never by a
  second colour scale — that would fight the ramp and would need its own CVD check.
- **The HTML report stays self-contained.** No network, no external assets — it
  is handed around as a single file and must render identically offline. Script
  is allowed but only inline, and only where markup genuinely cannot do the job:
  timeline zoom and the hourly selector. Everything else degrades gracefully —
  with scripting off the full-day timeline still renders and days still expand,
  because the drill-down is `<details>`, not a click handler. No inline event
  attributes.
- **The PDF is written by hand, and it is one page.** `render/pdf.ts` emits PDF
  1.4 directly — no library, no headless browser, because zero dependencies is
  worth more than the code it saves. Text is WinAnsi with real Helvetica AFM
  widths; without them nothing right-aligned lines up. The one-pager must never
  spill onto a second sheet: a section that cannot fit is dropped or summed, and
  `test/pdf.test.js` asserts `/Count 1` and that nothing is drawn off the page.
- **The menu bar app duplicates the registry rules, and a test holds them equal.**
  `macos/AgentClock.swift` reimplements `readLiveSessions()` because spawning Node
  every two seconds costs ~130x more CPU than reading the directory (~130ms vs
  ~1ms). Change `registry.ts` and you must change the Swift too;
  `test/menubar.test.js` runs both against one fixture and fails if they diverge.
  Keep every fail-open branch — the port must fail toward showing a phantom
  session, exactly as the TypeScript does. It stays ad-hoc signed on purpose:
  locally compiled code is never quarantined, so there is no Gatekeeper prompt and
  no paid certificate. That rules out `SMAppService`, which refuses ad-hoc
  signatures — launch-at-login writes a plain Aqua LaunchAgent instead.
- **The menu bar app ships as source, never as a binary.** `agentclock menubar`
  compiles it on the user's machine; that is the whole reason there is no
  Gatekeeper prompt. `files` lists `macos` *and* `!macos/build`, because naming a
  directory in `files` overrides `.gitignore` and would otherwise publish the
  compiled 215 KB bundle. `test/menubar.test.js` asserts on the real `npm pack`
  file list, so this cannot regress silently. The build output goes to
  `~/.agentclock/menubar-build`, never inside the package — a global install may
  sit somewhere the user cannot write.
- **The badge is smoothed, and the dropdown shows it.** Raw `busy` flickers at
  every turn boundary, so a session counts until it has been quiet for the hold
  window. Sessions in that tail render dimmed; never let the count claim work that
  the list does not account for.
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
  `transcripts` (Claude parsing) · `agents` (Codex parsing, the registry, the
  scanner, multi-agent stats) · `render` · `pdf` · `archive` · `timeline` ·
  `core` · `cli`.
- **Changed the report? Render it and look at it, in both themes.** Markup
  checks alone missed chart tracks going white on dark — the fix was declaring
  `color-scheme: light dark`.
- **Changed the PDF? Rasterise it and look at it.** `sips -s format png
  one-pager.pdf --out one-pager.png`. `gs -o /dev/null -sDEVICE=nullpage` and
  `pdfinfo` are independent parsers worth running too — a bad xref offset still
  opens in Preview.
- Changed parsing or stats? Check it against a real `~/.claude` / `~/.codex` and
  compare the totals, not just that it runs. `stats --all --json` before and after
  should differ only in `windowTo` and `totalLifetimeMs`, which drift with the
  clock while a session is live. A full scan of ~700 MB should stay around 3s; if
  it doesn't, time the stages separately — the scan and the stats reduction have
  each been the culprit once.
- Adding an agent? It is one file in `src/agents/` plus one line in
  `src/agents/index.ts`. Read the contract in `src/agents/types.ts` first — it
  states the two rules an adapter must not break.
