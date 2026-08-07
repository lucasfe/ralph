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

// Adversarial / edge-case companions to loop.codex.stream.test.js and
// loop.codex.test.js for issue #558. These reuse the SAME stub-on-PATH harness
// (REAL jq — no jq stub; REAL node only for the agent-invocation bridge and the
// telemetry sidecar) but hit corners the happy-path + single-failure tests miss:
//   - the REAL codex argv boundary: exec/--json/--sandbox/approvals-off/network-on,
//     prompt on stdin (no prompt argument), `-` stdin marker — proving the
//     registry (NOT hard-coded bash) drives the mandated flags at the loop level
//   - RALPH_CODEX_MODEL passthrough into BOTH the codex argv (`-m`) AND telemetry
//     (event.model), plus the unset case => null model, null occupancy (never guessed)
//   - a TRUNCATED codex stream (no terminal turn.completed/turn.failed) exiting
//     non-zero mid-turn: no crash, failure still detected, log + sidecar still exist
//   - codex stderr (non-JSON) routed to the per-issue log IN FULL while real jq
//     renders valid stdout — proving the single stderr-routing impl serves codex too
//
// Real-jq caveat (same as loop.codex.stream.test.js): we deliberately do NOT
// create a `jq` stub, so the real jq resolves from the rest of PATH and the real
// CODEX_STREAM_FILTER renders. The gh count/number `-q` queries never reach real
// jq because gh is stubbed to emit plain numbers, and the `@uri` notify encoding
// is skipped because CALLMEBOT_KEY / WHATSAPP_PHONE are left empty.

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

function runLoop({ timeout = 15000, once = false, extraEnv = {} } = {}) {
  // Prepend our stub bin to PATH but DO NOT stub jq — real jq resolves from the
  // rest of PATH so the real CODEX_STREAM_FILTER renders for this test.
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-codex-adv-test',
    RALPH_AGENT: 'codex',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    ...extraEnv,
  }
  const args = once ? [RALPH_TEMPLATE, '--once'] : [RALPH_TEMPLATE]
  return spawnSync('bash', args, { cwd: workdir, env, timeout, encoding: 'utf8' })
}

// A single-issue CLOSED (resolved) queue: count query returns 1, sort:created-asc
// returns #1 and decrements the count to 0 so the next list empties the queue.
// Exactly ONE codex invocation results — the clean setup the argv/model tests
// need. Uses the same decrementing count-file idiom as loop.codex.stream.test.js.
function seedSingleClosed() {
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
}

// A single-issue OPEN, never-excluded queue for FAILURE paths: #98 is returned
// for every sort:created-asc (appended to selected.log for bounding) and stays
// OPEN with no exclusion label, so a non-zero codex exit makes the loop add
// claude-failed (recorded to edit.log) and, on re-selection, the zero-progress
// guard breaks the loop — it can never spin forever.
function seedOpenFailing() {
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
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-codex-adv-'))
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
  // and the REAL codex stream filter are emitted from the registry, and the
  // env-dependent `-m <model>` flag is composed) and the telemetry sidecar;
  // everything else (build-prompt) just emits a dummy prompt.
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

describe('ralph.sh main loop — codex adversarial / edge cases (#558)', () => {
  it('invokes codex with the mandated argv from the registry: exec/--json/sandbox/approvals-off/network-on, prompt on stdin, `-` marker (no prompt argument)', () => {
    // codex stub records its FULL argv (one token per line) so we can assert the
    // exact flag set the registry composes reaches the CLI — not a bash literal.
    // It drains the piped prompt and emits a minimal success stream so the loop
    // + telemetry complete cleanly.
    writeStub(
      'codex',
      `#!/bin/bash
printf '%s\\n' "$@" > "${join(workdir, 'argv.log')}"
cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
`,
    )
    seedSingleClosed()

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status).toBe(0)
    expect(existsSync(join(workdir, 'claude-calls.log'))).toBe(false)

    // The codex argv, one token per line, exactly as the CLI received it.
    const argvFile = join(workdir, 'argv.log')
    expect(existsSync(argvFile), `expected codex argv log. stderr:\n${res.stderr}`).toBe(true)
    const argv = readFileSync(argvFile, 'utf8').replace(/\n$/, '').split('\n')

    // Every mandated token/flag from CODEX_ARGV must be present, in order, at the
    // real boundary — this is the "network access explicitly enabled + approvals
    // disabled + non-interactive JSONL" contract proven at the LOOP level, not by
    // re-reading the registry constant.
    expect(argv.slice(0, 8)).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ])

    // Prompt-on-stdin contract: the LAST arg is the `-` stdin marker and there is
    // NO prompt string argument (the "PROMPT" body arrives via the stdin pipe, so
    // it must never appear in argv). With RALPH_CODEX_MODEL unset there is also no
    // `-m` flag, so the argv is exactly the 8 base flags + `-` (9 tokens).
    expect(argv[argv.length - 1]).toBe('-')
    expect(argv).not.toContain('PROMPT')
    expect(argv).not.toContain('-m')
    expect(argv.length).toBe(9)
  })

  it('RALPH_CODEX_MODEL set: passes `-m <model>` in the codex argv AND records event.model = that model', () => {
    // With RALPH_CODEX_MODEL set, agent-invocation.js must compose `-m gpt-5-codex`
    // onto the base argv (before the `-` marker), and capture-issue-event.js must
    // record that configured model on the telemetry event (Codex's stream carries
    // no model id, so the configured value is the only source).
    writeStub(
      'codex',
      `#!/bin/bash
printf '%s\\n' "$@" > "${join(workdir, 'argv.log')}"
cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
`,
    )
    seedSingleClosed()

    const res = runLoop({ timeout: 15000, extraEnv: { RALPH_CODEX_MODEL: 'gpt-5-codex' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status).toBe(0)

    // `-m gpt-5-codex` must appear as an ADJACENT flag+value pair in the argv, and
    // the `-` stdin marker must remain LAST (the model flag composes before it).
    const argv = readFileSync(join(workdir, 'argv.log'), 'utf8').replace(/\n$/, '').split('\n')
    const mIdx = argv.indexOf('-m')
    expect(mIdx, `expected -m in codex argv: ${JSON.stringify(argv)}`).toBeGreaterThanOrEqual(0)
    expect(argv[mIdx + 1]).toBe('gpt-5-codex')
    expect(argv[argv.length - 1]).toBe('-')

    // Telemetry records the configured model verbatim.
    const metricsFile = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    expect(existsSync(metricsFile), `expected metrics. stderr:\n${res.stderr}`).toBe(true)
    const lines = readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    const ev = JSON.parse(lines[0].slice('RALPH_ISSUE_EVENT '.length))
    expect(ev.agent).toBe('codex')
    expect(ev.model).toBe('gpt-5-codex')
  })

  it('RALPH_CODEX_MODEL unset: NO `-m` flag, and event.model + context_end_pct are null (occupancy never guessed)', () => {
    // With no configured model, agent-invocation.js must NOT add `-m`, and since
    // Codex's stream carries no model id, telemetry must record model:null AND
    // context_end_pct:null — the loop must never GUESS an occupancy against an
    // assumed window. The stream reports real input_tokens (10), so this proves
    // the null pct comes from the unknown-window path, not from zero tokens.
    writeStub(
      'codex',
      `#!/bin/bash
printf '%s\\n' "$@" > "${join(workdir, 'argv.log')}"
cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
`,
    )
    seedSingleClosed()

    // RALPH_CODEX_MODEL explicitly unset (deleted from the inherited env). Also
    // clear RALPH_CONTEXT_WINDOW so the null-occupancy assertion below is
    // hermetic: with no model AND no window override, the window is genuinely
    // unknown, so context_end_pct MUST be null regardless of the host env.
    const res = runLoop({ timeout: 15000, extraEnv: { RALPH_CODEX_MODEL: '', RALPH_CONTEXT_WINDOW: '' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
    expect(res.status).toBe(0)

    const argv = readFileSync(join(workdir, 'argv.log'), 'utf8').replace(/\n$/, '').split('\n')
    expect(argv).not.toContain('-m')

    const metricsFile = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    const lines = readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    const ev = JSON.parse(lines[0].slice('RALPH_ISSUE_EVENT '.length))
    expect(ev.agent).toBe('codex')
    expect(ev.model).toBeNull()
    expect(ev.context_end_pct).toBeNull()
    // Sanity: tokens WERE parsed (so a null pct is the unknown-window decision,
    // not simply "no usage").
    expect(ev.context_end_tokens).toBe(10)
  })

  it('truncated stream: codex emits a partial line with no terminal turn.completed/turn.failed and exits non-zero — no crash, failure detected, log + sidecar still written', () => {
    // codex emits thread.started then a TRUNCATED (unterminated, non-JSON) line
    // and dies mid-turn with a non-zero exit — a killed/OOM'd CLI. There is NO
    // turn.completed and NO turn.failed, so the ONLY failure signal is the exit
    // code. The loop must (a) not crash, (b) detect the failure via PIPESTATUS
    // (claude_exit_code != 0), (c) still write the per-issue log and the raw
    // jsonl sidecar (partial content is fine), and (d) tag telemetry codex.
    writeStub(
      'codex',
      `#!/bin/bash
cat > /dev/null
echo '{"type":"thread.started","thread_id":"t-1"}'
printf '{"type":"turn.start'
exit 137
`,
    )
    seedOpenFailing()

    const res = runLoop({ timeout: 15000 })
    // Must exit on its own — never killed by the timeout (would mean it spun).
    expect(res.signal, `loop was killed by timeout — it spun forever. stdout:\n${res.stdout}`).toBeNull()
    // Real jq must NOT have choked on the truncated non-JSON line (fromjson?).
    expect(`${res.stdout}\n${res.stderr}`).not.toMatch(/parse error|Invalid numeric literal/i)

    // Failure detection: #98 was marked claude-failed (the truncated, non-zero
    // run was NOT mistaken for a successful/empty run).
    const editLog = existsSync(join(workdir, 'edit.log'))
      ? readFileSync(join(workdir, 'edit.log'), 'utf8')
      : ''
    expect(editLog).toContain('--add-label')
    expect(editLog).toContain('claude-failed')

    // Bounded re-selection: #98 selected at least twice (guard fires on the
    // re-selection) but not thousands of times — proves the loop advanced.
    const selected = existsSync(join(workdir, 'selected.log'))
      ? readFileSync(join(workdir, 'selected.log'), 'utf8').trim().split('\n')
      : []
    expect(selected.length).toBeGreaterThanOrEqual(2)
    expect(selected.length).toBeLessThanOrEqual(5)

    // Both the per-issue log AND the raw jsonl sidecar still exist despite the
    // mid-turn death; the sidecar holds the (partial) bytes tee'd before exit.
    const logFile = join(workdir, 'logs', 'ralph-issue-98.log')
    const jsonlFile = join(workdir, 'logs', 'ralph-issue-98.jsonl')
    expect(existsSync(logFile), `expected per-issue log. stderr:\n${res.stderr}`).toBe(true)
    expect(existsSync(jsonlFile), 'expected raw jsonl sidecar').toBe(true)
    expect(readFileSync(jsonlFile, 'utf8')).toContain('"type":"thread.started"')

    // Telemetry: agent codex, non-zero exit captured on every event.
    const metricsFile = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    expect(existsSync(metricsFile)).toBe(true)
    const lines = readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    for (const line of lines) {
      const ev = JSON.parse(line.slice('RALPH_ISSUE_EVENT '.length))
      expect(ev.agent).toBe('codex')
      expect(ev.claude_exit_code).not.toBe(0)
    }
  })

  it('codex stderr routing: a non-JSON stderr error line lands in the per-issue log IN FULL while real jq still renders valid stdout', () => {
    // codex writes a non-JSON error to STDERR (auth failure) AND valid JSON to
    // stdout, then exits non-zero. This mirrors the claude adversarial stderr
    // test but on the CODEX path with REAL jq: it proves the SINGLE stderr-routing
    // implementation (`2> >(tee -a "$log_file" >&2)`) serves both agents, that the
    // stderr line is NOT fed to jq (which would abort on "Invalid numeric literal"),
    // and that the truncate-once/append-only design lands the WHOLE stderr line.
    writeStub(
      'codex',
      `#!/bin/bash
cat > /dev/null
echo "auth error: token expired" >&2
echo '{"type":"item.completed","item":{"type":"agent_message","text":"partial work"}}'
echo '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}'
exit 1
`,
    )
    seedOpenFailing()

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop was killed by timeout — it spun forever. stdout:\n${res.stdout}`).toBeNull()
    // Real jq must NOT have seen the stderr line — no parse error anywhere.
    expect(`${res.stdout}\n${res.stderr}`).not.toMatch(/parse error|Invalid numeric literal/i)

    const logFile = join(workdir, 'logs', 'ralph-issue-98.log')
    expect(existsSync(logFile), `expected per-issue log. stderr:\n${res.stderr}`).toBe(true)
    const logText = readFileSync(logFile, 'utf8')
    // The COMPLETE stderr line must reach the per-issue log (no clobbering by the
    // stdout tee's truncate — the log is truncated ONCE up front, both tees append).
    expect(logText).toContain('auth error: token expired')
    // AND the valid stdout still rendered through real jq (agent message + the
    // failed-turn terminator), proving stderr routing didn't disturb the JSON pipe.
    expect(logText).toContain('partial work')
    expect(logText).toContain('==> result: error')

    // The failure was detected (claude-failed applied), not swallowed.
    const editLog = existsSync(join(workdir, 'edit.log'))
      ? readFileSync(join(workdir, 'edit.log'), 'utf8')
      : ''
    expect(editLog).toContain('claude-failed')

    // stderr error-signal count is recorded in telemetry (the "auth" line matches
    // the auth/credit/rate-limit signal regex), tagged codex.
    const metricsFile = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    expect(existsSync(metricsFile)).toBe(true)
    const lines = readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const ev = JSON.parse(line.slice('RALPH_ISSUE_EVENT '.length))
      expect(ev.agent).toBe('codex')
      expect(ev.claude_exit_code).toBe(1)
      expect(ev.stderr_error_signals).toBeGreaterThanOrEqual(1)
    }
  })
})
