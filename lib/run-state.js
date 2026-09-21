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
//   beginTask(root, {number, iteration, startedAt, taskKey, worktree}, fs)
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
//   node run-state.js begin-task <root> <number> <iteration> [jiraKey] [worktree]
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
// PURE and import-free (#127), which is why a record-writer that half the repo loads can
// afford to know the Jira key grammar: no I/O, no spawner, no edges.
import { numberFromKey, usableJiraKey } from './jira-key.js'

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

export function beginTask(
  projectRoot,
  { number, iteration, startedAt, taskKey, worktree } = {},
  fsImpl,
) {
  // Read-modify-write on the run's own record. A missing/unreadable record still
  // yields a usable one (status `running`): a lost `begin` must not also lose
  // every task update after it.
  const base = readRunState(projectRoot, fsImpl) ?? { schema: SCHEMA, status: RUNNING }
  // #127: a jira task has a NAME (`FOO-123`) and `number` cannot hold it, so the
  // key is recorded BESIDE the number rather than instead of it — every reader
  // written against an integer since #55 keeps working, and the surfaces a human
  // reads gain the spelling that actually appears on the board. null for the
  // github and folder sources, which have no key.
  const key = usableJiraKey(taskKey)
  write(projectRoot, fsImpl, {
    ...base,
    status: RUNNING,
    current: {
      // The key's own number is a FALLBACK, never an override: a caller that
      // measured a number (github, folder) is telling us one, and deriving over
      // it would replace a fact with a guess. In jira mode bash has no number to
      // pass and sends `''` — the record's documented "unknown" — which is
      // exactly where the derived one belongs.
      number: toNumberOrNull(number) ?? numberFromKey(key),
      task_key: key,
      started_at: toIso(startedAt),
      iteration: toNumberOrNull(iteration),
      // #222: WHICH DIRECTORY the task is being done in. Since #218 every task runs
      // in its own git worktree, and nothing on disk said which one — so a detached
      // run left the reader to `git worktree list` and match a branch name by hand.
      // Recorded beside the task for the same reason the key is: the loop MEASURED
      // this path (lib/worktree.js printed the tree it created), and deriving
      // `<root>/.ralph/worktrees/issue-<number>` in a reader would replace that fact
      // with a guess — already wrong for a folder task, whose handle is `task-<n>`,
      // and wrong again for an iteration that never got a worktree at all.
      //
      // APPENDED LAST inside `current`, and always PRESENT: a record written before
      // this field existed still reads (readRunState hands back the disk verbatim),
      // and every writer since keeps the key so a reader can say `worktree === null`
      // rather than probing for the key's existence.
      worktree: textOrNull(worktree),
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

// A path (#222), with the same "bash spells absent as `''`" rule as the numbers above
// — and recorded VERBATIM once it is not blank. No trimming, no normalizing, no
// shortening: this value's only consumer is somebody (or something) about to `cd` into
// it, and a tidied path names a different directory or none. Blankness is decided on
// the TRIMMED text, so `'   '` from a half-expanded variable reads as unknown rather
// than as a directory called three spaces.
function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
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
        // The 4th argument is the Jira key (#127) and the 5th is the task's worktree
        // (#222); BOTH are OPTIONAL and INDEPENDENT. The github and folder arms of
        // the loop pass no key, a jira iteration passes no worktree, and bash
        // delivers an absent argument as `''`, which reads as "unknown" like every
        // other empty value here. ONE call site in ralph.sh serves all three
        // sources — and stays one call, because `begin-task` re-stamps the task's
        // `started_at` and a second call per iteration would reset the clock
        // `ralph status` subtracts to say how long the task has been running.
        //
        // A FOUR-ARGUMENT CALL STILL RECORDS THE TASK, and that is the same rule rather
        // than a second one: `rest` yields `undefined` for an argument nobody passed, and
        // `undefined` is read here exactly like the `''` bash sends for a value it does not
        // have. Tolerating a short call costs nothing; losing an iteration over a missing
        // path would be the expensive reading.
        //
        // THE VERSION-SKEW STORY IS NARROWER THAN IT LOOKS, and worth stating exactly,
        // because the loose version of it ("nothing to defend against") reads as permission
        // to delete the tolerance above. At LAUNCH the two halves always come from one
        // install: `ralph start` and `ralph cycle` run templates/ralph.sh IN PLACE from it
        // (lib/paths.js's `templatePath`) and the script derives $RALPH_PKG_DIR from its own
        // location. That is also the mixture the launchers guard — an update landing inside
        // the launching process — and they guard it by returning BEFORE they reach the
        // template: start.js's gate answers `{exitCode: 0, started: false}` from inside the
        // same command that would resolve `templatePath('ralph.sh')`, and cycle.js's does the
        // same ahead of its shell-out, so neither launcher starts a loop out of a tree IT
        // ITSELF just replaced.
        //
        // AN UPDATE LANDING AFTER LAUNCH IS NOT THEIRS TO CATCH, and that one does pair an old
        // script with a new sidecar. Bash reads a script from the descriptor it already opened:
        // replacing the file the way an install does — a new inode moved over the path — leaves
        // the running loop on the OLD text, while rewriting the same inode in place feeds it
        // NEW text from wherever it had got to. Either way the halves can disagree, because
        // every `node "$RALPH_PKG_DIR/lib/run-state.js"` re-resolves that path at call time and
        // loads whatever is there NOW. Reachable through Ralph's own machinery, too: the
        // scheduler's guards are keyed by ROOT (a `tmux has-session` on the root's session
        // name, then `acquireLock(root)`), so a cycle — or a `ralph start` — in a SECOND repo
        // reaches its own update gate, installs the new package and exits, having replaced the
        // install underneath the FIRST repo's running loop. Which is one more reason a short
        // call must still record the task.
        //
        // THE SKEW THIS FIELD MEETS EVERY DAY, THOUGH, LIVES ON DISK: a
        // `.ralph/run-state.json` written before this field existed, which readRunState hands
        // back verbatim and the read-modify-write in beginTask fills in from the next
        // iteration on.
        const [number, iteration, taskKey, worktree] = rest
        beginTask(projectRoot, { number, iteration, taskKey, worktree })
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
