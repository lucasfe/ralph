import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseLatestDigest } from './digest-history.js'
import { digestInterval } from './digest-file.js'
import {
  assembleDigestContext,
  boundedHead,
  boundedTail,
  buildDigestInvocation,
  buildDigestPrompt,
  extractNarrative,
  formatHistoryEntry,
  inFlightLogPath,
  renderDigest,
  runDigest,
} from './digest.js'
// #108 took the flattener out of lib/digest.js and did NOT leave a re-export behind, so the three
// tests below ask the module that owns it. They are kept in this file anyway: digest.js still uses
// it on every diagnostic and every history heading, and a shape those depend on is worth pinning
// beside them as well as in lib/one-line.test.js.
import { oneLine } from './one-line.js'
import { agentSpec } from './agent-registry.js'
import { buildProgress } from './progress.js'

// QA augmentation for #61 — `ralph digest`. The dev's lib/digest.test.js pins the
// contract on well-formed inputs: the two argv shapes, the model override, the
// bounds, the JSONL extraction, the prompt's placeholders, the append, the failure
// path and the no-active-run gate. What is attacked HERE is the edges around all of
// that, and nothing it already covers:
//
//   1. THE NO-TOOL GUARANTEE AS A BYTE. `--tools ''` is the single most
//      security-relevant string in the diff, and its whole risk is that it is
//      FALSY: any `.filter(Boolean)`/`.filter(a => a)` on the way to argv would
//      silently re-enable every tool while every other assertion in the suite
//      stayed green. Pinned as a positional fact about `args` AND as a
//      source-purity fact about the builder.
//   2. THE BOUNDS AT THE BYTE BOUNDARY. One line longer than the whole byte
//      budget, 2-byte and 4-byte characters straddling the cut in BOTH directions,
//      a budget narrower than a single character, no trailing newline, CRLF, a file
//      of nothing but newlines, and a budget of 0 or a negative.
//   3. THE JSONL READER ON HOSTILE STREAMS. Tool events with no message at all, a
//      line that is a JSON array or a scalar, an `item` that is an array, a
//      whitespace-only message after a real one, a truncated final line, CRLF, a
//      100KB line, and `text` disagreeing with `message`.
//   4. THE RACE, WHICH IS THE REAL TIMEOUT. A child that never settles, a child
//      that rejects LATE (after being abandoned) and must not surface as an
//      unhandled rejection, a slow-but-successful child that must NOT be killed,
//      and the deadline timer being cleared on a fast success rather than left
//      pending.
//   5. NEVER THROWS, AS THE MODULE HEADER PROMISES. A hostile `collect`, an `exec`
//      that throws synchronously, an unreadable prompt template, a failing mkdir,
//      a record that is an array, a task number that is not a number.
//   6. THE CONTEXT CANNOT FORGE ITSELF. A log tail carrying `{{RUN_STATE}}` or `$&`
//      must reach the model verbatim rather than being interpolated a second time.
//   7. REGISTRY PURITY (AC#5): no agent name appears as a branching condition in
//      lib/digest.js — the same source-purity technique status.json.qa.test.js uses.
//
// Hermetic (#41): every seam is injected — `collect`, `exec`, `readFile`,
// `readTemplate`, `appendFile`, `mkdir`, `now`, `stderr` — and every env is an
// explicit literal, never `process.env`. Nothing here spawns a process or touches
// disk; test/digest.stub-cli.qa.test.js is the counterpart that does both.

const ROOT = '/repo'
const RUN_ID = 'ralph-repo-qa61'
const NOW = Date.parse('2026-08-26T04:40:12.500Z')
const NARRATIVE = '#031 is in the red phase and the run looks healthy.'
const GIT_STATUS = '## main...origin/main [ahead 8]\n M lib/digest.js'
const GIT_LOG = 'a5eb336 docs: document the progress view'

const METRICS = [
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","issue_number":11,"duration_ms":2520000,"total_cost_usd":3.2}`,
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","issue_number":12,"duration_ms":3000000,"total_cost_usd":4}`,
  '',
].join('\n')

const liveRecord = (overrides = {}) => ({
  schema: 1,
  run_id: RUN_ID,
  session: RUN_ID,
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

// The gathering half of `ralph status`, stubbed. Deliberately NOT the dev's helper:
// this one can also answer with a hostile shape (a primitive, a missing `now`).
function makeCollect({ record = liveRecord(), mode = 'running', queue = 6, ...rest } = {}) {
  const live = mode === 'running' || mode === 'interrupted'
  return async () => ({
    root: ROOT,
    record,
    mode,
    session: record?.session ?? null,
    tmuxAlive: mode === 'running',
    queue,
    metricsText: METRICS,
    now: NOW,
    progress: buildProgress({ metricsText: METRICS, record: live ? record : null, queue, now: NOW }),
    ...rest,
  })
}

// git answers the two read-only probes; `agent` answers the one completion, and may
// be a value, a function, a promise or a thrower.
function makeExec({ agent = { exitCode: 0, stdout: NARRATIVE, stderr: '' }, git } = {}) {
  const calls = []
  const exec = (cmd, args = [], options = {}) => {
    calls.push({ cmd, args, options })
    if (cmd === 'git') {
      if (typeof git === 'function') return git(args)
      if (args[0] === 'status') return Promise.resolve({ exitCode: 0, stdout: GIT_STATUS })
      return Promise.resolve({ exitCode: 0, stdout: GIT_LOG })
    }
    return typeof agent === 'function' ? agent(cmd, args, options) : Promise.resolve(agent)
  }
  exec.calls = calls
  exec.agentCall = () => calls.find((c) => c.cmd !== 'git')
  exec.prompt = () => exec.agentCall()?.options?.input ?? ''
  return exec
}

function makeFs({ log = `noise\nEditing SettingsRowDescriptor.swift — red phase\n` } = {}) {
  const appended = []
  const mkdirs = []
  const reads = []
  return {
    appended,
    mkdirs,
    reads,
    history: () => appended.map((a) => a.data).join(''),
    readFile: (p) => {
      reads.push(String(p))
      if (String(p).includes('ralph-issue-')) {
        if (typeof log === 'function') return log(String(p))
        return log
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    appendFile: (p, data) => appended.push({ path: String(p), data: String(data) }),
    mkdir: (p, opts) => mkdirs.push({ path: String(p), opts }),
  }
}

const engineDeps = (overrides = {}) => {
  const fs = makeFs(overrides.fsOptions)
  const bag = {
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
  delete bag.fsOptions
  return bag
}

// ---------------------------------------------------------------------------
// 1. The no-tool guarantee. The whole hazard is that the argument is falsy.
// ---------------------------------------------------------------------------

describe('buildDigestInvocation — the empty-string tool argument is not droppable (#61 QA)', () => {
  it('carries `--tools` immediately followed by an argument that is the empty string', () => {
    const args = buildDigestInvocation({}).args
    const i = args.indexOf('--tools')
    expect(i, '--tools vanished from the digest argv').toBeGreaterThanOrEqual(0)
    // Not `toBeFalsy`: the assertion has to distinguish `''` from `undefined`, which
    // is what a dropped element would leave here.
    expect(args).toHaveLength(7)
    expect(args[i + 1]).toBe('')
    expect(typeof args[i + 1]).toBe('string')
    expect(Object.prototype.hasOwnProperty.call(args, i + 1)).toBe(true)
  })

  it('keeps exactly ONE empty-string element, whatever the model override is', () => {
    // A filter that dropped empty strings would silently re-enable every tool while
    // every other assertion about this argv stayed green, so the count is pinned
    // across the override paths that rebuild the array.
    for (const env of [
      {},
      { RALPH_DIGEST_MODEL: 'sonnet' },
      { RALPH_DIGEST_MODEL: '' },
      { RALPH_DIGEST_MODEL: '   ' },
      { RALPH_AGENT: 'claude', RALPH_DIGEST_MODEL: 'opus' },
    ]) {
      const args = buildDigestInvocation(env).args
      expect(args.filter((a) => a === ''), JSON.stringify(env)).toHaveLength(1)
      expect(args[args.indexOf('--tools') + 1], JSON.stringify(env)).toBe('')
    }
  })

  it('survives the invocation reaching an argv consumer that copies it', () => {
    // The engine hands `inv.args` straight to execa, which spreads it. A copy must
    // not lose the element either — `[...args]`, `args.slice()` and `concat` all
    // preserve it, but a `.filter`/`.map(String).filter(Boolean)` in between would
    // not, and this is the shape that would be added "to tidy the argv up".
    const args = buildDigestInvocation({}).args
    for (const copy of [[...args], args.slice(), [].concat(args), Array.from(args)]) {
      expect(copy).toEqual(args)
      expect(copy.filter((a) => a === '')).toHaveLength(1)
    }
  })

  it('the builder does not filter, compact or truthiness-test its argv', () => {
    // Source purity in the house style: the reason the empty string survives is that
    // there is nowhere in the builder for it to be dropped.
    const body = bodyOf('buildDigestInvocation')
    for (const forbidden of [/\.filter\(/, /Boolean\)/, /\.flat\(/, /\.map\(/]) {
      expect(body, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('no digest argv enables the loop’s autonomy, for either agent', () => {
    for (const agent of ['claude', 'codex']) {
      const joined = buildDigestInvocation({ RALPH_AGENT: agent }).args.join(' ')
      for (const forbidden of [
        '--dangerously-skip-permissions',
        'workspace-write',
        'network_access',
        '--yolo',
        '--full-auto',
        'danger-full-access',
        'stream-json',
      ]) {
        expect(joined, `${agent} digest argv carries ${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})

describe('buildDigestInvocation — the model override at its edges (#61 QA)', () => {
  it('places the override immediately after the agent’s own model flag, and nowhere else', () => {
    for (const [agent, flag, tail] of [
      ['claude', '--model', undefined],
      ['codex', '-m', '-'],
    ]) {
      const inv = buildDigestInvocation({ RALPH_AGENT: agent, RALPH_DIGEST_MODEL: 'zzz-model' })
      const i = inv.args.indexOf(flag)
      expect(i, `${agent} lost its model flag`).toBeGreaterThanOrEqual(0)
      expect(inv.args[i + 1]).toBe('zzz-model')
      expect(inv.args.filter((a) => a === flag), `${agent} emitted the flag twice`).toHaveLength(1)
      expect(inv.args.filter((a) => a === 'zzz-model')).toHaveLength(1)
      // ...and the stdin marker is still the LAST element, because for codex it is a
      // positional and an override inserted after it would be read as the prompt.
      if (tail) expect(inv.args.at(-1)).toBe(tail)
    }
  })

  it('passes a model carrying shell metacharacters through as ONE argv element', () => {
    // execa spawns without a shell, so the only way this becomes a command is if
    // something here splits it. Nothing may.
    const hostile = 'haiku; touch /tmp/ralph-digest-pwned && echo $(id) `whoami` | cat'
    const inv = buildDigestInvocation({ RALPH_DIGEST_MODEL: hostile })
    expect(inv.model).toBe(hostile)
    expect(inv.args[inv.args.indexOf('--model') + 1]).toBe(hostile)
    expect(inv.args.filter((a) => a.includes('touch'))).toHaveLength(1)
    expect(inv.args).toHaveLength(7)
  })

  it('a whitespace-padded override is trimmed but an inner space is preserved', () => {
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: '  haiku  ' }).model).toBe('haiku')
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: 'a b' }).model).toBe('a b')
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: ' ' }).model).toBe('haiku')
  })

  it('a non-string override is coerced rather than crashing the builder', () => {
    // process.env is always strings, but the bag is injectable and a caller may
    // hand over a config value straight from JSON.
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: null }).model).toBe('haiku')
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: undefined }).model).toBe('haiku')
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: 0 }).model).toBe('0')
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: false }).model).toBe('false')
    expect(buildDigestInvocation({ RALPH_DIGEST_MODEL: 42 }).model).toBe('42')
  })

  it('ignores every OTHER model variable, so the loop’s model cannot leak in', () => {
    // The loop's model is chosen for depth and a digest on it would cost more than the
    // work it narrates, so only RALPH_DIGEST_MODEL may steer this argv.
    for (const key of ['RALPH_CODEX_MODEL', 'RALPH_CLAUDE_MODEL', 'RALPH_MODEL', 'ANTHROPIC_MODEL']) {
      expect(buildDigestInvocation({ [key]: 'gpt-5-pro' }).model, key).toBe('haiku')
      expect(
        buildDigestInvocation({ RALPH_AGENT: 'codex', [key]: 'gpt-5-pro' }).model,
        key,
      ).toBe('gpt-5-mini')
    }
    // ...and RALPH_DIGEST_MODEL still wins when both are set.
    expect(
      buildDigestInvocation({ RALPH_CODEX_MODEL: 'gpt-5-pro', RALPH_DIGEST_MODEL: 'cheap' }).model,
    ).toBe('cheap')
  })

  it('normalizes RALPH_AGENT the way the registry does, and answers with that spec', () => {
    for (const raw of ['codex', 'CODEX', '  Codex  ', '\tcodex\n']) {
      const inv = buildDigestInvocation({ RALPH_AGENT: raw })
      expect(inv.agent, JSON.stringify(raw)).toBe('codex')
      expect(inv.output).toBe('jsonl-agent-message')
      expect(inv.args.at(-1)).toBe('-')
    }
  })

  it('is total: no env, an empty env and a null env all build the default invocation', () => {
    const expected = buildDigestInvocation({})
    for (const [label, env] of [
      ['no argument', undefined],
      ['an empty object', {}],
      ['null', null],
      ['a null-prototype bag', Object.create(null)],
    ]) {
      expect(buildDigestInvocation(env), label).toEqual(expected)
    }
  })

  it('never mutates the registry — two calls are deep-equal and share no array', () => {
    const first = buildDigestInvocation({})
    first.args.push('--dangerously-skip-permissions')
    first.args.length = 2
    expect(buildDigestInvocation({}).args).toEqual(agentSpec('claude').digest.argv.concat([
      '--model',
      'haiku',
    ]))
  })
})

// ---------------------------------------------------------------------------
// 2. The bounds, at the byte boundary
// ---------------------------------------------------------------------------

describe('boundedTail / boundedHead — the cut lands on a character boundary (#61 QA)', () => {
  it('keeps the END of a single line that is longer than the whole byte budget', () => {
    // 80 lines is no bound at all against one line of a minified diff, which is why
    // the byte cap exists — and a tail must keep the RECENT end of that line.
    const line = 'a'.repeat(200) + 'THE-END'
    const out = boundedTail(line, { maxLines: 80, maxBytes: 32 })
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(32)
    expect(out.endsWith('THE-END')).toBe(true)
  })

  it('keeps the START of that same line when bounded from the head', () => {
    const line = 'THE-START' + 'a'.repeat(200)
    const out = boundedHead(line, { maxLines: 80, maxBytes: 32 })
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(32)
    expect(out.startsWith('THE-START')).toBe(true)
  })

  it('never grows a replacement character, for 2-byte or 4-byte characters, either direction', () => {
    // Every offset in a window around the cut, so the straddle is hit rather than
    // hoped for: a blind byte slice fails on at least one of these for each width.
    for (const char of ['é', '€', '🎉', '👩‍💻']) {
      const width = Buffer.byteLength(char, 'utf8')
      const text = char.repeat(64)
      for (let budget = 1; budget <= 4 * width + 3; budget++) {
        for (const [name, fn] of [['tail', boundedTail], ['head', boundedHead]]) {
          const out = fn(text, { maxLines: 80, maxBytes: budget })
          const label = `${name} ${JSON.stringify(char)} @${budget}`
          expect(out, `${label} produced U+FFFD`).not.toContain('�')
          expect(Buffer.byteLength(out, 'utf8'), `${label} overran`).toBeLessThanOrEqual(budget)
        }
      }
    }
  })

  it('answers with nothing rather than half a character when the budget is narrower than one', () => {
    for (const fn of [boundedTail, boundedHead]) {
      expect(fn('🎉🎉🎉', { maxLines: 80, maxBytes: 3 })).toBe('')
      expect(fn('ééé', { maxLines: 80, maxBytes: 1 })).toBe('')
    }
  })

  it('keeps the last line of a file that has no trailing newline', () => {
    const out = boundedTail('one\ntwo\nthree', { maxLines: 2, maxBytes: 1000 })
    expect(out).toBe('two\nthree')
  })

  it('does not spend a line of the budget on the empty string after a trailing newline', () => {
    expect(boundedTail('one\ntwo\n', { maxLines: 1, maxBytes: 1000 })).toBe('two')
    expect(boundedTail('one\ntwo\n\n\n', { maxLines: 1, maxBytes: 1000 })).toBe('two')
    expect(boundedTail('\n\n\n', { maxLines: 80, maxBytes: 1000 })).toBe('')
    expect(boundedHead('\n', { maxLines: 80, maxBytes: 1000 })).toBe('')
  })

  it('keeps whole CRLF lines rather than losing the last one to the \\r', () => {
    const out = boundedTail('one\r\ntwo\r\nthree\r\n', { maxLines: 2, maxBytes: 1000 })
    expect(out).toContain('two')
    expect(out).toContain('three')
    expect(out.split('\n').filter((l) => l.trim() !== '')).toHaveLength(2)
  })

  it('degenerate budgets still answer with a bounded string, never a throw', () => {
    for (const opts of [
      { maxLines: 0, maxBytes: 0 },
      { maxLines: -5, maxBytes: -5 },
      { maxLines: 1, maxBytes: 1 },
      {},
    ]) {
      for (const fn of [boundedTail, boundedHead]) {
        const out = fn('alpha\nbeta\ngamma', opts)
        expect(typeof out, JSON.stringify(opts)).toBe('string')
        expect(out.split('\n').length, JSON.stringify(opts)).toBeLessThanOrEqual(3)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 3. The JSONL reader on hostile streams
// ---------------------------------------------------------------------------

describe('extractNarrative — the JSONL stream is untrusted text (#61 QA)', () => {
  const jsonl = (s) => extractNarrative(s, 'jsonl-agent-message')

  it('answers "" when the stream carries tool events and no message at all', () => {
    // The engine turns "" into a FAILURE with no history entry, which is the point:
    // a codex turn that only ran commands has narrated nothing.
    const stream = [
      '{"type":"item.completed","item":{"type":"command_execution","command":"git status"}}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking about it"}}',
      '{"type":"item.completed","item":{"type":"error","message":"boom"}}',
      '{"type":"turn.failed"}',
    ].join('\n')
    expect(jsonl(stream)).toBe('')
  })

  it('skips a line that is a JSON array, a scalar or null', () => {
    const stream = [
      '[{"type":"agent_message","text":"from an array"}]',
      '"just a string"',
      'null',
      '42',
      'true',
      '{"type":"item.completed","item":{"type":"agent_message","text":"the real one"}}',
    ].join('\n')
    expect(jsonl(stream)).toBe('the real one')
  })

  it('skips an event whose `item` is an array rather than an object', () => {
    const stream = [
      '{"type":"item.completed","item":[{"type":"agent_message","text":"nested in an array"}]}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"kept"}}',
    ].join('\n')
    expect(jsonl(stream)).toBe('kept')
  })

  it('falls back to the last NON-BLANK message when the final one is whitespace', () => {
    // A blank final answer is not an answer, and overwriting a real one with it
    // would turn a good digest into a "returned no text" failure.
    const stream = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"the substance"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"   \\n  "}}',
    ].join('\n')
    expect(jsonl(stream)).toBe('the substance')
  })

  it('ignores a truncated final line and keeps the last complete message', () => {
    const stream =
      '{"type":"item.completed","item":{"type":"agent_message","text":"complete"}}\n' +
      '{"type":"item.completed","item":{"type":"agent_mess'
    expect(jsonl(stream)).toBe('complete')
  })

  it('reads a CRLF stream, including one with no final newline', () => {
    const stream =
      '{"type":"item.completed","item":{"type":"reasoning","text":"x"}}\r\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"crlf survivor"}}\r\n' +
      '{"type":"turn.completed"}'
    expect(jsonl(stream)).toBe('crlf survivor')
  })

  it('reads one enormous line without truncating the message it carries', () => {
    const body = 'x'.repeat(200000)
    expect(jsonl(JSON.stringify({ type: 'agent_message', text: body }))).toBe(body)
  })

  it('prefers `text` deterministically when `text` and `message` disagree', () => {
    // Both fields are accepted because codex versions differ; when both are present
    // the answer must not depend on key order in the JSON.
    expect(jsonl('{"type":"agent_message","text":"T","message":"M"}')).toBe('T')
    expect(jsonl('{"type":"agent_message","message":"M","text":"T"}')).toBe('T')
    expect(jsonl('{"type":"item.completed","item":{"message":"M","type":"agent_message","text":"T"}}')).toBe('T')
    // ...and falls through to `message` only when `text` is not a string.
    expect(jsonl('{"type":"agent_message","text":null,"message":"M"}')).toBe('M')
    expect(jsonl('{"type":"agent_message","text":7,"message":"M"}')).toBe('M')
  })

  it('answers "" when neither body is a string', () => {
    expect(jsonl('{"type":"agent_message","text":{"text":"nested"}}')).toBe('')
    expect(jsonl('{"type":"agent_message","message":["a"]}')).toBe('')
    expect(jsonl('{"type":"agent_message"}')).toBe('')
  })

  it('keeps a multi-paragraph message intact and trims only its ends', () => {
    const stream = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '\n\nfirst.\n\nsecond.\n\n' },
    })
    expect(jsonl(stream)).toBe('first.\n\nsecond.')
  })

  it('the text kind is total over anything a CLI could print', () => {
    for (const input of [undefined, null, 0, {}, [], '   ', '\u0000ok\u0000']) {
      expect(typeof extractNarrative(input, 'text')).toBe('string')
    }
    expect(extractNarrative('\r\nprose\r\n', 'text')).toBe('prose')
  })
})

// ---------------------------------------------------------------------------
// 4. The race — the real timeout
// ---------------------------------------------------------------------------

describe('runDigest — the hard deadline bounds the WAIT, not just the child (#61 QA)', () => {
  it('abandons a child that never settles, and its late rejection never escapes', async () => {
    // The measured production case: execa's own `timeout` signals the child, but the
    // result promise only settles when stdout closes, and an agent's orphans hold
    // that pipe. Here the injected child never settles at all, and then rejects
    // AFTER being abandoned — the shape that would surface as a process-level
    // unhandledRejection if nobody kept a handler on it.
    //
    // THE THREE NUMBERS ARE THE TEST. `childDeadline` gives up at the budget plus a
    // grace clamped to the budget, so 100ms here means ~200ms:
    //   * give up at ~200ms, asserted below 700 — if the race were gone, the digest
    //     could only settle when the injected promise rejects, at 900;
    //   * reject at 900ms, which must land INSIDE the observation window or the
    //     unhandledRejection half of this test proves nothing;
    //   * watch for 1200ms after the digest returns, so the window closes no earlier
    //     than ~1400ms and covers the rejection with ~500ms to spare on a busy machine.
    const rejections = []
    const onRejection = (e) => rejections.push(e)
    process.on('unhandledRejection', onRejection)
    try {
      const deps = engineDeps({
        timeout: 100,
        exec: makeExec({
          agent: () =>
            new Promise((_, reject) => setTimeout(() => reject(new Error('late boom')), 900)),
        }),
      })
      const started = Date.now()
      const result = await runDigest(deps)

      // Bounded by the race, and demonstrably NOT by the rejection: 700 sits between
      // the give-up and the reject.
      expect(Date.now() - started, 'the wait was not bounded by the race').toBeLessThan(700)
      expect(result.status).toBe('failed')
      expect(result.diagnostic).toMatch(/timed out/i)
      expect(result.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
      expect(result.narrative).toBe(null)
      expect(deps.fs.appended, 'a hung agent wrote a history entry').toEqual([])

      // Outlive the abandoned promise's own rejection, which is the whole point of the
      // tripwire above.
      await new Promise((r) => setTimeout(r, 1200))
      expect(rejections.map((e) => e?.message)).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('does NOT kill a slow but successful agent, and writes its entry', async () => {
    // The deadline is a hang bound, not a budget. An answer that arrives inside the
    // grace must be used, or a busy machine would silently stop producing digests.
    //
    // The two numbers are scaled to keep pinning that: the grace is now the budget or
    // KILL_GRACE_MS, whichever is smaller (`childDeadline`), so an answer "inside the
    // grace" is one arriving before roughly twice the budget. 700ms against a 600ms
    // budget is past the point execa would have signalled the child and 500ms clear of
    // the ~1200ms give-up — enough margin that timer drift on a loaded machine cannot
    // flip the outcome.
    const deps = engineDeps({
      timeout: 600,
      exec: makeExec({
        agent: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ exitCode: 0, stdout: NARRATIVE, stderr: '' }), 700),
          ),
      }),
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('ok')
    expect(result.narrative).toBe(NARRATIVE)
    expect(deps.fs.appended).toHaveLength(1)
  })

  it('leaves no deadline timer pending after a fast success', async () => {
    // An un-cleared (even if unref'd) deadline is a timer the process carries for 92
    // seconds after it has already answered. Counted rather than reasoned about.
    vi.useFakeTimers()
    try {
      const result = await runDigest(engineDeps())
      expect(result.status).toBe('ok')
      expect(vi.getTimerCount(), 'a deadline timer outlived the answer').toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a child-level timeout and a pipe-level one as different diagnostics', async () => {
    // Both are "timed out", and they must both be ONE line — but they are different
    // facts and the second one names the pipe, which is the only clue a reader gets
    // that the child was already dead.
    const childTimeout = engineDeps({
      timeout: 1234,
      exec: makeExec({ agent: { exitCode: undefined, timedOut: true, stdout: '', stderr: '' } }),
    })
    const a = await runDigest(childTimeout)
    expect(a.status).toBe('failed')
    expect(a.diagnostic).toMatch(/timed out after 1s/)
    expect(a.diagnostic).not.toMatch(/pipe/)

    const pipeHang = engineDeps({
      timeout: 20,
      exec: makeExec({ agent: () => new Promise(() => {}) }),
    })
    const b = await runDigest(pipeHang)
    expect(b.status).toBe('failed')
    expect(b.diagnostic).toMatch(/pipe/)
  })

  it('SIGKILLs the abandoned child rather than leaving it running', async () => {
    const signals = []
    const child = new Promise(() => {})
    child.kill = (sig) => signals.push(sig)
    const deps = engineDeps({ timeout: 20, exec: makeExec({ agent: () => child }) })
    await runDigest(deps)
    expect(signals).toEqual(['SIGKILL'])
  })

})

// ---------------------------------------------------------------------------
// 5. Never throws — the module header's promise, at each boundary
// ---------------------------------------------------------------------------

describe('runDigest — every boundary degrades to a diagnostic (#61 QA)', () => {
  it('an unreadable prompt template does not throw out of the engine', async () => {
    // templates/digest.md ships in the package, so this is a broken install or a
    // permissions problem — and `runDigest` documents itself as never throwing, so
    // it owes a diagnostic here like it does for every other failure.
    for (const readTemplate of [
      () => {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      },
      () => null,
      () => 42,
    ]) {
      const deps = engineDeps({ readTemplate })
      await expect(runDigest(deps), String(readTemplate)).resolves.toMatchObject({
        status: 'failed',
      })
      expect(deps.fs.appended).toEqual([])
    }
  })

  it('an exec that throws SYNCHRONOUSLY is caught like a rejected one', async () => {
    const deps = engineDeps({
      exec: (cmd) => {
        if (cmd === 'git') return Promise.resolve({ exitCode: 0, stdout: '' })
        throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
      },
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('failed')
    expect(result.diagnostic).toEqual(expect.any(String))
    expect(deps.fs.appended).toEqual([])
  })

  it('a mkdir that fails costs the entry, never the narrative', async () => {
    const deps = engineDeps({
      mkdir: () => {
        throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' })
      },
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('ok')
    expect(result.narrative).toBe(NARRATIVE)
    expect(deps.fs.appended).toEqual([])
    // ...and the reader is told, in one line, that the record was lost.
    expect(result.diagnostic).toEqual(expect.any(String))
    expect(result.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
    expect(result.diagnostic).toMatch(/digest\.log/)
  })

  it('a failed append is reported without losing the narrative or the status', async () => {
    const deps = engineDeps({
      appendFile: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('ok')
    expect(result.narrative).toBe(NARRATIVE)
    expect(result.diagnostic).toMatch(/could not append/i)
  })

  it('a collect() answering with a primitive, null or a partial shape still answers', async () => {
    for (const collect of [
      async () => null,
      async () => 'nonsense',
      async () => 42,
      async () => ({}),
      async () => ({ mode: 'running' }),
    ]) {
      const deps = engineDeps({ collect })
      const result = await runDigest(deps)
      expect(['no-run', 'failed', 'ok'], String(collect)).toContain(result.status)
      expect(result.diagnostic ?? '', String(collect)).toEqual(expect.any(String))
    }
  })

  it('a collect() that rejects, and one that throws synchronously, both degrade', async () => {
    for (const collect of [
      async () => {
        throw new Error('git exploded')
      },
      () => {
        throw new Error('sync explosion')
      },
    ]) {
      const deps = engineDeps({ collect })
      const result = await runDigest(deps)
      expect(result.status).toBe('failed')
      expect(deps.exec.calls, 'the agent was spawned after the gather failed').toEqual([])
      expect(deps.fs.appended).toEqual([])
    }
  })

  it('a non-finite clock from the gatherer falls back to the injected one', async () => {
    for (const bad of [undefined, null, NaN, Infinity, 'now']) {
      const deps = engineDeps({ collect: makeCollect({ now: bad }) })
      const result = await runDigest(deps)
      expect(result.status, String(bad)).toBe('ok')
      expect(deps.fs.appended[0].data, String(bad)).toContain('2026-08-26T04:40:12Z')
    }
  })

  it('a diagnostic stays one short line even when the agent printed a page of stderr', async () => {
    const wall = Array.from({ length: 200 }, (_, i) => `line ${i} of a very long stack trace`).join('\n')
    const deps = engineDeps({
      exec: makeExec({ agent: { exitCode: 3, stdout: '', stderr: wall } }),
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('failed')
    expect(result.diagnostic.split('\n')).toHaveLength(1)
    expect(result.diagnostic.length, 'the diagnostic was not capped').toBeLessThan(300)
    expect(result.diagnostic).toContain('line 0')
  })

  it('an exit code that is not a number is a failure, not an accidental success', async () => {
    for (const exitCode of [undefined, null, '0', NaN, 1]) {
      const deps = engineDeps({
        exec: makeExec({ agent: { exitCode, stdout: NARRATIVE, stderr: '' } }),
      })
      const result = await runDigest(deps)
      expect(result.status, String(exitCode)).toBe('failed')
      expect(deps.fs.appended, String(exitCode)).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// 6. The record's edges, and the log that may not exist
// ---------------------------------------------------------------------------

describe('runDigest — the record at its edges (#61 QA)', () => {
  it('a record with `current: null` tails no log and invents no path', async () => {
    const deps = engineDeps({ collect: makeCollect({ record: liveRecord({ current: null }) }) })
    const result = await runDigest(deps)

    expect(result.status).toBe('ok')
    expect(result.task).toBe('none')
    expect(deps.fs.reads.filter((p) => p.includes('ralph-issue'))).toEqual([])
    const prompt = deps.exec.prompt()
    expect(prompt).toMatch(/no task in flight/i)
    expect(prompt).not.toContain('ralph-issue-null')
    expect(prompt).not.toContain('ralph-issue-undefined')
  })

  it('a task number that is not a number tails no log either', async () => {
    for (const number of ['31', null, undefined, {}, [31], true]) {
      const deps = engineDeps({
        collect: makeCollect({
          record: liveRecord({ current: { number, started_at: '2026-08-26T04:00:00.000Z' } }),
        }),
      })
      const result = await runDigest(deps)
      expect(result.status, JSON.stringify(number)).toBe('ok')
      expect(deps.fs.reads.filter((p) => p.includes('ralph-issue')), JSON.stringify(number)).toEqual([])
      expect(inFlightLogPath(ROOT, number), JSON.stringify(number)).toBe(null)
    }
  })

  it('tails the NUMBER-named log for a jira run, not the key-named one the loop writes (HAZARD, pinned)', async () => {
    // A cross-file divergence #128 created, and nothing else in the suite compares the two
    // halves because they are produced by different files:
    //
    //   • lib/run-state.js:101 writes `number: toNumberOrNull(number) ?? numberFromKey(key)`,
    //     so a jira iteration for FOO-123 records number 123 alongside task_key 'FOO-123'.
    //   • templates/ralph.sh:583 dispatches `run_agent_for_issue "$task_log_handle"`, and the
    //     handle is derived from the key one line earlier (ralph.sh:582 replaces every
    //     character outside [A-Za-z0-9._-] with `_`), which is a NO-OP for a key shaped like
    //     FOO-123 — so the transcript is written to logs/ralph-issue-FOO-123.log. The handle
    //     is deliberately NOT the key (ralph.sh:575-577 says so), but for the ordinary key
    //     this test uses the two strings are equal, so the divergence below is real and not
    //     an artifact of the scrub.
    //   • lib/digest.js:482-483 builds the tail path from `record.current.number` alone and
    //     hands it to `inFlightLogPath`, which formats `logs/ralph-issue-${taskNumber}.log`.
    //
    // So the digest tails a file that does not exist and narrates a jira run with no
    // transcript at all. It degrades quietly — the ENOENT is swallowed and the digest still
    // reports ok — which is exactly why it needs a test rather than a bug report on its own.
    // Two tickets whose keys share a number (AAA-7 and BBB-7) would also collide on one path.
    //
    // NOT FIXED HERE, but the fix is already half-present in the file: digest.js imports
    // `taskKeyOf` (lib/progress.js:1362) and uses it in `taskLabel` so the PROSE says FOO-123
    // — for the stated reason that a derived `#123` names something nobody can look up. The
    // log path is the one place that reasoning was not applied.
    const seen = []
    const deps = engineDeps({
      collect: makeCollect({
        record: liveRecord({
          source: 'jira',
          current: {
            number: 123,
            task_key: 'FOO-123',
            started_at: '2026-08-26T04:00:00.000Z',
            iteration: 3,
          },
        }),
      }),
      // Only the key-named transcript exists on disk, which is the real shape of a jira run.
      fsOptions: {
        log: (p) => {
          seen.push(p)
          if (p.includes('ralph-issue-FOO-123')) return 'the transcript the loop actually wrote'
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        },
      },
    })
    const result = await runDigest(deps)

    expect(result.status).toBe('ok')
    // The path it asked for, and the path it never asked for.
    expect(seen).toEqual([`${ROOT}/logs/ralph-issue-123.log`])
    expect(inFlightLogPath(ROOT, 123)).toBe(`${ROOT}/logs/ralph-issue-123.log`)
    // The consequence, stated where a reader will see it: the transcript is missing from the
    // prompt the narrator gets, even though it was on disk the whole time.
    expect(deps.exec.prompt()).not.toContain('the transcript the loop actually wrote')
  })

  it('a record that is an array or has no run_id still produces one stamped entry', async () => {
    for (const record of [[1, 2, 3], { schema: 1 }, { run_id: '' }, { run_id: 0 }]) {
      const deps = engineDeps({ collect: makeCollect({ record, mode: 'interrupted' }) })
      const result = await runDigest(deps)
      expect(result.status, JSON.stringify(record)).toBe('ok')
      expect(deps.fs.appended, JSON.stringify(record)).toHaveLength(1)
      const entry = deps.fs.appended[0].data
      expect(entry, JSON.stringify(record)).toContain('2026-08-26T04:40:12Z')
      // Never a bare `run undefined` / `run null` in a file a human reads.
      expect(entry).not.toMatch(/run (undefined|null)\b/)
    }
  })

  it('never-run leaves the filesystem and the process table untouched', async () => {
    const deps = engineDeps({
      collect: makeCollect({ record: null, mode: 'never-run', queue: null }),
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('no-run')
    // Not even the git probes: there is no run to describe the tree of.
    expect(deps.exec.calls).toEqual([])
    expect(deps.fs.appended).toEqual([])
    expect(deps.fs.mkdirs, '.ralph/ was created for a project that never ran').toEqual([])
    expect(deps.fs.reads).toEqual([])
  })

  it('a mode of `running` with no record on disk is still the no-run answer', async () => {
    const deps = engineDeps({ collect: makeCollect({ record: null, mode: 'running' }) })
    const result = await runDigest(deps)
    expect(result.status).toBe('no-run')
    expect(deps.exec.calls).toEqual([])
  })

  it('an unknown mode is narrated rather than refused', async () => {
    // reconcileMode ships four modes; a fifth added later must not silently turn the
    // digest off, because the record is there and there IS something to say.
    const deps = engineDeps({ collect: makeCollect({ mode: 'draining' }) })
    const result = await runDigest(deps)
    expect(result.status).toBe('ok')
    expect(deps.exec.prompt()).toContain('draining')
  })
})

describe('runDigest — the log tail is bounded by bytes as well as lines (#61 QA)', () => {
  it('bounds ONE enormous line, keeping its most recent end', async () => {
    const line = 'x'.repeat(4000000) + 'THE-LATEST-OUTPUT'
    const deps = engineDeps({ fsOptions: { log: line } })
    await runDigest(deps)
    const prompt = deps.exec.prompt()
    expect(prompt).toContain('THE-LATEST-OUTPUT')
    expect(prompt.length, 'a single 4MB line reached the model').toBeLessThan(40000)
  })

  it('never hands the model a replacement character out of a multibyte log', async () => {
    const deps = engineDeps({ fsOptions: { log: 'é'.repeat(20000) + '\nplain tail line\n' } })
    await runDigest(deps)
    expect(deps.exec.prompt()).not.toContain('�')
  })

  it('an empty, whitespace-only or unreadable log all read as an explicit absence', async () => {
    for (const log of ['', '\n\n\n', () => { throw new Error('EACCES') }]) {
      const deps = engineDeps({ fsOptions: { log } })
      const result = await runDigest(deps)
      expect(result.status, String(log)).toBe('ok')
      expect(deps.exec.prompt(), String(log)).toMatch(/empty or has not been written/i)
    }
  })

  it('bounds a flooded git status while keeping the branch line the issue asks about', async () => {
    const flood = ['## main...origin/main [ahead 41]']
      .concat(Array.from({ length: 6000 }, (_, i) => ` M file-${i}.js`))
      .join('\n')
    const deps = engineDeps({
      exec: makeExec({ git: (args) => Promise.resolve({ exitCode: 0, stdout: args[0] === 'status' ? flood : GIT_LOG }) }),
    })
    await runDigest(deps)
    const prompt = deps.exec.prompt()
    expect(prompt).toContain('## main...origin/main [ahead 41]')
    expect(prompt).not.toContain('file-5999.js')
  })

  it('both git probes failing reads as an explicit absence, not a clean tree', async () => {
    for (const git of [
      () => Promise.resolve({ exitCode: 128, stdout: '', stderr: 'not a git repository' }),
      () => Promise.reject(new Error('spawn git ENOENT')),
      () => {
        throw new Error('sync ENOENT')
      },
      () => Promise.resolve(null),
    ]) {
      const deps = engineDeps({ exec: makeExec({ git }) })
      const result = await runDigest(deps)
      expect(result.status, String(git)).toBe('ok')
      const prompt = deps.exec.prompt()
      expect(prompt, String(git)).toMatch(/git reported nothing/i)
      expect(prompt, String(git)).toMatch(/no commits reported/i)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. The context cannot forge itself
// ---------------------------------------------------------------------------

describe('buildDigestPrompt — context is inlined ONCE, never re-interpolated (#61 QA)', () => {
  it('a log tail carrying a placeholder reaches the model verbatim', async () => {
    // The log tail is the agent's own output, which is the one part of the context a
    // task under test could influence. A second interpolation pass over it would let
    // a log line rewrite the run record the model is reading.
    const deps = engineDeps({
      fsOptions: { log: 'the task printed {{RUN_STATE}} and {{PROGRESS}} and {{LOG_TAIL}}\n' },
    })
    await runDigest(deps)
    const prompt = deps.exec.prompt()
    expect(prompt).toContain('the task printed {{RUN_STATE}} and {{PROGRESS}} and {{LOG_TAIL}}')
    // ...and the real record appears exactly once, in its own block. `queue_at_start`
    // is a run-record-only key: it is not in the progress snapshot, so a second copy
    // could only have come from a second interpolation pass.
    expect(prompt.match(/"queue_at_start": 8/g)).toHaveLength(1)
  })

  it('a log tail carrying $& or $1 is not read as a replacement pattern', async () => {
    const deps = engineDeps({ fsOptions: { log: 'match $& then $1 then $$ then $`\n' } })
    await runDigest(deps)
    expect(deps.exec.prompt()).toContain('match $& then $1 then $$ then $`')
  })

  it('the assembled var set is exactly the template’s placeholder set, both ways', () => {
    // Same contract the dev pins, asserted as two set differences so a failure names
    // WHICH side drifted rather than just that the sorted lists differ.
    const template = readFileSync(new URL('../templates/digest.md', import.meta.url), 'utf8')
    const asked = new Set([...template.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((m) => m[1]))
    const supplied = new Set(Object.keys(assembleDigestContext({})))
    expect([...asked].filter((k) => !supplied.has(k)), 'template asks for vars nobody assembles').toEqual([])
    expect([...supplied].filter((k) => !asked.has(k)), 'vars assembled that the template never uses').toEqual([])
  })

  it('the template tells the model it has no tools, which is the design it verifies', async () => {
    const deps = engineDeps()
    const result = await runDigest(deps)
    expect(result.prompt.toLowerCase()).toMatch(/no tools/)
    // And it never invites an action: this surface narrates, it does not advise.
    expect(result.prompt.toLowerCase()).toMatch(/never suggest a command|narrating, not/)
  })
})

// ---------------------------------------------------------------------------
// 8. The history entry and the terminal rendering
// ---------------------------------------------------------------------------

describe('formatHistoryEntry / renderDigest — shape under hostile text (#61 QA)', () => {
  it('a heading is one line, whatever the label’s length', () => {
    for (const task of ['#031', 'none', '#'.repeat(200), '']) {
      const entry = formatHistoryEntry({ at: 'T', runId: 'r', task, narrative: 'x' })
      // [0] is the entry's own leading delimiter newline, so the heading is [1].
      expect(entry.split('\n')[1].split('\n'), task).toHaveLength(1)
      expect(entry.split('\n')[1], task).toMatch(/^── /)
      const lines = renderDigest({ narrative: 'x', task, model: 'haiku', now: NOW })
      expect(lines[0].includes('\n'), task).toBe(false)
    }
  })

  it('a narrative carrying newlines cannot inject a second heading line', () => {
    // Any line the narrative contributes must be narrative. A forged `── …` line is
    // the one thing a reader (or a grep over the history) would mistake for an entry.
    const forged = `real prose.\n── 1999-01-01T00:00:00Z · run other-run · #999 ${'─'.repeat(20)}\nmore prose.`
    const entry = formatHistoryEntry({ at: 'T', runId: 'r', task: '#1', narrative: forged })
    const headings = entry.split('\n').filter((l) => l.startsWith('── '))
    expect(headings, 'a narrative forged a history heading').toHaveLength(1)
  })

  it('the terminal heading names the resolved model, so an override is visible', () => {
    const lines = renderDigest({ narrative: 'x', task: '#031', model: 'gpt-5-mini', now: NOW })
    expect(lines[0]).toContain('gpt-5-mini')
    expect(lines[0]).not.toContain('undefined')
  })

  it('renders no ANSI escapes — the narrative channel is plain text', () => {
    const lines = renderDigest({ narrative: 'x', task: '#1', model: 'm', now: NOW })
    expect(lines.join('\n')).not.toMatch(new RegExp(String.fromCharCode(27)))
  })

  it('is total: a missing narrative, model, task and clock all render without throwing', () => {
    const lines = renderDigest({})
    expect(Array.isArray(lines)).toBe(true)
    expect(lines[0]).toContain('none')
    expect(lines[0]).toContain('unknown')
    expect(lines[0]).toContain('--:--')
    expect(formatHistoryEntry()).toMatch(/^\n── unknown · run unknown · none/)
    expect(formatHistoryEntry().endsWith('\n\n')).toBe(true)
  })
})

// The function MOVED to lib/one-line.js in #108 (so `ralph doctor` could word a warning without
// inheriting this module's execa import) and lib/one-line.test.js is now its full spec, including
// the control characters a whitespace collapse never reached. These three tests are kept HERE
// anyway, and deliberately: this file's subject is the SHAPE of a digest diagnostic, every one of
// which is `oneLine`'s output, and the heading tests further down depend on the same three
// promises — so they are pinned where the dependency is, not only where the definition is.
describe('oneLine — the shape a diagnostic promises (#61 QA, moved by #108)', () => {
  it('collapses every kind of whitespace to a single line', () => {
    expect(oneLine('a\nb\r\nc\td   e f')).toBe('a b c d e f')
    expect(oneLine('\n\n  padded  \n\n')).toBe('padded')
  })

  it('caps long text with an ellipsis rather than truncating silently', () => {
    const out = oneLine('z'.repeat(5000))
    expect(out).toHaveLength(200)
    expect(out.endsWith('…')).toBe(true)
  })

  it('is idempotent, because the engine and the CLI shell both apply it', () => {
    for (const input of ['a\nb', 'z'.repeat(5000), '', null, undefined, 0, {}]) {
      expect(oneLine(oneLine(input)), String(input)).toBe(oneLine(input))
    }
  })
})

// ---------------------------------------------------------------------------
// 9. Registry purity (AC#5)
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(new URL('./digest.js', import.meta.url), 'utf8')
// Comments are stripped first: the module's prose NAMES claude and codex in order
// to explain that it does not branch on them.
const CODE = SOURCE.split('\n')
  .map((line) => (line.trimStart().startsWith('//') ? '' : line.replace(/\s\/\/.*$/, '')))
  .join('\n')

function bodyOf(name) {
  const start = CODE.indexOf(`function ${name}(`)
  expect(start, `${name} must be declared in lib/digest.js`).toBeGreaterThan(-1)
  const end = CODE.indexOf('\n}\n', start)
  return CODE.slice(start, end)
}

describe('lib/digest.js — the registry is the only holder of agent knowledge (#61 QA)', () => {
  it('names no agent and no agent CLI flag anywhere in its code', () => {
    for (const forbidden of [
      /\bclaude\b/i,
      /\bcodex\b/i,
      /\bhaiku\b/i,
      /gpt-5/i,
      /--tools/,
      /--sandbox/,
      /--output-format/,
      /--model/,
      /approval_policy/,
      /skip-git-repo-check/,
    ]) {
      expect(CODE, `lib/digest.js code matches ${forbidden}`).not.toMatch(forbidden)
    }
  })

  it('dispatches on the spec’s output kind, and reads every per-agent field from the spec', () => {
    const body = bodyOf('buildDigestInvocation')
    expect(body).toContain('spec.digest')
    // Every one of the five fields the registry owns is destructured, not guessed.
    for (const field of ['argv', 'modelFlag', 'model', 'stdinArgv', 'output']) {
      expect(body, `${field} is not read from the spec`).toContain(field)
    }
    expect(bodyOf('extractNarrative')).toContain('output ===')
  })

  it('has no throw site of its own and never exits the process', () => {
    // The module header's promise, as a property of the source: an accessory that
    // could exit or throw would be able to affect a run.
    expect(CODE).not.toMatch(/\bthrow\b/)
    expect(CODE).not.toMatch(/process\.exit/)
    expect(CODE).not.toMatch(/console\./)
  })

  it('spawns nothing but the resolved CLI and read-only git', () => {
    const names = [...CODE.matchAll(/exec\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(names, 'a hard-coded command name reached the engine').toEqual(['git'])
    // ...and the git it runs cannot write.
    for (const forbidden of [/'commit'/, /'push'/, /'checkout'/, /'add'/, /'reset'/]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('passes reject:false to every child it starts', () => {
    const spawnSites = (CODE.match(/exec\(/g) ?? []).length
    const rejectFalse = (CODE.match(/reject:\s*false/g) ?? []).length
    expect(rejectFalse, 'a child was started without reject:false').toBe(spawnSites)
  })
})

// ---------------------------------------------------------------------------
// 10. Every wait the engine performs, not just the agent's
// ---------------------------------------------------------------------------

describe('runDigest — no await inside it is unbounded (#61 QA)', () => {
  it('a git probe that never answers cannot hang the digest', async () => {
    // `git status` and `git log` do block in the field — a contended index.lock, a repo
    // on a stalled network mount, a filter/credential helper waiting on a tty — and
    // there is no reader-visible difference between "ralph digest is thinking" and
    // "ralph digest will never return". Both probes are now issued concurrently under
    // one `Promise.all`, each bounded by its share of the digest's budget, so the pair
    // that never answers costs ONE share (plus its kill grace) and not two, and the
    // command still returns. This is the wall-clock ceiling on that; the sibling
    // describes below pin the share's exact value and the surviving paragraph.
    const deps = engineDeps({
      timeout: 50,
      exec: (cmd) =>
        cmd === 'git'
          ? new Promise(() => {})
          : Promise.resolve({ exitCode: 0, stdout: NARRATIVE, stderr: '' }),
    })
    // The sentinel is the tripwire; the STATUS is the property. A probe pair that never
    // answers must cost a paragraph and nothing else, so the digest still narrates —
    // which also means this cannot pass by the digest failing fast for some other
    // reason. 800ms is ~40x the real give-up here (a 50ms budget shares out to 8ms,
    // plus a grace clamped to 8ms) and still far below anything a hang would reach.
    const outcome = await Promise.race([
      runDigest(deps).then((r) => r?.status),
      new Promise((resolve) => setTimeout(() => resolve('NEVER-RETURNED'), 800)),
    ])
    expect(outcome, 'ralph digest hung on a git probe with no bound').not.toBe('NEVER-RETURNED')
    expect(outcome, 'a silent git probe cost the digest itself').toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// 11. The FIXES themselves, which are the newest and therefore least hardened code
//     in the diff. Five defects were repaired by adding: a null-prompt gate, a git
//     budget derived from the timeout, a concurrent probe pair under one
//     `Promise.all`, and a history entry that is self-delimiting BY CONSTRUCTION
//     (indented body, unconditional leading newline) rather than by convention.
//     Each of those is attacked here on its own terms.
// ---------------------------------------------------------------------------

describe('buildDigestPrompt — an unreadable template is a null, never a throw (#61 QA)', () => {
  const TEMPLATE = 'mode {{MODE}} / task {{TASK}}'
  const VARS = { MODE: 'running', TASK: '#031' }
  const quiet = { write: () => true }

  // The gate has to reject every shape a broken reader can answer with, not just the
  // throw — `String(42)` or `String(null)` would otherwise be interpolated and shipped
  // to a model as a two-to-four character prompt, which is a request for invented prose
  // rather than a failure anybody can see.
  it.each([
    ['a reader that throws ENOENT', () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    }],
    ['a reader that throws EACCES', () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }],
    ['a reader that throws a bare string', () => {
      throw 'nope'
    }],
    ['null', () => null],
    ['undefined', () => undefined],
    ['a number', () => 42],
    ['a plain object', () => ({})],
    ['an array of lines', () => ['a', 'b']],
    ['the empty string', () => ''],
    ['a whitespace-only string', () => '   \n\t\n  '],
    ['an empty Buffer', () => Buffer.alloc(0)],
    ['a whitespace-only Buffer', () => Buffer.from('  \n ', 'utf8')],
  ])('answers null for %s', (_label, readTemplate) => {
    expect(buildDigestPrompt(VARS, { readTemplate, stderr: quiet })).toBe(null)
  })

  it('accepts a Buffer, and decodes it rather than stringifying the object', () => {
    // `readFileSync` without an encoding answers with a Buffer, so this branch is a
    // real reader's output and not a hypothetical. `String(buffer)` happens to work,
    // which is exactly why the positive control matters: the test has to prove the
    // template's TEXT arrived, not that something string-shaped did.
    const prompt = buildDigestPrompt(VARS, { readTemplate: () => Buffer.from(TEMPLATE, 'utf8'), stderr: quiet })
    expect(prompt).toBe('mode running / task #031')
  })

  it('answers null when interpolation itself throws over a hostile var', () => {
    const hostile = { MODE: { toString() { throw new Error('boom') } }, TASK: '#031' }
    expect(buildDigestPrompt(hostile, { readTemplate: () => TEMPLATE, stderr: quiet })).toBe(null)
  })

  it('answers null when the stderr the interpolator warns on is itself broken', () => {
    // An unknown placeholder makes `interpolate` write a warning; a stderr that throws
    // on write must not turn that into an exception out of an accessory.
    const broken = { write: () => { throw new Error('EPIPE') } }
    expect(buildDigestPrompt({}, { readTemplate: () => 'a {{NOT_A_VAR}} b', stderr: broken })).toBe(null)
  })

  it('a template with no placeholders at all is still a prompt', () => {
    // The gate rejects a BLANK template, not a placeholder-free one: a template someone
    // shortened by hand must not read as a broken install.
    expect(buildDigestPrompt(VARS, { readTemplate: () => 'narrate.', stderr: quiet })).toBe('narrate.')
  })
})

describe('runDigest — no template means no request, no entry and no cost (#61 QA)', () => {
  const broken = () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  }

  it('fails, names the template, and never asks the model anything', async () => {
    const exec = makeExec()
    const deps = engineDeps({ exec, readTemplate: broken })
    const result = await runDigest(deps)

    expect(result.status).toBe('failed')
    expect(result.narrative).toBe(null)
    expect(result.diagnostic).toContain('templates/digest.md')
    // The gate sits BEFORE the spawn. A model handed a prompt with the context missing
    // would answer about nothing, and the reader would be billed for it.
    expect(exec.agentCall(), 'the agent was invoked with no prompt to send it').toBeUndefined()
    expect(deps.fs.appended).toEqual([])
    expect(deps.fs.mkdirs, '.ralph/ was created for an entry that was never written').toEqual([])
  })

  it('reports `prompt: null` rather than a half-built one', async () => {
    // Every other failure path carries the prompt it sent. A caller reading
    // `result.prompt` has to be able to tell "never built" from "sent and refused".
    const result = await runDigest(engineDeps({ readTemplate: broken }))
    expect(result).toHaveProperty('prompt', null)
    // ...and the rest of the shape a failure always carries is still populated, so the
    // early return is not a differently-shaped result.
    expect(result.root).toBe(ROOT)
    expect(result.mode).toBe('running')
    expect(result.model).toBe('haiku')
    expect(result.agent).toBe('claude')
    expect(result.task).toBe('#031')
    expect(result.now).toBe(NOW)
  })

  it('costs the reader exactly one line, like every other failure', async () => {
    const result = await runDigest(engineDeps({ readTemplate: broken }))
    expect(result.diagnostic.split('\n')).toHaveLength(1)
    expect(oneLine(result.diagnostic)).toBe(result.diagnostic)
    expect(result.diagnostic).toMatch(/^ralph digest: /)
  })

  it.each([
    ['a blank template', () => '   \n  \n'],
    ['an empty Buffer', () => Buffer.alloc(0)],
    ['a reader answering with a number', () => 42],
  ])('treats %s as no template rather than as an empty prompt', async (_label, readTemplate) => {
    const exec = makeExec()
    const deps = engineDeps({ exec, readTemplate })
    const result = await runDigest(deps)
    expect(result.status).toBe('failed')
    expect(exec.agentCall(), 'an empty prompt was sent to the model').toBeUndefined()
    expect(deps.fs.appended).toEqual([])
  })
})

describe('runDigest — the git probes are bounded out of the same budget (#61 QA)', () => {
  it('hands both probes a positive integer share of the digest timeout', async () => {
    // A SHARE rather than a second constant, so tightening the digest's timeout
    // tightens what it waits on. What matters at the edges is that the share can never
    // be zero or negative: `setTimeout` treats those as 1ms, which would turn every
    // probe into an instant non-answer rather than a bounded one.
    for (const [timeout, expected] of [[90000, 15000], [6000, 1000], [60, 10], [1, 1], [0, 1], [-5000, 1]]) {
      const exec = makeExec()
      await runDigest(engineDeps({ exec, timeout }))
      const gits = exec.calls.filter((c) => c.cmd === 'git')
      expect(gits, `timeout ${timeout}`).toHaveLength(2)
      for (const g of gits) {
        expect(g.options.timeout, `timeout ${timeout}`).toBe(expected)
        expect(Number.isInteger(g.options.timeout), `timeout ${timeout}`).toBe(true)
        expect(g.options.timeout, `timeout ${timeout}`).toBeGreaterThan(0)
        // Still read-only and still at the run's root, budget or no budget.
        expect(g.options.reject, `timeout ${timeout}`).toBe(false)
        expect(g.options.cwd, `timeout ${timeout}`).toBe(ROOT)
      }
    }
  })

  it.each([
    ['0', 0],
    ['1', 1],
    ['a negative', -5000],
    ['NaN', Number.NaN],
    ['a string', 'ninety'],
    ['null', null],
    ['an object', {}],
  ])('a degenerate timeout (%s) still settles, and never throws', async (_label, timeout) => {
    const result = await runDigest(engineDeps({ timeout }))
    expect(result.status, `timeout ${_label}`).toEqual(expect.any(String))
    expect(result, `timeout ${_label}`).toHaveProperty('diagnostic')
  })

  it('issues both probes CONCURRENTLY, so the pair costs one budget and not two', async () => {
    const order = []
    let releaseStatus
    const exec = makeExec({
      git: (args) => {
        order.push(args[0])
        if (args[0] === 'status') {
          return new Promise((resolve) => {
            releaseStatus = () => resolve({ exitCode: 0, stdout: GIT_STATUS })
          })
        }
        return Promise.resolve({ exitCode: 0, stdout: GIT_LOG })
      },
    })
    const running = runDigest(engineDeps({ exec }))
    await new Promise((resolve) => setImmediate(resolve))
    // `log` was issued while `status` was still outstanding. Awaited one after the
    // other, the second probe could not have been reached at all.
    expect(order, 'the probes are still awaited in sequence').toEqual(['status', 'log'])
    releaseStatus()
    expect((await running).status).toBe('ok')
  })

  it('does not swap the two probes when the second answers first', async () => {
    // Concurrency is new, and `Promise.all` preserves position rather than completion
    // order — but only if the destructuring stays in step with the array.
    const exec = makeExec({
      git: (args) =>
        args[0] === 'status'
          ? new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, stdout: GIT_STATUS }), 30))
          : Promise.resolve({ exitCode: 0, stdout: GIT_LOG }),
    })
    await runDigest(engineDeps({ exec }))
    const prompt = exec.prompt()
    // templates/digest.md puts {{GIT_STATUS}} above {{GIT_LOG}}, so their order in the
    // prompt is exactly a swap detector.
    expect(prompt).toContain(GIT_STATUS)
    expect(prompt).toContain(GIT_LOG)
    expect(prompt.indexOf(GIT_STATUS), 'the two git probes landed in each other’s slot')
      .toBeLessThan(prompt.indexOf(GIT_LOG))
  })

  it('one probe that never answers costs its own paragraph and nothing else', async () => {
    const exec = makeExec({
      git: (args) =>
        args[0] === 'status'
          ? new Promise(() => {})
          : Promise.resolve({ exitCode: 0, stdout: GIT_LOG }),
    })
    const result = await runDigest(engineDeps({ exec, timeout: 60 }))
    expect(result.status).toBe('ok')
    const prompt = exec.prompt()
    expect(prompt).toContain('(git reported nothing')
    expect(prompt, 'a hung status probe took the log probe down with it').toContain(GIT_LOG)
  })

  it('a probe that REJECTS while the other is still pending does not reject the pair', async () => {
    const exec = makeExec({
      git: (args) =>
        args[0] === 'status'
          ? Promise.reject(new Error('spawn git ENOENT'))
          : new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, stdout: GIT_LOG }), 20)),
    })
    const result = await runDigest(engineDeps({ exec }))
    expect(result.status).toBe('ok')
    expect(exec.prompt()).toContain(GIT_LOG)
  })

  it('a probe that throws SYNCHRONOUSLY is the same non-answer', async () => {
    const exec = makeExec({
      git: (args) => {
        if (args[0] === 'status') throw new Error('unknown option')
        return Promise.resolve({ exitCode: 0, stdout: GIT_LOG })
      },
    })
    const result = await runDigest(engineDeps({ exec }))
    expect(result.status).toBe('ok')
    expect(exec.prompt()).toContain(GIT_LOG)
  })

  it('a probe answering non-zero is a non-answer, not its stderr as context', async () => {
    const exec = makeExec({
      git: () => Promise.resolve({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    })
    const result = await runDigest(engineDeps({ exec }))
    expect(result.status).toBe('ok')
    expect(exec.prompt(), 'git’s stderr was passed off as git state').not.toContain('fatal:')
  })

  it('SIGKILLs the probes it gave up on rather than leaving them running', async () => {
    const kills = []
    const exec = makeExec({
      git: () => {
        const child = new Promise(() => {})
        child.kill = (sig) => kills.push(sig)
        return child
      },
    })
    await runDigest(engineDeps({ exec, timeout: 60 }))
    expect(kills).toEqual(['SIGKILL', 'SIGKILL'])
  })

  it('three concurrent deadlines cannot cross-talk — the narrative is the agent’s own', async () => {
    // `raceDeadline` is now entered three times per digest, concurrently, and its
    // give-up sentinel is module-level. A probe settling must not read as the agent's
    // hang, or the reverse, and neither may settle twice.
    const exec = makeExec({
      git: (args) =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ exitCode: 0, stdout: args[0] === 'status' ? GIT_STATUS : GIT_LOG }), 5),
        ),
      agent: () =>
        new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, stdout: NARRATIVE, stderr: '' }), 15)),
    })
    const deps = engineDeps({ exec, timeout: 4000 })
    const result = await runDigest(deps)
    expect(result.status).toBe('ok')
    expect(result.narrative).toBe(NARRATIVE)
    expect(exec.prompt()).toContain(GIT_STATUS)
    expect(deps.fs.appended).toHaveLength(1)
  })
})

describe('runDigest — “EVERY wait is bounded” includes the one before the budget (#61 QA)', () => {
  it('a run-state gather that never answers cannot hang the digest', async () => {
    // The module header claims every wait is bounded out of one budget. The FIRST await
    // in the engine is `collect` (collectStatus), which shells out to `git rev-parse`,
    // `tmux has-session` and, on a live github-sourced run, `gh issue list` — a network
    // call — none of them carrying a timeout of their own. It was once guarded against
    // THROWING but not against never answering, so a digest could be waited on forever
    // one frame above the region that was bounded. It is now raced against a share of
    // the budget: 50ms here means it gives up at ~8ms, so the 800ms sentinel below is
    // ~100x the bound and can only fire if that race is removed.
    const deps = engineDeps({ timeout: 50, collect: () => new Promise(() => {}) })
    const exec = deps.exec
    const outcome = await Promise.race([
      runDigest(deps).then((r) => r),
      new Promise((resolve) => setTimeout(() => resolve('NEVER-RETURNED'), 800)),
    ])
    expect(outcome, 'ralph digest hung before it reached its own budget').not.toBe('NEVER-RETURNED')

    // ...and a wedged gatherer is an ANOMALY, not a fresh project. `no-run` is the
    // quiet, correct answer for a directory nothing has run in, and reporting it here
    // would print a reassuring line about a healthy repo while a probe hangs.
    expect(outcome.status, 'a wedged gatherer was reported as a project that never ran').toBe('failed')
    expect(outcome.diagnostic).toMatch(/run state/i)
    expect(outcome.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
    expect(outcome.narrative).toBe(null)
    // Nothing was asked and nothing was written on the strength of a state we never read.
    expect(exec.calls, 'a child was spawned without a run state').toEqual([])
    expect(deps.fs.appended).toEqual([])
  })
})

describe('formatHistoryEntry — self-delimiting by construction, not by convention (#61 QA)', () => {
  const INDENT = '  '
  const headingsIn = (text) => text.split('\n').filter((l) => l.startsWith('── '))
  const blocksIn = (text) => text.split('\n\n').filter((b) => b.trim() !== '')
  const entry = (narrative) =>
    formatHistoryEntry({ at: '2026-08-26T04:40:12Z', runId: RUN_ID, task: '#031', narrative })

  it('indents every narrative line by exactly the entry indent, in order', () => {
    // The dev's own test matches lines after trimming BOTH sides, which proves the
    // lines survive but not that the indent is there — and the indent is the whole
    // mechanism. Pinned here byte-for-byte, blank line included.
    // [0] is the entry's leading delimiter newline and [1] the heading, so the body
    // starts at [2] — the same four lines, one index later.
    const lines = entry('first line.\nsecond line.\n\nfourth line.').split('\n')
    expect(lines.slice(2, 6)).toEqual([
      `${INDENT}first line.`,
      `${INDENT}second line.`,
      INDENT,
      `${INDENT}fourth line.`,
    ])
  })

  it.each([
    ['two paragraphs, the shape templates/digest.md asks for', 'Para one.\n\nPara two.'],
    ['three paragraphs', 'One.\n\nTwo.\n\nThree.'],
    ['a forged heading at column 0', `prose.\n── 1999-01-01T00:00:00Z · run other · #999 ${'─'.repeat(20)}\nmore.`],
    ['a forged heading already carrying the indent', `prose.\n  ── 1999-01-01T00:00:00Z · run other ${'─'.repeat(20)}\nmore.`],
    ['a forged heading as the FIRST line', `── 1999-01-01T00:00:00Z · run other ${'─'.repeat(20)}\nprose.`],
    ['a body whose every line is the indent', '  \n  \n  '],
    ['CRLF line endings around the blank line', 'Para one.\r\n\r\nPara two.\r\n'],
    ['a lone carriage return in front of a forged heading', 'prose.\r── 1999-01-01T00:00:00Z · run other ──\rmore.'],
    ['one very long line', 'x'.repeat(50000)],
    ['a blank line made of spaces', 'Para one.\n   \nPara two.'],
    ['a blank line made of tabs', 'Para one.\n\t\nPara two.'],
    ['a fenced code block containing a blank line', 'Look:\n\n```\na\n\nb\n```\n\nDone.'],
    ['a body that is only newlines', '\n\n\n'],
  ])('stays exactly one heading and one block: %s', (_label, narrative) => {
    const text = entry(narrative)
    expect(headingsIn(text), 'a narrative contributed a second heading line').toHaveLength(1)
    expect(blocksIn(text), 'one digest produced more than one delimited block').toHaveLength(1)
  })

  it('two entries in one file are exactly two headings and two blocks', () => {
    // Written the way the engine writes them: appended verbatim, one after the other,
    // because each entry now carries its own leading newline.
    const two = `${entry('Para one.\n\nPara two.')}${entry('Second digest.')}`
    expect(headingsIn(two)).toHaveLength(2)
    expect(blocksIn(two)).toHaveLength(2)
  })

  it('an entry appended after an unterminated line still starts its own line', () => {
    const glued = `── 2026-08-25T23:00:00Z · run older · #030 ───\ntruncated mid-write`
    // No newline added here on purpose: the entry's own leading one is the whole
    // guarantee, so this now tests the format rather than the test's own arithmetic.
    const after = glued + entry('Second digest.')
    expect(headingsIn(after), 'the new heading was glued onto the previous line').toHaveLength(2)
    // ...and the damaged entry's own bytes are untouched.
    expect(after.startsWith(glued)).toBe(true)
  })

  it('the narrative that reaches STDOUT is not indented — the pipe stays prose, verbatim', () => {
    // The indent is a property of the history FORMAT only. `ralph digest > notes.md`
    // must still collect the model's own bytes, or the fix for the history file was
    // paid for out of AC#1.
    const body = 'Para one.\n\nPara two.'
    const lines = renderDigest({ narrative: body, task: '#031', model: 'haiku', now: NOW })
    expect(lines.slice(1).join('\n')).toBe(body)
    for (const line of lines.slice(1)) expect(line.startsWith(INDENT)).toBe(false)
    // ...and the same narrative in the history file IS indented, so stdout and the
    // history file are demonstrably not sharing one renderer.
    expect(entry(body)).toContain(`\n${INDENT}Para one.`)
  })
})

describe('runDigest — the append leads with a newline, written blind (#61 QA)', () => {
  it('writes a payload that begins with a newline and ends with a blank line', async () => {
    const deps = engineDeps()
    await runDigest(deps)
    const data = deps.fs.appended[0].data
    expect(data.startsWith('\n'), 'the entry could be glued onto an unterminated line').toBe(true)
    expect(data.endsWith('\n\n')).toBe(true)
    expect(data.split('\n').filter((l) => l.startsWith('── '))).toHaveLength(1)
    expect(data, 'the narrative reached the file unindented').toContain(`  ${NARRATIVE}`)
  })

  it('does not read the history file back to decide — the guarantee is the format’s', async () => {
    // Written blind on purpose: a read that can itself fail would make the property
    // conditional on a second syscall. So no read of the history path may happen.
    const deps = engineDeps()
    await runDigest(deps)
    expect(deps.fs.reads.filter((p) => p.includes('digest.log'))).toEqual([])
  })

  it('is ONE write, so a concurrent digest cannot interleave a heading and a body', async () => {
    // A single append of this size is atomic on POSIX; two would not be, and two
    // digests do run at once (a cron beside a human).
    const deps = engineDeps()
    await runDigest(deps)
    expect(deps.fs.appended, 'the entry was written in more than one call').toHaveLength(1)
  })

  it('an append that fails still leaves the narrative and one diagnostic', async () => {
    // Unchanged by the fix, re-pinned because the payload it writes changed.
    const deps = engineDeps({
      appendFile: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
    })
    const result = await runDigest(deps)
    expect(result.status).toBe('ok')
    expect(result.narrative).toBe(NARRATIVE)
    expect(result.diagnostic).toMatch(/could not append/i)
    expect(result.diagnostic.split('\n')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 9. #63 — the entry's fourth field, and the WRITER/READER contract at the cap
// ---------------------------------------------------------------------------

// QA augmentation for #63 on the writing side. The dev's digest.test.js pins that the model
// is named as a fourth field and that a model name cannot forge a heading; the reading side
// is attacked in lib/digest-history.qa.test.js. What is left, and what neither file owns, is
// the SEAM BETWEEN THEM: `oneLine` caps the whole heading label at 200 characters, so a long
// field does not merely get shortened — it can take a LATER field's separator with it, and
// the reader's `fields.length < 3` guard then decides whether the entry survives. That
// arithmetic is invisible from either side alone.
describe('formatHistoryEntry ↔ parseLatestDigest — the label cap is a contract (#63 QA)', () => {
  const AT_63 = '2026-08-26T04:40:12Z'
  const SEP_63 = ` ${String.fromCharCode(0xb7)} `

  it('writes exactly four fields, on one line, for every shape of field', () => {
    for (const [label, fields] of Object.entries({
      'the ordinary case': { runId: 'ralph-repo-abc', task: '#031', model: 'claude-haiku-4-5' },
      'nothing at all': {},
      'a model carrying the field separator': { runId: 'r', task: '#1', model: `a${SEP_63}b` },
      'a model carrying newlines': { runId: 'r', task: '#1', model: 'a\nb\nc' },
      'a 500-character model': { runId: 'r', task: '#1', model: 'm'.repeat(500) },
      'a bedrock model id': { runId: 'r', task: '#1', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
    })) {
      const heading = formatHistoryEntry({ at: AT_63, narrative: 'x', ...fields }).split('\n')[1]
      expect(heading.split('\n'), label).toHaveLength(1)
      // Four fields, always: an entry that wrote three would be indistinguishable from a
      // 0.21.0 entry, and the reader reports a missing model as "no model" rather than as
      // a malformed heading.
      expect(heading.split(SEP_63).length, `${label}: ${heading}`).toBeGreaterThanOrEqual(4)
    }
  })

  it('round-trips a model that contains the field separator, via the remainder rule', () => {
    // The model is written LAST for exactly this reason: it is a string this codebase does
    // not control, so the reader takes everything after the task as the model rather than
    // splitting on a separator the value might hold.
    const model = `bedrock${SEP_63}claude-haiku`
    const parsed = parseLatestDigest(
      formatHistoryEntry({ at: AT_63, runId: 'r', task: '#1', model, narrative: 'x' }),
    )
    expect(parsed.model).toBe(model)
    expect(parsed.task).toBe('#1')
  })

  it('refuses the whole entry rather than reading a wrong field when the cap eats a separator', () => {
    // A run id long enough to push the label past 200 characters leaves a heading with TWO
    // fields, and the reader's `< 3` guard drops it — so the section vanishes (AC#5) rather
    // than reporting a truncated run id that could match nothing or, worse, something.
    const text = formatHistoryEntry({ at: AT_63, runId: 'R'.repeat(200), task: '#1', model: 'm', narrative: 'x' })
    expect(text.split('\n')[1]).toContain('…')
    expect(parseLatestDigest(text)).toBe(null)
  })

  it('loses the model, not the entry, when the cap eats only the last field', () => {
    // One field further along: the task survives (truncated), the model is gone, and the
    // reader reports `model: null` — which renders with no model clause at all rather than
    // with the word `unknown`. The run scoping, which is what protects the reader from
    // another run's narration, is untouched.
    const text = formatHistoryEntry({ at: AT_63, runId: 'r', task: 'T'.repeat(200), model: 'm', narrative: 'x' })
    const parsed = parseLatestDigest(text)
    expect(parsed).not.toBe(null)
    expect(parsed.runId).toBe('r')
    expect(parsed.model, 'a truncated label published a partial model name').toBe(null)
  })

  it('keeps digestInterval in one place — the copy in start.js is gone, not duplicated', () => {
    // #63 moved this helper out of lib/commands/start.js so `ralph start`, `ralph digest
    // --loop` and `ralph status` read the knob by one rule. A leftover local copy would
    // drift silently: the launch box would say `every 30m` while the status view measured
    // staleness against something else. Its home is lib/digest-file.js — the pure module
    // the writer, the reader and both commands share — and that is where this file imports
    // it from too, so the function exercised below is the one production calls.
    const startSource = readFileSync(new URL('./commands/start.js', import.meta.url), 'utf8')
    expect(startSource, 'start.js still defines its own digestInterval').not.toMatch(
      /function digestInterval/,
    )
    expect(startSource, 'start.js still defines its own config reader').not.toMatch(/function safeReadConfig/)
    expect(startSource).toMatch(/import \{[^}]*digestInterval[^}]*\} from '\.\.\/digest-file\.js'/)
    // ...and it is the same function, not a re-export of something else.
    expect(digestInterval('RALPH_DIGEST_INTERVAL="30m" # every half hour')).toBe('30m')
    expect(digestInterval('RALPH_DIGEST_INTERVAL=0')).toBe('')
  })
})
