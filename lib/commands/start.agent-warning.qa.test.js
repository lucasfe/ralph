// QA #118 — the adversarial half of `ralph start`'s agent-fallback warning.
//
// lib/commands/start.agent-warning.test.js drives the five claims the issue was filed about and
// it drives them on values a user could plausibly type. This file is the sweep for values a user
// would NOT type: a 5000-character RALPH_AGENT, one control byte from every class a terminal
// obeys, astral code points sitting exactly on the registry's 200-point cap, a lone surrogate,
// and text shaped like a shell assignment or a jq program. `resolveAgent` promises the echo is
// sanitised at the source (#108) and `ralph start` deliberately declines to re-flatten it, so the
// promise is only worth what it is worth THROUGH THIS PRINTER — which is what the first group
// below measures, one code point at a time.
//
// It also does two things the dev's spec could not:
//
//   * PINS THE SINGLE-RESOLUTION INVARIANT BEHAVIOURALLY. That spec's last test counts
//     `resolveAgent(` occurrences in start.js's source with the comments stripped, which goes red
//     for a refactor that is correct and green for a second resolution spelled any other way.
//     The property it is reaching for — the identity box's agent row and the warning above the
//     splash can never name different agents — is observable on the two streams, so it is
//     asserted there instead, over a table that includes the hostile values.
//
//   * MEASURES THE PRECEDENCE AGAINST REAL BASH. `ralph start` claims to resolve at the LOOP's
//     precedence, and templates/ralph.sh gets there with `set -a` around a `.` of
//     ralph.config.sh. Every config shape below was run through a real `set -a; . file` before it
//     was written down here, so the table is a measurement rather than a reading of the parser.
//     Two rows of it FOUND A DEFECT and were red when this file landed: `parseConfigVar` cannot
//     tell "absent" from "present but blank", so the `parseConfigVar(...) || processEnv.RALPH_AGENT`
//     of the day let the environment through an assignment that in bash would have masked it. Both
//     are green now. The `||` was replaced by the presence question it could not ask —
//     `configAssignsVar(configText, 'RALPH_AGENT') ? parseConfigVar(...) : null`, then `??` onto
//     the environment — and lib/parse-config-var.js carries the bash measurement that settles it.
//
// No raw control byte is typed anywhere in this file (#107): every one is built from its code
// point, so grep, rg and git grep keep reading the file as text.

import { describe, it, expect } from 'vitest'
import { startCommand } from './start.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'

const REPO = '/repo'
const HOME = '/home/me'
const LF = String.fromCharCode(10)
const REPLACEMENT = String.fromCharCode(0xfffd)
const GRINNING = String.fromCodePoint(0x1f600)

// The registry's own bound, restated as the number this file measures against rather than
// imported: a change to DIAGNOSTIC_MAX_CHARS should fail here and be re-argued, not be absorbed.
const ECHO_MAX_POINTS = 200

/** The whole line `ralph start` writes for a raw value, given the echo the registry made of it. */
const warningFor = (echo) =>
  `⚠️  RALPH_AGENT='${echo}' unrecognized; falling back to 'claude'. Valid: claude, codex.`

// Everything in that sentence EXCEPT the echo, in code points. The cap assertions are stated as
// `BOILERPLATE + n` so they say what they mean — "the echo was allowed n code points" — instead
// of hard-coding a total that would move if the wording ever did.
const BOILERPLATE = [...warningFor('')].length

const cfg = (...lines) => ['TASK_SOURCE=folder', ...lines, ''].join(LF)

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    chunks,
    output: () => chunks.join(''),
    lines: () => {
      const text = chunks.join('')
      return text === '' ? [] : text.split(LF).slice(0, -1)
    },
  }
}

const deps = ({ isTTY, queue = 3, sessionExists = false, config = cfg(), ...overrides } = {}) => {
  const stdout = makeStream()
  if (isTTY !== undefined) stdout.isTTY = isTTY
  return {
    cwd: REPO,
    stdout,
    stderr: makeStream(),
    exec: async (cmd, args) => {
      if (cmd === 'tmux' && args[0] === 'has-session') {
        return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? config : ''),
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    currentVersion: '1.2.3',
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

/** Every stderr line about this variable. One is the promise; the count is the test. */
const agentLines = (d) => d.stderr.lines().filter((line) => line.includes('RALPH_AGENT'))

/**
 * The agent the identity box NAMES, read out of the rendered rows rather than out of a
 * return value — this is the only thing a user of `ralph start` actually sees.
 */
const boxAgent = (d) => {
  const row = d.stdout
    .output()
    .split(LF)
    .find((line) => /\bagent\s{2,}\S/.test(line))
  return row ? row.match(/\bagent\s{2,}(\S+)/)[1] : null
}

/** The agent a warning line says the run fell back TO. */
const fallbackAgent = (line) => line.match(/falling back to '([^']*)'/)?.[1] ?? null

describe('QA #118 — a hostile RALPH_AGENT cannot forge a second line on `ralph start`', () => {
  it('caps a 5000-character value at the registry bound and still launches', async () => {
    // The value that a `$(...)` in a shell profile produces when the command it ran went wrong:
    // a page of text where an agent name should be. It may cost the launch nothing and it may
    // occupy exactly one line, because the line above it is a splash and the line below it is
    // the first preflight step.
    const { d, result } = await run({ isTTY: true, processEnv: { RALPH_AGENT: 'c'.repeat(5000) } })
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    const lines = agentLines(d)
    expect(lines).toHaveLength(1)
    expect([...lines[0]]).toHaveLength(BOILERPLATE + ECHO_MAX_POINTS)
    // Truncation SAYS so, and the sentence still closes: a cap that ate the boilerplate would
    // leave a line no reader could tell from a crash.
    expect(lines[0]).toContain('…')
    expect(lines[0].endsWith("unrecognized; falling back to 'claude'. Valid: claude, codex.")).toBe(
      true,
    )
  })

  it('replaces every control class a terminal obeys, one code point for one', async () => {
    // The whole class lib/one-line.js names, each byte spelled from its code point and each one
    // in the middle of a plausible typo so the echo cannot trim it away. NUL is in here because
    // it is what makes a file `data` to grep; U+0085 NEL and U+009B CSI are in here because they
    // end a line and start a control sequence respectively and neither is in JavaScript's `\s`.
    const cases = {
      NUL: 0x00,
      BEL: 0x07,
      BS: 0x08,
      LF: 0x0a,
      CR: 0x0d,
      ESC: 0x1b,
      DEL: 0x7f,
      NEL: 0x85,
      CSI: 0x9b,
      LS: 0x2028,
      PS: 0x2029,
    }
    // stdout with no RALPH_AGENT at all, to subtract against below. A typo resolves to claude,
    // which is what an unset value resolves to, so the launch record must not move by one byte.
    const clean = deps({ isTTY: true })
    await startCommand(clean)

    for (const [name, code] of Object.entries(cases)) {
      const raw = `codx${String.fromCharCode(code)}row  forged`
      const { d, result } = await run({ isTTY: true, processEnv: { RALPH_AGENT: raw } })
      expect(result, name).toEqual({ exitCode: 0, started: true, count: 3 })
      // ONE line, and it is the whole of stderr: a value that could end a line would otherwise
      // put `row  forged` at column zero, where it reads as a row of the box below it.
      const lines = agentLines(d)
      expect(lines, name).toHaveLength(1)
      expect(d.stderr.lines(), name).toHaveLength(1)
      expect(lines[0], name).toBe(warningFor(`codx${REPLACEMENT}row  forged`))
      // One code point in, one out — the scrub is a substitution and not a strip, so the echo
      // is exactly as long as the value and the reader can see there is something there.
      expect([...lines[0]], name).toHaveLength(BOILERPLATE + [...raw].length)
      // ...and the byte itself is nowhere IN the sentence. Asserted on the line's content rather
      // than on the raw stream, because the stream's own terminator is an LF and one of the codes
      // under test IS the LF — the claim is that the VALUE cannot contribute one, not that the
      // writer stopped using them. stdout gets the same treatment by subtraction, for the same
      // reason: a splash writes ESC bytes of its own, so "no ESC on stdout" would be false for
      // every run, while "not one byte different from a run with no typo" is exactly the promise.
      expect(lines[0].includes(String.fromCharCode(code)), `${name} inside the sentence`).toBe(
        false,
      )
      expect(d.stdout.output(), `${name} on stdout`).toBe(clean.stdout.output())
    }
  })

  it('counts the cap in code points, so an astral value is neither halved nor over-trimmed', async () => {
    // 400 emoji is 800 UTF-16 units and 400 code points. A cap counted in units would slice a
    // surrogate pair in half, and half a pair has no encoding — the stream would substitute a
    // replacement mark the user never set, which is the one lie this echo may not tell.
    const { d } = await run({ isTTY: true, processEnv: { RALPH_AGENT: GRINNING.repeat(400) } })
    const [line] = agentLines(d)
    expect([...line]).toHaveLength(BOILERPLATE + ECHO_MAX_POINTS)
    expect(line).toContain(GRINNING)
    expect(line).not.toContain(REPLACEMENT)

    // ...and the boundary from the other side: 199 emoji plus a four-character tail is 203 code
    // points, so the tail is what goes and the ellipsis is what says so.
    const { d: edge } = await run({
      isTTY: true,
      processEnv: { RALPH_AGENT: `${GRINNING.repeat(199)}TAIL` },
    })
    const [edgeLine] = agentLines(edge)
    expect([...edgeLine]).toHaveLength(BOILERPLATE + ECHO_MAX_POINTS)
    expect(edgeLine).not.toContain('TAIL')
    expect(edgeLine).toContain(`${GRINNING}…'`)

    // ...and a value one code point UNDER the bound is untouched, so the cap is a bound and not
    // a formatter.
    const { d: under } = await run({
      isTTY: true,
      processEnv: { RALPH_AGENT: GRINNING.repeat(ECHO_MAX_POINTS - 1) },
    })
    const [underLine] = agentLines(under)
    expect(underLine).toBe(warningFor(GRINNING.repeat(ECHO_MAX_POINTS - 1)))
  })

  it('echoes a lone surrogate as one code point without splitting the line', async () => {
    // An ill-formed string is what a `$(...)` over a truncated UTF-8 read can leave in an
    // environment. It is not our string to repair — the echo hands back what it was given — but
    // it may not become two lines or a crash on the way.
    const lone = `codx${String.fromCharCode(0xd800)}`
    const { d, result } = await run({ isTTY: true, processEnv: { RALPH_AGENT: lone } })
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(agentLines(d)).toHaveLength(1)
    expect([...agentLines(d)[0]]).toHaveLength(BOILERPLATE + [...lone].length)
  })

  it('treats padding-plus-a-control-byte as a typo, and shows the padding', async () => {
    // The trap either way round. `resolveAgent` reads a value that TRIMS to nothing as unset, so
    // three spaces are silence — but a NUL is not whitespace to `String.trim`, so a value that
    // LOOKS blank is unrecognised and earns the line. The echo keeps both spaces, because the
    // user needs to see that the padding was not what went wrong.
    const raw = ` ${String.fromCharCode(0)} `
    const { d } = await run({ isTTY: true, processEnv: { RALPH_AGENT: raw } })
    expect(agentLines(d)).toEqual([warningFor(` ${REPLACEMENT} `)])
  })

  it('quotes a value shaped like a shell assignment or a jq program, never interprets it', async () => {
    // `ralph start` runs no shell over this value and never should, but it prints it next to a
    // launch announcement a user will paste into a bug report — so the echo has to stay inside
    // its quotes, on one line, and cost stdout nothing. The `emitShellAssignments` half of this
    // is pinned in lib/agent-invocation.warning.qa.test.js, through a real bash eval.
    const hostile = [
      `claude'; RALPH_AGENT_ARGS=(rm -rf /); echo '`,
      'codx$(touch /tmp/ralph-118-qa-pwned)',
      'codx`touch /tmp/ralph-118-qa-pwned`',
      '.[] | @sh "\\(.x)"',
      'export RALPH_RESOLVED_AGENT=codex',
    ]
    for (const value of hostile) {
      const { d, result } = await run({ isTTY: true, processEnv: { RALPH_AGENT: value } })
      expect(result, value).toEqual({ exitCode: 0, started: true, count: 3 })
      expect(agentLines(d), value).toEqual([warningFor(value)])
      expect(d.stdout.output().includes(value), value).toBe(false)
      expect(d.stdout.output(), value).not.toContain('unrecognized')
    }
  })
})

describe('QA #118 — the box row and the warning cannot disagree (behaviourally)', () => {
  it('names one agent across both streams, for every shape of value', async () => {
    // THE INVARIANT THE STRUCTURAL TEST IS REACHING FOR, asserted where a user can see it. Two
    // `resolveAgent` calls would be free to drift; what must never happen is a box announcing
    // codex under a warning announcing a fallback to claude. So: a warning implies the row says
    // exactly what the warning says it fell back to, and silence implies the row says what the
    // value resolved to. Nothing here reads start.js's source.
    const table = [
      { value: undefined, row: 'claude' },
      { value: '', row: 'claude' },
      { value: '   ', row: 'claude' },
      { value: 'claude', row: 'claude' },
      { value: 'codex', row: 'codex' },
      { value: 'CODEX', row: 'codex' },
      { value: ' codex ', row: 'codex' },
      { value: `codex${LF}`, row: 'codex' },
      { value: 'codx', row: 'claude' },
      { value: 'codex-cli', row: 'claude' },
      { value: 'c'.repeat(5000), row: 'claude' },
      { value: `codex${String.fromCharCode(27)}[2J`, row: 'claude' },
      { value: GRINNING.repeat(400), row: 'claude' },
    ]
    for (const { value, row } of table) {
      const label = JSON.stringify(value)
      const { d } = await run({ isTTY: true, processEnv: { RALPH_AGENT: value } })
      const lines = agentLines(d)
      expect(lines.length, label).toBeLessThanOrEqual(1)
      expect(boxAgent(d), label).toBe(row)
      if (lines.length === 1) {
        // A warning was printed, so the row it is about must be the fallback it names.
        expect(fallbackAgent(lines[0]), label).toBe(boxAgent(d))
      }
    }
  })

  it('warns only when the row would otherwise be a surprise', async () => {
    // The other direction, which is what makes the pair a specification rather than two facts:
    // the line appears exactly when the agent the box names is NOT the one the value asked for.
    for (const value of ['claude', 'codex', 'CODEX', ' codex ']) {
      const { d } = await run({ isTTY: true, processEnv: { RALPH_AGENT: value } })
      expect(boxAgent(d), value).toBe(value.trim().toLowerCase())
      expect(agentLines(d), value).toEqual([])
    }
    for (const value of ['codx', 'gemini', 'gpt-5']) {
      const { d } = await run({ isTTY: true, processEnv: { RALPH_AGENT: value } })
      expect(boxAgent(d), value).toBe('claude')
      expect(agentLines(d), value).toHaveLength(1)
    }
  })
})

describe('QA #118 — the config shapes, measured against the shell that sources them', () => {
  it('reads export, inline comments and a repeated declaration the way bash does', async () => {
    // Every row here was run through a real `set -a; . file; set +a` before it was written down.
    // `# RALPH_AGENT=codx` is the one that matters most: commenting a knob out is how a user
    // BACKS OUT of a typo, and a parser that still saw it would leave them unable to.
    const table = [
      { line: 'export RALPH_AGENT=codx', warns: 'codx' },
      { line: 'RALPH_AGENT=codx # left over from a test', warns: 'codx' },
      { line: 'RALPH_AGENT="codx" # left over from a test', warns: 'codx' },
      { line: '   RALPH_AGENT="codx"   ', warns: 'codx' },
      { line: "RALPH_AGENT='codx'", warns: 'codx' },
      { line: '# RALPH_AGENT=codx', warns: null },
      { line: 'RALPH_AGENT="   "', warns: null },
      { line: 'RALPH_AGENTX=codx', warns: null },
    ]
    for (const { line, warns } of table) {
      const { d } = await run({ isTTY: true, config: cfg(line) })
      expect(agentLines(d), line).toEqual(warns === null ? [] : [warningFor(warns)])
    }

    // The LAST uncommented assignment wins, in this parser and in the shell. A user who added a
    // second line rather than editing the first is told about the value that will actually run.
    const { d: last } = await run({
      isTTY: true,
      config: cfg('RALPH_AGENT="codx"', 'RALPH_AGENT="codex"'),
    })
    expect(agentLines(last)).toEqual([])
    const { d: lastTypo } = await run({
      isTTY: true,
      config: cfg('RALPH_AGENT="codex"', 'RALPH_AGENT="codx"'),
    })
    expect(agentLines(lastTypo)).toEqual([warningFor('codx')])
  })

  it('stays silent when the config BLANKS the agent, because the loop will too', async () => {
    // MEASURED, not reasoned: `set -a; . file` over a file containing `RALPH_AGENT=""` leaves
    // RALPH_AGENT empty in the loop's environment even when the caller exported `codx`, because
    // an assignment to the empty string is still an assignment. The loop therefore resolves
    // claude with NO fallback and says nothing at all.
    //
    // The transcript is in lib/parse-config-var.js, above `configAssignsVar`, which is the one
    // copy of it — the shell's answer belongs with the function that models the shell.
    //
    // THIS ROW FOUND A DEFECT and was red when it was written. `ralph start` reads that file with
    // `parseConfigVar`, which answers '' for BOTH "no such assignment" and "assigned the empty
    // string" — so the `parseConfigVar(...) || processEnv.RALPH_AGENT` it used fell through to an
    // environment the loop had already masked, and warned about a typo that changes nothing. That
    // is precisely the trade the implementation's own comment ruled out two paragraphs from the
    // expression that made it: "warning about a value the run will not use is worse than silence."
    // Fixed by asking presence separately (`configAssignsVar`), which is what keeps it green.
    for (const line of ['RALPH_AGENT=""', "RALPH_AGENT=''", 'RALPH_AGENT=', 'export RALPH_AGENT=']) {
      const { d } = await run({
        isTTY: true,
        config: cfg(line),
        processEnv: { RALPH_AGENT: 'codx' },
      })
      expect(agentLines(d), line).toEqual([])
    }
  })

  it('names the agent the loop will run when the config BLANKS a valid environment value', async () => {
    // The mirror of the row above and the more expensive half, because it is the box rather than
    // a diagnostic. Same measurement, same cause: with `RALPH_AGENT=""` in ralph.config.sh the
    // loop runs CLAUDE whatever the environment said, so a box reading `codex` is naming an
    // agent that will not run — the exact confusion #69 was filed to end.
    //
    // This one predated #118 (the `||` was #69's), and #118 inherited it by resolving the warning
    // through the same expression — which is why both symptoms ended with one fix: reading the
    // config value with a PRESENT/ABSENT answer rather than a truthiness test. That is what
    // `configAssignsVar` is, and this row is the half of it the user can see.
    const { d } = await run({
      isTTY: true,
      config: cfg('RALPH_AGENT=""'),
      processEnv: { RALPH_AGENT: 'codex' },
    })
    expect(boxAgent(d)).toBe('claude')
  })
})

describe('QA #118 — the diagnostic outlives every abort below it', () => {
  it('prints before an aborting gh auth check, several preflight steps down', async () => {
    // The tmux abort the dev's spec uses is the step directly below the warning. This one is
    // four steps further on and on the other side of the banner, the update check and the
    // .env.local read — so it pins the ORDER rather than a single neighbour, and it is the abort
    // an unattended cron launch actually hits when a token expires overnight.
    const d = deps({
      isTTY: true,
      config: [`TASK_SOURCE=github`, 'RALPH_AGENT="codx"', ''].join(LF),
      exec: async (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'has-session') {
          return { exitCode: 1, stdout: '', stderr: '' }
        }
        if (cmd === 'gh' && args[0] === 'auth') return { exitCode: 1, stdout: '', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    await expect(startCommand(d)).rejects.toMatchObject({ exitCode: 1 })
    expect(agentLines(d)).toEqual([warningFor('codx')])
    expect(d.stderr.output()).toContain('gh not authenticated')
    // ...and in that ORDER: the diagnostic is the first thing on the stream, so a reader whose
    // terminal only kept the last screen still has it above the error.
    expect(d.stderr.lines()[0]).toBe(warningFor('codx'))
  })

  it('prints on a piped stdout, where the launch record is a file', async () => {
    // No TTY: no sprite, no animation, and the box printed in plain text. The diagnostic is not
    // decoration, so it survives — and stdout is still byte-identical to the run with no typo,
    // which is what makes `ralph start > start.log` a record rather than a diagnostic.
    const typo = deps({ config: cfg('RALPH_AGENT="codx"') })
    const clean = deps()
    await startCommand(typo)
    await startCommand(clean)
    expect(typo.stdout.output()).toBe(clean.stdout.output())
    expect(agentLines(typo)).toEqual([warningFor('codx')])
    expect(clean.stderr.output()).toBe('')
  })
})
