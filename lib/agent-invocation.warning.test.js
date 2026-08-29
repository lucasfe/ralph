// #118 — the agent-fallback warning on the bash bridge's stderr.
//
// lib/agent-invocation.js is the ONE place the loop learns which CLI to drive:
// templates/ralph.sh runs `eval "$(node lib/agent-invocation.js)"`, so this module's STDOUT is
// a shell program and every byte of it is load-bearing. It resolved `RALPH_AGENT` through the
// registry and dropped the warning on the floor, which is the same silence #118 reports for
// `ralph start` seen from the other side of the bridge: a loop launched by any route fell back
// to claude without a word.
//
// Driven as a SUBPROCESS rather than by calling the exported function, because the claim is
// about the two streams a `node lib/agent-invocation.js` actually produces and the split between
// them is the whole fix. Four claims:
//
//   1. STDOUT IS BYTE-FOR-BYTE WHAT IT WAS. A typo'd value resolves to claude, so the emitted
//      assignments must equal the ones an unset value produces — not merely parse, not merely
//      contain the right agent. A diagnostic folded into that stream would be eval'd as bash.
//   2. THE WARNING IS ON STDERR, once, and it names the value as written.
//   3. THE PROGRAM STILL EVALS, through bash, with the warning in flight. Claim 1 says the bytes
//      did not move; this says the shell agrees.
//   4. A RECOGNISED OR UNSET VALUE PRINTS NOTHING, and the exit status never moves — the loop
//      treats a non-zero bridge as fatal (`resolve_agent_invocation` aborts), so a warning that
//      changed the status would turn a typo into a dead launch.
//
// WHERE THE LINE GOES AFTER THIS MODULE: templates/ralph.sh redirects this script's stderr into a
// temp file so a node deprecation notice cannot be folded into `$sh`, and it now `cat`s that file
// to its own stderr on BOTH paths — the failing resolve, as it always did, and the successful one,
// which used to `rm` it unread and was the other half of #118. So the line below reaches the loop
// itself, not just a wrapper that happens not to swallow stderr. That forwarding is pinned in
// test/loop.adversarial.test.js ("the agent bridge's stderr on the SUCCESS path"), which runs the
// template in real bash; it is asserted THERE rather than here because it is a claim about the
// shell, and this file's business is the two streams the node process writes.
//
// The environment is built from scratch for every run so an ambient RALPH_AGENT in the
// developer's shell cannot change what is asserted (#41).

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { emitShellAssignments, buildAgentInvocation } from './agent-invocation.js'

const SCRIPT = fileURLToPath(new URL('./agent-invocation.js', import.meta.url))
const LF = String.fromCharCode(10)

// Everything the child needs to run node and nothing that could make it talk: PATH so the
// binary resolves, and no RALPH_* of any kind unless a test asks for one. NODE_OPTIONS is
// dropped because an inherited `--trace-warnings` would put lines on the very stream under test.
function envFor(RALPH_AGENT) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME }
  if (RALPH_AGENT !== undefined) env.RALPH_AGENT = RALPH_AGENT
  return env
}

function bridge(RALPH_AGENT) {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: envFor(RALPH_AGENT) })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

/** The value of a variable after bash has eval'd the bridge's stdout — claim 3. */
function evalThroughBash(RALPH_AGENT, variable) {
  const r = spawnSync(
    'bash',
    ['-c', `eval "$(node "$1")" && printf '%s' "\${${variable}}"`, 'ralph', SCRIPT],
    { encoding: 'utf8', env: envFor(RALPH_AGENT) },
  )
  return { value: r.stdout, stderr: r.stderr, status: r.status }
}

const warningFor = (echo) =>
  `⚠️  RALPH_AGENT='${echo}' unrecognized; falling back to 'claude'. Valid: claude, codex.`
const warningLines = (stderr) => stderr.split(LF).filter((line) => line.includes('RALPH_AGENT'))

describe('the bash bridge — an unrecognized RALPH_AGENT (#118)', () => {
  it('warns on stderr and leaves stdout byte-for-byte the claude program', async () => {
    // Claims 1 and 2 together, which is the only way either is worth having: the fallback is
    // announced on the stream the loop can discard, and the stream the loop EVALS is identical
    // to the one an unset value produces.
    const typo = bridge('codx')
    const unset = bridge(undefined)
    expect(typo.status).toBe(0)
    expect(typo.stdout).toBe(unset.stdout)
    expect(typo.stdout).toBe(emitShellAssignments(buildAgentInvocation({})) + LF)
    expect(warningLines(typo.stderr)).toEqual([warningFor('codx')])
    expect(typo.stdout).not.toContain('unrecognized')
    expect(typo.stdout).not.toContain('⚠️')
  })

  // The per-spelling echo used to be pinned here too, over five typos. Dropped as redundant in
  // review: agent-invocation.warning.qa.test.js asserts the whole of stderr is byte-equal to
  // `⚠️  ` + what `resolveAgent` composed, over a superset of those values — a stronger claim than
  // this file's line-filtered one, for the same five subprocess spawns.

  it('still evals to the claude CLI in bash, with the warning in flight', async () => {
    // Claim 3. The loop's `resolve_agent_invocation` aborts on a non-zero status OR an empty
    // stdout, so the failure mode a stray byte on stdout produces is a dead launch rather than a
    // wrong one. Asserted through a real bash eval, exactly as the loop does it.
    for (const variable of ['RALPH_RESOLVED_AGENT', 'RALPH_AGENT_CLI']) {
      const r = evalThroughBash('codx', variable)
      expect(r.status, variable).toBe(0)
      expect(r.value, variable).toBe('claude')
      expect(r.stderr, variable).toContain('unrecognized')
    }
    // ...and the argv array survives the same eval as an array, not as one word.
    const args = evalThroughBash('codx', 'RALPH_AGENT_ARGS[0]')
    expect(args.value).toBe('-p')
  })
})

describe('the bash bridge — a value the registry understands is silent (#118)', () => {
  it('prints nothing on stderr for either agent, in any case or padding', async () => {
    // `codex ` is in here rather than in the typo list above deliberately: `resolveAgent` TRIMS
    // before it looks up, so the trailing space the issue's own example uses is a clean
    // resolution to codex. The silence is the correct answer for it.
    for (const value of ['claude', 'codex', 'CODEX', ' codex ', 'codex ', `codex${LF}`]) {
      const r = bridge(value)
      expect(r.stderr, value).toBe('')
      expect(r.status, value).toBe(0)
    }
    // ...and the codex program is still the codex program: silence is not a fallback.
    expect(bridge('CODEX').stdout).toBe(
      emitShellAssignments(buildAgentInvocation({ RALPH_AGENT: 'codex' })) + LF,
    )
  })

  it('prints nothing for an unset, empty or whitespace value', async () => {
    for (const value of [undefined, '', '   ']) {
      const r = bridge(value)
      expect(r.stderr, JSON.stringify(value)).toBe('')
      expect(r.stdout, JSON.stringify(value)).toBe(
        emitShellAssignments(buildAgentInvocation({})) + LF,
      )
    }
  })
})

describe('buildAgentInvocation stays pure (#118)', () => {
  it('writes nothing itself — the warning is the script block’s to print', async () => {
    // The function is imported by nothing that has a terminal, and it must stay that way: it is
    // called once per loop launch through the script block below it and its answer is DATA. So
    // the fallback travels as a field rather than as a side effect, and this is the guard on
    // that — a `process.stderr.write` inside it would fire inside every test that calls it.
    const writes = []
    const real = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk, ...rest) => {
      writes.push(String(chunk))
      return real(chunk, ...rest)
    }
    try {
      expect(buildAgentInvocation({ RALPH_AGENT: 'codx' }).agent).toBe('claude')
      expect(buildAgentInvocation({ RALPH_AGENT: 'codx' }).warning).toContain('unrecognized')
      expect(buildAgentInvocation({}).warning).toBeNull()
    } finally {
      process.stderr.write = real
    }
    expect(writes).toEqual([])
  })

  it('keeps the warning out of the emitted shell, whatever is in it', async () => {
    // The one thing that must never happen: a value carrying a quote, a newline or a `$(...)`
    // reaching the eval'd stream. `emitShellAssignments` names the fields it renders, so an
    // extra one on the invocation object cannot leak into the program — pinned because the
    // alternative is a config file that can run commands in the loop's shell.
    const hostile = `codx'; touch /tmp/ralph-118-pwned; echo '`
    const inv = buildAgentInvocation({ RALPH_AGENT: hostile })
    const sh = emitShellAssignments(inv)
    expect(inv.warning).toContain('unrecognized')
    expect(sh).not.toContain('touch /tmp/ralph-118-pwned')
    expect(sh).not.toContain('unrecognized')
    expect(sh).toBe(emitShellAssignments(buildAgentInvocation({})))
  })
})
