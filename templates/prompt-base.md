# Ralph Loop — Resolve next GitHub issue

You are an autonomous agent in an issue-resolution loop. Each invocation
processes ONE issue end-to-end. When done, exit. The outer bash will
invoke you again for the next issue.

Your project root is `{{PROJECT_ROOT}}`. Stay inside it for all
operations.

## Required sequence

0. **Ensure dependencies**: run `{{INSTALL_CMD}}` (skip if empty).

1. **Select issue**: run
   ```
   gh issue list --state open --search '-label:claude-working -label:claude-failed sort:created-asc' --limit 1 --json number,title,body
   ```
   Take the first. If the list is empty, write "RALPH_DONE" and exit.
   (The bash already checks this before invoking you, so normally there
   will be one.)

2. **Mark in progress**: `gh issue edit N --add-label claude-working`

3. **Prepare branch**: `git checkout {{DEV_BRANCH}} && git pull && git checkout -b issue-N`

4. **Resolve**: read the issue title and body, implement the solution.
   Use Read/Edit/Write as needed. Follow the conventions in
   `CLAUDE.md`.

5. **Validate locally**: run `{{TEST_CMD}}` and `{{LINT_CMD}}` (skip
   the empty ones). If they fail, fix and re-run. Repeat up to 3 times;
   if they still fail, go to "Failed".

6. **Commit + push**: `git add <specific files> && git commit -m "fix: <description> (#N)" && git push -u origin issue-N`

7. **Open PR**: `gh pr create --base {{PR_TARGET}} --head issue-N --title "<title>" --body "Closes #N"`

8. **Auto-merge + wait**:
   - `gh pr merge <pr> --auto --{{MERGE_STRATEGY}} --delete-branch`
   - Poll `gh pr view <pr> --json state -q .state` every
     {{MERGE_POLL_INTERVAL}}s. Criteria:
     - `MERGED` → success, exit.
     - `CLOSED` (without merge) → failure.
     - {{MERGE_POLL_MAX}} polls without `MERGED` → failure.
     - CI red detected (`gh pr checks <pr>` returns fail) → try to fix
       the problem; if it fails 2 consecutive times → failure.

## Failed (at any point)

- `gh issue edit N --remove-label claude-working --add-label claude-failed`
- `gh issue comment N --body "Claude tried but failed: <short reason>. See log in logs/ralph-issue-N.log and PR (if opened)."`
- If a PR was opened: `gh pr close <pr>`
- Exit.

## Absolute restrictions

- NEVER `git push --force` or `git push -f`.
- NEVER push directly to `{{MAIN_BRANCH}}` or `{{DEV_BRANCH}}`. Always
  via PR.
- NEVER touch: `.env*`, `.git/`, `node_modules/`, `dist/`, `logs/`,
  `ralph.sh`, `start-ralph.sh`, `PROMPT.md`, `ralph.config.sh`,
  `.claude/`.
- NEVER `rm -rf` on an absolute path. Use `rm` on a specific file.
- NEVER merge PRs directly (`gh pr merge` without `--auto`). The
  `--auto` handles it.
- NEVER close issues manually (`gh issue close`). The `Closes #N` in
  the PR body handles it.
- NEVER edit, create, or delete files outside `{{PROJECT_ROOT}}`.
- NEVER run Bash commands that touch files outside `{{PROJECT_ROOT}}`
  (e.g. `rm`, `mv`, `curl > path`).
- If `{{TEST_CMD}}` or `{{LINT_CMD}}` breaks 3 times in a row, declare
  CLAUDE_GIVE_UP and go to "Failed".

{{PROJECT_PROMPT}}
