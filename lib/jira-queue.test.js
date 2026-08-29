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
import { queueCount, queueCountResult } from './jira-queue.js'
import { composeJiraJql } from './jira-jql.js'

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
    expect(sent).toContain('labels NOT IN (in-progress, failed, do-not-ralph)')
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
