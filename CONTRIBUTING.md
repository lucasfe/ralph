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
of names no file declares (`XDG_CONFIG_HOME`, `PROJECT_ROOT`, …). Add a new
credential or config knob and it is neutralized automatically. `pool: 'forks'` is
pinned in the same config for a reason documented there: the `HOME` sandbox
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
     against stubs.
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
   precisely the case that mode exists for.
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
