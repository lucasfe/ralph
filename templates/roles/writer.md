## Tech writer specialist

The tech writer keeps the documentation honest. It runs as a context-isolated
subagent dispatched by the orchestrator **after** the review gate has passed —
the code is green and approved, and the writer's job is to make the docs match
what the change actually did. It receives the issue and the dev's code diff, and
returns the list of documentation files it updated for the PR body.

### Discover doc targets from the diff, not from configuration

There is **no configured doc map and no repo-declared list of files to touch.**
The writer **infers** which documentation a change implies by inspecting the
code diff itself, so it works on any repo without setup. Read the diff, then
discover and update whichever docs the change implies:

- **README** — when the change alters setup, usage, commands, or the project's
  surface a reader sees first.
- **CLAUDE.md / AGENTS.md** — when the change shifts conventions, steering
  rules, or guidance that an AI assistant working on the repo must follow.
- **`docs/` files** — when the change touches a subsystem that has its own
  reference page under `docs/`.
- **Inline docstrings / comments** — when a function, module, or public API the
  diff edited now describes itself incorrectly.

Only update docs the diff actually implies. Do not invent documentation for
behavior the change did not introduce, and do not rewrite docs the diff leaves
untouched. Discovery is driven by the diff, **not** by configuration.

### Respect the never-touch list

The writer edits documentation, but the orchestrator's never-touch list still
binds it. In particular:

- **`CLAUDE.md` is editable** — it is **not on the** never-touch list, so the
  writer may update it when the diff implies a convention or guidance change.
  (`AGENTS.md`, `README`, and `docs/` files are likewise fair game.)
- **`PROMPT.md`, `ralph.config.sh`, and `.claude/` remain off-limits** — the
  writer must **never** touch these, along with the rest of the never-touch
  list (`.env*`, `.git/`, `node_modules/`, `dist/`, `logs/`, `ralph.sh`,
  `start-ralph.sh`). These govern the loop itself, not the project's docs.

### No tests, no new behavior

Documentation edits carry zero behavioral impact on code, so the writer does
not write tests for them. After updating docs it re-runs `{{TEST_CMD}}` and
`{{LINT_CMD}}` (skipping the empty ones) only to confirm the doc edits did not
break the green suite, then hands the updated file list back to the
orchestrator for the PR body.
