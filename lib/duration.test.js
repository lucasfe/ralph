import { describe, it, expect } from 'vitest'
import {
  InvalidDurationError,
  MAX_TIMER_MS,
  parseDuration,
  parseTimerDuration,
} from './duration.js'
import { parseInterval, ScheduleAbort } from './commands/schedule.js'

// #62 — ONE duration grammar for the whole CLI. `30m` has to mean 1800 seconds
// whether it arrives as `ralph schedule install --interval 30m`, as
// `RALPH_DIGEST_INTERVAL=30m` in ralph.config.sh, or as `ralph digest --loop
// --interval 30m` in the tmux window `ralph start` opens — three entry points that
// used to be one regex in lib/commands/schedule.js and two places waiting to drift.
//
// The scheduler's cases are re-asserted HERE, against the extracted parser, because
// they are the grammar's real specification: they are the formats a user has already
// been told work. schedule.test.js keeps its own copies pointed at parseInterval —
// that suite is about the command's contract (its abort type, its default), this one
// is about the grammar.

describe('parseDuration — the shared grammar (#62)', () => {
  it('parses a bare integer as seconds', () => {
    expect(parseDuration('60')).toBe(60)
    expect(parseDuration('3600')).toBe(3600)
  })

  it('parses every documented unit', () => {
    expect(parseDuration('45s')).toBe(45)
    expect(parseDuration('30m')).toBe(1800)
    expect(parseDuration('2h')).toBe(7200)
    expect(parseDuration('4h')).toBe(14400)
    expect(parseDuration('1d')).toBe(86400)
  })

  it('is case-insensitive about the unit', () => {
    expect(parseDuration('30M')).toBe(1800)
    expect(parseDuration('2H')).toBe(7200)
    expect(parseDuration('1D')).toBe(86400)
    expect(parseDuration('90S')).toBe(90)
  })

  it('tolerates surrounding whitespace and a space before the unit', () => {
    expect(parseDuration('  30m  ')).toBe(1800)
    expect(parseDuration('30 m')).toBe(1800)
  })

  it('accepts zero — a duration of nothing is still a parse, not a syntax error', () => {
    // The CALLER decides what zero means: launchd takes it literally, the digest
    // reads it as "off" (start.js already does, #60). Rejecting it here would make
    // the two disagree about what a valid duration is.
    expect(parseDuration('0')).toBe(0)
    expect(parseDuration('0m')).toBe(0)
  })

  it('rejects what the scheduler has always rejected', () => {
    for (const bad of ['not-a-duration', '4y', '', '1.5h', '-5m', '30 minutes', '1h30m']) {
      expect(() => parseDuration(bad), bad).toThrow(InvalidDurationError)
    }
  })

  it('rejects a missing value instead of inventing a default', () => {
    // A default is POLICY and belongs to the caller that has one: `ralph schedule`
    // must hand launchd some number, the digest must not start a timer nobody asked
    // for. A parser that answered 4h for `null` would smuggle the scheduler's answer
    // into every other caller.
    expect(() => parseDuration(null)).toThrow(InvalidDurationError)
    expect(() => parseDuration(undefined)).toThrow(InvalidDurationError)
  })

  it('says what was wrong and what would have been right', () => {
    expect(() => parseDuration('4y')).toThrow('invalid interval: 4y (expected e.g. 60, 30m, 2h, 1d)')
  })

  it('throws a NEUTRAL error — no exit code, no command in the name', () => {
    // The whole point of extracting it: an error that belongs to `ralph schedule`
    // cannot be raised by a parser three commands share. Each caller re-throws it
    // as its own.
    const e = catchOf(() => parseDuration('nope'))
    expect(e).toBeInstanceOf(InvalidDurationError)
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(ScheduleAbort)
    expect(e.exitCode).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC#2: the scheduler wraps the shared parser, and NOTHING a user or a test could
// observe about `parseInterval` changed — same accepted formats, same error type,
// same message bytes, same 4h default.
// ---------------------------------------------------------------------------

describe('parseInterval — unchanged after the extraction (#62)', () => {
  it('still answers the scheduler default for a missing interval', () => {
    expect(parseInterval(undefined)).toBe(14400)
    expect(parseInterval(null)).toBe(14400)
  })

  it('agrees with the shared parser on every value it accepts', () => {
    for (const good of ['60', '3600', '45s', '30m', '2h', '4h', '1d', '  30m  ', '0']) {
      expect(parseInterval(good), good).toBe(parseDuration(good))
    }
  })

  it('still throws ScheduleAbort with exit code 1, not the parser error', () => {
    const e = catchOf(() => parseInterval('4y'))
    expect(e).toBeInstanceOf(ScheduleAbort)
    expect(e).not.toBeInstanceOf(InvalidDurationError)
    expect(e.exitCode).toBe(1)
  })

  it('keeps the message byte-identical to the one it shipped before', () => {
    expect(() => parseInterval('4y')).toThrow('invalid interval: 4y (expected e.g. 60, 30m, 2h, 1d)')
    expect(() => parseInterval('not-a-duration')).toThrow(
      'invalid interval: not-a-duration (expected e.g. 60, 30m, 2h, 1d)',
    )
    // The empty string reached the regex before the extraction too, so its message
    // interpolates to a trailing space — asserted so a "tidier" rewrite of the
    // shared message cannot silently change what a scheduled repo prints.
    expect(() => parseInterval('')).toThrow('invalid interval:  (expected e.g. 60, 30m, 2h, 1d)')
  })
})

// ---------------------------------------------------------------------------
// The grammar says what a duration IS; this says which durations a JS timer can
// actually WAIT. Two different questions, and they have to stay two: `ralph schedule`
// hands its seconds to launchd, which has no ceiling, while `ralph digest --loop`
// hands them to setTimeout, whose delay is a signed 32-bit millisecond count — one
// millisecond over and node fires after 1ms instead of waiting, which turns a monthly
// digest into a paid model call per millisecond.
// ---------------------------------------------------------------------------

describe('parseTimerDuration — an interval a real clock can keep (#62)', () => {
  it('agrees with the grammar on everything the config template advertises', () => {
    for (const [input, seconds] of [['60', 60], ['30m', 1800], ['2h', 7200], ['1d', 86400]]) {
      expect(parseTimerDuration(input), input).toBe(seconds)
      expect(parseTimerDuration(input), input).toBe(parseDuration(input))
    }
  })

  it('rejects every spelling of zero, because a loop cannot wait for no time', () => {
    for (const input of ['0', '0s', '0m', '0h', '0d', '00']) {
      const e = catchOf(() => parseTimerDuration(input))
      expect(e, input).toBeInstanceOf(InvalidDurationError)
      expect(e.message, input).toContain(input)
    }
  })

  it('rejects an interval longer than a timer can wait', () => {
    // ~24d 20h is the boundary; the values here are the ones a human or a config
    // typo actually produces.
    for (const input of ['25d', '30d', '9999999999', String(Number.MAX_SAFE_INTEGER)]) {
      const e = catchOf(() => parseTimerDuration(input))
      expect(e, input).toBeInstanceOf(InvalidDurationError)
      expect(e.message, input).toContain(input)
    }
  })

  it('draws the line exactly at what setTimeout can hold', () => {
    const most = Math.floor(MAX_TIMER_MS / 1000)
    expect(MAX_TIMER_MS).toBe(2147483647)
    expect(parseTimerDuration(String(most))).toBe(most)
    expect(parseTimerDuration(String(most)) * 1000).toBeLessThanOrEqual(MAX_TIMER_MS)
    expect(() => parseTimerDuration(String(most + 1))).toThrow(InvalidDurationError)
    // 24d is inside it and 25d is not, so the boundary is where the message says.
    expect(parseTimerDuration('24d')).toBe(2073600)
  })

  it('leaves the GRAMMAR alone — the scheduler still takes an interval no timer would', () => {
    // The ceiling is a timer's problem, not a duration's: a launchd StartInterval of
    // 30 days is legitimate, so parseDuration and parseInterval must keep answering.
    expect(parseDuration('30d')).toBe(2592000)
    expect(parseInterval('30d')).toBe(2592000)
    expect(parseDuration(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('still refuses what the grammar refuses, with the grammar\'s own message', () => {
    const e = catchOf(() => parseTimerDuration('0.5h'))
    expect(e).toBeInstanceOf(InvalidDurationError)
    expect(e.message).toBe('invalid interval: 0.5h (expected e.g. 60, 30m, 2h, 1d)')
  })
})

function catchOf(fn) {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected a throw, got none')
}
