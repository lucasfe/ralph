import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DIGEST_TIMEOUT_MS,
  TAIL_MAX_BYTES,
  TAIL_MAX_LINES,
  assembleDigestContext,
  boundedHead,
  boundedTail,
  buildDigestInvocation,
  buildDigestPrompt,
  digestLogPath,
  extractNarrative,
  formatHistoryEntry,
  inFlightLogPath,
  renderDigest,
  runDigest,
} from './digest.js'
import { agentSpec } from './agent-registry.js'
import { templatePath } from './paths.js'
import { buildProgress } from './progress.js'

// #61 — `ralph digest`: one turn, no tools, cheap model, and the model sees ONLY
// what Ralph put in the prompt. This file covers the whole of lib/digest.js — the
// pure halves (argv, bounds, extraction, formatting) and the engine's behaviour
// against an injected exec, which is where the append, the failure path and the
// no-active-run gate live.
//
// Nothing here touches a real filesystem, a real clock or a real agent: the engine
// takes `collect`, `exec`, `readFile`, `appendFile`, `mkdir` and `now` as
// parameters. test/digest.stub-cli.test.js is the counterpart that runs a REAL
// child process against a stub CLI.

const ROOT = '/repo'
const RUN_ID = 'ralph-repo-abc123'
const NOW = Date.parse('2026-08-26T04:40:12.500Z')

const runningRecord = (overrides = {}) => ({
  schema: 1,
  run_id: RUN_ID,
  session: 'ralph-repo-abc123',
  source: 'github',
  status: 'running',
  started_at: '2026-08-26T01:20:00.000Z',
  queue_at_start: 8,
  current: { number: 31, started_at: '2026-08-26T04:00:00.000Z', iteration: 3 },
  finished_at: null,
  ok: null,
  failed: null,
  ...overrides,
})

const LOG_TAIL_MARKER = 'Editing SettingsRowDescriptor.swift — red phase'
const GIT_STATUS = '## main...origin/main [ahead 8]\n M lib/digest.js'
const GIT_LOG = 'a5eb336 docs: document the progress view'
const NARRATIVE = '#031 is in the TDD red phase.\nMain is 8 commits ahead of origin/main.'

// A live run with three timed, costed tasks behind it, so the progress snapshot the
// prompt carries has real figures rather than a wall of `null`.
const METRICS = [
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","issue_number":11,"duration_ms":2520000,"total_cost_usd":3.2}`,
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","issue_number":12,"duration_ms":3000000,"total_cost_usd":4}`,
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","issue_number":13,"duration_ms":2760000,"total_cost_usd":2.8}`,
  '',
].join('\n')

// The gathering half of `ralph status`, stubbed: one object in, no gh call, no tmux
// probe, no lock read. The engine treats it as its only source of run truth.
function makeCollect({ record = runningRecord(), mode = 'running', queue = 6 } = {}) {
  const calls = []
  // `live` mirrors status.js: running AND interrupted both carry the record into
  // the snapshot; idle/never-run deliberately do not.
  const live = mode === 'running' || mode === 'interrupted'
  const collect = async (deps) => {
    calls.push(deps)
    return {
      root: ROOT,
      record,
      mode,
      session: record?.session ?? null,
      tmuxAlive: mode === 'running',
      queue,
      metricsText: METRICS,
      now: NOW,
      progress: buildProgress({ metricsText: METRICS, record: live ? record : null, queue, now: NOW }),
    }
  }
  collect.calls = calls
  return collect
}

// exec: git answers the two state probes, and the agent CLI answers with prose.
function makeExec({ agentResult = { exitCode: 0, stdout: NARRATIVE, stderr: '' } } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ cmd, args, options, key: `${cmd} ${args.join(' ')}` })
    if (cmd === 'git' && args[0] === 'status') return { exitCode: 0, stdout: GIT_STATUS, stderr: '' }
    if (cmd === 'git' && args[0] === 'log') return { exitCode: 0, stdout: GIT_LOG, stderr: '' }
    return typeof agentResult === 'function' ? agentResult(cmd, args, options) : agentResult
  }
  exec.calls = calls
  exec.agentCall = () => calls.find((c) => c.cmd !== 'git')
  return exec
}

function makeFs() {
  const appended = []
  const mkdirs = []
  return {
    appended,
    mkdirs,
    readFile: (p) => {
      if (String(p).includes('ralph-issue-31.log')) {
        return `noise\n${LOG_TAIL_MARKER}\n`
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    appendFile: (p, data) => appended.push({ path: String(p), data: String(data) }),
    mkdir: (p, opts) => mkdirs.push({ path: String(p), opts }),
  }
}

const engineDeps = (overrides = {}) => {
  const fs = makeFs()
  return {
    cwd: ROOT,
    env: {},
    exec: makeExec(),
    collect: makeCollect(),
    readFile: fs.readFile,
    appendFile: fs.appendFile,
    mkdir: fs.mkdir,
    now: () => NOW,
    stderr: { write: () => true },
    fs,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildDigestInvocation — the argv shape, per agent, plus the model override
// ---------------------------------------------------------------------------

describe('buildDigestInvocation — one-shot no-tool argv (#61)', () => {
  it('builds the claude argv from the registry spec plus the cheap model', () => {
    const inv = buildDigestInvocation({})
    expect(inv.agent).toBe('claude')
    expect(inv.cli).toBe('claude')
    expect(inv.model).toBe('haiku')
    expect(inv.output).toBe('text')
    expect(inv.args).toEqual(['-p', '--tools', '', '--output-format', 'text', '--model', 'haiku'])
  })

  it('builds the codex argv with the stdin marker last', () => {
    const inv = buildDigestInvocation({ RALPH_AGENT: 'codex' })
    expect(inv.agent).toBe('codex')
    expect(inv.cli).toBe('codex')
    expect(inv.model).toBe('gpt-5-mini')
    expect(inv.output).toBe('jsonl-agent-message')
    expect(inv.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '--skip-git-repo-check',
      '-m',
      'gpt-5-mini',
      '-',
    ])
    expect(inv.args[inv.args.length - 1]).toBe('-')
  })

  it('starts with the registry’s static argv, for both agents', () => {
    // The registry stays the single owner of the flags; this builder only composes
    // the env-dependent model on top, exactly as agent-invocation.js does for the
    // loop.
    for (const agent of ['claude', 'codex']) {
      const base = agentSpec(agent).digest.argv
      const inv = buildDigestInvocation({ RALPH_AGENT: agent })
      expect(inv.args.slice(0, base.length)).toEqual(base)
    }
  })

  it('disables every tool for claude and keeps the codex sandbox read-only', () => {
    const claude = buildDigestInvocation({}).args
    expect(claude[claude.indexOf('--tools') + 1]).toBe('')
    const codex = buildDigestInvocation({ RALPH_AGENT: 'codex' }).args
    expect(codex[codex.indexOf('--sandbox') + 1]).toBe('read-only')
    // Nothing about the LOOP's autonomy leaks into a digest.
    expect(claude).not.toContain('--dangerously-skip-permissions')
    expect(codex.join(' ')).not.toContain('workspace-write')
    expect(codex.join(' ')).not.toContain('network_access')
  })

  it('RALPH_DIGEST_MODEL overrides the registry default for both agents', () => {
    const claude = buildDigestInvocation({ RALPH_DIGEST_MODEL: 'sonnet' })
    expect(claude.model).toBe('sonnet')
    expect(claude.args[claude.args.indexOf('--model') + 1]).toBe('sonnet')
    const codex = buildDigestInvocation({ RALPH_AGENT: 'codex', RALPH_DIGEST_MODEL: 'gpt-5' })
    expect(codex.model).toBe('gpt-5')
    expect(codex.args[codex.args.indexOf('-m') + 1]).toBe('gpt-5')
    // Still the last arg — an override must not displace the stdin marker.
    expect(codex.args[codex.args.length - 1]).toBe('-')
  })

  it('an empty or whitespace-only override falls back to the registry default', () => {
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: '' }).model).toBe('haiku')
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: '   ' }).model).toBe('haiku')
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: '\t\n' }).model).toBe('haiku')
    expect(
      buildDigestInvocation({ RALPH_AGENT: 'codex', RALPH_DIGEST_MODEL: ' ' }).model,
    ).toBe('gpt-5-mini')
  })

  it('trims a padded override, and exactly one model flag is ever emitted', () => {
    const inv = buildDigestInvocation({ RALPH_DIGEST_MODEL: '  opus  ' })
    expect(inv.model).toBe('opus')
    expect(inv.args.filter((a) => a === '--model')).toHaveLength(1)
  })

  it('falls back to the claude digest spec on an unrecognized RALPH_AGENT', () => {
    const inv = buildDigestInvocation({ RALPH_AGENT: 'codx' })
    expect(inv.agent).toBe('claude')
    expect(inv.model).toBe('haiku')
  })

  it('ignores RALPH_CODEX_MODEL — the loop’s model is not the digest’s', () => {
    // A heavy loop model would defeat the entire point of a cheap accessory.
    const inv = buildDigestInvocation({ RALPH_AGENT: 'codex', RALPH_CODEX_MODEL: 'gpt-5-codex' })
    expect(inv.model).toBe('gpt-5-mini')
    expect(inv.args).not.toContain('gpt-5-codex')
  })
})

// ---------------------------------------------------------------------------
// The bounds — never feed an unbounded file to a model
// ---------------------------------------------------------------------------

describe('boundedTail / boundedHead — the model never sees an unbounded file (#61)', () => {
  it('keeps the LAST lines, capped by line count', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const out = boundedTail(text, { maxLines: 10, maxBytes: 1e6 })
    expect(out.split('\n')).toHaveLength(10)
    expect(out.split('\n').at(-1)).toBe('line 499')
    expect(out).not.toContain('line 400')
  })

  it('caps by BYTES as well, even for one enormous line', () => {
    const out = boundedTail('x'.repeat(50000), { maxLines: 10, maxBytes: 500 })
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(500)
  })

  it('cuts on a character boundary — no replacement characters', () => {
    const out = boundedTail('é'.repeat(2000), { maxLines: 10, maxBytes: 101 })
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(101)
    expect(out).not.toContain('�')
  })

  it('keeps the FIRST lines for head-bounded output', () => {
    const text = ['## main...origin/main [ahead 8]', 'a', 'b', 'c', 'd'].join('\n')
    const out = boundedHead(text, { maxLines: 2, maxBytes: 1e6 })
    expect(out.split('\n')).toEqual(['## main...origin/main [ahead 8]', 'a'])
  })

  it('head-bounds by bytes on a character boundary too', () => {
    const out = boundedHead('é'.repeat(2000), { maxLines: 10, maxBytes: 101 })
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(101)
    expect(out).not.toContain('�')
  })

  it('is total: null, undefined, a number and an empty string all answer ""', () => {
    for (const input of [null, undefined, '', 0, {}]) {
      expect(typeof boundedTail(input)).toBe('string')
      expect(typeof boundedHead(input)).toBe('string')
    }
    expect(boundedTail(null)).toBe('')
    expect(boundedTail('')).toBe('')
  })

  it('ships bounds that are actually bounds', () => {
    expect(TAIL_MAX_LINES).toBeGreaterThan(0)
    expect(TAIL_MAX_LINES).toBeLessThanOrEqual(500)
    expect(TAIL_MAX_BYTES).toBeGreaterThan(0)
    expect(TAIL_MAX_BYTES).toBeLessThanOrEqual(64000)
    // A hanging agent must not be able to hold a digest open forever.
    expect(DIGEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DIGEST_TIMEOUT_MS).toBeLessThanOrEqual(300000)
  })
})

// ---------------------------------------------------------------------------
// extractNarrative — dispatch on the SPEC's output kind, never on agent name
// ---------------------------------------------------------------------------

describe('extractNarrative — prose out of whatever the CLI printed (#61)', () => {
  it('text: trims stdout and returns it whole', () => {
    expect(extractNarrative('  #031 is in the red phase.\n\n', 'text')).toBe(
      '#031 is in the red phase.',
    )
  })

  it('jsonl-agent-message: returns the LAST agent message', () => {
    const stdout = [
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
      '{"type":"turn.completed"}',
      '',
    ].join('\n')
    expect(extractNarrative(stdout, 'jsonl-agent-message')).toBe('second')
  })

  it('jsonl-agent-message: tolerates the assistant_message alias and a .message body', () => {
    const stdout = '{"type":"item.completed","item":{"type":"assistant_message","message":"hi"}}'
    expect(extractNarrative(stdout, 'jsonl-agent-message')).toBe('hi')
  })

  it('jsonl-agent-message: skips garbage, half-written and untagged lines', () => {
    const stdout = [
      'not json at all',
      '{"type":"item.completed","item":{"type":"agent_message","tex',
      '{"type":"error","message":"boom"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"survivor"}}',
    ].join('\n')
    expect(extractNarrative(stdout, 'jsonl-agent-message')).toBe('survivor')
  })

  it('jsonl-agent-message: answers "" when no agent message was ever emitted', () => {
    expect(extractNarrative('{"type":"turn.failed"}', 'jsonl-agent-message')).toBe('')
    expect(extractNarrative('', 'jsonl-agent-message')).toBe('')
    expect(extractNarrative(null, 'jsonl-agent-message')).toBe('')
  })

  it('an unknown output kind degrades to the raw text rather than throwing', () => {
    // An accessory must never crash a reader over a registry key it does not know.
    expect(extractNarrative(' hello ', 'some-future-kind')).toBe('hello')
    expect(extractNarrative(' hello ', undefined)).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// The prompt — the whole no-tool design is verifiable here
// ---------------------------------------------------------------------------

describe('assembleDigestContext — the whole of what the model will know (#61)', () => {
  const full = () =>
    assembleDigestContext({
      record: runningRecord(),
      mode: 'running',
      snapshot: { run_id: RUN_ID, pace: { per_task_min: 46 } },
      gitStatus: GIT_STATUS,
      gitLog: GIT_LOG,
      logPath: '/repo/logs/ralph-issue-31.log',
      logTail: LOG_TAIL_MARKER,
      now: NOW,
    })

  it('supplies every placeholder templates/digest.md asks for', () => {
    // The two files are one contract: a template that grows a placeholder nobody
    // assembles would ship `{{SOMETHING}}` to a model on every digest, and a var
    // nobody references would quietly stop being sent.
    const template = readFileSync(templatePath('digest.md'), 'utf8')
    const asked = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1])
    expect(asked.length).toBeGreaterThan(0)
    expect(Object.keys(full()).sort()).toEqual([...new Set(asked)].sort())
  })

  it('stamps the clock to the second and names the mode and the task', () => {
    const vars = full()
    expect(vars.NOW).toBe('2026-08-26T04:40:12Z')
    expect(vars.MODE).toBe('running')
    expect(vars.TASK).toBe('#031')
  })

  it('SPELLS OUT every absence, because a blank block reads as “clean”', () => {
    const empty = assembleDigestContext({
      record: null,
      mode: 'idle',
      snapshot: null,
      gitStatus: '',
      gitLog: '',
      logPath: null,
      logTail: '',
      now: NOW,
    })
    for (const [key, value] of Object.entries(empty)) {
      expect(String(value).trim(), `${key} was left blank`).not.toBe('')
    }
    expect(empty.RUN_STATE).toMatch(/no run record/i)
    expect(empty.LOG_PATH).toMatch(/no task/i)
    expect(empty.LOG_TAIL).toMatch(/empty|not been written/i)
    expect(empty.GIT_STATUS).toMatch(/nothing|clean/i)
    expect(empty.GIT_LOG).toMatch(/no commits/i)
    expect(empty.TASK).toBe('none')
  })

  it('bounds the git output too — a huge status cannot flood the prompt', () => {
    const flood = Array.from({ length: 4000 }, (_, i) => ` M file-${i}.js`).join('\n')
    const vars = assembleDigestContext({ record: runningRecord(), gitStatus: flood, now: NOW })
    expect(vars.GIT_STATUS.length).toBeLessThan(flood.length / 2)
    // ...and it keeps the HEAD, where `git status --short --branch` puts the branch
    // line with the ahead/behind the digest is asked to flag.
    expect(vars.GIT_STATUS.startsWith(' M file-0.js')).toBe(true)
  })
})

describe('buildDigestPrompt — the context travels INLINE (#61)', () => {
  const vars = {
    NOW: '2026-08-26T04:40:12Z',
    MODE: 'running',
    TASK: '#031',
    RUN_STATE: JSON.stringify(runningRecord(), null, 2),
    PROGRESS: JSON.stringify({ run_id: RUN_ID, pace: { per_task_min: 46 } }, null, 2),
    GIT_STATUS: GIT_STATUS,
    GIT_LOG: GIT_LOG,
    LOG_PATH: 'logs/ralph-issue-31.log',
    LOG_TAIL: LOG_TAIL_MARKER,
  }

  it('interpolates every var and leaves no placeholder behind', () => {
    const prompt = buildDigestPrompt(vars, { stderr: { write: () => true } })
    for (const value of Object.values(vars)) {
      for (const line of String(value).split('\n')) {
        if (line.trim() === '') continue
        expect(prompt, `the prompt dropped: ${line}`).toContain(line)
      }
    }
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  it('asks for a few sentences and invites flagging what looks wrong', () => {
    const prompt = buildDigestPrompt(vars, { stderr: { write: () => true } }).toLowerCase()
    expect(prompt).toMatch(/sentence/)
    expect(prompt).toMatch(/wrong|off|suspicious/)
    // The whole point of the design, stated to the model too: it has no tools, so
    // the inline context is all there is.
    expect(prompt).toMatch(/no tools|cannot run|only what/)
  })

  it('warns on nothing when handed the full var set', () => {
    // interpolate() writes a warning per unknown placeholder; a template that asks
    // for a var the engine never assembles would print one on every digest.
    const warnings = []
    buildDigestPrompt(vars, { stderr: { write: (s) => warnings.push(s) } })
    expect(warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The history entry and the terminal heading
// ---------------------------------------------------------------------------

describe('formatHistoryEntry — a night’s narrative, one entry at a time (#61)', () => {
  it('carries the timestamp, the run id and the in-flight task', () => {
    const entry = formatHistoryEntry({
      at: '2026-08-26T04:40:12Z',
      runId: RUN_ID,
      task: '#031',
      narrative: NARRATIVE,
    })
    expect(entry).toContain('2026-08-26T04:40:12Z')
    expect(entry).toContain(RUN_ID)
    expect(entry).toContain('#031')
    // Line by line, because the body is written indented so that a blank line or a
    // forged `── ` heading in model output cannot break the entry format. Every line
    // of the narrative has to survive that, in order.
    const lines = entry.split('\n')
    let at = 0
    for (const line of NARRATIVE.split('\n')) {
      const found = lines.findIndex((l, i) => i >= at && l.trim() === line.trim())
      expect(found, `the entry dropped: ${line}`).toBeGreaterThan(-1)
      at = found + 1
    }
  })

  it('names the model that wrote it, on the heading, as a fourth field (#63)', () => {
    // `ralph status` reads this heading back to say WHO narrated the run, so the
    // model has to be in the entry rather than only in the terminal heading — and
    // inside the same `oneLine` guard as the rest of it, because it can come
    // straight off RALPH_DIGEST_MODEL.
    const entry = formatHistoryEntry({
      at: 'T',
      runId: 'r',
      task: '#1',
      model: 'claude-haiku-4-5',
      narrative: 'x',
    })
    expect(entry.split('\n')[1]).toMatch(/^── T · run r · #1 · claude-haiku-4-5 ─+$/)
    const forged = formatHistoryEntry({
      at: 'T',
      runId: 'r',
      task: '#1',
      model: `m\n── 1999-01-01T00:00:00Z · run other ${'─'.repeat(20)}`,
      narrative: 'x',
    })
    expect(
      forged.split('\n').filter((l) => l.startsWith('── ')),
      'a model name forged a heading',
    ).toHaveLength(1)
  })

  it('ends with a blank line so consecutive entries stay separable', () => {
    const entry = formatHistoryEntry({ at: 'T', runId: 'r', task: '#1', narrative: 'x' })
    expect(entry.endsWith('\n\n')).toBe(true)
    const two = entry + formatHistoryEntry({ at: 'T2', runId: 'r', task: '#2', narrative: 'y' })
    expect(two.split('\n\n').filter((s) => s.trim() !== '')).toHaveLength(2)
  })

  it('names the run and the task even when the record could not', () => {
    const entry = formatHistoryEntry({ at: 'T', runId: null, task: null, narrative: 'x' })
    expect(entry).toContain('unknown')
    expect(entry).toContain('x')
  })

  it('is self-delimiting ON ITS OWN, so a caller only has to append it', () => {
    // The leading newline belongs to the entry, not to the append: a caller that
    // forgets it would let a previous write cut short swallow the next heading, and
    // "one entry is one `^── ` line" would stop being a property of the format.
    const entry = formatHistoryEntry({ at: 'T', runId: 'r', task: '#1', narrative: 'x' })
    expect(entry.startsWith('\n')).toBe(true)
    const glued = 'truncated mid-write' + entry
    expect(glued.split('\n').filter((l) => l.startsWith('── '))).toHaveLength(1)
  })

  it('cannot be split by a run id, which is read off disk verbatim', () => {
    // lib/run-state.js returns a record from the future verbatim, so `run_id` is not
    // ours either: a newline in it would break the heading line in two, and the second
    // half could itself start with `── `.
    const entry = formatHistoryEntry({
      at: 'T',
      runId: `r\n── 1999-01-01T00:00:00Z · run other ${'─'.repeat(20)}`,
      task: '#1',
      narrative: 'x',
    })
    const lines = entry.split('\n')
    expect(lines.filter((l) => l.startsWith('── ')), 'a run id forged a heading').toHaveLength(1)
    expect(lines[1]).toContain('run r')
  })
})

describe('renderDigest — the only thing that reaches stdout (#61)', () => {
  it('prints one heading naming the task and the model, then the narrative', () => {
    const lines = renderDigest({ narrative: NARRATIVE, task: '#031', model: 'haiku', now: NOW })
    expect(lines[0]).toContain('digest')
    expect(lines[0]).toContain('#031')
    expect(lines[0]).toContain('haiku')
    expect(lines.slice(1).join('\n')).toBe(NARRATIVE)
  })

  it('keeps the narrative’s own line breaks', () => {
    const lines = renderDigest({ narrative: 'a\nb\nc', task: '#1', model: 'm', now: NOW })
    expect(lines.slice(1)).toEqual(['a', 'b', 'c'])
  })
})

describe('digestLogPath / inFlightLogPath — where the two files live (#61)', () => {
  it('appends the history under .ralph/, which is already gitignored', () => {
    expect(digestLogPath(ROOT)).toBe('/repo/.ralph/digest.log')
  })

  it('resolves the in-flight agent log under logs/, and null with no task', () => {
    expect(inFlightLogPath(ROOT, 31)).toBe('/repo/logs/ralph-issue-31.log')
    expect(inFlightLogPath(ROOT, null)).toBe(null)
    expect(inFlightLogPath(ROOT, undefined)).toBe(null)
    expect(inFlightLogPath(ROOT, 'nope')).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// runDigest — the engine
// ---------------------------------------------------------------------------

describe('runDigest — one turn, then append (#61)', () => {
  it('returns the narrative and appends ONE history entry', async () => {
    const deps = engineDeps()
    const result = await runDigest(deps)

    expect(result.status).toBe('ok')
    expect(result.narrative).toBe(NARRATIVE)
    expect(deps.fs.appended).toHaveLength(1)
    expect(deps.fs.appended[0].path).toBe(digestLogPath(ROOT))
    // Every line of the narrative reaches the file (indented — see formatHistoryEntry),
    // and the entry names the run and the task it belongs to.
    for (const line of NARRATIVE.split('\n')) {
      expect(deps.fs.appended[0].data).toContain(line)
    }
    expect(deps.fs.appended[0].data).toContain(RUN_ID)
    expect(deps.fs.appended[0].data).toContain('#031')
    // The ISO stamp comes from the injected clock, not from a second reading.
    expect(deps.fs.appended[0].data).toContain('2026-08-26T04:40:12Z')
    // .ralph/ is created if missing, and the write is an APPEND, never a truncate.
    expect(deps.fs.mkdirs).toHaveLength(1)
    expect(deps.fs.mkdirs[0].opts).toEqual({ recursive: true })
    // ...and the bytes are the formatter's, verbatim: the call site adds nothing, so
    // there is only one place the entry format can be got wrong.
    expect(deps.fs.appended[0].data).toBe(
      formatHistoryEntry({
        at: '2026-08-26T04:40:12Z',
        runId: RUN_ID,
        task: '#031',
        // #63: the model that answered goes in the entry too — the same one this
        // invocation resolved, never a second reading of the environment.
        model: 'haiku',
        narrative: NARRATIVE,
      }),
    )
    expect(deps.fs.appended[0].data).toContain('haiku')
  })

  it('invokes the agent ONCE, with no tools, the prompt on stdin and a timeout', async () => {
    const deps = engineDeps({ timeout: 4321 })
    await runDigest(deps)

    const agentCalls = deps.exec.calls.filter((c) => c.cmd !== 'git')
    expect(agentCalls).toHaveLength(1)
    const call = agentCalls[0]
    expect(call.cmd).toBe('claude')
    expect(call.args).toEqual(buildDigestInvocation({}).args)
    // The prompt is piped, never passed as argv: it carries whole files.
    expect(typeof call.options.input).toBe('string')
    expect(call.options.input.length).toBeGreaterThan(0)
    expect(call.options.timeout).toBe(4321)
    // A failing agent must never throw out of the engine.
    expect(call.options.reject).toBe(false)
    expect(call.options.cwd).toBe(ROOT)
  })

  it('assembles the context ITSELF and hands it over inline', async () => {
    // AC#2 + AC#4, and the reason the no-tool design is verifiable at all: every
    // fact the model gets is in the prompt, because it has no way to fetch one.
    const deps = engineDeps()
    const result = await runDigest(deps)
    const prompt = deps.exec.agentCall().options.input

    expect(prompt).toBe(result.prompt)
    // The in-flight task and its log tail...
    expect(prompt).toContain('#031')
    expect(prompt).toContain(LOG_TAIL_MARKER)
    expect(prompt).toContain('logs/ralph-issue-31.log')
    // ...git state, including the ahead/behind the issue's example flags...
    expect(prompt).toContain('## main...origin/main [ahead 8]')
    expect(prompt).toContain(GIT_LOG)
    // ...and the progress snapshot's key figures.
    expect(prompt).toContain(RUN_ID)
    expect(prompt).toContain('"remaining": 6')
    expect(prompt).toContain('"per_task_min": 46')
    expect(prompt).toContain('"usd": 10')
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  it('reads git state at the run’s root, and only reads', async () => {
    const deps = engineDeps()
    await runDigest(deps)
    const git = deps.exec.calls.filter((c) => c.cmd === 'git')
    expect(git.map((c) => c.args[0]).sort()).toEqual(['log', 'status'])
    for (const call of git) {
      expect(call.options.cwd).toBe(ROOT)
      expect(call.options.reject).toBe(false)
    }
  })

  it('bounds the log tail it feeds the model', async () => {
    const flood = Array.from({ length: 5000 }, (_, i) => `noisy log line ${i}`).join('\n')
    const deps = engineDeps({ readFile: () => flood })
    await runDigest(deps)
    const prompt = deps.exec.agentCall().options.input
    // The most recent lines survive, the oldest do not, and the whole prompt stays
    // a long way short of the raw file.
    expect(prompt).toContain('noisy log line 4999')
    expect(prompt).not.toContain('noisy log line 0\n')
    expect(prompt.length).toBeLessThan(flood.length / 2)
  })

  it('still runs when the in-flight log does not exist yet', async () => {
    const deps = engineDeps({
      readFile: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('ok')
    expect(result.narrative).toBe(NARRATIVE)
  })

  it('reports the resolved model, so RALPH_DIGEST_MODEL is observable', async () => {
    const deps = engineDeps({ env: { RALPH_DIGEST_MODEL: 'sonnet' } })
    const result = await runDigest(deps)
    expect(result.model).toBe('sonnet')
    expect(deps.exec.agentCall().args).toContain('sonnet')
  })
})

describe('runDigest — no active run (#61)', () => {
  it('never-run: one honest line, no agent, no history entry, no throw', async () => {
    const deps = engineDeps({ collect: makeCollect({ record: null, mode: 'never-run', queue: null }) })
    const result = await runDigest(deps)

    expect(result.status).toBe('no-run')
    expect(result.narrative).toBe(null)
    expect(result.diagnostic).toEqual(expect.any(String))
    expect(result.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
    // Nothing was spawned and nothing was written.
    expect(deps.exec.calls).toEqual([])
    expect(deps.fs.appended).toEqual([])
    expect(deps.fs.mkdirs).toEqual([])
  })

  it('narrates a finished run: idle and interrupted are legitimate subjects', async () => {
    for (const mode of ['idle', 'interrupted']) {
      const deps = engineDeps({
        collect: makeCollect({
          mode,
          record: runningRecord({ status: 'partial', finished_at: '2026-08-26T04:30:00.000Z', ok: 2, failed: 1 }),
        }),
      })
      const result = await runDigest(deps)
      expect(result.status, `mode ${mode} produced no digest`).toBe('ok')
      expect(deps.fs.appended).toHaveLength(1)
      expect(deps.exec.agentCall().options.input).toContain(mode)
    }
  })
})

describe('runDigest — failure is silent and harmless (#61)', () => {
  it('a non-zero exit writes no entry and returns one diagnostic', async () => {
    const deps = engineDeps({
      exec: makeExec({ agentResult: { exitCode: 1, stdout: '', stderr: 'Invalid API key' } }),
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('failed')
    expect(result.narrative).toBe(null)
    expect(result.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
    expect(deps.fs.appended).toEqual([])
  })

  it('a timeout is named as one, and writes no entry', async () => {
    const deps = engineDeps({
      exec: makeExec({
        agentResult: { exitCode: undefined, timedOut: true, failed: true, stdout: '', stderr: '' },
      }),
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('failed')
    expect(result.diagnostic).toMatch(/timed out/i)
    expect(deps.fs.appended).toEqual([])
  })

  it('a spawn error (an uninstalled CLI) is caught rather than thrown', async () => {
    const deps = engineDeps({
      exec: makeExec({
        agentResult: () => {
          throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
        },
      }),
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('failed')
    expect(deps.fs.appended).toEqual([])
  })

  it('an empty answer is a failure, not an empty history entry', async () => {
    for (const stdout of ['', '   \n\n', null]) {
      const deps = engineDeps({ exec: makeExec({ agentResult: { exitCode: 0, stdout } }) })
      const result = await runDigest(deps)
      expect(result.status).toBe('failed')
      expect(deps.fs.appended).toEqual([])
    }
  })

  it('an unwritable .ralph/ loses the entry, not the narrative', async () => {
    // The digest is an accessory: a history write that fails must still print, and
    // must still exit without a stack trace.
    const deps = engineDeps({
      appendFile: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      },
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('ok')
    expect(result.narrative).toBe(NARRATIVE)
  })

  it('a collect() that blows up degrades to a diagnostic', async () => {
    const deps = engineDeps({
      collect: async () => {
        throw new Error('git exploded')
      },
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('failed')
    expect(result.diagnostic).toEqual(expect.any(String))
    expect(deps.fs.appended).toEqual([])
  })

  it('a collect() that never answers is bounded too, and named as itself', async () => {
    // The FIRST await, and the one it is easiest to leave unbounded: `collectStatus`
    // shells out to git, tmux and (on a github run) `gh`, none of which carries a
    // timeout of its own. 'failed' rather than 'no-run', because not knowing is not the
    // same claim as nothing having ever run here.
    const deps = engineDeps({ timeout: 60, collect: () => new Promise(() => {}) })
    const started = Date.now()
    const result = await runDigest(deps)
    expect(Date.now() - started, 'the gather was unbounded').toBeLessThan(1000)
    expect(result.status).toBe('failed')
    expect(result.diagnostic).toMatch(/run state/i)
    expect(deps.fs.appended).toEqual([])
  })

  it('gives up on the agent inside its own budget, and its late failure never escapes', async () => {
    // The grace on OUR wait is the budget or KILL_GRACE_MS, whichever is smaller (see
    // `childDeadline`), so a caller asking for a 60ms digest gets one — and the child it
    // walked away from cannot come back as an unhandledRejection later.
    const rejections = []
    const onRejection = (e) => rejections.push(e)
    process.on('unhandledRejection', onRejection)
    try {
      const deps = engineDeps({
        timeout: 60,
        exec: makeExec({
          agentResult: () =>
            new Promise((_, reject) => setTimeout(() => reject(new Error('late boom')), 300)),
        }),
      })
      const started = Date.now()
      const result = await runDigest(deps)
      expect(Date.now() - started, 'the wait outlived the budget and its grace').toBeLessThan(280)
      expect(result.status).toBe('failed')
      expect(result.diagnostic).toMatch(/timed out/i)
      expect(deps.fs.appended).toEqual([])
      // Outlive the abandoned promise's own rejection.
      await new Promise((r) => setTimeout(r, 300))
      expect(rejections.map((e) => e?.message)).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
