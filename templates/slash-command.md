# /ralph — Trigger the Ralph loop

Runs Ralph: an autonomous agent that resolves open GitHub issues one
at a time in the background and (optionally) notifies via WhatsApp
when done.

## What to do

Execute the CLI from the project root via Bash:

```bash
ralph start
```

The CLI runs sanity checks, ensures the required GitHub labels exist,
offers to clean up orphaned `in-progress` labels, and launches the
loop in a detached `tmux` session named for this project
(`ralph-<repo>-<hash>`, derived from the project path, so several repos
can run Ralph at once).

Report the script output to the user (success, errors, or `[y/N]`
cleanup question). If the script asks for confirmation, relay it to
the user before continuing.

## Useful commands after starting

- See live: `ralph live` (no session name to type, and it works from
  any directory in the repo)
- List sessions: `tmux ls`
- Detach: inside the session, `Ctrl+B` then `D` — the loop keeps running
- Kill: `ralph stop`
- Logs per issue: `logs/ralph-issue-*.log`

`ralph start` also prints the raw commands for this project's session —
`tmux attach` on the line under its `Watch live:` row, and
`tmux kill-session` on its `Kill:` row. Those are the escape hatch for a
`ralph start` run somewhere other than the repo root: the session is then
named after that directory, and neither `ralph live` nor `ralph stop`,
both of which derive the name from the repo's git toplevel, can reach it.

## When NOT to use

- This project's tmux session is already running (CLI aborts and names
  `ralph live` as the way to watch the loop that is already going).
- No eligible open issues are in the queue (CLI aborts).
