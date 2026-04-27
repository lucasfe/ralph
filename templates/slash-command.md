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
offers to clean up orphaned `claude-working` labels, and launches the
loop in a detached `tmux` session called `ralph`.

Report the script output to the user (success, errors, or `[y/N]`
cleanup question). If the script asks for confirmation, relay it to
the user before continuing.

## Useful commands after starting

- See live: `tmux attach -t ralph`
- List sessions: `tmux ls`
- Detach: inside the session, `Ctrl+B` then `D`
- Kill: `tmux kill-session -t ralph` (or `ralph stop`)
- Logs per issue: `logs/ralph-issue-*.log`

## When NOT to use

- A `ralph` tmux session is already running (CLI aborts).
- No eligible open issues are in the queue (CLI aborts).
