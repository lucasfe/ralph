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

import { oneLine, renderDigest, runDigest } from '../digest.js'

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
  ...engine
} = {}) {
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
