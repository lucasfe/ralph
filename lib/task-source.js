// PURE task-source registry — NO I/O (#565). The single place that normalizes
// the TASK_SOURCE env var into a resolved source name. Mirrors resolveAgent in
// agent-registry.js: an unset/empty/whitespace value => github (the default,
// zero-regression path); a recognized value (case-insensitive, trimmed) => that
// source; anything else falls back to github so a typo never aborts a run.
//
// #125 ADDED jira, and it added ONLY a name. Being in this list is what makes
// `TASK_SOURCE=jira` a value rather than a typo — `ralph init --source jira`
// accepts it, lib/deps.js gates `acli` on it and `ralph doctor` reports what a
// Jira run needs — and nothing yet selects or resolves a Jira ticket. That is the
// whole point of registering the name first: a prerequisite you cannot check is a
// prerequisite people discover by having a run fail.
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
// deliberately; the loop still runs the GitHub path for anything that is not
// 'folder'.

export const VALID_SOURCES = ['github', 'folder', 'jira']
export const DEFAULT_SOURCE = 'github'

export function resolveSource(env = {}) {
  const raw = env?.TASK_SOURCE
  if (raw == null || String(raw).trim() === '') return DEFAULT_SOURCE
  const normalized = String(raw).trim().toLowerCase()
  return VALID_SOURCES.includes(normalized) ? normalized : DEFAULT_SOURCE
}
