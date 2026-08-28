// #74 — RALPH_BANNER, wired into `ralph start`.
//
// lib/banner-mode.test.js is the POLICY, asserted as a table against plain values. This file
// is the WIRING, and it has four claims:
//
//   1. THE KNOB IS READ FROM THE FILE THE LOOP ALREADY READS, without sourcing it — the same
//      thin-reader pattern `RALPH_AGENT`, `TASK_SOURCE` and `RALPH_DIGEST_INTERVAL` go
//      through — and out of the ONE read this command already makes. Asserted as a count, so
//      a second read cannot creep in and let a config rewritten mid-preflight answer two
//      questions differently.
//   2. THE ENVIRONMENT WINS. Deliberately the opposite precedence to the `TASK_SOURCE` line
//      three lines below it in start.js, and the reason is in lib/banner-mode.js's header: a
//      task source is a property of the repo, a banner is a property of the invocation.
//   3. EACH MODE PRODUCES EXACTLY THE BYTES IT PROMISES. `full` is #73's splash, unchanged.
//      `static` is the frame the splash settles on and nothing else — no hide, no restore,
//      no cursor move. `off` is the run this command made before #67 existed, box included:
//      asserted by SUBTRACTION against a default run, so "leaves existing output unchanged"
//      is a statement about the whole stream rather than about a prefix.
//   4. A TYPO COSTS A LINE OF STDERR AND NEVER THE RUN.
//
// ...and the fifth, which is the one the issue turns on and is asserted here rather than in
// the resolver's table because only a wired run can show it: a `full` that the TERMINAL capped
// down to nothing still prints the identity BOX. A pipe is not a request to be told nothing;
// an explicit `off` is.
//
// Every capability is injected (#41): the config text, the environment bag, `stdoutIsTTY`,
// `columns`, the sleep and the signal source. No assertion in this file can be changed by the
// terminal the suite happens to run in.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { startCommand } from './start.js'
import { BANNER_MODES, DEFAULT_BANNER_MODE } from '../banner-mode.js'
import { templatePath } from '../paths.js'
import { renderSplashFrames, renderStaticBanner } from '../sprite-banner.js'
import { playSplash } from '../sprite-player.js'
import { composeBanner } from '../banner-compose.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'
import { sessionNameFor } from '../lock.js'

// The escape byte, spelled rather than typed, so the assertions below can say "not one
// escape sequence reached this stream" without a raw control character in the source.
const ESC = '\u001B'
const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const SESSION = sessionNameFor(REPO)

// The 17 rows a colour-capable terminal receives, from the same pure function the command
// reaches through — the pixels are lib/sprite-banner.test.js's business.
const BANNER = renderStaticBanner({ isTTY: true, color: true })

// The two byte streams the sprite can arrive as, PRODUCED BY THE PLAYER rather than restated
// here: five frames redrawn in place (`full`), and one frame written once (`static`). Deriving
// them is what keeps this file a wiring spec — which sequence a count of frames produces is
// pinned byte by byte, against spelled-out escapes, in lib/sprite-player.test.js.
const SPLASH_BLOCK = await sprite()
const STATIC_BLOCK = await sprite(1)

async function sprite(cycles) {
  const chunks = []
  await playSplash({
    frames: renderSplashFrames({ isTTY: true, color: true }),
    cycles,
    stream: { write: (chunk) => chunks.push(chunk) },
    sleep: async () => {},
    signals: null,
  })
  return chunks.join('')
}

// ...and the box, from the same pure function for the same reason.
const BOX = composeBanner({
  facts: { version: VERSION, latestVersion: null, cwd: REPO, whatsNew: [] },
  capabilities: { color: false },
})
const BOX_BLOCK = `${BOX.join('\n')}\n`

function makeStream({ isTTY } = {}) {
  const chunks = []
  const stream = {
    write: (s) => {
      chunks.push(s)
      return true
    },
    chunks,
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
  // Only ever SET when a test asks for it: `Boolean(undefined)` is what a piped stdout
  // answers, and that is the default the piped runs below rely on.
  if (isTTY !== undefined) stream.isTTY = isTTY
  return stream
}

// A ralph.config.sh, with the banner's line in it and the task source that keeps every run
// below on the folder path. The source is in EVERY fixture on purpose: `github` and `folder`
// print different preflight lines, and a subtraction between two runs is only a statement
// about the banner if nothing else about them differs.
const cfg = (...lines) => ['TASK_SOURCE=folder', ...lines, ''].join('\n')

// Driven through the folder source so the queue depth is a dependency rather than a `gh`
// stub — the banner is source-independent.
const deps = ({
  isTTY,
  queue = 3,
  sessionExists = false,
  config = cfg(),
  ...overrides
} = {}) => {
  const stdout = makeStream({ isTTY })
  const stderr = makeStream()
  const reads = []
  const calls = []
  const naps = []
  const exec = async (cmd, args) => {
    calls.push({ cmd, key: `${cmd} ${args.join(' ')}` })
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
    exec,
    reads,
    naps,
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => {
      reads.push(String(p))
      return String(p).endsWith('ralph.config.sh') ? config : ''
    },
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    currentVersion: VERSION,
    update: async () => ({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'disabled',
      updatedCache: null,
    }),
    readCache: () => ({ ...EMPTY_VERSION_CACHE }),
    readChangelog: () => [],
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => queue,
    home: HOME,
    processEnv: {},
    // The splash's two impure capabilities, neutralised — a real sleep would cost every TTY
    // run here a second of wall clock and the real signal source would leave a SIGINT
    // listener in the vitest worker. The naps are RECORDED, because how long each mode holds
    // the terminal is one of this file's claims.
    sleep: async (ms) => {
      naps.push(ms)
    },
    signals: null,
    ...overrides,
  }
}

/** A run's stdout with the identity box taken out of it, wherever it is. */
const withoutBox = (output) => output.replace(BOX_BLOCK, '')

describe('startCommand — RALPH_BANNER=full (#74)', () => {
  it('is what an unset knob does: #73’s splash, byte for byte', async () => {
    // The zero-regression row. A repo that never edits ralph.config.sh and a shell that never
    // exports the variable both get the banner they already had.
    const unset = deps({ isTTY: true })
    const explicit = deps({ isTTY: true, config: cfg('RALPH_BANNER="full"') })
    await startCommand(unset)
    await startCommand(explicit)
    expect(unset.stdout.output().startsWith(`${SPLASH_BLOCK}${BOX_BLOCK}`)).toBe(true)
    expect(explicit.stdout.output()).toBe(unset.stdout.output())
    expect(explicit.stderr.output()).toBe('')
    // Five frames, five naps: the second the PRD advertises, still coming from the asset.
    expect(explicit.naps).toEqual([200, 200, 200, 200, 200])
  })

  it('accepts it case-insensitively and trimmed, from the config and from the environment', async () => {
    // The spellings a LINE of ralph.config.sh can hold — the shared grammar reads one line,
    // so a value with a newline in it is not something a user can write there.
    for (const value of ['full', 'FULL', '  Full  ', '\tfull\t']) {
      const fromConfig = deps({ isTTY: true, config: cfg(`RALPH_BANNER="${value}"`) })
      const fromEnv = deps({ isTTY: true, processEnv: { RALPH_BANNER: value } })
      await startCommand(fromConfig)
      await startCommand(fromEnv)
      expect(fromConfig.stdout.output(), value).toBe(fromEnv.stdout.output())
      expect(fromConfig.stdout.output().startsWith(SPLASH_BLOCK), value).toBe(true)
      expect(fromConfig.stderr.output(), value).toBe('')
    }

    // ...and the ones only an ENVIRONMENT can: `RALPH_BANNER=$'full\n'`, or the trailing
    // newline a `$(cat some-file)` leaves behind. Trimmed like any other whitespace, because
    // the alternative is a warning about a value the user cannot see the problem with.
    for (const value of ['full\n', '\nfull', ' \t full \n ']) {
      const d = deps({ isTTY: true, processEnv: { RALPH_BANNER: value } })
      await startCommand(d)
      expect(d.stdout.output().startsWith(SPLASH_BLOCK), JSON.stringify(value)).toBe(true)
      expect(d.stderr.output(), JSON.stringify(value)).toBe('')
    }
  })
})

describe('startCommand — RALPH_BANNER=static (#74)', () => {
  it('writes the settled frame once, and animates nothing', async () => {
    const d = deps({ isTTY: true, config: cfg('RALPH_BANNER="static"') })
    await startCommand(d)
    // The same seventeen rows the splash ends on — in ONE write, with no cursor control at
    // all. The player hides no cursor it is not going to redraw over (#73), which is what
    // makes this mode a choice about plumbing rather than about pixels.
    expect(STATIC_BLOCK).toBe(`${BANNER.join('\n')}\n`)
    expect(d.stdout.output().startsWith(`${STATIC_BLOCK}${BOX_BLOCK}`)).toBe(true)
    expect(d.stdout.chunks[0]).toBe(STATIC_BLOCK)
    expect(d.stdout.output()).not.toContain(`${ESC}[?25`)
    expect(d.stdout.output()).not.toMatch(/\u001B\[\d+A/)
    // One frame, one beat: the same 200ms the splash holds its final frame for before the box
    // lands under it, and a fifth of what `full` costs.
    expect(d.naps).toEqual([200])
  })

  it('is the full run minus the animation — the box and every preflight line are untouched', async () => {
    // THE SUBTRACTION for this mode: a `static` run is a `full` run with four frames and the
    // cursor control taken out and NOTHING else moved, reworded or reordered.
    const still = deps({ isTTY: true, config: cfg('RALPH_BANNER=static') })
    const full = deps({ isTTY: true })
    expect(await startCommand(still)).toEqual(await startCommand(full))
    expect(still.stdout.output().replace(STATIC_BLOCK, '')).toBe(
      full.stdout.output().replace(SPLASH_BLOCK, ''),
    )
    expect(still.stderr.output()).toBe(full.stderr.output())
  })

  it('accepts it case-insensitively and trimmed', async () => {
    for (const value of ['static', 'STATIC', ' Static ']) {
      const d = deps({ isTTY: true, config: cfg(`RALPH_BANNER='${value}'`) })
      await startCommand(d)
      expect(d.stdout.output().startsWith(STATIC_BLOCK), value).toBe(true)
      expect(d.naps, value).toEqual([200])
    }
  })

  it('draws no sprite where the terminal cannot hold one, and keeps the facts', async () => {
    // Capability caps DOWNWARD from here too: `static` is still a sprite, so a pipe, a
    // NO_COLOR run and a 20-column terminal all get the box alone.
    for (const options of [
      { label: 'a pipe', overrides: {} },
      { label: 'NO_COLOR', overrides: { isTTY: true, processEnv: { NO_COLOR: '1' } } },
      { label: '20 columns', overrides: { isTTY: true, columns: 20 } },
    ]) {
      const d = deps({ ...options.overrides, config: cfg('RALPH_BANNER=static') })
      await startCommand(d)
      expect(d.stdout.output(), options.label).not.toMatch(/[▀▄]/)
      expect(d.naps, options.label).toEqual([])
      expect(d.stdout.output(), options.label).toContain('cwd')
    }
  })
})

describe('startCommand — RALPH_BANNER=off (#74)', () => {
  it('prints no sprite and no box, and leaves the rest byte-for-byte unchanged', async () => {
    // Criterion 3, as a subtraction: an `off` run is a piped run with the box removed and not
    // one other byte different — no blank line where it was, no reordering, no reworded label.
    const off = deps({ config: cfg('RALPH_BANNER="off"') })
    const on = deps({ config: cfg() })
    expect(await startCommand(off)).toEqual(await startCommand(on))
    expect(on.stdout.output().startsWith(BOX_BLOCK)).toBe(true)
    expect(off.stdout.output()).toBe(withoutBox(on.stdout.output()))
    expect(off.stderr.output()).toBe(on.stderr.output())
    // Nothing of the banner survives: no frame glyph, no box glyph, no escape byte.
    expect(off.stdout.output()).not.toMatch(/[▀▄╭╮╰╯│]/)
    expect(off.stdout.output()).not.toContain(ESC)
    expect(off.naps).toEqual([])
  })

  it('silences the banner on a colour-capable TTY, where there was the most to draw', async () => {
    const off = deps({ isTTY: true, config: cfg('RALPH_BANNER=off') })
    const on = deps({ isTTY: true })
    await startCommand(off)
    await startCommand(on)
    expect(off.stdout.output()).toBe(withoutBox(on.stdout.output()).replace(SPLASH_BLOCK, ''))
    expect(off.stdout.output()).not.toContain(ESC)
    expect(off.naps).toEqual([])
  })

  it('accepts it case-insensitively and trimmed', async () => {
    for (const value of ['off', 'OFF', ' Off ']) {
      const d = deps({ isTTY: true, config: cfg(`RALPH_BANNER="${value}"`) })
      await startCommand(d)
      expect(d.stdout.output(), value).not.toMatch(/[▀▄╭╮╰╯│]/)
    }
  })

  it('still prints the preflight, the launch box and the abort — a banner is not the run', async () => {
    // `off` is a request about DECORATION. Everything the command has to say about the run
    // itself is still said, including on the way out of a failure.
    const launched = deps({ isTTY: true, config: cfg('RALPH_BANNER=off') })
    expect(await startCommand(launched)).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(launched.stdout.output()).toContain('✅ Ralph started in background. 3 issues in the queue.')

    const aborted = deps({ isTTY: true, sessionExists: true, config: cfg('RALPH_BANNER=off') })
    await expect(startCommand(aborted)).rejects.toMatchObject({ exitCode: 1 })
    expect(aborted.stderr.output()).toContain(`❌ tmux session '${SESSION}' already exists.`)
    expect(aborted.stdout.output()).not.toMatch(/[▀▄╭╮╰╯│]/)
  })
})

describe('startCommand — the environment overrides the config (#74)', () => {
  it('lets `RALPH_BANNER=off ralph start` silence a repo that committed full', async () => {
    // The reason the override exists: a one-off run inside a wrapper script or a cron entry
    // must be silenceable without editing — and committing — a file every other run shares.
    const d = deps({
      isTTY: true,
      config: cfg('RALPH_BANNER="full"'),
      processEnv: { RALPH_BANNER: 'off' },
    })
    await startCommand(d)
    expect(d.stdout.output()).not.toMatch(/[▀▄╭╮╰╯│]/)
    expect(d.naps).toEqual([])
  })

  it('lets the environment turn a committed off back on', async () => {
    const d = deps({
      isTTY: true,
      config: cfg('RALPH_BANNER=off'),
      processEnv: { RALPH_BANNER: 'full' },
    })
    await startCommand(d)
    expect(d.stdout.output().startsWith(`${SPLASH_BLOCK}${BOX_BLOCK}`)).toBe(true)
  })

  it('defers to the config for an unset, empty or whitespace override', async () => {
    // A `RALPH_BANNER=` exported by a shell script reaches us as the empty string, which is
    // the most easily typed spelling of "no opinion" and must not mean anything.
    for (const RALPH_BANNER of [undefined, '', '   ']) {
      const d = deps({ isTTY: true, config: cfg('RALPH_BANNER=static'), processEnv: { RALPH_BANNER } })
      await startCommand(d)
      expect(d.stdout.output().startsWith(STATIC_BLOCK), JSON.stringify(RALPH_BANNER)).toBe(true)
    }
  })

  it('reads no environment of its own — the injected bag is the only one', async () => {
    // (#41) The variable is read off `processEnv`, so a developer who exported RALPH_BANNER
    // in their own shell cannot change what this suite asserts. Both directions: an empty bag
    // animates, and the bag alone can silence.
    const ambient = process.env.RALPH_BANNER
    try {
      process.env.RALPH_BANNER = 'off'
      const d = deps({ isTTY: true })
      await startCommand(d)
      expect(d.stdout.output().startsWith(SPLASH_BLOCK)).toBe(true)
    } finally {
      if (ambient === undefined) delete process.env.RALPH_BANNER
      else process.env.RALPH_BANNER = ambient
    }
  })
})

describe('startCommand — an unrecognized RALPH_BANNER (#74)', () => {
  it('warns on stderr, draws the full banner, and changes no exit code', async () => {
    const d = deps({ isTTY: true, config: cfg('RALPH_BANNER="blinky"') })
    expect(await startCommand(d)).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(d.stderr.output()).toBe(
      "⚠️  RALPH_BANNER='blinky' unrecognized; falling back to 'full'. Valid: full, static, off.\n",
    )
    // ...and stdout is the run a valid `full` would have produced, to the byte.
    const good = deps({ isTTY: true })
    await startCommand(good)
    expect(d.stdout.output()).toBe(good.stdout.output())
  })

  it('echoes the value as written, so the typo is visible', async () => {
    for (const value of ['Blinkyyy', 'no', 'true', '0', 'ful l']) {
      const d = deps({ processEnv: { RALPH_BANNER: value } })
      await startCommand(d)
      expect(d.stderr.output(), value).toContain(`RALPH_BANNER='${value}' unrecognized`)
      expect(d.stderr.output(), value).toContain('Valid: full, static, off.')
    }
  })

  it('warns once per run, on stderr only, and never on a value it understands', async () => {
    const bad = deps({ isTTY: true, config: cfg('RALPH_BANNER=nope') })
    await startCommand(bad)
    expect(bad.stderr.output().split('\n').filter((line) => line.includes('RALPH_BANNER'))).toHaveLength(1)
    expect(bad.stdout.output()).not.toContain('RALPH_BANNER')

    for (const value of ['full', 'static', 'off', '', '  ']) {
      const good = deps({ isTTY: true, config: cfg(`RALPH_BANNER="${value}"`) })
      await startCommand(good)
      expect(good.stderr.output(), JSON.stringify(value)).toBe('')
    }
  })

  it('collapses a hostile value to one line rather than forging output', async () => {
    // The value comes out of a committed file and an ambient environment, and the warning goes
    // to a terminal. A newline in it would let a config file write a second line of Ralph's
    // stderr; the shared one-line diagnostic rule (#62) is what keeps the warning one line.
    const d = deps({ processEnv: { RALPH_BANNER: 'nope\n❌ Ralph exploded' } })
    await startCommand(d)
    expect(d.stderr.output().split('\n').filter(Boolean)).toHaveLength(1)
    expect(d.stderr.output()).toContain('nope ❌ Ralph exploded')
  })
})

describe('startCommand — where the knob is read from (#74)', () => {
  it('takes it out of the one ralph.config.sh read it already makes, and sources nothing', async () => {
    // Criterion 4. The parse is over TEXT (lib/parse-config-var.js), so no shell runs and a
    // second read cannot appear: `ralph start` reads this file once and asks it for four
    // things — the banner, the task source, the digest interval and the digest's agent.
    const d = deps({ isTTY: true, config: cfg('RALPH_BANNER=off') })
    await startCommand(d)
    expect(d.reads.filter((path) => path.endsWith('ralph.config.sh'))).toHaveLength(1)
    for (const { cmd } of d.exec.calls) expect(['bash', 'sh', 'source', 'zsh']).not.toContain(cmd)
  })

  it('ignores a commented-out assignment, like every other knob in that file', async () => {
    // The shared grammar's rule, asserted here because this is the file a user edits by hand:
    // commenting the line out is how a knob is switched back to its default.
    const d = deps({ isTTY: true, config: cfg('# RALPH_BANNER=off') })
    await startCommand(d)
    expect(d.stdout.output().startsWith(SPLASH_BLOCK)).toBe(true)
  })

  it('survives a missing or unreadable config, on the default', async () => {
    // readConfigText never throws, and the banner must be the last thing to notice: no config
    // file at all is a `full` banner, not a crash and not a silent one.
    const missing = deps({ isTTY: true, exists: () => false })
    await startCommand(missing)
    expect(missing.stdout.output().startsWith(SPLASH_BLOCK)).toBe(true)

    const unreadable = deps({
      isTTY: true,
      readFile: () => {
        throw new Error('EACCES')
      },
    })
    await startCommand(unreadable)
    expect(unreadable.stdout.output().startsWith(SPLASH_BLOCK)).toBe(true)
  })

  it('reads the config before it draws, and still draws above every other side effect', async () => {
    // #74 moves the config read ABOVE the banner, because the banner's own mode is in that
    // file. What must not move is anything a user SEES or anything this command DOES: the
    // first exec still comes after the whole banner.
    const d = deps({ isTTY: true })
    await startCommand(d)
    expect(d.reads[0]).toBe('/repo/ralph.config.sh')
    expect(d.exec.calls[0].key).toBe(`tmux has-session -t ${SESSION}`)
    expect(d.stdout.output().startsWith(`${SPLASH_BLOCK}${BOX_BLOCK}`)).toBe(true)
  })
})

describe('startCommand — the cap does not reach the facts (#74)', () => {
  it('keeps the box on a pipe, a NO_COLOR run and a narrow terminal, for every mode but off', async () => {
    // THE DISTINCTION THE ISSUE TURNS ON. A capped `full` is the terminal saying it cannot
    // show a sprite; it is not the user asking to be told nothing. A launchd log is exactly
    // where "which version, which directory" is the question being asked, so the box stays —
    // in plain text, with not one escape byte.
    for (const mode of ['full', 'static', '', 'garbage']) {
      for (const options of [
        { label: 'a pipe', overrides: {} },
        { label: 'NO_COLOR', overrides: { isTTY: true, processEnv: { NO_COLOR: '1' } } },
        { label: 'color:false', overrides: { isTTY: true, color: false } },
        { label: '20 columns', overrides: { isTTY: true, columns: 20 } },
      ]) {
        const label = `${mode} / ${options.label}`
        const d = deps({ ...options.overrides, config: cfg(`RALPH_BANNER="${mode}"`) })
        await startCommand(d)
        expect(d.stdout.output(), label).toContain(REPO)
        expect(d.stdout.output(), label).toContain(`ralph ${VERSION}`)
        expect(d.stdout.output(), label).not.toContain(ESC)
      }
    }
  })

  it('leaves the frame to composeBanner, which reads the same width #74 does', async () => {
    // The box's borders are decided ONCE, and not here: `bannerLayout` answers them inside
    // composeBanner, from the same `columns` this command has passed it since #72. #74 says
    // only WHETHER the box prints, so a mode knob must change no pixel of it at any width.
    // Asserted against the pure function at both rungs — 60 columns is boxed, 30 is bare —
    // because bytes are what would catch a resolver that started having an opinion here.
    for (const width of [60, 30]) {
      const d = deps({ columns: width })
      await startCommand(d)
      const expected = composeBanner({
        facts: { version: VERSION, latestVersion: null, cwd: REPO, whatsNew: [] },
        width,
        capabilities: { color: false },
      })
      expect(d.stdout.lines().slice(0, expected.length), String(width)).toEqual(expected)
    }
  })
})

describe('the shipped ralph.config.sh template documents the knob (#74, criterion 7)', () => {
  // The file every `ralph init` writes. Read from disk rather than restated, because a knob
  // that exists and is undocumented is a knob nobody finds — and the assertions below are
  // derived from BANNER_MODES, so a fourth mode would fail here until the comment names it.
  const TEMPLATE = readFileSync(templatePath('ralph.config.sh'), 'utf8')

  it('declares it exactly once, live, on the default, with no placeholder in it', async () => {
    // Live rather than commented, so switching the banner off is editing a word rather than
    // remembering a variable name — and ONE live assignment, because bash takes the last one
    // and a second line further down would silently win. On the DEFAULT, so the file `ralph
    // init` writes changes nothing about what a start looks like.
    const live = TEMPLATE.split('\n').filter((line) => /^\s*(export\s+)?RALPH_BANNER\s*=/.test(line))
    expect(live).toEqual([`RALPH_BANNER="${DEFAULT_BANNER_MODE}"`])
    // `ralph init` substitutes a fixed set of placeholders and this is not one of them: an
    // unrendered `{{...}}` would reach the resolver as a value and earn every user a warning.
    expect(live[0]).not.toContain('{{')
  })

  it('names all three values, and the environment override, in the comment above it', async () => {
    // Everything between the blank line above the knob and the assignment itself. Anchored on
    // the LIVE line — `^RALPH_BANNER=` — because the name appears inside its own comment, as
    // the example of the override, and `indexOf` would stop there.
    const comment = TEMPLATE.slice(0, TEMPLATE.search(/^RALPH_BANNER=/m))
      .split('\n\n')
      .at(-1)
    for (const mode of BANNER_MODES) expect(comment, mode).toContain(`"${mode}"`)
    // The override is the half a committed file cannot show by example, so it has to be said.
    expect(comment).toContain('RALPH_BANNER=off ralph start')
  })

  it('produces the run a repo with no banner line at all produces', async () => {
    // The claim that makes the two above worth having: the shipped default is the code's
    // default. Asserted through startCommand rather than by reading the string, on the same
    // argument the digest template's spec makes — "defaults to the full banner" is a claim
    // about behaviour. `{{TASK_SOURCE}}` is the one placeholder these runs need rendered.
    const template = deps({ isTTY: true, config: TEMPLATE.replace('{{TASK_SOURCE}}', 'folder') })
    const bare = deps({ isTTY: true })
    await startCommand(template)
    await startCommand(bare)
    expect(template.stdout.output()).toBe(bare.stdout.output())
    expect(template.stderr.output()).toBe('')
    expect(template.naps).toEqual([200, 200, 200, 200, 200])
  })
})
