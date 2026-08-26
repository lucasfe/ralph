import { describe, it, expect } from 'vitest'
import { VALID_AGENTS, agentSpec, resolveAgent } from './agent-registry.js'
import { buildDigestInvocation, extractNarrative } from './digest.js'

// QA augmentation for #61 — the registry's digest block. The dev's
// lib/agent-registry.digest.test.js pins each agent's flags, the missing model, the
// mutation insulation and the loop argv being untouched. What is attacked HERE is
// what a THIRD agent, or a later edit to one of these two, could break without any
// of that going red:
//
//   1. THE DIGEST INVOCATION MUST NOT BE ABLE TO ACT. Asserted as a denylist over
//      every entry in VALID_AGENTS rather than per-agent, so a digest spec added
//      later that inherits an autonomy flag fails here — this is the property #61
//      calls "structurally impossible rather than merely sandboxed", and the only
//      thing standing behind it is these argv arrays.
//   2. THE TWO ARGVS MUST NOT CONVERGE. The loop's spec and the digest's spec differ
//      exactly where capability lives, and a copy-paste between them is the realistic
//      way this regresses.
//   3. THE OUTPUT KIND SET IS CLOSED. `extractNarrative` degrades an UNKNOWN kind to
//      raw stdout, which for a JSONL agent would append a screenful of events to
//      digest.log and call it prose. So every kind in the registry has to be one the
//      engine implements, and adding a third forces the decision here.
//   4. THE COPY IS DEEP ENOUGH FOR WHATEVER THE SPEC GROWS. #61 added nested copying
//      for `digest.argv`/`digest.stdinArgv`; the same guard is stated as a property
//      over EVERY reference-valued field so the next nested object is covered too.
//   5. resolveAgent ∘ agentSpec IS TOTAL. `agentSpec` throws on an unknown name and
//      `SPECS` is a plain object, so an inherited key (`constructor`, `__proto__`)
//      reaching it would be either a throw or a bogus spec inside an accessory that
//      promises never to throw.
//
// Pure: nothing here reads env, spawns anything or touches disk.

// Anything that grants the digest turn a capability. Split by what it grants so a
// failure names the capability rather than just the string.
const FORBIDDEN_FLAGS = [
  ['skips permission prompts', '--dangerously-skip-permissions'],
  ['grants a writable sandbox', 'workspace-write'],
  ['grants full disk access', 'danger-full-access'],
  ['grants network access', 'network_access'],
  ['auto-approves everything', '--yolo'],
  ['auto-approves everything', '--full-auto'],
  ['auto-approves everything', 'approval_policy="on-request"'],
  ['re-enables tools by name', '--allowedTools'],
  ['re-enables tools by name', '--permission-mode'],
  ['adds an MCP server', '--mcp-config'],
  ['loads project settings', '--settings'],
  ['resumes prior state', '--resume'],
  ['resumes prior state', '--continue'],
]

// The output kinds lib/digest.js actually implements. An unlisted kind is not a
// failure the engine reports — it silently means "use stdout verbatim".
const IMPLEMENTED_OUTPUT_KINDS = ['text', 'jsonl-agent-message']

describe('QA: the digest spec cannot grant the narration turn any capability (#61)', () => {
  it.each(VALID_AGENTS)('%s: the digest argv carries no autonomy or write flag', (agent) => {
    const joined = agentSpec(agent).digest.argv.join(' ')
    for (const [grants, flag] of FORBIDDEN_FLAGS) {
      expect(joined, `${agent}'s digest argv ${grants} (${flag})`).not.toContain(flag)
    }
  })

  it.each(VALID_AGENTS)('%s: every digest argv element is a plain, spawnable string', (agent) => {
    // execa rejects a non-string argv element, and a digest that cannot even spawn is
    // a silent hole rather than a loud one. NUL and newline are checked because they
    // are the two bytes an argv element cannot carry.
    const { argv, stdinArgv, modelFlag, model } = agentSpec(agent).digest
    for (const element of [...argv, ...stdinArgv, modelFlag, model]) {
      expect(typeof element, `${agent}: ${JSON.stringify(element)}`).toBe('string')
      expect(element, `${agent}: ${JSON.stringify(element)}`).not.toMatch(/[\0\n\r]/)
    }
  })

  it.each(VALID_AGENTS)('%s: the digest argv keeps its one-shot flag, so nothing waits on a tty', (agent) => {
    // An interactive invocation with a prompt on stdin hangs forever, and the hard
    // deadline would turn every digest into a 92-second timeout.
    const argv = agentSpec(agent).digest.argv
    expect(argv.some((a) => a === '-p' || a === 'exec' || a === '--print'), agent).toBe(true)
  })
})

describe('QA: the loop’s spec and the digest’s spec must not converge (#61)', () => {
  it.each(VALID_AGENTS)('%s: they are different arrays with different capability', (agent) => {
    const spec = agentSpec(agent)
    expect(spec.digest.argv).not.toBe(spec.argv)
    expect(spec.digest.argv, `${agent}'s digest argv is the loop's`).not.toEqual(spec.argv)
    // ...and the loop's own capability flags are exactly what is missing from it: if
    // this ever holds, the digest is running with the loop's permissions.
    const loopOnly = spec.argv.filter((a) => !spec.digest.argv.includes(a))
    expect(loopOnly.length, `${agent}: the digest argv is a superset of the loop's`).toBeGreaterThan(0)
  })

  it('claude’s digest drops permission-skipping and stream-json; codex’s drops the write sandbox', () => {
    const claude = agentSpec('claude')
    expect(claude.argv).toContain('--dangerously-skip-permissions')
    expect(claude.digest.argv).not.toContain('--dangerously-skip-permissions')
    // stream-json exists so the loop can pretty-print a live stream; a one-shot
    // narration wants prose, and asking for the stream would make the engine parse it.
    expect(claude.digest.argv).not.toContain('stream-json')

    const codex = agentSpec('codex')
    const sandboxOf = (argv) => argv[argv.indexOf('--sandbox') + 1]
    expect(sandboxOf(codex.argv)).toBe('workspace-write')
    expect(sandboxOf(codex.digest.argv)).toBe('read-only')
    expect(codex.digest.argv.join(' ')).not.toContain('network_access')
  })

  it('the cheap digest default is not whatever model the loop is pointed at', () => {
    // The whole reason RALPH_DIGEST_MODEL is its own variable: an accessory that may
    // run every few minutes all night must not inherit the model chosen for depth.
    for (const agent of VALID_AGENTS) {
      const { model, modelFlag, argv } = agentSpec(agent).digest
      expect(argv, `${agent} baked the model into its static argv`).not.toContain(model)
      expect(argv, `${agent} baked the model flag into its static argv`).not.toContain(modelFlag)
    }
  })
})

describe('QA: the registry’s output kind must be one the engine implements (#61)', () => {
  it.each(VALID_AGENTS)('%s names an implemented output kind', (agent) => {
    // The engine's fallback for an unknown kind is "use stdout verbatim", which is
    // silently wrong for any structured stream — so the set is closed HERE, where a
    // third agent is added, rather than discovered in a digest.log full of JSONL.
    expect(IMPLEMENTED_OUTPUT_KINDS, `add '${agent}' handling to extractNarrative`).toContain(
      agentSpec(agent).digest.output,
    )
  })

  it('each kind actually yields prose from that agent’s realistic stdout', () => {
    // The registry↔engine contract end to end, without spawning anything: what the
    // CLI prints, through the kind the registry declared, must come out as the
    // sentence and nothing else.
    const stdoutFor = {
      text: 'The run is on #031 and looks healthy.\n',
      'jsonl-agent-message': [
        '{"type":"item.completed","item":{"type":"reasoning","text":"considering"}}',
        '{"type":"item.completed","item":{"type":"command_execution","command":"git status"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"The run is on #031 and looks healthy."}}',
        '{"type":"turn.completed"}',
        '',
      ].join('\n'),
    }
    for (const agent of VALID_AGENTS) {
      const kind = agentSpec(agent).digest.output
      expect(extractNarrative(stdoutFor[kind], kind), agent).toBe(
        'The run is on #031 and looks healthy.',
      )
    }
  })
})

describe('QA: agentSpec hands out no shared reference at all (#61)', () => {
  it.each(VALID_AGENTS)('%s: every array or object on the returned spec is a fresh instance', (agent) => {
    // Stated as a property over the whole spec rather than over the two arrays #61
    // added, so the next nested field is covered without a new test — the failure mode
    // is one command's `push()` silently editing the registry for the rest of the run.
    const a = agentSpec(agent)
    const b = agentSpec(agent)
    const walk = (x, y, path) => {
      if (x === null || typeof x !== 'object') return
      expect(y, `${agent}: ${path} is shared between calls`).not.toBe(x)
      for (const key of Object.keys(x)) walk(x[key], y[key], `${path}.${key}`)
    }
    walk(a, b, 'spec')
    // ...and equal in value, so "fresh" never came at the cost of "the same spec".
    expect(b).toEqual(a)
  })

  it.each(VALID_AGENTS)('%s: deleting a key off the returned digest block does not leak', (agent) => {
    const first = agentSpec(agent).digest
    delete first.output
    delete first.model
    first.argv.length = 0
    expect(agentSpec(agent).digest.output).toEqual(expect.any(String))
    expect(agentSpec(agent).digest.argv.length).toBeGreaterThan(0)
  })
})

describe('QA: resolveAgent ∘ agentSpec is total for any RALPH_AGENT (#61)', () => {
  it('an inherited-property name never reaches agentSpec as an agent', () => {
    // `SPECS` is a plain object literal, so `SPECS['constructor']` is truthy and
    // `SPECS['__proto__']` is Object.prototype — either would sail past agentSpec's
    // `if (!spec)` guard and hand the digest engine a spec with no argv. The gate is
    // resolveAgent's allowlist, and buildDigestInvocation is what composes them.
    for (const raw of [
      '__proto__',
      'constructor',
      'prototype',
      'hasOwnProperty',
      'toString',
      'valueOf',
      'CONSTRUCTOR',
      '  __proto__  ',
    ]) {
      expect(resolveAgent({ RALPH_AGENT: raw }).agent, raw).toBe('claude')
      const inv = buildDigestInvocation({ RALPH_AGENT: raw })
      expect(inv.agent, raw).toBe('claude')
      expect(inv.cli, raw).toBe('claude')
      expect(inv.args, raw).toEqual(agentSpec('claude').digest.argv.concat(['--model', 'haiku']))
    }
  })

  it('every agent resolveAgent can name has a spec, and it builds an invocation', () => {
    // The closure property: nothing resolveAgent returns may be a name agentSpec
    // refuses, or an accessory that promises never to throw would throw at the
    // registry boundary.
    for (const raw of [...VALID_AGENTS, undefined, null, '', '   ', 'nope', 42, {}, []]) {
      const { agent } = resolveAgent({ RALPH_AGENT: raw })
      expect(VALID_AGENTS, JSON.stringify(raw)).toContain(agent)
      expect(() => agentSpec(agent), JSON.stringify(raw)).not.toThrow()
      expect(() => buildDigestInvocation({ RALPH_AGENT: raw }), JSON.stringify(raw)).not.toThrow()
    }
  })
})
