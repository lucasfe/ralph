# Spike: headless subagent dispatch (issue #420)

**Parent PRD:** #419 — Ralph team mode.

**Question:** Can an orchestrator running inside `claude -p --dangerously-skip-permissions`
(the exact mode Ralph uses per issue) dispatch real, context-isolated subagents via the
Task/Agent tool and get structured results back? The entire team-mode pipeline
(Triage → Dev → QA → Review → Tech Writer) depends on this.

## Verdict

**Works.** Real Task/Agent-tool subagent dispatch is available and reliable in headless
mode. The team pipeline will use **real subagents** per role. The sequential
persona-switching fallback (#419 stories 27–28) is **not needed** and is held in reserve
only if a future runtime change removes the capability.

## How it was verified

The spike was run from inside an actual Ralph invocation — i.e. a live
`claude -p --dangerously-skip-permissions` process resolving this very issue — so the test
environment is identical to production, not a simulation.

| Check | Method | Result |
|---|---|---|
| Subagent runs at all | Dispatched a subagent told to return structured JSON | Ran; returned valid JSON |
| Returns a structured result | Asked for a fixed JSON shape incl. a computed value (`6 * 7`) and a token | `computed: 42`, `secret_token: RALPH-SPIKE-OK-420` — exact |
| Context is isolated | Asked the subagent what context it received | Confirmed it got only its own prompt, not the parent conversation |
| Subagents can use tools | Second subagent ran `node -e "console.log(2**10)"` via Bash | `tool_worked: true`, `bash_output: 1024` |
| Each dispatch is independent | Asked the second subagent if it knew the first's secret token | `knows_previous_subagent: false` — no cross-contamination |

## Implications for the build

- The orchestrator template dispatches one real subagent per role, each with a fresh
  isolated context and a structured return contract.
- Subagents can read files and run commands (tests, lint, git), which the Dev/QA/Review
  roles require.
- Results do not leak between dispatches, so role outputs must be passed forward
  explicitly by the orchestrator (e.g. dev's diff handed to QA/Review) rather than assumed
  to be shared.
- No `solo`-vs-`team` toggle and no persona-switching branch are required in the shipped
  templates.
