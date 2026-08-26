// `ralph status` (#55) — a minimal live view of the run in progress: which run,
// how long it has been going, which task is in flight and for how long, how deep
// the queue is right now, and how to reach the run — the session's attach/kill
// pair for a `ralph start` run, the log to follow for a `ralph cycle` one, which
// has no session to attach to at all.
//
// FOUR modes, reconciled from the record against run liveness: running,
// interrupted, idle, never-run. All four exit 0 and none of them writes anything
// — a read-only view must never disturb the run it reports on.
//
// The live view also carries the run's pace, its ETA and its spend (#57). All of
// that arithmetic is policy, so it lives in lib/progress.js; this file only reads
// issues.jsonl — through the never-throws guard every consumer of that file shares
// (lib/issue-metrics.js), because a read-only view must never abort over its own
// telemetry — and hands the text to the pure path.
//
// TWO VIEWS, not one (#59). `running` gets the live view above. `idle` and
// `interrupted` get the morning-after REPORT CARD — outcome counts, the failed task
// numbers, the night's spend, the wall clock, when it ended and how long ago — whose
// policy lives in lib/post-mortem.js, because a finished run has no pace and no ETA
// to report and every number on it is a fact rather than an extrapolation. So idle
// and interrupted now count the queue and read issues.jsonl too. `never-run` still
// reads NOTHING at all — no gh call, no metrics, no config — because there is no run
// to report on and a one-line pointer at `ralph start` needs no inputs.
//
// `--json` prints the same snapshot as a machine-readable document instead of the
// human lines (#58) — the SAME snapshot, built once here and handed to whichever
// renderer is printing, so a prompt or a notifier driven off the document can never
// report something the terminal does not. Under the flag stdout carries the
// document and nothing else, so `ralph status --json | jq` works in all four modes.
//
// Shape: a thin I/O shell (resolve the git toplevel, read the record, probe
// liveness — tmux session OR cycle lock — resolve the task source, count the
// queue, read the metrics) around two pure functions — reconcileMode() and
// renderStatus() — so every judgement and every string is unit-testable without a
// clock, a filesystem or a subprocess. lib/run-state.js owns the record's fields;
// this file never writes one.

import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execa } from 'execa'
import { peekLock as defaultPeekLock, sessionNameFor } from '../lock.js'
import { readRunState as defaultReadRunState } from '../run-state.js'
import { readConfigSource } from '../read-config-source.js'
import { resolveSource } from '../task-source.js'
import { queueCount as folderQueueCountLib } from '../folder-queue.js'
import { metricsPath, safeReadMetrics } from '../issue-metrics.js'
import {
  buildProgress,
  finiteOrNull,
  formatClock,
  formatElapsed,
  padTaskNumber,
  renderProgress,
  toJsonSnapshot,
} from '../progress.js'
import { buildPostMortem, renderPostMortem } from '../post-mortem.js'

// The pace/ETA/spend arithmetic AND the three formatters the live view has used
// since #55 live in lib/progress.js, the pure module — re-exported here so #55's
// callers keep importing them from the command that first needed them.
export { formatClock, formatElapsed, padTaskNumber }

// Same query `ralph start` and the loop use, so "6 waiting" here means the same
// six items the loop would pick up next.
const SEARCH_QUERY =
  'state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge'

// Declared with no throw site yet, on purpose: `status` is a read-only view and
// every mode — including a missing record, a cwd outside a repo and a failed
// queue count — is a successful read, so it has no failure of its own to report.
// Kept for wiring symmetry with the other command blocks in bin/ralph.js, which
// all catch their own Abort type.
class StatusAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

// The whole four-mode decision, as one rule: a `running` record is believed only
// while the RUN that wrote it is still alive — otherwise a hard-killed run (tmux
// kill-session, a reboot) would read as eternally in flight, because nothing gets
// to write a terminal record on the way out.
//
// `runAlive`, not `sessionAlive`: tmux is only one of the loop's two launchers.
// `ralph cycle` spawns the same loop with no session of its own, and proves it is
// alive by holding the cycle lock instead. Which of the two answered is the
// caller's business; this rule stays one rule rather than growing a branch per
// launcher.
export function reconcileMode({ record, runAlive }) {
  if (!record) return 'never-run'
  if (record.status !== 'running') return 'idle'
  return runAlive ? 'running' : 'interrupted'
}

// PURE renderer: mode + record + queue + the progress snapshot + an injected `now`
// (epoch ms) in, lines out. No I/O, no Date.now — the hermetic suite pins the
// exact output.
//
// `attachable` splits the two shapes a live run can have: a tmux-launched run you
// can attach to and kill, versus a scheduled `ralph cycle` run with no session at
// all. It defaults to the tmux shape of a `running` mode; statusCommand always
// passes it explicitly, from the probe that actually answered.
//
// `progress` and `postMortem` are the two snapshots the two views render from
// (#57, #59), and they arrive as PARAMETERS because `ralph status --json` (#58)
// prints the progress one as a document: the shell builds ONE of each and hands
// them to whichever surface is printing, so no two surfaces can report different
// numbers. The defaults exist only so a direct caller — every test of this function
// — need not build one to render a view that has no metrics behind it; a snapshot
// with no history reads every derived number as `unknown`, the honest reading.
export function renderStatus({
  mode,
  record,
  session,
  queue,
  attachable = mode === 'running',
  now,
  progress = buildProgress({ record, queue, now }),
  postMortem = buildPostMortem({ record, queue, now }),
}) {
  // Nothing to report and nothing read to report it from: one friendly line, not an
  // error and not a table of `unknown`.
  if (mode === 'never-run') {
    return ['▸ ralph — never-run · no run recorded yet (start one with `ralph start`)']
  }

  // idle | interrupted — the report card (#59). An interrupted run gets one too,
  // rather than the live view's pace and ETA: it is over, whatever it managed to
  // finish is all there is to say, and a projection for a run that will never pick up
  // another task is an invented number.
  if (mode !== 'running') return renderPostMortem(postMortem)

  const runId = record?.run_id || 'unknown'
  const started = Date.parse(record?.started_at)
  const task = record?.current
  const taskStarted = Date.parse(task?.started_at)
  const inFlight = task
    ? `#${padTaskNumber(task.number)} (${formatElapsed(now - taskStarted)})`
    : 'none yet'

  const lines = [
    `▸ ralph — ${mode} · run ${runId} ` +
      `(started ${formatClock(started)}, ${formatElapsed(now - started)} ago)`,
    `  in flight  ${inFlight}`,
    `  queue      ${queue == null ? 'unknown' : `${queue} waiting`}`,
    // Counted facts first, then what they imply (#57): the pace this run is
    // holding, when the queue empties, and what it has cost so far.
    ...renderProgress(progress),
    '',
  ]
  if (attachable) {
    lines.push(`  attach     tmux attach -t ${session}`, '  kill       ralph stop')
  } else {
    // A live run with no session of its own: `ralph cycle`, usually under launchd.
    // There is nothing to attach to, and `ralph start` — the advice the report card
    // gives — is the one thing that would be REFUSED while the cycle lock is held,
    // so point at the log the cycle actually writes instead.
    lines.push(
      '  scheduled  ralph cycle run — no tmux session to attach to',
      '  logs       tail -f logs/ralph-cycle.out.log',
    )
  }
  return lines
}

// No `stderr` in the deps bag, unlike the other commands: every mode here is a
// successful read, so there is nothing to write to it — and under `--json` (#58)
// that absence is load-bearing rather than incidental. A diagnostic would have to
// go to stderr to keep stdout pipeable, and the reason there is no such write
// anywhere below is that there is no diagnostic to make: a missing record, a cwd
// outside a repo, a failed queue count and an unreadable issues.jsonl all resolve
// to a `null` leaf in the document, which SAYS "unknown" more usefully to a
// consumer than a line of prose it would have to parse.
export async function statusCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  exec = execa,
  exists = realExistsSync,
  readFile = realReadFileSync,
  readRunState = defaultReadRunState,
  folderQueueCount = defaultFolderQueueCount,
  peekLock = defaultPeekLock,
  now = Date.now,
  processEnv = process.env,
  json = false,
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')

  // Anchor on the git toplevel, not the cwd. The record is written by a process
  // anchored there (the loop's PROJECT_ROOT), the cycle lock is keyed on that same
  // path, and `ralph cycle`/`ralph schedule` resolve it the same way — a reader
  // that anchored on the cwd would report `never-run` from any subdirectory of a
  // repo with a live run, and then advise the `ralph start` that would launch a
  // second loop on it. Degrades to the cwd instead of aborting: a read-only view
  // outside a repo should still print `never-run`.
  const root = await resolveRoot(exec, cwd)

  const record = readRunState(root)

  // Probe the session the RUN recorded, not the one a fresh `ralph start` would
  // create: those differ when the record was written elsewhere (a cycle run
  // records the default `ralph`), and liveness is a question about THIS run.
  const session = record?.session || sessionNameFor(root)
  const has = await exec('tmux', ['has-session', '-t', session], { reject: false })
  const tmuxAlive = has?.exitCode === 0

  // Two ways a run proves it is alive, cheapest first: its tmux session, or the
  // cycle lock a `ralph cycle` run holds for its whole duration. The `||` also
  // keeps the lock read off the common path.
  const runAlive = tmuxAlive || Boolean(safePeekLock(peekLock, root)?.alive)
  const mode = reconcileMode({ record, runAlive })

  // Is this run still going? The one fact both snapshots below hang off, and the
  // reason `interrupted` — a record still saying `running` with no process behind
  // it — is not treated as live by either of them.
  const live = mode === 'running' || mode === 'interrupted'
  const hasRun = mode !== 'never-run'

  // THE READ PLAN, decided by what the surface about to print will actually USE
  // rather than by the mode alone (#59 review). A `gh` call and a file read are what
  // this command costs, and a user drives it off a prompt timer.
  //
  //   the card     — needs both for any mode with a record: it reports the ended
  //                  run's outcome and spend, and the queue waiting for the next one.
  //   the document — reports measurements only for the modes whose snapshot is built
  //                  from them (see the seam below), so an idle `--json` run would be
  //                  paying for a queue count its own document publishes as `null`.
  //   never-run    — reads NOTHING under either flag: no `gh` call, no directory scan,
  //                  no metrics read, not even the config read that chooses between
  //                  them, because a repo with no record has nothing they could say
  //                  anything about.
  const measured = json ? live : hasRun
  const queue = measured
    ? await countQueue({ root, exec, exists, readFile, folderQueueCount, processEnv })
    : null
  // Read at the RUN's root, where the loop appended it — same anchor as the record
  // and the lock.
  const metricsText = measured ? safeReadMetrics(readFile, metricsPath(root)) : ''

  // ONE clock reading for every surface, and one snapshot per view built from it
  // (#58). The human lines and the JSON document are the same numbers rendered twice,
  // so they must not be able to disagree — which they could if either surface read
  // the clock or the metrics for itself.
  //
  // `live`, not `hasRun`: nothing measured is handed to the progress snapshot unless
  // the run is in flight. run-state's endRun deliberately leaves `current` on a
  // terminal record (it is the last task the run worked on), so handing an idle record
  // to the progress module would have it count a task in flight and report a run that
  // finished hours ago as still working — and its pace would fall back to the all-time
  // mean over a file that outlives every run. In idle/never-run the snapshot is
  // therefore built from nothing at all, which is exactly the all-unknown reading
  // those modes deserve, and it keeps the document one shape instead of two.
  //
  // `runAlive` is the SAME question one layer down, and it is what keeps the two
  // surfaces from contradicting each other over an interrupted run (#59 review): that
  // mode's document does report the measurements above — the run really did complete
  // those tasks at that pace for that money — but the run is over, so there is no task
  // in flight to name and no future to extrapolate. Passing the fact rather than
  // nulling six fields is what keeps it one rule; see buildProgress for what hangs off
  // it.
  //
  // DELIBERATE ASYMMETRY, and it will be flagged on the PR rather than fixed here:
  // the report card below reports an idle run's spend from the same metrics text this
  // gate withholds from the document, so `ralph status` prints a total that
  // `ralph status --json` reports as `null` for the same repo. `--json` is #58's
  // published contract and a key in a document is the one thing that cannot be fixed
  // after release, so #59 leaves the document exactly as shipped; teaching it to
  // publish a terminal run's outcome is its own change, with its own keys.
  //
  // The gate is on the SNAPSHOT only. The projection below still gets the raw
  // record, deliberately: an idle document must name the run that just ended
  // (`run_id`), and the reason that cannot resurrect its task is that
  // `tasks.current` is gated on the snapshot's own in-flight count rather than on
  // the record it was handed.
  const nowMs = now()
  const progress = buildProgress({
    metricsText: live ? metricsText : '',
    record: live ? record : null,
    queue: live ? queue : null,
    now: nowMs,
    runAlive: mode === 'running',
  })
  // ...and the report card the two ended modes render from (#59), built here for the
  // same reason: one snapshot, from one clock reading and one read of each input.
  const postMortem = buildPostMortem({ metricsText, record, queue, now: nowMs })

  if (json) {
    // The document, and NOTHING else on stdout: no heading, no advice, no
    // trailing blank line. One line, compact, newline-terminated — `jq` and a
    // line-buffered status line both want a whole document per read, and a
    // pretty-printed one would only be re-formatted by whatever consumes it.
    out(JSON.stringify(toJsonSnapshot(progress, { mode, record })))
    return { exitCode: 0, mode, record, queue }
  }

  const lines = renderStatus({
    mode,
    record,
    session,
    queue,
    attachable: tmuxAlive,
    now: nowMs,
    progress,
    postMortem,
  })
  for (const line of lines) out(line)

  return { exitCode: 0, mode, record, queue }
}

// The repo root, the way `ralph cycle` and `ralph schedule` resolve it — minus the
// abort: outside a git work tree the cwd is a good enough anchor for a read.
async function resolveRoot(exec, cwd) {
  const probe = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, reject: false })
  if (probe?.exitCode !== 0) return cwd
  return (probe.stdout || '').trim() || cwd
}

// Same guard `ralph schedule status` puts around its lock read: a lock this
// command only consults for liveness must never be the thing that breaks the view.
function safePeekLock(peekLock, root) {
  try {
    return peekLock(root)
  } catch {
    return null
  }
}

// Live queue depth, resolved the way `ralph start` resolves it: the task source
// comes from ralph.config.sh, folder mode counts the local .ralph/tasks tree and
// makes no gh call at all. Returns null — rendered as `unknown` — when the count
// fails or answers with something that is not a number, because a failed count
// must degrade, never abort a read-only status view.
async function countQueue({ root, exec, exists, readFile, folderQueueCount, processEnv }) {
  const configSourceRaw = readConfigSource(resolve(root, 'ralph.config.sh'), { exists, readFile })
  const source = resolveSource({ TASK_SOURCE: configSourceRaw || processEnv.TASK_SOURCE })

  if (source === 'folder') {
    try {
      return finiteOrNull(await folderQueueCount({ cwd: root }))
    } catch {
      return null
    }
  }

  const queue = await exec(
    'gh',
    ['issue', 'list', '--search', SEARCH_QUERY, '--limit', '100', '--json', 'number', '-q', '. | length'],
    // At the root, like every other gh call in the CLI: gh reads the repo off the
    // git remote of its cwd.
    { cwd: root, reject: false },
  )
  if (queue?.exitCode !== 0) return null
  const raw = (queue.stdout || '').trim()
  return raw === '' ? null : finiteOrNull(Number(raw))
}

// Default folder-queue counter — the same one `ralph start` uses. Injectable in
// tests via folderQueueCount.
function defaultFolderQueueCount({ cwd }) {
  return folderQueueCountLib(resolve(cwd, '.ralph', 'tasks'))
}

export { StatusAbort }
