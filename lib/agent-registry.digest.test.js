import { describe, it, expect } from 'vitest'
import { VALID_AGENTS, agentSpec } from './agent-registry.js'

// #61 — `ralph digest` invokes an agent CLI for ONE no-tool text completion on a
// cheap model, and the argv that does that is per-agent knowledge. The registry is
// the single file allowed to hold it (the same rule the loop's `argv`, the
// `authProbe` kind and the `streamFilter` already live under), so the digest engine
// can dispatch on the SPEC rather than on the agent's name.
//
// What is pinned here is the CONTRACT of that block, not one CLI's flag spelling:
//   1. Every valid agent has one — a third agent added without a digest spec must
//      fail here rather than at 3am inside an unattended run.
//   2. The block carries the four things the engine cannot know: the static flags,
//      how THIS cli names its model flag, the cheap-model default, whatever trailing
//      argv makes it read the prompt from stdin, and how to get prose out of stdout.
//   3. It is INSULATED from mutation. `agentSpec` shallow-copies, so a nested object
//      would otherwise hand every caller the registry's own — one `args.push()` in a
//      command and the next reader inherits it.

// The shape every digest spec must have. Stated once, checked for both agents, so a
// spec that is merely PRESENT but missing a key cannot pass.
const DIGEST_KEYS = ['argv', 'modelFlag', 'model', 'stdinArgv', 'output']

describe('agentSpec — the digest invocation spec (#61)', () => {
  it.each(VALID_AGENTS)('%s carries a complete digest block', (agent) => {
    const digest = agentSpec(agent).digest
    expect(digest, `agent '${agent}' has no digest spec`).toBeTruthy()
    expect(Object.keys(digest).sort()).toEqual([...DIGEST_KEYS].sort())
    expect(Array.isArray(digest.argv)).toBe(true)
    expect(digest.argv.length).toBeGreaterThan(0)
    expect(Array.isArray(digest.stdinArgv)).toBe(true)
    // Non-empty strings: an empty modelFlag would emit a bare model name as a
    // positional, and an empty `output` kind would leave the engine guessing.
    expect(typeof digest.modelFlag).toBe('string')
    expect(digest.modelFlag.length).toBeGreaterThan(0)
    expect(typeof digest.model).toBe('string')
    expect(digest.model.trim().length).toBeGreaterThan(0)
    expect(typeof digest.output).toBe('string')
    expect(digest.output.length).toBeGreaterThan(0)
  })

  it('claude disables every tool and asks for plain text', () => {
    const digest = agentSpec('claude').digest
    // `--tools ""` is claude's own documented way to disable ALL tools, which is
    // what makes "the model cannot act" structural rather than a promise.
    const i = digest.argv.indexOf('--tools')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(digest.argv[i + 1]).toBe('')
    // One shot, prose on stdout — nothing for the engine to parse.
    expect(digest.argv).toContain('-p')
    expect(digest.argv.join(' ')).toContain('--output-format text')
    expect(digest.output).toBe('text')
    expect(digest.modelFlag).toBe('--model')
    // No stdin marker: `cat prompt | claude -p` is how the loop already feeds it.
    expect(digest.stdinArgv).toEqual([])
  })

  it('codex runs one read-only exec with approvals off and reads the prompt on stdin', () => {
    const digest = agentSpec('codex').digest
    expect(digest.argv[0]).toBe('exec')
    // No first-class no-tool flag exists, so the sandbox is what bounds it: nothing
    // it could invoke may write, and nothing may stop to ask.
    expect(digest.argv.join(' ')).toContain('--sandbox read-only')
    expect(digest.argv.join(' ')).toContain('approval_policy="never"')
    // A digest must never be the thing that dies because the cwd is not a repo.
    expect(digest.argv).toContain('--skip-git-repo-check')
    // JSONL on stdout, so the prose has to be extracted rather than read.
    expect(digest.argv).toContain('--json')
    expect(digest.output).toBe('jsonl-agent-message')
    expect(digest.modelFlag).toBe('-m')
    expect(digest.stdinArgv).toEqual(['-'])
  })

  it('the static argv carries no model — that is the invocation builder’s job', () => {
    // The cheap default is overridable (RALPH_DIGEST_MODEL), so baking it into the
    // static flags would give the builder two places to disagree about the model.
    for (const agent of VALID_AGENTS) {
      const digest = agentSpec(agent).digest
      expect(digest.argv).not.toContain(digest.modelFlag)
      expect(digest.argv).not.toContain(digest.model)
    }
  })

  it('names a cheap model for both agents', () => {
    // The value itself is a judgement call (and RALPH_DIGEST_MODEL exists precisely
    // so a wrong id is recoverable), but the CHOICE has to be recorded here rather
    // than defaulted to whatever the CLI would pick for interactive work.
    expect(agentSpec('claude').digest.model).toBe('haiku')
    expect(agentSpec('codex').digest.model).toBe('gpt-5-mini')
  })
})

// The digest block's insulation from mutation is pinned as a property over the WHOLE
// spec in lib/agent-registry.digest.qa.test.js ("every array or object on the returned
// spec is a fresh instance"), which covers the next nested field for free. Nothing
// per-field here would add to it.
describe('agentSpec — the digest block is an addition, not an edit (#61)', () => {
  it('leaves the loop’s own argv/streamFilter untouched', () => {
    // The digest block is an ADDITION: the loop pipeline must be byte-for-byte what
    // it was, or #61 has changed how issues get resolved.
    expect(agentSpec('claude').argv).toEqual([
      '-p',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ])
    expect(agentSpec('codex').argv).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ])
  })
})
