// Jira auth probe with an INJECTABLE exec dependency (#125). Returns
// { ok, reason } (async). Modelled on lib/agent-auth.js's codex arm, and for the
// same reasons — read that file first; this one is deliberately its shape.
//
//   Jira — run `acli jira auth status` and key on the EXIT CODE ONLY, never on
//          output text. A CLI is free to change its wording between releases, to
//          localise it, or to print something alarming on the way to exiting
//          zero; the exit code is the part it promises. A throw (no acli on PATH,
//          a spawn failure) or a non-zero exit both mean `ok: false` — this probe
//          reports, it never raises.
//
// TWO STATES ONLY, and a caller that needs three must add the third ITSELF. This
// function answers `ok: false` for a missing or unusable `exec` too, because a
// boolean has nowhere else to put it — but "acli said no" and "nobody could ask
// acli" are different findings, and `reason` does not distinguish them either.
// lib/commands/doctor.js therefore checks the seam BEFORE probing and renders the
// second case as "not verified"; do the same rather than reading an `ok: false` from
// here as a login failure — unless, like the second caller below, both cases mean the
// same thing to you.
//
// TWO CALLERS SINCE #134, which is the point of the function rather than an accident:
// `ralph doctor`'s jira auth row, and `ralph cycle`'s preflight, which refuses to start
// a `jira` run whose session cannot be proved. Sharing this function — not just the
// acli invocation — is what makes it impossible for the diagnostic to report healthy on
// a machine where the loop will not start. The cycle collapses the three states into
// two on purpose: it holds a real spawner and cannot proceed either way, so it phrases
// `ok: false` as one actionable abort naming `acli jira auth login` rather than
// distinguishing findings a scheduled run can do nothing about. `reason` is deliberately
// remedy-free here so neither caller has to strip the other's phrasing.
//
// THIS MODULE IMPORTS NOTHING, and that is load-bearing rather than tidy.
// `ralph doctor` calls it, and lib/commands/doctor.version-line.qa.test.js walks
// doctor.js's whole transitive import graph to assert the diagnostic can reach no
// process spawner and no socket — it even greps the comment-stripped source of
// every file on that graph for the name of the library that would do it. So the
// spawner arrives as an argument from bin/ralph.js and never as an import here.
// `exec` therefore has NO DEFAULT: a caller with no way to run acli is a caller
// that cannot answer this question, which is a state doctor renders as "not
// verified" rather than as a failure.

// The acli auth subcommand, kept in one named place exactly as
// CODEX_LOGIN_STATUS_ARGV is in lib/agent-auth.js: the argv is the interface, and
// an interface spelled inline at its one call site is an interface nobody finds.
const ACLI_JIRA_AUTH_STATUS_ARGV = ['jira', 'auth', 'status']

export async function probeJiraAuth({ exec } = {}) {
  try {
    const r = await exec('acli', ACLI_JIRA_AUTH_STATUS_ARGV, { reject: false })
    // EXIT CODE ONLY — never parse stdout/stderr text.
    if (r && r.exitCode === 0) return { ok: true, reason: null }
  } catch {
    // A missing/unusable `exec` lands here too (calling a non-function throws),
    // which is why there is no separate guard for it: both mean the same thing.
  }
  return { ok: false, reason: 'jira not authenticated' }
}
