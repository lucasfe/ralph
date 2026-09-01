import { describe, it, expect } from 'vitest'
import { startCommand, StartAbort } from './start.js'
import { sessionNameFor } from '../lock.js'

// #169 — the two places `ralph start` hands a reader a way to watch the loop now NAME
// `ralph live` (#167) first, and keep the `tmux attach -t <session>` command under it.
//
// Both halves are load-bearing and the issue says so:
//
//   1. THE SHORTCUT LEADS, because a command nobody is told about is a command nobody
//      runs, and these are the two moments a reader is looking for exactly it — one
//      after a launch, one after being refused a second launch.
//   2. THE RAW COMMAND STAYS, on its own continuation line. It is the escape hatch for
//      the run `ralph live` cannot resolve (a loop launched from another tree), and it
//      carries the SESSION NAME — which is how a reader with three concurrent loops
//      tells them apart. The name still appears in both surfaces, and this file asserts
//      that rather than the row's leading word alone.
//
// The continuation column is the surrounding block's, not a new one: 19 spaces in the
// launch box (`   Watch live:     `.length, the column #60's projection already
// continues at) and 11 in the abort (`   Watch:  `.length). Both are asserted as
// literals here, because alignment is the whole reason those widths are what they are.
//
// Hermetic like every other start suite: exec, fs, env, the update check and the clock
// are injected, and `RALPH_BANNER=off` keeps the identity box out of the bytes so a
// subtraction between two runs is a statement about these rows.

const REPO = '/repo'
const HOME = '/home/me'
const SESSION = sessionNameFor(REPO)

// The launch box's label field: a 3-space indent and a 16-wide label, so a value starts
// at column 20 and a continuation line is 19 spaces of padding (lib/progress.js:117).
const BOX_CONTINUATION = ' '.repeat('   Watch live:     '.length)
// The abort's narrower one — `   Watch:  ` is 11 characters wide.
const ABORT_CONTINUATION = ' '.repeat('   Watch:  '.length)

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

// `sessionExists` is the only knob these tests turn: it flips `tmux has-session` from
// "free" (the launch path) to "taken" (the abort path).
function makeExec({ sessionExists = false } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const CONFIG = 'TASK_SOURCE=folder\nRALPH_BANNER=off\n'

function baseDeps({ sessionExists = false, ...overrides } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: makeExec({ sessionExists }),
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? CONFIG : ''),
    folderQueueCount: async () => 3,
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
    readCache: () => ({ latest_version: null }),
    peekLock: () => null,
    now: () => new Date(2026, 7, 25, 16, 4, 0).getTime(),
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

describe('startCommand — the launch box names `ralph live` (#169)', () => {
  it('makes `ralph live` the Watch live value and puts the tmux command under it', async () => {
    const deps = baseDeps()
    const result = await startCommand(deps)
    expect(result.started).toBe(true)
    const lines = deps.stdout.lines()
    const watch = lines.indexOf('   Watch live:     ralph live')
    expect(watch, deps.stdout.output()).toBeGreaterThan(-1)
    expect(lines[watch + 1]).toBe(`${BOX_CONTINUATION}tmux attach -t ${SESSION}`)
  })

  it('keeps the rest of the tail in order, with the new line as the only insertion', async () => {
    // Pinned as a block: the five lines a user's muscle memory is built on are still
    // there, still in this order, and the continuation is the second line of the pair
    // rather than a row somewhere else in the box.
    const deps = baseDeps()
    await startCommand(deps)
    expect(deps.stdout.lines().slice(-6)).toEqual([
      '   Watch live:     ralph live',
      `${BOX_CONTINUATION}tmux attach -t ${SESSION}`,
      '   Detach:         inside the session, Ctrl+B then D',
      '   List:           tmux ls',
      `   Kill:           tmux kill-session -t ${SESSION}`,
      '   Logs:           logs/ralph-issue-*.log',
    ])
  })

  it('still shows the session name, so concurrent loops stay distinguishable', async () => {
    const deps = baseDeps()
    await startCommand(deps)
    expect(deps.stdout.output()).toContain(SESSION)
  })
})

describe('startCommand — the session-exists abort names `ralph live` (#169)', () => {
  it('offers `ralph live` first and the tmux commands under and after it', async () => {
    // The likeliest moment of all: the reader just asked for a loop and was told one is
    // already running. `ralph live` is the answer, and both tmux commands survive it.
    const deps = baseDeps({ sessionExists: true })
    await expect(startCommand(deps)).rejects.toThrow(StartAbort)
    expect(deps.stderr.output()).toBe(`❌ tmux session '${SESSION}' already exists.\n`)
    expect(deps.stdout.lines()).toEqual([
      '   Watch:  ralph live',
      `${ABORT_CONTINUATION}tmux attach -t ${SESSION}`,
      `   Kill:   tmux kill-session -t ${SESSION}`,
    ])
  })

  it('aborts before the loop is launched, exactly as it did before', async () => {
    // The rows are advice; the refusal is the behaviour. No `tmux new-session`, exit 1.
    const deps = baseDeps({ sessionExists: true })
    await expect(startCommand(deps)).rejects.toMatchObject({ exitCode: 1 })
    expect(deps.exec.calls.some((c) => c.cmd === 'tmux' && c.args[0] === 'new')).toBe(false)
  })
})
