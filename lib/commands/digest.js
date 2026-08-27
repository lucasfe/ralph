// `ralph digest` (#61) — the CLI shell around the digest engine (lib/digest.js).
//
// Its whole job is ROUTING, and the two channels mean different things: stdout
// carries the narrative and its one heading, so `ralph digest > notes.md` and `ralph
// digest | pbcopy` collect prose and nothing else; stderr carries every diagnostic,
// so a failure is visible to a human watching the terminal and invisible to whatever
// is consuming the pipe.
//
// EXIT 0, ALWAYS. A digest is an accessory to a run: it explains what is happening,
// it never changes it. So a missing agent, an unauthenticated one, a hang, an empty
// answer and a project that has never run all end the same way — one terse line on
// stderr and a successful exit — because a non-zero exit here would make a watchdog
// or a `&&` chain treat "could not narrate the run" as "the run is broken".
//
// That includes an engine that THROWS. runDigest is written not to, but the promise
// is kept here too rather than only there: this is the last frame before the process
// exits, and a stack trace on a reader's terminal at 4am is noise about the reader's
// tool rather than news about their run.
//
// #62 added --loop: the same digest, on its own timer, until something kills it —
// which is how `ralph start` runs it in a second tmux window beside the loop. The
// exit-0 contract above holds tick by tick AND for the loop as a whole: a digest
// that fails writes its line and the timer keeps its appointment, because a night
// of narration is worth having and no single entry in it is worth stopping for.

import { oneLine, renderDigest, runDigest } from '../digest.js'
import { InvalidDurationError, parseTimerDuration } from '../duration.js'

// Declared with no throw site, like status's StatusAbort: every outcome of this
// command is a successful exit, so it has no failure of its own to signal. Kept so
// the command block in bin/ralph.js has the same catch-its-own-Abort shape as every
// other block there, and so a future digest that CAN fail hard has somewhere to say
// so.
export class DigestAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export async function digestCommand({
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  run = runDigest,
  // #62: --loop. A task takes 40-100 minutes, so a half-hourly digest cannot ride
  // on iteration boundaries — it needs a clock of its own, and `ralph start` gives
  // it one as a second tmux window beside the loop.
  loop = false,
  interval = null,
  // The clock, injected on the same convention as every other collaborator here:
  // real setTimeout by default, a recorder in tests, so no suite waits 30 minutes
  // to prove a 30-minute interval.
  sleep = defaultSleep,
  // What a SIGTERM is to this loop. In the field the answer is always yes and the
  // loop ends when the pane dies; in tests it is what bounds the timer. It gates
  // CONTINUING, not starting: a window killed during its first digest still leaves
  // that digest in the pane.
  shouldContinue = () => true,
  ...engine
} = {}) {
  if (!loop) return emitDigest({ cwd, env, stdout, stderr, run, engine })

  // The interval is the ONLY thing a looping digest cannot do without, so it is
  // checked before the first agent call rather than after. Still exit 0 and still
  // one line on stderr: the contract above is about every outcome, and a watchdog
  // must not read "I cannot narrate on that interval" as "the run is broken".
  //
  // `status` is a parameter because the two refusals are not the same news, and a
  // caller matching on it should not have to parse the sentence to tell them apart:
  // nothing supplied is not the same as something supplied that the grammar rejected.
  const refuseToLoop = (why, status = 'invalid-interval') => {
    stderr.write(`ralph digest: not looping — ${why}\n`)
    return { exitCode: 0, status, runs: 0 }
  }

  // Absent is its own case, ahead of the grammar: `--loop` with nothing after it is
  // how anyone reaches this by hand, and the parser can only say `invalid interval:
  // null` — a sentence about this command's option parsing rather than about what the
  // reader has to type next. Its own status too, for the same reason: `invalid-interval`
  // for an interval nobody supplied names a fault that never happened.
  if (interval == null || String(interval).trim() === '') {
    return refuseToLoop('--loop needs an interval (e.g. --interval 30m)', 'no-interval')
  }

  // parseTimerDuration, not parseDuration: this interval becomes a setTimeout, and
  // both ENDS of that are traps. Zero parses (it is a duration of nothing) and is the
  // value most likely to arrive by accident, since any spelling of zero is how
  // ralph.config.sh turns the digest off (#60); `25d` parses too and overflows
  // setTimeout's signed 32-bit delay, which makes node fire after 1ms instead of
  // waiting (#62 QA). Both end as a digest per millisecond against a paid model, so
  // both are refused by the shared function `ralph start` validates with — one place
  // to read, so a window is never opened for an interval this loop would reject.
  let seconds
  try {
    seconds = parseTimerDuration(interval)
  } catch (e) {
    return refuseToLoop(e instanceof InvalidDurationError ? e.message : oneLine(e?.message))
  }

  let runs = 0
  for (;;) {
    // AC#8: a night of digests is worth having and no single one of them is worth
    // the timer. emitDigest already swallows an engine that throws; this catch is
    // for the frame around it — a broken stream, a renderer that trips on a shape
    // nobody predicted — because the alternative is a pane that stops narrating
    // hours before anyone attaches to it.
    try {
      await emitDigest({ cwd, env, stdout, stderr, run, engine })
    } catch (e) {
      stderr.write(`ralph digest: skipped this one (${oneLine(e?.message) || 'unknown failure'})\n`)
    }
    runs += 1
    if (!shouldContinue()) break
    await sleep(seconds * 1000)
  }

  return { exitCode: 0, status: 'stopped', runs }
}

// One digest, routed. This is the whole of the pre-#62 command, unchanged, so the
// one-shot run and every tick of --loop print and diagnose identically.
async function emitDigest({ cwd, env, stdout, stderr, run, engine }) {
  let result
  try {
    result = await run({ cwd, env, stderr, ...engine })
  } catch (e) {
    // Collapsed to one line, and the message only — a stack trace would be about
    // Ralph's internals, which is not what the reader asked.
    const why = oneLine(e?.message) || 'unknown failure'
    stderr.write(`ralph digest: could not produce a digest (${why})\n`)
    return { exitCode: 0, status: 'failed' }
  }

  // The narrative and the diagnostic are independent: a digest can be printed AND
  // have failed to be recorded, and a reader deserves both facts.
  if (result?.narrative) {
    for (const line of renderDigest(result)) stdout.write(line + '\n')
  }
  if (result?.diagnostic) {
    stderr.write(oneLine(result.diagnostic) + '\n')
  } else if (!result?.narrative) {
    // Nothing printed and nothing explained: an engine result this shape is a bug,
    // but silence would leave the reader thinking the digest had simply nothing to
    // say about a live run.
    stderr.write('ralph digest: no digest and no reason given\n')
  }

  return { exitCode: 0, status: result?.status ?? 'failed' }
}

// #62: the real clock, and the only thing holding the process open between digests.
// Emphatically NOT unref'd: nothing else in a `ralph digest --loop` keeps the event
// loop alive — stdin has no reader — so an unref'd timer would let node exit after
// the first digest and the window would look like a one-shot that forgot to end.
// The process ends when the pane does.
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
