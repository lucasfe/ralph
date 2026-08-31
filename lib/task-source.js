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
// makes the queue drain either way. #131 then gave the arm its TELEMETRY: one
// RALPH_ISSUE_EVENT per iteration, like the other two sources, carrying the ticket key as
// a `task_key` field of its own beside the number derived from it — so `ralph status`, the
// digest and `ralph cycle`'s counts finally have a per-iteration record of a Jira run.
//
// DEFAULT_SOURCE and the unknown-value fallback are deliberately untouched. A new
// member of this list must not move either, or every repo whose ralph.config.sh
// predates it changes behaviour on upgrade.
//
// AND ADDING A NAME HERE IS NOT INERT AT THE CONSUMERS, which is the lesson #125's
// review paid for: a value that used to fall back to 'github' now arrives at every
// `resolveSource` caller as itself, so any gate spelled `=== 'github'` silently
// stops firing for it. Two were (lib/commands/cycle.js's gh-auth preflight and
// `ralph start`'s banner repo row) and both were respelled `!== 'folder'` — the RULE,
// since folder mode was the one that opted out of gh, rather than the case. Before
// adding a fourth value, grep for `source ===` and decide each site deliberately.
//
// #127 THEN MADE `!== 'folder'` THE LOOSE END rather than the settled rule, for the two
// gates that spend a CREDENTIAL: the LOOP runs no `gh` command at all under 'jira'
// (measured in test/loop.jira.adversarial.test.js), so the commands that start it were
// asking for an authentication their run will not use. #134 closed one of the two.
// Where each site stands now:
//
//   lib/commands/cycle.js's preflight — NARROWED. It keys on all three sources: gh auth
//   for github (via `worksThroughGitHub` below), `acli jira auth status` for jira, and
//   nothing at all for folder.
//
//   `ralph start`'s step-4 gh-auth gate (./commands/start.js) — STILL `!== 'folder'`,
//   because passing it is what keeps steps 6, 7 and 8 (label creation, the orphan sweep,
//   and a queue check taken from GitHub) legible under 'jira'; nothing has moved those to
//   Jira. Outstanding debt, argued in full at the site.
//
//   `ralph start`'s steps 6+7 (./commands/start.js, the third live check, at line 746) — STILL
//   `!== 'folder'`, and part of the same debt as the gate above: it is what SPENDS the gh
//   auth that gate demands, creating the issue labels and running the orphan sweep against
//   the GitHub board under 'jira'. Narrowing the gate without narrowing this would abort
//   the run later instead of earlier, so the two move together.
//
//   `ralph start`'s banner repo row — STILL `!== 'folder'`, and NOT part of that debt: it
//   draws a row rather than demanding a credential, and `start` does still read GitHub
//   issues under 'jira', which is what the row names.
//
// The last three are every LIVE `!== 'folder'` left in the two commands — all in start.js,
// at its lines 542, 715 and 746; grep it, and note that cycle.js's remaining matches are
// this argument's own prose, not a check. One credential site is
// NOT in the list because it carries no source check at ALL: `ralph cycle`'s own orphan
// sweep runs for every source, so a 'jira' cycle still spawns `gh issue list` and can still
// `gh issue edit --remove-label` a GitHub issue. #134 left that alone deliberately;
// source-gating it is the follow-up.
//
// `worksThroughGitHub` BELOW IS THE ANSWER TO THAT LESSON, and #131 is the slice that
// needed it. Its telemetry sidecar had two gates spelled `!== 'folder'` — where the verdict
// comes from (github's issue labels, or the source's own recorded outcome) and whether there
// is a pull request to diff — from back when 'folder' was the only source that had opted
// out of GitHub's bookkeeping. Adding jira to a
// `!==` chain is exactly the shape the paragraph above warns about: the chain answers
// correctly only for the values somebody remembered to add, so the DEFAULT for a name
// nobody updated is the github treatment — a `gh` call in a run that has no GitHub at all.
// Spelled as an ALLOWLIST of one, a fourth source gets the safe answer by default and has
// to opt IN to GitHub's bookkeeping, which is a decision a reader can see being made.
//
// ONE SOURCE-KEYED CHOICE IN THAT SAME FILE IS STILL A TERNARY, and this paragraph scopes the
// claim above rather than adding a rule: `resolveTaskNumber` reads
// `source === 'folder' ? RALPH_TASK_ID : RALPH_ISSUE_NUMBER`, so a fourth source would be
// handed github's variable there too. Left for now because the COST of that default differs
// in kind — an unrecognised source gets a variable it never exported, which parses to null,
// the record's documented "unknown", and nothing else happens: no subprocess, no `gh`, no
// verdict read off another repo's labels. The two gates above took an ACTION in the wrong
// place, which is why they went first; this one is the next seam, not a finished one.

export const VALID_SOURCES = ['github', 'folder', 'jira']
export const DEFAULT_SOURCE = 'github'

export function resolveSource(env = {}) {
  const raw = env?.TASK_SOURCE
  if (raw == null || String(raw).trim() === '') return DEFAULT_SOURCE
  const normalized = String(raw).trim().toLowerCase()
  return VALID_SOURCES.includes(normalized) ? normalized : DEFAULT_SOURCE
}

/**
 * Does this source do its bookkeeping on GitHub — an issue whose labels and state ARE the
 * outcome, and a pull request carrying the diff? One source does, and the other two report
 * what became of their task themselves (folder by the terminal directory it ends in, jira
 * by the label the board carries), so nothing about them can be read out of `gh`.
 *
 * Takes a RESOLVED source (the output of `resolveSource`), so an unset or unrecognised
 * TASK_SOURCE has already become 'github' and keeps the behaviour it has always had.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function worksThroughGitHub(source) {
  return source === 'github'
}
