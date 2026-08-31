// QA #119 — THE COVERAGE CLAIM ITSELF, and the two channels no row was pointed at.
//
// #119 replaced a source sweep with behaviour, and the behaviour half holds: drive any printer
// in lib/agent-registry.warning.consumers.qa.test.js's roster into silence and its row goes red;
// teach any silent caller to print — as a destructure, as `resolveAgent(env).warning`, through a
// variable, by spread, or through a helper that passes the object along — and its row goes red
// too; refactor an existing printer's destructure into a property read and every row stays
// green, which is the exact false red #69's regex produced. None of that is what this file is
// about, because none of it needs help.
//
// WHAT NEEDS HELP IS THE SENTENCE THAT MAKES THOSE ROWS A SPECIFICATION RATHER THAN A LIST.
// "One row per call site" is only worth anything if a new call site cannot appear without a row,
// and that claim is carried by a single sweep: the set of modules under lib/ whose comment-
// stripped source contains the token `resolveAgent`, compared against the set of modules the
// rows name. That sweep answers a narrower question than the roster claim needs, in four ways
// that were each confirmed by planting the caller and watching the suite stay green. Its own
// comment names three of them and points here for the closing — 4 is a variant of 3, split out
// below because it is worth naming even though one fix covers both — so what follows widens that
// question rather than restating it:
//
//   1. IT COUNTS MODULES, NOT CALL SITES. lib/commands/doctor.js is in the roster twice —
//      `doctorCommand` prints, `assertCriticalDeps` does not — and the comparison dedupes by
//      module, so a SECOND reader added to any module already on the list is invisible. A new
//      printer inside `ralph start` is the realistic shape of that, and it is the shape #118
//      had just finished adding.
//   2. IT SWEEPS lib/ ONLY. bin/ralph.js is the process's entry point and imports these
//      commands; a resolver call and a print added THERE is outside the swept tree entirely.
//   3. IT KEYS ON AN IDENTIFIER, and an identifier can be renamed at the boundary. Give the
//      registry `export { resolveAgent as pickAgent }` and a consumer that imports `pickAgent`
//      contains no occurrence of the swept token, in code or in prose.
//   4. …and the same for a computed read off a dynamic namespace object. That last one is
//      contrived; the first three are not.
//
// So the roster is re-asked here as a question about the IMPORT EDGE. There is exactly one way
// into `resolveAgent` — importing lib/agent-registry.js — and a module names the module it
// imports whatever it then calls the binding, statically or through `import()`. Widening the
// tree to bin/ and scripts/ closes 2, and keying on the edge instead of the identifier closes 3
// and 4 together, without asking #119's forbidden question: an edge says WHICH MODULES CAN
// REACH THE RESOLVER, never how any of them spells the read. 1 is the one the edge cannot
// carry, because an edge is a module and a row is a call site, so the per-module CALL COUNT is
// pinned beside it — a count of calls, which is what a row drives, and not a count of reads.
//
// THE CHANNELS. `observe` in the consumers file folds each driver's artefact into a third
// channel called `elsewhere`, and for two rows that fold is narrower than the row's real
// surface:
//
//   ralph init   FOLDS IN ONE OF SIX FILES. The driver reads back ralph.config.sh, which is the
//                file the loop sources and the obvious place for a diagnostic to end up dead.
//                But `initCommand` also writes PROMPT.md, .env.local.example,
//                ralph-notify.sh.example, .claude/commands/ralph.md and .gitignore, and a
//                warning appended to any of those is a diagnostic checked into the user's repo.
//                Planting it in PROMPT.md leaves every row green.
//   exec argv    IS NOT A CHANNEL ANYWHERE. `ralph start`'s last act is to hand tmux a command
//                line, and `ralph init`/`ralph cycle` shell out to git and gh. An argv is a
//                channel a user reads — it is in `ps`, in the tmux session list and in any
//                shell history or audit log that records the spawn — and nothing watches it.
//
// EACH CHANNEL GETS THE NEEDLES IT CAN BEAR, and the two above do not get the same set — the
// helpers say why at length, because the temptation is to "tighten" the shorter one. The bare word
// `unrecognized` is a needle in NEITHER file: lib/banner-mode.js composes `RALPH_BANNER=<value>
// unrecognized; falling back to '<default>'. Valid: …` for a different knob, so that word names
// THE WORDING OF A FALLBACK WARNING IN GENERAL rather than this warning, which is #69's ambiguity
// wearing a needle's clothes. A generated FILE bears all three needles this file does use — the
// sentence, the `RALPH_AGENT='` prefix, the raw value — and templates/ralph.config.sh is the
// reason to check that rather than assume it, because the template does carry this knob: line 21
// renders `RALPH_AGENT="{{RALPH_AGENT}}"` in DOUBLE quotes, filled by lib/commands/init.js:156
// with the agent init's own resolver RETURNED, so a correctly generated scaffold matches none of
// the three. An ARGV bears the SENTENCE ONLY, because `ralph start` forwards the raw configured
// `RALPH_AGENT` into the digest window's command line in single quotes: a repo that committed
// `codx` has an argv containing `RALPH_AGENT='codx'` while behaving exactly as designed, so
// keying a command line on the assignment prefix or the value would red on correct behaviour —
// #119's own false-red shape, one channel over. The sentence survives that distinction, and not
// on faith: planting it in the launch command line reds the argv row, and so does planting it in
// the digest window's own line, the one string that legitimately carries the assignment already.
//
// AND SILENCE IS ASSERTED AGAINST THE RAW VALUE, NOT ONLY AGAINST THE SENTENCE. The consumers
// file drives every row with `codx`, and both of its needles are properties of the composed
// warning; the raw value contains neither. So a caller that echoed `env.RALPH_AGENT` straight
// out — into a telemetry line, a state file, a returned message — would satisfy every silence
// assertion in that file while committing the #108 defect in its original form: an
// unsanitised value, on a channel, able to forge a line. The rows below drive the same six
// callers with a value carrying a marker no source contains plus a NUL and an ESC, and ask for
// the marker's absence. One needle then covers both echoes, because the sanitiser keeps
// printable characters: the sentence for this value contains the marker too.
//
// Every seam stays injected (#41) and nothing here spawns a process or touches the network.
// Control characters are built from their code points (#107).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Volume } from 'memfs'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { resolveAgent } from './agent-registry.js'
import { buildPrompt } from './build-prompt.js'
import { buildDigestInvocation } from './digest.js'
import { captureIssueEvent } from './capture-issue-event.js'
import { finalizeState } from './finalize-state.js'
import { EMPTY_VERSION_CACHE } from './version-cache.js'
import { assertCriticalDeps } from './commands/doctor.js'
import { initCommand } from './commands/init.js'
import { startCommand } from './commands/start.js'
import { cycleCommand } from './commands/cycle.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LF = String.fromCharCode(0x0a)
const NUL = String.fromCharCode(0x00)
const ESC = String.fromCharCode(0x1b)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const stripAnsi = (text) => String(text).replace(SGR, '')

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const CLAUDE_CREDS = join(HOME, '.claude', '.credentials.json')

const TYPO = 'codx'
const SENTENCE = resolveAgent({ RALPH_AGENT: TYPO }).warning
const ASSIGNMENT = "RALPH_AGENT='"

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(String(s))
      return true
    },
    output: () => chunks.join(''),
  }
}

// ---------------------------------------------------------------------------------------------
// THE ROSTER, RE-ASKED AS A QUESTION ABOUT THE IMPORT GRAPH
// ---------------------------------------------------------------------------------------------

describe('QA #119 — the roster is complete on the IMPORT EDGE, not on an identifier', () => {
  // The whole tree a `ralph` process runs code from, not just lib/. bin/ralph.js is the entry
  // point and scripts/ is built by `npm run` — a resolver call in either is as reachable as one
  // in a command module, and #119's sweep reads neither.
  const sources = (dir, acc = []) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) sources(path, acc)
      else if (entry.endsWith('.js') && !entry.includes('.test.')) acc.push(path)
    }
    return acc
  }
  const FILES = ['lib', 'bin', 'scripts'].flatMap((d) => sources(join(ROOT, d)))
  const named = (path) => path.slice(ROOT.length)
  const code = new Map(FILES.map((path) => [named(path), codeWithoutComments(path)]))

  // THE SPECIFIER, and nothing else about the statement it appears in. A static
  // `from './agent-registry.js'`, a dynamic `import('../agent-registry.js')`, a `require()`
  // through `createRequire`, a re-export — every one of them has to write the path down, and
  // the path is the one part of the edge that cannot be renamed. Matching the string literal
  // rather than the keyword in front of it is what makes this immune to the FORM of the import
  // as well as to the name of the binding; `codeWithoutComments` is what keeps the three
  // modules that discuss the registry in prose (banner-model, install-failure, task-source)
  // from being counted as callers, which is the #69 trap in its original direction.
  const EDGE = /['"][^'"]*agent-registry\.js['"]/

  // The modules the behavioural rows in lib/agent-registry.warning.consumers.qa.test.js name,
  // one entry per module, and the number of times each of them CALLS the resolver — which is
  // one entry per ROW, and the difference between the two columns is the whole of hole 1.
  const ROWS_PER_MODULE = {
    'lib/agent-invocation.js': 1, // the bash bridge (printer, as a field)
    'lib/build-prompt.js': 1, // buildPrompt (silent)
    'lib/capture-issue-event.js': 1, // captureIssueEvent (silent)
    'lib/commands/cycle.js': 1, // ralph cycle preflight (silent)
    'lib/commands/doctor.js': 2, // doctorCommand (printer) + assertCriticalDeps (silent)
    'lib/commands/init.js': 1, // ralph init (printer)
    'lib/commands/start.js': 1, // ralph start (printer)
    'lib/digest.js': 1, // buildDigestInvocation (silent)
    'lib/finalize-state.js': 1, // finalizeState (silent)
  }
  const ROSTER = Object.keys(ROWS_PER_MODULE).sort()
  const ROW_COUNT = Object.values(ROWS_PER_MODULE).reduce((a, b) => a + b, 0)

  it('names every module in lib/, bin/ and scripts/ that imports the registry, and nothing else', () => {
    const importers = [...code.entries()]
      .filter(([, text]) => EDGE.test(text))
      .map(([name]) => name)
      .sort()
    expect(importers).toEqual(ROSTER)
  })

  it('leaves the registry no second name, so the edge cannot be crossed unnamed', () => {
    // Hole 3 closed from the other end as well as by the sweep above: `export { x as y }` in the
    // registry, or a re-export of it from a third module, would give a caller a binding whose
    // name says nothing about where it came from. The registry publishes three bindings and it
    // publishes them all as declarations, which is a property worth pinning on its own — the
    // #108 import-graph test in lib/agent-registry.warning.qa.test.js already depends on this
    // module's shape being boring.
    const registry = code.get('lib/agent-registry.js')
    expect(registry).toBeDefined()
    const declared = [...registry.matchAll(/^\s*export\s+(?:const|function)\s+(\w+)/gm)].map(
      (m) => m[1],
    )
    expect(declared.sort()).toEqual(['VALID_AGENTS', 'agentSpec', 'resolveAgent'])
    expect(registry).not.toMatch(/export\s*(?:\{|\*)/)

    const reExporters = [...code.entries()]
      .filter(([, text]) => /export\s*(?:\{[^}]*\}|\*)\s*from\s*['"][^'"]*agent-registry\.js['"]/.test(text))
      .map(([name]) => name)
    expect(reExporters).toEqual([])
  })

  it('has one row per CALL SITE, not one per module', () => {
    // Hole 1. `lib/commands/doctor.js` proves a module can hold two readers with opposite
    // specifications, so the module list cannot be the coverage claim: a print added to a
    // second function inside any module already on the list changes no module set at all.
    // Counting calls is not counting spellings — a call is what a row drives; how it takes the
    // result apart is exactly what #119 stopped asserting.
    const calls = {}
    for (const [name, text] of code) {
      if (name === 'lib/agent-registry.js') continue // where it is DECLARED, not called
      const n = (text.match(/\bresolveAgent\s*\(/g) || []).length
      if (n > 0) calls[name] = n
    }
    expect(calls).toEqual(ROWS_PER_MODULE)
    expect(Object.values(calls).reduce((a, b) => a + b, 0)).toBe(ROW_COUNT)
    expect(ROW_COUNT).toBe(10)
  })

  it('sanity-checks both sweeps, so neither can pass by finding nothing', () => {
    // ANTI-VACUITY, and one clause per way the sweep above could be trivially satisfied: an
    // empty walk, a tree that stops at lib/, a regex that matches the registry's own path
    // because the file is named after itself, and a comparison of two one-element lists.
    expect(FILES.length).toBeGreaterThan(60)
    expect([...code.keys()]).toContain('bin/ralph.js')
    expect([...code.keys()]).toContain('scripts/generate-sprite.js')
    expect(EDGE.test(code.get('lib/agent-registry.js'))).toBe(false)
    expect(ROSTER.length).toBeGreaterThan(5)
  })
})

// ---------------------------------------------------------------------------------------------
// THE CHANNELS NO ROW WATCHES: EVERY GENERATED FILE, AND EVERY ARGV
// ---------------------------------------------------------------------------------------------

/** Which of a given set of needles a channel's text carries, colour discounted. */
const carries = (text, needles) => {
  const haystack = stripAnsi(String(text ?? ''))
  return needles.filter((needle) => haystack.includes(needle))
}

/**
 * Needles a GENERATED FILE can never legitimately contain — all three of them.
 *
 * The resolver's whole sentence, the `RALPH_AGENT='` prefix only it composes, and the typo the
 * driver was given. The file channel earns all three, and templates/ralph.config.sh is the reason
 * to check rather than assume: that template DOES carry this knob, at line 21, through
 * `{{RALPH_AGENT}}`. But `ralph init` substitutes the agent its own resolver RETURNED
 * (lib/commands/init.js:156) — `claude` for a typo, never the typo — and the template spells the
 * assignment with DOUBLE quotes, so a correctly generated scaffold contains neither
 * `RALPH_AGENT='` nor `codx`. What is deliberately not a needle in EITHER file of this pair is the
 * bare word `unrecognized`: lib/banner-mode.js:174-177 composes the same sentence shape for
 * RALPH_BANNER, so the word names the wording of a fallback warning in general rather than this
 * warning — see the header.
 */
const fileLeaks = (text) => carries(text, [SENTENCE, ASSIGNMENT, TYPO])

/**
 * The one needle an ARGV can never legitimately contain: the resolver's whole sentence.
 *
 * ASSIGNMENT and TYPO are deliberately NOT asked of a command line, and their absence here is the
 * difference between two channels rather than a weakening of one. `ralph start` forwards this
 * repo's configured agent into the digest window it opens: `openDigestWindow`'s `envPrefix`
 * (lib/commands/start.js:1029) builds `RALPH_AGENT=${shellQuote(agent)} ` into the `tmux
 * new-window` command line, out of `parseConfigVar(configText, 'RALPH_AGENT').trim()` — passed in
 * at the call site, lib/commands/start.js:921 — the RAW
 * config value, not the resolved one — because `ralph digest` resolves its own agent from its
 * environment and `ralph start` never sources ralph.config.sh, so a window that inherited the
 * launching shell's value would narrate the run with the wrong model all night.
 * templates/ralph.config.sh:252-253 documents that forwarding as a promise to the user. `shellQuote`
 * uses SINGLE quotes, so a repo whose config says `codx` has a command line containing the exact
 * bytes `RALPH_AGENT='codx'` — ASSIGNMENT and TYPO both — while behaving exactly as designed: the
 * typo is forwarded so the WINDOW falls back and warns for itself, the same way the loop does.
 *
 * So keying an argv on those two would go red on correct behaviour, which is precisely the false
 * red #119 was filed about, reintroduced one channel over. Do not tighten it back. The SENTENCE is
 * a different claim and it survives the distinction intact: nothing but `resolveAgent` composes
 * that string, and no command line has any business carrying a diagnostic. Measured rather than
 * assumed, twice: appending the warning to the LAUNCH command line reds the row below, and so does
 * appending it to the digest window's own command line — the one string here that legitimately
 * carries `RALPH_AGENT='codx'` already. One needle is enough because the sentence is the leak.
 */
const argvLeaks = (text) => carries(text, [SENTENCE])

async function runInit(value, { stdout, stderr, execd }) {
  const vol = Volume.fromJSON({ [`${REPO}/.keep`]: '' }, '/')
  const exec = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    execd.push(key)
    if (key === 'git rev-parse --show-toplevel') return { exitCode: 0, stdout: REPO, stderr: '' }
    if (key === 'git symbolic-ref refs/remotes/origin/HEAD') {
      return { exitCode: 0, stdout: 'refs/remotes/origin/main', stderr: '' }
    }
    if (key === 'git branch -a') return { exitCode: 0, stdout: `* main${LF}`, stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const result = await initCommand({
    cwd: REPO,
    stdout,
    stderr,
    exec,
    fs: vol,
    // The prompt, not the flag: #560 rejects an invalid `--agent` before the resolver runs.
    agent: null,
    source: 'github',
    isTTY: true,
    promptAgent: async () => value,
    ask: async () => false,
    promptValue: async () => '',
    home: HOME,
    processEnv: {},
  })
  return { result, files: vol.toJSON() }
}

async function runStart(value, { stdout, stderr, execd }) {
  stdout.isTTY = true
  // A REPO THAT COMMITTED THE TYPO AND ASKED FOR A DIGEST, and every line of that is load-bearing
  // for the argv row (see `argvLeaks`).
  //
  // RALPH_DIGEST_INTERVAL is what opens the digest window AT ALL: templates/ralph.config.sh ships
  // it empty, `digestInterval` reads empty as off, and with it off `openDigestWindow` is never
  // called — so the one argv in this command that carries `RALPH_AGENT=` is never built and a row
  // asserting an argv is clean would be asserting it of a channel the fixture had quietly closed.
  // An earlier version of this file did exactly that, and passed for it.
  //
  // The agent is stated in the CONFIG rather than only in the environment because a config
  // assignment is what start.js forwards. It also happens to be what start.js RESOLVES from — a
  // configured value beats an ambient one, deliberately, because a task source and an agent are
  // properties of the repository — so this single line drives the printed warning and the
  // forwarded command line at once, which is the whole scenario in one knob. `processEnv` is left
  // empty for the same reason: nothing here should be attributable to the shell that ran vitest.
  const config = [
    `RALPH_AGENT="${value}"`,
    'TASK_SOURCE=folder',
    'RALPH_DIGEST_INTERVAL="30m"',
    '',
  ].join(LF)
  const exec = async (cmd, args) => {
    execd.push(`${cmd} ${(args ?? []).join(' ')}`)
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return startCommand({
    cwd: REPO,
    stdout,
    stderr,
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
    folderQueueCount: async () => 3,
    home: HOME,
    processEnv: {},
    // Injected, as start.js's own comment invites: the digest command line names this path, and an
    // argv row must not depend on how the test runner happened to be spawned.
    ralphBinary: join(REPO, 'node_modules', '.bin', 'ralph'),
    sleep: async () => {},
    signals: null,
  })
}

describe('QA #119 — the channels a driver was not pointed at', () => {
  it('ralph init leaves the warning out of every file it generates, not just ralph.config.sh', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const execd = []
    const { result, files } = await runInit(TYPO, { stdout, stderr, execd })

    // Observability first, on the same terms every row in the consumers file uses: the typo
    // reached init's resolver, fell back, and was reported once on the stream init warns on.
    expect(result.agent).toBe('claude')
    expect(
      stripAnsi(stderr.output())
        .split(LF)
        .filter((line) => line.includes(SENTENCE)),
    ).toHaveLength(1)

    // ...and the scaffold init just wrote is six files, all of which the user keeps.
    const written = Object.entries(files).filter(([path]) => path !== `${REPO}/.keep`)
    expect(written.length).toBeGreaterThanOrEqual(6)
    for (const [path, body] of written) {
      expect(fileLeaks(body), `${path} carries the warning`).toEqual([])
    }
  })

  it('ralph init and ralph start put the warning in no argv they hand to exec, digest window included', async () => {
    for (const [label, drive] of [
      ['ralph init', runInit],
      ['ralph start', runStart],
    ]) {
      const stdout = makeStream()
      const stderr = makeStream()
      const execd = []
      await drive(TYPO, { stdout, stderr, execd })

      // An argv channel that was never written to would make this pass on nothing, so the spawns
      // are asserted to have happened before they are asserted to be clean. A command line is the
      // one Ralph writes and never controls the reading of: it is in `ps`, in `tmux list-sessions`,
      // in any shell history or audit log that records the spawn.
      expect(execd.length, label).toBeGreaterThan(1)
      if (label === 'ralph start') {
        // BOTH tmux spawns, and the second one is the reason this fixture configures a digest.
        // `tmux new -d -s` launches the loop; `tmux new-window` opens the digest beside it and is
        // the ONE argv in this repo that legitimately carries this knob. Its payload is asserted
        // POSITIVELY — the exact bytes `argvLeaks` refuses to key on — so the channel cannot go
        // quiet again the way it did before: a change that stops the digest window from opening,
        // or stops it forwarding the agent, fails HERE rather than reducing the sweep below to a
        // walk over an empty list.
        expect(execd.some((key) => key.startsWith('tmux new -d ')), label).toBe(true)
        const digestArgv = execd.filter((key) => key.startsWith('tmux new-window'))
        expect(digestArgv, label).toHaveLength(1)
        expect(digestArgv[0]).toContain(`${ASSIGNMENT}${TYPO}'`)
        expect(digestArgv[0]).toContain('digest --loop --interval')
      }
      expect(
        stripAnsi(stderr.output())
          .split(LF)
          .filter((line) => line.includes(SENTENCE)),
        label,
      ).toHaveLength(1)
      for (const key of execd) {
        expect(argvLeaks(key), `${label} argv: ${key}`).toEqual([])
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------
// SILENCE, ASKED OF THE RAW VALUE AS WELL AS OF THE SENTENCE
// ---------------------------------------------------------------------------------------------

// A marker no file in the repo contains, wrapped in a value that is still a typo of `codex` and
// still carries the two bytes #108 is about. Because the sanitiser replaces control characters
// one for one and leaves printable text alone, the marker survives into the composed warning —
// so ONE needle catches both a raw echo and a sanitised one, and the NUL/ESC clauses then say
// which of the two it was.
const MARK = 'qa119rawecho'
const HOSTILE = `co${MARK}dx${LF}${ESC}[31m${NUL}`

let sandbox
beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-119-coverage-qa-'))
})
afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
})

/** One silent caller, driven with a raw value, reporting the agent and every channel it used. */
async function observeSilent(drive, value) {
  const stdout = makeStream()
  const stderr = makeStream()
  const logged = []
  const escaped = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (chunk, ...rest) => {
    escaped.push(String(chunk))
    return realOut(chunk, ...rest)
  }
  process.stderr.write = (chunk, ...rest) => {
    escaped.push(String(chunk))
    return realErr(chunk, ...rest)
  }
  let observed
  try {
    observed = await drive(value, { stdout, stderr, log: (m) => logged.push(String(m)) })
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
  return {
    agent: observed?.agent ?? null,
    channels: [stdout.output(), stderr.output(), ...escaped, ...logged, observed?.extra ?? ''].map(
      (text) => stripAnsi(String(text)),
    ),
  }
}

const SILENT = {
  'buildPrompt': (value, { stderr }) => {
    const reads = []
    const prompt = buildPrompt({
      projectRoot: REPO,
      env: { RALPH_AGENT: value },
      fs: {
        existsSync: () => false,
        readFileSync: (p) => {
          reads.push(basename(String(p)))
          return ''
        },
      },
      stderr,
    })
    // Which orchestrator template was read IS the resolution, observed from the outside.
    const template = reads.find((name) => name.startsWith('prompt-team'))
    return {
      agent: template === undefined ? null : template.includes('codex') ? 'codex' : 'claude',
      extra: prompt,
    }
  },

  'buildDigestInvocation': (value) => {
    const inv = buildDigestInvocation({ RALPH_AGENT: value })
    return { agent: inv.agent, extra: JSON.stringify(inv) }
  },

  'captureIssueEvent': (value, { log }) => {
    const root = mkdtempSync(join(sandbox, 'capture-'))
    captureIssueEvent({
      env: {
        PROJECT_ROOT: root,
        RALPH_AGENT: value,
        TASK_SOURCE: 'folder',
        RALPH_TASK_ID: '119',
        RALPH_TASK_OUTCOME: 'done',
        RALPH_CLAUDE_EXIT: '0',
        RALPH_RUN_ID: 'ralph-119-0',
      },
      now: () => 0,
      log,
      fetchDiffStats: () => ({ additions: 0, deletions: 0, changedFiles: 0 }),
    })
    const line = readFileSync(join(root, '.ralph', 'metrics', 'issues.jsonl'), 'utf8').trim()
    const event = JSON.parse(line.slice(line.indexOf('{')))
    return { agent: event.agent, extra: line }
  },

  'finalizeState': (value) => {
    const vol = Volume.fromJSON(
      {
        [`${REPO}/ralph.config.sh`]: `RALPH_AGENT="claude"${LF}`,
        [`${REPO}/.ralph/state.json`]: JSON.stringify({
          validated_at: '2026-08-28T00:00:00.000Z',
          detected_stack: 'node',
          notes: '',
          last_seen_release: '0.0.0',
        }),
      },
      '/',
    )
    const next = finalizeState({
      projectRoot: REPO,
      ralphVersion: VERSION,
      fs: vol,
      env: { RALPH_AGENT: value },
    })
    return {
      agent: next.agent,
      extra: `${vol.readFileSync(join(REPO, '.ralph', 'state.json'), 'utf8').toString()}${LF}${JSON.stringify(next)}`,
    }
  },

  'assertCriticalDeps': (value) => {
    const result = assertCriticalDeps({
      hasCommand: () => false,
      platform: 'mac',
      env: { RALPH_AGENT: value },
    })
    const names = result.missingCritical.map((r) => r.name)
    const agent = ['claude', 'codex'].find((candidate) => names.includes(candidate)) ?? null
    return { agent, extra: JSON.stringify(result) }
  },

  'ralph cycle preflight': async (value, { stdout, stderr }) => {
    const probed = []
    const execCalls = []
    const exec = async (cmd, args) => {
      const key = `${cmd} ${args.join(' ')}`
      execCalls.push(key)
      if (key === 'git rev-parse --show-toplevel') {
        return { exitCode: 0, stdout: `${REPO}${LF}`, stderr: '' }
      }
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (key === 'gh repo view --json nameWithOwner -q .nameWithOwner') {
        return { exitCode: 0, stdout: `me/repo${LF}`, stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await cycleCommand({
      cwd: REPO,
      stdout,
      stderr,
      isTTY: false,
      exec,
      exists: (p) => {
        probed.push(String(p))
        return true
      },
      loadEnv: () => ({}),
      acquireLock: () => ({
        acquired: true,
        holder: { pid: 1, startedAt: '2026-08-28T00:00:00.000Z', repoPath: REPO },
      }),
      releaseLock: () => {},
      findOrphans: async () => [],
      cleanupOrphans: async () => [],
      sendWa: async () => ({ ok: true }),
      pingSuccess: async () => ({ ok: true }),
      pingFail: async () => ({ ok: true }),
      runQueueOnce: async () => ({ successes: [], failures: [] }),
      readFile: () => '',
      folderQueueCount: async () => 0,
      now: () => Date.parse('2026-08-28T00:30:00.000Z'),
      claudeCredentialsPath: CLAUDE_CREDS,
      processEnv: { RALPH_AGENT: value },
      home: HOME,
      ask: async () => false,
      cacheFs: new Volume(),
    })
    // The auth probe preflight attempted is agent-shaped, and it is the only place this
    // command's resolution becomes visible from outside.
    const agent = probed.includes(CLAUDE_CREDS)
      ? 'claude'
      : execCalls.some((key) => key.startsWith('codex login'))
        ? 'codex'
        : null
    // The argv is folded in here for the same reason it is asserted for start and init above.
    //
    // AND SO ARE THE PROBED PATHS, which #140 is how we found out. The `folds each row ARTEFACT
    // into the channels it searches` claim below needs each row's artefact to contain the agent
    // the row resolved, and for this row the resolution lives in `probed` — the argv above is a
    // preflight that exits on an empty queue and never names an agent at all. It satisfied that
    // claim anyway, because the in-progress label used to carry a `claude-` prefix and the
    // exclusion clause for it put the substring `claude` in the argv for free. #140 renamed that
    // label, the accident went away, and the row went red — so the artefact now carries the thing
    // the readout is actually made of. The probed paths are dependency-supplied and cannot carry
    // the hostile value, so folding them in cannot weaken the marker assertions above.
    return {
      agent,
      extra: `${JSON.stringify(result)}${LF}${execCalls.join(LF)}${LF}${probed.join(LF)}`,
    }
  },
}

describe('QA #119 — a silent caller echoes neither the sentence NOR the value it came from', () => {
  for (const [label, drive] of Object.entries(SILENT)) {
    it(`${label} keeps a hostile RALPH_AGENT off every channel it has`, async () => {
      const observed = await observeSilent(drive, HOSTILE)
      // The value went all the way in and fell back — without this the clauses below are
      // satisfied by a driver that never reached the resolver.
      expect(observed.agent, label).toBe('claude')
      for (const channel of observed.channels) {
        // The marker is the strong needle: it is in the raw value AND in the sanitised
        // sentence, so its absence rules out both echoes at once.
        expect(channel, `${label} echoed the value`).not.toContain(MARK)
        // ...and these two say that if anything ever does echo, the #108 guarantee is what
        // it echoes: a control byte on a channel is the defect in its original form.
        expect(channel, `${label} passed a NUL through`).not.toContain(NUL)
        expect(channel, `${label} passed an ESC through`).not.toContain(ESC)
      }
    })
  }

  it('reads an agent that MOVES, so no row above is answering a question it never asked', async () => {
    // ANTI-VACUITY for the whole group. `expect(agent).toBe('claude')` is worth nothing if the
    // readout is a constant — claude is the fallback AND the default, so a driver that reached
    // nothing at all reports it just as readily as one that reached the resolver and fell back.
    // The same six rows are therefore driven with a value the registry UNDERSTANDS, and each
    // has to report the other agent: that is the proof that the value under test is what the
    // readout is made of, which is what makes the marker's absence above a measurement.
    for (const [label, drive] of Object.entries(SILENT)) {
      const observed = await observeSilent(drive, 'codex')
      expect(observed.agent, label).toBe('codex')
    }
  })

  it('folds each row ARTEFACT into the channels it searches, so a needle there is found', async () => {
    // The other half of anti-vacuity, and the reason it is a separate claim: five of these six
    // rows observe through an artefact rather than a stream — a JSONL line, a state file, a
    // returned message, a command line — so a `channels` array that came back empty (a driver
    // that returned no `extra`, a harness that dropped it) would satisfy every clause above by
    // iterating nothing. Each artefact is asked to name the agent the module resolved, which is
    // the one string all five are known to contain.
    //
    // buildPrompt is the exception and is listed as one: its artefact is the prompt text, and
    // its templates are injected as empty strings here, so the composition is empty by
    // construction rather than by accident. Its live channel is the stderr it is HANDED, which
    // is what lib/agent-registry.warning.consumers.qa.test.js's own row drives.
    for (const [label, drive] of Object.entries(SILENT)) {
      if (label === 'buildPrompt') continue
      const observed = await observeSilent(drive, HOSTILE)
      expect(observed.channels.join(LF), `${label} reported no artefact`).toContain('claude')
    }
  })
})
