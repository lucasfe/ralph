import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureIssueEvent } from './capture-issue-event.js'
import { metricsPath } from './issue-metrics.js'
import { claimText, JIRA_UNRECORDED_CLAIM_PATTERNS } from '../test/helpers/doc-guard.js'

// QA augmentation for #565. The dev's capture-issue-event.test.js locks the
// happy folder-mode paths. These attack the telemetry sidecar's "never break the
// loop, never call gh in folder mode" contract under adversarial inputs.

let workdir

function envFor(overrides = {}) {
  return {
    PROJECT_ROOT: workdir,
    RALPH_RUN_ID: 'ralph-abc-1718000000',
    RALPH_CLAUDE_EXIT: '0',
    RALPH_DEV_BRANCH: 'dev',
    RALPH_RAW_JSONL_PATH: join(workdir, 'logs', 'x.jsonl'),
    RALPH_STDERR_LOG_PATH: join(workdir, 'logs', 'x.log'),
    ...overrides,
  }
}

const folderEnv = (overrides = {}) =>
  envFor({ TASK_SOURCE: 'folder', RALPH_TASK_ID: '7', RALPH_TASK_OUTCOME: 'done', ...overrides })

function readEvents() {
  const p = metricsPath(workdir)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)))
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-capture-qa-'))
  mkdirSync(join(workdir, 'logs'), { recursive: true })
})

afterEach(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true })
})

describe('captureIssueEvent — folder telemetry adversarial (#565 QA)', () => {
  it('folder mode NEVER calls the gh diff fetcher, even when it would throw', () => {
    const fetchDiffStats = () => {
      throw new Error('gh must not be called in folder mode')
    }
    // Must not throw and must still write a zeroed-diff event.
    expect(() =>
      captureIssueEvent({ env: folderEnv(), fetchDiffStats }),
    ).not.toThrow()
    const e = readEvents()[0]
    expect(e.files).toBe(0)
    expect(e.insertions).toBe(0)
    expect(e.deletions).toBe(0)
  })

  it('RALPH_TASK_OUTCOME verdict is case-insensitive (DONE → pass, FAILED → fail)', () => {
    captureIssueEvent({ env: folderEnv({ RALPH_TASK_OUTCOME: 'DONE' }), fetchDiffStats: () => ({}) })
    expect(readEvents()[0].verdict).toBe('pass')
  })

  it('the folder verdict override beats a stray failed label', () => {
    captureIssueEvent({
      env: folderEnv({ RALPH_TASK_OUTCOME: 'done', RALPH_ISSUE_LABELS: 'failed' }),
      fetchDiffStats: () => ({}),
    })
    // Even though a failed label is present, the terminal-dir outcome wins.
    expect(readEvents()[0].verdict).toBe('pass')
  })

  it('a non-numeric RALPH_TASK_ID becomes a null issue_number (never NaN in JSON)', () => {
    captureIssueEvent({
      env: folderEnv({ RALPH_TASK_ID: 'not-a-number' }),
      fetchDiffStats: () => ({}),
    })
    const e = readEvents()[0]
    expect(e.issue_number).toBe(null)
  })

  it('reads RALPH_TASK_ID (not RALPH_ISSUE_NUMBER) as the number in folder mode', () => {
    captureIssueEvent({
      env: folderEnv({ RALPH_TASK_ID: '42', RALPH_ISSUE_NUMBER: '98' }),
      fetchDiffStats: () => ({}),
    })
    expect(readEvents()[0].issue_number).toBe(42)
  })

  it('a garbage TASK_SOURCE resolves to github and DOES read RALPH_ISSUE_NUMBER', () => {
    // resolveSource falls back to github; the sidecar then reads the issue number.
    let called = 0
    captureIssueEvent({
      env: envFor({ TASK_SOURCE: 'gitlab', RALPH_ISSUE_NUMBER: '55', RALPH_TASK_ID: '7' }),
      fetchDiffStats: () => {
        called++
        return { additions: 0, deletions: 0, changedFiles: 0 }
      },
    })
    expect(readEvents()[0].issue_number).toBe(55)
    expect(called).toBe(1)
  })

  it('a telemetry crash (unwritable project root) never throws out of the sidecar', () => {
    expect(() =>
      captureIssueEvent({
        env: folderEnv({ PROJECT_ROOT: '/nonexistent/\0/root' }),
        fetchDiffStats: () => ({}),
      }),
    ).not.toThrow()
  })
})

// ===========================================================================
// QA augmentation for #131 — the JIRA arm's telemetry, adversarially.
// ===========================================================================
//
// lib/capture-issue-event.test.js owns the happy jira arm: a well-formed key, the two
// outcome words, no `gh`. This file asks the questions that suite cannot, and each one is
// about a value the sidecar does not choose:
//
//   1. THE KEY IS ACLI'S, NOT RALPH'S. `usableJiraKey` deliberately passes a key its own
//      grammar refuses straight through (lib/jira-key.js's PERMISSIVE half), so `FOO/1`,
//      `FOO 1` and a key with a newline in it all reach this sidecar in production. The
//      question is never "is it valid" but "what got recorded, and is the LOG still one
//      JSON object per line afterwards".
//   2. NOTHING NUMERIC MAY REACH THE JSON AS NaN OR Infinity. `JSON.stringify(NaN)` is
//      `null`, which is survivable, but the same is not true of every reader downstream —
//      and `Number('Infinity')` is finite-looking enough to slip a guard that only tests
//      `Number.isNaN`. Every numeric env var is swept, and the assertion is on the BYTES
//      the file received rather than on the parsed object.
//   3. `never throws` IS A PROMISE, so it is tested against an `env` that fights back: a
//      symbol, an object, a getter that throws. Reachable through the exported function,
//      whose `env` is an injected object rather than `process.env`.
//   4. THE OTHER TWO SOURCES' BYTES ARE FROZEN. AC4 says a github or folder event is
//      byte-for-byte what it was, and the honest way to say that is to serialise the same
//      event twice — once with a stale `RALPH_TASK_KEY` in the env, once without — and
//      compare the STRINGS, not a field list somebody remembered to write down.
const jiraEnv = (overrides = {}) =>
  envFor({ TASK_SOURCE: 'jira', RALPH_TASK_KEY: 'FOO-123', RALPH_TASK_OUTCOME: 'done', ...overrides })

// The file as the appender left it, before anything parses it. Every "is this still one
// event" assertion needs the raw bytes: a forged newline inside a recorded value would
// split into two parseable lines and `readEvents` would report two events without ever
// saying that is what happened.
const rawLines = () => {
  const p = metricsPath(workdir)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
}

// gh must never be reached by any test in this block; a fetcher that throws is the only
// stub that can say so without also counting calls.
const noGh = () => {
  throw new Error('gh must not be called in jira mode')
}

describe('captureIssueEvent — jira keys the grammar refuses (#131 QA)', () => {
  // MEASURED against lib/jira-key.js rather than reasoned about: each row is
  // `usableJiraKey`/`numberFromKey`'s answer for that string. The permissive half hands the
  // key through and the strict half declines a number, which is exactly the pair this
  // sidecar records.
  const refused = {
    'a second hyphen (not a project key)': ['FOO-BAR-1', 'FOO-BAR-1', null],
    'a decimal work item': ['FOO-1.5', 'FOO-1.5', null],
    'a signed work item': ['FOO-+1', 'FOO-+1', null],
    'digits with a letter after them': ['FOO-12a', 'FOO-12a', null],
    'no project key at all': ['-1', '-1', null],
    'no work item at all': ['FOO-', 'FOO-', null],
    'a path separator': ['FOO/1', 'FOO/1', null],
    'a space': ['FOO 1', 'FOO 1', null],
  }

  for (const [what, [raw, key, number]] of Object.entries(refused)) {
    it(`records ${what} as the key it is, with a null number, and still writes the event`, () => {
      captureIssueEvent({ env: jiraEnv({ RALPH_TASK_KEY: raw }), fetchDiffStats: noGh })
      const events = readEvents()
      expect(events, raw).toHaveLength(1)
      expect(events[0].task_key, raw).toBe(key)
      expect(events[0].issue_number, raw).toBeNull()
      // The verdict is the board's, and an unreadable name does not cost the run its
      // outcome — which is the whole reason the strict half answers null instead of throwing.
      expect(events[0].verdict, raw).toBe('pass')
    })
  }

  it('uppercases a lowercase project key and leaves leading zeros in the key alone', () => {
    // Both halves of `normalizeJiraKey`'s contract in one event: the project key is Jira's
    // own spelling, the work item number is left verbatim because renumbering it would name
    // a different ticket — while the DERIVED number drops the zeros, since 007 is 7.
    captureIssueEvent({ env: jiraEnv({ RALPH_TASK_KEY: 'foo-007' }), fetchDiffStats: noGh })
    expect(readEvents()[0]).toMatchObject({ task_key: 'FOO-007', issue_number: 7 })
  })

  it('records an underscore-bearing project key with its number (the grammar accepts it)', () => {
    captureIssueEvent({ env: jiraEnv({ RALPH_TASK_KEY: 'FO_O2-9' }), fetchDiffStats: noGh })
    expect(readEvents()[0]).toMatchObject({ task_key: 'FO_O2-9', issue_number: 9 })
  })

  it('a work item past MAX_SAFE_INTEGER keeps the key and takes no number', () => {
    // The digits stop round-tripping past 2^53, so the number would name a different
    // ticket than the text does — refused, and the KEY is what survives.
    const raw = 'FOO-99999999999999999999'
    captureIssueEvent({ env: jiraEnv({ RALPH_TASK_KEY: raw }), fetchDiffStats: noGh })
    const events = readEvents()
    expect(events[0].task_key).toBe(raw)
    expect(events[0].issue_number).toBeNull()
    // The number that was refused is nowhere in the line either — not as a float, not as
    // a `1e20`, and not as the string that produced it.
    expect(rawLines()[0]).not.toContain('"issue_number":1')
  })

  for (const [what, value] of Object.entries({
    empty: '',
    'whitespace only': '   ',
    'a tab and a newline': '\t\n',
  })) {
    it(`writes an event for a ${what} RALPH_TASK_KEY, with no task_key key and a null number`, () => {
      captureIssueEvent({ env: jiraEnv({ RALPH_TASK_KEY: value }), fetchDiffStats: noGh })
      const events = readEvents()
      expect(events).toHaveLength(1)
      // ABSENT rather than null or empty: `usableJiraKey` answers null for all three, and
      // lib/issue-event.js omits the field for null — so an unnamed jira event has the same
      // key set a github event has, which is the shape every reader already handles.
      expect('task_key' in events[0], value).toBe(false)
      expect(events[0].issue_number, value).toBeNull()
      expect(events[0].verdict, value).toBe('pass')
    })
  }

  it('keeps the log ONE event per line for a key carrying a newline and a forged tag', () => {
    // The key crosses acli, bash and a file before it gets here, and the tag the readers
    // slice off is a line prefix — so a key that contains one would forge a second event if
    // the value reached the file unescaped. `JSON.stringify` is what stops it; this is the
    // assertion that says so.
    const forged = 'FOO-1' + String.fromCharCode(10) + 'RALPH_ISSUE_EVENT {"verdict":"pass"}'
    captureIssueEvent({ env: jiraEnv({ RALPH_TASK_KEY: forged }), fetchDiffStats: noGh })
    expect(rawLines()).toHaveLength(1)
    const events = readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].task_key).toBe(forged)
    expect(events[0].verdict).toBe('pass')
  })
})

describe('captureIssueEvent — a jira event never carries NaN or Infinity (#131 QA)', () => {
  // The four numeric env vars a jira iteration hands the sidecar, each with the values a
  // bash `$(( ))`, an empty variable or a missing export can produce. `RALPH_DURATION_MS`
  // leads the list because the jira arm computes it itself (templates/ralph.sh times its own
  // dispatch), so it is the one nothing else in the repo had a reason to fuzz.
  const hostileNumbers = {
    RALPH_DURATION_MS: ['', '0', '-1', '-0', 'abc', 'NaN', 'Infinity', '-Infinity', '1e3', '  ', '9007199254740993'],
    RALPH_CLAUDE_EXIT: ['', 'abc', 'NaN', 'Infinity', '-1', '1x'],
    RALPH_CONTEXT_WINDOW: ['', '0', '-5', 'abc', 'NaN', 'Infinity', '1e400'],
  }

  for (const [name, values] of Object.entries(hostileNumbers)) {
    for (const value of values) {
      it(`${name}=${JSON.stringify(value)} leaves the line valid JSON with no NaN and no Infinity`, () => {
        captureIssueEvent({ env: jiraEnv({ [name]: value }), fetchDiffStats: noGh })
        const line = rawLines()[0]
        expect(line, `${name}=${value}`).toBeDefined()
        // The BYTES, because the parse below cannot see the difference: `JSON.parse` on a
        // line containing a bare `NaN` throws, and on one where a reader's own coercion
        // would produce one it succeeds — so both are asserted.
        expect(line, `${name}=${value}`).not.toMatch(/NaN|Infinity/)
        expect(() => JSON.parse(line.slice('RALPH_ISSUE_EVENT '.length))).not.toThrow()
        const e = readEvents()[0]
        for (const field of ['issue_number', 'duration_ms', 'claude_exit_code', 'context_window', 'context_end_tokens', 'total_cost_usd']) {
          const v = e[field]
          expect(v === null || Number.isFinite(v), `${name}=${value} → ${field}=${v}`).toBe(true)
        }
      })
    }
  }

  it('discards a NEGATIVE duration and falls back to the stream, which reports 0 here', () => {
    // A clock that went backwards between the arm's two `date +%s000` reads is the only way
    // this arises, and a negative `duration_ms` is a number a `--json` consumer could do
    // arithmetic with. The fallback is the stream's own figure — 0 for the empty stream
    // these fixtures write — and 0 is what every reader in this repo already treats as
    // "not measured" (progress.js `measuredOrNull`), so nothing has to learn a new value.
    captureIssueEvent({ env: jiraEnv({ RALPH_DURATION_MS: '-5000' }), fetchDiffStats: noGh })
    expect(readEvents()[0].duration_ms).toBe(0)
  })

  it('records a positive measured duration verbatim', () => {
    captureIssueEvent({ env: jiraEnv({ RALPH_DURATION_MS: '1e3' }), fetchDiffStats: noGh })
    expect(readEvents()[0].duration_ms).toBe(1000)
  })
})

describe('captureIssueEvent — a hostile env object cannot break the sidecar (#131 QA)', () => {
  // `captureIssueEvent`'s docblock promises it never throws. The exported function takes an
  // injected `env`, so these shapes are reachable through it — and `String(value)` on the
  // last two is exactly what lib/jira-key.js refuses to do for this reason.
  for (const [what, value] of Object.entries({
    'a number': 123,
    'a boolean': true,
    'an array': ['FOO-1'],
    'an object with a toString': { toString: () => 'FOO-9' },
    'a symbol': Symbol('FOO-1'),
  })) {
    it(`writes an unnamed event for a RALPH_TASK_KEY that is ${what}`, () => {
      expect(() =>
        captureIssueEvent({ env: jiraEnv({ RALPH_TASK_KEY: value }), fetchDiffStats: noGh }),
      ).not.toThrow()
      const events = readEvents()
      expect(events, what).toHaveLength(1)
      // Never coerced: an object with a `toString` is a caller bug, not a ticket name.
      expect('task_key' in events[0], what).toBe(false)
      expect(events[0].issue_number, what).toBeNull()
    })
  }

  it('swallows a RALPH_TASK_KEY getter that throws, and says so on the log channel', () => {
    // Not a shape `process.env` can take, but the exported seam accepts any object and the
    // promise is unconditional. The event is LOST (the throw lands before the append), which
    // is the sidecar's whole posture: no record, and no effect on the run either.
    const said = []
    const env = jiraEnv()
    Object.defineProperty(env, 'RALPH_TASK_KEY', {
      get() {
        throw new Error('hostile getter')
      },
    })
    expect(() =>
      captureIssueEvent({ env, log: (m) => said.push(m), fetchDiffStats: noGh }),
    ).not.toThrow()
    expect(said.join('\n')).toContain('capture-issue-event: skipped')
    expect(readEvents()).toEqual([])
  })

  it('never throws for an unwritable .ralph, and writes no partial line', () => {
    const said = []
    expect(() =>
      captureIssueEvent({
        env: jiraEnv({ PROJECT_ROOT: '/nonexistent/\0/root' }),
        log: (m) => said.push(m),
        fetchDiffStats: noGh,
      }),
    ).not.toThrow()
    expect(said.join('\n')).toContain('capture-issue-event: skipped')
    expect(rawLines()).toEqual([])
  })
})

describe('captureIssueEvent — the other two sources are byte-for-byte unchanged (#131 QA)', () => {
  // AC4, stated as bytes rather than as a field list: the same iteration is captured twice,
  // once with a stale `RALPH_TASK_KEY` left in the env by an earlier jira run in the same
  // shell, and the two FILES are compared. A field-by-field assertion would pass a schema
  // that had quietly grown a `task_key: null`.
  const capturedLine = (env) => {
    rmSync(metricsPath(workdir), { force: true })
    captureIssueEvent({ env, now: () => 1_700_000_000_000, fetchDiffStats: () => ({ additions: 3, deletions: 1, changedFiles: 2 }) })
    return rawLines()[0]
  }

  it('a github event is identical with and without a stale RALPH_TASK_KEY in the env', () => {
    const clean = capturedLine(envFor({ RALPH_ISSUE_NUMBER: '42', RALPH_ISSUE_STATE: 'CLOSED' }))
    const stale = capturedLine(
      envFor({ RALPH_ISSUE_NUMBER: '42', RALPH_ISSUE_STATE: 'CLOSED', RALPH_TASK_KEY: 'FOO-123' }),
    )
    expect(stale).toBe(clean)
    expect(clean).not.toContain('task_key')
  })

  it('a folder event is identical with and without a stale RALPH_TASK_KEY in the env', () => {
    const clean = capturedLine(folderEnv())
    const stale = capturedLine(folderEnv({ RALPH_TASK_KEY: 'FOO-123' }))
    expect(stale).toBe(clean)
    expect(clean).not.toContain('task_key')
  })

  it('a jira event is a github event with ONE key added and nothing else moved', () => {
    // The shape claim, measured both ways round: the jira key set is the github one plus
    // `task_key`, and no other field is dropped, renamed or added. Where in the object that
    // key lands is NOT pinned — no consumer reads insertion order, so a reshuffle of the
    // literal in lib/issue-event.js is free and this test stays about the key set.
    const github = JSON.parse(
      capturedLine(envFor({ RALPH_ISSUE_NUMBER: '42', RALPH_ISSUE_STATE: 'CLOSED' })).slice(
        'RALPH_ISSUE_EVENT '.length,
      ),
    )
    const jira = JSON.parse(capturedLine(jiraEnv()).slice('RALPH_ISSUE_EVENT '.length))
    expect(Object.keys(jira)).toContain('task_key')
    expect(Object.keys(jira).filter((k) => k !== 'task_key')).toEqual(Object.keys(github))
  })
})

describe('captureIssueEvent — the source decides which arm runs (#131 QA)', () => {
  // `worksThroughGitHub` is an ALLOWLIST OF ONE, used at both seams (the verdict source and
  // the PR-diff fetch), so the values that are NOT 'github' after `resolveSource` are the
  // ones worth sweeping: a typo must keep github's behaviour exactly, and only the two
  // recognised non-github names may change it.
  const githubish = ['gitlab', 'git', 'gh', 'jirah', 'jir', 'issues', '', '   ', 'GITHUB', 'GitHub']

  for (const value of githubish) {
    it(`TASK_SOURCE=${JSON.stringify(value)} still reads the issue number, the labels AND the PR diff`, () => {
      let calls = 0
      captureIssueEvent({
        env: envFor({
          TASK_SOURCE: value,
          RALPH_ISSUE_NUMBER: '42',
          RALPH_ISSUE_LABELS: 'pending-merge',
          RALPH_TASK_OUTCOME: 'failed',
        }),
        fetchDiffStats: (n) => {
          calls++
          expect(n, value).toBe(42)
          return { additions: 3, deletions: 1, changedFiles: 2 }
        },
      })
      const e = readEvents()[0]
      expect(e.issue_number, value).toBe(42)
      // The label wins and RALPH_TASK_OUTCOME is not consulted at all — the github
      // precedence, unchanged by an unknown name.
      expect(e.verdict, value).toBe('pass')
      expect(calls, value).toBe(1)
      expect(e.files, value).toBe(2)
    })
  }

  for (const value of ['jira', 'JIRA', 'Jira', ' jira\t']) {
    it(`TASK_SOURCE=${JSON.stringify(value)} takes the jira arm, whatever the github env says`, () => {
      // `resolveSource` trims and lowercases, so all four spellings are the same source
      // here — which is NOT what the loop's own dispatch does with the last three (see
      // test/loop.jira.adversarial.test.js).
      let calls = 0
      captureIssueEvent({
        env: jiraEnv({
          TASK_SOURCE: value,
          RALPH_ISSUE_NUMBER: '42',
          RALPH_ISSUE_LABELS: 'pending-merge',
          RALPH_ISSUE_STATE: 'CLOSED',
        }),
        fetchDiffStats: () => {
          calls++
          return { additions: 3, deletions: 1, changedFiles: 2 }
        },
      })
      const e = readEvents()[0]
      expect(e.task_key, value).toBe('FOO-123')
      expect(e.issue_number, value).toBe(123)
      expect(calls, value).toBe(0)
      expect(e.files, value).toBe(0)
    })
  }
})

// The claim sweep from the other side (#131 QA). capture-issue-event.test.js drives
// JIRA_UNRECORDED_CLAIM_PATTERNS forwards: eleven verbatim pre-#131 sentences, each proven to
// match, plus the whole-repo negative. What that cannot show is the two ways a pattern list goes
// wrong in the other direction, and both are cheap to measure here:
//
//   FALSE POSITIVES are the expensive failure. The list has to sit in a repo whose prose talks
//   about this telemetry constantly now that it exists, and the moment a true sentence matches,
//   the fix is to make the docs vaguer — which is the opposite of what the guard is for. Each row
//   below is a sentence the repo either already says or would plainly want to.
//
//   FALSE NEGATIVES are the guard's ceiling, and worth PINNING rather than asserting away: the
//   list is patterns over the sentences #131 actually deleted, so a claim reintroduced in words
//   nobody wrote the first time goes through. Recording which words those are is what turns "the
//   sweep is narrow" from an adjective into something a later slice can widen against.
describe('JIRA_UNRECORDED_CLAIM_PATTERNS — what it must NOT catch (#131 QA)', () => {
  // Every one of these is TRUE after #131, and the first two are load-bearing rather than
  // hypothetical: `no agent invoked` is lib/digest.js's own status string for a run that never
  // started, and lib/jira-key.js describes the digest's number-derived transcript path as a
  // still-open follow-up in the same "what is still missing" shape the banned sentences used.
  const stillSayable = {
    "digest's no-run status": 'no agent invoked',
    "jira-key.js's surviving defect": 'What is still missing is the digest path, and it is an open follow-up.',
    'the write, described': 'The loop appends one per-ticket event for every Jira iteration.',
    'the counts, described': '`ralph cycle` counts the per-ticket event this arm appends.',
    'the slice, referenced': '#131 recorded the key beside the number derived from it.',
    'a real remaining gap': '`ralph status --json` publishes no per-row key list.',
    'folder mode, described': 'The bash loop owns the failure sweep for a task directory.',
  }

  for (const [what, sentence] of Object.entries(stillSayable)) {
    it(`leaves the ${what} sayable`, () => {
      const text = claimText(sentence)
      for (const pattern of JIRA_UNRECORDED_CLAIM_PATTERNS) {
        expect(text, `${sentence} matched ${pattern}`).not.toMatch(pattern)
      }
    })
  }

  it('goes through the whole list, so a widened pattern is checked against all of it', () => {
    // The floor exists because the assertions above are `not.toMatch`: an empty list would pass
    // every one of them. Measured at 13.
    expect(JIRA_UNRECORDED_CLAIM_PATTERNS.length).toBeGreaterThanOrEqual(13)
  })
})

describe('JIRA_UNRECORDED_CLAIM_PATTERNS — the rewordings it lets through (#131 QA)', () => {
  // PINNED, NOT REPAIRED, and the distinction is the whole point of the block: none of these
  // five sentences stood in the repo before #131, so widening the list to catch them would be
  // guessing at prose nobody has written. What this test buys is a red the day somebody DOES
  // widen it — at which point this file is the list of what they just started catching — and an
  // honest answer to "is the sweep complete?" that is a measurement rather than a hope.
  //
  // The shape of the miss is consistent: every pattern in the list binds to a noun phrase from
  // a deleted sentence (`per-ticket telemetry`, `issue event is appended`, the arm count), so
  // a claim that names the FILE, the SIDECAR, or just `event` slips past all fourteen.
  const unswept = {
    'names the arm and the noun, in the wrong order': 'The jira arm appends no issue event.',
    'says telemetry without a bound absence word': 'No telemetry is recorded for a Jira ticket.',
    'names the log file instead of the event': 'A jira run leaves `.ralph/metrics/issues.jsonl` empty.',
    'names the sidecar instead of the write': 'The jira arm never spawns the telemetry sidecar.',
    'says event with no qualifier at all': 'No event is written under this source.',
  }

  for (const [what, sentence] of Object.entries(unswept)) {
    it(`does not catch a claim that ${what}`, () => {
      const text = claimText(sentence)
      expect(
        JIRA_UNRECORDED_CLAIM_PATTERNS.some((p) => p.test(text)),
        `${sentence} — now caught; widen or delete this row`,
      ).toBe(false)
    })
  }
})
