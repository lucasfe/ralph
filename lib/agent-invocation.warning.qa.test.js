// QA #118 — the bash bridge under a hostile RALPH_AGENT, through a real bash `eval`.
//
// lib/agent-invocation.warning.test.js proves the split (stdout is the program, stderr is the
// sentence) and it proves it on one hostile value, at the level of the pure function:
// `emitShellAssignments(buildAgentInvocation({ RALPH_AGENT: hostile }))` never contains the
// hostile text. That is the right assertion about the renderer and it is not the assertion the
// loop depends on. What the loop depends on is that the BYTES a `node lib/agent-invocation.js`
// puts on stdout, after the warning has been written to the other stream, still eval in a real
// shell to the claude invocation and run nothing. So every test here spawns the script and hands
// its stdout to `bash`, exactly as `resolve_agent_invocation` does.
//
// Four things it adds over that spec:
//
//   1. A MATRIX of injection shapes rather than one — a bare single quote, `$(...)`, backticks, a
//      newline followed by a command, a value shaped like an assignment to one of the very
//      variables the program sets, and a jq fragment — each checked against a SENTINEL file that
//      does not exist and must not come to.
//   2. THE ARRAY, after the eval, element by element. `RALPH_AGENT_ARGS` is the field a folded
//      line would corrupt most quietly: six flags collapsed into one word still evals, still
//      exits 0, and produces a claude invocation nobody would recognise from the log.
//   3. THE LENGTHS AND THE CONTROL CLASSES, measured on the stream the script actually writes,
//      because #108's cap is a promise the registry makes and this is the printer that has to
//      keep it. UTF-8 encoding happens here and nowhere in the pure function.
//   4. RALPH_CODEX_MODEL, which is the OTHER env value that reaches the eval'd stdout — the one
//      field `shQuote` genuinely has to hold. #118 did not change it, and a QA sweep of the
//      stdout/stderr split that never tested the value which DOES travel on stdout would be
//      testing the easy half.
//
// No raw control byte is typed in this file (#107); every one is built from its code point.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitShellAssignments, buildAgentInvocation } from './agent-invocation.js'
import { resolveAgent } from './agent-registry.js'

const SCRIPT = fileURLToPath(new URL('./agent-invocation.js', import.meta.url))
const LF = String.fromCharCode(10)
const REPLACEMENT = String.fromCharCode(0xfffd)
const ECHO_MAX_POINTS = 200

let sandbox
let sentinel

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-118-qa-'))
  sentinel = join(sandbox, 'pwned')
})
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const envFor = (RALPH_AGENT, extra = {}) => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extra }
  if (RALPH_AGENT !== undefined) env.RALPH_AGENT = RALPH_AGENT
  return env
}

const bridge = (RALPH_AGENT, extra) =>
  spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: envFor(RALPH_AGENT, extra) })

/**
 * The loop's own sequence: run the bridge with its stderr captured to a temp file, forward that
 * file, eval the stdout, then report what the shell ended up holding. This mirrors
 * `resolve_agent_invocation` in templates/ralph.sh rather than paraphrasing it, so a program that
 * evals here is a program that evals there.
 */
function evalLikeTheLoop(RALPH_AGENT, extra) {
  const program = [
    'set -u',
    '_err="$(mktemp)"',
    'sh="$(node "$1" 2>"$_err")" || { echo "BRIDGE-FAILED" >&2; exit 9; }',
    'cat "$_err" >&2',
    'rm -f "$_err"',
    'eval "$sh"',
    // One field per line, so a folded assignment shows up as a missing or merged line rather
    // than as a substring that happens to match.
    'printf "agent=%s\\n" "$RALPH_RESOLVED_AGENT"',
    'printf "cli=%s\\n" "$RALPH_AGENT_CLI"',
    'printf "nargs=%s\\n" "${#RALPH_AGENT_ARGS[@]}"',
    'for a in "${RALPH_AGENT_ARGS[@]}"; do printf "arg=%s\\n" "$a"; done',
    'printf "filterlines=%s\\n" "$(printf "%s" "$RALPH_AGENT_STREAM_FILTER" | wc -l | tr -d " ")"',
  ].join('\n')
  const r = spawnSync('bash', ['-c', program, 'ralph', SCRIPT], {
    encoding: 'utf8',
    env: envFor(RALPH_AGENT, extra),
    cwd: sandbox,
  })
  const lines = r.stdout.split(LF).filter(Boolean)
  const pick = (key) =>
    lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? null
  return {
    status: r.status,
    stderr: r.stderr,
    agent: pick('agent'),
    cli: pick('cli'),
    nargs: pick('nargs'),
    args: lines.filter((line) => line.startsWith('arg=')).map((line) => line.slice(4)),
    filterLines: pick('filterlines'),
  }
}

const warningFor = (echo) =>
  `⚠️  RALPH_AGENT='${echo}' unrecognized; falling back to 'claude'. Valid: claude, codex.`
const BOILERPLATE = [...warningFor('')].length
const agentLines = (stderr) => stderr.split(LF).filter((line) => line.includes('RALPH_AGENT='))

// The static claude argv, spelled out so a folded array fails on the CONTENT and not just on a
// count. These are the six flags the loop has driven since before there was a registry.
const CLAUDE_ARGS = [
  '-p',
  '--dangerously-skip-permissions',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
]

describe('QA #118 — the eval survives every injection shape RALPH_AGENT can hold', () => {
  it('resolves the claude program and runs nothing, for each shape', () => {
    // Each value is a real attempt at the shell, aimed at a SENTINEL that does not exist. The
    // last two are the interesting ones: one assigns to a variable the program itself sets (so a
    // leak would be silent rather than fatal), the other is a jq fragment, because the stream
    // filter is a jq program and a value that reached it would be evaluated by jq later.
    const shapes = {
      'bare single quote': `codx'; touch ${sentinel}; echo '`,
      'command substitution': `codx$(touch ${sentinel})`,
      backticks: 'codx`touch ' + sentinel + '`',
      'newline then a command': `codx${LF}touch ${sentinel}`,
      'assignment to our own variable': `claude"; RALPH_AGENT_ARGS=(touch ${sentinel}); #`,
      'array-splicing quote': `claude' 'x`,
      'jq fragment': '.[] | @sh "\\(.x)"',
      'double-quote and semicolon': `codx"; touch ${sentinel};"`,
    }
    for (const [name, value] of Object.entries(shapes)) {
      const r = evalLikeTheLoop(value)
      expect(r.status, name).toBe(0)
      expect(r.agent, name).toBe('claude')
      expect(r.cli, name).toBe('claude')
      // THE ARRAY, element by element: six flags, in order, none merged and none added.
      expect(r.nargs, name).toBe(String(CLAUDE_ARGS.length))
      expect(r.args, name).toEqual(CLAUDE_ARGS)
      // The jq filter is a MULTI-LINE value and must stay one value — the emitter's ordering
      // note depends on it being last, so a count of its lines is the cheapest proof the eval
      // did not close it early.
      expect(Number(r.filterLines), name).toBeGreaterThan(5)
      // The sentence is on the other stream, once.
      expect(agentLines(r.stderr), name).toHaveLength(1)
      // ...and nothing ran. Checked as an empty DIRECTORY rather than as one missing path, so a
      // value that wrote somewhere adjacent is caught too.
      expect(existsSync(sentinel), name).toBe(false)
      expect(readdirSync(sandbox), name).toEqual([])
    }
  })

  it('emits the same program a bare `ralph` would, byte for byte, for each shape', () => {
    // The claim the eval cannot make on its own: not merely "a program that works", but the SAME
    // program. A stray byte that happened to be harmless would still mean the bridge's stdout is
    // a function of the typo, which is the property #118's whole split exists to deny.
    const expected = emitShellAssignments(buildAgentInvocation({})) + LF
    const unset = bridge(undefined)
    expect(unset.stdout).toBe(expected)
    expect(unset.stderr).toBe('')
    for (const value of [
      `codx'; touch ${sentinel}; echo '`,
      `codx$(touch ${sentinel})`,
      `codx${LF}touch ${sentinel}`,
      'c'.repeat(5000),
      `codex${String.fromCharCode(27)}[2J`,
      String.fromCodePoint(0x1f600).repeat(400),
    ]) {
      const r = bridge(value)
      const label = JSON.stringify(value.slice(0, 40))
      expect(r.status, label).toBe(0)
      expect(r.stdout, label).toBe(expected)
    }
  })

  it('holds a hostile RALPH_CODEX_MODEL inside one argv element', () => {
    // The OTHER value that reaches the eval'd stream, and the only one `shQuote` is genuinely
    // load-bearing for: with a recognised agent there is no warning at all, so this travels on
    // stdout by design. It must arrive as ONE element of the array — not as a command, and not
    // as three words.
    const model = `gpt-5'; touch ${sentinel}; echo '`
    const r = evalLikeTheLoop('codex', { RALPH_CODEX_MODEL: model })
    expect(r.status).toBe(0)
    expect(r.agent).toBe('codex')
    expect(r.stderr).toBe('')
    expect(r.args).toContain(model)
    expect(r.args[r.args.indexOf('-m') + 1]).toBe(model)
    expect(r.args[r.args.length - 1]).toBe('-')
    expect(existsSync(sentinel)).toBe(false)
    expect(readdirSync(sandbox)).toEqual([])
  })
})

describe('QA #118 — the sentence the bridge writes is bounded and single', () => {
  it('caps at the registry bound and stays one line, whatever the length', () => {
    for (const [name, value] of Object.entries({
      '5000 plain characters': 'c'.repeat(5000),
      '1000 newline-separated words': `codx${LF}`.repeat(1000),
      '400 astral code points': String.fromCodePoint(0x1f600).repeat(400),
    })) {
      const r = bridge(value)
      expect(r.status, name).toBe(0)
      const lines = agentLines(r.stderr)
      expect(lines, name).toHaveLength(1)
      // The whole stream is that one line, terminated once. A second line here is a line the
      // loop's `cat` would forward as a message nobody composed.
      expect(r.stderr, name).toBe(`${lines[0]}${LF}`)
      expect([...lines[0]], name).toHaveLength(BOILERPLATE + ECHO_MAX_POINTS)
      expect(lines[0], name).toContain('…')
    }
  })

  it('replaces the control classes on the way through UTF-8, not just in the string', () => {
    // The pure function's answer is a JS string; THIS is where it becomes bytes, and a byte is
    // what a terminal obeys. NUL is absent from the table for a reason worth writing down: a
    // POSIX environment block is NUL-terminated, so `RALPH_AGENT` cannot carry one at all —
    // Node refuses the spawn. The `ralph start` side reaches that case (its env is an injected
    // object) and lib/commands/start.agent-warning.qa.test.js covers it there.
    for (const [name, code] of Object.entries({
      BEL: 0x07,
      BS: 0x08,
      LF: 0x0a,
      CR: 0x0d,
      ESC: 0x1b,
      DEL: 0x7f,
      NEL: 0x85,
      CSI: 0x9b,
      LS: 0x2028,
      PS: 0x2029,
    })) {
      const raw = `codx${String.fromCharCode(code)}row  forged`
      const r = bridge(raw)
      expect(r.status, name).toBe(0)
      expect(r.stderr, name).toBe(`${warningFor(`codx${REPLACEMENT}row  forged`)}${LF}`)
      expect([...r.stderr].length - 1, name).toBe(BOILERPLATE + [...raw].length)
    }
  })

  it('writes the same sentence `resolveAgent` composed, with nothing added but the prefix', () => {
    // "One message, four mouths" (#108), asserted as an EQUALITY against the resolver rather
    // than as a substring match — which is the only version of the claim that catches a printer
    // that reworded, re-wrapped or re-flattened its copy. `ralph doctor`, `ralph init` and
    // `ralph start` all write `⚠️  ` + the warning; so must this one.
    for (const value of ['codx', 'codex-cli', 'CODX', ' codx ', `codx${String.fromCharCode(9)}`]) {
      const { warning } = resolveAgent({ RALPH_AGENT: value })
      expect(bridge(value).stderr, JSON.stringify(value)).toBe(`⚠️  ${warning}${LF}`)
    }
  })

  it('never moves the exit status, because the loop treats a non-zero bridge as fatal', () => {
    for (const value of [
      undefined,
      '',
      '   ',
      'claude',
      'codex',
      'codx',
      'c'.repeat(5000),
      `codx${String.fromCharCode(27)}`,
      `codx'`,
    ]) {
      expect(bridge(value).status, JSON.stringify(value)).toBe(0)
    }
  })
})
