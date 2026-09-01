import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startCommand, StartAbort } from './start.js'
import { sessionNameFor } from '../lock.js'
import { RALPH_HOME } from '../paths.js'
import { fenced } from '../../test/helpers/doc-guard.js'

// QA augmentation for #169 — the two places `ralph start` hands a reader a way to watch the
// loop. The dev's ./start.live-hint.test.js pins both surfaces' bytes with the continuation
// indents spelled out as literals (19 and 11). What is attacked here is everything those
// literals cannot say:
//
//   1. ALIGNMENT IS A PROPERTY OF THE LABELS, not a number. `   Watch live:     ` is 19
//      characters because the box's label field is 16 wide, and the continuation line has
//      to land on whatever column the OTHER rows land on — so it is measured against
//      `Progress:`, `Detach:`, `Logs:` and the projection's own continuation rather than
//      against 19. A future relabel that forgets to repad fails here; against a literal it
//      would go green with the box out of line.
//   2. THE BOX HAS BRANCHES. Digest on, digest refused, projection present, projection
//      absent, folder source, github source, a WhatsApp line printed AFTER it — the pair
//      has to come out contiguous, in order and exactly once in every one of them, because
//      it is now two `out()` calls where there was one and the failure mode of two is
//      something landing between them.
//   3. THE SESSION NAME IS THE ROW'S POINT. Both surfaces are asserted to advertise the
//      session the command ITSELF used — the `-s` of the `tmux new` that launched the loop,
//      the `-t` of the `has-session` that refused it — rather than merely some name, and
//      through a hostile cwd, which is the only untrusted input either surface has.
//   4. THE OTHER EXITS MUST STAY SILENT. `ralph start` has six more ways out, and every one
//      of them ends with no session a user could attach to. A hint moved a line too early
//      would advertise `ralph live` after an aborted launch — worse than advertising
//      nothing, because there is nothing running to attach to.
//   5. THE TWO SURFACES ARE MUTUALLY EXCLUSIVE, and the ❌/hint split across the two
//      streams is load-bearing (live.js:68 documents it as the departure `ralph live`
//      deliberately does NOT copy).
//
// Plus the strongest guard available for a transcript: the launch box in README.md is
// extracted and compared against what the code actually prints, so the doc cannot drift
// again, and every `ralph <word>` the box advertises is checked against the command table
// in bin/ralph.js — `ralph live` is a new command, and a typo in a hint nothing calls would
// ship silently.
//
// Hermetic: `exec`, `exists`, `readFile`, `hasCommand`, `loadEnv`, `update`, `runUpdate`,
// `ask`, `sendWa`, `peekLock`, `readCache`, `now`, `home` and `processEnv` are all injected;
// nothing is spawned and nothing is written. README.md and bin/ralph.js are read off disk
// READ-ONLY, the shape lib/commands/cycle.update-docs.test.js:42 established.

const REPO = '/repo'
const HOME = '/home/me'
const SESSION = sessionNameFor(REPO)
const MIN = 60000
const RALPH_BIN = '/usr/local/bin/ralph'

// The launch-box fixture, shared with ./start.launch-box.qa.test.js: a 16:04 launch, nine
// issues, and two finished tasks that average 84 min/task and $31.425/task — which is the
// worked example the README transcript below was written from.
const NOW = new Date(2026, 7, 25, 16, 4, 0).getTime()
const HISTORY =
  [
    { issue_number: 29, run_id: 'ralph-a', ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.1 },
    { issue_number: 30, run_id: 'ralph-b', ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.75 },
  ]
    .map((e) => `RALPH_ISSUE_EVENT ${JSON.stringify(e)}`)
    .join('\n') + '\n'

const WATCH_ROW = '   Watch live:     ralph live'
const ABORT_ROW = '   Watch:  ralph live'
const attachLine = (session) => `tmux attach -t ${session}`

// The two strings the surfaces now carry. Every negative sweep names BOTH: an exit that
// dropped `tmux attach` and kept `ralph live` would pass a one-token sweep while still
// advertising an attach to a session that does not exist.
const HINTS = ['ralph live', 'tmux attach']

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

// One exec for the whole preflight, matched on cmd/args. Every knob is a way for a
// different exit to be taken.
function makeExec({
  queue = '9',
  sessionExists = false,
  tmuxNew = 0,
  newWindow = 0,
  ghAuth = 0,
  jq = 0,
} = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    }
    if (cmd === 'tmux' && args[0] === 'new') {
      return { exitCode: tmuxNew, stdout: '', stderr: 'no server' }
    }
    if (cmd === 'tmux' && args[0] === 'new-window') {
      return { exitCode: newWindow, stdout: '', stderr: 'no space for a new window' }
    }
    if (cmd === 'jq') return { exitCode: jq, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'auth') return { exitCode: ghAuth, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
      return { exitCode: 0, stdout: queue, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.of = (cmd, sub) => calls.filter((c) => c.cmd === cmd && (sub === undefined || c.args[0] === sub))
  return exec
}

// `config: null` is the github default (no ralph.config.sh at all); `mcp: true` puts a
// .mcp.json on disk for the jq gate to judge.
function baseDeps({ config = null, metrics = HISTORY, mcp = false, exec, ...overrides } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: exec ?? makeExec(),
    exists: (p) => {
      const path = String(p)
      if (path.endsWith('ralph.config.sh')) return config != null
      if (path.endsWith('.mcp.json')) return mcp
      return false
    },
    readFile: (p) => {
      const path = String(p)
      if (path.endsWith('ralph.config.sh')) return config ?? ''
      if (path.endsWith('issues.jsonl')) return metrics
      return ''
    },
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    update: async () => ({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'disabled',
      updatedCache: null,
    }),
    sendWa: async () => ({ ok: true }),
    readCache: () => ({ latest_version: null }),
    peekLock: () => null,
    // NOT OPTIONAL HERE, AND THIS FILE IS WHY. Left unstubbed, `readChangelog` falls through to
    // the real `readChangelogEntries()`, which reads the CHANGELOG.md shipped inside the
    // installed package — so the identity box grows a `new` row quoting the LATEST release's
    // entries. Every assertion below is a `not.toContain('ralph live')`, and 0.25.0's entry for
    // this very feature is the literal string "`ralph live` attaches to this repo's running
    // loop". The release note defeats the test that guards the feature it describes.
    //
    // WHICH IS WHY IT PASSED WHEN IT WAS WRITTEN, and that is the part worth keeping. While #169
    // was in review the newest entry was 0.24.0, which says nothing about `ralph live` (measured:
    // zero occurrences in ccdee9a's CHANGELOG.md), so all thirty specs were green and the PR's
    // own red CI was the screenshot guard, not this. The eight failures appeared in b69e387 —
    // release-please writing the 0.25.0 section — a commit that touched no test and no command.
    // A test whose verdict depends on the changelog is a test that breaks at RELEASE time, which
    // is the worst moment for it, because that is the run that publishes.
    //
    // The other sixteen `start.*.test.js` files all stub this; this one shipped without.
    readChangelog: () => [],
    folderQueueCount: async () => 9,
    now: () => NOW,
    home: HOME,
    processEnv: {},
    ralphBinary: RALPH_BIN,
    ...overrides,
  }
}

// The box only, from the success line down, blank lines dropped — the credential notice and
// the identity box above it are other surfaces.
const box = (deps) => {
  const lines = deps.stdout.output().split('\n')
  const first = lines.findIndex((l) => l.startsWith('✅ Ralph started in background.'))
  return first === -1 ? [] : lines.slice(first).filter(Boolean)
}

// WHERE A ROW'S VALUE STARTS, whether the row carries a label or is a continuation of the
// one above it. The box is aligned if and only if every one of these agrees, which is what
// makes the assertion a property rather than a transcription of today's padding.
const valueColOf = (row) => {
  const labelled = /^( +[A-Za-z][A-Za-z ]*:)( +)(?=\S)/.exec(row)
  if (labelled) return labelled[1].length + labelled[2].length
  const continuation = /^( +)(?=\S)/.exec(row)
  return continuation ? continuation[1].length : 0
}
const rowStarting = (lines, prefix) => lines.find((l) => l.startsWith(prefix))

// The abort prints three lines and nothing else, so its assertions are on the WHOLE stream
// — which means the identity box has to be off (#76). Every launch-box case above leaves it
// ON, the default, because `box()` slices from the `✅` line and the box cannot reach it.
const abortDeps = (overrides = {}) =>
  baseDeps({
    exec: makeExec({ sessionExists: true }),
    processEnv: { RALPH_BANNER: 'off' },
    ...overrides,
  })

describe('QA #169 — the launch box column is derived from its labels, not spelled out', () => {
  it('lands every row and every continuation line of the box on one value column', async () => {
    // The whole box, in one assertion: `Projection:`, its continuation, `Progress:`,
    // `Watch live:`, ITS continuation, `Detach:`, `List:`, `Kill:` and `Logs:` all put
    // their values at the same column. #169 added the second continuation line this
    // property has ever had, and a wrongly padded one is invisible in a `toContain`.
    const deps = baseDeps()
    await startCommand(deps)
    const lines = box(deps)
    expect(lines.length).toBeGreaterThan(8)
    const cols = lines.slice(1).map(valueColOf)
    expect(new Set(cols), `columns: ${cols.join(',')}\n${lines.join('\n')}`).toEqual(
      new Set([cols[0]]),
    )
  })

  it('pads the tmux line to the column the OTHER rows use, not to one of its own', async () => {
    // Measured off `Progress:` — a row #169 did not touch — so relabelling `Watch live:`
    // without repadding the line under it goes red here instead of silently stepping out
    // of the block.
    const deps = baseDeps()
    await startCommand(deps)
    const lines = box(deps)
    const watch = lines.indexOf(WATCH_ROW)
    expect(watch, lines.join('\n')).toBeGreaterThan(-1)
    const column = valueColOf(rowStarting(lines, '   Progress:'))
    expect(lines[watch + 1]).toBe(`${' '.repeat(column)}${attachLine(SESSION)}`)
    // Padding and nothing else before the command: no bullet, no dash, no second label.
    expect(lines[watch + 1]).toMatch(/^ +tmux attach -t \S+$/)
    // ...and the same column the projection's own continuation line already used (#60),
    // which is the claim start.js's comment makes about lib/progress.js:117.
    expect(valueColOf(rowStarting(lines, '                   → '))).toBe(column)
  })

  it('lands the abort’s two values on one column too', async () => {
    // The narrower field: `   Watch:  ` and `   Kill:   ` are both 11 wide, so the
    // continuation is 11 spaces — derived from `Kill:`, the row #169 left alone.
    const deps = abortDeps()
    await expect(startCommand(deps)).rejects.toThrow(StartAbort)
    const lines = deps.stdout.lines()
    const column = valueColOf(rowStarting(lines, '   Kill:'))
    expect(lines).toEqual([
      ABORT_ROW,
      `${' '.repeat(column)}${attachLine(SESSION)}`,
      `   Kill:   tmux kill-session -t ${SESSION}`,
    ])
    expect(new Set(lines.map(valueColOf))).toEqual(new Set([column]))
  })
})

describe('QA #169 — the pair comes out contiguous on every branch that prints the box', () => {
  // Every branch of the box, driven end to end. In all of them the two lines must be
  // adjacent, in order, and printed once — a `Digest:` row inserted between them, or a
  // second copy from a path that prints the box twice, are the two failures two `out()`
  // calls invite where one could not.
  const branches = {
    'github source, with a projection': {},
    'folder source, with a projection': { config: 'TASK_SOURCE=folder\n' },
    'no metrics at all, so no projection': { metrics: '' },
    'a half-written issues.jsonl': { metrics: 'RALPH_ISSUE_EVENT {"issue_numb' },
    'a digest window that opened': { config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n' },
    'a digest window that was refused': {
      config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n',
      exec: makeExec({ newWindow: 1 }),
    },
    'an unparseable digest interval': { config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=90 minutes\n' },
    'the identity box turned off': { config: 'RALPH_BANNER=off\n' },
    'a WhatsApp notification printed below it': {
      processEnv: { CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+15550100' },
    },
  }

  for (const [label, overrides] of Object.entries(branches)) {
    it(`prints the pair once, in order, with ${label}`, async () => {
      const deps = baseDeps(overrides)
      const result = await startCommand(deps)
      expect(result.started, label).toBe(true)
      const lines = box(deps)
      const watch = lines.indexOf(WATCH_ROW)
      expect(watch, `${label}:\n${lines.join('\n')}`).toBeGreaterThan(-1)
      // Contiguity and order, not padding — the column is measured once, above, so a
      // repadding regression reports itself there rather than nine times here.
      expect(lines[watch + 1], label).toMatch(/^ +tmux attach -t \S+$/)
      expect(lines[watch + 1].trim(), label).toBe(attachLine(SESSION))
      // Once each, so no path prints the box twice and no path prints half of it.
      expect(
        lines.filter((l) => l === WATCH_ROW),
        label,
      ).toHaveLength(1)
      expect(
        lines.filter((l) => l.trim() === attachLine(SESSION)),
        label,
      ).toHaveLength(1)
      // ...and the four rows the pair heads — three about tmux, then the log path — still
      // follow it immediately, so nothing was interleaved into the block.
      expect(lines.slice(watch + 2, watch + 6)).toEqual([
        '   Detach:         inside the session, Ctrl+B then D',
        '   List:           tmux ls',
        `   Kill:           tmux kill-session -t ${SESSION}`,
        '   Logs:           logs/ralph-issue-*.log',
      ])
    })
  }

  it('keeps the tail last even when a WhatsApp line prints after the box', async () => {
    // The one branch where the pair is NOT at the end of stdout: the notification line
    // follows the box. It must follow the whole box, not land between the two halves of a
    // row (which is what a hint printed from inside the notification block would do).
    const deps = baseDeps({ processEnv: { CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+15550100' } })
    await startCommand(deps)
    const lines = box(deps)
    expect(lines.at(-1)).toBe('📲 Startup WhatsApp notification sent.')
    expect(lines.at(-2)).toBe('   Logs:           logs/ralph-issue-*.log')
    expect(lines.indexOf(WATCH_ROW)).toBe(lines.length - 7)
  })
})

describe('QA #169 — no other exit from `ralph start` advertises a session', () => {
  // Six more ways out, and not one of them leaves a session a reader could attach to. The
  // sweep is over BOTH streams: the hint rows go to stdout and the refusals to stderr, so
  // a hint that migrated to the wrong stream still counts as advertised.
  const exits = {
    'the queue is empty (early return, exit 0)': {
      deps: { exec: makeExec({ queue: '0' }) },
      expect: async (d) => {
        const result = await startCommand(d)
        expect(result).toMatchObject({ exitCode: 0, started: false })
        expect(d.stdout.output()).toContain('No issues in the queue')
      },
    },
    'the tmux launch itself failed': {
      deps: { exec: makeExec({ tmuxNew: 1 }) },
      expect: async (d) => {
        await expect(startCommand(d)).rejects.toThrow(StartAbort)
        expect(d.stderr.output()).toContain('Failed to start tmux session')
      },
    },
    'a live `ralph cycle` holds the lock': {
      deps: {
        peekLock: () => ({ alive: true, holder: { pid: 4242, startedAt: new Date(NOW).toISOString() } }),
      },
      expect: async (d) => {
        await expect(startCommand(d)).rejects.toThrow(StartAbort)
        expect(d.stderr.output()).toContain('Cycle in progress')
      },
    },
    'a critical command is missing': {
      deps: { hasCommand: (c) => c !== 'tmux' },
      expect: async (d) => {
        await expect(startCommand(d)).rejects.toThrow(StartAbort)
        expect(d.stderr.output()).toMatch(/tmux/)
      },
    },
    'gh is not authenticated': {
      deps: { exec: makeExec({ ghAuth: 1 }) },
      expect: async (d) => {
        await expect(startCommand(d)).rejects.toThrow(StartAbort)
        expect(d.stderr.output()).toContain('gh not authenticated')
      },
    },
    '.mcp.json is invalid JSON': {
      deps: { mcp: true, exec: makeExec({ jq: 1 }) },
      expect: async (d) => {
        await expect(startCommand(d)).rejects.toThrow(StartAbort)
        expect(d.stderr.output()).toContain('.mcp.json has invalid JSON')
      },
    },
    'an update was installed, so the run stops': {
      deps: {
        isTTY: true,
        update: async () => ({
          latestVersion: '9.9.9',
          isNewer: true,
          shouldPrompt: true,
          source: 'live',
          updatedCache: null,
        }),
        recordPrompt: () => {},
        runUpdate: async () => ({ updated: true, to: '9.9.9' }),
      },
      expect: async (d) => {
        const result = await startCommand(d)
        expect(result).toMatchObject({ exitCode: 0, started: false })
        expect(d.stdout.output()).toContain('Updated to 9.9.9')
      },
    },
  }

  for (const [label, spec] of Object.entries(exits)) {
    it(`prints neither hint when ${label}`, async () => {
      const d = baseDeps(spec.deps)
      await spec.expect(d)
      const printed = d.stdout.output() + d.stderr.output()
      for (const hint of HINTS) {
        expect(printed, `${label} advertised "${hint}"`).not.toContain(hint)
      }
    })
  }
})

describe('QA #169 — the two surfaces are mutually exclusive', () => {
  it('prints the abort pair and none of the launch box', async () => {
    const deps = abortDeps()
    await expect(startCommand(deps)).rejects.toMatchObject({ exitCode: 1 })
    const out = deps.stdout.output()
    expect(out).toContain(ABORT_ROW)
    expect(out).not.toContain(WATCH_ROW)
    expect(out).not.toContain('✅ Ralph started in background.')
    expect(out).not.toContain('   Detach:')
    // One mention, not two: the abort's own row, and nothing from the box.
    expect(out.split('ralph live').length - 1).toBe(1)
    // The loop was never launched, so there is nothing to attach to yet — which is why
    // the abort names the session that is ALREADY running rather than a new one.
    expect(deps.exec.of('tmux', 'new')).toHaveLength(0)
  })

  it('prints the launch box and none of the abort', async () => {
    const deps = baseDeps()
    await startCommand(deps)
    const out = deps.stdout.output()
    expect(out).toContain(WATCH_ROW)
    expect(out).not.toContain(ABORT_ROW)
    expect(out).not.toContain('   Kill:   tmux kill-session')
    expect(out.split('ralph live').length - 1).toBe(1)
  })

  it('keeps the abort’s ❌ on stderr and its hints on stdout', async () => {
    // live.js:68 cites this split as the convention it deliberately departs from, so it is
    // load-bearing beyond this command: the hints are advice a user copies out of stdout,
    // and the refusal is the diagnostic. Neither stream may carry the other's half.
    const deps = abortDeps()
    await expect(startCommand(deps)).rejects.toThrow(StartAbort)
    expect(deps.stderr.output()).toBe(`❌ tmux session '${SESSION}' already exists.\n`)
    for (const hint of HINTS) expect(deps.stderr.output()).not.toContain(hint)
    expect(deps.stdout.output()).not.toContain('❌')
  })
})

describe('QA #169 — both surfaces advertise the session the command itself used', () => {
  // The only untrusted input either surface has is the cwd, and `sessionNameFor` reduces a
  // directory name to `[A-Za-z0-9_-]`. So unlike `ralph status` — which prints the session
  // RECORDED in run-state.json, a string nothing sanitises — these two rows can only ever
  // print a name a shell would take as one word. Asserted, because it is the reason
  // neither row needs quoting.
  const HOSTILE_CWD = "/tmp/we ird)(;$(rm -rf ~)"
  const HOSTILE_SESSION = sessionNameFor(HOSTILE_CWD)

  it('names the session the launch actually passed to `tmux new -s`', async () => {
    const deps = baseDeps({ cwd: HOSTILE_CWD })
    await startCommand(deps)
    const launch = deps.exec.of('tmux', 'new')[0]
    const launched = launch.args[launch.args.indexOf('-s') + 1]
    expect(launched).toBe(HOSTILE_SESSION)
    const lines = box(deps)
    const watch = lines.indexOf(WATCH_ROW)
    expect(lines[watch + 1].trim()).toBe(attachLine(launched))
    // ...and the `Kill:` row four lines down is about the same session, which is the
    // reason #169 kept the name in the box at all.
    expect(rowStarting(lines, '   Kill:')).toContain(launched)
    expect(launched).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('names the session the abort actually probed with `has-session -t`', async () => {
    const deps = abortDeps({ cwd: HOSTILE_CWD })
    await expect(startCommand(deps)).rejects.toThrow(StartAbort)
    const probe = deps.exec.of('tmux', 'has-session')[0]
    expect(probe.args).toEqual(['has-session', '-t', HOSTILE_SESSION])
    expect(probe.options.shell).toBe(undefined)
    expect(deps.stdout.lines()[1].trim()).toBe(attachLine(HOSTILE_SESSION))
    expect(deps.stderr.output()).toContain(`'${HOSTILE_SESSION}'`)
  })
})

describe('QA #169 — the launch box in README.md is the box the code prints', () => {
  // The fenced-block walk comes from test/helpers/doc-guard.js, not from a copy here:
  // ./status.live-hint.qa.test.js runs the same guard over the same file for the other
  // surface, and two copies of the walk is how two guards start disagreeing about what
  // counts as a transcript.
  const README = readFileSync(join(RALPH_HOME, 'README.md'), 'utf8')
  // The session the transcript was written with. Substituted for the fixture's own name,
  // which is a hash of a path — the one thing a doc cannot reproduce.
  const DOC_SESSION = 'ralph-ralph-b36ff7b1'

  it('has exactly one launch-box transcript, and it matches the real output', async () => {
    // The strongest guard available for a transcript: not "the README mentions ralph live"
    // but "the README's block IS the output", every line of it, for the worked example the
    // fixture reproduces. #169's own docs hunk was hand-edited; this is what stops the
    // next one drifting.
    const blocks = fenced(README).filter((b) => b[0]?.startsWith('✅ Ralph started in background.'))
    expect(blocks).toHaveLength(1)
    const deps = baseDeps()
    await startCommand(deps)
    expect(blocks[0].map((l) => l.replaceAll(DOC_SESSION, SESSION))).toEqual(box(deps))
  })

  it('has no pre-#169 hint row left anywhere in it', () => {
    // The whole file, not the transcript: a second worked example or a screenshot caption
    // carrying the old single-line row would be exactly the drift this suite catches.
    expect(README).not.toContain('Watch live:     tmux attach')
    expect(README).not.toContain('Watch:  tmux attach')
  })
})

describe('QA #169 — the box advertises commands that exist', () => {
  // `ralph live` arrived in #167. A surface advertising a command that does not exist is
  // worse than one advertising nothing, and no test calls a hint string — so every
  // `ralph <word>` either surface prints is checked against the commander registrations in
  // bin/ralph.js.
  const BIN = readFileSync(new URL('../../bin/ralph.js', import.meta.url), 'utf8')
  const REGISTERED = new Set([...BIN.matchAll(/\.command\('([a-z-]+)'\)/g)].map((m) => m[1]))

  it('found the command table at all', () => {
    expect(REGISTERED.size).toBeGreaterThan(8)
    expect(REGISTERED.has('live')).toBe(true)
  })

  it('names only registered commands in the launch box', async () => {
    const deps = baseDeps()
    await startCommand(deps)
    const words = [...box(deps).join('\n').matchAll(/\bralph ([a-z-]+)/g)].map((m) => m[1])
    // `ralph live` and `ralph status`, at least.
    expect(words.length).toBeGreaterThan(1)
    for (const word of words) {
      expect(REGISTERED.has(word), `\`ralph ${word}\` is not a registered command`).toBe(true)
    }
  })

  it('names only registered commands in the session-exists abort', async () => {
    const deps = abortDeps()
    await expect(startCommand(deps)).rejects.toThrow(StartAbort)
    const words = [...deps.stdout.output().matchAll(/\bralph ([a-z-]+)/g)].map((m) => m[1])
    expect(words).toContain('live')
    for (const word of words) {
      expect(REGISTERED.has(word), `\`ralph ${word}\` is not a registered command`).toBe(true)
    }
  })
})
