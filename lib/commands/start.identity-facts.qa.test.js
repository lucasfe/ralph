// #69 QA — adversarial specs for the WIRING of the five identity facts into `ralph start`.
//
// start.identity-facts.test.js proves the intended matrix: the precedence, the four model
// answers, the source table, the repo row in github mode, and the three reads that pay for
// all of it. This file attacks the same wiring from outside that matrix, along the five seams
// that are this command's rather than the box's or the resolver's:
//
//   * THE READS CAN FAIL IN SHAPES A HAPPY PATH NEVER PRODUCES. `<cwd>/.git` is a FILE in a
//     worktree and in a submodule, so the read of `<cwd>/.git/config` fails with ENOTDIR
//     rather than ENOENT — a distinct errno on a path this command constructs by hand. The
//     metrics log is appended to with `>>` by a loop that can be killed mid-line. Both are
//     read best-effort, and neither may cost the launch or the rows beside it.
//   * THE ENVIRONMENT IS AMBIENT. `GH_REPO`, `RALPH_AGENT` and `RALPH_CODEX_MODEL` are
//     inherited from whatever shell, wrapper script or CI runner invoked this, so each of
//     them can be blank, a control byte, or not a string at all. The row must degrade to
//     nothing rather than to something wrong, and it must never put a byte on stdout that
//     forges a line.
//   * `RALPH_BANNER=off` IS A PROMISE ABOUT BYTES. #74's whole point is that a wrapper script
//     or a cron entry can turn the decoration off completely, and #69 added five rows and two
//     file reads to the thing being turned off. Not one byte, and the reads that were hoisted
//     for #60's projection still happen exactly once.
//   * THE WHOLE PIPELINE IS THE UNIT. The resolver's spec asserts what a log line resolves
//     to and the box's spec asserts what a fact prints as. Only here can a fact travel from a
//     log line all the way to a terminal — which is where the fractional-window row below is
//     visible as a thing a user can actually see.
//   * AND SINCE #120, A FIFTH: `GH_REPO` IS ALSO A LINE IN A COMMITTED FILE. The repo row used
//     to read one place (the process environment) and now reads two, at the loop's own
//     precedence — `ralph.config.sh` over the environment, because templates/ralph.sh sources
//     that file with `set -a`. That puts the bash-assignment grammar of lib/parse-config-var.js
//     in front of a row that had never seen it, and it moves the "a set-but-unparseable value
//     draws NO row rather than falling back to origin" asymmetry off an ambient variable and
//     onto a file where a typo is committed and lives forever. The last describe block below is
//     that seam: which spellings decide the row, which values are refused, and what a hostile
//     byte out of a tracked file can and cannot do to the frame.
//
// The harness is start.identity-facts.test.js's, deliberately: every seam is injected (#41),
// so nothing here depends on the developer's checkout — not their .git, not their .ralph, not
// their environment. Control bytes are spelled with `String.fromCharCode` (#107).

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { startCommand } from './start.js'
import { metricsPath } from '../issue-metrics.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const METRICS_PATH = metricsPath(REPO)
const CONFIG_PATH = resolve(REPO, 'ralph.config.sh')
const GIT_CONFIG_PATH = resolve(REPO, '.git', 'config')
const GITHUB = 'TASK_SOURCE=github\n'
const FOLDER = 'TASK_SOURCE=folder\n'
const MIN = 60000

const ESC = String.fromCharCode(27)
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const NUL = String.fromCharCode(0)
const C1_CSI = String.fromCharCode(0x9b)
const PLACEHOLDER = String.fromCharCode(0xfffd)
const LABEL_WIDTH = 8

const eventLine = (fields) => `RALPH_ISSUE_EVENT ${JSON.stringify(fields)}`
const HISTORY =
  [
    {
      issue_number: 29,
      run_id: 'ralph-a',
      ts: 1,
      duration_ms: 97 * MIN,
      total_cost_usd: 34.1,
      agent: 'claude',
      model: 'claude-sonnet-4',
      context_window: 200_000,
    },
    {
      issue_number: 30,
      run_id: 'ralph-b',
      ts: 2,
      duration_ms: 71 * MIN,
      total_cost_usd: 28.75,
      agent: 'claude',
      model: 'claude-opus-5',
      context_window: 1_000_000,
    },
  ]
    .map(eventLine)
    .join(LF) + LF

const GIT_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '[remote "origin"]',
  '\turl = git@github.com:lucasfe/ralph.git',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '',
].join(LF)

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
    lines: () => chunks.join('').split(LF).slice(0, -1),
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

const deps = ({
  config = FOLDER,
  metrics = '',
  gitConfig = GIT_CONFIG,
  queue = 3,
  exec,
  ...overrides
} = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const paths = { exists: [], readFile: [] }
  const value = (fixture) => (typeof fixture === 'function' ? fixture() : fixture)
  return {
    cwd: REPO,
    stdout,
    stderr,
    paths,
    exec: exec ?? makeExec(),
    exists: (p) => {
      paths.exists.push(String(p))
      return String(p).endsWith('ralph.config.sh') && config != null
    },
    readFile: (p) => {
      const path = String(p)
      paths.readFile.push(path)
      if (path.endsWith('ralph.config.sh')) return value(config)
      if (path.endsWith('issues.jsonl')) return value(metrics)
      if (path === GIT_CONFIG_PATH) return value(gitConfig)
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
    folderQueueCount: async () => queue,
    now: () => new Date(2026, 7, 25, 16, 4, 0).getTime(),
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

/** The box wherever it is, found by its own frame — nothing else here draws corners. */
const boxOf = (d) => {
  const lines = d.stdout.lines()
  const top = lines.findIndex((line) => line.startsWith('╭'))
  const bottom = lines.findIndex((line) => line.startsWith('╰'))
  return top === -1 || bottom < top ? [] : lines.slice(top, bottom + 1)
}

/** A row's value, frame and gutter removed — or undefined when the row is not drawn. */
const rowOf = (d, label) => {
  const row = boxOf(d).find((line) => stripAnsi(line).includes(`│ ${label}`))
  return row === undefined ? undefined : stripAnsi(row).slice(2, -2).trimEnd().slice(LABEL_WIDTH)
}

/**
 * A row's value in the BARE form, which has no frame to find it by.
 *
 * Matched on the eight-column gutter rather than on `includes`, so a label that happens to
 * appear inside another row's value cannot answer for it.
 */
const bareRowOf = (d, label) => {
  const row = d.stdout
    .lines()
    .map(stripAnsi)
    .find((line) => line.startsWith(label.padEnd(LABEL_WIDTH)))
  return row === undefined ? undefined : row.slice(LABEL_WIDTH).trimEnd()
}

/**
 * The banner's own lines, which is the block the width guarantee is about.
 *
 * By INDEX, because the banner is the first thing this command prints and because below 44
 * columns there is no frame to find it by — and deliberately NOT the whole stream: the
 * preflight notices under it (the WhatsApp hint, the queue count) are prose this box never
 * promised to clip.
 */
const bannerLinesOf = (d, height) => d.stdout.lines().slice(0, height)

const run = async (options) => {
  const d = deps(options)
  const result = await startCommand(d)
  return { d, result }
}

describe('QA #69 start — a window a user can see, out of a log a user can write', () => {
  it('draws no context row for a fractional window in the log', async () => {
    // END-TO-END REACHABILITY of the `0M tokens` row, which is the reason this test is here
    // rather than only in lib/banner-compose.model-rows.qa.test.js:
    //
    //   RALPH_CONTEXT_WINDOW=0.5 ralph start
    //
    // is accepted by lib/capture-issue-event.js — its guard is `Number.isFinite(cw) && cw > 0`
    // — so the run's event carries `"context_window":0.5`. lib/banner-model.js's
    // `positiveNumberOr` accepts it on the same terms and reports it as this run's window, and
    // the box floors it to 0, divides it exactly by a million and prints `context  0M tokens`:
    // a window no model has and nobody configured. A row the box worked out for itself is
    // exactly what the flooring comment above `windowTokens` says must never happen, and the
    // dev's own table pins `0` and `-1` as NO ROW — so this is that table's own rule, applied
    // to the one value that slips past the guard.
    for (const contextWindow of [0.5, 0.999, 1e-7]) {
      const metrics = eventLine({ ts: 3, agent: 'claude', model: 'claude-opus-5', context_window: contextWindow })
      const { d } = await run({ config: GITHUB, metrics: `${metrics}${LF}` })
      // The model is real evidence and its row stays; only the window is unknowable.
      expect(rowOf(d, 'agent'), String(contextWindow)).toBe('claude — claude-opus-5 (last run)')
      expect(rowOf(d, 'context'), String(contextWindow)).toBeUndefined()
      expect(d.stdout.output(), String(contextWindow)).not.toContain('0M tokens')
    }
  })

  it('reports a whole-number window from the log unchanged', async () => {
    // The other direction, so the test above cannot be satisfied by dropping the row
    // whenever an override was used: an odd but honest RALPH_CONTEXT_WINDOW prints as itself.
    for (const [contextWindow, expected] of [
      [1_000_000, '1M tokens'],
      [123_456, '123456 tokens'],
      [1, '1 tokens'],
      [7_500, '7500 tokens'],
    ]) {
      const metrics = eventLine({ ts: 3, agent: 'claude', model: 'm', context_window: contextWindow })
      const { d } = await run({ config: GITHUB, metrics: `${metrics}${LF}` })
      expect(rowOf(d, 'context'), String(contextWindow)).toBe(expected)
    }
  })

  it('starts, and claims nothing, on a log whose ONLY line was truncated', async () => {
    // The state a file appended to with `>>` is left in when the very first run of a repo was
    // killed mid-line: no older event to fall back to, and nothing salvageable from the
    // fragment. Asserted here rather than only in the resolver's spec because the SAME text is
    // read once and serves two consumers — the box, which must claim nothing, and #60's launch
    // projection at the bottom of the run, which must still print.
    const truncated = 'RALPH_ISSUE_EVENT {"agent":"claude","model":"claude-op'
    const { d, result } = await run({ config: GITHUB, metrics: truncated })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(rowOf(d, 'agent')).toBe('claude — model resolves at first run')
    expect(rowOf(d, 'context')).toBeUndefined()
    // ...and the ONE read that served both consumers still happened once. #60's projection
    // draws nothing here for the same reason the box does — there is no complete event in this
    // file to measure — which is the coupling this test is really about: one unusable log, two
    // features declining to guess.
    expect(d.paths.readFile.filter((p) => p.endsWith('issues.jsonl'))).toEqual([METRICS_PATH])
    expect(d.stdout.output()).not.toContain('Projection:')
  })

  it('reports the newest PARSEABLE event when the tail was truncated behind it', async () => {
    // The same file with history above the fragment, pinned as the deliberate reading it is:
    // an unparseable line is SKIPPED, so the row names the newest event that is actually an
    // event. Worth stating plainly, because there is a nuance a reader could mistake for a
    // defect — the truncated line belongs to a run this row is then not describing, so
    // `last run` means "the last run we have a complete record of". That is the same
    // discipline aggregateCycleCounts in lib/issue-metrics.js applies to the same lines, and
    // the alternative (no row at all whenever a log ends mid-write) would cost the row on
    // most real checkouts.
    const truncated = 'RALPH_ISSUE_EVENT {"agent":"claude","model":"claude-op'
    const { d } = await run({ config: GITHUB, metrics: `${HISTORY}${truncated}` })
    expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    expect(rowOf(d, 'context')).toBe('1M tokens')
    // ...and the other consumer of the same text got its two complete events too.
    expect(d.stdout.output()).toContain('Projection:')
  })

  it('sanitises a model id carrying control bytes, and forges no line with it', async () => {
    // The metrics log is a file this command does not write and does not read as bytes: a
    // foreign writer, a mangled pipe or a hand edit can put anything inside a JSON string.
    // The resolver hands it on untouched by design (that is the box's gate to apply), so this
    // is the assertion that the two halves actually meet on the way to a terminal.
    for (const byte of [ESC, LF, CR, C1_CSI, String.fromCharCode(0)]) {
      const metrics = eventLine({ ts: 3, agent: 'claude', model: `opus${byte}5` })
      const { d } = await run({ config: GITHUB, metrics: `${metrics}${LF}` })
      const label = byte.charCodeAt(0).toString()
      expect(rowOf(d, 'agent'), label).toBe(
        `claude — opus${PLACEHOLDER}5 (last run)`,
      )
      // Every row is inside the frame, and the box is still six sides of one box.
      const box = boxOf(d)
      expect(box.length, label).toBeGreaterThan(2)
      for (const line of box.slice(1, -1)) expect(line, label).toMatch(/^│ .* │$/)
      expect(box.filter((line) => line.startsWith('╭')), label).toHaveLength(1)
      // ...and no escape byte from the LOG reached the stream. The banner's own colour is off
      // here (no TTY), so any ESC on stdout came from the fact.
      expect(d.stdout.output(), label).not.toContain(ESC)
      expect(d.stdout.output(), label).not.toContain(C1_CSI)
    }
  })

  it('names no model for a log whose newest event belongs to another agent’s run', async () => {
    // The dev's spec covers a Codex event; these are the shapes a log picks up from a repo
    // that has been through several agents and several Ralph versions.
    for (const agent of ['codex', 'gemini', 'CLAUDE', 'claude-code']) {
      const metrics = `${HISTORY}${eventLine({ ts: 3, agent, model: 'not-ours' })}${LF}`
      const { d } = await run({ config: GITHUB, metrics })
      expect(rowOf(d, 'agent'), agent).toBe('claude — model resolves at first run')
      expect(d.stdout.output(), agent).not.toContain('not-ours')
    }
  })
})

describe('QA #69 start — the repo row degrades rather than guesses', () => {
  it('draws no repo row when .git is a FILE, as it is in a worktree', async () => {
    // A worktree and a submodule both have `<cwd>/.git` as a FILE holding `gitdir: …`, so the
    // read of `<cwd>/.git/config` fails with ENOTDIR — a different errno from the ENOENT of a
    // directory that is simply not a repository, on a path this command builds by hand. Both
    // must cost one row and nothing else.
    const enotdir = () => {
      const error = new Error("ENOTDIR: not a directory, open '/repo/.git/config'")
      error.code = 'ENOTDIR'
      throw error
    }
    for (const gitConfig of [enotdir, () => 'gitdir: /repo/.git/worktrees/feature\n', () => undefined]) {
      const { d, result } = await run({ config: GITHUB, gitConfig, metrics: HISTORY })
      expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(rowOf(d, 'repo')).toBeUndefined()
      // One unresolvable fact costs one row: the rows around it are all still there.
      expect(rowOf(d, 'source')).toBe('github')
      expect(rowOf(d, 'cwd')).toBe(REPO)
      expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    }
  })

  // GH_REPO as an environment can actually hand it over, and the row each value earns.
  const GH_REPOS = [
    ['gh’s host-prefixed spelling', 'github.com/someone/else', 'someone/else'],
    ['an enterprise host prefix', 'ghe.internal.example/someone/else', 'someone/else'],
    ['a .git suffix', 'someone/else.git', 'someone/else'],
    ['surrounding whitespace', '  someone/else  ', 'someone/else'],
    ['a trailing newline a script forgot to chomp', `someone/else${LF}`, 'someone/else'],
    // ...and everything that is not a slug gh could read an issue from. NOT the origin slug:
    // GH_REPO is what gh itself reads, so naming origin would name a repository the loop is
    // not about to use — which is the exact confusion this row was asked to end.
    ['four segments', 'a/b/c/d', undefined],
    ['one segment', 'ralph', undefined],
    ['a whole url', 'https://github.com/someone/else', undefined],
    ['an ssh url', 'git@github.com:someone/else.git', undefined],
    ['a relative path', '../else', undefined],
    ['a query string', 'someone/else?ref=main', undefined],
    ['an ESC sequence', `someone/else${ESC}[31m`, undefined],
    ['an embedded newline', `someone${LF}/else`, undefined],
    ['a forged row', `o/n${LF}│ repo    evil/repo`, undefined],
  ]

  for (const [label, ghRepo, expected] of GH_REPOS) {
    it(`draws ${JSON.stringify(expected)} for a GH_REPO with ${label}`, async () => {
      const { d, result } = await run({
        config: GITHUB,
        processEnv: { GH_REPO: ghRepo },
        metrics: HISTORY,
      })
      expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(rowOf(d, 'repo')).toBe(expected)
      // Whatever the value was, it did not become a line: exactly one box, every row inside
      // the frame, and no `evil/repo` row smuggled in under a real one.
      const box = boxOf(d)
      expect(box.filter((line) => line.startsWith('╰'))).toHaveLength(1)
      for (const line of box.slice(1, -1)) expect(line).toMatch(/^│ .* │$/)
      expect(box.filter((line) => stripAnsi(line).startsWith('│ repo')).length).toBeLessThanOrEqual(
        1,
      )
      expect(d.stdout.output()).not.toContain('evil/repo')
    })
  }

  it('reads .git/config for nothing in folder mode, even with GH_REPO set', async () => {
    // Folder mode reads no issues from a repository, so there is no repo row to draw and no
    // reason to touch the file — and a GH_REPO left over in the environment from another
    // checkout must not conjure one.
    const { d } = await run({
      config: FOLDER,
      processEnv: { GH_REPO: 'someone/else' },
      metrics: HISTORY,
    })
    expect(rowOf(d, 'repo')).toBeUndefined()
    expect(rowOf(d, 'source')).toBe('folder')
    expect(d.paths.readFile).not.toContain(GIT_CONFIG_PATH)
    expect(d.stdout.output()).not.toContain('someone/else')
  })

  it('keeps the row when the repo is resolvable but the metrics log is unreadable', async () => {
    // The two new reads are independent: a log that throws must not cost the repo row, and a
    // .git/config that throws must not cost the model row. Asserted both ways round, because
    // one try/catch around both reads would pass every test that varies only one of them.
    const throws = () => {
      throw new Error('EACCES')
    }
    const { d: noLog } = await run({ config: GITHUB, metrics: throws })
    expect(rowOf(noLog, 'repo')).toBe('lucasfe/ralph')
    expect(rowOf(noLog, 'agent')).toBe('claude — model resolves at first run')

    const { d: noGit } = await run({ config: GITHUB, gitConfig: throws, metrics: HISTORY })
    expect(rowOf(noGit, 'repo')).toBeUndefined()
    expect(rowOf(noGit, 'agent')).toBe('claude — claude-opus-5 (last run)')
  })

  it('keeps the launch when reading GH_REPO out of the environment is what throws', async () => {
    // THE ONE INPUT THE RESOLVER CANNOT DEFEND ITSELF AGAINST, exercised where the defence
    // actually lives. `resolveBannerRepo` type-checks every VALUE it is handed rather than
    // coercing it (lib/git-remote-slug.js's header says why, and #116 moved that grammar into
    // a module of its own), but the bag's fields are read by plain destructuring — so a
    // `GH_REPO` that is an ACCESSOR rather than a string runs somebody else's code before the
    // resolver sees anything, and the throw is not the resolver's to catch. What makes that
    // safe is this command: `bannerRepoSlug` builds the bag inside its own `try`, so the
    // failure costs the row and the row alone.
    //
    // Not hypothetical for a library consumer — `processEnv` is an injected seam, and a proxy
    // or a lazily-resolved config object is a perfectly ordinary thing to inject through it.
    // The assertion that matters is the last one: the loop still starts.
    let reads = 0
    const { d, result } = await run({
      config: GITHUB,
      metrics: HISTORY,
      processEnv: {
        get GH_REPO() {
          reads += 1
          throw new Error('the accessor ran')
        },
      },
    })
    // Counted, so the test cannot pass because nothing read the variable at all: a missing row
    // is what a missing READ looks like too, and only one of the two is what is being asserted.
    expect(reads).toBeGreaterThan(0)
    expect(rowOf(d, 'repo')).toBeUndefined()
    // Every other row of the box is untouched, including the one resolved from the OTHER file
    // read for it — the two reads are independent, as the test above this one asserts from the
    // other direction.
    expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    expect(rowOf(d, 'source')).toBe('github')
    expect(rowOf(d, 'cwd')).toBe(REPO)
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
  })
})

describe('QA #120 start — GH_REPO as a line in the file the loop sources', () => {
  // EVERY ROW BELOW RUNS WITH ALL THREE ANSWERS AVAILABLE, which is the only arrangement that
  // can tell this precedence apart from the two it could have been. There is an
  // `ambient/repo` in the environment and a real `origin` in `.git/config`, so a spelling
  // resolves to exactly one of:
  //
  //   the file's own value   the config assigned something readable, and it decides
  //   `ambient/repo`         the config assigned NOTHING, the one case bash falls through on
  //   `lucasfe/ralph`        the config assigned something BLANK, which masks the environment
  //                          in the sourcing shell and reads to `gh` as unset, so origin decides
  //
  // A table with only two of the three in it would let the third pass: an implementation that
  // read the file with a `||` is indistinguishable from the right one until a blank assignment
  // and an ambient value are present at the same time.
  const AMBIENT = { GH_REPO: 'ambient/repo' }
  const ORIGIN = 'lucasfe/ralph'
  const committed = (assignment) => `${GITHUB}${assignment}`

  // One spelling of the assignment, one row it earns. The grammar is lib/parse-config-var.js's
  // and its own specs pin what it reads out of a line; what is asserted here is that THIS row
  // now goes through it — the knob is new to that parser, so `export`, a quote pair, an inline
  // comment, a repeated key and a commented-out line all decide a repository for the first time.
  const SPELLINGS = [
    ['an `export` prefix', `export GH_REPO=committed/repo${LF}`, 'committed/repo'],
    ['a double-quoted value', `GH_REPO="committed/repo"${LF}`, 'committed/repo'],
    ['a single-quoted value', `GH_REPO='committed/repo'${LF}`, 'committed/repo'],
    ['an indented and padded `export`', `  export   GH_REPO=committed/repo  ${LF}`, 'committed/repo'],
    // The single most likely hand edit to this file: keep the value, add the note.
    ['an inline comment after the value', `GH_REPO=committed/repo # the fork we file against${LF}`, 'committed/repo'],
    ['an inline comment after a quoted value', `GH_REPO="committed/repo" # the fork${LF}`, 'committed/repo'],
    ['CRLF line endings', `GH_REPO=committed/repo${CR}${LF}`, 'committed/repo'],
    // Repeated keys, both directions. bash reads the last assignment, and a whole line
    // commented out is not an assignment at all — so the live line above it still stands.
    ['a repeated assignment', `GH_REPO=first/one${LF}GH_REPO=second/two${LF}`, 'second/two'],
    ['a repeat whose second line is commented out', `GH_REPO=first/one${LF}# GH_REPO=second/two${LF}`, 'first/one'],
    // Commented out entirely: not an assignment, so the environment is reached exactly as it
    // is on every project that never heard of this knob.
    ['the whole line commented out', `# GH_REPO=committed/repo${LF}`, 'ambient/repo'],
    ['a comment with no space after the hash', `#GH_REPO=committed/repo${LF}`, 'ambient/repo'],
    // The name has to END at the `=`, or a neighbouring knob would answer for this row.
    ['a longer name that merely starts with GH_REPO', `GH_REPOSITORY=committed/repo${LF}`, 'ambient/repo'],
    ['a name with a suffix after an underscore', `GH_REPO_FALLBACK=committed/repo${LF}`, 'ambient/repo'],
    // ...and the four ways a committed file says "blank", every one of which MASKS the
    // environment in the sourcing shell and therefore hands the row to origin. This is the
    // half a `||` gets backwards, and the half that is only visible with an ambient value set.
    ['a bare `=` with nothing after it', `GH_REPO=${LF}`, ORIGIN],
    ['an empty single-quoted value', `GH_REPO=''${LF}`, ORIGIN],
    ['a value that is only whitespace', `GH_REPO="   "${LF}`, ORIGIN],
    ['a blank assignment with a note after it', `GH_REPO= # not this checkout${LF}`, ORIGIN],
    // `VAR=#off` is how a user comments the VALUE out while keeping the line, and this parser
    // reads it as blank where bash would keep `#off` as data. Both answers land on the same
    // row here, which is worth having as a row: `#off` is not a slug either, so `gh` would
    // resolve origin too, and the divergence lib/parse-config-var.js documents costs nothing
    // on this knob.
    ['a value commented out in place', `GH_REPO=#off${LF}`, ORIGIN],
  ]

  for (const [label, assignment, expected] of SPELLINGS) {
    it(`draws ${JSON.stringify(expected)} for a config GH_REPO with ${label}`, async () => {
      const { d, result } = await run({
        config: committed(assignment),
        processEnv: { ...AMBIENT },
        metrics: HISTORY,
      })
      expect(result, label).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(rowOf(d, 'repo'), label).toBe(expected)
      // Whatever it read, it read it into ONE row inside the frame.
      expect(boxOf(d).filter((line) => stripAnsi(line).startsWith('│ repo')), label).toHaveLength(1)
    })
  }

  it('reads the two spellings bash assigns nothing for exactly as the loop does (#147)', async () => {
    // THE PLACE THIS ROW USED TO OUTRUN THE LOOP, and it no longer does. #120 is what made
    // both shapes reachable on this knob, and this test was written then to pin the
    // disagreement and go red the day the shared grammar caught up (#147). It has.
    //
    // Neither shape is this call site's: lib/parse-config-var.js owns them, records the
    // transcripts above `assignmentHead`, and lib/parse-config-var.qa.test.js measures both
    // against a real bash. Both were already true of RALPH_AGENT when #118 gave it this same
    // present-or-absent shape; what made them worth fixing here is that this row's contract is
    // stricter than that knob's — naming a repository the loop is NOT about to read is the one
    // answer lib/git-remote-slug.js says it may never give.
    //
    // Measured, so the AGREEMENT is a record and not a guess:
    //
    //   $ printf 'GH_REPO = committed/repo\n' > c.sh
    //   $ GH_REPO=ambient/repo bash -c 'set -a; . ./c.sh; set +a; printf "[%s]" "$GH_REPO"'
    //   c.sh: line 1: GH_REPO: command not found
    //   [ambient/repo]
    //
    //   $ printf 'GH_REPO=committed/repo\nGH_REPO=\n' > c.sh
    //   $ GH_REPO=ambient/repo bash -c 'set -a; . ./c.sh; set +a; printf "[%s]" "$GH_REPO"'
    //   []
    //
    // So the loop reads `ambient/repo` for the first and a masked blank for the second, and
    // this row now reads the same two things: `configAssignsVar` says NO to a line the shell
    // runs as a command, which sends the row to the environment, and the bare `=` of the second
    // is the last assignment and blanks the live line above it — which reads to `gh` as unset
    // and hands the row to origin. Both are the table's own third and second outcomes,
    // reached for the first time by these two spellings.
    for (const [assignment, expected] of [
      [`GH_REPO = committed/repo${LF}`, 'ambient/repo'],
      [`GH_REPO=committed/repo${LF}GH_REPO=${LF}`, ORIGIN],
    ]) {
      const { d, result } = await run({
        config: committed(assignment),
        processEnv: { ...AMBIENT },
        metrics: HISTORY,
      })
      expect(result, assignment).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(rowOf(d, 'repo'), assignment).toBe(expected)
      // Neither run may leave the value the file spelled anywhere on screen: it is a slug the
      // loop is not about to use, which is the failure this whole row exists to prevent.
      expect(d.stdout.output(), assignment).not.toContain('committed/repo')
    }
  })

  it('resolves `TASK_SOURCE = folder` to the source the loop resolves (#147)', async () => {
    // CRITERION 5 at the command, and the reason #147 was not merely a tidy-up: a space before
    // the `=` on THIS knob is not a cosmetic divergence, it is `ralph start` announcing one
    // work queue and launching a loop that reads another. templates/ralph.sh sources the file,
    // sees no assignment, and dispatches github (its own dispatch block is run against this
    // very line in lib/parse-config-var.qa.test.js's #147 block); this command used to print
    // `folder`.
    //
    // Asserted through the whole command rather than through the resolver, because the row on
    // screen is the artefact a user compares against the run — and in folder mode the box also
    // DROPS the repo row, so the old reading changed the shape of the box and not just a word
    // in it.
    const { d, result } = await run({
      config: `TASK_SOURCE = folder${LF}`,
      processEnv: { ...AMBIENT },
      metrics: HISTORY,
    })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(rowOf(d, 'source')).toBe('github')
    // github mode, so the repo row is back — from the environment, which is what the loop is
    // holding for this config.
    expect(rowOf(d, 'repo')).toBe('ambient/repo')
    // ...and the spelling bash DOES assign still reaches folder, so this is a tightening of
    // the grammar and not a refusal of the setting.
    const { d: assigned } = await run({
      config: FOLDER,
      processEnv: { ...AMBIENT },
      metrics: HISTORY,
    })
    expect(rowOf(assigned, 'source')).toBe('folder')
  })

  // A value the file DID assign and this grammar cannot reduce to `owner/name`. The contract is
  // an asymmetry, and #120 is what moved it onto a committed file: a set-but-unparseable value
  // draws NO row, never origin's and never the environment's, because a repository the loop is
  // not about to read is worse on screen than no repository at all. It matters more here than it
  // did on an ambient variable — a shell typo dies with the shell, and this one is committed.
  const NOT_A_SLUG = [
    // gh's own `[HOST/]OWNER/REPO` spellings first, which ARE readable: three segments means a
    // host was given and is dropped. A committed config is exactly where the long form gets
    // written, so these two are the rows that stop the refusals below from being a blanket no.
    ['gh’s host-prefixed spelling', 'GH_REPO=github.com/committed/repo', 'committed/repo'],
    ['an enterprise host prefix', 'GH_REPO=ghe.internal.example/committed/repo', 'committed/repo'],
    ['a .git suffix', 'GH_REPO=committed/repo.git', 'committed/repo'],
    // ...and everything a typo, a paste or a half-remembered format leaves behind.
    ['one segment', 'GH_REPO=committed', undefined],
    ['four segments', 'GH_REPO=a/b/c/d', undefined],
    // `GH_REPO=committed/re po` USED TO BE A ROW HERE and is not a member of this family at all:
    // bash never assigns it, so there is no "value the file set" to refuse. It has a test of its
    // own below. The quoted spelling stays, and it is what keeps this list from being a rule about
    // spaces — bash assigns that one, and the refusal is then the grammar's own judgement.
    ['a space inside a quote pair', 'GH_REPO="committed/re po"', undefined],
    ['a bare relative step', 'GH_REPO=..', undefined],
    ['a relative path', 'GH_REPO=../else', undefined],
    ['a relative step as the name', 'GH_REPO=committed/..', undefined],
    ['a whole https url', 'GH_REPO=https://github.com/committed/repo', undefined],
    ['an ssh url', 'GH_REPO=git@github.com:committed/repo.git', undefined],
    // The two shapes only a SHELL file produces, and the reason this row cannot simply trust a
    // text parse: nothing here expands anything. The loop's `gh` would see the expansion, this
    // box sees the source, and refusing it is the safe direction — a missing row costs a line
    // of decoration, a row reading `$OWNER/repo` would be a row about the file's bytes.
    ['an unexpanded variable', 'GH_REPO=$OWNER/repo', undefined],
    ['an unexpanded command substitution', 'GH_REPO=$(cat .repo)', undefined],
  ]

  for (const [label, assignment, expected] of NOT_A_SLUG) {
    it(`draws ${JSON.stringify(expected)} for a config GH_REPO holding ${label}`, async () => {
      const { d, result } = await run({
        config: committed(`${assignment}${LF}`),
        processEnv: { ...AMBIENT },
        metrics: HISTORY,
      })
      expect(result, label).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(rowOf(d, 'repo'), label).toBe(expected)
      // NEITHER fallback, which is the whole asymmetry: a value the file set is the answer or
      // there is no answer. Both alternatives would name a repository this run will not use.
      expect(d.stdout.output(), label).not.toContain(ORIGIN)
      expect(d.stdout.output(), label).not.toContain('ambient/repo')
      // ...and the rows either side of it are untouched: one unreadable fact costs one row.
      expect(rowOf(d, 'source'), label).toBe('github')
      expect(rowOf(d, 'agent'), label).toBe('claude — claude-opus-5 (last run)')
    })
  }

  it('draws the ENVIRONMENT’s repo for an unquoted space, because the file never assigned one', async () => {
    // THE ROW THAT LEFT THE LIST ABOVE, and the reason it left. `GH_REPO=committed/re po` looks
    // like the unparseable-value case and is not one: an unquoted blank makes the `GH_REPO=` an
    // environment prefix to the word after it, so bash runs `po` as a command and the sourcing
    // shell keeps whatever it inherited —
    //
    //   $ printf 'GH_REPO=committed/re po\n' > r.sh
    //   $ GH_REPO=ambient/repo bash -c 'set -a; . ./r.sh; set +a; printf "[%s]" "$GH_REPO"'
    //   ./r.sh: line 1: po: command not found
    //   [ambient/repo]
    //
    // The asymmetry above is about a value the file SET; there is none here, so the box falls
    // through to the environment exactly as the loop does. Before the #149 review this drew no row
    // at all, which was the box disagreeing with the loop about a committed line.
    const { d, result } = await run({
      config: committed(`GH_REPO=committed/re po${LF}`),
      processEnv: { ...AMBIENT },
      metrics: HISTORY,
    })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(rowOf(d, 'repo')).toBe('ambient/repo')
    // ...and the QUOTED spelling of the same value is still the asymmetry, on the same run shape:
    // bash assigns it, the grammar cannot reduce it to `owner/name`, and no row is drawn.
    const quoted = await run({
      config: committed(`GH_REPO="committed/re po"${LF}`),
      processEnv: { ...AMBIENT },
      metrics: HISTORY,
    })
    expect(rowOf(quoted.d, 'repo')).toBeUndefined()
    expect(quoted.d.stdout.output()).not.toContain('ambient/repo')
  })

  // A committed file is a more dangerous source of bytes than an environment, not a safer one:
  // it is written once and read on every start, it can hold a line break where a variable
  // cannot, and nobody re-reads it. Each row is a value carrying something that would be a
  // second line or an instruction to the terminal if it reached the frame.
  const HOSTILE = [
    ['an ESC sequence', `GH_REPO=committed/repo${ESC}[31m${LF}`, undefined],
    ['an ESC sequence inside a quote pair', `GH_REPO="committed/repo${ESC}[31m"${LF}`, undefined],
    ['a C1 CSI byte', `GH_REPO=committed/repo${C1_CSI}31m${LF}`, undefined],
    ['a NUL byte', `GH_REPO=committed/repo${NUL}${LF}`, undefined],
    // The line break a variable cannot carry and a FILE can. The parser is line-based, so the
    // forged row is simply not part of the assignment — the row reads the real value and the
    // next line is not an assignment of anything.
    ['a forged row on the line below', `GH_REPO=committed/repo${LF}│ repo    evil/repo${LF}`, 'committed/repo'],
    // ...and the same forgery attempted as a value that CONTINUES past the newline, which is
    // the multi-line value lib/parse-config-var.js declines to model: it reads the unterminated
    // `"committed/repo`, whose quote is not a slug character, so the row goes rather than
    // arriving forged. bash would refuse the whole file as a syntax error unless a later line
    // closed the pair — either way, no `evil/repo`.
    ['a value continued on the next line', `GH_REPO="committed/repo${LF}│ repo    evil/repo"${LF}`, undefined],
  ]

  for (const [label, assignment, expected] of HOSTILE) {
    it(`forges no line for a config GH_REPO with ${label}`, async () => {
      const { d, result } = await run({
        config: committed(assignment),
        processEnv: { ...AMBIENT },
        metrics: HISTORY,
      })
      expect(result, label).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(rowOf(d, 'repo'), label).toBe(expected)
      // The COMPOSED output, not just the resolved slug: one box, every row inside the frame,
      // at most one `repo` row, and no byte the file wrote reaching the stream as an
      // instruction. The banner's own colour is off here (no TTY), so any ESC on stdout came
      // from the fact.
      const box = boxOf(d)
      expect(box.filter((line) => line.startsWith('╭')), label).toHaveLength(1)
      expect(box.filter((line) => line.startsWith('╰')), label).toHaveLength(1)
      for (const line of box.slice(1, -1)) expect(line, label).toMatch(/^│ .* │$/)
      expect(box.filter((line) => stripAnsi(line).startsWith('│ repo')).length, label).toBeLessThanOrEqual(1)
      for (const byte of [ESC, C1_CSI, NUL]) {
        expect(d.stdout.output(), `${label} @ ${byte.charCodeAt(0)}`).not.toContain(byte)
      }
      expect(d.stdout.output(), label).not.toContain('evil/repo')
    })
  }

  it('draws no repo row in folder mode, however the config spells GH_REPO', async () => {
    // The github gate is above the read and #120 did not move it: a folder run reads issues
    // from no repository, so a committed GH_REPO — the value a project that switched task
    // sources is most likely to have left behind in the file — conjures no row and costs no
    // read. The dev's spec covers a GH_REPO in the ENVIRONMENT here; a line in the file is the
    // one the switch leaves behind.
    for (const assignment of [`GH_REPO=committed/repo${LF}`, `export GH_REPO="committed/repo"${LF}`]) {
      const { d } = await run({
        config: `${FOLDER}${assignment}`,
        processEnv: { ...AMBIENT },
        metrics: HISTORY,
      })
      expect(rowOf(d, 'repo'), assignment).toBeUndefined()
      expect(rowOf(d, 'source'), assignment).toBe('folder')
      expect(d.paths.readFile, assignment).not.toContain(GIT_CONFIG_PATH)
      expect(d.stdout.output(), assignment).not.toContain('committed/repo')
    }
  })

  it('reads no .git/config and prints no slug with the banner off', async () => {
    // #74's promise, re-asserted for the one thing #120 changed about it: the file the mode
    // itself came out of now also holds the repo. Both reads of it stay where they were — one
    // read of ralph.config.sh, no read of .git/config — and not one byte of a slug reaches the
    // stream, from the file OR the environment.
    const { d, result } = await run({
      config: committed(`GH_REPO=committed/repo${LF}`),
      processEnv: { ...AMBIENT, RALPH_BANNER: 'off' },
      metrics: HISTORY,
    })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(boxOf(d)).toEqual([])
    expect(d.paths.readFile).not.toContain(GIT_CONFIG_PATH)
    expect(d.paths.readFile.filter((p) => p === CONFIG_PATH)).toEqual([CONFIG_PATH])
    for (const forbidden of ['committed/repo', 'ambient/repo', ORIGIN]) {
      expect(d.stdout.output(), forbidden).not.toContain(forbidden)
    }
    // ...and the run below the silenced banner is unchanged.
    expect(d.stdout.output()).toContain('Projection:')
  })

  it('costs the launch no read and no spawn it was not already making', async () => {
    // THE PRICE OF THE PRECEDENCE IS ZERO, which is the claim that makes it affordable in front
    // of the first paint. `configText` was already read once at the top of `startCommand` for
    // six other values, so this row is a parse of text the command is holding — not a second
    // open of the same file, not a `git remote get-url`, and not the `gh repo view` that would
    // put a GraphQL round trip in front of the box.
    const exec = makeExec()
    const { d } = await run({
      config: committed(`GH_REPO=committed/repo${LF}`),
      processEnv: { ...AMBIENT },
      metrics: HISTORY,
      exec,
    })
    expect(rowOf(d, 'repo')).toBe('committed/repo')
    expect(d.paths.readFile.slice(0, 3)).toEqual([CONFIG_PATH, METRICS_PATH, GIT_CONFIG_PATH])
    expect(d.paths.readFile.filter((p) => p === CONFIG_PATH)).toEqual([CONFIG_PATH])
    expect(d.paths.exists.filter((p) => p.endsWith('ralph.config.sh'))).toEqual([CONFIG_PATH])
    for (const call of exec.calls) {
      expect(call.key).not.toContain('repo view')
      expect(call.key).not.toContain('remote')
    }
  })

  it('never reads the environment’s GH_REPO once the file has answered', async () => {
    // THE SHORT CIRCUIT, asserted as one. The existing spec above drives a THROWING accessor
    // with no config assignment and counts the reads to prove the variable was reached at all;
    // this is the other half of that seam, and it is the half #120 created: with the file
    // holding an answer, `??` must never evaluate its right-hand side, so somebody else's
    // getter never runs. A count of zero is the only way to see that — an implementation that
    // read the environment first and preferred the config afterwards would give the same ROW.
    const accessor = () => {
      let reads = 0
      return {
        env: {
          get GH_REPO() {
            reads += 1
            throw new Error('the accessor ran')
          },
        },
        reads: () => reads,
      }
    }

    // A readable value: the file decides, and the environment is not even touched.
    const set = accessor()
    const { d, result } = await run({
      config: committed(`GH_REPO=committed/repo${LF}`),
      processEnv: set.env,
      metrics: HISTORY,
    })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(set.reads()).toBe(0)
    expect(rowOf(d, 'repo')).toBe('committed/repo')

    // ...and a BLANK one, which is the case a `||` would have fallen through on and where the
    // throw would then have cost the row. '' is not nullish, so the accessor stays unrun and
    // origin answers — exactly what the loop's `gh` does with an exported-but-empty variable.
    const blanked = accessor()
    const { d: blank } = await run({
      config: committed(`GH_REPO=""${LF}`),
      processEnv: blanked.env,
      metrics: HISTORY,
    })
    expect(blanked.reads()).toBe(0)
    expect(rowOf(blank, 'repo')).toBe(ORIGIN)
  })

  // The config text is read best-effort at the top of the command and every failure of that
  // read is already '' — so the row must land on the ENVIRONMENT for all of them, which is the
  // same answer as "the file assigned nothing". Driven through the seam rather than asserted of
  // `readConfigText`, because the new code path is the one that has to survive a '' it never
  // asked about: `configAssignsVar('', 'GH_REPO')` is the guard, and a truthiness slip there
  // would drop the environment on every project with no config file at all.
  const UNREADABLE = [
    ['a config read that throws', () => { throw new Error('EACCES') }, 'ambient/repo'],
    ['a config read that returns null', () => null, 'ambient/repo'],
    ['a config read that returns a number', () => 42, 'ambient/repo'],
    ['no ralph.config.sh at all', null, 'ambient/repo'],
    // A Buffer is what an fs hands back without an encoding, and it still carries the
    // assignment: `readConfigText` stringifies it, so the file's value decides as usual.
    ['a config read that returns a Buffer', () => Buffer.from(`${GITHUB}GH_REPO=committed/repo${LF}`), 'committed/repo'],
  ]

  for (const [label, config, expected] of UNREADABLE) {
    it(`draws ${JSON.stringify(expected)} for ${label}`, async () => {
      const { d, result } = await run({ config, processEnv: { ...AMBIENT }, metrics: HISTORY })
      expect(result, label).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(rowOf(d, 'repo'), label).toBe(expected)
      // The source row is the proof the text really was unusable rather than merely quiet:
      // TASK_SOURCE went with it and the github default is what is left.
      expect(rowOf(d, 'source'), label).toBe('github')
    })
  }

  it('draws no row when the file blanks GH_REPO and origin cannot be read either', async () => {
    // The composite the two halves of this precedence make together, and the one only #120 can
    // reach: the file masks the environment, so the answer is origin's — and origin is a read
    // that fails. Two degradations in a row must still cost exactly one row.
    const { d, result } = await run({
      config: committed(`GH_REPO=""${LF}`),
      gitConfig: () => {
        throw new Error('EACCES')
      },
      processEnv: { ...AMBIENT },
      metrics: HISTORY,
    })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(rowOf(d, 'repo')).toBeUndefined()
    // Not the environment's, which is the whole point of the mask, and not a forged frame.
    expect(d.stdout.output()).not.toContain('ambient/repo')
    expect(rowOf(d, 'source')).toBe('github')
    expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    for (const line of boxOf(d).slice(1, -1)) expect(line).toMatch(/^│ .* │$/)
  })
})

describe('QA #69 start — the environment is ambient, the config is the loop’s', () => {
  it('takes RALPH_CODEX_MODEL from the environment when only the agent is configured', async () => {
    // The mixed case the precedence rule does not obviously cover: the file names the agent
    // and says nothing about the model, so the model comes from the environment the loop will
    // inherit — the same value templates/ralph.sh would pass on the command line.
    const { d } = await run({
      config: `${FOLDER}RALPH_AGENT=codex\n`,
      processEnv: { RALPH_CODEX_MODEL: 'gpt-5-codex' },
      metrics: HISTORY,
    })
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
    expect(rowOf(d, 'context')).toBe('400k tokens')
  })

  it('trims padding after a configured model, and reads nothing off a blank before it', async () => {
    // RALPH_CODEX_MODEL is a value people edit by hand in a shell file, where a trailing
    // space is invisible — and where a quoted empty value is a real thing to leave behind.
    //
    // THE SECOND ROW USED TO EXPECT THE MODEL and now expects no model at all (#149 review). A
    // blank AFTER the `=` is not padding: `RALPH_CODEX_MODEL= gpt-5-codex` is bash's
    // environment-prefix syntax, so the sourcing shell runs `gpt-5-codex` as a command and
    // assigns nothing —
    //
    //   $ printf 'RALPH_CODEX_MODEL= gpt-5-codex\n' > m.sh
    //   $ bash -c 'set -a; . ./m.sh; set +a; printf "[%s]" "${RALPH_CODEX_MODEL-«unset»}"'
    //   ./m.sh: line 1: gpt-5-codex: command not found
    //   [«unset»]
    //
    // — and there is no environment here for the row to fall back to, so the box says what a run
    // passing no `--model` really does. The FIRST row is the padding bash does drop, and it is
    // what keeps this about words rather than about whitespace.
    for (const [assigned, expected] of [
      ['gpt-5-codex ', 'codex — gpt-5-codex (configured)'],
      [' gpt-5-codex', 'codex — model resolves at first run'],
      ['""', 'codex — model resolves at first run'],
      ["''", 'codex — model resolves at first run'],
    ]) {
      const { d } = await run({
        config: `${FOLDER}RALPH_AGENT=codex\nRALPH_CODEX_MODEL=${assigned}\n`,
        metrics: HISTORY,
      })
      expect(rowOf(d, 'agent'), JSON.stringify(assigned)).toBe(expected)
    }
  })

  it('sanitises a hostile RALPH_CODEX_MODEL rather than obeying it', async () => {
    // The Codex model is the one model id that reaches the box from an environment variable
    // instead of from a log, so it is the one a wrapper script can set to anything.
    const { d } = await run({
      config: `${FOLDER}RALPH_AGENT=codex\n`,
      processEnv: { RALPH_CODEX_MODEL: `gpt${ESC}[31m5` },
      metrics: HISTORY,
    })
    expect(rowOf(d, 'agent')).toContain(PLACEHOLDER)
    expect(d.stdout.output()).not.toContain(ESC)
    for (const line of boxOf(d).slice(1, -1)) expect(line).toMatch(/^│ .* │$/)
  })

  it('names the agent that will RUN, for every spelling of RALPH_AGENT', async () => {
    // `resolveAgent` trims, lowercases, and warns-and-falls-back rather than aborting an
    // unattended run — so the row reports what is ABOUT TO RUN rather than what was typed, in
    // both directions:
    //
    //   a typo, a control byte, a blank    →  claude, and the log's model is its evidence
    //   a case or padding variant of codex →  codex, whose model comes from a knob that is
    //                                         not set here, so it promises nothing
    //
    // The second half is what makes this more than a fallback test: a row that reported the
    // RAW value would name `CODEX` and then read the log for a Claude model, which is the
    // over-confident row the provenance tag exists to prevent.
    for (const [RALPH_AGENT, expected] of [
      ['codx', 'claude — claude-opus-5 (last run)'],
      ['claude-code', 'claude — claude-opus-5 (last run)'],
      ['gemini', 'claude — claude-opus-5 (last run)'],
      [`codex${ESC}[31m`, 'claude — claude-opus-5 (last run)'],
      ['', 'claude — claude-opus-5 (last run)'],
      ['   ', 'claude — claude-opus-5 (last run)'],
      [`claude${LF}`, 'claude — claude-opus-5 (last run)'],
      ['CODEX', 'codex — model resolves at first run'],
      [' codex ', 'codex — model resolves at first run'],
      ['Codex', 'codex — model resolves at first run'],
    ]) {
      const { d } = await run({ config: GITHUB, processEnv: { RALPH_AGENT }, metrics: HISTORY })
      const label = JSON.stringify(RALPH_AGENT)
      expect(rowOf(d, 'agent'), label).toBe(expected)
      // ...and whichever way it resolved, no byte of the raw value reached the stream.
      expect(d.stdout.output(), label).not.toContain(ESC)
    }
  })
})

describe('QA #69 start — the rows the frame does not fit, and the ones nobody asked for', () => {
  it('prints not one byte of any of it when RALPH_BANNER is off', async () => {
    // #74's promise, re-asserted for #69's five rows and its two new reads: a wrapper script
    // or a cron entry that turned the decoration off must not get a model id, a repo slug or
    // a frame glyph — from a log full of history, a real origin remote, and a GH_REPO set.
    const { d, result } = await run({
      config: GITHUB,
      processEnv: { RALPH_BANNER: 'off', GH_REPO: 'someone/else' },
      metrics: HISTORY,
    })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    const output = d.stdout.output()
    for (const forbidden of [
      '╭',
      '│',
      '╰',
      'claude-opus-5',
      'last run',
      '1M tokens',
      'someone/else',
      'lucasfe/ralph',
      'model resolves at first run',
    ]) {
      expect(output, forbidden).not.toContain(forbidden)
    }
  })

  it('still reads the metrics log exactly once with the banner off', async () => {
    // The read is HOISTED above the banner and shared with #60's launch projection, so
    // turning the banner off does not turn the read off — and it must not turn it into two
    // either. The projection at the bottom of the run is the proof the text still arrived.
    const { d } = await run({
      config: GITHUB,
      processEnv: { RALPH_BANNER: 'off' },
      metrics: HISTORY,
    })
    expect(d.paths.readFile.filter((p) => p.endsWith('issues.jsonl'))).toEqual([METRICS_PATH])
    expect(d.stdout.output()).toContain('Projection:')
  })

  it('carries all five rows into the bare form on a narrow terminal', async () => {
    // Below 44 columns there is no frame, and #69's rows are the ones most likely to be
    // treated as decoration a narrow terminal can do without. They are not: "which agent,
    // which model, which repo" is exactly what a reader on a 26-column pane is checking.
    for (const columns of [43, 30, 26]) {
      const { d } = await run({ config: GITHUB, columns, metrics: HISTORY })
      expect(boxOf(d), String(columns)).toEqual([])
      for (const label of ['agent', 'context', 'cwd', 'source', 'repo']) {
        expect(bareRowOf(d, label), `${label} @ ${columns}`).toBeDefined()
      }
      // Clipped to the columns the caller reported, never wrapped — one fact, one line. The
      // banner is the FIRST thing this command prints, so it is the first six lines: a title
      // and #69's five rows (this fixture has no update, no cache verdict and no changelog).
      for (const line of bannerLinesOf(d, 1 + 5)) {
        expect([...stripAnsi(line)].length, `${columns}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
          columns,
        )
      }
    }
  })

  it('holds a narrow terminal even when every new fact is hostile', async () => {
    // The clip and the control-byte gate are the two mechanisms that decide what a line is,
    // and this is the one place they both run on a value that came out of a file: a model id
    // with an ESC in it, on a terminal too narrow for the row it belongs to.
    const metrics = eventLine({ ts: 3, agent: 'claude', model: `opus${ESC}[31m-5-very-long-id` })
    for (const columns of [43, 26, 12, 1]) {
      const { d, result } = await run({
        config: GITHUB,
        columns,
        metrics: `${metrics}${LF}`,
        processEnv: { GH_REPO: `o/n${LF}` },
      })
      expect(result, String(columns)).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(d.stdout.output(), String(columns)).not.toContain(ESC)
      // A title and four rows this time: the event carries a model but no window, so there is
      // no `context` row to draw.
      for (const line of bannerLinesOf(d, 1 + 4)) {
        expect([...stripAnsi(line)].length, `${columns}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
          columns,
        )
      }
    }
  })

  it('adds no field to the event it reads — criterion 9, through the writer’s own vocabulary', async () => {
    // #69 READS the metrics log and writes nothing to it, so none of its five facts may have
    // become an event field on the way past. Asserted against the LOG the command was handed:
    // a run that read this text and then appended to it would show up as a write, and a
    // feature that had quietly grown a field would show up in the vocabulary below.
    const { d } = await run({ config: GITHUB, metrics: HISTORY })
    const written = d.paths.readFile.filter((p) => p.endsWith('issues.jsonl'))
    expect(written).toEqual([METRICS_PATH])
    for (const word of ['provenance', 'last-run', 'configured', 'banner', 'repo', 'source']) {
      expect(HISTORY, word).not.toContain(word)
    }
  })
})
