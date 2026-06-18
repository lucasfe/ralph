import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

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

function runLoop({ timeout = 15000 } = {}) {
  // Prepend our stub bin to PATH; keep the real bash + coreutils available.
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-test',
    // Ensure no real notifications fire.
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
  }
  return spawnSync('bash', [RALPH_TEMPLATE], {
    cwd: workdir,
    env,
    timeout,
    encoding: 'utf8',
  })
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
