// #67 QA — the banner as a change to a command that has NINE ways out.
//
// start.banner.test.js proves the two headline claims on the happy path and on one
// abort. This file is the same two claims taken to every exit `startCommand` has,
// because "byte-for-byte unchanged" is a statement about the whole surface and the
// interesting runs are the ones that fail:
//
//   1. EVERY PATH, TWICE. Each of the twelve outcomes below — three flavours of
//      success, two early returns and six aborts — is run once with a piped stdout
//      and once with a TTY stdout, from the same dependency bag. The TTY run must be
//      the piped run with seventeen rows prepended and NOTHING else different: same
//      stderr, byte for byte, same exit code, same returned shape, same StartAbort
//      message. A banner that slipped below a guard, a line that moved, or an abort
//      that changed its status shows up as a diff on one row of that table.
//   2. THE PRE-#67 BYTES, SPELLED OUT. Two paths additionally pin their suppressed
//      output as a LITERAL, captured by running this same bag against a pre-#67
//      checkout of lib/commands/start.js. Subtracting one run from another proves
//      the two agree with each other; only a literal proves they agree with what
//      shipped.
//
// And the third thing this file exists for: the two capabilities are INDEPENDENT
// seams. `isTTY` is stdin and gates a blocking readline; `stdoutIsTTY` is stdout and
// gates escape sequences. A run can have either without the other, so both crossed
// combinations are exercised against a real prompt decision — one asks and draws
// nothing, the other draws and never asks.

import { describe, it, expect } from 'vitest'
import { StartAbort, startCommand } from './start.js'
import { renderStaticBanner } from '../sprite-banner.js'
import { sessionNameFor } from '../lock.js'

const ESC = '\u001B'
const REPO = '/repo'
const HOME = '/home/me'
const SESSION = sessionNameFor(REPO)

// The seventeen rows, from the pure function the command itself calls: the pixels are
// lib/sprite-banner.qa.test.js's business.
const BANNER = renderStaticBanner({ isTTY: true, color: true })
const BANNER_BLOCK = `${BANNER.join('\n')}\n`

// Every side effect in the order it happens — the writes plus the config read plus
// each exec — so "the banner came first" is a statement about the run and not about
// one stream.
function makeTimeline() {
  const events = []
  return {
    events,
    record: (kind, detail = '') => events.push({ kind, detail }),
    firstOther: () => events.findIndex((event) => event.kind !== 'write'),
  }
}

function makeStream(timeline, { isTTY, kind = 'write' } = {}) {
  const chunks = []
  const stream = {
    write: (s) => {
      chunks.push(s)
      timeline?.record(kind, s)
      return true
    },
    chunks,
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
  // Only ever SET when a test asks for it: `Boolean(undefined)` is what a piped
  // stdout answers, and that is what every other start spec runs under.
  if (isTTY !== undefined) stream.isTTY = isTTY
  return stream
}

const NO_UPDATE = {
  latestVersion: null,
  isNewer: false,
  shouldPrompt: false,
  source: 'disabled',
  updatedCache: null,
}

const NEWER_AND_ASKABLE = {
  latestVersion: '9.9.9',
  isNewer: true,
  shouldPrompt: true,
  source: 'registry',
  updatedCache: null,
}

// One bag, every path reachable from its options. `now` and `ralphBinary` are pinned
// so the two runs of a pair cannot differ on a clock or on how the process was
// spawned rather than on the banner.
function deps({
  isTTY,
  queue = 3,
  sessionExists = false,
  config = 'TASK_SOURCE=folder\n',
  files = ['ralph.config.sh'],
  hasCommand = () => true,
  peekLock = () => null,
  ghAuthOk = true,
  mcpOk = true,
  tmuxLaunchOk = true,
  update = async () => NO_UPDATE,
  runUpdate,
  orphans = '',
  ghQueue = '3',
  ...overrides
} = {}) {
  const timeline = makeTimeline()
  const stdout = makeStream(timeline, { isTTY })
  const stderr = makeStream(timeline, { kind: 'stderr' })
  const asked = []
  const exec = async (cmd, args) => {
    timeline.record('exec', `${cmd} ${args.join(' ')}`)
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    }
    if (cmd === 'tmux' && args[0] === 'new') {
      return tmuxLaunchOk
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'no server running\n' }
    }
    if (cmd === 'gh' && args[0] === 'auth') {
      return { exitCode: ghAuthOk ? 0 : 1, stdout: '', stderr: '' }
    }
    if (cmd === 'jq' && args[0] === '-e') return { exitCode: mcpOk ? 0 : 1, stdout: '', stderr: '' }
    if (cmd === 'jq') return { exitCode: 0, stdout: 'ctx, gh\n', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('claude-working')) {
      return { exitCode: 0, stdout: orphans, stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return { exitCode: 0, stdout: ghQueue, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const ask = async (question) => {
    asked.push(question)
    return false
  }
  ask.asked = asked
  return {
    cwd: REPO,
    stdout,
    stderr,
    timeline,
    exec,
    exists: (p) => files.some((f) => String(p).endsWith(f)),
    readFile: (p) => {
      timeline.record('readFile', String(p))
      return String(p).endsWith('ralph.config.sh') ? config : ''
    },
    loadEnv: () => ({}),
    hasCommand,
    ask,
    currentVersion: '1.2.3',
    update,
    runUpdate,
    // #26's stamp writes through the global cache; injected away so no run here
    // touches a real (or sandboxed) file.
    recordPrompt: () => {},
    sendWa: async () => ({ ok: true }),
    peekLock,
    folderQueueCount: async () => queue,
    now: () => 1_700_000_000_000,
    home: HOME,
    processEnv: {},
    ralphBinary: '/usr/local/bin/ralph',
    ...overrides,
  }
}

// Run the command and describe how it left, in a shape two runs can be compared on.
async function outcomeOf(d) {
  try {
    return { returned: await startCommand(d) }
  } catch (error) {
    return {
      abort: error instanceof StartAbort,
      name: error.constructor.name,
      message: error.message,
      exitCode: error.exitCode,
    }
  }
}

// The twelve ways out of `startCommand`, each named by what it is: a preflight abort,
// an early return or a launch.
const PATHS = {
  'folder launch': {},
  'folder launch with a digest window': {
    config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n',
  },
  'github launch with orphans and an .mcp.json': {
    config: '',
    files: ['ralph.config.sh', '.mcp.json'],
    orphans: '  #12 first\n  #34 second',
    ghQueue: '7',
  },
  'empty queue early return': { queue: 0 },
  'tmux session already exists': { sessionExists: true },
  'cycle lock held': {
    peekLock: () => ({ alive: true, holder: { pid: 4242, startedAt: '2023-11-14T00:00:00Z' } }),
  },
  'missing critical dependency': { hasCommand: (name) => name !== 'gh' },
  'gh not authenticated': { config: '', ghAuthOk: false },
  'invalid .mcp.json': { files: ['ralph.config.sh', '.mcp.json'], mcpOk: false },
  'tmux launch failed': { tmuxLaunchOk: false },
  'update installed early return': {
    update: async () => NEWER_AND_ASKABLE,
    runUpdate: async () => ({ updated: true, to: '9.9.9' }),
    stdin: { isTTY: true },
    ask: async () => true,
  },
  'update accepted but not installed': {
    update: async () => NEWER_AND_ASKABLE,
    runUpdate: async () => ({ updated: false, to: '9.9.9' }),
    stdin: { isTTY: true },
    ask: async () => true,
  },
}

describe('QA startCommand banner — every exit path, piped and on a TTY (#67)', () => {
  for (const [name, options] of Object.entries(PATHS)) {
    it(`leaves the ${name} path byte-identical, banner aside`, async () => {
      const piped = deps(options)
      const tty = deps({ ...options, isTTY: true })
      const pipedOutcome = await outcomeOf(piped)
      const ttyOutcome = await outcomeOf(tty)

      // The subtraction, on this path: the TTY run is the piped run with seventeen
      // rows in front of it and not one byte else moved.
      expect(tty.stdout.output()).toBe(BANNER_BLOCK + piped.stdout.output())
      expect(tty.stderr.output()).toBe(piped.stderr.output())
      // ...and the piped run carries no trace of the sprite at all: no escape, no
      // glyph, not even a blank line, which is what an `out('')` would have left.
      expect(piped.stdout.output()).not.toContain(ESC)
      expect(piped.stdout.output()).not.toMatch(/[▀▄]/)
      expect(piped.stdout.output()).not.toMatch(/^\n/)
      // The banner is on stdout, never on the stream a script reads errors from.
      expect(tty.stderr.output()).not.toContain(ESC)

      // Exit code, returned shape and abort identity are the command's answer about
      // the run, and the banner is not allowed an opinion on any of them.
      expect(ttyOutcome).toEqual(pipedOutcome)
    })
  }

  it('puts the frame above the error on every aborting path', async () => {
    // The runs where the banner is the ONLY thing above the failure. A banner printed
    // after any guard would be missing from exactly these.
    const aborts = [
      'tmux session already exists',
      'cycle lock held',
      'missing critical dependency',
      'gh not authenticated',
      'invalid .mcp.json',
      'tmux launch failed',
    ]
    for (const name of aborts) {
      const d = deps({ ...PATHS[name], isTTY: true })
      const outcome = await outcomeOf(d)
      expect(outcome.abort, name).toBe(true)
      expect(outcome.exitCode, name).toBe(1)
      expect(d.stdout.lines().slice(0, BANNER.length), name).toEqual(BANNER)
      expect(d.stderr.output(), name).not.toBe('')
      // Written before the guard that aborted, not merely present: the first event
      // that is not a stdout write is event 17 on every one of these.
      expect(d.timeline.firstOther(), name).toBe(BANNER.length)
    }
  })

  it('writes one line per row, each with its own trailing newline', async () => {
    // Seventeen `out()` calls, not one joined blob and not a chunk that forgets the
    // last newline — which would glue the sprite's bottom row to the first preflight
    // line.
    const d = deps({ isTTY: true })
    await startCommand(d)
    const banner = d.stdout.chunks.slice(0, BANNER.length)
    expect(banner).toEqual(BANNER.map((line) => `${line}\n`))
    for (const chunk of banner) {
      expect(chunk.endsWith('\n')).toBe(true)
      expect(chunk.split('\n')).toHaveLength(2)
    }
  })
})

describe('QA startCommand banner — the pre-#67 bytes, spelled out (#67)', () => {
  // Captured by running this file's dependency bag against lib/commands/start.js as
  // of the commit before #67. Subtracting a TTY run from a piped run proves the two
  // agree; these literals are what proves the piped run agrees with what SHIPPED.
  it('reproduces the launch output exactly, and prepends only the banner to it', async () => {
    const expected =
      'ℹ️  CALLMEBOT_KEY/WHATSAPP_PHONE missing; WhatsApp notifications will be skipped.\n' +
      '✅ Ralph started in background. 3 issues in the queue.\n' +
      '   Progress:       ralph status\n' +
      `   Watch live:     tmux attach -t ${SESSION}\n` +
      '   Detach:         inside the session, Ctrl+B then D\n' +
      '   List:           tmux ls\n' +
      `   Kill:           tmux kill-session -t ${SESSION}\n` +
      '   Logs:           logs/ralph-issue-*.log\n'

    const piped = deps()
    expect(await outcomeOf(piped)).toEqual({ returned: { exitCode: 0, started: true, count: 3 } })
    expect(piped.stdout.output()).toBe(expected)
    expect(piped.stderr.output()).toBe('')

    const tty = deps({ isTTY: true })
    await startCommand(tty)
    expect(tty.stdout.output()).toBe(BANNER_BLOCK + expected)
  })

  it('reproduces the tmux-taken abort exactly, on both streams', async () => {
    const expectedOut =
      `   Watch:  tmux attach -t ${SESSION}\n` + `   Kill:   tmux kill-session -t ${SESSION}\n`
    const expectedErr = `❌ tmux session '${SESSION}' already exists.\n`

    const piped = deps({ sessionExists: true })
    expect(await outcomeOf(piped)).toEqual({
      abort: true,
      name: 'StartAbort',
      message: 'tmux session already exists',
      exitCode: 1,
    })
    expect(piped.stdout.output()).toBe(expectedOut)
    expect(piped.stderr.output()).toBe(expectedErr)

    const tty = deps({ sessionExists: true, isTTY: true })
    await expect(startCommand(tty)).rejects.toThrow(StartAbort)
    expect(tty.stdout.output()).toBe(BANNER_BLOCK + expectedOut)
    expect(tty.stderr.output()).toBe(expectedErr)
  })
})

describe('QA startCommand banner — stdout capability is not stdin capability (#67)', () => {
  it('asks the update question over a stdin TTY while writing no sprite to a piped stdout', async () => {
    // The launchd/CI shape inverted: interactive on stdin, redirected on stdout. The
    // prompt must still happen — it is gated on #25's `isTTY` — and not one escape
    // byte may reach the log file.
    const d = deps({
      stdin: { isTTY: true },
      update: async () => NEWER_AND_ASKABLE,
    })
    await outcomeOf(d)
    expect(d.ask.asked).toEqual(['Update now? [y/N]: '])
    expect(d.stdout.output()).not.toContain(ESC)
    expect(d.stdout.output()).toContain('New version available: 9.9.9')
  })

  it('draws the sprite on a stdout TTY while never asking over a piped stdin', async () => {
    // The other half: a terminal a user is watching, with stdin coming from a file or
    // a heredoc. `confirm` would never resolve there, so the question must not be put
    // — and the sprite must be, because stdout is a terminal.
    const d = deps({
      isTTY: true,
      stdin: { isTTY: false },
      update: async () => NEWER_AND_ASKABLE,
    })
    await outcomeOf(d)
    expect(d.ask.asked).toEqual([])
    expect(d.stdout.lines().slice(0, BANNER.length)).toEqual(BANNER)
    expect(d.stdout.output()).toContain('New version available: 9.9.9')
  })

  it('never lets the stdin option decide the sprite, in either direction', async () => {
    // #25's `isTTY` is an explicit option too, so the crossed pair is worth pinning
    // as options rather than only as streams.
    const stdinOnly = deps({ isTTY: undefined, stdin: { isTTY: true } })
    await startCommand(stdinOnly)
    expect(stdinOnly.stdout.output()).not.toContain(ESC)

    const stdoutOnly = deps({ isTTY: true })
    await startCommand(stdoutOnly)
    expect(stdoutOnly.stdout.lines().slice(0, BANNER.length)).toEqual(BANNER)
  })
})

describe('QA startCommand banner — the two capability options, resolved (#67)', () => {
  const bannerShown = (d) => d.stdout.output().startsWith(BANNER_BLOCK)

  it('lets an explicit color:true beat a NO_COLOR in the injected environment', async () => {
    // The escape hatch the module header claims exists instead of FORCE_COLOR: a
    // caller that has already decided is not overruled by the bag.
    const d = deps({ isTTY: true, processEnv: { NO_COLOR: '1' }, color: true })
    await startCommand(d)
    expect(bannerShown(d)).toBe(true)
  })

  it('lets an explicit color:false silence a clean TTY', async () => {
    const d = deps({ isTTY: true, color: false })
    await startCommand(d)
    expect(d.stdout.output()).not.toContain(ESC)
  })

  it('resolves an omitted color through colorEnabled, using the stdoutIsTTY it was given', async () => {
    // `stdoutIsTTY` is declared before `color` in the signature, so an explicitly
    // passed one is what the default expression sees. Proved on a PIPED stream, where
    // nothing but the option could have turned the sprite on.
    const forced = deps({ stdoutIsTTY: true })
    await startCommand(forced)
    expect(bannerShown(forced)).toBe(true)

    const suppressed = deps({ stdoutIsTTY: true, processEnv: { NO_COLOR: '' } })
    await startCommand(suppressed)
    expect(suppressed.stdout.output()).not.toContain(ESC)

    // ...including a NO_COLOR the bag inherits rather than owns.
    const inherited = deps({ stdoutIsTTY: true, processEnv: Object.create({ NO_COLOR: '1' }) })
    await startCommand(inherited)
    expect(inherited.stdout.output()).not.toContain(ESC)
  })

  it('falls back to the stream when stdoutIsTTY is passed as undefined', async () => {
    // A caller forwarding an optional value (`{ stdoutIsTTY: options.stdoutIsTTY }`)
    // must get the derivation, not silence: that is what a destructuring default is
    // for, and it is the difference between a forwarded bag and a decision.
    const d = deps({ isTTY: true, stdoutIsTTY: undefined })
    await startCommand(d)
    expect(bannerShown(d)).toBe(true)
  })

  it('reads the injected bag and not the ambient one', async () => {
    // #41: with NO_COLOR exported in the process, an injected clean bag still draws.
    // Mutating process.env here is the documented opt-in — the harness restores it.
    process.env.NO_COLOR = '1'
    const injected = deps({ isTTY: true, processEnv: {} })
    await startCommand(injected)
    expect(bannerShown(injected)).toBe(true)
  })

  it('honors the ambient bag when the caller supplies none, which is what the CLI does', async () => {
    // `bin/ralph.js` calls `startCommand({ currentVersion })` and nothing else, so
    // `processEnv` defaults to `process.env` — the only path on which a real user's
    // exported NO_COLOR reaches the gate. Asserted in both directions so this is a
    // statement about the variable and not about the sandbox.
    const clean = deps({ isTTY: true, processEnv: undefined })
    await startCommand(clean)
    expect(bannerShown(clean)).toBe(true)

    process.env.NO_COLOR = '1'
    const ambient = deps({ isTTY: true, processEnv: undefined })
    await startCommand(ambient)
    expect(ambient.stdout.output()).not.toContain(ESC)
  })
})
