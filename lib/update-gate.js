import pc from 'picocolors'
import { confirm } from './utils/prompt.js'
import { recordPromptShown, resolveUpdateDecision } from './update-check.js'
import { updateCommand } from './commands/update.js'

// #25: the question, verbatim as it shipped. It reads as a prompt with a default
// ("[y/N]") because `confirm` treats anything but an explicit yes as a decline.
const UPDATE_QUESTION = 'Update now? [y/N]: '

// #50: the update gate — #24's notice, #25's TTY-gated prompt and #26's weekly
// prompt window as ONE policy behind one call, extracted verbatim out of
// `ralph start`'s step 2.5 so `ralph cycle` can reuse it instead of duplicating a
// ~50-line block and every seam it injects. Each of those seams is still a seam
// here, on the same convention, so both call sites drive the identical policy and
// neither contributes any of its own.
//
// What a caller gets is a VERDICT, never a decision to make: whether something
// newer exists, which version, whether a question was actually shown, whether it
// was accepted, whether an install really landed, and which version landed. The
// two CONSEQUENCES of an accepted install — announcing the new version and
// refusing to launch on the old one, or the neutral "did not complete" line — stay
// with the caller, because only the caller knows what it was about to launch.
//
// Where the policy is NOT re-explained: the two weekly windows (what shouldPrompt
// means, why the prompt window is independent of the network one, and why
// RALPH_NO_UPDATE_CHECK needs no handling at this site) are documented once, on
// resolveUpdateDecision in ./update-check.js, which owns the rule.
//
// Never throws, with two deliberate exceptions: `ask`, and the notice write —
// which means `stdout.write` itself AND the interpolation of `latestVersion` into
// the notice, since that value is carried by reference from the decision and a
// caller-supplied `toString` runs there, outside any try. Every other boundary —
// the decision and every read of it, the stamp, the install, the clock, the env
// bag — is guarded here, so a caller with no try/catch around this call cannot
// lose its run to what is only advice.
//
// The write is unguarded for the same reason startCommand's own `out` is: a process
// whose stdout throws has lost the run either way, and swallowing it would hide a
// broken terminal behind a silent success.
//
// A prompt that throws or rejects is left to escape, exactly as it did
// before this module existed: the real `confirm` cannot do either (a Ctrl-C kills
// the process, an EOF hangs), and the pinned tests in
// lib/commands/start.update-prompt.qa.test.js document that if it ever becomes
// reachable the fix is to treat a broken prompt as a decline, not to swallow it
// here and start a loop the user never asked for.
export async function runUpdateGate({
  currentVersion = 'unknown',
  exec,
  // No defaults for the clock, the env bag, the home or the cache fs: an undefined
  // value here reaches the callee's OWN default (the real clock, process.env, the
  // real home, the real fs), which keeps one source of truth for each of them in
  // ./update-check.js and ./version-cache.js.
  now,
  processEnv,
  home,
  cacheFs,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  // #25: the prompt is TTY-gated — a blocking readline on a launchd- or CI-spawned
  // process would hang forever, so a non-interactive run only ever gets #24's
  // printed notice. The default is derived from the RESOLVED `stdin` above so a
  // caller that injects a non-interactive stream cannot be handed a readline over
  // it: `confirm` never resolves on an input that ends without a line, which is an
  // unrecoverable hang rather than a cosmetic defect. Legal because destructuring
  // defaults evaluate left to right and `stdin` is declared before this.
  isTTY = Boolean(stdin?.isTTY),
  // The four injectable seams. The defaults are the same functions `ralph start`
  // names in its own signature, so a caller may forward its own or let these
  // stand; tests replace either end.
  update = resolveUpdateDecision,
  recordPrompt = recordPromptShown,
  runUpdate = updateCommand,
  ask = confirm,
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')

  // resolveUpdateDecision is total by contract and prints nothing itself, so a
  // failed or throttled check is silent. The try is for the SEAM, not for it: an
  // injected decision may do anything, and a hostile env bag escapes even the real
  // one (isUpdateCheckDisabled reads RALPH_NO_UPDATE_CHECK ahead of any try block
  // there). Either way the run gets a verdict rather than a stack trace.
  //
  // The three READS live inside the guard too, not just the call. A decision is an
  // injected value all the way down, so a property getter can throw exactly as
  // easily as the call can, and a read left outside would hand a caller with no
  // try/catch the stack trace this module promises it will never see. They are
  // copied into plain locals so no later line touches the object again; only the
  // flags are coerced — `latestVersion` is carried by reference, so a caller that
  // passes a version object gets that same object back in the verdict.
  let latestVersion = null
  let isNewer = false
  let shouldPrompt = false
  try {
    const decision = await update({ currentVersion, exec, now, processEnv, home, fs: cacheFs })
    latestVersion = decision?.latestVersion ?? null
    isNewer = Boolean(decision?.isNewer)
    shouldPrompt = Boolean(decision?.shouldPrompt)
  } catch {
    // A decision that cannot be read is treated as no decision at all: silent, no
    // notice, no question. All three are reset because a getter that throws part
    // way through leaves the locals read before it already assigned, and a half-read
    // decision is not one this module is willing to act on.
    latestVersion = null
    isNewer = false
    shouldPrompt = false
  }
  if (!isNewer) return verdict({ latestVersion })

  // #24: the notice, printed on EVERY run where something newer exists, TTY or
  // not, throttled question or not. One line, naming the manual upgrade command —
  // it is #24's tested contract and the useful answer for a user who declines. The
  // question below is an addition after it, never a replacement.
  out(pc.yellow(`New version available: ${latestVersion} (run npm i -g @lucasfe/ralph to update)`))

  let prompted = false
  let accepted = false
  if (shouldPrompt && isTTY) {
    prompted = true
    // #26: the stamp lands here, and BEFORE the answer is awaited, because this is
    // the only place that knows a question was actually put to a human — the
    // decision above is also resolved on headless runs (cron, launchd, CI) where
    // nothing is ever displayed. And the window belongs to the asking, not the
    // answering: a user who Ctrl-Cs at the prompt has seen it, and must not be
    // asked again on their next run seconds later.
    try {
      recordPrompt({ now, processEnv, home, fs: cacheFs })
    } catch {
      // Best-effort, like every other write to the global cache: losing the stamp
      // costs one extra question next run, never the run itself.
    }
    accepted = Boolean(await ask(UPDATE_QUESTION, { input: stdin, output: stdout }))
  }
  if (!accepted) return verdict({ isNewer: true, latestVersion, prompted })

  const installed = await runUpdateSafely({ runUpdate, currentVersion, exec, stdout, stderr })
  return verdict({
    isNewer: true,
    latestVersion,
    prompted,
    accepted: true,
    installed: installed.ok,
    // The version the caller may announce. `to` is what the install itself
    // reports; the notice's version is the fallback for an install that updated
    // without naming one.
    installedVersion: installed.ok ? (installed.to ?? latestVersion) : null,
  })
}

// One shape for every path, so a caller never has to test for a missing key: an
// opt-out run, a throttled run and a completed install all answer the same six
// questions.
function verdict({
  isNewer = false,
  latestVersion = null,
  prompted = false,
  accepted = false,
  installed = false,
  installedVersion = null,
} = {}) {
  return { isNewer, latestVersion, prompted, accepted, installed, installedVersion }
}

// #25: run the update and answer the one question the caller needs — "is a NEW
// version installed now?". Gated on `updated`, NEVER on `to`: updateCommand's `to`
// names the version that is out there, so it is set even when the install failed or
// was refused (npx run, linked dev checkout), and gating on it would announce an
// update that never happened. Every throw is swallowed for the same reason the
// non-zero exit is tolerated — updateCommand has already written its own
// diagnostics, and an update is never worth losing a run over.
async function runUpdateSafely({ runUpdate, currentVersion, exec, stdout, stderr }) {
  try {
    const result = await runUpdate({ currentVersion, exec, stdout, stderr })
    return result?.updated ? { ok: true, to: result.to } : { ok: false }
  } catch {
    return { ok: false }
  }
}
