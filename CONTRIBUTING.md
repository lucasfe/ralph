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

### Source hygiene: no raw control bytes (#107)

No file committed here may carry a raw C0 control byte (TAB, LF and CR excepted)
or DEL. Plenty of tests need those bytes — most of the suite's ANSI assertions do —
so write them as **escapes**: `\u001B` in a string, template or regex literal, or
`String.fromCharCode(27)` when a sequence is assembled into a `RegExp`. Both
spellings are byte-identical to the raw byte at runtime, so what the code under
test receives is unchanged; only what a reader and a search tool can see changes.

Two bytes are worth naming, because neither cost is obvious. A raw **U+0000
(NUL)** makes `file` classify the source as `data`, and grep, `rg` and `git grep`
then skip the file — silently, without so much as a line count, while Node reads
it perfectly well. #107 found two committed test files in exactly that state: the
coverage existed and nothing could find it. A raw **U+001B (ESC)** stays
greppable but is a live escape sequence, so `cat`-ing or `less`-ing the file
recolours the reader's terminal from that line on.

The rule is **asserted** rather than merely written down, because it *was* written
down — in `lib/commands/doctor.identity-box.test.js` — and violated twice anyway,
and the failure is silent by construction: the suite stays green while a whole test
file leaves the searchable repo. The guard's scope is **what `git ls-files`
tracks**, which is a rule rather than a hand-maintained skip list: a `coverage/`
report, a `.DS_Store`, or the `.env.local` the README asks you to create is not
authored source and never reaches the sweep, and nothing under `.git/` or
`node_modules/` needs excusing. The cost of that choice, stated so it does not
surprise you: a new file is out of scope until it is staged. It also **fails
closed** — a missing `git`, a directory that is not a repository, or an empty file
list throws rather than reporting a clean sweep, since a guard that quietly scans
nothing is the same blind spot #107 is about. NUL is forbidden in **every** tracked
file; ESC and the rest of the class are checked in `.js`. The contract is asserted
by `test/source-control-bytes.test.js` and `test/source-control-bytes.qa.test.js`
(which plants offenders and proves the detector actually fires), both driving the
one shared detector in `test/helpers/source-control-bytes.js`.

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

`ralph start` plays a one-second pixel-sprite splash as its first output on a
colour terminal, settles it on a still frame, and prints an identity box under it
on every run — or as much of that as `RALPH_BANNER` asked for (see
[the README](./README.md#quick-start)). Since #75 `ralph doctor` heads its report
with that same box, and since #76 `ralph status` heads its human view with it
too — out of the same composer and the same setting, and with none of the pixels
in either: three commands share this half, one shares both. Eight published
modules under `lib/` back the two halves and the setting that governs them, the
first of them fed by a generator that is not published at all:

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
  printed. All three of its inputs (**stdout** TTY-ness, the colour policy, and the
  terminal's `width`) arrive as arguments, and `ralph start` resolves them into
  injectable `stdoutIsTTY` / `color` / `width` options rather than reading
  `process.stdout` or `process.env` anywhere down the stack. Keep it that way — a
  module that read `process.env.NO_COLOR` itself would turn every test that injects
  an environment into a test of the contributor's shell, which is what
  [test hermeticity](#test-hermeticity-41) exists to prevent. `NO_COLOR` is
  honoured on **presence** here, deliberately unlike picocolors' truthiness test;
  the reasoning is in the module's docstring and the README's env-var row, and both
  should move together if it ever changes. The width is asked **last** and is only
  ever a reason to stay silent, so no column count can talk a piped stream into a
  screenful of escapes — and it holds no threshold of its own: it asks
  `bannerLayout` (below) for the verdict. Do not give this module a 26 of its own.
  Two copies of that number are two thresholds the day one of them moves, and the
  failure would be silent — a sprite still drawn at 25 columns above a box that had
  already unboxed. Since #73 that one gate answers **two** entry points:
  `renderSplashFrames`, every frame in the order the splash plays them, which is what
  `ralph start` calls; and `renderStaticBanner`, the poster frame alone, which **no
  command calls any more and which stays anyway**. It is the oracle — three specs
  compare the frame the animation settles on against its output, so "the splash ends
  on the frame an unanimated banner would have drawn" is a comparison between two
  functions instead of a claim about one. Do not retire it as dead code; a caller
  with no stream to write to has no other answer available.
- `lib/sprite-player.js` — the splash (#73), and the **one impure module** in this
  list: it writes bytes to a stream and waits between them, which is why it is a
  file of its own rather than a loop inside `start.js`. Everything it is impure
  through arrives as an argument — the stream, the `sleep`, the signal source, the
  re-raise — so a one-second animation is a sequence a test compares byte for byte
  in microseconds, with no timer and no listener on the real process. Two rules
  worth keeping. **The bound is structural:** `splashSequence` builds a fixed array
  before the first byte goes out and the loop is a `for...of` over it, so a splash
  can never hang a `ralph start`; there is no `while`, no clock comparison and no
  interval, and a static read in the spec asserts that absence. **It knows no
  height:** every cursor-up is derived from the frame just written, so regenerating
  the art at another size cannot desync the animation from it — a hardcoded `17`
  here is the bug that walks the cursor up through the previous run's output. It
  holds no gate either: `renderSplashFrames` answers with an empty list on a pipe,
  under `NO_COLOR` and below 26 columns, and an empty list plays *nothing* — not a
  sleep, not a cursor toggle, not one byte. `cycles: 1` is byte-for-byte the
  unanimated banner, and that is the whole of `RALPH_BANNER=static` (#74): the mode
  resolver hands this module the same frames and a `cycles` of 1, and adds nothing
  else here — no mode, no knob, no notion of `full`/`static`/`off`. Keep it that way;
  a `RALPH_BANNER` read in this file would put the policy in two places, and the one
  that matters is `lib/banner-mode.js`'s. The two seams are
  this module's defaults and **`start.js` forwards them rather than defaulting them
  itself**, so `sleep` and `signals` are named once, here, where the spec asserts them.
  The consequence for a contributor: any test that drives `startCommand` over a TTY
  stdout has to inject both, or it buys a real second of wall clock per run and hangs a
  SIGINT listener on the vitest worker's own process.
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
  `whatsNew` entry in that object with the signature untouched. #75 added the
  second caller on that same seam: `ralph doctor` passes `os`, `agent` and
  `cachedLatest` and gets the `os` / `agent` / `cached` rows for them, while
  `ralph start` passes none of the three and is unchanged to the byte — because
  each of those rows is **gated on its fact being present**, unlike every older
  row, which says `unknown` when it was not given one. A caller that never asked
  a question has no answer to report, and `os      unknown` in a pasted bug
  report would send a reader hunting a platform-detection bug that does not
  exist. `cachedLatest` is deliberately a separate fact from `latestVersion`
  rather than a second reading of it: `latestVersion` is advice and draws a row
  only when there is something to act on, `cachedLatest` is a *reading of the
  cache* and always draws one, including the "nobody has checked yet" state a
  diagnostic must not swallow. Keep them apart, or `ralph start` grows a row and
  `doctor` loses a verdict. `os` rather than `platform` is arithmetic, not taste:
  the label gutter is eight columns and `padEnd` does not grow, so `platform`
  would print `platformmac`. #76 added the third caller, and it is the argument
  for this seam rather than a strain on it: `ralph status` passes `version` and
  `cwd` and nothing else, and gets a one-row box out of the same composer with no
  new parameter, no new row, and not a line changed in this module — which is what
  "rows, not parameters" was supposed to buy. The `width`
  argument is the one that came home to roost: `bannerLayout(width)` is the whole
  degradation ladder in one pure, total function — box from `BOX_MIN_WIDTH` (44)
  up, sprite from `SPRITE_MIN_WIDTH` (26) up, and any width that cannot be used at
  all falling back to the 60-column `BANNER_WIDTH` rather than throwing or
  degrading. It is the *only* place either rung is read, which is what makes every
  one of them testable without a terminal, and the two line forms it selects
  between (`BOXED` / `BARE`) are data rather than a conditional inside each builder
  — so a box whose top is framed and whose rows are not is unreachable. `26` is
  deliberately **not** imported from `sprite-data.js` (this half knows nothing about
  pixels); a test pins `spriteWidth === SPRITE_MIN_WIDTH` instead, so redrawing the
  art wider goes red in the suite rather than tearing on a narrow terminal. The box is
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
  missing file, an unreadable one, an fs that is not one — a policy that belongs
  to `readChangelogEntries` and the banner **alone**, because that read happens
  before `ralph start`'s first preflight line. `lib/commands/changelog.js`
  (`ralph changelog`, #71) takes the same `changelogPath()` and the same
  `parseChangelog`, so the two can never disagree about what a release
  contained, but does its own guarded read on purpose: a user who *typed* a
  command about the changelog is owed the failure, named, with the path in it and
  a non-zero exit. Do not unify them on the reader that swallows everything.
  `CHANGELOG.md` is in `package.json`'s `files`, which is what makes the section
  affordable on every start — the answer is already on disk beside `lib/`, so
  there is no round trip in front of the first paint — and what makes
  `ralph changelog` answerable offline, from any directory. Keep it that way if
  you touch either file.
- `lib/banner-mode.js` — the *policy* (#74), and the one module here that sits above
  both halves: how much of all of the above the user actually asked for. One pure
  function — `resolveBannerMode({ configured, override, isTTY, color, width })` —
  returning the three decisions `start.js` needs (the effective `mode`, whether there
  is a `sprite`, whether the `box` prints at all) plus a `warning` it does **not**
  print, for the same reason `resolveAgent` returns one: a module that wrote to stderr
  could not be asserted as a table, and only the caller knows which stream a warning
  belongs on. Three rules worth keeping. **Precedence is environment over config**,
  deliberately the opposite of the `TASK_SOURCE` line in `start.js`, because a task
  source is a property of the repository while a banner is a property of one
  invocation — do not "harmonize" the two, and do not describe precedence in the docs
  as if one rule covered both. **The capability cap runs downward only:** `full` into
  a pipe behaves as `off`, and no value, spelling or combination can put a sprite on a
  non-terminal — the only hatch is still the programmatic one `sprite-banner.js`
  documents. **And the cap stops at the sprite:** `mode` is what the terminal can
  effect, `box` is what the user *requested*, which is why they are two answers rather
  than one — a piped `ralph start` has printed the identity box since #68, and only an
  explicit `off` may take it away. It holds no threshold of its own (`bannerLayout`
  answers the sprite rung, exactly as `sprite-banner.js` asks it) and no opinion about
  what the box *looks* like: an earlier draft of #74 resolved the frame here and passed
  it down as a capability, which made two owners of one decision, so it is gone. The
  impure half is the caller's, and it moved for this: `start.js` reads
  `ralph.config.sh` (text-parsed with `parseConfigVar`, never sourced) at the **top**
  of `startCommand`, above the picture that file decides, and puts the warning on
  stderr behind the same `⚠️` prefix `ralph init` uses for a mistyped `RALPH_AGENT`.
  Only the read moved — `TASK_SOURCE` and `RALPH_DIGEST_INTERVAL` are still derived at
  the preflight step that uses them, out of that same one read. Since #75 and #76
  this resolver has **three** callers, reading different parts of one answer:
  `lib/commands/doctor.js` does the same text-parsed read of the same file with the
  same precedence — which is what makes `RALPH_BANNER` one knob rather than two that
  share a name — but reads `box` alone. It passes **no `isTTY`**, so no arrangement of
  its arguments can authorise a sprite, and it **drops the warning deliberately**. That
  used to be half a constraint: wording one safely meant `oneLine`, which lived in
  `lib/digest.js` and so behind execa, and `doctor` is the command people run when
  things are already broken — it takes no exec dependency and opens no socket, and a QA
  spec walks its whole import graph to keep it that way. #108 removed the constraint
  (`oneLine` now lives in `lib/one-line.js`, which imports nothing, and `doctor` reaches
  it transitively for the `RALPH_AGENT` warning it *does* print) and left the judgement,
  which was always the better half: a typo in a **cosmetic** knob does not earn a line in
  a diagnostic. Do not "fix" that silence into a warning; it costs a `doctor` user
  nothing, and `ralph start` names it. `lib/commands/status.js` is the third, on the
  same read, the same precedence, the same absent `isTTY` and the same `box`-alone
  answer — and it drops the warning for a reason of its own, simpler and stronger
  than `doctor`'s: that command has **no stderr channel at all** (no `stderr` in its
  deps bag, deliberately), which is what keeps `ralph status --json` pipeable. Do not
  give it one in order to word a banner typo. It is also the one caller that does not
  always ask: `never-run` short-circuits *before* the resolver, because that mode is
  pinned as reading nothing — `ralph.config.sh` included — so resolving there would
  answer "draw the default box" out of a config nobody opened, and the box names a
  run that mode does not have.

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
   - The **identity box** heads the output (#75) — above the dep report and
     above the abort on a missing required dep — with the tarball version you
     just installed as its title and `os`, `agent`, `cached` and `cwd` rows
     under it. No sprite, no animation and no cursor movement belong anywhere
     in it, at any `RALPH_BANNER` value, and a mistyped `RALPH_AGENT` puts its
     warning line *under* the closing `╰──╯` — **one** line, whatever the value
     was (#108). Worth typing once, because it is the defect that issue closed:
     `RALPH_AGENT=$'codx\nos      linux' ralph doctor` must print a box with its
     real `os` row and no second one, and a warning holding a visible `U+FFFD`
     where the newline was. Every echo of a user's value in `doctor` and `init`
     goes through `oneLineEcho` from `lib/one-line.js` for this; if you add
     another one, use it.
   - The `cached` row comes from the global update-check cache, which is
     written by the weekly check in `ralph start` and in `ralph cycle` — so it
     reads `unknown (no update check cached yet)` on a machine where neither
     has run, and a real version on a machine with scheduled cycles installed:
     `<version> — up to date`, or ``<version> available — run `ralph update` ``
     when the cache is ahead of the tarball. All three are expected here; none
     is a failure. `doctor` must return immediately either way: it makes no
     registry query.
   - `RALPH_BANNER=off ralph doctor` prints **no box and not one blank line**,
     so the output starts at the first dep line, while
     `RALPH_BANNER=loud ralph doctor` prints the default box and **no warning
     on either stream** — the one place this knob behaves differently from
     `ralph start`, and the thing a contributor is most likely to "fix" by
     accident.
5. **Pick a real open issue** in the project and run `ralph start`.
   Watch via the `tmux attach` command `ralph start` prints (the session is
   per-project: `ralph-<repo>-<hash>`). Verify that:
   - The **sprite** is drawn as the very first thing on the terminal, above the
     preflight lines, with the **identity box** immediately under it — and since #73 it
     *animates* for about a second before it settles, so watch this one rather than
     glancing at it. This is the one place a real TTY is exercised — the hermetic suite
     injects `stdoutIsTTY` and `columns`, and `sleep` and `signals` besides, and never
     touches a terminal — so the splash is only ever *seen* here. Four things to look
     for that no spec can show you: the frames must redraw **in place**, so when the run
     is over the scrollback holds one sprite and not five, and nothing above the sprite
     has been walked over; the box's `╭─` must land clean under the settled frame, with
     no stray escape in front of the corner; the **cursor must be visible again** for the
     rest of the run (if it has vanished, the restore did not happen — `reset` your shell
     and treat that as a bug, not a quirk); and a `Ctrl-C` *through the middle of
     the animation* must leave the cursor visible and exit **130** (`echo $?`), the same
     as a `Ctrl-C` anywhere else in the run. Then check both suppressions here as
     well. Piped: `ralph start 2>/dev/null | cat -v` must show no sprite and no
     truecolor escape (`^[[38;2;`, `^[[48;2;`) — and none of the splash's control
     sequences either (`^[[?25l`, `^[[?25h`, `^[[17A`), because a suppressed sprite is
     not animated at half volume — while the box is **still there**, in plain text,
     holding its 60 columns, with the remaining lines and the exit code unchanged. It
     must also come back no slower than it used to: nothing is waited for on a pipe.
     Value-less `NO_COLOR`: `NO_COLOR= ralph start` on the same terminal must drop the
     sprite while the ✅ / ⚠️ lines stay coloured — the divergence from
     picocolors is intentional, so this is the pass condition, not a bug — and the
     box must survive it too, losing only the yellow on its `update` row.
   - **The three `RALPH_BANNER` modes** (#74), which are the other thing only a real
     terminal can show you. `RALPH_BANNER=static ralph start` must land the settled
     frame **once**, with no visible redraw and no flicker, and the box under it — the
     same picture `full` ends on, arrived at without the second of animation.
     `RALPH_BANNER=off ralph start` must print **nothing** above its first preflight
     line: no sprite, no box, not one blank line, and the rest of the run unchanged.
     `RALPH_BANNER=loud ralph start` must draw the **full** banner anyway and put one
     `⚠️` line on stderr — so `RALPH_BANNER=loud ralph start 2>/dev/null` shows the
     banner and no warning at all, which is the check that stdout stayed clean. Then
     write `RALPH_BANNER="off"` into the project's `ralph.config.sh` and confirm both
     directions: a bare `ralph start` draws nothing, while a `RALPH_BANNER=full`
     prefixed onto the same command animates anyway, because the environment wins
     over the file here — the opposite way round to `TASK_SOURCE`, and the one thing
     about this knob a contributor is most likely to assume backwards.
   - The box's **`update` row is the one line that depends on machine state**: it is
     printed only when the global update-check cache already holds something newer
     than the tarball you just installed, so on a machine where nothing has ever
     checked there is nothing to see and that is not a failure. Resize the window
     too, and walk the whole ladder: under 60 columns the box must narrow and clip
     its values with `…`, never wrapping a line or running its right border ragged;
     under 44 it must drop the border entirely and print bare `label   value` rows;
     and under 26 the sprite must go as well — whole, not clipped — leaving those
     bare rows behind it. No width may wrap a line, tear a row, or lose the version.
     And `RALPH_NO_UPDATE_CHECK=1 ralph start` must leave the box with its title,
     its `cwd`, and its what's-new rows alone.
   - The box's **`new` rows** are read from the `CHANGELOG.md` inside the tarball you
     just installed, and this step is the only place that read happens for real — the
     hermetic suite injects an fs and never touches the file. They must show the three
     bullets at the top of **Ralph's** newest entry (clipped with `…`), even though the
     sibling project you are standing in very likely has a `CHANGELOG.md` of its own:
     anything out of *that* file in the box is a cwd-relative read and a bug. The
     `more` row names `ralph changelog`: run it here too, and from a directory that is
     no Ralph project at all. It must exit 0 and print **Ralph's** releases — the
     newest one with every bullet the box clipped away, and the whole file under
     `--all` — never the release notes of whatever repo you are standing in.
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
   - The **identity box** heads that same human view (#76), above the `▸ ralph`
     line, with the tarball version as its title and a single `cwd` row under it —
     no `update`, `os` or `agent` row, and no sprite, no animation and no cursor
     movement at any `RALPH_BANNER` value. That row is the git **toplevel**, so the
     subdirectory run above must print the *same* `cwd` as the root run rather than
     the directory you typed it in. `RALPH_BANNER=off ralph status` must print no
     box and not one blank line, so the output starts at `▸ ralph`, while
     `RALPH_BANNER=loud ralph status` prints the default box and **no warning on
     either stream** — as in `doctor`, and here for the stronger reason that this
     command writes to stderr in no mode at all.
   - `ralph status --json | jq .` prints one document and no `jq` error, and —
     once `eta.finish_at` is non-null —
     `ralph status --json | jq '.eta.finish_at | fromdate'` prints an epoch
     number. The hermetic suite pins the document's shape but never runs `jq`,
     so this is the one place the timestamp format meets the parser it is
     truncated to the second for. It must stay one document with the box turned
     **on** as well (`RALPH_BANNER=full ralph status --json | jq .`): a frame on
     that path is a broken parse for every consumer downstream.
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
