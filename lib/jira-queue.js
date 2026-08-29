// Jira-mode task queue (#126). When TASK_SOURCE=jira, the queue depth comes from a Jira
// project instead of `gh issue list`: this module composes the configured JIRA_JQL (see
// jira-jql.js) and asks Atlassian's `acli` to count what matches. Structural mirror of
// folder-queue.js — a library API for the JS commands plus a node CLI the bash loop can
// shell out to — so bash holds no Jira knowledge of its own.
//
// THIS IS THE ONLY PLACE IN RALPH THAT KNOWS `acli` EXISTS as a thing you run, and the argv
// below is the interface. `lib/jira-auth.js` knows the auth subcommand for the same reason
// and in the same shape; keep both spellings in their one named place rather than inline at
// a call site, where an interface is an interface nobody finds.
//
// Library API (injectable exec for hermetic tests):
//   queueCountResult(jql, {exec}) — one probe, reported honestly: {ok, count, reason}
//   queueCount(jql, {exec})       — the same probe read as a number; 0 on anything that is
//                                   not a provable count
//
// CLI (for templates/ralph.sh, which does not read the queue from here yet):
//   node jira-queue.js count "<jql>"   → prints the count
//
// `exec` HAS NO DEFAULT, exactly as in jira-auth.js, and it is worth being precise about what
// that buys and what it does not.
//
//   WHAT IT BUYS: a defaulted parameter needs a module-scope `import { execa }`, which would
//   put execa on the import graph of EVERY importer of this file — including a command that
//   only wanted the pure count. Without the default, the spawner arrives as an argument from
//   whoever already has one: `lib/commands/status.js` and `lib/commands/cycle.js` each default
//   their own `exec = execa` from their own module-scope import (status.js:283, cycle.js:60),
//   and bin/ralph.js injects one explicitly for `doctorCommand` alone. So this module's
//   callers hold the spawner; this module never names it outside the CLI verb below, which
//   imports it lazily so it stays out of the loaded set at runtime.
//
//   WHAT IT DOES NOT BUY: reachability from `ralph doctor`. That guard
//   (doctor.version-line.qa.test.js) extracts DYNAMIC specifiers as well as static ones and
//   greps every file on the graph for the token `execa`, so this module would fail it either
//   way — the laziness is a runtime property, not a pass. THIS FILE THEREFORE MUST NOT APPEAR
//   ON DOCTOR'S GRAPH AT ALL. A diagnostic that wants Jira knowledge should import
//   ./jira-jql.js, which is pure and has no edges; anything needing a live count belongs
//   behind an injected seam the diagnostic is handed, not behind an import.
//
// TWO CALLERS, ONE PROBE, TWO LEGITIMATE DEGRADATIONS — which is why there are two
// functions rather than one, and why the second is a thin wrapper over the first:
//
//   `ralph cycle` is a SCHEDULER, and a count it cannot take means "no work I can prove",
//   which costs a tick and never a wrong one. Throwing instead would abort a scheduled run
//   over a diagnostic problem, and guessing would send the loop at a ticket it cannot even
//   see. That reading is `queueCount`, whose every failure is 0 and none of them throws.
//
//   `ralph status` is a READ-ONLY VIEW, and its job is to SAY when it does not know: a Jira
//   board nobody could reach must render `unknown`, never `0 waiting`, because `0 waiting`
//   is a claim about the board and reads as "almost done". That reading needs a signal 0
//   cannot carry — by contract 0 is also a real, empty queue — so it consumes
//   `queueCountResult`, whose `ok:false` is the "nobody took a count" that `finiteOrNull`
//   in status.js turns into null.
//
// The failures are identical for both; only the sentence each caller reads out of them
// differs. Keeping the probe single means a new failure mode is handled once, and neither
// posture can drift into being the other one's bug.

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { composeJiraJql } from './jira-jql.js'

// The argv, in its one named place — see the header. A function rather than a constant only
// because the composed query is an argument; the shape around it is the interface. MODULE-
// PRIVATE, like ACLI_JIRA_AUTH_STATUS_ARGV in jira-auth.js: naming it is for readers of this
// file, and exporting it would invite a second caller to know what Ralph runs. Tests reach it
// through the argv `queueCountResult` records on the injected `exec`.
const acliCountArgv = (jql) => ['jira', 'workitem', 'search', '--jql', jql, '--count']

// A DIGIT STRING AND NOTHING ELSE. `Number('')` is 0 and `Number('  7 ')` is 7, so a
// tolerant parse would read an empty answer — the shape a broken spawn produces — as a
// real count of zero, and would accept `1e3`, `0x10` and `-3` as counts too. A count acli
// did not clearly report is not a count, so it comes back as null and NOT as 0: telling the
// two apart is the whole point of `queueCountResult` below.
function parseCount(stdout) {
  const raw = (typeof stdout === 'string' ? stdout : (stdout?.toString?.() ?? '')).trim()
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

const noCount = (reason) => ({ ok: false, count: null, reason })

/**
 * Ask acli how many Jira work items match the configured eligibility query, and report the
 * answer WITH ITS PROVENANCE: `ok:false` is "nobody took a count", which 0 cannot mean here
 * because 0 is also a real, empty queue. Never throws; every failure is a value.
 *
 * Same discriminated shape as its pure sibling `composeJiraJql` — {ok, <payload>, reason},
 * reason a sentence when there is nothing to report and null when there is.
 *
 * @param {string} jql the raw JIRA_JQL value from ralph.config.sh
 * @param {{ exec?: Function }} [deps] injected process spawner (no default — see above)
 * @returns {Promise<{ok: boolean, count: number|null, reason: string|null}>}
 */
export async function queueCountResult(jql, { exec } = {}) {
  const composed = composeJiraJql(jql)
  // A misconfigured JIRA_JQL SPAWNS NOTHING. Ralph's half of the query on its own selects
  // every work item on the Jira site, so there is no query to fall back to here. The
  // composer's own sentence is forwarded rather than restated — it is the one that names the
  // knob the reader has to go and fix.
  if (!composed.ok) return noCount(composed.reason)

  let r
  try {
    r = await exec('acli', acliCountArgv(composed.jql), { reject: false })
  } catch (err) {
    // A missing/unusable `exec` lands here too (calling a non-function throws), which is why
    // there is no separate guard for it: both mean "no process was run".
    return noCount(`acli could not be run: ${err?.message || 'unknown error'}`)
  }

  // EXIT CODE FIRST, text second — the same rule jira-auth.js keys on. A non-zero exit with a
  // number on stdout is not a count; it is a CLI explaining itself. A result with no exitCode
  // at all (execa's ENOENT shape, a spawn that never happened) fails the same test.
  if (!r || r.exitCode !== 0) {
    return noCount('acli did not exit cleanly — is it installed, and is the session logged in?')
  }

  // READING the text is inside the guard too, not just parsing it: `stdout` may be a getter on
  // a destroyed stream, or an object whose `toString` explodes. Both are the same finding as
  // prose on stdout — nothing countable came back — and neither may escape as a throw.
  let count
  try {
    count = parseCount(r.stdout)
  } catch {
    count = null
  }
  if (count === null) {
    return noCount('acli exited cleanly but printed no count Ralph could read')
  }
  return { ok: true, count, reason: null }
}

/**
 * How many Jira work items are waiting, per the configured eligibility query — the SCHEDULER's
 * reading of the probe above, in which anything unprovable is 0. Deliberately lossy, and a
 * wrapper rather than a second copy of the logic so the two readings cannot drift apart.
 *
 * @param {string} jql the raw JIRA_JQL value from ralph.config.sh
 * @param {{ exec?: Function }} [deps] injected process spawner (no default — see above)
 * @returns {Promise<number>} the count, or 0 when it cannot be proven
 */
export async function queueCount(jql, deps) {
  const result = await queueCountResult(jql, deps)
  return result.ok ? result.count : 0
}

// --- CLI entrypoint (for templates/ralph.sh) --------------------------------
// Async, unlike folder-queue.js's, for one reason: the spawner is resolved HERE rather than
// at module scope, so a command that only wants the library never loads execa.
async function runCli(argv) {
  const [cmd, jql] = argv
  if (!cmd || !jql) {
    process.stderr.write('usage: jira-queue.js count "<jql>"\n')
    return 2
  }
  switch (cmd) {
    case 'count': {
      const { execa } = await import('execa')
      process.stdout.write(String(await queueCount(jql, { exec: execa })) + '\n')
      return 0
    }
    default:
      process.stderr.write(`jira-queue.js: unknown command '${cmd}'\n`)
      return 2
  }
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code))
}
