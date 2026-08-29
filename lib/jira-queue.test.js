// #126 — the spec for the Jira queue depth. NO TEST HERE RUNS A REAL `acli`: `exec` is an
// injected seam, asserted the same way lib/jira-auth.test.js asserts the auth probe, and for
// the same reason — a diagnostic or a status view that needs a Jira session to be TESTABLE is
// a diagnostic nobody can run in CI.
//
// WHAT IS BEING ASSERTED, in two halves:
//
//   the ARGV — the interface to acli. This module is the single place in Ralph that knows
//   `acli` exists, so the command it runs is a claim worth pinning: a typo in a subcommand is
//   a queue that is permanently empty rather than an error anybody sees.
//
//   the DEGRADATION — every failure answers 0, and nothing propagates. `ralph cycle` reads
//   this number to decide whether there is work; a throw would abort a scheduled run, and a
//   guess would send the loop at a ticket it cannot see. Zero means "no work I can prove",
//   which is the reading that costs a cycle and never a wrong one.
//
// ...and a third, added when `ralph status` needed the other reading: the PROVENANCE. Since 0
// means both "acli said zero" and "nobody could take a count", a read-only view cannot use the
// number — `0 waiting` is a claim about the Jira board. `queueCountResult` reports the same
// single probe with that ambiguity removed, and `queueCount` is its lossy wrapper; the last
// suite in this file pins the two to one probe so they cannot drift.

import { describe, expect, it, vi } from 'vitest'
import {
  claimTask,
  commentTask,
  completeTask,
  queueCount,
  queueCountResult,
  queuePick,
} from './jira-queue.js'
import { composeJiraJql, JIRA_DONE_LABEL, JIRA_IN_PROGRESS_LABEL } from './jira-jql.js'

const JQL = 'project = RALPH AND statusCategory != Done'
const COMPOSED = composeJiraJql(JQL).jql
const ok = (stdout) => vi.fn(async () => ({ exitCode: 0, stdout, stderr: '' }))

describe('queueCount — the composed query, counted by acli (#126)', () => {
  it('runs the COMPOSED jql with --count and returns the integer acli reports', async () => {
    const exec = ok('7\n')
    expect(await queueCount(JQL, { exec })).toBe(7)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(
      'acli',
      ['jira', 'workitem', 'search', '--jql', COMPOSED, '--count'],
      expect.objectContaining({ reject: false }),
    )
  })

  it('sends Ralph’s half of the query, not the user’s clause alone', async () => {
    const exec = ok('7')
    await queueCount(JQL, { exec })
    const argv = exec.mock.calls[0][1]
    const sent = argv[argv.indexOf('--jql') + 1]
    expect(sent).toContain(JQL)
    expect(sent).toContain('labels NOT IN (in-progress, done, failed, do-not-ralph)')
    expect(sent.endsWith('ORDER BY created ASC')).toBe(true)
  })

  it('counts zero as zero — an empty queue is an answer, not a failure', async () => {
    expect(await queueCount(JQL, { exec: ok('0\n') })).toBe(0)
  })

  it('reads a count of any size, and leading zeros', async () => {
    expect(await queueCount(JQL, { exec: ok('  12  ') })).toBe(12)
    expect(await queueCount(JQL, { exec: ok('007') })).toBe(7)
    expect(await queueCount(JQL, { exec: ok('1000') })).toBe(1000)
    // A Buffer is what a spawner hands back when nobody asked for an encoding.
    expect(await queueCount(JQL, { exec: ok(Buffer.from('4\n')) })).toBe(4)
  })
})

describe('queueCount — a misconfigured JIRA_JQL never reaches acli', () => {
  // The refusal lives in jira-jql.js; this is the assertion that this module HEEDS it. A
  // bare `labels NOT IN (...)` would count every ticket on the site, so the process is
  // never even started: no query, no count, no cycle.
  for (const [label, jql] of [
    ['nothing at all', undefined],
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   \t\n'],
    ['an ordering with no eligibility clause', 'ORDER BY created ASC'],
    ['a non-string', 42],
  ]) {
    it(`answers 0 and spawns nothing for ${label}`, async () => {
      const exec = vi.fn(async () => ({ exitCode: 0, stdout: '99', stderr: '' }))
      expect(await queueCount(jql, { exec })).toBe(0)
      expect(exec).not.toHaveBeenCalled()
    })
  }
})

describe('queueCount — degrades to 0, never throws', () => {
  it('answers 0 on a non-zero exit, whatever it printed', async () => {
    const exec = vi.fn(async () => ({ exitCode: 1, stdout: '9', stderr: 'unknown flag' }))
    expect(await queueCount(JQL, { exec })).toBe(0)
  })

  it('answers 0 when the session is not authenticated', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 2,
      stdout: '',
      stderr: 'You are not logged in. Run `acli jira auth login`.',
    }))
    expect(await queueCount(JQL, { exec })).toBe(0)
  })

  it('answers 0 when acli is absent or the spawn fails', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('ENOENT: acli not found')
    })
    expect(await queueCount(JQL, { exec: throwing })).toBe(0)
    const rejecting = vi.fn(() => Promise.reject(new Error('boom')))
    expect(await queueCount(JQL, { exec: rejecting })).toBe(0)
  })

  it('answers 0 when there is no exec to run — this module imports no spawner', async () => {
    // Same posture as lib/jira-auth.js: the seam has NO DEFAULT in the library, so a caller
    // that supplies none cannot count anything, and 0 is the safe reading rather than a crash.
    expect(await queueCount(JQL)).toBe(0)
    expect(await queueCount(JQL, {})).toBe(0)
    expect(await queueCount(JQL, { exec: 'not a function' })).toBe(0)
  })

  it('answers 0 for output no count can be read out of', async () => {
    const unparseable = [
      '',
      '   \n',
      'seven',
      'NaN',
      'Total: 7',
      '7 work items',
      '1.5',
      '-3',
      '0x10',
      '1e3',
      '7,000',
      // Bigger than a JS integer can carry exactly — a number nobody should act on.
      '9'.repeat(30),
      undefined,
      null,
      {},
    ]
    for (const stdout of unparseable) {
      const exec = vi.fn(async () => ({ exitCode: 0, stdout, stderr: '' }))
      expect(await queueCount(JQL, { exec }), JSON.stringify(stdout)).toBe(0)
    }
  })

  it('answers 0 when exec resolves to nothing at all', async () => {
    expect(await queueCount(JQL, { exec: vi.fn(async () => undefined) })).toBe(0)
    expect(await queueCount(JQL, { exec: vi.fn(async () => null) })).toBe(0)
  })

  it('a result MISSING exitCode is not a success (undefined !== 0)', async () => {
    const exec = vi.fn(async () => ({ stdout: '9', stderr: '' }))
    expect(await queueCount(JQL, { exec })).toBe(0)
  })

  it('a STRING "0" exitCode is not a success either (strict === 0)', async () => {
    const exec = vi.fn(async () => ({ exitCode: '0', stdout: '9', stderr: '' }))
    expect(await queueCount(JQL, { exec })).toBe(0)
  })
})

describe('queueCountResult — the same probe, with its provenance', () => {
  // What `ralph status` consumes, and the reason it exists: `0` is TWO findings under
  // queueCount's contract — an empty Jira board, and a count nobody could take — and a
  // read-only view has to tell the reader which one it is looking at.

  it('reports a real count as ok, with no reason to give', async () => {
    const exec = ok('7\n')
    expect(await queueCountResult(JQL, { exec })).toEqual({ ok: true, count: 7, reason: null })
    expect(exec).toHaveBeenCalledWith(
      'acli',
      ['jira', 'workitem', 'search', '--jql', COMPOSED, '--count'],
      expect.objectContaining({ reject: false }),
    )
  })

  it('reports a REAL empty queue as ok with a count of 0 — not as a failure', async () => {
    // The half that makes the other half meaningful: acli reporting zero IS an answer, so a
    // view must render it as `0 waiting` rather than as `unknown`.
    expect(await queueCountResult(JQL, { exec: ok('0\n') })).toEqual({
      ok: true,
      count: 0,
      reason: null,
    })
  })

  // Every way there is no count, and none of them may look like the empty queue above.
  //
  // `a timeout` is defensive rather than reachable, and says so here so it does not read as
  // "timeouts are handled": nothing passes a `timeout` option to the spawner (the only option
  // is `reject: false`), so execa never produces that shape today. The genuine wart is the
  // opposite one — a wedged `acli` hangs `ralph status` and `ralph cycle` for as long as it
  // wants, with no deadline anywhere. Adding one is a follow-up, not part of #126.
  const noCountShapes = {
    'a misconfigured query (nothing to run)': { jql: '', exec: ok('99') },
    'a non-zero exit': { exec: vi.fn(async () => ({ exitCode: 1, stdout: '9' })) },
    'a logged-out session': { exec: vi.fn(async () => ({ exitCode: 2, stderr: 'not logged in' })) },
    'an execa ENOENT shape with no exitCode at all': { exec: vi.fn(async () => ({ failed: true })) },
    'a timeout': { exec: vi.fn(async () => ({ timedOut: true, failed: true, stdout: '' })) },
    'a spawn that resolved to nothing': { exec: vi.fn(async () => undefined) },
    'a clean exit with empty stdout': { exec: ok('') },
    'a clean exit with only whitespace': { exec: ok('   ') },
    'a clean exit printing prose': { exec: ok('unknown flag: --count') },
    'a spawner that throws': {
      exec: vi.fn(async () => {
        throw new Error('ENOENT: acli not found')
      }),
    },
    'a stdout that explodes when read': {
      exec: vi.fn(async () => ({
        exitCode: 0,
        get stdout() {
          throw new Error('stream already destroyed')
        },
      })),
    },
    'no spawner at all': { exec: undefined },
  }

  for (const [label, { jql = JQL, exec }] of Object.entries(noCountShapes)) {
    it(`reports NO COUNT, with a reason a human can act on, for ${label}`, async () => {
      const result = await queueCountResult(jql, { exec })
      expect(result.ok, label).toBe(false)
      // `count` is null rather than 0, so a caller that forgets to check `ok` cannot render a
      // failure as an empty board by accident.
      expect(result.count, label).toBe(null)
      expect(typeof result.reason, label).toBe('string')
      expect(result.reason.length, label).toBeGreaterThan(0)
    })
  }

  it('forwards the composer’s own sentence for a misconfigured query, and spawns nothing', async () => {
    // The reason names the knob to go and fix (JIRA_JQL) rather than blaming acli, which was
    // never started — the composer already writes that sentence, so it is passed through.
    const exec = vi.fn(() => {
      throw new Error('acli must not be reached for a misconfigured query')
    })
    const result = await queueCountResult('   ', { exec })
    expect(result.reason).toBe(composeJiraJql('   ').reason)
    expect(result.reason).toContain('JIRA_JQL')
    expect(exec).not.toHaveBeenCalled()
  })

  it('never throws for any of those shapes, exactly like queueCount', async () => {
    for (const [label, { jql = JQL, exec }] of Object.entries(noCountShapes)) {
      await expect(queueCountResult(jql, { exec }), label).resolves.toBeTruthy()
    }
  })
})

describe('one probe, two readings (#126)', () => {
  // The structural claim: queueCount is `ok ? count : 0` over queueCountResult, not a second
  // copy of the logic. A new failure mode therefore has to be handled once, and the scheduler's
  // conflation of "zero" with "unknown" cannot leak into the view's reading or vice versa.

  it('queueCount answers exactly what the result-shaped probe says, read as a number', async () => {
    const stdouts = ['7', '0', '', '   ', 'seven', '1.5', '-3', '9'.repeat(30)]
    for (const stdout of stdouts) {
      const forNumber = ok(stdout)
      const forResult = ok(stdout)
      const number = await queueCount(JQL, { exec: forNumber })
      const result = await queueCountResult(JQL, { exec: forResult })
      expect(number, JSON.stringify(stdout)).toBe(result.ok ? result.count : 0)
      // ...and one probe per call, either way: no double spawn hiding behind the wrapper.
      expect(forNumber, JSON.stringify(stdout)).toHaveBeenCalledTimes(1)
    }
  })

  it('spawns nothing at all when there is nothing to ask, through either entry point', async () => {
    const forNumber = vi.fn(async () => ({ exitCode: 0, stdout: '99' }))
    const forResult = vi.fn(async () => ({ exitCode: 0, stdout: '99' }))
    expect(await queueCount('', { exec: forNumber })).toBe(0)
    expect((await queueCountResult('', { exec: forResult })).ok).toBe(false)
    expect(forNumber).not.toHaveBeenCalled()
    expect(forResult).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// #127 — SELECTION AND THE CLAIM. Same two halves as the count above (the ARGV is the
// interface to acli; every failure is a degradation rather than a throw), plus a third
// this slice introduces: the WRITE.
//
// A claim is the first thing Ralph does to somebody's Jira board, and `acli jira workitem
// edit --labels` is documented only as "Edit the labels" — whether it APPENDS or REPLACES
// is not something this repo can verify, since no test here may spawn a real acli and CI
// has none. So `claimTask` is read-then-union by construction, and the tests below assert
// the union rather than the append: a ticket carrying `frontend, p2` must still carry both
// afterwards under EITHER semantics, which is the only way to be right without knowing.
// ---------------------------------------------------------------------------

const KEY = 'FOO-123'
const SUMMARY = 'Do the thing'

// The acli subcommand an invocation names (`['jira', 'workitem', <sub>, ...]`), so the
// assertions below can talk about "the read" and "the write" rather than about call
// indices — claimTask runs two processes and the relationship between them is the point.
const subOf = (argv) => argv[2]
const argvsFor = (exec, sub) =>
  exec.mock.calls.map(([, argv]) => argv).filter((argv) => subOf(argv) === sub)

// One search result, in the shape the Jira REST API wraps a work item in and acli is a
// client of: `key` beside a `fields` object. The other shapes acli might print are
// exercised in their own test below.
const searchJson = (...items) => JSON.stringify(items)
const item = (key = KEY, summary = SUMMARY) => ({ key, fields: { summary } })

// A recording spawner that answers per subcommand, defaulting the read to a ticket with no
// labels and the write to a clean exit. Overrides take a result object, or a function of
// the argv when a test needs to answer differently the second time.
const claimExec = ({ view, edit } = {}) =>
  vi.fn(async (_bin, argv) => {
    const answer = subOf(argv) === 'view' ? view : subOf(argv) === 'edit' ? edit : undefined
    const fallback =
      subOf(argv) === 'view'
        ? { exitCode: 0, stdout: '{"key":"FOO-123","fields":{"labels":[]}}', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    if (answer === undefined) return fallback
    return typeof answer === 'function' ? answer(argv) : answer
  })

describe('queuePick — the top ticket of the composed query (#127)', () => {
  it('runs the COMPOSED jql with --limit 1 and returns the first result', async () => {
    const exec = ok(searchJson(item()))
    expect(await queuePick(JQL, { exec })).toEqual({ key: KEY, summary: SUMMARY })
    expect(exec).toHaveBeenCalledTimes(1)
    const [bin, argv, options] = exec.mock.calls[0]
    expect(bin).toBe('acli')
    expect(argv).toEqual([
      'jira',
      'workitem',
      'search',
      '--jql',
      COMPOSED,
      '--limit',
      '1',
      '--json',
      '--fields',
      'key,summary',
    ])
    expect(options).toMatchObject({ reject: false })
  })

  it('asks for only the fields acli’s `search` allows, and still orders by created ASC', async () => {
    // The acli constraint #127 names: `--fields` on `search` accepts only issuetype, key,
    // assignee, priority, status, summary, reporter and labels. It restricts the fields
    // FETCHED and says nothing about ORDER BY, so the drain guarantee survives it.
    const exec = ok(searchJson(item()))
    await queuePick(JQL, { exec })
    const argv = exec.mock.calls[0][1]
    const fields = argv[argv.indexOf('--fields') + 1].split(',')
    const ALLOWED = ['issuetype', 'key', 'assignee', 'priority', 'status', 'summary', 'reporter', 'labels']
    for (const field of fields) expect(ALLOWED, field).toContain(field)
    expect(argv[argv.indexOf('--jql') + 1].endsWith('ORDER BY created ASC')).toBe(true)
  })

  it('takes the FIRST result when acli answers with more than one', async () => {
    const exec = ok(searchJson(item('FOO-1', 'first'), item('FOO-2', 'second')))
    expect(await queuePick(JQL, { exec })).toEqual({ key: 'FOO-1', summary: 'first' })
  })

  it('reads the summary whether acli nests it under `fields` or prints it flat', async () => {
    // The envelope acli wraps a work item in is not something this repo can verify, so
    // both shapes are read rather than one being assumed. An unreadable summary is '' —
    // never the string "undefined", which is what a template would have printed.
    expect(await queuePick(JQL, { exec: ok(searchJson({ key: KEY, summary: SUMMARY })) })).toEqual({
      key: KEY,
      summary: SUMMARY,
    })
    expect(await queuePick(JQL, { exec: ok(JSON.stringify({ issues: [item()] })) })).toEqual({
      key: KEY,
      summary: SUMMARY,
    })
    expect(await queuePick(JQL, { exec: ok(searchJson({ key: KEY })) })).toEqual({
      key: KEY,
      summary: '',
    })
  })

  it('returns null for an EMPTY result set — an empty queue is an answer', async () => {
    for (const stdout of ['[]', '{"issues":[]}', '', '   ']) {
      expect(await queuePick(JQL, { exec: ok(stdout) }), JSON.stringify(stdout)).toBe(null)
    }
  })

  it('returns null rather than throwing on every failure acli can hand back', async () => {
    const shapes = {
      'a non-zero exit with JSON on stdout': ok(searchJson(item())),
      'unparseable JSON': ok('{"issues":['),
      'prose instead of JSON': ok('Error: you are not logged in'),
      'JSON that is not a work item at all': ok('{"count":3}'),
      'a result item with no key': ok(searchJson({ fields: { summary: SUMMARY } })),
      'a key that is not a string': ok(searchJson({ key: 123, fields: { summary: SUMMARY } })),
      'a key that is empty': ok(searchJson({ key: '   ' })),
      'stdout that throws when read': vi.fn(async () => ({
        exitCode: 0,
        get stdout() {
          throw new Error('stream destroyed')
        },
      })),
      'nothing at all': vi.fn(async () => undefined),
      'a missing exitCode': vi.fn(async () => ({ stdout: searchJson(item()) })),
      'a spawn that throws (no acli on PATH)': vi.fn(async () => {
        throw new Error('spawn acli ENOENT')
      }),
      'no exec at all — this module imports no spawner': undefined,
    }
    for (const [label, exec] of Object.entries(shapes)) {
      const failing =
        label === 'a non-zero exit with JSON on stdout'
          ? vi.fn(async () => ({ exitCode: 1, stdout: searchJson(item()) }))
          : exec
      await expect(queuePick(JQL, { exec: failing }), label).resolves.toBe(null)
    }
  })

  it('spawns nothing and returns null for a misconfigured JIRA_JQL', async () => {
    for (const jql of [undefined, null, '', '   ', 'ORDER BY created ASC', 42]) {
      const exec = ok(searchJson(item()))
      expect(await queuePick(jql, { exec }), String(jql)).toBe(null)
      expect(exec, String(jql)).not.toHaveBeenCalled()
    }
  })
})

describe('claimTask — read, union, write (#127)', () => {
  it('reads the ticket’s labels, then writes them back WITH in-progress', async () => {
    const exec = claimExec({
      view: { exitCode: 0, stdout: '{"key":"FOO-123","fields":{"labels":["frontend","p2"]}}' },
    })
    const result = await claimTask(KEY, { exec })
    expect(result).toEqual({ ok: true, labels: ['frontend', 'p2', JIRA_IN_PROGRESS_LABEL], reason: null })

    // The read comes first, and it asks for the one field it needs.
    expect(argvsFor(exec, 'view')).toEqual([
      ['jira', 'workitem', 'view', '--key', KEY, '--fields', 'labels', '--json'],
    ])
    // ...and the write carries the UNION. Both of the team's labels survive whether
    // `--labels` appends or replaces, which is the whole reason for the read.
    expect(argvsFor(exec, 'edit')).toEqual([
      ['jira', 'workitem', 'edit', '--key', KEY, '--labels', `frontend,p2,${JIRA_IN_PROGRESS_LABEL}`, '--yes'],
    ])
    expect(subOf(exec.mock.calls[0][1])).toBe('view')
  })

  it('claims a ticket with NO labels — the queue is mostly these', async () => {
    const exec = claimExec({ view: { exitCode: 0, stdout: '{"key":"FOO-123","fields":{"labels":[]}}' } })
    expect(await claimTask(KEY, { exec })).toEqual({
      ok: true,
      labels: [JIRA_IN_PROGRESS_LABEL],
      reason: null,
    })
    const argv = argvsFor(exec, 'edit')[0]
    expect(argv[argv.indexOf('--labels') + 1]).toBe(JIRA_IN_PROGRESS_LABEL)
  })

  it('reads the labels wherever acli’s envelope puts them', async () => {
    const shapes = {
      'nested under fields': '{"fields":{"labels":["a"]}}',
      'flat on the work item': '{"key":"FOO-123","labels":["a"]}',
      'an array of work items': '[{"fields":{"labels":["a"]}}]',
      'wrapped one level deeper': '{"workItem":{"fields":{"labels":["a"]}}}',
    }
    for (const [label, stdout] of Object.entries(shapes)) {
      const exec = claimExec({ view: { exitCode: 0, stdout } })
      expect((await claimTask(KEY, { exec })).labels, label).toEqual(['a', JIRA_IN_PROGRESS_LABEL])
    }
  })

  it('is IDEMPOTENT: an already-claimed ticket is not written again and does not fail', async () => {
    const exec = claimExec({
      view: {
        exitCode: 0,
        stdout: JSON.stringify({ fields: { labels: ['frontend', JIRA_IN_PROGRESS_LABEL] } }),
      },
    })
    expect(await claimTask(KEY, { exec })).toEqual({
      ok: true,
      labels: ['frontend', JIRA_IN_PROGRESS_LABEL],
      reason: null,
    })
    // No duplicate label, and no write at all: the cheapest idempotence is the one that
    // does not touch a board it has nothing to change on.
    expect(argvsFor(exec, 'edit')).toEqual([])
  })

  it('passes --yes on EVERY write, so an unattended run is never blocked on a prompt', async () => {
    const exec = claimExec({ view: { exitCode: 0, stdout: '{"fields":{"labels":["p2"]}}' } })
    await claimTask(KEY, { exec })
    const writes = exec.mock.calls.map(([, argv]) => argv).filter((argv) => subOf(argv) !== 'view')
    expect(writes.length).toBeGreaterThan(0)
    for (const argv of writes) expect(argv, argv.join(' ')).toContain('--yes')
  })

  it('normalizes the key it was handed, and passes an unrecognised one through', async () => {
    const exec = claimExec()
    await claimTask('  foo-123  ', { exec })
    expect(argvsFor(exec, 'view')[0]).toContain('FOO-123')

    // A project key Ralph's grammar does not recognise is still the ticket acli named.
    const odd = claimExec()
    await claimTask('FOO-BAR-1', { exec: odd })
    expect(argvsFor(odd, 'view')[0]).toContain('FOO-BAR-1')
  })

  it('WRITES NOTHING when the read failed — a claim must never wipe labels it could not read', async () => {
    const unreadable = {
      'a non-zero exit': { exitCode: 1, stdout: '' },
      'unparseable JSON': { exitCode: 0, stdout: '{"fields":' },
      'prose instead of JSON': { exitCode: 0, stdout: 'ERROR: no such work item' },
      'nothing at all': undefined,
      'stdout that throws when read': {
        exitCode: 0,
        get stdout() {
          throw new Error('stream destroyed')
        },
      },
    }
    for (const [label, view] of Object.entries(unreadable)) {
      const exec = claimExec({ view: view === undefined ? () => undefined : view })
      const result = await claimTask(KEY, { exec })
      expect(result.ok, label).toBe(false)
      expect(result.labels, label).toBe(null)
      expect(typeof result.reason, label).toBe('string')
      expect(argvsFor(exec, 'edit'), label).toEqual([])
    }
  })

  it('WRITES NOTHING for a label list it could read but not SEND — and says which failure it was', async () => {
    // QA's finding. `[{"name":"frontend"}]` IS an array, so the "no label list" refusal does
    // not fire; every entry is then dropped as unsendable and a bare `--labels in-progress`
    // used to go out, which under replace semantics is the wipe the read exists to prevent.
    // The reason sentence is pinned here because it is the operator's only clue that the
    // ARGV BUILDER needs fixing rather than their board: "no label list" and "a shape Ralph
    // cannot send back" are different findings and must not share a wording.
    for (const labels of ['[{"name":"frontend"},{"name":"p2"}]', '[["frontend"]]', '[42]', '["   "]']) {
      const exec = claimExec({ view: { exitCode: 0, stdout: `{"fields":{"labels":${labels}}}` } })
      const result = await claimTask(KEY, { exec })
      expect(result, labels).toEqual({
        ok: false,
        labels: null,
        reason: `acli spelled ${KEY}'s labels in a shape Ralph cannot send back, so its labels are unknown and were left alone`,
      })
      expect(argvsFor(exec, 'edit'), labels).toEqual([])
    }
  })

  it('tells a list that IS empty from one it emptied — only one of them may be written', async () => {
    // The boundary the fix above must not cross: `labels: []` is the commonest answer in the
    // queue and claims normally, and a PARTIAL drop still claims, because a list with one
    // readable label was read correctly. Both argvs are compared to make the difference the
    // subject of the test rather than a side effect of it.
    const sent = async (labels) => {
      const exec = claimExec({ view: { exitCode: 0, stdout: `{"fields":{"labels":${labels}}}` } })
      await claimTask(KEY, { exec })
      return argvsFor(exec, 'edit').map((argv) => argv[argv.indexOf('--labels') + 1])
    }
    expect(await sent('[]')).toEqual([JIRA_IN_PROGRESS_LABEL])
    expect(await sent('[{"name":"frontend"}]')).toEqual([])
    expect(await sent('["frontend",{"name":"p2"}]')).toEqual([`frontend,${JIRA_IN_PROGRESS_LABEL}`])
  })

  it('reports a failed WRITE honestly, and never throws', async () => {
    const exec = claimExec({
      view: { exitCode: 0, stdout: '{"fields":{"labels":[]}}' },
      edit: { exitCode: 1, stdout: '', stderr: 'permission denied' },
    })
    const result = await claimTask(KEY, { exec })
    expect(result.ok).toBe(false)
    expect(result.labels).toBe(null)
    expect(result.reason).toContain('acli')
  })

  it('never throws for a missing exec, a throwing spawn or an unusable key', async () => {
    const shapes = {
      'no exec at all': [KEY, {}],
      'an exec that throws': [KEY, { exec: () => { throw new Error('spawn acli ENOENT') } }],
      'no key': [undefined, { exec: claimExec() }],
      'an empty key': ['   ', { exec: claimExec() }],
      'a non-string key': [123, { exec: claimExec() }],
    }
    for (const [label, [key, deps]] of Object.entries(shapes)) {
      const result = await claimTask(key, deps)
      expect(result.ok, label).toBe(false)
      expect(typeof result.reason, label).toBe('string')
    }
  })

  it('spawns NOTHING at all when there is no key to claim', async () => {
    const exec = claimExec()
    await claimTask('', { exec })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('a claimed ticket drops out of the next pick BY COMPOSITION (#127)', () => {
  // AC: "a claimed ticket is excluded from the next queuePick by the in-progress clause
  // composed in #126". There is no second Jira to prove that against, and faking one would
  // only prove the fake — so the property is asserted where it actually lives: the label
  // claimTask WRITES is the label the composed query EXCLUDES. One constant, two consumers,
  // and this is the test that would fail if either drifted.
  it('claims the very label the composed query excludes', async () => {
    const exec = claimExec({ view: { exitCode: 0, stdout: '{"fields":{"labels":[]}}' } })
    await claimTask(KEY, { exec })
    const written = argvsFor(exec, 'edit')[0]
    const label = written[written.indexOf('--labels') + 1]
    expect(label).toBe(JIRA_IN_PROGRESS_LABEL)

    const picker = ok(searchJson(item()))
    await queuePick(JQL, { exec: picker })
    const sent = picker.mock.calls[0][1][picker.mock.calls[0][1].indexOf('--jql') + 1]
    expect(sent).toContain(`labels NOT IN (${label},`)
    expect(sent).toContain('OR labels IS EMPTY')
  })
})

// ---------------------------------------------------------------------------
// #129 — COMPLETION. The third write, and the first one whose whole point is that MOST OF
// IT IS ALLOWED TO FAIL.
//
// With no PR and no pushed branch, the Jira ticket is the ONLY audit trail of what Ralph
// changed — which makes the three parts of a completion three different promises:
//
//   THE TRANSITION IS BEST-EFFORT. A Jira workflow can refuse a move: a status with no
//   transition from where the ticket sits, a required field, a validator. Ralph cannot know
//   any project's workflow, so a refusal is a board move it did not get — never a failed
//   task, and never a ticket left in the queue. It warns and carries on.
//
//   THE LABEL IS THE PROMISE. Jira labels are freeform and no workflow rule can refuse one,
//   so `done` is what actually takes the ticket out of the composed query. It is therefore
//   the ONLY part whose failure is reported as a failure.
//
//   THE COMMENT NEVER COUNTS. It is `|| true` in the same sense as the telemetry sidecar in
//   templates/ralph.sh: it may not change a run's outcome and may not throw.
//
// THE TRANSITION-REFUSAL RESPONSE IS CANNED, like every other acli answer in this file. No
// test here runs a real acli — there is none in CI, and a transition is a write to somebody's
// live board — so `--status` and `--remove-labels` and `comment create` are TRANSCRIBED
// spellings, pinned so a correction is one edit.
// ---------------------------------------------------------------------------

const DONE_STATUS = 'Done'

// A stream shaped like `process.stderr` for the one part of completion that reports to a
// human rather than to a caller. The warnings are the whole user interface of a refused
// transition, so they are asserted rather than swallowed.
const recorder = () => {
  const calls = []
  return { calls, write: (text) => calls.push(text) }
}

// A recording spawner for the completion path. FOUR subcommands can arrive — `transition`,
// `view` (the label read), `edit` (both label writes) and `comment` — and each defaults to
// the answer a healthy board gives, with the read defaulting to a CLAIMED ticket because
// that is the only state completion is ever reached from. Overrides take a result object,
// or a function of the argv when a test has to answer the two `edit` writes differently.
const completeExec = ({ transition, view, edit, comment } = {}) =>
  vi.fn(async (_bin, argv) => {
    const answer = { transition, view, edit, comment }[subOf(argv)]
    const fallback =
      subOf(argv) === 'view'
        ? {
            exitCode: 0,
            stdout: JSON.stringify({ key: KEY, fields: { labels: [JIRA_IN_PROGRESS_LABEL] } }),
          }
        : { exitCode: 0, stdout: '', stderr: '' }
    if (answer === undefined) return fallback
    return typeof answer === 'function' ? answer(argv) : answer
  })

// A ticket's labels as acli would print them for the read.
const labelDoc = (...labels) => JSON.stringify({ key: KEY, fields: { labels } })

// The writes, in the order they went out — everything that is not the read.
const writesOf = (exec) =>
  exec.mock.calls.map(([, argv]) => argv).filter((argv) => subOf(argv) !== 'view')

// The `edit` write that carries a given flag, since completion makes two of them.
const editWith = (exec, flag) =>
  argvsFor(exec, 'edit').filter((argv) => argv.includes(flag))

describe('completeTask — transition, done label, in-progress removal (#129)', () => {
  it('does all three, in that order, on the argv Ralph transcribed', async () => {
    const exec = completeExec()
    const stderr = recorder()
    const result = await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr })
    expect(result).toEqual({ ok: true, labels: [JIRA_DONE_LABEL], reason: null })

    // THE ORDER IS THE CLAIM, not just the set: the transition goes first because a board
    // whose workflow still accepts it should get the move before Ralph starts labelling,
    // and `in-progress` comes off LAST because the ticket must never be un-owned and
    // un-done at the same time.
    expect(exec.mock.calls.map(([, argv]) => subOf(argv))).toEqual([
      'transition',
      'view',
      'edit',
      'edit',
    ])
    expect(argvsFor(exec, 'transition')).toEqual([
      ['jira', 'workitem', 'transition', '--key', KEY, '--status', DONE_STATUS, '--yes'],
    ])
    // The label write carries the UNION and not the one new label — the fixture ticket is a
    // CLAIMED one, so it already has `in-progress` on it, and the read-then-union write says
    // both. That is why removal has to be its own call below: this write cannot drop a label,
    // by construction, and a `--labels done` that happened to REPLACE would silently strip
    // every label the team had put on the ticket.
    expect(editWith(exec, '--labels')).toEqual([
      [
        'jira',
        'workitem',
        'edit',
        '--key',
        KEY,
        '--labels',
        `${JIRA_IN_PROGRESS_LABEL},${JIRA_DONE_LABEL}`,
        '--yes',
      ],
    ])
    // `--remove-labels`, NOT a second `--labels`: whether `--labels` appends or replaces is
    // exactly what this repo cannot verify, so removal is spelled with the flag whose
    // meaning is unambiguous.
    expect(editWith(exec, '--remove-labels')).toEqual([
      [
        'jira',
        'workitem',
        'edit',
        '--key',
        KEY,
        '--remove-labels',
        JIRA_IN_PROGRESS_LABEL,
        '--yes',
      ],
    ])
    // A completion that worked says nothing to a human.
    expect(stderr.calls).toEqual([])
  })

  it('adds the label READ-THEN-UNION, so a team’s own labels survive completion', async () => {
    // The same safety property as the claim, for the same unverifiable reason: `--labels`
    // may replace, so a bare `--labels done` could delete every label the team put on the
    // ticket and still look like a successful completion.
    const exec = completeExec({
      view: { exitCode: 0, stdout: labelDoc('frontend', 'p2', JIRA_IN_PROGRESS_LABEL) },
    })
    const result = await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr: recorder() })
    expect(result.ok).toBe(true)
    const written = editWith(exec, '--labels')[0]
    expect(written[written.indexOf('--labels') + 1]).toBe(
      `frontend,p2,${JIRA_IN_PROGRESS_LABEL},${JIRA_DONE_LABEL}`,
    )
    // ...and the reported label set is the ticket AFTER the removal, not the union sent.
    expect(result.labels).toEqual(['frontend', 'p2', JIRA_DONE_LABEL])
  })

  it('passes --yes on EVERY write it makes, so an unattended run is never blocked', async () => {
    // Three writes, all of them unattended. This runs in a detached tmux pane with no
    // terminal to answer on, so one acli that stopped to confirm would hang the iteration
    // until its caller killed it.
    const exec = completeExec({ view: { exitCode: 0, stdout: labelDoc(JIRA_IN_PROGRESS_LABEL) } })
    await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr: recorder() })
    const writes = writesOf(exec)
    expect(writes).toHaveLength(3)
    for (const argv of writes) expect(argv.at(-1), argv.join(' ')).toBe('--yes')
  })

  it('does not remove a label the ticket does not carry', async () => {
    // The cheapest idempotence is the one that does not touch a board it has nothing to
    // change on — the same rule claimTask follows for an already-claimed ticket.
    const exec = completeExec({ view: { exitCode: 0, stdout: labelDoc('frontend') } })
    const result = await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr: recorder() })
    expect(result).toEqual({ ok: true, labels: ['frontend', JIRA_DONE_LABEL], reason: null })
    expect(editWith(exec, '--remove-labels')).toEqual([])
  })

  it('is IDEMPOTENT on a ticket that already carries `done`', async () => {
    const exec = completeExec({
      view: { exitCode: 0, stdout: labelDoc(JIRA_DONE_LABEL, JIRA_IN_PROGRESS_LABEL) },
    })
    const result = await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr: recorder() })
    expect(result.ok).toBe(true)
    expect(editWith(exec, '--labels')).toEqual([])
    // The `in-progress` sweep still runs: a ticket carrying both labels is a half-finished
    // completion, and finishing it is the point.
    expect(editWith(exec, '--remove-labels')).toHaveLength(1)
  })

  it('normalizes the key once, and every write names the SAME ticket', async () => {
    const exec = completeExec()
    await completeTask('  foo-123  ', { doneStatus: DONE_STATUS, exec, stderr: recorder() })
    for (const [, argv] of exec.mock.calls) {
      expect(argv[argv.indexOf('--key') + 1], argv.join(' ')).toBe(KEY)
    }
  })
})

describe('completeTask — a refused transition is a board move lost, never a failed task (#129)', () => {
  // The canned refusal: acli exits non-zero with the sentence a Jira workflow gives when
  // there is no transition to the named status from where the ticket sits.
  const REFUSED = {
    exitCode: 1,
    stdout: '',
    stderr: `Error: transition to "${DONE_STATUS}" is not available for this work item`,
  }

  it('still labels, still succeeds, and warns on stderr naming the refusal', async () => {
    const exec = completeExec({ transition: REFUSED })
    const stderr = recorder()
    const result = await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr })

    // A workflow Ralph cannot drive is not a failed task.
    expect(result).toEqual({ ok: true, labels: [JIRA_DONE_LABEL], reason: null })
    // The label is what guarantees the ticket leaves the queue, so it still went out.
    expect(editWith(exec, '--labels')).toHaveLength(1)
    expect(editWith(exec, '--remove-labels')).toHaveLength(1)

    // ...and the warning is the ONLY record that a human has to move the ticket by hand.
    expect(stderr.calls).toHaveLength(1)
    const warning = stderr.calls[0]
    expect(warning).toContain(KEY)
    expect(warning).toContain(DONE_STATUS)
    expect(warning.toLowerCase()).toMatch(/refus|could not/)
    expect(warning.toLowerCase()).toMatch(/by hand|manual|yourself/)
    // One line, terminated: this shares a stream with the agent's own output.
    expect(warning.endsWith(String.fromCharCode(0x0a))).toBe(true)
    expect(warning.split(String.fromCharCode(0x0a)).filter(Boolean)).toHaveLength(1)
  })

  it('treats every way a transition can fail the same way — warn, label, succeed', async () => {
    const refusals = {
      'no such transition': REFUSED,
      'a required field': { exitCode: 1, stderr: 'Field "Resolution" is required' },
      'a validator': { exitCode: 2, stderr: 'You do not have permission to transition' },
      'a spawn that never happened': () => undefined,
      'an execa ENOENT shape': () => ({ failed: true }),
      'a spawner that throws': () => {
        throw new Error('spawn acli ENOENT')
      },
    }
    for (const [label, transition] of Object.entries(refusals)) {
      const exec = completeExec({ transition })
      const stderr = recorder()
      const result = await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr })
      expect(result.ok, label).toBe(true)
      expect(result.labels, label).toEqual([JIRA_DONE_LABEL])
      expect(stderr.calls, label).toHaveLength(1)
    }
  })

  it('SKIPS the transition entirely for an unset or empty done status, and warns ONCE', async () => {
    // Not an abort. A repo that never set JIRA_DONE_STATUS still wants its ticket labelled
    // and commented — the label is what drains the queue — so the missing knob costs one
    // board move and one line of output.
    for (const doneStatus of [undefined, '', '   ', null, 42]) {
      const exec = completeExec()
      const stderr = recorder()
      const result = await completeTask(KEY, { doneStatus, exec, stderr })
      expect(result.ok, String(doneStatus)).toBe(true)
      expect(result.labels, String(doneStatus)).toEqual([JIRA_DONE_LABEL])
      // No process at all for the move it is not making.
      expect(argvsFor(exec, 'transition'), String(doneStatus)).toEqual([])
      expect(editWith(exec, '--labels'), String(doneStatus)).toHaveLength(1)
      // ONCE — a per-write reminder would bury the one line that matters.
      expect(stderr.calls, String(doneStatus)).toHaveLength(1)
      expect(stderr.calls[0]).toContain('JIRA_DONE_STATUS')
    }
  })
})

describe('completeTask — the exclusion label is the ONLY reportable failure (#129)', () => {
  it('reports failure when the label cannot be WRITTEN — the ticket would stay in the queue', async () => {
    const exec = completeExec({
      edit: (argv) =>
        argv.includes('--labels')
          ? { exitCode: 1, stdout: '', stderr: 'permission denied' }
          : { exitCode: 0, stdout: '' },
    })
    const result = await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr: recorder() })
    expect(result.ok).toBe(false)
    expect(result.labels).toBe(null)
    expect(result.reason).toContain(KEY)
    expect(result.reason).toContain(JIRA_DONE_LABEL)
    // Nothing is removed after a failed add: a ticket that lost `in-progress` without
    // gaining `done` is a ticket back in the queue with no owner.
    expect(editWith(exec, '--remove-labels')).toEqual([])
  })

  it('reports failure when the label list could not be READ, and writes nothing at all', async () => {
    // Same rule as the claim: an unreadable label list means the current labels are
    // UNKNOWN, and a union built on that guess is the wipe the read exists to prevent.
    const unreadable = {
      'a non-zero exit': { exitCode: 1, stdout: '' },
      'unparseable JSON': { exitCode: 0, stdout: '{"fields":' },
      'prose instead of JSON': { exitCode: 0, stdout: 'ERROR: no such work item' },
      'no label list in the answer': { exitCode: 0, stdout: '{"key":"FOO-123"}' },
      'a list Ralph cannot send back': { exitCode: 0, stdout: '{"fields":{"labels":[{"name":"a"}]}}' },
    }
    for (const [label, view] of Object.entries(unreadable)) {
      const exec = completeExec({ view })
      const result = await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr: recorder() })
      expect(result.ok, label).toBe(false)
      expect(result.labels, label).toBe(null)
      expect(typeof result.reason, label).toBe('string')
      expect(argvsFor(exec, 'edit'), label).toEqual([])
    }
  })

  it('reports SUCCESS when only the in-progress removal failed', async () => {
    // The ticket carries `done`, so it is out of the composed query whatever happens to the
    // other label — a stale `in-progress` beside a `done` is untidy, not a failed task.
    const exec = completeExec({
      edit: (argv) =>
        argv.includes('--remove-labels')
          ? { exitCode: 1, stdout: '', stderr: 'permission denied' }
          : { exitCode: 0, stdout: '' },
    })
    const stderr = recorder()
    const result = await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr })
    expect(result.ok).toBe(true)
    // Reported honestly: the label is still on the ticket, so it is still in the answer.
    expect(result.labels).toEqual([JIRA_IN_PROGRESS_LABEL, JIRA_DONE_LABEL])
    expect(stderr.calls).toHaveLength(1)
    expect(stderr.calls[0]).toContain(JIRA_IN_PROGRESS_LABEL)
  })

  it('never throws, and spawns NOTHING when there is no key to complete', async () => {
    const exec = completeExec()
    const noKey = await completeTask('', { doneStatus: DONE_STATUS, exec, stderr: recorder() })
    expect(noKey.ok).toBe(false)
    expect(typeof noKey.reason).toBe('string')
    expect(exec).not.toHaveBeenCalled()

    // No deps bag at all — the `= {}` default, exercised on the one input that reaches no
    // stream and no process: an unusable key is refused before anything is warned about.
    for (const key of ['', undefined, null, '   ', 123, {}, [], Symbol('FOO-1')]) {
      const result = await completeTask(key)
      expect(result.ok, String(typeof key)).toBe(false)
      expect(result.labels, String(typeof key)).toBe(null)
      expect(typeof result.reason, String(typeof key)).toBe('string')
    }

    for (const [label, deps] of Object.entries({
      'no exec at all': { doneStatus: DONE_STATUS, stderr: recorder() },
      'an exec that throws': {
        doneStatus: DONE_STATUS,
        stderr: recorder(),
        exec: () => {
          throw new Error('spawn acli ENOENT')
        },
      },
      'an exec that is not callable': { doneStatus: DONE_STATUS, stderr: recorder(), exec: 'acli' },
      'a stderr that throws on write': {
        doneStatus: '',
        exec: completeExec(),
        stderr: {
          write() {
            throw new Error('stream already destroyed')
          },
        },
      },
    })) {
      const result = await completeTask(KEY, deps)
      // The last row is the only one that SUCCEEDS: a stream that cannot be written to is not
      // a reason to fail a completion, so the label still went on and the warning was lost.
      expect(typeof result.ok, label).toBe('boolean')
      expect(result.ok, label).toBe(label === 'a stderr that throws on write')
    }
  })
})

describe('commentTask — the only audit trail, and it may never cost a run (#129)', () => {
  const BODY = 'Resolved by Ralph in 1a2b3c4 on main. Tests: 2431 passed.'

  it('posts the body on the transcribed `comment create` argv', async () => {
    const exec = completeExec()
    expect(await commentTask(KEY, BODY, { exec })).toEqual({ ok: true, reason: null })
    expect(exec.mock.calls).toEqual([
      [
        'acli',
        ['jira', 'workitem', 'comment', 'create', '--key', KEY, '--body', BODY, '--yes'],
        { reject: false },
      ],
    ])
  })

  it('sends the body as ONE argv element, however it is spelled', async () => {
    // A commit summary carries newlines, backticks, quotes and parentheses. As one element
    // it reaches acli's own parser untouched; there is no shell anywhere in the options, so
    // none of it can be re-read as syntax.
    const body = ['## Ralph', '', 'SHA `1a2b3c4`; "quoted"; $(echo hi)'].join(
      String.fromCharCode(0x0a),
    )
    const exec = completeExec()
    await commentTask(KEY, body, { exec })
    const [, argv, options] = exec.mock.calls[0]
    expect(argv[argv.indexOf('--body') + 1]).toBe(body)
    expect(options).toEqual({ reject: false })
  })

  it('reports a failure as a VALUE for every way acli can refuse, and never throws', async () => {
    const shapes = {
      'a non-zero exit': completeExec({ comment: { exitCode: 1, stderr: 'permission denied' } }),
      'a logged-out session': completeExec({ comment: { exitCode: 2, stderr: 'not logged in' } }),
      'an execa ENOENT shape': completeExec({ comment: { failed: true } }),
      'nothing at all': vi.fn(async () => undefined),
      'a spawner that throws': vi.fn(async () => {
        throw new Error('spawn acli ENOENT')
      }),
      'no spawner at all': undefined,
    }
    for (const [label, exec] of Object.entries(shapes)) {
      const result = await commentTask(KEY, BODY, { exec })
      expect(result.ok, label).toBe(false)
      expect(typeof result.reason, label).toBe('string')
    }
    // ...including the shapes that are the CALLER's mistake rather than acli's.
    for (const [key, body] of [
      ['', BODY],
      [undefined, BODY],
      [KEY, ''],
      [KEY, '   '],
      [KEY, undefined],
      [KEY, 42],
    ]) {
      const exec = completeExec()
      const result = await commentTask(key, body, { exec })
      expect(result.ok, `${key} / ${body}`).toBe(false)
      // Nothing empty is posted: a comment that says nothing is worse than none, because it
      // reads on the board as Ralph having recorded something.
      expect(exec, `${key} / ${body}`).not.toHaveBeenCalled()
    }
  })

  it('cannot change what completeTask already reported — they are separate calls', async () => {
    // The `|| true` posture, stated structurally: completion's verdict is computed from the
    // label write and nothing else, so a comment that failed afterwards has nothing to
    // change. Asserted as two calls over one spawner, which is how the CLI and the prompt
    // sequence them.
    const exec = completeExec({ comment: { exitCode: 1, stderr: 'permission denied' } })
    const completed = await completeTask(KEY, {
      doneStatus: DONE_STATUS,
      exec,
      stderr: recorder(),
    })
    const commented = await commentTask(KEY, BODY, { exec })
    expect(completed.ok).toBe(true)
    expect(commented.ok).toBe(false)
  })
})

describe('a completed ticket drops out of the next pick BY COMPOSITION (#129)', () => {
  // The #127 test's twin, and the same argument: there is no second Jira to prove exclusion
  // against, so the property is asserted where it lives — the label completeTask WRITES is a
  // label the composed query REFUSES.
  it('labels the very label the composed query excludes', async () => {
    const exec = completeExec({ view: { exitCode: 0, stdout: labelDoc() } })
    await completeTask(KEY, { doneStatus: DONE_STATUS, exec, stderr: recorder() })
    const written = editWith(exec, '--labels')[0]
    const label = written[written.indexOf('--labels') + 1]
    expect(label).toBe(JIRA_DONE_LABEL)

    const picker = ok(searchJson(item()))
    await queuePick(JQL, { exec: picker })
    const argv = picker.mock.calls[0][1]
    const sent = argv[argv.indexOf('--jql') + 1]
    expect(sent).toContain(`, ${label},`)
    expect(sent).toContain('labels NOT IN (')
    expect(sent).toContain('OR labels IS EMPTY')
  })
})
