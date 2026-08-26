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
// The live view also draws the run's TASK TABLE (#56) — one row per task, with its
// verdict, cost and duration — under a progress line that puts a denominator around the
// task in flight (`2/9 done · #031 in flight (40min)`). That line replaces #55's `in
// flight` line rather than joining it. Both come from lib/progress.js, which is also
// where the untrusted issue titles the table renders are sanitized; this file's only
// extra work is looking those titles up, best-effort, for the one surface that shows
// them.
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
  formatClock,
  formatElapsed,
  padTaskNumber,
  renderProgress,
  renderProgressLine,
  renderTaskTable,
  toJsonSnapshot,
} from '../progress.js'

// The pace/ETA/spend arithmetic AND the formatters the live view has used since #55
// live in lib/progress.js, the pure module — re-exported here so #55's callers keep
// importing them from the command that first needed them. `padTaskNumber` joined them
// in #56, when the task table gave it a second caller.
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
// `progress` is the pace/ETA/spend snapshot (#57) those three lines are rendered
// from, and it arrives as a PARAMETER because `ralph status --json` (#58) prints
// that same snapshot as a document: the shell builds ONE of them and hands it to
// whichever surface is printing, so the two cannot report different numbers. The
// default exists only so a direct caller — every test of this function — need not
// build one to render a view that has no metrics behind it; a snapshot with no
// history reads pace/ETA/spend as `unknown`, which is the honest reading.
export function renderStatus({
  mode,
  record,
  session,
  queue,
  attachable = mode === 'running',
  now,
  progress = buildProgress({ record, queue, now }),
}) {
  if (mode === 'never-run') {
    return ['▸ ralph — never-run · no run recorded yet (start one with `ralph start`)']
  }

  const runId = record?.run_id || 'unknown'

  if (mode === 'idle') {
    const finished = Date.parse(record?.finished_at)
    // `?`, not 0: a truncated or externally-written record that never recorded a
    // count must not be reported as a run that failed nothing.
    const counts = `${record?.ok ?? '?'} ok, ${record?.failed ?? '?'} failed`
    return [
      `▸ ralph — idle · last run ${runId} ended ${formatClock(finished)} ` +
        `(${record?.status ?? 'unknown'}: ${counts})`,
    ]
  }

  // running | interrupted — the live view.
  const started = Date.parse(record?.started_at)
  const table = renderTaskTable(progress)

  const lines = [
    `▸ ralph — ${mode} · run ${runId} ` +
      `(started ${formatClock(started)}, ${formatElapsed(now - started)} ago)`,
    // #55's `in flight` line, with a denominator around it (#56): it names the same
    // task and the same elapsed, and adds the fraction of the queue that is done — so
    // there is no separate `in flight` line any more, rather than two lines saying
    // half of each other.
    renderProgressLine(progress),
    // The table, standing off from the lines either side — SPREAD rather than switched
    // on, because `renderTaskTable` answers `[]` for a run with no task to row (a
    // `ralph cycle` run between tasks), and a blank line above a header over nothing
    // would be furniture. The blanks go with it.
    ...(table.length > 0 ? ['', ...table, ''] : []),
    `  queue      ${queue == null ? 'unknown' : `${queue} waiting`}`,
    // Counted facts first, then what they imply (#57): the pace this run is
    // holding, when the queue empties, and what it has cost so far.
    ...renderProgress(progress),
    '',
  ]
  if (mode === 'running' && attachable) {
    lines.push(`  attach     tmux attach -t ${session}`, '  kill       ralph stop')
  } else if (mode === 'running') {
    // A live run with no session of its own: `ralph cycle`, usually under launchd.
    // There is nothing to attach to, and `ralph start` — the advice below — is the
    // one thing that would be REFUSED while the cycle lock is held, so point at
    // the log the cycle actually writes instead.
    lines.push(
      '  scheduled  ralph cycle run — no tmux session to attach to',
      '  logs       tail -f logs/ralph-cycle.out.log',
    )
  } else {
    // Interrupted: there is no session to attach to and nothing to kill, so the
    // only useful next step is starting a fresh run.
    lines.push('  restart    ralph start')
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

  // The queue and the metrics are only rendered by the live view, so idle/never-run
  // spend nothing — no `gh` call, no directory scan, no metrics read.
  const live = mode === 'running' || mode === 'interrupted'
  // Resolved once, and read twice: the source decides how the queue is counted and
  // whether task titles can be looked up at all.
  const source = live ? taskSourceOf({ root, exists, readFile, processEnv }) : null
  const queue = live ? await countQueue({ root, exec, folderQueueCount, source }) : null
  // Read at the RUN's root, where the loop appended it — same anchor as the record
  // and the lock.
  const metricsText = live ? safeReadMetrics(readFile, metricsPath(root)) : ''
  // The task table's titles (#56) — the one read here that is a courtesy rather than a
  // fact, and priced accordingly: see readIssueTitles for why the `github` human view
  // is the only caller that pays for it.
  const titles = live && !json && source === 'github' ? await readIssueTitles({ root, exec }) : null

  // ONE clock reading for both surfaces, and one snapshot built from it (#58). The
  // human lines and the JSON document are the same numbers rendered twice, so they
  // must not be able to disagree — which they could if either surface read the
  // clock or the metrics for itself.
  //
  // `record` only when the run is LIVE: run-state's endRun deliberately leaves
  // `current` on a terminal record (it is the last task the run worked on), so
  // handing an idle record to the progress module would have it count a task in
  // flight and report a run that finished hours ago as still working. In
  // idle/never-run the snapshot is therefore built from nothing at all — no
  // metrics, no queue, no record — which is exactly the all-unknown reading those
  // modes deserve, and it keeps the document one shape instead of two.
  //
  // The gate is on the SNAPSHOT only. The projection below still gets the raw
  // record, deliberately: an idle document must name the run that just ended
  // (`run_id`), and the reason that cannot resurrect its task is that
  // `tasks.current` is gated on the snapshot's own in-flight count rather than on
  // the record it was handed.
  const nowMs = now()
  const progress = buildProgress({
    metricsText,
    record: live ? record : null,
    queue,
    now: nowMs,
    // Titles change no number, which is why fetching them for one surface and not the
    // other keeps the two honest: the document publishes none, so it is byte-identical
    // whether this is `{}`, `null` or a hundred titles.
    titles,
  })

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

// The task source, resolved the way `ralph start` resolves it: ralph.config.sh first,
// then the environment. Hoisted out of `countQueue` in #56, when the title lookup
// became a second reader of it — one resolution per command, so the two readers cannot
// disagree about which source this repo uses.
function taskSourceOf({ root, exists, readFile, processEnv }) {
  const configSourceRaw = readConfigSource(resolve(root, 'ralph.config.sh'), { exists, readFile })
  return resolveSource({ TASK_SOURCE: configSourceRaw || processEnv.TASK_SOURCE })
}

// Live queue depth, for the source already resolved above: folder mode counts the local
// .ralph/tasks tree and makes no gh call at all. Returns null — rendered as `unknown` —
// when the count fails or answers with something that is not a number, because a failed
// count must degrade, never abort a read-only status view.
async function countQueue({ root, exec, folderQueueCount, source }) {
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

// The titles the task table renders (#56) — ONE extra best-effort `gh` call, and every
// clause of that sentence is a decision:
//
// BEST-EFFORT. Titles are context for numbers that are already correct, so every
// failure — no `gh` on PATH, no auth, no network, a repo with no issues, a stdout that
// is not JSON — answers `{}` and the table renders task numbers alone, exactly as it
// does in folder mode. A read-only view must not fail over a courtesy.
//
// ONE EXTRA CALL, and only where it buys something. Skipped under `--json`, because the
// document publishes no titles and a machine consumer is the last caller that should
// pay for prose; skipped in idle/never-run, which spend nothing at all today and are
// worth keeping that way; and skipped for the `folder` source, where a title lives
// inside each task file — lib/folder-queue.js exposes counts and paths, so titling a
// folder run would cost a file read per row, which is a bigger promise than this
// courtesy is worth.
//
// `--state all`: the table's completed rows are tasks the run has just CLOSED, so a
// query scoped to open issues would title the queue and leave every row above it blank.
// The same `--limit 100` the queue count uses, and with the same consequence — a run
// reaching past the hundred most recent issues simply renders those rows unlabeled.
//
// The titles are handed on RAW. Cleaning them is lib/progress.js's job (a GitHub title
// is text somebody else wrote, and the pure module is where that is unit-tested), so
// this function's only contract is "numbers to strings, or nothing".
async function readIssueTitles({ root, exec }) {
  const listed = await exec(
    'gh',
    ['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title'],
    { cwd: root, reject: false },
  )
  if (listed?.exitCode !== 0) return {}
  const titles = {}
  try {
    for (const issue of JSON.parse(listed.stdout || '[]')) {
      if (typeof issue?.number === 'number' && Number.isFinite(issue.number)) {
        titles[issue.number] = issue.title
      }
    }
  } catch {
    return {}
  }
  return titles
}

function finiteOrNull(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

// Default folder-queue counter — the same one `ralph start` uses. Injectable in
// tests via folderQueueCount.
function defaultFolderQueueCount({ cwd }) {
  return folderQueueCountLib(resolve(cwd, '.ralph', 'tasks'))
}

export { StatusAbort }
