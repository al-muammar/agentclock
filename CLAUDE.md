# agentclock

A CLI that reports how many Claude Code sessions ran, how many were actually
working, and for how long. It reads files Claude Code already writes — there is
no daemon and nothing resident.

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
release PR, CI, then tag. **Pushing a `v*` tag is what publishes** —
`.github/workflows/publish.yml` re-runs the full matrix on the tagged tree, sends
it to npm over GitHub OIDC (no token, provenance attached) and writes the GitHub
Release from the CHANGELOG section. It refuses a tag that disagrees with
`package.json`, one whose commit is not on `main`, and a version already on npm.
Two more things the skill exists to stop you forgetting — the version lives in
**`package.json`, `package-lock.json`, `src/cli.ts` and `macos/Info.plist`** and
all four must
agree (`--version` reads the constant, not the manifest, so the manifest stays
out of the bundle; the plist carries it twice and is the easy one to miss, since
a stale value still builds and runs. `test/cli.test.js` and
`test/menubar.test.js` fail a half-done bump), and the tag goes on the
**merged** commit, never a local one, so it can only ever name a tree CI went
green on.

## Shape

```
registry.ts     ~/.claude/sessions/<pid>.json   → live state
transcripts.ts  ~/.claude/projects/**/*.jsonl   → historical spans
spans.ts        merge / clip
stats.ts        spans → concurrency, days, projects, timeline
archive.ts      ~/.agentclock/archive.jsonl        → history past Claude's 30-day sweep
credentials.ts  macOS Keychain                 → the OAuth token Claude Code stores
quota.ts        /api/oauth/usage               → how much quota is left (the one fetch)
burn.ts         transcripts, from a cursor     → exact tokens per live session
usagecache.ts   ~/.agentclock/usage.json       → both of those, for the menu bar to read
render/         term.ts (ANSI) · html.ts + svg.ts (self-contained report)
                pdf.ts (PDF primitives) + onepager.ts (one-page summary)

macos/          AgentClock.swift — data (the Swift port), Snapshot, menu bar badge
                HUD.swift        — the screen-edge panel: pill ⇄ card
                Ships as SOURCE in the npm package and is compiled on the user's
                machine by `agentclock menubar`. One swiftc call, both files, no
                Xcode project.
```

`refresh()` publishes one `Snapshot`; the badge and the HUD are two renderers of
it. Nothing in `HUD.swift` reads the registry, the transcripts or the usage cache
— that boundary is why one implementation, not two, has to be held equal to the
TypeScript.

Everything downstream of `stats.ts` consumes **spans**: half-open `[start, end)`
intervals when a session was working.

## Invariants — don't break these

- **A session with N subagents counts as one — in history.** Subagent transcripts
  live in `<slug>/<sessionId>/subagents/`; the transcript scan enumerates only
  files directly inside a project slug and never walks into `subagents/`. That is
  what makes concurrency a count of sessions. The **live** snapshot does read that
  directory (`subagents.ts`), and feeds nothing into any historical metric — so
  `stats.ts` and everything downstream still sees one span set per session.
- **Agents are counted live, never estimated from history.** Subagent transcripts
  carry no `turn_duration` at all — 0 records across 474 files — so there is no
  exact agent time to report and none is invented. Liveness comes from three
  signals, none sufficient alone: a terminal `end_turn` record, the parent's
  `<task-notification>`, and a 30-minute staleness cap. Freshness alone was
  measured at a 21% false-negative rate and the terminal record alone leaks 9%
  phantoms; see `src/subagents.ts` for the numbers.
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
  `npx agentclock` start in under a second; adding a dep needs a real reason.
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
- **The macOS app duplicates the registry rules, and a test holds them equal.**
  `macos/AgentClock.swift` reimplements `readLiveSessions()` and `subagents.ts`
  because spawning Node every two seconds costs ~130x more CPU than reading the
  directory (~130ms vs ~1ms). Change either one and you must change the Swift too;
  `test/menubar.test.js` runs both against one fixture and fails if they diverge.
  Keep every fail-open branch — the port must fail toward showing a phantom
  session, exactly as the TypeScript does. **Quota is the deliberate exception to
  that duplication:** the Swift only *reads* `~/.agentclock/usage.json`, and the
  fetch, the credential and the response parsing stay in TypeScript. The 130x
  argument is about cadence, not about spawning — quota moves on five-hour
  boundaries, so the app shells out once a minute (~0.78s of CPU per refresh, about
  1.3% of a core; the same work on the two-second tick would be 40%) and reads the
  file every two seconds. Do not port the fetch into Swift; that would put a
  network client and a credential reader behind a second implementation nothing
  holds equal. It stays ad-hoc signed on purpose:
  locally compiled code is never quarantined, so there is no Gatekeeper prompt and
  no paid certificate. That rules out `SMAppService`, which refuses ad-hoc
  signatures — launch-at-login writes a plain Aqua LaunchAgent instead.
- **The HUD's silhouette is a drawn path, not a layer corner radius.**
  `TabBackdrop` exists because `CALayer` can do neither thing the shape needs: the
  concave flare where the tab meets the screen edge curves *outward*, and a layer
  border has no way to leave one side unstroked. So the fill closes across the
  screen edge and the stroke stops short of it — the tab is attached to that edge,
  and an edge it is attached to is not an edge it should be outlined against. The
  flare costs `HUDStyle.flare` of height at each end, which is why the panel is
  taller than its content and the content insets itself to match; miss that inset
  and every row shifts. Flush also makes it an edge target in the Fitts's-law
  sense: the pointer cannot overshoot it. Position against `visibleFrame`, never
  `frame`, so a right-hand Dock still pushes it clear.
- **The HUD's screen is a stored preference, never wherever the panel already is.**
  `place()` positions against `targetScreen`, not `panel.screen`: reading the screen
  back out of the panel makes the position self-fulfilling, and that is exactly how
  the tab came to be stuck on the display it launched on with no way off it — the
  drag ignored the horizontal axis outright. It still never floats the tab away from
  an edge; horizontal movement only chooses *which* screen's edge, and it follows the
  pointer's screen rather than the panel's, because the pointer crosses the boundary
  first. The preference is stored by display **id and name**: ids are handed out per
  session, so a monitor that is unplugged, or a Mac that is rebooted, can come back
  under a different one. A remembered screen that is missing falls back to the main
  one *without clearing the preference*, so the HUD goes home when that display
  returns.
- **The badge and the tab follow different quota scopes, on purpose.** The badge
  takes `binding` — the scope closest to exhaustion — because it is one line of
  text with no room to name which limit it means, so it must show the one that
  decides when work stops. The tab takes `five_hour` (`Snapshot.sessionQuota`)
  because it is read all day and the weekly figure barely moves across one, and it
  can afford to: the card behind it lists both, and always the binding scope.
  `test/menubar.test.js` keeps a `state-split` fixture whose weekly limit is nearly
  gone while the session window is untouched — the only fixture that can tell the
  two renderers apart, since in the main one they coincide.
- **Quota sits at the foot of the card, because that is where the tab puts it.**
  The resting tab reads dots, then idle, then quota; the card it opens into must
  not reorder the same three facts. **The card is also the one place that filters
  quota scopes** — session and weekly only — which is a deliberate exception to
  "unknown keys are never dropped". The CLI still shows every scope under its own
  key, and the exception has its own exception: the binding scope is always
  listed even when it is neither, because the tab's percentage follows it and a
  number the list cannot account for is worse than a row nobody wanted.
- **The HUD needs zero macOS permissions, and must keep needing zero.** Ad-hoc
  signed code carries no stable designated requirement, so macOS cannot tell that
  version N+1 is the same code as version N — and `agentclock menubar` recompiles
  on the user's machine, which makes *every upgrade a new identity*. Any TCC grant
  would have to be re-approved each time, and a stale row can suppress the prompt
  rather than re-asking. Same family as the `SMAppService` refusal above. Nothing
  used here needs consent: floating panels at any level, `.activeAlways` tracking
  areas, mouse-only global monitors, `NSVisualEffectView`. What would: `CGEventTap`
  (Input Monitoring), `AXObserver` (Accessibility), reading other windows' titles
  (Screen Recording, which never prompts and silently returns nothing). Don't.
- **The HUD never takes focus, and both halves are needed.**
  `.nonactivatingPanel` stops the *app* activating; `canBecomeKey → false` stops
  the *window* taking key. Either alone is not enough, and clicking a focus-taking
  panel over a full-screen app throws the user back to the desktop Space. The
  style mask must be passed at init — it is backed by a WindowServer tag set
  during panel initialisation, so mutating `styleMask` later leaves AppKit and
  WindowServer disagreeing. Also set `hidesOnDeactivate = false`: `NSPanel`
  defaults it to `true` (unlike `NSWindow`), so left alone the HUD disappears
  whenever another app comes forward, which is always.
- **Hover needs a timeout as well as an exit event.** `mouseExited` is unreliable
  at high cursor velocity and leaves the card stuck open; `HUDController` polls
  point-in-rect every 500 ms with 16 pt of hysteresis as the backstop. Removing
  the poll because "the tracking area already does that" is how it regresses.
  And `mouseEntered` does not fire when the panel appears under an already-still
  pointer — no boundary was crossed — hence `seedHover()`.
- **Never touch `ignoresMouseEvents` on the live panel.** Per-pixel click-through
  is the default for a borderless non-opaque window, and *assigning* that property
  at all — including to `false` — permanently disables it. It is only for a parked
  or hidden state.
- **The HUD's colours are explicit alphas, not `labelColor` and friends.** The
  panel is pinned to `.vibrantDark`, so semantic label colours are wrong twice:
  they follow the system theme rather than the panel's, and they are tuned for
  solid backgrounds — on a translucent HUD material `secondaryLabelColor` and
  below wash out to unreadable. This was measured by looking at it; the first
  draft's elapsed times were invisible. Teal / amber / grey match
  `src/render/term.ts`, so the terminal and the HUD never disagree about what a
  colour means.
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
- **One network call, and only this one.** `agentclock usage` asks Anthropic's
  `/api/oauth/usage` — the endpoint Claude Code's own `/usage` calls — for your
  quota, with the credential Claude Code already stores. It sends nothing but that
  token. No telemetry, no third party, and nothing about your code, your projects
  or your sessions ever leaves the machine; every other number in this tool is
  read from files Claude Code already wrote. The exception exists because
  remaining quota is genuinely not on disk anywhere, and cannot be estimated: across
  40 recorded limit hits the five-hour window held between 2,745 and 1,053,232
  output tokens, a 380x spread with no threshold in it. Adding a second endpoint
  needs a reason at least this good.
- **Take the credential by name, never by search.** The Keychain item
  `Claude Code-credentials` is one blob holding *several* services' secrets: beside
  `claudeAiOauth` it carries an `mcpOAuth` map with an access token per
  authenticated MCP server. A "first `accessToken` wins" walk picks whichever key
  sorts first and sends a third party's bearer token to api.anthropic.com — that
  bug was written and caught here. `src/credentials.ts` reads exactly
  `claudeAiOauth.accessToken` or fails, and `test/usage.test.js` holds it there.
- **Utilization is a percent, not a fraction.** `utilization: 3` means 3% used.
  The same response's `limits[]` array says `percent: 3` for that window, which is
  how to check. Scaling it by 100 turns an almost untouched quota into a saturated
  meter — the worst direction for this number to be wrong in.

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
  `transcripts` · `render` · `pdf` · `archive` · `timeline` · `core` · `cli` ·
  `usage` (quota parsing, credential targeting, token dedup).
- **Changed quota parsing? Check it against a real response, not the fixture.**
  `node -e` the endpoint and read the JSON: the fixture is a copy of a shape with
  no compatibility promise, and the two ways to get this wrong — a percent read as
  a fraction, a scope dropped for being unfamiliar — both look fine in a test that
  only ever sees the fixture.
- **Changed the report? Render it and look at it, in both themes.** Markup
  checks alone missed chart tracks going white on dark — the fix was declaring
  `color-scheme: light dark`.
- **Changed the PDF? Rasterise it and look at it.** `sips -s format png
  one-pager.pdf --out one-pager.png`. `gs -o /dev/null -sDEVICE=nullpage` and
  `pdfinfo` are independent parsers worth running too — a bad xref offset still
  opens in Preview.
- **Changed the HUD? Build it, run it, and look at it — on a light background and
  a dark one.** `make -C macos run`, then point at the pill. Markup-equivalent
  checks catch nothing here: the first draft passed `make check` and `npm test`
  with half its text invisible. `--hud` prints the pill as a string, which pins
  the counts but says nothing about whether you can read them.
- **Added a Swift file? Add it to `test/menubar.test.js`'s rebuild list.** The
  freshness check names its sources literally. Miss it and a stale binary is
  reused, it does not know the new flags, an unrecognised flag falls through to
  `app.run()`, and `npm test` hangs forever instead of failing.
- Changed parsing or stats? Check it against a real `~/.claude` and compare the
  totals, not just that it runs. A full scan of ~700 MB should stay around 3s;
  if it doesn't, time the stages separately — the scan and the stats reduction
  have each been the culprit once.
