import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Volume } from 'memfs'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { execa } from 'execa'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { initCommand, InitAbort } from './commands/init.js'
// #133: the JS-side reader of the file init writes. Half of every measurement below
// is "and this parser agrees with bash about the line", so it is imported rather than
// re-implemented.
import { parseConfigVar, configAssignsVar } from './parse-config-var.js'
// #133 QA: the REAL prompt seam, driven directly in the reachability block below.
// Which bytes a value can even CONTAIN is decided here, by readline, and a claim about
// "what a user could plausibly type" is only worth making if it was measured against
// the thing that reads the keyboard.
import { promptValue as realPromptValue } from './utils/prompt.js'

// QA augmentation for #565. The dev's init.test.js locks the source-selection
// happy paths. These attack idempotency (re-running init must not clobber real
// tasks) and the flag/prompt precedence guards under adversarial input.

const PROJECT = '/project'

function makeStream() {
  const chunks = []
  return { write: (s) => (chunks.push(s), true), output: () => chunks.join('') }
}

function makeExec() {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    if (key === 'git rev-parse --show-toplevel') return { exitCode: 0, stdout: PROJECT, stderr: '' }
    if (key === 'git symbolic-ref refs/remotes/origin/HEAD')
      return { exitCode: 0, stdout: 'refs/remotes/origin/main', stderr: '' }
    if (key === 'git branch -a') return { exitCode: 0, stdout: '* main\n', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

function newVol() {
  const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
  return vol
}

function run(vol, opts = {}) {
  return initCommand({
    cwd: PROJECT,
    stdout: makeStream(),
    stderr: opts.stderr ?? makeStream(),
    exec: makeExec(),
    fs: vol,
    ...opts,
  })
}

describe('initCommand — folder scaffold idempotency (#565 QA)', () => {
  it('running init --source folder twice does not crash and keeps existing tasks', async () => {
    const vol = newVol()
    await run(vol, { source: 'folder' })
    // Simulate a real queued task the author added after the first init.
    vol.writeFileSync(`${PROJECT}/.ralph/tasks/afk/todo/001-real-task.md`, 'do the thing')

    // Second init must not throw and must not clobber the task file.
    const result = await run(vol, { source: 'folder' })
    expect(result.exitCode).toBe(0)
    expect(vol.existsSync(`${PROJECT}/.ralph/tasks/afk/todo/001-real-task.md`)).toBe(true)
    expect(vol.readFileSync(`${PROJECT}/.ralph/tasks/afk/todo/001-real-task.md`, 'utf8')).toBe(
      'do the thing',
    )
  })

  it('all five lane dirs exist after scaffold', async () => {
    const vol = newVol()
    await run(vol, { source: 'folder' })
    for (const d of [
      'afk/todo',
      'afk/in-progress',
      'afk/done',
      'afk/failed',
      'hitl/todo',
    ]) {
      expect(vol.existsSync(`${PROJECT}/.ralph/tasks/${d}`)).toBe(true)
    }
  })

  it('a whitespace-only --source is not a typo — falls through to the github default', async () => {
    const vol = newVol()
    const result = await run(vol, { source: '   ', isTTY: false })
    expect(result.source).toBe('github')
    expect(vol.existsSync(`${PROJECT}/.ralph/tasks`)).toBe(false)
  })

  it('rejects an invalid --source with a nonzero abort BEFORE any file writes', async () => {
    const vol = newVol()
    const stderr = makeStream()
    let caught
    try {
      await run(vol, { source: 'GitLab', stderr })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InitAbort)
    expect(caught.exitCode).toBe(1)
    // Nothing was written — the guard runs before writeConfig.
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
    expect(vol.existsSync(`${PROJECT}/.ralph/tasks`)).toBe(false)
  })

  it('--source folder beats a would-be interactive prompt (flag wins, prompt not called)', async () => {
    const vol = newVol()
    let prompted = false
    const result = await run(vol, {
      source: 'folder',
      isTTY: true,
      ask: async () => false,
      promptAgent: async () => 'claude',
      promptSource: async () => {
        prompted = true
        return 'github'
      },
    })
    expect(prompted).toBe(false)
    expect(result.source).toBe('folder')
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#108) — the parts of `ralph init`'s echo nobody drove.
//
// init.test.js's own #108 block covers the four sentences: the `⚠️` fallback out of resolveAgent
// on the prompt path, the terminal-instruction class on that same path, and the two hard
// `❌ Unknown <thing> '<flag>'` rejections. What it does not cover is everything AROUND those
// sentences, and each of the three gaps below is load-bearing for a claim the fix makes:
//
//   * THE RAW VALUE IS STILL THROWN. `init.js` deliberately keeps the unsanitised value in
//     `InitAbort.message`, with a comment justifying it by what bin/ralph.js does with the
//     exception. That justification is a claim about ANOTHER FILE, and nothing checked it. If
//     bin/ralph.js ever prints the message, the sanitiser is bypassed by the very path #108 was
//     filed about — so the claim is pinned here structurally, against bin/ralph.js's source.
//   * THE FLAG IS NOT NECESSARILY A STRING. `initCommand` is an exported function whose flags
//     are options in a bag (#41), and its guard interpolates `agentFlag` into a sentence.
//     Commander hands over a string; a programmatic caller need not.
//   * INIT ECHOES SOMETHING ELSE ENTIRELY. `setupWhatsApp` prints `WHATSAPP_PHONE: <value>`
//     read out of ~/.config/ralph/.env, and that echo is NOT sanitised. It is the only other
//     place in this command where a value the user supplied reaches a stream verbatim, and
//     #108's criterion 1 is about `ralph init` as a whole rather than about two of its lines.
//
// Control characters are built from their code points, never typed (#107).
// ---------------------------------------------------------------------------

describe('initCommand — the #108 echo, everywhere else it happens', () => {
  const LF = String.fromCharCode(0x0a)
  const NUL = String.fromCharCode(0x00)
  const ESC = String.fromCharCode(0x1b)
  const PLACEHOLDER = String.fromCharCode(0xfffd)
  const HOME = '/home/test'
  const GLOBAL = join(HOME, '.config', 'ralph', '.env')

  function harness(overrides = {}, seedGlobal) {
    const seed = { [`${PROJECT}/.keep`]: '' }
    if (seedGlobal != null) seed[GLOBAL] = seedGlobal
    const vol = Volume.fromJSON(seed, '/')
    const stdout = makeStream()
    const stderr = makeStream()
    const run = () =>
      initCommand({
        cwd: PROJECT,
        stdout,
        stderr,
        exec: makeExec(),
        fs: vol,
        isTTY: false,
        home: HOME,
        processEnv: {},
        // Decline every gate rather than letting `confirm` reach the suite's stdin, and
        // answer every free-text prompt blank so the #133 source picker (which is built on
        // `promptValue`) does not reach it either on the cases that flip isTTY on. Blank at
        // that picker means github.
        ask: async () => false,
        promptValue: async () => '',
        ...overrides,
      })
    const errLines = () => stderr.output().split(LF).filter(Boolean)
    const outLines = () => stdout.output().split(LF)
    return { vol, stdout, stderr, errLines, outLines, run }
  }

  describe('the abort carries the RAW value, and nothing prints it', () => {
    it('keeps the unsanitised agent value on InitAbort.message', async () => {
      // DELIBERATE, per init.js's own comment: a programmatic caller catching the abort wants
      // the value AS GIVEN rather than our rendering of it, and the guarantee belongs to what
      // reaches a terminal. Pinned rather than assumed, because it is the one place in this
      // command where the raw bytes still exist after the fix — a future reader who "finished
      // the job" by sanitising the message too would silently break the contract for a caller,
      // and a future reader who printed the message would silently break #108.
      const hostile = `codex${LF}✅ Ralph is ready`
      const { run } = harness({ agent: hostile })
      const caught = await run().catch((e) => e)
      expect(caught).toBeInstanceOf(InitAbort)
      expect(caught.message).toBe(`unknown agent '${hostile}'`)
      expect(caught.message.split(LF)).toHaveLength(2)
      expect(caught.exitCode).toBe(1)
    })

    it('keeps the unsanitised source value on InitAbort.message too', async () => {
      const hostile = `folder${LF}✅ Ralph is ready`
      const { run } = harness({ source: hostile })
      const caught = await run().catch((e) => e)
      expect(caught).toBeInstanceOf(InitAbort)
      expect(caught.message).toBe(`unknown task source '${hostile}'`)
      expect(caught.exitCode).toBe(1)
    })

    it('and bin/ralph.js reads only the exit code off it — checked against bin/ralph.js', async () => {
      // THE CLAIM THE COMMENT MAKES ABOUT ANOTHER FILE. `InitAbort.message` is only safe to
      // leave raw for as long as nothing prints it, and that is a property of bin/ralph.js, not
      // of init.js — so it is asserted where it can be: on bin/ralph.js's source, with comments
      // stripped. The handler reads `e.exitCode` and re-throws anything that is not an
      // InitAbort, so the raw value never reaches a stream by this route.
      const BIN = fileURLToPath(new URL('../bin/ralph.js', import.meta.url))
      const code = codeWithoutComments(BIN)
      expect(code).toContain('e instanceof InitAbort')
      expect(code).toContain('process.exit(e.exitCode ?? 1)')
      // SCOPED TO THE HANDLER, not to the file. bin/ralph.js has fifteen `catch` blocks for
      // fifteen commands, and the first unrelated one that legitimately does `err(e.message)`
      // would otherwise fail this test with a message about #108's InitAbort — a trap for a
      // reader who touched neither. The claim is unchanged: nothing in the block that catches an
      // InitAbort reads its message. Anchored on the `instanceof` line and cut at the `throw e`
      // that ends the block.
      const handler = code.slice(
        code.indexOf('e instanceof InitAbort'),
        code.indexOf('throw e', code.indexOf('e instanceof InitAbort')),
      )
      expect(handler).not.toMatch(/\.message/)
      // ANTI-VACUITY: a bad path, an over-eager comment strip or an anchor that stopped matching
      // would make the negative above pass for free. The positives are the guard against that,
      // plus the words the file must still contain.
      expect(handler).toContain('process.exit(e.exitCode ?? 1)')
      expect(handler.length).toBeGreaterThan(20)
      expect(handler.length).toBeLessThan(code.length)
      expect(code.length).toBeGreaterThan(1000)
      expect(code).toContain('initCommand')
    })
  })

  describe('a flag is a value in a bag, and a bag holds anything', () => {
    // `initCommand({ agent })` is an exported option (#41). Commander gives a string; the five
    // other callers in the repo's tests and any programmatic embedder need not.
    const COERCIBLE = {
      'a number': [7, "'7'"],
      'an array': [['codx', 'claude'], "'codx,claude'"],
      'a plain object': [{}, "'[object Object]'"],
      'a toString carrying a newline': [
        { toString: () => `codx${LF}✅ Ralph is ready` },
        `'codx${PLACEHOLDER}✅ Ralph is ready'`,
      ],
    }

    for (const [label, [value, echoed]] of Object.entries(COERCIBLE)) {
      it(`rejects ${label} on ONE line, echoed and sanitised, writing nothing`, async () => {
        const { vol, errLines, run } = harness({ agent: value })
        const caught = await run().catch((e) => e)
        expect(caught, label).toBeInstanceOf(InitAbort)
        expect(caught.exitCode, label).toBe(1)
        expect(errLines(), label).toHaveLength(1)
        expect(errLines()[0], label).toBe(
          `❌ Unknown agent ${echoed}. Valid agents: claude, codex.`,
        )
        // #560's promise, unchanged by any of this: the guard runs before the first write.
        expect(vol.existsSync(`${PROJECT}/ralph.config.sh`), label).toBe(false)
      })
    }

    it('documents the gap: a flag whose coercion throws escapes as a plain Error', async () => {
      // NOT an InitAbort, which means bin/ralph.js's handler re-throws it and the process dies
      // with a stack trace rather than with exit code 1. The throw is on the guard's own
      // `String(agentFlag).trim()`, before `oneLineEcho`, so no hardening of the sanitiser would
      // change it — the same shape as the gap in resolveAgent (see
      // lib/agent-registry.warning.qa.test.js). Only reachable programmatically; pinned so the
      // boundary of "one line per warning, whatever it contains" is written down: it covers
      // every value that can BE a string, and a value that cannot never gets as far as a line.
      const { vol, errLines, run } = harness({
        agent: { toString: () => { throw new Error('nope') } },
      })
      const caught = await run().catch((e) => e)
      expect(caught).toBeInstanceOf(Error)
      expect(caught).not.toBeInstanceOf(InitAbort)
      expect(caught.message).toBe('nope')
      expect(errLines()).toEqual([])
      expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
    })

    it('puts no character on stderr that the flag did not contain', async () => {
      // THE DEFECT THIS CLOSED, on init's own sentence rather than on resolveAgent's.
      // `oneLineEcho` used to cap with `text.slice(0, 199)`, which slices UTF-16 CODE UNITS — and
      // an emoji is two of them — so a 200-emoji flag was cut between the halves of a surrogate
      // pair and the rejection line ended with a lone high surrogate. That string has no UTF-8
      // encoding, so Node substituted U+FFFD on the way out and the message showed an
      // unprintable-character mark the user's value never contained. `cap` now counts and slices
      // code points (`[...text]`), the spelling lib/banner-compose.js's `clip` already used.
      //
      // Pinned HERE as well as in lib/one-line.qa.test.js and
      // lib/commands/doctor.agent-warning.qa.test.js because this is a THIRD code path — init's
      // own `❌` sentence, which resolveAgent has nothing to do with — and stderr is what a
      // wrapper script greps. The one fix inside `cap()` closed all three; a fix applied at
      // resolveAgent would have left this one red, which is exactly the distinction criterion 3
      // is about.
      const emoji = String.fromCodePoint(0x1f600)
      const { errLines, stderr, run } = harness({ agent: emoji.repeat(200) })
      const caught = await run().catch((e) => e)
      expect(caught).toBeInstanceOf(InitAbort)
      expect(errLines()).toHaveLength(1)
      expect(stderr.output().isWellFormed()).toBe(true)
      const wire = Buffer.from(stderr.output(), 'utf8').toString('utf8')
      const marks = (text) => [...text].filter((c) => c === PLACEHOLDER).length
      expect(marks(wire)).toBe(marks(stderr.output()))
    })
  })

  describe('the OTHER value init echoes: the stored WhatsApp phone', () => {
    // The only other place in this command where something a user supplied reaches a stream
    // verbatim. It is read out of ~/.config/ralph/.env — a file `ralph init` itself writes from
    // a free-text prompt, and one a user hand-edits — and printed by `out()` with no sanitiser
    // between. #108's criterion 1 is about what `ralph init` can be made to emit, so this echo
    // is inside the blast radius even though the issue was reported about the agent warning.

    it('cannot be made to emit a second line, because the env parser is line-based', async () => {
      // THE REASON THIS IS NOT A CRITERION-1 FAILURE, and it is worth writing down rather than
      // leaving as a coincidence: `parseEnvFile` (lib/utils/env.js) splits on newlines and trims
      // each value, so a stored value CANNOT contain LF or CR — a second line in the file is a
      // second variable, not a continuation. The one-line guarantee therefore holds here by
      // construction, from a completely different mechanism than the sanitiser.
      const forged = [
        'WHATSAPP_PHONE=+15551234567',
        'CALLMEBOT_KEY=abcdef',
        '',
      ].join(LF)
      const { outLines, run } = harness({ isTTY: true }, forged)
      const result = await run()
      const echo = outLines().filter((l) => l.startsWith('  WHATSAPP_PHONE:'))
      expect(echo).toEqual(['  WHATSAPP_PHONE: +15551234567'])
      expect(result.exitCode).toBe(0)
    })

    it('DOES echo a stored ESC or NUL raw — an unsanitised echo, documented not asserted-safe', async () => {
      // A RESIDUAL, pinned as the behaviour it is rather than as a promise. A value can hold
      // every C0 character except LF and CR, and this echo passes them straight through: the
      // assertion below is that the raw bytes ARRIVE, which is the honest statement of today's
      // behaviour and a test that will fail loudly the day somebody sanitises it — at which
      // point the failure is the notification, and the fix is to flip this expectation.
      //
      // Why it is not a #108 defect: it cannot forge a LINE (see above), and it predates this
      // issue by every release since #5. Why it is worth a human's attention anyway: an ESC
      // reaching a terminal from a `ralph init` run is the same class of hazard #108 closed one
      // door on, and this door is next to it. The value it can reach is bounded by what a user
      // put in their own global config, so there is no cross-user exposure.
      const stored = `+1555${ESC}[2J${NUL}x`
      const { stdout, outLines, run } = harness({ isTTY: true }, `WHATSAPP_PHONE=${stored}${LF}`)
      const result = await run()
      // One line, as promised above...
      const echo = outLines().filter((l) => l.startsWith('  WHATSAPP_PHONE:'))
      expect(echo).toHaveLength(1)
      // ...and the raw bytes are in it, unlike every value that goes through oneLineEcho.
      expect(echo[0]).toBe(`  WHATSAPP_PHONE: ${stored}`)
      expect(stdout.output()).toContain(ESC)
      expect(stdout.output()).toContain(NUL)
      expect(result.exitCode).toBe(0)
    })
  })

  describe('exit codes, on every path #108 touched', () => {
    it('a sanitised fallback warning still exits 0 and still writes claude', async () => {
      // The soft path: a stray keystroke at the prompt must never abort an unattended run, and
      // the sanitiser is not allowed to have changed that. `⚠️` on stderr, config on disk,
      // exit 0.
      const { vol, errLines, run } = harness({
        isTTY: true,
        promptAgent: async () => `codx${NUL}`,
      })
      const result = await run()
      expect(errLines()).toHaveLength(1)
      expect(errLines()[0]).toContain(`RALPH_AGENT='codx${PLACEHOLDER}' unrecognized`)
      expect(result.exitCode).toBe(0)
      expect(result.agent).toBe('claude')
      expect(vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')).toContain(
        'RALPH_AGENT="claude"',
      )
    })

    it('a prompt answer that trims to a real agent warns about nothing', async () => {
      // The path the sanitiser is NOT on: resolveAgent trims before it looks up, so a value
      // wrapped in newlines resolves cleanly. Pinned so a future "sanitise at the door" change
      // cannot start warning about values that are not typos — and note that the value written
      // to ralph.config.sh is the RESOLVED one, so nothing hostile reaches the file either.
      const { vol, errLines, run } = harness({
        isTTY: true,
        promptAgent: async () => `${LF}codex${LF}`,
      })
      const result = await run()
      expect(errLines()).toEqual([])
      expect(result.agent).toBe('codex')
      expect(result.exitCode).toBe(0)
      expect(vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')).toContain(
        'RALPH_AGENT="codex"',
      )
    })

    it('writes only the RESOLVED agent to ralph.config.sh, never the hostile value', async () => {
      // The file is sourced by a shell. A raw value reaching it would be a much worse problem
      // than a forged terminal line, and the reason it cannot is that `writeConfig` interpolates
      // `agent` — resolveAgent's output — rather than the choice. Never pinned; pinning it now,
      // because #108 is the issue that made everyone look at where this value travels.
      const { vol, run } = harness({ isTTY: true, promptAgent: async () => `codx${LF}rm -rf /` })
      const result = await run()
      const config = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
      expect(config).toContain('RALPH_AGENT="claude"')
      expect(config).not.toContain('codx')
      expect(config).not.toContain('rm -rf /')
      expect(result.exitCode).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// QA augmentation for #125 — `ralph init --source jira`.
//
// The dev's init.test.js proves the happy path and one uppercase variant. What is
// left is the boundary either side of it, and one property that is easy to lose:
//
//   THE VALUE REACHES A FILE A SHELL WILL SOURCE, quoted, exactly once, and
//   normalized — `--source JIRA` must not write `TASK_SOURCE="JIRA"`, because
//   resolveSource lower-cases at read time and a config file that only works
//   because the reader is forgiving is a config file nobody can copy.
//
//   A NEAR-MISS IS REJECTED HARD, before any write, with the registry's own list
//   in the sentence. `jira` and `jiras` are one keystroke apart, and the flag is
//   where a typo is worth an error rather than a silent github fallback.
//
//   JIRA MODE SCAFFOLDS NOTHING. The `.ralph/tasks/` tree is folder mode's
//   mechanism; a jira repo that grew one would have an empty queue nobody reads.
//
// Every run injects fs (memfs), exec, home and processEnv, so nothing here
// touches the real filesystem or ~/.config/ralph.
// ---------------------------------------------------------------------------

describe('initCommand — --source jira (#125 QA)', () => {
  const HOME = '/home/test'
  const LF = String.fromCharCode(0x0a)
  const TAB = String.fromCharCode(0x09)

  const initWith = (vol, opts = {}) =>
    run(vol, {
      isTTY: false,
      home: HOME,
      processEnv: {},
      ask: async () => false,
      // #133 gave a jira init two free-text prompts of its own, so the one case below
      // that runs with a TTY needs this seam injected or it reads the suite's stdin.
      // Blank takes each documented default.
      promptValue: async () => '',
      ...opts,
    })

  const configOf = (vol) => vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')

  it('normalizes every spelling of the flag to TASK_SOURCE="jira"', async () => {
    for (const source of ['jira', 'JIRA', 'Jira', 'JiRa', '  jira  ', `${LF}${TAB}jira ${LF}`]) {
      const vol = newVol()
      const result = await initWith(vol, { source })
      expect(result.source, source).toBe('jira')
      const lines = configOf(vol).split(LF)
      // The exact LINE, not a substring: quoted, lower-cased, and one of them.
      expect(lines.filter((l) => l.startsWith('TASK_SOURCE=')), source).toEqual([
        'TASK_SOURCE="jira"',
      ])
      // ...and the uppercase spelling leaks NOWHERE ELSE either — not into a comment,
      // not into a second interpolation. The legitimate `JIRA`s in the template are the
      // variable NAMES it declares — `JIRA_JQL` since #126 and `JIRA_DONE_STATUS` since
      // #129 — so those identifiers are removed before looking; anything else uppercase
      // is the flag text escaping.
      const withoutKnobs = ['JIRA_JQL', 'JIRA_DONE_STATUS'].reduce(
        (text, knob) => text.split(knob).join(''),
        configOf(vol),
      )
      expect(withoutKnobs, source).not.toContain('JIRA')
    }
  })

  it('writes a BYTE-IDENTICAL config whatever spelling of the flag was used', async () => {
    // The un-narrowed form of the test above, and the reason it is worth having as well as
    // (not instead of) that one. Since #126 the template legitimately contains the identifier
    // `JIRA_JQL`, so the blanket `not.toContain('JIRA')` had to start ignoring that substring
    // — and an assertion that ignores a substring can no longer see a leak SPELLED with it.
    // A template line built as `${source}_JQL=""` would render `JIRA_JQL=""` for
    // `--source JIRA` and `jira_JQL=""` for `--source jira`, and the narrowed assertion is
    // blind to exactly that.
    //
    // Comparing the whole file across every spelling needs no allowlist and grows with the
    // template: normalization means the flag's letters cannot influence a single byte of what
    // is written, whichever line they would have reached.
    const canonical = await (async () => {
      const vol = newVol()
      await initWith(vol, { source: 'jira' })
      return configOf(vol)
    })()
    for (const source of ['JIRA', 'Jira', 'JiRa', '  jira  ', `${LF}${TAB}jira ${LF}`]) {
      const vol = newVol()
      await initWith(vol, { source })
      expect(configOf(vol), source).toBe(canonical)
    }
    // Anti-vacuity: the file really does mention the jira knobs, so this is a comparison of
    // content and not of two empty strings.
    expect(canonical).toContain('TASK_SOURCE="jira"')
    expect(canonical).toContain('JIRA_JQL=')
  })

  it('leaves no placeholder unfilled anywhere in the written config', async () => {
    // Stronger than "no {{TASK_SOURCE}}": the whole rendered file must carry no
    // mustache at all, so a template that grows a placeholder init does not
    // interpolate fails here rather than in a user's shell.
    const vol = newVol()
    await initWith(vol, { source: 'jira' })
    expect(configOf(vol)).not.toContain('{{')
    expect(configOf(vol)).not.toContain('}}')
  })

  it('rejects a near-miss hard, listing all three sources, before any write', async () => {
    for (const source of ['jiras', 'jra', 'jirra', 'jira/', 'jira,folder', 'atlassian', 'acli']) {
      const vol = newVol()
      const stderr = makeStream()
      const caught = await initWith(vol, { source, stderr }).catch((e) => e)
      expect(caught, source).toBeInstanceOf(InitAbort)
      expect(caught.exitCode, source).toBe(1)
      expect(stderr.output().split(LF).filter(Boolean), source).toEqual([
        `❌ Unknown task source '${source}'. Valid sources: github, folder, jira.`,
      ])
      // Nothing written, nothing scaffolded — the guard runs before writeConfig.
      expect(vol.existsSync(`${PROJECT}/ralph.config.sh`), source).toBe(false)
      expect(vol.existsSync(`${PROJECT}/.ralph`), source).toBe(false)
    }
  })

  it('scaffolds no task tree and writes the same PROMPT.md as a github run', async () => {
    // Two claims in one, because they are the same claim: jira mode is github mode
    // minus gh plus acli, and NOTHING about the local folder-queue mechanism.
    const jiraVol = newVol()
    await initWith(jiraVol, { source: 'jira' })
    expect(jiraVol.existsSync(`${PROJECT}/.ralph`)).toBe(false)
    expect(jiraVol.existsSync(`${PROJECT}/.ralph/tasks`)).toBe(false)

    const githubVol = newVol()
    await initWith(githubVol, { source: 'github' })
    expect(jiraVol.readFileSync(`${PROJECT}/PROMPT.md`, 'utf8').toString()).toBe(
      githubVol.readFileSync(`${PROJECT}/PROMPT.md`, 'utf8').toString(),
    )
    // ...and the two configs differ in exactly three lines: the source, and — since #133
    // — the two Jira knobs a jira init fills and a github init leaves empty. Every other
    // byte of the file is the same, which is the statement that jira mode is github mode
    // minus gh plus acli.
    const diff = (a, b) => a.split(LF).filter((l, i) => l !== b.split(LF)[i])
    expect(diff(configOf(jiraVol), configOf(githubVol))).toEqual([
      'TASK_SOURCE="jira"',
      `JIRA_JQL='assignee = currentUser() AND status NOT IN ("Done", "Closed", "Resolved", "Canceled")'`,
      'JIRA_DONE_STATUS="Done"',
    ])
    expect(diff(configOf(githubVol), configOf(jiraVol))).toEqual([
      'TASK_SOURCE="github"',
      'JIRA_JQL=""',
      'JIRA_DONE_STATUS=""',
    ])
  })

  it('the flag beats the interactive prompt — promptSource is never called', async () => {
    const vol = newVol()
    let prompted = false
    const result = await initWith(vol, {
      source: 'jira',
      isTTY: true,
      promptAgent: async () => 'claude',
      promptSource: async () => {
        prompted = true
        return 'github'
      },
    })
    expect(prompted).toBe(false)
    expect(result.source).toBe('jira')
  })

  it('echoes the resolved source in the summary', async () => {
    const vol = newVol()
    const stdout = makeStream()
    await initWith(vol, { source: '  JIRA  ', stdout })
    expect(stdout.output()).toContain('TASK_SOURCE:  jira')
    expect(stdout.output()).not.toContain('TASK_SOURCE:  JIRA')
  })

  it('the SHIPPED template documents jira and keeps its placeholder intact', async () => {
    // Read off disk rather than through a run, because this is a claim about the
    // artifact in the package: the comment above TASK_SOURCE is the only
    // documentation a user of a scaffolded repo has in front of them, and a value
    // the resolver accepts but the comment does not name is a value nobody finds.
    const TEMPLATE = fileURLToPath(new URL('../templates/ralph.config.sh', import.meta.url))
    const text = readFileSync(TEMPLATE, 'utf8')
    const lines = text.split(LF)
    expect(lines.filter((l) => l.startsWith('TASK_SOURCE='))).toEqual([
      'TASK_SOURCE="{{TASK_SOURCE}}"',
    ])
    const comment = text.slice(text.indexOf('# Task source'), text.indexOf('TASK_SOURCE="'))
    for (const value of ['"github"', '"folder"', '"jira"']) {
      expect(comment).toContain(value)
    }
    // What a jira run needs, which is the whole point of the slice.
    expect(comment).toContain('acli')
    expect(comment).toContain('acli jira auth login')
    expect(comment).toContain('ralph doctor')
    // Every comment line is a comment line — an unquoted prose line in a file a
    // shell sources would be executed.
    for (const line of comment.split(LF).filter(Boolean)) {
      expect(line.startsWith('#'), line).toBe(true)
    }
    // Placeholder parity: the template asks for exactly the ten vars init fills — eight
    // since #565, plus the two Jira knobs #133 turned from hardcoded empty literals into
    // interpolated ones.
    expect([...new Set(text.match(/\{\{[A-Z_]+\}\}/g))].sort()).toEqual([
      '{{DEV_BRANCH}}',
      '{{INSTALL_CMD}}',
      '{{JIRA_DONE_STATUS}}',
      '{{JIRA_JQL}}',
      '{{LINT_CMD}}',
      '{{MAIN_BRANCH}}',
      '{{PR_TARGET}}',
      '{{RALPH_AGENT}}',
      '{{TASK_SOURCE}}',
      '{{TEST_CMD}}',
    ])
  })
})

// ---------------------------------------------------------------------------
// QA augmentation for #133 — the three-way picker, and the QUOTING of the two
// Jira knobs init now writes.
//
// The dev's init.test.js proves the picker's three answers, the defaults, and that
// the values round-trip through `parseConfigVar`. What is left is the half that
// cannot be settled inside this process:
//
//   THE EMITTED LINE HAS TWO READERS, AND THEY ARE NOT THE SAME PARSER. The bash
//   loop SOURCES ralph.config.sh (`set -a; . ralph.config.sh`), and `ralph cycle`
//   / `ralph status` read JIRA_JQL out of it with `parseConfigVar` without
//   sourcing anything. A line only one of them reads correctly is a config that
//   works in one command and silently misbehaves in the other — and for JIRA_JQL
//   the misbehaviour is invisible: `queueCount` reports 0 for anything that is not
//   a provable count (see lib/jira-queue.js), so a query Jira rejects reads as a
//   queue of depth 0, which reads as "nothing to do".
//
//   THE DEFAULT JQL CONTAINS DOUBLE QUOTES, so the `VAR="{{VALUE}}"` shape every
//   other knob in the template uses is BROKEN for it — in two ways this file
//   MEASURES rather than asserts (see "why the rule exists" below): bash silently
//   drops the value's own quotes, and a quoted literal containing a space leaves
//   the variable unset. Which quote character is correct is therefore a property
//   of the value, decided per value and measured against a real bash — the same
//   evidence style lib/parse-config-var.qa.test.js uses, and for the same file.
//
// Every row below is run through a real `bash` and through `parseConfigVar`, and
// the one shape the two disagree about is pinned as the behaviour it is.
// ---------------------------------------------------------------------------

describe('initCommand — the Jira knobs, measured against a real bash (#133 QA)', () => {
  const HOME = '/home/test'
  const LF = String.fromCharCode(0x0a)
  const NUL = String.fromCharCode(0x00)
  const DEFAULT_JQL =
    'assignee = currentUser() AND status NOT IN ("Done", "Closed", "Resolved", "Canceled")'

  // Run init interactively with a queue of prompt answers, and hand back the config
  // it wrote plus the questions it asked. Nothing touches real stdin: promptValue is
  // the injected seam, and the WhatsApp gate is declined through `ask`.
  function initInteractively({ answers = [], ...overrides } = {}) {
    const vol = newVol()
    const stdout = makeStream()
    const questions = []
    const queue = [...answers]
    return initCommand({
      cwd: PROJECT,
      stdout,
      stderr: makeStream(),
      exec: makeExec(),
      fs: vol,
      isTTY: true,
      home: HOME,
      processEnv: {},
      ask: async () => false,
      promptAgent: async () => 'claude',
      promptValue: async (question) => {
        questions.push(question)
        return queue.length ? queue.shift() : ''
      },
      ...overrides,
    }).then((result) => ({
      result,
      questions,
      stdout: stdout.output(),
      config: vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8').toString(),
      vol,
    }))
  }

  // The single line the config assigns this name on. Asserted to be unique, because
  // "the last assignment wins" is bash's rule and a second one would make every
  // measurement below ambiguous.
  function assignmentLine(config, name) {
    const lines = config.split(LF).filter((l) => l.startsWith(`${name}=`))
    expect(lines).toHaveLength(1)
    return lines[0]
  }

  // What the shell that sources ralph.config.sh actually ends up with, for ONE
  // assignment line — the same probe lib/parse-config-var.qa.test.js uses.
  async function bashValue(line, name) {
    const script = `${line}${LF}printf 'V<<%s>>' "\${${name}-«unset»}"`
    const { stdout } = await execa('bash', ['-c', script], { reject: false })
    return stdout.match(/V<<([\s\S]*)>>/)?.[1] ?? null
  }

  describe('a value both readers agree on', () => {
    it.each([
      ['the default query, taken by pressing enter', ''],
      ['a JQL literal in single quotes, the shape the template recommends', "summary ~ '#123'"],
      ['a JQL literal in double quotes', 'project = R AND summary ~ "#123"'],
      ['a bare hash, which bash reads as a comment unquoted', 'project = R # note'],
      ['a dollar sign and a backtick, which double quotes would reinterpret', 'text ~ "$HOME `date`"'],
      ['a backslash', 'summary ~ "back\\slash"'],
      ['an apostrophe in prose', "summary ~ 'don't'"],
      ['parentheses and commas', 'status NOT IN ("Done", "Closed") AND (a = 1 OR b = 2)'],
    ])('%s: bash and parseConfigVar both read back exactly what was typed', async (_label, typed) => {
      const expected = typed === '' ? DEFAULT_JQL : typed
      const { config, result } = await initInteractively({ answers: ['jira', typed, ''] })
      const line = assignmentLine(config, 'JIRA_JQL')
      // The value init resolved, the shell's reading of the line, and the JS
      // reader's reading of the same line — three answers that must be one.
      expect(result.jiraJql).toBe(expected)
      expect(await bashValue(line, 'JIRA_JQL')).toBe(expected)
      expect(parseConfigVar(config, 'JIRA_JQL')).toBe(expected)
    })

    it('the same holds for JIRA_DONE_STATUS, including a name with spaces', async () => {
      for (const typed of ['', 'Done', 'Ready for Release', 'Complete (verified)']) {
        const expected = typed === '' ? 'Done' : typed
        const { config } = await initInteractively({ answers: ['jira', '', typed] })
        const line = assignmentLine(config, 'JIRA_DONE_STATUS')
        expect(await bashValue(line, 'JIRA_DONE_STATUS'), typed).toBe(expected)
        expect(parseConfigVar(config, 'JIRA_DONE_STATUS'), typed).toBe(expected)
      }
    })

    it('the default line is single-quoted, which is the fix the template’s own prose names', async () => {
      // Not just "it round-trips" — WHICH spelling it round-trips as, because the
      // template documents this exact remedy for a value carrying double quotes and
      // a reader that stops at the first inner quote.
      const { config } = await initInteractively({ answers: ['jira', '', ''] })
      expect(assignmentLine(config, 'JIRA_JQL')).toBe(`JIRA_JQL='${DEFAULT_JQL}'`)
    })

    it('a value with no character bash reinterprets keeps the template’s double quotes', async () => {
      // The other side of the rule, and the reason the empty case is byte-unchanged:
      // double quotes are what every other knob in this file uses, so they are the
      // shape a value that does not need escaping is still written with.
      const { config } = await initInteractively({ answers: ['jira', 'project = RALPH', 'Done'] })
      expect(assignmentLine(config, 'JIRA_JQL')).toBe('JIRA_JQL="project = RALPH"')
      expect(assignmentLine(config, 'JIRA_DONE_STATUS')).toBe('JIRA_DONE_STATUS="Done"')
    })
  })

  describe('the one shape the two readers disagree about', () => {
    it.each([
      ['both quote characters', `mixed "dq" and 'sq'`],
      ['a hash plus both quote characters', `text ~ "#urgent" AND labels = 'x'`],
    ])(
      '%s: bash reads it correctly, parseConfigVar reads the escape — PINNED, not promised',
      async (_label, typed) => {
        // A REAL LIMIT, recorded as one. A value holding a single quote AND one of the
        // characters double quotes reinterpret can only be written single-quoted with the
        // POSIX `'\''` splice, and `parseConfigVar` closes a quoted value at the first
        // matching quote — its own header says it has never modelled adjacent-word
        // concatenation, which is what the splice is. So the shell that runs the loop gets
        // the query right and the JS reader that counts the queue does not.
        //
        // Nothing here narrows that: it is unreachable from the default this command offers
        // (the default holds no single quote), and narrowing it means changing
        // parse-config-var.js, which every knob in this file is read through. This test is
        // the notification for whoever does — it fails the day the parser learns the splice.
        const { config } = await initInteractively({ answers: ['jira', typed, ''] })
        const line = assignmentLine(config, 'JIRA_JQL')
        expect(await bashValue(line, 'JIRA_JQL')).toBe(typed)
        const asRead = parseConfigVar(config, 'JIRA_JQL')
        expect(asRead).not.toBe(typed)
        expect(asRead).toContain("'\\''")
      },
    )
  })

  describe('why the rule exists — the naive shape, measured', () => {
    // THE EVIDENCE FOR quoteConfigValue, kept beside the rule it justifies. These two
    // lines are what init would write if JIRA_JQL were spelled `VAR="{{VALUE}}"` like
    // every other knob in the template. Neither is a guess: each is run through a real
    // bash here, and what that bash does is why the emitted quote character is chosen
    // per value. If a future bash makes these lines safe, these tests fail and the rule
    // can be reconsidered — that is the point of pinning the broken shape too.
    it.each([
      [
        'the default query: bash drops the value’s own quotes, the JS reader keeps them',
        `JIRA_JQL="${DEFAULT_JQL}"`,
        'assignee = currentUser() AND status NOT IN (Done, Closed, Resolved, Canceled)',
        DEFAULT_JQL,
      ],
      [
        'a quoted literal with a space: the assignment word ends there, so nothing is set',
        'JIRA_JQL="summary ~ "Ready for Release""',
        null, // measured below as "never assigned", not as a string
        'summary ~ "Ready for Release"',
      ],
    ])('%s', async (_label, naiveLine, fromBash, fromParser) => {
      // The probe's own sentinel, read off a line that assigns nothing, so the two
      // readings of "unset" can be compared without spelling the sentinel twice.
      const unset = await bashValue('# assigns nothing', 'JIRA_JQL')
      expect(await bashValue(naiveLine, 'JIRA_JQL')).toBe(fromBash ?? unset)
      expect(parseConfigVar(`${naiveLine}${LF}`, 'JIRA_JQL')).toBe(fromParser)
      // THE HARM, stated as the comparison it is: the loop's shell and `ralph cycle` /
      // `ralph status` would be working from two different queries off one line, and
      // bash reports nothing wrong about the first of them (it exits 0).
      expect(await bashValue(naiveLine, 'JIRA_JQL')).not.toBe(fromParser)
    })

    it('and init emits neither of those lines for the default query', async () => {
      const { config } = await initInteractively({ answers: ['jira', '', ''] })
      expect(assignmentLine(config, 'JIRA_JQL')).not.toBe(`JIRA_JQL="${DEFAULT_JQL}"`)
      // What it writes instead is the single-quoted spelling asserted above, which the
      // round-trip rows prove both readers agree on.
      expect(await bashValue(assignmentLine(config, 'JIRA_JQL'), 'JIRA_JQL')).toBe(DEFAULT_JQL)
    })
  })

  describe('github and folder are untouched — the no-regression half', () => {
    it.each([
      ['github, chosen at the picker with a blank answer', { answers: [''] }],
      ['folder, chosen at the picker', { answers: ['folder'] }],
      ['github, by flag', { source: 'github' }],
      ['folder, by flag', { source: 'folder' }],
      ['github, non-interactively', { isTTY: false }],
    ])('%s: both knobs ship EMPTY, exactly as the template always has', async (_label, opts) => {
      const { config } = await initInteractively(opts)
      expect(assignmentLine(config, 'JIRA_JQL')).toBe('JIRA_JQL=""')
      expect(assignmentLine(config, 'JIRA_DONE_STATUS')).toBe('JIRA_DONE_STATUS=""')
      // And bash agrees the value is empty, which is what makes the source inert.
      expect(await bashValue(assignmentLine(config, 'JIRA_JQL'), 'JIRA_JQL')).toBe('')
      expect(parseConfigVar(config, 'JIRA_JQL')).toBe('')
    })

    it('a github init asks the picker and nothing else', async () => {
      const { questions } = await initInteractively({ answers: [''] })
      expect(questions).toHaveLength(1)
      expect(questions[0].toLowerCase()).not.toContain('jql')
    })
  })

  describe('the picker under adversarial answers', () => {
    it.each([
      ['a control character glued to a real name', `jira${NUL}`],
      ['a forged second line', `jira${LF}✅ Ralph is ready`],
      ['a near-miss', 'jiras'],
      ['two names', 'jira,folder'],
      ['a shell fragment', 'folder; rm -rf /'],
      ['punctuation only', '???'],
    ])('%s: falls back to github, exits 0, and writes nothing hostile', async (_label, answer) => {
      const { result, config } = await initInteractively({ answers: [answer] })
      expect(result.exitCode, answer).toBe(0)
      expect(result.source, answer).toBe('github')
      expect(config, answer).toContain('TASK_SOURCE="github"')
      // The answer's own bytes reach the file nowhere — writeConfig interpolates the
      // RESOLVED source, the way it does the resolved agent (#108). This one assertion is
      // real for EVERY row, unlike the three below it, which each speak for one row and
      // pass for free on the other five; they are kept because they name what would be
      // alarming if it did land.
      expect(config, answer).not.toContain(answer)
      expect(config, answer).not.toContain('rm -rf')
      expect(config, answer).not.toContain(NUL)
      expect(config, answer).not.toContain('Ralph is ready')
    })

    it('a hostile answer at the picker never reaches the Jira prompts', async () => {
      // The fallback is to github, and github asks nothing more — so a stray keystroke
      // cannot leave a run waiting on two questions the user did not expect.
      const { questions } = await initInteractively({ answers: [`jira${NUL}`, 'x', 'y'] })
      expect(questions).toHaveLength(1)
    })
  })

  describe('the SHIPPED template', () => {
    const TEMPLATE = fileURLToPath(new URL('../templates/ralph.config.sh', import.meta.url))
    const text = () => readFileSync(TEMPLATE, 'utf8')

    it('declares both Jira knobs as placeholders that carry their own quotes', async () => {
      // The one place this template does NOT spell an assignment `VAR="{{VALUE}}"`, and
      // the reason is the whole point of #133: for JIRA_JQL the quote character depends on
      // the value, so init supplies it. Pinned so a future tidy-up that "restores
      // consistency" by adding the quotes back fails here rather than in a user's shell.
      const lines = text().split(LF)
      expect(lines.filter((l) => l.startsWith('JIRA_JQL='))).toEqual(['JIRA_JQL={{JIRA_JQL}}'])
      expect(lines.filter((l) => l.startsWith('JIRA_DONE_STATUS='))).toEqual([
        'JIRA_DONE_STATUS={{JIRA_DONE_STATUS}}',
      ])
    })

    // The placeholder SET is asserted once, in the #125 QA block above ("the SHIPPED
    // template documents jira and keeps its placeholder intact") — these two knobs were
    // added to that list rather than given a second one, so a future eleventh variable
    // cannot satisfy one list and miss the other.

    it('says who writes the quotes, and that a jira init fills both knobs', () => {
      // A reader of the template sees an unquoted right-hand side; the prose has to say
      // why, or the next person to touch it "fixes" it. And a reader who ran
      // `ralph init --source jira` has a value in front of them that the old prose said
      // this file had no default for — so both blocks now name the command that chose it.
      const jql = text().slice(
        text().indexOf('# Jira eligibility'),
        text().indexOf(`${LF}JIRA_JQL={{`),
      )
      const status = text().slice(
        text().indexOf('# Jira completion'),
        text().indexOf(`${LF}JIRA_DONE_STATUS={{`),
      )
      for (const block of [jql, status]) {
        expect(block).toMatch(/ralph init/)
        expect(block.toLowerCase()).toMatch(/quote/)
      }
    })

    it('every line of both Jira blocks is still a comment line', () => {
      // A file a shell sources: an unquoted prose line would be executed.
      for (const [marker, knob] of [
        ['# Jira eligibility', 'JIRA_JQL'],
        ['# Jira completion', 'JIRA_DONE_STATUS'],
      ]) {
        const block = text().slice(text().indexOf(marker), text().indexOf(`${LF}${knob}={{`))
        expect(block, marker).not.toBe('')
        for (const line of block.split(LF).filter(Boolean)) {
          expect(line.startsWith('#'), line).toBe(true)
        }
      }
    })
  })

  // =========================================================================
  // QA AUGMENTATION for #133 — the seam, not the coverage.
  //
  // The block above measures ONE LINE at a time. Four things cannot be settled that
  // way, and each is a different failure mode:
  //
  //   1. THE FILE, NOT THE LINE. A value that ends its assignment word early does not
  //      just set the wrong JIRA_JQL — it makes bash run the TAIL OF THE FILE as a
  //      command, so the blast radius is every setting after it. Measured below by
  //      writing the WHOLE emitted config to disk and sourcing it the way
  //      templates/ralph.sh does (`set -a; . ./ralph.config.sh`), then reading back a
  //      knob that sits AFTER the Jira pair.
  //   2. WHAT THE VALUE CAN EVEN CONTAIN. Reachability is a claim about readline, so it
  //      is measured against readline — the real `promptValue` seam, in TERMINAL mode,
  //      which is the only mode a prompt ever runs in (the non-TTY path never asks).
  //   3. THE OTHER READER, ON BYTES NOBODY LISTED. `quoteConfigValue`'s character class
  //      is about what DOUBLE QUOTES reinterpret. It says nothing about characters that
  //      break the OTHER reader, and `parseConfigVar` had one that returned '' — "not
  //      configured" — for a line bash reads perfectly. That one (U+2028/U+2029, and CR
  //      with it) is fixed in the parser; a NUL and an embedded LF still diverge and are
  //      pinned below as what they are.
  //   4. WHERE THE EMITTER COULD LOSE THE VALUE IT JUST QUOTED. `quoteConfigValue` runs,
  //      and then the template substitution runs — and while that substitution was
  //      MULTI-PASS (once per key, over text that already held the quoted values), a
  //      value naming a later key's placeholder had that key's value spliced into it.
  //      Fixed by writing the config through the repo's shared single-pass
  //      lib/interpolate.js; the pins are kept as the record.
  //
  // Control bytes are built from code points, never typed (#107).
  // =========================================================================

  const CR = String.fromCharCode(0x0d)
  const ESC = String.fromCharCode(0x1b)
  const TAB = String.fromCharCode(0x09)
  // U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR. Not in `.`'s match set in a JS
  // regex, which is the whole reason they are in this file (see the divergence block).
  const LS = String.fromCharCode(0x2028)
  const PS = String.fromCharCode(0x2029)
  // U+0085 NEXT LINE. The nearest character to the two above that LOOKS like it belongs
  // in the divergence and measurably does not: `/^.$/.test(NEL)` is TRUE where the same
  // test on U+2028 is false, so `.` never excluded it and this parser never had a problem
  // with it — even though other readers do split lines on it (Python's `splitlines()`
  // does, measured). Driven at the prompt anyway, so "only U+2028/U+2029 moved between
  // node versions" is a statement about the neighbourhood.
  const NEL = String.fromCharCode(0x85)
  // What `oneLineEcho` puts in place of a character no terminal can be trusted with,
  // one code point for one code point (lib/one-line.js).
  const PLACEHOLDER = String.fromCharCode(0xfffd)

  // Nothing here writes to the repo: one throwaway directory, removed after.
  let TMP = null
  let seq = 0
  beforeAll(() => {
    TMP = mkdtempSync(join(tmpdir(), 'ralph-133-qa-'))
  })
  afterAll(() => {
    if (TMP) rmSync(TMP, { recursive: true, force: true })
  })

  // Source the WHOLE emitted config the way templates/ralph.sh does, and syntax-check it.
  // Returns bash's own answer for each named knob plus the two exit codes and stderr,
  // because "the file still sources" is three separate claims: it parses, it exits 0, and
  // it says nothing on stderr. A `command not found` line is how bash reports that it ran
  // part of this file as a command, and it exits 0 anyway.
  async function sourceWholeFile(config, names) {
    seq += 1
    const path = join(TMP, `config-${seq}.sh`)
    writeFileSync(path, config)
    const syntax = await execa('bash', ['-n', path], { reject: false })
    const probe = names
      .map((n) => `printf '${n}<<%s>>' "\${${n}-«unset»}"`)
      .join('; ')
    const sourced = await execa('bash', ['-c', `set -a; . '${path}'; set +a; ${probe}`], {
      reject: false,
    })
    const values = {}
    for (const n of names) {
      values[n] = sourced.stdout.match(new RegExp(`${n}<<([\\s\\S]*?)>>`))?.[1] ?? null
    }
    return {
      syntaxExit: syntax.exitCode,
      syntaxErr: syntax.stderr.trim(),
      sourcedExit: sourced.exitCode,
      sourcedErr: sourced.stderr.trim(),
      values,
    }
  }

  // The real `promptValue`, forced into readline's TERMINAL mode — readline's `terminal`
  // option defaults to `output.isTTY`, and a jira init only ever prompts when isTTY is
  // true, so terminal mode is the ONLY mode this seam runs in for real. Used to measure
  // reachability rather than argue about it.
  function answerAtARealPrompt(bytes) {
    const input = new PassThrough()
    const output = new PassThrough()
    output.isTTY = true
    output.resume()
    const answered = realPromptValue('q: ', { input, output })
    input.write(bytes)
    return answered
  }

  describe('the whole emitted file is still a shell script — every hostile answer', () => {
    // WHY THE WHOLE FILE AND NOT THE LINE. The second failure init.js's own comment
    // measured (`JIRA_JQL="summary ~ "Ready for Release""`) does not merely mis-set the
    // variable: bash ends the assignment word at the space and runs the rest as a
    // command. On one line that shows up as `for: command not found`; in a 200-line
    // config it can swallow the lines that follow. So the assertions are: the file
    // parses, sourcing it is silent, the value survives, AND a knob further down the
    // file (MAIN_BRANCH, and TASK_SOURCE above it) still holds what init wrote.
    it.each([
      ['a bang, which bash reinterprets only when reading a terminal', 'project != RALPH AND x = 1 !'],
      ['a semicolon', 'project = R; echo pwned'],
      ['a pipe', 'project = R | tee /tmp/nope'],
      ['an ampersand', 'a = 1 & b = 2'],
      ['a glob star', 'summary ~ *'],
      ['a tilde', 'assignee = ~admin'],
      ['brace expansion', 'status IN {Done,Closed}'],
      ['a here-doc operator', 'summary ~ a << EOF'],
      ['process substitution', 'summary ~ a <(echo hi)'],
      ['arithmetic expansion', 'a = $((1+1))'],
      ['command substitution', 'text ~ "$HOME `id`" AND a = $(id)'],
      ['an UNBALANCED double quote', 'project = "RALPH'],
      ['an UNBALANCED single quote', "project = 'RALPH"],
      ['a lone double quote', '"'],
      ['a lone single quote', "'"],
      ['a double quote then a single quote', `"'`],
      ['a TRAILING backslash', 'summary ~ back\\'],
      ['a closing quote then a hash', 'a" # x'],
      ['the POSIX splice, typed literally', `a'\\''b`],
      ['both quote characters', `mixed "dq" and 'sq'`],
      ['a tab', `project =${TAB}RALPH`],
      ['500 characters', `project = ${'R'.repeat(500)}`],
      ['non-ASCII', 'summary ~ "ünïcødé 日本語 ✅"'],
    ])('%s: bash -n clean, sources silently, and clobbers nothing after it', async (_label, typed) => {
      const { config, result } = await initInteractively({ answers: ['jira', typed, ''] })
      const probe = await sourceWholeFile(config, ['JIRA_JQL', 'JIRA_DONE_STATUS', 'TASK_SOURCE', 'MAIN_BRANCH'])
      expect(probe.syntaxExit, `bash -n: ${probe.syntaxErr}`).toBe(0)
      expect(probe.syntaxErr).toBe('')
      // Sourcing is SILENT. `command not found` on stderr — with exit 0 beside it — is
      // exactly how the naive shape announces that it ran the file as a command.
      expect(probe.sourcedErr).toBe('')
      expect(probe.sourcedExit).toBe(0)
      expect(probe.values.JIRA_JQL).toBe(result.jiraJql)
      // ...and the settings either side of the Jira pair are the ones init wrote, which
      // is the statement that nothing was swallowed.
      expect(probe.values.TASK_SOURCE).toBe('jira')
      expect(probe.values.JIRA_DONE_STATUS).toBe('Done')
      expect(probe.values.MAIN_BRANCH).toBe('main')
    })

    it('the same holds when the hostile value is the DONE STATUS instead', async () => {
      // The status knob is quoted by the same function and sits one line below the JQL,
      // so a mis-quoted status swallows even more of the file. Its plausible values are
      // ordinary words, which is exactly why nothing was driving the hostile ones.
      for (const typed of ['Ready for Release', `it's done`, 'a"b', 'a$b', 'a\\', '"', "'", `a'\\''b`]) {
        const { config, result } = await initInteractively({ answers: ['jira', '', typed] })
        const probe = await sourceWholeFile(config, ['JIRA_DONE_STATUS', 'JIRA_JQL', 'RALPH_AGENT'])
        expect(probe.syntaxExit, typed).toBe(0)
        expect(probe.sourcedErr, typed).toBe('')
        expect(probe.values.JIRA_DONE_STATUS, typed).toBe(result.jiraDoneStatus)
        expect(probe.values.JIRA_JQL, typed).toBe(DEFAULT_JQL)
        expect(probe.values.RALPH_AGENT, typed).toBe('claude')
      }
    })

    it('a github init’s file sources clean too, with both knobs empty', async () => {
      // The no-regression baseline for the probe itself: if this ever failed, the rows
      // above would be measuring a broken template rather than a broken value.
      const { config } = await initInteractively({ answers: [''] })
      const probe = await sourceWholeFile(config, ['JIRA_JQL', 'JIRA_DONE_STATUS', 'TASK_SOURCE'])
      expect(probe.syntaxExit).toBe(0)
      expect(probe.sourcedErr).toBe('')
      expect(probe.values).toEqual({ JIRA_JQL: '', JIRA_DONE_STATUS: '', TASK_SOURCE: 'github' })
    })
  })

  describe('the double-quote branch: the characters it deliberately does NOT escape', () => {
    it('`!` is safe because history expansion is off in every shell that reads this file', async () => {
      // THE ONE CHARACTER MISSING FROM `REINTERPRETED_IN_DOUBLE_QUOTES` THAT LOOKS LIKE
      // IT SHOULD BE THERE. Inside double quotes bash expands `!` — but only when
      // history expansion is enabled, which happens when bash is READING A TERMINAL.
      // Sourcing a file is not that, and MEASURED, it is not that even with history
      // forced on:
      //
      //   $ printf 'JIRA_JQL="project != RALPH"\n' > line.sh
      //   $ bash -c 'set -a; . ./line.sh; set +a; printf "[%s]" "$JIRA_JQL"'
      //   [project != RALPH]
      //   $ bash -c 'set -o history; set -H; set -a; . ./line.sh; set +a; printf "[%s]" "$JIRA_JQL"'
      //   [project != RALPH]
      //
      // So `!` stays in the double-quoted branch, which matters: `!=` is ordinary JQL
      // and forcing it into single quotes would change the bytes of a very common line
      // for no reason.
      for (const typed of ['project != RALPH', 'a != 1 AND b != 2', 'summary ~ "wow!!"']) {
        const { config, result } = await initInteractively({ answers: ['jira', typed, ''] })
        const line = assignmentLine(config, 'JIRA_JQL')
        expect(await bashValue(line, 'JIRA_JQL'), typed).toBe(result.jiraJql)
        expect(parseConfigVar(config, 'JIRA_JQL'), typed).toBe(result.jiraJql)
        // And with history expansion forced ON, which no reader of this file does.
        const { stdout } = await execa(
          'bash',
          [
            '-c',
            `set -o history; set -H\n${line}\nprintf 'V<<%s>>' "\${JIRA_JQL-«unset»}"`,
          ],
          { reject: false },
        )
        expect(stdout.match(/V<<([\s\S]*)>>/)?.[1], typed).toBe(result.jiraJql)
      }
    })

    it('`!=` keeps the template’s double quotes rather than being pushed into single ones', async () => {
      const { config } = await initInteractively({ answers: ['jira', 'project != RALPH', ''] })
      expect(assignmentLine(config, 'JIRA_JQL')).toBe('JIRA_JQL="project != RALPH"')
    })
  })

  describe('the splice limit, as a PROPERTY rather than two rows', () => {
    it('bash is always right, and parseConfigVar is right EXACTLY when the value has no single quote OR no reinterpreted character', async () => {
      // THE DEV'S CHARACTERISATION OF THE KNOWN LIMIT, CHECKED RATHER THAN TAKEN. Its
      // claim is that the disagreement needs a single quote AND one of `"`, `$`, a
      // backtick or `\` — i.e. that it is exactly the values forced onto the splice
      // path. Measured over the table below, the biconditional holds with no
      // exceptions, in both directions: nothing outside that class diverges, and
      // nothing inside it agrees. Values carrying a line terminator or a NUL are
      // excluded and driven separately (see the divergence block) — those break the
      // parser for a completely different reason, and lumping them in here would make
      // this property read as false when it is not.
      const REINTERPRETED = /["$`\\]/
      for (const typed of [
        'project = RALPH',
        "summary ~ '#123'",
        "it's",
        "'",
        "''",
        "a'b",
        'project = R # note',
        'a" # x',
        'a"b',
        'text ~ "#urgent"',
        'summary ~ back\\',
        'abc$',
        'a `id` b',
        'a $(id) b',
        'ünïcødé ✅ 日本語',
        `mixed "dq" and 'sq'`,
        `"'`,
        `a'\\''b`,
        `'\\''x`,
        "a'$",
        'a\'`b',
        "a'\\b",
      ]) {
        const { config, result } = await initInteractively({ answers: ['jira', typed, ''] })
        const line = assignmentLine(config, 'JIRA_JQL')
        const resolved = result.jiraJql
        // bash, unconditionally.
        expect(await bashValue(line, 'JIRA_JQL'), typed).toBe(resolved)
        // ...and the parser, exactly when the value is off the splice path.
        const onSplicePath = resolved.includes("'") && REINTERPRETED.test(resolved)
        if (onSplicePath) {
          expect(parseConfigVar(config, 'JIRA_JQL'), typed).not.toBe(resolved)
          expect(parseConfigVar(config, 'JIRA_JQL'), typed).toContain("'\\''")
        } else {
          expect(parseConfigVar(config, 'JIRA_JQL'), typed).toBe(resolved)
        }
      }
    })
  })

  describe('bytes the LINE survives: the two readers, on characters nobody listed', () => {
    // FOUR SHAPES THE `["$`\\]` CLASS SAYS NOTHING ABOUT, because that class is about
    // what DOUBLE QUOTES reinterpret and these break a READER instead. Two of them were
    // divergences when QA measured them and are now fixed at the root (see
    // lib/parse-config-var.js); the other two remain divergences and stay pinned as the
    // behaviour they are. Reachability is MEASURED against the real prompt seam in the
    // block below rather than guessed at, because how a value gets into the file is most
    // of the severity here — the rest being the hand edit that line invites, which no
    // prompt is involved in.

    it('U+2028 / U+2029: both readers now agree, off a line bash reads whole', async () => {
      // WAS THE WORST OF THE FOUR, and the only one a real prompt can deliver AT ALL —
      // though only on some runtimes: readline hands both separators back intact up to
      // node 23 and ends the line at one on 24, measured on both sides in the
      // reachability block below, so a PASTED JQL carries one through init on the older
      // runtimes only. The line reaches the parser from a hand edit either way. What QA
      // measured before the fix:
      //
      //   $ printf 'JIRA_JQL="abc<U+2028>def"\n' > line.sh
      //   $ bash -n line.sh                    # exit 0
      //   $ bash -c 'set -a; . ./line.sh; set +a; printf "[%s]" "$JIRA_JQL"'
      //   [abc<U+2028>def]
      //   > parseConfigVar(text, 'JIRA_JQL')   // ''      <- and configAssignsVar said true
      //
      // WHY IT READ '': parse-config-var.js matched the value with `(.+?)`, and in a JS
      // regex `.` matches no line terminator — LF, CR, U+2028 and U+2029 are all outside
      // it. No line matched the assignment at all, so that loop never assigned and the
      // function returned its initial ''.
      //
      // THE HARM IT CARRIED, and it is the exact failure this whole slice exists to
      // prevent: templates/ralph.sh counts the queue with the SOURCED value
      // (`node lib/jira-queue.js count "${JIRA_JQL:-}"`), so the loop ran the query the
      // LINE holds — while `ralph cycle` (lib/commands/cycle.js reads JIRA_JQL through
      // parseConfigVar) and `ralph status` saw an EMPTY query, which lib/jira-jql.js
      // reports as "JIRA_JQL is empty" and counts as depth 0. One config, two answers,
      // and the disagreement was about whether the repo is configured at all.
      //
      // THE FIX is one character class in that parser — `(.+?)` → `([^\n]+?)`, on lines
      // that were split at LF and so cannot contain one — measured there against bash. (The
      // quantifier has since widened again, to `([^\n]*?)`, so that a bare `VAR=` matches
      // with an empty tail: #147, which left the character class exactly as #133 set it.)
      for (const sep of [LS, PS]) {
        const typed = `project = R AND summary ~ "a${sep}b"`
        const { config, result } = await initInteractively({ answers: ['jira', typed, ''] })
        const line = assignmentLine(config, 'JIRA_JQL')
        expect(result.jiraJql).toBe(typed)
        // bash: the whole value, off a file that is syntactically clean.
        const probe = await sourceWholeFile(config, ['JIRA_JQL'])
        expect(probe.syntaxExit).toBe(0)
        expect(probe.sourcedErr).toBe('')
        expect(probe.values.JIRA_JQL).toBe(typed)
        expect(await bashValue(line, 'JIRA_JQL')).toBe(typed)
        // ...and the JS reader, the same value, off the same line.
        expect(parseConfigVar(config, 'JIRA_JQL')).toBe(typed)
        expect(configAssignsVar(config, 'JIRA_JQL')).toBe(true)
      }
    })

    it('a carriage return: agreed too, by the same one-character fix', async () => {
      // Same root cause (`.` matched no CR either), kept as its own row because its
      // reachability is different: readline ENDS A LINE at a CR, so this one cannot be
      // typed or pasted at the prompt (measured in the reachability block). It is
      // reachable by hand-editing ralph.config.sh, or programmatically.
      const typed = `project = R${CR}AND a = 1`
      const { config } = await initInteractively({ answers: ['jira', typed, ''] })
      expect(await bashValue(assignmentLine(config, 'JIRA_JQL'), 'JIRA_JQL')).toBe(typed)
      expect(parseConfigVar(config, 'JIRA_JQL')).toBe(typed)
      expect(configAssignsVar(config, 'JIRA_JQL')).toBe(true)
      // A CR as a LINE ENDING is still stripped — that is the CRLF case, which the widened
      // class had to leave alone and did. The MECHANISM moved in the #147 follow-up: the
      // padding is now `[ \t]*`, which cannot match a CR, so the value group is forced to
      // keep it and `trimPadding`'s trailing class — which names CR, U+2028 and U+2029 for
      // exactly this reason — is what removes it (parse-config-var.qa.test.js's `a trailing
      // \r is still a LINE ENDING, not part of the value` measures it).
      expect(parseConfigVar(`JIRA_JQL="abc"${CR}${LF}`, 'JIRA_JQL')).toBe('abc')
    })

    it('a NUL byte: bash DROPS it, parseConfigVar KEEPS it — two different queries', async () => {
      //   $ printf 'JIRA_JQL="project = R<NUL>AND a = 1"\n' > config.sh
      //   $ bash -n config.sh                                    # exit 0
      //   $ bash -c 'set -a; . ./config.sh; set +a; printf "[%s]" "$JIRA_JQL"'
      //   [project = RAND a = 1]      # the NUL is gone, silently, exit 0, no stderr
      //   > parseConfigVar(text, 'JIRA_JQL')   // 'project = R<NUL>AND a = 1'
      //
      // Not a quoting failure — bash drops a NUL out of a script it reads whatever the
      // quotes are — but still two readers holding two different queries off one line.
      // It also makes ralph.config.sh a file `file(1)` calls data and grep skips, which
      // is the hazard #107 spells out for this repo's own sources.
      //
      // Measured through a FILE rather than `bash -c`, because execa refuses to put a
      // NUL in an argv at all ("Arguments cannot contain null bytes") — which is its own
      // small piece of evidence about how far this byte travels. Sourcing a file is what
      // templates/ralph.sh does anyway.
      const typed = `project = R${NUL}AND a = 1`
      const stripped = 'project = RAND a = 1'
      const { config, result } = await initInteractively({ answers: ['jira', typed, ''] })
      expect(result.jiraJql).toBe(typed)
      const probe = await sourceWholeFile(config, ['JIRA_JQL', 'TASK_SOURCE'])
      expect(probe.syntaxExit).toBe(0)
      expect(probe.sourcedErr).toBe('')
      expect(probe.values.JIRA_JQL).toBe(stripped)
      expect(probe.values.TASK_SOURCE).toBe('jira')
      expect(parseConfigVar(config, 'JIRA_JQL')).toBe(typed)
      expect(parseConfigVar(config, 'JIRA_JQL')).not.toBe(stripped)
    })

    it('a line feed: bash reads a two-line value, parseConfigVar reads a STRAY QUOTE', async () => {
      // The parser's documented "no multi-line values" limit, reached from init for the
      // first time. What makes it worth its own row is the SHAPE of the wrong answer: the
      // parser hands back the OPENING QUOTE CHARACTER as part of the value, so the query
      // that reaches acli begins with a `"` the user never typed.
      const typed = `project = R${LF}AND a = 1`
      const { config } = await initInteractively({ answers: ['jira', typed, ''] })
      const probe = await sourceWholeFile(config, ['JIRA_JQL'])
      expect(probe.syntaxExit).toBe(0)
      expect(probe.sourcedErr).toBe('')
      expect(probe.values.JIRA_JQL).toBe(typed)
      expect(parseConfigVar(config, 'JIRA_JQL')).toBe('"project = R')
      // The single-quote branch does the same thing with its own quote character.
      const { config: sq } = await initInteractively({
        answers: ['jira', `project = "R"${LF}AND a = 1`, ''],
      })
      expect(parseConfigVar(sq, 'JIRA_JQL')).toBe(`'project = "R"`)
    })
  })

  describe('reachability, measured at the REAL prompt rather than argued', () => {
    // Severity here is entirely a question of which bytes readline can hand back, and
    // that is a property of readline in TERMINAL mode — the only mode a jira init's
    // prompts ever run in, since the non-TTY path asks nothing. Driven through the real
    // `promptValue`, with `output.isTTY` set so readline turns terminal mode on.
    //
    // EVERY ROW IN THIS TABLE IS VERSION-INVARIANT, and that is measured rather than
    // assumed: they answer identically on node 18.20.8, 19.9.0, 20.20.2, 22.23.2, 23.11.1
    // and 24.16.0 — on 20 and 24 by running this file under each, and on all six through
    // a throwaway probe holding this helper's code verbatim. The two SEPARATOR rows are
    // NOT version-invariant, and are split out underneath for that reason.
    it.each([
      ['an ordinary answer', 'project = R', 'project = R'],
      // SWALLOWED by readline's keypress decoding: not reachable at a prompt.
      ['a NUL in the middle', `a${NUL}b`, 'ab'],
      // TRUNCATES the answer — readline takes it as the start of an escape sequence.
      ['an ESC in the middle', `a${ESC}b`, 'a'],
      // A LINE ENDING, so the answer stops there. Neither LF nor CR can be embedded.
      ['a CR in the middle', `a${CR}b`, 'a'],
      ['a tab in the middle', `a${TAB}b`, `a${TAB}b`],
      // NEL U+0085, a line boundary to other readers but not to a JS regex, does not
      // move either — included so "only U+2028/U+2029 diverge" is a measurement about
      // the neighbourhood rather than about two characters picked in advance.
      ['NEL U+0085 in the middle', `a${NEL}b`, `a${NEL}b`],
    ])('%s: readline hands back %j as %j', async (_label, typed, expected) => {
      expect(await answerAtARealPrompt(`${typed}${LF}`)).toBe(expected)
    })

    // DIVERGENCE: U+2028 / U+2029 AT THE PROMPT ARE A PROPERTY OF THE NODE VERSION, and
    // both behaviours are on runtimes this package supports (`engines.node` is `>=18`),
    // so neither one is "the" answer and this block pins the pair. Measured by typing
    // `a<sep>b<LF>` at this helper, or at a probe holding its code verbatim:
    //
    //   node 18.20.8  ->  a<U+2028>b     node 22.23.2  ->  a<U+2028>b
    //   node 19.9.0   ->  a<U+2028>b     node 23.11.1  ->  a<U+2028>b
    //   node 20.20.2  ->  a<U+2028>b     node 24.16.0  ->  a
    //
    // and U+2029 identically on all six. So up to and including 23 readline hands both
    // separators back INTACT, while on 24 it ends the line at one — its keypress
    // decoding treats them as line terminators. The boundary is 23 -> 24, measured on
    // both sides of it, and every OTHER row of the table above is unchanged across all
    // six. CI runs 24 (.github/workflows/ci.yml) and a dev box may be on any of them,
    // which is how this arrived: the hard-coded node-20 answer went red on CI alone.
    //
    // WHAT IT MEANS FOR THE PARSER FIX. It decides only whether `ralph init` is one of
    // the routes to a U+2028 in ralph.config.sh — on 18-23 it is, on 24 it is not. It
    // does not decide whether the fix is needed: a hand-edited or tool-written config
    // reaches parseConfigVar whatever a prompt does.
    //
    // THE EXPECTATION IS DERIVED FROM ONE PROBE OF THE RUNNING READLINE, not from a
    // version comparison: `process.versions.node >= 24` would assert a boundary nobody
    // measured across every runtime in `>=18`, and would go red again the day CI moves
    // to 26. The probe's own answer is pinned to exactly the two shapes above, so a
    // THIRD behaviour on some future node fails here loudly instead of being absorbed.
    let probed = null
    const probeSeparatorHandling = () => {
      // Memoized on the PROMISE, so both rows below are derived from a single
      // measurement and cannot silently disagree about what the runtime does.
      probed ??= answerAtARealPrompt(`a${LS}b${LF}`)
      return probed
    }
    // Rows carry the CODE POINT rather than the character, which is #107's habit of
    // spelling these out applied to the table itself. It is not load-bearing for the test
    // NAME: this title holds a single `%s`, and vitest hands `format` only as many row
    // values as the title has placeholders (`items.slice(0, count)` in @vitest/runner's
    // `formatTitle`), so a surplus value is never appended to a reporter line anyway —
    // read there rather than assumed, since the row above it passes three values to a
    // three-placeholder title and the old shape of THIS row put a raw separator in a name.
    it.each([
      ['U+2028 in the middle', 0x2028],
      ['U+2029 in the middle', 0x2029],
    ])(
      '%s: readline either hands it back intact (node 18-23) or ends the line at it (node 24)',
      async (_label, codePoint) => {
        const sep = String.fromCharCode(codePoint)
        const answer = await probeSeparatorHandling()
        // Exactly two known shapes, for the probe's own character.
        expect([`a${LS}b`, 'a']).toContain(answer)
        const survives = answer === `a${LS}b`
        // ...and this row's character behaves the same way the probed one did. That is
        // the claim, not a restatement: a runtime that ended the line at U+2029 while
        // handing U+2028 back would fail here.
        expect(await answerAtARealPrompt(`a${sep}b${LF}`)).toBe(survives ? `a${sep}b` : 'a')
      },
    )
  })

  describe('a JQL that NAMES a placeholder survives the template pass verbatim (QA round 1)', () => {
    // WAS A DEFECT, NOW A GUARANTEE, and the pins are kept as the record of it.
    //
    // WHERE THE EMITTER USED TO LOSE THE VALUE IT HAD JUST QUOTED. `quoteConfigValue`
    // produces the whole right-hand side, quotes included — and init's own private
    // `interpolate` then ran `split('{{KEY}}').join(value)` once PER KEY, in
    // `Object.entries` order. The Jira knobs are the last two, JIRA_JQL then
    // JIRA_DONE_STATUS, so a JQL containing the literal text `{{JIRA_DONE_STATUS}}` had
    // the ALREADY-QUOTED status spliced into the middle of it on the following pass,
    // quote characters and all — producing precisely the two shapes init.js's own
    // comment measured and exists to avoid. Both transcripts are real, and are what QA
    // measured off the multi-pass emitter:
    //
    //   status "Done" (one word):
    //     JIRA_JQL="project = "Done""
    //     bash   -> project = Done          (the inner quotes dropped, exit 0, silent)
    //     parser -> project = "Done"        (kept)  <- two readers, two queries
    //
    //   status "Ready for Release" (the template's OWN example of a status name):
    //     JIRA_JQL="project = "Ready for Release""
    //     $ bash -c 'set -a; . ./ralph.config.sh; set +a; printf "[%s]" "${JIRA_JQL-«unset»}"'
    //     ralph.config.sh: line 146: for: command not found
    //     [«unset»]
    //     parser -> project = "Ready for Release"
    //
    // THE FIX IS STRUCTURAL, not a rule about these two keys: `writeConfig` now goes
    // through the repo's shared single-pass lib/interpolate.js, which scans the template
    // ONCE with a placeholder regex and never re-examines what it substituted. So a
    // value may contain any `{{NAME}}` at all, whatever key it belongs to and whatever
    // order the keys are in.
    it.each([
      ['a LATER key’s placeholder — the shape that used to corrupt the line', 'Done'],
      ['the same, with a multi-word status', 'Ready for Release'],
    ])('%s', async (_label, status) => {
      const typed = 'project = {{JIRA_DONE_STATUS}}'
      const { config, result } = await initInteractively({ answers: ['jira', typed, status] })
      expect(result.jiraJql).toBe(typed)
      // The line carries the placeholder TEXT, not the status: one pass, no rescan.
      expect(assignmentLine(config, 'JIRA_JQL')).toBe(`JIRA_JQL="${typed}"`)
      expect(assignmentLine(config, 'JIRA_DONE_STATUS')).toBe(`JIRA_DONE_STATUS="${status}"`)
      const probe = await sourceWholeFile(config, ['JIRA_JQL', 'JIRA_DONE_STATUS'])
      expect(probe.syntaxExit).toBe(0)
      // Silent sourcing — the `for: command not found` above is exactly what this asserts
      // is gone — and BOTH readers now hold the value init resolved.
      expect(probe.sourcedErr).toBe('')
      expect(probe.sourcedExit).toBe(0)
      expect(probe.values.JIRA_JQL).toBe(result.jiraJql)
      expect(probe.values.JIRA_DONE_STATUS).toBe(status)
      expect(parseConfigVar(config, 'JIRA_JQL')).toBe(result.jiraJql)
    })

    it('every OTHER placeholder name is just as inert in a JQL', async () => {
      // The property, rather than the one key that happened to bite: its own name, an
      // EARLIER key's name, and a name that is no key at all. Under the old multi-pass
      // emitter the first two passed for a reason that was about order — `{{JIRA_JQL}}`
      // being the current key and `{{TASK_SOURCE}}` an earlier one — and now they pass
      // for the reason all of them do.
      for (const typed of [
        'project = {{JIRA_JQL}}',
        'project = {{TASK_SOURCE}}',
        'a {{NOT_A_KEY}} b',
        'a {{INSTALL_CMD}} and a {{JIRA_DONE_STATUS}}',
      ]) {
        const { config, result } = await initInteractively({ answers: ['jira', typed, ''] })
        expect(result.jiraJql, typed).toBe(typed)
        expect(assignmentLine(config, 'JIRA_JQL'), typed).toBe(`JIRA_JQL="${typed}"`)
        expect(await bashValue(assignmentLine(config, 'JIRA_JQL'), 'JIRA_JQL'), typed).toBe(typed)
        expect(parseConfigVar(config, 'JIRA_JQL'), typed).toBe(typed)
      }
    })

    it('an unknown placeholder in the JQL is not reported as the TEMPLATE’s — no stderr at all', async () => {
      // The one behaviour the shared helper adds: it WARNS about a `{{NAME}}` it has no
      // value for, and leaves it intact. That warning is about the template's own text,
      // and a user's JQL is not the template — a value substituted in is never rescanned,
      // so `a {{NOT_A_KEY}} b` cannot trigger it. Asserted because a warning here would
      // be a sentence about a bug the user does not have.
      const vol = newVol()
      const stderr = makeStream()
      await run(vol, {
        stderr,
        isTTY: true,
        home: '/home/test',
        processEnv: {},
        ask: async () => false,
        promptAgent: async () => 'claude',
        promptValue: async (q) => (q.startsWith('Draw tasks') ? 'jira' : 'a {{NOT_A_KEY}} b'),
      })
      expect(stderr.output()).toBe('')
      expect(vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8').toString()).toContain(
        'JIRA_JQL="a {{NOT_A_KEY}} b"',
      )
    })
  })

  describe('the summary’s JIRA_JQL row is one-line-guarded (#108’s class — QA round 1)', () => {
    // WAS A DEFECT, NOW A GUARANTEE — these three pins were written against the
    // unguarded row and are kept, flipped, as the record of the fix.
    //
    // #108 IN THE FILE #108 WAS FIXED IN. init.js already imported `oneLineEcho` and
    // already ran its two `❌ Unknown <thing>` echoes through it, for exactly this: "a
    // value carrying a newline made this ONE write emit TWO lines, the second one an
    // `❌`/`✅` composed by nobody". The `JIRA_JQL:` row #133 added to printSummary was a
    // third echo of a user-supplied value and went through nothing. QA measured what
    // that produced:
    //
    //   [ '  TASK_SOURCE:  jira',
    //     '  JIRA_JQL:     project = R',
    //     '  FAKE_ROW:     pwned',            <- a summary row nobody wrote
    //     '  Ralph reads WhatsApp credentials from your global config ...' ]
    //
    // WHY GUARDED HERE AND NOT AT THE OTHER UNSANITISED ECHO IN THIS COMMAND. Because
    // this row is #133's, and the stored-WhatsApp-phone echo above is pre-existing — not
    // because that one is safe. An earlier version of this note claimed `parseEnvFile`
    // made it incapable of forging a line; review measured otherwise and the claim is
    // withdrawn. `parseEnvFile` splits on LF only and `trim()` strips a CR only at the
    // ends, so a mid-value CR (and NEL, U+2028, U+2029, ESC) reaches that echo verbatim:
    // a stored `WHATSAPP_PHONE=+15551234567<CR>  CALLMEBOT_KEY:  totally-legit` prints as
    // one write that a terminal renders as the forged row alone. Same class, separate fix.
    it('a JQL carrying a newline still emits exactly ONE row, with the LF shown as U+FFFD', async () => {
      const forged = `project = R${LF}  FAKE_ROW:     pwned`
      const { stdout, config } = await initInteractively({ answers: ['jira', forged, ''] })
      const rows = stdout.split(LF)
      const at = rows.findIndex((r) => r.startsWith('  JIRA_JQL:'))
      expect(at).toBeGreaterThan(-1)
      // ONE row, and the whole answer is in it: `oneLineEcho` replaces one code point
      // with one code point, so nothing is dropped and nothing is collapsed.
      expect(rows[at]).toBe(`  JIRA_JQL:     project = R${PLACEHOLDER}  FAKE_ROW:     pwned`)
      // NO ROW OF ITS OWN ANYWHERE — the actual promise. The forged text is still in the
      // output, and has to be: it is part of the answer the user gave. What it is not is a
      // LINE, so nothing in the summary reads as a `NAME:  value` row nobody composed.
      expect(rows.filter((r) => /^ {2}FAKE_ROW:/.test(r))).toEqual([])
      // Stronger, and not satisfiable by naming the one row this test invented: the set of
      // row NAMES is exactly the set a benign JQL produces. A forgery of any name fails.
      const names = (text) => text.split(LF).flatMap((r) => r.match(/^ {2}([A-Z_]+): {2}/)?.[1] ?? [])
      const control = await initInteractively({ answers: ['jira', 'project = RALPH', ''] })
      expect(names(stdout)).toEqual(names(control.stdout))
      // The row after this one is the summary's own blank line, not a forgery.
      expect(rows[at + 1]).toBe('')
      // ...and the CONFIG still got the bytes the user typed. The guard is about the
      // ECHO only: sanitising the value on its way to the file would write a query
      // containing U+FFFD, which is a different setting from the one that was asked for.
      // (What bash and the parser then make of a multi-line value is the LF row in the
      // divergence block, not this one's business.)
      expect(config).toContain(forged)
    })

    it('and an ESC in the JQL no longer reaches stdout at all', async () => {
      // The other half of the class: a byte that DRIVES a terminal rather than ending a
      // line. One row either way — but now the escape is a visible placeholder instead
      // of an instruction to the terminal `ralph init` is printing to.
      const { stdout } = await initInteractively({ answers: ['jira', `project = R${ESC}[2J`, ''] })
      expect(stdout).not.toContain(ESC)
      expect(stdout.split(LF).filter((r) => r.startsWith('  JIRA_JQL:'))).toEqual([
        `  JIRA_JQL:     project = R${PLACEHOLDER}[2J`,
      ])
    })

    it('structurally: the JQL row goes through oneLineEcho, like this command’s other echoes', async () => {
      // The behavioural pins above say what happens; this says WHERE. `oneLineEcho`
      // appears four times in init.js with comments stripped — the import, the
      // `❌ Unknown agent` and `❌ Unknown task source` echoes, and the summary row.
      const INIT = fileURLToPath(new URL('./commands/init.js', import.meta.url))
      const code = codeWithoutComments(INIT)
      expect((code.match(/oneLineEcho/g) ?? []).length).toBe(4)
      const summaryRow = code.slice(code.indexOf("source === 'jira'"))
      expect(summaryRow).toContain('JIRA_JQL:')
      expect(summaryRow.slice(0, summaryRow.indexOf(')\n'))).toContain('oneLineEcho')
      // ANTI-VACUITY: a bad path or an over-eager comment strip would make the positive
      // pass for free. Measured, stripping comments leaves just under half of init.js
      // (~49%, this file being as prose-heavy as it is), so the floor at 0.45 of the raw
      // file sits below that with real margin rather than at a number a 90% strip would
      // still clear. The RATIO is what is pinned, deliberately: an exact byte count here
      // would go stale on the next comment edit to init.js, which is how the figures this
      // replaces came to be wrong.
      expect(code).toContain('printSummary')
      expect(code.length).toBeGreaterThan(readFileSync(INIT, 'utf8').length * 0.45)
    })

    it('structurally: interpolate’s unknown-placeholder warning is routed to the command’s stderr', async () => {
      // Review round 1: this argument cannot be reached behaviourally — every placeholder
      // in templates/ralph.config.sh is a key init supplies, so `interpolate` never warns
      // from here, and measured, deleting the argument fails NOTHING in the suite. It is
      // still the right call (interpolate defaults to process.stderr, and this command
      // takes an injected one), so it is pinned where it can be: at the source. If a
      // future template gains a placeholder init does not pass, the warning lands on the
      // caller's stream — and this pin is what keeps that true.
      const INIT = fileURLToPath(new URL('./commands/init.js', import.meta.url))
      const code = codeWithoutComments(INIT)
      expect(code).toMatch(/interpolate\(readTemplate\('ralph\.config\.sh'\), vars, \{ stderr \}\)/)
      // ...and writeConfig has to actually take it, rather than closing over a global.
      expect(code).toMatch(/function writeConfig\(\{[^}]*\bstderr\b[^}]*\}\)/)
      // ANTI-VACUITY: the strip has to have left real code behind.
      expect(code).toContain('function writeConfig')
    })
  })

  describe('the picker never aborts and never lands off VALID_SOURCES', () => {
    // `resolveSourceChoice` does `String(choice ?? '').trim().toLowerCase()` and then a
    // membership test, so the promise is total: whatever comes back, init writes a config.
    // `promptSource` is an injected option (#41), so what comes back need not be a string.
    it.each([
      ['a number', 7, 'github'],
      ['zero', 0, 'github'],
      ['true', true, 'github'],
      ['false', false, 'github'],
      ['null', null, 'github'],
      ['undefined', undefined, 'github'],
      ['a plain object', {}, 'github'],
      ['an empty array', [], 'github'],
      ['a two-element array', ['github', 'folder'], 'github'],
      // `String(['jira'])` is 'jira', so a one-element array DOES select jira. Pinned as
      // the coercion it is rather than as an intention.
      ['a ONE-element array, which coerces to its member', ['jira'], 'jira'],
      ['a String object', new String('JIRA'), 'jira'],
      ['an object with a toString', { toString: () => ' Folder ' }, 'folder'],
      ['10000 characters', 'x'.repeat(10000), 'github'],
      ['a valid name with trailing punctuation', 'jira,', 'github'],
      ['a valid name with a trailing period', 'folder.', 'github'],
      ['SHOUTED', 'GITHUB', 'github'],
      ['a trailing space', 'github ', 'github'],
      ['mixed case with tabs', `${TAB}JiRa${TAB}`, 'jira'],
      ['a forged second line', `folder${LF}TASK_SOURCE="jira"`, 'github'],
      ['a NUL glued on', `folder${NUL}`, 'github'],
      ['a U+2028 glued on', `folder${LS}`, 'folder'],
    ])('%s -> %s, exit 0, and a config on disk', async (_label, returned, expected) => {
      const { result, config } = await initInteractively({
        promptSource: async () => returned,
        // The JQL/status answers, for the rows that land on jira.
        answers: ['', ''],
      })
      expect(result.exitCode).toBe(0)
      expect(result.source).toBe(expected)
      expect(assignmentLine(config, 'TASK_SOURCE')).toBe(`TASK_SOURCE="${expected}"`)
      // Nothing the answer contained reaches the file: writeConfig interpolates the
      // RESOLVED source, the way it does the resolved agent (#108).
      expect(config).not.toContain(NUL)
      expect(config.split(LF).filter((l) => l.startsWith('TASK_SOURCE='))).toHaveLength(1)
    })

    it('a promptSource whose coercion THROWS escapes as a plain Error, writing nothing', async () => {
      // The boundary of "total", and the same shape init.qa.test.js already pins for the
      // --agent flag: a value that cannot BE a string never becomes a source. Not an
      // InitAbort, so bin/ralph.js re-throws it. Only reachable programmatically.
      const vol = newVol()
      const caught = await run(vol, {
        isTTY: true,
        home: '/home/test',
        processEnv: {},
        ask: async () => false,
        promptAgent: async () => 'claude',
        promptValue: async () => '',
        promptSource: async () => ({ toString: () => { throw new Error('nope') } }),
      }).catch((e) => e)
      expect(caught).toBeInstanceOf(Error)
      expect(caught).not.toBeInstanceOf(InitAbort)
      expect(caught.message).toBe('nope')
      expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
    })
  })

  describe('no TTY: nothing prompts, for every source, and nothing hangs', () => {
    it.each([
      [null, 'github', ''],
      [undefined, 'github', ''],
      ['   ', 'github', ''],
      ['github', 'github', ''],
      ['folder', 'folder', ''],
      ['jira', 'jira', DEFAULT_JQL],
      ['  JIRA  ', 'jira', DEFAULT_JQL],
    ])('--source %j reaches no prompt seam at all', async (source, expected, expectedJql) => {
      // `resolveJiraSettings` returns early on `!isTTY`, and `resolveSourceChoice` never
      // calls promptSource — so EVERY seam is asserted untouched rather than just the one
      // the code path was written about. Any of them reaching real readline would hang
      // the suite on stdin, which is the failure this is really guarding.
      const touched = []
      const vol = newVol()
      const result = await run(vol, {
        isTTY: false,
        source,
        home: '/home/test',
        processEnv: {},
        ask: async (q) => (touched.push(['ask', q]), false),
        promptValue: async (q) => (touched.push(['promptValue', q]), ''),
        promptAgent: async () => (touched.push(['promptAgent']), 'claude'),
        promptSource: async () => (touched.push(['promptSource']), 'github'),
      })
      expect(touched).toEqual([])
      expect(result.source).toBe(expected)
      expect(result.jiraJql).toBe(expectedJql)
      expect(result.exitCode).toBe(0)
    })
  })

  describe('a prompt that rejects leaves NO half-written scaffold', () => {
    it.each([
      ['the picker', 1],
      ['the JQL prompt', 2],
      ['the done-status prompt', 3],
    ])('a throw at %s writes nothing at all', async (_label, failOn) => {
      // Every question this command has is asked BEFORE the first write — init.js says
      // so in a comment ("before any file is written... so every question this command
      // has is over before it starts scaffolding") and this is the assertion behind it.
      // A partial scaffold would be the worst outcome available: `writeConfig` refuses to
      // overwrite an existing ralph.config.sh, so a half-written one survives every
      // later `ralph init`.
      const vol = newVol()
      let n = 0
      const caught = await run(vol, {
        isTTY: true,
        home: '/home/test',
        processEnv: {},
        ask: async () => false,
        promptAgent: async () => 'claude',
        promptValue: async () => {
          n += 1
          if (n === failOn) throw new Error('stdin closed')
          return 'jira'
        },
      }).catch((e) => e)
      expect(caught).toBeInstanceOf(Error)
      expect(caught.message).toBe('stdin closed')
      for (const path of [
        'ralph.config.sh',
        'PROMPT.md',
        '.env.local.example',
        'ralph-notify.sh.example',
        '.gitignore',
        '.ralph',
        '.claude/commands/ralph.md',
      ]) {
        expect(vol.existsSync(`${PROJECT}/${path}`), path).toBe(false)
      }
    })
  })

  describe('github and folder: byte-for-byte the lines the template shipped before #133', () => {
    it.each([
      ['github at the picker', { answers: [''] }, false],
      ['folder at the picker', { answers: ['folder'] }, true],
      ['github by flag', { source: 'github' }, false],
      ['folder by flag', { source: 'folder' }, true],
      ['github with no TTY', { isTTY: false }, false],
      ['folder with no TTY', { isTTY: false, source: 'folder' }, true],
    ])('%s: the two knob lines are the pre-#133 literals, and both still read as ASSIGNED', async (_label, opts, scaffolds) => {
      // THE NO-REGRESSION HALF, stated against the literal bytes rather than against the
      // current template — `JIRA_JQL=""` and `JIRA_DONE_STATUS=""` are what
      // templates/ralph.config.sh hardcoded before this slice turned both into
      // placeholders (see the diff), so a github or folder init writing anything else
      // would be a change to a mode #133 was not about.
      const { config, vol } = await initInteractively(opts)
      expect(assignmentLine(config, 'JIRA_JQL')).toBe('JIRA_JQL=""')
      expect(assignmentLine(config, 'JIRA_DONE_STATUS')).toBe('JIRA_DONE_STATUS=""')
      // Present-but-empty, which is the distinction lib/parse-config-var.js exists to
      // make: an absent assignment leaves an exported value alone, a blank one overwrites
      // it. Turning a hardcoded literal into a placeholder is exactly the change that
      // could have dropped the line, and '' alone cannot tell you it did.
      for (const knob of ['JIRA_JQL', 'JIRA_DONE_STATUS']) {
        expect(configAssignsVar(config, knob), knob).toBe(true)
        expect(parseConfigVar(config, knob), knob).toBe('')
      }
      // The scaffold either side of the change: folder gets both lanes and the four afk
      // status dirs, github gets nothing.
      const dirs = [
        '.ralph/tasks/afk/todo',
        '.ralph/tasks/afk/in-progress',
        '.ralph/tasks/afk/done',
        '.ralph/tasks/afk/failed',
        '.ralph/tasks/hitl/todo',
      ]
      for (const d of dirs) expect(vol.existsSync(`${PROJECT}/${d}`), d).toBe(scaffolds)
      if (!scaffolds) expect(vol.existsSync(`${PROJECT}/.ralph`)).toBe(false)
    })
  })

  describe('template / interpolation coupling', () => {
    const TEMPLATE = fileURLToPath(new URL('../templates/ralph.config.sh', import.meta.url))
    const text = () => readFileSync(TEMPLATE, 'utf8')

    it('the COMMENTED example assignments were not converted to placeholders', () => {
      // #133 rewrote two live assignments; the prose around them contains four more
      // `JIRA_...=` strings that read exactly like assignments and must stay as they are,
      // because they are the only worked examples a user of a scaffolded repo has. A
      // sweep that "updated all the JIRA_JQL lines" would have taken these too.
      const lines = text().split(LF).filter((l) => /JIRA_(JQL|DONE_STATUS)\s*=/.test(l))
      expect(lines).toEqual([
        '# JIRA_JQL="project = RALPH AND statusCategory != Done AND assignee = currentUser()"',
        '# it for a comment, so JIRA_JQL="summary ~ \\"#123\\"" reaches Jira truncated: the query is',
        '# quotes, JIRA_JQL=\'summary ~ "#123"\', or write the JQL literal with them,',
        '# JIRA_JQL="summary ~ \'#123\'". A query with no `#` in it is unaffected.',
        'JIRA_JQL={{JIRA_JQL}}',
        '# JIRA_DONE_STATUS="Done"',
        'JIRA_DONE_STATUS={{JIRA_DONE_STATUS}}',
      ])
    })

    it('every OTHER placeholder still carries the template’s own quotes', () => {
      // The Jira pair is the exception; the other eight must not have been dragged along
      // with it, because init passes those values RAW and a bare right-hand side would
      // make a value with a space in it (`INSTALL_CMD=npm ci`) run as a command.
      for (const key of [
        'INSTALL_CMD',
        'TEST_CMD',
        'LINT_CMD',
        'MAIN_BRANCH',
        'DEV_BRANCH',
        'PR_TARGET',
        'RALPH_AGENT',
        'TASK_SOURCE',
      ]) {
        expect(text().split(LF).filter((l) => l.startsWith(`${key}=`)), key).toEqual([
          `${key}="{{${key}}}"`,
        ])
      }
    })

    it('a BARE right-hand side — what a missing interpolation would leave — is harmless in both readers', async () => {
      // `interpolate` substitutes '' for a knob passed as null or undefined, so a knob
      // init passed nothing FOR would ship as `JIRA_JQL=` with nothing after it (a knob it
      // does not pass AT ALL is a different case: the shared helper leaves that
      // placeholder intact and warns, which the block above drives). Measured, a bare
      // right-hand side is not a syntax error and
      // both readers agree it is empty, so the failure mode of the new unquoted
      // placeholder shape is "inert", not "broken file". init always passes both (the
      // rows above prove it), so this is the floor rather than a path.
      const bare = `JIRA_JQL=${LF}JIRA_DONE_STATUS=${LF}`
      expect(await bashValue('JIRA_JQL=', 'JIRA_JQL')).toBe('')
      expect(parseConfigVar(bare, 'JIRA_JQL')).toBe('')
      expect(configAssignsVar(bare, 'JIRA_JQL')).toBe(true)
      const probe = await sourceWholeFile(bare, ['JIRA_JQL', 'JIRA_DONE_STATUS'])
      expect(probe.syntaxExit).toBe(0)
      expect(probe.sourcedErr).toBe('')
      expect(probe.values).toEqual({ JIRA_JQL: '', JIRA_DONE_STATUS: '' })
    })

    it('a jira init leaves no mustache anywhere and assigns each of the ten knobs exactly once', async () => {
      const { config } = await initInteractively({ answers: ['jira', '', ''] })
      expect(config).not.toMatch(/\{\{|\}\}/)
      for (const key of [
        'INSTALL_CMD',
        'TEST_CMD',
        'LINT_CMD',
        'MAIN_BRANCH',
        'DEV_BRANCH',
        'PR_TARGET',
        'RALPH_AGENT',
        'TASK_SOURCE',
        'JIRA_JQL',
        'JIRA_DONE_STATUS',
      ]) {
        expect(config.split(LF).filter((l) => l.startsWith(`${key}=`)), key).toHaveLength(1)
        expect(configAssignsVar(config, key), key).toBe(true)
      }
    })
  })
})
