// #118 — the agent-fallback warning, on `ralph start`'s stderr.
//
// lib/agent-registry.js decides WHAT the sentence says and lib/agent-registry.warning.qa.test.js
// pins it as a value. This file is the WIRING into the one command that actually launches the
// agent, and it has five claims — all of them about the STREAMS, because the defect was never
// about a return value. `resolveAgent` has answered `{ agent, fellBack, warning }` since #554;
// `ralph start` simply read `.agent` and threw the rest away, so a `RALPH_AGENT="codex "` typo
// cost a whole overnight run of the wrong agent with nothing on either stream saying so.
//
//   1. AN UNRECOGNISED VALUE COSTS ONE LINE OF STDERR AND NEVER THE RUN — the same trade the
//      `RALPH_BANNER` warning two lines above it makes, down to the prefix, and the same trade
//      `ralph init` already makes for this very variable.
//   2. STDOUT IS UNTOUCHED, byte for byte, against a run with the variable unset. `ralph start
//      | tee` must be unaffected, and the identity box must keep REPORTING the agent that will
//      actually run rather than acquiring a second opinion about the typo (#69).
//   3. A VALUE THE REGISTRY UNDERSTANDS — and an unset, empty or whitespace one — PRINTS
//      NOTHING. A diagnostic that fires on a clean run is noise nobody can switch off.
//   4. IT IS RESOLVED AT THE LOOP'S OWN PRECEDENCE: ralph.config.sh over the environment,
//      because templates/ralph.sh sources that file with `set -a`. Warning about a value the
//      run will not use would be worse than silence.
//   5. IT LANDS ABOVE THE SPLASH, alongside the banner warning, rather than mid-announcement —
//      asserted as an ORDER over the two streams, since that is the only way a reader can see
//      it. And it is not decoration: `RALPH_BANNER=off` silences the picture, not the
//      diagnostic, and an aborting run still gets it.
//
// Every seam is injected (#41) — the config text, the environment bag, `stdoutIsTTY`, the sleep
// and the signal source — so no assertion here can be changed by the shell the suite runs in.

import { describe, it, expect } from 'vitest'
import { startCommand } from './start.js'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'
import { sessionNameFor } from '../lock.js'

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const SESSION = sessionNameFor(REPO)

// The escape byte, spelled rather than typed (#107), and the mark `oneLineEcho` puts in its
// place — a raw control character in a committed source makes grep skip the file silently.
const ESC = String.fromCharCode(27)
const LF = String.fromCharCode(10)
const PLACEHOLDER = String.fromCharCode(0xfffd)

/** The whole line `ralph start` is expected to write for a given raw value. */
const warningFor = (echo) =>
  `⚠️  RALPH_AGENT='${echo}' unrecognized; falling back to 'claude'. Valid: claude, codex.`

// Both streams write into ONE ordered log as well as their own buffer: claim 5 is about which
// stream got a byte FIRST, and two independent chunk arrays cannot say that.
function makeStreams({ isTTY } = {}) {
  const writes = []
  const make = (name) => {
    const chunks = []
    const stream = {
      write: (s) => {
        chunks.push(s)
        writes.push({ stream: name, text: s })
        return true
      },
      chunks,
      output: () => chunks.join(''),
      lines: () => chunks.join('').split(LF).slice(0, -1),
    }
    return stream
  }
  const stdout = make('stdout')
  // Only ever SET when a test asks for it: `Boolean(undefined)` is what a piped stdout answers,
  // and that is the default the runs below rely on.
  if (isTTY !== undefined) stdout.isTTY = isTTY
  return { stdout, stderr: make('stderr'), writes }
}

// A ralph.config.sh with the task source in it. Folder mode in every fixture, deliberately: it
// keeps the queue depth a dependency rather than a `gh` stub, and a subtraction between two runs
// is only a statement about the warning if nothing else about them differs.
const cfg = (...lines) => ['TASK_SOURCE=folder', ...lines, ''].join(LF)

const deps = ({ isTTY, queue = 3, sessionExists = false, config = cfg(), ...overrides } = {}) => {
  const { stdout, stderr, writes } = makeStreams({ isTTY })
  const exec = async (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return {
    cwd: REPO,
    stdout,
    stderr,
    writes,
    exec,
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? config : ''),
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
    // The splash's two impure capabilities, neutralised: a real sleep would cost every TTY run
    // here a second of wall clock and the real signal source would leave a SIGINT listener in
    // the vitest worker.
    sleep: async () => {},
    signals: null,
    ...overrides,
  }
}

const run = async (options) => {
  const d = deps(options)
  const result = await startCommand(d)
  return { d, result }
}

/** Every stderr line that is about this variable — the count is claim 1's whole point. */
const agentLines = (d) => d.stderr.lines().filter((line) => line.includes('RALPH_AGENT'))

describe('startCommand — an unrecognized RALPH_AGENT (#118)', () => {
  it('warns once on stderr, runs anyway, and puts nothing on stdout', async () => {
    // THE DEFECT, closed. The value is echoed back as written so the typo is visible, the
    // fallback is named so the user knows what is about to run all night, and the exit code
    // does not move: a mistyped knob is never worth aborting an unattended launch over.
    const { d, result } = await run({ isTTY: true, config: cfg('RALPH_AGENT="codx"') })
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(agentLines(d)).toEqual([warningFor('codx')])
    expect(d.stdout.output()).not.toContain('RALPH_AGENT')
    expect(d.stdout.output()).not.toContain('unrecognized')
  })

  it('leaves stdout byte-for-byte the run an unset value produces', async () => {
    // Claim 2. `ralph start | tee` is how an operator keeps a launch record, so the diagnostic
    // may not reach that stream — and the identity box must still REPORT the run rather than
    // diagnose it (#69): the agent row names claude, which is what will actually run, and the
    // typo is annotated on the OTHER stream.
    const typo = deps({ isTTY: true, config: cfg('RALPH_AGENT="codx"') })
    const unset = deps({ isTTY: true })
    expect(await startCommand(typo)).toEqual(await startCommand(unset))
    expect(typo.stdout.output()).toBe(unset.stdout.output())
    expect(unset.stderr.output()).toBe('')
    expect(typo.stderr.output()).toBe(`${warningFor('codx')}${LF}`)
  })

  it('echoes every spelling of the typo back as written', async () => {
    // Padding, case and spelling are untouched, because the sentence's job is to show the user
    // what they typed — `codex-cli` is the most expensive of these, since it is one word away
    // from a value that would have worked and reads as correct at a glance.
    for (const value of ['codx', 'claude-code', 'gemini', 'codex-cli', 'CODX', 'gpt-5', 'true']) {
      const { d } = await run({ processEnv: { RALPH_AGENT: value } })
      expect(agentLines(d), value).toEqual([warningFor(value)])
    }
  })

  it('collapses a hostile value to one line rather than forging output', async () => {
    // The value comes out of a committed file and an ambient environment, and the warning goes
    // to a terminal. `resolveAgent` sanitises the echo at the source (#108) — one code point for
    // one — so this command needs no rule of its own, and the assertion that matters here is
    // that ONE write is still ONE line.
    for (const value of [`codx${LF}❌ Ralph exploded`, `codex${ESC}[2J`]) {
      const { d, result } = await run({ processEnv: { RALPH_AGENT: value } })
      expect(result, JSON.stringify(value)).toEqual({ exitCode: 0, started: true, count: 3 })
      expect(agentLines(d), JSON.stringify(value)).toHaveLength(1)
      expect(d.stderr.output(), JSON.stringify(value)).toContain(PLACEHOLDER)
      expect(d.stderr.chunks.every((chunk) => chunk.split(LF).length === 2)).toBe(true)
    }
  })
})

describe('startCommand — a value the registry understands is silent (#118)', () => {
  it('prints nothing for either agent, in any case or padding', async () => {
    // The padded spellings are the ones the issue's own example turns on: `resolveAgent` TRIMS
    // before it looks up, so `RALPH_AGENT="codex "` — a trailing space left behind by a hand
    // edit, or the newline a `$(cat ...)` leaves on the end — is a clean resolution to codex and
    // not a typo at all. Warning about it would be warning about a value that works.
    for (const value of ['claude', 'codex', 'CODEX', ' codex ', 'Claude', 'codex ']) {
      const fromConfig = await run({ isTTY: true, config: cfg(`RALPH_AGENT="${value}"`) })
      const fromEnv = await run({ isTTY: true, processEnv: { RALPH_AGENT: value } })
      expect(fromConfig.d.stderr.output(), value).toBe('')
      expect(fromEnv.d.stderr.output(), value).toBe('')
    }

    // ...and the spellings only an ENVIRONMENT can hold: `RALPH_AGENT=$'codex\n'`, or the
    // trailing newline a `$(cat some-file)` leaves behind. A config LINE cannot carry one, so
    // these go through the bag alone.
    for (const value of [`codex${LF}`, `${LF}codex`, ` \tcodex${LF} `]) {
      const { d } = await run({ isTTY: true, processEnv: { RALPH_AGENT: value } })
      expect(d.stderr.output(), JSON.stringify(value)).toBe('')
    }
  })

  it('prints nothing for an unset, empty or whitespace value', async () => {
    // `RALPH_AGENT=` exported by a wrapper script, and `RALPH_AGENT=""` left behind by a hand
    // edit, are the most easily typed spellings of "no opinion". Neither is a typo, and
    // `resolveAgent` reads a value that trims to nothing as unset rather than as unrecognised.
    for (const value of [undefined, '', '   ', `${LF}claude${LF}`]) {
      const { d } = await run({ isTTY: true, processEnv: { RALPH_AGENT: value } })
      expect(d.stderr.output(), JSON.stringify(value)).toBe('')
    }
    for (const line of ['', 'RALPH_AGENT=', 'RALPH_AGENT=""', 'RALPH_AGENT="   "', '# RALPH_AGENT=codx']) {
      const { d } = await run({ isTTY: true, config: cfg(line) })
      expect(d.stderr.output(), line).toBe('')
    }
  })

  it('reads no environment of its own — the injected bag is the only one', async () => {
    // (#41) A developer who exported a typo'd RALPH_AGENT in their own shell must not be able
    // to change what this suite asserts, in either direction.
    const ambient = process.env.RALPH_AGENT
    try {
      process.env.RALPH_AGENT = 'codx'
      const { d } = await run({ isTTY: true })
      expect(d.stderr.output()).toBe('')
    } finally {
      if (ambient === undefined) delete process.env.RALPH_AGENT
      else process.env.RALPH_AGENT = ambient
    }
  })
})

describe('startCommand — the warning is resolved at the loop’s precedence (#118)', () => {
  it('says nothing when the config names a real agent and the environment holds the typo', async () => {
    // THE ROW THAT MAKES THE PRECEDENCE LOAD-BEARING. templates/ralph.sh sources
    // ralph.config.sh with `set -a`, so the file wins — the loop is about to run codex, the
    // environment's `codx` is dead text, and warning about it would send a user hunting for a
    // typo that changes nothing. Same answer the identity box gives, from the same resolution.
    const { d } = await run({
      isTTY: true,
      config: cfg('RALPH_AGENT="codex"'),
      processEnv: { RALPH_AGENT: 'codx' },
    })
    expect(d.stderr.output()).toBe('')
  })

  it('warns about the config’s typo even when the environment is valid', async () => {
    // The mirror image, and the one an operator actually hits: `RALPH_AGENT=claude` exported
    // in a shell profile masks nothing, because the file is what the loop will source.
    const { d } = await run({
      isTTY: true,
      config: cfg('RALPH_AGENT="codx"'),
      processEnv: { RALPH_AGENT: 'claude' },
    })
    expect(agentLines(d)).toEqual([warningFor('codx')])
  })

  it('falls back to the environment when the config says nothing about the agent', async () => {
    const { d } = await run({ isTTY: true, config: cfg(), processEnv: { RALPH_AGENT: 'codx' } })
    expect(agentLines(d)).toEqual([warningFor('codx')])
  })

  it('keeps the environment out when the config assigns the knob nothing at all', async () => {
    // #118 REVIEW — the shape a truthiness test gets wrong, and the reason this reads PRESENT vs
    // ABSENT rather than truthy vs falsy. Assigning the empty string is still assigning, so bash
    // overwrites an exported value with it — measured, and recorded once, above `configAssignsVar`
    // in lib/parse-config-var.js.
    //
    // The loop therefore resolves claude with nothing to report, and a warning about the
    // environment's `codx` would be a false alarm about text no run will read. All four spellings
    // of blank, because a user backing a knob out reaches for whichever one they think of.
    for (const line of ['RALPH_AGENT=""', "RALPH_AGENT=''", 'RALPH_AGENT=', 'export RALPH_AGENT=']) {
      const { d } = await run({ isTTY: true, config: cfg(line), processEnv: { RALPH_AGENT: 'codx' } })
      expect(agentLines(d), line).toEqual([])
    }
  })

  it('names the config’s agent in the box, on the same precedence as the warning', async () => {
    // The BOX half of the precedence, and the row the structural guard at the bottom of this file
    // cannot see: a second `resolveAgent` reading only `processEnv` would agree with the warning
    // on every value the QA table drives (both would say claude) and still misreport this one.
    // Config `codex` with nothing in the environment must render `codex` — silently, since a
    // recognised value has nothing to warn about.
    const { d } = await run({ isTTY: true, config: cfg('RALPH_AGENT="codex"') })
    expect(d.stdout.output()).toMatch(/\bagent\s{2,}codex\b/)
    expect(agentLines(d)).toEqual([])

    // ...and the blank assignment above reaches the box too, not just the diagnostic: the loop
    // runs claude, so the frame may not advertise the environment's codex.
    const { d: blanked } = await run({
      isTTY: true,
      config: cfg('RALPH_AGENT=""'),
      processEnv: { RALPH_AGENT: 'codex' },
    })
    expect(blanked.stdout.output()).toMatch(/\bagent\s{2,}claude\b/)
  })

  it('survives a missing or unreadable config, warning about the environment', async () => {
    // `readConfigText` answers '' rather than throwing, so a repo with no config file at all
    // still gets the diagnostic for what its shell exported.
    const missing = await run({ isTTY: true, exists: () => false, processEnv: { RALPH_AGENT: 'codx' } })
    expect(agentLines(missing.d)).toEqual([warningFor('codx')])

    const unreadable = await run({
      isTTY: true,
      readFile: () => {
        throw new Error('EACCES')
      },
      processEnv: { RALPH_AGENT: 'codx' },
    })
    expect(agentLines(unreadable.d)).toEqual([warningFor('codx')])
  })
})

describe('startCommand — where the warning lands (#118)', () => {
  it('is the first thing written, above the splash and the box', async () => {
    // Claim 5. A diagnostic in the middle of a launch announcement is the wrong place for it:
    // the box is a curtain going up and reads as one paragraph. So the line goes where the
    // `RALPH_BANNER` fallback warning already goes — before the first byte of stdout.
    const { d } = await run({ isTTY: true, config: cfg('RALPH_AGENT="codx"') })
    expect(d.writes[0]).toEqual({ stream: 'stderr', text: `${warningFor('codx')}${LF}` })
    expect(d.writes.filter((w) => w.stream === 'stderr')).toHaveLength(1)
  })

  it('lines up under the banner’s own warning when both knobs are mistyped', async () => {
    // Two knobs, two lines, one order, and no stdout between them: the banner's warning is
    // resolved first because the banner is what it decides, and the agent's follows it.
    const { d } = await run({
      isTTY: true,
      config: cfg('RALPH_BANNER="blinky"', 'RALPH_AGENT="codx"'),
    })
    expect(d.stderr.lines()).toEqual([
      "⚠️  RALPH_BANNER='blinky' unrecognized; falling back to 'full'. Valid: full, static, off.",
      warningFor('codx'),
    ])
    expect(d.writes.slice(0, 2).map((w) => w.stream)).toEqual(['stderr', 'stderr'])
  })

  it('is not decoration: RALPH_BANNER=off silences the picture, not the diagnostic', async () => {
    // `off` is a request about DECORATION (#74). A typo'd agent is a fact about the run, and a
    // cron entry or a wrapper script that turned the banner off is exactly the launch where
    // nobody is watching the pane — so it is the launch that most needs the line.
    const { d, result } = await run({
      isTTY: true,
      config: cfg('RALPH_BANNER=off', 'RALPH_AGENT="codx"'),
    })
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(d.stdout.output()).not.toMatch(/[▀▄╭╮╰╯│]/)
    expect(agentLines(d)).toEqual([warningFor('codx')])
  })

  it('still prints on a run that aborts before it reaches the loop', async () => {
    // The aborting run is where a preflight line is the only context an error has. This one
    // dies on the tmux uniqueness check, one step below the warning, so the reader gets both.
    const d = deps({ isTTY: true, sessionExists: true, config: cfg('RALPH_AGENT="codx"') })
    await expect(startCommand(d)).rejects.toMatchObject({ exitCode: 1 })
    expect(agentLines(d)).toEqual([warningFor('codx')])
    expect(d.stderr.output()).toContain(`❌ tmux session '${SESSION}' already exists.`)
  })
})

describe('startCommand — one owner of the decision (#118)', () => {
  it('resolves the agent exactly once, so the box and the warning cannot disagree', async () => {
    // The behavioural half is the `toHaveLength(1)` above. This is the STRUCTURAL half, and it
    // guards the smell this file's own comments name (start.js:306-307): two call sites resolving
    // one value is two owners of one decision, and the second would drift — a box naming the
    // agent the loop will run while a warning above it named a different fallback is precisely
    // the confusion #69 and #118 were both filed about.
    const code = codeWithoutComments(new URL('./start.js', import.meta.url))
    expect(code.match(/resolveAgent\(/g)).toHaveLength(1)
  })
})
