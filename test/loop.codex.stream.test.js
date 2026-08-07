import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

const RALPH_TEMPLATE = templatePath('ralph.sh')
// Resolve the REAL node binary so the stub can delegate the agent-invocation
// resolver and the telemetry sidecar to it (the stub shadows `node` on PATH;
// build-prompt.js stays an echo, but the registry bridge + capture must run).
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

// Criterion 15 of #558: drive the REAL bash loop against a stubbed `codex`
// emitting the real observed `codex exec --json` event shape, and prove the
// end-to-end streaming pipeline (NOT just telemetry, which loop.codex.test.js
// already covers). The decisive difference from loop.codex.test.js: we use
// REAL jq (no jq stub), so the real CODEX_STREAM_FILTER from lib/agent-registry.js
// must actually render the stream into the per-issue log. We prove:
//   1. the readable pretty-printed stream lands in logs/ralph-issue-N.log
//      (agent messages + shell commands + `==> result: success`),
//   2. the RAW JSONL sidecar (logs/ralph-issue-N.jsonl) is tee'd verbatim,
//   3. a `turn.failed` stream whose process exits non-zero is detected as a
//      failure (issue gets the claude-failed label), rendering `==> result: error`.
//
// Real-jq caveat: we deliberately do NOT create a `jq` stub, so the real
// /opt/homebrew/bin/jq resolves from the rest of PATH. The loop's other jq uses
// are unaffected: the gh count/number queries are served by the `gh` stub
// returning plain numbers (gh's own `-q` never reaches real jq because gh is
// stubbed), and the `@uri` notification encoding is skipped because we leave
// CALLMEBOT_KEY / WHATSAPP_PHONE empty.

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

function runLoop({ timeout = 15000, once = false } = {}) {
  // Prepend our stub bin to PATH but DO NOT stub jq — real jq resolves from the
  // rest of PATH so the real CODEX_STREAM_FILTER renders for this test.
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-codex-stream-test',
    RALPH_AGENT: 'codex',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
  }
  const args = once ? [RALPH_TEMPLATE, '--once'] : [RALPH_TEMPLATE]
  return spawnSync('bash', args, { cwd: workdir, env, timeout, encoding: 'utf8' })
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-codex-stream-'))
  bindir = join(workdir, 'bin')
  mkdirSync(bindir, { recursive: true })
  mkdirSync(join(workdir, 'logs'), { recursive: true })
  mkdirSync(join(workdir, '.ralph'), { recursive: true })
  writeFileSync(join(workdir, '.ralph', 'state.json'), '{}')

  // git stub: answer rev-parse --show-toplevel with our workdir; no-op the rest.
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

  // node stub: real node for the agent-invocation resolver (so RALPH_AGENT_*
  // and the REAL codex stream filter are emitted from the registry) and the
  // telemetry sidecar; everything else (build-prompt) just emits a dummy prompt.
  writeStub(
    'node',
    `#!/bin/bash
case "$*" in
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`,
  )

  // A claude stub that FAILS the test if ever called — proves the loop drives
  // codex, not claude, when RALPH_AGENT=codex.
  writeStub(
    'claude',
    `#!/bin/bash
cat > /dev/null
echo "claude MUST NOT BE CALLED" >> "${join(workdir, 'claude-calls.log')}"
exit 1
`,
  )

  // NOTE: intentionally NO jq stub — real jq must render CODEX_STREAM_FILTER.

  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (workdir && existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true })
  }
})

describe('ralph.sh main loop — codex real-stream rendering (#558 criterion 15)', () => {
  it('happy path: renders the codex stream to the per-issue log, tees the raw sidecar, tags telemetry codex', () => {
    // codex stub drains the prompt then emits the REAL observed SUCCESS stream
    // shape (thread.started + turn.started + a command_execution item + an
    // agent_message item + turn.completed) on stdout, exiting 0.
    writeStub(
      'codex',
      `#!/bin/bash
cat > /dev/null
echo '{"type":"thread.started","thread_id":"t-1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"i0","type":"command_execution","command":"npm test"}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"Resolved the issue"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
`,
    )

    // 1-issue queue: list returns 1, sort:created-asc returns #1 and decrements
    // the count to 0 so the next list empties the queue; the issue is CLOSED
    // (resolved). Uses the same decrementing count-file idiom as loop.test.js.
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

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Fila vazia, encerrando.')
    expect(existsSync(join(workdir, 'claude-calls.log'))).toBe(false)

    // (1) The per-issue log holds the REAL jq-rendered stream: the agent message
    //     text, the `  $ <command>` shell line, and the `==> result: success`
    //     terminator. If jq were stubbed to a no-op (as in loop.codex.test.js)
    //     these substrings would be absent — this is what proves real rendering.
    const logFile = join(workdir, 'logs', 'ralph-issue-1.log')
    expect(existsSync(logFile), `expected per-issue log. stderr:\n${res.stderr}`).toBe(true)
    const logText = readFileSync(logFile, 'utf8')
    expect(logText).toContain('Resolved the issue')
    expect(logText).toContain('$ npm test')
    expect(logText).toContain('==> result: success')

    // (2) The raw JSONL sidecar is tee'd verbatim between codex and jq, so it
    //     must contain the untouched JSON lines (proves the `tee "$raw_jsonl"`).
    const jsonlFile = join(workdir, 'logs', 'ralph-issue-1.jsonl')
    expect(existsSync(jsonlFile), 'expected raw jsonl sidecar').toBe(true)
    const jsonlText = readFileSync(jsonlFile, 'utf8')
    expect(jsonlText).toContain('"type":"turn.completed"')
    expect(jsonlText).toContain('"type":"item.completed"')

    // (3) Telemetry: exactly one RALPH_ISSUE_EVENT line tagged agent:"codex".
    const metricsFile = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    expect(existsSync(metricsFile), `expected metrics. stderr:\n${res.stderr}`).toBe(true)
    const lines = readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    const ev = JSON.parse(lines[0].slice('RALPH_ISSUE_EVENT '.length))
    expect(ev.agent).toBe('codex')
    expect(ev.verdict).toBe('pass')
  })

  it('failed-turn: a codex run with turn.failed exiting non-zero is detected as failure and labels the issue', () => {
    // codex stub emits the REAL observed FAILED-turn stream (an error item, a
    // top-level error event, and a turn.failed event) and exits 1 — exactly as
    // the CLI does on a failed turn. PIPESTATUS[1] non-zero => claude_failed=1.
    writeStub(
      'codex',
      `#!/bin/bash
cat > /dev/null
echo '{"type":"thread.started","thread_id":"t-1"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata not found"}}'
echo '{"type":"turn.started"}'
echo '{"type":"error","message":"unexpected status 401 Unauthorized"}'
echo '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}'
exit 1
`,
    )

    // gh stub: #98 stays OPEN with no exclusion label. Because codex exited
    // non-zero the loop adds the claude-failed label (captured to edit.log) and,
    // on re-selection of the same #98, the zero-progress guard breaks the loop —
    // so it cannot spin forever. Selections captured to selected.log for bounds.
    writeStub(
      'gh',
      `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*) echo "98" >> "${join(workdir, 'selected.log')}"; echo "98"; exit 0 ;;
    *) echo "8"; exit 0 ;;
  esac
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  echo "$*" >> "${join(workdir, 'edit.log')}"
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

    const res = runLoop({ timeout: 15000 })
    // Must exit on its own — never killed by the timeout (would mean it spun).
    expect(res.signal, `loop was killed by timeout — it spun forever. stdout:\n${res.stdout}`).toBeNull()

    // Failure detection: the loop marked #98 claude-failed (it did NOT treat the
    // non-zero, turn.failed run as a successful/empty run). If failure detection
    // regressed (e.g. exit code ignored) no edit would ever fire.
    const editLog = existsSync(join(workdir, 'edit.log'))
      ? readFileSync(join(workdir, 'edit.log'), 'utf8')
      : ''
    expect(editLog).toContain('--add-label')
    expect(editLog).toContain('claude-failed')

    // Bounded re-selection: #98 selected at least twice (guard fires on
    // re-selection) but not thousands of times — proves the loop advanced.
    const selected = existsSync(join(workdir, 'selected.log'))
      ? readFileSync(join(workdir, 'selected.log'), 'utf8').trim().split('\n')
      : []
    expect(selected.length).toBeGreaterThanOrEqual(2)
    expect(selected.length).toBeLessThanOrEqual(5)

    // The REAL jq filter rendered the failed turn as `==> result: error`.
    const logFile = join(workdir, 'logs', 'ralph-issue-98.log')
    expect(existsSync(logFile), `expected per-issue log. stderr:\n${res.stderr}`).toBe(true)
    expect(readFileSync(logFile, 'utf8')).toContain('==> result: error')

    // Telemetry still records agent:"codex" with the non-zero exit captured.
    const metricsFile = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    expect(existsSync(metricsFile)).toBe(true)
    const lines = readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const ev = JSON.parse(line.slice('RALPH_ISSUE_EVENT '.length))
      expect(ev.agent).toBe('codex')
      expect(ev.claude_exit_code).toBe(1)
    }
  })
})
