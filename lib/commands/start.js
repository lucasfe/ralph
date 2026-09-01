import { existsSync, readFileSync as realReadFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { execa } from 'execa'
import pc from 'picocolors'
import { loadEnvFile } from '../utils/env.js'
import { createCredentialResolver } from '../utils/global-config.js'
import { commandExists } from '../utils/which.js'
import { confirm } from '../utils/prompt.js'
import { defaultRalphBinary, templatePath } from '../paths.js'
import { assertCriticalDeps } from './doctor.js'
import { checkDeps } from '../deps.js'
import { detectPlatform } from '../platform.js'
import { isUpdateCheckDisabled, recordPromptShown, resolveUpdateDecision } from '../update-check.js'
import { runUpdateGate } from '../update-gate.js'
import { updateCommand } from './update.js'
import { sendWhatsappMessage } from '../utils/whatsapp.js'
import { peekLock as defaultPeekLock, sessionNameFor } from '../lock.js'
import { readConfigText } from '../read-config-source.js'
import { parseConfigVar, configAssignsVar } from '../parse-config-var.js'
import { parseTimerDuration } from '../duration.js'
// The same one-line-diagnostic rule `ralph digest` prints its own failures through
// (#62), imported rather than re-derived: it collapses whitespace AND caps the length,
// and a warning here is read in the same terminal as one from there. Asked of
// lib/one-line.js rather than of lib/digest.js since #108 — the function was never
// about digests, and one import path to it is better than two.
import { oneLine } from '../one-line.js'
// ...and the knob this command opens the digest's window with, read by the one rule
// `ralph digest --loop` waits on and `ralph status` measures staleness against (#63).
import { digestInterval } from '../digest-file.js'
import { resolveSource } from '../task-source.js'
import { queueCount as folderQueueCountLib } from '../folder-queue.js'
import { metricsPath, safeReadText } from '../issue-metrics.js'
import { buildLaunchProjection, renderLaunchProjection } from '../progress.js'
// #67: the banner's gate and its rendered frames. Both pure, both fed values this
// command already has injected — see the `stdoutIsTTY`/`color` options below.
// #73: ...and it is now every frame rather than the one still, because the banner animates.
import { colorEnabled, renderSplashFrames } from '../sprite-banner.js'
// #73: the one impure piece of the banner, and the only module in the whole feature that
// touches a stream or a clock. It is imported HERE and by no other command, which is the
// shape criterion 7 asks for: nothing but `ralph start` can animate anything.
import { playSplash } from '../sprite-player.js'
// #68: the banner's other half — the identity box, composed from resolved facts. Pure
// too, which is why the impure half of it (reading the cached version below) is this
// command's job rather than the module's.
// #161: ...and the ladder itself, because this command now spends one more of its rungs: on a
// terminal wide enough to hold both blocks the box goes BESIDE the sprite instead of under it.
// The threshold is not spelled here — `bannerLayout` answers, exactly as it answers
// lib/sprite-banner.js about 26, so there is still one ladder and one owner of it.
import { bannerLayout, composeBanner } from '../banner-compose.js'
// #161: the horizontal join, and the sprite's visible width for it to offset the box by. The
// width comes from the ART because a rendered sprite line is mostly escape bytes and no honest
// count of the string is a column count; the join is pure and writes no escape of its own.
import { joinBeside } from '../banner-beside.js'
import { spriteWidth } from '../sprite-data.js'
// #69: the two facts the box cannot simply be handed — which model the agent will use, and
// which repository the loop will read issues from. Pure, like everything else in the banner:
// the metrics log and .git/config are read HERE and their TEXT goes in, which is what keeps
// the resolution rules testable without a previous run or a git remote. #116 gave them a
// module each, because that is all they ever had in common: one weighs evidence about a
// model, the other parses git's config format.
import { resolveBannerModel } from '../banner-model.js'
import { resolveBannerRepo } from '../git-remote-slug.js'
// ...and the registry that turns RALPH_AGENT into the agent that will actually run. The box
// reports the RESOLVED agent for the same reason the telemetry records it: the row is about
// what is about to happen, not about what was typed.
import { resolveAgent } from '../agent-registry.js'
// #74: ...and how much of that banner the user actually asked for. Pure, and it is the ONLY
// policy about the banner this command still holds — the configured value and the environment
// override go in, and the frame count and whether to print the box at all come out. Every
// rule about precedence and every rung of the sprite's gate lives in there, so there is
// nothing here to get wrong except which values to forward.
import { resolveBannerMode } from '../banner-mode.js'
import { readVersionCache } from '../version-cache.js'
// #70: the box's what's-new section, in the same two halves — the pure grammar of
// CHANGELOG.md and the reader that resolves it inside the installed package. No network
// call and no latency: the file ships in the tarball, so the newest release's bullets cost
// one local read of a file that is already next to lib/.
import { latestBullets } from '../changelog.js'
import { readChangelogEntries } from '../changelog-file.js'
// #139: Ralph's label vocabulary and the query composed from it. The three commands that
// select work used to carry a hand-typed copy of that query each, with nothing checking that
// the three agreed — and the labels this command CREATES were three near-identical blocks of
// argv spelling the same words a fourth time. Both are one import now: the query the loop
// selects with and the labels it stamps cannot drift, because there is one spelling of each.
// ...and, since #141, the retired-name check read off the same mapping: it composes the `gh
// label edit` line this command prints, so the warning cannot name a rename the module does not
// know about. It takes the `exec` below rather than importing one — see labels.js's header.
import {
  findLegacyLabels,
  ISSUE_SEARCH_QUERY,
  IN_PROGRESS_LABEL,
  MANAGED_LABELS,
} from '../labels.js'

const DEFAULT_STARTUP_MESSAGE = '🟢 Ralph started and is active.'
// #62: the digest's window name. Named rather than addressed by index so teardown
// and inspection have a stable handle — see openDigestWindow below.
const DIGEST_WINDOW = 'digest'

class StartAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export async function startCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  // #25: the update prompt is TTY-gated — a blocking readline on a launchd- or
  // CI-spawned process would hang forever, so a non-interactive run only ever
  // gets #24's printed notice. The default is derived from the RESOLVED `stdin`
  // above — the injected stream when there is one, the ambient `process.stdin`
  // otherwise via that parameter's own default — precisely so a caller that
  // injects a non-interactive stream cannot be handed a readline over it:
  // `confirm` never resolves on an input that ends without a line, so that would
  // be an unrecoverable hang. Legal because destructuring defaults evaluate left
  // to right and `stdin` is declared before this.
  isTTY = Boolean(stdin?.isTTY),
  exec = execa,
  exists = existsSync,
  loadEnv = loadEnvFile,
  hasCommand = commandExists,
  ask = confirm,
  currentVersion = 'unknown',
  update = resolveUpdateDecision,
  // #26: the prompt-window stamp. Injected on the same convention as `update` and
  // `cacheFs` below, so the CALL is observable and orderable in tests — several of
  // them spy on it to assert it runs before `await ask`. The write it performs is
  // asserted through `cacheFs`, not through here.
  recordPrompt = recordPromptShown,
  // #25: the `ralph update` machinery from #21, injected so tests never shell out.
  runUpdate = updateCommand,
  sendWa = sendWhatsappMessage,
  peekLock = defaultPeekLock,
  readFile = realReadFileSync,
  folderQueueCount = defaultFolderQueueCount,
  now = Date.now,
  home = homedir(),
  processEnv = process.env,
  // #67: the two capabilities the sprite banner needs. Deliberately NOT the `isTTY`
  // above — that one is about STDIN, and it gates a blocking readline; this one is
  // about STDOUT, and it gates escape sequences. A launchd run piping stdout to a
  // log can still be interactive on stdin and vice versa, so folding them together
  // would print a screenful of ANSI into a log file to decide whether to prompt.
  // Same left-to-right destructuring trick as `isTTY`: derived from the RESOLVED
  // `stdout` above, so injecting a stream is enough to control it, and overriding
  // the option explicitly still wins over whatever the stream claims.
  stdoutIsTTY = Boolean(stdout?.isTTY),
  // ...and the colour policy, resolved from the environment already injected above
  // rather than from `process.env`, so a test never depends on the shell it runs in
  // (#41). See lib/sprite-banner.js for why NO_COLOR is honored on presence.
  color = colorEnabled({ env: processEnv, isTTY: stdoutIsTTY }),
  // #68: the width the identity box is held to — and, since #72, the width the SPRITE
  // is gated on too, so this one option now feeds BOTH halves of the banner and there
  // is still only one column count to inject. Same left-to-right trick again, from the
  // RESOLVED `stdout`: a terminal reports its columns, a pipe reports `undefined`, and
  // `bannerLayout` treats absent — or zero, which some CI runners report — as its own
  // 60-column default rather than as a one-column box.
  columns = stdout?.columns,
  // #73: the splash's two impure capabilities — how it waits between frames, and where it
  // listens for the Ctrl-C that would otherwise leave a hidden cursor behind.
  //
  // FORWARDED RATHER THAN DEFAULTED HERE, which is the one place this signature does that
  // deliberately: lib/sprite-player.js owns both defaults (a real 200ms timer, and the real
  // `process` as the signal source), so the timer and the listener are named once, in the
  // module whose spec asserts them. Passing `undefined` through is exactly what a caller
  // that has no opinion does with `stdoutIsTTY` or `cacheFs`.
  //
  // Injected in every test that drives this command over a TTY stdout, because the honest
  // default costs a second of wall clock per run and registers a listener on the vitest
  // worker's own process. A test that wants the timing asserts the naps instead.
  sleep,
  signals,
  // #24: fs impl for the global update-check cache — injected (memfs) in tests
  // so no run touches the real ~/.config/ralph.
  cacheFs,
  // #68: how the box learns there is a newer version. THE CACHE ONLY — this is the
  // banner, printed before the first preflight line, and it must not add a network
  // round trip to `ralph start`'s first paint. The registry check is #24's, it happens
  // at step 2.5 with its own weekly throttle, and it is what fills this cache; the box
  // reports what that last check left behind. Injected so no test in this repo reads a
  // real ~/.config/ralph and so a developer's own cached update cannot add a row to
  // another suite's expected output (#41).
  readCache = readVersionCache,
  // #70: how the box learns what changed in this release. THE SHIPPED FILE ONLY — same
  // argument as `readCache` above: this is the banner, printed before the first preflight
  // line, so it may not add a round trip to the first paint. CHANGELOG.md is in the
  // tarball, so the answer is already on disk beside lib/.
  //
  // Injected on the same convention, and for the same two reasons: no test in this repo
  // should assert against whatever this week's release notes happen to say, and no
  // developer's checkout should be able to change another suite's expected output (#41).
  readChangelog = readChangelogEntries,
  // ...and the fs UNDER that reader, so the DEFAULT wiring is testable too — memfs can
  // hold a changelog at the installed module's own path without the real file being read.
  // Same seam, same spelling, as `cacheFs`.
  changelogFs,
  // #62: the binary the digest window runs, resolved the way schedule.js resolves
  // the one it writes into a plist. Injectable so no test's expectations depend on
  // how the process was spawned.
  ralphBinary = defaultRalphBinary(),
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')
  const err = (msg) => stderr.write(msg + '\n')

  // #74: the ONE read of ralph.config.sh, and it happens HERE — above the banner rather than
  // below it, because the banner's own mode is one of the things written in that file. This is
  // exactly the move #68's comment predicted a later slice would need ("a slice that wants
  // them in the box must move the config read above it, not the box below them"), and ONLY
  // THE READ MOVED: `source` and `digest` are still derived at the preflight step that uses
  // them, out of this same text.
  //
  // Safe to be first because this line is inert: `readConfigText` runs no shell, writes
  // nothing, and answers '' for a missing or unreadable file rather than throwing. So the
  // first thing a user SEES is still the banner, and the first thing this command DOES to the
  // machine is still the tmux uniqueness check.
  const configText = readConfigText(resolve(cwd, 'ralph.config.sh'), { exists, readFile })

  // #122/#149: THE PRECEDENCE RULE FOR EVERY KNOB THIS COMMAND READS, STATED ONCE, HERE.
  //
  // What this box promises is that it names what THE LOOP will use, and the loop's answer for a
  // knob is decided by whether ralph.config.sh ASSIGNS the name — not by whether the value it
  // assigns is truthy. templates/ralph.sh sources that file with `set -a`, and an assignment
  // exports whatever it holds, the empty string included, OVER an inherited value. Measured against
  // a real bash (GNU bash 5.3.15, aarch64-apple-darwin25.4.0) with `gpt-5-codex` inherited, across
  // all six ways a file can blank a knob — a seventh only LOOKS like one, see THE ONE CAVEAT below:
  //
  //   RALPH_CODEX_MODEL=""            -> []
  //   RALPH_CODEX_MODEL=''            -> []
  //   RALPH_CODEX_MODEL=              -> []
  //   RALPH_CODEX_MODEL=<3 spaces>    -> []          (bash ends the word at the `=`)
  //   export RALPH_CODEX_MODEL=       -> []
  //   RALPH_CODEX_MODEL="   "         -> [   ]       (quoted whitespace IS a value bash keeps)
  //
  // So the question is PRESENCE, and `configAssignsVar` is the only reader that can ask it —
  // `parseConfigVar` answers '' both for a file that never mentions the name and for one that
  // blanks it, and those two are opposites in the sourcing shell. Hence the ternary below and
  // never a `||`: an ABSENT assignment is the one case that reaches the environment, which is the
  // one case bash falls through on. (#118 and #120 spelled the same rule as
  // `configAssignsVar(...) ? parseConfigVar(...) : null` and then `??` onto the environment; one
  // ternary says it in one place, and there is no null left over for a caller to interpret.)
  //
  // #118 landed this shape for RALPH_AGENT and #120 for GH_REPO, each as a documented departure
  // from a `||` the other knobs used; #122 gave the `||` a name; #149 made the presence test THE
  // rule and pointed every knob at it, so there is one shape here instead of a rule plus a
  // recorded divergence. What a name still buys is that a knob which DEPARTS is visible BY NOT
  // CALLING IT, and exactly one does:
  //
  //   RALPH_BANNER   environment over config, the deliberate inversion — a banner is a property
  //                  of the INVOCATION, not of the repository. `resolveBannerMode` just below,
  //                  and lib/banner-mode.js, carry that argument.
  //
  // AND THIS IS NOT AN INVENTORY OF THE FUNCTION'S CONFIG READS. Three more belong to the digest
  // rather than to the box and do not call this: `digestInterval(configText)` at the preflight,
  // and `RALPH_AGENT` and `RALPH_DIGEST_MODEL` in the digest window's launch near the bottom —
  // ALL THREE config-only, with no environment fallback at all: a THIRD precedence, after the
  // inversion. Whether they should share this one is a wider question than this closure's.
  //
  // THE ONE CAVEAT, and it belongs to the READER rather than to this rule: an assignment here means
  // parse-config-var.js's grammar, which since the #149 review models bash's WORD rule as well as
  // its assignment head — a bare `NAME=` followed by a blank and a command word assigns nothing in
  // bash, so that module refuses such a line on both readers (`X= folder` included). What it still
  // reads where bash does not: an `export` prefix, and a subshell tail. Measured and pinned there.
  //
  // (The transcript above writes the knob as a bare `NAME=` on purpose. #41's ambient-surface
  // sweep is a regex over these sources and does not skip comments, so a dotted SCREAMING_CASE
  // placeholder in prose reads to it as a real environment read.)
  const sourcedValue = (name) =>
    configAssignsVar(configText, name) ? parseConfigVar(configText, name) : processEnv[name]

  // ...and the banner's whole shape, resolved once, in one pure call: whether there is a
  // sprite, whether it animates, whether the identity box prints and whether that box gets a
  // frame.
  //
  // PRECEDENCE IS ENVIRONMENT OVER CONFIG, which is deliberately the opposite of the
  // `TASK_SOURCE` line further down, and neither is a mistake. A task source is a property of
  // the REPOSITORY — every clone of it draws work from the same place, and a stray variable in
  // a shell must not quietly redirect a run — while a banner is a property of the INVOCATION:
  // `RALPH_BANNER=off ralph start` inside a wrapper script, a cron entry or a CI job has to be
  // silenceable without editing, and committing, a file that every other run in the repo
  // shares. See lib/banner-mode.js, which is where that argument is written down.
  //
  // The capabilities are the same three values the sprite gate and the box already get, which
  // is the point of resolving here: nothing below reads the terminal a second time.
  const banner = resolveBannerMode({
    configured: parseConfigVar(configText, 'RALPH_BANNER'),
    override: processEnv.RALPH_BANNER,
    isTTY: stdoutIsTTY,
    color,
    width: columns,
  })
  // A value we do not recognize costs one line of stderr and never the run — the same trade
  // `ralph init` makes for a mistyped RALPH_AGENT, down to the prefix, because a banner knob
  // is not worth an aborted launch and silence would leave a user editing a line that does
  // nothing. Through `oneLine` (#62) because this value came out of a committed file and an
  // ambient environment: a newline inside it would otherwise let a config file write a second
  // line of Ralph's own diagnostics. Since #108 that flattener also replaces what a whitespace
  // collapse cannot reach — ESC, BEL, the C1 block — so the same call now covers the terminal
  // instructions as well as the line breaks, and it lives in lib/one-line.js rather than behind
  // this module's execa import.
  if (banner.warning) err(`⚠️  ${oneLine(banner.warning)}`)

  // #118: ...and the other knob a typo can quietly cost a whole night, on the same terms and in
  // the same place. `resolveAgent` has always answered `{ agent, fellBack, warning }`; this
  // command read `.agent` for the box below and dropped the rest, so `ralph start` and the loop
  // it launches were the ONLY paths that fell back to claude in silence — `ralph doctor` and
  // `ralph init` both print this line, and the user of a mistyped RALPH_AGENT found out from the
  // telemetry the next morning.
  //
  // RESOLVED HERE, ONCE, and spent twice: the warning below, and `.agent` for the identity box
  // further down. Not two `resolveAgent` calls — see the note at the box about the frame, which
  // is the same argument: two sites resolving one value is two owners of one decision, and a box
  // naming one agent under a warning naming another fallback is the exact confusion #69 was
  // filed about. At the LOOP's precedence, config over environment, for the reason written out
  // at that box: warning about a value the run will not use is worse than silence, and
  // templates/ralph.sh sources ralph.config.sh with `set -a`.
  //
  // ABOVE THE SPLASH rather than beside the box, which is the one thing #69 deliberately did NOT
  // do. The box REPORTS the run and reads as one paragraph, so a diagnostic inside it would be a
  // second opinion in the middle of a launch announcement; this is the line the banner's own
  // fallback warning already occupies, and the two read as a pair. STDERR ONLY, so `ralph start
  // | tee` is unaffected and the launch record stays byte-identical.
  //
  // NOT through `oneLine`, unlike the banner's warning above it: `resolveAgent` sanitises its own
  // echo at the source (#108), one code point for one, so this sentence is already exactly one
  // line however hostile the value was. Re-flattening it here would trim padding the echo exists
  // to show. Same `⚠️ ` prefix and the same `err()` as `ralph init`'s copy of this line.
  //
  // PRESENT OR ABSENT, not truthy or falsy, and the difference is a real run — which is #118's
  // finding and, since #149, the rule stated at `sourcedValue` above rather than a departure from
  // one. A `||` here read the environment whenever the file's value was empty, but a config that
  // assigns the knob an empty value MASKS the environment in the shell that sources it, so
  // `RALPH_AGENT=""` meant the loop would resolve claude with nothing to report while this line
  // warned about the environment's `codx`: a diagnostic about text no run will read, which is the
  // exact trade the paragraph above rules out. It cost the box the same way, a row reading `codex`
  // over a loop running claude, which is #69's confusion restored.
  const { agent, warning: agentWarning } = resolveAgent({
    RALPH_AGENT: sourcedValue('RALPH_AGENT'),
  })
  if (agentWarning) err(`⚠️  ${agentWarning}`)

  // #67: the sprite, and the FIRST thing this command writes — above the tmux
  // uniqueness check, above every preflight line, and below only READS: #74's inert read of
  // the config, which is where its own mode comes from, and since #161 the equally inert
  // reads the identity box is made of. It is a curtain going up, so it has to be there on
  // the runs that fail too: a banner printed after the guard would be missing from exactly
  // the run where it is the only thing above the error. Empty array on a pipe, a log, or
  // NO_COLOR, so nothing at all is written and every other line stays byte-identical.
  //
  // #161 MOVED THE CALL, not the claim, and this note stays here because it is where the
  // banner step begins: `playBannerSplash` is now at the BOTTOM of this step, under the
  // facts, because the box may have to be glued into the frames before the first one is
  // written. Nothing between here and there writes a byte — see the facts below, which are
  // reads and nothing else — so what a user sees is still an animation ahead of everything
  // this command does to the machine, and lib/commands/start.banner.test.js pins that as an
  // ORDER over the whole run rather than as a prefix of stdout.
  //
  // #72: ...and the terminal's `columns` goes in here too, because the sprite is 26 cells
  // wide and a terminal narrower than that cannot hold it. It was the same number the box is
  // drawn at until #161 gave the beside arrangement one of its own (`besideWidth`, below); the
  // SPRITE is still measured against the whole terminal, because the whole terminal is what it
  // is drawn on and the box is what has to fit in what it leaves. Still NO
  // GATE HERE — the third capability is forwarded exactly like the other two and the
  // decision stays in lib/banner-compose.js's `bannerLayout`, so there is one ladder and
  // this command has no rung of its own to get wrong.
  //
  // #73: AND IT MOVES. The same still is now the first and last frame of a one-second
  // splash: the sprite's frames are redrawn in place five times and the animation settles
  // on the poster frame, which is the frame this line used to print on its own. What the
  // reader ends up looking at is unchanged; what changed is that it arrives alive.
  //
  // NOTHING IS AWAITED ON THIS LINE, and #161 is why that has to be said: rendering the frames
  // is arithmetic on three capabilities, while the `await`, the structural bound that makes it
  // safe and the wrapper that catches it moved to the bottom of this step with the call, and so
  // did the paragraph that used to be here about them. STILL NO GATE HERE either: the frame list is empty on a pipe, under NO_COLOR and
  // below 26 columns, and an empty list plays nothing at all — no sleep, no cursor control, not
  // one byte — so a piped `ralph start` is neither slower nor different by a single character.
  //
  // #74: ...and the FIRST of the two things RALPH_BANNER changes about the splash is what this
  // ternary answers. `off` — and a `full` the terminal capped down to it — resolves NO frames,
  // which is the state a pipe has always been in, so that path is the one already asserted
  // byte-for-byte: nothing written, no sleep, no cursor control. The second thing is `static`,
  // which keeps exactly these frames and changes the CYCLE COUNT instead; that one is an
  // argument, so it is described where it is passed.
  //
  // AND STILL NO RUNG HERE, in the sense the two paragraphs above mean it: `banner.sprite` is
  // an answer resolved once, at the top of this function, out of the same three capabilities
  // this line forwards to `renderSplashFrames`. The ternary spends it; it does not decide it.
  // ...and the frames themselves, resolved here — where the note above them is — and PLAYED
  // at the bottom of this step. Resolving them now keeps the two halves of the arrangement
  // next to each other: this is the list #161 may have to glue the box onto, and whether it
  // is empty is the first half of that question.
  const frames = banner.sprite
    ? renderSplashFrames({ isTTY: stdoutIsTTY, color, width: columns })
    : []

  // #68: ...and the identity box — which is the half a reader can USE — which
  // Ralph this is, where it is running, and whether a newer one is waiting.
  //
  // NOT gated on the terminal, and that is the deliberate part: the sprite above is
  // decoration and disappears on a pipe, but these are facts, and a launchd log or a CI
  // job is exactly where "which version, which directory" is the question being asked.
  // The PRD says a run without colour or without a TTY gets the facts alone, so that is
  // what it gets — in plain text, with not one escape byte, because `color` is passed
  // through and composeBanner only paints the update hint when it is true.
  //
  // Above every other side effect, for the same reason the sprite is: the aborting runs are
  // the ones where this box is the only context the error has. WHERE exactly it lands is
  // #161's question and the ladder's answer — beside the sprite on a terminal wide enough to
  // hold both, under it on every narrower one, and on its own wherever there is no sprite at
  // all. Composed here either way, before the first frame is written, because the beside
  // arrangement needs these lines to glue onto the frames.
  //
  // THE FACTS ARE RESOLVED HERE, which is the seam #69 grew into: agent, model, context
  // window, task source and repo are five more entries in this one object — read on this
  // impure side, from the config text, the metrics log and `.git/config`, and handed to a
  // module that still touches nothing. #70's `whatsNew` was the second fact to arrive this
  // way and its pattern is the one they copied: a total helper at the bottom of this file, an
  // injected reader, and no way for the read to cost the run. #74 had already removed the one
  // obstacle the original note warned about — `configText` is resolved at the top of this
  // function, so #69's facts were a `parseConfigVar` away rather than a reordering away.
  //
  // NOTHING IS STAMPED. The what's-new section prints on every start, deliberately: it is
  // release notes, not #24's throttled update notice, so there is no "seen" record to
  // write and no state file to grow. A user who starts Ralph twice is told twice.
  //
  // #74: ...AND THE ONE THING THAT DOES SILENCE IT IS THE USER, not the terminal. `box` is
  // false only for an explicitly requested `RALPH_BANNER=off`; a `full` that a pipe, NO_COLOR
  // or a 20-column terminal capped down to nothing still prints these rows, because the
  // paragraph above is still true — a log is where "which version, which directory" gets
  // asked. Skipping the loop is the whole implementation of `off`: no rows, and therefore not
  // one byte between the command line and the first preflight line.
  //
  // ...and it is the ONLY thing #74 says about this box. What the box LOOKS like — whether it
  // is framed at this width — is still `bannerLayout`'s answer inside composeBanner. An earlier
  // draft of #74 resolved the frame alongside the mode and passed it down as a capability; that
  // made two owners of one decision, the second asserted to agree with the first, so it is gone.
  //
  // #161 changed the NUMBER that goes in, and only where the arrangement changed with it: beside
  // the sprite the box is laid out in the columns the picture and its air leave behind — the
  // terminal's, less the sprite's 26 cells and the two of air, capped at the same 60-column
  // target — rather than in the whole terminal's. What that buys is one property, and it is
  // worth stating as arithmetic rather than as a worry: the joined line comes out exactly
  // `min(columns, 88)` cells wide at every width the rung is live on, so it CANNOT WRAP. A
  // wrapped line is not a cosmetic problem inside an animation: the player walks back up by the
  // rows it wrote, counted off its own newlines, and a line the terminal folded in two occupies
  // a row nobody counted. lib/banner-compose.beside.qa.test.js:97 sweeps every integer width
  // from 1 to 1000 and never lets 26 + 2 + `besideWidth` exceed the terminal, which is that
  // claim measured rather than argued.
  //
  // WHAT HANDING `columns` IN WOULD ACTUALLY COST, measured the same way, because the honest
  // number is smaller than an earlier draft of this note claimed and the argument survives it:
  // composeBanner caps the box at BANNER_WIDTH either way, so a box laid out at the whole
  // terminal is 60 wide on anything from 60 columns up, and the joined line is 28 + 60 = 88 no
  // matter how wide the terminal is. The overhang is therefore `88 - columns`: 16 columns at the
  // rung's own 72, 8 at 80, 1 at 87, and none at all from 88 up. On the 120-column terminal this
  // issue was filed about it would have produced the byte-identical box — the wrapping is real
  // between 72 and 87 and nowhere else, and `besideWidth` is what makes the whole live range one
  // case instead of two. That number is the same function's, so this is still one ladder
  // answering both questions and not a second opinion about width computed here.

  // #69: THE FACTS THAT NEEDED THE IMPURE SIDE, resolved here — which is exactly the seam the
  // note above promised this slice would grow into, and the reason it is a handful of lines
  // rather than a rewrite.
  //
  // PRECEDENCE FOR EVERY KNOB BELOW IS `sourcedValue`'s, resolved at the top of this function
  // where the rule and its bash transcript are written down: the file decides for a name the file
  // ASSIGNS, blank included, and the environment answers only for a name the file never mentions.
  // A box that answered the other way round would name an agent the loop is not about to run,
  // which is precisely the confusion #69 was asked to end. (RALPH_BANNER above is the one
  // deliberate exception, and its own note says why: a banner is a property of the invocation,
  // not of the repository.)
  //
  // #149 IS WHAT MADE THAT ONE RULE RATHER THAN TWO. These two knobs and `TASK_SOURCE` below read
  // `parseConfigVar(...) || processEnv[NAME]` until then, which reached past a blanked assignment
  // into an environment the loop had already masked — so a repo that blanked RALPH_CODEX_MODEL
  // while the invoking shell exported one got a box naming a model `buildAgentInvocation` would
  // never be handed, and a blanked RALPH_CONTEXT_WINDOW got the shell's number over the window
  // the run's own first event recorded. lib/commands/start.precedence.qa.test.js drives a blanked
  // file through the whole command and asserts the answer from outside, at all four knobs.
  const source = resolveSource({
    // THE SOURCE MOVED UP AT #69, nothing else about it changed: it is resolved from the same
    // `configText` at the same precedence, one step earlier, because the box names it. See the
    // note at the preflight step below, which is where it is still spent.
    //
    // THE SHARED RULE, WITH NO PER-KNOB SPELLING. `parseConfigSource` is what `ralph cycle`,
    // `ralph status` and `ralph doctor` call for this knob, and lib/read-config-source.js defines
    // it as `parseConfigVar(text, 'TASK_SOURCE')` verbatim — so this site has no grammar of its own
    // to preserve, and routing through the closure like every other knob is the whole of it.
    // Two tripwires keep that true, and they guard different halves of it. That the two READERS stay
    // the same call is asserted shape by shape in lib/commands/start.sourced-value.qa.test.js ("and
    // it agrees with the shared reader `start` now uses, on every shape") — the day one of them grows
    // a spelling the other lacks, this command and those three read one file two ways. That the
    // shared reader's own VALUE and PRESENCE stay on one grammar is lib/parse-config-var.test.js
    // ("never says ABSENT about a line the value reader reads a value out of"), which is the property
    // this ternary is spent on.
    //
    // This is the knob where the blank was never cosmetic — the row is the run's intake and
    // the preflight below SPENDS THIS BINDING, so a blanked `TASK_SOURCE` used to make the command
    // count a folder queue and skip `gh auth status` for a loop about to read GitHub issues.
    TASK_SOURCE: sourcedValue('TASK_SOURCE'),
  })
  // ONE read of the metrics log per run (#60/#69), hoisted above the banner and reused by the
  // launch projection at the bottom of this function. Reading it twice would let a log the
  // loop appended to mid-run answer the two questions differently — and this is the same
  // never-throws read every consumer of that file shares, so it costs a launch nothing even
  // when the file is missing, unreadable or half-written. Unconditional, deliberately: the run
  // that ABORTS after the banner has already paid for it, and gating the read on
  // `RALPH_BANNER` would buy back one inert read at the price of two code paths.
  const metricsText = safeReadText(readFile, metricsPath(cwd))
  // Which agent, which model, how big a window, and how much that claim is worth. Only the
  // RESOLVED `agent` reaches this box, and that is still the whole of its opinion about the
  // matter: the box REPORTS the run, it does not diagnose it, so a typo'd RALPH_AGENT gets the
  // row for the agent that will actually run (claude, by `resolveAgent`'s own fallback) and no
  // second opinion about the typo inside the frame.
  //
  // #118: what changed is that the COMMAND now diagnoses it — one line of stderr, above the
  // splash, next to the banner's own fallback warning, where a diagnostic is not interrupting an
  // announcement. Same resolution, resolved once up there and spent here; see that site for why
  // it is not resolved a second time.
  const identity = resolveBannerModel({
    metricsText,
    agent,
    // Both knobs on the one rule — the presence test at the top of this function (#122, #149) —
    // rather than spelled out twice more here. A blanked RALPH_CODEX_MODEL therefore arrives as the
    // '' it is, `trimmedOr` refuses it, and the row says the model is not known yet: which is
    // exactly what the loop does with it, since `buildAgentInvocation` passes no `-m` for an empty
    // knob and codex picks its own default.
    configuredModel: sourcedValue('RALPH_CODEX_MODEL'),
    // The window this run is CONFIGURED with — and only the configured path reads it, because a
    // `last-run` window comes out of an event that already folded in whatever override THAT run
    // had. A blanked knob arrives as '' here too, `Number('')` is 0 and 0 is not a window, so
    // `resolveContextWindow` falls to the model's map — the same number lib/capture-issue-event.js
    // will write into that run's very first event out of the same blank.
    configuredWindow: sourcedValue('RALPH_CONTEXT_WINDOW'),
  })
  // ...and the repository, for every source but folder — there is none a folder run reads
  // issues from, so naming one would be naming a fact that is not about this run. The gate is
  // spelled that way round rather than as `=== 'github'`, and the note at the `repo` binding
  // below is why (#125).
  //
  // AND ONLY WHEN THERE IS A BOX TO DRAW, which is the one difference between this read and the
  // metrics read above: that text has a second consumer (#60's projection runs whatever the
  // banner is doing), this slug has none. `RALPH_BANNER=off` costs not one byte of output (#74)
  // and now costs not one read either. It is not a second code path — `null` is what an
  // unresolvable slug already is, and `factRows`' gate turns it into no row.
  //
  // #120: AND AT THE LOOP'S PRECEDENCE, config over environment, which until now was the one
  // knob in this block that was not. GH_REPO is `gh`'s variable rather than Ralph's, and nothing
  // told anybody to put it in ralph.config.sh — which is the whole case for reading only the
  // environment, and it is not enough. This box's stated guarantee is that it names what THE
  // LOOP will read, and templates/ralph.sh sources that file with `set -a`, so a committed
  // GH_REPO decides for every `gh` command the loop runs. Reading past it was the one case in
  // this block where the box and the loop could disagree — the exact confusion #69 was filed to
  // end — and a row nobody documented is still a row a reader believes.
  //
  // ON `sourcedValue`'S PRESENCE TEST, like every other knob in this block since #149 — it was
  // #118's shape and #120's departure before that, and the argument has not changed, only its
  // scope. A config that assigns the knob an EMPTY value MASKS the environment in the shell that
  // sources it, so `GH_REPO=""` means the loop's `gh` sees an empty variable, reads it as unset,
  // and resolves its base repository from origin — and `resolveBannerRepo` already treats a blank
  // `ghRepo` as unset and falls through to origin's url. So handing the blank straight through
  // names exactly the repository the loop will honour, where a `||` would reach past it into the
  // environment and name one no `gh` call in the run is about to touch.
  //
  // ...and the helper no longer carries a copy of that shape, which is #149's one structural change
  // to it: `sourcedValue` goes in and the helper CALLS it, so the rule is written once here and the
  // grammar one layer down still sees one string and knows nothing about where it came from. It is
  // handed the rule rather than the answer for a reason the helper's own note gives — a hostile
  // `processEnv` accessor must cost the row inside that `try`, not the launch outside it.
  //
  // #125: AND `!== 'folder'` RATHER THAN `=== 'github'`, which is the same one-token
  // correction the cycle preflight needed for the same reason. The rule this row is
  // about is the one stated at the top of this note — a FOLDER run reads issues from
  // no repository — and a knob that had grown a third value (`jira`) would otherwise
  // have silently lost the row while the loop went on using the very slug it names.
  // The two gates further down are spelled this way already; this one was the outlier.
  //
  // #127 CHANGED WHAT THAT MEANS FOR `jira`, and this row is now about THIS COMMAND
  // rather than about the loop. The loop selects Jira tickets and runs no `gh` command
  // at all, while `ralph start` still demands `gh auth`, still creates its labels,
  // still sweeps orphans and still counts GitHub issues to decide whether to launch —
  // all through the two gates below. So the slug is exactly what those calls will
  // read, and drawing it is honest about the command a reader is watching; it is no
  // longer a fact about the work. Moving this command onto the Jira queue is the
  // follow-up that gets to delete the row, and doing it here alone would name no
  // repository while the very next preflight step still needed one.
  const repo =
    banner.box && source !== 'folder'
      ? bannerRepoSlug({ readFile, cwd, sourcedValue })
      : null

  // #161: THE ARRANGEMENT, as one boolean, decided from two things that are both already
  // resolved — is there a picture to sit beside, and does the terminal hold both blocks.
  // `layout.beside` is the second and the only one this command asks for; the first is the
  // emptiness of a list, and `frames` is empty on a pipe, under NO_COLOR, below 26 columns and
  // for `RALPH_BANNER=off`. So every path that had no sprite before this issue is the path it
  // was, byte for byte, and the only run whose bytes change is the one that had ninety empty
  // columns next to a cartoon.
  //
  // AND IT IS DECIDED BEFORE THE BOX IS COMPOSED, because the box's WIDTH is the first thing
  // that depends on it. "Is there a box at all" is not a third conjunct here and must not become
  // one: `boxLines` is empty only for `RALPH_BANNER=off`, which is the same answer that empties
  // `frames`, so the two can never disagree — and even if they could, an empty box changes
  // nothing, since `joinBeside` hands back the sprite's own lines and the `!beside` loop below
  // writes nothing. A conjunct that cannot change a byte is a claim a reader has to check.
  //
  // `static` keeps its frame and therefore keeps the arrangement: the box sits beside a still
  // picture for one beat instead of five, which is what that mode asks for and nothing more.
  const layout = bannerLayout(columns)
  const beside = layout.beside && frames.length > 0
  const boxLines = banner.box
    ? composeBanner({
        facts: {
          version: currentVersion,
          latestVersion: cachedLatestVersion({ readCache, fs: cacheFs, processEnv, home }),
          cwd,
          agent: identity.agent,
          model: identity.model,
          provenance: identity.provenance,
          contextWindow: identity.contextWindow,
          source,
          repo,
          whatsNew: whatsNewBullets({ readChangelog, fs: changelogFs }),
        },
        // The columns the picture leaves behind when the box goes beside it, the whole
        // terminal's when it does not — see the note above about which module owns both.
        width: beside ? layout.besideWidth : columns,
        capabilities: { color },
      })
    : []

  // THE PICTURE, PLAYED — and the box glued into its right-hand margin first, when there is
  // room for it. Every frame gets the same box, because the frames are redrawn IN PLACE: a box
  // on the first frame alone would be erased by the second. The player counts its cursor moves
  // off the newlines it writes rather than off the sprite's height, so frames that grew taller
  // or wider by this join redraw exactly as correctly as the bare ones did (see lib/sprite-player.js).
  //
  // #73: AWAITED, and that is the only risk the splash carries — so the bound is structural
  // rather than trusted: `playSplash` walks a FIXED five-element array with no `while` and no
  // clock comparison in it, and `playBannerSplash` at the bottom of this file cannot let a
  // throwing timer, a dead stream or a hostile signal source cost the run.
  //
  // #74: ...and `static` is the second of the two things RALPH_BANNER changes about the splash —
  // an ARGUMENT to this call rather than a branch around it, which is why the note over `frames`
  // above sends a reader here for it. ONE cycle, which the player writes as the settled frame and
  // nothing else: no hide, no restore, no cursor move, because it only hides a cursor it is going
  // to redraw over. That frame still holds for its 200ms beat, exactly as the splash's last frame
  // does before whatever follows it — the identity box on a terminal too narrow to put the box
  // beside the picture, and the run's own first line on one wide enough that the box is already
  // up there in the margin.
  await playBannerSplash({
    frames: beside
      ? frames.map((frame) => ({
          ...frame,
          lines: joinBeside({ spriteLines: frame.lines, boxLines, spriteWidth }),
        }))
      : frames,
    cycles: banner.mode === 'static' ? 1 : undefined,
    stream: stdout,
    sleep,
    signals,
  })

  // ...and under it on every other path, which is where this box has printed since #68: no
  // sprite to sit beside, or no room to. Not an ELSE for the join but a `!beside` on the same
  // answer, so the box is printed exactly once — the bug #161 would most easily introduce is
  // drawing it in both places, and lib/commands/start.banner-beside.test.js counts it.
  if (!beside) {
    for (const line of boxLines) out(line)
  }

  // Per-project tmux session name so multiple repos can run Ralph concurrently
  // without colliding on a single literal 'ralph' session.
  const session = sessionNameFor(cwd)

  // #565: resolve the task source from ralph.config.sh so `ralph start` is
  // folder-aware like `ralph cycle`. Folder mode never touches gh (no auth
  // check, no labels, no orphan sweep) and counts the queue from the local
  // .ralph/tasks tree. The github path (default) is unchanged. Behaviour is
  // otherwise identical between sources — only where issues are picked up
  // differs; the loop (templates/ralph.sh) already dispatches both.
  //
  // ONE read of the file, SIX values out of it (#60, #74, #69): the source, the digest
  // interval the hint block below needs, the banner mode, and the agent, Codex model and
  // context window the identity box names — which is why the read itself now happens at the
  // top of this function, above the picture it decides. Reading the file twice would let a
  // config rewritten mid-preflight answer the six questions differently, and the parse is over
  // text either way — see parse-config-var.js for the shared grammar.
  //
  // `source` is resolved with the banner's facts up there rather than here, because the box
  // is painted before this point and names it. This is still where it is SPENT.
  const digest = digestInterval(configText)

  // 1. tmux session uniqueness (best-effort: silently fall through if tmux missing,
  //    the dep check below will catch and report it). Only THIS project's session
  //    blocks start — another project's session is unrelated.
  if (hasCommand('tmux')) {
    const has = await exec('tmux', ['has-session', '-t', session], { reject: false })
    if (has.exitCode === 0) {
      err(`❌ tmux session '${session}' already exists.`)
      // #169: `ralph live` leads here, the moment a reader most wants it: they asked for a
      // loop and were told one is already running, so "watch the one that is" is the whole
      // remedy. The raw command stays under it because it is the one certain to work HERE —
      // the session above was derived from this command's own cwd (:679) and `ralph live`
      // derives it from the git toplevel, so a loop started in a subdirectory answers to the
      // line below and not to the row above it. 11 spaces, `   Watch:  `'s own width.
      out('   Watch:  ralph live')
      out(`           tmux attach -t ${session}`)
      out(`   Kill:   tmux kill-session -t ${session}`)
      throw new StartAbort('tmux session already exists', 1)
    }
  }

  // 1.5. ralph cycle coexistence — abort if a live cycle holds the lock.
  // Stale lock holders fall through silently so a crashed cycle doesn't block start.
  const lockState = peekLock(cwd)
  if (lockState && lockState.alive) {
    const ageH = ageInHours(now(), lockState.holder?.startedAt)
    err(
      `⏸️ Cycle in progress (PID ${lockState.holder?.pid} for ${ageH}h) — wait or run \`ralph schedule pause\` first`,
    )
    throw new StartAbort('cycle lock held', 1)
  }

  // 2. Required commands (shared dep check)
  const platform = detectPlatform()
  const depCheck = assertCriticalDeps({ hasCommand, platform })
  if (!depCheck.ok) {
    err(depCheck.message)
    throw new StartAbort(
      `missing command: ${depCheck.missingCritical.map((d) => d.name).join(', ')}`,
      1,
    )
  }
  const missingNonCritical = checkDeps({ hasCommand }).filter(
    (r) => !r.present && !r.critical,
  )
  for (const r of missingNonCritical) {
    out(`⚠️  '${r.name}' not found (optional). Some features may not work.`)
  }

  // 2.5. #24/#25/#26: the update notice, the TTY-gated prompt and the weekly
  // prompt window, as one policy in ../update-gate.js (#50) — which is also where
  // every "why" about it now lives. This site owns two things only: WHERE the gate
  // runs, and what an accepted install means for a launch.
  //
  // It sits HERE, and not where the old step-8.5 block did, for two reasons: 8.5
  // ran after the empty-queue early return, so a user with an empty queue never saw
  // the notice; and running before the gh label/orphan/queue calls means #25's
  // accept path won't discard work already done.
  //
  // What the placement buys, precisely: it is after the three guards that abort
  // LOCALLY — tmux session, cycle lock, missing dependency — none of which touch
  // the network or do work a user sees, so those aborts stay silent and spend
  // nothing. It does NOT mean no aborting run ever shows the notice: `gh auth
  // status` below, an invalid `.mcp.json`, and a failed tmux launch all abort
  // AFTER this point, and such a run both prints the notice and stamps
  // last_check_at, burning the weekly window. That is accepted: the notice is
  // advice, not a step, and the alternative — checking after every guard — puts
  // it back behind the empty-queue early return that step 8.5 was moved out of.
  //
  // The gate prints nothing but the notice, so a failed, throttled or opted-out
  // check is silent, and it guards every boundary it owns — so this call needs no
  // guard of its own. Not that nothing can escape it: a broken `ask` still aborts
  // the run with its raw error, pinned in start.update-prompt.qa.test.js and
  // deliberate, since a prompt that cannot be answered must not be read as consent.
  // Wrapping this call would swallow that too, which is why it is not wrapped.
  const updateGate = await runUpdateGate({
    currentVersion,
    exec,
    now,
    processEnv,
    home,
    cacheFs,
    stdout,
    stderr,
    stdin,
    isTTY,
    update,
    recordPrompt,
    runUpdate,
    ask,
  })
  if (updateGate.installed) {
    // #25: no re-exec and no background install, on purpose. THIS process
    // already holds pre-update module state, and `templatePath('ralph.sh')`
    // below resolves against the OLD install — the tmux loop reads that
    // template at launch. Exiting cleanly is the only way to guarantee the
    // loop never runs a half-swapped mixture of two versions.
    out(pc.green(`✅ Updated to ${updateGate.installedVersion} — run \`ralph start\` again.`))
    return { exitCode: 0, started: false }
  } else if (updateGate.accepted) {
    // Accepted but not updated — a failed install, or nothing to update here (an
    // npx run, a linked dev checkout). Either way the loop still launches on the
    // current version: an update is never worth losing a run over. runUpdate wrote
    // its own diagnostics, so this adds one neutral line and falls through.
    //
    // `else if`, not a second `if`: the two outcomes are mutually exclusive, and
    // saying so locally means a future caller with cleanup to do before returning —
    // releasing a lock, say — cannot turn a dropped `return` above into a run that
    // announces both a successful update and a failed one.
    out(`⚠️  Update did not complete — starting Ralph on ${currentVersion}.`)
  }

  // 3. .env.local — informational only
  const envPath = resolve(cwd, '.env.local')
  let env = {}
  if (exists(envPath)) {
    env = loadEnv(envPath)
  }
  const resolveCred = createCredentialResolver({ repoEnv: env, processEnv, home, loadEnv })
  const callmebotKey = resolveCred('CALLMEBOT_KEY') ?? ''
  const whatsappPhone = resolveCred('WHATSAPP_PHONE') ?? ''
  const startupMessage = resolveCred('RALPH_STARTUP_MESSAGE') ?? DEFAULT_STARTUP_MESSAGE
  if (!callmebotKey || !whatsappPhone) {
    out('ℹ️  CALLMEBOT_KEY/WHATSAPP_PHONE missing; WhatsApp notifications will be skipped.')
  }

  // 4. gh authenticated (every source but folder — folder mode is the one that never touches gh)
  //
  // #127: `jira` now also never touches gh IN THE LOOP, so this gate outlives its reason
  // for that value — it fails a Jira run that would have worked. Left as it is on purpose:
  // steps 6, 7 and 8 below still run GitHub calls under `jira`, and passing this gate is
  // what makes their failures legible instead of arriving as an empty queue. The follow-up
  // moves all four together (README: "What is still GitHub's"), because loosening this one
  // alone buys a run that aborts three steps later with a worse message.
  if (source !== 'folder') {
    const ghAuth = await exec('gh', ['auth', 'status'], { reject: false })
    if (ghAuth.exitCode !== 0) {
      err("❌ gh not authenticated. Run 'gh auth login'.")
      throw new StartAbort('gh not authenticated', 1)
    }
  }

  // 5. .mcp.json validity
  const mcpPath = resolve(cwd, '.mcp.json')
  if (exists(mcpPath)) {
    const mcpCheck = await exec('jq', ['-e', '.', mcpPath], { reject: false })
    if (mcpCheck.exitCode !== 0) {
      err('❌ .mcp.json has invalid JSON')
      throw new StartAbort('invalid .mcp.json', 1)
    }
    const serversResult = await exec(
      'jq',
      ['-r', '.mcpServers | keys | join(", ")', mcpPath],
      { reject: false },
    )
    const servers = (serversResult.stdout || '').trim()
    out(`ℹ️  MCP servers configured: ${servers}`)
    out(
      "   If any MCP's auth has expired, run 'claude' interactively once first to re-authenticate.",
    )
  }

  // 6 + 7. Label creation and orphan cleanup are github-only (they read/write
  // GitHub issue labels). Folder mode tracks progress via the .ralph/tasks
  // status dirs, so it skips both entirely.
  if (source !== 'folder') {
    // 6. Create labels (idempotent)
    //
    // #139: iterated over the specs in lib/labels.js rather than three near-identical blocks
    // of argv. The ARGV IS UNCHANGED and that is deliberate — name, then `--color`, then
    // `--description`, in the order MANAGED_LABELS lists the labels — because the tests that
    // guard this compare whole command lines (`gh label create <name> --color <hex> ...`), so
    // reshaping a call would read as a behaviour change. Sequential `await`s, one per
    // label, exactly as before: the calls are ORDERABLE, and several specs assert where in
    // the run they land.
    for (const label of MANAGED_LABELS) {
      await exec(
        'gh',
        ['label', 'create', label.name, '--color', label.color, '--description', label.description],
        { reject: false },
      )
    }

    // 7. Orphan in-progress cleanup
    const orphanList = await exec(
      'gh',
      [
        'issue',
        'list',
        '--state',
        'open',
        '--label',
        IN_PROGRESS_LABEL,
        '--json',
        'number,title',
        '-q',
        '.[] | "  #\\(.number) \\(.title)"',
      ],
      { reject: false },
    )
    const orphaned = (orphanList.stdout || '').trim()
    if (orphaned) {
      out(`⚠️  Issues with the '${IN_PROGRESS_LABEL}' label (previous run interrupted):`)
      out(orphaned)
      out('ℹ️  Keeping labels. These issues will be skipped this run.')
      out(
        `   To reprocess, remove manually: gh issue edit <n> --remove-label ${IN_PROGRESS_LABEL}`,
      )
    }

    // 7b. #141: retired label names still on the board.
    //
    // HERE, beside the orphan notice above, because it is the same class of message: something
    // from a previous state of the world needs a human, and the two are read together. It is
    // also the message that EXPLAINS an empty orphan notice on an unmigrated board — that sweep
    // lists `--label in-progress`, so the issues this warning is about are precisely the ones it
    // cannot see.
    //
    // AFTER the label creation above, and not before: on a fresh board the creates are what put
    // the current names there, and reporting a rename before offering the destination reads
    // backwards.
    //
    // IT NEVER ABORTS. #140's rename left every board untouched on purpose — Ralph does not run
    // `gh label edit` for a user — so a retired name is a nuisance the user can fix in one
    // paste, not a broken setup. The run goes on to the queue check and the launch, and the
    // check itself is empty-on-failure (see labels.js), so there is nothing here to guard.
    //
    // THE PRINTED CONSEQUENCE IS TWO-PART, AND BOTH HALVES ARE MEASURABLE OFF THIS SAME RUN —
    // which the first draft got backwards, saying the issues were "invisible to Ralph". They are
    // not. Step 8 below spends ISSUE_SEARCH_QUERY, whose four `-label:` clauses are the CURRENT
    // names, so an open issue whose only Ralph label is a retired one MATCHES that search and is
    // selected as fresh work — at a paid invocation, on every pass, for work already done under
    // the old name. What is blind is the sweep at step 7 above, which lists `--label
    // in-progress`, so the one query that would have flagged those issues cannot see them.
    // Visible to the query that costs money, invisible to the query that would have warned:
    // "invisible" reads as inert and buys the user the expensive option. Both halves are pinned
    // against the argv of one real run in start.legacy-warning.qa.test.js.
    for (const { legacy, current, command } of await findLegacyLabels({ exec })) {
      out(`⚠️  Retired label '${legacy}' still exists on this board (now '${current}').`)
      out(
        '   Issues carrying it are no longer excluded from the queue: Ralph picks them up again as fresh work.',
      )
      out('   The orphan sweep can no longer see them either. Rename the label with:')
      out(`   ${command}`)
    }
  }

  // 8. Queue check — folder via the local .ralph/tasks tree, every other source via gh.
  //
  // #127: AND THAT IS NOW WRONG FOR `jira`, knowingly and until the follow-up lands. The
  // loop this command is about to launch drains the JIRA queue (lib/jira-queue.js, through
  // the JIRA_JQL in ralph.config.sh), so the number below — and the projection the launch
  // box builds from it — describes a board the run will not touch, and an empty GitHub
  // queue stops a launch that had Jira tickets waiting. `ralph cycle` already counts the
  // right one; this command does not, and inventing a second count here without moving the
  // gh gates above with it would leave the run failing at step 4 instead.
  let count
  if (source === 'folder') {
    count = String(await getFolderQueueCount(folderQueueCount, cwd))
  } else {
    const queue = await exec(
      'gh',
      [
        'issue',
        'list',
        '--search',
        ISSUE_SEARCH_QUERY,
        '--limit',
        '100',
        '--json',
        'number',
        '-q',
        '. | length',
      ],
      { reject: false },
    )
    count = (queue.stdout || '').trim()
  }
  if (count === '0' || count === '') {
    out('ℹ️  No issues in the queue. Nothing to do.')
    return { exitCode: 0, started: false }
  }

  // 9. Launch tmux detached, running the bash loop shipped with the package
  const ralphTemplate = templatePath('ralph.sh')
  const tmuxLaunch = await exec(
    'tmux',
    [
      'new',
      '-d',
      '-s',
      session,
      `cd '${cwd}' && RALPH_TMUX_SESSION='${session}' bash '${ralphTemplate}'`,
    ],
    { reject: false },
  )
  if (tmuxLaunch.exitCode !== 0) {
    err(`❌ Failed to start tmux session: ${(tmuxLaunch.stderr || '').trim()}`)
    throw new StartAbort('tmux launch failed', 1)
  }

  // 9b. #62: the digest, as a second window in the session we just created —
  //
  //     session ralph-<slug>-<hash>
  //       window 0            the loop, templates/ralph.sh, the raw agent stream
  //       window 1  digest    ralph digest --loop --interval <RALPH_DIGEST_INTERVAL>
  //
  // A window and not a daemon, a launchd agent or a cron entry: tmux is already a
  // hard dependency of this command, so one `new-window` works the same on macOS,
  // Linux and WSL2; there is nothing to install and nothing to leave behind; both
  // teardown paths already reach it, because `ralph stop` and templates/ralph.sh's
  // end-of-run both kill the SESSION and a session takes its windows with it; and
  // attaching shows the stream and the narration side by side.
  //
  // AFTER the launch above, and only if it succeeded: with no loop there is nothing
  // to narrate, and this run is aborting anyway. Never before it, because opening
  // this window is the one step here allowed to fail quietly.
  //
  // The answer is KEPT, because the launch box below reports it: a window this function
  // refused to open must not be advertised as running (#62 review).
  let digestWindow = null
  if (digest) {
    digestWindow = await openDigestWindow({
      exec,
      err,
      session,
      cwd,
      interval: digest,
      // Trimmed, so a knob edited out by hand with a space left behind reads as absent
      // rather than as an agent named "   ". The model is passed as the config spells it:
      // buildDigestInvocation already reads a blank one as its default.
      agent: parseConfigVar(configText, 'RALPH_AGENT').trim(),
      model: parseConfigVar(configText, 'RALPH_DIGEST_MODEL'),
      ralphBinary,
    })
  }

  // #60: what the queue we just accepted should cost and when it should be done.
  // Every number and every string of it is policy, so it all lives in
  // ../progress.js; this site passes the three inputs.
  //
  // BEST-EFFORT twice over: the shared never-throws read every consumer of that
  // file uses (issue-metrics.js), and a projection with no history renders as no
  // lines at all. A missing, unreadable or half-written issues.jsonl costs the
  // reader a hint, never a launch — the loop is already running by this point.
  //
  // #69: the same `metricsText` the banner's model row was resolved from, read once at the
  // top of this function. Two reads would let a log the loop appended to while the preflight
  // ran tell the box one story and this line another.
  const projection = buildLaunchProjection({
    metricsText,
    queue: Number(count),
    now: now(),
  })

  out(`✅ Ralph started in background. ${count} issues in the queue.`)
  for (const line of renderLaunchProjection(projection)) out(line)
  out('   Progress:       ralph status')
  // #60's line, and #62 has now made the second half of it literal: the digest runs
  // alongside the loop as window `digest` in the session the tmux lines below name, so
  // `tmux attach` lands on the loop and Ctrl+B then W lists both.
  //
  // Printed whenever the config asked for a digest, and keyed on whether it actually
  // opened. Both halves matter and they used to be traded against each other: keying on
  // the config alone ended a successful-looking launch with `every 0.5h — runs alongside
  // the loop` for a window that had just been refused, with the only correction on
  // stderr, above the box, in a preflight a reader scrolls past. Printing nothing
  // instead would tell a reader with a typo'd interval nothing at all about the knob
  // they had just edited. So: the line always appears, and it says which happened.
  if (digest) {
    out(
      digestWindow?.opened
        ? `   Digest:         every ${digest} — runs alongside the loop`
        : `   Digest:         every ${digest} — NOT running (see the warning on stderr)`,
    )
  }
  // #169: the row's VALUE is `ralph live` (./live.js) and the tmux command is its
  // continuation line — a shortcut named where a reader is already looking. The raw command
  // stays because it is the one certain to work HERE: this function derived the session from
  // its own cwd (:679) and `ralph live` derives it from the git toplevel
  // (../repo-session.js:10-16), so a loop launched from a subdirectory answers to the line
  // below, not the row above it. 19 spaces of padding — #60's column (lib/progress.js:117).
  out('   Watch live:     ralph live')
  out(`                   tmux attach -t ${session}`)
  out('   Detach:         inside the session, Ctrl+B then D')
  out('   List:           tmux ls')
  out(`   Kill:           tmux kill-session -t ${session}`)
  out('   Logs:           logs/ralph-issue-*.log')

  // Startup notification — best effort, never blocks startup or surfaces stack traces.
  if (callmebotKey && whatsappPhone) {
    const waResult = await sendWa({
      phone: whatsappPhone,
      apiKey: callmebotKey,
      message: startupMessage,
    })
    if (waResult?.ok) {
      out('📲 Startup WhatsApp notification sent.')
    } else {
      out(`⚠️  Startup WhatsApp notification failed: ${waResult?.reason ?? 'unknown'}.`)
    }
  }

  return { exitCode: 0, started: true, count: Number(count) }
}

// #62: open the digest's window, or explain why there isn't one. NEVER THROWS, and
// that is the whole contract of this function: the loop is already running by the
// time it is called, so every failure below costs the reader a narration and nothing
// else. A warning on stderr, and the launch continues.
//
// The WHY goes to stderr and the FACT goes to the caller: the diagnostic is about
// Ralph's plumbing and belongs in the stream a script can discard, but whether there
// is a digest is part of this command's answer about the run, so `{ opened }` is
// returned rather than dropped and the launch box keys its Digest line on it. A repo
// that configures no digest reaches neither, and its box is unchanged.
async function openDigestWindow({ exec, err, session, cwd, interval, agent, model, ralphBinary }) {
  // Validated HERE rather than left to the window: `ralph digest --loop` would reject
  // it too, but in a pane nobody is attached to yet, hours before anyone notices. The
  // shared grammar (../duration.js) is the same one `ralph schedule` uses, so the
  // fractional interval a user is most likely to reach for (`0.5h`) is rejected here
  // exactly as it is there — and the message names the formats that do work.
  //
  // parseTimerDuration and not parseDuration, because this window's whole job is to
  // WAIT: `RALPH_DIGEST_INTERVAL=30d` is a duration a timer cannot hold, and opening a
  // window for it would start a digest per millisecond (#62 QA). The loop in the window
  // refuses exactly this set, from the same function — the agreement is shared code,
  // not a number written down twice.
  try {
    parseTimerDuration(interval)
  } catch (e) {
    err(`⚠️  Digest window not opened — ${oneLine(e?.message)}. The loop is running.`)
    return { opened: false, reason: 'invalid-interval' }
  }

  // BOTH knobs, and the agent is not optional (#62 review): `ralph digest` resolves its
  // agent from `env.RALPH_AGENT` and `ralph start` never sources ralph.config.sh, so a
  // repo on codex that only forwarded the model would open a window running
  // `claude --model gpt-5-mini` — every tick failing, in a pane nobody is attached to,
  // while the launch box advertised a digest all night.
  //
  // Each assignment is emitted ONLY when the config actually sets it, so a repo that
  // configures neither gets the same bare command it always did and inherits whatever
  // the ambient environment says — the same resolution order every other Ralph command
  // uses. Quoted, not interpolated: every value here comes from outside this process (a
  // path, two config values, argv[1]) and this string is handed to a shell.
  const envPrefix =
    (agent ? `RALPH_AGENT=${shellQuote(agent)} ` : '') +
    (model ? `RALPH_DIGEST_MODEL=${shellQuote(model)} ` : '')
  const command =
    `cd ${shellQuote(cwd)} && ${envPrefix}${shellQuote(ralphBinary)} ` +
    `digest --loop --interval ${shellQuote(interval)}`

  // `-d` so window 0 stays the one an attach lands on, and `-n digest` because an
  // index is not a promise: a user's own base-index setting moves the number, but
  // `tmux kill-window -t <session>:digest` keeps working whatever it is.
  let result
  try {
    result = await exec(
      'tmux',
      ['new-window', '-d', '-t', session, '-n', DIGEST_WINDOW, command],
      { reject: false },
    )
  } catch (e) {
    // `reject: false` covers a tmux that answers non-zero; this covers a tmux that
    // cannot be spawned at all.
    err(`⚠️  Digest window not opened — ${oneLine(e?.message) || 'tmux could not be run'}. The loop is running.`)
    return { opened: false, reason: 'spawn-failed' }
  }
  if (result?.exitCode !== 0) {
    const why = oneLine(result?.stderr) || `tmux new-window exited ${result?.exitCode}`
    err(`⚠️  Digest window not opened — ${why}. The loop is running.`)
    return { opened: false, reason: 'tmux-failed' }
  }
  return { opened: true, window: DIGEST_WINDOW }
}

// One shell word, whatever is in it — POSIX single quotes, with an embedded quote
// spliced as '\''. Cheaper than pulling in a dependency, and the only escaping this
// file needs. Deliberately not shared with agent-invocation.js's `shQuote`: that one
// is a private detail of the bash bridge and renders a nullish value as the literal
// `undefined`, which is right for an argv element it must not silently drop and wrong
// for a config value that is simply absent here.
function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`
}

// #565: default folder-queue counter — counts .md tasks in .ralph/tasks/afk/
// todo via the folder-queue library. Injectable in tests via folderQueueCount.
function defaultFolderQueueCount({ cwd }) {
  return folderQueueCountLib(resolve(cwd, '.ralph', 'tasks'))
}

async function getFolderQueueCount(folderQueueCount, cwd) {
  try {
    const n = await folderQueueCount({ cwd })
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

// #68: the newest version the last update check left in the global cache, or null.
//
// TOTAL, on purpose, and the try/catch is load-bearing rather than defensive: this runs
// before the first preflight line of every `ralph start`, and readVersionCache is total
// for a bad FILE but not for a bad ARGUMENT — its `path` default parameter evaluates
// before its own try blocks, so a non-string `home` or a truthy non-string
// XDG_CONFIG_HOME throws a TypeError straight out of join(). A corrupt, hostile or
// unreadable cache costs a HINT; it must never cost the run. Same guard, for the same
// reason, that resolveUpdateDecision puts around its own read.
//
// The `latest_version` type check is not redundant with normalizeCache's: an injected
// `readCache` is a seam a caller controls, so what comes back here is not guaranteed to
// have been through it.
//
// THE OPT-OUT IS HONORED HERE, and `ralph doctor`'s otherwise-identical helper
// deliberately does not honor it — the difference is what the two lines ARE. Doctor's
// version line is a diagnostic: it reports the cache's contents to a user who asked
// what state their install is in. This hint is the same nagging `RALPH_NO_UPDATE_CHECK`
// exists to switch off, printed above every single `ralph start`. Reading the cache
// anyway would also break the promise update-check.js states for that path — "reads no
// cache at all" — which two QA suites pin as zero operations on the injected cache fs.
function cachedLatestVersion({ readCache, fs, processEnv, home }) {
  if (isUpdateCheckDisabled(processEnv)) return null
  try {
    const cache = readCache({ fs, processEnv, home })
    return typeof cache?.latest_version === 'string' ? cache.latest_version : null
  } catch {
    return null
  }
}

// #70: the newest release's bullets, or none at all.
//
// TOTAL, and the try/catch is the same load-bearing kind as `cachedLatestVersion`'s above:
// `readChangelogEntries` swallows every FILE failure of its own, but `readChangelog` is an
// injected seam a caller controls, so what runs here is not guaranteed to be it — a stub
// that THROWS, one that returns an already-resolving promise, or one that returns a
// hand-built entry with no sections must all cost the SECTION and never the run.
// `latestBullets` refuses those shapes and this guard catches the rest.
//
// The one shape this cannot save is a reader that returns a REJECTING promise: the section
// drops, but the rejection is unhandled and Node exits over it, and no synchronous
// try/catch can reach it. Deliberately not guarded — the reader is synchronous by
// construction, so the branch would be dead code today, and swallowing it would turn a
// future `async` mistake into a silent missing section instead of a loud crash. What keeps
// that shape unreachable is the tripwire at lib/changelog-file.qa.test.js:229, which fails
// the moment the reader stops answering synchronously and says exactly why.
//
// The bullets are handed on RAW. Trimming, control-character replacement and the three-bullet
// cap belong to lib/banner-rows.js, which gates every row it builds, and the clip belongs to the
// frame half beside it — sanitising here would make the box's guarantee a convention of this
// call site instead.
function whatsNewBullets({ readChangelog, fs }) {
  try {
    return latestBullets(readChangelog({ fs }))
  } catch {
    return []
  }
}

// #69: the repository the loop will read issues from, or none.
//
// READ, NOT ASKED, and that is the whole design of this helper. `gh repo view` knows the
// answer authoritatively — lib/commands/cycle.js asks it — but that is a GraphQL round trip
// over the network, and this row is printed BEFORE the first preflight line of a command whose
// job is to get a loop running. A banner that waits on api.github.com is a banner that hangs
// on a bad connection, and there is no timeout worth writing for a decoration. So the answer
// comes from what is already local: GH_REPO if anything set it (which is what `gh` itself would
// honour first), otherwise origin's url out of `.git/config`. Both are strings by the time
// resolveBannerRepo sees them, which is what keeps that grammar pure and tested.
//
// #120: and "anything" is ralph.config.sh over the environment, the precedence every other knob
// at the call site uses and the precedence the loop itself uses. The argument is written down
// there, next to the `sourcedValue` closure that implements it for every knob; what belongs here
// is only that the CALLER decides this, so this helper takes one already-resolved string — since
// #149 it does not see `configText` or the environment at all — and the grammar below knows
// nothing about where the value came from.
//
// NO `exists` PROBE, deliberately: the injected `readFile` is total by the same contract every
// other best-effort read in this file relies on, so the probe would buy nothing but a second
// syscall and a second failure mode. A repo with no `.git` — a tarball, a worktree spelled
// oddly, a Ralph run inside a container mount — reads as no answer, which is exactly right.
//
// TOTAL, on the same argument as `cachedLatestVersion` and `whatsNewBullets` above: `readFile`
// is a seam a caller controls, `resolve` throws on a non-string `cwd`, and a directory read as
// a file throws EISDIR on every platform. All of them cost the ROW.
//
// `safeReadText` rather than a bare `readFile`, for the last clause of its contract: "read this
// path as text, answer '' for missing, unreadable, half-written or Buffer-returning". An
// injected fs called without an encoding hands back a Buffer, and a second copy of
// `?.toString() || ''` here would be a second place to get it wrong.
//
// DEGRADES TO NO ROW rather than to `unknown`, and the difference matters: gh resolves its base
// repository from more than origin (a `gh repo set-default`, an upstream remote), so "this
// checkout does not cheaply say" is not the same claim as "there is no repo". A missing row
// says nothing; a row reading `unknown` would say something false about the loop's own state.
// AND THE KNOB IS READ INSIDE THAT `try`, WHICH IS WHY THE RULE ARRIVES AS A FUNCTION rather than
// as an already-resolved string (#149). `processEnv` is an injected seam — a proxy or a lazily
// resolved config object is an ordinary thing for a library consumer to hand over — so a `GH_REPO`
// that is an ACCESSOR runs somebody else's code, and that throw is nobody else's to catch:
// resolving it at the call site would put it outside this guard and cost the LAUNCH instead of the
// row. `start.identity-facts.qa.test.js` drives exactly that bag and asserts the loop still starts.
function bannerRepoSlug({ readFile, cwd, sourcedValue }) {
  try {
    return resolveBannerRepo({
      ghRepo: sourcedValue('GH_REPO'),
      gitConfigText: safeReadText(readFile, resolve(cwd, '.git', 'config')),
    })
  } catch {
    return null
  }
}

// #73: play the splash, and never let it cost the run.
//
// TOTAL, on the same argument as `cachedLatestVersion` and `whatsNewBullets` above and for
// the same reason — this is a banner, printed before the first preflight line, and a banner
// is never worth losing a run over. What is being guarded is not the player, which is total
// about everything it decides itself; it is the two SEAMS the player was handed. An
// injected `sleep` that throws, an injected signal source that throws from `on`, a `stdout`
// that EPIPEs because the reader on the other end of the pipe went away mid-animation: all
// of those must cost the picture and nothing else. Without this wrapper the last of them
// turns `ralph start | head` into a crash with no exit code of its own.
//
// The cursor has already been PUT BACK AS FAR AS IT CAN BE by the time this catch runs — the
// player restores it from a `finally` before it rethrows — so there is nothing to clean up
// here. Best-effort rather than guaranteed, and deliberately: the player writes the restore
// inside a `try` of its own, so the one case it cannot fix is a stdout that has stopped
// accepting bytes altogether, which is also the one case where no other code could fix it
// either. Nothing is printed on the way out: stderr belongs to the run, and "the sprite
// didn't finish" is not news a user needs while their loop is starting.
async function playBannerSplash(options) {
  try {
    await playSplash(options)
  } catch {
    // The animation stops wherever it got to. Where #161 put the box BESIDE the sprite it
    // went out with whichever frames did land and is not printed again; where the terminal
    // was too narrow for that, it still prints under the picture on the way past.
  }
}

function ageInHours(nowMs, isoStartedAt) {
  if (!isoStartedAt) return 0
  const startMs = Date.parse(isoStartedAt)
  if (!Number.isFinite(startMs)) return 0
  return Math.max(0, Math.round((nowMs - startMs) / 3600000))
}

export { StartAbort }
