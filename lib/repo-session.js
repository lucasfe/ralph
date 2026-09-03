import { sessionNameFor } from './lock.js'

// #167 — "WHICH TMUX SESSION BELONGS TO THIS REPO, AND IS IT ALIVE?", answered in one
// place. Two commands still ask it with their own spelling: lib/commands/status.js (the
// `attach` hint and the `running` mode) and lib/commands/cycle.js (the guard that skips a
// scheduled tick while an interactive loop is up). This module's consumers are
// `ralph live`, its first (#167), and `ralph stop`, which moved onto it in #168 — the point
// of the second one being that the two cannot disagree about which session a repo has.
//
// THE ROOT IS THE GIT TOPLEVEL, NOT THE CWD, and that is the whole reason this is a
// module rather than two lines at a call site. `sessionNameFor` hashes the path it is
// given, so `/repo` and `/repo/lib` are two different sessions for one loop — which is
// exactly the state `ralph stop` was in before #168, and is still the state `ralph start`
// is in (start.js:684 passes its `cwd` straight through), while `ralph cycle` and
// `ralph status` resolve the toplevel first. Anchoring here is what lets `ralph live` be
// typed from `lib/` or `test/`, and `ralph stop` kill the loop from either.
//
// OUTSIDE A GIT WORK TREE IT DEGRADES TO THE CWD, the way lib/commands/status.js and
// lib/commands/schedule.js already do rather than the way lib/commands/cycle.js does
// (which aborts): a session name is a label, and a caller that wants to refuse can refuse
// on its own terms. Every unusable answer takes that path — git missing, git exiting
// non-zero, git exiting 0 with nothing to say — because they are the same finding: there
// is no toplevel to anchor on.
//
// WHAT IT DELIBERATELY DOES NOT CONSULT, both of which are consulted one layer up:
//
//   .ralph/run-state.json — `ralph status` prefers the session RECORDED there
//                           (status.js:317) because its whole job is to describe a run
//                           that may already be over. A file the loop last wrote can be
//                           stale, half-written, or from a previous checkout path; this
//                           module answers about the repo you are standing in, and the
//                           only honest way to do that is to derive the name.
//   the cycle lock        — `peekLock` lives in the very module this one imports, and
//                           liveness-of-a-cycle is a different question from
//                           liveness-of-a-session: `ralph cycle` runs the loop in the
//                           foreground with NO tmux session at all. A caller that needs
//                           both asks both, and `ralph status` does exactly that
//                           (status.js:324).
//
// `exec` HAS NO DEFAULT, on lib/jira-auth.js's convention: a caller with no way to run a
// process cannot answer this question, and the commands that can already hold a spawner
// they inject in tests. Neither probe can throw for the ordinary failures — both pass
// `{ reject: false }`, under which execa resolves a missing binary as
// `{ failed: true, exitCode: undefined }` rather than raising (measured against execa 9 in
// lib/repo-session.test.js's degradation tables).
export async function resolveRepoSession({ cwd, exec } = {}) {
  const root = await resolveRoot(exec, cwd)
  const session = sessionNameFor(root)
  // ONE has-session probe, keyed on the exit code and never on tmux's output text —
  // the rule lib/jira-auth.js states for `acli`, and for the same reason: the wording is
  // the CLI's to change between releases, the exit code is what it promises.
  const probe = await exec('tmux', ['has-session', '-t', session], { reject: false })
  return { root, session, alive: probe?.exitCode === 0 }
}

// Byte-identical to the private `resolveRoot` at lib/commands/status.js:700-704 — diffed,
// not eyeballed — and there are three more near-copies: `resolveRepoRoot` at
// lib/commands/schedule.js:670 and `resolveProjectRoot` at lib/commands/init.js:556 both
// end at the same cwd fallback, while `resolveRepoRoot` at lib/commands/cycle.js:431
// throws instead. That is a census, not a plan: none of the four is exported, and this
// function is private too, because the module's one entry point answers root, name and
// liveness TOGETHER. A caller drops its copy by wanting the name and the liveness of ONE
// resolved root — which is `ralph live` and, since #168, `ralph stop`, the second of which
// spends the root only through the name it derives — and of the rest, nobody yet:
// cycle.js:431 aborts instead of degrading, schedule.js and init.js want a root and no
// session at all, and status.js prefers the RECORDED session name over a derived one
// (status.js:317, see above). Kept as a named function rather than folded into the caller
// because the name is what says the fallback is deliberate.
async function resolveRoot(exec, cwd) {
  const probe = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, reject: false })
  if (probe?.exitCode !== 0) return cwd
  return (probe.stdout || '').trim() || cwd
}
