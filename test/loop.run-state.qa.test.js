import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'
import { reconcileMode, renderStatus } from '../lib/commands/status.js'

// QA augmentation for #55, bash side. The dev's test/loop.run-state.test.js
// asserts the records the loop leaves behind. This file attacks the guarantee
// that WRAPS those writes: run-state is an observability sidecar, so a broken one
// must be invisible to the run.
//
// The centrepiece is a CONTROL COMPARISON rather than a list of expected values:
// the same run is executed twice in the same sandbox — once with the sidecar
// working, once with it failing — and the run's outcome, its per-issue metrics
// and its RALPH_CYCLE_EVENT line are compared against each other. Only the
// genuinely volatile fields (wall-clock stamps, the epoch inside the run id,
// measured durations) are normalized away, so any other divergence fails,
// including one nobody thought to write an expectation for.
//
// Also covered here: mid-run observability (the record is readable WHILE the loop
// is inside an iteration, and renders through the real `ralph status` renderer),
// a partial run's terminal record, and the `end` call that sits immediately
// above the `--once` early exit.
//
// Same stubbed-PATH harness as test/loop.test.js.

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

function readRunStateFile() {
  const f = join(workdir, '.ralph', 'run-state.json')
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
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

// --- the run-state sidecar, in three flavours -------------------------------
// `real` delegates to the actual node binary (the dev's harness). The other two
// shadow ONLY the run-state invocation, leaving every other bridge real, so a
// comparison isolates the sidecar and nothing else.
const SIDECAR = {
  real: `  *run-state.js*) exec "${REAL_NODE}" "$@" ;;`,
  // Loud on stderr, non-zero exit, nothing on stdout: the shape of an unwritable
  // .ralph/, a broken install or an incompatible node.
  failsOnStderr: `  *run-state.js*) echo "run-state.js: catastrophic sidecar failure" >&2; exit 3 ;;`,
  // Junk on BOTH streams: a number on stdout is the nastiest case, because it is
  // exactly what a queue count or an issue number looks like.
  spewsGarbage: `  *run-state.js*) echo "99999"; printf 'not\\njson\\n'; echo "warn" >&2; exit 3 ;;`,
}

function seedNodeStub(sidecar = SIDECAR.real) {
  writeStub(
    'node',
    `#!/bin/bash
case "$*" in
${sidecar}
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *worktree.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
  *folder-queue.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`,
  )
}

// gh: `count` issues that drain one per iteration, each reported CLOSED.
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
  writeStub('claude', `#!/bin/bash\ncat > /dev/null\necho '{"type":"result","subtype":"success"}'\nexit 0\n`)
}

function writeTask(status, file, body = 'do the thing') {
  const dir = join(workdir, '.ralph', 'tasks', 'afk', status)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), body)
}

// --- comparison plumbing ----------------------------------------------------
// Volatile by nature, and only these: wall-clock stamps, the start epoch baked
// into the run id, and measured durations.
function normalizeStdout(s) {
  return (s ?? '').replace(/\bralph-test-\d+\b/g, 'ralph-test-<epoch>').replace(/\b\d+min\b/g, '<dur>min')
}

const stripIssueVolatile = ({ ts, run_id, duration_ms, ...rest }) => rest
const stripCycleVolatile = ({ ts, run_id, durationMin, ...rest }) => rest

// Everything about a run that must NOT depend on the run-state sidecar.
function outcomeOf(res) {
  return {
    exitStatus: res.status,
    signal: res.signal,
    stdout: normalizeStdout(res.stdout),
    issueEvents: readIssueEvents().map(stripIssueVolatile),
    cycleEvents: readCycleEvents().map(stripCycleVolatile),
  }
}

// Wipe everything a run produced, keeping the sandbox and the pre-seeded
// .ralph/state.json, so a second run starts from the same place as the first.
function resetRunArtifacts(count = 3) {
  rmSync(join(workdir, '.ralph', 'metrics'), { recursive: true, force: true })
  rmSync(join(workdir, '.ralph', 'run-state.json'), { recursive: true, force: true })
  rmSync(join(workdir, 'logs'), { recursive: true, force: true })
  mkdirSync(join(workdir, 'logs'), { recursive: true })
  writeFileSync(join(workdir, 'count.txt'), String(count))
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-runstate-qa-'))
  bindir = join(workdir, 'bin')
  mkdirSync(bindir, { recursive: true })
  mkdirSync(join(workdir, 'logs'), { recursive: true })
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

describe('ralph.sh run-state — a broken sidecar changes NOTHING about the run (#55 QA)', () => {
  it('a run-state sidecar that fails leaves the outcome, the metrics and the cycle event identical to a control run', () => {
    seedGithubHappyPath(3)

    // 1. Control: the sidecar works.
    const control = runLoop()
    expect(control.signal, `control loop hung. stdout:\n${control.stdout}`).toBeNull()
    expect(control.status, `control stderr:\n${control.stderr}`).toBe(0)
    const controlOutcome = outcomeOf(control)
    expect(readRunStateFile()).not.toBe(null)
    // Guard the guard: if the control run produced no observable work, the
    // comparison below would be vacuous.
    expect(controlOutcome.issueEvents.length).toBe(3)
    expect(controlOutcome.cycleEvents.length).toBe(1)

    // 2. Same sandbox, same stubs, same queue — only the sidecar is broken.
    resetRunArtifacts(3)
    seedNodeStub(SIDECAR.failsOnStderr)

    const broken = runLoop()
    expect(broken.signal, `broken loop hung. stdout:\n${broken.stdout}`).toBeNull()
    const brokenOutcome = outcomeOf(broken)

    // The whole acceptance criterion, as one assertion: outcome, stdout,
    // per-issue metrics and the cycle event are unchanged.
    expect(brokenOutcome).toEqual(controlOutcome)

    // …and the sidecar really did fail — no record was left behind, so the
    // comparison above was not comparing two healthy runs.
    expect(readRunStateFile()).toBe(null)
    expect(existsSync(join(workdir, '.ralph', 'run-state.json'))).toBe(false)
    expect(broken.stderr).toContain('catastrophic sidecar failure')
  })

  it('a sidecar that spews a NUMBER on stdout is never mistaken for a queue count or an issue number', () => {
    // If any run-state call were ever wrapped in `$(...)`, `99999` would become
    // the queue depth or the selected issue. The loop must keep processing
    // exactly the three real issues.
    seedGithubHappyPath(3)
    seedNodeStub(SIDECAR.spewsGarbage)

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    expect(res.stdout).toContain('Ralph finished: 3 ok, 0 failed')
    expect(res.stdout).not.toContain('issue #99999')
    expect(res.stdout).not.toContain('(99999 remaining)')

    const events = readIssueEvents()
    expect(events.map((e) => e.issue_number)).toEqual([3, 2, 1])
    expect(events.every((e) => e.verdict === 'pass')).toBe(true)
    expect(readCycleEvents()[0]).toMatchObject({ status: 'success', ok: 3, failed: 0, processed: 3 })
  })

  it('the --once path still exits 0 when the `end` write fails right before the early exit', () => {
    // `end` is deliberately placed ABOVE the `--once` exit, so it is the last
    // thing that runs in a `ralph cycle` drain. A failure there must not become
    // the process's exit status.
    seedGithubHappyPath(2)
    mkdirSync(join(workdir, '.ralph', 'run-state.json'), { recursive: true })

    const res = runLoop({ once: true })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).toContain('Ralph finished: 2 ok, 0 failed')
    // The record path is still the directory we planted — nothing was written
    // beneath it, and no cycle event is emitted in once mode.
    expect(readdirSync(join(workdir, '.ralph', 'run-state.json'))).toEqual([])
    expect(readCycleEvents()).toEqual([])
    expect(readIssueEvents().length).toBe(2)
  })
})

describe('ralph.sh run-state — the record is observable MID-RUN (#55 QA)', () => {
  it('says which task is in flight while the agent is still working on it, and renders through `ralph status`', () => {
    // The point of the whole feature: a detached run's current task is readable
    // from outside. The agent stub snapshots the record from INSIDE an iteration.
    const snapdir = join(workdir, 'snaps')
    mkdirSync(snapdir, { recursive: true })
    seedGithubHappyPath(3)
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
n=$(cat "${snapdir}/n" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "${snapdir}/n"
cp "$PROJECT_ROOT/.ralph/run-state.json" "${snapdir}/snap-$n.json" 2>/dev/null || true
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    const snaps = [1, 2, 3].map((n) => {
      const f = join(snapdir, `snap-${n}.json`)
      expect(existsSync(f), `no mid-run snapshot for iteration ${n}`).toBe(true)
      return JSON.parse(readFileSync(f, 'utf8'))
    })

    // Every snapshot is an IN-FLIGHT record: still running, not yet terminal.
    for (const [i, snap] of snaps.entries()) {
      expect(snap.status, `snapshot ${i + 1}`).toBe('running')
      expect(snap.finished_at, `snapshot ${i + 1}`).toBe(null)
      expect(snap.session).toBe('ralph-test')
      expect(snap.source).toBe('github')
      expect(snap.queue_at_start).toBe(3)
    }
    // The in-flight task advances with the queue, and the iteration index counts
    // passes rather than restarting or skipping.
    expect(snaps.map((s) => s.current.number)).toEqual([3, 2, 1])
    expect(snaps.map((s) => s.current.iteration)).toEqual([1, 2, 3])
    // One run identity across the whole run, matching the terminal record.
    const runIds = new Set(snaps.map((s) => s.run_id))
    expect(runIds.size).toBe(1)
    expect(readRunStateFile().run_id).toBe(snaps[0].run_id)

    // And the record the LOOP wrote renders through the REAL status renderer:
    // this is what catches a field-name drift between the two sides.
    const midRun = snaps[1]
    const startedMs = Date.parse(midRun.current.started_at)
    const mode = reconcileMode({ record: midRun, runAlive: true })
    expect(mode).toBe('running')
    const lines = renderStatus({
      mode,
      record: midRun,
      session: midRun.session,
      queue: 2,
      now: startedMs + 40 * 60000,
    })
    expect(lines[0]).toContain(`run ${midRun.run_id}`)
    // #56's two readings of the same record — the sentence and the row. Both are asserted
    // because they are read from DIFFERENT fields of it (the progress line from
    // `current.number` and `current.started_at`, the row from the task rows the snapshot
    // builds), and a drift in either is a field name the loop and the CLI disagree about.
    // `0/3` is 0 done + 1 in flight + 2 waiting: the loop really has finished nothing yet
    // at this point of the run.
    expect(lines).toContain('  progress   0/3 done · #002 in flight (40min)  [────────] 0%')
    expect(lines).toContain('  #002  🔄 live     –         ~40min')
    expect(lines).toContain('  queue      2 waiting')
    expect(lines).toContain('  attach     ralph live  (tmux attach -t ralph-test)')
    expect(lines.join('\n')).not.toContain('#?')
    // Scoped to the lines the RECORD drives — the heading, the progress line and the table
    // — because #57's pace/eta/spend block reads `unknown` here on purpose: this renders
    // with no issues.jsonl behind it, which is the honest answer and not a drift.
    expect(lines.slice(0, 6).join('\n')).not.toContain('unknown')
  })
})

describe('ralph.sh run-state — the terminal record on the ZERO-PROGRESS break-out (#55 QA)', () => {
  it('terminates the record when the loop aborts on a re-selected issue, instead of leaving it running', () => {
    // The one exit path that is neither "queue empty" nor a completed drain: the
    // guard `break`s out of the middle of the loop. If `end` sat inside the
    // normal-completion path, this run would stay `running` forever and
    // `ralph status` would report an in-flight task that no longer exists.
    writeStub(
      'gh',
      `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*) echo "7" ;;   # the SAME issue, every time
    *)                  echo "1" ;;   # and the queue never drains
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "" ;;      # no exclusion label…
    *state*)  echo "OPEN" ;;  # …and still open: zero progress
  esac
  exit 0
fi
exit 0
`,
    )
    writeStub('claude', `#!/bin/bash\ncat > /dev/null\necho '{"type":"result","subtype":"success"}'\nexit 0\n`)

    const res = runLoop()
    expect(res.signal, `loop hung — the guard did not fire. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stderr).toContain('no progress on issue #7 (re-selected without state change)')

    const rec = readRunStateFile()
    expect(rec, `no run-state written. stderr:\n${res.stderr}`).not.toBe(null)
    expect(rec.status).toBe('failed')
    expect(rec.ok).toBe(0)
    expect(rec.failed).toBe(2)
    expect(Number.isFinite(Date.parse(rec.finished_at))).toBe(true)
    // Exactly two iterations ran before the guard fired, and `iter` counted both.
    expect(rec.current).toMatchObject({ number: 7, iteration: 2 })
    // The whole point: a live session must not make this read as in flight.
    expect(reconcileMode({ record: rec, runAlive: true })).toBe('idle')
  })
})

describe('ralph.sh run-state — the terminal record on a PARTIAL run (#55 QA)', () => {
  it('records status partial with the loop’s own split counts (folder mode: one done, one swept)', () => {
    // Neither an all-success nor an all-failed run: the third terminal status the
    // loop can compute, and the one where a re-derivation would go wrong.
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
TODO="$PROJECT_ROOT/.ralph/tasks/afk/todo"
DONE="$PROJECT_ROOT/.ralph/tasks/afk/done"
mkdir -p "$DONE"
f=$(ls "$TODO"/*.md 2>/dev/null | sort | head -1)
case "$f" in
  *001*) mv "$f" "$DONE/" ;;
esac
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )
    writeStub('gh', `#!/bin/bash\necho "$*" >> "${join(workdir, 'gh-called.log')}"\nexit 0\n`)
    writeTask('todo', '001-first.md')
    writeTask('todo', '002-second.md')

    const res = runLoop({ extraEnv: { TASK_SOURCE: 'folder' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toContain('Ralph finished: 1 ok, 1 failed')

    const rec = readRunStateFile()
    expect(rec, `no run-state written. stderr:\n${res.stderr}`).not.toBe(null)
    expect(rec.status).toBe('partial')
    expect(rec.ok).toBe(1)
    expect(rec.failed).toBe(1)
    expect(rec.source).toBe('folder')
    expect(rec.queue_at_start).toBe(2)
    expect(rec.current).toMatchObject({ number: 2, iteration: 2 })
    expect(Number.isFinite(Date.parse(rec.finished_at))).toBe(true)
    // A terminal record must never read as in flight, whatever the mix.
    expect(reconcileMode({ record: rec, runAlive: true })).toBe('idle')

    // Folder mode stays gh-free, run-state sidecar included.
    expect(existsSync(join(workdir, 'gh-called.log'))).toBe(false)
  })
})

// --- #222: the recorded worktree, where only a real bash run can answer -------
// The library suites own the field and both `ralph status` surfaces, and
// test/loop.run-state.test.js owns the arrival of the path for a github and a folder happy
// path plus the github abort. Two questions are left, and both are about BASH:
//
//   1. THE PATH IS ONE ARGUMENT, even when it contains a space. `$task_worktree` is now
//      passed to a fifth positional parameter, `cd`-ed into, and exported — three places an
//      unquoted expansion would split it, and the failure is not a wrong record but a
//      HALF-recorded one plus an agent that ran somewhere else (or nowhere). A worktree path
//      contains a space whenever the project root does, which on macOS is ordinary
//      (`~/Documents/My Projects/repo`), and nothing in the suite had ever put one there.
//   2. THE ABORT PATH IS PER SOURCE. The record is written before the abort check, so a
//      run that dies for want of a worktree still names the task it died on. That ordering
//      is asserted for github upstream; folder mode reaches the same check through the OTHER
//      create verb (`create-detached`, #221) with a different handle and a different refusal,
//      and the thing that must not happen is the record arriving after the `break`.
describe('ralph.sh run-state — a worktree path with a SPACE in it (#222 QA)', () => {
  it('records it whole, runs the agent inside it, and draws it in `ralph status`', () => {
    // The path is injected by stubbing ONLY `worktree.js create`, which is the narrowest
    // probe that asks the question: lib/worktree.js derives the path from the project root,
    // so a spaced root yields exactly this shape, and stubbing the one verb keeps the test
    // about the loop's handling of the VALUE rather than about moving the whole sandbox
    // behind a spaced name (which would put every other bridge in the blast radius too).
    const spaced = join(workdir, 'My Projects', '.ralph', 'worktrees', 'issue-1')
    const snapdir = join(workdir, 'snaps')
    mkdirSync(snapdir, { recursive: true })
    writeStub(
      'node',
      `#!/bin/bash
case "$*" in
  *"worktree.js create"*) printf '%s\\n' "${spaced}"; mkdir -p "${spaced}"; exit 0 ;;
  *"worktree.js remove"*) exit 0 ;;
  *run-state.js*) exec "${REAL_NODE}" "$@" ;;
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
  *folder-queue.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`,
    )
    seedGithubHappyPath(1)
    // Three readings of the same variable, all from inside the iteration: the directory the
    // agent was actually started in, the directory lib/build-prompt.js is told to name as
    // {{PROJECT_ROOT}}, and the record as it stood mid-run.
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
{
  echo "PWD=$PWD"
  echo "PROMPT_ROOT=\${RALPH_PROMPT_PROJECT_ROOT-<unset>}"
} >> "${join(snapdir, 'agent.log')}"
cp "$PROJECT_ROOT/.ralph/run-state.json" "${join(snapdir, 'snap.json')}" 2>/dev/null || true
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    // `set -u` is on and the value now crosses three more expansions; a split path would
    // also show up as git or `cd` complaining about half of it.
    expect(res.stderr).not.toContain('unbound variable')
    expect(res.stderr).not.toContain('No such file or directory')

    const rec = readRunStateFile()
    expect(rec, `no run-state written. stderr:\n${res.stderr}`).not.toBe(null)
    expect(rec.current.worktree).toBe(spaced)

    // The agent really ran there, and the prompt builder was pointed at the same string.
    const agentLog = readFileSync(join(snapdir, 'agent.log'), 'utf8')
    expect(agentLog).toContain(`PWD=${spaced}`)
    expect(agentLog).toContain(`PROMPT_ROOT=${spaced}`)

    // And the record the LOOP wrote draws the row through the REAL renderer, space and all:
    // the one assertion that spans both sides of #222, and the one that would catch a path
    // the loop truncated at its first space (which is still a valid-looking path).
    const snap = JSON.parse(readFileSync(join(snapdir, 'snap.json'), 'utf8'))
    expect(snap.current.worktree).toBe(spaced)
    const mode = reconcileMode({ record: snap, runAlive: true })
    expect(mode).toBe('running')
    const lines = renderStatus({
      mode,
      record: snap,
      session: snap.session,
      queue: 0,
      now: Date.parse(snap.current.started_at) + 60000,
    })
    expect(lines, lines.join('\n')).toContain(`  worktree   ${spaced}`)
  })
})

describe('ralph.sh run-state — the FOLDER abort still names its task (#222 QA)', () => {
  it('writes the record before aborting, with no worktree, and never pays for an agent', () => {
    // Folder mode's create is `create-detached` and its base must be a LOCAL BRANCH
    // (lib/worktree.js refuses a tag or a sha, because the `advance` call after the agent can
    // only move `refs/heads/<base>`), so a git that verifies nothing is the honest way to
    // make this fail — a repo whose $DEV_BRANCH does not exist locally.
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
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo "ran" >> "${join(workdir, 'claude-called.log')}"
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )
    writeTask('todo', '001-first.md')
    writeTask('todo', '002-second.md')

    const res = runLoop({ extraEnv: { TASK_SOURCE: 'folder' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    // The folder label, not the github one: the sentence names the task a human has to go
    // and unblock, and the two sources spell it differently (`task #1` / `issue #1`).
    expect(res.stderr).toContain('could not create a worktree for task #1')

    const rec = readRunStateFile()
    expect(rec, `no run-state written. stderr:\n${res.stderr}`).not.toBe(null)
    // Written BEFORE the `break`, which is the whole ordering question: the run failed on a
    // specific task and this is the only place that says which. An `iter` of 1 also shows the
    // abort happened on the FIRST pass rather than after a silent retry.
    expect(rec.current).toMatchObject({ number: 1, iteration: 1 })
    expect(rec.current.worktree).toBe(null)
    expect('worktree' in rec.current).toBe(true)
    expect(rec.status).toBe('failed')
    // Nothing was attempted, so nothing was billed — the reason this path aborts instead of
    // marking the task failed and moving on.
    expect(existsSync(join(workdir, 'claude-called.log'))).toBe(false)
    expect(readdirSync(join(workdir, '.ralph', 'tasks', 'afk', 'todo')).sort()).toEqual([
      '001-first.md',
      '002-second.md',
    ])
    // And what `ralph status` makes of that record: no worktree row at all, rather than a
    // label with nothing beside it. Rendered from the bash-written record, because the
    // record's shape is the only thing the two sides share.
    const lines = renderStatus({
      mode: reconcileMode({ record: rec, runAlive: true }),
      record: rec,
      session: rec.session,
      queue: 2,
      now: Date.parse(rec.finished_at),
    })
    expect(lines.join('\n')).not.toContain('worktree')
  })
})

describe('ralph.sh run-state — the window while the next worktree is being created (#222 QA)', () => {
  it('still shows the PREVIOUS iteration’s task and directory, which may already be gone', () => {
    // A CHARACTERISATION of the one gap #222 could not close, measured rather than reasoned
    // about. The record is written ONCE per iteration and the worktree has to exist before the
    // value can be passed, so the create now happens BEFORE the write: for the length of one
    // `git worktree add`, `ralph status` is still describing the previous iteration.
    //
    // That window predates #222 (#55's `current` has always survived until the next
    // `begin-task`), and #222 both LENGTHENS and sharpens it rather than creating it. Longer,
    // because the create and its fetch used to run AFTER the write and now run before it, so
    // those seconds are new. Sharper, because of the field itself: the previous
    // iteration ENDED — and if it ended in a merged PR, #220 removed its tree — so the path on
    // show can name a directory that no longer exists. Asserted as it is because the
    // alternatives are worse: a second `begin-task` would reset the start time the progress
    // line subtracts, and clearing `current` first would make a status read during the window
    // say nothing is running when something is.
    //
    // The snapshot is taken from INSIDE the create for the second iteration, which is the only
    // vantage point where the window is observable at all.
    const snapdir = join(workdir, 'snaps')
    mkdirSync(snapdir, { recursive: true })
    writeStub(
      'node',
      `#!/bin/bash
case "$*" in
  *"worktree.js create"*)
    n=$(cat "${snapdir}/n" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "${snapdir}/n"
    cp "$PROJECT_ROOT/.ralph/run-state.json" "${snapdir}/during-$n.json" 2>/dev/null || true
    ls "$PROJECT_ROOT/.ralph/worktrees" > "${snapdir}/trees-$n.txt" 2>/dev/null || true
    exec "${REAL_NODE}" "$@" ;;
  *run-state.js*) exec "${REAL_NODE}" "$@" ;;
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *worktree.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
  *folder-queue.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`,
    )
    seedGithubHappyPath(2)

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    // Iteration 1's create sees a record with nothing in flight yet — `begin` wrote
    // `current: null`, so the view says "starting" rather than naming a task.
    const first = JSON.parse(readFileSync(join(snapdir, 'during-1.json'), 'utf8'))
    expect(first.current).toBe(null)

    // Iteration 2's create sees iteration 1: issue #2, its worktree, its start time.
    const second = JSON.parse(readFileSync(join(snapdir, 'during-2.json'), 'utf8'))
    expect(second.current.number).toBe(2)
    expect(second.current.iteration).toBe(1)
    const stale = second.current.worktree
    expect(stale).toBe(join(workdir, '.ralph', 'worktrees', 'issue-2'))

    // ...and #220 had already taken that tree down, because issue #2 came back CLOSED. So the
    // row a reader would see in this window names a directory that is not there any more —
    // which is what makes this a window worth knowing about rather than merely a lag.
    expect(readFileSync(join(snapdir, 'trees-2.txt'), 'utf8').trim()).toBe('')
    const mode = reconcileMode({ record: second, runAlive: true })
    expect(mode).toBe('running')
    const lines = renderStatus({
      mode,
      record: second,
      session: second.session,
      queue: 1,
      now: Date.parse(second.current.started_at) + 60000,
    })
    expect(lines).toContain(`  worktree   ${stale}`)
    expect(existsSync(stale)).toBe(false)

    // The window closes on the very next line of the loop: the terminal record names the task
    // that really was in flight last, in the tree that really was its own.
    const rec = readRunStateFile()
    expect(rec.current.number).toBe(1)
    expect(rec.current.worktree).toBe(join(workdir, '.ralph', 'worktrees', 'issue-1'))
  })
})
