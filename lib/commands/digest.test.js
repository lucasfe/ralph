import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { digestCommand, DigestAbort } from './digest.js'

// #61 — the CLI shell around the digest engine. Its whole job is routing: the
// narrative (and its heading) to stdout so `ralph digest` stays pipeable, every
// diagnostic to stderr, and exit 0 in EVERY case — an accessory that may never
// affect a run must never look like a broken command either.
//
// The engine itself is covered in lib/digest.test.js and against a real stub CLI in
// test/digest.stub-cli.test.js; here `run` is injected, so these assertions are
// about the shell and nothing else.

const NARRATIVE = '#031 is in the TDD red phase.\nMain is 8 commits ahead of origin/main.'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

const deps = (result, overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const calls = []
  return {
    cwd: '/repo',
    stdout,
    stderr,
    env: {},
    run: async (bag) => {
      calls.push(bag)
      if (typeof result === 'function') return result(bag)
      return result
    },
    calls,
    ...overrides,
  }
}

const okResult = {
  status: 'ok',
  narrative: NARRATIVE,
  diagnostic: null,
  model: 'haiku',
  task: '#031',
  now: Date.parse('2026-08-26T04:40:12Z'),
}

describe('digestCommand — a digest that landed (#61)', () => {
  it('prints the heading and the narrative on stdout, nothing on stderr, exit 0', async () => {
    const d = deps(okResult)
    const result = await digestCommand(d)

    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('ok')
    expect(d.stderr.output()).toBe('')
    const lines = d.stdout.lines()
    expect(lines[0]).toContain('digest')
    expect(lines[0]).toContain('#031')
    expect(lines[0]).toContain('haiku')
    expect(lines.slice(1).join('\n')).toBe(NARRATIVE)
  })

  it('newline-terminates its output, so the shell prompt is not left mid-line', async () => {
    const d = deps(okResult)
    await digestCommand(d)
    expect(d.stdout.output().endsWith('\n')).toBe(true)
  })

  it('forwards the cwd and the env it was given to the engine', async () => {
    const d = deps(okResult, { cwd: '/elsewhere', env: { RALPH_DIGEST_MODEL: 'sonnet' } })
    await digestCommand(d)
    expect(d.calls).toHaveLength(1)
    expect(d.calls[0].cwd).toBe('/elsewhere')
    expect(d.calls[0].env).toEqual({ RALPH_DIGEST_MODEL: 'sonnet' })
  })
})

describe('digestCommand — every failure exits 0 with one line on stderr (#61)', () => {
  const failing = [
    ['a failed agent', { status: 'failed', narrative: null, diagnostic: 'ralph digest: the agent exited 1' }],
    ['a timeout', { status: 'failed', narrative: null, diagnostic: 'ralph digest: the agent timed out after 90s' }],
    ['no run at all', { status: 'no-run', narrative: null, diagnostic: 'ralph digest: no run recorded yet' }],
  ]

  it.each(failing)('%s: stdout stays empty and the exit code stays 0', async (_label, engineResult) => {
    const d = deps(engineResult)
    const result = await digestCommand(d)

    expect(result.exitCode).toBe(0)
    // stdout is the narrative channel and nothing else: `ralph digest > notes.md`
    // must never collect a line of prose that is not a digest.
    expect(d.stdout.output()).toBe('')
    expect(d.stderr.lines()).toHaveLength(1)
    expect(d.stderr.output()).toBe(engineResult.diagnostic + '\n')
  })

  it('an engine that throws is still exit 0 with a diagnostic, not a stack trace', async () => {
    const d = deps(() => {
      throw new Error('unexpected')
    })
    const result = await digestCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.stdout.output()).toBe('')
    expect(d.stderr.lines()).toHaveLength(1)
    expect(d.stderr.output()).toMatch(/digest/i)
    expect(d.stderr.output()).not.toContain('at ')
  })

  it('a diagnostic-less failure still says something, once', async () => {
    const d = deps({ status: 'failed', narrative: null, diagnostic: null })
    await digestCommand(d)
    expect(d.stderr.lines()).toHaveLength(1)
  })
})

describe('DigestAbort — wiring symmetry with the other command blocks (#61)', () => {
  it('is an Error carrying an exit code', () => {
    const e = new DigestAbort('boom', 2)
    expect(e).toBeInstanceOf(Error)
    expect(e.exitCode).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// CLI registration (AC#10). bin/ralph.js parses argv on import and bin/ is outside
// vitest's include globs, so the wiring is asserted from real `--help` invocations,
// the way status.json.test.js and status.help.test.js already do.
// ---------------------------------------------------------------------------

const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))
const cli = (...argv) => execa('node', [BIN, ...argv], { reject: false })

describe('ralph digest — registered in the CLI with a --help description (#61)', () => {
  it('`ralph digest --help` exits 0 and describes the command', async () => {
    const result = await cli('digest', '--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage: ralph digest')
    const lines = result.stdout.split('\n')
    const start = lines.findIndex((l) => l.startsWith('Usage:')) + 1
    const end = lines.findIndex((l) => l.startsWith('Options:'))
    const description = lines
      .slice(start, end === -1 ? undefined : end)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    expect(description, 'ralph digest has no --help description').not.toBe('')
    // It has to say what the command DOES, in the vocabulary of the issue.
    expect(description.toLowerCase()).toMatch(/narrat|prose|sentence|summar/)
    expect(result.stderr).toBe('')
  })

  it('lists digest at the top level', async () => {
    const result = await cli('--help')
    expect(result.stdout).toMatch(/^\s+digest\b/m)
  })

  it('does not run the command it documents', async () => {
    // `--help` must not resolve a git root, count a queue or spawn a model.
    const result = await cli('digest', '--help')
    expect(result.stdout).not.toContain('── digest')
  })
})
