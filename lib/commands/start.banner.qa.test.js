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
// #68 leaves both claims intact and sharpens the first one. The banner now has two
// halves with different rules: the SPRITE is TTY-and-colour gated, so it is what the
// subtraction removes; the identity BOX is text and prints on every run, so it appears
// on both sides and cancels. That is why the twelve rows below needed no new
// expectations — only the two literals grew by three lines, and `firstOther()` by three
// events, because the box is written above the preflight too.
//
// And the third thing this file exists for: the two capabilities are INDEPENDENT
// seams. `isTTY` is stdin and gates a blocking readline; `stdoutIsTTY` is stdout and
// gates escape sequences. A run can have either without the other, so both crossed
// combinations are exercised against a real prompt decision — one asks and draws
// nothing, the other draws and never asks.

import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { StartAbort, startCommand } from './start.js'
import { renderStaticBanner } from '../sprite-banner.js'
// #68: the box's two collaborators, imported so this file's expectations are derived
// from the RULES the command obeys rather than from a second reading of them — the
// opt-out predicate #24 owns, and the XDG cache path #24 writes.
import { isUpdateCheckDisabled } from '../update-check.js'
import { versionCachePath } from '../version-cache.js'
import { sessionNameFor } from '../lock.js'

const ESC = '\u001B'
// The sprite's own signature — the only escape a `pc`-colouring path may claim is absent.
//
// "No ANSI anywhere in stdout" is NOT a claim `ralph start` can keep, and asserting it
// is why this file passed locally and failed on CI. `pc.yellow` colours the
// update-available notice, and picocolors decides ONCE AT IMPORT from the real
// `process.env` — which no injected bag can reach — turning colour on whenever `CI` is
// set. Those lines are therefore plain on a developer's piped run and coloured on
// GitHub Actions, through no fault of the banner.
//
// 24-bit truecolor is the discriminator: lib/sprite-render.js emits `38;2;`/`48;2;`
// per cell, and picocolors only ever emits the basic 16-colour codes (`[33m`, `[0m`).
// So these match the sprite and nothing else, on either machine. Byte-identity
// (`tty === BANNER_BLOCK + piped`) remains the real guarantee; this is the belt.
const SPRITE_FG = `${ESC}[38;2;`
const SPRITE_BG = `${ESC}[48;2;`

/** Assert an output carries no trace of the sprite, whatever else coloured itself. */
function expectNoSprite(output) {
  expect(output).not.toContain(SPRITE_FG)
  expect(output).not.toContain(SPRITE_BG)
  expect(output).not.toMatch(/[▀▄]/)
}

const REPO = '/repo'
const HOME = '/home/me'
const SESSION = sessionNameFor(REPO)
// #68: where the box reads its update hint from, resolved the way #24 resolves it so a
// path change cannot make these assertions pass against the wrong file.
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })

// The seventeen rows, from the pure function the command itself calls: the pixels are
// lib/sprite-banner.qa.test.js's business.
const BANNER = renderStaticBanner({ isTTY: true, color: true })
const BANNER_BLOCK = `${BANNER.join('\n')}\n`

// #68's identity box, SPELLED OUT rather than composed — the one file where that is the
// right call, because this is the file whose job is the command's actual bytes. Three
// lines here: this bag's `currentVersion`, its `cwd`, and no update row, since every
// run below reads an empty cache (see `readCache` in deps). The streams carry no
// `columns`, so the box is drawn at its 60-column default.
//
// It is NOT part of BANNER_BLOCK, and that is the point of the subtraction below: the
// sprite is what a piped run loses, the box is what both runs keep.
const BOX = [
  `╭─ ralph 1.2.3 ${'─'.repeat(44)}╮`,
  `│ cwd     /repo${' '.repeat(43)} │`,
  `╰${'─'.repeat(58)}╯`,
]
const BOX_BLOCK = `${BOX.join('\n')}\n`

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
    // #68: and the box's READ of that same cache, injected for the same reason — plus
    // one this file cares about especially. The twelve paths below compare bytes; a
    // developer whose real cache happens to hold a newer version would otherwise get a
    // fourth row in the box and a diff that has nothing to do with the code (#41).
    readCache: () => ({ latest_version: null }),
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
      // ...and the piped run carries no trace of the sprite at all: no truecolor
      // escape, no glyph, not even a blank line, which is what an `out('')` would have
      // left. Sprite-specific rather than ESC-wide because some of these paths print a
      // `pc`-coloured notice whose colour is ambient — see SPRITE_FG above.
      expectNoSprite(piped.stdout.output())
      expect(piped.stdout.output()).not.toMatch(/^\n/)
      // The banner is on stdout, never on the stream a script reads errors from.
      expectNoSprite(tty.stderr.output())

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
      expect(d.stdout.lines().slice(BANNER.length, BANNER.length + BOX.length), name).toEqual(BOX)
      expect(d.stderr.output(), name).not.toBe('')
      // Written before the guard that aborted, not merely present: the first event that
      // is not a stdout write is event 20 on every one of these — seventeen sprite rows
      // and #68's three box lines, then the preflight.
      expect(d.timeline.firstOther(), name).toBe(BANNER.length + BOX.length)
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
  //
  // #68 PREPENDS BOX_BLOCK to both, and the literals below are untouched — deliberately
  // so. The box is the one thing this issue adds to a piped run, and keeping the
  // pre-banner bytes spelled out separately is what makes that readable as "three lines
  // added, nothing else changed" rather than as a re-recorded expectation.
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
    expect(piped.stdout.output()).toBe(BOX_BLOCK + expected)
    expect(piped.stderr.output()).toBe('')

    const tty = deps({ isTTY: true })
    await startCommand(tty)
    expect(tty.stdout.output()).toBe(BANNER_BLOCK + BOX_BLOCK + expected)
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
    expect(piped.stdout.output()).toBe(BOX_BLOCK + expectedOut)
    expect(piped.stderr.output()).toBe(expectedErr)

    const tty = deps({ sessionExists: true, isTTY: true })
    await expect(startCommand(tty)).rejects.toThrow(StartAbort)
    expect(tty.stdout.output()).toBe(BANNER_BLOCK + BOX_BLOCK + expectedOut)
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
    // Sprite-specific: this path prints the `pc.yellow` update notice, whose colour is
    // decided by the ambient environment and is not the banner's doing.
    expectNoSprite(d.stdout.output())
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

// ---------------------------------------------------------------------------
// #68 QA — the identity BOX as a change to the same twelve-way command.
//
// start.banner.test.js proves the box's happy paths and #68's own additions above
// prove the TTY runs of every exit. What is left is the half of the claim the sprite
// never had to make, because the sprite is allowed to be absent:
//
//   1. THE PIPED RUNS. The box is the FIRST LINE of a launchd log, a `| tee`, a CI
//      transcript — on every one of the twelve ways out, including the six aborts,
//      where it is the only context the error has. The TTY assertions above cannot
//      see this: they slice from BANNER.length, so a box that had quietly become
//      TTY-gated would still pass them on the subtraction alone.
//   2. THE CACHE IS READ AND NOTHING ELSE. The box is printed before the first
//      preflight line of every run, so what it must NOT do is measurable: no write,
//      no mkdir, no `npm view`, no second read. The opt-out path must not even read.
//   3. THE SEAM SURVIVES ITS OWN ABUSE. `readCache` is an injected function, and a
//      caller (or a future refactor) can hand back anything. A banner is never worth
//      losing a run over, so every shape costs a HINT and never the run.
// ---------------------------------------------------------------------------

// The box with an update row, spelled out for the same reason BOX is: this file's job
// is the command's actual bytes. Twelve trailing spaces because the value is
// `9.9.9 available — run \`ralph update\`` — 36 columns after the eight-column label
// gutter, inside a 56-column content field.
const BOX_WITH_HINT = [
  BOX[0],
  `│ update  9.9.9 available — run \`ralph update\`${' '.repeat(12)} │`,
  BOX[1],
  BOX[2],
]

/** The box wherever it is, found by its own frame — nothing else here draws corners. */
const boxOf = (d) => {
  const lines = d.stdout.lines()
  const top = lines.findIndex((line) => line.startsWith('╭'))
  const bottom = lines.findIndex((line) => line.startsWith('╰'))
  return top === -1 || bottom < top ? [] : lines.slice(top, bottom + 1)
}

const rowOf = (d, label) => boxOf(d).find((line) => line.includes(`│ ${label}`))

const execDetails = (d) => d.timeline.events.filter((e) => e.kind === 'exec').map((e) => e.detail)

// A cache fs that records rather than acts. Every method version-cache.js can reach is
// present — a bag missing one would fail as a TypeError and look like the guard working
// — and the read reports "no such file", which is what a fresh container has.
function recordingCacheFs(ops) {
  return {
    readFileSync: (path) => {
      ops.push(`readFileSync ${path}`)
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    },
    writeFileSync: (path) => ops.push(`writeFileSync ${path}`),
    mkdirSync: (path) => ops.push(`mkdirSync ${path}`),
    existsSync: (path) => {
      ops.push(`existsSync ${path}`)
      return false
    },
  }
}

describe('QA startCommand identity box — the first line of every piped run (#68)', () => {
  for (const [name, options] of Object.entries(PATHS)) {
    it(`opens the ${name} path with the box, above every other side effect`, async () => {
      // Piped, which is the case the sprite does not cover: with no seventeen rows in
      // front of it the box is lines 0..2 of stdout, and the first event that is not a
      // stdout write is event 3. Both halves matter — the slice proves it is there and
      // in one piece, `firstOther` proves nothing happened before it.
      const d = deps(options)
      await outcomeOf(d)
      expect(d.stdout.lines().slice(0, BOX.length), name).toEqual(BOX)
      expect(d.timeline.firstOther(), name).toBe(BOX.length)
      // One `out()` per line, each with its own newline: a chunk that forgot the last
      // one would glue the box's bottom rule to the first preflight line.
      expect(d.stdout.chunks.slice(0, BOX.length), name).toEqual(BOX.map((line) => `${line}\n`))
      // ...and the box is text, so a piped run gets it with no escape byte at all.
      for (const line of BOX) expect(line, name).not.toContain(ESC)
    })
  }

  it('keeps the box on stdout, never on the stream a script reads errors from', async () => {
    // The six aborts all write to stderr; the box is context for a human reading the
    // log, and a script parsing stderr must not have to skip a frame to find the error.
    for (const name of ['tmux session already exists', 'cycle lock held', 'tmux launch failed']) {
      const d = deps(PATHS[name])
      await outcomeOf(d)
      expect(d.stderr.output(), name).not.toContain('╭')
      expect(d.stderr.output(), name).not.toContain('│')
      expect(d.stdout.lines().slice(0, BOX.length), name).toEqual(BOX)
    }
  })

  it('shows the box first even when the sprite is suppressed by NO_COLOR on a TTY', async () => {
    // A terminal whose user asked for no colour is still a terminal, and the facts are
    // not colour. The sprite goes; the box is line 0.
    for (const options of [
      { isTTY: true, processEnv: { NO_COLOR: '1' } },
      { isTTY: true, processEnv: { NO_COLOR: '' } },
      { isTTY: true, color: false },
      { stdoutIsTTY: false, isTTY: true },
    ]) {
      const d = deps(options)
      await startCommand(d)
      expect(d.stdout.lines().slice(0, BOX.length), JSON.stringify(options)).toEqual(BOX)
      expectNoSprite(d.stdout.output())
    }
  })
})

describe('QA startCommand identity box — the cache is read, and nothing else (#68)', () => {
  it('performs exactly one read and no write on the cache fs, on a launch', async () => {
    // The box READS. #24 owns writing, and it is injected away here (`update` returns a
    // decision, `recordPrompt` is a no-op), so every operation this bag sees is the
    // banner's. One read, no mkdir, no write — a `ralph start` must not create
    // ~/.config/ralph just to print a version.
    const ops = []
    const d = deps({ cacheFs: recordingCacheFs(ops), readCache: undefined })
    expect(await outcomeOf(d)).toEqual({ returned: { exitCode: 0, started: true, count: 3 } })
    expect(ops).toEqual([`readFileSync ${CACHE_PATH}`])
  })

  it('performs no write on any of the twelve ways out', async () => {
    // Including the aborts, which are the runs that exit before #24's step 2.5 — so a
    // write appearing here could only be the banner's.
    for (const [name, options] of Object.entries(PATHS)) {
      const ops = []
      const d = deps({ ...options, cacheFs: recordingCacheFs(ops), readCache: undefined })
      await outcomeOf(d)
      expect(ops.filter((op) => !op.startsWith('readFileSync')), name).toEqual([])
      expect(ops.length, name).toBeLessThanOrEqual(1)
    }
  })

  it('creates no cache file in a fresh container, on a launch and on an abort', async () => {
    // memfs rather than a recorder, so this is a claim about the RESULT: the directory
    // ~/.config/ralph does not come into existence because a banner was printed.
    for (const options of [{}, { sessionExists: true }, { queue: 0 }]) {
      const cacheFs = new Volume()
      const d = deps({ ...options, cacheFs, readCache: undefined })
      await outcomeOf(d)
      expect(cacheFs.toJSON(), JSON.stringify(options)).toEqual({})
    }
  })

  it('asks the registry nothing — no `npm view` on any path', async () => {
    // #21's fetch is `npm view @lucasfe/ralph version`, and #24 gates it behind a
    // weekly throttle. The banner is printed before all of that and must never be the
    // thing that adds a network round trip to `ralph start`'s first paint.
    for (const [name, options] of Object.entries(PATHS)) {
      const d = deps(options)
      await outcomeOf(d)
      for (const detail of execDetails(d)) {
        expect(detail, name).not.toContain('npm')
        expect(detail, name).not.toContain('view')
      }
    }
  })

  it('reads the cache through the seam once, with the run’s own fs, env and home', async () => {
    // #41: the box's one impure input, and it must arrive from the injected bag rather
    // than from the ambient process. Asserted as identity, not as equality.
    const cacheFs = recordingCacheFs([])
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    const seen = []
    const d = deps({
      cacheFs,
      processEnv,
      home: '/home/elsewhere',
      readCache: (args) => {
        seen.push(args)
        return { latest_version: null }
      },
    })
    await startCommand(d)
    expect(seen).toHaveLength(1)
    expect(seen[0].fs).toBe(cacheFs)
    expect(seen[0].processEnv).toBe(processEnv)
    expect(seen[0].home).toBe('/home/elsewhere')
  })

  it('reads the real cache file through the injected fs when no seam is given', async () => {
    // The DEFAULT wiring, so `readCache` cannot be plumbed to nothing: memfs stands in
    // for ~/.config/ralph and the hint proves the file was actually read.
    const cacheFs = Volume.fromJSON({ [CACHE_PATH]: JSON.stringify({ latest_version: '9.9.9' }) }, '/')
    const d = deps({ cacheFs, readCache: undefined })
    await startCommand(d)
    expect(boxOf(d)).toEqual(BOX_WITH_HINT)
  })

  it('honors an XDG_CONFIG_HOME the run was given rather than the home dir', async () => {
    // The cache path is XDG-resolved (#24), and the box must read the same file the
    // update check writes — otherwise a user with XDG set gets a hint that never
    // updates, or none at all.
    const processEnv = { XDG_CONFIG_HOME: '/xdg' }
    const path = versionCachePath({ processEnv, home: HOME })
    const cacheFs = Volume.fromJSON({ [path]: JSON.stringify({ latest_version: '9.9.9' }) }, '/')
    const d = deps({ cacheFs, processEnv, readCache: undefined })
    await startCommand(d)
    expect(rowOf(d, 'update')).toContain('9.9.9')
  })
})

describe('QA startCommand identity box — the opt-out gates the hint and the read (#68)', () => {
  // Every spelling of #24's opt-out, and the ONE rule that decides: whatever
  // `isUpdateCheckDisabled` says of the bag is what the hint must do. Computed from
  // that function rather than restated as a literal, because a second reading of the
  // variable is exactly how the box and the notice would come to disagree about
  // whether a user asked to stop being told about updates.
  const SPELLINGS = ['1', '0', 'true', 'false', 'TRUE', 'FALSE', 'yes', 'no', 'off', 'on', ' 1 ', ' 0 ', '', '   ', '\t', '00', '2', '-1', 'null']

  for (const value of SPELLINGS) {
    it(`agrees with isUpdateCheckDisabled for ${JSON.stringify(value)}`, async () => {
      const processEnv = { RALPH_NO_UPDATE_CHECK: value }
      const disabled = isUpdateCheckDisabled(processEnv)
      const seen = []
      const d = deps({
        processEnv,
        readCache: () => {
          seen.push(value)
          return { latest_version: '9.9.9' }
        },
      })
      await startCommand(d)
      expect(Boolean(rowOf(d, 'update')), `disabled=${disabled}`).toBe(!disabled)
      // ...and on the disabled path the cache is not read AT ALL. update-check.js
      // promises that path "reads no cache", two QA suites pin it as zero operations on
      // the injected fs, and the box must not be what starts touching it.
      expect(seen, `disabled=${disabled}`).toEqual(disabled ? [] : [value])
    })
  }

  it('reads the opt-out from a non-string and an inherited value, like the check does', async () => {
    // An injected bag is not `process.env` and is not bound to strings; an inherited
    // key is how a caller layers a bag over defaults. Both go through String() in
    // isUpdateCheckDisabled, so both must gate the hint the same way.
    for (const processEnv of [
      { RALPH_NO_UPDATE_CHECK: 1 },
      { RALPH_NO_UPDATE_CHECK: true },
      { RALPH_NO_UPDATE_CHECK: 0 },
      { RALPH_NO_UPDATE_CHECK: false },
      { RALPH_NO_UPDATE_CHECK: null },
      { RALPH_NO_UPDATE_CHECK: undefined },
      Object.create({ RALPH_NO_UPDATE_CHECK: '1' }),
    ]) {
      const d = deps({ processEnv, readCache: () => ({ latest_version: '9.9.9' }) })
      await startCommand(d)
      const context = JSON.stringify(processEnv)
      expect(Boolean(rowOf(d, 'update')), context).toBe(!isUpdateCheckDisabled(processEnv))
    }
  })

  it('touches no cache file on the opt-out path, with the default wiring', async () => {
    // Not just "the seam was not called": with no seam injected at all, the fs the run
    // was given must see nothing — no read, no mkdir, no write.
    const ops = []
    const d = deps({
      processEnv: { RALPH_NO_UPDATE_CHECK: '1' },
      cacheFs: recordingCacheFs(ops),
      readCache: undefined,
    })
    await startCommand(d)
    expect(ops).toEqual([])
    expect(boxOf(d)).toEqual(BOX)
  })

  it('still prints the box itself when update checks are off', async () => {
    // The opt-out is about the NAG, not about the facts: which version and which
    // directory are still the reasons this box exists.
    const d = deps({ processEnv: { RALPH_NO_UPDATE_CHECK: '1' }, isTTY: true })
    await startCommand(d)
    expect(d.stdout.lines().slice(BANNER.length, BANNER.length + BOX.length)).toEqual(BOX)
  })
})

describe('QA startCommand identity box — the readCache seam, abused (#68)', () => {
  // Everything the seam can hand back that is not a cache. Each costs the HINT and
  // nothing else: same box, same exit code, nothing on stderr.
  const RETURNS = [
    ['null', () => null],
    ['undefined', () => undefined],
    ['an empty object', () => ({})],
    ['a numeric latest_version', () => ({ latest_version: 42 })],
    ['a null latest_version', () => ({ latest_version: null })],
    ['a blank latest_version', () => ({ latest_version: '   ' })],
    ['a non-semver latest_version', () => ({ latest_version: 'banana' })],
    ['an array', () => []],
    ['a string', () => 'nope'],
    ['a number', () => 7],
    ['a promise', () => Promise.resolve({ latest_version: '9.9.9' })],
    ['a throwing latest_version getter', () => ({ get latest_version() { throw new Error('boom') } })],
    ['a throwing read', () => { throw new TypeError('The "path" argument must be of type string.') }],
    ['a null prototype cache', () => Object.assign(Object.create(null), { latest_version: null })],
  ]

  for (const [name, readCache] of RETURNS) {
    it(`costs a hint and never the run for ${name}`, async () => {
      const d = deps({ readCache })
      expect(await outcomeOf(d), name).toEqual({
        returned: { exitCode: 0, started: true, count: 3 },
      })
      expect(boxOf(d), name).toEqual(BOX)
      expect(d.stderr.output(), name).toBe('')
    })
  }

  it('does not await a promised cache into a hint, and does not warn about it', async () => {
    // A `readCache` that returns a promise is a refactor accident (`async` added to a
    // sync seam). The banner is printed synchronously before the first preflight line,
    // so there is nothing to await it with — what matters is that the run is unharmed
    // and the box says nothing it cannot prove.
    const d = deps({ readCache: async () => ({ latest_version: '9.9.9' }) })
    await startCommand(d)
    expect(boxOf(d)).toEqual(BOX)
    expect(d.stdout.output()).not.toContain('ralph update')
  })

  it('trusts a seam’s value no further than a semver, on the hint', async () => {
    // An injected seam has not necessarily been through normalizeCache, so the string
    // check in the command is not redundant with version-cache.js's. A padded value is
    // still a version; a v-prefixed one is not.
    const padded = deps({ readCache: () => ({ latest_version: ' 9.9.9 ' }) })
    await startCommand(padded)
    expect(boxOf(padded)).toEqual(BOX_WITH_HINT)

    for (const latest of ['v9.9.9', '9.9', 'latest', '9.9.9.9']) {
      const d = deps({ readCache: () => ({ latest_version: latest }) })
      await startCommand(d)
      expect(boxOf(d), latest).toEqual(BOX)
    }
  })

  it('offers no hint for a cached version that is not newer than the installed one', async () => {
    for (const latest of ['1.2.3', '1.2.2', '0.9.9', '1.2.3-rc.1']) {
      const d = deps({ readCache: () => ({ latest_version: latest }) })
      await startCommand(d)
      expect(boxOf(d), latest).toEqual(BOX)
    }
  })
})

describe('QA startCommand identity box — the width comes from the stream (#68)', () => {
  const widthsOf = (d) => boxOf(d).map((line) => [...line].length)

  it('takes the terminal’s columns, and the 60-column default from a stream without any', async () => {
    for (const [columns, expected] of [
      [40, 40],
      [30, 30],
      [26, 26],
      [61, 60],
      [200, 60],
    ]) {
      const d = deps({ isTTY: true })
      d.stdout.columns = columns
      await startCommand(d)
      expect(new Set(widthsOf(d)), String(columns)).toEqual(new Set([expected]))
    }
  })

  it('falls back to the default for every column count a stream can lie with', async () => {
    // `stdout.columns` is 0 on some CI runners, undefined on a pipe, and there is no
    // rule that says a stream cannot report nonsense. None of it may produce a
    // one-column box or lose the run.
    for (const columns of [0, -1, Number.NaN, '80', null, {}, 0.5]) {
      const d = deps({ isTTY: true })
      d.stdout.columns = columns
      await startCommand(d)
      expect(boxOf(d), JSON.stringify(columns)).toEqual(BOX)
    }
  })

  it('lets an explicit columns option beat what the stream reports', async () => {
    // Same convention as `stdoutIsTTY` and `color`: a caller that has already decided
    // is not overruled by the stream.
    const d = deps({ isTTY: true, columns: 30 })
    d.stdout.columns = 200
    await startCommand(d)
    expect(new Set(widthsOf(d))).toEqual(new Set([30]))
  })

  it('never lets a narrow terminal spill the box past the columns it reported', async () => {
    // The guarantee a wrapping terminal makes visible: one line wider than the
    // terminal is two lines on screen, and the box would look torn in exactly the
    // window a user shrank to read it.
    //
    // Piped, and by INDEX rather than through boxOf: below three columns the frame
    // glyphs are themselves clipped away, so a finder that looks for `╭` finds nothing
    // — and "the first four lines of stdout are the box" is the claim that still holds
    // there. Four lines, because this run's cache holds a newer version.
    for (const columns of [59, 44, 27, 26, 12, 5, 2, 1]) {
      const d = deps({ columns, readCache: () => ({ latest_version: '9.9.9' }) })
      await startCommand(d)
      const box = d.stdout.lines().slice(0, BOX_WITH_HINT.length)
      expect(box, String(columns)).toHaveLength(BOX_WITH_HINT.length)
      for (const line of box) {
        const visible = [...line.replaceAll(/\u001B\[\d+m/g, '')].length
        expect(visible, `${columns}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns)
      }
    }
  })
})
