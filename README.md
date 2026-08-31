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
branch with no PR. A third source, **`jira`**, works a ticket end-to-end and
**records the result on the board**: it counts the queue from your Jira project,
selects the oldest eligible ticket, records it as the in-flight task, labels it
`in-progress` on the board, and hands the **key** to the agent, which reads the
work item with Atlassian's `acli` itself and commits straight to your dev branch —
no feature branch, no PR, and nothing pushes. Once that commit exists the ticket is
labelled `done`, stripped of `in-progress`, and commented with the commit SHA, and
it is transitioned to whatever status `JIRA_DONE_STATUS` names — a knob a `jira` init
asks for (offering `Done`) and a `github`/`folder` init leaves empty, so while it is
empty the ticket is recorded without being moved on the
board. An iteration that produced **nothing** is swept instead: the loop reads the
ticket's labels back off the board after the agent returns and gives anything that is
not `done` the `failed` label, `in-progress` off, so a killed or idle invocation
cannot leave the loop spinning on one ticket. Nothing pushes the commit either. The
iteration **is** recorded: one telemetry event per ticket, carrying the ticket key beside
the number derived from it. It has also never been run against a live
Jira — every Jira surface is stub-tested only. See
[Choosing the task source](#choosing-the-task-source).

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
vice-versa). Which of `gh` and Atlassian's `acli` `ralph doctor` asks for follows
the [task source](#choosing-the-task-source): `gh` under the default `github`,
neither of them under `folder` — so a repo with no GitHub remote needs only
`git`, the agent CLI, and `jq` — and `acli` under `jira`, required, with its
login state reported beside it. A `jira` run needs **both**, and that is the one
place the diagnostic is ahead of the loop: the loop itself runs no `gh` command
under that source, but the commands that *start* it — `ralph start` and
`ralph cycle` — still demand an authenticated `gh`, which `doctor` has stopped
listing for it. Read [Choosing the task source](#choosing-the-task-source) before
setting that one.
macOS, Linux, and WSL2 are supported.

## Quick start

In a git repo on the branch you want Ralph to work from:

```bash
ralph init      # one-time: detect stack, write config, slash command, gitignore
ralph doctor    # verify required deps are on PATH, under an identity box you can paste
ralph start     # under the sprite and identity box: launch the loop in a detached tmux session
ralph status    # under an identity box: run, progress, task table, queue, pace, ETA, spend, digest
ralph digest    # narrate in prose what the loop is doing, and log it to .ralph/digest.log
ralph stop      # kill this project's tmux session when you want Ralph to halt
ralph update    # update Ralph itself to the latest published version (any directory)
ralph changelog # what changed in recent Ralph releases (any directory, no network)
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
configured — the source read out of the committed `ralph.config.sh` line first and
your environment only where that line is missing or **empty**, which is one
spelling looser than `ralph start`, where an empty line is a value like any other
(see [`TASK_SOURCE`](#configuration-reference)) — and heads its report with the same **identity
box** `ralph start`
opens with — described a few paragraphs down, and here carrying the facts a
diagnostic is asked for, in one block to paste into a bug report:

```
╭─ ralph 0.22.0 ───────────────────────────────────────────╮
│ os      mac                                              │
│ agent   claude                                           │
│ cached  0.23.0 available — run `ralph update`            │
│ cwd     /Users/you/repos/your-project                    │
╰──────────────────────────────────────────────────────────╯
```

The installed version is the box's **title**; `os` is the platform Ralph
detected, `agent` is the agent whose CLI it validated, and `cwd` is where you
ran it. The `cached` row answers "am I current?", and it has three readings:
``0.23.0 available — run `ralph update` `` (yellow) when the cache holds
something newer, `0.22.0 — up to date` (green) when it holds the version you
already have — or an older one, since a local build ahead of the registry is not
stale — and `unknown (no update check cached yet)` when nothing usable is
cached. That number is **read** from the same global `update-check.json` the
weekly check writes, whether that check ran under `ralph start` or under a
scheduled `ralph cycle` (see [Updating Ralph](#updating-ralph)): `doctor` never
queries the registry, never writes that file, and applies neither of the two
7-day windows it holds — it reports whatever the last check left behind, however
old, and running it neither refreshes the check nor spends the week's update
question. That keeps it usable offline and on a half-broken install, which is
when you reach for it.

The box is **additive output only** — `doctor`'s exit code still answers for the
deps alone, so a wrapper or CI step gating on `ralph doctor` does not start
failing the day a release lands — and it is printed **above** the dep report, so
it survives the early exit on a missing required dep. It is the box and nothing
else: no sprite, no animation and no cursor movement at any setting, because
this is output people pipe, quote and diff. A mistyped `RALPH_AGENT` still gets
its one warning line, printed directly **under** the box whose `agent` row it
explains — and **exactly one line, whatever you set**. The warning quotes your
value back at you untrimmed and in its original case, so three trailing spaces
are visible as three trailing spaces, but every control character in it — a
newline, an `ESC`, a `NUL` — is replaced with the Unicode replacement character
`U+FFFD` and the echo is capped at 200 characters. So no value can break the
warning across two lines, forge an extra row of the box above it, or move your
terminal's cursor: a `ralph doctor` report pasted into a bug report holds only
lines `doctor` composed.

[`RALPH_BANNER`](#configuration-reference) governs this box too, read from the
same `ralph.config.sh` line and overridden by the same environment variable
`ralph start` obeys (the environment wins): `RALPH_BANNER=off ralph doctor`
prints no box and not one blank line, so the output starts at the first dep
line, and on that path the update-check cache is not read at all. One difference
from `ralph start` is deliberate: a value `doctor` does not recognize falls back
to the full box **silently**, with no warning on either stream, because a typo in
a purely **cosmetic** knob does not earn a line in a diagnostic. `ralph start` —
the command the setting is actually about — is where that typo is reported.

`ralph start` runs sanity checks (tmux session uniqueness, deps,
`gh auth`, `.mcp.json`, label setup, orphan `in-progress` cleanup),
optionally prints an update notice (and, on an interactive terminal, at
most once a week, offers to install it — see
[Updating Ralph](#updating-ralph)), and launches the bash loop inside
a per-project tmux session named `ralph-<repo>-<hash>` (derived from the
project path, so multiple repos can run Ralph concurrently without
colliding). The exact attach / kill commands for your session are printed by
`ralph start`; detach with `Ctrl+B` then `D`, or tail per-issue logs in
`logs/ralph-issue-*.log`. When
[`RALPH_DIGEST_INTERVAL`](#configuration-reference) is set in
`ralph.config.sh`, the same session also gets a **second window named
`digest`** that narrates the run on a timer beside the loop — see
`ralph digest` below. The same box carries `ralph status` for checking in
later and — on a repo with metrics history behind it — a projection of what the
queue it just accepted should take and cost, and when it should be done (see
[The launch projection](#the-launch-projection--ralph-start)). Each iteration
also tees the agent's raw JSON stream (Claude's `stream-json`, or Codex's
`codex exec --json` JSONL) to `logs/ralph-issue-*.jsonl` and appends one
telemetry event line to `.ralph/metrics/issues.jsonl` (see
[Monitoring data model](#monitoring-data-model)).

On an interactive terminal `ralph start` opens with a **small pixel sprite** — a
one-second splash in 24-bit colour that plays its frames in place and settles on
a still, printed above the very first preflight line, so it is there on the runs
that fail their checks too. It redraws *over itself* rather than scrolling, so
what your scrollback keeps is one frame and not five, and its length is a fixed
count of frames rather than a timed loop: it cannot hold a start up for longer
than the second it advertises. The cursor is hidden while it draws and put back
when it settles — including on a `Ctrl-C` through the middle of it, which still
exits **130**. An animation that cannot finish — a terminal that stops taking
bytes halfway through it — costs the picture and not the run: the identity box
prints under wherever it stopped, and the exit code is the one the run would
have had. It is decoration and nothing depends on it: it is gated on the
terminal rather than on the run, so when stdout is **not** a TTY (a pipe, a
redirect to a file, a launchd log, a CI transcript) or
[`NO_COLOR`](#environment-variables) is set in the environment, the sprite is not
printed at all — none of its escape sequences, no cursor movement, not even a
blank line where it would have been, and nothing waited for a frame nobody was
going to see — and every other line of `ralph start`'s output, plus its exit
code, is byte-for-byte what the same run prints on a terminal. There is no flag
and no variable that turns the sprite **on**: a non-terminal never gets it. None
of that is yours to configure, and gating it on the terminal rather than on a
setting is what makes it so: a piped run, a launchd job and a CI transcript come
out clean by default, with no flag to remember in a wrapper script and nothing to
set in a plist or a CI job for the sake of a readable log. A terminal narrower
than the sprite itself — under **26 columns** — silences it the same way, and
drops it *whole* rather than clipping it, because half a face with a torn edge is
not a smaller sprite. Those are the terminal's reasons; you have one of your own,
and it is [`RALPH_BANNER`](#configuration-reference) — the setting described a few
paragraphs down, which can hold the splash still on its settled frame or drop the
whole banner, sprite and box together.

Directly under it, and on **every** run bar one an explicit
[`RALPH_BANNER=off`](#configuration-reference) silenced, comes the **identity
box**: which Ralph this is, which agent and model are about to run and how much
context that model has, where it is running and where it takes its work from,
whether a newer Ralph is waiting, and what changed in the release you are on.

```
╭─ ralph 0.22.0 ───────────────────────────────────────────╮
│ update  0.23.0 available — run `ralph update`            │
│ agent   claude — claude-opus-5 (last run)                │
│ context 1M tokens                                        │
│ cwd     /Users/you/repos/your-project                    │
│ source  github                                           │
│ repo    you/your-project                                 │
│ new     • `ralph digest --loop` + a digest window in th… │
│         • `ralph digest` one-shot — no-tool narration o… │
│         • a digest section in `ralph status` (#63) (#96… │
│ more    run `ralph changelog` for the rest               │
╰──────────────────────────────────────────────────────────╯
```

The **title** is the Ralph that is about to run — the installed version, read out
of the package's own `package.json` — and `cwd` is the directory you ran the
command in. Those two rows are on every box the three commands draw, though
`ralph status`'s `cwd` names the git toplevel instead of the directory you typed
in, for the reason its own paragraph below gives. Every other row — `agent`,
`context`, `source`, `repo`, `update`, `new` and `more` — appears only when Ralph
has the fact behind it, and each has a paragraph of its own below.

Unlike the sprite the box is **not** gated on the terminal, because it is facts
rather than decoration: a launchd log or a CI transcript is exactly where "which
version, which directory" is the question being asked. A non-TTY or `NO_COLOR`
costs it its colour and nothing else — the `update` row is yellow on a colour
terminal and plain text everywhere else, with not one escape byte emitted. It is
printed **before every other side effect**, so it is on screen even on the runs a
preflight check aborts, and it is **additive output only**: no other line and no
exit code changes because of it. It holds 60 columns, or your terminal's width
when that is narrower, with anything longer clipped by `…` and no line ever
wrapped; under **44 columns**, where the frame would be spending an eighth of the
screen on decoration, the border is dropped altogether and the same rows print
bare as `label   value` — the same information, with the border's four columns
handed back to the fact. A width Ralph cannot use falls back to that 60-column
default rather than degrading, so a pipe (where there is no column count to read)
gets the box it always did. A fact Ralph could not read (the version, on an
install with an unreadable `package.json`) reads `unknown` rather than being
guessed at.

`ralph doctor` and `ralph status` head their own reports with this same box —
same composer, same width ladder, same `RALPH_BANNER` setting — each carrying the
rows it has facts for: `doctor` the ones a diagnostic needs (`os`, `agent`,
`cached`), `status` the `cwd` under the version in the title and nothing else,
where `ralph start` carries `agent`, `context`, `source`, `repo`, `update` and the
what's-new bullets. Which rows a box holds is a question of which facts the
command resolved, so no command grows another's; see the `ralph doctor` paragraph
above for that box and its `cached` row, and the `ralph status` paragraph below
for why that one is the shortest of the three. The one row the two boxes spell
differently is `agent`: `doctor` prints the agent's **name alone** (`agent
codex`), because that report is a diagnostic about an installation and not a
report about a run — it never looks at a run, so it has no model to name and no
`context` row either — while `ralph start`'s row is the sentence described below.

How much of that banner you get is the one thing about it that is yours to
choose. [`RALPH_BANNER`](#configuration-reference) in `ralph.config.sh` takes
three values: **`full`** — the default, and what every Ralph before this setting
did — plays the splash and prints the box under it; **`static`** draws the same
picture with none of the animation, which is the settled frame written once, with
no cursor hidden and no `Ctrl-C` handler armed; and **`off`** prints nothing at
all, not the sprite, not the box, not one blank line, so `ralph start`'s output
begins at its first preflight line exactly as it did before any of this existed.
Values are case-insensitive and surrounding whitespace is ignored; unset or empty
means `full`, and a value Ralph does not recognize also means `full` and says so
in one line on **stderr** — a typo costs you a line of output and never the run,
and nothing it prints reaches stdout, so `ralph start | tee` is unaffected either
way. That warning quotes the value it did not recognize, flattened to one line and
with every control character in it replaced by `U+FFFD`, so a stray `ESC` in the
committed line is shown to you rather than obeyed by your terminal.
An [environment variable of the same name](#environment-variables) **wins**
over the file, deliberately the opposite way round to
[`TASK_SOURCE`](#choosing-the-task-source): a task source is a property of the
repository, while a banner is a property of one invocation, so
`RALPH_BANNER=off ralph start` silences a single run inside a wrapper script, a
cron entry or a CI job without editing — and committing — a file every other run
in the repo shares.

The terminal only ever caps this **downward**. No value of `RALPH_BANNER` turns
the sprite on: a pipe, a launchd log, a `NO_COLOR` run or a window under 26
columns draws no sprite whatever the setting says, and asking for `full` or
`static` there costs nothing — no frames, no waiting, not one escape sequence.
What the cap does **not** reach is the box, for the same reason the terminal
never gated it: a piped or `NO_COLOR` run still prints it, in plain text, exactly
as it did before this setting existed. Only an **explicit** `off` — a user asking
for nothing, rather than a terminal that cannot show something — takes the box
away.

The `update` row is served **entirely from the cache** the weekly check already
keeps (see [Where the check keeps its state](#where-the-check-keeps-its-state)),
so the banner makes no registry query of its own and costs the first paint
nothing: on a machine where that check has never run there is simply no row. It
appears only when what is cached is **strictly newer** than what you have — the
same comparison behind [the weekly check](#the-weekly-check)'s notice, so the box
and the notice can never disagree about what counts as newer, though a single run
can print both. It also honours
[`RALPH_NO_UPDATE_CHECK`](#environment-variables): with the opt-out set the cache
is not read at all and the row never appears, leaving the box its title, its
`agent`, `context`, `cwd`, `source` and `repo` rows, and its what's-new rows.

The `agent` row names the agent that is **about to run** and, after an em dash,
the model it will use — and it always says **where that model claim came from**,
because the two agents give Ralph two different qualities of evidence and a row
that hid the difference would be claiming more than it knows. The agent half is
the *resolved* [`RALPH_AGENT`](#configuration-reference), so a mistyped value
shows you the agent that will actually run (`claude`, that setting's fallback)
rather than what you typed: this box reports the run, it does not diagnose it, so
there is no second opinion about the typo inside the frame. The typo itself is
named **above** the box instead — one line on **stderr**, next to the banner's own
fallback warning, and the run starts anyway — so nothing about it reaches stdout
and `ralph start | tee` is unaffected. A recognized value, or none at all, prints
nothing. [`ralph doctor`](#quick-start) and `ralph init` print that same line, and
so does the loop, in the tmux window it runs in.
The model half has three readings:

- ``agent   claude — claude-opus-5 (last run)`` — the model the **previous** run
  actually used, read back out of the newest event in
  [`.ralph/metrics/issues.jsonl`](#per-issue-stream--ralphmetricsissuesjsonl).
  Claude Code picks its own model and offers no way to ask before the first turn,
  so this is the only honest evidence there is, and `(last run)` says out loud
  what it is: a fact about the run before this one, not a promise about this one.
  Switch models between runs and the box is a run behind you until the next event
  lands.
- ``agent   codex — gpt-5-codex (configured)`` — the
  [`RALPH_CODEX_MODEL`](#configuration-reference) the loop is about to pass on the
  command line, which for Codex *is* the answer. The metrics log is **never**
  consulted for a Codex row: Codex's stream carries no model id, so the log holds
  nothing but a staler copy of this same configured value — and reading it would
  let a log full of Claude runs put a Claude model on a Codex row the first time a
  project switched agents.
- ``agent   claude — model resolves at first run`` — no evidence at all, so the
  row **names no model**. That is what a fresh checkout gets, and it is spelled
  with whichever agent it is about, so a `codex` project with no
  `RALPH_CODEX_MODEL` set reads ``codex — model resolves at first run``. It is
  worded as a fact about the future rather than as a failure: nothing is broken,
  the run simply has not happened yet. Ralph does not guess here, the same way the
  telemetry does not.

The log is read the way every other consumer of that file reads it — the newest
line, with a truncated or garbage trailing line skipped rather than fatal, since
the loop appends to it and can be killed mid-line. It is the newest event **full
stop**, deliberately: if that event carries no model, or belongs to a *different*
agent (which is what the bottom of the log looks like in a repo that just switched
`RALPH_AGENT`), the row falls to `model resolves at first run` rather than reaching
further back for an event that would answer. An older run's model is not a fact
about the last run, and labelling it `(last run)` would be exactly the
overstatement the tag exists to prevent.

The `context` row is how much context that model works with, and it appears
**only when the window is known** — there is no `context unknown`, because a model
id Ralph has no window for is a gap in the map rather than a detection bug worth a
row. The number is written exactly, and abbreviated only when it is exactly
divisible: `1M tokens`, `200k tokens`, and a plain `1500 tokens` for anything else,
so what you read here can always be matched against the
[`RALPH_CONTEXT_WINDOW`](#configuration-reference) you set rather than against a
friendlier rounding. Which side of the model claim above it comes from matters for
one thing: on the `(last run)` path the window is taken from that same event, which
was written with whatever override *that* run had, so a change to
`RALPH_CONTEXT_WINDOW` reaches this row on the next run rather than on this one;
on the `(configured)` path it is resolved from the model id and the current
override together, and takes effect immediately.

All three knobs behind those two rows — `RALPH_AGENT`, `RALPH_CODEX_MODEL` and
`RALPH_CONTEXT_WINDOW` — are read from `ralph.config.sh` **first**, and from the
environment only where the file is silent about them. That is the way round the
loop itself resolves them (it *sources* that file, so a committed value overrides
an inherited one), and it is deliberately the opposite of
[`RALPH_BANNER`](#configuration-reference), where the environment wins: these three
name what the run is going to do, so a box that preferred the environment could
name an agent the loop is not about to run, while a banner is a property of one
invocation rather than of the repository.

"Silent" means **no assignment at all** — for all three of them, and for the
`source` and `repo` rows below. An explicitly blank `RALPH_AGENT=""` line is a value
like any other, because a shell sourcing the file
with `set -a` exports the empty string *over* whatever your environment held — so
that line means `claude`, and both the `agent` row and the warning above the box
follow it rather than reporting an environment value the loop will never see. A
blanked `RALPH_CODEX_MODEL=""` reads the same way round: the row falls to ``codex —
model resolves at first run`` and draws no `context` row at all, which is what a run
handed no model on the command line actually does, rather than naming a model out of
your shell that the loop will never pass. And on that same `(configured)` path a
blanked `RALPH_CONTEXT_WINDOW=""` leaves the window to the model id, so the row matches
the number the run's very first telemetry event will record rather than contradicting it
with one out of your shell. What hands a knob back to
the environment is a line **both** readers refuse: no line, a commented-out one, one
with a space in front of the `=`, or one with a blank after the `=` and a word behind
it. Those last two are the same mistake on either side of the `=` — a line bash reads
as a *command* rather than as an assignment, so it leaves the variable holding
whatever it already held — and the
[configuration reference](#configuration-reference) spells out both.

The `source` row is the resolved [`TASK_SOURCE`](#choosing-the-task-source) —
`github`, `folder` or `jira` — and the `repo` row under it is the repository the loop
will read issues from, `owner/name`. **`repo` is drawn for every source except
`folder`:** a folder-mode
run draws no such row at all, because there is no repository it reads issues from
and naming one would be naming a fact that is not about the run. A `jira` run still
draws it, and since ticket selection landed that row is about **`ralph start`** rather
than about the loop: the launcher's own orphan sweep and queue check still read GitHub
issues out of exactly the repository named here, while the loop it starts selects Jira
tickets and touches no issue at all. That mismatch is a known one — see
[what is still GitHub's](#what-is-still-githubs). Both rows are
there for the same reader: the one running Ralph in several checkouts of the same
project, or in a fork, who wants to know which one this loop is about to work on
before it starts working.

`TASK_SOURCE` is read on the same rule as the three knobs above — the file first, the
environment only where the file assigns the name nothing at all — and the `source` row
is not the only thing that spends the answer: the **preflight** reads the very same
binding, so the row and the checks under it can never name different sources. So a
blanked `TASK_SOURCE=""` means `github` here, exactly as it does to the loop (whose own
dispatch reads `${TASK_SOURCE:-github}` out of the file it sourced): the row says
`github`, `gh auth status` is checked, and the GitHub queue is the one counted — rather
than an exported `folder` deciding which preflight runs for a loop about to read GitHub
issues. [`ralph doctor`](#quick-start), [`ralph status`](#quick-start) and `ralph cycle`
are **one spelling behind** on this: they take the file's value whenever it is non-empty
and fall through to the environment when it is empty, so a config that blanks the knob
while your shell exports one has those three naming the shell's source — and `doctor`
checking that source's deps — while `ralph start` and the loop work `github`. It is a
named follow-up rather than a design, and the way past it is to write the value or leave
the line out entirely.

That slug is resolved **locally and cheaply**, out of two places in the order the
loop itself reads them: a [`GH_REPO`](#environment-variables) assignment in
`ralph.config.sh` **first**, then `GH_REPO` in the environment, and `origin`'s url
out of the `.git/config` in the directory you ran the command in when neither
assigns it. `GH_REPO` ahead of `origin` is what `gh` itself honours; the file ahead
of the environment is the same way round as the three knobs above, and for the same
reason — the loop *sources* that file with `set -a`, so a committed `GH_REPO`
decides for every `gh` command it runs, and a row that read past it could name a
repository no call in the run is about to touch. "Silent" also means here what it
means for `RALPH_AGENT`: **no assignment at all**. A blank `GH_REPO=` line is a
value like any other and keeps your environment out of this row — and because a
blank value reads as unset to `gh`, which then resolves its base repository from
`origin`, that line hands the row to `origin`'s url rather than to whatever your
shell exported. `gh repo view` would know authoritatively, and it is deliberately
not asked: this row prints *before* the first preflight line, and no decoration is
worth putting a network round trip in front of the first paint or hanging a start
on a bad connection. The trade is worth knowing about, because it is visible: `gh`
resolves its base repository from more than `origin` (a `gh repo set-default`, an
upstream remote), so in a checkout where the two disagree **this row shows what
git says**. And when the answer is not cheaply knowable — no `.git` at all, an
`origin` that is a local path or a bundle rather than a GitHub repository, a
`GH_REPO` that is not a slug — the row is simply **absent** rather than reading
`unknown`: "this checkout does not cheaply say" is not the same claim as "there is
no repo", and only the missing row tells the truth. The `.git/config` read happens
only when there is a box to draw, so
[`RALPH_BANNER=off`](#configuration-reference) costs not one byte of output and not
one read for this row either.

The `new` rows are the newest release in the `CHANGELOG.md` that **ships inside
the installed package** — its first three bullets, in the order a reader of the
file would meet them, clipped to the box's width like every other row. That file
is in the tarball, so this is one local read: no network call, and nothing added
to the first paint. It is resolved against the **install**, never against your
working directory, so a globally installed Ralph running inside a project that
has a `CHANGELOG.md` of its own still shows *Ralph's* release notes and never
yours. The rows print on every run and nothing is recorded as seen — these are
release notes, not the weekly update nag — so starting Ralph twice tells you
twice. If the shipped changelog is missing (a pruned install), empty, or in a
shape nothing can be made of, the `new` and `more` rows simply do not appear and
the run starts exactly as it did before.

The `more` row points at [`ralph changelog`](#ralph-changelog), which is where
the rest of the entry is: it prints the newest release **whole** — every bullet,
not the box's three — then the two releases behind it, and **every** release in
the file under `--all`. It reads the same shipped changelog this box does, from
the install rather than from your project, so it costs no network call and needs
no Ralph project to answer.

`ralph status` answers "what is Ralph on right now?" without attaching to
anything. Its human view opens with the same **identity box** `ralph start` and
`ralph doctor` head their output with — the one described above — holding two
facts and no more:

```
╭─ ralph 0.22.0 ───────────────────────────────────────────╮
│ cwd     /Users/you/repos/your-project                    │
╰──────────────────────────────────────────────────────────╯
```

That shortness is the decision. This is the readout people screenshot and paste,
and a table carrying a pace, an ETA and a night's spend says everything about a
run except **which** run it was and **where** — so the version in the title and
the `cwd` row are exactly the two things the numbers below cannot say for
themselves. There is deliberately no `update` row: "a newer Ralph is waiting" is
advice for the two commands a reader can act on it from — `ralph start` offers to
install it, `ralph doctor` reports what is cached — rather than for a view you
refresh on a timer. There are no `os` / `agent` rows either: those belong to a
command diagnosing a machine, and this one is reporting a run. And
`cwd` is the **git toplevel** rather than your working directory, because that is
the path the record, the cycle lock, `issues.jsonl` and `.ralph/digest.log` are
all keyed on: the one line that takes a reader back to the run being reported,
whichever subdirectory it was typed in.

It is the box and nothing else — no sprite, no animation and no cursor movement
at any setting, because this is output people pipe, quote and diff — and it is
**additive output only**: one blank line separates it from the report, no line of
the report changes because of it, and the exit code is still `0` in all four
modes. [`RALPH_BANNER`](#configuration-reference) governs it exactly as it governs
the other two, read from the same `ralph.config.sh` line and overridden by the
same environment variable (the environment wins). `RALPH_BANNER=off` takes the
blank line away with the box, so the report starts at its `▸ ralph` line byte for
byte as it did before the box existed. And one mode prints no box whatever the
setting says — **`never-run`**, because the box identifies a run and that mode has
none, which is also what keeps it the readout that reads nothing at all,
`ralph.config.sh` included.

Under the box it reads the run-state record the loop keeps at
`.ralph/run-state.json` and prints the run and how long it has been going, how far
through the queue it is — tasks done over a denominator recounted on every call,
the task in flight and for how long, and a bar — a **per-task table** of what the
run has worked through, the **live** queue depth, the pace the run is
holding, an ETA with a range and a wall-clock finish time, the spend so far and
where it projects to, and the attach / kill lines for the session — or, for a
scheduled `ralph cycle` run, the log to follow instead, since that run has no
session to attach to. Each of those three estimates reads `unknown` rather than
a guessed number when the run has no history to reason from. A run that has been
narrated also gets the latest `ralph digest` entry for it printed under those
numbers — the sentence that explains them, with how old it is and which model
wrote it (see [The digest section](#the-digest-section)). It anchors on the
git toplevel, so it reports the same run from any subdirectory of the repo, and
it exits `0` whether a run is in flight, was interrupted, is over, or never
happened. See
[Run state](#run-state--ralphrun-statejson-and-ralph-status).
`ralph status --json` prints that same snapshot as a single JSON document on
stdout instead, so a shell prompt, a status line, or a notifier can read it
without re-parsing the metrics file. The identity box does not reach that path at
all: no box, no blank line, one document, at every `RALPH_BANNER` value. See
[Machine-readable output](#machine-readable-output--ralph-status---json).

`ralph digest` answers the same question one resolution coarser: it asks a
cheap model for a few sentences of plain prose about what the run is doing —
which task is in flight, which file it appears to be editing, which phase of
the TDD cycle it looks to be in, and anything that looks wrong. Ralph
assembles the context itself (the in-flight log tail, bounded by both lines
and bytes; `git status` and `git log`; and the same snapshot
`ralph status --json` prints) and hands it over inline in the prompt, so
**the model gets no tools at all** — it cannot read a file, run a command, or
touch the run, and that is structural rather than a setting it was asked to
respect. It is one turn rather than an agent session, which is what makes it
cheap enough to ask for repeatedly; the model it asks defaults to a cheap
per-agent one (`haiku` for Claude, `gpt-5-mini` for Codex) and is overridable
with [`RALPH_DIGEST_MODEL`](#environment-variables). Each narrative is also
**appended** to `.ralph/digest.log` — one entry per digest, under a heading
naming four things (an ISO timestamp, the run id, the task in flight, and the
model that answered), and never truncated — so a night of digests reads back as
the night's story and greps by any of the four. The latest entry for the run in
flight is also what `ralph status` reads back to you, so the narration and the
numbers it is about arrive in one view rather than two commands (see
[The digest section](#the-digest-section)). Failure is deliberately
silent and harmless: an agent that is missing, unauthenticated, slow to
answer, or that answers with nothing writes **no** history entry, prints one
line to stderr, and still exits `0`, because a digest is an accessory to a run
and must never be able to fail one. In a project with no run recorded yet it
prints one honest line and never invokes the agent at all.

The digest can also keep the loop company on a timer instead of being asked one
question at a time. `ralph digest --loop --interval 30m` prints a digest
immediately and then one every 30 minutes until it is killed, and
[`RALPH_DIGEST_INTERVAL`](#configuration-reference) in `ralph.config.sh` is how
you get that without typing it: `ralph start` opens exactly that command in a
**second tmux window named `digest`**, in the session it just created for the
loop.

```
session ralph-<repo>-<hash>
  window 0            the loop — the raw agent stream
  window 1  digest    ralph digest --loop --interval 30m
```

`tmux attach` still lands on the loop's window; `Ctrl+B` then `W` lists both, so
the stream and the narration sit side by side. Each digest is appended to
`.ralph/digest.log` exactly as a hand-run one is, so the night's story reads back
without attaching to anything. The window narrates with the agent and model *this
repo* configures — `ralph start` forwards whichever of `RALPH_AGENT` and
[`RALPH_DIGEST_MODEL`](#environment-variables) `ralph.config.sh` sets into it (and
nothing when it sets neither, leaving the ambient environment to decide as usual),
so a Codex repo's digest runs Codex rather than a `claude` that would fail every
tick. Teardown is the session's: `ralph stop`, and
the loop's own end of run, kill the **session**, and the digest window goes with
it. There is nothing separate to stop and nothing left narrating afterwards.

The interval is **off by default**, and turning it on can cost you the digest but
never the run. Empty — what `ralph init` writes — or any spelling of zero (`0`,
`0m`) means no window, no timer, and no model call. In a repo initialized before
this shipped there is no `RALPH_DIGEST_INTERVAL` line in `ralph.config.sh` at all,
because `ralph init` never rewrites that file (see
[What survives an update](#what-survives-an-update)); add the assignment yourself
— an absent knob reads exactly like an empty one, so the only difference is that
nothing in the file tells you it exists. A value the duration grammar
rejects (a fraction like `0.5h`) or one longer than a timer can wait (`30d`; the
ceiling is `24d`) is refused **after** the loop is already running: `ralph start`
writes `⚠️  Digest window not opened — …. The loop is running.` to stderr, and the
startup box's digest line — which quotes the interval exactly as the file spells it
— reads `Digest: every 0.5h — NOT running (see the warning on stderr)` where a
working one reads `Digest: every 30m — runs alongside the loop`. The launch itself
still succeeds either way. Run by hand, those two refusals — plus `--loop` with no
`--interval` at all, and `--interval 0`, which the config knob instead reads as
simply off — print one
`ralph digest: not looping — …` line and exit `0`; so does a digest that
fails *mid*-loop, which writes its line and leaves the timer to keep its next
appointment rather than ending the night early. Only `ralph start` opens that
window: a scheduled [`ralph cycle`](#scheduling-ralph-macos-launchd) has no tmux
session of its own and starts no digest.

`ralph update` updates the Ralph CLI itself, from any directory. It, the
`--force` flag, the install layouts it can and cannot update, and the weekly
check `ralph start` and `ralph cycle` run are all covered in
[Updating Ralph](#updating-ralph).

`ralph changelog` says what a version actually changed — the three newest
releases by default, every one under `--all` — read from the `CHANGELOG.md` that
ships inside the install, so it answers offline and from any directory. See
[`ralph changelog`](#ralph-changelog).

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
mistyped flag never silently falls back to `claude`. `<x>` is the value you
passed, echoed back untrimmed and in its original case — with every control
character in it replaced by `U+FFFD` and the echo capped at 200 characters, so
the rejection is one line of stderr no matter what the flag carried.

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
reports which agent it validated in the `agent` row of the identity box it opens
with (`agent   codex`) and checks that agent's CLI — Claude needs `claude`;
Codex needs `codex`.

A hand-edited typo is **not** rejected the way the flag is — a committed file is
read, not validated, so anything that is neither `claude` nor `codex` falls back to
`claude`. It does not fall back quietly: `ralph start` names the value in one line
on stderr before the splash and launches anyway, and the loop names it again inside
its tmux window, so a typo costs you a line of output rather than a night of the
wrong agent.

Nothing else in `ralph.config.sh` changes between agents. The two agents share
the same team roles, triage tiers, PR flow, and telemetry; only the
orchestrator template and the invoked CLI differ. For Codex you can also pin a
model with `RALPH_CODEX_MODEL` (see [Configuration reference](#configuration-reference)),
which is also the model `ralph start`'s identity box names beside the agent —
``agent   codex — gpt-5-codex (configured)``. On a Claude project that row names
the model the **last** run used instead, because Claude Code picks its own and
there is no way to ask it before the first turn; [the quick
start](#quick-start) walks through both readings and the third, where nothing is
known yet and the row names no model at all.

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
- **`jira`** — **the work happens, and what became of the ticket is recorded on the
  board.** Ralph counts your Jira queue, selects the oldest eligible ticket, records it
  as the in-flight task, claims it by adding the `in-progress` label, and hands the
  **key and nothing else** to the agent, which reads the work item with `acli` itself
  and commits
  straight to `DEV_BRANCH` — no feature branch, no PR, no auto-merge, and nothing
  pushes, the same delivery shape `folder` mode has. Each iteration works one ticket;
  the claim is what the composed query excludes, so the queue drains and the loop
  exits `Queue empty`. **Once the commit exists, the ticket is closed out**: it is
  labelled `done` — the label the composed query also excludes, so a resolved ticket
  stays out of the queue — `in-progress` comes back off, a comment carries the commit
  SHA, the branch and the test/lint result, and the ticket is transitioned to
  [`JIRA_DONE_STATUS`](#recording-a-ticket-as-done--jira_done_status), which a `jira`
  init asks for (offering `Done`) and a `github`/`folder` init leaves empty, so while it
  is empty the ticket is recorded without being moved on the
  board. **And a ticket it did not resolve is swept**: after the agent returns the loop
  reads the ticket's labels back off the board and, for anything that is not `done`,
  adds `failed` and takes `in-progress` off, warning on stderr with the ticket and the
  state it found. **And the iteration is recorded**: the loop appends one issue event per
  ticket to `.ralph/metrics/issues.jsonl`, carrying the ticket key as `task_key` beside the
  number derived from it, so the task table and the pace/spend figures in `ralph status`,
  the idle report card and `ralph cycle`'s `N ok, N failed` summary account for a Jira
  iteration the way they account for a GitHub one. Nothing is read from GitHub issues under
  this value either — the loop runs no `gh` command at all, telemetry included.
  [`ralph status`](#run-state--ralphrun-statejson-and-ralph-status) and
  `ralph cycle` take the queue depth by running the
  [`JIRA_JQL`](#configuration-reference) you configure through Atlassian's `acli`,
  and `ralph status` names the in-flight ticket by its key. `ralph doctor` follows
  the name too, asking for `acli` as a required dep with a per-platform install hint
  and reporting whether that CLI is logged in. **`ralph start` has not moved yet**:
  it still demands an authenticated `gh` and still gates the launch on the GitHub
  queue. See [The `jira` source today](#the-jira-source-today) for the query Ralph
  composes, what a broken `acli` costs you, and what is still GitHub's.

Side by side, and the row worth reading first is **delivery shape** — it is the one
that surprises people, because two of the three sources never publish anything:

| | `github` | `folder` | `jira` |
| --- | --- | --- | --- |
| Work comes from | open issues on the repo's GitHub board, read with `gh` | numbered `.md` files under the gitignored `.ralph/tasks/` tree | work items on a Jira site, read with Atlassian's `acli` |
| Eligibility is expressed as | a **fixed search query** inside the generated `ralph.sh` — `state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge` — not a config knob; the pick adds `sort:created-asc` | the **directory** itself: the lowest-numbered file in `afk/todo/` | **your JQL**, in [`JIRA_JQL`](#the-eligibility-query--jira_jql) — eligibility only, with Ralph appending the label exclusion and the ordering |
| CLI and auth it needs | `gh`, authenticated (`gh auth login`) | **no source CLI at all** — `ralph doctor` skips both `gh` and `acli` | `acli`, logged in (`acli jira auth login`) |
| **Delivery shape** | an `issue-N` **branch**, **pushed**, with a PR set to **auto-merge** (`gh pr merge … --auto`) | one commit **straight onto `DEV_BRANCH`** — no branch, no PR, **and nothing pushes** | one commit **straight onto `DEV_BRANCH`** — no branch, no PR, **and nothing pushes** |
| Ralph claims work by | the **agent** adding the `in-progress` label to the issue | the **agent** moving the file `afk/todo → afk/in-progress` | the **loop** adding the `in-progress` label to the ticket |
| Completion is recorded as | the issue reaching `CLOSED` (usually via `Closes #N` on the merge) or carrying `pending-merge` | the file arriving in `afk/done/` | the `done` label, with `in-progress` removed, a comment carrying the commit SHA, and a transition to [`JIRA_DONE_STATUS`](#recording-a-ticket-as-done--jira_done_status) where the project's workflow accepts one |
| Failure is recorded as | the `failed` label | the loop moving the file to `afk/failed/` | the loop adding the `failed` label and removing `in-progress` |
| The human parking lot is | the `do-not-ralph` label on an issue | the whole [`hitl/` lane](#folder-mode-layout) — release a task by moving its file `hitl/todo → afk/todo` | the `do-not-ralph` label on a ticket |
| Orchestrator prompt template | `prompt-team.md` (Claude) or `prompt-team-codex.md` (Codex) — picked by **agent** | `prompt-team-folder.md` | `prompt-team-jira.md` |

Two asymmetries in that table are worth stating outright rather than inferring.
**Only `github` publishes anything** — the other two leave the work as commits on
`DEV_BRANCH` in the clone Ralph ran in, so pushing or merging it onward is a step you
take by hand (see [What is still GitHub's](#what-is-still-githubs) for what that means
on a shared Jira board). And **the `jira` column has never been run against a live
Jira**: every one of its surfaces is driven against a stubbed `acli`, and the shape of
`acli` itself is transcribed from Atlassian's documentation rather than measured — see
[the callout under `The jira source today`](#the-jira-source-today).

One **coincidence** in that table is not a shared mechanism. `in-progress` and
`failed` read the same in all three columns, and they name three unrelated things:
a GitHub **label** under `github`, a **directory** under `folder`
(`afk/in-progress/` and `afk/failed/` in the [layout below](#folder-mode-layout)),
and a label on **your own Jira board** under `jira`. Each lane defines its own copy
— `lib/labels.js`, `lib/folder-queue.js` and `lib/jira-jql.js` share no code for
these words — so renaming one leaves the other two exactly where they are, and a
Jira board that already carries an `in-progress` label is spelling the same word
rather than sharing Ralph's. Ralph also reads these names **exactly**: a board of
your own that runs a `build-failed` or `failed-review` label is not read as Ralph's
`failed`, and `pending-merged` is not its `pending-merge`.

Pick the source at `ralph init` time:

```bash
ralph init --source folder    # write TASK_SOURCE="folder"
ralph init --source github    # write TASK_SOURCE="github" (same as the default)
ralph init --source jira      # write TASK_SOURCE="jira" (plus the two Jira knobs — see below)
ralph init                    # interactive picker on a TTY, else defaults to github
```

The `--source` value is case-insensitive and trimmed, and it is **validated
before anything is written**: an invalid value is **rejected** with
`❌ Unknown task source '<x>'. Valid sources: github, folder, jira.` and a nonzero
exit, so a mistyped flag never silently falls back. `<x>` is sanitised exactly as
the [`--agent` rejection](#choosing-the-coding-agent) is — your value, untrimmed
and in its original case, with control characters replaced by `U+FFFD` and the
echo capped at 200 characters — so the rejection is always one line.

When you run `ralph init` in an interactive terminal **without** `--source`, it
prompts `Draw tasks from github, folder or jira? [github]:` — a **three-way
picker**, answered with a source name, trimmed and case-insensitive. A blank
answer (just pressing enter) keeps the default `github`, and so does anything the
picker does not recognise: unlike the `--source` flag, a typo at the prompt never
fails the init, it falls back. So the safe path is still the one you get by
holding enter.

Answer `jira` — or pass `--source jira`, which skips the picker entirely — and
init asks the two things a Jira run cannot work without, each showing the default
that pressing enter accepts:

| Prompt | Writes |
| --- | --- |
| `Jira eligibility query (JQL) [assignee = currentUser() AND status NOT IN ("Done", "Closed", "Resolved", "Canceled")]:` | [`JIRA_JQL`](#the-eligibility-query--jira_jql) |
| `Jira status for a finished ticket [Done]:` | [`JIRA_DONE_STATUS`](#recording-a-ticket-as-done--jira_done_status) |

Both go into `ralph.config.sh`, and for these two lines **init supplies the quotes
itself**: the default query contains double quotes, and a double-quoted value does
not survive them (the shell that sources the file drops the inner quotes and hands
the loop a different query than Ralph's own reader takes off the same line), so a
value that needs single quotes gets them. A `github` or `folder` init asks neither
question and leaves both knobs empty, exactly as before — and a `jira` init
scaffolds **no** `.ralph/tasks/` tree, because that tree belongs to the folder
source.

When stdin is **not** a TTY, `ralph init` asks nothing at all: with no flag it
defaults to `github` silently, so existing automation keeps working unchanged, and
`--source jira` writes the two defaults above without prompting or blocking.

To switch an existing project, edit `TASK_SOURCE` in `ralph.config.sh` by hand.
The bash loop, the prompt builder, and `ralph doctor`/`cycle` preflight all read
this one value, so the loop and prompt consistently honor it on every run.
`ralph doctor` reads it the way the loop does for any value it finds — the committed
`ralph.config.sh` line **first**, the environment second — which is what `ralph start`
and `ralph status` already did.
So a project that only ever writes the value into that file, which is exactly what
`ralph init` does, now gets one answer from all three: a config-only
`TASK_SOURCE="folder"` drops the `gh` row from `ralph doctor`, where before it took
one. **One spelling still parts them**, and it is an empty assignment: `ralph start`
takes a `TASK_SOURCE=""` line as the value it is — `github`, since that is what the
loop's own `${TASK_SOURCE:-github}` makes of the blank it sourced — while `ralph
doctor`, `ralph status` and `ralph cycle` read past an empty line into the
environment. So an exported source still reaches those three — `doctor` checking its
deps, `status` reporting it, `cycle` gating its preflight on it — over a run that will
do `github`. Closing that is a named follow-up; until then, blanking this knob to mean
"let my shell decide" is the one thing not to do with it.
`ralph start` also reports the resolved source in the `source` row of the identity
box it opens with, and adds a `repo` row naming the repository the
loop will read issues from — a folder-mode run draws no `repo` row at all, because
there is no repository it reads issues from, while a `jira` run draws one, because
`ralph start` itself still reads GitHub issues to decide whether to launch even
though the loop it launches no longer does. See
[the quick start](#quick-start) for how that slug is resolved.

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

Per-task telemetry is the **same stream**: one event per iteration, written by the
same sidecar, and the same `.ralph/metrics/issues.jsonl` and daily heartbeat
rollup serve both sources — keyed here on the task id. **Two rows of the
[event table](#per-issue-stream--ralphmetricsissuesjsonl) answer to the mode
rather than to GitHub**:
the `verdict` is the terminal directory (`done` → `pass`, `failed` → `fail`)
rather than anything read off a label, and `files`/`insertions`/`deletions` stay
`0` because the `gh` call that would fetch them is skipped — folder mode opens no
PR, so there is nothing to diff. A task's frontmatter **labels are not part of the
event**: it has no field for them, and the only labels the loop ever hands the
sidecar are the ones the `github` arm reads off the issue.
[`ralph status`](#run-state--ralphrun-statejson-and-ralph-status) serves both
sources as well: the loop
writes its run-state record from both, and in folder mode `status`
counts the queue off the local `.ralph/tasks/` tree — no `gh` call, in keeping
with the rest of the mode.

> **Accepted tradeoff:** committing straight to the dev branch means folder mode
> has no per-task rollback boundary — a bad autonomous commit lands directly on
> `DEV_BRANCH`.

### The `jira` source today

`TASK_SOURCE="jira"` **works a ticket, and records what became of it on the board.**
Ralph counts the queue from your Jira project, selects the oldest eligible ticket,
claims it, and hands the key to the agent, which reads the work item itself and
commits to `DEV_BRANCH` locally — then labels the ticket `done`, takes `in-progress`
back off, comments the commit SHA, and transitions it to
[`JIRA_DONE_STATUS`](#recording-a-ticket-as-done--jira_done_status) where that knob
names a status the project's workflow accepts. A ticket the agent did **not** finish
is swept by the loop instead: it reads the labels back off the board and gives anything
that is not `done` the `failed` label, `in-progress` off. The iteration is recorded too —
one issue event per ticket, carrying the key. What has **not** moved with the arm is what
`ralph start` does around the loop. [That has a section of its
own](#what-is-still-githubs) at the bottom of this one.

> **⚠️ None of this has been run against a live Jira.** Every Jira surface is unit-
> and stub-tested — the composed query, the queue count, the ticket selection, the
> claim, the completion, the sweep, the comment, the auth probe, the key grammar, the
> prompt render, and the whole bash arm driven end-to-end against a stubbed `acli` on a
> prepended `PATH` all have coverage
> — but no test has ever spoken to a real Jira site, and that is deliberate rather
> than an omission: four of the eight `acli` invocations are **writes** to somebody's
> board — a label, a label removal, a transition and a comment — so the stub never
> comes off `PATH`, not even in the test about a missing binary. What that leaves
> unverified is the shape of `acli` itself, which is **transcribed from its
> documentation rather than measured**: the flag spellings, the fields `search` will
> accept, the expectation that your query's ordering still decides which work item
> `--limit 1` returns, and the JSON envelope a work item comes wrapped in. A first
> run against a real project is a human-in-the-loop gate that has not happened yet —
> so expect rough edges on a real board, and see [What a broken `acli` costs
> you](#what-a-broken-acli-costs-you) for the shape those failures take.

> **⚠️ A `jira` run relabels every ticket it touches, and nothing takes those labels
> back off.** Every ticket it selects gains the `in-progress` label — the one the
> [composed query](#the-eligibility-query--jira_jql) excludes — and that write is not
> incidental: it is what makes the queue drain instead of handing the same ticket out
> forever. Every ticket then leaves the run carrying one of two more labels. A ticket
> the agent **resolved** gets `done` with `in-progress` removed, and the comment beside
> it says which commit resolved it. A ticket the agent did **not** resolve gets
> `failed` with `in-progress` removed — written by the loop, off the board's own labels
> rather than the agent's exit code — and it carries a comment only where the agent
> lived long enough to leave one. Both labels are excluded by the query, so the queue
> drains either way; neither is ever removed by Ralph, so **a swept or resolved ticket
> is yours to re-open**, and the `github` source's two ways back (the loop removes
> `in-progress` once an issue reaches a state the queue filter excludes anyway, and
> the next `ralph start` offers to clear the residue a killed run left) still have no
> Jira analog. The one ticket a run can leave reading as in flight is one Ralph could
> not edit at all: the sweep is a write too, and an `acli` that refuses it leaves
> `in-progress` where it was and says so on stderr. So point a narrow
> [`JIRA_JQL`](#the-eligibility-query--jira_jql) at this, rather than a board a team is
> working from.

Three things follow the value, and the first two are `ralph doctor`'s. The first is
the dependency check: it swaps the `gh` row for an `acli` one, on the
same source gate `gh` rides on, and `acli` is **critical** in its own right — the
queue depth, the ticket selection and the claim all go through it and there is no
second way to any of them, exactly as
a GitHub run has no way to its queue without `gh` — so a missing `acli` fails the
diagnostic and prints the install hint for your platform. The second is one row
added for the **login state**, which
is a different question from `acli` being on `PATH`. That one row has three
readings, and a run prints exactly one of them:

```
  ✓ jira auth
  ! jira auth (not authenticated)
      login: acli jira auth login
  ! jira auth (not verified)
      check: acli jira auth status
```

Auth is **reported, never enforced — by `doctor`.** Both failing states are a yellow `!`
and neither can move `doctor`'s exit code — the same treatment `doctor` already gives
agent-CLI health, and for the same reason: an expired token must not start failing
every wrapper and CI step that gates on `ralph doctor`. `ralph cycle` **enforces** the
same question rather than reporting it: its preflight runs this very probe under `jira`
and refuses to start a pass whose session it cannot prove, so a `!` on this row is a
warning about a scheduled run that will abort — see [What a broken `acli` costs
you](#what-a-broken-acli-costs-you). `not verified` is an honest
third answer rather than a softer failure: it means the check could not be **run**,
not that a login was refused, so its hint is the command to run by hand. (A missing
`acli` is not that state — the probe ran and failed, so the row reads `not
authenticated` beside the `✗ acli` dep row that names the real problem.) The verdict
keys on `acli jira auth status`'s **exit code** alone and never on its output text,
which a CLI is free to reword between releases.

#### The eligibility query — `JIRA_JQL`

The third thing the value changes is where the queue depth **and the ticket** come
from — one query answers both, so the count and the selection can never disagree
about what is eligible — and it is
the one that needs a setting of your own: `JIRA_JQL` in `ralph.config.sh`. A
`github` or `folder` init writes it **empty**; a `jira` init writes a **working
default** — `assignee = currentUser()` and nothing your workflow has finished — which
it offers at a prompt you can answer with your own query (see [Choosing the task
source](#choosing-the-task-source)). What belongs in it either way is the half
that is yours — which work items are candidates for Ralph at all — and nothing
about labels or ordering:

```bash
JIRA_JQL="project = RALPH AND statusCategory != Done AND assignee = currentUser()"
```

**Ralph appends its own half, and there is no way to turn that off.** Your clause
is wrapped in parentheses, then the label exclusion is added, then the ordering, so
the query that actually reaches Jira is:

```
(project = RALPH AND statusCategory != Done AND assignee = currentUser()) AND (labels NOT IN (in-progress, done, failed, do-not-ralph) OR labels IS EMPTY) ORDER BY created ASC
```

The exclusion is the Jira spelling of the label filter the `github` source runs: it
keeps the loop off work already in flight, already finished, already failed, or
marked hands-off. Its `in-progress`, `done` and `failed` names are also **the three
labels Ralph writes** — one when it claims a ticket, one when the agent records the
work as complete, one when the loop sweeps a ticket the agent did not finish — and
that is one mechanism rather than several agreeing conventions: the claim is what
makes the next pass of this query skip a ticket in flight, the completion is what
makes the queue drain rather than hand a resolved ticket out again, and the sweep is
what makes it drain even when the agent recorded nothing at all. `do-not-ralph` is
the only one of the four Ralph never writes — that one is yours, for a ticket you
want the loop to leave alone. The exclusion's `OR labels IS EMPTY` half is not a
flourish — in JQL a `NOT IN` never matches a work item whose field is unset, so the
`NOT IN` alone would hide every unlabelled ticket, which is most freshly filed ones and
therefore most of a queue. The parentheses
around your clause are a correctness fix rather than tidiness: JQL binds `AND`
tighter than `OR`, so appending `AND <exclusion>` to a bare `a OR b` would leave
every item matching `a` eligible however it is labelled — which is the in-progress
work the exclusion exists to skip.

**A fifth label matters to a Jira run and is not in this query at all:
`ralph-heavy`.** The four above are about *eligibility* — they decide which tickets the
loop may pick — while `ralph-heavy` is about *how hard the team works the ticket it
already picked*, and it is the orchestrator that reads it rather than the query. A
ticket carrying it is forced to
[**Tier 2 / Heavy**](#how-ralph-resolves-issues), the tier that adds the three-explorer
understand phase and the three-reviewer adversarial panel. The override is **subject to
`RALPH_HEAVY_TIER`**, which ships `0`: with the flag off, Tier 2 is unavailable and
triage falls back to Tier 1 whatever the label says. It needs no Jira-specific
translation — a Jira label is the same first-class field a GitHub label is, and the
orchestrator reads it out of the same `labels` array it already fetched with the work
item. So the full label vocabulary of a Jira run is five words: `in-progress`, `done`
and `failed`, which Ralph writes; `do-not-ralph` and `ralph-heavy`, which you write.

**Ordering is relocated, not refused.** Jira requires `ORDER BY` to be the final
clause, so a query that ends with one cannot simply have text appended to it: Ralph
cuts the ordering off, inserts the exclusion into the where-clause, and puts your
ordering back **verbatim** at the end — your case, your spacing, your text, because
rewriting it would be a second grammar nobody asked for. Any case is recognized
(`order by` reads the same as `ORDER BY`), and an `ORDER BY` **inside a quoted
string literal** — `summary ~ "order by"`, a text search for a phrase — is left
where it is, because cutting inside a literal would quietly produce a different
query rather than a syntax error. Write no ordering at all and you get
`ORDER BY created ASC`, oldest first: the same rule `github` mode's
`sort:created-asc` follows, so a queue drains instead of churning on whatever was
filed last.

**Empty means not configured, and deliberately not "everything".** Ralph's half on
its own selects every work item on the Jira site, so an unset `JIRA_JQL` would
report somebody else's board as this repo's queue. An empty, blank or missing value
therefore counts nothing and runs no `acli` at all. A `jira` init does not leave you
there — it writes the working default above, interactively or under `--source jira`
— so the empty case is now a config you blanked yourself, or one written by a
`github`/`folder` init that was later switched over by hand.

**Keep the query inside one project.** A Jira key is Ralph's only identity for a ticket,
but several record fields predate Jira and are typed as **numbers**, so the loop derives
one from the key by taking the digits after the hyphen: `FOO-123` becomes
`issue_number: 123`. That derivation **is not unique across projects** — `FOO-1` and
`BAR-1` both yield `1` — so a `JIRA_JQL` spanning two projects can conflate two
different tickets on every surface that publishes the number rather than the key. Three
do: `ralph cycle`'s `OK:`/`FAIL:` summary (printed *and* sent as the run's
notification), the interrupted run's report-card `outcome` row, and the transcript path
[`ralph digest`](#quick-start) quotes — where two tickets sharing a number collide on
one `logs/ralph-issue-<number>.log`. The surfaces that name a task by its **key** are
unaffected, because the key is what they print: `ralph status`'s progress line and task
table, the report card's `last task` row, `ralph digest`'s `TASK` line (its *narration*
names the key even where its transcript *path* does not), and `ralph status --json`, which
publishes `tasks.current.task_key` beside the number. The event itself always carries
both, so nothing is *lost* — but a single-project query is what keeps the number-shaped
half of that reporting readable, and it is the shape the derivation was accepted for.

Unlike [`TASK_SOURCE`](#configuration-reference), this knob is read from the
committed file **only**, with no environment fallback beside it. An eligibility
query is a property of the repository, and the assignment is always present in the
file — `init` writes it on every path, with a value for `jira` and empty otherwise —
so a loop that *sources* that file with `set -a` puts whatever it holds, empty
included, in the environment of every child it spawns: a variable that could answer
where the file is blank would read as unconfigured in the command you typed and
configured in the process it started. `ralph doctor` does not read it either — it checks that `acli`
is installed and logged in, never that your query parses.

> **Accepted tradeoff:** the parenthesis wrap is not validation, and nothing checks
> that your clause is balanced. An ordinary unbalanced typo composes to unbalanced
> JQL, which Jira rejects — costing you the count and never a wrong one — but a
> clause built to close Ralph's parenthesis and reopen its own
> (`project = R) OR (1=1`) composes to something balanced and valid, with the
> exclusion demoted to one branch of the `OR` and the drain guarantee gone.
> Rejecting an unbalanced clause is a follow-up; until then this line is trusted
> the way every other line of a config file you commit is.

**A `#` anywhere in the value needs single quotes.** Ralph never *sources*
`ralph.config.sh` — the Node CLI text-parses individual assignments out of it — and
that reader closes a double-quoted value at an inner quote and takes a `#` after it
for a comment. So `JIRA_JQL="summary ~ \"#123\""` reaches Jira **truncated** where
bash would have kept it whole, Jira rejects the composed query, and a rejected query
costs you the count. Searching for a ticket reference is the ordinary case that hits
this, and either spelling avoids it: quote the **value** with single quotes
(`JIRA_JQL='summary ~ "#123"'`), or write the JQL literal with them
(`JIRA_JQL="summary ~ '#123'"`). A query with no `#` in it is unaffected.

#### Recording a ticket as done — `JIRA_DONE_STATUS`

Once the work is committed, the agent closes the ticket out through Ralph's own queue
module rather than through `acli` — the orchestrator prompt gives it two commands,
`lib/jira-queue.js complete "<KEY>"` and then
`lib/jira-queue.js comment "<KEY>" "<body>"`, and forbids it every other board write.
The first makes **up to three** board writes, in this order — it transitions the ticket
to the status `JIRA_DONE_STATUS` names, adds the `done` label, and takes `in-progress`
back off (that last only if the ticket still carries it). The second posts the audit trail:
the commit SHA, the branch, whether `TEST_CMD` and `LINT_CMD` passed, and a line on
what changed. Neither runs before the commit exists — a ticket marked done for work
that was never committed is worse than one left in flight, because the queue has
drained and the evidence has not.

**Only the label is promised, and that is deliberate.** The config template ships
**no status name** of its own, because there is no name that is right on every
board — a `jira` init asks for one, offering `Done`, but that is an answer you can
see and change rather than a shipped default, and a `github` or `folder` init leaves
the line empty. The names
come from your own project's workflow — `Done` on one, `Resolved`, `Closed` or
`Ready for Release` on the next — so write yours exactly as that workflow spells it,
capitalisation included. Empty or unset means *do not transition*, and is not an
error. A value you did set is not a guarantee either: a workflow decides which moves
exist from a given status and what each one requires, so it can refuse the move
because there is no transition from where the ticket sits, or because a field has to
be filled in first, or because a validator says no — and Ralph cannot know any
project's workflow well enough to avoid that. Both cases read the same way: the
completion **warns on stderr** — naming the ticket, and the status too where there was
one to attempt — and then finishes the job anyway. It still labels the ticket `done`,
the comment still goes on, and the ticket still counts as resolved. A board Ralph could
not drive is not a task Ralph failed; what it leaves you is one ticket to move by hand,
and the warning says which.

The label carries the promise because Jira labels are freeform text no workflow rule
can veto, and `done` is in the exclusion above — so a resolved ticket stops being
eligible on the next pass whatever the board's status column ends up saying. That
makes a `done` label which could not be written the **one** failure that matters: it
is the only outcome that leaves a resolved ticket in the queue to be handed out again,
and so the only one that makes `complete` exit non-zero (a key that is not usable as a
work item key is the other, and it is refused before any process is started). The
comment is best-effort by contract and its verb always exits `0`: the work is already
committed by the time anything comments, so a post that did not land costs you the
audit trail and never the iteration.

**No `ralph` command reads this value** — not `doctor`, not `status`, not `cycle`. Its
only transport is the loop *sourcing* `ralph.config.sh` with `set -a`, which exports
the assignment into the agent's environment, where `complete` reads it. So the value
that reaches a completion is the one committed in that file.

#### What a broken `acli` costs you

The count is taken by running the composed query through
`acli jira workitem search --jql <query> --count`, and the answer has to be a bare
run of digits on stdout after a **clean exit**. The exit code is read first, so a
non-zero exit with a number in its message is a CLI explaining itself rather than a
count, and text that is not a plain integer is not a count either — an empty answer
is the shape a broken spawn produces, and reading it as `0` would be reading a
failure as a fact about your board.

The other seven calls read the same way. The selection is the **same composed
query** with `--limit 1 --json --fields key,summary`, so the ticket that comes back is
drawn from exactly the set the count counted, and — with the caveat below — first by the
ordering that query carries. The claim is **two** calls rather than one:
`acli jira workitem view --key <KEY> --fields labels --json` to read the labels the
ticket already has, then
`acli jira workitem edit --key <KEY> --labels "<union>" --yes` to write them back with
`in-progress` added. It is a read-then-union because Ralph's label must not cost you
yours: `acli`'s `--labels` is documented as editing the labels without saying whether
it merges or replaces, and a union written by Ralph is correct either way. A ticket
labelled `frontend, p2` keeps both. Claiming twice writes nothing the second time —
the union is already there — and the `--yes` is what keeps an unattended run off a
confirmation prompt. If the labels cannot be **read**, nothing is written at all: a
blind write is the one way to lose a label.

The [completion](#recording-a-ticket-as-done--jira_done_status) is the remaining three,
and the `done` label goes on through that same read-then-union pair, for the same
reason. Around it: `acli jira workitem transition --key <KEY> --status "<STATUS>" --yes`
for the board move, and
`acli jira workitem edit --key <KEY> --remove-labels in-progress --yes` to take the
claim back off — spelled with its own flag rather than as a `--labels` list of
everything else, because "remove these labels" means the same thing whether `--labels`
merges or replaces, while a list would be a bet on one of the two. The comment is
`acli jira workitem comment create --key <KEY> --body "<body>" --yes`, a two-word
subcommand where every other call here has one. A refused transition costs the board
move, a refused removal leaves a ticket carrying both labels (untidy, and still out of
the queue, since the exclusion matches `done` too), and a refused comment costs the
audit trail — none of the three costs the iteration.

The **sweep** adds no call of its own: `locate` is the claim's label read on its own, and
`fail` is the claim's read-then-union write — with `failed` added instead of
`in-progress` — followed by the completion's `--remove-labels`. So those seven are
the whole inventory whichever way an iteration ends, and the sweep inherits their
failure shapes. A label list nobody can read is the one that reads differently at each
end: `locate` reports it as `unknown`, which the loop treats as "not provably done" and
sweeps, while `fail` writes nothing at all, for the claim's reason — a blind write is
the one way to lose a label.

The **eighth** call belongs to no iteration at all: `ralph status` asks the board for the
**summaries** of the tickets on its task table, in one
`acli jira workitem search --jql "key IN (…)" --limit <n> --json --fields key,summary`.
It is a read, it is made by a read-only view, and every way it can fail costs prose and
nothing else — [Where the titles come from, and what they
cost](#the-progress-line-and-the-task-table) has its gates and its failure shape.

**Every `acli` spelling on this page is transcribed from Atlassian's documentation, not
measured.** Nothing in this repo has ever run a real `acli` — there is none in CI, and
four of these eight calls write to a live board — so every test injects its own spawner
and every argv on this page is read off the docs rather than observed working. Three
claims in particular are the docs' and not Ralph's: that `--fields` on `search` accepts
only `issuetype, key, assignee, priority, status, summary, reporter, labels` (which is
why the selection and the title lookup both ask for `key,summary` and nothing more);
that it restricts the fields
*fetched* without touching what may be ordered on — so the `ORDER BY created ASC` above
is *expected* to decide which single ticket `--limit 1` returns, not confirmed to; and,
weakest of the three, the `--yes` on the **comment**, which is extrapolated from the
three writes documented as taking one rather than read off `comment create`'s own
documentation. Every failure mode is survivable, which is why the argv is stated rather
than hedged into uselessness: a flag `acli` rejects exits non-zero, so a bad spelling
costs the count, or costs the read and therefore writes nothing, and says so on stderr;
a wrong ordering costs you only oldest-first, since the queue still drains one ticket
per iteration; and a rejected `--yes` on the comment costs the comment alone, quietly,
with one line on stderr. `lib/jira-acli.js` holds **every** one of those eight argvs in
one place, and says at each which parts are unmeasured — `lib/jira-queue.js` above it
holds the verbs (count, pick, claim, complete, comment, locate, fail, titles) and what a failure
of each means for the queue, as `lib/jira-auth.js` holds the login probe — so a
correction is one edit and not a search.

Every way that can fail — no `acli` on `PATH`, a logged-out session, an unconfigured
`JIRA_JQL`, a query Jira rejects, output nobody can parse — costs you the **count**.
For three of those five that is the whole cost. The two that are about the **session**
now cost a scheduled pass as well, and earlier than the count: `ralph cycle`'s preflight
runs `acli jira auth status` under this source *before* it counts anything, so a
logged-out session — or an `acli` that is not there to be asked, which that probe reads
as the same verdict — aborts the pass at second zero with
`❌ ralph cycle: preflight failed (jira not authenticated — run: acli jira auth login).`
and never reaches the row below. **The two commands then degrade differently, on
purpose,** so one broken `acli` reads two ways and neither of them is a bug:

| Command | Reads an unprovable count as | Because |
| --- | --- | --- |
| [`ralph status`](#run-state--ralphrun-statejson-and-ralph-status) | `queue      unknown` — and `progress.remaining` / `progress.total` as `null` under `--json` | A read-only view has to be able to say it does not know. `0 waiting` is a claim about your Jira board, and it reads as "almost done" when the truth is that nobody could reach it. |
| [`ralph cycle`](#scheduling-ralph-macos-launchd) | `0`, so it prints `ℹ️  ralph cycle: queue empty, exiting.`, appends one `RALPH_CYCLE_EVENT` with every count zero, and exits `0` — on the three causes that get as far as a count at all, the session having been proved first | A scheduler with no provable work has nothing to do. Aborting a scheduled pass over a diagnostic problem would cost the tick for no gain, and the next tick takes the count again. |

So a `queue      unknown` in `ralph status` beside a cycle that says the queue is
empty is **one** finding wearing two faces, not two defects: look for the cause
rather than the disagreement, and `ralph doctor` is where the cause is named. A
`queue      unknown` beside a cycle that aborts naming `jira not authenticated` is that
same single finding in its other pairing — the session — and there the cycle names the
cause itself rather than leaving you to infer it from an empty board.

Inside the loop the same rule holds one step further along, at a different price each
time. A **selection** that answers nothing — a broken `acli`, a rejected query, JSON
nobody can parse, or a ticket somebody else claimed between the count and the pick —
reads as an empty queue: the loop prints `Queue empty, exiting.` and stops, because
there is nothing it can name to work on. A **claim** that fails costs the board and
not the run: the loop warns on stderr (the CLI's own line names the ticket and what
went wrong), leaves the ticket eligible, and carries on. The guard against that
becoming a spin is the ticket's own key — re-selecting the key it selected last
iteration means the board did not change, and the loop aborts with
`❌ ralph.sh: no progress on FOO-123 (re-selected). Aborting the loop.`, the Jira
analog of the zero-progress guard the other two sources have. The **completion**'s
failures are read one level further in — by the agent, which is what runs it — and
they degrade the same way: everything except a lost `done` label is a warning on
stderr and a ticket that still counts as resolved
([the section above](#recording-a-ticket-as-done--jira_done_status) has the split). The
**sweep** is the loop's again, and it is the one call whose failure the loop does not
even branch on: it runs `locate` with stderr dropped (the state word on stdout is the
whole answer, and an unreadable ticket is reported as `unknown`, which sweeps), then
`fail` with stderr kept and `|| true` after it, so a `failed` label `acli` refused
prints its reason and costs nothing else. The iteration is counted a failure either
way, because the run must finish whether or not the board could be written to.

The cycle's reading has a consequence worth knowing before you set the value: under
this source it is the **Jira** count that decides whether `ralph cycle` starts at
all, so a `JIRA_JQL` that matches nothing — or that is unset, or that Jira rejects
— makes the cycle exit `queue empty` however much work the board is holding.
`ralph start` is the other way round, and that is the mismatch below: its launch gate
is still GitHub's count.

And one consequence you will see rather than infer: `ralph status`'s `progress` line
counts the tasks this run has **completed**, read back out of
[`issues.jsonl`](#per-issue-stream--ralphmetricsissuesjsonl) — and this arm appends one
event per ticket, so that count climbs for a `jira` run exactly as it does for the other
two, against a denominator that is the Jira depth, with the ticket in hand as the one task
in flight. That task is named by its **key** (`FOO-123`) rather than a `#number`, in the
progress line and in the per-task table
under it — the rows a **finished** ticket leaves behind included, because the event carries
the key too. The progress line names the key and no summary, because nothing Ralph writes
records one; a **table row** carries the ticket's summary beside its key, which
`ralph status` looks up from the board itself in one `acli` search over the keys the table
is about to draw ([where the titles come from](#the-progress-line-and-the-task-table) has
that call, its gates and its failure shape) — a courtesy, so a lookup that fails leaves
every row its key and nothing else. The places that name a task a run has *finished with*
mostly follow the same rule — the `last task` row on the report card a killed run leaves
behind, and the task [`ralph digest`](#quick-start) narrates — with two exceptions, both
named below.
The derived `#number` is mostly left where
machines read it: `current.number` in
[the record itself](#run-state--ralphrun-statejson-and-ralph-status),
[`ralph status --json`](#machine-readable-output--ralph-status---json)'s
`tasks.current.number` — which now publishes `tasks.current.task_key` beside it, so a
machine reading that document is handed the ticket's own name and the number is a handle it
may ignore — and each event's `issue_number`.

**Two human surfaces still show that number**, and both are summary lines a command builds
out of the events rather than out of the run record. `ralph cycle`'s summary builds its
`OK:`/`FAIL:` lists from the events' `issue_number`, and it both prints the line and
sends it as the run's notification — so a Jira cycle reports `OK: #123` for a ticket called
`FOO-123`. That is the line the **command** composes from the events, not the `OK:`/`FAIL:`
line the loop script prints at the end of a run, which holds the keys themselves
(`OK: #FOO-123`). The report card's `outcome` row is the other: its failed list is drawn
from the same field, so one card carries `outcome    1 ok · 2 failed  — #123` and, further
down, `last task  FOO-123` — the same ticket, spelled both ways. Rendering either list from
the key the event now carries is a follow-up, and one worth doing to both at once; the
counts beside them are right, and so is the cycle's exit code.

**One path is still derived from that number rather than from the key, and under this
source it points at the wrong file.** `ralph digest` picks the per-task transcript it
quotes as `logs/ralph-issue-<number>.log`, so a `FOO-123` in flight sends it to
`logs/ralph-issue-123.log` — while the iteration wrote `logs/ralph-issue-FOO-123.log`,
named from the key. So the digest reads no transcript for a `jira` run at all: the missing
file is swallowed and the narration still reports `ok`, which is what makes it easy to
miss. In a repo that has *also* worked GitHub issues that path can be issue #123's log
instead, and then a paragraph about your Jira ticket is written over somebody else's work;
two tickets whose keys share a number (`AAA-7` and `BBB-7`) would collide on one path as
well. The narration still names the task by its key, so the two do not agree and the
mismatch is visible. Keying that path on the task the record names is a follow-up rather
than a decision; until it lands, read a `jira` run's digest as prose about the run and not
about a transcript.

#### What is still GitHub's

The work does happen: the loop names a ticket, claims it, and hands the **key and
nothing else** to the agent, which reads the work item with `acli` itself and commits
straight to `DEV_BRANCH` — no feature branch, no PR, no auto-merge, and nothing pushes,
the same delivery shape `folder` mode has. The transcript lands in
`logs/ralph-issue-<key>.log`, one log per ticket.

**Nothing publishes that commit, so publishing it is yours.** The word `push` does not
appear in the loop script at all, on any of its three source arms, and the Jira
orchestrator forbids the agent from pushing outright — so `DEV_BRANCH` in the clone
Ralph ran in is the only place the work exists. Pushing it, or merging it onward, is a
step you take by hand after the run, and a run left unattended for a week is a week of
tickets sitting in one local branch. That is also why the ticket matters more here than
it would in `github` mode: the [comment a completion
posts](#recording-a-ticket-as-done--jira_done_status), carrying the SHA and the branch,
is the only record of the work that leaves the machine.

**Read that once more before you point Ralph at a board somebody else reads.** The two
halves of a Jira iteration land in different places and only one of them is shared: the
*code* stays on one machine, while the *ticket* moves on a board a whole team is looking
at. So a ticket Ralph transitioned to `JIRA_DONE_STATUS` and labelled `done` can be
describing work that exists **nowhere but the clone Ralph ran in** — the board says
finished, and a colleague pulling the dev branch finds nothing there. That is a
**deliberate trade-off**, not an oversight: the delivery shape was taken from `folder`
mode wholesale so that the arm could be built and reasoned about before anything
published on its own. It is also why the guidance everywhere on this page is to give
`JIRA_JQL` a narrow, personal scope — `assignee = currentUser()`, which is what a `jira`
init offers — rather than a shared team board. A private queue makes "the board is ahead
of the repo" a note to yourself; a shared one makes it somebody else's wrong information.

**Both outcomes are written to the board, and by different processes.** A ticket Ralph
resolved is labelled `done` with `in-progress` gone and a comment naming the local
commit — the agent does that itself, because only the agent knows whether the work
landed and what SHA it landed as. A ticket it did **not** resolve is labelled `failed`
with `in-progress` gone, and the **loop** does that, because the invocation most in need
of sweeping is the one that died and a dead agent writes nothing: after the agent returns
bash reads the labels back and treats anything that is not `done` as a failure, whatever
the agent's exit code said. Both labels are excluded by the eligibility query, so the
queue drains either way and one killed run cannot leave the loop spinning on one ticket.
Neither label comes back off by itself — a swept ticket is yours to re-open, and it
carries no comment when the agent died before writing one, so the per-ticket log in
`logs/` is the record of what happened.

**The orphan sweep is GitHub's, and there is no Jira one.** `lib/orphan-cleanup.js` — the
thing that finds work a dead run left claimed and un-claims it — is spelled entirely in
`gh`: it lists with `gh issue list --state all --label in-progress …` and clears with
`gh issue edit N --remove-label in-progress`. So it can only ever repair a **GitHub**
issue, and running it under this source does nothing for your board (it does still spend
`gh` — see below). The in-iteration sweep covers the case it was built for: an agent that
died still gets its ticket labelled `failed`, because that sweep runs after the dispatch
returns. What it cannot cover is the **loop itself** dying — the tmux session killed, the
machine rebooted, an `acli` that refused the label write — because then no sweep runs at
all. The ticket is left carrying `in-progress`, which the eligibility query **excludes**,
so it is quietly out of the queue and stays there until somebody takes the label off by
hand. In `github` mode that residue gets cleared for you on the next scheduled pass —
`ralph cycle` runs this very module and removes `in-progress` from every orphan it
finds — and `ralph start` at least *names* the affected issues and prints the `gh issue
edit` to clear them by hand. Neither has a Jira analog. A narrow
[`JIRA_JQL`](#the-eligibility-query--jira_jql) is what keeps that recoverable: on a board
you own, a stray `in-progress` is one label you can find.

**The telemetry is wired**, and it is the loop's own: after the sweep, each iteration
appends one issue event to `.ralph/metrics/issues.jsonl` carrying the ticket key as
`task_key`, the number derived from it as `issue_number`, and the same agent, duration,
cost, turn-count, model and context-window fields every other source records. The
iteration's two log files are **inputs** to that, not fields of it: the sidecar reads the
raw stream and the stderr log it wrote to get the figures above and the error-signal count
beside them, and records what it counted rather than where it read it. So `ralph status`
counts a Jira run's completed tickets and names them by key, the idle report card can tally
an interrupted one off its events, and `ralph cycle` gets the `N ok, N failed` it decides
its exit code with. It is a **sidecar**: every write runs with `|| true` and exits 0
whatever happens, so an unwritable `.ralph/` costs the run its record and nothing else.
The end-of-run summary the loop prints names the tickets it worked, by key, under `OK:` and
`FAIL:`.

The loop itself is clean of GitHub: no `gh` command runs in a `jira` iteration, and
the run records `jira` as its
[run-state `source`](#run-state--ralphrun-statejson-and-ralph-status), which is what
it actually did.

**`ralph cycle` has moved with it; `ralph start` has not.** The scheduled command's
preflight now asks each source for the credential that source actually spends:
`gh auth status` under `github`, `acli jira auth status` under `jira`, and nothing at
all under `folder`. So an unauthenticated Jira session stops a scheduled pass at second
zero, with the abort every other preflight failure takes —
`❌ ralph cycle: preflight failed (jira not authenticated — run: acli jira auth login).`
on stderr, the same WhatsApp notice, the same `preflight-failed` event, exit 1 — and it
costs **zero** agent invocations, because an unauthed run would select nothing, claim
nothing and drain nothing. It is the same probe `ralph doctor`'s `jira auth` row runs
(one function, one argv), so the two cannot disagree about *this* question: no machine
gets a `✓ jira auth` row and a cycle that refuses to start over the session.

A broken `gh` no longer *stops* a `jira` cycle, but such a run still spends `gh` twice,
plus a `gh issue edit` write per orphan found — measured, not assumed: the cosmetic
repo-slug lookup behind the notification (which falls back to the repo path), plus the
orphan sweep's `gh issue list --state all --label in-progress` and, per orphan found, a
`gh issue edit N --remove-label in-progress` **write** to the GitHub board. A healthy
repo has no orphans, so the steady state is those first two calls and nothing else. The
sweep is not source-gated, so under
`jira` a logged-out `gh` produces neither a named abort nor a clean pass: every tick
prints `orphan-cleanup: gh list exited 1: …` to the scheduled run's stderr and then
drains Jira anyway. **Source-gating the orphan sweep is the remaining follow-up**; the
preflight change deliberately left it alone.

`ralph start` still treats every non-`folder` source as a GitHub one, so under `jira`:

- `ralph start` **aborts** unless `gh auth status` succeeds — `❌ gh not authenticated`
  — even though nothing in the run will use `gh`.
- `ralph start` creates its issue labels in the GitHub repo and reports issues still
  carrying `in-progress` from an earlier run.
- `ralph start` takes the `N issues in the queue` line of the
  [launch box](#the-launch-projection--ralph-start), and the projection under it, from
  **GitHub's** queue, and stops with `ℹ️  No issues in the queue. Nothing to do.` when
  that queue is empty however many tickets Jira is holding. (`ralph cycle` is the one
  that already counts Jira, so a scheduled pass starts on the right number.)

So `ralph start`'s queue line and `ralph status`'s queue row are about different
boards under this source, and only `ralph status`'s is about the queue the loop
drains. Moving the launcher onto the Jira count — and off its `gh` gate — is the
remaining follow-up: until it lands, a `jira` repo's `gh` install and `gh auth login`
stay your responsibility — a hard requirement for `ralph start`, which refuses to launch
without them, and still a real one for `ralph cycle`, which no longer *gates* on `gh` but
spends it on the slug lookup and the orphan sweep described above. That is also why
`ralph doctor` dropping the `gh` row here is not yet the whole story. `acli` is what the
loop needs and what the scheduled command now proves; `gh` is what the interactive
launcher still asks for outright.

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

A scheduled pass is observable **while it runs**, not only after it: the cycle
writes the same run-state record an interactive run does, and proves it is alive
by holding the cycle lock rather than by owning a tmux session, so
`ralph status` reports it as `running` and points you at
`logs/ralph-cycle.out.log` instead of at an attach command (see
[Run state](#run-state--ralphrun-statejson-and-ralph-status)).

**A launchd agent sources no shell startup file**, so the
`EnvironmentVariables` dict `install` writes into each plist is the
entire environment a scheduled run ever sees — not your `.zshrc`, and
not an `export` you typed in a terminal. Two values from the installing
shell go into it: `PATH`, and `RALPH_NO_UPDATE_CHECK` when that is set
to a non-empty value. Both are snapshots taken **at install time**;
re-run `ralph schedule install --force` to re-take them (see
[Environment variables](#environment-variables) for what the second one
silences).

## Updating Ralph

Ralph ships one update command, `ralph update`, and offers to run it for you
roughly once a week — from `ralph start`, or from a `ralph cycle` you run on a
terminal yourself. There is no `ralph upgrade` and no alias for one.
`ralph changelog` is the other half of that pair: what the version you are on —
or the one you just moved to — actually changed.

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

### `ralph changelog`

`ralph changelog` answers the question an update leaves behind: what changed. It
is the other command about the **install** rather than about a project, so like
`ralph update` it needs neither a git repository nor an initialized Ralph project
— no `ralph.config.sh`, no `.ralph/` — and runs from any directory. The default
view is the **three newest releases**, in the order the file lists them, under a
count of how many it holds and a pointer to the rest:

```
Ralph changelog — the 3 newest of 31 releases
run `ralph changelog --all` for every release

0.22.0 — 2026-08-27
  Features
    • `ralph digest --loop` + a digest window in the tmux session (#62) (#95) (a2f9464)
    • `ralph digest` one-shot — no-tool narration on a cheap model (#61) (#93) (6687570)
    • a digest section in `ralph status` (#63) (#96) (a6c37ba)
    • commit the sprite asset and show it statically in `ralph start` (#67) (#97) (541616f)

0.21.0 — 2026-08-26
  Features
    • GIF-to-sprite generator and pure half-block renderer (#66) (#87) (6d1834b)
    • idle post-mortem and never-run pointer in `ralph status` (#59) (#91) (46ddd1e)
  Bug Fixes
    • never finish a turn with a subagent in flight (#88) (#89) (c18ea21)

0.20.0 — 2026-08-26
  Features
    • `ralph status --json` (#58) (#84) (15c8ae0)
    • launch projection and `ralph status` hint in the `ralph start` box (#60) (#85) (ec042ac)
    • observed pace, ETA with range, and spend projection in `ralph status` (#57) (#83) (89da13d)
    • print the update notice in `ralph cycle` (#51) (#79) (2cde79f)
    • run-state file + `ralph status` reporting the in-flight task (#55) (#82) (330cedf)
    • TTY-gated update prompt in `ralph cycle`, stopping the drain after an install (#52) (#81) (c4a9ec8)
```

`--all` prints every release in the file instead. Having held nothing back it
drops the pointer line, and the header reads `Ralph changelog — 31 releases`.

Three is a count of **releases, not of bullets**: the newest entry is printed
whole, which is the point of the command. The identity box
[`ralph start`](#quick-start) opens with shows the first three *bullets* of that
same entry, clipped to its width; nothing is clipped here, so a bullet longer
than your terminal wraps rather than losing its tail. Structure comes from
indentation — two spaces for a section heading, four and a `•` for a bullet —
and the listing carries **no colour and not one escape byte**, so
`ralph changelog --all | grep digest`, a pager, or a paste into an issue comment
all give back exactly what you saw. A release with no day on its heading (an
`Unreleased` entry) prints its version alone rather than a dangling separator.

What it reads is the [`CHANGELOG.md`](./CHANGELOG.md) inside the installed
package, resolved against the **install** and never against your working
directory — so standing in a project that has a `CHANGELOG.md` of its own still
prints *Ralph's* releases and never yours. It is one local read: no registry
query and **no network call at all**, which is what makes it answerable offline,
instantly, from anywhere.

A changelog it cannot answer from costs you two lines on **stderr** — what it
could not do, and what to do about it — and exit code **1**, never a stack trace.
Stdout is left empty in every case, so a pipe into a pager gets an empty document
rather than half a listing. The three failures are worded apart because the
repairs differ: a file it could not read is reported with the path it tried and the note that
reinstalling Ralph restores it (a pruned install, or a tarball built without the
file); a file it read but could not parse says that instead; and a file that is
readable but holds no `## <version>` release heading is named along with how many
characters long it is. This is where the command and the identity box part
company: the box drops rows nobody asked for and starts the loop, while a
question you typed is owed either an answer or a failure.

### The weekly check

Before the loop launches, `ralph start` asks npm for the latest published
version — **at most once every 7 days** — and prints
`New version available: <version> (run npm i -g @lucasfe/ralph to update)`
when what it knows about is newer than what you have. The notice itself is not
throttled and keeps printing on every run that finds something newer (see
[Troubleshooting](#troubleshooting)).

**`ralph cycle` runs the identical check, and on a terminal asks the identical
question.** A scheduled cycle (see
[Scheduling Ralph](#scheduling-ralph-macos-launchd)) runs the same check and
prints the same one-line notice, on stdout — which launchd captures in
`logs/ralph-cycle.out.log`, where an unattended run is read. **Both** global
7-day windows are shared with `ralph start`, so six cycles a day cost at most
one registry query and one question a week between them, not six a day — and
being asked by one of the two commands this week means the other will not ask
again until the window rolls over. `ralph doctor` is the exception that draws
from neither: it *reads* that same file for the `cached` row of its identity box
and stamps neither window, so running `doctor` never spends the week's question.

A scheduled cycle is **notice-only**: launchd attaches no terminal, so the
question below is never asked and its window is never spent. **Ralph never
auto-updates on a schedule** — an unattended tick notifies and nothing more;
the install runs only after a human answers the question on a terminal. And
printing is not asking, so the check can **never block a scheduled tick** and
never fail one: it prints, and the pass drains as it always would. To silence a
*scheduled* cycle, [`RALPH_NO_UPDATE_CHECK`](#environment-variables) has to
reach the launchd agent, which is not the same thing as exporting it in your
shell.

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

Run `ralph cycle` by hand on a terminal and the same question follows its
notice — same wording, same window — with one difference in what accepting
means: the update runs, ``✅ Updated to <version> — run `ralph cycle` again.``
is printed, and the cycle **stops without draining the queue**, for the reason
`ralph start` refuses to launch. This process holds pre-update code and reaches
the loop script through the install that was just replaced, so stopping is what
guarantees no issue is processed by a mixture of two versions. Nothing is lost:
re-run `ralph cycle` yourself, or let the next scheduled tick pick the new
version up on its own. Declining, a failed install, or an `npx` run / linked
dev checkout with nothing to install all leave the cycle draining normally on
the version you already have — the last two after one neutral line,
`⚠️  Update did not complete — continuing this cycle on <version>.` A stopped
cycle still appends one `RALPH_CYCLE_EVENT` (status `updated`, every count
zero) to `logs/ralph-cycle.out.log`, so the
[daily heartbeat](#daily-heartbeat-24h-summary) counts the tick but attributes
no issues and no run time to it.

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
querying. A *scheduled* `ralph cycle` is the pure form of the first case: it
reads and writes the same file and stamps `last_check_at`, but never
`last_prompted_at`, because launchd gives it no terminal to ask on. Run by hand
on a terminal it stamps both, out of the very same windows `ralph start` draws
from. The prompt is always served from the *cached* `latest_version`,
so a query that was skipped or that failed outright still gets you the question
as long as what is cached is newer than what you have — which is the point: a
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
not a knob. `ralph doctor` reads the update-check file for the `cached` row of
its identity box, and only reads it: it makes no registry query and stamps
neither window, so running `doctor` neither refreshes the weekly check nor
consumes the week's question. The `update` row of the identity box
[`ralph start`](#quick-start) opens with reads it the same way — one field,
`latest_version`, no query and no stamp, so it can never move either window — with
one difference from `doctor`: it is silenced by
[`RALPH_NO_UPDATE_CHECK`](#environment-variables), and on that path the file is
not opened at all. `doctor`'s row has a switch of its own instead, and it is the
one that removes the whole box: under
[`RALPH_BANNER=off`](#configuration-reference) there is no row to fill, so that
run does not open the file either.

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

**Write every line as `KEY=value`, with nothing between the name and the `=`.**
The file is read two ways — the loop *sources* it with `set -a`, and the `ralph`
commands text-parse individual assignments out of it without ever running it —
and a shell assignment ends the name at the `=`. So `TASK_SOURCE = folder` is not
a setting at all: bash reads it as a *command* named `TASK_SOURCE` with two
arguments (`TASK_SOURCE: command not found`, and the variable left holding
whatever it already held), and Ralph's own reader now agrees with the shell about
that rather than honoring a line no run would ever have used — see
[Troubleshooting](#troubleshooting) for the symptom and the fix.
Indenting an assignment is fine, with **a space or a tab** and nothing else: a
no-break space or a byte-order mark in front of the name — what a config snippet
pasted out of a rendered web page arrives with — is an ordinary word character to
the shell, which makes the line a command again. Quotes around a value are
optional and an `export` prefix is accepted; both readers take either.

**And nothing between the `=` and the value either, when the value is unquoted.** It
is the same rule at the other end of the assignment, and it costs a setting just as
silently: `RALPH_DIGEST_INTERVAL=  2h  ` is bash's *environment-prefix* syntax, not an
assignment — the `RALPH_DIGEST_INTERVAL=` binding is scoped to the command word that
follows it, so bash runs `2h` (`2h: command not found`), the binding dies with it, and
the variable is left holding whatever it already held. `TASK_SOURCE= folder` is the
same line, and so is `RALPH_AGENT=# off`, where the `#` opens no comment because a
comment only opens at a `#` that *begins* a word. Ralph's readers refuse all of them
too, so such a line is read by nothing: a knob with an environment fallback
(`TASK_SOURCE`, `RALPH_AGENT`, `GH_REPO`) falls through to your shell exactly as it
does in bash, and one whose read of this file has no environment fallback at all
(`RALPH_DIGEST_INTERVAL`, and `RALPH_DIGEST_MODEL` on the digest-window path) is
simply unset.
Write `RALPH_DIGEST_INTERVAL=2h`, or quote the value: `RALPH_DIGEST_INTERVAL="  2h  "`
is a real assignment, because the blanks are inside the quotes, and Ralph trims it back
to `2h`. Two neighbouring spellings are **not** affected, because bash really does
assign on them, and both assign **empty**: a blank with nothing behind it
(`RALPH_DIGEST_INTERVAL= `) and a `#` that begins its own word, which is an ordinary
comment (`RALPH_DIGEST_INTERVAL= # off`). A third spelling is outside the rule for a
different reason: a **backslash** at the very end of a line is bash's line
*continuation* rather than a word, so the line runs on into the next one and — when
nothing follows on it — the assignment is real: `TASK_SOURCE=folder \` on its own leaves
the shell holding `folder`. Ralph's readers call that an assignment too, but they stop at
the newline where bash does not, so the value they read keeps the trailing ` \` — and, if
you quoted the value, the **quote pair** with it, because a tail outside the pair defeats
the rule that would otherwise unwrap it: `TASK_SOURCE="folder" \` reads as `"folder" \`
where bash holds `folder`. Either way a string bash never held is a string no knob
recognizes, so that line has `ralph start` naming `github` (its fallback for an
unrecognized source) over a loop working `folder`. And put a real command on the
continuation line and even the *presence* verdict parts company with the shell:
`TASK_SOURCE=github \` followed by `echo hi` assigns nothing at all — the binding is
scoped to that `echo` and dies with it — while Ralph reads the line as an assignment and
resolves `github`. Write each assignment on one line; nothing in this file needs a
continuation. An `export` prefix is out of the rule as
well, and is no way round it either: `export RALPH_DIGEST_INTERVAL= 2h` has the
builtin apply the `RALPH_DIGEST_INTERVAL=` and reject the rest
(``export: `2h': not a valid identifier``), so bash is left holding an empty value while
Ralph's reader takes the `2h` — one of the few places the two still disagree, and one
more reason to keep the blank out. See
[Troubleshooting](#troubleshooting) for the symptom, and for what changes on a file
already written this way when you upgrade.

| Variable              | Default                              | Purpose                                                                 |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `RALPH_AGENT`         | `claude`                             | Coding agent Ralph drives: `claude` (default, Claude Code) or `codex` (OpenAI Codex CLI, **experimental**). Unset or unrecognized falls back to `claude` (with a warning). Set by `ralph init --agent <name>` / the interactive picker. The `agent` row of the identity box [`ralph start`](#quick-start) opens with names the **resolved** agent, so a mistyped value shows you the agent that will actually run rather than what you typed — that box reports the run, and the typo itself is named **on stderr**, beside it rather than inside it: `ralph start` writes one line above the splash and starts the loop anyway (never a byte on stdout, so `ralph start \| tee` is unaffected), the loop writes the same line again inside its tmux window, and `ralph init` and [`ralph doctor`](#quick-start) write it too. A recognized value — or none at all — prints nothing on either stream. This file is read **first** and the environment only where this file does not assign the name at all: the loop *sources* it with `set -a`, so a value here beats one exported in your shell, and a blank `RALPH_AGENT=""` is a value rather than silence — it means `claude`, not "whatever was inherited". |
| `RALPH_BANNER`        | `full`                               | How much of the startup banner [`ralph start`](#quick-start) draws — and, because the identity box also heads [`ralph doctor`](#quick-start)'s report and [`ralph status`](#quick-start)'s human view, whether either of those commands prints its box at all. `full` (the default `ralph init` writes) plays the one-second sprite splash, settles it on its final frame, and prints the identity box under it. `static` draws the same picture with none of the animation — the settled frame, once, in a single write, with no cursor hidden, no `Ctrl-C` handler armed, and byte-for-byte the frame the splash would have ended on (it still holds that frame's own 200ms beat, the same pause the splash's last frame takes before the box lands under it). `off` prints nothing at all, not even the box, so the output starts at the first preflight line exactly as it did before any of this existed — and nothing is read for a box nobody is going to see: not the update-check cache behind the `update` row, not the shipped `CHANGELOG.md` behind the what's-new rows, and not the `.git/config` behind the `repo` row. Case-insensitive, surrounding whitespace ignored; unset or empty means `full`, and an unrecognized value means `full` **and warns on stderr — in `ralph start` only** — a typo here costs you one line of output and never the run, and never a byte of stdout, so `ralph start \| tee` is unaffected. `ralph doctor` and `ralph status` take the identical fallback **silently**: the default box, and not a word about the typo on either stream — `doctor` because a typo in a purely cosmetic knob does not earn a line in a diagnostic, `status` because it has no stderr channel at all, which is what keeps its `--json` output pipeable — so `ralph start`, the command the setting is actually about, is where a mistyped value is reported. **An environment variable of the same name wins over this line**, which is deliberately the opposite way round to `TASK_SOURCE` below (that one reads the committed file first): a task source is a property of the repository, a banner is a property of one invocation, so `RALPH_BANNER=off ralph start` silences a single run inside a wrapper script, a cron entry or a CI job without editing — and committing — a file every other run in the repo shares. See the [environment-variable row](#environment-variables). The terminal caps this **downward only**: a pipe, a launchd log, a `NO_COLOR` run or a window under 26 columns draws no sprite whatever this says, and no value here can put one back. The cap stops at the sprite — those runs still print the identity box, in plain text, because it is facts rather than decoration — so only an explicit `off` takes the box away. `ralph doctor` and `ralph status` read the box half of this setting and nothing else: neither draws a sprite or an animation at any value, `full` and `static` are the same picture in both, and `off` means no box and not one blank line where it would have been — so `RALPH_BANNER=off ralph status` prints the report starting at its `▸ ralph` line, byte for byte as it did before the box existed. `ralph status` adds the only two exceptions in either direction: its `never-run` mode prints no box at any value, because the box identifies a run and that mode has none, and `ralph status --json` prints its one document at every value, since this setting reaches the human view alone. |
| `RALPH_CODEX_MODEL`   | unset (ships commented-out)          | Model id for the Codex agent (ignored when `RALPH_AGENT=claude`). Unset/empty lets Codex use its configured default and leaves the telemetry `model` field `null`. Example: `RALPH_CODEX_MODEL="gpt-5-codex"`. It is also the model the identity box [`ralph start`](#quick-start) opens with names on a Codex project — ``agent   codex — gpt-5-codex (configured)`` — and the tag is literal: for Codex this value *is* the answer, so the metrics log is never consulted for that row (Codex's stream carries no model id, so the log would hold nothing but a staler copy of this same value). Unset, the row reads ``codex — model resolves at first run`` and names no model at all — and so does a line in this file that assigns the knob **blank**, which masks an exported one rather than falling through to it, because the loop *sources* this file with `set -a` and would be handed the blank too. On that path the box also draws **no `context` row**, since a run passing no model has no window to report. |
| `RALPH_DIGEST_INTERVAL` | `""` (off)                         | How often the digest narrates while the loop works. Empty (the default `ralph init` writes) or any spelling of zero (`0`, `0m`) means no digest at all — nothing here costs a model call until you ask for one. Set an interval and `ralph start` opens a second tmux window named `digest` running `ralph digest --loop` on it, next to the loop's window; `ralph stop` takes both down (see [`ralph digest`](#quick-start)). Same duration grammar as [`ralph schedule install --interval`](#scheduling-ralph-macos-launchd): a whole number with an optional single-letter unit — `60` (bare = seconds), `30m`, `2h`, `1d`. A fraction (`0.5h`) is rejected, as is anything longer than a JS timer can wait (`24d` is the ceiling). A rejected value costs the digest and never the launch: a warning on stderr, `NOT running` on the box's digest line, loop unaffected. Read by two commands, on one shared rule: `ralph start` opens the window with it, and [`ralph status`](#the-digest-section) measures a narration's staleness against it — twice this interval late reads `stale`, falling back to a 30-minute interval (so an hour late) when the value is empty, zero or refused. A scheduled `ralph cycle` neither reads it nor opens a window. **The one knob in this file most likely to be hand-written with a blank after the `=`**, and the one that costs the most for it: `RALPH_DIGEST_INTERVAL=  2h  ` is not an assignment to bash at all (see the spelling rules above this table), so it opens no window and warns about nothing either — there is no interval for Ralph to complain about. Write `RALPH_DIGEST_INTERVAL=2h` or quote it. |
| `RALPH_DIGEST_MODEL`  | unset (ships commented-out)          | Model the digest asks for its narration — unset means the cheap per-agent default (`haiku` under `RALPH_AGENT=claude`, `gpt-5-mini` under `codex`). It is primarily an [environment variable](#environment-variables), and that row is the full behavior; the reason it appears in this file too is the digest **window**: `ralph start` text-parses this assignment out of `ralph.config.sh` and forwards it (with `RALPH_AGENT`) into the window it opens, so a repo can fix its digest's model without exporting anything. A `ralph digest` you run yourself reads the process environment only, so export it or prefix it on the command line. |
| `TASK_SOURCE`         | `github`                             | Where Ralph draws work from: `github` (default, resolves open GitHub issues via `gh` and opens PRs), `folder` (local `.ralph/tasks/` tree, commits straight to `DEV_BRANCH`, no PR, no `gh`) or `jira`, which today **works a ticket and records on the board what became of it**: the queue depth, the ticket and the claim all come from your Jira project by running [`JIRA_JQL`](#the-eligibility-query--jira_jql) through Atlassian's `acli` — each iteration selects the oldest eligible ticket, records it, labels it `in-progress`, and hands the key to the agent, which reads the work item itself and commits straight to `DEV_BRANCH` with no branch, no PR and no push, then labels the ticket `done`, takes `in-progress` back off, comments the commit SHA, and transitions the ticket to [`JIRA_DONE_STATUS`](#recording-a-ticket-as-done--jira_done_status) where that knob names a status the project's workflow accepts. A ticket the agent did **not** finish is swept by the loop rather than by the agent — after the dispatch returns it reads the ticket's labels back off the board and gives anything that is not `done` the `failed` label with `in-progress` removed, warning on stderr — so a killed, crashed or idle invocation can never leave the loop spinning on the same ticket. The iteration **is** recorded: the loop appends one per-ticket event to `.ralph/metrics/issues.jsonl` carrying the ticket key as `task_key` beside the numeric `issue_number` derived from it, so `ralph status`'s completed count and `ralph cycle`'s `N ok, N failed` account for a Jira run like any other — best-effort, so a telemetry failure costs the run its record and never its outcome. The loop runs no `gh` command, telemetry included. `ralph cycle` asks for the credential this source actually spends: under `jira` its preflight aborts unless `acli jira auth status` exits `0`, and it no longer gates on `gh auth` at all. `ralph start` has not moved with the loop: it still demands an authenticated `gh` and still counts GitHub issues to decide whether to launch, so its number can differ from `ralph status`'s and it can refuse to start over an empty GitHub queue. [`ralph doctor`](#the-jira-source-today) also asks for `acli` instead of `gh` here and reports whether that CLI is logged in (reported, never enforced — it cannot fail the diagnostic, though `ralph cycle`'s preflight runs the same probe and does refuse to start). Values are case-insensitive and trimmed; unset, empty or unrecognized falls back to `github`. **That holds for the commands, not for the loop:** `ralph start`, `status`, `cycle` and `doctor` lowercase and trim this value, while the loop's own dispatch compares it exactly — so `TASK_SOURCE=JIRA` has the commands reading Jira while the loop works GitHub. A known divergence, older than the `jira` source (`FOLDER` behaves the same way), pinned in the test suite and left for its own fix; write the value in lower case. Set by `ralph init --source <name>` or by init's interactive picker, which offers all three names and takes `github` on a blank or unrecognized answer; choosing `jira` there also asks for [`JIRA_JQL`](#the-eligibility-query--jira_jql) and [`JIRA_DONE_STATUS`](#recording-a-ticket-as-done--jira_done_status). This file is read **first** and the environment second — the loop *sources* it with `set -a`, so a committed value beats an exported one, and all four commands that read the knob agree about that. **They part on an empty assignment.** For `ralph start` a `TASK_SOURCE=""` line is a value like any other and means `github`, which is what the loop's own `${TASK_SOURCE:-github}` makes of the blank it sourced — so the `source` row, the `gh auth status` check and the queue that gets counted all follow the file. `ralph status`, `ralph cycle` and `ralph doctor` still read **past** an empty line into the environment, so a shell that exports `folder` or `jira` has those three reporting it — and `doctor` checking that source's deps — over a run that will do `github`. A named follow-up rather than a design; write the value or leave the line out. See [Choosing the task source](#choosing-the-task-source). |
| `JIRA_JQL`            | `""` (not configured; a `jira` init writes a working query) | The Jira **eligibility** query, read only under `TASK_SOURCE="jira"` and ignored otherwise: which work items are candidates for Ralph, and nothing about labels or ordering. One query answers both questions the source asks — how deep the queue is, and which ticket is next — so a count and a selection can never disagree about what is eligible. **Ralph appends its own half and you cannot turn that off** — your clause is wrapped in parentheses (so an `OR` in it keeps its meaning against the `AND` that follows), then `AND (labels NOT IN (in-progress, done, failed, do-not-ralph) OR labels IS EMPTY)`, then the ordering. Three of those four labels are Ralph's own writes — `in-progress` when it claims a ticket, `done` when the agent records one as complete, `failed` when the loop sweeps one the agent did not finish — so claiming is what makes the next pass skip work in flight, completing is what makes the queue drain rather than hand a resolved ticket out again, and the sweep is what makes it drain even when the agent recorded nothing at all. `do-not-ralph` is the one label here Ralph never writes: that one is yours, for a ticket you want the loop to leave alone. A trailing `ORDER BY` of yours is **relocated, not refused** — Jira requires it last, so it is cut off, the exclusion is inserted, and your ordering goes back verbatim at the end; write none and you get `ORDER BY created ASC`, the analog of `github` mode's `sort:created-asc`. Empty means **not configured**, deliberately not "everything": Ralph's half alone would select every work item on the Jira site, so a blank value counts nothing, spawns no `acli jira workitem` call at all, selects nothing (a loop started with it prints `Queue empty, exiting.` on its first pass), and leaves `ralph status` reporting `queue      unknown` while `ralph cycle` exits saying the queue is empty. `ralph cycle` does still spawn **one** `acli` under this source whatever this line holds — its preflight's `acli jira auth status`, which runs before the query is looked at — so a blank query on a logged-out session reports the session rather than an empty queue. Config-**only**, with no environment fallback beside it, unlike `TASK_SOURCE`: an eligibility query is a property of the repository, and the assignment is always present in the file (`init` writes it on every path, empty for `github`/`folder`), so `set -a` exports whatever it holds — a blank included — into every child the loop spawns. A value containing a `#` needs **single** quotes — `JIRA_JQL='summary ~ "#123"'` — because the file is text-parsed rather than sourced and a `#` after a closing double quote is taken for a comment; the truncated query is then rejected by Jira, which costs you the count. `ralph init` chooses the quote character on the line it writes for you — single where the value needs them, double where it does not — so this is a rule for **hand edits**. `ralph doctor` never reads this line. See [The eligibility query](#the-eligibility-query--jira_jql). |
| `JIRA_DONE_STATUS`    | `""` (do not transition)             | The status Ralph asks Jira to move a ticket to once the work is committed, read only under `TASK_SOURCE="jira"` and ignored otherwise — the third of the three writes a completion makes, beside the `done` label and the comment carrying the commit SHA. **The template ships no default, because no name is right everywhere** (a `jira` init asks for one, offering `Done`, which is a visible answer rather than a shipped default)**:** status names come from your project's own workflow (`Done` on one board, `Resolved`, `Closed`, `Complete` or `Ready for Release` on the next), so write yours exactly as that workflow spells it, capitalisation included — `JIRA_DONE_STATUS="Done"`. **Empty or unset means "do not transition"**, and is not an error: Ralph skips the move, warns once on stderr, and still labels and comments. **A refused transition costs you a board move and never the run** — a workflow can decline the move for reasons Ralph can neither see nor satisfy (no transition to that status from where the ticket sits, a required field, a validator), and when it does Ralph warns on stderr naming the ticket and the status, then finishes the job anyway: it still labels the ticket `done`, still comments the SHA, and still counts the ticket as resolved. What you are left with is one ticket to move by hand, and the warning says which. **The label is what actually drains the queue**, which is why the transition is allowed to fail: Jira labels are freeform and no workflow rule can veto one, and `done` is in the exclusion Ralph appends to [`JIRA_JQL`](#the-eligibility-query--jira_jql), so a completed ticket stops being eligible whatever the board's status column says. A `done` label that could **not** be written is the one failure that fails a completion — it is the only outcome that leaves a resolved ticket in the queue — and Ralph says so, both on stderr and in the exit code. **No `ralph` command reads this line**: not `doctor`, not `status`, not `cycle`. Its only transport is the loop *sourcing* `ralph.config.sh` with `set -a`, which exports the assignment into the agent's environment, where `lib/jira-queue.js complete` reads it. See [Recording a ticket as done](#recording-a-ticket-as-done--jira_done_status). |
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
| `RALPH_CONTEXT_WINDOW` | unset (auto-resolved)               | Optional numeric override (tokens) for the context window used by the [`context_end_pct`](#per-issue-stream--ralphmetricsissuesjsonl) metric. Unset = auto-resolve from the run's model id (Anthropic: `opus`/`sonnet`/`fable` = 1,000,000, `haiku` = 200,000; OpenAI/Codex: `gpt-5`/`gpt-4.1`/`gpt-4`/`o3`/`o4`/`codex` = 400,000, legacy `gpt-4o` = 128,000). An unknown model resolves to no window (`null` pct). A non-numeric or `<= 0` value is ignored. The same window is what the `context` row of the identity box [`ralph start`](#quick-start) opens with prints, spelled **exactly** — `1M tokens`, `200k tokens`, `1500 tokens`, abbreviated only when the number is exactly divisible — so a value you set here is one you can match against the box rather than against a rounding. Which run that row describes follows the `agent` row above it: on a Codex project the box resolves the window from the configured model and this value together, so a change takes effect on the very next `ralph start`, while for Claude it reads the window out of the **last run's** telemetry event, which already folded in whatever override that run had — so a change here reaches the box one run later. A window neither the map nor this override supplies draws no row at all. |

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

Not every setting lives in `ralph.config.sh`. The variables below are
read from the **process environment** — with three exceptions, each noted in
its own row: `ralph start` does text-parse `RALPH_DIGEST_MODEL` out of
`ralph.config.sh`, but only to forward it into the digest window it opens,
`RALPH_BANNER` is a genuine two-source setting whose committed value
this variable overrides for one run (its
[configuration-reference row](#configuration-reference) is the full story),
and `GH_REPO` is a two-source setting the other way round — a `GH_REPO`
line in that file **beats** this variable for the one row Ralph reads it
for, because the loop sources the file and a committed value therefore
decides for every `gh` call the row is about.
Otherwise, putting these in `ralph.config.sh` has no effect: the Node CLI
never sources that file (it
text-parses individual assignments out of it), and these variables are
not resolved through `.env.local` or the global `~/.config/ralph/.env`
either — those feed a fixed set of notification credentials (see
[Global config file](#global-config-file-share-creds-across-repos)).
Export them in your shell, your shell profile, or prefix them on the
command line.

| Variable                | Default               | Purpose                                                                                                                                                                                   |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RALPH_NO_UPDATE_CHECK` | unset (check enabled) | Opts out of the weekly update check in `ralph start` and in `ralph cycle`. When set, the check short-circuits before any registry query, any read or write of `~/.config/ralph/update-check.json`, and any notice — and, with it, both the interactive update prompt and the `update` row of the identity box [`ralph start`](#quick-start) opens with, which is served from that same cache and therefore does not read it either. Because that path reads no cache at all, *neither* of the file's two weekly windows (`last_check_at`, `last_prompted_at`) is consulted or stamped, so opting back in gets you the question straight away rather than a week of silence. It does not gate the `cached` row of the identity box [`ralph doctor`](#quick-start) heads its report with, which only ever *reads* that file and never checks: an opted-out machine simply has nothing cached, so the row reads `unknown (no update check cached yet)`. That `start`'s `update` row reads that very same file and *is* gated is the deliberate half of the distinction: `doctor`'s row is a diagnostic a user asked for, while `start`'s is the same nagging this variable exists to switch off, printed above every single run. The switch that does silence `doctor`'s row is [`RALPH_BANNER=off`](#configuration-reference), which takes the whole box with it. |
| `NO_COLOR`              | unset (sprite shown on a TTY) | Suppresses the pixel sprite [`ralph start`](#quick-start) prints above its first preflight line — the one-second splash with it, so a run under this variable spends no time and writes no cursor movement on an animation nobody would have seen. Honored on **presence**, not truthiness — as [the convention](https://no-color.org) specifies ("when present, regardless of its value"), so `NO_COLOR=`, `NO_COLOR=0` and `NO_COLOR=false` **all** silence it. To get the sprite back, unset the variable rather than assigning it something that reads as off. It is only ever the *second* gate: a non-TTY stdout suppresses the sprite whatever this says, and nothing here can force the sprite onto a pipe. This is **not** a global colour switch for Ralph — the rest of Ralph's coloured output goes through [picocolors](https://github.com/alexeyraspopov/picocolors), which tests the value's truthiness instead, so `NO_COLOR=1` turns everything plain while the value-less `NO_COLOR=` silences the sprite and leaves the ✅ / ⚠️ lines green. The divergence is deliberate and in the safe direction: strip the escapes from a coloured sentence and it is still a sentence, strip them from the sprite and it is 442 blank cells. It does **not** suppress the identity box under the sprite — that is facts rather than decoration and prints on every run bar one an explicit [`RALPH_BANNER=off`](#configuration-reference) silenced — but it does take the colour out of it: the box's `update` row is yellow on a colour terminal and plain text here, escape-free like the rest of it. The box [`ralph doctor`](#quick-start) heads its report with is coloured by picocolors' rule rather than this presence one, exactly like the ✓ / ✗ marks under it — so `NO_COLOR=1 ralph doctor` is plain from top to bottom, a piped `ralph doctor` emits not one escape byte *unless* `FORCE_COLOR` or `CI` is set (picocolors keeps colour on a non-TTY for both — its rule, not this one, and it paints the ✓ / ✗ marks and the `cached` row alike), and `NO_COLOR= ralph doctor` on a terminal keeps the colour on both the marks and the box's `cached` row. |
| `RALPH_BANNER`          | unset (the `ralph.config.sh` line, then `full`) | Overrides the [`RALPH_BANNER`](#configuration-reference) line in `ralph.config.sh` for a single run of `ralph start`, of [`ralph doctor`](#quick-start) **or** of [`ralph status`](#quick-start) — the latter two head their reports with the same identity box: `full`, `static` or `off`, with that row carrying the values in full. The environment **wins** here, which is deliberately the opposite way round to `TASK_SOURCE` — a task source is a property of the repository, a banner is a property of one invocation — so a wrapper script, a cron entry or a CI job can silence the banner without editing, and committing, a file every other run in the repo shares. An unset or blank value is **not** a choice: it defers to the file, so `RALPH_BANNER= ralph start` gets whatever the repo asked for rather than an accidental mode. It cannot turn the sprite **on**, the same way `NO_COLOR`'s absence cannot: a non-TTY stdout, a `NO_COLOR` run or a terminal under 26 columns draws no sprite whatever this says, and it costs those runs nothing — no frames, no sleep, not one escape sequence. Those runs still print the identity box, in plain text; only an explicit `off` removes it, because that is a user asking for nothing rather than a terminal unable to show something. An unrecognized value falls back to `full` and warns on **stderr**, never on stdout and never fatally — in `ralph start`. `ralph doctor` and `ralph status` fall back the same way and **say nothing at all**: the three commands share the knob and its precedence, not the warning, so a typo you never see reported here is one `ralph start` will name for you (`status` could not report it if it wanted to — it writes to stderr in no mode, which is what keeps `ralph status --json` pipeable). `full` and `static` are indistinguishable in both, neither of which draws a sprite at any value. In `ralph status` this reaches the human view alone: `--json` prints its one document whatever the value, and the `never-run` mode prints no box at any value, having no run to identify. |
| `RALPH_DIGEST_MODEL`    | unset (cheap default) | Model id [`ralph digest`](#quick-start) asks for the narration. Unset, empty, or whitespace-only uses the cheap per-agent default the agent registry declares — `haiku` under `RALPH_AGENT=claude`, `gpt-5-mini` under `codex`. It steers **only** the digest: the loop's own model is untouched, and `RALPH_CODEX_MODEL` is deliberately *not* consulted here, because the loop's model is chosen for depth while a digest that may run every few minutes all night is chosen for price. A wrong or unavailable id costs you the digest and never the run — the agent fails, no history entry is written, one line goes to stderr, and `ralph digest` still exits `0`. Whichever model answers is **recorded in the history entry's heading** and read back by [`ralph status`](#the-digest-section), so a paragraph in the live view can be weighed against who wrote it; entries written by Ralph 0.21.0, before the model was a field, report it as absent. **One path also reads it from `ralph.config.sh`:** the digest window `ralph start` opens when [`RALPH_DIGEST_INTERVAL`](#configuration-reference) is set. `start` parses the assignment out of that file and forwards it (with `RALPH_AGENT`) into the window, so an unattended digest can be given a model without exporting anything — a repo's committed choice, rather than a property of whichever shell launched it. Everywhere else, including a `ralph digest` you type yourself, the file is not consulted and the environment is the only source. |
| `GH_REPO`               | unset (the `ralph.config.sh` line, then `origin`) | Not Ralph's variable but [`gh`'s](https://cli.github.com/manual/gh_help_environment), and it is listed here because Ralph reads it for one row: the `repo` row of the identity box [`ralph start`](#quick-start) opens with, which names the repository the loop will read issues from. Set, it **decides over `origin`** — because it decides for every `gh` command the loop runs, so a box that named `origin`'s slug while the loop read someone else's would be wrong in exactly the situation that row was added for. It does **not** decide over the file: a `GH_REPO` assignment in `ralph.config.sh` wins over this variable, which is deliberately the opposite way round to [`RALPH_BANNER`](#configuration-reference) and the same way round as the loop, since the loop *sources* that file with `set -a` — a committed value is what those very `gh` calls will read, so the row follows it. It wins **even when it is blank**, which is the surprising half: `GH_REPO=` in that file masks whatever your shell exported in the shell that sources it, `gh` reads the empty value as unset and resolves its base repository from `origin`, and so does this row. The environment answers only where the file assigns the knob **nothing at all** — no line, a commented-out one, or one bash does not read as an assignment either: a space in front of the `=`, or a blank after it with a word behind it (see the [spelling rules](#configuration-reference)). Those are exactly the lines bash itself falls through on, which is the point of reading it this way round. `gh`'s own spelling is accepted (`[HOST/]OWNER/REPO`, with the host dropped), a blank value counts as unset whichever source it came from, and a value that is not a slug at all draws **no row** rather than falling back to `origin`: naming a repository the loop will not use is worse than naming none. With neither source naming one, the slug comes from `origin`'s url in the `.git/config` of the directory you ran the command in — read locally, never with `gh repo view`, because that row prints before the first preflight line and no decoration may put a network round trip in front of the first paint. This row is drawn for every task source **except `folder`**: a `TASK_SOURCE=folder` run draws none, whatever this is set to, while a `TASK_SOURCE=jira` run draws one, since `ralph start` itself still reads GitHub issues under that source even though the loop it launches no longer does. |

**`RALPH_NO_UPDATE_CHECK`'s value parse is permissive, which is a footgun
on a negatively-named flag.** Only `0` and `false` keep the check **on**
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

**Scheduled cycles read it from the plist, not your shell.** A launchd
agent sources no `.zshrc` or `.zprofile`, so the only environment
`ralph cycle` sees under
[scheduling](#scheduling-ralph-macos-launchd) is the
`EnvironmentVariables` dict in its plist. `ralph schedule install`
therefore copies `RALPH_NO_UPDATE_CHECK` into both plists when it is set
in the installing shell — a snapshot taken at install time, exactly like
`PATH`. Setting or unsetting it afterwards changes nothing for the
already-installed agents; re-run `ralph schedule install --force` to
re-take the snapshot.

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
stop it (`ralph stop`) before starting again — `ralph status` names the run and
the issue it is on, and `ralph start` prints the exact attach / kill commands
for your session.

**The startup box says `Digest: … NOT running`.** — `ralph start` took
`RALPH_DIGEST_INTERVAL` as set (non-empty, non-zero) and then could not open the
digest window, and it explained why on stderr, above the box:
`⚠️  Digest window not opened — …. The loop is running.` The loop is genuinely
unaffected — that window is opened *after* the launch precisely so it can never
fail one. Two things cause nearly all of it: the interval is not a duration Ralph
accepts (`0.5h`, `90 minutes`) or is longer than a timer can wait (`30d`; `24d` is
the ceiling), in which case fix the value in `ralph.config.sh` and the next
`ralph start` opens the window; or tmux refused the `new-window`, whose own stderr
is quoted in the warning. To get narration for the run *already* going, leave it
alone and run `ralph digest` — or `ralph digest --loop --interval 30m` in another
terminal, which appends to `.ralph/digest.log` exactly as the window would. Either
way `ralph status` picks the entry up and prints it: the section is about what is on
disk for the run in flight, not about whether a window was ever opened, so a repo
with no interval configured still shows a digest you asked for by hand (see
[The digest section](#the-digest-section)) — measured for staleness against the
30-minute fallback, since there is no configured interval to measure it against.

**You detached and cannot tell whether Ralph is still working.** — Run
`ralph status`. It reads the run-state record the loop writes
(`.ralph/run-state.json`), reconciles it against whether that run is still
alive, and names the run, how far through the queue it is — tasks done over a live
denominator, and the issue in flight and for how long — a table of the tasks it has
worked through, the live queue depth, the pace, ETA, and spend the run is holding,
and — if anything has narrated
the run — the latest [`ralph digest`](#the-digest-section) entry for it, from any
subdirectory of the repo and without attaching to anything. **`interrupted`** there
means a run started and never wrote a terminal
record: a `tmux kill-session`, a `kill -9`, or a reboot took it out mid-issue,
and the issue on the `in flight` line is where it stopped. There is nothing left
to attach to, so start again — the next `ralph start` offers to clear the
`in-progress` label that run left behind (see below). One case reads
misleadingly stale rather than wrong: a run that never reached the loop at all
(an empty queue, or a preflight abort) writes no record, so `status` keeps
reporting the run before it. See
[Run state](#run-state--ralphrun-statejson-and-ralph-status) for the record and
all four modes.

**`ralph doctor` reports a missing required dep.** — Install it with
the command shown in the output (e.g. `brew install gh` on macOS,
`apt install gh` on Linux/WSL). Ralph never auto-installs deps. `doctor`
checks only the **selected** agent's CLI: on a Codex project it wants
`codex` (`npm install -g @openai/codex`) and will not ask for `claude`;
on a Claude project the reverse holds. The same is true of the selected
[task source](#choosing-the-task-source)'s CLI: `gh` under `github`,
Atlassian's `acli` under `jira`, and neither of the two under `folder`. Under
`jira` that list is short by one and knowingly so: the loop itself runs no `gh` at all,
and `ralph cycle` no longer *gates* on one — though it does still spend `gh` on the
repo-slug lookup its notification names (falling back to the repo path) and on the orphan
sweep's `gh issue list` plus a `gh issue edit --remove-label` per orphan found. Under a
logged-out `gh` only the `gh issue list` call runs, and it logs
`orphan-cleanup: gh list exited 1: …` each tick instead of stopping the run.
Meanwhile `ralph start` still refuses to launch at all without an authenticated `gh`. See
[What is still GitHub's](#what-is-still-githubs).

**`ralph doctor` prints `! jira auth (not authenticated)` or `! jira auth
(not verified)`.** — Neither is failing the diagnostic: that row is yellow in
both states and cannot move `doctor`'s exit code. Run the command the row
names — `acli jira auth login` for the first, `acli jira auth status` for the
second, which means the check could not be run at all rather than that a login
was refused. A **missing** `acli` is not that second state: it reads `not
authenticated`, beside the `✗ acli` dep row that names the real problem. Worth
fixing rather than filing away, because a logged-out `acli` is what stops a Jira run
outright: `ralph status` reports `queue      unknown` (the count cannot be taken), and
`ralph cycle` refuses to start at all — its preflight runs this very probe under `jira`
and aborts with `jira not authenticated — run: acli jira auth login` rather than
spending an agent invocation on a queue it cannot read.
What the row is still *not* about is **the board's workflow**: a resolved ticket does
get labelled `done` and commented, but the status **transition** needs
[`JIRA_DONE_STATUS`](#recording-a-ticket-as-done--jira_done_status) set to a status your
project's workflow will actually accept — a `jira` init writes `Done` unless you gave it
another, and `Done` is a status plenty of workflows do not have. So a green
`jira auth` does not mean a finished ticket will ever *move* in Jira — the completion
warns on stderr when it could not move one, and finishes the ticket anyway. See
[The `jira` source today](#the-jira-source-today).

**`ralph status` says `queue      unknown` but `ralph cycle` says the queue is
empty.** — Under `TASK_SOURCE="jira"` that is one finding reported twice, not two
defects: the same `acli` count failed for both, and the two commands are **meant**
to read that failure differently — a read-only view says when it does not know,
while a scheduler with no provable work has nothing to do and lets the next tick
try again ([the table here](#what-a-broken-acli-costs-you) has the reasoning). So
chase the cause, not the disagreement: `ralph doctor` for the `acli` and
`jira auth` rows, then `JIRA_JQL` in `ralph.config.sh` — a blank one is
*unconfigured* rather than "everything", and one containing a `#` needs single
quotes to survive the config reader. Running the composed query in Jira's own
search is the quickest way to tell a query Jira rejects from a genuinely empty
queue.

**A `jira` run's digest reads as vague, and never quotes the agent.** — Expected, and
not a model problem: under `TASK_SOURCE="jira"` the digest is looking for the wrong
file. It derives the transcript it tails from the run record's `number`, which for
`FOO-123` is the derived `123`, while the iteration wrote `logs/ralph-issue-FOO-123.log`
— named from the key. The missing file is swallowed, so `ralph digest` still exits `0`
and still narrates: you get prose about the git state and the run record with no
transcript behind it, and nothing says a transcript was expected. Read the log yourself
in the meantime — `logs/ralph-issue-<KEY>.log`, one per ticket — and see [`ralph status`
and the run state](#run-state--ralphrun-statejson-and-ralph-status) for why the number
is derived at all. Keying that path on the key is a follow-up.

**`ralph cycle`/`start` aborts with `codex not authenticated`.** — When
`RALPH_AGENT=codex`, the preflight runs `codex login status` and keys on
its **exit code** only. A non-zero exit (or a missing `codex` CLI) blocks
the run. Log in with `codex login` (or provision the CLI's managed
credentials) and retry. Managed-credential builds that print
`Login is not required.` and exit zero count as authenticated. The Claude
path is unchanged: it still checks for the Claude credentials file and
reports `claude credentials missing` when absent.

**The loop's window opens with a node deprecation notice or an
`ExperimentalWarning`.** — Expected, and nothing is broken. The loop resolves which
agent to invoke by running a small node bridge and capturing its **stderr** to a
temp file, because that bridge's *stdout* is a shell program the loop evaluates and
a warning line folded into it would break the launch. That capture used to be
deleted unread on a successful resolve, which also ate the one line it most needed
to show: a mistyped `RALPH_AGENT` fell back to `claude` and said so nowhere, so an
overnight run went to the wrong agent in silence. The capture is now forwarded to
the loop's own stderr **whole and unread** — the loop holds no agent-specific
knowledge and does not grep it — so node's own notices and any nvm/shim banner reach
the window alongside the warning that matters. Stdout is untouched, and a bridge
with nothing to say still adds nothing.

**Issues stuck with the `in-progress` label after a crash.** — The
next `ralph start` detects orphans and asks whether to clear them and
reprocess. Answer `y` to re-queue the issues.

**`ralph start` warns that a retired label still exists on this board.** —
Ralph renamed the two labels it stamps on an issue: `claude-working` became
`in-progress`, and `claude-failed` became `failed`. Those words describe what
the *loop* is doing rather than who is driving it, and Ralph has driven Codex
as well as Claude for a while now, so the old prefix named the wrong thing on
half its runs. The rename is a **clean break**: Ralph has never run
`gh label edit` on your board and this warning does not change that, so a
repository set up by an older Ralph keeps the retired labels — and every issue
carrying one — until you rename them yourself. Paste both lines (or just the
one the warning named):

```bash
gh label edit claude-working --name in-progress --description 'Ralph loop in progress'
gh label edit claude-failed --name failed --description 'Ralph loop tried and gave up'
```

That is the whole migration, and there is no per-issue relabelling to do
afterwards. GitHub identifies a label by an **ID** of its own rather than by
its text, so `--name` renames the label *itself* and the new name carries over
to every issue already holding it, however many there are — which is what makes
one command per label enough on a board with a hundred labelled issues.
`--description` rides along because the two kinds of staleness arrived
together: a board first set up by Ralph's original shell script has these
labels with **Portuguese** descriptions, and `gh label create` fails outright
on a label that already exists rather than updating one, so every Ralph since
has left those descriptions exactly as it found them. One paste replaces both
the name and the description.

Skipping the rename is not a tidiness problem. Issues still carrying a retired
name fall into a gap where nothing can see them: the queue filter excludes the
**current** names, so those issues are no longer excluded from the queue and
Ralph hands one out again as fresh work it has already done — at one paid agent
invocation per pass — while the orphan sweep lists the current name too, so it
cannot report them either. Visible to the query that costs money, invisible to
the query that would have warned you. The warning itself never stops a run:
`ralph start` prints it, hands over the command, and launches the loop.

**A line in `ralph.config.sh` does nothing at all.** — Look for a space in front
of the `=`. `RALPH_DIGEST_INTERVAL = 30m` reads like a setting and is not one: a
shell assignment ends the name at the `=`, so bash — which is what actually reads
that file, sourced with `set -a` — takes the line as a *command* named
`RALPH_DIGEST_INTERVAL` (`command not found` in the loop's window) and leaves the
variable holding whatever it already held. The `ralph` commands read it the same
way round, so a spaced line is a line no part of Ralph honors: a spaced
`RALPH_DIGEST_INTERVAL` opens no digest window and warns about none either (there
is no interval to complain about, which is what makes this quieter than the
`Digest: … NOT running` case near the top of this section), a spaced
`TASK_SOURCE` falls back to `github`, and a spaced `RALPH_AGENT`, `GH_REPO` or
`RALPH_BANNER` defers to your environment or to its default. Delete the spaces —
`RALPH_DIGEST_INTERVAL=30m` — and the next run picks the value up. An
**indent** is fine and always was, as long as it is a space or a tab; a no-break
space or a byte-order mark in front of the name, which is how a snippet pasted out
of a rendered web page arrives, is a word character to the shell and makes the
line a command just as surely.

**Then look on the other side of the `=`.** A blank there with a word behind it is
the same mistake wearing a different name: `RALPH_DIGEST_INTERVAL=  2h  ` is bash's
*environment-prefix* syntax, a binding scoped to the command word that follows it, so
bash runs `2h` (`2h: command not found` in the loop's window), the binding dies with
that command, and the variable again keeps whatever it already held.
`TASK_SOURCE= folder` is the same line, and so is `RALPH_AGENT=# off` — the `#` opens
no comment there, because a comment only opens at a `#` that *begins* a word. Ralph's
own readers refuse all of these too, so a knob written this way is a knob nothing
reads, and each one lands exactly where the spaced line above leaves it:
`RALPH_AGENT`, `TASK_SOURCE`, `GH_REPO` and `RALPH_BANNER` defer to your environment,
and to their defaults where the environment says nothing either, while
`RALPH_DIGEST_INTERVAL` — which has no environment fallback at all — reads as unset, so
there is no digest window and no warning about one. Delete the blank (`RALPH_DIGEST_INTERVAL=2h`) or move it
inside quotes (`RALPH_DIGEST_INTERVAL="  2h  "` is a real assignment, and Ralph trims
it back to `2h`). A blank with **nothing** behind it is a genuine assignment to empty
and always was, so `RALPH_DIGEST_INTERVAL= ` still means *off* rather than *unread*.

**Worth checking after an upgrade, not only on a new file.** Up to and including
0.23.0 the `ralph` commands honored a spaced line the loop had always ignored, so
a repo could hold a setting that was live in the box and dead in the run:
`TASK_SOURCE = folder` had `ralph start` announcing `folder` over a loop working
GitHub issues, and `RALPH_DIGEST_INTERVAL = 30m` had `ralph start` opening a
digest window for an interval the loop itself had never been given. Newer Ralphs
answer the way the shell does, which is the fix — and the visible cost of it, on
those files only: the box stops naming a source the loop is not about to work, and
the digest window that line used to open stops opening. Nothing on disk changes
when you upgrade, and nothing warns you; if a repo's digest went quiet or its
banner started naming a different source, that spelling is the first thing to
check.

The same upgrade closed the gap on the **other** side of the `=`, where the one
visible cost runs the other way round: `RALPH_DIGEST_INTERVAL=  2h  ` used to open a
digest window and now opens **none**, silently, because bash never assigned anything
on that line and Ralph's readers no longer pretend otherwise. Nothing the template
ships is written that way — `ralph init` writes `RALPH_DIGEST_INTERVAL=""` — so this
reaches only a file somebody typed an interval into by hand, which is exactly how
that knob is meant to be set. Same symptom, same check: if the digest stopped
narrating after an upgrade and the line still looks right, count the spaces **after**
the `=` as well as before it. A blanked `TASK_SOURCE=""` is worth the same look for a
different reason — it now means `github` to `ralph start`, where it used to defer to
an exported value (see [`TASK_SOURCE`](#configuration-reference)).

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
repeat until you actually update (or a later check finds nothing newer). A
scheduled `ralph cycle` prints the same unthrottled notice into
`logs/ralph-cycle.out.log`, so on a machine with the launchd agents
installed, expect one there per pass as well — and never a question after
it, since a launchd run has no terminal to ask on. The question that can
follow the notice on an interactive terminal — `Update now? [y/N]:` —
has a **7-day window of its own** in the global update-check cache, so it
reaches you at most once a week however many times `ralph start` and
`ralph cycle` run and however many repos are involved; declining is remembered
until that window rolls over. See [Updating Ralph](#updating-ralph) for the full behavior — both
windows, the prompt-from-cache rule, and the headless path.

Run `ralph update` to update — it picks the right command for a global
npm, pnpm, yarn, or bun install (see [`ralph update`](#ralph-update)) — or
`npm i -g @lucasfe/ralph` by hand. To silence the check, the notice, and the
question together instead, set
[`RALPH_NO_UPDATE_CHECK`](#environment-variables). Deleting `.ralph/state.json`
silences nothing: the windows live in the global cache, and the
`last_seen_release` field still present in that state file no longer drives
update notices — it is not a knob to reach for.

**`ralph doctor`'s `cached` row reads `unknown (no update check cached
yet)`.** — Nothing usable is
in the update-check cache yet, which is the normal state on a fresh
install: that file is written only by the weekly check — which runs in
`ralph start` and in `ralph cycle`, and nowhere else — and `doctor`
deliberately makes no registry query of its own. Run `ralph start` once, or
let the next scheduled cycle run, and the row fills in on the next
`doctor`; to learn the latest version right now,
`ralph update` asks the registry directly (and installs nothing when you
are already current). The row also reads `unknown` when the cache file
is unreadable or hand-mangled into something that is not a version, and
it stays `unknown` for as long as
[`RALPH_NO_UPDATE_CHECK`](#environment-variables) is set, because the
check that would populate it never runs. Either way it is a missing
answer, never a failure: `doctor`'s exit code is decided by the dep
report alone. The row names the question it could not answer rather than
printing a bare `unknown` beside a version number, so a pasted report
cannot be misread as "the installed version is unknown" — that fact is the
box's title, and it says `ralph unknown` when it is the one missing.

**No issues are picked up.** — Ralph's queue filter skips any open issue
carrying **one of four labels**: `in-progress` or `failed` — its own
bookkeeping — plus `pending-merge`, which parks an issue whose PR is
merged but not yet rolled forward onto the default branch, and
`do-not-ralph`, which is yours to apply and which Ralph never creates or
clears. Remove the label to put the issue back in the queue. The filter
is written out in full in the eligibility row of
[the task-source comparison](#choosing-the-task-source), which is the
only copy of it on this page, so what you read there is the query that
actually runs. Ralph applies `failed`
itself when Claude exits non-zero on an issue (auth/credit/rate-limit
errors, crashes) without otherwise resolving it, so the queue keeps
advancing instead of stalling on the same issue — see the per-issue log
to find out why.

Under [`TASK_SOURCE="jira"`](#the-jira-source-today) the filter above is not what
selects work at all: the loop draws its tickets from Jira and runs no `gh` command,
and `ralph cycle` decides whether to start from the **Jira** count, so a `JIRA_JQL`
that matches nothing — or that is unset, or that Jira rejects — makes the cycle exit
`queue empty` however many issues this filter would have matched. `ralph start` is
the odd one out and knowingly so: it still counts the GitHub queue, so it can refuse
to launch a Jira run over an empty one
([the detail](#what-is-still-githubs)).

`in-progress` is not left behind on a resolved issue. The loop clears
it as soon as an iteration leaves the issue in a state the filter already
excludes — the PR **merged** into a non-default branch with the issue
still open (`pending-merge`), the issue **closed** (including
closed indirectly by a merged PR's `Closes #N`), or `failed`
applied — so `in-progress` keeps meaning "Ralph is working on this
right now", and an issue that is later **reopened** comes back into the
queue instead of being silently skipped for a label left over from the
run that resolved it. The one case where the label is kept deliberately
is an issue that is still **open** after an iteration made no progress:
there the sticky label is what keeps a stuck issue from being re-selected
forever, and it is cleared later by the sweep below.

Leftovers are swept per pass by `ralph cycle` (see
[Scheduling Ralph](#scheduling-ralph-macos-launchd)), which clears
`in-progress` from **both open and closed** issues and prints/notifies
what it cleared (`🧹 ralph cycle: cleaned N orphan(s)`). Expect that line
to be busy on the first pass in a repo that accumulated stale labels
before this behavior existed. The sweep reads one page of up to 100
labelled issues per pass, newest first, so a backlog larger than that
drains over several cycles rather than all at once.

**An iteration prints `claude failed on issue #N (non-zero exit)`.** —
Claude exited non-zero on that issue without opening a PR, closing it,
or applying an exclusion label. Ralph adds the `failed` label so
the next iteration moves on. The cause (auth, credit balance,
rate-limit, or a crash) is captured in `logs/ralph-issue-N.log`:
Claude's stderr is now written there (and echoed to the terminal)
rather than being merged into the JSON stream. Fix the underlying
problem, clear the `failed` label, and re-run.

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
the issue (`failed`, `do-not-ralph`), then start Ralph again.

## Monitoring data model

Ralph emits two **append-only, newline-delimited JSON** telemetry streams
at two different grains: one **per issue** and one **per run**. Both are
**observation-only** — capture happens after the loop has already decided
an outcome and can never abort or alter the loop (every write is wrapped
`|| true`). The streams introduce **no new config tunables, no push
alerts, and no ceilings**; they only record what already happened.

The two streams are designed to map cleanly onto two future database
tables — a `runs` table (per-run stream) and an `issues` table (per-issue
stream) — joined on [`run_id`](#run_id--the-join-key).

Both streams are **history**. Ralph also keeps one artifact that is not a stream
at all — a single [run-state
record](#run-state--ralphrun-statejson-and-ralph-status) for the run in
progress, rewritten in place instead of appended, which is what `ralph status`
reads. It is the present tense rather than the record of what happened, but it
keeps the same observation-only discipline: every write is `|| true`, and no
failure of it can change a run.

### Per-issue stream — `.ralph/metrics/issues.jsonl`

After each issue iteration — regardless of outcome — Ralph appends one
`RALPH_ISSUE_EVENT <json>` line to `.ralph/metrics/issues.jsonl`, plus a
raw-output sidecar:

| Path | Contents |
| --- | --- |
| `.ralph/metrics/issues.jsonl` | One appended `RALPH_ISSUE_EVENT <json>` line per iteration. **Append-only** — events accumulate across runs and are never truncated. Maps to the future `issues` table. |
| `logs/ralph-issue-N.jsonl` | The agent's raw JSON stdout for that issue, tee'd verbatim (Claude's `stream-json`, or Codex's `codex exec --json` JSONL). Truncated fresh per issue. Under [`TASK_SOURCE="jira"`](#the-jira-source-today) the name comes from the **ticket key** rather than a number — `logs/ralph-issue-FOO-123.jsonl` — and the event's fields are parsed from that file, so the two agree. |

Each event line is the tag `RALPH_ISSUE_EVENT ` followed by a JSON object
with these fields:

| Field | Meaning |
| --- | --- |
| `issue_number` | The task this iteration worked, as a **number**: the GitHub issue under `github`, the numeric task id under `folder`, and under `jira` the number **derived** from the ticket key (`FOO-123` → `123`, see the [`jira` source](#the-jira-source-today)) — `null` when there is none to read, which for a Jira key the grammar does not recognise is a real case. Two projects' tickets can share a number (`FOO-1`, `BAR-1`); that is accepted, because a `JIRA_JQL` is normally scoped to one project and the key beside it is the identity. |
| `task_key` | The Jira ticket key this iteration worked (`FOO-123`), recorded verbatim — the spelling a reader recognises on the board, beside the number derived from it. **Present only under `jira`**: a `github` or `folder` event has no such concept and carries **no such field** rather than a `null` one, so their key set is byte-for-byte what it has always been. |
| `run_id` | The [join key](#run_id--the-join-key) — ties every issue event from one loop invocation to its run. |
| `ts` | Event timestamp (epoch milliseconds). |
| `agent` | The **resolved** coding agent that produced the event: `claude` or `codex`. A `RALPH_AGENT` typo records the fallback (`claude`), so a misconfiguration stays auditable. |
| `subtype` | The result subtype (e.g. `success`, `error`), or `null` if absent — **reconciled** with the stream's error flag, not copied verbatim. Claude's `result` event carries **both** `subtype` and `is_error`, and on a hard failure the two contradict each other (an auth failure reports `{"subtype":"success","is_error":true}`). `is_error` decides pass/fail; `subtype` only *names* the outcome. So a flagged result never records `success`: it keeps its own subtype when that already names the error (`error_max_turns` stays `error_max_turns`) and records `error` otherwise. The flag is **not** a field of its own — it is folded into this one, so the event's key set is unchanged. |
| `total_cost_usd` | The agent's reported cost for the iteration. **Codex always reports `0`** — the Codex stream carries no price and Ralph never fabricates one. |
| `num_turns` | Number of turns in the iteration. |
| `duration_ms` | Wall-clock duration for the iteration. Claude self-reports it in its `result` line; **Codex's stream carries no duration**, so the loop supplies its own measured wall-clock time (`RALPH_DURATION_MS`). |
| `usage` | The four raw token counts, broken out: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (each zeroed if absent). **For Codex**, `reasoning_output_tokens` are folded into `output_tokens` (they are billable output and dominate even trivial turns; the raw split stays in the `.jsonl` sidecar), `cached_input_tokens` map to `cache_read_input_tokens`, and `cache_write_input_tokens` map to `cache_creation_input_tokens`. |
| `claude_exit_code` | Whether the agent failed, as `1` or `0` — a **flag, not a status**. The loop reduces the agent's real exit code to non-zero/zero before the sidecar ever sees it, so an invocation killed on `127` records `1` exactly like one that exited `1`; what actually killed it is in that iteration's `logs/ralph-issue-*.log`, teed there as it happened. All three task sources hand over the same variable, so the field means the same thing in every event. (The field name is kept verbatim for both agents so the schema is unchanged.) |
| `stderr_error_signals` | Count of stderr lines matching auth / credit / rate-limit signals. |
| `verdict` | Under `github`: `pass` (CLOSED or `pending-merge`), `fail` (`failed` label), or `unknown`. Under `folder` and `jira` the **outcome the loop read back** decides instead, and it overrides the labels entirely — the terminal task directory there, the ticket's own label here — with `done` → `pass`, `failed` → `fail`, and anything else `unknown`. One mapping serves both, so the two sources cannot drift apart. |
| `files`, `insertions`, `deletions` | Real PR diff stats, fetched best-effort from the issue's PR (`gh pr list --head issue-<n>`). Degrade to `0` when no PR exists or the fetch fails — never aborts the loop. **Only `github` is asked**: `folder` and `jira` commit straight to `DEV_BRANCH` and open no PR, so the `gh` call is skipped rather than left to fail its way to the same zeros — which is what lets a machine with no `gh` at all write a complete event. |
| `context_end_tokens` | End-of-job context-window occupancy — the statusline number. The input side of the **most recent** model request: for Claude, the sum of `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from the **last** `message_start` event (not the cumulative `result` usage); for Codex, the same sum taken from the last `turn.completed` usage. `0` when no usage is present. |
| `context_end_pct` | `context_end_tokens / window`, rounded to 6 decimal places. `null` when the model's window is unknown or tokens are `0`. The window resolves from the model id (see [`RALPH_CONTEXT_WINDOW`](#configuration-reference) for the Anthropic + OpenAI/Codex maps) or from the override. |
| `model` | The resolved model id. For Claude it comes from the last `message_start`. **Codex's stream carries no model id**, so this is the configured [`RALPH_CODEX_MODEL`](#configuration-reference), or `null` when that is unset — Ralph never guesses. This is the one field of this stream with a reader outside the metrics: the `agent` row of the identity box [`ralph start`](#quick-start) opens with reads it back out of the **newest** event in this file to report which model the last run used, which is why that row is tagged `(last run)` rather than presented as a promise about the run about to start. It does so for Claude only — a Codex row is served straight from `RALPH_CODEX_MODEL`, because what is recorded here for a Codex run is that same configured value, one run staler. |
| `context_window` | The resolved context window in tokens — the **same** window that backs `context_end_pct` (single source of truth). Resolves from the model id (see [`RALPH_CONTEXT_WINDOW`](#configuration-reference)) or from the override. `null` when the window is unknown (including Codex with no configured model). The box's `context` row is read from this field of that same newest event, so it already reflects whatever `RALPH_CONTEXT_WINDOW` *that* run was given; a `null` here is a run the box draws no `context` row for. |

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
| `status` | `success` (no failures), `partial` (some ok, some failed), or `failed` — the outcomes of a pass that drained the queue. A pass that stopped instead reports that, with every count zero: `updated`, for one, is a cycle that installed a newer Ralph and stopped rather than draining through a half-swapped install (see [The weekly check](#the-weekly-check)). |
| `ok`, `failed` | Real per-run counts of resolved vs. failed issues. |
| `durationMin` | Run duration in minutes. |
| `processed` | Total issues processed (`ok + failed`). |
| `run_id` | The [join key](#run_id--the-join-key) — the same value stamped on every per-issue event from this run. |

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

### Run state — `.ralph/run-state.json` and `ralph status`

Both streams above are history. The **run state** is the present tense: one
small JSON record, rewritten in place (never appended), saying what the run
happening *right now* is doing. A detached run is otherwise unobservable — the
`==> Iteration for issue #N` line (`==> Iteration for FOO-123` under
[`jira`](#the-jira-source-today)) lives only in the tmux pane's scrollback, so
without this file nothing on disk answers "what is Ralph on?". It lives under the
gitignored `.ralph/` directory, so it is machine-local by construction and never
travels in a commit.

The loop writes it at three moments, each best-effort (`|| true`): once at run
start (`run_id`, `session`, `source`, `queue_at_start`, `started_at`), once per
iteration (`current: { number, task_key, started_at, iteration }`), and once at the end
(`status`, `finished_at`, `ok`, `failed`). `--once` runs — the path
`ralph cycle` drives — write the same records. An unwritable `.ralph/` changes
nothing about a run: not its outcome, not its per-issue events, not its
`RALPH_CYCLE_EVENT` line.

The record is flat, and `lib/run-state.js` is its single owner — neither the bash
loop nor `ralph status` names a field of its own:

| Field | Meaning |
| --- | --- |
| `schema` | Record version, currently `1`. Written for future migrations; **no reader inspects it yet**, so a record whose `schema` is missing or from the future is still read verbatim. |
| `run_id` | The [join key](#run_id--the-join-key) — the same value this run stamps on every `RALPH_ISSUE_EVENT` and on its `RALPH_CYCLE_EVENT`, so a run in flight can be tied to the history it has already written. |
| `session` | The tmux session the run was launched into (`ralph-<repo>-<hash>`), or the default `ralph` for a `ralph cycle` run, which has no session of its own. `ralph status` probes **this** session for liveness — the one the run recorded, not the one a fresh `ralph start` would create. |
| `source` | The resolved task source for the run: `github`, `folder` or `jira`, and only ever those three. This is the value the **bash loop** resolved, and the loop normalizes anything that is not an explicit `folder` or `jira` to `github` — so a typo records `github`, which is what it actually did. |
| `status` | `running` until the run ends, then the loop's own terminal status: `success`, `partial`, or `failed` — the same value the run's `RALPH_CYCLE_EVENT` reports. |
| `started_at` | Run start (ISO 8601, UTC). |
| `queue_at_start` | How deep the queue was when the run began — how much work it picked up. `null` when the count produced no number at all; an unknown depth is never recorded as `0`, which would be a lie. |
| `current` | The task in flight: `{ number, task_key, started_at, iteration }`, rewritten at the top of **every** iteration in all three task sources; `null` before the first one. Deliberately left in place on a terminal record, where it names the last task the run worked on. `task_key` is the Jira key (`FOO-123`) and is `null` under `github` and `folder`, which have no key; under `jira` the `number` beside it is **derived** from that key (`123`), because every reader written against an integer since this record was added keeps working, and the human surfaces show the key. |
| `finished_at` | Run end (ISO 8601, UTC). `null` while the run is going. |
| `ok`, `failed` | The run's own final counts — the same numbers as its `RALPH_CYCLE_EVENT`. `null` while the run is going. |

Only the loop writes the record, and only once it has actually started: a pass
that stops before it — an empty queue, or a preflight that aborts — leaves the
previous run's record untouched, so `ralph status` reports *that* run rather than
inventing one for a pass that did no work.

`ralph status` reads the record and reconciles it against whether the run that
wrote it is still alive, in one rule: a `running` record + a live run is
**running**; a `running` record whose run is gone is **interrupted** (a hard kill
or a reboot never got to write a terminal record); a terminal record is
**idle**; no record at all is **never-run**. All four exit `0`, and none of them
writes anything — `status` is a read-only view, so consulting a run can never
disturb it.

Three of the four are headed by the **identity box** described in
[the quick start](#quick-start); `never-run` is the exception, having no run to
identify. The readouts below are the report alone, as
[`RALPH_BANNER=off`](#configuration-reference) prints it.

A run can prove it is alive two ways, because the loop has two launchers:
`ralph start` leaves a tmux session, and `ralph cycle` (including every scheduled
run) holds the cycle lock instead. Both count — a draining scheduled run reads
`running`, not `interrupted`, and is shown with the log to follow rather than a
session to attach to:

```
▸ ralph — running · run ralph-ralph-b36ff7b1-1718700000 (started 16:20, 12min ago)
  progress   0/7 done · #031 in flight (4min)  [────────] 0%

  task                 verdict     cost      time
  #031 digest section  🔄 live     –         ~4min

  queue      6 waiting
  pace       ~84 min/task
  eta        ~9h44m left → ~02:16  (±1h30m)
  spend      unknown

  scheduled  ralph cycle run — no tmux session to attach to
  logs       tail -f logs/ralph-cycle.out.log
```

```
▸ ralph — running · run ralph-ralph-b36ff7b1-1718700000 (started 16:20, 3h12m ago)
  progress   2/9 done · #031 in flight (40min)  [██──────] 22%

  task                   verdict     cost      time
  #029 run-state record  ✅ pass     $34.45    97min
  #030 pace and ETA      ✅ pass     $28.40    71min
  #031 digest section    🔄 live     –         ~40min

  queue      6 waiting
  pace       ~84 min/task · $31.4/task
  eta        ~9h08m left → ~04:40  (±1h30m)
  spend      $62.85 so far · ~$250 projected

  ── digest (6min ago · haiku) ─────────────────────────────────
  Ralph is on #031, the digest section in ralph status, and it
  looks to be in the green phase: the log tail is a vitest run
  over lib/digest-history.test.js and the file it keeps
  rewriting is lib/digest-history.js.
  Nothing looks wrong — the pace has not moved off 84 minutes a
  task and no error is repeating in the tail.

  attach     tmux attach -t ralph-ralph-b36ff7b1
  kill       ralph stop
```

The two readouts differ in those last two lines, in the digest block the second
one has, and in how much each run has to say about itself — never in the id: a
cycle builds its `run_id` from the same per-project session name a `ralph start`
run would use, so what tells them apart is whether there is a session to attach
to. The scheduled run above is twelve minutes old and has finished nothing yet,
which is why its bar is empty, its table is the one row for the task in flight, its
pace is the all-time fallback and it has no spend of its own to
report (see [The progress line and the task table](#the-progress-line-and-the-task-table)
and [Pace, ETA, and spend](#pace-eta-and-spend) below). Nothing has
narrated it either: the digest window is opened by `ralph start`, and a scheduled
`ralph cycle` opens none, so a cycle run has a digest block only if you ran
`ralph digest` against it by hand (see
[The digest section](#the-digest-section) below).

An **`interrupted`** run prints the same six lines with the mode swapped and
`restart    ralph start` in place of the attach pair — there is nothing left to
attach to or kill, and the `in flight` line names the issue the run died on.
**`idle`** and **`never-run`** are one line of report each, deliberately: the run
is over, or there has not been one.

```
▸ ralph — idle · last run ralph-ralph-b36ff7b1-1718700000 ended 14:02 (partial: 2 ok, 1 failed)
```

```
▸ ralph — never-run · no run recorded yet (start one with `ralph start`)
```

Three small rules govern how those lines spell what they cannot say plainly, and
all three are the record's own never-lie-with-a-zero discipline seen from the
rendering side. A task number is **zero-padded to three digits** — `#031` — so
consecutive readouts align down the column, and a wider number is never cut to
fit it (`#1234`); a `number` the record could not supply as one reads `#?`. A task
that has a **key** is named by it instead — a
[`TASK_SOURCE="jira"`](#the-jira-source-today) ticket reads `FOO-123`, in the
`progress` line and in the table's `task` column alike, because the key is what a
reader can look up on the board and the number beside it in the record is derived
from it. The
`progress` line reads `nothing in flight` before the run has picked up its first
task, and reads it for a `current` that is *present but empty* too, since neither
of those names a task to report — and neither is counted into the denominator
either, so six waiting and nothing being worked on reads `0/6 done` rather than
`0/7`. And the `idle` line spends its `?` exactly where
`queue_at_start` does: a truncated or externally-written record that never
recorded `ok`/`failed` reads `(partial: ? ok, ? failed)` rather than a `0` that
would claim a run failed nothing.

The queue depth is **live**, and the [task source](#choosing-the-task-source)
decides how it is counted: the `gh` issue search under `github`, the local
`.ralph/tasks` tree under `folder` (no `gh` call at all), and the configured
[`JIRA_JQL`](#the-eligibility-query--jira_jql) through `acli` under `jira`. Only
the first two are what `ralph start` counts — under `jira` that command counts
GitHub issues as well, and since the loop it launches no longer works them, that
number is not a second right answer about a different board: it is a **debt**
rather than a defensible split, and it can refuse to start a run while Jira has
tickets waiting (see [The `jira` source today](#the-jira-source-today)). A failed count degrades to
`queue      unknown`; it never
fails the command, and it never reads as `0 waiting`. Only the live views pay
for it: `idle` and `never-run` skip the count entirely — no subprocess, no
directory scan. It is also the **denominator** the `progress` line counts against,
and it is bought **first** — before the one other subprocess a live view may
spend, the task-title lookup described next (`gh` under `github`, `acli` under
`jira`) — because it is the number the view cannot do without, and the titles are
only prose.

#### The progress line and the task table

The two blocks between the heading and the queue count answer the two questions a
reader who left a run unattended actually has — *how much of this is done?* and
*what has it done?* — and between them they replace the single
`in flight  #031 (40min)` row the live view used to open with. That row named the
task and nothing else, which is half a sentence: which issue is being worked on
only means something beside how much of the queue is left.

```
  progress   2/9 done · #031 in flight (40min)  [██──────] 22%
```

The fraction, the bar and the percentage are **one fact drawn three ways** —
computed once, from the same snapshot the rest of the view is rendered from, so they
cannot disagree with each other or with the table under them. The denominator is the
**live** queue: `completed + in flight + waiting`, recounted on every call rather
than frozen at the record's `queue_at_start`, because issues are opened and closed
while a run is going and a denominator fixed at launch drifts quietly away from the
truth.

The task in flight is **named in the line and counted in the total, never in the
numerator**. `3/9` while `#031` is still running would mean the fraction cannot be
trusted to move when something actually finishes, which is the one thing it is for.
Before the run picks up its first task the clause reads `nothing in flight` and the
task drops out of the total with it, so six waiting reads `0/6 done`.

A segment is **absent rather than faked**, the same discipline the three derived
lines below follow. A failed queue count leaves no denominator, so the line reads
`2/unknown done` and the bar and the percentage stay away entirely — a bar is a
picture *of* a denominator, and drawing one against a guess is worse than drawing
none. The completed count survives on its own, because it is a tally of the rows the
table is built from, and naming which half is missing beats dropping both. Both ends
of the bar are **reserved**: short of finished a run always leaves
one cell empty and never reads `100%` — `99%` is the ceiling — and a run that has
finished one of sixty still fills one cell and reads at least `1%`, because erasing
a task that really ran is the `$0.00` mistake in another alphabet. Everything in
between rounds **down** — a progress reading should never round up to a milestone
the run has not reached.

Under it, one row per task the run has touched, in the order
`.ralph/metrics/issues.jsonl` recorded them, with the task in flight last:

```
  task                   verdict     cost      time
  #029 run-state record  ✅ pass     $34.45    97min
  #030 pace and ETA      ✅ pass     $28.40    71min
  #031 digest section    🔄 live     –         ~40min
```

| Column | What it says |
| --- | --- |
| `task` | The zero-padded number — or the Jira **key** for a ticket that has one — and the task's title beside it when one could be looked up. The name is the fact and the title is context, so a row with no title is that name alone rather than a gap, and the column is only ever as wide as the widest title actually on show. A row is titled by whatever **names** it: a GitHub row asks for its number and a Jira row asks for its key, so a ticket is never titled with the prose of the GitHub issue whose number its key happens to derive to — `FOO-101` beside a `101` in the map is left untitled rather than borrowing it. |
| `verdict` | `✅ pass`, `❌ fail`, `❔ unknown` for a task the loop closed without recording one, and `🔄 live` for the one still running. Marker **and** word, never the marker alone: the glyph is what you scan for down the column, and the word is what survives a terminal without the font, a `grep`, and a reader who cannot see colour or emoji at all. |
| `cost` | What the task recorded, to the cent, or `–` when nothing was recorded. Never `$0.00`, which is the whole reason this column is worth a table: a reader scanning it must never have to wonder whether a row was free or unmeasured. A positive amount under a cent reads `<$0.01`, exactly as it does in the `spend` line. |
| `time` | Minutes, rather than the `3h12m` the run-scale spans use, because this column is read *down* — against the other rows and against the `~84 min/task` pace line below it, which is the unit that comparison happens in. The task in flight wears a `~`, since its number is still moving. |

The table is **capped at eight closed rows** plus the one in flight, which is the
same number [the digest block](#the-digest-section) caps its body at, so a view with
two variable-height blocks elides by one rule you learn once. Without a cap the whole
view would be as tall as the run is long: a night that worked through sixty issues
would put the queue count, the pace, the ETA, the spend, the digest and the
attach/kill pair below the fold. The rows kept are the **most recent** ones — a live
view answers "what just happened" — and what was dropped is named, with somewhere to
go for it, directly under the header where the missing rows would have been:

```
  … 52 earlier tasks in .ralph/metrics/issues.jsonl
```

That cap is a **display** decision and nothing else. The `progress` line above still
counts every task, so `60/67 done` over eight rows is the table eliding rather than
the fraction lying.

A run **between** tasks with nothing closed yet gets no table at all — not even the
blank lines that fence it — because a header over no rows is furniture. Neither do
the three modes that print the report card or the one-line greeting: an
`interrupted` run's history belongs to its card, not to a table with a `🔄 live` row
in it.

**Where the titles come from, and what they cost.** Nothing Ralph writes records a
task's title — neither the
[per-issue events](#per-issue-stream--ralphmetricsissuesjsonl) nor the run-state
record carries one — so the live view looks them up with one extra call, and **which
call** is the one thing that varies by task source:

| Source | The lookup |
| --- | --- |
| `github` | `gh issue list --state all --limit 100 --json number,title`, made at the git toplevel after the queue count. `--state all` is the whole difference between it and the count: the table's closed rows are issues this run has just *closed*, so an open-only query would title the queue and leave every row above it blank. |
| `jira` | `acli jira workitem search --jql "key IN (…)" --limit <n> --json --fields key,summary` — **one** call naming every ticket on the table at once, not one per row. The keys come off the rows themselves (the events' `task_key` plus the one in flight), so the query asks about the tickets actually on show and nothing else, and `--limit` is the number of **tickets** the query names — the keys de-duplicated, not the rows counted — rather than a page size, so a table of nine rows cannot come back titled five. Each key is checked against the [key grammar](#the-jira-source-today) before it goes into that query and dropped if it fails; if none survives, **no process is started**. |
| `folder` | None. A folder task's title lives inside its own file, and folder mode is deliberately GitHub-free — it is the mode for repos that have no GitHub at all. |

Whichever call it is, it is gated **tighter** than the queue count, on three
independent conditions:

| Only when | Why |
| --- | --- |
| the mode is `running` | The other three modes print the report card or the greeting, so a lookup for them would buy prose that nothing renders. |
| `--json` is off | [The document](#machine-readable-output--ralph-status---json) publishes no titles and no rows, so the call would buy a consumer nothing — and skipping it keeps `--json` the cheap surface a shell prompt can poll on a timer. |
| the source has somewhere to ask | The table above: GitHub for `github`, the board for `jira`, nowhere for `folder`. A `jira` run makes **no `gh` call at all** — it may be a repo with no GitHub remote — and a `jira` run whose rows carry no key makes no `acli` title call either, because there is nothing to ask about. |

And it is a **courtesy, never a fact**. Every way either lookup can fail — the
binary missing, unauthenticated, timed out, or answering with something that is not a
list of issues or work items — resolves to no titles at all, and every row then
renders as its number or its key, which is exactly what folder mode renders on
purpose. Nothing is said about it, because `ralph status` writes to stderr in no
mode; the command still exits `0` with the table intact.

A title is also the **second** piece of text in this view that Ralph did not write —
the other is [the digest narration](#the-digest-section) — and it is the less
trustworthy of the two, so it is scrubbed harder. A narration comes out of a file
this repo's own model wrote; an issue title on a public repository is prose anybody
at all can author, arriving over a pipe into a terminal that obeys some of what it
is sent. So escape sequences are taken **whole** rather than by their leading byte —
removing the escape alone would leave `[31mred` sitting on the line as ordinary text
— and the control, format, surrogate, private-use and line-separator characters go
with them, each replaced by a **space** so that a scrubbed sequence cannot fuse the
words either side of it into one. What is left is collapsed on whitespace, which is
what turns a newline forged into a title back into part of one cell rather than a
row of its own, and then truncated to **24 columns** with a trailing `…` — columns
as a terminal draws them, so that a CJK or emoji title cannot bend the grid around
itself — with a second cut at 64 code points, for text whose drawn width is a lie: a
thousand stacked combining marks measure almost no columns at all and are still a
blot on one cell. A title that scrubs away to nothing is no title, and the row is
its number.

#### Pace, ETA, and spend

The three lines under the queue are the counted facts turned into what they
imply. They are derived from the run's own
[per-issue events](#per-issue-stream--ralphmetricsissuesjsonl), read from
`.ralph/metrics/issues.jsonl` at the same git toplevel the record and the lock
live at:

| Line | How it is computed |
| --- | --- |
| `pace` | The mean duration of the **last three** tasks *this run* completed, once at least two of them exist — a queue's difficulty drifts, and what a run just finished predicts what it is about to pick up far better than every task ever recorded does. Below two in-run samples it falls back to the **all-time** mean over the whole of `issues.jsonl`, which is what a run too young to have an opinion of its own shows. The `$/task` half is the run's own observed rate. |
| `eta` | What is left of the in-flight task's estimate — floored at zero, so a task already running longer than the pace predicted never pushes the finish line out on its own — plus the **live** queue depth times the pace. Rendered as time left, a local wall-clock finish time (past midnight simply reads as tomorrow's clock; a finish no calendar can spell — one corrupt `duration_ms` away — reads `--:--` rather than a fabricated clock), and a `±` spread taken from the fastest and slowest of the same samples, rounded to five minutes. The depth is recounted on every call, never frozen at `queue_at_start`: items are opened and closed while a run is going, and a denominator fixed at launch drifts silently away from the truth. |
| `spend` | What this run has recorded so far, printed to the cent because it is a sum and not an estimate, plus a projection at the observed per-task rate over the tasks still ahead. The projection is rounded to a coarse grid — `~$250`, not `~$251.40` — since cents are noise on a figure extrapolated from a handful of tasks, and it is never rounded below the money already on the books, nor away to nothing: a figure the grid would erase falls back to its exact cents instead. A positive amount below a cent is spelled as the bound it is, `<$0.01`, rather than as the `$0.00` cents would round it to — cheap, not free. |

Every one of them reads `unknown` rather than a number it cannot stand behind:
these lines exist to be trusted when you leave a run unattended, and a guessed
ETA is worse than no ETA. A run that has completed nothing and no history behind
it to fall back on, a queue count that failed (no depth, so no ETA), a metrics
file that is missing, unreadable, or half-written by a run killed mid-append —
each degrades to `unknown`, never to `0`. Cost is the sharpest case:
`total_cost_usd` is `0` for every Codex iteration, because the Codex stream
carries no price and Ralph never fabricates one, so a Codex run reads
`spend      unknown` rather than `$0.00`, which would claim the run was free.
The metrics read is guarded the same way the queue count is — a read-only view
never aborts over its own telemetry.

Like `ralph cycle`, `ralph status` anchors itself on the **git toplevel**, so it
reports the same run from any subdirectory of the repo — the loop writes the
record at its `PROJECT_ROOT`, and a cwd-anchored read two directories down would
report `never-run` about a live run and then advise the `ralph start` that would
put a second loop on it. Outside a git work tree it falls back to the current
directory, which for anything but a Ralph project root means `never-run`. That
toplevel is also what the identity box's `cwd` row prints, which is the whole
reason the row is worth a line: it names the directory the record, the cycle lock,
`issues.jsonl` and `.ralph/digest.log` are all keyed on, not the subdirectory the
command was typed in.

#### The digest section

Under the numbers, when there is one to show, sits the sentence that explains
them: the latest [`ralph digest`](#quick-start) entry for the run in flight, read
back out of `.ralph/digest.log`. It is printed **after** the figures it is about
and **before** the advice about what to do next, and it brings its own blank line
with it — so a run with no narration behind it gets byte-for-byte the view this
command printed before the section existed.

The heading carries the three things worth knowing before you trust the paragraph
under it: how old the narration is, which model wrote it, and whether it is late.

```
  ── digest (6min ago · haiku) ─────────────────────────────────
  ── digest (1h18m ago · haiku · stale) ────────────────────────
  ── digest (6min ago) ─────────────────────────────────────────
  ── digest (1h18m ago · us.anthropic.claude-haiku… · stale) ───
```

The **age** is never shortened and never dropped, and neither is `stale`: a stale
narration mistaken for a current one is the one real harm this section can do. The
**model** is the only elastic clause, so it is the clause that gives way —
[`RALPH_DIGEST_MODEL`](#environment-variables) is free text and a Bedrock or Vertex
id runs to forty-odd characters, so it is elided (the fourth line above) to keep
the heading inside the same 64 columns the digest's other headings are padded to —
the one `ralph digest` prints, and every one in `.ralph/digest.log`. A truncated
model name is merely less specific; a truncated age would be a lie. It
is dropped **entirely** rather than spelled `unknown` for an entry written before
the model was a field — Ralph 0.21.0 recorded three (the third line above) — since
what is missing there is the model, not the digest, and `· unknown` in a heading
reads as a fact about the model rather than about our own records.

**`stale` means the timer skipped a tick**, not that a digest is a few seconds
late. The threshold is **two** intervals of
[`RALPH_DIGEST_INTERVAL`](#configuration-reference), because a digest lands when
its timer fires *and* the model answers, so a single interval is routinely missed
by a few seconds and warning about that would only train you to ignore the marker.
Two means the window is dead or the agent stopped answering, which is worth
saying. With no interval to measure against — unset, turned off, or a value the
duration grammar refuses — the *interval* falls back to **30 minutes**, so a
narration reads `stale` past an hour: 30m is the interval the config `ralph init`
writes recommends in its own comment, which makes it the assumption you most
likely configured.

An interval that is off is not the same thing as a digest that does not exist, and
this is the seam where that will look like a bug. `RALPH_DIGEST_INTERVAL=""` turns
off the *window*; it does not turn off `ralph digest`, which stays a one-shot you
can run by hand at any moment. So an entry that is on disk and belongs to this run
is shown whether or not anything was configured to produce it — refusing to print
a narration you deliberately asked for because a config value is empty would hide
the thing you asked for. All the interval decides is the ruler `stale` is measured
with.

The body is the narration **wrapped to those same 64 columns**, with blank lines
dropped — an empty line inside a block whose surroundings use empty lines as
separators would read as the block having ended halfway through — and capped at
**eight rows**, which is the two short paragraphs the digest's own template asks
for. A narration that runs longer says where the rest of it is, the way the `logs`
row does, because being told something is hidden and not told where to find it is
a problem rather than an answer:

```
  … full narration in .ralph/digest.log
```

That cap bounds **terminal rows**, so a single token too long for a line of its
own — a URL, a base64 blob, a minified stack out of a log tail — is broken at the
width rather than left to overflow. Eight rows means eight rows, and one long word
cannot push the attach/kill pair the cap exists to protect off the screen.

**This is one of the two parts of `ralph status` that are not Ralph's own text** —
the other is the issue titles in
[the task table](#the-progress-line-and-the-task-table), scrubbed harder still,
for the reason given there. Every
other row is a number this repo computed, an id it generated, or one of its own
words; the narration — and the model name beside it — come out of a file that
holds model output and that a human can edit. So on the way to a terminal every
control byte in it (C0, DEL, C1) is replaced with a **space**: a narration opening
with an ANSI clear-screen would otherwise erase the view and take the attach/kill
pair with it, a title-setting sequence would retitle your window, and a NUL
truncates the line on some terminals. Newlines are the exception, because there
they are structure rather than content — they are where the paragraphs break. A
space rather than nothing, so a scrubbed sequence cannot fuse the words on either
side of it into one. `ralph status --json` deliberately publishes the narration
**raw** instead; that asymmetry is
[explained below](#machine-readable-output--ralph-status---json).

Finally, the section belongs to the **`running` view alone**, and to *this* run
alone. An entry whose run id is not the record's is some other run's narration —
`.ralph/digest.log` is appended forever, so last night's is still in the file —
and reporting a finished run's work as the current state is worse than saying
nothing. `idle`, `interrupted` and `never-run` do not read the history file at
all: a run that is over is reported from facts rather than from prose, so an
interrupted run whose last narration is still sitting on disk shows none of it.
Everything else costs you the section and nothing more: a missing file (a repo
with the digest off never creates one), an unreadable one, or a last entry that
cannot be stood behind — a heading whose timestamp will not parse, or one torn in
half by a digest killed mid-append — in which case the scan falls back to the last
whole entry before it rather than printing a heading with nothing under it.

#### Machine-readable output — `ralph status --json`

`ralph status --json` prints **one JSON document on stdout and nothing else** —
no heading, no advice, no identity box, no trailing blank line, one compact
newline-terminated line — so a shell prompt, a tmux status line, or a custom
notifier can be driven off `ralph status --json | jq` instead of re-parsing
`.ralph/metrics/issues.jsonl` by hand. It is the second readout above seen from
the other side — the same document, broken one section per line here for reading,
from a machine whose clock is UTC so its finish time reads as the same wall
clock:

```
{
  "mode": "running",
  "run_id": "ralph-ralph-b36ff7b1-1718700000",
  "progress": { "completed": 2, "in_flight": 1, "remaining": 6, "total": 9 },
  "tasks": { "current": { "number": 31, "started_at": "2026-08-25T18:52:00Z", "task_key": null } },
  "pace": { "basis": "last3-in-run", "per_task_min": 84, "fastest_min": 71, "slowest_min": 97, "samples": 2 },
  "eta": { "remaining_min": 548, "finish_at": "2026-08-26T04:40:00Z", "range_min": [457, 639], "basis": "last3-in-run" },
  "spend": { "usd": 62.85, "per_task_usd": 31.425, "projected_usd": 251.4 },
  "digest": { "at": "2026-08-25T19:26:00Z", "age_min": 6, "model": "haiku", "task": "#031", "stale": false, "text": "Ralph is on #031, the digest section in ralph status, and …" }
}
```

The document is a **projection of the very snapshot the human lines are rendered
from**, not a second reading of the same files: one snapshot is built per
invocation and handed to whichever surface is printing, and the JSON side only
renames camelCase to snake_case, converts milliseconds to whole minutes, and
clamps. It computes nothing and never opens `issues.jsonl` for itself, so the
two surfaces cannot drift apart, and everything in
[Pace, ETA, and spend](#pace-eta-and-spend) above applies to it unchanged. The
one thing cut short above is `digest.text`, which carries the run's whole
narration: the document is that block of prose in full, and it is elided here
because nothing else in the document is prose.

A projection of the snapshot is not the whole of it, and the one thing left out is
deliberate: the document publishes **no per-task rows and no task titles**, so
[the task table](#the-progress-line-and-the-task-table) has no counterpart here and
the extra call that titles it — `gh` under `github`, `acli` under `jira` — is never
made under `--json`. The keys below are
the one thing about this command that cannot be fixed after release, and a run's
task-by-task history is already on disk, one line per task, in
[`issues.jsonl`](#per-issue-stream--ralphmetricsissuesjsonl) — which is where a
consumer that wants the rows reads them, and where the table's own elision line
points a human. `progress.completed` and `tasks.current` are what the document says
about the same fact instead, and they have said it since **0.20.0**. No key has
changed meaning or gone away in that time; what the document has done is **grow**, twice —
[`digest`](#the-digest-section) in **0.22.0**, and now `tasks.current.task_key`, which
names a Jira ticket the number beside it cannot and is `null` in every document a `github`
or `folder` run prints.

| Field | Meaning |
| --- | --- |
| `mode` | `running`, `interrupted`, `idle`, or `never-run` — the four modes above. The **discriminator**: read it first, because every key below it is present in every mode. |
| `run_id` | The [join key](#run_id--the-join-key) as a string, or `null` in `never-run`. An `idle` document still names the run that just ended, so its history in `issues.jsonl` stays reachable. |
| `progress.completed`, `progress.in_flight` | Tasks this run has finished, and whether one is in flight (`0` or `1`). |
| `progress.remaining`, `progress.total` | The **live** queue depth, and `completed + in_flight + remaining`. Both `null` when the count failed — "nothing left" and "we could not look" are different answers. |
| `tasks.current` | `{ number, started_at, task_key }` for the task in flight, and `null` **exactly** when `progress.in_flight` is `0`. Those three keys and no others, at every task source. Gated on that count rather than on the record, because a terminal record deliberately keeps `current` (it names the last task the run worked on) and reading it directly would have an `idle` document claim a finished run is still working. |
| `tasks.current.task_key` | The Jira **key** of the ticket in flight (`"FOO-123"`) under [`TASK_SOURCE="jira"`](#the-jira-source-today), and `null` at every other source — where the task has no key, rather than one that could not be read. Published **verbatim**, exactly as the record spells it, because a key is an identity and a re-spelled one addresses no ticket: the table's cell is scrubbed and truncated for a terminal, and this is not a terminal. **Unbounded in length** for the same reason, and the same rule `run_id` has always had — a 100 kB key hand-written into `.ralph/run-state.json` is published at 100 kB rather than cut into a key that names nothing. `number` beside it still carries the key's **derived** number (`FOO-123` → `123`), which is a handle a consumer may now ignore — [and should](#the-jira-source-today), since it is not unique across projects. Always **present**: a `github` or `folder` document publishes the key as `null` rather than dropping it, so `.tasks.current.task_key` resolves wherever `tasks.current` does. |
| `pace.basis`, `eta.basis` | `last3-in-run`, `all-time`, or `unknown` — which sample set the pace came from. One value from one read, published on both sections: the ETA is the number a reader distrusts, and being told it came from the last three tasks is what makes it checkable. |
| `pace.per_task_min` | The pace as whole minutes per task — the `~84 min/task` the human line prints. |
| `pace.fastest_min`, `pace.slowest_min` | The observed extremes of the **same** samples, published here beside the mean they were measured with, because they are a fact about tasks rather than about the finish. |
| `pace.samples` | How many task durations the pace averaged. |
| `eta.remaining_min` | Whole minutes until the queue empties, at that pace and that live depth. |
| `eta.finish_at` | When that lands, as an instant (see below). |
| `eta.range_min` | The ETA's `[low, high]` band in whole minutes — `remaining_min` ± the spread the human line prints as `(±1h30m)`, floored at `0` and always ascending. Taken **unrounded**, so the endpoints can sit a minute or two wider than that `±` implies: the printed spread is rounded to five minutes for a reader, the document's is not. **Endpoints of the ETA, not the per-task extremes**: those are `pace.fastest_min` / `pace.slowest_min`, where they were measured, and a `[71, 97]` band around `548` would be nonsense. |
| `spend.usd`, `spend.per_task_usd`, `spend.projected_usd` | What the run has recorded, its observed rate, and that rate over the tasks still ahead — in dollars, unrounded. |
| `digest` | The run's latest narration — the same entry [The digest section](#the-digest-section) documents — or `null` when there is none to publish. **Always present, and `null` wholesale** rather than a shape with six empty leaves: a section whose every leaf is `null` still asserts that the thing exists and was unmeasurable, which is honest for a pace but not here, where there genuinely is no digest. It follows `tasks.current`, which is `null` wholesale for the same reason. Populated **only** in `running`: `idle`, `interrupted` and `never-run` never open `.ralph/digest.log` at all, so an interrupted run whose last narration is still sitting on disk publishes `null` here. |
| `digest.at` | When the narration was written, as an instant (see below). Read off the entry's own heading and re-emitted in this document's format rather than copied through, so a hand-edited stamp still arrives as UTC to the second. |
| `digest.age_min` | How old it is, in whole minutes — `age_min` and not an `age_ms` because a narration's freshness is a minutes-scale question, and the document's other durations are minutes. Rounded, and floored at `0`: two clocks (a record written on another machine, a system clock stepped by NTP) can put an entry in the future, and a negative age is a bug report about Ralph rather than news about the run. `.digest.age_min` resolves in every mode — to a number or to `null` — which is the property a consumer actually writes against. |
| `digest.model` | The model that wrote it, as the entry recorded it, or `null`. Never the string `unknown`: an entry written by Ralph **0.21.0** carries three heading fields rather than four, so there is no model in it to report, and that is absence rather than a model named "unknown". |
| `digest.task` | The task that was in flight when the narration was written, spelled as the entry spells it — the same zero-padded `"#031"` the terminal prints — or `null` when no task was in flight. A **string**, and deliberately not the same question as `tasks.current`: this is what the digest was about, which on an older entry need not be what the run is on now. |
| `digest.stale` | Whether the narration is late by the rule [above](#the-digest-section) — the document's one boolean, because publishing a yes/no as a word would make a consumer parse it to learn something it can already read off `age_min` and its own interval. **Three-valued**, since the unknown discipline outranks the type: a value wherever `age_min` is a number, and `null` in the single case it is not, because with no age there is no judgement to make and `false` would say "fresh" where the honest answer is "we cannot say". Tied to `age_min` rather than computed twice, so the two leaves can never disagree. |
| `digest.text` | The narration itself: the **raw** text of the entry, whole and unwrapped. The terminal's 64-column block is a rendering, so a consumer re-wrapping to its own width gets the paragraphs intact. |

Every mode emits the **same key set**; only the values change. The measurements
belong to the two **live** modes: `idle` and `never-run` never count the queue
and never read `issues.jsonl` at all — the same shortcut their one-line human
view takes — so an `idle` document is its `mode` and its `run_id` with every
measurement empty, and a consumer that wants a finished run's totals reads
`issues.jsonl` instead. An unknown value is `null` — never `0`, and never an
absent key, so a consumer writes `.eta.finish_at` once and it resolves in all
four modes instead of needing a presence check per field. `progress.completed`,
`progress.in_flight`, and `pace.samples` are the exception that proves the rule:
they are counts, so a `0` there is the measurement and not a stand-in.

`digest` is gated tighter than the measurements — only a `running` document opens
`.ralph/digest.log`, so an `interrupted` one reports the pace and spend the run
really did make and `digest: null` beside them. It is also the one section that
goes `null` **wholesale** rather than leaf by leaf, following `tasks.current`: an
all-`null` shape would assert a digest exists and could not be measured, and there
simply is none. Nothing downstream has to know that, because `jq` reads a field of
`null` as `null` — `.digest.age_min` resolves in all four modes exactly as
`.eta.finish_at` does.

The exit code is `0` in every mode and **nothing is ever written to stderr**,
because there is nothing to say — a missing record (including a cwd outside a
work tree) resolves to a mode, and a failed queue count or an unreadable,
half-written `issues.jsonl` resolves to a `null` leaf, which tells a consumer
more than a line of prose it would have to parse. Whatever happens, stdout stays
one parseable document. The identity box that heads the human view is not on this
path at all — the document is returned before the box is composed — so the
[`RALPH_BANNER`](#configuration-reference) setting, in `ralph.config.sh` or in the
environment, cannot put a byte in front of it at any value.

All three instants are **ISO-8601 UTC truncated to the second**
(`2026-08-26T04:40:00Z`, not `…:00.000Z`): `jq`'s `fromdate` parses
`%Y-%m-%dT%H:%M:%SZ` and fails outright on a fractional second. UTC rather than
the local wall clock the human view prints, because a document gets parsed,
moved between machines, and diffed — the reader's local reading is the
terminal's job. Where they differ is what they do with an instant that format
cannot spell, and the difference is provenance. `eta.finish_at` is **derived**
(now plus the ETA), so one corrupt `duration_ms` in `issues.jsonl` can push it
past year 9999; it **saturates** at the calendar bounds
(`0000-01-01T00:00:00Z` … `9999-12-31T23:59:59Z`), which costs nothing because
`remaining_min` sits right beside it carrying the true magnitude losslessly, and
which buys an invariant worth writing a prompt against: `finish_at` is `null`
only when there is no ETA at all, and otherwise always a four-digit-year
instant. `tasks.current.started_at` and `digest.at` are **transcribed** — one from
the record, the other from the history entry's own heading — so an out-of-range
value is `null` instead. There is no adjacent field to carry the truth, and a
clamped start would hand a status line computing `now - started_at` thousands of
years while the terminal beside it prints `(0min)`.

Money is emitted unrounded (`62.85`, `31.425`, `251.4`). The coarse dollar grid
the human line uses (`~$250`) is a rendering decision for a reader; a machine
gets the figure and rounds it however it likes. For the same reason there is
deliberately **no `elapsed_min`** on the task in flight: `started_at` is a fact,
whereas an elapsed would be stale the instant the document was written — a
status line redrawing on a timer wants the former and derives the latter itself.

The narration goes out **raw**, which is the one place this document and the
terminal deliberately disagree about the same bytes. The human view replaces every
control byte in the narration with a space before printing it, because an ANSI
escape sitting in there would act on the reader's terminal rather than show up in
it (see [The digest section](#the-digest-section)). `digest.text` is not scrubbed,
because `JSON.stringify` escapes every code unit below `0x20` anyway — the wire is
safe by construction, and a consumer re-rendering the narration in a surface of its
own should receive what the model actually wrote rather than our cleaned-up reading
of it. The hazard is the terminal, so the defence lives in the terminal renderer.

Worked, then: everything above exists so that one line of `jq` can be written
once and left alone. What a shell prompt or a tmux `status-right` wants is the
mode, the task, how far through the queue it is, and when it lands —

```bash
ralph status --json | jq -r '
  if .mode != "running" then "ralph \(.mode)"
  else [ "ralph",
         (.tasks.current | if . == null then "no task yet" else "#\(.number // "?")" end),
         "\(.progress.completed)/\(.progress.total // "?")",
         (.eta.finish_at | if . == null then "eta ?" else "eta \(fromdate | strflocaltime("%H:%M"))" end)
       ] | join(" · ")
  end'
```

— which across the four modes prints, the first line being the document above
read back on that same UTC machine:

```
ralph · #31 · 2/9 · eta 04:40      # running, every measurement available
ralph · #31 · 0/? · eta ?          # running: the queue count failed, nothing to pace from yet
ralph · no task yet · 0/6 · eta ?  # running, before the first task is picked up
ralph interrupted                  # …and `ralph idle`, `ralph never-run`, from the same branch
```

Three habits in it, and each is a paragraph above being spent. `mode` is read
**first**, and answers on its own for the three non-running modes: those
documents have nothing to say past their name and a run id, and asking a
finished run how fast it is going is not a question. Then **every leaf a number
can go missing from is guarded**, because a `null` breaks a consumer in two
different ways and only one of them is loud: interpolated, it prints the literal
text (`#null`, `0/null`), which a status line will happily display for hours,
whereas `fromdate` on it fails outright (`strptime/1 requires string inputs`)
and takes the whole line down. So the numbers take a `//` default and the
instant takes an explicit `null` branch — while `progress.completed` needs
neither, precisely *because* it is a count. And `finish_at` goes through
`fromdate` and only then `strflocaltime`, which is the whole reason that field is
truncated to the second: the document carries an unambiguous UTC instant and the
reader wants their own wall clock, so the conversion belongs at the point of
display and nowhere earlier.

Keep it in a small script on `PATH` and point the prompt or `status-right` at
*that* rather than inlining it — tmux reads a bare `#` in a format string as its
own escape. Nothing downstream needs a failure branch, because there is no
failure to branch on: the command exits `0` and stdout carries exactly one
document in all four modes. And the same four reads drive a notifier instead of a
status line by changing only the string they are formatted into —
`.eta.remaining_min` under a threshold is the entire condition for "tell me when
it is nearly done".

### The launch projection — `ralph start`

`ralph start` asks the three questions
[Pace, ETA, and spend](#pace-eta-and-spend) answers, one step earlier: before a
single task has run, what should the queue it just accepted take, what should it
cost, and when should it be done? The answer sits at the top of the startup box,
above the tmux lines:

```
✅ Ralph started in background. 9 issues in the queue.
   Projection:     ~84 min/task · ~$31/task
                   → ~12h36m, ~$280, done ≈ 04:40
   Progress:       ralph status
   Watch live:     tmux attach -t ralph-ralph-b36ff7b1
   Detach:         inside the session, Ctrl+B then D
   List:           tmux ls
   Kill:           tmux kill-session -t ralph-ralph-b36ff7b1
   Logs:           logs/ralph-issue-*.log
```

Two rates on the first line — minutes and dollars per task — and on the
continuation line what they come to over the whole accepted queue: a total
duration, a total cost, and a local wall-clock finish time (past midnight simply
reads as tomorrow's clock, exactly as in `ralph status`). Everything from
`Watch live:` down is unchanged; the projection and the `ralph status` hint are
purely additive.

The queue on that first line is GitHub's, and under
[`TASK_SOURCE="jira"`](#the-jira-source-today) that is now the **wrong** board: the
loop selects and claims Jira tickets, and this command has not followed it there yet,
so the number — and the cost and finish time projected from it — describe issues the
run will never touch. Read `ralph status` for that source's depth, and
[what is still GitHub's](#what-is-still-githubs) for the rest of the mismatch.

The basis is **deliberately different**. This projection is the **all-time** mean
over the whole of `.ralph/metrics/issues.jsonl`, never the last three tasks the
live view prefers, because at launch there is no run to observe yet — every task
ever recorded in this repo is the only evidence there is. So the two can differ,
and the pace `ralph status` reports an hour in, measured on the run actually
happening, is the better number: this one exists to be read before you walk away.

The unknown discipline is the same one, spent differently. With no history at
all — a fresh repo's first launch — the two lines are **omitted entirely**
rather than printed as `~0 min/task · ~$0/task`, which would promise a free,
instant queue. With one half measurable and the other not, the known segments
print and the rest drop out: a Codex project records durations but no cost (see
`total_cost_usd` [above](#per-issue-stream--ralphmetricsissuesjsonl)), so it gets
the minutes and the duration total and no dollars at all. And unlike every line
of `ralph status`, the word `unknown` never appears here — a launch box is advice
on the way out the door rather than a report being interrogated, so an absent
number is simply absent, and a finish time no calendar can spell drops `done ≈`
instead of printing `--:--`. Money rounds to the same coarse grid, and yields to
the exact figure the same way: a rate the grid would erase prints its exact cents,
and a positive one below a cent prints `<$0.01`.

Reading the metrics file is best-effort, the same way every other read of it is:
missing, unreadable, or half-written by a run killed mid-append costs the reader
this hint and never the launch — by the time these lines print, the loop is
already going.

## Links

- [PRD / decisions (agenthub#13)][prd]
- [CHANGELOG](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
