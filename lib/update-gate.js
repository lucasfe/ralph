import pc from 'picocolors'
import { confirm } from './utils/prompt.js'
import { recordPromptShown, resolveUpdateDecision } from './update-check.js'
import { updateCommand } from './commands/update.js'
import { classifyInstall } from './install-target.js'

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
// the decision and every read of it, the classification and every read of it
// (#200), the stamp, the install, the clock, the env bag — is guarded here, so a
// caller with no try/catch around this call cannot lose its run to what is only
// advice.
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
  // The five injectable seams. FOUR of them — `update`, `recordPrompt`, `runUpdate`
  // and `ask` — default to the same functions `ralph start` names in its own
  // signature, so a caller may forward its own or let these stand; tests replace
  // either end. `classify` is the exception: its default lives ONLY here.
  // lib/commands/start.js:141 and lib/commands/cycle.js:138 declare it with no default
  // on purpose, so an omitted forward lands on this line rather than on a second copy
  // of `classifyInstall` in each command.
  update = resolveUpdateDecision,
  recordPrompt = recordPromptShown,
  runUpdate = updateCommand,
  ask = confirm,
  // #200: how this copy was installed — the layout decides which channel the check
  // asks and which command the notice names. No install path is forwarded, on
  // purpose: `classifyInstall` falls back to RALPH_HOME, which lib/paths.js:7 resolves
  // from that module's OWN URL to this package's root directory — the only install the
  // notice can honestly describe. Tests inject their own layout through here.
  classify = classifyInstall,
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')

  // #200: the classification, at most once per run and only when something wants it.
  //
  // `exec: null` is the load-bearing part. The probe `classifyInstall` falls back to
  // for a layout no path marker matches is `npm root -g`, a subprocess — and this GATE
  // runs on every `ralph start`, including every run inside the 7-day window, which
  // spawns nothing at all today. Withholding the spawner keeps that true: what it gives
  // up is telling a plain npm global install apart from an unrecognized one, and those
  // two answer the same channel and the same notice command, so the notice cannot tell
  // the difference either. (The classification itself is lazier still — the thunk at :164
  // and the notice read at :187 are the only two things that ever ask for it.)
  //
  // Guarded because `classify` is a seam and a classification is a value this module
  // did not build: a throw here would cost the run, and #50's whole contract is that
  // this is advice. A null answer means "no layout to speak of", which reads as no
  // command in the notice and npm for the query — and a FAILED classification answers
  // null for the rest of the run rather than being retried, since a `classify` that
  // threw once has no more reason to succeed on the second ask than it had on the first.
  //
  // The memo is the PROMISE, not a flag beside a variable (#200 QA found that version:
  // it set "classified" before the await and assigned the answer after it, so a consumer
  // arriving while the first classification was still in flight was handed `undefined` —
  // no channel, hence npm, for a layout that had just been identified as Homebrew).
  // "At most once per run" is a promise about the ANSWER two consumers share, not only
  // about the call count, and awaiting one shared promise is what makes both true at
  // once. The never-throws guarantee is inside it: the try wraps the await, so the
  // memoized promise RESOLVES to null on failure and never rejects — no consumer, in any
  // order, can be handed a rejection.
  //
  // `pending` is a local of THIS call, so two `runUpdateGate` calls in one process — which
  // is what THE SUITE does, not what `ralph cycle` does: `cycleCommand` calls this gate
  // exactly once (lib/commands/cycle.js:284, under no loop) and bin/ralph.js:204 invokes
  // `cycleCommand` once per process — classify independently, and one run's failure cannot
  // poison the next.
  let pending = null
  const installTarget = () => {
    pending ??= (async () => {
      try {
        return (await classify({ exec: null })) ?? null
      } catch {
        return null
      }
    })()
    return pending
  }

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
    const decision = await update({
      currentVersion,
      exec,
      now,
      processEnv,
      home,
      fs: cacheFs,
      // #200: a THUNK, not a descriptor. resolveUpdateDecision resolves it only on the
      // run that actually queries a channel, so the throttled and opted-out paths
      // classify nothing — which is what keeps this call as cheap as it was when it
      // always asked npm.
      latestSource: async () => (await installTarget())?.latest,
    })
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

  // #200: the command THIS layout is updated by, or null when it has none. Read here,
  // inside a guard, because the notice write below is deliberately unguarded and a
  // classification is an injected value whose getter can throw as easily as its call
  // can. Non-strings and blanks answer null too: a notice must not offer "run
  // undefined to update".
  let noticeCommand = null
  try {
    const label = (await installTarget())?.noticeLabel
    noticeCommand = typeof label === 'string' && label.trim() ? label.trim() : null
  } catch {
    noticeCommand = null
  }

  // #24: the notice, printed on EVERY run where something newer exists, TTY or
  // not, throttled question or not. One line, naming the manual upgrade command —
  // it is #24's tested contract and the useful answer for a user who declines. The
  // question below is an addition after it, never a replacement.
  //
  // #200: that command comes from the classification, so each user reads the one that
  // applies to their install. Until then this line named an npm global install for
  // every layout there is, which told a Homebrew user to plant a second copy competing
  // on PATH. A layout with nothing to run — an npx run, a linked checkout — gets the
  // version and no command at all, because the only command there is to name is the
  // one an accepted prompt would then refuse to run; `ralph update` is where that
  // refusal is explained, on the run the user asked for.
  const byHand = noticeCommand ? ` (run ${noticeCommand} to update)` : ''
  out(pc.yellow(`New version available: ${latestVersion}${byHand}`))

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
