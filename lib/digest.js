// `ralph digest` (#61) — a few sentences of narrative about what the run is doing
// RIGHT NOW: which task is in flight, which file it is editing, which TDD phase it
// looks to be in, what landed, and anything that looks wrong. One turn on a cheap
// model, not an agent session, so it is fast enough and cheap enough to ask for
// every few minutes all night.
//
// THE MODEL GETS NO TOOLS, and that is the design rather than a setting. Ralph
// assembles the context deterministically here — the in-flight log tail, git
// status/log, the progress snapshot — and hands it over INLINE in the prompt, asking
// only for prose back. Sandboxing an agent that COULD act leaves you trusting the
// sandbox; a model with no tools at all cannot act, and the property is verifiable
// from the prompt (see the tests that assert the context travels inline). The claude
// argv says `--tools ""` and the codex argv says `--sandbox read-only`, both from the
// registry, which stays the only file holding agent-specific knowledge.
//
// AN ACCESSORY, WHICH IS THE OTHER HALF OF THE CONTRACT: a digest may never affect a
// run. So every failure — an agent that exits non-zero, is not installed, is
// unauthenticated, hangs, or answers with nothing — produces NO history entry, one
// terse line on stderr, and exit 0. There is no throw site anywhere below, and every
// AWAIT is bounded out of the ONE injected budget, including the ones in front of the
// agent call: the call itself gets the whole budget, and the three waits before it —
// the run-state gather, then the two git probes concurrently — get a sixth each. Worst
// case is the budget, plus a third of it, plus two kill graces (124s at the defaults)
// and never longer, because a command that can hang is a command that can hold up
// whatever asked for it. (The synchronous fs calls — the template read, the log tail,
// the append — are not bounded and cannot be: they are local, small, and the kernel
// owns how long they take. They are guarded against FAILING, which is the risk they
// actually carry.)
//
// THE CONTEXT IS BORROWED, NOT RE-DERIVED. `collectStatus` (lib/commands/status.js)
// already resolves the project root, reads the run record, reconciles the mode,
// counts the queue and builds the progress snapshot; the digest calls it rather than
// doing any of that again, so the prose can never describe a run that `ralph status`
// would describe differently.
//
// BOUNDED INPUT, where input can grow. The in-flight agent log grows for as long as a
// task runs, so it is never fed whole to a model: `boundedTail` caps it by lines AND
// bytes and keeps the most recent end. Same for git output, from the other end
// (`boundedHead` — the branch line, with its ahead/behind, is the first line and the one
// that matters). RUN_STATE and PROGRESS are deliberately NOT bounded: both are fixed-shape
// documents of a few hundred bytes whose size does not grow with the run, and cutting
// either would emit invalid JSON while dropping the fields the prose most needs (the
// terminal ok/failed counts from one end, the run identity from the other).
//
// APPEND, NEVER OVERWRITE. Each digest is appended to `.ralph/digest.log` under a
// heading naming four things — an ISO stamp, the run id, the task in flight and the
// model that answered — so after a night the file reads as the whole night's narrative
// and greps by any of the four. `.ralph/` is already gitignored. The entry format is
// self-delimiting BY CONSTRUCTION rather than by convention, and `formatHistoryEntry`
// owns ALL of that construction — its own leading newline included — so the append is a
// verbatim write with nothing to get wrong. One digest is exactly one `^── ` line and
// exactly one blank-line-delimited block, always, for any narrative and any record.
//
// ...AND THE FORMAT NOW HAS A READER, so it is a contract rather than a convenience
// (#63): `ralph status` shows the latest entry for the run in flight, which means
// lib/digest-history.js parses what this file writes. The literals both sides agree on
// live in lib/digest-file.js and are imported here, so neither can be changed alone; the
// reasoning for each defence is on `formatHistoryEntry` below, and the reader's own
// tests build every fixture by calling it.
//
// Shape: the pure halves — `buildDigestInvocation`, the bounds,
// `assembleDigestContext`, `extractNarrative`, `formatHistoryEntry`, `renderDigest` —
// plus `runDigest`, the engine, whose every side effect (exec, read, append, mkdir,
// clock) arrives as a parameter. `digestLogPath` is re-exported from lib/digest-file.js,
// which owns it now — this module is still the one that APPENDS to that path, so callers
// keep asking it. lib/commands/digest.js is the CLI shell over it.

import {
  appendFileSync as realAppendFileSync,
  mkdirSync as realMkdirSync,
  readFileSync as realReadFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { agentSpec, resolveAgent } from './agent-registry.js'
// The file this module appends to — where it lives, how an entry is spelled, and when
// the next one is due — is owned by lib/digest-file.js, so the READER of the same file
// (lib/digest-history.js) and the two commands that care about the knob share these
// literals with the writer instead of re-typing them. See that file's header. Only what
// this module actually uses is imported: `digestInterval` lives there and is read there,
// and pulling it through here would make anyone who wants one line of ralph.config.sh
// load the engine, execa and all.
import {
  ABSENT_AT,
  ABSENT_MODEL,
  ABSENT_RUN,
  ABSENT_TASK,
  ENTRY_INDENT,
  FIELD_SEPARATOR,
  HEADING_PREFIX,
  digestLogPath,
} from './digest-file.js'
import { interpolate } from './interpolate.js'
// The one-line flattener USED to be defined right here, and it moved for a reason that had
// nothing to do with digests: `ralph doctor` needs it too, and doctor's import graph is pinned
// (lib/commands/doctor.version-line.qa.test.js) to four bare specifiers that do not include
// execa — which this module imports. So the seven pure lines are now lib/one-line.js, which
// imports nothing. See that file's header for the whole argument; `oneLineEcho` is its sibling
// and is for echoing somebody's own value back at them, which nothing here does.
import { oneLine } from './one-line.js'
import { templatePath } from './paths.js'
import { formatClock, taskKeyOf, toJsonSnapshot } from './progress.js'
import { collectStatus, padTaskNumber } from './commands/status.js'

// How long the whole answer may take. A cheap-model one-shot answers in seconds, so
// this is a hang bound rather than a budget — and it is what keeps `ralph digest`
// from ever becoming something you wait on. Injectable so a test can trip it fast.
export const DIGEST_TIMEOUT_MS = 90000

// ...and then how much longer we are willing to wait for the KILL to take effect,
// after which we stop waiting regardless.
//
// These are two different bounds and both are needed. execa's `timeout` bounds the
// CHILD: at the deadline it signals the process. It does NOT bound our WAIT, because
// the result promise only settles once the child's stdout has closed — and a child
// that spawned its own children (which every agent CLI does) leaves them holding that
// pipe after it dies. Measured: a stub killed at 500ms kept execa pending for 5.2s,
// exactly the grandchild's lifetime. A digest that can hang for as long as an agent's
// orphans feel like living is not bounded at all, so the race below is the real bound
// and this is the CEILING on the grace it allows for the polite kill to work first (the
// grace itself is `childDeadline`'s, which clamps this to the child's own budget).
const KILL_GRACE_MS = 2000

// The race's own answer, distinguishable from any value a child could resolve with.
const HUNG = Symbol('digest-hung')

// Everything waited on BEFORE the agent — the run-state gather and the two git probes —
// gets a SHARE of the same budget rather than a second wall-clock constant to keep in
// step with it: a caller that tightens the digest's timeout tightens everything the
// digest waits on. A sixth is 15s of the 90s default, which is an eternity for a run
// record and two local read-only commands, and still short enough that a stalled repo
// costs a paragraph rather than the command.
const PROBE_BUDGET_SHARE = 6

// The in-flight log tail's two bounds. Both, not either: 80 lines of ordinary log
// output is a few KB, but one line of a minified diff or a base64 blob is not, and a
// prompt is billed by the token either way.
export const TAIL_MAX_LINES = 80
export const TAIL_MAX_BYTES = 8000

// git output is bounded too, from the head — `git status --short --branch` leads with
// the branch line the digest most wants (`## main...origin/main [ahead 8]`), so a
// tail bound would throw away the very thing the issue asks to be flagged.
const GIT_MAX_LINES = 40
const GIT_MAX_BYTES = 4000
const GIT_LOG_COMMITS = 10

// The prompt template.
const DIGEST_TEMPLATE = 'digest.md'

// Every heading this file prints (the terminal one and the history one) is padded to
// the same width, so a history file skims as a column of entries. It stays HERE and is
// not part of the shared format: the reader strips the pad by anchoring on the end of
// the line, so it never needs the number.
const HEADING_WIDTH = 64

// Re-exported rather than defined: the path is lib/digest-file.js's now, so the reader of
// the file shares one spelling of it with the writer — but this module is what appends to
// it and has answered for it since before the file had a reader, so callers that already
// ask here keep getting an answer.
export { digestLogPath }

// Where the loop writes the human-readable stream for the task in flight. `null`
// rather than a path when there is no task (or a record too broken to name one), so
// the caller reads "nothing to tail" instead of going looking for
// `ralph-issue-null.log`.
export function inFlightLogPath(projectRoot, taskNumber) {
  if (typeof taskNumber !== 'number' || !Number.isFinite(taskNumber)) return null
  return join(projectRoot, 'logs', `ralph-issue-${taskNumber}.log`)
}

// PURE. The argv for one no-tool text completion, composed the way
// agent-invocation.js composes the loop's: the STATIC flags come from the registry
// spec, and only the env-dependent model is added here. Deliberately NOT entangled
// with the loop's builder — they answer different questions (autonomy versus
// narration) and sharing a code path would invite one to inherit the other's flags.
//
// RALPH_DIGEST_MODEL takes precedence; unset, empty or whitespace-only means the
// registry's cheap default. RALPH_CODEX_MODEL is deliberately ignored: the loop's
// model is chosen for depth, and a digest on it would cost more than the work it
// narrates.
export function buildDigestInvocation(env = {}) {
  const { agent } = resolveAgent(env)
  const spec = agentSpec(agent)
  const { argv, modelFlag, model: defaultModel, stdinArgv, output } = spec.digest

  const override = String(env?.RALPH_DIGEST_MODEL ?? '').trim()
  const model = override || defaultModel

  return {
    agent,
    cli: spec.cli,
    // ...static flags, the model, then whatever makes this CLI read stdin — which
    // must stay last, because for codex it is a positional (`-`).
    args: [...argv, modelFlag, model, ...stdinArgv],
    model,
    output,
  }
}

// PURE. Keep at most `maxLines` lines and `maxBytes` bytes of `text`, from the END —
// the most recent output, which is what a live log's reader wants.
export function boundedTail(text, opts) {
  return bound(text, opts, true)
}

// ...and from the START, for output whose first line is the important one.
export function boundedHead(text, opts) {
  return bound(text, opts, false)
}

function bound(text, { maxLines = TAIL_MAX_LINES, maxBytes = TAIL_MAX_BYTES } = {}, fromEnd) {
  const raw = text == null ? '' : String(text)
  if (raw === '') return ''

  // Trailing newlines first: a file that ends with one would otherwise spend a line
  // of the budget on the empty string after it.
  const lines = raw.replace(/\n+$/, '').split('\n')
  const lineCap = Math.max(1, maxLines)
  const kept = fromEnd ? lines.slice(-lineCap) : lines.slice(0, lineCap)

  let buf = Buffer.from(kept.join('\n'), 'utf8')
  const byteCap = Math.max(1, maxBytes)
  if (buf.length > byteCap) {
    // Cut on a UTF-8 character boundary. A blind byte slice through a multi-byte
    // character hands the model a replacement character (`�`) — a corruption that
    // looks, in a log tail, exactly like a real one in the file.
    if (fromEnd) {
      buf = buf.subarray(buf.length - byteCap)
      let start = 0
      while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
      buf = buf.subarray(start)
    } else {
      let end = byteCap
      while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
      buf = buf.subarray(0, end)
    }
  }
  return buf.toString('utf8')
}

// PURE. Prose out of whatever the CLI printed, dispatched on the SPEC's `output`
// kind — never on the agent's name, which is what keeps this file free of
// agent-specific branching (the same rule the registry's `authProbe` kind follows).
//
// An unknown kind degrades to the raw text rather than throwing: a registry that
// grows a third agent must not be able to crash a reader here.
export function extractNarrative(stdout, output) {
  const text = stdout == null ? '' : String(stdout)
  if (output === 'jsonl-agent-message') return lastAgentMessage(text)
  return text.trim()
}

// Codex prints JSONL events, and the prose is the LAST agent message in the stream
// (the earlier ones are reasoning and tool chatter). Same event shape the registry's
// codex streamFilter reads, with the same tolerance: blank, untagged, malformed and
// half-written lines are skipped in silence.
function lastAgentMessage(text) {
  let latest = ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.startsWith('{')) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    // `item.completed` wraps the item; some versions emit the item's type at the top
    // level instead, so both are accepted.
    const item = event.item && typeof event.item === 'object' ? event.item : event
    const type = item.type
    if (type !== 'agent_message' && type !== 'assistant_message') continue
    const body = typeof item.text === 'string' ? item.text : item.message
    if (typeof body === 'string' && body.trim() !== '') latest = body
  }
  return latest.trim()
}

// PURE. The interpolation vars for templates/digest.md — the WHOLE of what the model
// will know, since it has no way to fetch anything else.
//
// The record and the snapshot go in as JSON rather than as prose. They are already
// documents with names a model can read (`queue_at_start`, `per_task_min`), and
// re-rendering them into sentences here would be a second presentation policy, free
// to drift from what `ralph status` reports. Absences are spelled out in words,
// because a blank fenced block reads as "clean" when it means "unknown".
export function assembleDigestContext({
  record,
  mode,
  snapshot,
  gitStatus,
  gitLog,
  logPath,
  logTail,
  now,
} = {}) {
  return {
    NOW: isoStamp(now),
    MODE: mode ?? 'unknown',
    TASK: taskLabel(record),
    RUN_STATE: record ? JSON.stringify(record, null, 2) : '(no run record on disk)',
    PROGRESS: JSON.stringify(snapshot ?? {}, null, 2),
    GIT_STATUS: boundedHead(gitStatus, { maxLines: GIT_MAX_LINES, maxBytes: GIT_MAX_BYTES })
      || '(git reported nothing — a clean tree, or not a repo)',
    GIT_LOG: boundedHead(gitLog, { maxLines: GIT_MAX_LINES, maxBytes: GIT_MAX_BYTES })
      || '(no commits reported)',
    LOG_PATH: logPath ?? '(no task in flight, so no log to tail)',
    LOG_TAIL: logTail || '(the log is empty or has not been written yet)',
  }
}

// The prompt. `readTemplate` is separate from the engine's `readFile` on purpose: one
// reads Ralph's OWN packaged template, the other reads files in the user's project,
// and a single injectable conflating them would let a test stubbing project reads
// accidentally starve the prompt.
//
// Returns NULL rather than raising when the template cannot be turned into text — a
// partial npm install, an unreadable `templates/`, a reader that answers with
// something that is not a string. The engine reports that like any other failure,
// which is the difference between "ralph digest could not narrate" and a stack trace
// on the reader's terminal.
export function buildDigestPrompt(vars, { readTemplate = realReadFileSync, stderr = process.stderr } = {}) {
  let raw = null
  try {
    raw = readTemplate(templatePath(DIGEST_TEMPLATE), 'utf8')
  } catch {
    return null
  }
  // A string (real `readFileSync` with an encoding) or a Buffer (without one). Anything
  // else is a broken reader, not a template, and interpolating `String(42)` would ship
  // a two-character prompt to a model rather than saying so.
  const template =
    typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null
  if (!template || template.trim() === '') return null
  try {
    return interpolate(template, vars, { stderr })
  } catch {
    return null
  }
}

// ONE WHOLE HISTORY ENTRY, delimiters included, so that a caller appending this byte
// string cannot get the format half right. The format is chosen so that the entry
// SEPARATOR cannot occur inside an entry: a leading newline, then timestamp, run id,
// in-flight task and the model that answered on the heading line (so the file is
// greppable by run, by task and by model), then the narrative INDENTED line by line,
// then a blank line.
//
// The MODEL is the fourth field and it arrived last (#63), because `ralph status` reads
// this heading back to say who narrated the run — and a reader deciding whether to
// trust a paragraph wants to know whether haiku or the frontier model wrote it. Four
// fields, ` · `-separated, in the order a reader scans them: when, which run, which
// task, whose words. An entry written before #63 has three, which the reader treats as
// a digest with an unnamed model rather than as a malformed entry — see
// lib/digest-history.js.
//
// All three of those are defences, and every one of them is about text this file does not
// control:
//
//   * The INDENT, against the narrative, which is model output — and
//     `templates/digest.md` asks for two paragraphs. A blank line inside the narrative
//     would otherwise split one digest into two blocks, which is the common case and not
//     an edge case; indented, a "blank" line still carries the indent, so `\n\n` occurs
//     only BETWEEN entries. And a narrative line beginning `── ` would otherwise forge a
//     heading, attributing invented prose to another run and task; indented, no body line
//     can start at column 0, so `grep '^── '` counts entries exactly.
//   * The LEADING NEWLINE, unconditional, against the file. A well-formed history already
//     ends in one, so this usually just widens the gap between entries — but a digest
//     interrupted mid-append, or a file a human edited, leaves the last line
//     unterminated, and then the new heading would be glued onto it and `grep '^── '`
//     would silently miss the entry. Written blind rather than after reading the file back
//     to find out: the guarantee is then a property of the format instead of a property of
//     a read that can itself fail, and it costs one byte.
//   * `oneLine` ON THE HEADING, against the run record AND the environment. The record is
//     read verbatim off disk and may be from a future version, hand-edited or truncated
//     (see lib/run-state.js), so a `run_id` holding a newline would split the heading and
//     could itself start a second `^── ` line — the very forgery the indent exists to
//     prevent. The model is inside the same guard for the same reason and a nearer one:
//     it comes from `RALPH_DIGEST_MODEL`, which is a string a user exports.
export function formatHistoryEntry({ at, runId, task, model, narrative } = {}) {
  const head = heading(
    oneLine(
      [at || ABSENT_AT, `run ${runId || ABSENT_RUN}`, task || ABSENT_TASK, model || ABSENT_MODEL].join(
        FIELD_SEPARATOR,
      ),
    ),
  )
  const body = String(narrative ?? '')
    .trim()
    .split('\n')
    .map((line) => ENTRY_INDENT + line)
    .join('\n')
  return `\n${head}\n${body}\n\n`
}

// PURE. The ONLY thing that reaches stdout: one heading naming the task, the model
// that answered and the clock, then the narrative verbatim. Nothing else is ever
// printed there, so `ralph digest > notes.md` collects prose and only prose.
export function renderDigest({ narrative, task, model, now } = {}) {
  return [
    heading(`digest · ${task || 'none'} · ${model || 'unknown'} · ${formatClock(now)}`),
    ...String(narrative ?? '')
      .trim()
      .split('\n'),
  ]
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

// Assemble, ask once, append, return the text. Returns
// `{status, narrative, diagnostic, ...}` where status is:
//   'ok'     — narrative present, history appended
//   'no-run' — nothing has ever run here; no agent invoked, no entry written
//   'failed' — the agent could not answer; no entry written
// and NEVER throws: `diagnostic` is the one line the caller puts on stderr.
export async function runDigest({
  cwd = process.cwd(),
  env = process.env,
  exec = execa,
  readFile = realReadFileSync,
  readTemplate = realReadFileSync,
  appendFile = realAppendFileSync,
  mkdir = realMkdirSync,
  collect = collectStatus,
  now = Date.now,
  timeout = DIGEST_TIMEOUT_MS,
  stderr = process.stderr,
} = {}) {
  // The run, the mode and the progress snapshot, from the same gatherer `ralph
  // status` renders. Guarded twice, because this is the FIRST wait and therefore the
  // easiest one to forget: against throwing, and against never answering. It shells out
  // to `git rev-parse`, `tmux has-session` and — on a github-sourced run — `gh issue
  // list`, a network call, none of which carries a timeout of its own today, so an
  // unbounded await here would leave the whole command unbounded one frame above the
  // region that is carefully bounded below.
  //
  // No kill grace on this one: those children belong to the gatherer, not to us, so
  // there is nothing here to signal and nothing to wait for after signalling it. We
  // stop waiting; `raceDeadline` swallows whatever the abandoned promise does next.
  const gatherBudget = budgetShare(timeout)
  let status
  try {
    status = await raceDeadline(collect({ cwd, exec, readFile, now, processEnv: env }), gatherBudget)
  } catch (e) {
    return failed(`could not read the run state (${messageOf(e)})`)
  }

  // 'failed', deliberately, and NOT 'no-run': a gatherer that never answered leaves us
  // ignorant, which is not the same claim as a project with nothing recorded in it.
  // 'no-run' is a quiet, expected, correct answer that suppresses the agent call on
  // purpose; reporting it here would print a reassuring line about a healthy fresh
  // project while a probe is wedged. A stuck gather is an anomaly and gets its own line.
  if (status === HUNG) {
    return failed('gave up waiting for the run state — git, tmux or the queue probe did not answer')
  }

  const root = status?.root ?? cwd
  const record = status?.record ?? null
  const mode = status?.mode ?? 'never-run'
  const atMs = Number.isFinite(status?.now) ? status.now : now()

  // NOTHING HAS EVER RUN HERE. One honest line and out — no agent invoked and no
  // history entry, because there is no run to narrate and a model asked to narrate
  // nothing will invent something. idle and interrupted are NOT this case: a run that
  // has just finished, or one that was killed mid-task, is exactly what the history
  // file exists to remember.
  if (mode === 'never-run' || !record) {
    return {
      status: 'no-run',
      narrative: null,
      diagnostic: diagnostic('no run recorded here yet, so there is nothing to narrate'),
      root,
      mode,
      now: atMs,
    }
  }

  const taskNumber = record?.current?.number
  const logPath = inFlightLogPath(root, typeof taskNumber === 'number' ? taskNumber : null)

  // Two read-only git probes: what the tree looks like now, and what landed. Both at
  // the run's root, both allowed to answer with nothing — and both BOUNDED, out of the
  // same budget the agent call is bounded by. git blocks in the field (a contended
  // index.lock, a repo on a stalled network mount, a credential helper waiting on a
  // tty), and an unbounded probe in front of a bounded agent call would make the
  // command as a whole unbounded again. Concurrent because they are independent reads,
  // so the pair costs one budget rather than two.
  const gitBudget = budgetShare(timeout)
  const [gitStatus, gitLog] = await Promise.all([
    gitText(exec, root, ['status', '--short', '--branch'], gitBudget),
    gitText(exec, root, ['log', '--oneline', '-n', String(GIT_LOG_COMMITS)], gitBudget),
  ])

  const prompt = buildDigestPrompt(
    assembleDigestContext({
      record,
      mode,
      // The same document `ralph status --json` prints, from the same snapshot — so
      // the prose and the machine-readable view cannot describe different runs.
      snapshot: toJsonSnapshot(status.progress, { mode, record }),
      gitStatus,
      gitLog,
      logPath,
      logTail: logPath ? readTail(readFile, logPath) : '',
      now: atMs,
    }),
    { readTemplate, stderr },
  )

  const inv = buildDigestInvocation(env)
  const task = taskLabel(record)
  const base = { root, mode, prompt: prompt ?? null, model: inv.model, agent: inv.agent, task, now: atMs }

  // No template, no prompt, no request: asking a model to narrate a run with nothing
  // but the interpolated context missing would get prose about nothing.
  if (!prompt) {
    return failed(`could not read the prompt template (templates/${DIGEST_TEMPLATE})`, base)
  }

  let result
  try {
    const child = exec(inv.cli, inv.args, {
      cwd: root,
      // The prompt carries whole files, so it goes over stdin — never as argv, where
      // it would meet an OS argument-length limit and the shell's quoting rules.
      input: prompt,
      reject: false,
      timeout,
      env,
    })
    // The hard bound on OUR wait (see childDeadline). Normally execa's own timeout
    // resolves first and this never fires; it exists for the case where the child is
    // dead and its orphans still hold the pipe.
    result = await raceDeadline(child, childDeadline(timeout))
  } catch (e) {
    // execa with `reject: false` reports a failed spawn in its result, so reaching
    // here means something more unusual — a bad option, a stream error. Either way an
    // accessory swallows it.
    return failed(`could not run ${inv.cli} (${messageOf(e)})`, base)
  }

  const seconds = Math.round(timeout / 1000)
  if (result === HUNG) {
    return failed(`${inv.cli} timed out after ${seconds}s and would not let go of the pipe`, base)
  }
  if (result?.timedOut) {
    return failed(`${inv.cli} timed out after ${seconds}s`, base)
  }
  if (!result || result.exitCode !== 0) {
    const detail = oneLine(result?.stderr) || `exit ${result?.exitCode ?? 'unknown'}`
    return failed(`${inv.cli} failed (${detail})`, base)
  }

  const narrative = extractNarrative(result.stdout, inv.output)
  if (narrative === '') {
    // An empty answer is a failure, not an empty entry: a history file of blank
    // stamps is worse than a gap, because it reads as a run that had nothing to say.
    return failed(`${inv.cli} returned no text`, base)
  }

  // The append is the last thing, and its failure costs the entry but never the
  // narrative — the reader asked what the run is doing, and we know.
  let historyError = null
  try {
    const path = digestLogPath(root)
    mkdir(dirname(path), { recursive: true })
    // Appended verbatim: `formatHistoryEntry` owns the whole format, delimiters included,
    // so there is nothing for this call site to add and nothing for it to get wrong.
    // `inv.model` and not a second read of the environment (#63): the entry has to name
    // the model that actually answered, so it comes from the invocation that answered.
    appendFile(
      path,
      formatHistoryEntry({
        at: isoStamp(atMs),
        runId: record?.run_id,
        task,
        model: inv.model,
        narrative,
      }),
    )
  } catch (e) {
    historyError = diagnostic(`printed, but could not append to ${digestLogPath(root)} (${messageOf(e)})`)
  }

  return { ...base, status: 'ok', narrative, diagnostic: historyError }
}

// How long to wait on a child WE spawned, given the budget its own execa `timeout` was
// set from. ONE rule for every such wait — the agent call and both git probes — because
// they are the same two-step scheme and a second formula would be a second, undocumented
// bound: execa's `timeout` signals the child, then this allows a grace for that signal to
// land before we stop waiting and SIGKILL.
//
// The grace is KILL_GRACE_MS or the budget itself, whichever is SMALLER. Two reasons for
// the clamp. Waiting longer for a kill than you were ever willing to wait for the answer
// makes the grace, not the budget, the thing that decides how slow a digest can be — a
// caller asking for 20ms should not get 2s. And equal values would collapse the two
// bounds into one: the race would fire in the same tick as execa's SIGTERM, so the polite
// kill could never be what ended the child and every slow child would be a SIGKILL.
function childDeadline(budget) {
  return budget + Math.min(KILL_GRACE_MS, budget)
}

// Wait for `child`, but never longer than `ms` — and when the deadline wins, SIGKILL
// whatever is left and STOP WAITING, rather than staying attached to a pipe somebody
// else is holding open.
//
// Abandoning a promise is normally a smell; here it is the point. The child was
// already signalled by execa's own timeout, its answer is now worthless, and the only
// remaining question is whether the reader waits for it — the answer being no. The
// dangling result is explicitly swallowed so an injected `exec` that rejects cannot
// surface later as an unhandled rejection, and the timer is unref'd so a pending
// deadline can never be the reason `ralph digest` fails to exit.
async function raceDeadline(child, ms) {
  let timer = null
  try {
    const outcome = await Promise.race([
      child,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(HUNG), ms)
        timer?.unref?.()
      }),
    ])
    if (outcome === HUNG) {
      try {
        child?.kill?.('SIGKILL')
      } catch {
        // Already gone — which is the outcome we wanted anyway.
      }
      Promise.resolve(child).catch(() => {})
    }
    return outcome
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------

// One share of the injected budget, for each wait that happens before the agent call.
// Floored at 1ms on purpose: `setTimeout` treats 0 and negatives as 1ms anyway, so a
// zero or negative share would silently turn a bounded wait into an instant non-answer
// — and a caller passing a nonsense timeout should still get a probe that is TRIED.
function budgetShare(timeout) {
  return Math.max(1, Math.round(timeout / PROBE_BUDGET_SHARE))
}

function failed(reason, base = {}) {
  return { ...base, status: 'failed', narrative: null, diagnostic: diagnostic(reason) }
}

// Every line this file hands to stderr, in one shape: prefixed so it is attributable
// in a scrollback, collapsed to a single line, and capped — an agent's stderr can be
// a page of it.
function diagnostic(reason) {
  return `ralph digest: ${oneLine(reason) || 'unknown failure'}`
}

// `oneLine` is IMPORTED here and NOT re-exported (#108 moved the body to lib/one-line.js). The
// first draft of that move did re-export it, so callers would not have to change a line — and
// that was the wrong trade: it would have left a permanent second import path routing a
// deliberately dependency-free helper back out through the one module the extraction existed to
// escape, which is #108's own trap in reduced form. Everyone who wants the flattener asks
// lib/one-line.js directly now (`lib/commands/start.js`, `lib/commands/digest.js`), and this
// module imports it for the same reason they do: there is exactly ONE flattener, which is the
// whole contract of a shape a reader greps or a launchd log collects.

function messageOf(e) {
  return oneLine(e?.message) || 'unknown error'
}

// `#031`, the same three-digit form the status view pads to, so a digest heading
// lines up with the view a reader just came from. `none` when no task is in flight.
//
// A JIRA KEY WINS OVER THE NUMBER (#127), for the reason the status views do it and one
// that is specific to this file: under `TASK_SOURCE=jira` the number was DERIVED from
// the key (`FOO-123` → 123), and this value is interpolated into the prompt a model
// narrates from — so `#123` would not just misname a row, it would teach the narration
// an identifier nobody can look up, in prose that reaches a reader by WhatsApp. Same
// scrub (`taskKeyOf`) as the views, imported from the module that owns it rather than
// re-derived, per #108's lesson two comments up.
function taskLabel(record) {
  const key = taskKeyOf(record?.current)
  if (key !== null) return key
  const number = record?.current?.number
  if (typeof number !== 'number' || !Number.isFinite(number)) return 'none'
  return `#${padTaskNumber(number)}`
}

// Read a log's tail and never care whether it was there: a task that has only just
// started has no log yet, and that is not a failure of anything.
function readTail(readFile, path) {
  try {
    return boundedTail(readFile(path, 'utf8')?.toString() ?? '')
  } catch {
    return ''
  }
}

// One read-only git probe at the run's root, bounded twice over like the agent call and
// by the same rule — see childDeadline, which both call sites go through. `reject: false`
// AND a try/catch, because git may be absent entirely.
//
// EVERY failure — missing git, non-zero exit, a probe that will not answer — is the
// same answer here: no git state to report. The digest still narrates the run from the
// record, the snapshot and the log tail; a slow repo costs context, never the digest.
async function gitText(exec, root, args, timeout) {
  try {
    const child = exec('git', args, { cwd: root, reject: false, timeout })
    const result = await raceDeadline(child, childDeadline(timeout))
    return result !== HUNG && result?.exitCode === 0 ? String(result.stdout ?? '') : ''
  } catch {
    return ''
  }
}

// ISO to the second, UTC: a history file is grepped and diffed, so it wants an
// unambiguous instant, and a digest has no business claiming milliseconds. A clock
// outside the calendar reads as `unknown` rather than throwing a RangeError out of an
// accessory.
function isoStamp(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'unknown'
  try {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  } catch {
    return 'unknown'
  }
}

function heading(text) {
  const opened = `${HEADING_PREFIX}${text} `
  return opened + '─'.repeat(Math.max(3, HEADING_WIDTH - opened.length))
}
