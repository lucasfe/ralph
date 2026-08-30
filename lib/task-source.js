// PURE task-source registry — NO I/O (#565). The single place that normalizes
// the TASK_SOURCE env var into a resolved source name. Mirrors resolveAgent in
// agent-registry.js: an unset/empty/whitespace value => github (the default,
// zero-regression path); a recognized value (case-insensitive, trimmed) => that
// source; anything else falls back to github so a typo never aborts a run.
//
// #125 ADDED jira, and it added ONLY a name. Being in this list is what makes
// `TASK_SOURCE=jira` a value rather than a typo — `ralph init --source jira`
// accepts it, lib/deps.js gates `acli` on it and `ralph doctor` reports what a
// Jira run needs. That is the whole point of registering the name first: a
// prerequisite you cannot check is a prerequisite people discover by having a run
// fail. #126 then gave the name a queue count, and #127 a SELECTION: the loop
// picks a ticket and claims it with the `in-progress` label. #128 made the name a
// LOOP — the arm exports the key, renders prompt-team-jira.md around it and
// dispatches the agent, which reads the work item itself and commits straight to
// DEV_BRANCH with no branch, no PR and no push. #129 then wrote the SUCCESS half of
// the bookkeeping back to the board — the agent labels the ticket `done`, takes
// `in-progress` off, comments the commit SHA and transitions the ticket where
// JIRA_DONE_STATUS names a status the workflow accepts — and #130 the FAILURE half,
// which is the LOOP's rather than the agent's: after the agent returns, bash reads the
// ticket's labels back and sweeps anything that is not `done` to `failed`, because the
// invocation that most needs sweeping is the one that died, and a dead agent writes
// nothing. So a worked ticket and a failed one now differ ON THE BOARD, which is what
// makes the queue drain either way. What is still missing is a per-ticket telemetry
// event (#131): nothing appends one under this source, so `ralph status` and the digest
// have no per-iteration record of a Jira run to narrate.
//
// DEFAULT_SOURCE and the unknown-value fallback are deliberately untouched. A new
// member of this list must not move either, or every repo whose ralph.config.sh
// predates it changes behaviour on upgrade.
//
// AND ADDING A NAME HERE IS NOT INERT AT THE CONSUMERS, which is the lesson #125's
// review paid for: a value that used to fall back to 'github' now arrives at every
// `resolveSource` caller as itself, so any gate spelled `=== 'github'` silently
// stops firing for it. Two were (lib/commands/cycle.js's gh-auth preflight and
// `ralph start`'s banner repo row) and both are now spelled `!== 'folder'` — the
// RULE, since folder mode is the one that opted out of gh, rather than the case.
// Before adding a fourth value, grep for `source ===` and decide each site
// deliberately. Those two `!== 'folder'` gates are now the loose end #127 left
// behind rather than the settled rule: the LOOP no longer runs a single `gh`
// command under 'jira', so the commands that start it are asking for an
// authentication their run will not use. Narrowing them is a follow-up, and the
// sites carry the argument in full.

export const VALID_SOURCES = ['github', 'folder', 'jira']
export const DEFAULT_SOURCE = 'github'

export function resolveSource(env = {}) {
  const raw = env?.TASK_SOURCE
  if (raw == null || String(raw).trim() === '') return DEFAULT_SOURCE
  const normalized = String(raw).trim().toLowerCase()
  return VALID_SOURCES.includes(normalized) ? normalized : DEFAULT_SOURCE
}
