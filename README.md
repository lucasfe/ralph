# @lucasfe/ralph

Ralph is an autonomous loop that picks the next open GitHub issue, asks
a coding agent to resolve it, opens a pull request, and waits for the merge
— then moves on to the next one. This package extracts the in-repo Ralph
scripts into a reusable CLI so any project can opt in with a single
`npm i -g @lucasfe/ralph` invocation.

By default the coding agent is **Claude Code**. Ralph can also drive the
**OpenAI Codex** CLI instead — see [Choosing the coding agent](#choosing-the-coding-agent).

By default Ralph draws its work from **GitHub issues** (the flow described
above). It can instead pull tasks from a **local `.ralph/tasks/` folder** with
no GitHub remote, auth, or `gh` dependency — committing straight to your dev
branch with no PR. See [Choosing the task source](#choosing-the-task-source).

> **⚠️ Codex support is experimental.** The Codex path is unit- and
> stub-tested (registry, stream parsing, invocation argv, auth probe, template
> parity, and the full bash loop driven against a stubbed `codex` emitting the
> real `codex exec --json` event shape all have coverage), but it has **not**
> been exercised in a live end-to-end run against the real `codex` CLI. Expect
> rough edges and report anything that misbehaves. Claude Code remains the
> fully-exercised default.

The full design is captured in [the original PRD][prd] (tracked in the
`agenthub` repo, where Ralph was first built).

[prd]: https://github.com/lucasfe/agenthub/issues/13

## Install

Global install (recommended — gives you `ralph` on `$PATH`):

```bash
npm install -g @lucasfe/ralph
```

Or run on demand without installing:

```bash
npx @lucasfe/ralph init
```

Requirements: Node ≥18, plus a few system tools that `ralph doctor`
will check for you (`git`, `gh`, `tmux`, `jq`, `curl`) and **one coding-agent
CLI** — either `claude` (the default) **or** `codex`, depending on which agent
you configure. Only the selected agent's CLI is required; `ralph doctor`
validates that one and never asks a Codex-only machine to install `claude` (or
vice-versa). `gh` is required **only** for the default GitHub task source — in
folder mode (`TASK_SOURCE=folder`) `ralph doctor` skips it, so a repo with no
GitHub remote needs only `git`, the agent CLI, and `jq` (see
[Choosing the task source](#choosing-the-task-source)). macOS, Linux, and WSL2
are supported.

## Quick start

In a git repo on the branch you want Ralph to work from:

```bash
ralph init     # one-time: detect stack, write config, slash command, gitignore
ralph doctor   # verify required deps are on PATH, and report installed vs cached latest
ralph start    # launch the loop in a detached tmux session
ralph stop     # kill this project's tmux session when you want Ralph to halt
ralph update   # update Ralph itself to the latest published version (any directory)
```

`ralph init` must be run **inside a git repository**. It checks this first and,
if you are outside a git work tree, aborts (exit code 1) before any prompt or
file write with `❌ ralph init must be run inside a git repository. Run 'git
init' first (or cd into your repo).`

`ralph init` inspects the manifests in your repo
(`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`,
`composer.json`, lockfiles) and writes a `ralph.config.sh` with the
right install/test/lint commands for your stack. If nothing matches,
the values are left empty and the agent is instructed to figure them out
at runtime. The stack detection is non-interactive; the only prompt is the
coding-agent picker (see below), and even that is skipped when a
`--agent` flag is passed or stdin is not a TTY (it defaults to `claude`).

`ralph doctor` checks the deps required by the agent and task source you
configured, and prints one version line directly under its header:
`version: 0.17.0 — cached latest: 0.18.0 — update available (run npm i -g
@lucasfe/ralph)` when the cache holds something newer, `version: 0.17.0 —
cached latest: 0.17.0 — up to date` when it holds the version you already have
(or an older one — a local build ahead of the registry is not stale), and
`version: 0.17.0 — cached latest: unknown (no update check cached yet)` when
nothing usable is cached. The "latest" half is **read** from the same global
`update-check.json` that `ralph start`'s weekly check writes (see
[Updating Ralph](#updating-ralph)): `doctor` never queries the registry,
never writes that file, and applies neither of the two 7-day windows it holds —
it reports whatever the last check left behind, however old, and running it
neither refreshes the check nor spends the week's update question. That keeps
it usable offline and on a half-broken install, which is when you reach for
it. The line is **additive output only** — `doctor`'s exit code still answers
for the deps alone, so a wrapper or CI step gating on `ralph doctor` does not
start failing the day a release lands — and it is printed **above** the dep
report, so it survives the early exit on a missing required dep.

`ralph start` runs sanity checks (tmux session uniqueness, deps,
`gh auth`, `.mcp.json`, label setup, orphan `claude-working` cleanup),
optionally prints an update notice (and, on an interactive terminal, at
most once a week, offers to install it — see
[Updating Ralph](#updating-ralph)), and launches the bash loop inside
a per-project tmux session named `ralph-<repo>-<hash>` (derived from the
project path, so multiple repos can run Ralph concurrently without
colliding). The exact attach / kill commands for your session are printed by
`ralph start`; detach with `Ctrl+B` then `D`, or tail per-issue logs in
`logs/ralph-issue-*.log`. Each iteration also tees
the agent's raw JSON stream (Claude's `stream-json`, or Codex's
`codex exec --json` JSONL) to `logs/ralph-issue-*.jsonl` and appends one
telemetry event line to `.ralph/metrics/issues.jsonl` (see
[Monitoring data model](#monitoring-data-model)).

`ralph update` updates the Ralph CLI itself, from any directory. It, the
`--force` flag, the install layouts it can and cannot update, and the weekly
check `ralph start` runs are all covered in
[Updating Ralph](#updating-ralph).

## How Ralph resolves issues

Each iteration runs a **team** of context-isolated specialists,
coordinated by an orchestrator that processes one issue end-to-end.
Solo mode has been retired: team mode is the only mode, with no
activation flag.

The orchestrator first **triages** the issue and scales the team to
fit it:

- **Tier 0 / Light — trivial / non-behavioral** — pure docs, plain
  config, or dependency bumps without logic changes. It skips the
  dev-TDD and QA stages and runs only a light review plus the writer.
  The boundary is conservative: when in doubt, the issue is treated as
  substantive.
- **Tier 1 / Standard — substantive** — anything that changes
  behavior. It runs the full team, in order: dev → QA → review →
  writer.
- **Tier 2 / Heavy — gated, dark** — the largest issues (multi-file /
  multi-module scope, audit, refactor, migration, or multi-hypothesis
  investigation), or any issue carrying the `ralph-heavy` label, which
  forces Tier 2. This tier is gated behind the `RALPH_HEAVY_TIER` flag
  and is **off by default**: when the flag is `0` the heavy tier is
  unavailable and triage falls back to Tier 1. When uncertain the
  classifier defaults to Tier 1 (never Tier 2 on a guess), and a heavy
  run that fails to converge degrades to Tier 1 rather than looping.
  When the flag is on, a Tier-2 run adds an **understand phase** before
  the dev: it fans out **three** read-only explorers chasing competing
  hypotheses, then an inline synthesizer collapses their structured
  returns into one plan handed to the dev as **plan + issue** (see the
  explorer in the roster below). A Tier-2 run also adds a **verify
  phase** after the single-reviewer gate and before the PR opens: an
  **adversarial panel of three reviewers** (correctness / security /
  maintainability lenses) blocks the diff only on a **majority — 2 of 3**
  (see the reviewer contract below).

The specialists each have a single contract:

0. **Explorer** *(Tier 2 only)* — a **read-only** hypothesis
   investigator that runs in the understand phase, before the dev. On a
   heavy run the orchestrator dispatches **three** explorers in
   parallel, each chasing a **different, competing hypothesis** about
   the root cause or right approach. An explorer reads, searches, and
   reasons — it never writes or edits a file — and ends with a
   structured return (hypothesis, verdict, evidence, proposed approach,
   risks). An inline **synthesizer** (a named seam in the orchestrator,
   not a subagent) collapses the three returns into one plan, handed to
   the dev as **plan + issue**. On Tier 0 / Tier 1 this phase is skipped
   and the dev receives the issue alone.
1. **Dev** — turns the issue into working, tested code through a
   strict **TDD red → green → refactor** loop. *Red:* write a failing
   test that captures the issue's expected behavior and confirm it
   fails for the right reason. *Green:* implement the minimum code that
   makes it pass and confirm the whole suite is green. *Refactor:*
   tighten names and remove duplication while keeping it green. The dev
   infers its persona from the issue and the repo's detected stack, and
   skips TDD only for changes with zero behavioral impact.
2. **QA** — runs only after the dev's suite is green, and *augments*
   (never rewrites) it with edge-case and adversarial tests. A failing
   QA test is treated as a defect and **blocks until green**: it goes
   back to the dev to fix, then control returns to QA to re-run the
   suite, until everything passes.
3. **Reviewer** — a **pre-PR gate**, run after QA is green but before
   any PR is opened. It judges maintainability (oversized files,
   tangled control flow, weak abstractions, needless indirection), not
   just whether the code works. Blocking findings loop **back to the
   dev** and then back to the reviewer, bounded to a **maximum of 2
   rounds**. If concerns remain after the round limit, the loop stops
   and a human is pulled in via the caveat flag (below). On a **Tier 2**
   run this single pass is replaced by an **adversarial panel of three
   reviewers** in a **verify phase**: the same reviewer contract is
   reused three times with **distinct lenses** (correctness, security,
   and the step-4c maintainability standard as the maintainability
   lens), and the diff is blocked only on a **majority — 2 of 3** (a lone
   objection is recorded but does not gate the PR). The panel keeps the
   same 2-round bound; on non-convergence the PR opens anyway with the
   same caveat flag, identical to Tier 1. On Tier 0 / Tier 1 the panel is
   skipped and the single-reviewer gate above is left unchanged.
4. **Writer** — runs after the review gate passes. It inspects the
   diff and **infers** which docs the change implies (README,
   `CLAUDE.md`/`AGENTS.md`, `docs/` pages, inline docstrings),
   updating only those — it writes no tests and introduces no new
   behavior.

The new/updated tests and the implementation land in the same commit
so the TDD pair is reviewable together. The PR body carries one
section per role: Dev/TDD (tests added, red names before, green suite
after), QA scenarios, Review verdict, and Docs updated. When TDD is
skipped per triage, the Dev/TDD and QA sections record the skip and
its justification.

When the reviewer and dev do **not** converge within the 2-round
limit, the PR is opened **anyway** with a **caveat flag** — a
prominent unresolved-concerns warning block prepended to the PR body
listing each blocking finding, so a human knows exactly what still
needs judgment before merge.

## Choosing the coding agent

Ralph drives one coding-agent CLI per project. The choice is recorded as
`RALPH_AGENT` in `ralph.config.sh`:

- **`claude`** (default) — Claude Code. Fully exercised; unchanged from
  earlier releases.
- **`codex`** — the OpenAI Codex CLI. **Experimental** (see the callout at the
  top of this README): validated by unit + stub tests, not yet by a live
  end-to-end run.

Pick the agent at `ralph init` time:

```bash
ralph init --agent codex     # write RALPH_AGENT="codex"
ralph init --agent claude    # write RALPH_AGENT="claude" (same as the default)
ralph init                   # interactive prompt on a TTY, else defaults to claude
```

The `--agent` value is case-insensitive and trimmed, and it is **validated
before anything is written**: an invalid value (a typo, a model name, anything
that is not `claude` or `codex`) is **rejected** with
`❌ Unknown agent '<x>'. Valid agents: claude, codex.` and a nonzero exit, so a
mistyped flag never silently falls back to `claude`.

When you run `ralph init` in an interactive terminal **without** `--agent`, it
prompts `Use Codex instead of Claude Code? [y/N]:` — answer `y`/`yes` for
`codex`; a blank answer or anything else keeps the default `claude`. This
prompt path never aborts: a stray keystroke just lands on the safe default. When
stdin is **not** a TTY and no flag is passed, `ralph init` skips the prompt and
defaults to `claude` silently, so an unattended run is never blocked.

To switch an existing project, edit `RALPH_AGENT` in `ralph.config.sh` by hand
(or delete the file and re-run `ralph init --agent <name>`). The next
`ralph start` detects that the resolved agent no longer matches the one recorded
in `.ralph/state.json` and re-runs config validation once under the new agent —
so the switch self-heals even though the rest of the config is unchanged.
`ralph doctor`
reports which agent it validated (`Ralph doctor — platform: … — agent: codex`)
and checks that agent's CLI — Claude needs `claude`; Codex needs `codex`.

Nothing else in `ralph.config.sh` changes between agents. The two agents share
the same team roles, triage tiers, PR flow, and telemetry; only the
orchestrator template and the invoked CLI differ. For Codex you can also pin a
model with `RALPH_CODEX_MODEL` (see [Configuration reference](#configuration-reference)).

### Codex sandbox and network access

Ralph runs `codex exec` with a **`workspace-write` sandbox** and network access
left on (`sandbox_workspace_write.network_access=true`), with approvals disabled
so the unattended loop never blocks on a prompt.

- **The sandbox is a *partial* boundary, not a substitute for the prompt's
  stay-inside-the-project rule.** During design the `workspace-write` sandbox did
  **not** prevent a write to the system temp directory. Treat it as defense in
  depth, not containment: the orchestrator's "never touch files outside the
  project root" instruction — not the sandbox — is what keeps a run contained.
  Do not over-trust the sandbox.
- **Network access is mandatory.** Ralph's loop drives `gh`, `npm`, and
  `git push` on every iteration, so with network access disabled those commands
  fail and no PR can be opened or merged. This is why the Codex sandbox is
  configured with network access enabled; if you tighten it, the loop stops
  working. (Claude Code runs unsandboxed and likewise needs network — the
  requirement is not Codex-specific.)

## Choosing the task source

Ralph draws its work from one **task source** per project, recorded as
`TASK_SOURCE` in `ralph.config.sh`:

- **`github`** (default) — today's behavior, unchanged. Ralph resolves open
  GitHub issues via `gh`, opens a PR per issue, and waits for the merge.
- **`folder`** — a fully-local mode. Tasks live as numbered markdown files under
  a gitignored `.ralph/tasks/` tree whose directories encode status. Ralph
  drains an autonomous queue, does the work, commits **directly to the dev
  branch**, and moves the task file to a terminal directory. No PRs, no
  auto-merge, and no `gh` dependency — folder mode needs only `git`, the agent
  CLI, and `jq`.

Pick the source at `ralph init` time:

```bash
ralph init --source folder    # write TASK_SOURCE="folder"
ralph init --source github    # write TASK_SOURCE="github" (same as the default)
ralph init                    # interactive prompt on a TTY, else defaults to github
```

The `--source` value is case-insensitive and trimmed, and it is **validated
before anything is written**: an invalid value is **rejected** with
`❌ Unknown task source '<x>'. Valid sources: github, folder.` and a nonzero
exit, so a mistyped flag never silently falls back.

When you run `ralph init` in an interactive terminal **without** `--source`, it
prompts `Draw tasks from a local .ralph/tasks/ folder instead of GitHub? [y/N]:`
— answer `y`/`yes` for `folder`; a blank answer or anything else keeps the
default `github`. When stdin is **not** a TTY and no flag is passed, `ralph
init` skips the prompt and defaults to `github` silently, so existing
automation keeps working unchanged.

To switch an existing project, edit `TASK_SOURCE` in `ralph.config.sh` by hand.
The bash loop, the prompt builder, and `ralph doctor`/`cycle` preflight all read
this one value, so the loop and prompt consistently honor it on every run.

### Folder-mode layout

In folder mode, `ralph init` scaffolds the `.ralph/tasks/` tree (empty
directories only — no README or example task). The tree separates an autonomous
lane (`afk`) from a human-in-the-loop parking lot (`hitl`):

```
.ralph/tasks/
  afk/todo/           # queued — Ralph picks the lowest-numbered file here
  afk/in-progress/    # the task Ralph is currently working
  afk/done/           # resolved successfully
  afk/failed/         # failed, crashed, or left unfinished
  hitl/todo/          # staging only — Ralph NEVER auto-picks from here
```

Ralph's autonomous loop only ever picks from `afk/todo/`. The `hitl` lane is a
human-only parking lot for tasks you are not ready to release to the robot; you
activate a task by **moving its file** `hitl/todo → afk/todo` (there is no
command for this — it is a plain file move). The whole `.ralph/tasks/` tree is
gitignored, so task files and their status moves never pollute your work
commits; the loop also `mkdir -p`s any missing status directory before use, so a
partial or freshly-cloned tree never crashes a run.

### Task-file format

Each task is a numbered markdown file (e.g. `001-fix-login.md`). The **leading
integer is the task's stable identity** — it drives the branch/log/telemetry
keys (analogous to today's `issue-N`) and stays constant as the file moves
between status directories. The file is YAML-ish frontmatter (`title`, optional
`labels`) delimited by `---`, followed by a markdown body:

```markdown
---
title: Fix login redirect loop
labels: bug, auth
---

When a session expires mid-request the app redirects to `/login` in a loop.
Reproduce by ... and fix so the user lands on the originally requested page.
```

The `title` and body map 1:1 onto a GitHub issue's title and body, so the
prompt fills the same way regardless of source. `labels` accepts a comma list
(`bug, auth`) or a bracketed list (`[bug, auth]`).

**Numbering rule** (a spec for a future task-authoring skill; the skill itself
is out of scope): the next number is `max(N) + 1` scanned across **all**
directories in **both** lanes, so a number is never reused — even by a task
already in `done/`, `failed/`, or the `hitl` parking lot.

### How Ralph works a folder task

Each iteration Ralph picks the lowest-numbered file in `afk/todo/` (the folder
analog of GitHub's `sort:created-asc`), then runs the same team flow described
in [How Ralph resolves issues](#how-ralph-resolves-issues) — only the intake and
completion differ:

- The agent moves the file `todo → in-progress` when it starts, resolves the
  task, commits directly to `DEV_BRANCH` (no branch, no PR, no merge), and moves
  the file to `done/` on success.
- The bash loop owns the **failure sweep**: on a non-zero exit, a file left in
  `in-progress/`, or a no-op (the agent exited 0 but left the file in `todo/`),
  bash moves the task to `failed/` so the queue always advances and no task is
  silently lost.
- The **zero-progress guard** still applies: if the same task is re-selected on
  consecutive iterations with no state change, Ralph stops rather than spin
  forever.

Per-task telemetry works exactly as in GitHub mode: the same
`.ralph/metrics/issues.jsonl` stream and daily heartbeat rollup serve both
sources, keyed on the task id, with the terminal directory (`done`/`failed`) as
the outcome and the frontmatter labels recorded (see
[Monitoring data model](#monitoring-data-model)).

> **Accepted tradeoff:** committing straight to the dev branch means folder mode
> has no per-task rollback boundary — a bad autonomous commit lands directly on
> `DEV_BRANCH`.

## Scheduling Ralph (macOS launchd)

Beyond the manual `ralph start` flow, Ralph can run on a launchd
timer so it processes the queue without human intervention. This is
macOS-only; on Linux / WSL use cron or systemd.

```bash
ralph schedule install            # cycle every 4h + heartbeat at 09:00 (defaults)
ralph schedule install --interval 30m --heartbeat-time 07:30
ralph schedule status             # state of every Ralph agent on this machine
ralph schedule status --here      # only the agent for the current repo
ralph schedule pause              # unload without deleting the plists
ralph schedule resume             # reload after a pause
ralph schedule remove             # unload + delete plists for this repo
ralph schedule remove --all       # unload + delete every Ralph plist (with confirm)
```

`install` writes two property lists under `~/Library/LaunchAgents/`:

| Plist | Schedule | Purpose |
| --- | --- | --- |
| `com.lucasfe.ralph.cycle.<slug>.plist` | `StartInterval` (default 4h) | Runs `ralph cycle` — one queue-processing pass. |
| `com.lucasfe.ralph.heartbeat.<slug>.plist` | `StartCalendarInterval` (default 09:00) | Sends the daily 24h summary. |

`<slug>` is the basename of the repo's working tree, so multiple
repos can each have their own pair of agents on the same user account.
`pause`, `resume`, `remove`, and `status` operate on both plists
transparently — there is no separate `ralph schedule heartbeat
install`. The `ralph schedule heartbeat` subcommand exists, but it is
the entry point launchd invokes when the heartbeat plist fires; you
will not normally call it by hand.

## Updating Ralph

Ralph ships one update command, `ralph update`, and `ralph start` offers to
run it for you roughly once a week. There is no `ralph upgrade` and no alias
for one.

### `ralph update`

`ralph update` updates the Ralph CLI itself — it is the one command that needs
neither a git repository nor an initialized Ralph project, so you can run it
from any directory. It asks the npm registry for the latest published version,
works out how this copy of Ralph was installed, and runs **that** package
manager's own global-install command, reporting both the version it came from
and the version it moved to. When you are already current it prints
`✅ Ralph is already up to date (<version>).` and installs nothing; pass
`--force` to reinstall the latest anyway (handy for repairing a broken
install). A failed registry query is reported and attempts no install (exit
code 1) — it never installs a version it could not confirm exists.

It only ever runs a package manager's global-install command, so it touches
the **installed package alone** and writes no file in your project — see
[What survives an update](#what-survives-an-update).

The layout is worked out from where this copy of Ralph lives:

| Install layout | What `ralph update` does | Exit code |
| --- | --- | --- |
| Global npm — under `npm root -g` | `npm install -g @lucasfe/ralph@latest` | 0 |
| Global pnpm | `pnpm add -g @lucasfe/ralph@latest` | 0 |
| Global yarn | `yarn global add @lucasfe/ralph@latest` | 0 |
| Global bun | `bun add -g @lucasfe/ralph@latest` | 0 |
| `npx` — running out of the npx cache | Nothing to do: npx always fetches the latest published version. | 0 |
| Linked — the package root is a symlink, or holds a `.git` entry | Nothing: Ralph will not write a published tarball over a linked install or a working tree. A `.git` entry means a dev checkout, so it points you at `git pull`; a bare symlink gets the linking manager's own global-add command instead (or, when that is unclear, "update it with whichever package manager created it"). | 0 |
| Unrecognized, or ambiguous — the path matches two managers at once | Refuses to guess, explains what it found, and prints `npm install -g @lucasfe/ralph@latest` to run by hand. | 1 |

The two refusals — `npx` and linked — print `ℹ️  Nothing for Ralph to update
here.` followed by what was found and what to do instead, and **exit 0**:
nothing failed, there is simply nothing for Ralph to install. They are decided
from the package root alone, before any package-manager guess, so a dev
checkout linked into a pnpm or yarn store is still treated as linked rather
than reinstalled over. An ambiguous path deliberately falls into the last row
instead of picking a manager at random. One gap worth knowing: a pnpm global
directory with no `pnpm` path segment (pnpm 6's `~/.pnpm-global`, a hand-set
`global-dir`, or `PNPM_HOME=/opt/pnpm-home`) is not recognized and lands in
that last row too.

#### When the install command fails

When the install command itself fails, `ralph update` exits with **that command's
own exit code** (1, 127, 243 — whatever it returned) and prints the diagnosis
under the headline instead of an opaque `exited 1`: a bounded tail of what the
package manager wrote, then a hint when the failure names a permission problem.
The tail is the **last** 12 non-blank lines — npm prints its error code at the
*end* of a log — each clipped to 200 columns, with every clip marked `…` and any
dropped lines counted in a `… N earlier lines omitted` line, so a multi-megabyte
npm log cannot flood the terminal and a truncated tail never reads as complete.

The hint fires on `EACCES`, `EPERM`, `errno -13`, `permission denied` or
`operation not permitted` appearing anywhere the failure carries text — both
streams, the error message, the error code — and it is matched **before** the
tail is clipped, so it still appears when the code itself was clipped away. It
names the two fixes that work, for the manager that actually ran: point the
global install directory somewhere you own (`npm config set prefix
~/.npm-global`, `pnpm setup`, `yarn config set prefix ~/.yarn`, `BUN_INSTALL=…`,
or, for a manager Ralph has no knob for, that manager's own global-prefix
setting), or re-run that one install with elevated privileges. The hint is
additive: the raw output above it is what tells a root-owned prefix apart from,
say, a manager binary that is not executable.

When both streams are empty — which is what a command that could not be spawned
at all looks like — the failure's own message is reported instead, bounded the
same way, so `spawn npm ENOENT` (npm is not on your `PATH`) is never swallowed;
only a failure that says nothing anywhere falls back to naming the command for
you to run yourself. Nothing ran in that case, so there is no exit code to pass
through and it exits 1. All of it goes to stderr, one whole line per write, and a
successful update writes nothing there at all — so a wrapper or CI step that
captures only stderr keeps the whole diagnosis and nothing else.

### The weekly check in `ralph start`

Before the loop launches, `ralph start` asks npm for the latest published
version — **at most once every 7 days** — and prints
`New version available: <version> (run npm i -g @lucasfe/ralph to update)`
when what it knows about is newer than what you have. The notice itself is not
throttled and keeps printing on every run that finds something newer (see
[Troubleshooting](#troubleshooting)).

When that notice fires, stdin is a terminal, **and** you have not already been
asked in the last 7 days, `ralph start` asks `Update now? [y/N]:` — before the
`gh` checks and before the tmux session, so nothing has been launched yet when
you answer. An empty answer declines, and so does anything that is not `y`;
the answer is trimmed and lowercased first, so `Y` and ` y ` accept too.

Answering **y** runs the same update `ralph update` does, prints
``✅ Updated to <version> — run `ralph start` again.``, and **exits 0 without
starting the loop**: the running process still holds pre-update code and the
old install's copy of the loop script, so re-launching by hand is the only way
to be sure the loop runs one version rather than a mixture of two. Declining
costs nothing — the loop starts immediately, with no extra output. An update
that does not complete is not fatal either: a failed install, or an `npx` run /
linked dev checkout with nothing for Ralph to install, prints
`⚠️  Update did not complete — starting Ralph on <version>.` and the loop runs
on the version you already have.

Without a TTY — cron, launchd, CI, a piped stdin — nothing is ever asked and
the loop always starts. Because no question was displayed, the prompt window is
left untouched, so a nightly headless run cannot spend the week's question on
nobody.

The question is asked **at most once every 7 days**, throttled by its own
`last_prompted_at` stamp in the global update-check cache — a window
independent of the weekly registry query, so declining *is* remembered, but
only until that window rolls over. Being *shown* the question is what consumes
the window, and the stamp is written before your answer is read, so
interrupting at the prompt (`Ctrl+C`) still counts as having been asked and you
are not asked again on the next run seconds later. There is deliberately no
per-release dedupe and nothing records *which* version you turned down: once
the week is up the same still-newer version is offered again, so a release you
deferred is never permanently forgotten.

To silence the check, the notice, and the question together, set
[`RALPH_NO_UPDATE_CHECK`](#environment-variables).

### Where the check keeps its state

Both 7-day windows are **global, not per-repo**. They live in
`$XDG_CONFIG_HOME/ralph/update-check.json`, or
`~/.config/ralph/update-check.json` when `XDG_CONFIG_HOME` is unset or blank
(the value is trimmed before it is used) — one file for your whole machine, so
five Ralph repos cost one check a week between them rather than one each, and
one question a week between them rather than five.
The file holds **two independent windows**: `last_check_at` gates the registry
query, `last_prompted_at` gates the question. Neither gates the other, so a run
can query the registry without asking you anything, and can ask without
querying. The prompt is always served from the *cached* `latest_version`, so a
query that was skipped or that failed outright still gets you the question as
long as what is cached is newer than what you have — which is the point: a
flaky network no longer hides an update Ralph already knows about. With the
network down and nothing useful cached there is simply nothing to say, and
`ralph start` goes quiet and launches the loop. A stamp that is missing,
unparseable, or somehow in the *future* counts as an open window rather than
one that never expires.

The file is separate from the credential dotenv (`ralph/.env`) in that same
directory, which the check never reads or writes — and it lives outside your
project entirely, so deleting `.ralph/state.json` or the whole `.ralph/`
directory resets **neither** window. `.ralph/state.json` does still carry a
`last_seen_release` field (the state writer requires it), but nothing in the
update path reads it any more: it is a leftover of the old per-release dedupe,
not a knob. `ralph doctor` reads the update-check file for its `cached latest:`
line, and only reads it: it makes no registry query and stamps neither window,
so running `doctor` neither refreshes the weekly check nor consumes the week's
question.

## What survives an update

`ralph update`, a manual `npm i -g @lucasfe/ralph@latest`, and a re-run of
`ralph init` all treat user-authored config files as read-only. Updating will
never silently overwrite credentials, secrets, or your project notes.
`ralph update` is the strongest case of the three: it runs a package manager's
global-install command and nothing else, so it writes **no project file at
all** — the table below is about what a re-run of `ralph init` leaves alone.

| File | Status on re-run | How to overwrite |
| --- | --- | --- |
| `.env.local` | **Never written or modified.** Ralph only writes `.env.local.example` (a template you copy from). | Edit by hand; Ralph stays out of it. |
| `ralph-notify.sh` | **Never written or modified.** Ralph only writes `ralph-notify.sh.example`. | Edit by hand. |
| `PROMPT.md` | Preserved on re-run; Ralph prints `PROMPT.md already exists — leaving it alone (pass --reset-prompt to overwrite)`. | `ralph init --reset-prompt` |
| `ralph.config.sh` | Preserved on re-run. | Delete the file and re-run `ralph init`. |
| `.claude/commands/ralph.md` | Preserved on re-run. | Delete the file and re-run `ralph init`. |
| `.env.local.example` | Overwritten on every run (it is a template, not a credential store). | n/a |
| `ralph-notify.sh.example` | Overwritten on every run (template). | n/a |
| `.gitignore` | Ralph appends missing entries idempotently; existing lines are untouched. | n/a |

The split is enforced by automated tests in `lib/init.test.js`, so a
future template-management refactor cannot silently break the invariant.

## Configuration reference

`ralph init` writes `ralph.config.sh` at the repo root. It is meant to
be committed. Re-running `ralph init` never overwrites it.

| Variable              | Default                              | Purpose                                                                 |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `RALPH_AGENT`         | `claude`                             | Coding agent Ralph drives: `claude` (default, Claude Code) or `codex` (OpenAI Codex CLI, **experimental**). Unset or unrecognized falls back to `claude` (with a warning). Set by `ralph init --agent <name>` / the interactive picker. |
| `RALPH_CODEX_MODEL`   | unset (ships commented-out)          | Model id for the Codex agent (ignored when `RALPH_AGENT=claude`). Unset/empty lets Codex use its configured default and leaves the telemetry `model` field `null`. Example: `RALPH_CODEX_MODEL="gpt-5-codex"`. |
| `TASK_SOURCE`         | `github`                             | Where Ralph draws work from: `github` (default, resolves open GitHub issues via `gh` and opens PRs) or `folder` (local `.ralph/tasks/` tree, commits straight to `DEV_BRANCH`, no PR, no `gh`). Unset/unrecognized falls back to `github`. Set by `ralph init --source <name>` / the interactive picker. See [Choosing the task source](#choosing-the-task-source). |
| `INSTALL_CMD`         | autodetected (e.g. `npm ci`)         | Command Ralph runs at the start of each iteration. Empty = ask the agent. |
| `TEST_CMD`            | autodetected (e.g. `npm test`)       | Test command run before opening a PR. Empty = skip.                    |
| `LINT_CMD`            | autodetected (e.g. `npm run lint`)   | Lint command run before opening a PR. Empty = skip.                    |
| `MAIN_BRANCH`         | from `origin/HEAD`                   | The protected branch (PRs ultimately land here).                       |
| `DEV_BRANCH`          | `dev` / `develop` / `MAIN_BRANCH`    | The integration branch Ralph branches off from.                        |
| `PR_TARGET`           | `DEV_BRANCH`                         | Base branch for the PR Ralph opens.                                    |
| `MERGE_STRATEGY`      | `squash`                             | Passed to `gh pr merge`. One of `squash`, `merge`, `rebase`.           |
| `AUTO_MERGE`          | `true`                               | v0.1 only supports `true` (manual review mode lands in v0.2).          |
| `MERGE_POLL_INTERVAL` | `30`                                 | Seconds between `gh pr view` polls while waiting for auto-merge.       |
| `MERGE_POLL_MAX`      | `40`                                 | Max polls (default = 20 minutes) before giving up on a PR.             |
| `RALPH_HEAVY_TIER`    | `0`                                  | Gates the **Tier 2 / Heavy** triage path. `0` = off (the default): the heavy tier is unavailable and triage falls back to Tier 1. When on, a Tier-2 run adds the explorer fan-out + inline synthesis understand phase before the dev, and a 3-reviewer adversarial-panel verify phase (majority-of-3 to block) before the PR opens. |
| `RALPH_CONTEXT_WINDOW` | unset (auto-resolved)               | Optional numeric override (tokens) for the context window used by the [`context_end_pct`](#per-issue-stream--ralphmetricsissuesjsonl) metric. Unset = auto-resolve from the run's model id (Anthropic: `opus`/`sonnet`/`fable` = 1,000,000, `haiku` = 200,000; OpenAI/Codex: `gpt-5`/`gpt-4.1`/`gpt-4`/`o3`/`o4`/`codex` = 400,000, legacy `gpt-4o` = 128,000). An unknown model resolves to no window (`null` pct). A non-numeric or `<= 0` value is ignored. |

The config is plain bash; edit it in any editor. On the next
`ralph start` Ralph re-validates the config one-shot via the selected
agent whenever any of these differ from what `.ralph/state.json`
recorded on the last validation:

- the sha256 of `ralph.config.sh` (you edited the config),
- the installed `@lucasfe/ralph` version, or
- the resolved coding agent — `RALPH_AGENT` from `ralph.config.sh`, or
  an override via the `RALPH_AGENT` env var. Switching agents re-checks
  the config under the agent that will actually run it (so a Codex-only
  machine can bootstrap), even when the config bytes are unchanged.

### Environment variables

Not every setting lives in `ralph.config.sh`. The variable below is read
from the **process environment** only. Putting it in `ralph.config.sh`
has no effect: the Node CLI never sources that file (it text-parses
individual assignments out of it), and this variable is not resolved
through `.env.local` or the global `~/.config/ralph/.env` either — those
feed a fixed set of notification credentials (see
[Global config file](#global-config-file-share-creds-across-repos)).
Export it in your shell, your shell profile, or prefix it on the command
line.

| Variable                | Default               | Purpose                                                                                                                                                                                   |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALPH_NO_UPDATE_CHECK` | unset (check enabled) | Opts out of the weekly update check in `ralph start`. When set, the check short-circuits before any registry query, any read or write of `~/.config/ralph/update-check.json`, and any notice — and, with it, the interactive update prompt. Because that path reads no cache at all, *neither* of the file's two weekly windows (`last_check_at`, `last_prompted_at`) is consulted or stamped, so opting back in gets you the question straight away rather than a week of silence. It does not gate `ralph doctor`'s version line, which only ever *reads* that file and never checks: an opted-out machine simply has nothing cached, so the line reports `cached latest: unknown`. |

**The value parse is permissive, which is a footgun on a
negatively-named flag.** Only `0` and `false` keep the check **on**
(case-insensitive, surrounding whitespace ignored); unset or empty also
keeps it on. **Every other value disables the check** — including the
ones that read as a refusal:

```bash
RALPH_NO_UPDATE_CHECK=1          # disabled
RALPH_NO_UPDATE_CHECK=true       # disabled
RALPH_NO_UPDATE_CHECK=yes        # disabled
RALPH_NO_UPDATE_CHECK=no         # DISABLED — not "no, keep checking"
RALPH_NO_UPDATE_CHECK=off        # DISABLED
RALPH_NO_UPDATE_CHECK=disabled   # DISABLED
RALPH_NO_UPDATE_CHECK=0          # enabled
RALPH_NO_UPDATE_CHECK=false      # enabled
RALPH_NO_UPDATE_CHECK=           # enabled (empty is treated as unset)
```

To turn the check back on, unset the variable (or set it to `0`) rather
than assigning it something that looks negative.

This table is not the only environment-sensitive setting: `RALPH_AGENT`
is honored as an env override on top of its `ralph.config.sh` value, as
described in the re-validation list above.

## Notification setup

Ralph posts a one-line summary at the end of every run, and a startup
ping when `ralph start` successfully launches the tmux session. Stdout
(visible via the `tmux attach` command printed by `ralph start`) is
always populated; the other channels are opt-in.

### WhatsApp via CallMeBot (built-in)

1. Follow the [CallMeBot setup][callmebot] to get an API key linked to
   your WhatsApp number.
2. Run `ralph init` in an interactive terminal. When no WhatsApp
   credentials are configured yet, it asks `Set up WhatsApp
   notifications globally? [y/N]` and, on yes, captures your phone (with
   country code) and CallMeBot key and writes them to your **global**
   config at `~/.config/ralph/.env` (or `$XDG_CONFIG_HOME/ralph/.env`),
   creating the directory `0700` and the file `0600`. These credentials
   are shared across every repo. Re-running `ralph init` shows the
   current phone in full and the key masked, and offers to change them
   (a blank answer keeps the existing value). When stdin is **not** a
   TTY, the prompt is skipped silently and nothing is written.
3. Done — the next `ralph start` will message you when the loop boots,
   and again when it finishes.

To scope credentials to a single repo instead, use the per-repo
override in `.env.local` (see
[Global config file](#global-config-file-share-creds-across-repos) for
the full precedence chain). `.env.local` is added to `.gitignore`
automatically and is never written by Ralph — copy `.env.local.example`
and fill in just the keys you want to override for that repo.

To customize the startup message body (e.g. include the host name or
environment), set `RALPH_STARTUP_MESSAGE` globally in
`~/.config/ralph/.env` or per repo in `.env.local`:

```bash
RALPH_STARTUP_MESSAGE=🟢 Ralph started on prod-runner-1
```

When unset, the default `🟢 Ralph started and is active.` is used.
Failures sending the startup ping log a warning and never abort
`ralph start`; missing credentials skip the ping silently.

[callmebot]: https://www.callmebot.com/blog/free-api-whatsapp-messages/

### Global config file (share creds across repos)

The global config is where `ralph init` stores the WhatsApp credentials
it captures interactively (see
[WhatsApp via CallMeBot](#whatsapp-via-callmebot-built-in)), and it is
the default source Ralph reads from — set it once and every repo picks
it up, no per-repo `.env.local` needed. You can also create or edit it
by hand. Ralph reads a generic dotenv file at `~/.config/ralph/.env`
(or `$XDG_CONFIG_HOME/ralph/.env` when `XDG_CONFIG_HOME` is set):

```bash
# ~/.config/ralph/.env
CALLMEBOT_KEY=<your-key>
WHATSAPP_PHONE=<your-phone-with-country-code>
```

The file is optional — if it's absent, nothing happens. Any variable
works; the keys Ralph looks up are `CALLMEBOT_KEY`, `WHATSAPP_PHONE`,
`RALPH_STARTUP_MESSAGE`, `RALPH_DAILY_SUMMARY_TIME`, and
`HEALTHCHECK_URL`, consulted by `ralph start`, `ralph cycle`, and
`ralph schedule`.

Each key resolves through this precedence chain, first match wins:

1. Repo `.env.local`
2. `process.env` (the environment Ralph runs in)
3. Global `~/.config/ralph/.env`

So a per-repo `.env.local` value always overrides the global file, which
lets you keep shared defaults globally and override them per repo. This
applies to the loop's own mid-run and end-of-run WhatsApp notifications
(sent from the shell), so they fire from global creds even when a repo
has no `.env.local`.

### Daily heartbeat (24h summary)

When Ralph is scheduled via `ralph schedule install` (see
[Scheduling Ralph](#scheduling-ralph-macos-launchd)), a second launchd
agent fires once a day and posts a one-line summary of the last 24h to
WhatsApp. This is the *positive heartbeat* — proof Ralph is alive even
on days when no issues moved.

Format:

```
📊 Ralph 24h | 6 cycles, 12 issues (10 ok, 2 fail) | lucasfe/agenthub | next 09:00
```

When the summary aggregation itself fails (corrupt logs, missing
directories, etc.), the message degrades to
`❌ Ralph 24h summary failed: <reason>` so silence never reads as
healthy.

The cycle count covers **both** scheduled `ralph cycle` passes and
interactive `ralph start` runs. Each finished run appends one run event
to `logs/ralph-cycle.out.log`, which the rollup aggregates; an
interactive `ralph start` therefore shows up in the 24h summary just
like an automated cycle does. (`ralph cycle` itself stays the sole
emitter for the scheduled path, so the two never double-count.)

The schedule defaults to `09:00` in your local timezone. Override it
with `RALPH_DAILY_SUMMARY_TIME` in `.env.local`:

```bash
RALPH_DAILY_SUMMARY_TIME=07:30
```

The heartbeat reuses the same `CALLMEBOT_KEY` / `WHATSAPP_PHONE`
credentials as the cycle and startup notifications. Missing credentials
skip the WhatsApp send (the summary is still printed to the log).

### Custom hook (`ralph-notify.sh`)

For Slack, Discord, email, native macOS notifications, etc., copy
`ralph-notify.sh.example` to `ralph-notify.sh`, `chmod +x` it, and edit.
Ralph invokes it at the end of each run with five arguments:

```
$1 — message string (already includes ok/fail summary)
$2 — status        ("success" | "partial" | "failed")
$3 — successes     count
$4 — failures      count
$5 — duration      in minutes
```

Slack example:

```bash
curl -s -X POST -H 'Content-type: application/json' \
  --data "{\"text\":\"[$2] $1\"}" \
  "$SLACK_WEBHOOK_URL"
```

The hook is gitignored by default. Failures inside the hook never crash
the loop.

## Troubleshooting

**"tmux session 'ralph-…' already exists."** — A previous `ralph start`
already launched the loop for *this* project (the session name is
per-project: `ralph-<repo>-<hash>`). Either attach and let it finish, or
stop it (`ralph stop`) before starting again — `ralph start` prints the
exact attach / kill commands for your session.

**`ralph doctor` reports a missing required dep.** — Install it with
the command shown in the output (e.g. `brew install gh` on macOS,
`apt install gh` on Linux/WSL). Ralph never auto-installs deps. `doctor`
checks only the **selected** agent's CLI: on a Codex project it wants
`codex` (`npm install -g @openai/codex`) and will not ask for `claude`;
on a Claude project the reverse holds.

**`ralph cycle`/`start` aborts with `codex not authenticated`.** — When
`RALPH_AGENT=codex`, the preflight runs `codex login status` and keys on
its **exit code** only. A non-zero exit (or a missing `codex` CLI) blocks
the run. Log in with `codex login` (or provision the CLI's managed
credentials) and retry. Managed-credential builds that print
`Login is not required.` and exit zero count as authenticated. The Claude
path is unchanged: it still checks for the Claude credentials file and
reports `claude credentials missing` when absent.

**Issues stuck with the `claude-working` label after a crash.** — The
next `ralph start` detects orphans and asks whether to clear them and
reprocess. Answer `y` to re-queue the issues.

**Reset the agent's understanding of the config.** — Delete
`.ralph/state.json` (or the whole `.ralph/` directory) and run
`ralph start` again. Lazy validation re-runs and rewrites the state
based on the current `ralph.config.sh` and project manifests. It does
**not** reset the update check: both of its 7-day windows live in a
global cache outside the project (see
[Where the check keeps its state](#where-the-check-keeps-its-state)).

**Update notice keeps appearing — but the question after it does not.** —
Working as intended. The notice is the one part of the update check with no
throttle on it at all: `ralph start` prints it on *every* run for as long as
the version it has cached is newer than the one you have, so expect it to
repeat until you actually update (or a later check finds nothing newer). The
question that can follow it on an interactive terminal — `Update now? [y/N]:` —
has a **7-day window of its own** in the global update-check cache, so it
reaches you at most once a week however many times `ralph start` runs and
however many repos are involved; declining is remembered until that window
rolls over. See [Updating Ralph](#updating-ralph) for the full behavior — both
windows, the prompt-from-cache rule, and the headless path.

Run `ralph update` to update — it picks the right command for a global
npm, pnpm, yarn, or bun install (see [`ralph update`](#ralph-update)) — or
`npm i -g @lucasfe/ralph` by hand. To silence the check, the notice, and the
question together instead, set
[`RALPH_NO_UPDATE_CHECK`](#environment-variables). Deleting `.ralph/state.json`
silences nothing: the windows live in the global cache, and the
`last_seen_release` field still present in that state file no longer drives
update notices — it is not a knob to reach for.

**`ralph doctor` reports `cached latest: unknown`.** — Nothing usable is
in the update-check cache yet, which is the normal state on a fresh
install: only `ralph start` writes that file, and `doctor` deliberately
makes no registry query of its own. Run `ralph start` once and the line
fills in on the next `doctor`; to learn the latest version right now,
`ralph update` asks the registry directly (and installs nothing when you
are already current). The line also reads `unknown` when the cache file
is unreadable or hand-mangled into something that is not a version, and
it stays `unknown` for as long as
[`RALPH_NO_UPDATE_CHECK`](#environment-variables) is set, because the
check that would populate it never runs. Either way it is a missing
answer, never a failure: `doctor`'s exit code is decided by the dep
report alone.

**No issues are picked up.** — Check the queue filter Ralph uses:
`state:open -label:claude-working -label:claude-failed -label:do-not-ralph`.
Issues already labelled `claude-working` or `claude-failed` are
skipped; clear those labels to retry. Ralph applies `claude-failed`
itself when Claude exits non-zero on an issue (auth/credit/rate-limit
errors, crashes) without otherwise resolving it, so the queue keeps
advancing instead of stalling on the same issue — see the per-issue log
to find out why.

`claude-working` is not left behind on a resolved issue. The loop clears
it as soon as an iteration leaves the issue in a state the filter already
excludes — a PR opened (`pending-merge`), the issue **closed** (including
closed indirectly by a merged PR's `Closes #N`), or `claude-failed`
applied — so `claude-working` keeps meaning "Ralph is working on this
right now", and an issue that is later **reopened** comes back into the
queue instead of being silently skipped for a label left over from the
run that resolved it. The one case where the label is kept deliberately
is an issue that is still **open** after an iteration made no progress:
there the sticky label is what keeps a stuck issue from being re-selected
forever, and it is cleared later by the sweep below.

Leftovers are swept per pass by `ralph cycle` (see
[Scheduling Ralph](#scheduling-ralph-macos-launchd)), which clears
`claude-working` from **both open and closed** issues and prints/notifies
what it cleared (`🧹 ralph cycle: cleaned N orphan(s)`). Expect that line
to be busy on the first pass in a repo that accumulated stale labels
before this behavior existed. The sweep reads one page of up to 100
labelled issues per pass, newest first, so a backlog larger than that
drains over several cycles rather than all at once.

**An iteration prints `claude failed on issue #N (non-zero exit)`.** —
Claude exited non-zero on that issue without opening a PR, closing it,
or applying an exclusion label. Ralph adds the `claude-failed` label so
the next iteration moves on. The cause (auth, credit balance,
rate-limit, or a crash) is captured in `logs/ralph-issue-N.log`:
Claude's stderr is now written there (and echoed to the terminal)
rather than being merged into the JSON stream. Fix the underlying
problem, clear the `claude-failed` label, and re-run.

**The per-issue log says `==> result: error`, but the raw `.jsonl`
for that issue says `"subtype":"success"`.** — Working as intended;
the log line is the one to trust. Claude's `result` event carries two
outcome fields that contradict each other on a hard failure — an auth
failure emits `{"subtype":"success","is_error":true,"num_turns":1}` —
and Ralph treats `is_error` as authoritative, so a flagged result is
never rendered as a success. The `==> result:` line prints the
reconciled outcome (the subtype's own name when it already names the
error, otherwise `error`), and the per-issue telemetry records that
same reconciled value in
[`subtype`](#per-issue-stream--ralphmetricsissuesjsonl). Note that
`verdict` is decided separately, from the issue's labels and state, so
`subtype: error` alongside `verdict: pass` is legitimate — the agent's
run failed, but the issue still ended up resolved. Codex names its
failures outright, so its `==> result:` rendering is unchanged.

**The loop aborts with `no progress on issue #N`.** — A zero-progress
guard fired: the same issue was re-selected on consecutive iterations
with no change to its exclusion state (no PR, not closed, no label),
which means the loop could never drain the queue. Rather than burn API
calls spinning forever, Ralph records the issue as a failure and stops.
Inspect `logs/ralph-issue-N.log` for the root cause, resolve or label
the issue (`claude-failed`, `do-not-ralph`), then start Ralph again.

## Monitoring data model

Ralph emits two **append-only, newline-delimited JSON** telemetry streams
at two different grains: one **per issue** and one **per run**. Both are
**observation-only** — capture happens after the loop has already decided
an outcome and can never abort or alter the loop (every write is wrapped
`|| true`). The streams introduce **no new config tunables, no push
alerts, and no ceilings**; they only record what already happened.

The two streams are designed to map cleanly onto two future database
tables — a `runs` table (per-run stream) and an `issues` table (per-issue
stream) — joined on [`run_id`](#run_id-the-join-key).

### Per-issue stream — `.ralph/metrics/issues.jsonl`

After each issue iteration — regardless of outcome — Ralph appends one
`RALPH_ISSUE_EVENT <json>` line to `.ralph/metrics/issues.jsonl`, plus a
raw-output sidecar:

| Path | Contents |
| --- | --- |
| `.ralph/metrics/issues.jsonl` | One appended `RALPH_ISSUE_EVENT <json>` line per iteration. **Append-only** — events accumulate across runs and are never truncated. Maps to the future `issues` table. |
| `logs/ralph-issue-N.jsonl` | The agent's raw JSON stdout for that issue, tee'd verbatim (Claude's `stream-json`, or Codex's `codex exec --json` JSONL). Truncated fresh per issue. |

Each event line is the tag `RALPH_ISSUE_EVENT ` followed by a JSON object
with these fields:

| Field | Meaning |
| --- | --- |
| `issue_number` | The issue resolved this iteration. |
| `run_id` | The [join key](#run_id-the-join-key) — ties every issue event from one loop invocation to its run. |
| `ts` | Event timestamp (epoch milliseconds). |
| `agent` | The **resolved** coding agent that produced the event: `claude` or `codex`. A `RALPH_AGENT` typo records the fallback (`claude`), so a misconfiguration stays auditable. |
| `subtype` | The result subtype (e.g. `success`, `error`), or `null` if absent — **reconciled** with the stream's error flag, not copied verbatim. Claude's `result` event carries **both** `subtype` and `is_error`, and on a hard failure the two contradict each other (an auth failure reports `{"subtype":"success","is_error":true}`). `is_error` decides pass/fail; `subtype` only *names* the outcome. So a flagged result never records `success`: it keeps its own subtype when that already names the error (`error_max_turns` stays `error_max_turns`) and records `error` otherwise. The flag is **not** a field of its own — it is folded into this one, so the event's key set is unchanged. |
| `total_cost_usd` | The agent's reported cost for the iteration. **Codex always reports `0`** — the Codex stream carries no price and Ralph never fabricates one. |
| `num_turns` | Number of turns in the iteration. |
| `duration_ms` | Wall-clock duration for the iteration. Claude self-reports it in its `result` line; **Codex's stream carries no duration**, so the loop supplies its own measured wall-clock time (`RALPH_DURATION_MS`). |
| `usage` | The four raw token counts, broken out: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (each zeroed if absent). **For Codex**, `reasoning_output_tokens` are folded into `output_tokens` (they are billable output and dominate even trivial turns; the raw split stays in the `.jsonl` sidecar), `cached_input_tokens` map to `cache_read_input_tokens`, and `cache_write_input_tokens` map to `cache_creation_input_tokens`. |
| `claude_exit_code` | The agent's exit code for the iteration. (The field name is kept verbatim for both agents so the schema is unchanged.) |
| `stderr_error_signals` | Count of stderr lines matching auth / credit / rate-limit signals. |
| `verdict` | `pass` (CLOSED or `pending-merge`), `fail` (`claude-failed` label), or `unknown`. |
| `files`, `insertions`, `deletions` | Real PR diff stats, fetched best-effort from the issue's PR (`gh pr list --head issue-<n>`). Degrade to `0` when no PR exists or the fetch fails — never aborts the loop. |
| `context_end_tokens` | End-of-job context-window occupancy — the statusline number. The input side of the **most recent** model request: for Claude, the sum of `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from the **last** `message_start` event (not the cumulative `result` usage); for Codex, the same sum taken from the last `turn.completed` usage. `0` when no usage is present. |
| `context_end_pct` | `context_end_tokens / window`, rounded to 6 decimal places. `null` when the model's window is unknown or tokens are `0`. The window resolves from the model id (see [`RALPH_CONTEXT_WINDOW`](#configuration-reference) for the Anthropic + OpenAI/Codex maps) or from the override. |
| `model` | The resolved model id. For Claude it comes from the last `message_start`. **Codex's stream carries no model id**, so this is the configured [`RALPH_CODEX_MODEL`](#configuration-reference), or `null` when that is unset — Ralph never guesses. |
| `context_window` | The resolved context window in tokens — the **same** window that backs `context_end_pct` (single source of truth). Resolves from the model id (see [`RALPH_CONTEXT_WINDOW`](#configuration-reference)) or from the override. `null` when the window is unknown (including Codex with no configured model). |

Stream parsing is agent-specific but yields the same normalized event
shape. For **Claude**, `subtype`, `total_cost_usd`, `num_turns`,
`duration_ms`, and `usage` come from the **last** parseable `result` line,
while `context_end_tokens`, `context_end_pct`, `model`, and
`context_window` come from the **last** `message_start` event (bare or
wrapped in a `stream_event` envelope). For **Codex**, the same fields come
from the `codex exec --json` JSONL events (`turn.completed` usage,
`turn.failed`/`error` for the subtype), with cost pinned to `0`, duration
supplied by the loop, and the model taken from `RALPH_CODEX_MODEL`. Either
way, blank, garbage, and non-JSON lines are skipped, and every field
degrades to zero/`null` when its source event is absent — the parse never
throws.

### Per-run stream — `RALPH_CYCLE_EVENT` in the heartbeat log

At the end of each run, Ralph appends exactly one `RALPH_CYCLE_EVENT
<json>` line to `logs/ralph-cycle.out.log` — the file the
[daily heartbeat](#daily-heartbeat-24h-summary) globs for its 24h rollup.
This stream maps to the future `runs` table.

| Field | Meaning |
| --- | --- |
| `ts` | Run-end timestamp (ISO 8601, UTC). |
| `status` | `success` (no failures), `partial` (some ok, some failed), or `failed`. |
| `ok`, `failed` | Real per-run counts of resolved vs. failed issues. |
| `durationMin` | Run duration in minutes. |
| `processed` | Total issues processed (`ok + failed`). |
| `run_id` | The [join key](#run_id-the-join-key) — the same value stamped on every per-issue event from this run. |

Both run paths now emit real counts: scheduled `ralph cycle` passes and
interactive `ralph start` runs each append one `RALPH_CYCLE_EVENT`, so an
interactive run shows up in the 24h summary just like an automated cycle.
(`ralph cycle` stays the sole emitter for the scheduled path, so the two
never double-count.) The `run_id` field is purely additive — same tag,
file, and parser the heartbeat already reads.

### `run_id` — the join key

`run_id` is the key that links the two streams. Its shape is:

```
<tmux-session-name>-<start-epoch-seconds>
```

e.g. `ralph-agenthub-a1b2c3-1718700000`. It is computed **once** per run
from a single source of truth and reused by both the per-issue capture
and the end-of-run `RALPH_CYCLE_EVENT`, so the two streams can never drift
apart.

To join: every `RALPH_ISSUE_EVENT` in `.ralph/metrics/issues.jsonl`
carries the `run_id` of the run that produced it, and exactly one
`RALPH_CYCLE_EVENT` in `logs/ralph-cycle.out.log` carries that same
`run_id`. One run event therefore fans out to N issue events — the same
one-to-many relationship the future `runs` ←→ `issues` tables will model,
with `run_id` as the foreign key.

## Links

- [PRD / decisions (agenthub#13)][prd]
- [CHANGELOG](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
