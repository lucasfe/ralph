import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'
import { summarizeLast24h } from '../lib/heartbeat.js'

const RALPH_TEMPLATE = templatePath('ralph.sh')
// Resolve the REAL node binary so the stub can delegate the capture-issue-event
// invocation to it (the stub shadows `node` on PATH; build-prompt.js stays an
// echo, but the telemetry sidecar must actually run).
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

// These integration tests execute templates/ralph.sh's main loop against
// stubbed external commands (git, gh, claude, jq, node) placed on a PATH we
// prepend. They reproduce issue #505: the loop spinning forever on a single
// issue when `claude -p` emits non-JSON and the issue never gets an exclusion
// label. The fix must guarantee forward progress (a zero-progress guard).

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

function runLoop({ timeout = 15000, once = false } = {}) {
  // Prepend our stub bin to PATH; keep the real bash + coreutils available.
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-test',
    // Ensure no real notifications fire.
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
  }
  const args = once ? [RALPH_TEMPLATE, '--once'] : [RALPH_TEMPLATE]
  return spawnSync('bash', args, {
    cwd: workdir,
    env,
    timeout,
    encoding: 'utf8',
  })
}

// Collect the RALPH_CYCLE_EVENT lines the loop appended to logs/ralph-cycle.out.log.
function readCycleEvents() {
  const f = join(workdir, 'logs', 'ralph-cycle.out.log')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.includes('RALPH_CYCLE_EVENT'))
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-loop-'))
  bindir = join(workdir, 'bin')
  mkdirSync(bindir, { recursive: true })
  mkdirSync(join(workdir, 'logs'), { recursive: true })
  // Pre-seed .ralph/state.json so the lazy-validation block is bypassed.
  // (Validation only runs when ralph.config.sh exists; we don't create it,
  // so the whole block is skipped and the test isolates the main loop.)
  mkdirSync(join(workdir, '.ralph'), { recursive: true })
  writeFileSync(join(workdir, '.ralph', 'state.json'), '{}')

  // --- git stub: answer rev-parse --show-toplevel with our workdir, and
  // no-op everything else (checkout/pull/branch in cleanup). -----------------
  writeStub(
    'git',
    `#!/bin/bash
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  echo "${workdir}"
  exit 0
fi
exit 0
`
  )

  // --- node stub: the script calls \`node -p require(...).version\` only when
  // ralph.config.sh exists (it doesn't here), and \`node .../build-prompt.js\`
  // inside the loop. The build-prompt invocation just needs to emit *some*
  // prompt text on stdout that the claude stub will read. ---------------------
  writeStub(
    'node',
    `#!/bin/bash
# The telemetry sidecar (capture-issue-event.js) must run for real so the
# .ralph/metrics/issues.jsonl assertion is meaningful; delegate it to the real
# node binary. Everything else (build-prompt.js / build-validate-prompt.js)
# just needs to emit a dummy prompt.
case "$*" in
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`
  )

  // --- claude stub: simulate the failure mode — print a NON-JSON line to
  // stderr (an auth/credit error) and exit non-zero, emitting nothing to
  // stdout. This is exactly what triggers the jq parse error when stderr is
  // merged via 2>&1. ----------------------------------------------------------
  writeStub(
    'claude',
    `#!/bin/bash
cat > /dev/null   # drain the piped prompt
echo "Credit balance too low (auth error)" >&2
exit 1
`
  )

  // --- jq stub: behave like a minimal real jq for the queries the loop uses,
  // but FAIL loudly on the streaming filter if it ever receives the non-JSON
  // claude stderr (mirrors real jq's "Invalid numeric literal"). We don't
  // implement full jq; we recognize the specific invocations. ----------------
  writeStub(
    'jq',
    `#!/bin/bash
# Detect the streaming pretty-print filter used on claude output.
for a in "$@"; do
  case "$a" in
    *".type == \\"assistant\\""*)
      # Read stdin; if any line isn't JSON, emulate jq's parse error + nonzero.
      while IFS= read -r line; do
        case "$line" in
          '{'*) : ;;        # looks like JSON, ignore
          '') : ;;
          *)
            echo "jq: parse error: Invalid numeric literal at line 1, column 6" >&2
            exit 5
            ;;
        esac
      done
      exit 0
      ;;
  esac
done
# Fallback for other jq uses (e.g. @uri encoding in notifications): no-op.
cat > /dev/null 2>/dev/null || true
exit 0
`
  )

  // --- gh stub: always report 8 open issues, and always select #98 (the
  // sort:created-asc query). \`gh issue view\` reports the issue as OPEN with no
  // labels — i.e. claude never managed to label it claude-failed / close it.
  // This is precisely the zero-progress condition that makes the loop respin.
  // Append to a marker file so the test can prove the SAME issue was selected
  // repeatedly before any guard fires. ---------------------------------------
  writeStub(
    'gh',
    `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*)
      echo "98" >> "${join(workdir, 'selected.log')}"
      echo "98"
      exit 0
      ;;
    *)
      echo "8"   # count of open issues — never drops
      exit 0
      ;;
  esac
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "" ;;        # no labels
    *state*)  echo "OPEN" ;;    # still open
    *)        echo "" ;;
  esac
  exit 0
fi
exit 0
`
  )

  // tmux/curl stubs so cleanup/notify paths never touch the real system.
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

// Reconfigure the gh/claude stubs so the queue drains cleanly: `count` issues,
// each selected once and reported CLOSED (success). Shared by the happy-path,
// cycle-event, and once-mode tests.
function seedHappyPath(count = 3) {
  writeStub(
    'claude',
    `#!/bin/bash
cat > /dev/null
echo '{"type":"result","subtype":"success"}'
exit 0
`
  )
  writeFileSync(join(workdir, 'count.txt'), String(count))
  writeStub(
    'gh',
    `#!/bin/bash
CNT_FILE="${join(workdir, 'count.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cnt=$(cat "$CNT_FILE")
  case "$*" in
    *sort:created-asc*)
      echo "$cnt"      # use the count as the issue number (unique each time)
      echo "$((cnt - 1))" > "$CNT_FILE"   # simulate it getting resolved
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
`
  )
}

afterEach(() => {
  if (workdir && existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true })
  }
})

describe('ralph.sh main loop — issue #505 (no infinite spin)', () => {
  it('does not spin forever when claude fails and the issue is never excluded', () => {
    const res = runLoop({ timeout: 15000 })

    // The decisive assertion: the process must EXIT ON ITS OWN, not be killed
    // by the timeout. spawnSync sets res.signal === 'SIGTERM' (and error.code
    // 'ETIMEDOUT') when it hard-kills a process that overran the timeout.
    expect(res.signal, `loop was killed by timeout — it spun forever. stdout:\n${res.stdout}`).toBeNull()

    // Prove the SAME issue was selected more than once before the guard fired
    // (i.e. the loop genuinely iterated on #98), but a bounded number of times
    // — not thousands — so we know the guard broke the spin.
    const selected = existsSync(join(workdir, 'selected.log'))
      ? readFileSync(join(workdir, 'selected.log'), 'utf8').trim().split('\n')
      : []
    // The guard fires only on re-selection (num === prev_num), so #98 must be
    // selected at least twice before the loop breaks.
    expect(selected.length).toBeGreaterThanOrEqual(2)
    // Bounded: the guard must stop re-selecting after a few iterations.
    expect(selected.length).toBeLessThanOrEqual(5)
    expect(selected.every((n) => n === '98')).toBe(true)
  })

  it('happy path: drains the queue and exits cleanly when issues get resolved', () => {
    // gh stub: count counts down from a counter file; each iteration the
    // selected issue is "closed" (count decremented) so the queue empties and
    // the loop terminates normally. claude exits 0 with valid JSON.
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo '{"type":"result","subtype":"success"}'
exit 0
`
    )
    // 3 issues; each list call returns the current count, sort:created-asc
    // returns a unique number, and viewing reports CLOSED (success).
    writeFileSync(join(workdir, 'count.txt'), '3')
    writeStub(
      'gh',
      `#!/bin/bash
CNT_FILE="${join(workdir, 'count.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cnt=$(cat "$CNT_FILE")
  case "$*" in
    *sort:created-asc*)
      echo "$cnt"      # use the count as the issue number (unique each time)
      echo "$((cnt - 1))" > "$CNT_FILE"   # simulate it getting resolved
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
`
    )

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Fila vazia, encerrando.')
    // All resolved -> reported as successes, none failed.
    expect(res.stdout).toMatch(/3 ok, 0 falharam|Ralph finalizado: 3 ok/)

    // #529: per-issue telemetry — the capture sidecar must have appended a
    // RALPH_ISSUE_EVENT line per resolved issue to .ralph/metrics/issues.jsonl.
    const metricsFile = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    expect(existsSync(metricsFile), `expected metrics at ${metricsFile}. stderr:\n${res.stderr}`).toBe(true)
    const eventLines = readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean)
    expect(eventLines.length).toBe(3)
    for (const line of eventLines) {
      expect(line.startsWith('RALPH_ISSUE_EVENT ')).toBe(true)
      const ev = JSON.parse(line.slice('RALPH_ISSUE_EVENT '.length))
      // Issues were reported CLOSED -> pass verdict; run_id is session-START.
      expect(ev.verdict).toBe('pass')
      expect(ev.run_id).toMatch(/^ralph-test-\d+$/)
      expect(typeof ev.issue_number).toBe('number')
    }
    // One event for each selected issue number (3, 2, 1).
    const issueNums = eventLines
      .map((l) => JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)).issue_number)
      .sort()
    expect(issueNums).toEqual([1, 2, 3])
  })
})

describe('ralph.sh run-event telemetry — issue #531 (24h rollup reach)', () => {
  it('normal mode: appends exactly one RALPH_CYCLE_EVENT with real counts + run_id', () => {
    seedHappyPath(3)

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)

    const cycleEvents = readCycleEvents()
    // Exactly ONE run event, so the 24h rollup counts an interactive run once.
    expect(
      cycleEvents.length,
      `expected exactly one RALPH_CYCLE_EVENT, got:\n${cycleEvents.join('\n')}`,
    ).toBe(1)

    const idx = cycleEvents[0].indexOf('RALPH_CYCLE_EVENT')
    const json = cycleEvents[0].slice(idx + 'RALPH_CYCLE_EVENT'.length).trim()
    const ev = JSON.parse(json)

    // Real bash-computed counts: 3 issues resolved, none failed.
    expect(ev.ok).toBe(3)
    expect(ev.failed).toBe(0)
    expect(ev.status).toBe('success')
    expect(ev.processed).toBe(3)
    expect(typeof ev.durationMin).toBe('number')
    expect(Number.isFinite(Date.parse(ev.ts))).toBe(true)
    expect(ev.run_id).toMatch(/^ralph-test-\d+$/)

    // Consistency: the run_id must equal the run_id used by the per-issue
    // capture events from the SAME run.
    const metricsFile = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    const issueRunIds = readFileSync(metricsFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)).run_id)
    for (const rid of issueRunIds) {
      expect(rid).toBe(ev.run_id)
    }
  })

  // Parse the single RALPH_CYCLE_EVENT JSON object out of the collected lines.
  function parseSingleCycleEvent(lines) {
    expect(lines.length, `expected exactly one RALPH_CYCLE_EVENT, got:\n${lines.join('\n')}`).toBe(1)
    const idx = lines[0].indexOf('RALPH_CYCLE_EVENT')
    return JSON.parse(lines[0].slice(idx + 'RALPH_CYCLE_EVENT'.length).trim())
  }

  it('failure path: STILL emits a RALPH_CYCLE_EVENT with status:"failed" when every issue fails', () => {
    // Use the beforeEach default stubs: claude exits non-zero, #98 stays OPEN
    // with no exclusion label, so the zero-progress guard fires and records the
    // issue as a failure. Telemetry must fire regardless of run outcome.
    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)

    const ev = parseSingleCycleEvent(readCycleEvents())
    // No issue ever resolved -> all failures, status must be "failed".
    expect(ev.status).toBe('failed')
    expect(ev.ok).toBe(0)
    expect(ev.failed).toBeGreaterThanOrEqual(1)
    // processed is the sum of ok + failed and must be internally consistent.
    expect(ev.processed).toBe(ev.ok + ev.failed)
    expect(ev.run_id).toMatch(/^ralph-test-\d+$/)
    expect(Number.isFinite(Date.parse(ev.ts))).toBe(true)
  })

  it('partial path: emits status:"partial" with processed = ok + failed on a mixed run', () => {
    // Drive a mixed run: the FIRST selected issue (#2) closes (success); the
    // SECOND (#1) stays OPEN with no label and claude fails -> it gets re-
    // selected once and the zero-progress guard records it as a failure and
    // breaks. Net: 1 ok, >=1 failed -> status "partial".
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
# Succeed for the high-numbered issue, fail for the rest.
exit 0
`,
    )
    writeFileSync(join(workdir, 'count.txt'), '2')
    writeStub(
      'gh',
      `#!/bin/bash
CNT_FILE="${join(workdir, 'count.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cnt=$(cat "$CNT_FILE")
  case "$*" in
    *sort:created-asc*)
      echo "$cnt"
      # Only the first issue (#2) resolves; once we reach #1, it never closes,
      # so the count stays at 1 (stuck) -> guard fires on re-selection.
      if [ "$cnt" -gt 1 ]; then echo "$((cnt - 1))" > "$CNT_FILE"; fi
      ;;
    *)
      echo "$cnt"
      ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  # Determine which issue we're viewing from the args.
  num=""
  for a in "$@"; do case "$a" in [0-9]*) num="$a" ;; esac; done
  case "$*" in
    *labels*) echo "" ;;
    *state*)
      if [ "$num" = "2" ]; then echo "CLOSED"; else echo "OPEN"; fi
      ;;
    *) echo "" ;;
  esac
  exit 0
fi
exit 0
`,
    )

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)

    const ev = parseSingleCycleEvent(readCycleEvents())
    expect(ev.status).toBe('partial')
    expect(ev.ok).toBeGreaterThanOrEqual(1)
    expect(ev.failed).toBeGreaterThanOrEqual(1)
    expect(ev.processed).toBe(ev.ok + ev.failed)
  })

  it('appends (does not overwrite) when a prior RALPH_CYCLE_EVENT already exists in the log', () => {
    // The heartbeat SUMS multiple events across cycles, so a new run must append
    // rather than truncate. Pre-seed a prior event line from an earlier cycle.
    const priorEvent =
      'RALPH_CYCLE_EVENT {"ts":"2020-01-01T00:00:00Z","status":"success","ok":7,"failed":0,"durationMin":1,"processed":7,"run_id":"prior-1"}'
    writeFileSync(join(workdir, 'logs', 'ralph-cycle.out.log'), priorEvent + '\n')

    seedHappyPath(3)
    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)

    const lines = readCycleEvents()
    // Two events now: the prior one intact + the freshly appended one.
    expect(lines.length, `expected 2 events (prior + new), got:\n${lines.join('\n')}`).toBe(2)
    // Prior line must be byte-for-byte intact (not clobbered/truncated).
    expect(lines[0]).toBe(priorEvent)
    // New line is the current run's success event.
    const idx = lines[1].indexOf('RALPH_CYCLE_EVENT')
    const fresh = JSON.parse(lines[1].slice(idx + 'RALPH_CYCLE_EVENT'.length).trim())
    expect(fresh.status).toBe('success')
    expect(fresh.ok).toBe(3)
    expect(fresh.run_id).not.toBe('prior-1')
  })

  it('heartbeat round-trip: the emitted line is parsed identically by summarizeLast24h', () => {
    // The real integration risk: the consumer (lib/heartbeat.js) must parse the
    // exact line ralph.sh emits. Run a real cycle, then feed logs/ through the
    // real parser with a clock pinned just after emission so it's within 24h.
    seedHappyPath(3)
    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)

    const ev = parseSingleCycleEvent(readCycleEvents())
    // Pin clock to the event's own timestamp so it's deterministically within 24h.
    const clock = () => Date.parse(ev.ts) + 1000

    const summary = summarizeLast24h({
      logDir: join(workdir, 'logs'),
      clock,
    })

    // The consumer must count exactly this one cycle with matching tallies.
    expect(summary.cycles).toBe(1)
    expect(summary.ok).toBe(3)
    expect(summary.failed).toBe(0)
    expect(summary.totalIssues).toBe(3)
    expect(summary.abortedCycles).toBe(0)
    // durationMin from the event must round-trip into durations[].
    expect(summary.durations).toEqual([ev.durationMin])
    // lastCycle echoes the emitted event fields (run_id round-trips too).
    expect(summary.lastCycle.run_id).toBe(ev.run_id)
    expect(summary.lastCycle.status).toBe('success')
  })

  it('heartbeat round-trip: failure cycle counts as a failed cycle (ok=0, failed>=1)', () => {
    // A failed run's emitted event must also be consumed correctly: it is NOT
    // an aborted-status event (those are preflight/lock/tmux), so it counts as a
    // real cycle with failed issues. Uses the beforeEach default failure stubs.
    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)

    const ev = parseSingleCycleEvent(readCycleEvents())
    const clock = () => Date.parse(ev.ts) + 1000

    const summary = summarizeLast24h({ logDir: join(workdir, 'logs'), clock })
    expect(summary.cycles).toBe(1)
    expect(summary.ok).toBe(0)
    expect(summary.failed).toBe(ev.failed)
    expect(summary.failed).toBeGreaterThanOrEqual(1)
    // "failed" is not in ABORTED_STATUSES, so it is a counted cycle, not aborted.
    expect(summary.abortedCycles).toBe(0)
  })

  it('--once mode: emits NO RALPH_CYCLE_EVENT (ralph cycle is the sole emitter)', () => {
    seedHappyPath(3)

    const res = runLoop({ timeout: 15000, once: true })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)
    // Queue still drains in once mode.
    expect(res.stdout).toContain('Fila vazia, encerrando.')

    // No run event — the automated path (ralph cycle) is the sole emitter, so
    // ralph.sh must not double-count.
    const cycleEvents = readCycleEvents()
    expect(
      cycleEvents.length,
      `expected NO RALPH_CYCLE_EVENT in once mode, got:\n${cycleEvents.join('\n')}`,
    ).toBe(0)
  })
})
