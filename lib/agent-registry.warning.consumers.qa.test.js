// QA #119 — WHO PRINTS THE FALLBACK WARNING, asked of the streams instead of the sources.
//
// `resolveAgent` composes one sentence about a mistyped RALPH_AGENT (#108) and a handful of
// modules decide what to do with it. Four surface it; the rest destructure `{ agent }` and drop
// it on the floor. That split is a real specification — a caller that never echoes needs no
// sanitiser guarantee, and a caller that echoes needs a line-count test — so the repo has always
// wanted a test that knows which group each module is in.
//
// IT USED TO ASK THE QUESTION OF THE SOURCE CODE, and that is what #119 is about. The test this
// file replaces lived in lib/agent-registry.warning.qa.test.js, swept lib/ with the comments
// stripped, and asserted that the set of files matching a `warning`-shaped regex equalled a
// literal list of five. It went wrong in both directions at once:
//
//   * THE LOOSE VERSION MATCHED A DIFFERENT OBJECT'S FIELD, AND A LINE OF USER-FACING TEXT.
//     Before #69 the pattern was "mentions the word `warning`" anywhere in the stripped source,
//     and in lib/commands/start.js it found two of those, neither of them this sentence:
//     `if (banner.warning) err(...)`, which reads the field of lib/banner-mode.js's own unrelated
//     fallback warning, and a template string telling a reader to "see the warning on stderr".
//     So a module landed in the consumer set on the strength of a property belonging to another
//     object and a line of text addressed to a user.
//   * THE TIGHT VERSION MISSED CODE. #69 narrowed it to a destructure that names the field or an
//     object literal with a `warning:` key, which is one of several equivalent ways to read a
//     property. `resolveAgent(env).warning`, or `const r = resolveAgent(env)` followed by
//     `r.warning`, matches neither — so a NEW printer spelled that way would leave the swept set
//     unchanged, the literal list would still compare equal, and the test whose entire purpose is
//     to know who prints the warning would pass while a printer walked in behind its back. The
//     mirror image is just as bad: refactoring an EXISTING consumer's destructure into a property
//     read turns the test red for a change that moved no bytes on any stream.
//
// A sweep for the spelling of a read cannot get this right, because the spelling is not the
// property anybody cares about. What the codebase actually promises is observable: for each
// command that should warn, an unrecognised RALPH_AGENT produces the resolver's own sentence on
// the stream that command writes to; for each caller that should not, no channel carries it at
// all. So that is what is asserted here, one row per call site, and the claim survives any
// refactor of the read while going red the moment a command starts or stops warning.
//
// WHAT EACH ROW MEASURES, since the four printers do not all print:
//
//   commands/doctor.js    STDOUT. doctor's whole output is a report and the warning is an
//                         annotation on the identity box's agent row.
//   commands/init.js      STDERR, reached through the interactive PROMPT — an explicit `--agent`
//                         typo is rejected hard before the resolver is called (#560), so the
//                         prompt is the only path on which init's warning exists at all.
//   commands/start.js     STDERR, above the splash (#118).
//   agent-invocation.js   NEITHER, and this is the one member that does not print from the
//                         function that reads the field. `buildAgentInvocation`'s answer is DATA:
//                         its stdout is a shell program templates/ralph.sh `eval`s, so the
//                         warning leaves as a FIELD and only the script block at the bottom of
//                         that module turns it into bytes. What is measured here is therefore the
//                         surfacing — the field is byte-equal to the resolver's sentence, the
//                         emitted program does not contain a word of it, and the pure function
//                         writes nothing anywhere. The BYTES half needs a subprocess, and it has
//                         one: lib/agent-invocation.warning.test.js spawns the script and reads
//                         its two streams. This file spawns nothing.
//
// Every row also asserts WHICH AGENT the module resolved, because a silence assertion is worthless
// if the driver never reached the call site: `agent === 'claude'` is the proof that the typo went
// all the way in and fell back. And each driver's own output — the generated ralph.config.sh, the
// emitted shell program, the telemetry line, the invocation object — is folded into the channels
// under test, so a warning smuggled into a FILE or a DATA structure is caught alongside one
// smuggled onto a stream.
//
// Almost every seam is injected (#41): streams, env bags, config text, fs, exec, clocks, locks and
// the update cache. The one exception is named rather than glossed, because it is a real one —
// `captureIssueEvent` takes `{ env, now, log, fetchDiffStats }` and has no fs seam at all, so its
// driver appends to a throwaway `mkdtempSync` directory that is removed in `afterAll`. That is the
// only row that touches a real filesystem, and the driver says so again at the call.
//
// Nothing here spawns a process, touches the network, or reads the developer's own RALPH_AGENT —
// the last of which is asserted rather than assumed, by exporting a typo into the ambient
// environment and driving every row with a value the registry recognises. Control characters are
// built from their code points (#107).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Volume } from 'memfs'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { resolveAgent } from './agent-registry.js'
import { buildAgentInvocation, emitShellAssignments } from './agent-invocation.js'
import { buildPrompt } from './build-prompt.js'
import { buildDigestInvocation } from './digest.js'
import { captureIssueEvent } from './capture-issue-event.js'
import { finalizeState } from './finalize-state.js'
import { EMPTY_VERSION_CACHE } from './version-cache.js'
import { doctorCommand, assertCriticalDeps } from './commands/doctor.js'
import { initCommand } from './commands/init.js'
import { startCommand } from './commands/start.js'
import { cycleCommand } from './commands/cycle.js'

const LIB = fileURLToPath(new URL('.', import.meta.url))
const LF = String.fromCharCode(0x0a)
const ESC = String.fromCharCode(0x1b)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const stripAnsi = (text) => String(text).replace(SGR, '')

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const CLAUDE_CREDS = join(HOME, '.claude', '.credentials.json')

// One unrecognised value and one the registry understands. The per-command specs already sweep
// the spellings, the hostile values and the code-point classes; what is under test here is WHICH
// MODULE SPEAKS, so one representative typo is the whole fixture.
const TYPO = 'codx'
const RECOGNISED = 'codex'

/** The resolver is the oracle: the sentence a printer must carry is the one it composed. */
const SENTENCE = resolveAgent({ RALPH_AGENT: TYPO }).warning
// The assignment-shaped prefix, and the second of the only two needles this file uses. Both are
// unique to `resolveAgent`: it is the one module in lib/ that composes `RALPH_AGENT='` at all,
// which lib/agent-registry.warning.qa.test.js pins as a set of one, and the whole sentence is a
// superset of that prefix. Anything looser would measure the wrong thing — lib/banner-mode.js
// builds `RALPH_BANNER=<value> unrecognized; falling back to '<default>'. Valid: …` for a
// different knob, so a needle like the bare word "unrecognized" names the WORDING OF A FALLBACK
// WARNING IN GENERAL rather than this warning, and that is the ambiguity #69 tripped over.
const ASSIGNMENT = "RALPH_AGENT='"
const CHANNELS = ['stdout', 'stderr', 'elsewhere']

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

/**
 * Drive one call site with a raw RALPH_AGENT and report every channel it could have reached.
 *
 * `stdout`/`stderr` are the streams the module was HANDED. `elsewhere` is everything else it
 * could have used to leak the sentence: the process's own streams (which a module with no
 * injected stream would have to reach for), whatever it logged, and the artefact it produced.
 * The process streams are recorded and PASSED THROUGH rather than swallowed, so a reporter write
 * that lands mid-test is not lost.
 */
async function observe(drive, value) {
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
    field: observed?.field ?? null,
    stdout: stripAnsi(stdout.output()),
    stderr: stripAnsi(stderr.output()),
    elsewhere: stripAnsi([...escaped, ...logged, observed?.extra ?? ''].join(LF)),
  }
}

/** The agent a rendered identity box NAMES — the only agent a user of these commands can see. */
const boxAgent = (out) => out.match(/\bagent\s{2,}(\S+)/)?.[1] ?? null

// ---------------------------------------------------------------------------------------------
// The drivers. One per non-test call site of `resolveAgent`, each reaching it the way the
// command's own spec does, and each answering the agent the module ended up resolving.
// ---------------------------------------------------------------------------------------------

async function driveDoctor(value, { stdout, stderr }) {
  await doctorCommand({
    stdout,
    stderr,
    hasCommand: () => true,
    platform: 'mac',
    env: { RALPH_AGENT: value },
    currentVersion: VERSION,
    cacheFs: new Volume(),
    home: HOME,
    cwd: REPO,
    color: false,
    exists: () => false,
    readFile: () => '',
  })
  return { agent: boxAgent(stripAnsi(stdout.output())) }
}

// The OTHER reader in lib/commands/doctor.js, and the reason that module appears in both groups:
// `assertCriticalDeps` resolves the same agent, keeps `{ agent }` only, and composes its message
// out of dependency names. It has no streams at all, so the whole of its answer goes into
// `elsewhere` — a "helpfully" surfaced warning would show up in the message it returns.
function driveAssertCriticalDeps(value) {
  const result = assertCriticalDeps({
    hasCommand: () => false,
    platform: 'mac',
    env: { RALPH_AGENT: value },
  })
  // Only the SELECTED agent's CLI is a critical dep, so the missing set names the agent.
  const names = result.missingCritical.map((r) => r.name)
  const agent = ['claude', 'codex'].find((candidate) => names.includes(candidate)) ?? null
  return { agent, extra: `${result.message}${LF}${names.join(' ')}` }
}

async function driveInit(value, { stdout, stderr }) {
  const vol = Volume.fromJSON({ [`${REPO}/.keep`]: '' }, '/')
  const exec = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
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
    // The PROMPT path, not the flag path: `--agent codx` is rejected before the resolver runs
    // (#560), so a flag can never produce this warning. A stray keystroke at the picker can.
    agent: null,
    source: 'github',
    isTTY: true,
    promptAgent: async () => value,
    ask: async () => false,
    promptValue: async () => '',
    home: HOME,
    processEnv: {},
  })
  return {
    agent: result.agent,
    // The file the loop will source, folded in RAW: a diagnostic that reached it would be dead
    // text at best, and this haystack needs no pre-processing because both needles are safe
    // against the template it was rendered from. templates/ralph.config.sh does document this
    // very knob in prose, but it spells the assignment with DOUBLE quotes and init interpolates
    // the RESOLVED agent into it — so neither `RALPH_AGENT='` nor the sentence can appear in the
    // generated file unless a printer put it there.
    extra: vol.readFileSync(join(REPO, 'ralph.config.sh'), 'utf8').toString(),
  }
}

async function driveStart(value, { stdout, stderr }) {
  stdout.isTTY = true
  // Folder mode, so the queue depth is a dependency rather than a `gh` stub.
  const config = ['TASK_SOURCE=folder', ''].join(LF)
  const exec = async (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  await startCommand({
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
    processEnv: { RALPH_AGENT: value },
    // The splash's two impure capabilities, neutralised (a real sleep costs a second of wall
    // clock per run and the real signal source leaves a listener in the vitest worker).
    sleep: async () => {},
    signals: null,
  })
  return { agent: boxAgent(stripAnsi(stdout.output())) }
}

function driveAgentInvocation(value) {
  const inv = buildAgentInvocation({ RALPH_AGENT: value })
  return {
    agent: inv.agent,
    // The warning as DATA, which is the only thing this function surfaces...
    field: inv.warning,
    // ...and the bytes it DOES put on a stream: the shell program the loop evals.
    extra: emitShellAssignments(inv),
  }
}

function driveBuildPrompt(value, { stderr }) {
  const reads = []
  const fs = {
    existsSync: () => false,
    readFileSync: (p) => {
      reads.push(basename(String(p)))
      return ''
    },
  }
  const prompt = buildPrompt({ projectRoot: REPO, env: { RALPH_AGENT: value }, fs, stderr })
  // The orchestrator template IS the resolution, observed: claude gets prompt-team.md, codex
  // gets prompt-team-codex.md. Null when no template was read at all, so a driver that never
  // reached the call site fails the agent assertion rather than passing vacuously.
  const template = reads.find((name) => name.startsWith('prompt-team'))
  const agent = template === undefined ? null : template.includes('codex') ? 'codex' : 'claude'
  return { agent, extra: prompt }
}

function driveDigest(value) {
  const inv = buildDigestInvocation({ RALPH_AGENT: value })
  return { agent: inv.agent, extra: JSON.stringify(inv) }
}

let sandbox

function driveCaptureIssueEvent(value, { log }) {
  // `captureIssueEvent` appends through the real fs with no injectable seam for it, so it gets a
  // throwaway directory rather than a mock — and the line it writes is then read back, which is
  // how this row observes the agent it recorded.
  const root = mkdtempSync(join(sandbox, 'capture-'))
  captureIssueEvent({
    env: {
      PROJECT_ROOT: root,
      RALPH_AGENT: value,
      // Folder mode: no PR, so no `gh` call at all. The stub below is the belt to that braces.
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
}

function driveFinalizeState(value) {
  const vol = Volume.fromJSON(
    {
      [`${REPO}/ralph.config.sh`]: `RALPH_AGENT="${TYPO}"${LF}`,
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
    // The state file this writes is read by tooling, so it is a channel like any other.
    extra: vol.readFileSync(join(REPO, '.ralph', 'state.json'), 'utf8').toString(),
  }
}

async function driveCycle(value, { stdout, stderr }) {
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
  // `runPreflight` hands the resolved agent to `probeAgentAuth`, and that probe is agent-shaped:
  // claude is a credentials file, codex is a `codex login status`. Which one was attempted is the
  // only place this command's resolution becomes observable — and it doubles as the proof that
  // preflight ran at all, since a preflight that returned early reaches neither.
  const agent = probed.includes(CLAUDE_CREDS)
    ? 'claude'
    : execCalls.some((key) => key.startsWith('codex login'))
      ? 'codex'
      : null
  return { agent, extra: JSON.stringify(result) }
}

// ---------------------------------------------------------------------------------------------

/** The modules that take the warning OUT of the resolver and put it in front of somebody. */
const PRINTERS = {
  'ralph doctor': { module: 'commands/doctor.js', channel: 'stdout', drive: driveDoctor },
  'ralph init': { module: 'commands/init.js', channel: 'stderr', drive: driveInit },
  'ralph start': { module: 'commands/start.js', channel: 'stderr', drive: driveStart },
  'the bash bridge': {
    module: 'agent-invocation.js',
    channel: 'field',
    drive: driveAgentInvocation,
  },
}

/** The callers that resolve the same agent and are specified to say nothing about the fallback. */
const SILENT = {
  'buildPrompt': { module: 'build-prompt.js', drive: driveBuildPrompt },
  'buildDigestInvocation': { module: 'digest.js', drive: driveDigest },
  'captureIssueEvent': { module: 'capture-issue-event.js', drive: driveCaptureIssueEvent },
  'finalizeState': { module: 'finalize-state.js', drive: driveFinalizeState },
  'ralph cycle preflight': { module: 'commands/cycle.js', drive: driveCycle },
  'assertCriticalDeps': { module: 'commands/doctor.js', drive: driveAssertCriticalDeps },
}

const ALL_ROWS = { ...PRINTERS, ...SILENT }

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-119-qa-'))
})
afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
})

describe('QA #119 — every printer, measured on the stream it actually writes to', () => {
  for (const [label, row] of Object.entries(PRINTERS)) {
    it(`${label} surfaces the resolver's own sentence, and puts it nowhere else`, async () => {
      const observed = await observe(row.drive, TYPO)
      // The typo reached this module's resolver and fell back. Without this the silence half of
      // every assertion below could be satisfied by a driver that never got there.
      expect(observed.agent, label).toBe('claude')

      const carriers = CHANNELS.filter((channel) => channel !== row.channel)
      // `field` IS THE BRIDGE'S CHANNEL AND ONLY THE BRIDGE'S, so the assertion on it is
      // load-bearing in exactly two places: here, where `buildAgentInvocation` must surface the
      // sentence as data, and in the recognised-value run further down, where that same row must
      // surface nothing. The other nine rows' drivers return no `field` at all, so `toBeNull()`
      // holds for them for a reason unrelated to what the row claims. It is written out for every
      // row anyway, so the bridge's positive and negative spellings live in one table with the
      // stream-based rows rather than in a special case beside them.
      if (row.channel === 'field') {
        // The bridge: the sentence leaves as DATA, byte-equal to the resolver's, and the stream
        // this module does write — a shell program the loop evals — carries no trace of it.
        expect(observed.field, label).toBe(SENTENCE)
      } else {
        const lines = observed[row.channel].split(LF).filter((line) => line.includes(SENTENCE))
        expect(lines, `${label} on ${row.channel}`).toHaveLength(1)
        expect(observed.field, label).toBeNull()
      }

      for (const channel of carriers) {
        expect(observed[channel], `${label} leaked onto ${channel}`).not.toContain(ASSIGNMENT)
      }
    })
  }
})

describe('QA #119 — every other caller of the resolver stays silent', () => {
  for (const [label, row] of Object.entries(SILENT)) {
    it(`${label} resolves the fallback and carries the warning on no channel`, async () => {
      // A caller that never echoes needs no sanitiser guarantee, which is what makes the
      // resolver's placement sufficient rather than merely convenient (#108). A row that starts
      // printing is not a failure in itself; it is a demand that whoever added the print also
      // added a line-count test for it, and moved this row into PRINTERS above.
      const observed = await observe(row.drive, TYPO)
      expect(observed.agent, label).toBe('claude')
      expect(observed.field, label).toBeNull()
      for (const channel of CHANNELS) {
        expect(observed[channel], `${label} printed on ${channel}`).not.toContain(SENTENCE)
        expect(observed[channel], `${label} printed on ${channel}`).not.toContain(ASSIGNMENT)
      }
    })
  }
})

describe('QA #119 — silence is not the default, and no row reads the ambient environment', () => {
  it('prints nothing anywhere for a recognised value, with a typo exported around it', async () => {
    // TWO CLAIMS AT ONCE, because they need the same pass over every row.
    //
    // The first is what makes the group above a specification rather than a list of facts: a
    // printer that emitted the line unconditionally would satisfy every assertion up there, so
    // the same rows are driven with a value the registry understands and must go quiet.
    //
    // The second is #41. `codx` is exported into the real process environment for the duration,
    // so any driver that leaked `process.env` into the module it drives — or any module that
    // reached past its injected bag — resolves claude and warns, and fails here. That is the only
    // way to state "the injected bag is the only one" for every call site at once.
    const ambient = process.env.RALPH_AGENT
    process.env.RALPH_AGENT = TYPO
    try {
      for (const [label, row] of Object.entries(ALL_ROWS)) {
        const observed = await observe(row.drive, RECOGNISED)
        expect(observed.agent, label).toBe(RECOGNISED)
        expect(observed.field, label).toBeNull()
        for (const channel of CHANNELS) {
          // `RALPH_AGENT='` is the right needle for this direction: it catches a warning about
          // ANY value, which is what a printer that echoed unconditionally would produce.
          expect(observed[channel], `${label} on ${channel}`).not.toContain(ASSIGNMENT)
        }
      }
    } finally {
      if (ambient === undefined) delete process.env.RALPH_AGENT
      else process.env.RALPH_AGENT = ambient
    }
  })
})

describe('QA #119 — every module in lib/ that NAMES the resolver has a row', () => {
  // The coverage guard, and the one claim in this file that is about the codebase rather than
  // about a stream: the rows above are only "no printer the per-command specs missed" if a new
  // call site cannot appear without a row. So the roster is compared against a sweep of lib/ —
  // and this comment is deliberately careful about what that sweep asks, because a comment that
  // credits its own regex with more reach than it has is the exact defect #119 exists to remove.
  //
  // WHAT IT ASKS is which modules under lib/ contain the IDENTIFIER `resolveAgent` in their
  // comment-stripped source. That is narrower than "which modules can reach the resolver", in
  // three ways worth naming rather than glossing:
  //
  //   * AN IDENTIFIER CAN BE RENAMED AT THE BOUNDARY. `export { resolveAgent as pickAgent }` in
  //     the registry, or a computed read off a namespace object, hands a caller a binding whose
  //     source contains no occurrence of the swept token — and that caller is invisible here.
  //   * IT DEDUPES BY MODULE. A second reader added to a module already on the list changes no
  //     module set at all, and lib/commands/doctor.js is proof the shape is not hypothetical: it
  //     holds two call sites with opposite specifications, one printer and one silent.
  //   * IT STOPS AT lib/. bin/ralph.js is the process's entry point and imports these commands;
  //     a resolver call and a print added THERE are outside the swept tree entirely.
  //
  // All three are closed in lib/agent-registry.warning.consumers.coverage.qa.test.js, which
  // re-asks the roster as a question about the IMPORT EDGE. It sweeps lib/, bin/ and scripts/ for
  // the SPECIFIER `agent-registry.js` — a path that a static `from`, a dynamic `import()`, a
  // `require()` and a re-export all have to write down, and the one part of the edge that cannot
  // be renamed — pins the registry to declaration-only exports so no second name for the function
  // can exist, and pins the per-module CALL COUNT so that a second reader inside a listed module
  // is a red test rather than a silent one.
  //
  // What no version of this asks is how a caller SPELLS the read, which is the question #119 is
  // about not asking. This sweep keeps that discipline. It simply answers less than the word
  // "reaches" would suggest, so it does not claim it, and the behavioural rows above are what the
  // coverage claim is ultimately in service of.
  const libFiles = (dir = LIB, acc = []) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) libFiles(path, acc)
      else if (entry.endsWith('.js') && !entry.includes('.test.')) acc.push(path)
    }
    return acc
  }
  const FILES = libFiles()
  const mentions = FILES.filter((path) => /\bresolveAgent\b/.test(codeWithoutComments(path))).map(
    (path) => path.slice(LIB.length),
  )

  it('drives every module in lib/ whose source names resolveAgent, and nothing else', () => {
    // agent-registry.js is excluded by name and not by accident: it is where the sentence is
    // COMPOSED, so it mentions the function because it exports it. That exclusion is asserted
    // just below, so the filter cannot quietly start dropping a real caller.
    const callers = mentions.filter((name) => name !== 'agent-registry.js').sort()
    const covered = [...new Set(Object.values(ALL_ROWS).map((row) => row.module))].sort()
    expect(callers).toEqual(covered)
  })

  it('sanity-checks that sweep, so it cannot pass by finding nothing', () => {
    // ANTI-VACUITY. An empty `FILES`, a bad path join or a comment-stripping bug would make the
    // comparison above pass by matching two empty lists. The same sweep is therefore made to find
    // things it must find: a deep directory of modules, the resolver itself, and the one command
    // whose printer #118 added last.
    expect(FILES.length).toBeGreaterThan(40)
    expect(mentions).toContain('agent-registry.js')
    expect(mentions).toContain('commands/start.js')
    expect(mentions.length).toBeGreaterThan(5)
  })
})
