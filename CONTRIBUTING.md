# Contributing to `@lucasfe/ralph`

Thanks for your interest. This package is developed inside the
[`agenthub`](https://github.com/lucasfe/agenthub) monorepo under
`packages/ralph/`. The roadmap, locked decisions, and per-slice
breakdown live in [issue #13][prd].

[prd]: https://github.com/lucasfe/agenthub/issues/13

## Local development

```bash
git clone https://github.com/lucasfe/agenthub.git
cd agenthub/packages/ralph
npm install
npm test            # vitest run
npm run test:watch  # vitest watch mode
```

The package has no build step — the published artefact is the source.
Three runtime deps (`commander`, `execa`, `picocolors`); tests use
`vitest` + `memfs` for hermetic filesystem assertions.

## Pull requests

- Branch off `dev` (the integration branch).
- Keep PRs scoped to a single slice from the plan; aggressive dogfood
  is the goal — every change should be reviewable on its own and
  rollback-friendly via `git revert`.
- Run `npm test` from `packages/ralph/` before pushing. CI runs
  `npm ci && npm test` and will block the merge on failure.
- Follow strict semver: patch = bug fix, minor = additive feature,
  major = breaking with migration notes added to `CHANGELOG.md`.

## Manual smoke test (pre-release recipe)

The package is dogfooded against the host repo continuously, but
before each tag we also exercise it against an unrelated project to
catch path/template bugs that the host repo can't surface.

1. **Pack a tarball locally** from `packages/ralph/`:
   ```bash
   cd packages/ralph
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
4. **Run `ralph doctor`** and confirm the dep summary is correct for
   the OS (`brew install ...` on macOS, `apt install ...` on
   Linux/WSL).
5. **Pick a real open issue** in the project and run `ralph start`.
   Watch via `tmux attach -t ralph`. Verify that:
   - Lazy validation runs on first start (`.ralph/state.json` did not
     exist), Claude rewrites the config if needed, and the state file
     is created.
   - The loop selects the issue, opens a PR, polls until merge,
     closes the issue, and emits the end-of-run summary on stdout.
   - `logs/ralph-issue-N.log` exists for the issue.
   - WhatsApp delivery works when `.env.local` is configured (else
     skipped silently).
   - The custom hook fires when `ralph-notify.sh` is present and
     executable (else skipped).
6. **Run `ralph stop`** and confirm the tmux session is gone:
   ```bash
   tmux ls   # must not list 'ralph'
   ```
7. **Re-run `ralph start`** with no eligible issues and confirm it
   exits with `ℹ️  Nenhuma issue na fila. Nada a fazer.`
8. **Edit `ralph.config.sh`** by hand (e.g. change `MERGE_STRATEGY`),
   then `ralph start` again. Lazy validation should re-run because
   the sha256 of the file changed.
9. **Bump `RALPH_VERSION` mismatch** by editing
   `.ralph/state.json` to a fake `ralph_version`. Next `ralph start`
   must re-validate.

If any step misbehaves, file an issue under the `ralph-package` label
on the host repo with the reproduction command and `logs/`.

## Releasing

Releases ship via the
[`ralph-publish.yml`](../../.github/workflows/ralph-publish.yml)
workflow on push of a `ralph-v*` tag. The maintainer flow is:

1. Land all PRs for the slice on `dev`.
2. Bump `package.json` version + move `## [Unreleased]` notes to a
   new `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`.
3. Open a PR to `main`, get it merged.
4. Tag the merge commit `ralph-vX.Y.Z` and push the tag.
5. The workflow runs `npm ci`, `npm test`, and
   `npm publish --access public` in `packages/ralph/`. On success the
   release lands on the npm registry under `@lucasfe/ralph`.

The workflow uses `NODE_AUTH_TOKEN` populated from the repo secret
`NPM_TOKEN`. Rotate that token via npm's "Access Tokens" page when
needed.
