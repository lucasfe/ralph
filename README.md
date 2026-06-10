# @lucasfe/ralph

Ralph is an autonomous loop that picks the next open GitHub issue, asks
Claude Code to resolve it, opens a pull request, and waits for the merge
— then moves on to the next one. This package extracts the in-repo Ralph
scripts into a reusable CLI so any project can opt in with a single
`npm i -g @lucasfe/ralph` invocation.

The full design is captured in [issue #13][prd].

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
will check for you (`git`, `gh`, `tmux`, `claude`, `jq`, `curl`).
macOS, Linux, and WSL2 are supported.

## Quick start

In a git repo on the branch you want Ralph to work from:

```bash
ralph init     # one-time: detect stack, write config, slash command, gitignore
ralph doctor   # verify required deps are on PATH
ralph start    # launch the loop in a detached tmux session
ralph stop     # kill the tmux session when you want Ralph to halt
```

`ralph init` is non-interactive: it inspects the manifests in your repo
(`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`,
`composer.json`, lockfiles) and writes a `ralph.config.sh` with the
right install/test/lint commands for your stack. If nothing matches,
the values are left empty and Claude is instructed to figure them out
at runtime.

`ralph start` runs sanity checks (tmux session uniqueness, deps,
`gh auth`, `.mcp.json`, label setup, orphan `claude-working` cleanup),
optionally prints an upgrade notice, and launches the bash loop inside
a tmux session named `ralph`. Watch it live with `tmux attach -t ralph`,
detach with `Ctrl+B` then `D`, or tail per-issue logs in
`logs/ralph-issue-*.log`.

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
  explorer in the roster below).

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
   and a human is pulled in via the caveat flag (below).
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

## What survives an update

`ralph init` and any future Ralph update mechanism (`npm i -g
@lucasfe/ralph@latest`, re-run of `ralph init`, future `ralph upgrade`)
treat user-authored config files as read-only. Running an update will
never silently overwrite credentials, secrets, or your project notes.

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

The split is enforced by automated tests in
`packages/ralph/lib/init.test.js`, so a future template-management
refactor cannot silently break the invariant.

## Configuration reference

`ralph init` writes `ralph.config.sh` at the repo root. It is meant to
be committed. Re-running `ralph init` never overwrites it.

| Variable              | Default                              | Purpose                                                                 |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `INSTALL_CMD`         | autodetected (e.g. `npm ci`)         | Command Ralph runs at the start of each iteration. Empty = ask Claude. |
| `TEST_CMD`            | autodetected (e.g. `npm test`)       | Test command run before opening a PR. Empty = skip.                    |
| `LINT_CMD`            | autodetected (e.g. `npm run lint`)   | Lint command run before opening a PR. Empty = skip.                    |
| `MAIN_BRANCH`         | from `origin/HEAD`                   | The protected branch (PRs ultimately land here).                       |
| `DEV_BRANCH`          | `dev` / `develop` / `MAIN_BRANCH`    | The integration branch Ralph branches off from.                        |
| `PR_TARGET`           | `DEV_BRANCH`                         | Base branch for the PR Ralph opens.                                    |
| `MERGE_STRATEGY`      | `squash`                             | Passed to `gh pr merge`. One of `squash`, `merge`, `rebase`.           |
| `AUTO_MERGE`          | `true`                               | v0.1 only supports `true` (manual review mode lands in v0.2).          |
| `MERGE_POLL_INTERVAL` | `30`                                 | Seconds between `gh pr view` polls while waiting for auto-merge.       |
| `MERGE_POLL_MAX`      | `40`                                 | Max polls (default = 20 minutes) before giving up on a PR.             |
| `RALPH_HEAVY_TIER`    | `0`                                  | Gates the **Tier 2 / Heavy** triage path. `0` = off (the default): the heavy tier is unavailable and triage falls back to Tier 1. When on, a Tier-2 run adds the explorer fan-out + inline synthesis understand phase before the dev. |

The config is plain bash; edit it in any editor. On the next
`ralph start` Ralph notices the change (sha256 mismatch in
`.ralph/state.json`) and re-validates the config one-shot via Claude.

## Notification setup

Ralph posts a one-line summary at the end of every run, and a startup
ping when `ralph start` successfully launches the tmux session. Stdout
(visible via `tmux attach -t ralph`) is always populated; the other
channels are opt-in.

### WhatsApp via CallMeBot (built-in)

1. Follow the [CallMeBot setup][callmebot] to get an API key linked to
   your WhatsApp number.
2. Copy `.env.local.example` (created by `ralph init`) to `.env.local`
   and fill in:
   ```bash
   CALLMEBOT_KEY=<your-key>
   WHATSAPP_PHONE=<your-phone-with-country-code>
   ```
3. `.env.local` is added to `.gitignore` automatically. Done — the next
   `ralph start` will message you when the loop boots, and again when
   it finishes.

To customize the startup message body (e.g. include the host name or
environment), set `RALPH_STARTUP_MESSAGE` in `.env.local`:

```bash
RALPH_STARTUP_MESSAGE=🟢 Ralph started on prod-runner-1
```

When unset, the default `🟢 Ralph started and is active.` is used.
Failures sending the startup ping log a warning and never abort
`ralph start`; missing credentials skip the ping silently.

[callmebot]: https://www.callmebot.com/blog/free-api-whatsapp-messages/

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

**"Sessão tmux 'ralph' já existe."** — A previous `ralph start`
already launched the loop. Either attach (`tmux attach -t ralph`) and
let it finish, or stop it (`ralph stop` / `tmux kill-session -t ralph`)
before starting again.

**`ralph doctor` reports a missing required dep.** — Install it with
the command shown in the output (e.g. `brew install gh` on macOS,
`apt install gh` on Linux/WSL). Ralph never auto-installs deps.

**Issues stuck with the `claude-working` label after a crash.** — The
next `ralph start` detects orphans and asks whether to clear them and
reprocess. Answer `y` to re-queue the issues.

**Reset Claude's understanding of the config.** — Delete
`.ralph/state.json` (or the whole `.ralph/` directory) and run
`ralph start` again. Lazy validation re-runs and rewrites the state
based on the current `ralph.config.sh` and project manifests.

**Update notice keeps appearing.** — `ralph start` warns once per
release. The reminder is deduped via `last_seen_release` in
`.ralph/state.json`. Run `npm i -g @lucasfe/ralph` to update.

**No issues are picked up.** — Check the queue filter Ralph uses:
`state:open -label:claude-working -label:claude-failed -label:do-not-ralph`.
Issues already labelled `claude-working` or `claude-failed` are
skipped; clear those labels to retry.

## Links

- [PRD / decisions (issue #13)][prd]
- [CHANGELOG](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
