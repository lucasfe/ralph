// `ralph status` (#55) — a minimal live view of the run in progress: which run,
// how long it has been going, which task is in flight and for how long, how deep
// the queue is right now, and how to reach the run — the session's attach/kill
// pair for a `ralph start` run, the log to follow for a `ralph cycle` one, which
// has no session to attach to at all.
//
// FOUR modes, reconciled from the record against run liveness: running,
// interrupted, idle, never-run. All four exit 0 and none of them writes anything
// — a read-only view must never disturb the run it reports on.
//
// The live view also carries the run's pace, its ETA and its spend (#57). All of
// that arithmetic is policy, so it lives in lib/progress.js; this file only reads
// issues.jsonl — through the never-throws guard every consumer of that file shares
// (lib/issue-metrics.js), because a read-only view must never abort over its own
// telemetry — and hands the text to the pure path.
//
// TWO VIEWS, not one (#59). `running` gets the live view above. `idle` and
// `interrupted` get the morning-after REPORT CARD — outcome counts, the failed task
// numbers, the night's spend, the wall clock, when it ended and how long ago — whose
// policy lives in lib/post-mortem.js, because a finished run has no pace and no ETA
// to report and every number on it is a fact rather than an extrapolation. So idle
// and interrupted now count the queue and read issues.jsonl too. `never-run` still
// reads NOTHING at all — no gh call, no metrics, no config — because there is no run
// to report on and a one-line pointer at `ralph start` needs no inputs.
//
// A NARRATED run also gets the latest `ralph digest` entry for itself (#63): the
// sentence that explains the numbers above it, with how old it is, which model wrote it
// and a `stale` marker once it is older than two of the digest's own intervals (30
// minutes when that knob is off). One gate serves both surfaces — `mode === 'running'`,
// and nothing else. The other three modes open no history file at all and publish
// `digest: null`, so an interrupted run whose narration is sitting on disk still reports
// nothing: prose about work in progress is not a fact about a run that stopped, and
// #59's report card is the surface for those. The policy — which entry, whose run, how
// late is late, how it is wrapped — is pure and lives in lib/digest-history.js; this
// file reads `.ralph/digest.log` and hands over the text.
//
// That narration is the view's FIRST TRUST BOUNDARY. Every other input here was written
// by Ralph; this one was written by a model and lands in the reader's terminal, so the
// render path replaces the control bytes in it with spaces (lib/digest-history.js) —
// an entry carrying an ANSI escape must not be able to repaint the screen. `--json`
// publishes the narrative RAW, and that asymmetry is deliberate: `JSON.stringify`
// escapes everything below 0x20 already, so the scrubbing is a terminal concern and a
// consumer reading the document should get what the model actually wrote.
//
// Above either of those sits the IDENTITY BOX (#76) — version and working directory, no
// sprite and no animation — because this is the command whose output gets screenshotted. A
// table carrying a pace, an ETA and a night's spend says everything about a run except
// which run it was and where, so one picture is worth more when it names both. The box is
// #68's, composed by lib/banner-compose.js and degraded by #72's width ladder there, so
// `ralph start`, `ralph doctor` and this command cannot disagree about how a box looks;
// this file resolves facts and forwards a width. It is additive OUTPUT only — nothing
// below reads it and no exit code moves — and `RALPH_BANNER=off` leaves the report
// byte-identical to what it printed before the box existed. `never-run` prints none: the
// box identifies a RUN and that mode has none, which also keeps it the free one-line
// pointer described above.
//
// `--json` prints the same snapshot as a machine-readable document instead of the
// human lines (#58) — the SAME snapshot, built once here and handed to whichever
// renderer is printing, so a prompt or a notifier driven off the document can never
// report something the terminal does not. Under the flag stdout carries the
// document and nothing else, so `ralph status --json | jq` works in all four modes.
//
// Shape: a thin I/O shell (resolve the git toplevel, read the record, probe
// liveness — tmux session OR cycle lock — resolve the task source, count the
// queue, read the metrics) around two pure functions — reconcileMode() and
// renderStatus() — so every judgement and every string is unit-testable without a
// clock, a filesystem or a subprocess. lib/run-state.js owns the record's fields;
// this file never writes one.

import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execa } from 'execa'
import { peekLock as defaultPeekLock, sessionNameFor } from '../lock.js'
import { readRunState as defaultReadRunState } from '../run-state.js'
import { parseConfigSource, readConfigText } from '../read-config-source.js'
import { resolveSource } from '../task-source.js'
// Where the digest's history lives and how its interval is read (#63); this file
// re-derives neither. Imported from lib/digest-file.js and NOT from lib/digest.js, which
// is where both used to live: lib/digest.js borrows `collectStatus` from this file for
// its context, so importing it back would close a cycle — and would put a command people
// run from a shell prompt one import away from execa and the digest engine. The shared
// module is pure, so this costs the view nothing.
import { digestInterval, digestLogPath } from '../digest-file.js'
// #76: the identity box, and the two modules that decide it. `composeBanner` is the box
// itself — the same one `ralph start` has drawn since #68 and `ralph doctor` since #75 —
// and `resolveBannerMode` is the single owner of what RALPH_BANNER means. This file holds
// neither decision: it resolves facts and forwards a width. `parseConfigVar` reads the knob
// out of the config text the gathering half already has in hand — so the box costs no read,
// and only the parsed VALUE crosses into the rendering half.
//
// NO SPRITE, NO ANIMATION, UNDER ANY SETTING — and this import list is where that is
// decided, which is why the argument is written here once rather than restated beside
// every line it constrains.
//
// It is the ABSENCE of an import rather than a branch: the pixels live in
// lib/sprite-banner.js and in the splash player beside it, and this file reaches NEITHER —
// not even for the `colorEnabled` helper `ralph start` uses. `ralph start`'s splash is a
// curtain going up on a loop that will run all night; `ralph status` is a read-only view
// people drive off a prompt timer, pipe into `jq` and paste into messages, and a command
// whose output gets quoted has no business moving the cursor or repainting a frame.
// status.identity-box.test.js reads this file's source with the comments stripped and
// fails on the word `sprite`, so an import that put an animation one edit away fails
// there rather than in the field.
import { composeBanner } from '../banner-compose.js'
import { resolveBannerMode } from '../banner-mode.js'
import { parseConfigVar } from '../parse-config-var.js'
import { buildDigestView, renderDigestSection } from '../digest-history.js'
import { queueCount as folderQueueCountLib } from '../folder-queue.js'
import { metricsPath, safeReadText } from '../issue-metrics.js'
import {
  buildProgress,
  finiteOrNull,
  formatClock,
  formatElapsed,
  padTaskNumber,
  renderProgress,
  renderProgressLine,
  renderTaskTable,
  toJsonSnapshot,
} from '../progress.js'
import { buildPostMortem, renderPostMortem } from '../post-mortem.js'

// The pace/ETA/spend arithmetic AND the three formatters the live view has used
// since #55 live in lib/progress.js, the pure module — re-exported here so #55's
// callers keep importing them from the command that first needed them.
export { formatClock, formatElapsed, padTaskNumber }

// Same query `ralph start` and the loop use, so "6 waiting" here means the same
// six items the loop would pick up next.
const SEARCH_QUERY =
  'state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge'

// Declared with no throw site yet, on purpose: `status` is a read-only view and
// every mode — including a missing record, a cwd outside a repo and a failed
// queue count — is a successful read, so it has no failure of its own to report.
// Kept for wiring symmetry with the other command blocks in bin/ralph.js, which
// all catch their own Abort type.
class StatusAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

// The whole four-mode decision, as one rule: a `running` record is believed only
// while the RUN that wrote it is still alive — otherwise a hard-killed run (tmux
// kill-session, a reboot) would read as eternally in flight, because nothing gets
// to write a terminal record on the way out.
//
// `runAlive`, not `sessionAlive`: tmux is only one of the loop's two launchers.
// `ralph cycle` spawns the same loop with no session of its own, and proves it is
// alive by holding the cycle lock instead. Which of the two answered is the
// caller's business; this rule stays one rule rather than growing a branch per
// launcher.
export function reconcileMode({ record, runAlive }) {
  if (!record) return 'never-run'
  if (record.status !== 'running') return 'idle'
  return runAlive ? 'running' : 'interrupted'
}

// PURE renderer: mode + record + queue + the progress snapshot + an injected `now`
// (epoch ms) in, lines out. No I/O, no Date.now — the hermetic suite pins the
// exact output.
//
// `attachable` splits the two shapes a live run can have: a tmux-launched run you
// can attach to and kill, versus a scheduled `ralph cycle` run with no session at
// all. It defaults to the tmux shape of a `running` mode; statusCommand always
// passes it explicitly, from the probe that actually answered.
//
// `progress` and `postMortem` are the two snapshots the two views render from
// (#57, #59), and they arrive as PARAMETERS because `ralph status --json` (#58)
// prints the progress one as a document: the shell builds ONE of each and hands
// them to whichever surface is printing, so no two surfaces can report different
// numbers. The defaults exist only so a direct caller — every test of this function
// — need not build one to render a view that has no metrics behind it; a snapshot
// with no history reads every derived number as `unknown`, the honest reading.
//
// `digest` (#63) arrives on the same seam and for the same reason, with one
// difference: its default is `null` rather than a snapshot built from nothing,
// because there is nothing to derive it from without reading a file — and reading
// one is what this function must never do. No digest means no section at all, so a
// caller that has not built one gets exactly the view this file printed before #63.
export function renderStatus({
  mode,
  record,
  session,
  queue,
  attachable = mode === 'running',
  now,
  progress = buildProgress({ record, queue, now }),
  postMortem = buildPostMortem({ record, queue, now }),
  digest = null,
}) {
  // Nothing to report and nothing read to report it from: one friendly line, not an
  // error and not a table of `unknown`.
  if (mode === 'never-run') {
    return ['▸ ralph — never-run · no run recorded yet (start one with `ralph start`)']
  }

  // idle | interrupted — the report card (#59). An interrupted run gets one too,
  // rather than the live view's pace and ETA: it is over, whatever it managed to
  // finish is all there is to say, and a projection for a run that will never pick up
  // another task is an invented number.
  if (mode !== 'running') return renderPostMortem(postMortem)

  const runId = record?.run_id || 'unknown'
  const started = Date.parse(record?.started_at)

  // The table, stood off from its neighbours by a blank line each — or NOTHING, when
  // there is no task to row. A run between tasks with no history yet is a real state
  // (the first iteration of a fresh run reaches it), and the empty list is what keeps it
  // from leaving a pair of blank lines behind where a table would have been.
  const table = renderTaskTable(progress)

  const lines = [
    `▸ ralph — ${mode} · run ${runId} ` +
      `(started ${formatClock(started)}, ${formatElapsed(now - started)} ago)`,
    // Progress REPLACES #55's `in flight` line rather than joining it (#56): which task
    // is in flight is one clause of the sentence a reader actually wants, and the other
    // — how much of the queue is left — was the line's whole reason for existing. The
    // pure module owns every character of it, including the bar.
    renderProgressLine(progress),
    ...(table.length > 0 ? ['', ...table, ''] : []),
    `  queue      ${queue == null ? 'unknown' : `${queue} waiting`}`,
    // Counted facts first, then what they imply (#57): the pace this run is
    // holding, when the queue empties, and what it has cost so far.
    ...renderProgress(progress),
    // ...and then the sentence that explains them (#63) — after the numbers it is
    // about, before the advice about what to do next. The section brings its own
    // blank line and is empty when there is no digest, so the line below stays the
    // one separator between the view and the attach pair either way.
    ...renderDigestSection(digest),
    '',
  ]
  if (attachable) {
    lines.push(`  attach     tmux attach -t ${session}`, '  kill       ralph stop')
  } else {
    // A live run with no session of its own: `ralph cycle`, usually under launchd.
    // There is nothing to attach to, and `ralph start` — the advice the report card
    // gives — is the one thing that would be REFUSED while the cycle lock is held,
    // so point at the log the cycle actually writes instead.
    lines.push(
      '  scheduled  ralph cycle run — no tmux session to attach to',
      '  logs       tail -f logs/ralph-cycle.out.log',
    )
  }
  return lines
}

// EVERYTHING THE VIEW IS BUILT FROM, gathered once (#61). This is the whole I/O
// half of the command — resolve the root, read the record, probe liveness, count the
// queue, read the metrics, reconcile the mode and build the snapshot — split out from
// the rendering half so a THIRD consumer can have the same facts.
//
// That consumer is `ralph digest` (#61), which needs the run, the mode and the
// progress snapshot as prompt context. The alternative was for it to re-resolve the
// root, re-read the record and re-count the queue, which is how two surfaces start
// disagreeing about the same run — the exact failure mode the "one snapshot, two
// renderers" note above exists to prevent. So there is one gatherer, and the
// snapshot it returns is the snapshot `ralph status` prints.
//
// Returns `{root, record, mode, session, tmuxAlive, queue, now, progress, postMortem,
// digest}`. Reads only, like everything else here. The metrics TEXT is deliberately not
// in that list, and neither is the digest history's: both are read below and consumed
// below, and handing either back would invite a caller to build a second snapshot out of
// it — the one thing one gatherer exists to prevent. `digest` is the built VIEW for the
// same reason `progress` is: a projection both renderers share rather than the text.
//
// `json` is here because the READ PLAN (#59) is decided by which surface will print —
// see the comment on `measured` below — and the plan is gathering, not rendering, so it
// belongs to this half. A caller that names no surface (`ralph digest`) gets the human
// view's plan, which is the one that reads the most, because it wants every fact.
export async function collectStatus({
  cwd = process.cwd(),
  exec = execa,
  exists = realExistsSync,
  readFile = realReadFileSync,
  readRunState = defaultReadRunState,
  folderQueueCount = defaultFolderQueueCount,
  peekLock = defaultPeekLock,
  now = Date.now,
  processEnv = process.env,
  json = false,
} = {}) {
  // Anchor on the git toplevel, not the cwd. The record is written by a process
  // anchored there (the loop's PROJECT_ROOT), the cycle lock is keyed on that same
  // path, and `ralph cycle`/`ralph schedule` resolve it the same way — a reader
  // that anchored on the cwd would report `never-run` from any subdirectory of a
  // repo with a live run, and then advise the `ralph start` that would launch a
  // second loop on it. Degrades to the cwd instead of aborting: a read-only view
  // outside a repo should still print `never-run`.
  const root = await resolveRoot(exec, cwd)

  const record = readRunState(root)

  // Probe the session the RUN recorded, not the one a fresh `ralph start` would
  // create: those differ when the record was written elsewhere (a cycle run
  // records the default `ralph`), and liveness is a question about THIS run.
  const session = record?.session || sessionNameFor(root)
  const has = await exec('tmux', ['has-session', '-t', session], { reject: false })
  const tmuxAlive = has?.exitCode === 0

  // Two ways a run proves it is alive, cheapest first: its tmux session, or the
  // cycle lock a `ralph cycle` run holds for its whole duration. The `||` also
  // keeps the lock read off the common path.
  const runAlive = tmuxAlive || Boolean(safePeekLock(peekLock, root)?.alive)
  const mode = reconcileMode({ record, runAlive })

  // Is this run still going? The one fact both snapshots below hang off, and the
  // reason `interrupted` — a record still saying `running` with no process behind
  // it — is not treated as live by either of them.
  const live = mode === 'running' || mode === 'interrupted'
  const hasRun = mode !== 'never-run'

  // THE READ PLAN, decided by what the surface about to print will actually USE
  // rather than by the mode alone (#59 review). A `gh` call and a file read are what
  // this command costs, and a user drives it off a prompt timer.
  //
  //   the card     — needs both for any mode with a record: it reports the ended
  //                  run's outcome and spend, and the queue waiting for the next one.
  //   the document — reports measurements only for the modes whose snapshot is built
  //                  from them (see the seam below), so an idle `--json` run would be
  //                  paying for a queue count its own document publishes as `null`.
  //   never-run    — reads NOTHING under either flag: no `gh` call, no directory scan,
  //                  no metrics read, not even the config read that chooses between
  //                  them, because a repo with no record has nothing they could say
  //                  anything about.
  //   the digest   — a THIRD gate, tighter than `measured` (#63): `.ralph/digest.log` is
  //                  read only when the mode is `running`, because a narration is about
  //                  work in progress and a finished run is reported by the card, which
  //                  #59 built out of facts rather than prose. So `interrupted` pays for
  //                  the queue and the metrics but not for the history, and `never-run`
  //                  still pays for nothing. Enforced at the read itself, below.
  const measured = json ? live : hasRun
  // ralph.config.sh, read ONCE and asked THREE times (#63, #76): the task source decides
  // how the queue is counted, the digest interval decides when a narration counts as late,
  // and RALPH_BANNER decides whether the identity box prints. Reading it three times would
  // let a config rewritten in between answer the questions differently — see
  // parse-config-var.js, whose grammar takes text for this reason. All three are asked HERE,
  // on this side of the seam, and only the three answers are handed back; see the return
  // below for why the text itself stays in this function.
  //
  // Behind the same gate as everything else: never-run reads no config either. That gate is
  // exactly `hasRun` for the human view, which is why the box needs no read of its own —
  // the file is already open in every mode the box prints in, and closed in the one it
  // does not.
  const configText = measured
    ? readConfigText(resolve(root, 'ralph.config.sh'), { exists, readFile })
    : ''
  // The task source, resolved ONCE from that text (#56). It used to be resolved inside
  // countQueue, which was fine while the queue was the only thing that asked — the title
  // lookup below is a second asker, and parsing the same text twice is how two questions
  // about one config start answering differently. Pure and free, so it needs no gate of
  // its own: `resolveSource` over the '' every unmeasured mode has is the default, which
  // is the same answer a repo with no config file gives.
  //
  // OPTIONAL CHAIN, and the hoist is what made it load-bearing (QA's finding): at HEAD
  // this read lived inside `countQueue` behind the `measured` gate, so a deps bag with an
  // explicit `processEnv: null` never reached it in never-run, idle or interrupted. Out
  // here it runs in every mode, which turned a null into a `TypeError` in all four. `?.`
  // rather than a default parameter, matching the sibling `processEnv?.RALPH_BANNER` in
  // this same function: `undefined` still takes the bag's `process.env` default, and an
  // explicit null reads as "no environment", which is what it says.
  const source = resolveSource({
    TASK_SOURCE: parseConfigSource(configText) || processEnv?.TASK_SOURCE,
  })
  const queue = measured ? await countQueue({ root, source, exec, folderQueueCount }) : null
  // ISSUE TITLES for the task table (#56), behind a FOURTH gate — tighter than
  // `measured`, tighter than the digest's, and the three reasons are independent:
  //
  //   `mode === 'running'` — the table is drawn by the live view alone. The other three
  //                          modes render the report card or the one-line greeting, so a
  //                          lookup for them would buy prose nothing prints.
  //   `!json`              — #58's document publishes no title, and its keys are the one
  //                          thing that cannot be fixed after release. Skipping the call
  //                          keeps the document byte-identical AND keeps `--json` the
  //                          cheap surface a prompt or notifier can poll.
  //   `source !== 'folder'` — a folder task's title lives inside its own file, and folder
  //                          mode is deliberately gh-free: it is the mode for repos that
  //                          have no GitHub at all.
  //
  // A COURTESY, never a fact: any failure resolves to `{}` and every row renders as its
  // number, which is exactly what folder mode does on purpose. Nothing is logged, because
  // there is no stderr in this deps bag to log to — see the note below.
  const titles =
    mode === 'running' && !json && source !== 'folder' ? await readIssueTitles({ root, exec }) : {}
  // Read at the RUN's root, where the loop appended it — same anchor as the record
  // and the lock.
  const metricsText = measured ? safeReadText(readFile, metricsPath(root)) : ''
  // ...and the digest's history, at the same anchor. Only for a LIVE run: a finished
  // run's narration belongs to its report card, which #59 built out of facts rather
  // than prose, and never-run must still cost nothing at all.
  const historyText = mode === 'running' ? safeReadHistory(readFile, digestLogPath(root)) : ''

  // ONE clock reading for every surface, and one snapshot per view built from it
  // (#58). The human lines and the JSON document are the same numbers rendered twice,
  // so they must not be able to disagree — which they could if either surface read
  // the clock or the metrics for itself.
  //
  // `live`, not `hasRun`: nothing measured is handed to the progress snapshot unless
  // the run is in flight. run-state's endRun deliberately leaves `current` on a
  // terminal record (it is the last task the run worked on), so handing an idle record
  // to the progress module would have it count a task in flight and report a run that
  // finished hours ago as still working — and its pace would fall back to the all-time
  // mean over a file that outlives every run. In idle/never-run the snapshot is
  // therefore built from nothing at all, which is exactly the all-unknown reading
  // those modes deserve, and it keeps the document one shape instead of two.
  //
  // `runAlive` is the SAME question one layer down, and it is what keeps the two
  // surfaces from contradicting each other over an interrupted run (#59 review): that
  // mode's document does report the measurements above — the run really did complete
  // those tasks at that pace for that money — but the run is over, so there is no task
  // in flight to name and no future to extrapolate. Passing the fact rather than
  // nulling six fields is what keeps it one rule; see buildProgress for what hangs off
  // it.
  //
  // DELIBERATE ASYMMETRY, and it will be flagged on the PR rather than fixed here:
  // the report card below reports an idle run's spend from the same metrics text this
  // gate withholds from the document, so `ralph status` prints a total that
  // `ralph status --json` reports as `null` for the same repo. `--json` is #58's
  // published contract and a key in a document is the one thing that cannot be fixed
  // after release, so #59 leaves the document exactly as shipped; teaching it to
  // publish a terminal run's outcome is its own change, with its own keys.
  //
  // The gate is on the SNAPSHOT only. The projection below still gets the raw
  // record, deliberately: an idle document must name the run that just ended
  // (`run_id`), and the reason that cannot resurrect its task is that
  // `tasks.current` is gated on the snapshot's own in-flight count rather than on
  // the record it was handed.
  const nowMs = now()
  const progress = buildProgress({
    metricsText: live ? metricsText : '',
    record: live ? record : null,
    queue: live ? queue : null,
    now: nowMs,
    runAlive: mode === 'running',
    // Handed over RAW. Cleaning untrusted text is policy — which bytes a terminal
    // obeys, how wide a column is, where to cut — and it lives in the pure module
    // where it is unit tested, next to the digest narration's scrubbing rather than
    // duplicated here. This side reads; that side decides.
    titles,
  })
  // ...and the report card the two ended modes render from (#59), built here for the
  // same reason: one snapshot, from one clock reading and one read of each input.
  const postMortem = buildPostMortem({ metricsText, record, queue, now: nowMs })
  // ...and the digest view (#63), off the SAME clock reading, so the age the terminal
  // prints and the `age_min` the document publishes are one subtraction rather than
  // two. `null` for every mode but `running`: the text above is empty there, and a
  // view built from nothing is nothing.
  const digest = buildDigestView({
    historyText,
    record,
    now: nowMs,
    interval: digestInterval(configText),
  })

  // `bannerSetting` (#76) is the config's RALPH_BANNER value, the third and last projection
  // this one read yields — beside the queue count the task source decided and the digest
  // view the interval shaped. The rule stated above holds without an exception: every input
  // is parsed on this side and only projections cross the seam, so no caller can build a
  // second reading of the run — or of the user's settings — out of bytes it was handed.
  //
  // The RAW TEXT deliberately does NOT cross. `ralph digest` (#61) shares this gatherer and
  // interpolates what it gets into a model prompt, and ralph.config.sh is where people keep
  // API keys; a snapshot carrying the file's text would put a secret one careless
  // interpolation away from an LLM, with the paragraph explaining why it was safe sitting
  // in a different file. Handing over the VALUE keeps that structurally impossible and
  // still keeps the file read ONCE, which is the whole point of `measured` — the
  // alternative was a second `readConfigText` in `statusCommand`, reading the same path a
  // moment later and answering `never-run` differently from this gate.
  //
  // Parsed unconditionally rather than behind the gate: `configText` is already '' in every
  // mode that read nothing, and `parseConfigVar('', …)` is '' — the same "nothing
  // configured" a repo with no config file gives. One expression, no second branch to keep
  // in step with the read plan.
  return {
    root,
    record,
    mode,
    session,
    tmuxAlive,
    queue,
    now: nowMs,
    progress,
    postMortem,
    digest,
    bannerSetting: parseConfigVar(configText, 'RALPH_BANNER'),
  }
}

// No `stderr` in the deps bag, unlike the other commands: every mode here is a
// successful read, so there is nothing to write to it — and under `--json` (#58)
// that absence is load-bearing rather than incidental. A diagnostic would have to
// go to stderr to keep stdout pipeable, and the reason there is no such write
// anywhere below is that there is no diagnostic to make: a missing record, a cwd
// outside a repo, a failed queue count and an unreadable issues.jsonl all resolve
// to a `null` leaf in the document, which SAYS "unknown" more usefully to a
// consumer than a line of prose it would have to parse.
//
// The RENDERING half: it gathers nothing itself (collectStatus above does all of
// it) and decides only which of the two surfaces prints the snapshot.
export async function statusCommand({
  stdout = process.stdout,
  json = false,
  collect = collectStatus,
  // #76: the installed version, threaded from package.json by bin/ralph.js — the title
  // row of the identity box and the fact the whole box exists to carry. The same
  // 'unknown' fallback every other command uses for a package.json it could not read: a
  // title that claims nothing rather than a fabricated number.
  currentVersion = 'unknown',
  // #76: whether ANSI may be emitted, and it defaults to `false` rather than to
  // picocolors' answer. That is a DEVIATION from `ralph doctor`, and it is forced by this
  // file's own contract: status.json.qa.test.js asserts that the string `pc.` and the
  // specifier `picocolors` appear NOWHERE in this module, because `--json`'s stdout is a
  // document and the cheapest way to guarantee no escape reaches it is for the command to
  // hold no colour source at all. Nothing is lost by it — the box drawn here has no
  // painted row, since `latestVersion` and `cachedLatest` are the only two facts
  // composeBanner colours and this command passes neither, so the lines are byte-identical
  // either way (asserted in status.identity-box.test.js). It stays an OPTION rather than a
  // hardcoded `false` because it is a capability of the terminal, and #41's rule is that
  // every one of those is injectable; a future fact worth painting would then need only a
  // caller that says so.
  color = false,
  // #76: the terminal's width, for #72's degradation ladder — a terminal reports its
  // columns, a pipe reports `undefined`, and `bannerLayout` reads both. Resolved from the
  // stream this command was handed rather than from `process.stdout`, so a piped or
  // captured run is measured on the stream it is actually writing to.
  columns = stdout?.columns,
  // #76: the environment, for the RALPH_BANNER override. Named here — where it used to
  // ride along inside `...gather` — because the rendering half now asks it a question of
  // its own, and it is FORWARDED to the gatherer explicitly below for that same reason:
  // destructuring a key out of a rest bag silently stops passing it on, and the task
  // source still reads TASK_SOURCE out of this exact object.
  processEnv = process.env,
  // ...and everything else — cwd, exec, exists, readFile, readRunState,
  // folderQueueCount, peekLock, now — is forwarded to `collectStatus` untouched, which is
  // why this signature names none of them.
  ...gather
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')

  // `json` is forwarded even though it is destructured above, because it decides the
  // read plan as well as the surface (#59): the gatherer must know which of the two is
  // about to print, or an idle `--json` run pays for a queue count its own document
  // publishes as `null`.
  const {
    root,
    record,
    mode,
    session,
    queue,
    tmuxAlive,
    now: nowMs,
    progress,
    postMortem,
    digest,
    bannerSetting,
  } = await collect({ ...gather, processEnv, json })

  if (json) {
    // The document, and NOTHING else on stdout: no heading, no advice, no
    // trailing blank line. One line, compact, newline-terminated — `jq` and a
    // line-buffered status line both want a whole document per read, and a
    // pretty-printed one would only be re-formatted by whatever consumes it.
    out(JSON.stringify(toJsonSnapshot(progress, { mode, record, digest })))
    return { exitCode: 0, mode, record, queue }
  }

  // #76: THE IDENTITY BOX, and it belongs to THIS half rather than to renderStatus.
  //
  // renderStatus is pure and stays pure: it takes a snapshot and returns the view's lines,
  // and every one of those lines is a statement about the run's state. The box is not —
  // it is a statement about the PROCESS that printed them, it is switched by a knob read
  // off the environment and the config, and its shape depends on how wide the terminal
  // happens to be. Folding three ambient capabilities into a pure renderer to save a loop
  // here would cost the property that makes the view testable at all; status.help.test.js
  // derives its expectations from renderStatus, and the box is not one of its lines.
  //
  // ONE CONDITION, evaluated left to right, and the short-circuit is the rule rather than
  // an optimisation: `never-run` prints no box AT ALL. That mode is the one this command
  // guarantees costs nothing — five tests across status.test.js and status.qa.test.js assert
  // it reads NOTHING, not even the config — and `bannerSetting` is therefore '' there by the
  // read plan above, so resolving in that mode would answer "draw the default box" from a
  // config nobody opened. The box identifies a RUN; a repo that has never had one has
  // nothing for it to name.
  //
  // NO `isTTY` IS PASSED, and the omission is the point: without it the resolver can only
  // ever answer `sprite: false`, so no arrangement of this command's arguments authorises
  // a pixel — structural rather than a matter of discipline, and the second half of the
  // guarantee whose first half is the missing import at the top of this file. `box` is the
  // one field read of the four returned, and it does not depend on TTY-ness by design (see
  // banner-mode.js: the terminal caps the SPRITE, never the FACTS — a piped `ralph status`
  // is precisely a paste into a message), while `mode` and `sprite` are questions about an
  // animation this command cannot draw. The `warning` is left unprinted for the reason
  // `ralph doctor` leaves it unprinted and this command has one more of: there is no
  // diagnostic channel here at all — no stderr in the deps bag, see the note above — and
  // that absence is what keeps `--json` pipeable. A mistyped knob therefore costs a picture
  // at worst, and `ralph start` is where the user is told.
  const box =
    mode !== 'never-run' &&
    resolveBannerMode({
      configured: bannerSetting,
      override: processEnv?.RALPH_BANNER,
      color,
      width: columns,
    }).box
  if (box) {
    // TWO FACTS, and the shortness of the list is the decision. `version` says which Ralph
    // and `cwd` says which repo — together they are the two things a screenshot of the
    // table below cannot say for itself. Deliberately NOT `latestVersion`/`cachedLatest`:
    // that would mean reading the global update-check cache, and "a newer Ralph is waiting"
    // is advice for the two commands a reader is in a position to act on (`ralph start`
    // resolves it, `ralph doctor` reports it) rather than for a view someone refreshes on a
    // timer. Deliberately NOT `os`/`agent` either: doctor carries those because it is
    // diagnosing a MACHINE, and this command is reporting a run.
    //
    // `root` and not the cwd, for the reason the whole file anchors there: the record, the
    // cycle lock, issues.jsonl and .ralph/digest.log are all keyed on the git toplevel, so
    // it is the one path a reader can take back to the run being reported — and printing
    // the cwd would name a subdirectory that owns none of it.
    for (const line of composeBanner({
      facts: { version: currentVersion, cwd: root },
      width: columns,
      capabilities: { color },
    })) {
      out(line)
    }
    // The blank line between the identity block and the report, printed only when there is
    // something above it to separate. `RALPH_BANNER=off` therefore means exactly what it
    // means in `ralph start` and `ralph doctor`: not one byte between the command line and
    // the first line of the report, rather than an orphan blank where the box used to be —
    // which is also what lets status.test.js and status.qa.test.js keep pinning the report
    // line by line with the knob turned off.
    out('')
  }

  const lines = renderStatus({
    mode,
    record,
    session,
    queue,
    attachable: tmuxAlive,
    now: nowMs,
    progress,
    postMortem,
    digest,
  })
  for (const line of lines) out(line)

  return { exitCode: 0, mode, record, queue }
}

// The repo root, the way `ralph cycle` and `ralph schedule` resolve it — minus the
// abort: outside a git work tree the cwd is a good enough anchor for a read.
async function resolveRoot(exec, cwd) {
  const probe = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, reject: false })
  if (probe?.exitCode !== 0) return cwd
  return (probe.stdout || '').trim() || cwd
}

// The digest history as TEXT, '' on any failure (#63) — the same never-throws shape
// `safeReadText` gives, and for the same reason: a read-only view must never abort
// over an accessory. `.ralph/digest.log` is the file most likely to be missing (a
// repo with the digest off never creates it), so ENOENT is the common case rather
// than the exceptional one, and no `exists` probe is spent on asking first. Every
// unreadable shape — missing, unreadable, half-written — reaches the parser as text
// it answers `null` to, and the section simply is not printed.
function safeReadHistory(readFile, path) {
  try {
    return readFile(path, 'utf8')?.toString() || ''
  } catch {
    return ''
  }
}

// Same guard `ralph schedule status` puts around its lock read: a lock this
// command only consults for liveness must never be the thing that breaks the view.
function safePeekLock(peekLock, root) {
  try {
    return peekLock(root)
  } catch {
    return null
  }
}

// Live queue depth, resolved the way `ralph start` resolves it: the task source
// comes from ralph.config.sh, folder mode counts the local .ralph/tasks tree and
// makes no gh call at all. Returns null — rendered as `unknown` — when the count
// fails or answers with something that is not a number, because a failed count
// must degrade, never abort a read-only status view.
//
// Takes the RESOLVED source rather than the config text (#56): its caller resolves it
// once, because the title lookup below asks the same question and two parses of one
// file is how two answers start to differ. Before #63 this function read the file
// itself; before #56 it parsed the text. Now it is handed the answer.
async function countQueue({ root, source, exec, folderQueueCount }) {
  if (source === 'folder') {
    try {
      return finiteOrNull(await folderQueueCount({ cwd: root }))
    } catch {
      return null
    }
  }

  const queue = await exec(
    'gh',
    ['issue', 'list', '--search', SEARCH_QUERY, '--limit', '100', '--json', 'number', '-q', '. | length'],
    // At the root, like every other gh call in the CLI: gh reads the repo off the
    // git remote of its cwd.
    { cwd: root, reject: false },
  )
  if (queue?.exitCode !== 0) return null
  const raw = (queue.stdout || '').trim()
  return raw === '' ? null : finiteOrNull(Number(raw))
}

// The task table's titles (#56): `{ [number]: title }`, best effort. One `gh` call,
// AFTER the queue count above — the number the view cannot do without is bought first,
// and the prose second.
//
// `--state all`, which is the whole difference between this call and the queue's: the
// table's closed rows are issues this run has just CLOSED, so `gh`'s open-only default
// would title the queue and leave every row above it blank. `--limit 100` matches the
// queue count's ceiling, and both match how many rows a night's run can produce.
//
// EVERY FAILURE IS `{}`, and there are more of them than "invalid JSON": gh may be
// missing, unauthenticated or timed out; its stdout may be a Buffer, empty, whitespace,
// an HTML error page from a proxy, or valid JSON that is not an array at all. None of
// those is worth a word on stderr — there is no stderr in this deps bag, deliberately
// (see the note above `statusCommand`), and a diagnostic about a missing courtesy would
// be noise on a view people drive off a prompt timer.
//
// Filtered on the way in rather than trusted: a finite number key and a string title,
// or the entry is dropped. Untrusted CONTENT is not this function's business — the pure
// module cleans the text, since that is where it is unit tested — but untrusted SHAPE
// is, because a `title` that is an object would reach the renderer as `[object Object]`.
async function readIssueTitles({ root, exec }) {
  let listed
  try {
    listed = await exec(
      'gh',
      ['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title'],
      // At the root, like every other gh call in the CLI, and never rejecting: a failed
      // courtesy must degrade, not throw.
      { cwd: root, reject: false },
    )
  } catch {
    // ...and `reject: false` is the DEPENDENCY's promise, not this function's. execa
    // honours it — a spawn failure resolves as `{ failed: true }` — but `exec` is an
    // injected seam, and a stub, a wrapper or a replacement that rejects on ENOENT would
    // otherwise take a whole read-only view down over a courtesy lookup (QA's finding).
    // The three older call sites in this file have the same shape and are deliberately
    // left alone: hardening them is a change to code #56 did not touch.
    return {}
  }
  if (listed?.exitCode !== 0) return {}
  let parsed
  try {
    parsed = JSON.parse((listed.stdout || '[]').toString() || '[]')
  } catch {
    return {}
  }
  if (!Array.isArray(parsed)) return {}
  const titles = {}
  for (const issue of parsed) {
    const number = issue?.number
    if (typeof number !== 'number' || !Number.isFinite(number)) continue
    if (typeof issue.title !== 'string') continue
    // First wins, so a repo listing the same number twice cannot have a later entry
    // rewrite an earlier one.
    if (!Object.hasOwn(titles, number)) titles[number] = issue.title
  }
  return titles
}

// Default folder-queue counter — the same one `ralph start` uses. Injectable in
// tests via folderQueueCount.
function defaultFolderQueueCount({ cwd }) {
  return folderQueueCountLib(resolve(cwd, '.ralph', 'tasks'))
}

export { StatusAbort }
