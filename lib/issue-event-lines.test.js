// #121 — the metrics log's line format, pinned as a CONTRACT rather than as three
// coincidences that happened to agree.
//
// `.ralph/metrics/issues.jsonl` used to be walked line by line in three separate places —
// `aggregateCycleCounts` in lib/issue-metrics.js, `parseIssueEvents` in lib/progress.js and
// `newestEvent` in lib/banner-model.js — each with its own copy of the tag and its own copy of
// the same four rules. They agreed, which was both the point and the problem: `ralph status`,
// `ralph cycle` and the launch box read the SAME file, and a reader who found the box
// disagreeing with `ralph status` about a run would file it as a bug, not as drift between
// three hand-maintained loops.
//
// So this file is the seam's spec, and it is deliberately three things at once:
//
//   1. THE PARSE CONTRACT, as string literals. Every case below is a line somebody's log has
//      actually held — a prefix in front of the tag, a truncated tail, a bare `null` — so no
//      case here needs a `.ralph` directory or a previous run (see test hermeticity, #41).
//   2. THE TWO WALKS AGREEING. `newestIssueEvent` is not a second parser; the last thing the
//      forward walk yields and the thing the reverse walk answers must be the SAME event for
//      every text, and that biconditional is asserted over a table of hostile ones.
//   3. THE SEAM ITSELF. A purity read (this module may import nothing, so the pure callers can
//      import it), and a sweep asserting it is the ONLY module in lib/ that spells the tag —
//      which is what makes the sharing structural instead of a convention.

import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { ISSUE_EVENT_TAG, issueEvents, newestIssueEvent } from './issue-event-lines.js'

const LIB = fileURLToPath(new URL('.', import.meta.url))

/** A log line, spelled the way the writer in lib/issue-metrics.js spells it. */
const tagged = (payload) => ISSUE_EVENT_TAG + payload
/** The forward walk, materialized — the shape `parseIssueEvents` hands its callers. */
const events = (text) => [...issueEvents(text)]

// Every input that is not a non-empty string. Normalizing one of these is the CALLER's job
// (see the coercion in parseIssueEvents, which exists so an injected `readFile` may return a
// Buffer) — this module refuses them, because `String(value)` on a hostile bag runs its
// `toString` and lib/banner-model.js's never-throws contract is written against exactly that.
const NOT_TEXT = [undefined, null, '', 0, 42, false, true, {}, [], () => {}, Buffer.from('x')]

describe('ISSUE_EVENT_TAG — one spelling, read and written', () => {
  it('is the tag byte for byte, trailing space included', () => {
    // The trailing space is LOAD-BEARING in both directions: every reader slices at
    // `indexOf(tag) + tag.length`, and the writer joins the payload straight onto it. Drop it
    // and `RALPH_ISSUE_EVENTX {}` becomes a match; widen it and every line ever written stops
    // being one. The file is append-only across upgrades, so this string can never change.
    expect(ISSUE_EVENT_TAG).toBe('RALPH_ISSUE_EVENT ')
  })
})

describe('issueEvents — the forward walk (#121)', () => {
  it('yields one event per tagged line, in file order, with no sort', () => {
    // File order IS append order, which is chronological, which is what "the last three"
    // means to the pace window. No sort: `ts` is optional, so sorting on it would silently
    // reshuffle the window — the timestamps below descend on purpose.
    const text = [
      tagged('{"issue_number":29,"ts":3}'),
      tagged('{"issue_number":30,"ts":2}'),
      tagged('{"issue_number":31,"ts":1}'),
    ].join('\n')
    expect(events(text).map((event) => event.issue_number)).toEqual([29, 30, 31])
  })

  it('finds the tag wherever it sits on the line, not only at its start', () => {
    // `indexOf`, not `startsWith`: the loop pipes its output through `tee` and a
    // pretty-printer, so a line can carry a timestamp or a prefix and still be an event.
    const text = [
      `2026-08-29T10:00:00Z | ${tagged('{"issue_number":29}')}`,
      `[stdout] ${tagged('{"issue_number":30}')}`,
    ].join('\n')
    expect(events(text).map((event) => event.issue_number)).toEqual([29, 30])
  })

  it('skips blank, whitespace-only and untagged lines', () => {
    const text = [
      '',
      '   ',
      'npm WARN deprecated something',
      'RALPH_CYCLE_EVENT {"ok":1}',
      tagged('{"issue_number":29}'),
      '',
    ].join('\n')
    expect(events(text)).toEqual([{ issue_number: 29 }])
  })

  it('skips a tagged line whose JSON does not parse', () => {
    for (const payload of ['{not valid json', '{"a":1,}', '{"a":NaN}', '{', '}']) {
      expect(events(tagged(payload)), payload).toEqual([])
    }
  })

  it('skips a tag with nothing, or only whitespace, after it', () => {
    expect(events('RALPH_ISSUE_EVENT ')).toEqual([])
    expect(events('RALPH_ISSUE_EVENT    ')).toEqual([])
    expect(events('noise RALPH_ISSUE_EVENT ')).toEqual([])
  })

  it('skips JSON that parses but is not an event object', () => {
    for (const payload of ['null', '42', '-0', '"a string"', 'true', 'false']) {
      expect(events(tagged(payload)), payload).toEqual([])
    }
  })

  it('skips a JSON ARRAY — the one rule the three callers did not all share (#121)', () => {
    // THE ONE DELIBERATE BEHAVIOURAL UNIFICATION. `aggregateCycleCounts` used to gate on
    // `!event || typeof event !== 'object'`, which ADMITS an array; the other two also
    // rejected `Array.isArray`. Nothing observable changed — an array cannot carry a numeric
    // `ts`, so the aggregator dropped it on the very next line — but "an array is not an
    // event" is now the rule in one place instead of a coincidence in two, and this is the
    // test that says so out loud rather than leaving a reader to wonder.
    for (const payload of ['[]', '[{"issue_number":29,"ts":1}]', '[1,2,3]']) {
      expect(events(tagged(payload)), payload).toEqual([])
    }
    // ...and an array on one line does not stop the walk reaching the object on the next.
    const text = [tagged('[{"issue_number":29}]'), tagged('{"issue_number":30}')].join('\n')
    expect(events(text)).toEqual([{ issue_number: 30 }])
  })

  it('never throws on a truncated trailing line, and yields what came before it', () => {
    // The loop appends with `>>` and can be killed mid-write, so a half-written last line is
    // the NORMAL state of this file rather than an exceptional one.
    const text = [
      tagged('{"issue_number":29,"ts":1}'),
      tagged('{"issue_number":30,"run_id":"run-1"'),
    ].join('\n')
    let parsed
    expect(() => {
      parsed = events(text)
    }).not.toThrow()
    expect(parsed).toEqual([{ issue_number: 29, ts: 1 }])
  })

  it('reads a CRLF log, because a trailing \\r is whitespace to JSON.parse', () => {
    const text = `${tagged('{"issue_number":29}')}\r\n${tagged('{"issue_number":30}')}\r\n`
    expect(events(text).map((event) => event.issue_number)).toEqual([29, 30])
  })

  it('yields nothing for input that is not a non-empty string', () => {
    for (const input of NOT_TEXT) {
      let parsed
      expect(() => {
        parsed = events(input)
      }, String(input)).not.toThrow()
      expect(parsed, String(input)).toEqual([])
    }
  })

  it('does not let a __proto__ payload pollute Object.prototype', () => {
    // This is now the ONLY `JSON.parse` any of the three readers runs over untrusted
    // append-only text, so the prototype-pollution case belongs here rather than three times
    // over. `JSON.parse` makes `__proto__` an own property; it must stay one.
    const before = Object.prototype.total_cost_usd
    const [event] = events(tagged('{"__proto__":{"total_cost_usd":999}}'))
    expect(Object.prototype.total_cost_usd).toBe(before)
    expect({}.total_cost_usd).toBe(undefined)
    expect(event.total_cost_usd).toBe(undefined)
  })

  it('is a generator, so no caller has to materialise the whole log', () => {
    // The reason this is an iterator and not an array: `aggregateCycleCounts` tallies as it
    // walks and never wants the events, and issues.jsonl accumulates across every run a repo
    // has ever done. The callers that DO want an array spread it and say so.
    const text = [tagged('{"issue_number":29}'), tagged('{"issue_number":30}')].join('\n')
    const walk = issueEvents(text)
    expect(Array.isArray(walk)).toBe(false)
    expect(typeof walk.next).toBe('function')
    expect(walk[Symbol.iterator]()).toBe(walk)
    // Produced one at a time: the first event is available before the second is parsed.
    expect(walk.next().value).toEqual({ issue_number: 29 })
    expect(walk.next().value).toEqual({ issue_number: 30 })
    expect(walk.next().done).toBe(true)
  })
})

describe('newestIssueEvent — the reverse walk (#121)', () => {
  it('answers with the LAST parseable event, never the first', () => {
    const text = [
      tagged('{"issue_number":29,"model":"older"}'),
      tagged('{"issue_number":30,"model":"middle"}'),
      tagged('{"issue_number":31,"model":"newest"}'),
    ].join('\n')
    expect(newestIssueEvent(text).model).toBe('newest')
  })

  it('walks back past a tail the loop left half-written', () => {
    // Same tails lib/banner-model.js's spec drives the box with, at the parser instead: a
    // truncated line, a bare tag, and JSON that is valid but is not an event.
    for (const tail of [
      tagged('{"agent":"claude","model":"claude-op'),
      'RALPH_ISSUE_EVENT ',
      tagged('null'),
      tagged('42'),
      tagged('"a string"'),
      tagged('true'),
      tagged('[]'),
      '',
      '   ',
      'some other line the loop printed',
    ]) {
      const text = [tagged('{"model":"claude-opus-5"}'), tail].join('\n')
      expect(newestIssueEvent(text), JSON.stringify(tail)).toEqual({ model: 'claude-opus-5' })
    }
  })

  it('stops at the first parseable line from the end and looks no further back', () => {
    // The box's whole correctness argument rests on this: an event that parses but carries no
    // model must END the search, so lib/banner-model.js can answer `unknown` rather than
    // reaching back to an older run and labelling it `last-run`.
    const text = [tagged('{"model":"older"}'), tagged('{"agent":"claude"}')].join('\n')
    expect(newestIssueEvent(text)).toEqual({ agent: 'claude' })
  })

  it('answers null when nothing in the text parses to an event', () => {
    for (const text of [
      '\n\n',
      'nothing tagged here',
      'RALPH_ISSUE_EVENT {\n???\n',
      [tagged('{trunc'), tagged('[]'), tagged('null')].join('\n'),
    ]) {
      expect(newestIssueEvent(text), JSON.stringify(text)).toBe(null)
    }
  })

  it('answers null for input that is not a non-empty string', () => {
    for (const input of NOT_TEXT) {
      let answer
      expect(() => {
        answer = newestIssueEvent(input)
      }, String(input)).not.toThrow()
      expect(answer, String(input)).toBe(null)
    }
  })

  it('agrees with the forward walk on every text — the property #121 exists for', () => {
    // THE SEAM, ASSERTED. The banner reads the newest event and `ralph status` reads them all;
    // if those two disagreed about which lines are events, the box would contradict the status
    // view over the same file. One `eventOn` gate serves both walks, so the reverse answer is
    // the forward walk's last yield for EVERY input — including the inputs where that is null.
    const HISTORY = [
      tagged('{"issue_number":29,"ts":1,"verdict":"pass"}'),
      tagged('{"issue_number":30,"ts":2,"verdict":"fail"}'),
    ].join('\n')
    const texts = {
      'an ordinary log': HISTORY,
      'a log with a trailing newline': `${HISTORY}\n`,
      'a truncated tail': `${HISTORY}\n${tagged('{"issue_number":31,"dur')}`,
      'an array on the last line': `${HISTORY}\n${tagged('[]')}`,
      'a bare tag on the last line': `${HISTORY}\nRALPH_ISSUE_EVENT `,
      'noise around every line': `npm WARN\n${HISTORY}\nplain stdout\n`,
      'a prefixed tag': `10:00:00 | ${tagged('{"issue_number":29}')}`,
      'nothing but junk': 'RALPH_ISSUE_EVENT {\n???\n',
      'an empty string': '',
      'two blank lines': '\n\n',
    }
    for (const [label, text] of Object.entries(texts)) {
      expect(newestIssueEvent(text), label).toEqual(events(text).at(-1) ?? null)
    }
  })
})

describe('issue-event-lines — the seam, read as source (#121)', () => {
  const CODE = codeWithoutComments(join(LIB, 'issue-event-lines.js'))

  it('imports nothing at all, which is what lets the pure callers import it', () => {
    // The reason this module exists at all rather than the parser living in
    // lib/issue-metrics.js: that module owns the FILE and therefore holds `node:fs`, and both
    // lib/banner-model.js and lib/progress.js are asserted pure by static reads of their own.
    // An import edge is only safe here while this end of it has no capability to lend — so the
    // claim is checked, not assumed.
    expect([...CODE.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1])).toEqual([])
    expect(CODE).not.toMatch(/^\s*import\s/m)
    expect(CODE).not.toMatch(/\bimport\s*\(/)
    expect(CODE).not.toMatch(/\brequire\s*\(/)
    expect(CODE).not.toMatch(/node:/)
  })

  it('reaches for no clock, no environment, no filesystem and no randomness', () => {
    for (const forbidden of [
      /\bprocess\b/,
      /\bDate\b/,
      /\bperformance\b/,
      /Math\s*\.\s*random/,
      /\bfetch\s*\(/,
      /readFileSync|writeFileSync|appendFileSync|existsSync/,
      /execa|spawn/,
    ]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('is the only module in lib/ that spells the tag', () => {
    // THE STRUCTURAL HALF OF #121. Three copies of one string literal is how the three
    // readers came to be three readers, and a fourth would rebuild the drift this module was
    // written to remove — silently, because a copy agrees on the day it is made. Read with
    // the prose stripped, since several of those modules still NAME the tag in a sentence
    // that explains where it went.
    //
    // Scoped to lib/*.js on purpose. templates/ralph.sh mentions the tag twice, both times in
    // a bash comment: the loop writes its telemetry by shelling out to `captureIssueEvent`,
    // so there has never been a second WRITER of these bytes to unify with.
    const sources = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) sources.push(path)
      }
    }
    walk(LIB)

    // Non-vacuity first: a walk that found nothing would pass the assertion below.
    expect(sources.length).toBeGreaterThan(30)
    const spellsIt = sources
      .filter((path) => /RALPH_ISSUE_EVENT/.test(codeWithoutComments(path)))
      .map((path) => relative(LIB, path))
    expect(spellsIt).toEqual(['issue-event-lines.js'])
  })
})
