import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { initCommand, InitAbort } from './commands/init.js'

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
        // Decline every gate rather than letting `confirm` reach the suite's stdin.
        ask: async () => false,
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
    run(vol, { isTTY: false, home: HOME, processEnv: {}, ask: async () => false, ...opts })

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
      // not into a second interpolation. The one legitimate `JIRA` in the template is
      // the JIRA_JQL variable name it has declared since #126, so that identifier is
      // removed before looking; anything else uppercase is the flag text escaping.
      expect(configOf(vol).split('JIRA_JQL').join(''), source).not.toContain('JIRA')
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
    // ...and the two configs differ in exactly the one line.
    const diff = (a, b) => a.split(LF).filter((l, i) => l !== b.split(LF)[i])
    expect(diff(configOf(jiraVol), configOf(githubVol))).toEqual(['TASK_SOURCE="jira"'])
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
    // Placeholder parity: the template asks for exactly the eight vars init fills.
    expect([...new Set(text.match(/\{\{[A-Z_]+\}\}/g))].sort()).toEqual([
      '{{DEV_BRANCH}}',
      '{{INSTALL_CMD}}',
      '{{LINT_CMD}}',
      '{{MAIN_BRANCH}}',
      '{{PR_TARGET}}',
      '{{RALPH_AGENT}}',
      '{{TASK_SOURCE}}',
      '{{TEST_CMD}}',
    ])
  })
})
