import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { beginRun, beginTask, endRun, readRunState, runStatePath } from './run-state.js'

// QA augmentation for #55. The dev's run-state.test.js locks the happy path and
// the four documented "no record" inputs (missing / empty / truncated /
// malformed). These tests attack the two contracts the bash loop actually leans
// on, from the hostile side:
//
//   1. readRunState NEVER throws — whatever is on disk, whatever the fs does.
//      `ralph status` has no try/catch around it, so a throw here is a stack
//      trace in the user's terminal instead of `never-run`.
//   2. The writers are the ONLY thing that may throw, and they must throw
//      (not swallow), because bash spells the policy `|| true` and the CLI turns
//      the throw into one terse line + a non-zero exit.
//
// Plus the out-of-order call sequences a crashed/racing run can produce, and the
// bash-string coercions where "unknown" and 0 must never be confused.
//
// Hermetic by construction: memfs or hand-written fs doubles only, no ambient
// clock in any assertion (every timestamp is either injected or asserted as a
// range/parseability, never as a literal).

const ROOT = '/repo'
const PATH = `${ROOT}/.ralph/run-state.json`

const vol = (json = {}) => Volume.fromJSON(json)
const onDisk = (v) => JSON.parse(v.readFileSync(PATH, 'utf8').toString())

describe('readRunState — hostile on-disk content still reads as "no record" (#55 QA)', () => {
  const noRecord = {
    'whitespace only (a file that was created but never filled)': '   \n\t\n ',
    'a UTF-8 BOM in front of an otherwise valid record': '﻿{"schema":1,"status":"running"}',
    'valid JSON that is a string': '"running"',
    'valid JSON that is a boolean': 'true',
    'valid JSON that is a negative number': '-1',
    'valid JSON that is a nested array': '[[{"status":"running"}]]',
    'two records concatenated (an interleaved double write)':
      '{"schema":1,"status":"running"}{"schema":1,"status":"idle"}',
    'a JSON fragment with a trailing comma': '{"schema":1,"status":"running",}',
    'NaN, which JSON.parse rejects': '{"queue_at_start":NaN}',
  }

  for (const [label, content] of Object.entries(noRecord)) {
    it(`returns null for ${label}`, () => {
      expect(readRunState(ROOT, vol({ [PATH]: content }))).toBe(null)
    })
  }

  it('returns null for a file far larger than any record (a log accidentally written here)', () => {
    // 2 MiB of non-JSON: the read succeeds, the parse cannot, and the caller
    // must still get null rather than an exception or a hang.
    const huge = 'x'.repeat(2 * 1024 * 1024)
    expect(readRunState(ROOT, vol({ [PATH]: huge }))).toBe(null)
  })

  it('returns null when a DIRECTORY sits where the record should be', () => {
    // This is exactly the shape the loop's best-effort test creates, seen from
    // the reader's side: existsSync says yes, the read raises EISDIR.
    const v = vol()
    v.mkdirSync(PATH, { recursive: true })
    expect(readRunState(ROOT, v)).toBe(null)
  })

  it('returns null when existsSync itself throws (not just the read)', () => {
    const hostile = {
      existsSync: () => {
        throw new Error('EACCES: permission denied, stat')
      },
      readFileSync: () => '{}',
    }
    expect(readRunState(ROOT, hostile)).toBe(null)
  })

  it('returns null when the read answers with something that is not text', () => {
    for (const answer of [undefined, null, 42]) {
      expect(
        readRunState(ROOT, { existsSync: () => true, readFileSync: () => answer }),
        `readFileSync -> ${String(answer)}`,
      ).toBe(null)
    }
  })

  it('accepts a Buffer from the read (the real fs answer) and parses it', () => {
    const raw = Buffer.from(JSON.stringify({ schema: 1, status: 'running', run_id: 'r' }))
    expect(readRunState(ROOT, { existsSync: () => true, readFileSync: () => raw })).toMatchObject({
      run_id: 'r',
    })
  })
})

describe('readRunState — a record with the WRONG shape is still a record (#55 QA)', () => {
  // The boundary that matters for `ralph status`: null means "never-run", and an
  // object means "there was a run". An object missing every field must land on
  // the object side, or a half-written run would be reported as never having
  // happened at all.
  it('returns {} for an empty object — present but empty is NOT never-run', () => {
    expect(readRunState(ROOT, vol({ [PATH]: '{}' }))).toEqual({})
  })

  it('returns wrong-typed fields verbatim, leaving the judgement to the reader', () => {
    const hostile = {
      schema: 'one',
      status: 'running',
      run_id: 42,
      current: 'issue 31',
      ok: '3',
      failed: [],
      started_at: 'yesterday',
    }
    expect(readRunState(ROOT, vol({ [PATH]: JSON.stringify(hostile) }))).toEqual(hostile)
  })

  it('returns a record whose schema is absent, or from the future, without special-casing it', () => {
    expect(readRunState(ROOT, vol({ [PATH]: '{"status":"running"}' }))).toEqual({ status: 'running' })
    expect(readRunState(ROOT, vol({ [PATH]: '{"schema":99,"status":"running"}' }))).toMatchObject({
      schema: 99,
    })
  })

  it('does not pollute Object.prototype from a hostile __proto__ / constructor key', () => {
    const hostile =
      '{"schema":1,"status":"running","__proto__":{"pwned":true},"constructor":{"pwned":true}}'
    const v = vol({ [PATH]: hostile })
    const rec = readRunState(ROOT, v)
    expect(rec).not.toBe(null)
    expect({}.pwned).toBe(undefined)
    // …and the read-modify-write path must not carry it into a live object either.
    beginTask(ROOT, { number: 7, iteration: 1 }, v)
    expect({}.pwned).toBe(undefined)
    expect(onDisk(v).current).toMatchObject({ number: 7 })
  })
})

describe('the writers THROW on a failed write — bash owns the policy (#55 QA)', () => {
  // Deliberate contract: swallowing here would make `|| true` in templates/ralph.sh
  // and the CLI's terse-stderr/exit-1 branch dead code, and nothing would ever be
  // able to tell that the observability file stopped being written.
  const failing = (which) => ({
    mkdirSync: () => {
      if (which === 'mkdir') throw new Error('EACCES: permission denied, mkdir')
    },
    writeFileSync: () => {
      if (which === 'write') throw new Error('ENOSPC: no space left on device, write')
    },
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('ENOENT')
    },
  })

  for (const which of ['mkdir', 'write']) {
    it(`beginRun propagates a ${which} failure`, () => {
      expect(() => beginRun(ROOT, { runId: 'r' }, failing(which))).toThrow(
        which === 'mkdir' ? /EACCES/ : /ENOSPC/,
      )
    })

    it(`beginTask propagates a ${which} failure`, () => {
      expect(() => beginTask(ROOT, { number: 1, iteration: 1 }, failing(which))).toThrow(
        which === 'mkdir' ? /EACCES/ : /ENOSPC/,
      )
    })

    it(`endRun propagates a ${which} failure`, () => {
      expect(() => endRun(ROOT, { status: 'success', ok: 1, failed: 0 }, failing(which))).toThrow(
        which === 'mkdir' ? /EACCES/ : /ENOSPC/,
      )
    })
  }

  it('a write failure leaves the PREVIOUS record intact (no truncate-then-fail)', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'run-1', session: 's', source: 'github', queueDepth: 3 }, v)
    const before = v.readFileSync(PATH, 'utf8').toString()
    const wrapped = {
      existsSync: v.existsSync.bind(v),
      readFileSync: v.readFileSync.bind(v),
      mkdirSync: v.mkdirSync.bind(v),
      writeFileSync: () => {
        throw new Error('EACCES: permission denied, open')
      },
    }
    expect(() => beginTask(ROOT, { number: 9, iteration: 1 }, wrapped)).toThrow(/EACCES/)
    expect(v.readFileSync(PATH, 'utf8').toString()).toBe(before)
  })
})

describe('read-modify-write with an unusable base record (#55 QA)', () => {
  it('beginTask writes a usable running record when the existing file is UNREADABLE', () => {
    // Not the same case as the dev's "begin never ran": here a file exists and
    // the read fails, so the ?? fallback has to cover a throwing read too.
    const v = vol({ [PATH]: '{"schema":1,"stat' })
    beginTask(ROOT, { number: 12, iteration: 4 }, v)
    expect(onDisk(v)).toMatchObject({
      status: 'running',
      current: { number: 12, iteration: 4 },
    })
  })

  it('endRun writes a terminal record when the file was deleted mid-run', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'run-1', session: 's', source: 'github', queueDepth: 1 }, v)
    v.unlinkSync(PATH)
    endRun(ROOT, { status: 'failed', ok: 0, failed: 2 }, v)
    const rec = onDisk(v)
    expect(rec).toMatchObject({ status: 'failed', ok: 0, failed: 2 })
    // The run identity is gone with the file — but the record is terminal, which
    // is what keeps `ralph status` from reporting an eternal in-flight run.
    expect(rec.status).not.toBe('running')
  })

  it('endRun with no prior begin at all still produces a terminal record', () => {
    const v = vol()
    endRun(ROOT, { status: 'partial', ok: '1', failed: '1' }, v)
    expect(onDisk(v)).toMatchObject({ schema: 1, status: 'partial', ok: 1, failed: 1 })
  })
})

describe('out-of-order and repeated calls (#55 QA)', () => {
  it('a second begin AFTER a terminal record clears the previous run’s outcome', () => {
    // The dev asserts a fresh `current`; this asserts the other half — a new run
    // must not be born carrying the last run's finished_at / ok / failed, or the
    // first `ralph status` of run 2 would quote run 1's results.
    const v = vol()
    beginRun(ROOT, { runId: 'run-1', session: 's', source: 'github', queueDepth: 2 }, v)
    beginTask(ROOT, { number: 9, iteration: 1 }, v)
    endRun(ROOT, { status: 'failed', ok: 0, failed: 1 }, v)
    beginRun(ROOT, { runId: 'run-2', session: 's', source: 'github', queueDepth: 5 }, v)

    expect(onDisk(v)).toMatchObject({
      run_id: 'run-2',
      status: 'running',
      queue_at_start: 5,
      current: null,
      finished_at: null,
      ok: null,
      failed: null,
    })
  })

  it('end called twice overwrites — the counts never accumulate', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'github', queueDepth: 4 }, v)
    endRun(ROOT, { status: 'partial', ok: 2, failed: 1, finishedAt: '2026-08-25T20:00:00.000Z' }, v)
    endRun(ROOT, { status: 'success', ok: 4, failed: 0, finishedAt: '2026-08-25T21:00:00.000Z' }, v)
    expect(onDisk(v)).toMatchObject({
      status: 'success',
      ok: 4,
      failed: 0,
      finished_at: '2026-08-25T21:00:00.000Z',
    })
  })

  it('a begin-task after a terminal record flips the record back to running', () => {
    // Reachable only if a run's `begin` write failed while its `begin-task`
    // succeeded. The field that matters is `status`, since that is the ONLY one
    // reconcileMode() reads: a live run must not read as idle.
    const v = vol()
    beginRun(ROOT, { runId: 'run-1', session: 's', source: 'github', queueDepth: 1 }, v)
    endRun(ROOT, { status: 'success', ok: 1, failed: 0 }, v)
    beginTask(ROOT, { number: 77, iteration: 1 }, v)
    expect(onDisk(v)).toMatchObject({ status: 'running', current: { number: 77 } })
  })

  it('unknown fields on the existing record survive a read-modify-write', () => {
    const v = vol({
      [PATH]: JSON.stringify({ schema: 1, status: 'running', run_id: 'r', future_field: 'keep me' }),
    })
    beginTask(ROOT, { number: 3, iteration: 1 }, v)
    endRun(ROOT, { status: 'success', ok: 1, failed: 0 }, v)
    expect(onDisk(v)).toMatchObject({ run_id: 'r', future_field: 'keep me', status: 'success' })
  })
})

describe('bash hands over strings: "unknown" vs 0 must never be confused (#55 QA)', () => {
  const queueDepthCases = [
    ['0', 0, 'an EMPTY queue is a real count, not unknown'],
    ['', null, 'a failed count is unknown'],
    ['abc', null, 'a gh error message is unknown'],
    ['Infinity', null, 'a non-finite value is unknown'],
    ['NaN', null, 'NaN is unknown'],
    ['  6  ', 6, 'padding from a shell pipeline is trimmed'],
    ['-1', -1, 'a negative count is kept verbatim rather than invented'],
  ]

  for (const [raw, expected, why] of queueDepthCases) {
    it(`queue depth ${JSON.stringify(raw)} => ${JSON.stringify(expected)} (${why})`, () => {
      const v = vol()
      beginRun(ROOT, { runId: 'r', session: 's', source: 'github', queueDepth: raw }, v)
      expect(onDisk(v).queue_at_start).toBe(expected)
    })
  }

  // DOCUMENTED, not endorsed: only the EMPTY string is treated as unknown, so a
  // whitespace-only value coerces through Number('  ') === 0 and reads as "the
  // queue was empty". Not reachable from templates/ralph.sh — command
  // substitution strips the trailing newline and both queue_count() branches
  // emit either digits or nothing — so this is pinned as current behaviour
  // rather than asserted as a bug. A `.trim()` in toNumberOrNull() would fold it
  // into the unknown branch alongside '', matching that helper's own comment
  // ("never 0, which would be a lie").
  it('a whitespace-only count currently reads as 0, not unknown (documented boundary)', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', session: 's', source: 'github', queueDepth: '   ' }, v)
    expect(onDisk(v).queue_at_start).toBe(0)
  })

  it('a task number that is not a number becomes null, never a coerced 0', () => {
    const v = vol()
    for (const raw of ['', 'null', 'undefined', '#31', 'abc']) {
      beginTask(ROOT, { number: raw, iteration: '1' }, v)
      expect(onDisk(v).current.number, `number ${JSON.stringify(raw)}`).toBe(null)
    }
  })

  it('an absurd or negative iteration index round-trips instead of crashing the write', () => {
    const v = vol()
    beginTask(ROOT, { number: '5', iteration: '-3' }, v)
    expect(onDisk(v).current.iteration).toBe(-3)
    beginTask(ROOT, { number: '5', iteration: '999999999999999999999' }, v)
    expect(onDisk(v).current.iteration).toBe(1e21)
    expect(readRunState(ROOT, v).current.iteration).toBe(1e21)
  })

  it('startedAt accepts a Date and epoch ms, and never stamps an invalid date', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r', startedAt: new Date(Date.UTC(2026, 7, 25, 16, 20)) }, v)
    expect(onDisk(v).started_at).toBe('2026-08-25T16:20:00.000Z')
    beginRun(ROOT, { runId: 'r', startedAt: Date.UTC(2026, 7, 25, 16, 20) }, v)
    expect(onDisk(v).started_at).toBe('2026-08-25T16:20:00.000Z')
    // NaN / Infinity are numbers but not moments: fall back to now, not to
    // "Invalid Date" (which would throw inside toISOString).
    for (const bogus of [NaN, Infinity]) {
      beginRun(ROOT, { runId: 'r', startedAt: bogus }, v)
      expect(Number.isFinite(Date.parse(onDisk(v).started_at)), `startedAt ${bogus}`).toBe(true)
    }
  })

  it('every write lands on ONE path, and it is not state.json', () => {
    const v = vol()
    beginRun(ROOT, { runId: 'r' }, v)
    beginTask(ROOT, { number: 1, iteration: 1 }, v)
    endRun(ROOT, { status: 'success', ok: 1, failed: 0 }, v)
    expect(Object.keys(v.toJSON())).toEqual([runStatePath(ROOT)])
  })
})
