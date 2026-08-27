# Contributing to `@lucasfe/ralph`

Thanks for your interest. Ralph is an autonomous GitHub-issue resolution
loop packaged as a CLI. It was extracted from the
[`agenthub`](https://github.com/lucasfe/agenthub) monorepo (where it was
dogfooded into maturity) and now lives standalone at
[`lucasfe/ralph`](https://github.com/lucasfe/ralph).

## Local development

```bash
git clone https://github.com/lucasfe/ralph.git
cd ralph
npm install
npm test            # vitest run
npm run test:watch  # vitest watch mode
```

The package has no build step — the published artefact is the source.
Three runtime deps (`commander`, `execa`, `picocolors`); tests use
`vitest` + `memfs` for hermetic filesystem assertions.

### Test hermeticity (#41)

`vitest.config.js` loads exactly one setup file — `test/setup/hermetic-env.js` —
in every worker. It deletes the ambient ralph-domain variables, repoints `HOME` at
a throwaway sandbox under the OS temp dir, and restores `process.env` between
tests. So `npm test` gives the same answer on a laptop and on CI, and a new test
file inherits that with no opt-in.

The name set is **derived from the sources**, not hand-maintained: `RALPH_*` by
prefix, every key passed to `resolveCred()` in `lib/`, and every variable declared
by `templates/ralph.config.sh` / `templates/env.local.example`, plus a short list
of names no file declares (`XDG_CONFIG_HOME`, `PROJECT_ROOT`, `NO_COLOR`, …). Add a
new credential or config knob and it is neutralized automatically. `NO_COLOR` earns
its place on that undeclared list for a reason worth stating: it is a cross-tool
convention nobody declares in a template, and a contributor who happens to export it
would otherwise flip every colour-gated assertion in the suite at once (see
[the sprite banner](#the-sprite-banner-generated-asset-placeholder-art)).
`pool: 'forks'` is pinned in the same config for a reason documented there: the `HOME` sandbox
travels through `process.env`, which only reaches `os.homedir()` when each worker
is its own process.

To assert environment resolution, opt in **explicitly**: inject the bag
(`processEnv: { XDG_CONFIG_HOME: '/xdg' }`, `home: '/home/me'`) for unit tests, or
set the variable on the child env / `process.env` inside a test that spawns a
process — it is reverted before the next test. Mutate in a `beforeEach`, not a
`beforeAll`: the per-test snapshot is taken after `beforeAll`, so a value set there
is sticky for the rest of the file. Never rely on a variable the invoking shell
happens to export. The contract is asserted by `test/hermetic-env.test.js`,
`test/hermetic-env.qa.test.js` and `test/hermetic-env.idempotence.qa.test.js`.

## Pull requests

- Branch off `main` and open a PR against `main`.
- Keep PRs scoped to a single change — every change should be reviewable
  on its own and rollback-friendly via `git revert`.
- Use [Conventional Commit](https://www.conventionalcommits.org/) titles
  (`feat:`, `fix:`, `chore:`, `docs:`, …). release-please reads them to
  compute the next version and generate the changelog, so the title is
  load-bearing: `fix:` → patch, `feat:` → minor, `!`/`BREAKING CHANGE` →
  major.
- Run `npm test` before pushing. CI runs `npm ci && npm test` on every
  push and pull request.
- Follow strict semver: patch = bug fix, minor = additive feature,
  major = breaking with migration notes added to `CHANGELOG.md`.

## Orchestrator templates: edit both, always

Ralph ships **three** orchestrator templates:

- `templates/prompt-team.md` — the Claude Code orchestrator (GitHub source).
- `templates/prompt-team-codex.md` — the Codex orchestrator (GitHub source).
- `templates/prompt-team-folder.md` — the folder-mode orchestrator (#565),
  selected by `build-prompt.js` when `TASK_SOURCE=folder`. It composes the
  **same** shared role files as the other two but forks the intake and
  completion prose: it reads a local task file, moves it `todo → in-progress`,
  commits straight to `DEV_BRANCH`, and moves the file to `done/` (no PR/merge).
  It is **not** covered by `template-parity.test.js` (that test asserts only the
  Claude ↔ Codex pair), so its shared skeleton can drift — keep it in sync by
  hand when you touch a role placeholder or a numbered step that all templates
  share.

The shared specialist roles (`templates/roles/*.md`) are composed into all via
the same `{{ROLE_DEV}}` / `{{ROLE_QA}}` / `{{ROLE_REVIEW}}` / `{{ROLE_WRITER}}` /
`{{ROLE_EXPLORER}}` placeholders, and all consume the same `{{INSTALL_CMD}}`,
`{{TEST_CMD}}`, branch, merge, and `{{RALPH_HEAVY_TIER}}` variables. Only the
**orchestrator body** is forked — it describes how each agent delegates (Claude
Code's subagents vs. Codex's sequential-persona degradation) and, for the
folder template, how intake/completion differ from the GitHub flow, so the
bodies are deliberately not identical.

**When you change one orchestrator template, change the others to match.** Any
edit to a shared placeholder, a numbered step heading, the `## Absolute
restrictions` block, or a PR-body section name must land in **all** the files it
applies to. `lib/template-parity.test.js` enforces this **for the Claude ↔ Codex
pair** in CI: it asserts that both GitHub templates carry the same role
placeholders, variables, step headings, restriction rules, and PR-body sections,
so a one-sided edit fails the suite instead of shipping a skewed Codex prompt.
The folder template is **not** in that assertion, so keep it in sync by hand.
The forked orchestrator prose is not asserted, so you are free to word each
agent's delegation instructions differently — just keep the shared structure in
lockstep.

### Codex maturity, sandbox, and network — do not "tighten" these

- **The Codex path is experimental.** It is unit- and stub-tested (registry,
  stream parsing, invocation argv, auth probe, template parity, and the full
  bash loop against a stubbed `codex`), but it has **not** been run end-to-end
  against a live `codex` CLI. The default Claude path is unchanged and fully
  exercised. Keep the README's experimental callout honest — do not upgrade the
  claim until a real live run has happened.
- **The `workspace-write` sandbox is a *partial* boundary.** In design testing
  it did not block a write to the system temp directory, so the Codex
  orchestrator's stay-inside-the-project rule — not the sandbox — is what
  contains a run. The `## Absolute restrictions` note in
  `prompt-team-codex.md` documents this deliberately; do not delete it.
- **Network access is required and enabled on purpose.** `codex exec` runs with
  `sandbox_workspace_write.network_access=true` (see `lib/agent-registry.js`)
  because the loop must run `gh`, `npm`, and `git push` every iteration.
  Disabling network access breaks the loop — no PR can be opened or merged. Do
  not "harden" it away.

## The sprite banner: generated asset, placeholder art

`ralph start` prints a pixel sprite as its first output on a colour terminal, and
an identity box under it on every run (see
[the README](./README.md#quick-start)). Six published modules under `lib/` back
the two halves, the first of them fed by a generator that is not published at all:

- `lib/sprite-data.js` — **GENERATED. Do not edit by hand.** It is the committed
  asset: a palette plus one row-per-pixel grid per frame. Regenerate it, never
  patch it:
  ```bash
  node scripts/generate-sprite.js <source.gif>   # → lib/sprite-data.js
  ```
  The generator is deterministic — same GIF, same flags, byte-identical module —
  which is the whole reason hand-editing is pointless. `--help` lists the grid,
  palette-size and near-black flags; the defaults are the measured values for the
  intended source art.
- `lib/sprite-render.js` — the pure half-block renderer (two pixel rows per text
  row, so a 26x34 grid draws as 26 columns x 17 lines).
- `lib/sprite-banner.js` — the *decision*: may we draw, and what exactly gets
  printed. Both of its capabilities (**stdout** TTY-ness and the colour policy)
  arrive as arguments, and `ralph start` resolves them into injectable
  `stdoutIsTTY` / `color` options rather than reading `process.stdout` or
  `process.env` anywhere down the stack. Keep it that way — a module that read
  `process.env.NO_COLOR` itself would turn every test that injects an environment
  into a test of the contributor's shell, which is what
  [test hermeticity](#test-hermeticity-41) exists to prevent. `NO_COLOR` is
  honoured on **presence** here, deliberately unlike picocolors' truthiness test;
  the reasoning is in the module's docstring and the README's env-var row, and both
  should move together if it ever changes.
- `lib/banner-compose.js` — the banner's *other half*: the identity box, composed
  from **resolved facts**. Pure in the same way and for the same reason — no
  `process`, no clock, no fs, and no cache read of its own — so `ralph start`
  resolves every fact on the impure side (the installed version, the working
  directory, the cached `latest_version`, and the newest release's changelog
  bullets) and hands them over. Injectable options carry the rest: `columns`,
  defaulting to `stdout?.columns`; `readCache`, defaulting to `readVersionCache`;
  and `readChangelog`, defaulting to `readChangelogEntries`, with a `changelogFs`
  beneath it so the default wiring is testable too. The last two are seams for the
  same reason: no suite may read a real `~/.config/ralph` or the shipped release
  notes, so neither a contributor's own pending update nor whatever this week's
  changelog happens to say can add a row to another suite's expected output. Later
  slices add **rows, not parameters**: `composeBanner`'s three arguments (`facts`,
  `width`, `capabilities`) are the seam, and a new fact belongs in the object
  `start` already builds — which is exactly how #70's what's-new rows landed, as a
  `whatsNew` entry in that object with the signature untouched. The box is
  deliberately **not** capability-gated the way the sprite is — facts belong in a
  launchd log too — so a piped `ralph start` is no longer byte-identical to a
  pre-banner one, and an assertion about what a non-TTY run does *not* print has to
  name the sprite rather than ANSI in general (`expectNoSprite` in
  `lib/commands/start.banner.qa.test.js`, whose comment says why).
- `lib/changelog.js` — `CHANGELOG.md` **as data**, for the box's what's-new rows:
  text in, ordered release entries out, and nothing else. Pure, and it takes a
  *string* rather than a path, so every shape it has to survive (an empty file, a
  bullet wrapped over three lines, a CRLF checkout) is a string literal in a test
  instead of a fixture. It is **total** — a changelog nothing can be made of is
  *no entries*, never a throw, because `ralph start` prints this box before its
  first preflight line and must not abort over its own release notes. It holds no
  semver opinion either: release-please writes newest-first, so the parser reports
  the order it read rather than sorting, which is the same refusal to have a second
  version opinion that `banner-compose.js` makes above it.
- `lib/changelog-file.js` — the impure half of that pair: one path, one read.
  `changelogPath()` joins `RALPH_HOME` (which `lib/paths.js` derives from
  `import.meta.url`) and **never the cwd** — `ralph start` runs inside the user's
  repo, and that repo has a `CHANGELOG.md` of its own, so a cwd-relative read would
  put somebody else's release notes in Ralph's banner. Every failure is `[]`: a
  missing file, an unreadable one, an fs that is not one. `CHANGELOG.md` is in
  `package.json`'s `files`, which is what makes the section affordable on every
  start — the answer is already on disk beside `lib/`, so there is no round trip in
  front of the first paint. Keep it that way if you touch either file.

**The committed art is a placeholder.** This repository carries no Wreck-It Ralph
GIF and never did — #66 made the source a developer-supplied *input*, which is why
the generator takes a path instead of a constant — so `lib/sprite-data.js` was
generated from a synthesized, original, obviously-not-Ralph stand-in put through
the real generator unedited:

```bash
node scripts/placeholder-sprite-source.js   # deterministic GIF, written to the OS temp dir
node scripts/generate-sprite.js <the path it just printed>
```

Swapping in real art is **one command** (`node scripts/generate-sprite.js
ralph.gif`) — no test pins a pixel or a colour. Afterwards, four placeholder files
are deleted **together**, and the two spec files among them are designed to go red
the moment the real art lands, which is the reminder:

```
scripts/placeholder-sprite-source.js
scripts/lib/placeholder-art.js
test/sprite-placeholder-source.test.js
test/sprite-placeholder-source.qa.test.js
```

In that last one, **keep or move the packaging block** (the `npm pack` manifest
closure check) — it guards what the published tarball contains and is worth having
with or without a placeholder.

Everything under `scripts/` is **development-only and unpublished by
construction**: `package.json`'s `files` is an allow-list (`bin`, `lib`,
`templates`, and two markdown files), so there is no ignore rule to keep in sync.
`lib/` *is* published, which is how the committed sprite data reaches an installed
Ralph. Nothing under `lib/` or `bin/` may import from `scripts/` or `test/`, and
that is asserted rather than trusted.

## Manual smoke test (pre-release recipe)

Before each release we exercise the package against an unrelated project
to catch path/template bugs that unit tests can't surface.

1. **Pack a tarball locally** from the repo root:
   ```bash
   npm pack
   # → lucasfe-ralph-<version>.tgz
   ```
2. **Install the tarball into a sibling project** (a real git repo of
   your choice, ideally a stack different from the host so
   `detect-stack` is exercised):
   ```bash
   cd /path/to/other-project
   npm i -g /absolute/path/to/lucasfe-ralph-<version>.tgz
   ```
3. **Run `ralph init`** at the project root and verify that:
   - `ralph.config.sh`, `PROMPT.md`, `.env.local.example`,
     `ralph-notify.sh.example`, and `.claude/commands/ralph.md`
     are created.
   - Detected `INSTALL_CMD`, `TEST_CMD`, `LINT_CMD`, `MAIN_BRANCH`,
     `DEV_BRANCH`, `PR_TARGET` match the project's stack.
   - `.gitignore` gets `.ralph/`, `ralph-notify.sh`, `.env.local`
     appended (idempotent — re-running init must not duplicate).
4. **Run `ralph doctor`** and confirm that:
   - The dep summary is correct for the OS (`brew install ...` on
     macOS, `apt install ...` on Linux/WSL).
   - The version line under the header names the tarball version you
     just installed. Its `cached latest:` half comes from the global
     update-check cache, which is written by the weekly check in
     `ralph start` and in `ralph cycle` — so it reads `unknown (no update
     check cached yet)` on a machine where neither has run, and reads a
     real version on a machine with scheduled cycles installed. Both are
     expected here; neither is a failure. `doctor` must return immediately
     either way: it makes no registry query.
5. **Pick a real open issue** in the project and run `ralph start`.
   Watch via the `tmux attach` command `ralph start` prints (the session is
   per-project: `ralph-<repo>-<hash>`). Verify that:
   - The **sprite** is drawn as the very first thing on the terminal, above the
     preflight lines, with the **identity box** immediately under it. This is the one
     place a real TTY is exercised — the hermetic suite injects `stdoutIsTTY` and
     `columns` and never touches a terminal — so check both suppressions here as
     well. Piped: `ralph start 2>/dev/null | cat -v` must show no sprite and no
     truecolor escape (`^[[38;2;`, `^[[48;2;`) while the box is **still there**, in
     plain text, holding its 60 columns, with the remaining lines and the exit code
     unchanged. Value-less `NO_COLOR`: `NO_COLOR= ralph start` on the same terminal
     must drop the sprite while the ✅ / ⚠️ lines stay coloured — the divergence from
     picocolors is intentional, so this is the pass condition, not a bug — and the
     box must survive it too, losing only the yellow on its `update` row.
   - The box's **`update` row is the one line that depends on machine state**: it is
     printed only when the global update-check cache already holds something newer
     than the tarball you just installed, so on a machine where nothing has ever
     checked there is nothing to see and that is not a failure. Resize the window
     too: under 60 columns the box must narrow and clip its values with `…`, never
     wrap a line or run its right border ragged. And `RALPH_NO_UPDATE_CHECK=1 ralph
     start` must leave the box with its title, its `cwd`, and its what's-new rows
     alone.
   - The box's **`new` rows** are read from the `CHANGELOG.md` inside the tarball you
     just installed, and this step is the only place that read happens for real — the
     hermetic suite injects an fs and never touches the file. They must show the three
     bullets at the top of **Ralph's** newest entry (clipped with `…`), even though the
     sibling project you are standing in very likely has a `CHANGELOG.md` of its own:
     anything out of *that* file in the box is a cwd-relative read and a bug. The
     `more` row names `ralph changelog`, which is not a command yet, so that command
     erroring out is expected here rather than a failure.
   - Lazy validation runs on first start (`.ralph/state.json` did not
     exist), Claude rewrites the config if needed, and the state file
     is created.
   - The loop selects the issue, opens a PR, polls until merge,
     closes the issue, and emits the end-of-run summary on stdout.
   - `logs/ralph-issue-N.log` exists for the issue.
   - `ralph status` — run once from the project root and once from a
     subdirectory — reports `running`, the same run id both times, the issue
     in flight, and a live queue depth. This step is the only place the loop's
     run-state writes are exercised for real: `.ralph/run-state.json` is
     written by `templates/ralph.sh`, which the unit suite can only drive
     against stubs. The same holds for `.ralph/metrics/issues.jsonl`, which
     backs the `pace` / `eta` / `spend` lines: once the first issue completes
     they must show real numbers instead of `unknown` (on a Codex project
     `spend` stays `unknown`, which is correct — the Codex stream carries no
     cost).
   - `ralph status --json | jq .` prints one document and no `jq` error, and —
     once `eta.finish_at` is non-null —
     `ralph status --json | jq '.eta.finish_at | fromdate'` prints an epoch
     number. The hermetic suite pins the document's shape but never runs `jq`,
     so this is the one place the timestamp format meets the parser it is
     truncated to the second for.
   - The startup box's `Projection:` lines, for the same reason. On the **first**
     `ralph start` in a fresh project there is no `.ralph/metrics/issues.jsonl`
     yet, so the block is correctly **absent** — never `~0 min/task · ~$0/task`.
     Run `ralph start` again once an issue has completed (with something left in
     the queue) and it must show real minutes and dollars per task, a total, and
     a plausible local finish clock. On a Codex project the dollar segments drop
     out and the minutes stay, which is correct.
   - The **digest window**, which is the part of it the hermetic suite can only
     drive against a stubbed `tmux`. Set `RALPH_DIGEST_INTERVAL="2m"` in
     `ralph.config.sh` and run `ralph start` again:
     `tmux list-windows -t ralph-<repo>-<hash>` must show a second window named
     `digest` beside the loop's, the startup box must read `Digest: every 2m —
     runs alongside the loop`, and within a couple of minutes that pane *and*
     `.ralph/digest.log` must both carry a narrative (on a Codex project, one
     produced by Codex — `start` forwards `RALPH_AGENT` into the window). Then
     set the interval to something the grammar refuses (`0.5h`) and start once
     more: the launch must still succeed, with `⚠️  Digest window not opened`
     on stderr and `NOT running` on the box's digest line.
   - WhatsApp delivery works when `.env.local` is configured (else
     skipped silently).
   - The custom hook fires when `ralph-notify.sh` is present and
     executable (else skipped).
6. **Run `ralph stop`** and confirm the tmux session is gone:
   ```bash
   tmux ls   # must not list the project's ralph-<repo>-<hash> session
   ```
   `ralph status` must now read `interrupted`, not `running`: `stop` is a
   `tmux kill-session`, so the loop never gets to write a terminal record —
   precisely the case that mode exists for. With a digest interval still
   configured, this is also the teardown check: `stop` kills the *session*, so
   the `digest` window must be gone with it and the next `ralph start` must not
   report the session name as already taken.
7. **Re-run `ralph start`** with no eligible issues and confirm it
   exits with `ℹ️  No issues in the queue. Nothing to do.`
8. **Edit `ralph.config.sh`** by hand (e.g. change `MERGE_STRATEGY`),
   then `ralph start` again. Lazy validation should re-run because
   the sha256 of the file changed.
9. **Bump `RALPH_VERSION` mismatch** by editing
   `.ralph/state.json` to a fake `ralph_version`. Next `ralph start`
   must re-validate.

If any step misbehaves, [file an issue](https://github.com/lucasfe/ralph/issues)
with the reproduction command and `logs/`.

## Releasing

Releases are automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml) via
[release-please](https://github.com/googleapis/release-please) and npm
[Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers).
The maintainer flow is:

1. Land `feat:` / `fix:` PRs on `main`.
2. release-please opens (or updates) a **Release PR** that bumps
   `package.json` and prepends a `CHANGELOG.md` entry.
3. Review and merge the Release PR. The merge tags `vX.Y.Z` and, on the
   resulting `push: main`, the `publish` job publishes `@lucasfe/ralph`
   to npm with provenance (prereleases go to the `rc` dist-tag; stable
   to `latest`).

No long-lived npm token is stored — publishing authenticates via OIDC,
so the npm Trusted Publisher for `@lucasfe/ralph` must point at this repo
(`lucasfe/ralph`) and the `release.yml` workflow.
