import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

// Issue #55 — the loop must leave a run-state record on disk so a DETACHED run
// is observable (`ralph status` reads it): one record at run start, the
// in-flight task at every iteration, and a terminal record at run end — in both
// task sources and in `--once` mode (the path `ralph cycle` drives). Every write
// is best-effort: an unwritable `.ralph/run-state.json` must leave the run's
// outcome, its per-issue metrics and its cycle-event line untouched.
//
// Same stubbed-PATH harness as test/loop.test.js: git/gh/claude/jq/node/tmux are
// shadowed on PATH, and the node stub delegates the REAL JS bridges (including
// the run-state sidecar under test) to the real node binary.

const RALPH_TEMPLATE = templatePath('ralph.sh')
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

function runLoop({ timeout = 20000, once = false, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-test',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    ...extraEnv,
  }
  const args = once ? [RALPH_TEMPLATE, '--once'] : [RALPH_TEMPLATE]
  return spawnSync('bash', args, { cwd: workdir, env, timeout, encoding: 'utf8' })
}

// The record the loop is expected to leave behind, parsed. Null when absent.
function readRunStateFile() {
  const f = join(workdir, '.ralph', 'run-state.json')
  if (!existsSync(f)) return null
  return JSON.parse(readFileSync(f, 'utf8'))
}

function readIssueEvents() {
  const f = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)))
}

function readCycleEvents() {
  const f = join(workdir, 'logs', 'ralph-cycle.out.log')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.includes('RALPH_CYCLE_EVENT'))
    .map((l) => JSON.parse(l.slice(l.indexOf('RALPH_CYCLE_EVENT') + 'RALPH_CYCLE_EVENT'.length)))
}

// node stub: the JS bridges the loop shells out to must run for real (the
// run-state sidecar is the subject here); build-prompt just echoes a prompt.
function seedNodeStub() {
  writeStub(
    'node',
    `#!/bin/bash
case "$*" in
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *worktree.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
  *folder-queue.js*) exec "${REAL_NODE}" "$@" ;;
  *run-state.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`,
  )
}

// gh: 3 issues that drain one per iteration (the count file doubles as the issue
// number), each reported CLOSED so the run is an all-success run.
function seedGithubHappyPath(count = 3) {
  writeFileSync(join(workdir, 'count.txt'), String(count))
  writeStub(
    'gh',
    `#!/bin/bash
CNT_FILE="${join(workdir, 'count.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cnt=$(cat "$CNT_FILE")
  case "$*" in
    *sort:created-asc*)
      echo "$cnt"
      echo "$((cnt - 1))" > "$CNT_FILE"
      ;;
    *)
      echo "$cnt"
      ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "" ;;
    *state*)  echo "CLOSED" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
exit 0
`,
  )
  writeStub(
    'claude',
    `#!/bin/bash
cat > /dev/null
echo '{"type":"result","subtype":"success"}'
exit 0
`,
  )
}

function writeTask(status, file, body = 'do the thing') {
  const dir = join(workdir, '.ralph', 'tasks', 'afk', status)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), body)
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-runstate-'))
  bindir = join(workdir, 'bin')
  mkdirSync(bindir, { recursive: true })
  mkdirSync(join(workdir, 'logs'), { recursive: true })
  // No ralph.config.sh, so the lazy-validation block stays skipped; state.json
  // is pre-seeded for the same reason the other loop suites do it.
  mkdirSync(join(workdir, '.ralph'), { recursive: true })
  writeFileSync(join(workdir, '.ralph', 'state.json'), '{}')

  writeStub(
    'git',
    `#!/bin/bash
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  echo "${workdir}"
  exit 0
fi
# #218/#221: before dispatching, the loop asks lib/worktree.js for a per-task worktree
# and then runs the agent with cwd set to it. A stub that answered "worktree add" with a
# bare exit 0 would leave the loop cd-ing into a directory that does not exist, and no
# agent would run at all - so the fiction this stub maintains has to include the
# directory. There are now TWO add spellings and the path sits at a different index in
# each - "worktree add -B <branch> <path> <start>" for github, "worktree add --detach
# <path> <start>" for folder (#221) - so it is found by SHAPE instead: the one argument
# that looks like a ralph worktree. A hardcoded $5 silently created a DIRECTORY NAMED
# AFTER THE START REF in the detached case, and the agent then ran in a tree that was not
# the one the loop had made. "worktree remove --force <path>" puts the path in $4. Both
# the mkdir and the rm are gated on that shape, so this stub can only ever create or
# delete something that looks like a ralph worktree.
if [ "$1" = "worktree" ]; then
  case "$2" in
    add) for a in "$@"; do case "$a" in */.ralph/worktrees/*) mkdir -p "$a" ;; esac; done ;;
    remove) case "$4" in */.ralph/worktrees/*) rm -rf "$4" ;; esac ;;
  esac
  exit 0
fi
exit 0
`,
  )
  seedNodeStub()
  writeStub('jq', `#!/bin/bash\ncat > /dev/null 2>/dev/null || true\nexit 0\n`)
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (workdir && existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true })
  }
})

describe('ralph.sh run-state — github mode (#55)', () => {
  it('records the run at start, the task at every iteration, and a terminal record at the end', () => {
    seedGithubHappyPath(3)

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    const rec = readRunStateFile()
    expect(rec, `no run-state written. stderr:\n${res.stderr}`).not.toBe(null)
    // Run identity, written once at start: same run_id the per-issue telemetry
    // and the cycle event use, plus the queue depth the run began with.
    expect(rec.run_id).toMatch(/^ralph-test-\d+$/)
    expect(rec.session).toBe('ralph-test')
    expect(rec.source).toBe('github')
    expect(rec.queue_at_start).toBe(3)
    expect(Number.isFinite(Date.parse(rec.started_at))).toBe(true)
    // Terminal record: the loop's own counts, not a re-derivation.
    expect(rec.status).toBe('success')
    expect(rec.ok).toBe(3)
    expect(rec.failed).toBe(0)
    expect(Number.isFinite(Date.parse(rec.finished_at))).toBe(true)
    // Per-iteration update: the last task recorded is the last issue worked, and
    // the iteration index counted every pass.
    expect(rec.current.number).toBe(1)
    expect(rec.current.iteration).toBe(3)
    expect(Number.isFinite(Date.parse(rec.current.started_at))).toBe(true)
    // #222 — and WHICH DIRECTORY that task ran in, so a detached run can be found without
    // `git worktree list` and a guess at the branch name. The value is the path
    // lib/worktree.js printed for this source's handle (`issue-<n>`), passed along by the
    // same one call: ralph.sh spells no layout and no field name of its own.
    expect(rec.current.worktree).toBe(join(workdir, '.ralph', 'worktrees', 'issue-1'))
    // One run id across every observability surface of this run.
    expect(readIssueEvents().map((e) => e.run_id)).toEqual([rec.run_id, rec.run_id, rec.run_id])
  })

  it('records a failed run’s terminal status and counts', () => {
    // Default-hostile stubs: claude exits non-zero and the issue is never
    // excluded, so the zero-progress guard fires and the run fails.
    writeStub('claude', `#!/bin/bash\ncat > /dev/null\necho "boom" >&2\nexit 1\n`)
    writeStub(
      'gh',
      `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*) echo "98" ;;
    *) echo "8" ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "" ;;
    *state*)  echo "OPEN" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
exit 0
`,
    )

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)

    const rec = readRunStateFile()
    expect(rec).not.toBe(null)
    expect(rec.status).toBe('failed')
    expect(rec.ok).toBe(0)
    expect(rec.failed).toBeGreaterThanOrEqual(1)
    expect(rec.current.number).toBe(98)
  })
})

describe('ralph.sh run-state — folder mode (#55)', () => {
  it('records the run with source folder, the task ids and a terminal record', () => {
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
TODO="$PROJECT_ROOT/.ralph/tasks/afk/todo"
DONE="$PROJECT_ROOT/.ralph/tasks/afk/done"
mkdir -p "$DONE"
f=$(ls "$TODO"/*.md 2>/dev/null | sort | head -1)
[ -n "$f" ] && mv "$f" "$DONE/"
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )
    // Records ANY gh invocation: folder mode must stay 100% gh-free, run-state
    // sidecar included.
    writeStub('gh', `#!/bin/bash\necho "$*" >> "${join(workdir, 'gh-called.log')}"\nexit 0\n`)
    writeTask('todo', '001-first.md')
    writeTask('todo', '002-second.md')

    const res = runLoop({ extraEnv: { TASK_SOURCE: 'folder' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    const rec = readRunStateFile()
    expect(rec, `no run-state written. stderr:\n${res.stderr}`).not.toBe(null)
    expect(rec.source).toBe('folder')
    expect(rec.queue_at_start).toBe(2)
    expect(rec.status).toBe('success')
    expect(rec.ok).toBe(2)
    expect(rec.failed).toBe(0)
    expect(rec.current.number).toBe(2)
    expect(rec.current.iteration).toBe(2)
    // #222 — the folder source's handle is `task-<n>`, and that difference is exactly why
    // the path is RECORDED rather than derived by whoever reads the record: a reader
    // rebuilding `issue-<number>` from the number would name a directory that never existed.
    expect(rec.current.worktree).toBe(join(workdir, '.ralph', 'worktrees', 'task-2'))

    const ghLog = join(workdir, 'gh-called.log')
    expect(
      existsSync(ghLog),
      `gh was invoked in folder mode:\n${existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : ''}`,
    ).toBe(false)
  })
})

describe('ralph.sh run-state — --once mode, the `ralph cycle` path (#55)', () => {
  it('writes the same records so a scheduled run is observable', () => {
    seedGithubHappyPath(3)

    const res = runLoop({ once: true })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Queue empty, exiting.')

    const rec = readRunStateFile()
    expect(rec, `no run-state written in once mode. stderr:\n${res.stderr}`).not.toBe(null)
    expect(rec.run_id).toMatch(/^ralph-test-\d+$/)
    expect(rec.queue_at_start).toBe(3)
    expect(rec.current.number).toBe(1)
    expect(rec.current.iteration).toBe(3)
    // The terminal record is written BEFORE the --once early exit, which is the
    // whole point: `ralph cycle` runs must not look eternally in flight.
    expect(rec.status).toBe('success')
    expect(rec.ok).toBe(3)
    expect(rec.failed).toBe(0)
    expect(Number.isFinite(Date.parse(rec.finished_at))).toBe(true)

    // Unchanged: the cycle event stays the automated path's own emission.
    expect(readCycleEvents()).toEqual([])
  })
})

// #222 — the in-flight WORKTREE reaches the record. The field, its emptiness rules and both
// `ralph status` surfaces are pinned in the library suites; what only a real bash run can
// show is the WIRING, and there are two halves to it:
//
//   THE PATH TRAVELS, AND NOTHING ELSE DOES. `lib/worktree.js` prints the directory it
//   created and `$task_worktree` already holds it, so the loop passes that variable to the
//   `begin-task` call it already makes — one more positional argument, no new verb, no field
//   name in bash, and no second writer of the record. The two happy-path tests above assert
//   the arrival for both sources (`issue-<n>` and `task-<n>`).
//
//   THE CALL STAYS SINGULAR. `begin-task` re-stamps `current.started_at`, which is what
//   `ralph status` subtracts to say how long the task has been running — so a second call
//   per iteration would silently reset the clock every time. #222 moved the worktree block
//   ABOVE the one call instead of adding a call after it, and the abort test below is what
//   holds that order in place: the task the run died on is still recorded, with no worktree.
describe('ralph.sh run-state — the in-flight worktree (#222)', () => {
  it('records the task with NO worktree when one could not be created, and aborts', () => {
    seedGithubHappyPath(3)
    // The realistic failure this abort exists for: no base commit to cut the branch from
    // (an empty repo, a DEV_BRANCH that exists on neither the remote nor on disk). Every
    // `rev-parse --verify` refuses, so lib/worktree.js throws, `|| task_worktree=""` empties
    // the variable, and the loop stops rather than marking work failed it never attempted.
    writeStub(
      'git',
      `#!/bin/bash
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  echo "${workdir}"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then exit 1; fi
exit 0
`,
    )

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stderr).toContain('could not create a worktree')

    const rec = readRunStateFile()
    expect(rec, `no run-state written. stderr:\n${res.stderr}`).not.toBe(null)
    // The iteration is recorded BEFORE the abort check, which is the point: `ralph status`
    // and the post-mortem both read `current.number` to name the task a dead run was on, and
    // an abort that recorded nothing would leave a run that failed on nothing in particular.
    expect(rec.current.number).toBe(3)
    expect(rec.current.iteration).toBe(1)
    // ...and the field is present and null rather than absent or a guess at the path that
    // was never created — the row `ralph status` then draws is no row at all.
    expect(rec.current.worktree).toBe(null)
    expect('worktree' in rec.current).toBe(true)
    expect(rec.status).toBe('failed')
  })

  it('makes ONE begin-task call, whose last argument is the worktree variable', () => {
    // Asserted against the script TEXT because the regression is invisible at runtime: a
    // second `begin-task` would write a perfectly good record, having thrown away the
    // task's start time. Same reason the jira suite pins "the ONE shared call".
    const script = readFileSync(RALPH_TEMPLATE, 'utf8')
    const calls = script.match(/^\s*node .*run-state\.js" begin-task .*$/gm) ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('begin-task "$PROJECT_ROOT" "$num" "$iter" "$task_key" "$task_worktree"')
    // Three sidecar invocations in the whole loop, in this order, and no fourth: the record
    // is written once at run start, once per iteration, and once at the end. #222 needed no
    // new verb either — the shape of the record is lib/run-state.js's alone.
    expect([...script.matchAll(/run-state\.js" ([a-z-]+)/g)].map((m) => m[1])).toEqual([
      'begin',
      'begin-task',
      'end',
    ])
    // And bash spells no key of the record anywhere — it passes values positionally and
    // learns nothing it would have to be edited to keep in step.
    expect(script).not.toContain('"worktree"')
  })
})

describe('ralph.sh run-state — best effort (#55)', () => {
  it('an unwritable .ralph/run-state.json leaves outcome, metrics and cycle event untouched', () => {
    seedGithubHappyPath(3)
    // Make every run-state write fail at the leaf without touching the rest of
    // .ralph/ (metrics must still be writable, which is the point): the record
    // path is occupied by a DIRECTORY, so writeFileSync can never succeed.
    mkdirSync(join(workdir, '.ralph', 'run-state.json'), { recursive: true })

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    // Outcome: unchanged exit code and unchanged end-of-run summary line.
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).toContain('Ralph finished: 3 ok, 0 failed')

    // Per-issue metrics: still one pass event per issue.
    const events = readIssueEvents()
    expect(events.length).toBe(3)
    expect(events.every((e) => e.verdict === 'pass')).toBe(true)
    expect(events.map((e) => e.issue_number).sort()).toEqual([1, 2, 3])

    // Cycle event: still exactly one, with the run's real counts.
    const cycleEvents = readCycleEvents()
    expect(cycleEvents.length).toBe(1)
    expect(cycleEvents[0]).toMatchObject({ status: 'success', ok: 3, failed: 0, processed: 3 })

    // And nothing pretends a record was written.
    expect(existsSync(join(workdir, '.ralph', 'run-state.json', 'run-state.json'))).toBe(false)
  })
})
