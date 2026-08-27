// ONE duration grammar for the whole CLI (#62). `30m` has to mean 1800 seconds
// wherever a human writes it: `ralph schedule install --interval 30m`,
// `RALPH_DIGEST_INTERVAL=30m` in ralph.config.sh, `ralph digest --loop --interval
// 30m` in the tmux window `ralph start` opens. It lived in lib/commands/schedule.js
// until #62 needed a second caller, and a second copy of a regex is a second answer
// waiting to happen.
//
// The grammar is EXACTLY the one the scheduler shipped, character for character: an
// integer, optional whitespace, an optional single-letter unit defaulting to
// seconds. Nothing was widened while moving it — a repo with a scheduled cycle has
// already been told which formats work, and `0.5h` throwing is part of that
// contract, not an accident of the old regex.
//
// What did NOT move: DEFAULTS. `ralph schedule` answers 4h for a missing interval
// because launchd must be handed some number; the digest answers nothing, because a
// timer nobody asked for must not start. A parser that defaulted would smuggle one
// caller's policy into every other one, so this one throws and each caller decides.
const SECONDS_PER_UNIT = { s: 1, m: 60, h: 3600, d: 86400 }

// Neutral on purpose: no exit code, no command name. `ralph schedule` re-throws it
// as ScheduleAbort (keeping its own exit code and its own message bytes), `ralph
// digest` turns it into one line on stderr and no loop. An error class that knew
// about exit codes could not be shared by two commands that disagree about them.
export class InvalidDurationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidDurationError'
  }
}

// `input` → whole seconds. Throws InvalidDurationError on anything else, including
// null/undefined/'' — see the note about defaults above.
//
// Zero PARSES. `--interval 0` is a duration of nothing, not a syntax error, and the
// callers disagree about what to do with it: launchd takes it literally, and any
// spelling of zero is how ralph.config.sh turns the digest off (#60). Deciding here
// would take that decision away from both.
export function parseDuration(input) {
  // `String(input)` and not `String(input ?? '')`: the message interpolates the raw
  // input, and this is precisely what the scheduler's regex saw before the move.
  const m = String(input).trim().match(/^(\d+)\s*([smhd]?)$/i)
  if (!m) {
    throw new InvalidDurationError(
      `invalid interval: ${input} (expected e.g. 60, 30m, 2h, 1d)`,
    )
  }
  const value = Number.parseInt(m[1], 10)
  const unit = (m[2] || 's').toLowerCase()
  const seconds = SECONDS_PER_UNIT[unit]
  // Unreachable through the regex above, and kept anyway with the message the
  // scheduler used to raise here: the two guards are one edit apart, and a widened
  // character class with no matching multiplier should say so rather than return NaN.
  if (seconds == null) {
    throw new InvalidDurationError(`invalid interval unit: ${unit}`)
  }
  return value * seconds
}

// setTimeout's ceiling. Its delay is a SIGNED 32-BIT millisecond count: hand it one
// more and node warns TimeoutOverflowWarning and fires after 1ms instead of waiting.
// ~24 days 20 hours, which is why the number looks arbitrary and is not.
export const MAX_TIMER_MS = 2_147_483_647

// The same grammar, narrowed to the durations a JS timer can actually WAIT — which is
// every duration Ralph loops on. Two questions, deliberately kept apart: `ralph
// schedule` hands its seconds to launchd, which has no such ceiling and for which a
// 30-day StartInterval is a legitimate answer, so parseDuration must keep accepting
// one. Anything that becomes a setTimeout has to be bounded at BOTH ends, because the
// failure is the same at both: zero and 25d each turn a half-hourly narration into a
// paid model call per millisecond.
//
// Shared rather than checked twice on purpose: `ralph start` validates an interval
// before opening the digest window, and `ralph digest --loop` validates it again in
// the window. Two copies of this ceiling would eventually disagree, and the shape of
// that disagreement is a window opened for an interval the loop inside it refuses.
export function parseTimerDuration(input) {
  const seconds = parseDuration(input)
  if (seconds <= 0) {
    throw new InvalidDurationError(
      `an interval of ${input} is not an interval (expected e.g. 60, 30m, 2h, 1d)`,
    )
  }
  if (seconds * 1000 > MAX_TIMER_MS) {
    throw new InvalidDurationError(
      `an interval of ${input} is longer than a timer can wait (the longest is 24d)`,
    )
  }
  return seconds
}
