import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { digestCommand, DigestAbort } from './digest.js'

// QA augmentation for #61 — the CLI shell. The dev's lib/commands/digest.test.js
// covers the happy path, three failure shapes, an engine that throws, and the
// `--help` registration. What is attacked HERE:
//
//   1. BOTH CHANNELS AT ONCE. The engine's `{status:'ok', narrative, diagnostic}` —
//      "printed, but could not append" — is the one result shape that writes to stdout
//      AND stderr, and it is the shape a read-only `.ralph/` produces in the field.
//      Nothing in the dev's suite exercises it through the shell.
//   2. THE ONE-LINE PROMISE, KEPT TWICE. The engine collapses its diagnostic and the
//      shell collapses it again; an injected engine (or a future one) that hands over
//      a page of text must not put a page on stderr, because a launchd log collects
//      these per line.
//   3. THE ENGINE MUST NOT REACH stdout. stdout is the narrative channel; the shell
//      forwards `stderr` into the engine bag deliberately and must NOT forward
//      `stdout`, or an interpolate warning would land in `ralph digest > notes.md`.
//   4. A RESULT OF ANY SHAPE. null, undefined, a primitive, an array, a status that is
//      not one of the three — all must exit 0 and say exactly one thing.
//   5. A REJECTION OF ANY SHAPE. A thrown string, a null, an Error with no message, a
//      DigestAbort — none may produce a stack trace or a non-zero exit.
//   6. ORDER. The prose is written before the diagnostic, so a human reading a
//      terminal sees the answer and then the caveat about it.
//
// `run` is injected everywhere below, so nothing here spawns a model. The CLI section
// at the bottom invokes the real binary, and only with `--help`.

const NARRATIVE = '#031 is in the red phase.\nMain is 8 commits ahead of origin/main.'

// One sink behind both streams, so ORDER across them is observable — two separate
// recorders would each look correct while interleaving wrongly.
function makeSinks() {
  const events = []
  const stream = (name) => ({
    write: (s) => {
      events.push([name, s])
      return true
    },
  })
  return {
    events,
    stdout: stream('out'),
    stderr: stream('err'),
    out: () => events.filter(([n]) => n === 'out').map(([, s]) => s).join(''),
    err: () => events.filter(([n]) => n === 'err').map(([, s]) => s).join(''),
    outLines: () => {
      const text = events.filter(([n]) => n === 'out').map(([, s]) => s).join('')
      return text === '' ? [] : text.split('\n').slice(0, -1)
    },
    errLines: () => {
      const text = events.filter(([n]) => n === 'err').map(([, s]) => s).join('')
      return text === '' ? [] : text.split('\n').slice(0, -1)
    },
  }
}

const bag = (result, overrides = {}) => {
  const sinks = makeSinks()
  const calls = []
  return {
    cwd: '/repo',
    env: {},
    stdout: sinks.stdout,
    stderr: sinks.stderr,
    run: async (b) => {
      calls.push(b)
      return typeof result === 'function' ? result(b) : result
    },
    sinks,
    calls,
    ...overrides,
  }
}

const OK = {
  status: 'ok',
  narrative: NARRATIVE,
  diagnostic: null,
  model: 'haiku',
  task: '#031',
  now: Date.parse('2026-08-26T04:40:12Z'),
}

describe('QA: digestCommand — a digest that printed but could not be recorded (#61)', () => {
  it('puts the prose on stdout AND the append failure on stderr, still exit 0, still ok', async () => {
    // The engine's contract: the append failing costs the ENTRY, never the narrative.
    // The reader asked what the run is doing and we know, so both facts are owed.
    const d = bag({
      ...OK,
      diagnostic: 'ralph digest: printed, but could not append to /repo/.ralph/digest.log (EACCES: permission denied)',
    })
    const result = await digestCommand(d)

    expect(result).toEqual({ exitCode: 0, status: 'ok' })
    expect(d.sinks.outLines().slice(1).join('\n')).toBe(NARRATIVE)
    expect(d.sinks.errLines()).toHaveLength(1)
    expect(d.sinks.err()).toContain('EACCES')
    // ...and the caveat is NOT on stdout, where a pipe would collect it as prose.
    expect(d.sinks.out()).not.toContain('EACCES')
  })

  it('writes the whole narrative before it writes the caveat about it', async () => {
    const d = bag({ ...OK, diagnostic: 'ralph digest: could not append' })
    await digestCommand(d)
    const channels = d.sinks.events.map(([n]) => n)
    expect(channels.lastIndexOf('out'), 'the caveat was interleaved into the prose').toBeLessThan(
      channels.indexOf('err'),
    )
  })

  it('says nothing twice: exactly one heading and no duplicate diagnostic', async () => {
    const d = bag({ ...OK, diagnostic: 'ralph digest: could not append' })
    await digestCommand(d)
    expect(d.sinks.outLines().filter((l) => l.startsWith('── '))).toHaveLength(1)
    expect(d.sinks.errLines()).toHaveLength(1)
  })
})

describe('QA: digestCommand — the one-line promise about stderr (#61)', () => {
  it('collapses a multi-line engine diagnostic to a single line', async () => {
    // A launchd/cron log collects stderr line by line, so a diagnostic that is
    // three lines is three unattributable fragments in tomorrow's scrollback.
    const d = bag({
      status: 'failed',
      narrative: null,
      diagnostic: 'ralph digest: claude failed (Traceback:\n  frame one\n  frame two\n)',
    })
    await digestCommand(d)
    expect(d.sinks.errLines()).toHaveLength(1)
    expect(d.sinks.err()).toContain('frame one')
    expect(d.sinks.err().endsWith('\n')).toBe(true)
  })

  it('caps an over-long engine diagnostic instead of pasting it whole', async () => {
    const d = bag({
      status: 'failed',
      narrative: null,
      diagnostic: 'ralph digest: ' + 'z'.repeat(9000),
    })
    await digestCommand(d)
    expect(d.sinks.errLines()).toHaveLength(1)
    expect(d.sinks.err().length, 'the shell pasted an unbounded diagnostic').toBeLessThan(300)
  })

  it('collapses the message of a thrown error the same way', async () => {
    const d = bag(() => {
      throw new Error('line one\nline two\n' + 'y'.repeat(5000))
    })
    const result = await digestCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.sinks.errLines()).toHaveLength(1)
    expect(d.sinks.err().length).toBeLessThan(400)
  })
})

describe('QA: digestCommand — the engine may write to stderr but never to stdout (#61)', () => {
  it('forwards stderr into the engine bag and withholds stdout', async () => {
    // The engine's interpolate warnings and its own diagnostics go to the stream the
    // shell was given, and the narrative channel stays the shell's alone.
    const d = bag(OK)
    await digestCommand(d)
    expect(d.calls).toHaveLength(1)
    expect(d.calls[0].stderr, 'the engine cannot warn about anything').toBe(d.stderr)
    expect(d.calls[0].stdout, 'the engine was handed the narrative channel').toBeUndefined()
  })

  it('forwards every extra engine seam it was given, unaltered', async () => {
    // The shell is a router: a caller injecting exec/readFile/now/timeout for a test or
    // a future flag must reach the engine, or the shell has quietly become a second
    // place where the engine's defaults are decided.
    const seams = {
      exec: () => {},
      readFile: () => '',
      readTemplate: () => '',
      appendFile: () => {},
      mkdir: () => {},
      collect: async () => ({}),
      now: () => 0,
      timeout: 1234,
    }
    const d = bag(OK, seams)
    await digestCommand(d)
    for (const [key, value] of Object.entries(seams)) {
      expect(d.calls[0][key], `${key} did not reach the engine`).toBe(value)
    }
    expect(d.calls[0].cwd).toBe('/repo')
    expect(d.calls[0].env).toEqual({})
  })

  it('does not hand the engine its own `run`, which would recurse', async () => {
    const d = bag(OK)
    await digestCommand(d)
    expect(d.calls[0].run).toBeUndefined()
  })
})

describe('QA: digestCommand — a result of any shape still exits 0 and says one thing (#61)', () => {
  const hostile = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'narrative'],
    ['a number', 7],
    ['an array', []],
    ['an empty object', {}],
  ]

  it.each(hostile)('%s: exit 0, one line on stderr, nothing on stdout', async (_label, result) => {
    const d = bag(result)
    const out = await digestCommand(d)
    expect(out.exitCode).toBe(0)
    expect(d.sinks.errLines(), 'silence, or more than one explanation').toHaveLength(1)
    expect(d.sinks.out()).toBe('')
  })

  it('passes an unrecognized status through rather than rewriting it', async () => {
    // The status is the shell's answer to its caller (and, later, to a script). It has
    // to be reported, not normalized into one of three known values.
    for (const status of ['degraded', '', 0, null, undefined]) {
      const d = bag({ status, narrative: null, diagnostic: 'ralph digest: something' })
      const out = await digestCommand(d)
      expect(out.exitCode, String(status)).toBe(0)
      expect(out.status, String(status)).toBe(status ?? 'failed')
    }
  })
})

describe('QA: digestCommand — a rejection of any shape (#61)', () => {
  const throwers = [
    ['a string', () => { throw 'just a string' }],
    ['a null', () => { throw null }],
    ['an undefined', () => { throw undefined }],
    ['an Error with no message', () => { throw new Error() }],
    ['a plain object', () => { throw { code: 'EWEIRD' } }],
    ['a rejected promise', () => Promise.reject(new Error('async boom'))],
    ['a DigestAbort', () => { throw new DigestAbort('hard failure', 7) }],
  ]

  it.each(throwers)('%s: exit 0, one line, no stack trace', async (_label, run) => {
    const d = bag(undefined, { run })
    const result = await digestCommand(d)

    expect(result.exitCode, 'a digest failure became a command failure').toBe(0)
    expect(result.status).toBe('failed')
    expect(d.sinks.out()).toBe('')
    expect(d.sinks.errLines()).toHaveLength(1)
    expect(d.sinks.err()).toMatch(/^ralph digest: /)
    // No frames, no file paths, no `at Module.` — a reader's terminal at 4am wants
    // news about their run, not about Ralph's internals.
    expect(d.sinks.err()).not.toMatch(/\bat \S+:\d+/)
    expect(d.sinks.err()).not.toContain('.js:')
  })

  it('a DigestAbort’s exit code is deliberately discarded — the command cannot fail', async () => {
    // Documenting the current design rather than asserting a wish: DigestAbort exists
    // for symmetry with the other command blocks and has no throw site, and the shell's
    // catch-all means bin/ralph.js's `instanceof DigestAbort` branch is unreachable
    // today. If a digest is ever allowed to fail hard, this test is the one to change.
    const d = bag(undefined, {
      run: () => {
        throw new DigestAbort('boom', 3)
      },
    })
    expect((await digestCommand(d)).exitCode).toBe(0)
  })
})

describe('QA: digestCommand — stdout stays a clean prose pipe (#61)', () => {
  it('emits only whole newline-terminated lines, so `while read` sees every one', async () => {
    const d = bag(OK)
    await digestCommand(d)
    for (const [, chunk] of d.sinks.events) {
      expect(chunk.endsWith('\n'), JSON.stringify(chunk)).toBe(true)
      expect(chunk.slice(0, -1).includes('\n'), JSON.stringify(chunk)).toBe(false)
    }
  })

  it('emits no ANSI escapes, so a redirected digest is plain text', async () => {
    const d = bag({ ...OK, task: '#031', model: 'haiku' })
    await digestCommand(d)
    expect(d.sinks.out()).not.toMatch(new RegExp(String.fromCharCode(27)))
  })

  it('a narrative with CRLF line endings is not double-spaced on the way out', async () => {
    const d = bag({ ...OK, narrative: 'first line.\r\nsecond line.' })
    await digestCommand(d)
    const body = d.sinks.out().split('\n').slice(1, -1)
    expect(body).toHaveLength(2)
    expect(body[1]).toBe('second line.')
  })
})

// ---------------------------------------------------------------------------
// AC#10 — the registration, from the real binary. `--help` only: nothing below
// resolves a run or spawns a model.
// ---------------------------------------------------------------------------

const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))
const cli = (...argv) => execa('node', [BIN, ...argv], { reject: false })

describe('QA: ralph digest — what the --help text has to tell a reader (#61)', () => {
  it('names the history file, so a reader knows a digest is kept', async () => {
    // AC#1 and AC#7 are half of what this command does; a description that only
    // mentions the printing leaves the appended file undiscoverable.
    const { stdout } = await cli('digest', '--help')
    expect(stdout).toMatch(/\.ralph\/digest\.log/)
  })

  it('the top-level listing carries the same one-line description', async () => {
    const { stdout } = await cli('--help')
    const line = stdout.split('\n').find((l) => /^\s+digest\b/.test(l))
    expect(line, 'digest is not listed in `ralph --help`').toBeTruthy()
    expect(line.replace(/^\s+digest\s+/, '').trim(), 'listed with no description').not.toBe('')
  })

  it('sits next to `status`, the command it complements', async () => {
    // Ordering is the only affordance a reader gets that these two answer the same
    // question at different resolutions.
    const { stdout } = await cli('--help')
    const names = stdout
      .split('\n')
      .map((l) => l.match(/^\s{2}([a-z][a-z-]*)\b/))
      .filter(Boolean)
      .map((m) => m[1])
    expect(names.indexOf('digest')).toBe(names.indexOf('status') + 1)
  })

  it('declares no options of its own, so there is one way to run it', async () => {
    // AC#1 is "runs once". An option here would be a mode, and a mode would need its
    // own acceptance criteria.
    const { stdout } = await cli('digest', '--help')
    const options = stdout.slice(stdout.indexOf('Options:'))
    const declared = options
      .split('\n')
      .map((l) => l.match(/^\s{2}(-[^\s,]+)/))
      .filter(Boolean)
      .map((m) => m[1])
    expect(declared).toEqual(['-h'])
  })

  it('rejects an unknown option instead of silently narrating anyway', async () => {
    const { stdout, stderr, exitCode } = await cli('digest', '--json')
    expect(exitCode, 'an unknown option produced a digest').not.toBe(0)
    expect(stderr).toContain("unknown option '--json'")
    expect(stdout).toBe('')
  })
})
