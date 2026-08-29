// QA #118 — the forwarding half, in real bash: `cat "$_err" >&2` on the SUCCESS path.
//
// test/loop.adversarial.test.js pins the three claims the change was made for — the typo reaches
// the terminal, the whole stream is forwarded rather than a line bash recognises, and a bridge
// with nothing to say adds nothing. This file is the sweep for what that `cat` does when the
// stream it is handed is NOT one tidy sentence, and for the two failure modes the new line sits
// next to:
//
//   * BOTH `cat`s. `resolve_agent_invocation` now forwards the capture on the failing path AND on
//     the successful one. Those are the only two, they are mutually exclusive by an `exit 1`, and
//     "exactly once" is the promise — so the abort path is driven here as well as the happy one,
//     and the count is asserted on both.
//   * MKTEMP. The capture is a temp file, and the loop runs under `set -u` with no `set -e`. A
//     `mktemp` that fails leaves `_err` empty, and `2>""` is a redirect bash cannot make — so the
//     question is whether the run dies LOUDLY or launches the wrong agent in silence, which is
//     the exact failure #118 was filed about. (This behaviour predates the change: the abort path
//     already `cat`ed. The test exists so the next edit to that function cannot quietly turn a
//     loud abort into a silent one.)
//   * A PATHOLOGICAL STREAM: two hundred kilobytes, an ESC, a NUL, and a final line with no
//     terminator. `cat` is a byte copy by design — the template's own comment says the stream is
//     forwarded UNREAD, precisely so this bash learns nothing about agents — so the claim is that
//     none of it reaches stdout and none of it costs the launch.
//
// It also records, as a passing test, the one precedence the LOOP has and `ralph start` does not:
// .env.local is sourced with `set -a` AFTER ralph.config.sh, so it is the loop's last word on
// RALPH_AGENT. A typo only that file carries is invisible to `ralph start` — the loop half of
// #118's fix is the only thing that reports it, which is worth having pinned.
//
// No raw control byte is typed in this file (#107): the stubs build theirs with printf escapes,
// which are bytes to bash and text on disk.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

const RALPH_TEMPLATE = templatePath('ralph.sh')
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

const LF = String.fromCharCode(10)
const TYPO_WARNING =
  "⚠️  RALPH_AGENT='codx' unrecognized; falling back to 'claude'. Valid: claude, codex."
const ABORT_LINE = 'ralph.sh: failed to resolve agent invocation from lib/agent-invocation.js.'

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

/** The bridge runs for real; every other `node` call is a dummy prompt. */
const nodeStub = (extra = '') => `#!/bin/bash
case "$*" in
  *agent-invocation.js*)
${extra || `    exec "${REAL_NODE}" "$@"`}
    ;;
esac
echo "PROMPT"
exit 0
`

// One `gh issue list` answer of "0" is the whole fixture these need: the agent bridge is resolved
// once at startup, above the loop, so a run that breaks immediately on an empty queue has already
// exercised it.
const EMPTY_QUEUE = `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  echo "0"
  exit 0
fi
exit 0
`

function runLoop({ timeout = 20000, extraEnv = {}, args = [] } = {}) {
  return spawnSync('bash', [RALPH_TEMPLATE, ...args], {
    cwd: workdir,
    env: {
      ...process.env,
      PATH: `${bindir}:${process.env.PATH}`,
      RALPH_TMUX_SESSION: 'ralph-test',
      CALLMEBOT_KEY: '',
      WHATSAPP_PHONE: '',
      ...extraEnv,
    },
    timeout,
    encoding: 'utf8',
  })
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-118-loop-'))
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
  writeStub('node', nodeStub())
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
  writeStub('jq', `#!/bin/bash\ncat > /dev/null 2>/dev/null || true\nexit 0\n`)
  // A guard, not a fixture: an empty queue exits before the agent is invoked, so a `claude` that
  // ever runs here means the test stopped testing what it says it does.
  writeStub('claude', `#!/bin/bash\necho "CLAUDE-SHOULD-NOT-RUN" >&2\nexit 1\n`)
  writeStub('gh', EMPTY_QUEUE)
})

afterEach(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true })
})

const warningLines = (text) => text.split(LF).filter((line) => line.includes('RALPH_AGENT='))

describe('QA #118 — the capture is forwarded exactly once, on whichever path fires', () => {
  // The plain SUCCESS-path row lived here and was cut in review: same stub set, same env, same
  // assertions as test/loop.adversarial.test.js ("lets a mistyped RALPH_AGENT reach the terminal"),
  // for another 1.1s of real-bash spawn. Nothing in this file's own claims went with it — the two
  // rows below drive the abort paths, and both success-path tests further down assert the same
  // exactly-one count on a run that reaches `Queue empty, exiting.`

  it('forwards it once on the ABORT path, and the two cannot both fire', () => {
    // The bridge writes its sentence and then dies. `resolve_agent_invocation` takes the abort
    // branch, which prints its own line, `cat`s the capture and exits — so the success `cat` is
    // unreachable and the count is still one. A future edit that moved the new `cat` above the
    // `if` would double this and nothing else in the suite would notice.
    writeStub('node', nodeStub(`    "${REAL_NODE}" "$@"\n    exit 3`))
    const res = runLoop({ extraEnv: { RALPH_AGENT: 'codx' } })
    expect(res.signal).toBeNull()
    expect(res.status).toBe(1)
    expect(warningLines(res.stderr)).toEqual([TYPO_WARNING])
    expect(res.stderr.split(LF).filter((l) => l.includes(ABORT_LINE))).toHaveLength(1)
  })

  it('forwards it once when the bridge exits 0 with an EMPTY program', () => {
    // The other abort condition — `[ -z "$sh" ]` — reached with a bridge that succeeded and said
    // something. The loop must not eval nothing and carry on, and the sentence must not be lost
    // in the process of refusing to.
    writeStub('node', nodeStub(`    "${REAL_NODE}" "$@" >/dev/null\n    exit 0`))
    const res = runLoop({ extraEnv: { RALPH_AGENT: 'codx' } })
    expect(res.signal).toBeNull()
    expect(res.status).toBe(1)
    expect(warningLines(res.stderr)).toEqual([TYPO_WARNING])
    expect(res.stderr.split(LF).filter((l) => l.includes(ABORT_LINE))).toHaveLength(1)
  })
})

describe('QA #118 — what the `cat` does with a stream that is not one tidy sentence', () => {
  it('forwards a huge, binary, unterminated stream whole and still launches', () => {
    // 200 KB of filler, an ESC, a NUL, and a last line with no terminator — the shape a shim,
    // an nvm banner or a crashing transitive dep produces. `cat` is a byte copy on purpose (the
    // template forwards the stream UNREAD so this bash learns nothing about agents), so the
    // claims are: the warning is still there, the filler is still there, stdout is untouched, and
    // the loop still resolves and runs.
    writeStub(
      'node',
      nodeStub(
        [
          `    "${REAL_NODE}" "$@"`,
          `    head -c 200000 /dev/zero | tr '\\0' 'X' >&2`,
          `    printf 'BIN:\\000\\007\\033[31mred\\033[0m\\n' >&2`,
          `    printf 'NO-TRAILING-NEWLINE' >&2`,
          '    exit 0',
        ].join('\n'),
      ),
    )
    const res = runLoop({ extraEnv: { RALPH_AGENT: 'codx' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)
    expect(res.stderr.length).toBeGreaterThan(200000)
    expect(warningLines(res.stderr)).toEqual([TYPO_WARNING])
    expect(res.stderr).toContain('NO-TRAILING-NEWLINE')
    // The invariant the capture exists for, and the one a 200 KB forward must not cost: not one
    // byte of that stream reached the stream the loop evals.
    expect(res.stdout).not.toContain('X'.repeat(64))
    expect(res.stdout).not.toContain('NO-TRAILING-NEWLINE')
    expect(res.stdout).not.toContain('unrecognized')
    expect(res.stdout).toContain('Queue empty, exiting.')
    // ...and no `set -u` trip, no eval syntax error, no abort on a resolve that succeeded.
    expect(`${res.stdout}${LF}${res.stderr}`).not.toMatch(/unbound variable|syntax error/)
    expect(res.stderr).not.toContain(ABORT_LINE)
  })

  it('dies loudly rather than launching silently when mktemp fails', () => {
    // No temp file means no capture, and `2>""` is a redirect bash refuses — so the command
    // substitution fails and the abort branch fires. That is the RIGHT answer: the alternative
    // to a loud abort here is a loop that resolved its agent from an unknown stream, which is
    // the failure #118 exists to prevent. Pinned so the next edit to this function cannot
    // downgrade it to a warning and carry on.
    writeStub('mktemp', `#!/bin/bash\nexit 1\n`)
    const res = runLoop({ extraEnv: { RALPH_AGENT: 'codx' } })
    expect(res.signal).toBeNull()
    expect(res.status).toBe(1)
    expect(res.stderr).toContain(ABORT_LINE)
    expect(res.stdout).not.toContain('Queue empty, exiting.')
    expect(res.stderr).not.toContain('CLAUDE-SHOULD-NOT-RUN')
  })
})

describe('QA #118 — the loop reports a typo `ralph start` cannot see', () => {
  it('warns about a RALPH_AGENT only .env.local carries', () => {
    // THE PRECEDENCE `ralph start` DOES NOT SHARE, recorded rather than argued: the loop sources
    // ralph.config.sh, then the global config for unset keys, then .env.local — all with `set -a`
    // — so .env.local has the last word on RALPH_AGENT. `ralph start` reads ralph.config.sh and
    // the process environment only, and its own resolution never sees this file, so its box can
    // name codex for a run the loop will give to claude.
    //
    // What makes that survivable is exactly the half of #118 this file is about: the loop says so
    // itself. Without the `cat` on the success path there is no diagnostic for this case
    // ANYWHERE, on either command.
    writeFileSync(join(workdir, '.env.local'), `RALPH_AGENT=codx${LF}`)
    const res = runLoop({ extraEnv: { RALPH_AGENT: 'codex' } })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)
    expect(warningLines(res.stderr)).toEqual([TYPO_WARNING])
    expect(res.stdout).toContain('Queue empty, exiting.')
  })
})
