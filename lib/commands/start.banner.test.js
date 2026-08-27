// #67 — the sprite, wired into `ralph start` as its FIRST output.
//
// Two claims, and the second one is the load-bearing half:
//
//   1. On a colour-capable TTY the command writes one static frame before it does
//      anything else — above the tmux uniqueness check, above the config read,
//      above every preflight line. "First" is asserted as an ORDER against the
//      other side effects, not just as a prefix of stdout, because a banner printed
//      after the tmux guard would still be the first line of a successful run and
//      the last thing a reader sees on a failed one.
//   2. Everywhere else — a pipe, a file, a CI log, NO_COLOR — `ralph start` is
//      byte-for-byte the command it was before this issue. That is asserted by
//      running the SAME deps twice and subtracting: the TTY run must equal the
//      banner plus the non-TTY run, with nothing else moved, added or reworded.
//
// Both capabilities are INJECTED (#41). The suite therefore says nothing about the
// terminal it happens to run in: `stdoutIsTTY` is a boolean here and NO_COLOR is a
// key in an injected bag, never a variable in the developer's shell.

import { describe, it, expect } from 'vitest'
import { StartAbort, startCommand } from './start.js'
import { renderStaticBanner } from '../sprite-banner.js'
import { sessionNameFor } from '../lock.js'

const ESC = '\u001B'
const REPO = '/repo'
const HOME = '/home/me'
const SESSION = sessionNameFor(REPO)

// The 17 rows a colour-capable terminal must receive, from the same pure function
// the command calls — the pixels themselves are lib/sprite-banner.test.js's
// business, and duplicating them here would pin the placeholder art into a wiring
// spec.
const BANNER = renderStaticBanner({ isTTY: true, color: true })

// Every side effect the command has, in the order it has them: stdout writes, the
// config read, and each exec. One array, so "the banner came first" is a statement
// about the whole run rather than about one stream.
function makeTimeline() {
  const events = []
  return {
    events,
    record: (kind, detail = '') => events.push({ kind, detail }),
    firstOther: () => events.findIndex((event) => event.kind !== 'write'),
    writes: () => events.filter((event) => event.kind === 'write').map((event) => event.detail),
  }
}

function makeStream(timeline, { isTTY, kind = 'write' } = {}) {
  const chunks = []
  const stream = {
    write: (s) => {
      chunks.push(s)
      timeline?.record(kind, s.replace(/\n$/, ''))
      return true
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
  // Only ever SET when a test asks for it: `Boolean(undefined)` is what a piped
  // stdout answers, and that is the default every other start spec runs under.
  if (isTTY !== undefined) stream.isTTY = isTTY
  return stream
}

// Driven through the folder source so the queue depth is a dependency rather than a
// `gh` stub — the banner is source-independent.
const deps = ({
  isTTY,
  queue = 3,
  sessionExists = false,
  config = 'TASK_SOURCE=folder\n',
  timeline = makeTimeline(),
  ...overrides
} = {}) => {
  const stdout = makeStream(timeline, { isTTY })
  const stderr = makeStream(timeline, { kind: 'stderr' })
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    timeline.record('exec', key)
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return {
    cwd: REPO,
    stdout,
    stderr,
    timeline,
    exec,
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => {
      timeline.record('readFile', String(p))
      return String(p).endsWith('ralph.config.sh') ? config : ''
    },
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    update: async () => ({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'disabled',
      updatedCache: null,
    }),
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => queue,
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

// The command's output with the banner sliced off the front, so a suppressed run
// can be compared against an enabled one line for line.
const withoutBanner = (output) => output.split('\n').slice(BANNER.length).join('\n')

describe('startCommand — the sprite banner (#67)', () => {
  it('writes the static frame as the first 17 lines on a colour-capable TTY', async () => {
    const d = deps({ isTTY: true })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(d.stdout.lines().slice(0, BANNER.length)).toEqual(BANNER)
    expect(BANNER).toHaveLength(17)
  })

  it('writes it before the config read and before the tmux uniqueness check', async () => {
    const d = deps({ isTTY: true })
    await startCommand(d)
    // The first thing that is not a stdout write is event 17: seventeen banner rows,
    // then the preflight the command always did.
    expect(d.timeline.firstOther()).toBe(BANNER.length)
    expect(d.timeline.writes().slice(0, BANNER.length)).toEqual(BANNER)
    const first = d.timeline.events[BANNER.length]
    expect(first.kind).toBe('readFile')
    const firstExec = d.timeline.events.find((event) => event.kind === 'exec')
    expect(firstExec.detail).toBe(`tmux has-session -t ${SESSION}`)
  })

  it('writes it above the tmux-session-taken error, and still exits 1', async () => {
    // The abort path matters most: this is the run where the banner is the ONLY
    // thing above the failure, so it must not have been skipped by an early return.
    const d = deps({ isTTY: true, sessionExists: true })
    await expect(startCommand(d)).rejects.toThrow(StartAbort)
    await expect(startCommand(deps({ isTTY: true, sessionExists: true }))).rejects.toMatchObject({
      exitCode: 1,
    })
    expect(d.stdout.lines().slice(0, BANNER.length)).toEqual(BANNER)
    expect(d.stderr.output()).toContain(`❌ tmux session '${SESSION}' already exists.`)
  })

  it('sends the banner to stdout only — stderr is untouched by it', async () => {
    const d = deps({ isTTY: true })
    await startCommand(d)
    expect(d.stderr.output()).toBe('')
  })

  it('writes nothing at all when stdout is not a TTY', async () => {
    const d = deps()
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(d.stdout.output()).not.toContain(ESC)
    expect(d.stdout.output()).not.toContain('▀')
    expect(d.stdout.output()).not.toContain('▄')
  })

  it('leaves the existing output byte-for-byte unchanged when suppressed', async () => {
    // The subtraction: one run with the banner, one without, identical deps. The
    // enabled run must be the suppressed run with 17 rows prepended and nothing
    // else different — no blank line, no reordering, no reworded label.
    const piped = deps()
    const tty = deps({ isTTY: true })
    await startCommand(piped)
    await startCommand(tty)
    expect(withoutBanner(tty.stdout.output())).toBe(piped.stdout.output())
    expect(tty.stdout.output()).toBe(`${BANNER.join('\n')}\n${piped.stdout.output()}`)
    expect(tty.stderr.output()).toBe(piped.stderr.output())
  })

  it('honors NO_COLOR from the injected environment, whatever its value', async () => {
    for (const value of ['1', 'false', '']) {
      const d = deps({ isTTY: true, processEnv: { NO_COLOR: value } })
      const plain = deps()
      await startCommand(d)
      await startCommand(plain)
      expect(d.stdout.output(), JSON.stringify(value)).toBe(plain.stdout.output())
      expect(d.stdout.output()).not.toContain(ESC)
    }
  })

  it('takes the capabilities as injected options, not from the ambient terminal', async () => {
    // Explicit beats derived, in BOTH directions: a TTY stdout with the option off
    // prints nothing, and a piped stdout with both options on prints the frame. No
    // assertion in this file can therefore be changed by the terminal it runs in.
    const forcedOff = deps({ isTTY: true, stdoutIsTTY: false })
    await startCommand(forcedOff)
    expect(forcedOff.stdout.output()).not.toContain(ESC)

    const forcedOn = deps({ stdoutIsTTY: true, color: true })
    await startCommand(forcedOn)
    expect(forcedOn.stdout.lines().slice(0, BANNER.length)).toEqual(BANNER)
  })

  it('does not reuse the stdin-facing isTTY option', async () => {
    // #25's `isTTY` is about STDIN and gates the update prompt's readline. A run
    // that is interactive on stdin but piped on stdout must print no sprite.
    const d = deps({ isTTY: undefined, stdin: { isTTY: true } })
    await startCommand(d)
    expect(d.stdout.output()).not.toContain(ESC)
  })

  it('changes no exit code, banner or not', async () => {
    for (const isTTY of [undefined, true]) {
      expect(await startCommand(deps({ isTTY, queue: 3 }))).toEqual({
        exitCode: 0,
        started: true,
        count: 3,
      })
      expect(await startCommand(deps({ isTTY, queue: 0 }))).toEqual({
        exitCode: 0,
        started: false,
      })
      await expect(startCommand(deps({ isTTY, sessionExists: true }))).rejects.toMatchObject({
        exitCode: 1,
      })
    }
  })

  it('still prints the frame on the empty-queue early return', async () => {
    // The queue is checked long after the banner is written, so this is a
    // regression guard for a future edit that moves the banner down.
    const d = deps({ isTTY: true, queue: 0 })
    await startCommand(d)
    expect(d.stdout.lines().slice(0, BANNER.length)).toEqual(BANNER)
    expect(d.stdout.output()).toContain('ℹ️  No issues in the queue. Nothing to do.')
  })
})
