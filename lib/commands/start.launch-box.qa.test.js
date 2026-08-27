import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startCommand, StartAbort } from './start.js'
import { sessionNameFor } from '../lock.js'
import { metricsPath } from '../issue-metrics.js'
import { templatePath } from '../paths.js'

// #60 QA augmentation — the `ralph start` startup box. The dev's start.test.js
// pins the happy-path box in folder mode, the no-history omission, two I/O
// failures and the digest on/off pair. What is attacked here is what makes the
// change ADDITIVE and what makes it SAFE:
//
//   1. THE BOX IS A TESTED OUTPUT SURFACE, and the five pre-existing lines are
//      what a user's muscle memory and every screenshot in the README are built
//      on. So the assertions below are on the WHOLE box — the `✅` line verbatim,
//      the new lines at the position they claim, and the five tmux lines in their
//      original relative order — rather than on the new lines alone. Driven
//      through BOTH sources, because the box is source-independent and folder mode
//      is the only one the dev's file exercises.
//   2. A HINT MAY NEVER COST A LAUNCH. Two files are read for it, both best
//      effort: issues.jsonl (which a killed run leaves half-written) and
//      ralph.config.sh (which may be absent, unreadable, or handed back as a
//      Buffer by an injected fs). Every one of those shapes must degrade to fewer
//      lines and never to an exception or a changed task source — the loop is
//      already running in tmux by the time these lines print, so an abort here
//      would leave a live session behind and tell the user nothing started.
//
// Plus the two orderings that are invisible in the output and easy to break: the
// empty-queue early return must not read the metrics file at all (it returns
// before the projection), and neither must a run that aborts on the tmux launch.
//
// Hermetic: no test here touches a real filesystem or spawns anything. `exists`,
// `readFile`, `exec`, `folderQueueCount` and `now` are all injected, and the one
// real file read is the SHIPPED template, read read-only to prove today's output
// is unchanged for every existing user.

const REPO = '/repo'
const HOME = '/home/me'
const SESSION = sessionNameFor(REPO)
const METRICS_PATH = metricsPath(REPO)
const CONFIG_PATH = resolve(REPO, 'ralph.config.sh')
const MIN = 60000

// A launch at 16:04 against the issue's worked example — 97min/$34.10 and
// 71min/$28.75 → 84 min/task, $31.425/task; nine waiting is 12h36m, ~$280, and a
// finish at 04:40 tomorrow.
const NOW = new Date(2026, 7, 25, 16, 4, 0).getTime()
const HISTORY =
  [
    { issue_number: 29, run_id: 'ralph-a', ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.1 },
    { issue_number: 30, run_id: 'ralph-b', ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.75 },
  ]
    .map((e) => `RALPH_ISSUE_EVENT ${JSON.stringify(e)}`)
    .join('\n') + '\n'

// Derived, not written out: the box prints the reader's local wall clock.
const clockOf = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const DONE = clockOf(NOW + 756 * MIN)

// The box as it stood BEFORE #60 — five lines, this order. Written out here so a
// reordering or a reworded label fails on this file too, not only on the dev's.
const EXISTING_TAIL = [
  `   Watch live:     tmux attach -t ${SESSION}`,
  '   Detach:         inside the session, Ctrl+B then D',
  '   List:           tmux ls',
  `   Kill:           tmux kill-session -t ${SESSION}`,
  '   Logs:           logs/ralph-issue-*.log',
]
const STARTED = '✅ Ralph started in background. 9 issues in the queue.'
const PROJECTION = [
  '   Projection:     ~84 min/task · ~$31/task',
  `                   → ~12h36m, ~$280, done ≈ ${DONE}`,
]
const PROGRESS = '   Progress:       ralph status'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
  }
}

// One exec for the whole preflight, matched on cmd/args rather than on exact key
// strings so a search-query tweak in start.js cannot silently defuse a test.
function makeExec({ queue = '9', tmuxNew = 0, ghAuth = 0, orphan = '' } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd === 'tmux' && args[0] === 'new') return { exitCode: tmuxNew, stdout: '', stderr: 'nope' }
    if (cmd === 'gh' && args[0] === 'auth') return { exitCode: ghAuth, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
      return { exitCode: 0, stdout: queue, stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'issue') return { exitCode: 0, stdout: orphan, stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

// `config: null` means ralph.config.sh does not exist — the github default path.
// Either fixture may be a FUNCTION, which is how a throwing or non-string
// `readFile` is expressed; `existsThrows` covers a config whose stat itself fails.
// Both files are served from the same injected readFile the command already takes,
// and every path either fs hook is asked about is recorded.
function baseDeps({
  config = null,
  configExists,
  existsThrows = false,
  metrics = HISTORY,
  exec,
  ...overrides
} = {}) {
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
      if (!String(p).endsWith('ralph.config.sh')) return false
      if (existsThrows) throw new Error('EPERM: operation not permitted')
      return configExists ?? config != null
    },
    readFile: (p) => {
      const path = String(p)
      paths.readFile.push(path)
      if (path.endsWith('ralph.config.sh')) return value(config)
      if (path.endsWith('issues.jsonl')) return value(metrics)
      return ''
    },
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    // The weekly update check is a no-op here: this file exercises the box.
    update: async () => ({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'disabled',
      updatedCache: null,
    }),
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    now: () => NOW,
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

// The box only, from the success line down: the credential notice and the MCP
// hints above it are a different surface.
const box = (deps) => {
  const lines = deps.stdout.output().split('\n')
  const first = lines.findIndex((l) => l.startsWith('✅ Ralph started in background.'))
  return first === -1 ? [] : lines.slice(first).filter(Boolean)
}

const metricsReads = (deps) => deps.paths.readFile.filter((p) => p.endsWith('issues.jsonl'))

describe('QA start box — the five pre-existing lines keep their text and order (#60)', () => {
  it('inserts the projection and the hint into the GITHUB-source box', async () => {
    // The dev's file drives folder mode throughout; this is the default path every
    // existing user is on.
    const deps = baseDeps()
    const result = await startCommand(deps)
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(box(deps)).toEqual([STARTED, ...PROJECTION, PROGRESS, ...EXISTING_TAIL])
  })

  it('produces a byte-identical box in FOLDER mode', async () => {
    // The queue's provenance is not the box's business: same history, same depth,
    // same nine lines, whether the count came from `gh` or from .ralph/tasks.
    const github = baseDeps()
    await startCommand(github)
    const folder = baseDeps({ config: 'TASK_SOURCE=folder\n', folderQueueCount: async () => 9 })
    await startCommand(folder)
    expect(box(folder)).toEqual(box(github))
    expect(folder.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)
  })

  it('keeps the five tmux lines contiguous, in order, and last', async () => {
    // Pinned positionally as well as by value: the projection and the hint are
    // INSERTED above them, so nothing may be interleaved into the tail.
    const deps = baseDeps()
    await startCommand(deps)
    const lines = box(deps)
    expect(lines.slice(-5)).toEqual(EXISTING_TAIL)
    expect(lines.indexOf(STARTED)).toBe(0)
    expect(lines.indexOf(PROJECTION[0])).toBe(1)
    expect(lines.indexOf(PROGRESS)).toBeLessThan(lines.indexOf(EXISTING_TAIL[0]))
  })

  it('leaves the ✅ line and its count untouched at every queue depth', async () => {
    for (const [queue, expected] of [
      ['1', '✅ Ralph started in background. 1 issues in the queue.'],
      ['9', STARTED],
      ['100', '✅ Ralph started in background. 100 issues in the queue.'],
    ]) {
      const deps = baseDeps({ exec: makeExec({ queue }) })
      await startCommand(deps)
      expect(box(deps)[0], queue).toBe(expected)
    }
  })

  it('adds only the hint line on a repo with no metrics history', async () => {
    // The one line every user gets from #60 on day one. No `~0 min/task`, no `~$0`.
    const deps = baseDeps({ metrics: '' })
    await startCommand(deps)
    expect(box(deps)).toEqual([STARTED, PROGRESS, ...EXISTING_TAIL])
  })

  it('keeps the WhatsApp notice after the box, not inside it', async () => {
    const deps = baseDeps({ loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' }) })
    await startCommand(deps)
    expect(box(deps)).toEqual([
      STARTED,
      ...PROJECTION,
      PROGRESS,
      ...EXISTING_TAIL,
      '📲 Startup WhatsApp notification sent.',
    ])
  })
})

describe('QA start box — the projection is best-effort I/O (#60)', () => {
  // Everything an injected or real `readFileSync` can hand back for the metrics
  // file. A launch is already underway when this runs, so each must cost at most
  // the two projection lines.
  const reads = {
    'a throwing readFile (EACCES)': () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    },
    'a readFile that throws ENOENT': () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    },
    'a readFile that throws EISDIR': () => {
      throw Object.assign(new Error('EISDIR: illegal operation'), { code: 'EISDIR' })
    },
    'undefined': () => undefined,
    'null': () => null,
    'an empty string': () => '',
    'a number': () => 42,
    'an object': () => ({}),
    'an array': () => [],
    'true': () => true,
    'a string of junk': () => 'npm WARN deprecated\nRALPH_ISSUE_EVENT {trunc',
  }

  for (const [label, metrics] of Object.entries(reads)) {
    it(`omits the projection and still launches for ${label}`, async () => {
      const deps = baseDeps({
        readFile: (p) => {
          const path = String(p)
          deps.paths.readFile.push(path)
          if (path.endsWith('issues.jsonl')) return metrics()
          return ''
        },
      })
      const result = await startCommand(deps)
      expect(result.started, label).toBe(true)
      expect(box(deps), label).toEqual([STARTED, PROGRESS, ...EXISTING_TAIL])
    })
  }

  it('reads a Buffer of jsonl text the way the real readFileSync can return one', async () => {
    // `readFileSync(path, 'utf8')` returns a string, but an injected fs (and an
    // encoding-less call) hands back a Buffer — the projection must survive it.
    const deps = baseDeps({ metrics: Buffer.from(HISTORY) })
    await startCommand(deps)
    expect(box(deps)).toEqual([STARTED, ...PROJECTION, PROGRESS, ...EXISTING_TAIL])
  })

  it('keeps the projection when a killed run left the LAST line half-written', async () => {
    // The realistic corruption: complete rows, then half of one. The hint must
    // survive it — dropping the block here would punish the reader for the crash.
    const deps = baseDeps({ metrics: HISTORY + 'RALPH_ISSUE_EVENT {"issue_number":31,"dur' })
    await startCommand(deps)
    expect(box(deps)).toEqual([STARTED, ...PROJECTION, PROGRESS, ...EXISTING_TAIL])
  })

  it('reads the metrics file ONCE, at .ralph/metrics/issues.jsonl, and never stats it', async () => {
    const deps = baseDeps()
    await startCommand(deps)
    expect(metricsReads(deps)).toEqual([METRICS_PATH])
    // A best-effort read needs no `exists` probe, and the projection must not add
    // a second path under .ralph to what this command consults.
    expect(deps.paths.exists.some((p) => p.includes('.ralph'))).toBe(false)
    expect(deps.paths.readFile.filter((p) => p.includes('.ralph'))).toEqual([METRICS_PATH])
  })

  it('never reads the metrics file on the empty-queue early return', async () => {
    // The projection sits after the tmux launch, so an empty queue must return
    // before it — no read, no lines, not even the hint.
    for (const [label, overrides] of [
      ['a github queue of 0', { exec: makeExec({ queue: '0' }) }],
      ['an empty gh stdout', { exec: makeExec({ queue: '' }) }],
      [
        'an empty folder queue',
        { config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n', folderQueueCount: async () => 0 },
      ],
    ]) {
      const deps = baseDeps(overrides)
      const result = await startCommand(deps)
      expect(result, label).toEqual({ exitCode: 0, started: false })
      expect(metricsReads(deps), label).toEqual([])
      const out = deps.stdout.output()
      expect(out, label).toContain('ℹ️  No issues in the queue. Nothing to do.')
      for (const token of ['Projection:', 'Progress:', 'Digest:']) {
        expect(out, `${label} → ${token}`).not.toContain(token)
      }
    }
  })

  it('never reads the metrics file on a run that aborts before the box', async () => {
    const aborts = {
      'a failed tmux launch': { exec: makeExec({ tmuxNew: 1 }) },
      'gh not authenticated': { exec: makeExec({ ghAuth: 1 }) },
    }
    for (const [label, overrides] of Object.entries(aborts)) {
      const deps = baseDeps(overrides)
      await expect(startCommand(deps), label).rejects.toThrow(StartAbort)
      expect(metricsReads(deps), label).toEqual([])
      expect(deps.stdout.output(), label).not.toContain('Projection:')
      expect(deps.stdout.output(), label).not.toContain('Progress:')
    }
  })
})

describe('QA start box — the queue the box accepted is the queue it projects (#60)', () => {
  it('scales the totals with the accepted depth', async () => {
    // Four waiting at 84 min/task is 5h36m and ~$130 — the projection is of THIS
    // queue, not of a depth frozen anywhere.
    const deps = baseDeps({ exec: makeExec({ queue: '4' }) })
    await startCommand(deps)
    expect(box(deps)[2]).toBe(`                   → ~5h36m, ~$130, done ≈ ${clockOf(NOW + 336 * MIN)}`)
  })

  it('projects the same numbers whether the depth arrived as a string or a number', async () => {
    // `gh` hands back stdout; the folder counter hands back a number. Both reach
    // the projection through `Number(count)`.
    const github = baseDeps({ exec: makeExec({ queue: '9\n' }) })
    await startCommand(github)
    const folder = baseDeps({ config: 'TASK_SOURCE=folder\n', folderQueueCount: async () => 9 })
    await startCommand(folder)
    expect(box(github).slice(1, 3)).toEqual(PROJECTION)
    expect(box(folder).slice(1, 3)).toEqual(PROJECTION)
  })

  it('drops the totals — never prints NaN — when the queue count is unusable', async () => {
    // `Number('abc')` is NaN. The count line is what `gh` said, but the projection
    // must not turn that into a number: the rates stay, the totals go.
    const deps = baseDeps({ exec: makeExec({ queue: 'abc' }) })
    const result = await startCommand(deps)
    expect(result.started).toBe(true)
    expect(box(deps)).toEqual([
      '✅ Ralph started in background. abc issues in the queue.',
      '   Projection:     ~84 min/task · ~$31/task',
      PROGRESS,
      ...EXISTING_TAIL,
    ])
    expect(deps.stdout.output()).not.toMatch(/NaN|Infinity|undefined/)
  })

  it('drops `done ≈` rather than printing an empty clock when `now` is unusable', async () => {
    for (const now of [() => NaN, () => Infinity, () => null, () => 'now']) {
      const deps = baseDeps({ now })
      const result = await startCommand(deps)
      expect(result.started, String(now())).toBe(true)
      expect(box(deps), String(now())).toEqual([
        STARTED,
        '   Projection:     ~84 min/task · ~$31/task',
        '                   → ~12h36m, ~$280',
        PROGRESS,
        ...EXISTING_TAIL,
      ])
      expect(deps.stdout.output(), String(now())).not.toContain('--:--')
    }
  })
})

describe('QA start box — whether the digest hint fires at all (#60)', () => {
  // What this command owns about the hint: that a configured interval produces the
  // line, and that anything which is not an interval — absent, zero, empty —
  // produces no line. Which spellings of an assignment the parser accepts is not
  // this file's question; those live in parse-config-var.qa.test.js, against the
  // parser directly, because every variable read through it shares the answer.
  const on = (value) => `   Digest:         every ${value} — runs alongside the loop`

  const configs = {
    'no config file at all': [null, null],
    'a config that never mentions it': ['TASK_SOURCE=github\n', null],
    'an interval the config asks for': ['RALPH_DIGEST_INTERVAL=30m\n', on('30m')],
    'an interval in hours': ['RALPH_DIGEST_INTERVAL=1h\n', on('1h')],
    // Any spelling of zero is off: an interval of zero is not an interval, and
    // zeroing a knob is how a shell config turns a feature off.
    'an explicit 0 — how a user disables a shell knob': ['RALPH_DIGEST_INTERVAL=0\n', null],
    'a zero carrying a unit': ['RALPH_DIGEST_INTERVAL=0m\n', null],
    'an empty value': ['RALPH_DIGEST_INTERVAL=\n', null],
    'a quoted empty value': ['RALPH_DIGEST_INTERVAL=""\n', null],
  }

  for (const [label, [config, expected]] of Object.entries(configs)) {
    it(`${expected == null ? 'prints no digest hint' : 'prints the digest hint'} for ${label}`, async () => {
      const deps = baseDeps({ config })
      await startCommand(deps)
      expect(box(deps), label).toEqual([
        STARTED,
        ...PROJECTION,
        PROGRESS,
        ...(expected == null ? [] : [expected]),
        ...EXISTING_TAIL,
      ])
    })
  }

  it('places the digest hint between the progress hint and the tmux lines', async () => {
    const deps = baseDeps({ config: 'RALPH_DIGEST_INTERVAL=30m\n' })
    await startCommand(deps)
    const lines = box(deps)
    expect(lines.indexOf(on('30m'))).toBe(lines.indexOf(PROGRESS) + 1)
    expect(lines.indexOf(on('30m'))).toBe(lines.indexOf(EXISTING_TAIL[0]) - 1)
  })

  it('never fires for a repo running the SHIPPED ralph.config.sh', async () => {
    // The zero-regression claim, against the real template rather than a fixture:
    // `ralph init` writes this file, and since #62 it DOES declare
    // RALPH_DIGEST_INTERVAL — empty, i.e. disabled, which is the whole point of that
    // default. So today's box is still byte-identical to yesterday's for every
    // existing user, and this test now pins the default rather than the absence.
    const template = readFileSync(templatePath('ralph.config.sh'), 'utf8')
    expect(template).toMatch(/^RALPH_DIGEST_INTERVAL=""$/m)
    const config = template.replace('{{TASK_SOURCE}}', 'github')
    const deps = baseDeps({ config })
    await startCommand(deps)
    expect(box(deps)).toEqual([STARTED, ...PROJECTION, PROGRESS, ...EXISTING_TAIL])
  })
})

describe('QA start box — an unreadable ralph.config.sh changes nothing (#60)', () => {
  // One read now answers two questions, so a failure of that read has two
  // blast radii: the digest hint (must be off) and the TASK SOURCE (must stay
  // github, the pre-#60 default). The second is the one that matters — a config
  // read that silently resolved to folder would skip gh auth and count the wrong
  // queue.
  const broken = {
    'a config that does not exist': { config: null },
    'a readFile that throws EACCES': {
      configExists: true,
      config: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
    },
    'a readFile that throws EISDIR': {
      configExists: true,
      config: () => {
        throw Object.assign(new Error('EISDIR: illegal operation'), { code: 'EISDIR' })
      },
    },
    'an exists that throws': { existsThrows: true },
    'a readFile that returns undefined': { configExists: true, config: () => undefined },
    'a readFile that returns null': { configExists: true, config: () => null },
    'a readFile that returns a number': { configExists: true, config: 42 },
    'a readFile that returns an object': { configExists: true, config: {} },
    'a config of pure junk': { config: '    not shell at all' },
    'a config whose TASK_SOURCE is commented out': { config: '# TASK_SOURCE=folder\n' },
    'a config whose TASK_SOURCE is a typo': { config: 'TASK_SOURCE=foldr\n' },
    'a config whose TASK_SOURCE is quoted-empty': { config: 'TASK_SOURCE=""\n' },
  }

  for (const [label, overrides] of Object.entries(broken)) {
    it(`keeps the github default and the digest off for ${label}`, async () => {
      const deps = baseDeps(overrides)
      const result = await startCommand(deps)
      expect(result.started, label).toBe(true)
      // The github path, unchanged: gh auth probed, labels created, queue via gh.
      expect(deps.exec.calls.some((c) => c.key === 'gh auth status'), label).toBe(true)
      expect(deps.exec.calls.some((c) => c.key.startsWith('gh label create')), label).toBe(true)
      expect(
        deps.exec.calls.some((c) => c.cmd === 'gh' && c.args.includes('--search')),
        label,
      ).toBe(true)
      expect(deps.stdout.output(), label).not.toContain('Digest:')
    })
  }

  it('takes BOTH values out of one read, whichever order they appear in', async () => {
    // The read is shared, so neither value may depend on being first.
    for (const config of [
      'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n',
      'RALPH_DIGEST_INTERVAL=30m\nTASK_SOURCE=folder\n',
      'RALPH_DIGEST_INTERVAL=30m\n# a comment\n\nexport TASK_SOURCE="folder"\n',
    ]) {
      const deps = baseDeps({ config, folderQueueCount: async () => 9 })
      await startCommand(deps)
      const configReads = deps.paths.readFile.filter((p) => p === CONFIG_PATH)
      expect(configReads, config).toHaveLength(1)
      expect(deps.exec.calls.some((c) => c.key === 'gh auth status'), config).toBe(false)
      expect(deps.stdout.output(), config).toContain(
        '   Digest:         every 30m — runs alongside the loop',
      )
    }
  })

  it('reads a Buffer config the way an injected fs can hand it back', async () => {
    const deps = baseDeps({
      config: Buffer.from('TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n'),
      folderQueueCount: async () => 9,
    })
    await startCommand(deps)
    expect(deps.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)
    expect(deps.stdout.output()).toContain('   Digest:         every 30m')
  })
})
