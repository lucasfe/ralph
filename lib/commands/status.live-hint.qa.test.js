import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderStatus, statusCommand } from './status.js'
import { RALPH_HOME } from '../paths.js'
import { fenced } from '../../test/helpers/doc-guard.js'

// QA augmentation for #169 — `ralph status`'s attach row. The dev's
// ./status.live-hint.test.js pins the row's text, its height, the scheduled branch and the
// three modes that have no session. What is attacked here is the SHAPE the issue chose and
// the promises that shape has to keep:
//
//   1. THE PARENTHETICAL IS A NEW GRAMMAR ON THAT ROW, and the row's value now has to be
//      read apart from it: a user copies `tmux attach -t <session>` out from between the
//      brackets. `sessionNameFor` reduces a DERIVED name to `[A-Za-z0-9_-]`, but this row
//      does not print a derived name — status.js:317 prefers the session RECORDED in
//      .ralph/run-state.json, which is a JSON string nobody sanitises (status.qa.test.js:178
//      already drives a `;`-bearing one through the probe). So a `)` in that record reaches
//      the brackets, and the battery below asserts the command is still recoverable from
//      the row for every hostile spelling — the FIRST `(` and the LAST `)` bound it.
//   2. THE COLUMN IS A PROPERTY, NOT A LITERAL. The row belongs to a block of six
//      key/value rows, and the reason #169 refused a continuation line is that a second
//      line under `attach` would read as a seventh key. So the column is asserted as
//      "wherever `kill` and `queue` put their values" rather than as 13 — a relabelled
//      `attach` that forgets to repad fails here rather than silently stepping out of line.
//   3. NEITHER SPELLING MAY LEAK WHERE THERE IS NO SESSION. `--json` is a machine surface
//      (status.json.qa.test.js:862 already sweeps `tmux attach` out of it) and the
//      scheduled/interrupted/idle/never-run views describe a run with nothing to attach to.
//      `ralph live` is now a second string that must be absent from all five, and it is
//      swept through the WHOLE command rather than through the pure renderer alone.
//   4. THE ROW ADVERTISES A REAL COMMAND. Both halves are checked against something
//      outside this file: `ralph live` against the command table in bin/ralph.js, and the
//      whole row against the transcript in README.md, so neither the CLI nor the docs can
//      drift away from what the view prints.
//
// Hermetic: `renderStatus` is pure, and every statusCommand case injects `exec`, `exists`,
// `readFile`, `readRunState`, `folderQueueCount`, `peekLock`, `now` and `processEnv`.
// README.md and bin/ralph.js are read off disk READ-ONLY, the established shape of a docs
// guard here (lib/commands/cycle.update-docs.test.js:42).

const REPO = '/repo'
// The README's own example session, so the transcript tests below need no second fixture
// and no substitution to compare against.
const SESSION = 'ralph-ralph-b36ff7b1'

const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime()

const running = (overrides = {}) => ({
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

const view = (overrides = {}) =>
  renderStatus({
    mode: 'running',
    record: running(),
    session: SESSION,
    queue: 6,
    now: NOW,
    ...overrides,
  })

// THE VALUE COLUMN, measured off whatever row it is handed: two spaces, a lowercase key,
// then padding. Used to compare the attach row against its NEIGHBOURS rather than against
// a number, which is the whole point — the block is only aligned if they agree.
const valueColOf = (row) => row.length - row.replace(/^ {2}[a-z]+ +/, '').length
const rowFor = (lines, key) => lines.find((l) => l.startsWith(`  ${key} `))

// What a reader does with the row: take everything between the first `(` and the last `)`
// and paste it into a shell. Written as the reader's rule, not as the renderer's template,
// so it is a statement about the row being unambiguous rather than a restatement of it.
const bracketed = (row) => row.slice(row.indexOf('(') + 1, row.lastIndexOf(')'))

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return false
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

// tmux answers 0 (a live session) by default; a test that wants the scheduled or the
// interrupted branch hands over a dead probe instead.
function makeExec({ tmuxResult = { exitCode: 0 }, ghResult = { exitCode: 0, stdout: '6' } } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux') return tmuxResult
    if (cmd === 'gh') return ghResult
    return { exitCode: 0, stdout: '' }
  }
  exec.calls = calls
  exec.of = (cmd) => calls.filter((c) => c.cmd === cmd)
  return exec
}

const deps = (overrides = {}) => {
  const stdout = makeStream()
  return {
    cwd: REPO,
    stdout,
    exec: makeExec(),
    exists: () => false,
    readFile: () => '',
    readRunState: () => running(),
    folderQueueCount: async () => 6,
    peekLock: () => null,
    now: () => NOW,
    // The identity box off, so every assertion below is about the report (#76).
    processEnv: { RALPH_BANNER: 'off' },
    ...overrides,
  }
}

// The two strings the row now carries. Every negative sweep in this file names BOTH: #169
// gave the hint a second spelling, so a view that dropped `tmux attach` and kept `ralph
// live` would pass a one-token sweep while still advertising an attach that cannot happen.
const HINTS = ['ralph live', 'tmux attach']

describe('QA #169 — the attach row lands on the column its neighbours use', () => {
  it('puts `ralph live` where `queue`, `pace`, `spend` and `kill` put their values', () => {
    // Derived, not spelled: the row is aligned if and only if it agrees with the block it
    // is in, so a future `attach:`→`watch:` relabel that forgets to repad fails right here.
    const lines = view({ attachable: true })
    const keys = ['queue', 'pace', 'eta', 'spend', 'attach', 'kill']
    const cols = keys.map((key) => {
      const row = rowFor(lines, key)
      expect(row, `no ${key} row in:\n${lines.join('\n')}`).toBeTruthy()
      return valueColOf(row)
    })
    expect(new Set(cols), `columns: ${cols.join(',')}`).toEqual(new Set([cols[0]]))
    // ...and the value at that column starts with the shortcut, with the parenthetical
    // BEHIND it. `ralph live` leading is the acceptance criterion; this is where it is
    // measured against the column rather than against a prefix literal.
    expect(rowFor(lines, 'attach').slice(cols[0])).toMatch(/^ralph live {2}\(tmux attach -t /)
  })

  it('costs the view no line, measured against the branch that has no session', () => {
    // Both branches push exactly two rows, which is the trade #169 made: the tmux command
    // rides in brackets instead of on a continuation line. Asserted as an EQUALITY between
    // the two branches rather than as `13`, so the claim survives the next row the live
    // view grows.
    expect(view({ attachable: true })).toHaveLength(view({ attachable: false }).length)
    expect(rowFor(view({ attachable: true }), 'attach')).not.toContain('\n')
  })

  it('keeps the row one row: nothing in the view is a bare continuation line', () => {
    // The failure #169 traded the parenthetical away to avoid — a line under `attach` with
    // no key on it, which this block's grammar would read as a seventh key. The task table
    // is excluded by its own leading `#`/`task` and the heading by its `▸`.
    for (const line of view({ attachable: true })) {
      if (line === '' || line.startsWith('▸') || /^ {2}(task|#)/.test(line)) continue
      expect(line, line).toMatch(/^ {2}[a-z]/)
    }
  })
})

describe('QA #169 — the parenthetical stays readable for a hostile recorded session', () => {
  // Every one of these reaches the row: status.js:317 prefers `record.session`, and the
  // record is JSON on disk that nothing sanitises. The claim is not that the name is
  // pretty — it is that a reader can still tell WHICH command the row is offering and
  // paste it back out whole.
  const hostile = {
    'a name that closes the bracket itself': 'ralph-repo)',
    'a name that opens a second bracket': 'ralph-repo(x',
    'a name that fakes a whole second parenthetical': 'foo) ralph live (bar',
    'nothing but brackets': '((()))',
    'a shell metacharacter run (status.qa.test.js:178)': 'ralph-repo; rm -rf $HOME #',
    'inner whitespace': 'ralph repo  live',
    'a name that is the shortcut': 'ralph live',
    'a 200-character name': `ralph-${'x'.repeat(194)}`,
    'a single character': 'r',
    'an empty recorded name': '',
    'a newline through the middle': 'ralph-repo\nralph-other',
    'a tab': 'ralph\trepo',
    'unicode': 'ralph-répo-🙈',
  }

  for (const [label, session] of Object.entries(hostile)) {
    it(`still offers one recoverable command when the session is ${label}`, () => {
      const lines = view({ attachable: true, session })
      const row = rowFor(lines, 'attach')
      // The label, then the shortcut, then the bracket — in that order, whatever is inside
      // it. This is what stops a `)`-bearing name reading as "the row ended here". The
      // column comes off the untouched `kill` row rather than being spelled out, so a
      // padding change fails the one alignment test above and not all fourteen of these.
      expect(row.slice(valueColOf(rowFor(lines, 'kill')))).toMatch(/^ralph live {2}\(/)
      expect(row.endsWith(')'), row).toBe(true)
      // ...and the bracketed span is EXACTLY the command, session included. First `(` to
      // last `)`, which is the rule a reader uses and the reason a hostile `)` in the
      // middle cannot truncate the copy.
      expect(bracketed(row)).toBe(`tmux attach -t ${session}`)
      expect(row).toContain(session)
    })
  }

  it('offers the same session the command itself probed', () => {
    // The row is only worth reading if it names the run this view is about. One assertion
    // across the seam: what the brackets tell a user to run is the argv `statusCommand`
    // just ran, `-t` argument and all.
    const session = 'ralph-repo) --kill-server ('
    const d = deps({ readRunState: () => running({ session }) })
    return statusCommand(d).then(() => {
      const probe = d.exec.of('tmux')[0]
      expect(probe.args).toEqual(['has-session', '-t', session])
      const row = d.stdout.lines().find((l) => l.startsWith('  attach '))
      expect(bracketed(row)).toBe(`tmux ${probe.args.join(' ')}`.replace('has-session', 'attach'))
      expect(bracketed(row).endsWith(probe.args[2])).toBe(true)
    })
  })
})

describe('QA #169 — no surface without a session names either half', () => {
  it('keeps both strings out of `ralph status --json`', async () => {
    // #58's document is the machine surface, and advice is not data. The sweep that
    // already exists for `tmux attach` (status.json.qa.test.js:862) has a second token to
    // carry now — a document that grew a `hint` field would pass the old one.
    const d = deps({ json: true })
    const result = await statusCommand(d)
    expect(result.mode).toBe('running')
    const out = d.stdout.output()
    for (const hint of HINTS) expect(out, `--json leaked "${hint}"`).not.toContain(hint)
    // Not vacuous: the document really is the running one, and it still identifies the run
    // — by `run_id`, which is the machine's way of naming what the human row names with a
    // session and a command.
    const doc = JSON.parse(out)
    expect(doc.mode).toBe('running')
    expect(doc.run_id).toBe(SESSION)
  })

  const noSession = {
    // A live `ralph cycle` under launchd: the record says running, tmux says no, and the
    // cycle lock is what proves the run alive. The branch #169 deliberately did not touch.
    'a scheduled cycle run (no tmux session)': {
      exec: makeExec({ tmuxResult: { exitCode: 1 } }),
      peekLock: () => ({ alive: true, holder: { pid: 4242, startedAt: new Date(NOW).toISOString() } }),
      expectMode: 'running',
    },
    // A record still saying `running` with nothing behind it: hard-killed, rebooted.
    'an interrupted run': {
      exec: makeExec({ tmuxResult: { exitCode: 1 } }),
      expectMode: 'interrupted',
    },
    'an idle run (the report card)': {
      readRunState: () => running({ status: 'ok', finished_at: new Date(NOW).toISOString(), ok: 3, failed: 0 }),
      expectMode: 'idle',
    },
    'a repo that never ran': { readRunState: () => null, expectMode: 'never-run' },
  }

  for (const [label, { expectMode, ...overrides }] of Object.entries(noSession)) {
    it(`prints neither string for ${label}`, async () => {
      const d = deps(overrides)
      const result = await statusCommand(d)
      expect(result.mode).toBe(expectMode)
      const out = d.stdout.output()
      for (const hint of HINTS) expect(out, `${label} leaked "${hint}"`).not.toContain(hint)
      // Not a vacuous pass on an empty stdout: something WAS printed for every mode.
      expect(out.length).toBeGreaterThan(0)
    })
  }

  it('never prints the attach pair and the scheduled pair in one view', async () => {
    // Mutually exclusive by construction, and worth pinning: the failure that would put
    // both there is a `lines.push` that forgot its `else`.
    const live = deps()
    await statusCommand(live)
    expect(live.stdout.output()).toContain('  attach     ralph live')
    expect(live.stdout.output()).not.toContain('  scheduled  ')

    const scheduled = deps(noSession['a scheduled cycle run (no tmux session)'])
    await statusCommand(scheduled)
    expect(scheduled.stdout.output()).toContain('  scheduled  ')
    expect(scheduled.stdout.output()).not.toContain('  attach ')
  })

  it('names the shortcut exactly once in the live view', async () => {
    // One row, one mention. Two would mean the pure renderer and the shell both grew a
    // hint, which is how two surfaces start disagreeing about one command.
    const d = deps()
    await statusCommand(d)
    expect(d.stdout.output().split('ralph live').length - 1).toBe(1)
  })
})

describe('QA #169 — the row and the docs cannot drift apart', () => {
  const README = readFileSync(join(RALPH_HOME, 'README.md'), 'utf8')

  // Fenced blocks, contents only, from the shared extractor (test/helpers/doc-guard.js) —
  // the sibling guard in ./start.live-hint.qa.test.js needs the same walk, and a second copy
  // of it here is how the two would start disagreeing about what a transcript is. The
  // comparison below is against the RENDERER, so a block that drifts fails rather than being
  // re-derived from the code it is supposed to document.
  const blocksWith = (needle) => fenced(README).filter((b) => b.some((l) => l.startsWith(needle)))

  it('shows the real attach and kill rows in the running-view transcript', () => {
    const blocks = blocksWith('  attach     ')
    // Exactly one, so the assertion below cannot pass by matching a block nobody edited.
    expect(blocks).toHaveLength(1)
    const rows = blocks[0].slice(-2)
    expect(rows).toEqual(view({ attachable: true }).slice(-2))
  })

  it('shows the real scheduled and logs rows for the branch #169 left alone', () => {
    const blocks = blocksWith('  scheduled  ')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].slice(-2)).toEqual(view({ attachable: false }).slice(-2))
  })

  it('has no pre-#169 attach row left anywhere in it', () => {
    // The whole file, not the transcripts: a screenshot caption or a second worked example
    // carrying the old row would be the drift this suite exists to catch.
    expect(README).not.toContain('attach     tmux attach -t')
  })
})

describe('QA #169 — the row advertises commands that exist', () => {
  // Every `ralph <word>` the view prints, checked against the commander registrations in
  // bin/ralph.js. A row advertising a shortcut that is not a command is worse than a row
  // advertising nothing, and nothing here RUNS the hint it reads — a typo would ship.
  const BIN = readFileSync(new URL('../../bin/ralph.js', import.meta.url), 'utf8')
  const REGISTERED = new Set([...BIN.matchAll(/\.command\('([a-z-]+)'\)/g)].map((m) => m[1]))

  it('found the command table at all', () => {
    // Anchor: an empty set would make every membership test below fail loudly, but a
    // renamed `.command(` call should say so once rather than four times.
    expect(REGISTERED.size).toBeGreaterThan(8)
    expect(REGISTERED.has('live')).toBe(true)
  })

  for (const [label, attachable] of Object.entries({ 'the live view': true, 'the scheduled view': false })) {
    it(`names only registered commands in ${label}`, () => {
      const printed = [...view({ attachable }).join('\n').matchAll(/\bralph ([a-z-]+)/g)].map((m) => m[1])
      expect(printed.length).toBeGreaterThan(0)
      for (const word of printed) {
        expect(REGISTERED.has(word), `\`ralph ${word}\` is not a registered command`).toBe(true)
      }
    })
  }
})
