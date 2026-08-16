---
name: release
description: Cut an agentclock release end to end — bump the version, write the CHANGELOG entry, open the release PR, wait for CI, tag, publish to npm, and create the GitHub Release. Use for "release 0.2.0", "cut a release", "ship a new version", "publish to npm".
---

# Releasing agentclock

One command's worth of ceremony, in order. Every step here exists because
skipping it has a specific cost — the notes say which.

Take the version from the user if they gave one. If they did not, derive it from
the commits since the last release: a new command, flag, or output surface is a
**minor**; a fix that changes nothing a user asks for is a **patch**. Say which
you picked and why before you start, and let them override it.

## 1. Preconditions

Stop and report rather than working around any of these.

```sh
git rev-parse --abbrev-ref HEAD        # must be main
git status --porcelain                 # must be empty of tracked changes
git fetch origin && git status -sb     # must not be behind origin/main
npm whoami                             # must print the publishing account
gh auth status                         # must be logged in
npm view agentclock version            # what is live right now
```

The last one matters: the git tag history is not the source of truth for what
shipped. 0.1.0 was published from a tree that was never tagged, so a release
that trusts `git describe` alone can pick a version that is already taken.

## 2. Confirm what is actually in the release

```sh
git log --oneline "$(npm view agentclock version | sed 's/^/v/')"..HEAD 2>/dev/null \
  || git log --oneline -15
```

Read the commits. If the set is empty, there is nothing to release — say so and
stop. If it contains something the user did not expect to ship, surface it
before going further.

## 3. Bump the version in both places

The version lives in **two** files and they must agree:

```sh
npm version <X.Y.Z> --no-git-tag-version    # package.json + package-lock.json
```

Then edit `src/cli.ts` — `export const VERSION = '<X.Y.Z>'` — because
`agentclock --version` reads that constant, not `package.json` (keeping the
package out of the bundle is what lets the CLI start with zero runtime
dependencies). `test/cli.test.js` asserts the two match, so a half-done bump
fails the test run in step 5 rather than shipping a CLI that lies about itself.

`--no-git-tag-version` is deliberate: this skill tags the *merged* commit in
step 7, not the local one, so the tag can never point at a tree that CI never
saw.

## 4. Write the CHANGELOG entry

Add a section to `CHANGELOG.md` above the previous release, dated today, in the
existing Keep a Changelog shape (`### Added` / `### Changed` / `### Fixed`).
Write it for someone deciding whether to upgrade — what they can now do, not
which files moved. Update the link definitions at the bottom of the file.

## 5. Run the full check suite locally

```sh
npm run check && npm run typecheck && npm test
```

This is the same suite `prepublishOnly` runs, so a failure here is a failure
that would otherwise surface halfway through `npm publish`, after the version
commit is already public.

If the release touched the PDF or the HTML report, also render and *look* at
them — see the verification rules in `CLAUDE.md`. Markup assertions have missed
visual regressions before.

## 6. Release PR, then CI

Every commit on `main` has arrived through a PR and CI is the gate. Keep it
that way:

```sh
git checkout -b release/v<X.Y.Z>
git add -A && git commit           # message: "Release <X.Y.Z>" + the changelog body
git push -u origin release/v<X.Y.Z>
gh pr create --title "Release <X.Y.Z>" --body "<changelog entry>"
gh pr checks --watch                # blocks until terminal; non-zero = failed
```

If CI fails, fix the cause and push again — never merge a red release PR, and
never disable a check to get through. When green:

```sh
gh pr merge --squash --delete-branch
git checkout main && git pull --ff-only origin main
```

## 7. Tag the merged commit

```sh
git tag -a v<X.Y.Z> -m "v<X.Y.Z>"
git push origin v<X.Y.Z>
```

Annotated, `v`-prefixed, and created only after the merge — the tag names the
exact tree CI went green on and npm is about to receive.

## 8. Publish

Check the payload before sending it, because npm versions are immutable — a
wrong publish can only be deprecated, never replaced:

```sh
npm pack --dry-run                  # dist/ + bin/ + README + LICENSE, nothing else
npm publish                         # prepublishOnly re-runs check + typecheck + test
```

`npm publish` is outward-facing and irreversible. Confirm with the user
immediately before running it unless they have already said to go all the way.

**The account has 2FA on, so `npm publish` will fail with `EOTP` when run from
here.** An agent cannot supply the one-time password. Do not retry, and do not
try to route around it — hand the step to the user and ask them to run it in
the session so its output lands in the conversation:

```
! npm publish --otp=<code from the authenticator>
```

Everything before this step is already done and durable at that point: the tag
is pushed and CI is green, so the publish is the only thing outstanding.

## 9. GitHub Release

```sh
gh release create v<X.Y.Z> --title "v<X.Y.Z>" --notes "<the changelog entry>"
```

## 10. Verify what actually shipped

Do not report success from exit codes alone:

```sh
npm view agentclock version                    # must be <X.Y.Z>
npx -y agentclock@<X.Y.Z> --version            # the published artifact, not the checkout
gh release view v<X.Y.Z> --json tagName,url
```

Then report: version, npm URL, release URL, and anything you skipped.

## Invariants

- **Never publish an untagged tree, never tag an unmerged one.** Both have
  happened here; both make "which commit is 0.1.0?" unanswerable.
- **`package.json`, `package-lock.json`, and `src/cli.ts` carry the same
  version.** Three files, one number.
- **Zero runtime dependencies is a release-blocking check.** If `dependencies`
  in `package.json` is non-empty, stop and ask — `npx agentclock` starting in
  under a second is the reason it is empty.
- **Nothing that leaves the machine gets added quietly.** No telemetry, no
  network calls, no postinstall script. Check the diff for them before shipping.
