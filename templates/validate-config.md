# Ralph Config Validation (one-shot)

You are running a one-shot validation pass for the Ralph configuration of
the project rooted at `{{PROJECT_ROOT}}`. This is NOT an issue-resolution
run — do not pick issues, do not open PRs, do not commit, do not push.

Ralph package version: `{{RALPH_VERSION}}`
Pre-validation `ralph.config.sh` sha256: `{{CURRENT_CONFIG_HASH}}`

## What to do

1. **Inspect manifests** at the project root to detect the actual stack.
   Read whichever of these are present:
   - `package.json` + `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json`
     → `pnpm` / `yarn` / `npm`
   - `pyproject.toml` or `requirements.txt` → `python` / `pip`
   - `go.mod` → `go`
   - `Cargo.toml` → `rust`
   - `Gemfile` → `ruby`
   - `composer.json` → `php`
   - Multiple of the above → `mixed`
   - None → `unknown`

   For npm-style projects, also peek at the `scripts` section of
   `package.json` to confirm a `test` and a `lint` script exist before
   you trust `npm test` / `npm run lint`.

2. **Read `ralph.config.sh`**. Compare its `INSTALL_CMD`, `TEST_CMD`, and
   `LINT_CMD` against what the manifests imply. If a value is empty,
   missing, or wrong, edit `ralph.config.sh` in place to use the correct
   command. Preserve every other variable (branches, merge config) as-is.

   Examples of correct values:
   - `npm` → `INSTALL_CMD="npm ci"`, `TEST_CMD="npm test"`, `LINT_CMD="npm run lint"` (only if a `lint` script is defined; otherwise leave empty)
   - `pnpm` → `INSTALL_CMD="pnpm install --frozen-lockfile"`, `TEST_CMD="pnpm test"`, `LINT_CMD="pnpm lint"`
   - `python` → `INSTALL_CMD="pip install -e ."`, `TEST_CMD="pytest"`, `LINT_CMD="ruff check ."`
   - `go` → `INSTALL_CMD="go mod download"`, `TEST_CMD="go test ./..."`, `LINT_CMD="go vet ./..."`
   - `rust` → `INSTALL_CMD="cargo fetch"`, `TEST_CMD="cargo test"`, `LINT_CMD="cargo clippy"`

   If the existing values already match the manifests, do not touch the
   file.

3. **Write `.ralph/state.json`**. Create the `.ralph/` directory if it is
   missing. The file must be valid JSON with exactly these keys:

   ```json
   {
     "config_hash": "{{CURRENT_CONFIG_HASH}}",
     "validated_at": "<ISO 8601 UTC timestamp>",
     "ralph_version": "{{RALPH_VERSION}}",
     "detected_stack": "<short label>",
     "notes": "<one short line>",
     "last_seen_release": ""
   }
   ```

   Field rules:
   - `config_hash`: write `{{CURRENT_CONFIG_HASH}}` verbatim. Ralph will
     recompute the hash after you exit and patch this field if you
     edited the config — do NOT compute a hash yourself.
   - `validated_at`: current UTC time in ISO 8601 (e.g.
     `2026-04-27T12:00:00Z`).
   - `ralph_version`: write `{{RALPH_VERSION}}` verbatim.
   - `detected_stack`: short label like `npm`, `pnpm`, `yarn`, `python`,
     `pip`, `go`, `rust`, `ruby`, `php`, `mixed`, or `unknown`.
   - `notes`: one short string. Examples: `"no changes needed"`,
     `"set INSTALL_CMD to npm ci"`, `"removed LINT_CMD because no lint
     script defined"`.
   - `last_seen_release`: leave as the empty string `""`.

4. **Exit.** Do not respond with extra commentary after writing the
   file.

## Absolute restrictions

- Touch ONLY `ralph.config.sh` and `.ralph/state.json`. Nothing else.
- Do NOT modify code, tests, READMEs, package manifests, or any other
  file.
- Do NOT run `npm install`, `pytest`, `cargo build`, etc. Inspect
  manifests by reading them; do not execute them.
- Do NOT touch GitHub: no `gh issue ...`, no `gh pr ...`, no
  `claude-working` label changes.
- Do NOT push branches or create PRs.
- Stay inside `{{PROJECT_ROOT}}`.
