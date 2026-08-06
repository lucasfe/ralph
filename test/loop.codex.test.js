import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

const RALPH_TEMPLATE = templatePath('ralph.sh')
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

// Codex-agent counterpart to loop.test.js. Drives templates/ralph.sh with
// RALPH_AGENT=codex and a stubbed `codex` CLI that emits `codex exec --json`
// JSONL. Proves the generalized loop invokes codex (not claude), that the
// forward-progress guard still applies, and that per-issue telemetry records
// agent:"codex".

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

function runLoop({ timeout = 15000, once = false } = {}) {
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-codex-test',
    RALPH_AGENT: 'codex',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
  }
  const args = once ? [RALPH_TEMPLATE, '--once'] : [RALPH_TEMPLATE]
  return spawnSync('bash', args, { cwd: workdir, env, timeout, encoding: 'utf8' })
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-codex-loop-'))
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
exit 0
`,
  )

  // node stub: real node for the agent-invocation resolver and the telemetry
  // sidecar; everything else (build-prompt) just emits a dummy prompt.
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

  // codex stub: must be invoked as \`codex exec --json ... -\`. Drains the
  // piped prompt, records the fact it was called (so we can assert claude was
  // NOT), and emits a minimal codex JSONL success stream on stdout.
  writeStub(
    'codex',
    `#!/bin/bash
cat > /dev/null
echo "codex $*" >> "${join(workdir, 'codex-calls.log')}"
echo '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
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

  // jq stub: minimal — pass gh count/number queries through, no-op the stream
  // filter (cosmetic only). We recognize the streaming filter and drain stdin.
  writeStub(
    'jq',
    `#!/bin/bash
for a in "$@"; do
  case "$a" in
    *"item.completed"*|*".type == \\"assistant\\""*)
      cat > /dev/null 2>/dev/null || true
      exit 0
      ;;
  esac
done
cat > /dev/null 2>/dev/null || true
exit 0
`,
  )

  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (workdir && existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true })
  }
})

function seedHappyPath(count = 2) {
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
}

describe('ralph.sh main loop — codex agent (#554)', () => {
  it('drives codex (not claude), drains the queue, and records agent:"codex" telemetry', () => {
    seedHappyPath(2)
    const res = runLoop({ timeout: 15000 })

    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Fila vazia, encerrando.')
    // The loop banner announces the resolved agent.
    expect(res.stdout).toContain('agent: codex')

    // codex was invoked as `codex exec --json ... -`; claude was never called.
    const codexCalls = readFileSync(join(workdir, 'codex-calls.log'), 'utf8')
    expect(codexCalls).toContain('exec')
    expect(codexCalls).toContain('--json')
    expect(existsSync(join(workdir, 'claude-calls.log'))).toBe(false)

    // Per-issue telemetry: each event carries agent:"codex".
    const metricsFile = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    expect(existsSync(metricsFile), `expected metrics. stderr:\n${res.stderr}`).toBe(true)
    const lines = readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    for (const line of lines) {
      const ev = JSON.parse(line.slice('RALPH_ISSUE_EVENT '.length))
      expect(ev.agent).toBe('codex')
      expect(ev.verdict).toBe('pass')
    }
  })

  it('forward-progress guard still fires when codex fails and the issue is never excluded', () => {
    // codex exits non-zero, #98 stays OPEN with no label -> zero-progress guard.
    writeStub(
      'codex',
      `#!/bin/bash
cat > /dev/null
echo "auth error" >&2
exit 1
`,
    )
    writeStub(
      'gh',
      `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*) echo "98" >> "${join(workdir, 'selected.log')}"; echo "98"; exit 0 ;;
    *) echo "8"; exit 0 ;;
  esac
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
    expect(res.signal, `loop was killed by timeout — it spun forever. stdout:\n${res.stdout}`).toBeNull()
    const selected = existsSync(join(workdir, 'selected.log'))
      ? readFileSync(join(workdir, 'selected.log'), 'utf8').trim().split('\n')
      : []
    expect(selected.length).toBeGreaterThanOrEqual(2)
    expect(selected.length).toBeLessThanOrEqual(5)
  })
})
