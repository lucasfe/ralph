// Run state (#55). ONE small JSON record under `.ralph/run-state.json` saying
// what a Ralph run is doing right now: which run it is, which task is in flight,
// and how it ended. Without it a detached run is unobservable — the `==>
// Iteration for issue #N` line exists only in the tmux pane's scrollback, so
// nothing on disk answers "what is Ralph on?". `ralph status` reads this file.
//
// This module is the SINGLE owner of the record's shape: neither the bash loop
// nor `ralph status` knows a field name. It follows the injectable-fs pattern of
// state.js / issue-metrics.js and doubles as a node CLI the loop shells out to
// (mirroring folder-queue.js / capture-issue-event.js), so bash only passes
// values it already has.
//
// NOT `.ralph/state.json`: that file is the config-hash/validation state owned by
// state.js and rewritten by the agent during lazy validation. This is a separate
// file with a separate lifetime (one run) on purpose.
//
// Library API (injectable fs for hermetic tests — the issue's begin/beginTask/
// end/read):
//   beginRun(root, {runId, session, source, queueDepth, startedAt}, fs)
//                                     — fresh `running` record for a new run
//   beginTask(root, {number, iteration, startedAt}, fs)
//                                     — the in-flight task, run fields kept
//   endRun(root, {status, ok, failed, finishedAt}, fs)
//                                     — terminal record (success/partial/failed)
//   readRunState(root, fs)            — the record, or null. NEVER throws:
//                                       missing, empty, truncated, malformed and
//                                       unreadable all read as "no record".
//   runStatePath(root)                — where the record lives
//
// CLI (for templates/ralph.sh — every call site there is best-effort `|| true`):
//   node run-state.js begin <root> <runId> <session> <source> <queueDepth>
//   node run-state.js begin-task <root> <number> <iteration>
//   node run-state.js end <root> <status> <ok> <failed>
//   node run-state.js read <root>     → prints the record as JSON, or nothing
//
// The writers deliberately do NOT swallow their own errors: the caller decides
// what a failed write means. Bash says `|| true` (an unwritable .ralph/ must
// never change a run's outcome) and the CLI below turns a throw into one terse
// stderr line plus a non-zero exit — never a stack trace in the tmux pane.

import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  readFileSync as realReadFileSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Recorded for future migrations; no reader inspects it yet. readRunState returns
// a record whose schema is absent, or from the future, verbatim — only an
// unreadable or non-object record reads as missing.
const SCHEMA = 1
const RUNNING = 'running'

export function runStatePath(projectRoot) {
  return join(projectRoot, '.ralph', 'run-state.json')
}

export function beginRun(projectRoot, { runId, session, source, queueDepth, startedAt } = {}, fsImpl) {
  // A fresh record, NOT a merge: a new run must never inherit the previous run's
  // in-flight task, or a crashed run's `current` would be reported as this one's.
  write(projectRoot, fsImpl, {
    schema: SCHEMA,
    run_id: runId ?? null,
    session: session ?? null,
    source: source ?? null,
    status: RUNNING,
    started_at: toIso(startedAt),
    queue_at_start: toNumberOrNull(queueDepth),
    current: null,
    finished_at: null,
    ok: null,
    failed: null,
  })
}

export function beginTask(projectRoot, { number, iteration, startedAt } = {}, fsImpl) {
  // Read-modify-write on the run's own record. A missing/unreadable record still
  // yields a usable one (status `running`): a lost `begin` must not also lose
  // every task update after it.
  const base = readRunState(projectRoot, fsImpl) ?? { schema: SCHEMA, status: RUNNING }
  write(projectRoot, fsImpl, {
    ...base,
    status: RUNNING,
    current: {
      number: toNumberOrNull(number),
      started_at: toIso(startedAt),
      iteration: toNumberOrNull(iteration),
    },
  })
}

export function endRun(projectRoot, { status, ok, failed, finishedAt } = {}, fsImpl) {
  // `current` is left as-is: on a terminal record it is the last task the run
  // worked on, which is what an interrupted-vs-finished readout wants to show.
  const base = readRunState(projectRoot, fsImpl) ?? { schema: SCHEMA }
  write(projectRoot, fsImpl, {
    ...base,
    status: status ?? 'unknown',
    finished_at: toIso(finishedAt),
    ok: toNumberOrNull(ok),
    failed: toNumberOrNull(failed),
  })
}

export function readRunState(projectRoot, fsImpl) {
  const fs = wrapRead(fsImpl)
  const path = runStatePath(projectRoot)
  let raw
  try {
    if (!fs.existsSync(path)) return null
    raw = fs.readFileSync(path, 'utf8').toString()
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Empty, truncated (a run killed mid-write) or plain garbage.
    return null
  }
  // Valid JSON that is not a record (array, scalar, null) is no record.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

function write(projectRoot, fsImpl, record) {
  const fs = wrapWrite(fsImpl)
  const path = runStatePath(projectRoot)
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
}

// Bash hands everything over as a string, and an empty one means "unknown"
// (e.g. a queue count whose `gh` call failed) — never 0, which would be a lie.
function toNumberOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// Accepts a Date, an epoch-ms number or an ISO string; anything else (including
// nothing) stamps now, since every call site records a moment that just happened.
function toIso(value) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && value !== '') return value
  return new Date().toISOString()
}

function wrapRead(fsImpl) {
  if (!fsImpl) {
    return { existsSync: realExistsSync, readFileSync: realReadFileSync }
  }
  return {
    existsSync: fsImpl.existsSync.bind(fsImpl),
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
  }
}

function wrapWrite(fsImpl) {
  if (!fsImpl) {
    return { mkdirSync: realMkdirSync, writeFileSync: realWriteFileSync }
  }
  return {
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
    writeFileSync: fsImpl.writeFileSync.bind(fsImpl),
  }
}

// --- CLI entrypoint (for templates/ralph.sh) --------------------------------
function runCli(argv) {
  const [cmd, projectRoot, ...rest] = argv
  if (!cmd || !projectRoot) {
    process.stderr.write(
      'usage: run-state.js <begin|begin-task|end|read> <projectRoot> [args]\n',
    )
    return 2
  }
  try {
    switch (cmd) {
      case 'begin': {
        const [runId, session, source, queueDepth] = rest
        beginRun(projectRoot, { runId, session, source, queueDepth })
        return 0
      }
      case 'begin-task': {
        const [number, iteration] = rest
        beginTask(projectRoot, { number, iteration })
        return 0
      }
      case 'end': {
        const [status, ok, failed] = rest
        endRun(projectRoot, { status, ok, failed })
        return 0
      }
      case 'read': {
        const record = readRunState(projectRoot)
        if (record) process.stdout.write(JSON.stringify(record) + '\n')
        return 0
      }
      default:
        process.stderr.write(`run-state.js: unknown command '${cmd}'\n`)
        return 2
    }
  } catch (e) {
    // One line, no stack: this runs inside the loop's tmux pane, where a
    // stack trace from an observability sidecar is pure noise. The loop's
    // `|| true` is what keeps the run itself unaffected.
    process.stderr.write(`run-state.js: ${cmd} failed (${e?.message ?? 'unknown error'})\n`)
    return 1
  }
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  process.exit(runCli(process.argv.slice(2)))
}
