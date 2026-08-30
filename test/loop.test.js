import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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

// Resolve the REAL jq binary. The validation-block tests below exercise the
// `needs_validate` decision, which parses .ralph/state.json fields
// (.config_hash / .ralph_version / .agent) via jq — the default jq stub only
// emulates the streaming filter, so those tests delegate to the real jq. If jq
// is unavailable the validation tests are skipped (ralph itself requires jq).
let REAL_JQ = ''
try {
  REAL_JQ = execFileSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).trim()
} catch {
  REAL_JQ = ''
}

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

function runLoop({ timeout = 15000, once = false, extraEnv = {} } = {}) {
  // Prepend our stub bin to PATH; keep the real bash + coreutils available.
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-test',
    // Ensure no real notifications fire.
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    ...extraEnv,
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
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
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
    expect(res.stdout).toContain('Queue empty, exiting.')
    // All resolved -> reported as successes, none failed.
    expect(res.stdout).toMatch(/3 ok, 0 failed|Ralph finished: 3 ok/)

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
    expect(res.stdout).toContain('Queue empty, exiting.')

    // No run event — the automated path (ralph cycle) is the sole emitter, so
    // ralph.sh must not double-count.
    const cycleEvents = readCycleEvents()
    expect(
      cycleEvents.length,
      `expected NO RALPH_CYCLE_EVENT in once mode, got:\n${cycleEvents.join('\n')}`,
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Issue #562 — lazy config validation runs through the CONFIGURED agent, and a
// change of agent (even via RALPH_AGENT env, which doesn't alter config_hash)
// triggers a fresh validation pass. These tests drive the validation block at
// the top of ralph.sh, which the other suites deliberately skip by not
// creating ralph.config.sh. Here we DO create it and pre-seed .ralph/state.json
// with a chosen (agent, config_hash, ralph_version) so we can control the
// needs_validate decision precisely.
// ---------------------------------------------------------------------------
describe('ralph.sh lazy validation — agent-aware revalidation (#562)', () => {
  // Package dir + version so we can seed a state.json whose ralph_version
  // MATCHES what the script computes (via `node -p require(pkg).version`),
  // isolating the AGENT trigger from the version trigger.
  const PKG_DIR = join(RALPH_TEMPLATE, '..', '..')
  const PKG_VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version

  const CONFIG_CONTENT = 'INSTALL_CMD="npm ci"\nTEST_CMD="npm test"\n'
  const CONFIG_HASH = createHash('sha256').update(CONFIG_CONTENT).digest('hex')

  // A complete state.json so lib/finalize-state.js (run for real) is satisfied.
  function seedState({ agent, configHash = CONFIG_HASH, ralphVersion = PKG_VERSION }) {
    const state = {
      validated_at: '2026-08-06T00:00:00Z',
      detected_stack: 'npm',
      notes: 'seeded',
      last_seen_release: '',
      config_hash: configHash,
      ralph_version: ralphVersion,
    }
    if (agent !== undefined) state.agent = agent
    writeFileSync(join(workdir, '.ralph', 'state.json'), JSON.stringify(state))
  }

  // Stubs tailored for the validation block: real jq (to parse state.json),
  // real node for the version query + the JS bridges (agent-invocation.js,
  // finalize-state.js, capture-issue-event.js), an empty gh queue so the main
  // loop exits immediately after validation, and a claude stub that emits valid
  // JSON. The validation prompt builders (build-validate-prompt.js) just echo.
  function seedValidationStubs() {
    writeStub(
      'node',
      `#!/bin/bash
case "$*" in
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
  *finalize-state.js*) exec "${REAL_NODE}" "$@" ;;
  *package.json*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`
    )
    writeStub('jq', `#!/bin/bash\nexec "${REAL_JQ}" "$@"\n`)
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo '{"type":"result","subtype":"success"}'
exit 0
`
    )
    // Empty queue: the count query returns 0, so the loop prints "Queue empty"
    // and exits right after validation.
    writeStub(
      'gh',
      `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  echo "0"
  exit 0
fi
exit 0
`
    )
    writeFileSync(join(workdir, 'ralph.config.sh'), CONFIG_CONTENT)
  }

  // A validation-agent stub that behaves like a REAL agent: it rewrites
  // .ralph/state.json with the required fields (validated_at, detected_stack,
  // notes, last_seen_release) so the post-validation existence check passes and
  // finalize-state.js (run for real) can record the resolved agent + hash +
  // version on top. `cli` picks which CLI name the stub is installed as
  // (claude | codex) so a test can prove the validation pass went through the
  // agent it expected; `marker` is a file the stub touches so a test can assert
  // the CLI actually ran (or, on a skip, that it did NOT).
  function writeValidatingAgentStub(cli, marker) {
    writeStub(
      cli,
      `#!/bin/bash
cat > /dev/null
mkdir -p .ralph
cat > .ralph/state.json <<'JSON'
{"validated_at":"2026-08-06T00:00:00Z","detected_stack":"npm","notes":"stub-validated","last_seen_release":""}
JSON
touch "${marker}"
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )
  }

  it.skipIf(!REAL_JQ)(
    'revalidates when the stored agent differs from the resolved agent (hash+version match)',
    () => {
      seedValidationStubs()
      // Resolved agent is claude (RALPH_AGENT unset), but state records codex →
      // the config must be re-checked under the agent that will actually run it.
      seedState({ agent: 'codex' })

      const res = runLoop({ timeout: 20000 })
      expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

      // The validation pass ran: banner printed and its log was produced.
      expect(res.stdout).toContain('Validating ralph.config.sh')
      expect(existsSync(join(workdir, 'logs', 'ralph-validate.log'))).toBe(true)
      // Queue then drains cleanly.
      expect(res.stdout).toContain('Queue empty, exiting.')
    },
  )

  it.skipIf(!REAL_JQ)(
    'skips validation when stored agent matches and hash+version match',
    () => {
      seedValidationStubs()
      // Resolved agent is claude and state already records claude with a matching
      // hash + version → nothing changed, so NO revalidation.
      seedState({ agent: 'claude' })

      const res = runLoop({ timeout: 20000 })
      expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

      // Validation must NOT run.
      expect(res.stdout).not.toContain('Validating ralph.config.sh')
      expect(existsSync(join(workdir, 'logs', 'ralph-validate.log'))).toBe(false)
      expect(res.stdout).toContain('Queue empty, exiting.')
    },
  )

  it.skipIf(!REAL_JQ)(
    'self-heals a legacy state.json with no agent field (one revalidation)',
    () => {
      seedValidationStubs()
      // Pre-existing state written before agents were recorded: no `agent` key.
      // stored_agent resolves to "" which differs from "claude" → one
      // self-healing revalidation.
      seedState({ agent: undefined })

      const res = runLoop({ timeout: 20000 })
      expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

      expect(res.stdout).toContain('Validating ralph.config.sh')
      expect(existsSync(join(workdir, 'logs', 'ralph-validate.log'))).toBe(true)
      // finalize-state.js (run for real) records the resolved agent, so the
      // healed state now carries agent: "claude".
      const healed = JSON.parse(readFileSync(join(workdir, '.ralph', 'state.json'), 'utf8'))
      expect(healed.agent).toBe('claude')
    },
  )

  // -------------------------------------------------------------------------
  // QA augmentation (#562) — edge/adversarial paths the dev's 3 tests didn't
  // pin: a corrupt state.json, the codex-only bootstrap headline story, and the
  // anti-churn round-trip (a second run must not re-validate).
  // -------------------------------------------------------------------------

  it.skipIf(!REAL_JQ)(
    'QA: adversarial — a malformed (non-JSON) state.json triggers exactly one self-healing revalidation',
    () => {
      seedValidationStubs()
      // Corrupt state.json: NOT valid JSON. `jq -r '.agent // ""'` errors, but
      // the `2>/dev/null || echo ""` guard yields stored_agent="" (and the hash
      // /version reads likewise fail-safe to ""), so needs_validate flips to yes
      // — the safe outcome: never trust a garbage state, re-validate. Install a
      // real-behaving claude stub so the pass can rewrite a VALID state.json;
      // otherwise finalize-state.js would read garbage and abort.
      const marker = join(workdir, 'claude-ran.marker')
      writeValidatingAgentStub('claude', marker)
      writeFileSync(join(workdir, '.ralph', 'state.json'), 'this is NOT json {{{ ,,, ]]]')

      const res = runLoop({ timeout: 20000 })
      expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

      // Revalidation fired (safe self-heal), and it went through the agent CLI.
      expect(res.stdout).toContain('Validating ralph.config.sh')
      expect(existsSync(marker), 'validation pass must have invoked the agent CLI').toBe(true)
      expect(existsSync(join(workdir, 'logs', 'ralph-validate.log'))).toBe(true)
      // The garbage was replaced with a well-formed, finalized state.json.
      const healed = JSON.parse(readFileSync(join(workdir, '.ralph', 'state.json'), 'utf8'))
      expect(healed.agent).toBe('claude')
      expect(healed.config_hash).toBe(CONFIG_HASH)
    },
  )

  it.skipIf(!REAL_JQ)(
    'QA: codex-only bootstrap — no state.json, resolved agent=codex → validation runs through the CODEX CLI and records agent:"codex"',
    () => {
      seedValidationStubs()
      // Headline user story: a fresh machine whose agent is codex, with NO prior
      // state. The absent-state.json branch must run validation, and it must
      // drive the CODEX cli — not unconditionally claude. Prove the codex stub
      // ran and the claude stub did NOT.
      rmSync(join(workdir, '.ralph', 'state.json'), { force: true })
      const codexMarker = join(workdir, 'codex-ran.marker')
      const claudeMarker = join(workdir, 'claude-ran.marker')
      writeValidatingAgentStub('codex', codexMarker)
      writeValidatingAgentStub('claude', claudeMarker)

      const res = runLoop({ timeout: 20000, extraEnv: { RALPH_AGENT: 'codex' } })
      expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

      expect(res.stdout).toContain('Validating ralph.config.sh')
      // The validation pass went through CODEX, not Claude.
      expect(existsSync(codexMarker), 'validation must run through the codex CLI').toBe(true)
      expect(existsSync(claudeMarker), 'claude CLI must NOT be invoked when agent=codex').toBe(false)
      // finalize-state.js records the resolved agent so state now carries codex.
      const state = JSON.parse(readFileSync(join(workdir, '.ralph', 'state.json'), 'utf8'))
      expect(state.agent).toBe('codex')
    },
  )

  it.skipIf(!REAL_JQ)(
    'QA: anti-churn — after a codex run records agent:"codex", a second codex run with matching hash/version SKIPS validation',
    () => {
      seedValidationStubs()
      // Round-trip: run once (bootstrap) so finalize records agent=codex + the
      // real config_hash + ralph_version. Then run AGAIN with the same resolved
      // agent and unchanged config — the loop must NOT re-validate, or it would
      // churn forever every cycle. This is the critical no-infinite-revalidation
      // property implied by, but not directly asserted in, the "skips" test.
      rmSync(join(workdir, '.ralph', 'state.json'), { force: true })
      const codexMarker = join(workdir, 'codex-ran.marker')
      writeValidatingAgentStub('codex', codexMarker)

      // --- Run 1: bootstrap. Validation runs and produces a finalized state. ---
      const res1 = runLoop({ timeout: 20000, extraEnv: { RALPH_AGENT: 'codex' } })
      expect(res1.signal, `run1 hung. stdout:\n${res1.stdout}\nstderr:\n${res1.stderr}`).toBeNull()
      expect(res1.status, `run1 stderr:\n${res1.stderr}`).toBe(0)
      expect(res1.stdout).toContain('Validating ralph.config.sh')
      const state1 = JSON.parse(readFileSync(join(workdir, '.ralph', 'state.json'), 'utf8'))
      expect(state1.agent).toBe('codex')

      // Reset the observable side effects so run 2 starts clean.
      rmSync(codexMarker, { force: true })
      rmSync(join(workdir, 'logs', 'ralph-validate.log'), { force: true })

      // --- Run 2: same agent, unchanged config → must SKIP validation. --------
      const res2 = runLoop({ timeout: 20000, extraEnv: { RALPH_AGENT: 'codex' } })
      expect(res2.signal, `run2 hung. stdout:\n${res2.stdout}\nstderr:\n${res2.stderr}`).toBeNull()
      expect(res2.status, `run2 stderr:\n${res2.stderr}`).toBe(0)

      expect(res2.stdout, 'second run must not re-validate (anti-churn)').not.toContain(
        'Validating ralph.config.sh',
      )
      expect(existsSync(codexMarker), 'agent CLI must not run for validation on the second pass').toBe(
        false,
      )
      expect(existsSync(join(workdir, 'logs', 'ralph-validate.log'))).toBe(false)
      expect(res2.stdout).toContain('Queue empty, exiting.')
    },
  )

  it.skipIf(!REAL_JQ)(
    'QA: defensive default — an EMPTY RALPH_RESOLVED_AGENT collapses to "claude" and does NOT spuriously revalidate a claude-recorded state',
    () => {
      seedValidationStubs()
      // Pin the `${RALPH_RESOLVED_AGENT:-claude}` bash default in the compare.
      // Override the agent-invocation bridge so it emits an EMPTY
      // RALPH_RESOLVED_AGENT (simulating a resolution that yields no explicit
      // agent) while still giving the loop a working claude CLI/argv. State
      // records agent:"claude"; the default must resolve the empty value to
      // "claude" == stored "claude" → NO revalidation. A missing default here
      // would make "" != "claude" and revalidate on every run.
      const claudeMarker = join(workdir, 'claude-ran.marker')
      writeValidatingAgentStub('claude', claudeMarker)
      writeStub(
        'node',
        `#!/bin/bash
case "$*" in
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *finalize-state.js*) exec "${REAL_NODE}" "$@" ;;
  *package.json*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*)
    # Emit a working claude invocation but with an EMPTY resolved-agent name.
    printf "RALPH_RESOLVED_AGENT=''\\n"
    printf "RALPH_AGENT_CLI='claude'\\n"
    printf "RALPH_AGENT_ARGS=('-p')\\n"
    printf "RALPH_AGENT_STREAM_FILTER='.'\\n"
    exit 0
    ;;
esac
echo "PROMPT"
exit 0
`,
      )
      seedState({ agent: 'claude' })

      const res = runLoop({ timeout: 20000 })
      expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

      // The default resolved empty→claude, matching the stored agent: no re-check.
      expect(res.stdout, 'empty resolved-agent must default to claude and skip').not.toContain(
        'Validating ralph.config.sh',
      )
      expect(existsSync(claudeMarker), 'no validation pass should have run the agent').toBe(false)
      expect(existsSync(join(workdir, 'logs', 'ralph-validate.log'))).toBe(false)
      expect(res.stdout).toContain('Queue empty, exiting.')
    },
  )
})

// ---------------------------------------------------------------------------
// Issue #4 — the shell loop honors the global config (~/.config/ralph/.env) for
// the end-of-run WhatsApp notification, which is sent from bash (not JS). With
// NO repo .env.local and the CALLMEBOT_KEY/WHATSAPP_PHONE env vars UNSET, creds
// placed in the global file must reach the notification. Precedence stays
// repo → process.env → global: the global file only fills vars not already set.
// ---------------------------------------------------------------------------
describe('ralph.sh global config read path — issue #4', () => {
  // Like runLoop(), but does NOT force CALLMEBOT_KEY/WHATSAPP_PHONE to '' — the
  // point of this suite is that they are genuinely UNSET so the global file can
  // fill them. curl is stubbed to record the URL it is called with so we can
  // prove the notification fired with the global creds.
  function runLoopNoCreds({ timeout = 15000, extraEnv = {} } = {}) {
    const env = {
      ...process.env,
      PATH: `${bindir}:${process.env.PATH}`,
      RALPH_TMUX_SESSION: 'ralph-test',
    }
    // Start from a genuinely-unset state, then let extraEnv opt back in so a
    // test can pin one cred in the environment (process.env-wins precedence).
    delete env.CALLMEBOT_KEY
    delete env.WHATSAPP_PHONE
    Object.assign(env, extraEnv)
    return spawnSync('bash', [RALPH_TEMPLATE], {
      cwd: workdir,
      env,
      timeout,
      encoding: 'utf8',
    })
  }

  function writeGlobalConfig(xdgHome, body) {
    const dir = join(xdgHome, 'ralph')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.env'), body)
  }

  it('sends the end-of-run WhatsApp notification using global creds when .env.local is absent and the env vars are unset', () => {
    seedHappyPath(2)
    // curl stub records the URL it received so we can assert the creds used.
    const curlLog = join(workdir, 'curl.log')
    writeStub('curl', `#!/bin/bash\necho "$*" >> "${curlLog}"\nexit 0\n`)
    // Real jq needed to @uri-encode the message in the notification block.
    if (REAL_JQ) writeStub('jq', `#!/bin/bash\nexec "${REAL_JQ}" "$@"\n`)

    const xdgHome = join(workdir, 'xdg')
    writeGlobalConfig(xdgHome, 'CALLMEBOT_KEY=globalkey\nWHATSAPP_PHONE=+15550000\n')

    const res = runLoopNoCreds({ extraEnv: { XDG_CONFIG_HOME: xdgHome } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    // The notification fired (bash echoes this only after the curl send).
    expect(res.stdout).toContain('WhatsApp notification sent')
    // The curl call carried the global creds.
    expect(existsSync(curlLog), `curl was never called. stdout:\n${res.stdout}`).toBe(true)
    const url = readFileSync(curlLog, 'utf8')
    expect(url).toContain('phone=+15550000')
    expect(url).toContain('apikey=globalkey')
  })

  it('does NOT clobber an env-set credential with the global value (process.env wins over global)', () => {
    seedHappyPath(2)
    const curlLog = join(workdir, 'curl.log')
    writeStub('curl', `#!/bin/bash\necho "$*" >> "${curlLog}"\nexit 0\n`)
    if (REAL_JQ) writeStub('jq', `#!/bin/bash\nexec "${REAL_JQ}" "$@"\n`)

    const xdgHome = join(workdir, 'xdg')
    writeGlobalConfig(xdgHome, 'CALLMEBOT_KEY=globalkey\nWHATSAPP_PHONE=+15550000\n')

    // WHATSAPP_PHONE is set in the environment → it must win over the global
    // file; only the unset CALLMEBOT_KEY is filled from the global config.
    const res = runLoopNoCreds({
      extraEnv: { XDG_CONFIG_HOME: xdgHome, WHATSAPP_PHONE: '+19999999' },
    })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    const url = readFileSync(curlLog, 'utf8')
    expect(url).toContain('phone=+19999999')
    expect(url).not.toContain('phone=+15550000')
    expect(url).toContain('apikey=globalkey')
  })

  // QA: the global file is a dotenv, not a fixed KEY=VALUE table — it may carry
  // `export ` prefixes, quoted values, comments, and blank lines. The parser
  // must handle them like lib/utils/env.js's parseEnvFile does.
  it('QA: parses export prefixes, quotes, comments, and blank lines in the global file', () => {
    seedHappyPath(1)
    const curlLog = join(workdir, 'curl.log')
    writeStub('curl', `#!/bin/bash\necho "$*" >> "${curlLog}"\nexit 0\n`)
    if (REAL_JQ) writeStub('jq', `#!/bin/bash\nexec "${REAL_JQ}" "$@"\n`)

    const xdgHome = join(workdir, 'xdg')
    writeGlobalConfig(
      xdgHome,
      '# Ralph global creds\n\nexport CALLMEBOT_KEY="quoted-key"\nWHATSAPP_PHONE=\'+15551234\'\n',
    )

    const res = runLoopNoCreds({ extraEnv: { XDG_CONFIG_HOME: xdgHome } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    const url = readFileSync(curlLog, 'utf8')
    // Quotes stripped, export prefix ignored, comment/blank lines skipped.
    expect(url).toContain('apikey=quoted-key')
    expect(url).toContain('phone=+15551234')
  })

  // QA: adversarial precedence — a set-but-EMPTY env credential must NOT be
  // back-filled from the global file (matches the JS `??` resolver, where ''
  // wins over the global value). The empty cred then correctly suppresses the
  // notification, so the loop must NOT send.
  it('QA: a set-but-empty env credential is not overridden by the global file', () => {
    seedHappyPath(1)
    const curlLog = join(workdir, 'curl.log')
    writeStub('curl', `#!/bin/bash\necho "$*" >> "${curlLog}"\nexit 0\n`)
    if (REAL_JQ) writeStub('jq', `#!/bin/bash\nexec "${REAL_JQ}" "$@"\n`)

    const xdgHome = join(workdir, 'xdg')
    writeGlobalConfig(xdgHome, 'CALLMEBOT_KEY=globalkey\nWHATSAPP_PHONE=+15550000\n')

    // CALLMEBOT_KEY is present but empty → it stays empty (not filled), so the
    // notification guard `[ -n "$CALLMEBOT_KEY" ]` is false and nothing sends.
    const res = runLoopNoCreds({
      extraEnv: { XDG_CONFIG_HOME: xdgHome, CALLMEBOT_KEY: '' },
    })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).not.toContain('WhatsApp notification sent')
    expect(existsSync(curlLog), 'curl must not be called when the cred is empty').toBe(false)
  })

  // QA: absent global file is a silent no-op — the loop still finishes cleanly
  // and simply sends no notification (no error, no hang).
  it('QA: a missing global file is a silent no-op (loop still exits cleanly)', () => {
    seedHappyPath(1)
    const curlLog = join(workdir, 'curl.log')
    writeStub('curl', `#!/bin/bash\necho "$*" >> "${curlLog}"\nexit 0\n`)
    if (REAL_JQ) writeStub('jq', `#!/bin/bash\nexec "${REAL_JQ}" "$@"\n`)

    // XDG points at a dir with no ralph/.env inside.
    const xdgHome = join(workdir, 'xdg-empty')
    mkdirSync(xdgHome, { recursive: true })

    const res = runLoopNoCreds({ extraEnv: { XDG_CONFIG_HOME: xdgHome } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(existsSync(curlLog)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Issue #565 — TASK_SOURCE=folder. The loop draws tasks from a local
// `.ralph/tasks/afk/todo` tree instead of GitHub, shelling out to
// lib/folder-queue.js for count/pick/locate/fail. It must NEVER touch gh in
// folder mode. The happy-path agent moves the task todo→done itself; bash owns
// the failure/no-op sweep (todo|in-progress → failed) and the zero-progress
// guard. Telemetry records the task id as issue_number and the terminal
// directory as the verdict. TASK_SOURCE is supplied via env here (no
// ralph.config.sh) so the lazy-validation block stays skipped and the test
// isolates the main loop's source dispatch.
// ---------------------------------------------------------------------------
describe('ralph.sh folder task source — issue #565', () => {
  // node stub: delegate the real JS bridges (folder-queue.js, agent-invocation.js,
  // capture-issue-event.js) to the real node; everything else echoes a prompt.
  // jq: minimal no-op streamer. gh: records ANY invocation so the test can prove
  // folder mode never touches it.
  function seedFolderStubs() {
    writeStub(
      'node',
      `#!/bin/bash
case "$*" in
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
  *folder-queue.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`,
    )
    writeStub('jq', `#!/bin/bash\ncat > /dev/null 2>/dev/null || true\nexit 0\n`)
    writeStub(
      'gh',
      `#!/bin/bash\necho "$*" >> "${join(workdir, 'gh-called.log')}"\nexit 0\n`,
    )
  }

  function writeTask(status, file, body = 'do the thing') {
    const dir = join(workdir, '.ralph', 'tasks', 'afk', status)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), body)
  }

  it('drains the folder queue: completes tasks, records folder telemetry, never touches gh', () => {
    seedFolderStubs()
    // Happy-path agent: moves the lowest-numbered todo task to done (mirrors the
    // git mv the folder orchestrator prompt instructs the real agent to perform).
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
    writeTask('todo', '001-first.md')
    writeTask('todo', '002-second.md')

    const res = runLoop({ timeout: 20000, extraEnv: { TASK_SOURCE: 'folder' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).toMatch(/2 ok, 0 failed/)

    // Both tasks ended in done.
    expect(existsSync(join(workdir, '.ralph', 'tasks', 'afk', 'done', '001-first.md'))).toBe(true)
    expect(existsSync(join(workdir, '.ralph', 'tasks', 'afk', 'done', '002-second.md'))).toBe(true)

    // gh must NEVER be invoked in folder mode (zero-regression the other way:
    // folder mode is entirely gh-free).
    expect(
      existsSync(join(workdir, 'gh-called.log')),
      `gh was invoked in folder mode:\n${existsSync(join(workdir, 'gh-called.log')) ? readFileSync(join(workdir, 'gh-called.log'), 'utf8') : ''}`,
    ).toBe(false)

    // Telemetry: one RALPH_ISSUE_EVENT per task; verdict pass; issue_number is
    // the task id.
    const metricsFile = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    expect(existsSync(metricsFile), `no metrics. stderr:\n${res.stderr}`).toBe(true)
    const events = readFileSync(metricsFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)))
    expect(events.length).toBe(2)
    for (const ev of events) expect(ev.verdict).toBe('pass')
    expect(events.map((e) => e.issue_number).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('sweeps an uncompleted task to failed and records it as a failure (no infinite spin)', () => {
    seedFolderStubs()
    // Agent fails without moving the task; bash must sweep it out of todo.
    writeStub('claude', `#!/bin/bash\ncat > /dev/null\necho "boom" >&2\nexit 1\n`)
    writeTask('todo', '007-broken.md')

    const res = runLoop({ timeout: 20000, extraEnv: { TASK_SOURCE: 'folder' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status).toBe(0)

    // Swept out of todo into failed so the queue drains (no infinite spin).
    expect(existsSync(join(workdir, '.ralph', 'tasks', 'afk', 'todo', '007-broken.md'))).toBe(false)
    expect(existsSync(join(workdir, '.ralph', 'tasks', 'afk', 'failed', '007-broken.md'))).toBe(true)
    expect(res.stdout).toMatch(/0 ok, 1 failed/)

    // Folder telemetry: verdict fail; issue_number is the task id.
    const events = readFileSync(join(workdir, '.ralph', 'metrics', 'issues.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)))
    expect(events.length).toBe(1)
    expect(events[0].verdict).toBe('fail')
    expect(events[0].issue_number).toBe(7)
  })

  // -------------------------------------------------------------------------
  // QA augmentation (#40) — the label sweep lives in the GITHUB branch, after
  // the folder branch's `continue`, so folder mode must remain 100% gh-free.
  // The happy-path test above already asserts gh-zero for an all-success run;
  // this strengthens it to a MIXED run that exercises the folder failure sweep
  // and the zero-progress guard — the paths that would be reached if the label
  // hygiene code had leaked out of the github branch.
  // -------------------------------------------------------------------------
  it('QA: folder mode invokes gh ZERO times even on a mixed success/failure run (#40 sweep is github-only)', () => {
    seedFolderStubs()
    // The agent completes only task 001 and leaves 002 sitting in todo, so bash
    // must run its failure sweep for 002 (and the label-hygiene block must not
    // be reachable from there).
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
TODO="$PROJECT_ROOT/.ralph/tasks/afk/todo"
DONE="$PROJECT_ROOT/.ralph/tasks/afk/done"
mkdir -p "$DONE"
[ -f "$TODO/001-first.md" ] && mv "$TODO/001-first.md" "$DONE/"
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )
    writeTask('todo', '001-first.md')
    writeTask('todo', '002-stuck.md')

    const res = runLoop({ timeout: 20000, extraEnv: { TASK_SOURCE: 'folder' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toMatch(/1 ok, 1 failed/)

    // Both terminal states reached (success + swept failure).
    expect(existsSync(join(workdir, '.ralph', 'tasks', 'afk', 'done', '001-first.md'))).toBe(true)
    expect(existsSync(join(workdir, '.ralph', 'tasks', 'afk', 'failed', '002-stuck.md'))).toBe(true)

    // The decisive assertion: gh was never invoked — not for the queue count,
    // not for a label read, and above all not for `--remove-label claude-working`.
    const ghLog = join(workdir, 'gh-called.log')
    expect(
      existsSync(ghLog),
      `gh was invoked in folder mode:\n${existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : ''}`,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Issue #40 — no iteration may end with a stale `claude-working` label. The
// label is added when work starts (prompt-team.md step 2) and removed by the
// agent on only two paths: PR opened (→ pending-merge) and gave up (→
// claude-failed). When a merged PR closes the issue via `Closes #N` neither
// path runs, so the label survives on an issue the loop counted as a SUCCESS.
// That poisons `claude-working` as the "what is the loop on right now?" signal
// and, if the issue is ever reopened, silently excludes it from the queue
// (the search filter is `-label:claude-working`). Bash owns the sweep because
// it is the component that classifies the outcome. Removal must be idempotent
// and best-effort: a missing label or a failing/hanging gh must never abort the
// iteration nor flip its outcome to failed.
// ---------------------------------------------------------------------------
describe('ralph.sh claude-working label hygiene — issue #40', () => {
  // A one-issue GitHub queue whose `gh issue view` reports the given labels +
  // state, and whose `gh issue edit` records the argv it received to
  // gh-edit.log (so a test can prove exactly what the loop asked GitHub to
  // change) and exits with `editExit`. `drains: false` keeps the queue count
  // pinned so the same issue is re-selected and the zero-progress guard fires
  // (the failure path).
  //
  // A near-twin lives in test/loop.label-hygiene.adversarial.test.js (the #40
  // hostile paths). That copy adds `logAllCalls` / `editExtra` options which only
  // its tests need; keep the two in sync when changing the stub's behavior.
  function seedLabelledIssue({
    labels = 'claude-working',
    state = 'CLOSED',
    editExit = 0,
    claudeExit = 0,
    drains = true,
  } = {}) {
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo '{"type":"result","subtype":"success"}'
exit ${claudeExit}
`,
    )
    writeFileSync(join(workdir, 'count.txt'), '1')
    writeStub(
      'gh',
      `#!/bin/bash
CNT_FILE="${join(workdir, 'count.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cnt=$(cat "$CNT_FILE")
  case "$*" in
    *sort:created-asc*)
      echo "$cnt"
      ${drains ? 'echo "$((cnt - 1))" > "$CNT_FILE"' : ': # queue never drains'}
      ;;
    *)
      echo "$cnt"
      ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "${labels}" ;;
    *state*)  echo "${state}" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  echo "$*" >> "${join(workdir, 'gh-edit.log')}"
  exit ${editExit}
fi
exit 0
`,
    )
  }

  // Every `gh issue edit` argv the loop issued, one per line.
  function readEdits() {
    const f = join(workdir, 'gh-edit.log')
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
  }

  it('removes claude-working from an issue counted as a success because it is CLOSED', () => {
    seedLabelledIssue({ labels: 'claude-working', state: 'CLOSED' })

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    // Still classified a success — the sweep must not change the outcome.
    expect(res.stdout).toMatch(/1 ok, 0 failed/)

    const edits = readEdits()
    expect(
      edits.some((e) => /^issue edit 1 .*--remove-label claude-working/.test(e)),
      `loop never removed claude-working. gh issue edit calls:\n${edits.join('\n')}`,
    ).toBe(true)
  })

  it('removes claude-working on the pending-merge success path (never both labels)', () => {
    // The agent opened a PR and set pending-merge but left claude-working on
    // (or the removal half of its two-flag edit failed): after the iteration
    // the two labels must never coexist.
    seedLabelledIssue({ labels: 'pending-merge,claude-working', state: 'OPEN' })

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toMatch(/1 ok, 0 failed/)

    const edits = readEdits()
    expect(
      edits.some((e) => /^issue edit 1 .*--remove-label claude-working/.test(e)),
      `loop never removed claude-working. gh issue edit calls:\n${edits.join('\n')}`,
    ).toBe(true)
    // And it never re-adds it.
    expect(edits.some((e) => /--add-label claude-working/.test(e))).toBe(false)
  })

  it('a failed iteration ends with claude-failed and no claude-working', () => {
    // Agent exits non-zero, issue still OPEN carrying claude-working and no
    // exclusion label: bash marks it claude-failed, and the stale
    // claude-working must go with it.
    seedLabelledIssue({
      labels: 'claude-working',
      state: 'OPEN',
      claudeExit: 1,
      drains: false,
    })

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toMatch(/0 ok, [1-9]\d* failed/)

    const edits = readEdits()
    expect(edits.some((e) => /--add-label claude-failed/.test(e))).toBe(true)
    expect(
      edits.some((e) => /^issue edit 1 .*--remove-label claude-working/.test(e)),
      `loop never removed claude-working on the failure path. gh issue edit calls:\n${edits.join('\n')}`,
    ).toBe(true)
  })

  it('is idempotent when the issue never carried the label (no error, still a success)', () => {
    seedLabelledIssue({ labels: '', state: 'CLOSED' })

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toMatch(/1 ok, 0 failed/)

    // No "does it have the label?" pre-check — gh treats removing an absent
    // label as a no-op, so the terminal path makes exactly one attempt.
    const removals = readEdits().filter((e) => /--remove-label claude-working/.test(e))
    expect(removals.length).toBe(1)
  })

  it.each([1, 124])(
    'a gh issue edit that exits %i (failure / timeout) neither aborts the iteration nor flips it to failed',
    (editExit) => {
      seedLabelledIssue({ labels: 'claude-working', state: 'CLOSED', editExit })

      const res = runLoop({ timeout: 15000 })
      expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
      // `set -u` is on and no `set -e`, but a bare failing command in some
      // shells/positions can still abort — the `|| true` convention must hold.
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
      expect(res.stdout).toContain('Queue empty, exiting.')
      expect(res.stdout).toMatch(/1 ok, 0 failed/)
      expect(readEdits().some((e) => /--remove-label claude-working/.test(e))).toBe(true)
    },
  )
})

// ---------------------------------------------------------------------------
// Issues #127 + #128 — TASK_SOURCE=jira. The loop SELECTS a Jira ticket and CLAIMS it (#127),
// so a run visibly takes ownership on the board before anything else can happen, and then
// HANDS THAT TICKET TO THE AGENT (#128). Four arms of the script are involved and all four
// are exercised here through the real JS bridges: the source normalizer, `queue_count`, the
// selection block, and the claim-then-dispatch block.
//
// `acli` IS A STUB ON PATH, and that is the whole point of testing it here: no test in this
// repo may run the real Atlassian CLI (there is none in CI, and a claim is a WRITE to
// somebody's board), but the argv Ralph sends and the JSON it parses are exactly what
// lib/jira-queue.js produces, and this suite is where bash, that module and the run record
// are proven to agree. The stub also models the ONE behaviour that makes the loop
// terminate: once the ticket carries `in-progress`, the composed query stops matching it,
// so the next count is 0.
//
// THE AGENT IS A STUB TOO, and it records both its argv AND its stdin: stdin is the whole
// handoff in jira mode, because bash tells the agent nothing but the key and the rendered
// prompt is where that key turns into instructions. So the `claude` stub keeps the prompt on
// disk and the prompt-builder is the REAL lib/build-prompt.js — the one seam that proves the
// exported key reaches the template. `gh` stays a recording stub for the opposite reason:
// jira mode must never reach GitHub, and the log's absence is the proof.
// TASK_SOURCE and JIRA_JQL arrive via env (no ralph.config.sh) for the same reason as the
// folder suite: it keeps the lazy-validation block skipped so the test isolates the loop.
// ---------------------------------------------------------------------------
describe('ralph.sh jira task source — issues #127 + #128 + #130', () => {
  const JQL = 'project = RALPH AND statusCategory != Done'

  const acliLog = () => join(workdir, 'acli-called.log')
  const claimedFlag = () => join(workdir, 'acli-claimed')
  const claudeLog = () => join(workdir, 'claude-called.log')
  // The prompt the agent was actually fed (#128) — the stub's stdin, appended so a
  // second invocation could never masquerade as the first.
  const promptLog = () => join(workdir, 'claude-prompt.txt')
  // THE BOARD, in one file: the ticket's labels as a comma-joined list. #130 made this
  // fixture stateful, because the outcome branch READS the board back after the agent has
  // run — against a `view` that always printed the seeded labels, a ticket the agent had
  // just completed would still read as un-done and get swept, and the test would be pinning
  // the fixture rather than the loop.
  const labelsFile = () => join(workdir, 'acli-labels.txt')
  const boardLabels = () => readLog(labelsFile()).trim()

  const readLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  const acliCalls = () => readLog(acliLog()).split('\n').filter(Boolean)

  // The acli stub: one script answering the five argv shapes lib/jira-queue.js sends (the
  // count, the pick, the label read, and the two label writes — `--labels` and
  // `--remove-labels`, which share the `edit` subcommand). Both writes update the label
  // file, so the read answers with whatever Ralph last wrote.
  //
  // WHAT MAKES THE LOOP TERMINATE, and it is now the same thing that makes it terminate on a
  // real board: the count and the pick apply Ralph's own exclusion to those labels, so a
  // ticket carrying `in-progress`, `done` or `failed` drops out of the queue. `acli-claimed`
  // survives as a way for a test to declare the board empty up front.
  function seedJiraStubs({ summary = 'Do the thing', labels = 'frontend,p2' } = {}) {
    writeFileSync(labelsFile(), labels)
    writeStub(
      'node',
      `#!/bin/bash
case "$*" in
  *jira-queue.js*) exec "${REAL_NODE}" "$@" ;;
  *run-state.js*) exec "${REAL_NODE}" "$@" ;;
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
  # #128: the REAL prompt builder, not the "PROMPT" placeholder below. What this
  # suite has to prove is that the key bash exported is the key the agent is told
  # to work, and a stubbed builder would prove only that bash ran something.
  *build-prompt.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`,
    )
    writeStub(
      'acli',
      `#!/bin/bash
echo "$*" >> "${acliLog()}"
LABELS="${labelsFile()}"

# Ralph's own exclusion, applied to the label file: the three labels it writes are the three
# the composed query refuses (lib/jira-jql.js), so a ticket carrying any of them is not in
# the queue any more.
excluded() {
  [ -f "${claimedFlag()}" ] && return 0
  grep -qE '(^|,)(in-progress|done|failed)(,|\$)' "\$LABELS" 2>/dev/null
}

# The label list as acli prints it: a JSON array of strings, or [] when the ticket has none.
print_labels() {
  local list; list=\$(cat "\$LABELS" 2>/dev/null || true)
  if [ -z "\$list" ]; then
    echo '{"key":"FOO-123","fields":{"labels":[]}}'
  else
    echo '{"key":"FOO-123","fields":{"labels":['"\$(printf '%s' "\$list" | sed 's/[^,][^,]*/"&"/g')"']}}'
  fi
}

case "$*" in
  *--count*)
    if excluded; then echo 0; else echo 1; fi ;;
  *"--limit 1"*)
    if excluded; then
      echo '[]'
    else
      echo '[{"key":"FOO-123","fields":{"summary":"${summary}"}}]'
    fi ;;
  *" view "*)
    print_labels ;;
  *" edit "*)
    prev=""
    for a in "\$@"; do
      case "\$prev" in
        --labels)
          # acli's own semantics are unknown to this repo, so the stub picks the harsher
          # reading: --labels REPLACES. Ralph's writes are read-then-union, so they survive it.
          printf '%s' "\$a" > "\$LABELS" ;;
        --remove-labels)
          old=\$(cat "\$LABELS" 2>/dev/null || true)
          new=""
          OLDIFS=\$IFS; IFS=','
          for l in \$old; do
            [ "\$l" = "\$a" ] || new="\${new:+\$new,}\$l"
          done
          IFS=\$OLDIFS
          printf '%s' "\$new" > "\$LABELS" ;;
      esac
      prev="\$a"
    done ;;
esac
exit 0
`,
    )
    writeStub('jq', `#!/bin/bash\ncat > /dev/null 2>/dev/null || true\nexit 0\n`)
    writeStub('gh', `#!/bin/bash\necho "$*" >> "${join(workdir, 'gh-called.log')}"\nexit 0\n`)
    writeStub(
      'claude',
      `#!/bin/bash\ncat >> "${promptLog()}"\necho "$*" >> "${claudeLog()}"\nexit 0\n`,
    )
  }

  const runJira = (extraEnv = {}) =>
    runLoop({ timeout: 20000, extraEnv: { TASK_SOURCE: 'jira', JIRA_JQL: JQL, ...extraEnv } })

  it('selects the top ticket, claims it with in-progress, and names the key in the iteration line', () => {
    seedJiraStubs()
    const res = runJira()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    // The iteration line names the TICKET, not a number Ralph derived from it.
    expect(res.stdout).toContain('==> Iteration for FOO-123 (1 remaining)')

    // The count and the pick both went through the COMPOSED query — Ralph's exclusion and
    // its ordering, not the user's clause alone.
    const calls = acliCalls()
    const counted = calls.find((c) => c.includes('--count'))
    const picked = calls.find((c) => c.includes('--limit 1'))
    expect(counted, calls.join('\n')).toContain(JQL)
    expect(counted).toContain('labels NOT IN (in-progress, done, failed, do-not-ralph)')
    expect(picked, calls.join('\n')).toContain('--fields key,summary')
    expect(picked).toContain('ORDER BY created ASC')

    // The claim is read-then-union, and it is unattended.
    expect(calls.some((c) => c.startsWith('jira workitem view --key FOO-123'))).toBe(true)
    const edit = calls.find((c) => c.includes(' edit '))
    expect(edit, calls.join('\n')).toContain('--labels frontend,p2,in-progress')
    expect(edit).toContain('--yes')
  })

  it('records the ticket as the in-flight task in .ralph/run-state.json', () => {
    seedJiraStubs()
    const res = runJira()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    const record = JSON.parse(readFileSync(join(workdir, '.ralph', 'run-state.json'), 'utf8'))
    expect(record.source).toBe('jira')
    expect(record.current).toMatchObject({ task_key: 'FOO-123', number: 123, iteration: 1 })
    expect(typeof record.current.started_at).toBe('string')
  })

  it('invokes the agent once for the claimed ticket and never invokes gh — #128', () => {
    seedJiraStubs()
    const res = runJira()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    // GitHub is not in this flow at all: the queue, the claim and the work item all
    // come from acli, and a `gh` call here would mean an arm leaked across sources.
    expect(
      existsSync(join(workdir, 'gh-called.log')),
      `gh was invoked in jira mode:\n${readLog(join(workdir, 'gh-called.log'))}`,
    ).toBe(false)

    // ONE invocation for the ONE ticket the iteration claimed. #127 shipped
    // selection + the claim and stopped; #128 is the dispatch that follows it.
    expect(
      existsSync(claudeLog()),
      `the agent was NOT invoked for the claimed jira ticket`,
    ).toBe(true)
    expect(readLog(claudeLog()).split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('logs the agent run under the ticket KEY, not the empty numeric handle — #128', () => {
    seedJiraStubs()
    const res = runJira()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    // $num is deliberately empty in jira mode (lib/run-state.js derives the numeric
    // handle from the key), so passing it to run_agent_for_issue would collapse every
    // ticket onto `logs/ralph-issue-.log`. The key keeps one log per ticket — and this
    // pair of assertions is the only thing that can tell those two apart.
    expect(existsSync(join(workdir, 'logs', 'ralph-issue-FOO-123.log'))).toBe(true)
    expect(existsSync(join(workdir, 'logs', 'ralph-issue-FOO-123.jsonl'))).toBe(true)
    expect(existsSync(join(workdir, 'logs', 'ralph-issue-.log'))).toBe(false)
  })

  it('feeds the agent a fully rendered jira prompt naming the claimed ticket — #128', () => {
    seedJiraStubs()
    const res = runJira()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    const prompt = readLog(promptLog())

    // The source picked the template, not the agent: jira mode gets the commit-direct
    // orchestrator even though RALPH_AGENT is the default claude.
    expect(prompt, prompt.slice(0, 400)).toContain(
      '# Ralph Loop — Team orchestrator (Jira mode)',
    )
    // The exported key reached {{RALPH_TASK_KEY}} — the read, the commit subject and
    // the trailer all name the ticket bash claimed.
    expect(prompt).toContain('acli jira workitem view --key FOO-123')
    expect(prompt).toContain('fix: <description> (FOO-123)')
    expect(prompt).toContain('Resolves FOO-123')
    // Nothing was left unrendered, and nothing tells the agent to reach for GitHub.
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(prompt).not.toMatch(/gh issue/)
    expect(prompt).not.toMatch(/gh pr create/)
  })

  it('exits on an empty Jira queue without spawning a pick', () => {
    seedJiraStubs()
    // `acli-claimed` is the stub's "every candidate is already excluded" switch, so seeding
    // it up front is a board with nothing eligible on it.
    writeFileSync(claimedFlag(), '')
    const res = runJira()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).not.toContain('Iteration for')
    expect(acliCalls().some((c) => c.includes('--limit 1'))).toBe(false)
  })

  it('counts nothing and claims nothing when JIRA_JQL is unset — no query, no acli', () => {
    // jira-jql.js refuses an empty eligibility clause, because Ralph's half alone selects
    // every work item on the site. The loop must read that refusal as an empty queue.
    seedJiraStubs()
    const res = runJira({ JIRA_JQL: '' })
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(acliCalls(), acliCalls().join('\n')).toEqual([])
  })

  it('warns and does not abort when the claim fails, leaving the ticket eligible', () => {
    seedJiraStubs()
    // An acli that reads fine and refuses to write: the claim's failure mode that matters,
    // since a ticket nobody could claim must not take the run down with it.
    writeStub(
      'acli',
      `#!/bin/bash
echo "$*" >> "${acliLog()}"
case "$*" in
  *--count*) echo 1 ;;
  *"--limit 1"*) echo '[{"key":"FOO-123","fields":{"summary":"Do the thing"}}]' ;;
  *" view "*) echo '{"key":"FOO-123","fields":{"labels":[]}}' ;;
  *" edit "*) echo "permission denied" >&2; exit 1 ;;
esac
exit 0
`,
    )
    const res = runJira()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toContain('==> Iteration for FOO-123 (1 remaining)')
    expect(res.stderr).toContain('FOO-123')
  })

  // --- #130: THE DRAIN GUARANTEE -------------------------------------------------------
  // What the three tests below are for: an agent invocation that produced NOTHING must not
  // leave the ticket the way it found it. In jira mode the loop's own hands are tied — it
  // has no PR to inspect and it deliberately does not read the agent's exit code as a verdict
  // (an agent killed after committing did the work; one that exited 0 having done nothing did
  // not) — so it asks the BOARD what happened and writes `failed` on anything that is not
  // `done`. A label is the one write no Jira workflow can refuse, which is what makes this a
  // guarantee rather than an attempt.
  //
  // The fixture's `acli` is stateful (see seedJiraStubs), so these tests watch a board change:
  // the claim's `in-progress` goes on, the agent does or does not record `done`, and the
  // sweep's `failed` is what makes the next count zero and the run end.
  const JIRA_QUEUE_JS = join(RALPH_TEMPLATE, '..', '..', 'lib', 'jira-queue.js')

  // An agent that completes its ticket the way prompt-team-jira.md's step 7 tells it to: by
  // calling `lib/jira-queue.js complete` (#129), against this suite's stub acli. Not a
  // shortcut that writes the label file directly — the point of the success case is that what
  // the REAL completion verb writes is what the loop's `locate` reads back as done.
  const seedCompletingAgent = () =>
    writeStub(
      'claude',
      `#!/bin/bash
cat >> "${promptLog()}"
echo "$*" >> "${claudeLog()}"
"${REAL_NODE}" "${JIRA_QUEUE_JS}" complete "$RALPH_TASK_KEY" >/dev/null 2>&1
exit 0
`,
    )

  it('sweeps a ticket the agent left un-done to `failed`, naming the key and the state — #130', () => {
    // The default `claude` stub reads the prompt, records the call and exits 0 WITHOUT
    // touching the board: the no-op iteration, which is the common case this exists for.
    seedJiraStubs()
    const res = runJira()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    // The warning names the ticket AND the state the board was found in — `working`, because
    // the claim is the last thing that wrote to it. Without the state, an operator reading
    // the log cannot tell a no-op agent from an unreadable ticket.
    expect(res.stderr, res.stderr).toContain('FOO-123 was not completed (state: working)')

    // The board carries `failed` and no longer carries `in-progress`: swept, not just noted.
    expect(boardLabels().split(',')).toEqual(['frontend', 'p2', 'failed'])

    // And that is what drains the queue: `failed` is excluded by the composed query, so the
    // next count is 0 and the run ends instead of handing the same ticket out again.
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).toMatch(/0 ok, 1 failed/)
  })

  it('sweeps a ticket whose agent was KILLED, and still drains the queue — #130', () => {
    seedJiraStubs()
    // SIGKILL's shell status, no output, nothing written to the board — the tmux-killed run,
    // the OOM, the crash. The sweep is unconditional on the exit code precisely so that this
    // case is indistinguishable from the no-op one as far as the queue is concerned.
    writeStub('claude', `#!/bin/bash\ncat > /dev/null\necho "$*" >> "${claudeLog()}"\nexit 137\n`)
    const res = runJira()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    expect(res.stderr, res.stderr).toContain('FOO-123 was not completed (state: working)')
    expect(boardLabels().split(',')).toContain('failed')
    expect(boardLabels().split(',')).not.toContain('in-progress')

    // ONE invocation for the ONE ticket: the killed agent is not retried, and the ticket it
    // could not finish is not handed to a second paid call.
    expect(readLog(claudeLog()).split('\n').filter(Boolean)).toHaveLength(1)
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).toMatch(/0 ok, 1 failed/)
    expect(res.stdout).toContain('FAIL: #FOO-123')
  })

  it('leaves a COMPLETED ticket alone and lists it under successes — #130', () => {
    seedJiraStubs()
    seedCompletingAgent()
    const res = runJira()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    // NOT swept: the sweep is what the loop does to a ticket it cannot prove is finished, and
    // a `done` label is that proof. A sweep here would file a false verdict against work that
    // actually landed — and `failed` beside `done` on somebody's board.
    expect(res.stderr, res.stderr).not.toContain('was not completed')
    expect(boardLabels().split(',')).toEqual(['frontend', 'p2', 'done'])
    expect(acliCalls().some((c) => c.includes('--labels frontend,p2,in-progress,failed'))).toBe(
      false,
    )

    // The summary reports the KEY, under OK, and reports it as the only outcome of the run.
    expect(res.stdout).toMatch(/1 ok, 0 failed/)
    expect(res.stdout).toContain('OK: #FOO-123')
    expect(res.stdout).toContain('FAIL: -')
  })

  it('aborts instead of re-selecting a ticket no write can reach — #130', () => {
    // The board that refuses every write: neither the claim nor the sweep can label anything,
    // so the ticket stays eligible and the queue cannot drain. This is the case the
    // zero-progress guard is for, and the guard runs BEFORE the dispatch, so the second
    // selection costs a `pick` and not a second agent invocation.
    seedJiraStubs()
    writeStub(
      'acli',
      `#!/bin/bash
echo "$*" >> "${acliLog()}"
case "$*" in
  *--count*) echo 1 ;;
  *"--limit 1"*) echo '[{"key":"FOO-123","fields":{"summary":"Do the thing"}}]' ;;
  *" view "*) echo '{"key":"FOO-123","fields":{"labels":[]}}' ;;
  *" edit "*) echo "permission denied" >&2; exit 1 ;;
esac
exit 0
`,
    )
    const res = runJira()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    // The sweep was ATTEMPTED — an unreadable-or-unwritable board is exactly when the
    // guarantee matters — and its failure is on stderr rather than swallowed, because that
    // sentence is the only record of why the ticket is still open.
    expect(res.stderr, res.stderr).toContain('FOO-123 was not completed (state: open)')
    expect(res.stderr).toContain('no progress on FOO-123 (re-selected)')
    expect(readLog(claudeLog()).split('\n').filter(Boolean)).toHaveLength(1)
    expect(res.stdout).toMatch(/0 ok, 1 failed/)
  })

  // --- #131: PER-TICKET TELEMETRY ------------------------------------------------------
  // The arm now appends one RALPH_ISSUE_EVENT per iteration, the way the other two do, and
  // the event carries the ticket KEY as a field of its own beside the number derived from
  // it. These read the file the real sidecar wrote (the `node` stub delegates
  // capture-issue-event.js to the real binary), so what is pinned is bash's env block and
  // lib/capture-issue-event.js agreeing — which is the one thing neither side's unit tests
  // can prove alone.
  const metricsFile = () => join(workdir, '.ralph', 'metrics', 'issues.jsonl')
  const events = () =>
    readLog(metricsFile())
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)))

  it('appends one event carrying the ticket key and the derived number — #131', () => {
    seedJiraStubs()
    seedCompletingAgent()
    const res = runJira()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    expect(existsSync(metricsFile()), `no metrics. stderr:\n${res.stderr}`).toBe(true)
    const all = events()
    expect(all).toHaveLength(1)
    expect(all[0].task_key).toBe('FOO-123')
    expect(all[0].issue_number).toBe(123)
    // A completed ticket is a pass, read off the board rather than off the exit code.
    expect(all[0].verdict).toBe('pass')
    // The run id joins this event to the run's own RALPH_CYCLE_EVENT, and the agent, the
    // exit code and a measured duration are all populated — the same fields the github and
    // folder arms pass. The duration is a COUNT OF MILLISECONDS the loop measured; it can
    // legitimately be 0 for a stub that returns inside one second, so its type is what is
    // asserted rather than a floor a fast machine would break.
    expect(all[0].run_id).toMatch(/^ralph-test-\d+$/)
    expect(all[0].agent).toBe('claude')
    expect(all[0].claude_exit_code).toBe(0)
    expect(typeof all[0].duration_ms).toBe('number')
    expect(Number.isFinite(all[0].duration_ms)).toBe(true)

    // NO gh call, from the loop or from the sidecar: jira mode opens no PR, so there is no
    // diff to fetch, and a machine without `gh` must still get complete telemetry.
    expect(
      existsSync(join(workdir, 'gh-called.log')),
      `gh was invoked in jira mode:\n${readLog(join(workdir, 'gh-called.log'))}`,
    ).toBe(false)
    expect(all[0].files).toBe(0)
    expect(all[0].insertions).toBe(0)
    expect(all[0].deletions).toBe(0)
  })

  it('records a SWEPT ticket as a fail, so the summary and the log agree — #131', () => {
    // The default stub leaves the board untouched, so the loop sweeps the ticket to
    // `failed` — and the event must carry the same verdict the run summary printed, or the
    // two records of one iteration disagree.
    seedJiraStubs()
    const res = runJira()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toMatch(/0 ok, 1 failed/)

    const all = events()
    expect(all).toHaveLength(1)
    expect(all[0].task_key).toBe('FOO-123')
    expect(all[0].verdict).toBe('fail')
  })

  it('names the per-ticket logs by the KEY, so the event describes the right transcript — #131', () => {
    // The env block passes `$task_log_handle`, not `$num`: `$num` is deliberately empty in
    // this mode, so a copy of the folder arm's `logs/ralph-issue-$num.*` would have handed
    // the sidecar `logs/ralph-issue-.jsonl` and every field read out of the stream would be
    // a zero. The stderr signal count is what proves the right file was read.
    seedJiraStubs()
    writeStub(
      'claude',
      `#!/bin/bash\ncat > /dev/null\necho "$*" >> "${claudeLog()}"\necho "Credit balance too low" >&2\nexit 1\n`,
    )
    const res = runJira()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    const all = events()
    expect(all).toHaveLength(1)
    expect(all[0].stderr_error_signals).toBe(1)
    expect(all[0].claude_exit_code).toBe(1)
  })

  it('a telemetry write that CANNOT succeed leaves the outcome and the exit code untouched — #131', () => {
    // `.ralph/metrics` occupied by a FILE, so the sidecar's mkdir can only fail. Telemetry
    // is a sidecar: the ticket is still completed, the summary still says 1 ok, and the run
    // still exits 0.
    seedJiraStubs()
    seedCompletingAgent()
    mkdirSync(join(workdir, '.ralph'), { recursive: true })
    writeFileSync(join(workdir, '.ralph', 'metrics'), 'not a directory')

    const res = runJira()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(res.stdout).toMatch(/1 ok, 0 failed/)
    expect(res.stdout).toContain('OK: #FOO-123')
    expect(boardLabels().split(',')).toContain('done')
  })
})
