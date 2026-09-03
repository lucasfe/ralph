// QA augmentation for #149 — `sourcedValue` (lib/commands/start.js:277) attacked as a MATRIX
// rather than as a handful of cases, and cross-checked against the programs that actually consume
// each knob.
//
// start.precedence.qa.test.js is the dev's file and it does the arguing: it states the rule, carries
// the bash transcript, and pins the three sites #149 named plus the quoted-whitespace
// non-regression. What it does NOT do is sweep. Its blank-spelling table is written on ONE knob
// (RALPH_CODEX_MODEL); the other four call sites — RALPH_AGENT (:347), TASK_SOURCE (:510),
// RALPH_CONTEXT_WINDOW (:544) and GH_REPO (:1311, through `bannerRepoSlug`) — are each pinned on a
// single spelling, `=""`. The rule the closure implements is a property of the PRECEDENCE, so it has
// to hold at every site for every spelling, and this file is where that is measured.
//
// WHAT IS DIFFERENT ABOUT HOW THIS FILE MEASURES. Nothing here hardcodes what bash does. Every row
// of the matrix below writes the config file, sources it with `set -a` in a REAL bash exactly as
// templates/ralph.sh does, reads back what the loop's environment is left holding, and only then
// asserts the box against that. So the file cannot drift from the shell the way a transcript in a
// comment can: if a future bash changes its mind about `X=<spaces>`, this file changes colour rather
// than staying green on a stale quotation. The shell it ran against while this was written is
// reported by `bash --version` inside the sweep, and the fixture set is the same six spellings —
// five that blank an inherited value and one, quoted whitespace, that does not. Block 5 adds a
// seventh that only LOOKS like a blank, and measures it the same way.
//
// The five things measured here that were not measured before:
//
//   1. THE MATRIX. Five blank spellings x five call sites, each row asserted against the loop
//      environment a real bash produced for it, plus the inherited case for the same knob so no row
//      can pass by the box having stopped reading the knob at all.
//   2. THE CONSUMERS, not a restated expectation. The window row is compared with the
//      `context_window` a real `captureIssueEvent` WRITES into issues.jsonl when handed the
//      environment bash just produced; the source row is compared with the value
//      templates/ralph.sh's own dispatch block resolves — the block is SLICED OUT OF THE TEMPLATE
//      and run, not paraphrased.
//   3. THE SHARED GRAMMAR. `sourcedValue(name)` is single-arity: every knob, TASK_SOURCE included,
//      reads `parseConfigVar(configText, name)`. The #149 review dropped the per-site argument this
//      block used to pin, because `parseConfigSource` — what `cycle`, `status` and `doctor` call for
//      that knob — is that same call verbatim. So the pin that matters now is a CROSS-COMMAND one:
//      the two readers must never disagree, swept over the whole spelling table rather than argued.
//   4. THE INDEX. `processEnv[name]` replaced named property reads. The shapes probed here are the
//      ones a `{}` literal does not cover: an OWN property whose value is `undefined`, values that
//      are not strings at all, and a bag whose accessor THROWS — at every one of the five names,
//      which is how the claim that only `GH_REPO`'s read is guarded gets checked instead of trusted.
//   5. THE SEVENTH SPELLING, which review round 1 found and this slice then fixed. `NAME= ""` — a
//      space after the `=` — is bash's environment-prefix syntax: bash assigns nothing, so an
//      inherited value stands, and so does a live earlier line in the same file. The presence test
//      read that line as present-and-blank, so pointing every knob at presence turned it into
//      masking. `envPrefixedNothing` in lib/parse-config-var.js now refuses the line on both
//      readers, and block 5 measures the fix at every knob — in a real bash and in the box — plus
//      the two boundaries it had to keep: `NAME=` with a blank tail, and `export NAME= ""`, which
//      bash does assign and which therefore still count as assignments here. Blocks 6 and 7 then
//      widened it: the fix was first drawn around a word made of empty quotes, review round 2 found
//      the same class one spelling over (`NAME=# off`, where the `#` opens no comment because a
//      comment opens only at a `#` that BEGINS a word), and round 3 rewrote the refusal around
//      bash's word rule instead of around spellings. Block 7's two `#` pins are agreements now, and
//      its sweep says what is left: an `export` prefix and a subshell tail. Round 4 then found the
//      widened refusal reaching a tail bash DOES assign on — a line ending in a backslash, which is
//      bash's line continuation rather than a word — so block 7's family now carries that tail in
//      both directions and the refusal declines the line instead of refusing it.
//
// Three divergences are pinned rather than fixed. In the last block, three commands still read
// TASK_SOURCE on a `||` (cycle.js:194, status.js:384, doctor.js:160 — all byte-identical to the
// commit before this slice), so a blanked knob now answers differently in `ralph doctor` than in
// `ralph start`. doctor.js's own comment declares that out of scope; what was missing is a test that
// makes the cost observable, and the cost is measured there rather than described. And in block 7,
// the two shapes the widened refusal cannot reach without costing a line bash really does assign:
// `export NAME= folder`, where the builtin applies the `NAME=` itself, and a `| cat` or `&` tail,
// where bash makes the assignment in a subshell. The third is a VALUE rather than a presence
// divergence and lives in the same block's sweep: a line ending in a continuation backslash is read
// as an assignment (which is what bash makes of it) with the backslash still in the value, because
// bash joins the next line and this reader stops at the newline. Named row by row there.
//
// Harness rules this file follows, all of them the repo's: every seam is injected, so nothing reads
// the developer's checkout, home or environment (#41); control bytes are built from code points and
// never typed (#107); spaces that are load-bearing are built with `repeat` so no formatter can eat
// them; and prose spells "environment" in full, because #41's ambient-surface scanner is a regex
// that does not skip comments.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execa } from 'execa'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startCommand } from './start.js'
import { doctorCommand } from './doctor.js'
import { parseConfigVar, configAssignsVar } from '../parse-config-var.js'
import { parseConfigSource } from '../read-config-source.js'
import { buildAgentInvocation } from '../agent-invocation.js'
import { resolveAgent } from '../agent-registry.js'
import { captureIssueEvent } from '../capture-issue-event.js'
import { metricsPath } from '../issue-metrics.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'

const LF = String.fromCharCode(10)
const ESC = String.fromCharCode(27)
const SPACES = ' '.repeat(3)
const UNSET = '«unset»'

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const GIT_CONFIG_PATH = resolve(REPO, '.git', 'config')
const ORIGIN_SLUG = 'lucasfe/ralph'
// The box's gutter, restated rather than imported — the rule every QA oracle here follows: a reader
// written out of the module it audits is satisfied by any mistake the two of them agree on.
const LABEL_WIDTH = 8

const AGENT = 'RALPH_AGENT'
const SOURCE = 'TASK_SOURCE'
const MODEL = 'RALPH_CODEX_MODEL'
const WINDOW = 'RALPH_CONTEXT_WINDOW'
const REPO_KNOB = 'GH_REPO'
// Every name `sourcedValue` is called with, in call-site order. The matrix is built off this list,
// so a sixth call site added without a row here is visible as a list that no longer matches the
// grep in the structural test at the bottom of the first block.
const KNOB_NAMES = [AGENT, SOURCE, MODEL, WINDOW, REPO_KNOB]

// The five ways a config file can blank a knob and have bash export the blank OVER an inherited
// value, plus the one way it can blank it and have bash keep a value. Which is which is not asserted
// from this list — `blankSpellings` is only the fixture set, and the sweep at the top of the first
// block asks bash which column each row lands in.
const blankSpellings = (name) => [
  ['a double-quoted empty value', `${name}=""`],
  ['a single-quoted empty value', `${name}=''`],
  ['a bare `=` with nothing after it', `${name}=`],
  ['unquoted trailing spaces', `${name}=${SPACES}`],
  ['an `export` of a bare `=`', `export ${name}=`],
]
const quotedWhitespace = (name) => `${name}="${SPACES}"`

// ---------------------------------------------------------------------------
// A real bash, sourcing a real file the way templates/ralph.sh does.
// ---------------------------------------------------------------------------

let TMP = null
let seq = 0
let BASH_VERSION = null

beforeAll(async () => {
  TMP = mkdtempSync(join(tmpdir(), 'ralph-149-sourced-qa-'))
  const v = await execa('bash', ['-c', 'printf %s "$BASH_VERSION"'], { reject: false })
  BASH_VERSION = v.stdout
})
afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true })
})

const writeConfig = (text) => {
  seq += 1
  const path = join(TMP, `config-${seq}.sh`)
  writeFileSync(path, text)
  return path
}

/**
 * What `set -a; . ralph.config.sh; set +a` leaves the loop holding for every knob of the box.
 *
 * This is the whole oracle of this file: the loop's environment, produced by the shell, with the
 * ambient values a user's invocation would have exported already in place. `${NAME-«unset»}`
 * distinguishes "assigned the empty string" from "never assigned" — the distinction `sourcedValue`
 * exists to model — and bash's first line of stderr is returned too, because a `command not found`
 * there means the shell RAN part of the config rather than assigning from it.
 */
async function loopEnv(configText, ambient = {}) {
  const path = writeConfig(configText)
  const probe = KNOB_NAMES.map(
    (name) => `printf '${name}=<<%s>>${LF}' "\${${name}-${UNSET}}"`,
  ).join('; ')
  const run = await execa('bash', ['-c', `set -a; . '${path}'; set +a; ${probe}`], {
    env: { ...ambient },
    reject: false,
  })
  const held = {}
  for (const name of KNOB_NAMES) {
    held[name] = run.stdout.match(new RegExp(`^${name}=<<([^${LF}]*)>>$`, 'm'))?.[1] ?? null
  }
  return { held, stderr: run.stderr.trim().split(LF)[0] ?? '' }
}

// The loop's OWN answer for TASK_SOURCE, out of templates/ralph.sh rather than out of a paraphrase
// of it. The block is sliced from the template by its first line and run verbatim after the config
// is sourced, so this cannot describe a dispatch the template no longer has — and the structural
// assertion below refuses a slice that came back empty or lost an arm.
const TEMPLATE = readFileSync(new URL('../../templates/ralph.sh', import.meta.url), 'utf8')
const DISPATCH_HEAD = 'if [ "${TASK_SOURCE:-github}" = "folder" ]; then'
const DISPATCH = (() => {
  const lines = TEMPLATE.split(LF)
  const from = lines.findIndex((line) => line.trim() === DISPATCH_HEAD)
  if (from === -1) return ''
  const to = lines.findIndex((line, i) => i > from && line.trim() === 'fi')
  return to === -1 ? '' : lines.slice(from, to + 1).join(LF)
})()

async function loopSource(configText, ambient = {}) {
  const path = writeConfig(configText)
  const run = await execa(
    'bash',
    ['-c', `set -a; . '${path}'; set +a${LF}${DISPATCH}${LF}printf '<<%s>>' "$TASK_SOURCE"`],
    { env: { ...ambient }, reject: false },
  )
  return run.stdout.match(/<<([^<>]*)>>/)?.[1] ?? null
}

// ---------------------------------------------------------------------------
// `ralph start`, every seam injected.
// ---------------------------------------------------------------------------

const CSI_COLOUR = new RegExp(`${ESC}[[][0-9]+m`, 'g')
const stripAnsi = (text) => text.replaceAll(CSI_COLOUR, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
    lines: () => {
      const text = chunks.join('')
      return text === '' ? [] : text.split(LF).slice(0, -1)
    },
  }
}

function makeExec({ queue = '9' } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
      return { exitCode: 0, stdout: queue, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const GIT_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '[remote "origin"]',
  '\turl = git@github.com:lucasfe/ralph.git',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '',
].join(LF)

const eventLine = (fields) => `RALPH_ISSUE_EVENT ${JSON.stringify(fields)}`
const CLAUDE_HISTORY =
  eventLine({
    issue_number: 30,
    run_id: 'ralph-b',
    ts: 2,
    duration_ms: 71 * 60000,
    total_cost_usd: 28.75,
    agent: 'claude',
    model: 'claude-opus-5',
    context_window: 1_000_000,
  }) + LF

const deps = ({ config = '', metrics = '', gitConfig = GIT_CONFIG, folderQueue = 3, ...overrides } = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const folderCounts = []
  return {
    cwd: REPO,
    stdout,
    stderr,
    folderCounts,
    exec: makeExec(),
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => {
      const path = String(p)
      if (path.endsWith('ralph.config.sh')) return config
      if (path.endsWith('issues.jsonl')) return metrics
      if (path === GIT_CONFIG_PATH) return gitConfig
      return ''
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
    folderQueueCount: async () => {
      folderCounts.push(1)
      return folderQueue
    },
    now: () => new Date(2026, 7, 25, 16, 4, 0).getTime(),
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

const boxOf = (d) => {
  const lines = d.stdout.lines()
  const top = lines.findIndex((line) => line.startsWith('╭'))
  const bottom = lines.findIndex((line) => line.startsWith('╰'))
  return top === -1 || bottom < top ? [] : lines.slice(top, bottom + 1)
}

const rowOf = (d, label) => {
  const row = boxOf(d).find((line) => stripAnsi(line).includes(`│ ${label}`))
  return row === undefined ? undefined : stripAnsi(row).slice(2, -2).trimEnd().slice(LABEL_WIDTH)
}

const run = async (options) => {
  const d = deps(options)
  const result = await startCommand(d)
  return { d, result }
}

// ---------------------------------------------------------------------------
// 1. The matrix: every blank spelling, at every call site.
// ---------------------------------------------------------------------------

// One row per call site. `blanked` is what the box must say once the FILE has blanked the knob and
// the loop is therefore holding an empty string; `inherited` is what it must say when the file is
// silent about the same name and the environment answers instead. Asserting both is what stops a
// row passing because the box quietly stopped reading the knob at all.
const CALL_SITES = [
  {
    name: AGENT,
    label: 'RALPH_AGENT',
    ambient: 'codex',
    // A claude event in the log, so the blanked case has a NAME to print rather than only an
    // absence: `resolveAgent('')` is claude, and the box then reports claude's last run.
    fixture: { metrics: CLAUDE_HISTORY },
    prefix: [],
    row: 'agent',
    blanked: 'claude — claude-opus-5 (last run)',
    inherited: 'codex — model resolves at first run',
  },
  {
    name: SOURCE,
    label: 'TASK_SOURCE',
    ambient: 'folder',
    fixture: {},
    prefix: [],
    row: 'source',
    blanked: 'github',
    inherited: 'folder',
  },
  {
    name: MODEL,
    label: 'RALPH_CODEX_MODEL',
    ambient: 'gpt-5-codex',
    fixture: {},
    prefix: [`${SOURCE}=folder`, `${AGENT}=codex`],
    row: 'agent',
    blanked: 'codex — model resolves at first run',
    inherited: 'codex — gpt-5-codex (configured)',
  },
  {
    name: WINDOW,
    label: 'RALPH_CONTEXT_WINDOW',
    ambient: '200000',
    fixture: {},
    prefix: [`${SOURCE}=folder`, `${AGENT}=codex`, `${MODEL}=gpt-5-codex`],
    row: 'context',
    // gpt-5-codex's own window out of lib/issue-event.js's map, which is where an ignored override
    // lands — in the box AND in the run's first event, asserted together further down.
    blanked: '400k tokens',
    inherited: '200k tokens',
  },
  {
    name: REPO_KNOB,
    label: 'GH_REPO',
    ambient: 'ambient/repo',
    fixture: {},
    prefix: [`${SOURCE}=github`],
    row: 'repo',
    blanked: ORIGIN_SLUG,
    inherited: 'ambient/repo',
  },
]

const cfg = (...lines) => [...lines, ''].join(LF)

describe('QA #149 — the blank-spelling matrix, at every one of the five call sites', () => {
  it('reports the shell it measured against, and finds the loop dispatch it needs', () => {
    // Not an assertion about a version — a record of one, so a red row below can be read against
    // the shell that produced it. What IS asserted is that the slice out of templates/ralph.sh came
    // back whole: an empty or one-armed slice would make every `loopSource` call vacuous.
    expect(BASH_VERSION).toMatch(/^[0-9]/)
    expect(DISPATCH).toContain(DISPATCH_HEAD)
    expect(DISPATCH).toContain('"${TASK_SOURCE:-github}" = "jira"')
    expect(DISPATCH.trimEnd().endsWith('fi')).toBe(true)
  })

  it('bash blanks an inherited value for FIVE spellings and keeps one, at every knob', async () => {
    // The fixture set, validated as a fixture set: the five rows must be the five bash blanks and
    // quoted whitespace must be the one it does not blank — for every knob name, since the name is
    // part of the line the shell parses. Nothing below reads a hardcoded transcript; this test is
    // what earns the word "blank" in the rest of the file.
    for (const name of KNOB_NAMES) {
      for (const [label, line] of blankSpellings(name)) {
        const { held, stderr } = await loopEnv(cfg(line), { [name]: 'INHERITED' })
        expect(held[name], `${name}: ${label}`).toBe('')
        // Empty stderr is the other half of the claim: bash ASSIGNED here, it did not run a word.
        expect(stderr, `${name}: ${label}`).toBe('')
      }
      const kept = await loopEnv(cfg(quotedWhitespace(name)), { [name]: 'INHERITED' })
      expect(kept.held[name], `${name}: quoted whitespace`).toBe(SPACES)
      expect(kept.stderr, `${name}: quoted whitespace`).toBe('')
    }
  })

  for (const site of CALL_SITES) {
    describe(site.label, () => {
      for (const [label, line] of blankSpellings(site.name)) {
        it(`masks the environment for ${label}`, async () => {
          const config = cfg(...site.prefix, line)
          // The loop's own answer first, from the shell, so the expectation below is anchored to a
          // measurement of THIS config rather than to a general claim.
          const { held } = await loopEnv(config, { [site.name]: site.ambient })
          expect(held[site.name]).toBe('')

          const { d } = await run({
            ...site.fixture,
            config,
            processEnv: { [site.name]: site.ambient },
          })
          expect(rowOf(d, site.row), label).toBe(site.blanked)
          // No row may quote the value the loop is not going to see.
          expect(stripAnsi(d.stdout.output()), label).not.toContain(site.ambient)
        })
      }

      it('lets the environment answer when the file never mentions the name', async () => {
        // The one case bash falls through on, at the same site, so the five above cannot be
        // satisfied by a closure that stopped reading the environment altogether.
        const config = cfg(...site.prefix)
        const { held } = await loopEnv(config, { [site.name]: site.ambient })
        expect(held[site.name]).toBe(site.ambient)

        const { d } = await run({
          ...site.fixture,
          config,
          processEnv: { [site.name]: site.ambient },
        })
        expect(rowOf(d, site.row)).toBe(site.inherited)
      })

      it('keeps QUOTED WHITESPACE reading as it did, since bash keeps that value', async () => {
        // The non-regression, at every site rather than at the three the issue named. This is the
        // one spelling where a truthiness test and a presence test agreed BEFORE the fix, so the
        // fix must not have moved it — and the shell is asked, per site, what it is left holding.
        const config = cfg(...site.prefix, quotedWhitespace(site.name))
        const { held } = await loopEnv(config, { [site.name]: site.ambient })
        expect(held[site.name]).toBe(SPACES)

        const { d } = await run({
          ...site.fixture,
          config,
          processEnv: { [site.name]: site.ambient },
        })
        // The file masks the environment in the sourcing shell too, so the ambient value is out of
        // the box here for the same reason as above — what differs is only that the file's value is
        // three spaces rather than nothing, and every reader downstream refuses three spaces.
        expect(stripAnsi(d.stdout.output())).not.toContain(site.ambient)
        expect(rowOf(d, site.row)).toBe(site.whitespace ?? site.blanked)
      })
    })
  }

  it('has a row for every name the command hands to `sourcedValue`', () => {
    // The matrix is only exhaustive while the list is. Read the call sites out of the source, so a
    // sixth knob pointed at the closure fails here instead of silently going unmeasured.
    const src = readFileSync(new URL('./start.js', import.meta.url), 'utf8')
    const called = new Set(
      [...src.matchAll(/sourcedValue\(\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]),
    )
    expect([...called].sort()).toEqual([...KNOB_NAMES].sort())
  })
})

// ---------------------------------------------------------------------------
// 2. The consumers, asked rather than paraphrased.
// ---------------------------------------------------------------------------

describe('QA #149 — the box against the programs that actually read each knob', () => {
  let workdir
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'ralph-149-capture-qa-'))
    mkdirSync(join(workdir, 'logs'), { recursive: true })
  })
  afterAll(() => {
    if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true })
  })

  /** The `context_window` a real telemetry write records, given the loop's environment. */
  const recordedWindow = (loopHeld, id) => {
    captureIssueEvent({
      env: {
        PROJECT_ROOT: workdir,
        RALPH_RUN_ID: `ralph-${id}`,
        RALPH_CLAUDE_EXIT: '0',
        TASK_SOURCE: 'folder',
        RALPH_TASK_ID: String(id),
        RALPH_TASK_OUTCOME: 'done',
        RALPH_AGENT: 'codex',
        RALPH_CODEX_MODEL: loopHeld[MODEL],
        RALPH_CONTEXT_WINDOW: loopHeld[WINDOW],
      },
      fetchDiffStats: () => ({}),
    })
    const events = readFileSync(metricsPath(workdir), 'utf8')
      .split(LF)
      .filter(Boolean)
      .map((line) => JSON.parse(line.slice('RALPH_ISSUE_EVENT '.length)))
    return events[events.length - 1].context_window
  }

  it('the window row is the number the run’s FIRST EVENT will record, for every blank', async () => {
    // The dev's file asserts the row against `resolveContextWindow`, one layer below the writer.
    // This goes to the writer itself: `captureIssueEvent` reads the knob out of the environment
    // bash produced, and the number it appends to issues.jsonl is compared with the row that was
    // on screen before the loop started. One number, two programs, and neither expectation is
    // written down as a literal in this test.
    let id = 10
    for (const [label, line] of [
      ...blankSpellings(WINDOW),
      ['quoted whitespace', quotedWhitespace(WINDOW)],
    ]) {
      const config = cfg(`${SOURCE}=folder`, `${AGENT}=codex`, `${MODEL}=gpt-5-codex`, line)
      const { held } = await loopEnv(config, { [WINDOW]: '200000' })
      const { d } = await run({ config, processEnv: { [WINDOW]: '200000' } })

      id += 1
      const recorded = recordedWindow(held, id)
      // The row prints a compact number, so the comparison is made in the row's own units.
      expect(rowOf(d, 'context'), label).toBe(`${recorded / 1000}k tokens`)
      // ...and never the override the file blanked.
      expect(rowOf(d, 'context'), label).not.toBe('200k tokens')
    }
  })

  it('the window row still follows an override the file really sets', async () => {
    // The control for the test above: when the file's value survives bash, both readers take it,
    // so the agreement is not an artifact of both falling back to the same map.
    const config = cfg(`${SOURCE}=folder`, `${AGENT}=codex`, `${MODEL}=gpt-5-codex`, `${WINDOW}=128000`)
    const { held } = await loopEnv(config, { [WINDOW]: '200000' })
    expect(held[WINDOW]).toBe('128000')
    const { d } = await run({ config, processEnv: { [WINDOW]: '200000' } })
    expect(rowOf(d, 'context')).toBe(`${recordedWindow(held, 90) / 1000}k tokens`)
    expect(rowOf(d, 'context')).toBe('128k tokens')
  })

  it('the model row names a model exactly when the loop will pass `-m`, for every blank', async () => {
    // `buildAgentInvocation` is the module that builds codex's argv, handed the environment bash
    // produced. The row and the flag have to agree in both directions.
    for (const [label, line] of [
      ...blankSpellings(MODEL),
      ['quoted whitespace', quotedWhitespace(MODEL)],
    ]) {
      const config = cfg(`${SOURCE}=folder`, `${AGENT}=codex`, line)
      const { held } = await loopEnv(config, { [MODEL]: 'gpt-5-codex' })
      const { args } = buildAgentInvocation({ RALPH_AGENT: 'codex', [MODEL]: held[MODEL] })
      const at = args.indexOf('-m')

      const { d } = await run({ config, processEnv: { [MODEL]: 'gpt-5-codex' } })
      expect(at, label).toBe(-1)
      expect(rowOf(d, 'agent'), label).toBe('codex — model resolves at first run')
      expect(rowOf(d, 'context'), label).toBeUndefined()
    }
  })

  it('the agent row names the agent `resolveAgent` will resolve, for every blank', async () => {
    // templates/ralph.sh shells out to lib/agent-registry.js for RALPH_RESOLVED_AGENT, so this is
    // the loop's own reader, handed the loop's own environment.
    for (const [label, line] of [
      ...blankSpellings(AGENT),
      ['quoted whitespace', quotedWhitespace(AGENT)],
    ]) {
      const config = cfg(`${SOURCE}=folder`, line)
      const { held } = await loopEnv(config, { [AGENT]: 'codex' })
      const { agent } = resolveAgent({ [AGENT]: held[AGENT] })
      expect(agent, label).toBe('claude')

      const { d } = await run({ config, metrics: CLAUDE_HISTORY, processEnv: { [AGENT]: 'codex' } })
      expect(rowOf(d, 'agent'), label).toBe('claude — claude-opus-5 (last run)')
      // And #118's second half: no warning about a value no run will read.
      expect(d.stderr.output(), label).not.toContain(AGENT)
    }
  })

  it('the source row is what the TEMPLATE’s own dispatch resolves, for every blank', async () => {
    // templates/ralph.sh:357-363, sliced out and run after the same config is sourced. Its compare
    // is EXACT where `resolveSource` trims and lowercases, so the two are not the same function —
    // which is why this is measured per spelling instead of assumed for the family.
    for (const [label, line] of [
      ...blankSpellings(SOURCE),
      ['quoted whitespace', quotedWhitespace(SOURCE)],
    ]) {
      const config = cfg(line)
      const loop = await loopSource(config, { [SOURCE]: 'folder' })
      const { d } = await run({ config, processEnv: { [SOURCE]: 'folder' } })
      expect(loop, label).toBe('github')
      expect(rowOf(d, 'source'), label).toBe('github')
    }
  })

  it('the PREFLIGHT follows that row for every blank, not only for `=""`', async () => {
    // The behaviour half of criterion 3, swept. The dev's file asserts the github preflight for one
    // spelling; the preflight spends the same binding for all of them, and a queue counted from the
    // wrong place is what this knob's blank costs.
    for (const [label, line] of blankSpellings(SOURCE)) {
      const { d, result } = await run({
        config: cfg(line),
        processEnv: { [SOURCE]: 'folder' },
      })
      expect(d.exec.calls.some((c) => c.key === 'gh auth status'), label).toBe(true)
      expect(d.exec.calls.some((c) => c.key.startsWith('gh label create')), label).toBe(true)
      expect(d.exec.calls.some((c) => c.cmd === 'gh' && c.args.includes('--search')), label).toBe(true)
      // The folder tree is never walked, and the count that decides whether to launch is GitHub's.
      expect(d.folderCounts, label).toEqual([])
      expect(result, label).toEqual({ exitCode: 0, started: true, count: 9 })
    }
  })

  it('runs the FOLDER preflight for a config that really says folder', async () => {
    // The control: the sweep above must not pass because the command lost the ability to run a
    // folder preflight at all.
    const { d, result } = await run({
      config: cfg(`${SOURCE}=folder`),
      processEnv: { [SOURCE]: 'github' },
    })
    expect(rowOf(d, 'source')).toBe('folder')
    expect(d.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)
    expect(d.folderCounts).toEqual([1])
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
  })
})

// ---------------------------------------------------------------------------
// 3. The shared grammar TASK_SOURCE rests on, now that `start` has no per-knob reader.
// ---------------------------------------------------------------------------

describe('QA #149 — TASK_SOURCE reads the shared grammar, like every other knob', () => {
  // `sourcedValue` is single-arity, so `ralph start` reads this knob with
  // `parseConfigVar(configText, 'TASK_SOURCE')` — not with `parseConfigSource`, which is what
  // `ralph cycle`, `ralph status` and `ralph doctor` call. The #149 review took the second argument
  // out because lib/read-config-source.js defines `parseConfigSource` as that same call verbatim,
  // so the argument bought a tripwire rather than a spelling. These rows are that tripwire, kept
  // and pointed at what now depends on it: the day the two readers part, `ralph start` and the
  // other three commands read one knob out of one file two different ways.
  // The shapes the two readers could plausibly disagree about: absent, plain, quoted, exported,
  // commented inline, commented out, repeated, a longer name that must not match, padded, an
  // unrecognised value, the five blank spellings, and quoted whitespace.
  const SHAPES = [
    ['absent', ''],
    ['a plain value', cfg(`${SOURCE}=folder`)],
    ['a quoted value', cfg(`${SOURCE}="folder"`)],
    ['an exported value', cfg(`export ${SOURCE}=folder`)],
    ['an inline comment', cfg(`${SOURCE}=folder # the tasks tree`)],
    ['a repeated assignment', cfg(`${SOURCE}=folder`, `${SOURCE}=jira`)],
    ['a commented-out line', cfg(`# ${SOURCE}=folder`)],
    ['a longer name', cfg(`${SOURCE}_FALLBACK=folder`)],
    ['a value with padding', cfg(`${SOURCE}=  folder  `)],
    ['an unrecognised value', cfg(`${SOURCE}=banana`)],
    ...blankSpellings(SOURCE).map(([label, line]) => [label, cfg(line)]),
    ['quoted whitespace', cfg(quotedWhitespace(SOURCE))],
  ]

  it('the other three commands’ reader always answers with a string, never `undefined`', () => {
    // Not a property of `sourcedValue` any more — it is what keeps `resolveSource` from ever being
    // handed a non-string by `cycle`, `status` or `doctor`, which pass this reader's answer straight
    // in the way `start` used to.
    for (const [label, text] of SHAPES) {
      expect(typeof parseConfigSource(text), label).toBe('string')
    }
    // ...including for the inputs a caller could reach the reader with at all.
    for (const text of [undefined, null, '', 0, false]) {
      expect(typeof parseConfigSource(text)).toBe('string')
    }
  })

  it('and it agrees with the shared reader `start` now uses, on every shape', () => {
    // THE TRIPWIRE. `ralph start` asks `parseConfigVar(text, TASK_SOURCE)`; the other three ask
    // `parseConfigSource(text)`. They are the same call today (lib/read-config-source.js), which is
    // the whole reason #149 could drop the per-site argument — so this row is what notices the day
    // one of them grows a spelling the other does not have, and the four commands stop agreeing
    // about which queue one config file names.
    for (const [label, text] of SHAPES) {
      expect(parseConfigSource(text), label).toBe(parseConfigVar(text, SOURCE))
    }
  })

  it('and PRESENCE is what decides, for the shapes where the two answers part', () => {
    // The pair the closure is built out of, over the same table: `configAssignsVar` and
    // `parseConfigVar` are opposites exactly for a blanked line, which is the case the ternary
    // exists for.
    for (const [label, line] of blankSpellings(SOURCE)) {
      const text = cfg(line)
      expect(configAssignsVar(text, SOURCE), label).toBe(true)
      expect(parseConfigVar(text, SOURCE), label).toBe('')
    }
    expect(configAssignsVar('', SOURCE)).toBe(false)
    expect(configAssignsVar(cfg(`# ${SOURCE}=folder`), SOURCE)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. `processEnv[name]` as a computed index.
// ---------------------------------------------------------------------------

describe('QA #149 — the environment bag, indexed by a computed name', () => {
  it('treats an OWN property whose value is `undefined` as unset, at every knob', async () => {
    // A bag can HAVE the key and hold nothing — `{ GH_REPO: undefined }` is what a spread of a
    // partially-populated object produces. `Object.hasOwn` is true, the value is not a string, and
    // the fallback arm hands it straight to the row's resolver. No row may print it.
    const processEnv = Object.fromEntries(KNOB_NAMES.map((name) => [name, undefined]))
    for (const name of KNOB_NAMES) expect(Object.hasOwn(processEnv, name)).toBe(true)

    const { d, result } = await run({ config: cfg(`${SOURCE}=github`, `${AGENT}=codex`), processEnv })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(rowOf(d, 'agent')).toBe('codex — model resolves at first run')
    expect(rowOf(d, 'context')).toBeUndefined()
    expect(rowOf(d, 'repo')).toBe(ORIGIN_SLUG)
    expect(stripAnsi(d.stdout.output())).not.toContain('undefined')
    expect(stripAnsi(d.stdout.output())).not.toContain('NaN')
    expect(d.stderr.output()).not.toContain('undefined')
  })

  it('survives values that are not strings at all', async () => {
    // The knobs are read out of an injected bag, and a library consumer's bag is not obliged to
    // hold strings. `Number()` of an object is NaN and `trim` is not a method on a number, so the
    // question is whether anything downstream assumed a string — measured, at all five names.
    const processEnv = {
      [AGENT]: 42,
      [SOURCE]: { toString: () => 'folder' },
      [MODEL]: 7,
      [WINDOW]: 200000,
      [REPO_KNOB]: ['owner', 'repo'],
    }
    const { d, result } = await run({ config: '', metrics: CLAUDE_HISTORY, processEnv })
    expect(result.exitCode).toBe(0)
    expect(stripAnsi(d.stdout.output())).not.toContain('NaN')
    expect(stripAnsi(d.stdout.output())).not.toContain('[object Object]')
  })

  it('keeps the LAUNCH when the bag’s `GH_REPO` accessor throws', async () => {
    // Verified independently of `bannerRepoSlug`'s note: the closure is handed to the helper rather
    // than called at the call site precisely so this read happens inside the helper's `try`. The
    // getter is armed to record that it really ran, so a passing run cannot mean the read was
    // skipped.
    let read = 0
    const processEnv = {
      get [REPO_KNOB]() {
        read += 1
        throw new Error('hostile accessor')
      },
    }
    const { d, result } = await run({ config: cfg(`${SOURCE}=github`), processEnv })
    expect(read).toBeGreaterThan(0)
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    // The row is the only casualty — a missing row says nothing, where a row reading `unknown`
    // would say something false.
    expect(rowOf(d, 'repo')).toBeUndefined()
    expect(boxOf(d).length).toBeGreaterThan(2)
  })

  it('and a BLANKED config shields that accessor from ever being called', async () => {
    // A property the ternary has that the `||` did not: the presence test never reaches the bag for
    // a name the file assigns, blank included, where `parseConfigVar(...) || processEnv[NAME]`
    // reached it for exactly the blank case. So the same hostile bag is not even touched here.
    let read = 0
    const processEnv = {
      get [REPO_KNOB]() {
        read += 1
        throw new Error('hostile accessor')
      },
    }
    const { d, result } = await run({
      config: cfg(`${SOURCE}=github`, `${REPO_KNOB}=""`),
      processEnv,
    })
    expect(read).toBe(0)
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(rowOf(d, 'repo')).toBe(ORIGIN_SLUG)
  })

  it('records which of the five names a throwing accessor can still abort the launch on', async () => {
    // The blast radius, measured rather than assumed, because only ONE of the five reads is inside
    // a `try`. This is a PIN on today's answer, not an endorsement: a bag whose accessor throws is
    // a library-consumer shape (#41 made every one of these an injected seam), and the row-versus-
    // launch trade `bannerRepoSlug` argues for GH_REPO is not made anywhere else.
    //
    // It is also NOT a #149 regression, and that is the reason it is a pin: the expression this
    // slice replaced read the same bag with a named property at the same four unguarded sites. What
    // #149 changed is only WHEN the read happens (never, for a name the file assigns), which is the
    // strictly narrower blast radius the test above measures.
    const aborts = []
    for (const name of KNOB_NAMES) {
      const processEnv = {
        get [name]() {
          throw new Error(`hostile ${name}`)
        },
      }
      let threw = null
      try {
        await run({ config: cfg(`${SOURCE}=github`), metrics: CLAUDE_HISTORY, processEnv })
      } catch (error) {
        threw = error.message
      }
      if (threw) aborts.push(name)
    }
    // TASK_SOURCE is absent from the list for a reason worth naming: the config above assigns it,
    // so the presence test never reads the bag for that name at all.
    expect(aborts).toEqual([AGENT, MODEL, WINDOW])
  })

  it('reads a PROTOTYPE-reachable knob at every name, exactly as a named read would', async () => {
    // The dev's file makes this point for the model. It is a property of property access rather
    // than of the model, so it is swept: for each name, an own-property-empty bag carrying the knob
    // on its prototype answers, and the pre-#149 named read answers identically.
    for (const name of KNOB_NAMES) {
      const bag = Object.create({ [name]: 'inherited-value' })
      expect(Object.keys(bag), name).toEqual([])
      expect(Object.hasOwn(bag, name), name).toBe(false)
      expect(bag[name], name).toBe('inherited-value')
    }
    // ...and through the command, on the one name where an inherited value is legible in a row.
    const bag = Object.create({ [MODEL]: 'inherited-model' })
    const { d } = await run({ config: cfg(`${SOURCE}=folder`, `${AGENT}=codex`), processEnv: bag })
    expect(rowOf(d, 'agent')).toBe('codex — inherited-model (configured)')
  })

  it('is not satisfied by a name that merely looks like a knob, at any of the five', async () => {
    // The index is computed, so the adversarial probe is a bag full of near-misses: a suffix, a
    // prefix, a lower-case twin, and `Object.prototype`'s own members under the knob's shape. None
    // of them may answer for the knob.
    //
    // The poison value is a word no line this command prints contains, which is not a detail: an
    // ordinary `no` is a substring of "notifications" in the WhatsApp notice, so a leak check
    // written on it passes for the wrong reason at best and fails for one at worst.
    const LEAK = 'QA-NEAR-MISS-LEAK'
    const nearMisses = {}
    for (const name of KNOB_NAMES) {
      nearMisses[`${name}_X`] = LEAK
      nearMisses[`MY_${name}`] = LEAK
      nearMisses[name.toLowerCase()] = LEAK
    }
    nearMisses.constructor = LEAK
    nearMisses.toString = LEAK
    const { d, result } = await run({
      config: cfg(`${SOURCE}=github`, `${AGENT}=codex`),
      processEnv: nearMisses,
    })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(rowOf(d, 'agent')).toBe('codex — model resolves at first run')
    expect(rowOf(d, 'repo')).toBe(ORIGIN_SLUG)
    expect(stripAnsi(d.stdout.output())).not.toContain(LEAK)
    expect(d.stderr.output()).not.toContain(LEAK)
  })
})

// ---------------------------------------------------------------------------
// 5. A BLANK SPELLED WITH A SPACE AFTER THE `=` — the seventh family, outside the
//    five-plus-one list above, and the one the grammar now refuses.
// ---------------------------------------------------------------------------

describe('QA #149 — `NAME= ""` no longer masks an environment bash leaves standing', () => {
  // WHAT THIS FAMILY IS. `NAME= ""` is not a blank assignment to bash at all. The `NAME=` is an
  // environment prefix scoped to the COMMAND that follows it, the command here is the empty word
  // `""`, and a prefix is scoped to the command it precedes — so the sourcing shell assigns nothing
  // and whatever it already held SURVIVES. Measured below rather than quoted, at every knob.
  //
  // WHY IT WAS A REGRESSION AND NOT A WART. `parseConfigVar` read this line as '' while
  // `configAssignsVar` called it PRESENT — the combination named in lib/parse-config-var.js's "THE RULE,
  // STATED ONCE" paragraph as the direction that DESTROYS an answer rather than inventing one. Under the old
  // `parseConfigVar(...) || processEnv[NAME]`, '' was falsy, the environment answered, and the box
  // AGREED WITH BASH by accident. Moving RALPH_CODEX_MODEL, RALPH_CONTEXT_WINDOW and TASK_SOURCE onto
  // the presence test made the '' win, so for those three the box began naming something the loop
  // was not about to use — #149's own defect, one spelling over. The two expressions are still
  // evaluated side by side below, which is what turns "they agree again" into a measurement.
  //
  // WHAT THE FIX WAS. `configAssignsVar` and `parseConfigVar` now BOTH refuse a bare `NAME=`
  // followed by a blank and a word — `envPrefixedNothing`, built from the same name as `assignmentHead`
  // so there is still one grammar. THE FIRST VERSION OF THAT FIX WAS THE DESTROYING HALF ONLY, drawn
  // around a word made of nothing but empty quotes, and two review rounds each found the same class
  // one spelling over (`NAME= ""`, then `NAME=# off`). The third round rewrote it around bash's word
  // rule instead — `endOfWord` walks the line the way the shell's tokenizer does — so the INVENT half
  // (`NAME= folder`) is refused too. The last test in this block is what bounds it: what still
  // invents is an `export` prefix and a subshell tail, both measured there.
  //
  // AND THE TWO BOUNDARIES THE FIX HAD TO KEEP, both asserted below against bash: a blank after the
  // `=` with NOTHING behind it is a real assignment to empty and must keep blanking, and
  // `export NAME= ""` really does blank because the builtin applies the `NAME=` argument on its own.

  const SPACED = (name) => `${name}= ""`

  it('bash leaves the inherited value standing for the whole family, at every knob', async () => {
    // The family, per knob: a space, two spaces and a tab between the `=` and the empty word, plus
    // the single-quoted spelling. All four keep the inherited value, and bash SAYS so on stderr —
    // `: command not found` is the shell reporting that it RAN a word rather than assigning one.
    const TAB = String.fromCharCode(9)
    for (const name of KNOB_NAMES) {
      for (const [label, line] of [
        ['one space', `${name}= ""`],
        ['two spaces', `${name}=  ""`],
        ['a tab', `${name}=${TAB}""`],
        ['single quotes', `${name}= ''`],
      ]) {
        const { held, stderr } = await loopEnv(cfg(line), { [name]: 'INHERITED' })
        expect(held[name], `${name}: ${label}`).toBe('INHERITED')
        expect(stderr, `${name}: ${label}`).toContain('command not found')
      }
      // THE TWO BOUNDARIES the grammar fix had to keep, measured on the same shell so the JS row
      // below is checked against them rather than against a claim.
      //
      // `export` is the exception, exactly as parse-config-var.js's "WHAT IS NOT REFUSED" table has
      // it: the builtin takes
      // `NAME=` as an assignment argument of its own, so THAT one really does blank.
      const exported = await loopEnv(cfg(`export ${name}= ""`), { [name]: 'INHERITED' })
      expect(exported.held[name], `${name}: export`).toBe('')
      // ...and a blank after the `=` with NOTHING behind it is a real assignment to empty — there is
      // no word for the `NAME=` to be a prefix of, and bash says nothing on stderr.
      for (const [label, line] of [
        ['a trailing blank and end of line', `${name}= `],
        ['a trailing blank and a comment', `${name}= # off for now`],
      ]) {
        const plain = await loopEnv(cfg(line), { [name]: 'INHERITED' })
        expect(plain.held[name], `${name}: ${label}`).toBe('')
        expect(plain.stderr, `${name}: ${label}`).toBe('')
      }
    }
  })

  it('and both JS readers now call it ABSENT, at every knob and every spelling', () => {
    // The verdict that was `true` before the grammar fix, which is what let the '' mask an
    // environment. Swept over the same four spellings the bash row above measures, so the two halves
    // of the claim are over the same fixture set, plus the two boundary shapes that must NOT move.
    const TAB = String.fromCharCode(9)
    for (const name of KNOB_NAMES) {
      for (const line of [`${name}= ""`, `${name}=  ""`, `${name}=${TAB}""`, `${name}= ''`]) {
        const text = cfg(line)
        expect(configAssignsVar(text, name), line).toBe(false)
        expect(parseConfigVar(text, name), line).toBe('')
      }
      // BOUNDARY 1: a blank after the `=` with nothing behind it. bash assigns empty (asserted
      // below), so this is still an assignment and still blanks.
      expect(configAssignsVar(cfg(`${name}= `), name), name).toBe(true)
      // BOUNDARY 2: `export` changes bash's answer, so it must change this one too.
      expect(configAssignsVar(cfg(`export ${name}= ""`), name), name).toBe(true)
      expect(parseConfigVar(cfg(`export ${name}= ""`), name), name).toBe('')
    }
  })

  it('so the OLD `||` and the presence test agree again — measured, not asserted in prose', () => {
    // The regression closed, as the two expressions rather than as a claim about them. Before the
    // grammar fix the left-hand side read 'INHERITED' and the right-hand side ''; the point of
    // keeping both is that a future widening of the head shows up here as a disagreement.
    for (const name of KNOB_NAMES) {
      const text = cfg(SPACED(name))
      const ambient = { [name]: 'INHERITED' }
      const oldShape = parseConfigVar(text, name) || ambient[name]
      const newShape = configAssignsVar(text, name) ? parseConfigVar(text, name) : ambient[name]
      // bash keeps 'INHERITED' (asserted above), and now so do both.
      expect(oldShape, name).toBe('INHERITED')
      expect(newShape, name).toBe('INHERITED')
    }
  })

  it('does not clear a LIVE earlier line either, which is the same defect inside one file', async () => {
    // The other victim of a present-and-blank verdict, and the case
    // lib/parse-config-var.js's "THE RULE, STATED ONCE" paragraph is written on: two lines, the
    // second of which bash RUNS. The
    // shell holds the first line's value, and the parser used to answer '' — so a repo that spelled
    // its override this way lost the assignment above it as well as the environment. Both halves are
    // asked here, the shell's first.
    for (const name of KNOB_NAMES) {
      const text = cfg(`${name}=live`, SPACED(name))
      const { held, stderr } = await loopEnv(text, { [name]: 'INHERITED' })
      expect(held[name], name).toBe('live')
      expect(stderr, name).toContain('command not found')
      expect(parseConfigVar(text, name), name).toBe('live')
      expect(configAssignsVar(text, name), name).toBe(true)
    }
  })

  it('and the box names the inherited value, for every knob, exactly as the loop does', async () => {
    // End to end, through the real command, with the loop's own answer measured alongside. Each row
    // used to be a place the box stated a fact about a run that was not true of that run; the
    // expectation is now `site.inherited`, which is the row the environment's value earns, and it is
    // reached through the same `inherited` column block 1 uses for a file that never mentions the
    // name — because to bash these two configs are the same config.
    const LOOP_HOLDS = ['codex', 'folder', 'gpt-5-codex', '200000', 'ambient/repo']
    for (const [i, site] of CALL_SITES.entries()) {
      const config = cfg(...site.prefix, SPACED(site.name))
      const { held } = await loopEnv(config, { [site.name]: site.ambient })
      // The loop keeps the environment's value...
      expect(held[site.name], site.label).toBe(LOOP_HOLDS[i])
      const { d } = await run({
        ...site.fixture,
        config,
        processEnv: { [site.name]: site.ambient },
      })
      // ...and so does the box.
      expect(rowOf(d, site.row), site.label).toBe(site.inherited)
      // ...which must not be read as "the row stopped depending on the knob": the blanked answer for
      // the same site is a different string, and block 1 asserts the box gives it for a spelling bash
      // really does blank with.
      expect(rowOf(d, site.row), site.label).not.toBe(site.blanked)
    }
  })

  it('and for TASK_SOURCE it is the PREFLIGHT that follows, which is the sharp half', async () => {
    // The row with teeth, because this knob is not cosmetic: the box's `source` row and the preflight
    // read ONE binding, so the wrong answer here does not merely misreport a run, it sends the
    // command down the other queue's preflight. The command now runs the FOLDER one — no
    // `gh auth status`, no label creation, `.ralph/tasks` counted — for a loop that is about to read
    // tasks out of `.ralph/tasks`, because the environment says folder and bash keeps it.
    const config = cfg(SPACED(SOURCE))
    const ambient = { [SOURCE]: 'folder' }
    expect(await loopSource(config, ambient)).toBe('folder')

    const { d, result } = await run({ config, processEnv: ambient })
    expect(rowOf(d, 'source')).toBe('folder')
    expect(d.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)
    expect(d.exec.calls.some((c) => c.cmd === 'gh' && c.args[0] === 'label')).toBe(false)
    expect(d.folderCounts).toEqual([1])
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })

    // ...and the launch that used to be an ABORT, on the same inputs with a `gh` that is not
    // authenticated. This is the half of the defect that cost a run rather than a row: the folder
    // repo never asks `gh` anything, so an unauthenticated `gh` is irrelevant to it and the loop
    // starts. Asserted as a resolution, because the old behaviour was a thrown `StartAbort`.
    const failing = deps({ config, processEnv: ambient })
    failing.exec = async (cmd, args = []) => {
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (cmd === 'gh' && args[0] === 'auth') return { exitCode: 1, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    await expect(startCommand(failing)).resolves.toEqual({ exitCode: 0, started: true, count: 3 })
    expect(failing.stderr.output()).not.toContain('gh not authenticated')
  })

  it('the INVENT direction of the same grammar closed too, and what is left of it is named', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the flip is the whole of #149's third review round.
    // `NAME= folder` read as `folder` here while bash assigned nothing, and the reason given for
    // leaving it alone was that the refusal was drawn around "a blank and then a word of EMPTY
    // QUOTES". Two rounds each found the same class one spelling over (`NAME= ""`, then `NAME=# off`),
    // so the refusal was rewritten around bash's own rule — an assignment followed by a COMMAND WORD
    // is an environment prefix and dies with that command — and this row went with it. Measured, on
    // the shell that sources the file:
    //
    //   $ printf 'TASK_SOURCE= folder\n' > p.sh
    //   $ TASK_SOURCE=github bash -c 'set -a; . ./p.sh; set +a; printf "[%s]" "$TASK_SOURCE"'
    //   ./p.sh: line 1: folder: command not found
    //   [github]
    //
    // So BOTH readers now decline the line and both expressions land on the environment — which is
    // also the one row where the old `||` was accidentally right and is now right on purpose.
    const config = cfg(`${SOURCE}= folder`)
    const ambient = { [SOURCE]: 'github' }
    expect(await loopSource(config, ambient)).toBe('github')

    const text = config
    expect(parseConfigVar(text, SOURCE)).toBe('')
    expect(configAssignsVar(text, SOURCE)).toBe(false)
    expect(parseConfigVar(text, SOURCE) || ambient[SOURCE]).toBe('github')
    expect(configAssignsVar(text, SOURCE) ? parseConfigVar(text, SOURCE) : ambient[SOURCE]).toBe('github')

    const { d } = await run({ config, processEnv: ambient })
    expect(rowOf(d, 'source')).toBe('github')

    // WHAT STILL INVENTS, so "the invent direction closed" cannot be read as "it is gone". Two groups
    // survive, both named in lib/parse-config-var.js's "WHAT THE SCAN STILL DOES NOT MODEL", and both
    // measured here rather than described:
    //
    //   export TASK_SOURCE= folder   bash: the builtin gets `TASK_SOURCE=` and `folder` as two
    //                                arguments and applies the first  -> assigns EMPTY
    //   TASK_SOURCE=folder |cat      bash: the assignment happens in the pipeline's subshell
    //                                -> the inherited value stands
    //
    // The first invents a VALUE while getting presence right; the second is still the destroying
    // shape (present, and the loop holds something else). Neither is reachable by the refusal without
    // costing a line bash really does assign, which is why they are pinned rather than fixed.
    const exported = cfg(`export ${SOURCE}= folder`)
    expect((await loopEnv(exported, { [SOURCE]: 'github' })).held[SOURCE]).toBe('')
    expect(parseConfigVar(exported, SOURCE)).toBe('folder')
    expect(configAssignsVar(exported, SOURCE)).toBe(true)

    const piped = cfg(`${SOURCE}=folder |cat`)
    expect((await loopEnv(piped, { [SOURCE]: 'github' })).held[SOURCE]).toBe('github')
    expect(parseConfigVar(piped, SOURCE)).toBe('folder |cat')
    expect(configAssignsVar(piped, SOURCE)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. The cross-command divergence this slice declared out of scope.
// ---------------------------------------------------------------------------

describe('QA #149 — the three commands still on a `||`, and what the difference costs', () => {
  const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')

  const doctorRun = async ({ config, env, hasCommand = () => true }) => {
    const { Volume } = await import('memfs')
    const chunks = []
    const result = await doctorCommand({
      stdout: { columns: 100, write: (s) => (chunks.push(s), true) },
      stderr: { write: () => true },
      hasCommand,
      platform: { isMac: true, isLinux: false, name: 'macOS' },
      env,
      currentVersion: VERSION,
      cacheFs: Volume.fromJSON({ [CACHE_PATH]: JSON.stringify({ latest_version: VERSION }) }, '/'),
      home: HOME,
      cwd: REPO,
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: () => config,
      color: false,
      columns: 100,
    })
    return { result, output: chunks.join('') }
  }

  it('the three `||` sites are byte-identical to the commit this slice branched from', () => {
    // The precondition for calling the divergence below pre-existing rather than introduced: the
    // expression in those three commands was not touched. Read out of the sources, so a later edit
    // to any of them lands here.
    for (const file of ['cycle.js', 'status.js', 'doctor.js']) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      expect(src, file).toMatch(
        /TASK_SOURCE: parseConfigSource\(configText\) \|\| (?:processEnv|env)\?*\.TASK_SOURCE/,
      )
    }
    // ...and `ralph start` is the only one of the four that does NOT spell it that way.
    const start = readFileSync(new URL('./start.js', import.meta.url), 'utf8')
    expect(start).not.toMatch(/parseConfigSource\(configText\) \|\|/)
  })

  it('PINNED DIVERGENCE: `ralph doctor` reports green where `ralph start` will abort', async () => {
    // The cost, measured. One config that blanks TASK_SOURCE, one shell exporting `folder`, one
    // machine without `gh`:
    //
    //   the loop           github  (templates/ralph.sh's dispatch, asserted from the shell below)
    //   `ralph start`      github  (the presence test) -> demands `gh auth status`
    //   `ralph doctor`     folder  (`||` reaches past the blank) -> never asks for `gh`, exits 0
    //
    // So a user whose config blanks the knob gets a clean bill of health from the command whose job
    // is to predict a launch, and then a launch that aborts. doctor.js's own note declares this out
    // of #149's scope and names status.js:384 and cycle.js:194 as the rest of the follow-up; what
    // is asserted here is TODAY'S answer, so the day those three move this test goes red and says
    // so. WHEN THAT HAPPENS: `mentionsGh` becomes true, `exitCode` becomes 1, and this test becomes
    // an agreement test rather than a divergence pin.
    const config = cfg(`${SOURCE}=""`)
    const ambient = { [SOURCE]: 'folder' }

    // What the loop will do, from the template's own dispatch.
    expect(await loopSource(config, ambient)).toBe('github')

    // What `ralph start` does: the github preflight, and the abort when gh is not authenticated.
    const started = await run({ config, processEnv: ambient })
    expect(rowOf(started.d, 'source')).toBe('github')
    expect(started.d.exec.calls.some((c) => c.key === 'gh auth status')).toBe(true)

    // What `ralph doctor` does with the same two inputs on a machine with no gh at all.
    const noGh = (name) => name !== 'gh'
    const blanked = await doctorRun({ config, env: ambient, hasCommand: noGh })
    expect(blanked.result.exitCode).toBe(0)
    expect(blanked.result.missingCritical).toEqual([])
    expect(/\bgh\b/.test(blanked.output)).toBe(false)

    // The control, and the proof the assertion above is not vacuous: doctor DOES demand gh once the
    // knob resolves to github by a route its `||` can see.
    const github = await doctorRun({ config: cfg(`${SOURCE}=github`), env: {}, hasCommand: noGh })
    expect(github.result.exitCode).toBe(1)
    expect(github.result.missingCritical.map((d) => d.name)).toContain('gh')
  })

  it('and the two commands AGREE for every non-blank spelling, which is why it is one gap', async () => {
    // The scope of the divergence, bounded: `||` and the presence test differ only for an
    // assignment bash blanks. Anything the file really says is read the same way by both, so the
    // follow-up is one case rather than a general disagreement.
    for (const [label, line] of [
      ['a plain value', `${SOURCE}=folder`],
      ['a quoted value', `${SOURCE}="folder"`],
      ['an exported value', `export ${SOURCE}=folder`],
      ['a padded value', `${SOURCE}=  folder  `],
      ['quoted whitespace', quotedWhitespace(SOURCE)],
    ]) {
      const config = cfg(line)
      const noGh = (name) => name !== 'gh'
      const doctor = await doctorRun({ config, env: { [SOURCE]: 'github' }, hasCommand: noGh })
      const started = await run({ config, processEnv: { [SOURCE]: 'github' } })
      // Quoted whitespace resolves to github in BOTH readers (it is truthy, and `resolveSource`
      // trims it to the default), so the pair is compared rather than asserted to a constant.
      const doctorSaysGithub = doctor.result.exitCode === 1
      const startSaysGithub = rowOf(started.d, 'source') === 'github'
      expect(doctorSaysGithub, label).toBe(startSaysGithub)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. The refusal itself, attacked at its boundary (QA of the #149 review fix).
// ---------------------------------------------------------------------------

describe('QA #149 review — `envPrefixedNothing`, at the boundary it draws', () => {
  // WHAT THIS BLOCK IS FOR. `envPrefixedNothing` (lib/parse-config-var.js) is new surface, and
  // it is a refusal: it makes both readers answer "the file does not assign this name" for a line
  // that matches it. A refusal has two ways to be wrong, and neither is visible from the spellings
  // the fix was written against —
  //
  //   TOO WIDE: it refuses a line bash really does assign, and the box then reports an inherited
  //             value for a knob the loop is about to blank. That is the SAME defect as #149's,
  //             pointing the other way, and the sweep below is written as the property rather than
  //             as a table so a spelling nobody thought of cannot pass by not being listed.
  //   TOO NARROW: a line bash does not assign, where the parser still reads '' and calls it
  //             present, is still out there masking an environment. The `#` spellings in the second
  //             test WERE that, and the third review round brought them under the same rule; the
  //             sweep's own enumeration is what says nothing else in the family is.
  //
  // Every row here is decided by a real bash sourcing a real file with `set -a`, exactly as
  // templates/ralph.sh does, with a value already inherited — never by a claim about bash.
  const TAB = String.fromCharCode(9)
  const CR = String.fromCharCode(13)
  // U+2028 LINE SEPARATOR. Spelled by code point rather than typed, because a raw one in this source
  // would be an actual line break to some readers and an invisible character to others; and because
  // the whole point of the row is that bash treats it as an ordinary word character, not a newline.
  const LS = String.fromCharCode(8232)
  const INHERITED = 'INHERITED'

  // Written on RALPH_CODEX_MODEL because it is the knob whose row states a model the loop will be
  // handed, and because `loopEnv` reports every knob anyway. The grammar is per-name, and block 5
  // already swept all five names for the spellings the fix names.
  const N = MODEL

  const FAMILY = [
    // The shape the fix refuses, in every spelling of "a blank and a word of empty quotes" this
    // reader can reach: both quote styles, both blanks, mixed styles, repeats, a comment tail glued
    // and spaced, a CRLF line ending, and an indent of each blank.
    ['one space, double quotes', `${N}= ""`],
    ['one space, single quotes', `${N}= ''`],
    ['two spaces and a padded tail', `${N}=  ""  `],
    ['a tab', `${N}=${TAB}""`],
    ['a tab and single quotes', `${N}=${TAB}''`],
    ['mixed quote styles', `${N}= ""''`],
    ['mixed the other way round', `${N}= ''""`],
    ['three empty words glued together', `${N}= ""''""`],
    ['a comment glued to the closing quote', `${N}= ""#off`],
    ['a comment after a blank', `${N}= "" # off`],
    ['a comment after a tab', `${N}= ""${TAB}# off`],
    ['a CRLF line ending', `${N}= ""${CR}`],
    ['a space indent', `  ${N}= ""`],
    ['a tab indent', `${TAB}${N}= ""`],
    // Shapes bash really does assign, which the refusal must NOT reach. These are the boundary the
    // fix had to keep, plus the six spellings block 1 is built on.
    ['a blank tail and end of line', `${N}= `],
    ['a blank tail and a comment', `${N}= # off`],
    ['an export of the refused shape', `export ${N}= ""`],
    ['an export of a bare `=`', `export ${N}=`],
    ['empty double quotes, no blank', `${N}=""`],
    ['a bare `=`', `${N}=`],
    ['quoted whitespace', quotedWhitespace(N)],
    // WHAT USED TO BE THE INVENT HALF of this family — bash assigns nothing and the parser read a
    // VALUE — and is now refused with the rest of it. These rows were listed here as pinned
    // divergences; the third review round rewrote the refusal around bash's word rule instead of
    // around empty quotes, and they came with it. They are kept in the family, in place, so the
    // sweep below states the change rather than losing the rows that used to prove the boundary.
    ['a word', `${N}= folder`],
    ['a quoted space', `${N}= " "`],
    ['quoted content', `${N}= "a"`],
    ['two empty words with a blank between', `${N}= "" ""`],
    ['empty quotes glued to a word', `${N}= ""x`],
    ['a quoted expansion of an unset name', `${N}= "$RALPH_QA_UNSET"`],
    ['a line continuation', `${N}= ""\\`],
    // THE ONE-SPELLING-OVER ROWS. Every row above ends its command word in a way this file already
    // reached: quotes, a `#`, a plain word, end of line. Two kinds of word do not, and each is one
    // spelling over from a row that was already here — which is exactly the gap that drove the two
    // earlier rounds of this fix, so it is closed in the table rather than beside it.
    //
    //   A LONE CARRIAGE RETURN AS THE COMMAND. `${N}= ""${CR}` was here; `${N}= ${CR}` was not. The
    //   CR is not whitespace to bash's tokenizer, so `${N}=` is a prefix and the command word is the
    //   `\r` itself. A CRLF file whose line is `${N}= ` therefore assigns NOTHING, where the same
    //   line with a Unix ending assigns ''. The `${N}=v ` rows are the same shape with a value in
    //   front, which matters because the too-wide direction would blank a knob that has one.
    //   OPERATOR CHARACTERS INSIDE THE COMMAND WORD. `endOfWord` bails out on `;`, `|`, `&`, `>`,
    //   `<` so the six operator tails bash really does assign on stay assigned. Quoting or escaping
    //   those same characters makes them ordinary word characters again, and the bail-out must not
    //   fire — otherwise the refusal stops one spelling short, the way it did on `${N}=# off`.
    //
    // Measured, all twelve, `bash -c` over a real sourced file with a value already inherited: the
    // inherited value stands on every one, and bash reports the word as a command it cannot find
    // (`\r`, the separator, `a;b`, `a|b`, `a&b`, `a>b`, `ab;c`).
    ['a blank and a carriage return', `${N}= ${CR}`],
    ['two blanks and a carriage return', `${N}=  ${CR}`],
    ['a tab and a carriage return', `${N}=${TAB}${CR}`],
    ['a value, a blank and a carriage return', `${N}=v ${CR}`],
    ['a value, two blanks and a carriage return', `${N}=v  ${CR}`],
    ['a blank and a Unicode line separator', `${N}= ${LS}`],
    ['a quoted semicolon', `${N}= "a;b"`],
    ['a single-quoted pipe', `${N}= 'a|b'`],
    ['an escaped ampersand', `${N}= a\\&b`],
    ['a quoted redirection', `${N}= "a>b"`],
    ['a bare word glued to a quoted semicolon', `${N}= a"b;c"`],
    ['a value and a quoted semicolon', `${N}=v "a;b"`],
    // A TAIL THAT IS A LINE CONTINUATION, which is the one the #149 review's own sweep caught this
    // refusal getting wrong — and getting wrong in the TOO WIDE direction, which is #149's own
    // defect one spelling over. A backslash at the very END of a line is neither an escape of a
    // character nor a word: it is bash's line CONTINUATION, so the line runs on into the next one
    // and a scanner that reads a single line cannot know what the command word will turn out to be.
    // Measured, each row as the config file's only line, sourced with `set -a` with a value for the
    // knob already inherited:
    //
    //   NAME=v \      -> [v]          no stderr: bash ASSIGNED — the continuation joins the empty
    //   NAME=v  \     -> [v]          line after it, so nothing is left to be a command word
    //   NAME=v<TAB>\  -> [v]
    //   NAME=v\       -> [v]
    //   NAME="v" \    -> [v]
    //   NAME= \       -> []           a blank with only a continuation behind it still BLANKS
    //   export NAME=v \ -> [v]
    //   NAME=v \\     -> [INHERITED]  `\: command not found` — TWO backslashes are an ESCAPED one,
    //                                 which is a word, so this line really does run a command
    //   NAME=v a\     -> [INHERITED]  `a: command not found` — the word is `a`, continuation or not
    //
    // The last two are why the answer is not "never refuse a line ending in a backslash": the
    // continuation only defeats the scan where the word it would end has nothing in it yet.
    // `${N}= ""\` above is the same boundary from the other side — the word is `""`, so the refusal
    // stands there whatever follows on the next line.
    ['a value and a trailing continuation', `${N}=v \\`],
    ['a value, two blanks and a trailing continuation', `${N}=v  \\`],
    ['a value, a tab and a trailing continuation', `${N}=v${TAB}\\`],
    ['a continuation glued to the value', `${N}=v\\`],
    ['a quoted value and a trailing continuation', `${N}="v" \\`],
    ['a blank and a trailing continuation', `${N}= \\`],
    ['an export and a trailing continuation', `export ${N}=v \\`],
    ['an escaped backslash where the continuation was', `${N}=v \\\\`],
    ['a word and a trailing continuation', `${N}=v a\\`],
    // ...and one row that still invents, so the enumeration below cannot be read as "nothing does".
    // A tail of `| cat` puts bash's assignment in a subshell, so the inherited value stands while
    // this reader sees an ordinary assignment. Unreachable by the refusal without costing the six
    // operator tails that DO assign (`;`, `&&`, `||`, `>`, `<`, `2>` — measured in
    // lib/parse-config-var.js's table), which is why it is a pin and not a fix.
    ['a subshell tail', `${N}=x |cat`],
  ]

  it('never refuses a line bash assigns, and never leaves a blank one claiming presence', async () => {
    // THE PROPERTY, over the whole family at once. For each row: what does the shell hold, and what
    // do the two readers say about the same text? Three things are asserted, and none of them names
    // a spelling —
    //
    //   1. ABSENT here implies bash kept the inherited value. This is the too-wide direction, and it
    //      is the one that would make the fix a new instance of #149's own defect.
    //   2. PRESENT here implies the resolution matches the shell for every row where bash assigned
    //      something, which is the other half of the same agreement.
    //   3. PRESENT-and-BLANK cannot coexist with a shell that kept its inherited value — that
    //      combination IS the destroying shape, and after the fix no row of this family may be in
    //      it. (The `#` spellings in the next test were outside this family and once WERE in it;
    //      the third review round brought them under the same rule, and that test now agrees with
    //      the shell too.)
    const refused = []
    const invented = []
    // The third bucket, and the one thing this property does NOT hold for: rows where PRESENCE is
    // right — the pair agrees with the shell about whether the file assigns the name — and the VALUE
    // the parser reads is not the string the shell ended up holding. Every row that lands here is a
    // line ending in bash's LINE CONTINUATION, where the shell joins the next line and drops the
    // backslash while this line-based reader keeps it. Collected and enumerated below exactly the way
    // `invented` is, rather than asserted row by row, because it is a divergence of `parseConfigVar`'s
    // multi-line reading that predates #149 (`main` read the same string for these lines) and is
    // strictly smaller than the refusal that used to hide it: a wrong string is a wrong ROW, where the
    // refusal these rows used to get was a wrong QUEUE.
    const valueDiverged = []
    for (const [label, line] of FAMILY) {
      const text = cfg(line)
      const { held } = await loopEnv(text, { [N]: INHERITED })
      const assigns = configAssignsVar(text, N)
      const parsed = parseConfigVar(text, N)
      const resolved = assigns ? parsed : INHERITED
      const why = `${label}: ${JSON.stringify(line)} (bash held ${JSON.stringify(held[N])})`
      if (!assigns) {
        refused.push(label)
        // 1: TOO WIDE would show up here — a refusal over a line the shell really assigned.
        expect(held[N], why).toBe(INHERITED)
      } else if (parsed === '') {
        // 3: TOO NARROW would show up here — present-and-blank is the destroying combination, and
        // over this family it may only ever appear where the shell really did blank the knob.
        expect(held[N], why).toBe('')
      } else {
        // What is left of the invent half: the parser reads a value off a line the shell ignored.
        // Collected rather than asserted row by row, and named below.
        if (held[N] === INHERITED) invented.push(label)
      }
      // ...and wherever the shell DID assign, the pair lands on the shell's own answer — except for
      // the value-divergence bucket above, which is named row by row after the loop.
      if (held[N] !== INHERITED) {
        if (assigns && parsed !== held[N]) valueDiverged.push(label)
        else expect(resolved, why).toBe(held[N])
      }
    }
    // The invent half, enumerated so it cannot grow unnoticed: these are the rows where the box
    // still names something the loop will not hold. Each is a pinned divergence of the grammar
    // (parse-config-var.js's `endOfWord`/`envPrefixedNothing` pair), not of `sourcedValue`, and the
    // old `||` was equally wrong about every one of them. IT USED TO HAVE SEVEN ENTRIES — the seven
    // `${N}= <word>` rows above — and the third review round moved all seven into the refusal, so
    // the only one left is the subshell tail, which no refusal can reach without also refusing the
    // six operator tails bash assigns on.
    expect(invented).toEqual(['a subshell tail'])
    // ...and the refusal is not vacuous, and no longer stops at the empty-quote words: it now fires
    // for every row of this family where bash runs a COMMAND, which is the rule it is written around.
    // Named rather than counted so widening it further — to `${N}= ` or `export ${N}= ""`, the two
    // rows bash really does BLANK with — is a red row rather than a silent change nobody reviewed.
    expect(refused).toEqual([
      'one space, double quotes',
      'one space, single quotes',
      'two spaces and a padded tail',
      'a tab',
      'a tab and single quotes',
      'mixed quote styles',
      'mixed the other way round',
      'three empty words glued together',
      'a comment glued to the closing quote',
      'a comment after a blank',
      'a comment after a tab',
      'a CRLF line ending',
      'a space indent',
      'a tab indent',
      'a word',
      'a quoted space',
      'quoted content',
      'two empty words with a blank between',
      'empty quotes glued to a word',
      'a quoted expansion of an unset name',
      'a line continuation',
      'a blank and a carriage return',
      'two blanks and a carriage return',
      'a tab and a carriage return',
      'a value, a blank and a carriage return',
      'a value, two blanks and a carriage return',
      'a blank and a Unicode line separator',
      'a quoted semicolon',
      'a single-quoted pipe',
      'an escaped ampersand',
      'a quoted redirection',
      'a bare word glued to a quoted semicolon',
      'a value and a quoted semicolon',
      // The two continuation rows where a WORD is already on the line, so the refusal is right
      // whatever the next line holds: an escaped backslash is a word, and so is `a`.
      'an escaped backslash where the continuation was',
      'a word and a trailing continuation',
    ])
    // ...and the value-divergence bucket, named. Every row is a line whose last character is a
    // backslash and which bash therefore reads together with the line after it: presence agrees with
    // the shell (that is what the sweep above asserts), and the value keeps the trailing backslash —
    // and, on `a quoted value and a trailing continuation`, THE QUOTE PAIR WITH IT. `${N}="v" \`
    // reads as `"v" \` rather than `v \`, because the unwrapping rule needs the pair to END the
    // value and this tail sits outside it, so nothing unwraps it; bash holds plain `v`. Presence
    // agreeing here is a property of this FAMILY, where every continuation joins a line with no
    // command word on it — a continuation whose NEXT line carries one diverges in presence too, and
    // lib/parse-config-var.js's `endOfWord` guard measures that row.
    // The seven rows are the whole of it, so a later widening — a divergence on a line with no
    // continuation on it — arrives here as a red row that names itself.
    expect(valueDiverged).toEqual([
      'a value and a trailing continuation',
      'a value, two blanks and a trailing continuation',
      'a value, a tab and a trailing continuation',
      'a continuation glued to the value',
      'a quoted value and a trailing continuation',
      'a blank and a trailing continuation',
      'an export and a trailing continuation',
    ])
  })

  it('a `#` where the blank goes no longer masks a value bash keeps either', async () => {
    // THIS WAS PINNED AS A DEFECT AND IS NOW THE FIX'S OWN PROPERTY — the two expectations below
    // were marked `WHEN FIXED` and this round is when. The pin's diagnosis is what did it:
    // `envPrefixedNothing` was spelled "a blank and then a word of empty quotes", but what makes a
    // line destroying is not the quotes, it is that BASH RUNS A COMMAND on the line, so its `NAME=`
    // is a prefix and nothing is assigned. The refusal is now written around that rule instead —
    // `endOfWord` walks the line the way the shell's tokenizer does and asks whether a command word
    // follows the assignment — so all eight spellings below are refused by the same predicate that
    // refuses `NAME= ""`, rather than by eight added cases. Measured, all three halves:
    //
    //   NAME=# off        bash: prefix `NAME=#`, command `off`  -> inherited value stands
    //   NAME=""#c off     bash: prefix `NAME=#c`,  command `off` -> inherited value stands
    //   NAME=""# c        bash: prefix `NAME=#`,   command `c`   -> inherited value stands
    //
    // Both expressions now agree with the shell on every row: the old `parseConfigVar(...) ||
    // processEnv[NAME]` was accidentally right about these (its '' fell through), and the presence
    // test is now right about them on purpose. What keeps this from being a fix drawn around eight
    // more spellings is the sweep in the test above and the 4,176-row one in parse-config-var.js:
    // neither found a line bash assigns that the refusal reaches.
    //
    // The `#` glued with NOTHING behind it (`NAME=#off`) is deliberately NOT in this table: bash
    // ASSIGNS `#off` there, so the parser's '' is a different divergence, pinned already in
    // lib/parse-config-var.boundary.qa.test.js's blank-tail table.
    for (const [label, line] of [
      ['a comment glued to the `=`, and a word', `${N}=# off`],
      ['a comment glued to a closing double quote, and a word', `${N}=""#c off`],
      ['a comment glued to a closing single quote, and a word', `${N}=''#c off`],
      ['a comment after empty quotes, and a word', `${N}=""# c`],
      // The remaining spellings of the same shape, found by sweeping every `#` tail this reader
      // strips against a real bash rather than by listing the ones that came to mind. All eight are
      // one class: the `#` reaches the parser's comment stripper, and the word behind it makes bash
      // treat the whole `NAME=...` as a prefix.
      ['a comment glued to the `=`, and empty quotes as the word', `${N}=# ""`],
      ['empty quotes inside the comment, and a word', `${N}=#"" off`],
      ['a comment glued to the `=`, and a tab before the word', `${N}=#${TAB}off`],
      ['a comment glued to the `=`, and a word, indented', `  ${N}=# off`],
    ]) {
      const text = cfg(line)
      const { held, stderr } = await loopEnv(text, { [N]: INHERITED })
      // The shell: it RAN a word, said so, and kept what it already held.
      expect(held[N], label).toBe(INHERITED)
      expect(stderr, label).toContain('command not found')
      // The readers, now agreeing with it.
      expect(parseConfigVar(text, N), label).toBe('')
      expect(configAssignsVar(text, N), label).toBe(false)
      const oldShape = parseConfigVar(text, N) || INHERITED
      const newShape = configAssignsVar(text, N) ? parseConfigVar(text, N) : INHERITED
      expect(oldShape, label).toBe(INHERITED)
      expect(newShape, label).toBe(INHERITED)
    }
  })

  it('and for TASK_SOURCE the launch that used to abort now follows the loop, one spelling over', async () => {
    // The round-1 reproduction with `#` in place of the blank, end to end through the real command,
    // and it now lands where block 5's row lands. THIS TEST USED TO ASSERT THE ABORT: `source` said
    // `github`, `gh auth status` ran, `folderCounts` was empty, and `startCommand` THREW on a machine
    // whose `gh` was not authenticated — for a loop about to read tasks out of `.ralph/tasks`. Each
    // of those four is inverted below, which is the cost of this spelling measured rather than
    // argued: not a misreported row, a refused launch.
    const config = cfg(`${SOURCE}=# off`)
    const ambient = { [SOURCE]: 'folder' }
    expect(await loopSource(config, ambient)).toBe('folder')

    const { d, result } = await run({ config, processEnv: ambient })
    expect(rowOf(d, 'source')).toBe('folder')
    expect(d.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)
    expect(d.exec.calls.some((c) => c.cmd === 'gh' && c.args[0] === 'label')).toBe(false)
    expect(d.folderCounts).toEqual([1])
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })

    // ...and the launch that used to be an abort, on the same inputs with a `gh` that is not
    // authenticated. The folder queue never asks `gh` anything, so an unauthenticated `gh` is
    // irrelevant to it and the loop starts. Asserted as a resolution, because the old behaviour was
    // a thrown `StartAbort` — `startCommand` throws rather than returning there, and bin/ralph.js is
    // what turns that into an exit code.
    const failing = deps({ config, processEnv: ambient })
    failing.exec = async (cmd, args = []) => {
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (cmd === 'gh' && args[0] === 'auth') return { exitCode: 1, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    await expect(startCommand(failing)).resolves.toEqual({ exitCode: 0, started: true, count: 3 })
    expect(failing.stderr.output()).not.toContain('gh not authenticated')
  })

  it('what widening the refusal actually cost, as the evidence rather than the sentence', () => {
    // THIS TEST USED TO JUSTIFY AN ASYMMETRY that no longer exists. It was written to check the
    // argument for leaving the invent half alone — three comments rested that half's survival on
    // `RALPH_DIGEST_INTERVAL=  2h  ` being a depended-upon spelling — and what it found instead was
    // that the only thing depending on it was a PINNED EXPECTATION. The review then widened the
    // refusal, so the same two facts now measure the cost rather than the justification, and the
    // third assertion is inverted: the pin flipped.
    const shipped = readFileSync(new URL('../../templates/ralph.config.sh', import.meta.url), 'utf8')
    expect(shipped).toContain('RALPH_DIGEST_INTERVAL=""')
    // No line of the shipped config is written with a blank after the `=` followed by a word, so the
    // widened refusal reaches no configuration this repo renders. Checked over every file directly
    // under templates/, not just the config one, because `ralph init` writes all of them — and
    // INCLUDING ralph.sh, which this parser never reads but which parse-config-var.js's note claims
    // this sweep covers. Excluding it would have made that note's "ralph.sh included" false.
    const templates = readdirSync(new URL('../../templates/', import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(new URL(`../../templates/${entry.name}`, import.meta.url), 'utf8'))
    const padded = [shipped, ...templates]
      .flatMap((text) => text.split(LF))
      .filter((line) => /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*=[ \t]+[^ \t#]/.test(line))
    expect(padded).toEqual([])
    // And what DID depend on it: the padded-interval pin, which now asserts the opposite. Read out
    // of the file so that flipping it back without revisiting this argument goes red here.
    const digestQa = readFileSync(new URL('./start.digest-window.qa.test.js', import.meta.url), 'utf8')
    expect(digestQa).toContain("'RALPH_DIGEST_INTERVAL=  2h  '")
    expect(digestQa).toContain('and so does a blank AFTER the `=`')
    expect(digestQa).not.toContain("it('still opens the window for the padded spellings")
  })
})
