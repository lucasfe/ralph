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
