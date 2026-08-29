// #69 — the agent, its model, the context window, the task source and the repo, wired
// into `ralph start`'s identity box.
//
// The box's WORDING is lib/banner-rows.test.js's business and the RESOLUTION rules belong
// to a spec each: lib/banner-model.test.js for the model and its provenance, and
// lib/git-remote-slug.test.js for the slug (#116 gave that grammar a module of its own). What
// is asserted here is everything that is this command's, and all of it is about where a fact
// comes from rather than about how it reads:
//
//   1. PRECEDENCE MATCHES THE LOOP. templates/ralph.sh sources ralph.config.sh with
//      `set -a`, so a value in the file overrides one inherited from the environment. The
//      box has to answer the same way round, or it would name an agent the loop is not
//      about to run — which is the exact confusion this feature was asked for.
//   2. THE FACTS COST THE RUN NOTHING. This box prints BEFORE the first preflight line, so
//      no fact in it may add a network round trip, a spawn, or a failure mode. Two local
//      files are read for it — the metrics log and .git/config — both best-effort, both
//      through the injected `readFile`, neither stat'ed. The metrics log is read ONCE and
//      the same text serves #60's launch projection at the bottom of the run.
//   3. NOTHING IS WRITTEN. #69 adds no telemetry field and changes no event shape: this
//      command reads that log and has no writer for it.
//
// Every seam is injected (#41), so nothing here depends on the developer's checkout — not
// their .git/config, not their .ralph, and not their environment.

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { startCommand } from './start.js'
import { metricsPath } from '../issue-metrics.js'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const METRICS_PATH = metricsPath(REPO)
const CONFIG_PATH = resolve(REPO, 'ralph.config.sh')
const GIT_CONFIG_PATH = resolve(REPO, '.git', 'config')
const MIN = 60000

// A real event carries all of it: what #60's projection measures (duration, cost) and what
// #69 reports (agent, model, window). Two runs, so "the newest wins" is visible here too.
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
    .join('\n') + '\n'

// A .git/config the way git writes one, origin last because that is where it usually is.
const GIT_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '[remote "origin"]',
  '\turl = git@github.com:lucasfe/ralph.git',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '',
].join('\n')

// The escape byte is spelled, never typed (#107): a raw one in a committed source makes
// `file` call this a binary and makes grep skip it silently.
const ESC = String.fromCharCode(27)
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
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

// One exec for the whole preflight, matched on cmd/args rather than on exact key strings,
// and RECORDED — the order matters to claim 2 above.
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

// Three text seams — the config, the metrics log and .git/config — each of which may be a
// FUNCTION, which is how a throwing or non-string reader is expressed. Every path either fs
// hook is asked about is recorded.
const deps = ({
  config = 'TASK_SOURCE=folder\n',
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
  return row === undefined ? undefined : stripAnsi(row).slice(2, -2).trimEnd().slice(8)
}

const run = async (options) => {
  const d = deps(options)
  const result = await startCommand(d)
  return { d, result }
}

describe('startCommand — which agent, which model (#69)', () => {
  it('reports the model the last run used, and the window it ran with', async () => {
    const { d } = await run({ metrics: HISTORY })
    expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    expect(rowOf(d, 'context')).toBe('1M tokens')
  })

  it('names the agent and promises nothing when there is no history at all', async () => {
    // Every fresh checkout, and the criterion the whole provenance tag exists for: the
    // Claude model cannot be known before the first turn, so the line says so rather than
    // naming a model it would have guessed.
    const { d } = await run({ metrics: '' })
    expect(rowOf(d, 'agent')).toBe('claude — model resolves at first run')
    expect(rowOf(d, 'context')).toBeUndefined()
  })

  it('reports Codex’s configured model as configured, never as a last run', async () => {
    // Codex's stream carries no model id, so the configured knob IS the answer — and the
    // window comes from the same map the telemetry writer uses.
    const { d } = await run({
      config: 'TASK_SOURCE=folder\nRALPH_AGENT=codex\nRALPH_CODEX_MODEL=gpt-5-codex\n',
      metrics: HISTORY,
    })
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
    expect(rowOf(d, 'context')).toBe('400k tokens')
  })

  it('says the model resolves at first run for a Codex with no model configured', async () => {
    const { d } = await run({ config: 'TASK_SOURCE=folder\nRALPH_AGENT=codex\n', metrics: HISTORY })
    expect(rowOf(d, 'agent')).toBe('codex — model resolves at first run')
    expect(rowOf(d, 'context')).toBeUndefined()
  })

  it('lets ralph.config.sh win over the environment, exactly as the loop does', async () => {
    // templates/ralph.sh sources the file with `set -a`, so the file overrides what it
    // inherited. The box has to answer the same way round as the process it is announcing —
    // this is the same precedence the TASK_SOURCE line beside it has always used, and the
    // deliberate opposite of RALPH_BANNER's (a knob about the invocation, not the repo).
    const { d } = await run({
      config: 'TASK_SOURCE=folder\nRALPH_AGENT=codex\nRALPH_CODEX_MODEL=gpt-5-codex\n',
      processEnv: { RALPH_AGENT: 'claude', RALPH_CODEX_MODEL: 'gpt-4o' },
      metrics: HISTORY,
    })
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
  })

  it('falls back to the environment when the config says nothing', async () => {
    const { d } = await run({
      config: 'TASK_SOURCE=folder\n',
      processEnv: { RALPH_AGENT: 'codex', RALPH_CODEX_MODEL: 'gpt-5-codex' },
    })
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
  })

  it('names the agent that will actually run when RALPH_AGENT is a typo', async () => {
    // `resolveAgent` warns and falls back to claude rather than aborting an unattended run,
    // and the box reports the RESOLVED agent for the same reason telemetry records it: the
    // row is about what is about to happen, not about what was typed.
    const { d } = await run({ config: 'TASK_SOURCE=folder\nRALPH_AGENT=codx\n', metrics: HISTORY })
    expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
  })

  it('reports the window RALPH_CONTEXT_WINDOW will actually give the run', async () => {
    // The override the loop passes its agent is part of "which model, how big a window", so
    // the Codex row has to read it: `400k tokens` from the map with a `200000` override in
    // force would be a row contradicted by the very first event the run writes. Same
    // config-over-environment precedence as the two knobs beside it, for the same reason —
    // templates/ralph.sh sources the file with `set -a`.
    const { d } = await run({
      config: 'TASK_SOURCE=folder\nRALPH_AGENT=codex\nRALPH_CODEX_MODEL=gpt-5-codex\nRALPH_CONTEXT_WINDOW=200000\n',
      processEnv: { RALPH_CONTEXT_WINDOW: '128000' },
    })
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
    expect(rowOf(d, 'context')).toBe('200k tokens')
    // ...and from the environment when the config is silent about it.
    const { d: fromEnv } = await run({
      config: 'TASK_SOURCE=folder\nRALPH_AGENT=codex\nRALPH_CODEX_MODEL=gpt-5-codex\n',
      processEnv: { RALPH_CONTEXT_WINDOW: '128000' },
    })
    expect(rowOf(fromEnv, 'context')).toBe('128k tokens')
    // The claude row is unmoved by the same knob: its window comes from the event, which was
    // written with whatever override THAT run had (see lib/banner-model.test.js).
    const { d: last } = await run({
      metrics: HISTORY,
      processEnv: { RALPH_CONTEXT_WINDOW: '128000' },
    })
    expect(rowOf(last, 'context')).toBe('1M tokens')
  })

  it('reads a Codex run’s history as no evidence about a claude launch', async () => {
    // A repo that switched agents has the other one's run at the bottom of its log.
    const codexRun = eventLine({ ts: 3, agent: 'codex', model: 'gpt-5-codex' })
    const { d } = await run({ metrics: `${HISTORY}${codexRun}\n` })
    expect(rowOf(d, 'agent')).toBe('claude — model resolves at first run')
  })
})

describe('startCommand — which source, which repo (#69)', () => {
  it('names the resolved task source, from the config', async () => {
    for (const [config, source] of [
      ['TASK_SOURCE=folder\n', 'folder'],
      ['TASK_SOURCE=github\n', 'github'],
      // Unset and unrecognized both resolve to the github default, and the row reports the
      // RESOLVED value rather than the raw one — a row saying `banana` would be a row about
      // the config file instead of about the run.
      ['', 'github'],
      ['TASK_SOURCE=banana\n', 'github'],
    ]) {
      const { d } = await run({ config, exec: makeExec() })
      expect(rowOf(d, 'source'), JSON.stringify(config)).toBe(source)
    }
  })

  it('honours TASK_SOURCE from the environment when the config is silent', async () => {
    const { d } = await run({ config: '', processEnv: { TASK_SOURCE: 'folder' } })
    expect(rowOf(d, 'source')).toBe('folder')
  })

  it('names the repo the loop will read, in github mode', async () => {
    const { d } = await run({ config: 'TASK_SOURCE=github\n' })
    expect(rowOf(d, 'repo')).toBe('lucasfe/ralph')
  })

  it('draws no repo row in folder mode, even with an origin remote', async () => {
    // Folder mode never touches gh: there is no repo it will read issues from, so naming
    // one would be naming a fact that is not about this run.
    const { d } = await run({ config: 'TASK_SOURCE=folder\n' })
    expect(rowOf(d, 'repo')).toBeUndefined()
    expect(d.paths.readFile).not.toContain(GIT_CONFIG_PATH)
  })

  it('lets GH_REPO win, because gh does', async () => {
    const { d } = await run({
      config: 'TASK_SOURCE=github\n',
      processEnv: { GH_REPO: 'someone/else' },
    })
    expect(rowOf(d, 'repo')).toBe('someone/else')
  })

  it('lets a GH_REPO in ralph.config.sh win over the environment, as the loop does', async () => {
    // #120: the same precedence as the three knobs above, and here for the sharpest version of
    // the reason claim 1 makes. templates/ralph.sh sources this file with `set -a`, so a
    // committed GH_REPO decides for every `gh` command the loop runs — and a box that named the
    // environment's repository instead would name one no issue in the run came from, which is
    // the one disagreement between the box and the loop this feature was asked to end.
    const { d } = await run({
      config: 'TASK_SOURCE=github\nGH_REPO=committed/repo\n',
      processEnv: { GH_REPO: 'ambient/repo' },
    })
    expect(rowOf(d, 'repo')).toBe('committed/repo')
    // ...and the environment when the file assigns nothing, which is the only case bash falls
    // through on and the case every project that never heard of this knob is in.
    const { d: fromEnv } = await run({
      config: 'TASK_SOURCE=github\n',
      processEnv: { GH_REPO: 'ambient/repo' },
    })
    expect(rowOf(fromEnv, 'repo')).toBe('ambient/repo')
  })

  it('keeps the environment out when the config blanks GH_REPO, and reads origin', async () => {
    // #120: PRESENT OR ABSENT, not truthy or falsy — the RALPH_AGENT shape (#118) rather than
    // the `||` beside it, and this is the row that makes the difference visible. `set -a`
    // exports a blank assignment OVER an inherited value, so the loop's `gh` sees an empty
    // GH_REPO, reads it as unset, and takes its base repository from origin. Passing the blank
    // straight through gives exactly that row; a `||` would fall through to the environment and
    // print `ambient/repo`, a repository no `gh` call in this run is about to touch.
    const { d } = await run({
      config: 'TASK_SOURCE=github\nGH_REPO=""\n',
      processEnv: { GH_REPO: 'ambient/repo' },
    })
    expect(rowOf(d, 'repo')).toBe('lucasfe/ralph')
  })

  it('drops the row rather than guessing when the remote is not a GitHub slug', async () => {
    for (const gitConfig of ['', '[remote "origin"]\n\turl = /srv/git/thing.git\n', () => null]) {
      const { d } = await run({ config: 'TASK_SOURCE=github\n', gitConfig })
      expect(rowOf(d, 'repo')).toBeUndefined()
      // ...and the source row is still there: one unresolvable fact costs one row.
      expect(rowOf(d, 'source')).toBe('github')
    }
  })
})

describe('startCommand — the new facts cost the run nothing (#69)', () => {
  it('reads the metrics file ONCE, and the same text serves the launch projection', async () => {
    // The box needs this text before the first preflight line and #60's projection needs it
    // after the tmux launch. ONE read, hoisted above the banner and reused — a second read
    // would let a log the loop appended to mid-run answer the two questions differently.
    const { d } = await run({ config: 'TASK_SOURCE=github\n', metrics: HISTORY })
    expect(d.paths.readFile.filter((p) => p.endsWith('issues.jsonl'))).toEqual([METRICS_PATH])
    expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    expect(d.stdout.output()).toContain('Projection:')
  })

  it('never stats either new file — a best-effort read needs no probe', async () => {
    // `exists` is asked about ralph.config.sh and the two credential files, and about
    // nothing else: an `exists` on .git/config would put a second path under a directory
    // this command has no business inspecting, and it would answer no faster.
    const { d } = await run({ config: 'TASK_SOURCE=github\n', metrics: HISTORY })
    expect(d.paths.exists).not.toContain(GIT_CONFIG_PATH)
    expect(d.paths.exists.some((p) => p.includes('.ralph'))).toBe(false)
    expect(d.paths.exists.some((p) => p.includes('.git/'))).toBe(false)
  })

  it('never shells out for the repo — the first exec is still the tmux check', async () => {
    // `gh repo view` is a GraphQL round trip (lib/commands/cycle.js uses it, where there is
    // no banner waiting on it) and `git remote get-url` is a spawn. Both would put an effect
    // above the first thing this command draws, so the slug comes out of a local file.
    const exec = makeExec()
    const { d } = await run({ config: 'TASK_SOURCE=github\n', exec, metrics: HISTORY })
    expect(exec.calls[0].key).toBe(`tmux has-session -t ${(await import('../lock.js')).sessionNameFor(REPO)}`)
    for (const call of exec.calls) {
      expect(call.key).not.toContain('repo view')
      expect(call.key).not.toContain('remote')
    }
    expect(rowOf(d, 'repo')).toBe('lucasfe/ralph')
  })

  it('reads no .git/config at all when there is no box to draw', async () => {
    // `RALPH_BANNER=off` is the wrapper-script, cron and CI case, and #74 pinned that it costs
    // not one BYTE of output. The repo read serves nothing but a row that mode will not draw,
    // so it costs not one READ either — this fact, unlike the metrics text, has no second
    // consumer to share it with. The metrics read stays: #60's projection needs it whatever
    // the banner is doing, which is why gating that one would buy back an inert read at the
    // price of two code paths.
    const { d } = await run({
      config: 'TASK_SOURCE=github\n',
      metrics: HISTORY,
      processEnv: { RALPH_BANNER: 'off' },
    })
    expect(boxOf(d)).toEqual([])
    expect(d.paths.readFile).not.toContain(GIT_CONFIG_PATH)
    expect(d.paths.readFile.filter((p) => p.endsWith('issues.jsonl'))).toEqual([METRICS_PATH])
    expect(d.stdout.output()).toContain('Projection:')
  })

  it('reads the two files BELOW the banner’s own config read and above nothing else', async () => {
    // The order the box's own facts are resolved in is not observable from the output, but
    // WHICH files were read before the first paint is: three, all local, all inert.
    const { d } = await run({ config: 'TASK_SOURCE=github\n', metrics: HISTORY })
    expect(d.paths.readFile.slice(0, 3)).toEqual([CONFIG_PATH, METRICS_PATH, GIT_CONFIG_PATH])
  })

  const hostile = [
    ['a metrics read that throws', { metrics: () => { throw new Error('EACCES') } }],
    ['a .git/config read that throws', { gitConfig: () => { throw new Error('EACCES') } }],
    ['a metrics read that returns a number', { metrics: () => 42 }],
    ['a .git/config read that returns a number', { gitConfig: () => 42 }],
    ['a metrics read that returns a Buffer', { metrics: () => Buffer.from(HISTORY) }],
    ['a .git/config read that returns a Buffer', { gitConfig: () => Buffer.from(GIT_CONFIG) }],
    ['a hostile GH_REPO', { processEnv: { GH_REPO: { toString() { throw new Error('nope') } } } }],
    ['a hostile RALPH_AGENT', { processEnv: { RALPH_AGENT: `codex${ESC}[31m` } }],
  ]

  for (const [label, overrides] of hostile) {
    it(`starts anyway — ${label}`, async () => {
      const { d, result } = await run({ config: 'TASK_SOURCE=github\n', ...overrides })
      expect(result, label).toEqual({ exitCode: 0, started: true, count: 9 })
      // The box still prints, and it still says which Ralph and where.
      expect(boxOf(d).length, label).toBeGreaterThan(2)
      expect(rowOf(d, 'cwd'), label).toBe(REPO)
      // Not one forged line: every row is inside the frame.
      for (const line of boxOf(d).slice(1, -1)) {
        expect(line, label).toMatch(/^│ .* │$/)
      }
    })
  }

  it('writes no telemetry and changes no event shape — criterion 9, as a static read', async () => {
    // #69 READS the metrics log and adds nothing to it. Asserted on the source because the
    // absence of a write cannot be shown by exercising happy paths: this command holds no
    // writer for that file and must not acquire one for a banner row.
    const code = codeWithoutComments(new URL('./start.js', import.meta.url))
    expect(code).not.toMatch(/appendIssueEvent|buildIssueEvent/)
    // The read, pinned to its SUBJECT. Since #117 the shared reader is named for its contract
    // rather than for this file, and start.js points it at a second path as well (`.git/config`,
    // for the repo row) — so matching the name alone would no longer say WHICH file is read, and
    // "reads the metrics log, writes nothing to it" is the whole of the claim.
    expect(code).toMatch(/safeReadText\(readFile, metricsPath\(/)
  })
})
