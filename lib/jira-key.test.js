// #127 — the spec for the Jira key grammar. PURE, so this file spawns nothing, stubs
// nothing and reads nothing: the module under test imports nothing at all (the same
// property lib/jira-jql.test.js and lib/task-source.test.js rely on), which is why a
// grammar can be tested as a grammar.
//
// WHAT THE GRAMMAR IS FOR, because it decides what "malformed" has to mean here:
//
//   `numberFromKey` is the NUMERIC HANDLE. `.ralph/run-state.json` has carried a numeric
//   `number` for the in-flight task since #55, and every reader of that field — the status
//   view, the telemetry sidecar — was written against an integer. A Jira ticket's name is
//   `FOO-123`, so the number is derived rather than invented, and a key it cannot read
//   answers null: null is the record's documented "unknown", and 0 would be task #0.
//
//   `usableJiraKey` is the KEY AS RALPH WILL USE IT — in an acli argv and in the run
//   record. It normalizes what it recognises and passes through what it does not, which
//   is the deliberate half: a project key this grammar has never seen is still the ticket
//   acli said was next, and refusing to claim it would be Ralph's regex overruling Jira.
//
// The two therefore disagree on purpose for an unrecognised key — no number, but a usable
// key — and the tests below assert that pairing rather than treating it as an edge case.

import { describe, expect, it } from 'vitest'
import { isJiraKey, normalizeJiraKey, numberFromKey, usableJiraKey } from './jira-key.js'

// Every non-key this module has to answer for without throwing. Named once and shared by
// all four functions below, because "does not throw" is a claim about the whole module and
// a case that only reached one function would be the one that took a run down.
const NOT_KEYS = [
  ['nothing at all', undefined],
  ['null', null],
  ['an empty string', ''],
  ['whitespace only', '   '],
  ['a project key with no number', 'FOO'],
  ['a bare number', '123'],
  ['a bare number as a number', 123],
  ['a number with no project', '-123'],
  ['a trailing dash', 'FOO-'],
  ['a non-numeric suffix', 'FOO-12a'],
  ['a double dash', 'FOO--1'],
  ['two dashes and a number', 'FOO-BAR-1'],
  ['a project key starting with a digit', '1FOO-2'],
  ['a decimal suffix', 'FOO-1.5'],
  ['a signed suffix', 'FOO-+1'],
  ['an inner space', 'FOO 123'],
  ['a space around the dash', 'FOO - 123'],
  ['an object', { key: 'FOO-123' }],
  ['an array', ['FOO-123']],
  ['a boolean', true],
  ['a symbol', Symbol('FOO-123')],
]

describe('numberFromKey — the numeric handle a Jira key carries (#127)', () => {
  it('reads the number the issue names', () => {
    expect(numberFromKey('FOO-123')).toBe(123)
    expect(numberFromKey('PROJ-1')).toBe(1)
  })

  it('reads a long project key, a digit-bearing one and an underscore one', () => {
    // Jira project keys are not three letters: they may carry digits and underscores
    // after the first character, and they can be long.
    expect(numberFromKey('AB1-7')).toBe(7)
    expect(numberFromKey('A_B-8')).toBe(8)
    expect(numberFromKey('LONGPROJECTKEY-9')).toBe(9)
  })

  it('reads a lowercase key and one wrapped in whitespace — both are a human typing', () => {
    expect(numberFromKey('foo-123')).toBe(123)
    expect(numberFromKey('  FOO-123\n')).toBe(123)
  })

  it('reads a big ticket number, and refuses one no integer can hold', () => {
    expect(numberFromKey('FOO-987654')).toBe(987654)
    // Past Number.MAX_SAFE_INTEGER the digits stop round-tripping, so the "number" would
    // be a different ticket than the one written down — parseCount in jira-queue.js
    // refuses the same shape for the same reason.
    expect(numberFromKey('FOO-99999999999999999999')).toBe(null)
  })

  it('returns null rather than throwing for anything that is not a key', () => {
    for (const [label, value] of NOT_KEYS) {
      expect(() => numberFromKey(value), label).not.toThrow()
      expect(numberFromKey(value), label).toBe(null)
    }
  })
})

describe('isJiraKey / normalizeJiraKey — validation and normalization (#127)', () => {
  it('recognises a key, whatever case it was typed in', () => {
    expect(isJiraKey('FOO-123')).toBe(true)
    expect(isJiraKey('foo-123')).toBe(true)
    expect(isJiraKey(' FOO-123 ')).toBe(true)
  })

  it('normalizes to the spelling Jira itself uses: an uppercase project key', () => {
    expect(normalizeJiraKey('foo-123')).toBe('FOO-123')
    expect(normalizeJiraKey('  FoO-123  ')).toBe('FOO-123')
  })

  it('leaves the NUMBER exactly as written — the key is Jira’s identity, not ours', () => {
    // `FOO-007` is not renumbered to `FOO-7`: whatever acli or a human handed over is
    // what Jira will be asked about. Only the case of the project key is Ralph's to fix.
    expect(normalizeJiraKey('foo-007')).toBe('FOO-007')
  })

  it('says no, without throwing, for anything that is not a key', () => {
    for (const [label, value] of NOT_KEYS) {
      expect(() => isJiraKey(value), label).not.toThrow()
      expect(isJiraKey(value), label).toBe(false)
      expect(() => normalizeJiraKey(value), label).not.toThrow()
      expect(normalizeJiraKey(value), label).toBe(null)
    }
  })
})

describe('usableJiraKey — the key Ralph puts in an argv and in the run record (#127)', () => {
  it('normalizes a key it recognises', () => {
    expect(usableJiraKey('foo-123')).toBe('FOO-123')
    expect(usableJiraKey('  FOO-123  ')).toBe('FOO-123')
  })

  it('passes an UNRECOGNISED key through verbatim, trimmed — Jira names the ticket, not us', () => {
    // The decisive case, and the reason this function exists next to the strict pair
    // above: `numberFromKey` has no number to offer here, but the ticket is real and
    // must still be claimable. A grammar that gated the claim would render the queue
    // permanently empty for whoever owns that project key.
    expect(usableJiraKey('FOO-BAR-1')).toBe('FOO-BAR-1')
    expect(usableJiraKey('  weird thing  ')).toBe('weird thing')
    expect(numberFromKey('FOO-BAR-1')).toBe(null)
  })

  it('answers null for nothing usable, and never throws', () => {
    for (const value of [undefined, null, '', '   ', 123, { key: 'FOO-1' }, ['FOO-1'], true]) {
      expect(() => usableJiraKey(value), String(value)).not.toThrow()
      expect(usableJiraKey(value), String(value)).toBe(null)
    }
  })
})
