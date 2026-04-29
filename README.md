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

Each iteration follows a **TDD red → green → refactor** loop, baked
into the prompt Claude receives:

1. **Red** — write a failing test that captures the issue's expected
   behavior, then run `TEST_CMD` and confirm it fails for the right
   reason (the behavior is not yet implemented).
2. **Green** — implement the minimum code that makes the new test pass,
   then run `TEST_CMD` again and confirm every test passes.
3. **Refactor** — tighten names, remove duplication, and improve the
   design while keeping the suite green.

The new/updated tests and the implementation land in the same commit
so the TDD pair is reviewable together. The PR body documents the
TDD steps (tests added, failing names before, green suite result
after). TDD is skipped only for changes with zero behavioral impact:
pure documentation, plain configuration, or dependency bumps without
logic changes — and the skip is justified in the PR body.

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
