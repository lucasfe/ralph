import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { execa } from 'execa'
import { statusCommand } from './status.js'
import { buildProgress, toJsonSnapshot } from '../progress.js'
import { formatHistoryEntry } from '../digest.js'

// #58 — `ralph status --json`. The projection itself is pinned in
// lib/progress.json.test.js; what is tested here is the I/O shell's half of the
// promise, and it is a promise about STDOUT rather than about numbers:
//
//   1. STDOUT IS THE DOCUMENT, in every mode. `ralph status --json | jq` has to
//      work whether a run is in flight or the repo has never seen one, so the
//      assertions below parse the whole of stdout — not a line of it — and count
//      the lines to prove nothing human slipped in alongside.
//   2. ONE SNAPSHOT FEEDS BOTH SURFACES. The document is asserted to equal the
//      projection of a snapshot this test builds itself from the same inputs, and
//      the numbers in it are asserted to be the ones the human lines print. Between
//      them there is no room for a second serializer to drift.
//   3. EXIT 0, AND THE OLD OUTPUT UNCHANGED. `--json` is an addition; the no-flag
//      view is the one every existing test pins, and the four modes still all
//      succeed because a read-only view has no failure of its own to report.
//
// Hermetic like status.test.js: local Date constructors (the human line's `16:20`
// is a wall clock), an injected `now`, injected fs/exec/lock doubles.

const REPO = '/repo'
const SESSION = 'ralph-ralph-b36ff7b1'
const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))

const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 3h12m in, 40min into #031
const RUN_FINISHED = new Date(2026, 7, 25, 14, 2, 0)

const MIN = 60000
const metricsEvent = (event) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(event)
// The issue's worked example, scoped to the run the record names.
const METRICS = [
  metricsEvent({ issue_number: 29, run_id: SESSION, ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.1 }),
  metricsEvent({ issue_number: 30, run_id: SESSION, ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.75 }),
].join('\n')

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

const runningRecord = (overrides = {}) => ({
  schema: 1,
  run_id: SESSION,
  session: SESSION,
  source: 'github',
  status: 'running',
  started_at: RUN_STARTED.toISOString(),
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 3 },
  finished_at: null,
  ok: null,
  failed: null,
  ...overrides,
})

const terminalRecord = (overrides = {}) => ({
  ...runningRecord(),
  status: 'partial',
  finished_at: RUN_FINISHED.toISOString(),
  ok: 2,
  failed: 1,
  ...overrides,
})

function makeExec({ sessionAlive = true, ghQueue = '6', ghExitCode = 0, gitRoot = '' } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { exitCode: gitRoot === null ? 1 : 0, stdout: gitRoot ?? '', stderr: '' }
    }
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionAlive ? 0 : 1, stdout: '', stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return { exitCode: ghExitCode, stdout: ghQueue, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  return {
    cwd: REPO,
    stdout,
    exec: makeExec(),
    exists: () => false,
    readFile: (p) => (String(p).endsWith('issues.jsonl') ? METRICS : ''),
    readRunState: () => runningRecord(),
    folderQueueCount: async () => 6,
    peekLock: () => null,
    now: () => NOW,
    // RALPH_BANNER=off (#76). Most of this file is about the document, which no banner
    // setting can reach — `--json` returns before the box — but "leaves the no-flag view
    // exactly as it was" below asserts the HUMAN view's exact `lines()` list, and the
    // identity box prints above it by default. Off here for the same reason as in
    // status.test.js: these expectations are statements about the report, and the box has
    // its own suite in status.identity-box.test.js. That the document is untouched at every
    // setting is asserted there too, so turning the knob off here hides nothing.
    processEnv: { RALPH_BANNER: 'off' },
    ...overrides,
  }
}

// The four modes, as deps bags, so every assertion below can sweep all of them.
const modeCases = () => [
  ['running', baseDeps()],
  ['interrupted', baseDeps({ exec: makeExec({ sessionAlive: false }) })],
  ['idle', baseDeps({ readRunState: () => terminalRecord() })],
  ['never-run', baseDeps({ readRunState: () => null })],
]

const parseOnly = (deps) => {
  const out = deps.stdout.output()
  expect(out.endsWith('\n'), 'the document ends in a newline').toBe(true)
  return JSON.parse(out)
}

describe('ralph status --json — stdout is the document, in every mode (#58)', () => {
  it('prints one JSON document and nothing else', async () => {
    const deps = baseDeps({ json: true })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.lines().length).toBe(1)
    const doc = parseOnly(deps)
    expect(doc.mode).toBe('running')
    // Not one character of the human view: no heading, no label column, no advice.
    const out = deps.stdout.output()
    expect(out).not.toContain('▸ ralph')
    expect(out).not.toContain('in flight')
    expect(out).not.toContain('min/task')
    expect(out).not.toContain('tmux attach')
  })

  it('parses as JSON and exits 0 in all four modes, with the mode as the discriminator', async () => {
    for (const [mode, deps] of modeCases()) {
      deps.json = true
      const result = await statusCommand(deps)
      expect(result.exitCode, `mode ${mode} must exit 0`).toBe(0)
      expect(result.mode, mode).toBe(mode)
      expect(deps.stdout.lines().length, `mode ${mode} must print exactly one line`).toBe(1)
      const doc = parseOnly(deps)
      expect(doc.mode, mode).toBe(mode)
      expect(Object.keys(doc), mode).toEqual([
        'mode',
        'run_id',
        'progress',
        'tasks',
        'pace',
        'eta',
        'spend',
        // #63, appended last: always present, `null` in every mode with no digest
        // for the run in flight.
        'digest',
      ])
    }
  })

  it('never lets a human line share stdout with the document, in any mode', async () => {
    // The command has no stderr in its deps bag (every mode is a successful read),
    // so anything it wanted to say would land on stdout and break `| jq`. Pinned
    // per mode, because `never-run` and `idle` are the two that print prose.
    for (const [mode, deps] of modeCases()) {
      deps.json = true
      await statusCommand(deps)
      const out = deps.stdout.output()
      expect(out.startsWith('{'), `mode ${mode} must start the document at byte 0`).toBe(true)
      // Not `unknown`: that is the pace basis's own name for itself, and it is
      // legitimately in the document. The prose below never is.
      for (const human of ['▸', 'ralph —', 'no run recorded', 'waiting', 'ralph start', 'min/task']) {
        expect(out, `mode ${mode} leaked "${human}"`).not.toContain(human)
      }
    }
  })

  it('keeps the queue and metrics reads out of never-run, flag or no flag', async () => {
    // #59 gave idle a report card built from the ended run's own metrics and a live
    // queue count, so the idle CARD pays for both reads now — while the idle document
    // deliberately keeps publishing an all-unknown run (the asymmetry is documented at
    // the snapshot seam in status.js) and therefore reads neither, which is pinned in
    // the review describe below. never-run is the mode that reads nothing whichever
    // surface is printing, and that is what this test owns.
    for (const flag of [true, false]) {
      const [, deps] = modeCases()[3]
      const read = []
      deps.json = flag
      deps.readFile = (p) => {
        read.push(String(p))
        return ''
      }
      const result = await statusCommand(deps)
      expect(result.mode).toBe('never-run')
      expect(read, `json: ${flag}`).toEqual([])
      expect(deps.exec.calls.some((c) => c.cmd === 'gh'), `json: ${flag}`).toBe(false)
    }
  })
})

describe('ralph status --json — one snapshot behind both surfaces (#58)', () => {
  it('emits the projection of the very snapshot the human view renders', async () => {
    const deps = baseDeps({ json: true })
    await statusCommand(deps)
    const record = runningRecord()
    expect(parseOnly(deps)).toEqual(
      toJsonSnapshot(buildProgress({ metricsText: METRICS, record, queue: 6, now: NOW }), {
        mode: 'running',
        record,
      }),
    )
  })

  it('reports the same numbers the human lines print', async () => {
    const jsonDeps = baseDeps({ json: true })
    await statusCommand(jsonDeps)
    const doc = parseOnly(jsonDeps)

    const humanDeps = baseDeps()
    await statusCommand(humanDeps)
    const human = humanDeps.stdout.output()
    expect(human).toContain(`~${doc.pace.per_task_min} min/task`)
    expect(human).toContain(`${doc.progress.remaining} waiting`)
    expect(human).toContain(`$${doc.spend.usd.toFixed(2)} so far`)
  })

  it('leaves the no-flag view exactly as it was', async () => {
    const deps = baseDeps()
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.lines()).toEqual([
      `▸ ralph — running · run ${SESSION} (started 16:20, 3h12m ago)`,
      // #56's progress line and table. "Exactly as it was" is about the FLAG — that
      // `--json` is the only thing that changes what stdout gets — so this list tracks the
      // human view as it grows; what must never appear is a brace, asserted below.
      '  progress   2/9 done · #031 in flight (40min)  [██──────] 22%',
      '',
      '  task  verdict     cost      time',
      '  #029  ❔ unknown  $34.10    97min',
      '  #030  ❔ unknown  $28.75    71min',
      '  #031  🔄 live     –         ~40min',
      '',
      '  queue      6 waiting',
      '  pace       ~84 min/task · $31.4/task',
      '  eta        ~9h08m left → ~04:40  (±1h30m)',
      '  spend      $62.85 so far · ~$250 projected',
      '',
      `  attach     tmux attach -t ${SESSION}`,
      '  kill       ralph stop',
    ])
    expect(deps.stdout.output()).not.toContain('{')
  })
})

// #63 — the digest in the document. The projection's shape is pinned in
// lib/progress.json.test.js; what this describe owns is that the SHELL feeds it the
// same view the terminal renders, and that the key is there in every mode.
describe('ralph status --json — the run’s digest (#63)', () => {
  const DIGEST_AT = new Date(NOW - 12 * 60000)
  const NARRATIVE = '#031 is in the TDD red phase.\n\nSuite went 1454 → 1598 passing.'
  const history = (overrides = {}) =>
    formatHistoryEntry({
      at: DIGEST_AT.toISOString(),
      runId: SESSION,
      task: '#031',
      model: 'claude-haiku-4-5',
      narrative: NARRATIVE,
      ...overrides,
    })

  const digestDeps = (overrides = {}) =>
    baseDeps({
      json: true,
      readFile: (p) => {
        if (String(p).endsWith('digest.log')) return history()
        return String(p).endsWith('issues.jsonl') ? METRICS : ''
      },
      ...overrides,
    })

  it('publishes the digest, its instant, its age, its model and its raw text', async () => {
    const deps = digestDeps()
    await statusCommand(deps)
    expect(parseOnly(deps).digest).toEqual({
      at: DIGEST_AT.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      age_min: 12,
      model: 'claude-haiku-4-5',
      task: '#031',
      stale: false,
      // Unwrapped and unindented: the terminal's 64-column block is a rendering.
      text: NARRATIVE,
    })
  })

  it('reports the same digest the human view prints', async () => {
    const jsonDeps = digestDeps()
    await statusCommand(jsonDeps)
    const doc = parseOnly(jsonDeps)

    const humanDeps = digestDeps({ json: false })
    await statusCommand(humanDeps)
    const human = humanDeps.stdout.output()
    expect(human).toContain(`(${doc.digest.age_min}min ago · ${doc.digest.model})`)
    expect(human).toContain('#031 is in the TDD red phase.')
  })

  it('says null — never an absent key — in every mode with no digest of its own', async () => {
    for (const [mode, deps] of modeCases()) {
      deps.json = true
      await statusCommand(deps)
      const doc = parseOnly(deps)
      expect(doc, mode).toHaveProperty('digest')
      expect(doc.digest, mode).toBe(null)
    }
  })

  it('says null for the PREVIOUS run’s digest, whatever is in the file', async () => {
    const deps = digestDeps({
      readFile: (p) =>
        String(p).endsWith('digest.log') ? history({ runId: 'ralph-ralph-0000dead' }) : '',
    })
    await statusCommand(deps)
    expect(parseOnly(deps).digest).toBe(null)
  })

  it('keeps stdout a document when the history file is unreadable', async () => {
    const deps = digestDeps({
      readFile: (p) => {
        if (String(p).endsWith('digest.log')) throw new Error('EACCES: permission denied')
        return ''
      },
    })
    const result = await statusCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(parseOnly(deps).digest).toBe(null)
    expect(deps.stdout.output()).not.toContain('EACCES')
  })
})

describe('ralph status --json — unknown is null, in the modes that know nothing (#58)', () => {
  it('says null, never 0, for a live run with no history to reason from', async () => {
    const deps = baseDeps({ json: true, readFile: () => '' })
    await statusCommand(deps)
    const doc = parseOnly(deps)
    expect(doc.pace).toEqual({
      basis: 'unknown',
      per_task_min: null,
      fastest_min: null,
      slowest_min: null,
      samples: 0,
    })
    expect(doc.eta).toEqual({
      remaining_min: null,
      finish_at: null,
      range_min: null,
      basis: 'unknown',
    })
    expect(doc.spend).toEqual({ usd: null, per_task_usd: null, projected_usd: null })
    // The queue was still counted, so the denominator is a fact.
    expect(doc.progress.remaining).toBe(6)
  })

  it('says null for the ETA and the projection when the queue count failed', async () => {
    const deps = baseDeps({ json: true, exec: makeExec({ ghExitCode: 1, ghQueue: '' }) })
    const result = await statusCommand(deps)
    const doc = parseOnly(deps)
    expect(result.exitCode).toBe(0)
    expect(doc.progress.remaining).toBe(null)
    expect(doc.progress.total).toBe(null)
    expect(doc.eta.remaining_min).toBe(null)
    expect(doc.spend.projected_usd).toBe(null)
    // ...and the measured facts survive.
    expect(doc.pace.per_task_min).toBe(84)
    expect(doc.spend.usd).toBeCloseTo(62.85, 5)
  })

  it('says null everywhere for a metrics read that threw, still exiting 0', async () => {
    const deps = baseDeps({
      json: true,
      readFile: (p) => {
        if (String(p).endsWith('issues.jsonl')) throw new Error('EACCES: permission denied')
        return ''
      },
    })
    const result = await statusCommand(deps)
    const doc = parseOnly(deps)
    expect(result.exitCode).toBe(0)
    expect(doc.pace.per_task_min).toBe(null)
    expect(doc.eta.finish_at).toBe(null)
    expect(doc.spend.usd).toBe(null)
    expect(deps.stdout.output()).not.toContain('EACCES')
  })

  it('never says a finished run has a task in flight', async () => {
    // run-state's endRun deliberately KEEPS `current` on a terminal record — it is
    // the last task the run worked on. An idle document that reported it as in
    // flight would have `ralph status --json` claim a finished run is still going.
    const deps = baseDeps({ json: true, readRunState: () => terminalRecord() })
    await statusCommand(deps)
    const doc = parseOnly(deps)
    expect(doc.mode).toBe('idle')
    expect(doc.run_id).toBe(SESSION)
    expect(doc.progress.in_flight).toBe(0)
    expect(doc.tasks.current).toBe(null)
  })

  it('names no run and measures nothing for a repo that never ran ralph', async () => {
    const deps = baseDeps({ json: true, readRunState: () => null })
    await statusCommand(deps)
    const doc = parseOnly(deps)
    expect(doc.mode).toBe('never-run')
    expect(doc.run_id).toBe(null)
    expect(doc.tasks.current).toBe(null)
    expect(doc.progress).toEqual({ completed: 0, in_flight: 0, remaining: null, total: null })
    expect(doc.eta.remaining_min).toBe(null)
  })
})

// The two things #59's review found at this seam, both about a run that is OVER while
// its record still says `running`:
//
//   1. THE TWO SURFACES MUST AGREE. The card calls an interrupted run over; the document
//      was still naming the task it was "working on" and predicting when that task and
//      the whole queue would finish. Same keys as before — what changed is that the
//      predictions read `null`.
//   2. A READ IS ONLY WORTH PAYING FOR IF THE SURFACE USES IT. The idle document reports
//      no measurement at all, so counting the queue for it is a `gh` round-trip thrown
//      away on a command people put on a prompt timer.
describe('ralph status --json — a dead run reports facts and no predictions (#59 review)', () => {
  const interruptedDeps = (overrides = {}) =>
    baseDeps({ json: true, exec: makeExec({ sessionAlive: false }), ...overrides })

  it('publishes what the interrupted run measured and nothing it cannot know', async () => {
    const deps = interruptedDeps()
    await statusCommand(deps)
    const doc = parseOnly(deps)
    expect(doc.mode).toBe('interrupted')
    // MEASURED — the tasks really ran, at that pace, for that money.
    expect(doc.progress.completed).toBe(2)
    expect(doc.progress.remaining).toBe(6)
    expect(doc.pace.per_task_min).toBe(84)
    expect(doc.pace.samples).toBe(2)
    expect(doc.spend.usd).toBeCloseTo(62.85, 5)
    expect(doc.spend.per_task_usd).toBeCloseTo(31.425, 5)
    // INVENTED — a run that is over has no task in flight and no future.
    expect(doc.progress.in_flight).toBe(0)
    expect(doc.tasks.current).toBe(null)
    expect(doc.eta.remaining_min).toBe(null)
    expect(doc.eta.finish_at).toBe(null)
    expect(doc.eta.range_min).toBe(null)
    expect(doc.spend.projected_usd).toBe(null)
  })

  it('changes no key, in any mode — only which values are null', async () => {
    // The keys are #58's published contract, so a `jq` filter written against a running
    // document must resolve against an interrupted one. Compared as the full key set of
    // every section rather than as a spot check.
    const shapeOf = (doc) =>
      Object.fromEntries(
        Object.entries(doc).map(([k, v]) => [k, v && typeof v === 'object' ? Object.keys(v) : k]),
      )
    const live = baseDeps({ json: true })
    await statusCommand(live)
    const dead = interruptedDeps()
    await statusCommand(dead)
    expect(shapeOf(parseOnly(dead))).toEqual(shapeOf(parseOnly(live)))
  })

  it('leaves the running document byte-identical', async () => {
    // The liveness rule is new input, and a live run is the mode that must not have
    // noticed it: same deps as #58's own worked example, same document.
    const deps = baseDeps({ json: true })
    await statusCommand(deps)
    const record = runningRecord()
    expect(parseOnly(deps)).toEqual(
      toJsonSnapshot(buildProgress({ metricsText: METRICS, record, queue: 6, now: NOW }), {
        mode: 'running',
        record,
      }),
    )
  })

  it('says the card says the same thing: over, with no pace, ETA or projection', async () => {
    // The human surface of the same repo, from the same deps. The card is the
    // report-card module's (pinned in lib/post-mortem.test.js); what matters here is that
    // it agrees with the document above rather than showing a live view's predictions.
    const deps = baseDeps({ exec: makeExec({ sessionAlive: false }) })
    const result = await statusCommand(deps)
    expect(result.mode).toBe('interrupted')
    const out = deps.stdout.output()
    expect(out).toContain('▸ ralph — interrupted ·')
    for (const prediction of ['pace', 'eta', 'min/task', 'projected', 'in flight']) {
      expect(out, prediction).not.toContain(prediction)
    }
  })

  it('pays for no queue count and no metrics read the idle document would discard', async () => {
    // The regression: idle reads both for its CARD, and the document reports neither, so
    // under `--json` both were bought and thrown away.
    const read = []
    const deps = baseDeps({
      json: true,
      readRunState: () => terminalRecord(),
      readFile: (p) => {
        read.push(String(p))
        return METRICS
      },
    })
    const result = await statusCommand(deps)
    expect(result.mode).toBe('idle')
    expect(deps.exec.calls.some((c) => c.cmd === 'gh')).toBe(false)
    expect(read).toEqual([])
    // ...and the document is the all-unknown one #58 published, unchanged by the saving.
    const doc = parseOnly(deps)
    expect(doc.progress.remaining).toBe(null)
    expect(doc.spend.usd).toBe(null)
  })

  it('still pays for both in the modes whose document reports them', async () => {
    // The other side of the rule: the saving is "what this surface uses", not "spend
    // less". A running or interrupted document reports the pace, the spend and the
    // queue, so both reads happen — exactly once each.
    for (const [label, overrides] of Object.entries({
      running: {},
      interrupted: { exec: makeExec({ sessionAlive: false }) },
    })) {
      const read = []
      const deps = baseDeps({
        json: true,
        readFile: (p) => {
          if (String(p).endsWith('issues.jsonl')) read.push(String(p))
          return METRICS
        },
        ...overrides,
      })
      await statusCommand(deps)
      expect(read.length, label).toBe(1)
      expect(deps.exec.calls.filter((c) => c.cmd === 'gh').length, label).toBe(1)
    }
  })
})

// bin/ralph.js parses argv on import and bin/ is outside vitest's include globs,
// so the wiring is asserted from the SOURCE plus one real `--help` invocation —
// the approach lib/commands/update.test.js and cycle.update-notice.test.js take.
describe('ralph status --json — CLI registration (#58)', () => {
  const bin = readFileSync(new URL('../../bin/ralph.js', import.meta.url), 'utf8')

  it('documents --json in `ralph status --help`', async () => {
    const result = await execa('node', [BIN, 'status', '--help'], { reject: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/--json/)
  })

  it('threads the flag through to statusCommand', () => {
    expect(bin).toMatch(/statusCommand\(\{[\s\S]{0,120}?json:\s*Boolean\(opts\.json\)/)
  })
})
