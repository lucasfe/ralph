import { describe, it, expect } from 'vitest'
import { InvalidDurationError, MAX_TIMER_MS, parseDuration, parseTimerDuration } from './duration.js'
import { parseInterval, ScheduleAbort } from './commands/schedule.js'

// QA augmentation for #62. The dev's duration.test.js proves the documented
// grammar and the scheduler's re-thrown abort. This file attacks the BOUNDARY of
// the regex — everything a human or a config file can put in front of it that is
// neither `30m` nor `not-a-duration` — and then pins AC#2 the only way it can
// honestly be pinned: by running the SAME battery through both entry points and
// demanding they answer identically, value for value and byte for byte.
//
// Why the battery matters more than any single case: `RALPH_DIGEST_INTERVAL` is now
// read out of a file nobody validates, and `--interval` is now typed by hand into a
// second command. The grammar is the only thing between those two and a tmux window
// that busy-loops on a paid model, so the interesting inputs are the ones that
// LOOK numeric — `1e3`, `0x10`, `+5m`, `1.5h`, `030`, fullwidth digits — not the
// ones that look like prose.
//
// Nothing here is allowed to widen the grammar. Every case below asserts what the
// scheduler ALREADY did with that input before the extraction, so a "helpful"
// future commit that starts accepting `1.5h` or `1h30m` fails here first.

// A single place to say "what did this entry point do with that input": either a
// value, or the class and message of what it threw. Comparing these objects is how
// AC#2 becomes one assertion instead of thirty.
function outcome(fn, input) {
  try {
    return { value: fn(input) }
  } catch (e) {
    return { threw: e.constructor.name, message: e.message }
  }
}

// Everything except nullish, which is the ONE input the two are documented to
// disagree about (the scheduler defaults to 4h, the parser refuses to invent one).
const BATTERY = [
  // accepted today
  '60', '3600', '0', '00', '030', '0s', '0m', '0h', '0d',
  '45s', '30m', '2h', '4h', '1d', '30M', '2H', '1D', '90S',
  '  30m  ', '30 m', '\t30m\n', '30\tm',
  // rejected today — the near-misses a human actually types
  '1.5h', '0.5h', '.5h', '5.h', '+5m', '-5m', '+0', '-0', ' -1 ',
  '1e3', '1E3', '0x10', '0b11', '1_000', '1,000', '30%', '30 m s',
  'm', 's', 'h', 'd', 'ms', '30ms', '5min', '1h30m', '30m0s', '3 0m',
  '30 minutes', 'half an hour', '4y', '4w', 'NaN', 'Infinity', '',
  '   ', '\n', 'null', 'undefined', '-', '30-', 'thirty',
  // non-string inputs: a config reader or an embedder hands these over, and
  // `String(input)` is exactly what the scheduler's regex saw before the move
  60, 0, 1.5, -5, 1e21, NaN, Infinity, -Infinity, true, false, {}, [], ['30'], [30],
  // digits that are not ASCII digits — `\d` is ASCII-only, and a config pasted out
  // of a document can carry either of these
  '٣٠m', '３０m', '30\u00A0m',
  // absurd but finite: pinned so a future guard against them lands in the CALLERS
  // (where the policy is) and not in the grammar (where it would change what
  // `ralph schedule` accepts)
  '9007199254740993', String(Number.MAX_SAFE_INTEGER), '99999999999999999999d',
]

describe('QA: parseDuration — the boundary of the shared grammar (#62)', () => {
  it('accepts nothing that merely LOOKS numeric', () => {
    // Every one of these is a plausible thing to write in ralph.config.sh, and every
    // one of them was rejected by the scheduler before the extraction. Accepting any
    // of them later would silently change what `ralph schedule install --interval`
    // takes, which AC#2 forbids.
    for (const bad of ['1.5h', '0.5h', '.5h', '+5m', '-5m', '1e3', '0x10', '1_000', '1,000', '30%']) {
      expect(() => parseDuration(bad), bad).toThrow(InvalidDurationError)
    }
  })

  it('rejects a unit with no number in front of it', () => {
    // `--interval m` is a typo for `--interval 30m`, not "one minute".
    for (const bad of ['m', 's', 'h', 'd', 'M', ' m ']) {
      expect(() => parseDuration(bad), bad).toThrow(InvalidDurationError)
    }
  })

  it('rejects a compound or doubled unit', () => {
    for (const bad of ['1h30m', '30m0s', '30ms', '5min', '30 m s', '30mm']) {
      expect(() => parseDuration(bad), bad).toThrow(InvalidDurationError)
    }
  })

  it('rejects every spelling of empty', () => {
    for (const bad of ['', ' ', '   ', '\t', '\n', '\t \n ']) {
      expect(() => parseDuration(bad), JSON.stringify(bad)).toThrow(InvalidDurationError)
    }
  })

  it('reads leading zeros as decimal, never as octal', () => {
    // `parseInt(x, 10)` — pinned because dropping the radix would turn `030` into 24
    // and a config that reads `030m` into a half-hour that is really 24 minutes.
    expect(parseDuration('030')).toBe(30)
    expect(parseDuration('0030m')).toBe(1800)
    expect(parseDuration('010h')).toBe(36000)
  })

  it('treats every unit in its own character class as a real multiplier', () => {
    // The regex `[smhd]` and the SECONDS_PER_UNIT table are two lists one edit apart.
    // If they ever drift, this catches it as the "invalid interval unit" message the
    // parser keeps for exactly that case — rather than as a NaN in a plist.
    for (const unit of ['s', 'm', 'h', 'd', 'S', 'M', 'H', 'D']) {
      const seconds = parseDuration(`1${unit}`)
      expect(Number.isFinite(seconds), unit).toBe(true)
      expect(seconds, unit).toBeGreaterThan(0)
    }
  })

  it('accepts any whitespace between the number and the unit, including a nbsp', () => {
    // `\s` in JS covers the tab, the newline and U+00A0 — the last one being what a
    // value pasted out of a rendered document carries. Documented rather than
    // endorsed: the point is that it resolves to a NUMBER and not to a refusal at
    // 4am in a pane nobody is watching.
    expect(parseDuration('30\tm')).toBe(1800)
    expect(parseDuration('30\nm')).toBe(1800)
    expect(parseDuration('30\u00A0m')).toBe(1800)
    // ...but whitespace INSIDE the number is not a thousands separator.
    expect(() => parseDuration('3 0m')).toThrow(InvalidDurationError)
  })

  it('rejects digits that are not ASCII digits', () => {
    // `\d` is ASCII-only, so an Arabic-Indic or fullwidth number is a parse failure
    // rather than a duration nobody can predict.
    for (const bad of ['٣٠m', '３０m', '٣٠', '３０']) {
      expect(() => parseDuration(bad), bad).toThrow(InvalidDurationError)
    }
  })

  it('coerces a numeric input the way the scheduler always did', () => {
    // An embedder (or a config reader that parsed the value first) can hand over a
    // Number. `String(input)` makes `60` and `'60'` the same input, and keeps `1.5`
    // and `-5` the same refusal.
    expect(parseDuration(60)).toBe(60)
    expect(parseDuration(0)).toBe(0)
    for (const bad of [1.5, -5, NaN, Infinity, -Infinity, true, false]) {
      expect(() => parseDuration(bad), String(bad)).toThrow(InvalidDurationError)
    }
  })

  it('never answers NaN — an accepted input is always a finite, non-negative integer', () => {
    // The value ends up in a launchd StartInterval and in `setTimeout`. NaN in either
    // is a schedule that never fires, so "throws" and "returns a usable number" must
    // be the only two outcomes there are.
    for (const input of BATTERY) {
      const got = outcome(parseDuration, input)
      if (!('value' in got)) continue
      expect(Number.isFinite(got.value), `${String(input)} → ${got.value}`).toBe(true)
      expect(Number.isInteger(got.value), `${String(input)} → ${got.value}`).toBe(true)
      expect(got.value, `${String(input)} → ${got.value}`).toBeGreaterThanOrEqual(0)
    }
  })

  it('parses an absurdly large value rather than refusing it — the CALLERS own that policy', () => {
    // Pinned deliberately, and it is not an endorsement: `ralph schedule` may want a
    // 30-day interval and launchd will take it. What must not happen is the GRAMMAR
    // acquiring a ceiling, because that ceiling would change what a scheduled repo
    // already accepts. The digest's own guard against an interval it cannot honor
    // belongs in digest.js, and is asserted there.
    expect(parseDuration(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
    expect(parseDuration('30d')).toBe(2592000)
    expect(Number.isFinite(parseDuration('99999999999999999999d'))).toBe(true)
  })

  it('says what was wrong, quoting the input EXACTLY as it arrived', () => {
    // The message interpolates the raw input, untrimmed — which is what the
    // scheduler's message did before the move, so these bytes are the contract and
    // not a detail. The empty and whitespace-only cases are the ones a "tidier"
    // rewrite would silently change.
    expect(outcome(parseDuration, '').message).toBe(
      'invalid interval:  (expected e.g. 60, 30m, 2h, 1d)',
    )
    expect(outcome(parseDuration, '   ').message).toBe(
      'invalid interval:     (expected e.g. 60, 30m, 2h, 1d)',
    )
    expect(outcome(parseDuration, null).message).toBe(
      'invalid interval: null (expected e.g. 60, 30m, 2h, 1d)',
    )
    expect(outcome(parseDuration, undefined).message).toBe(
      'invalid interval: undefined (expected e.g. 60, 30m, 2h, 1d)',
    )
    // Every message names the formats that DO work, whatever came in.
    for (const input of BATTERY) {
      const got = outcome(parseDuration, input)
      if ('value' in got) continue
      expect(got.message, String(input)).toContain('expected e.g. 60, 30m, 2h, 1d')
    }
  })

  it('throws an error with a name and a stack, and no exit code', () => {
    const e = outcome(parseDuration, 'nope')
    expect(e.threw).toBe('InvalidDurationError')
    const raw = catchOf(() => parseDuration('nope'))
    expect(raw.name).toBe('InvalidDurationError')
    expect(typeof raw.stack).toBe('string')
    // Neutral about exit codes: two commands share it and they disagree about what a
    // bad interval costs.
    expect(raw.exitCode).toBeUndefined()
    expect(raw.code).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC#2, as one comparison. `parseInterval` is a wrapper now; a scheduled repo must
// not be able to tell. Two things could break that: a value the wrapper answers
// differently, and an error class that leaks past it.
// ---------------------------------------------------------------------------

describe('QA: parseInterval — byte-identical to the pre-#62 scheduler (#62)', () => {
  it('answers the SAME thing as the shared parser for every input in the battery', () => {
    // Value for value and, when they throw, message byte for message byte. The only
    // difference allowed is the class: ScheduleAbort out here, InvalidDurationError
    // in there.
    const disagreements = []
    for (const input of BATTERY) {
      const shared = outcome(parseDuration, input)
      const scheduler = outcome(parseInterval, input)
      const same =
        'value' in shared
          ? shared.value === scheduler.value
          : shared.message === scheduler.message && !('value' in scheduler)
      if (!same) disagreements.push({ input: String(input), shared, scheduler })
    }
    expect(disagreements).toEqual([])
  })

  it('diverges from the parser on nullish input, and ONLY there', () => {
    // The 4h default is launchd policy, not grammar: a plist needs some number.
    expect(parseInterval(null)).toBe(14400)
    expect(parseInterval(undefined)).toBe(14400)
    expect(parseInterval()).toBe(14400)
    expect(() => parseDuration(null)).toThrow(InvalidDurationError)
    // The empty string is NOT nullish and never was — `RALPH_DIGEST_INTERVAL=""`
    // reaching the scheduler would still be a refusal, not four hours.
    expect(() => parseInterval('')).toThrow(ScheduleAbort)
    expect(() => parseInterval('   ')).toThrow(ScheduleAbort)
  })

  it('never lets an InvalidDurationError escape — a caller catching ScheduleAbort still catches everything', () => {
    // This is the whole risk of the extraction. `bin/ralph.js` catches ScheduleAbort
    // and nothing else, so a parser error travelling out of here unwrapped would turn
    // a typo'd `--interval` into a stack trace and a crash instead of one line and
    // exit 1.
    let unwrapped = []
    for (const input of BATTERY) {
      let caught
      try {
        parseInterval(input)
        continue
      } catch (e) {
        caught = e
      }
      const ok = caught instanceof ScheduleAbort && !(caught instanceof InvalidDurationError)
      if (!ok) unwrapped.push({ input: String(input), threw: caught?.constructor?.name })
      // ...and the abort carries the exit code the command block reads.
      expect(caught.exitCode, String(input)).toBe(1)
    }
    expect(unwrapped).toEqual([])
  })

  it('is catchable as a ScheduleAbort by a caller that only knows that class', () => {
    // The shape bin/ralph.js relies on, written the way bin/ralph.js writes it.
    const caught = (() => {
      try {
        parseInterval('0.5h')
      } catch (e) {
        if (e instanceof ScheduleAbort) return { handled: true, exitCode: e.exitCode ?? 1 }
        throw e
      }
    })()
    expect(caught).toEqual({ handled: true, exitCode: 1 })
  })

  it('lets a non-duration failure travel as itself — a bug is not a bad interval', () => {
    // A value whose stringification throws is not a user typing the wrong thing; it
    // is a caller handing over something broken, and relabelling it "invalid
    // interval" would send a reader hunting through ralph.config.sh for a typo that
    // is not there. Both entry points must fail identically, and neither may dress it
    // up as its own abort.
    const hostile = {
      toString() {
        throw new TypeError('no string for you')
      },
    }
    const shared = catchOf(() => parseDuration(hostile))
    const scheduler = catchOf(() => parseInterval(hostile))
    expect(shared).toBeInstanceOf(TypeError)
    expect(scheduler).toBeInstanceOf(TypeError)
    expect(scheduler).not.toBeInstanceOf(ScheduleAbort)
    expect(scheduler.message).toBe(shared.message)
  })

  it('is pure — the same input answers the same thing however often it is asked', () => {
    // No cache, no counter, no mutation of the input. Cheap to assert, and the thing
    // that makes the two callers' shared use of it safe at all.
    const frozen = Object.freeze({ toString: () => '30m' })
    expect([parseDuration(frozen), parseDuration(frozen), parseDuration(frozen)]).toEqual([
      1800, 1800, 1800,
    ])
    const arg = '30m'
    parseDuration(arg)
    expect(arg).toBe('30m')
    expect(parseInterval('4h')).toBe(parseInterval('4h'))
  })
})

// The second entry point, added when the first proved too wide for a timer: every
// duration Ralph SLEEPS on goes through this one, and the whole reason it exists is
// that setTimeout's delay is a signed 32-bit millisecond count. Hand it more and node
// warns TimeoutOverflowWarning and fires after 1ms — a half-hourly narration turned
// into a paid model call per millisecond. The tests below are about the two ends of
// that window, and about the two callers agreeing on where they are.
describe('QA: parseTimerDuration — bounded at both ends, and only here (#62)', () => {
  it('accepts the largest duration a timer can hold and refuses the next one, in every unit', () => {
    // The ceiling is 2_147_483_647ms, which is not a whole number of seconds — so the
    // largest interval that can be ACCEPTED is 2_147_483s, and the boundary in each unit
    // is wherever that lands. Collected into one comparison so a fencepost error shows
    // up as a table rather than as whichever assertion happened to be first.
    const rows = [
      ['2147483', 'in'], // the largest whole second
      ['2147484', 'out'], // one second more
      ['2147483s', 'in'],
      ['2147484s', 'out'],
      ['35791m', 'in'], // 2_147_460s
      ['35792m', 'out'], // 2_147_520s
      ['596h', 'in'], // 2_145_600s
      ['597h', 'out'], // 2_149_200s
      ['24d', 'in'], // 2_073_600s — the number the refusal message names
      ['25d', 'out'],
      ['30d', 'out'], // the one a human would actually write
    ]
    expect(
      rows.map(([input]) => [input, outcome(parseTimerDuration, input).value === undefined ? 'out' : 'in']),
    ).toEqual(rows.map(([input, side]) => [input, side]))
  })

  it('never returns a delay a real setTimeout would silently collapse', () => {
    // The invariant, over the whole grammar battery rather than over a chosen few: if
    // this parser said yes, `seconds * 1000` is a delay node will actually wait out.
    const unsafe = []
    for (const input of BATTERY) {
      const got = outcome(parseTimerDuration, input)
      if (got.value === undefined) continue
      const ms = got.value * 1000
      if (!(Number.isInteger(ms) && ms > 0 && ms <= MAX_TIMER_MS)) unsafe.push([input, ms])
    }
    expect(unsafe).toEqual([])
  })

  it('pins the ceiling itself, because the number is not arbitrary', () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1)
    // Exactly the ceiling is unreachable through this grammar (it is not a whole number
    // of seconds), so the largest delay it can produce is 647ms short of it. Pinned so
    // a future `>=` here reads as a deliberate change and not as a rounding accident.
    expect(parseTimerDuration('2147483') * 1000).toBe(2147483000)
    expect(parseTimerDuration('2147483') * 1000).toBeLessThanOrEqual(MAX_TIMER_MS)
    expect(MAX_TIMER_MS - parseTimerDuration('2147483') * 1000).toBe(647)
  })

  it('refuses every spelling of zero, and says what a duration looks like', () => {
    // Zero is the value most likely to arrive by accident, because any spelling of it is
    // how ralph.config.sh turns the digest off — and a zero-delay loop is the same
    // failure as an overflowed one. The message has to name the formats that work,
    // because it is printed verbatim to a reader who just got no digest.
    const zeros = ['0', '00', '0s', '0m', '0h', '0d', ' 0 ', '0 s']
    const got = zeros.map((z) => outcome(parseTimerDuration, z))
    expect(got).toEqual(
      zeros.map((z) => ({
        threw: 'InvalidDurationError',
        message: `an interval of ${z} is not an interval (expected e.g. 60, 30m, 2h, 1d)`,
      })),
    )
  })

  it('says the interval is longer than a timer can wait, and names the longest one', () => {
    const e = catchOf(() => parseTimerDuration('30d'))
    expect(e.message).toBe('an interval of 30d is longer than a timer can wait (the longest is 24d)')
    // The raw input, interpolated: the reader has to recognise what they typed.
    expect(catchOf(() => parseTimerDuration('  30d  ')).message).toContain('  30d  ')
    // And the number it names is genuinely accepted, so the advice is followable.
    expect(parseTimerDuration('24d')).toBe(2073600)
  })

  it('throws the same neutral error class as the grammar, on one line, with no exit code', () => {
    // Both callers print `e.message` straight into one line of stderr — `ralph digest`
    // as `not looping — <message>`, `ralph start` as `⚠️  Digest window not opened —
    // <message>`. A newline in either message would read as two problems, and an
    // exitCode on the class would smuggle one caller's policy into the other's.
    for (const input of ['0', '30d', '0.5h', 'half an hour']) {
      const e = catchOf(() => parseTimerDuration(input))
      expect(e).toBeInstanceOf(InvalidDurationError)
      expect(e.name).toBe('InvalidDurationError')
      expect(e.message).not.toContain('\n')
      expect(e.exitCode).toBeUndefined()
      expect(e.code).toBeUndefined()
      expect(typeof e.stack).toBe('string')
    }
  })

  it('is a strict NARROWING of the shared grammar — never a different answer', () => {
    // The two must not drift into two grammars. For every input in the battery: if the
    // timer parser accepted it, the grammar accepted it too and with the same number of
    // seconds; if the grammar rejected it, so did the timer parser, with the grammar's
    // own message. Only the ceiling and zero may differ, and only by refusing.
    const drift = []
    for (const input of BATTERY) {
      const grammar = outcome(parseDuration, input)
      const timer = outcome(parseTimerDuration, input)
      if (grammar.value !== undefined) {
        // Accepted by the grammar: the timer either agrees exactly, or refuses for one
        // of its own two reasons.
        if (timer.value !== undefined && timer.value !== grammar.value) drift.push([input, 'value', grammar, timer])
        if (
          timer.value === undefined &&
          !/is not an interval|longer than a timer can wait/.test(timer.message)
        ) {
          drift.push([input, 'reason', grammar, timer])
        }
        continue
      }
      // Rejected by the grammar: the timer must reject it identically — same class, same
      // bytes — because that message is the one the reader was already shown.
      if (timer.value !== undefined || timer.message !== grammar.message) {
        drift.push([input, 'rejection', grammar, timer])
      }
    }
    expect(drift).toEqual([])
  })

  it('leaves the scheduler unbounded — launchd has no such ceiling (#62 AC2)', () => {
    // The whole reason there are two functions. `ralph schedule install --interval 30d`
    // writes a StartInterval into a plist; launchd waits 30 days perfectly well, and a
    // repo that already scheduled one must not stop working because a digest window
    // cannot.
    expect(parseInterval('30d')).toBe(2592000)
    expect(parseInterval('365d')).toBe(31536000)
    expect(parseDuration('30d')).toBe(2592000)
    // …and the scheduler's zero and its default are untouched too.
    expect(parseInterval('0')).toBe(0)
    expect(parseInterval(undefined)).toBe(14400)
    expect(parseInterval(null)).toBe(14400)
  })

  it('inherits the grammar on whitespace, and invents no default', () => {
    expect(parseTimerDuration(' 30m ')).toBe(1800)
    expect(parseTimerDuration('30 m')).toBe(1800)
    expect(parseTimerDuration('\t2h\n')).toBe(7200)
    // Whitespace INSIDE the number is still not a number.
    expect(catchOf(() => parseTimerDuration('3 0m')).message).toBe(
      'invalid interval: 3 0m (expected e.g. 60, 30m, 2h, 1d)',
    )
    // No default of its own: a timer nobody asked for must not start.
    for (const empty of [null, undefined, '', '   ']) {
      expect(catchOf(() => parseTimerDuration(empty)).name).toBe('InvalidDurationError')
    }
  })

  it('is pure, like the grammar it wraps', () => {
    expect([parseTimerDuration('30m'), parseTimerDuration('30m')]).toEqual([1800, 1800])
    const frozen = Object.freeze({ toString: () => '2h' })
    expect(parseTimerDuration(frozen)).toBe(7200)
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
