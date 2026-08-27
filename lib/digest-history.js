// #63 — the digest, READ BACK. `ralph status` shows the latest narration for the run
// in flight, with its age and the model that wrote it, so the reader gets the numbers
// and the sentence that explains them in one view instead of two commands.
//
// PURE, and deliberately not part of lib/digest.js: that module spawns an agent,
// appends to a file and owns a 90-second budget, and the READER must be incapable of
// any of it. Everything here takes text and returns data — no fs, no exec, no ambient
// clock (`now` is a parameter), no config path (the interval arrives as the raw value
// the config held). A read-only view is only as read-only as the modules it calls.
//
// THE READER IS SEPARATE FROM THE WRITER, and the agreement between them is held two
// ways. By CONSTRUCTION: the entry format's literals come from lib/digest-file.js, which
// lib/digest.js writes with and this module reads with, so neither side can be changed
// alone — and that module is pure, so importing the grammar costs a status view nothing
// (reaching into the writer for it would have dragged execa and the digest engine into a
// command people run from a shell prompt, and closed a cycle round it). And by TEST:
// every fixture in lib/digest-history.test.js that stands for a history file is produced
// by `formatHistoryEntry` itself, so the day the format changes in a way a shared
// constant cannot catch, the suite fails HERE instead of this parser quietly answering
// `null` in the field.
//
// NOTHING HERE THROWS and nothing here is ever "an error": a history file is somebody
// else's bytes — model output, a crashed append, a file a human edited — and every
// unreadable shape degrades to `null`, which the view renders as no section at all.
// AC#3 and AC#5 fall out of that single rule rather than out of a branch per case.

import { belongsToRun, finiteOrNull, formatElapsed } from './progress.js'
// The entry format — `\n── {at} · run {id} · {task} · {model} ───…\n`, then every
// narrative line at ENTRY_INDENT, then a blank line — and the writer's words for a field
// it had nothing to put in. Shared with lib/digest.js, which writes them.
//
// The absence words are read back as ABSENCE and never as data: a record too broken to
// name its run writes `run unknown`, and taking that as a run id would let a run with no
// id match an entry with no id — the exact cross-run confusion `belongsToRun` prevents.
import {
  ABSENT_MODEL,
  ABSENT_RUN,
  ABSENT_TASK,
  ENTRY_INDENT,
  FIELD_SEPARATOR,
  HEADING_PREFIX,
} from './digest-file.js'
import { parseTimerDuration } from './duration.js'

// One heading line, with the fields as the capture. Built from the shared prefix rather
// than typed out, so the two sides cannot drift; the trailing `─` padding is matched by
// anchoring on the END of the line, which is what lets this parser stay ignorant of the
// width the writer padded to. See headingFields.
const HEADING_LINE = new RegExp(`^${HEADING_PREFIX}(.*?)\\s─+$`)

// How many intervals late a digest has to be before the view stops presenting it as
// current. TWO, not one: a digest lands when its timer fires and the agent answers, so
// a single interval is routinely missed by a few seconds and warning about that would
// train the reader to ignore the marker. Two intervals means the timer skipped one —
// a dead digest window, an agent that stopped answering — which is worth saying.
const STALE_INTERVALS = 2

// ...and what to measure against when the interval is unknown: absent from
// ralph.config.sh, turned off, or a value the grammar refuses. 30 minutes is the
// interval templates/ralph.config.sh suggests, so the assumption is the one the reader
// most likely configured, and the ceiling it produces (60 minutes) is comfortably
// longer than the 40-100 minutes a task takes. A digest cannot be measured against no
// interval at all, and treating "not configured" as "never stale" would present a
// narration from six hours ago as the current state of the run.
const DEFAULT_INTERVAL_SECONDS = 1800

// The section is two spaces in, like every row of the live view, and its heading is
// padded to the same 64 columns lib/digest.js pads its own headings to — so the block
// reads as part of the same view and the same file's history.
const SECTION_INDENT = '  '
const SECTION_WIDTH = 64
const BODY_WIDTH = SECTION_WIDTH - SECTION_INDENT.length

// A bound on the block, because the narrative is MODEL OUTPUT and templates/digest.md
// asking for two short paragraphs is a request, not a guarantee. The view's whole
// purpose is that the attach/kill pair below it is one glance away; a model that
// answered with fifty lines would push it off the screen. Eight lines is the two
// paragraphs the template asks for, and the ninth line says there is more — and says
// WHERE, like the `logs  tail -f …` row above it, because a reader told that something
// is hidden and not told where to find it has been given a problem rather than an
// answer. The whole narration is in the file, unwrapped and unscrubbed.
const MAX_BODY_LINES = 8
const MORE_MARKER = '… full narration in .ralph/digest.log'

// What a shortened model id ends in. See elide.
const ELLIPSIS = '…'

// THIS SECTION IS A TRUST BOUNDARY, and it is the first one `ralph status` has ever
// had. Every other row of that view is a number this repo computed, an id it generated
// or one of its own words; the narrative — and the model name beside it — come out of
// `.ralph/digest.log`, which is MODEL OUTPUT appended to a file a human can edit. So
// the bytes on their way to a terminal are scrubbed of everything a terminal ACTS on
// rather than shows: a narrative opening `ESC[2J ESC[H` would erase the reader's
// screen and take the attach/kill pair with it, `ESC]0;…BEL` would retitle their
// window, and a NUL truncates the line on some terminals. C0, DEL and C1 all go.
//
// `\n` is the one exception, because it is structure here rather than content:
// bodyLines splits paragraphs on it. Everything else — `\t`, `\r`, VT, FF — becomes a
// SPACE rather than nothing, so a scrubbed sequence cannot fuse the words on either
// side of it into one; the wrapper then collapses the run like any other whitespace.
//
// `--json` is DELIBERATELY NOT scrubbed and that asymmetry is the point: JSON.stringify
// escapes every code unit below 0x20, so the wire is safe by construction, and a machine
// consumer re-rendering the narration in its own surface should receive what the model
// actually wrote rather than our cleaned-up reading of it. The danger is the terminal,
// so the defence lives in the terminal renderer.
const CONTROL_BYTES = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f]', 'g')

// The shortest padding a heading is allowed to end in — the floor `heading` clamps at,
// and therefore the columns the LABEL may not spend.
const MIN_HEADING_PAD = 3

// `digest (…)`: the fixed part of the heading, so the label's budget can be derived
// from the width rather than counted by hand.
const SECTION_TITLE = 'digest'

// The columns available to the parenthesised label, once the heading's opener, its
// closing space, its minimum padding and `digest ()` are paid for. The label is the
// only elastic part of the line, and a model id is the only elastic part of the label
// — `RALPH_DIGEST_MODEL` is documented free text and a Bedrock or Vertex id runs to
// forty-odd characters — so this is the number the elision measures against, and the
// reason the heading stays inside its box for every combination of age and staleness.
const LABEL_WIDTH =
  BODY_WIDTH - HEADING_PREFIX.length - 1 - MIN_HEADING_PAD - `${SECTION_TITLE} ()`.length

// The LAST well-formed entry in a history file, or `null`. Scanned BACKWARDS from the
// end, one heading at a time, and that is not just an optimisation: a digest
// interrupted between its heading and its body leaves a torn entry at the end of the
// file, and the entry before it is a real narration whose age the view can state
// honestly. Stopping at the torn one would hide a digest that exists; inventing an
// empty narrative for it would print a heading with nothing under it.
export function parseLatestDigest(text) {
  const lines = String(text ?? '').split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith(HEADING_PREFIX)) continue
    const entry = readEntry(lines, i)
    if (entry) return entry
  }
  return null
}

// One entry, given the line its heading is on. `null` for anything this parser cannot
// stand behind — an unreadable timestamp, a heading missing its run field, a body that
// is not there — because the caller's next question is "how long ago", and a digest
// that cannot say when it was written cannot answer it.
function readEntry(lines, at) {
  const fields = headingFields(lines[at])
  if (!fields) return null

  // The instant is the one field with no honest unknown: `12min ago` IS the news. A
  // stamp `Date.parse` cannot read (`yesterday`, a truncated write, an empty field)
  // makes the whole entry unusable rather than a digest of unknown age.
  const atMs = finiteOrNull(Date.parse(fields.at))
  if (atMs == null) return null

  // The body is every following line carrying the entry indent. The indent is what
  // makes this unambiguous: the writer indents EVERY narrative line, blank ones
  // included, so the first unindented line — the blank line that ends the entry, the
  // next heading, or something a human left behind — ends the body, and a narrative
  // line beginning `── ` cannot forge a heading of its own.
  const body = []
  for (let i = at + 1; i < lines.length; i += 1) {
    if (!lines[i].startsWith(ENTRY_INDENT)) break
    body.push(lines[i].slice(ENTRY_INDENT.length))
  }
  const narrative = body.join('\n').replace(/\s+$/, '')
  // A heading with no prose under it is a digest caught mid-append (runDigest refuses
  // to record an empty narrative), so it is not an entry yet.
  if (narrative === '') return null

  return {
    at: fields.at,
    atMs,
    runId: fields.runId,
    task: fields.task,
    model: fields.model,
    narrative,
  }
}

// The heading line's four fields. THREE are required (an entry written before #63 has
// no model, and it is still that run's history — the model is what is missing, not the
// digest), and the model is the remainder, because it is written last and a model name
// is a string this file does not control.
//
// The trailing `─` padding is stripped by anchoring on the END of the line: the pad is
// the only run of dashes that reaches it, so a field carrying dashes of its own cannot
// be mistaken for the pad.
function headingFields(line) {
  const match = line.match(HEADING_LINE)
  if (!match) return null
  const fields = match[1].split(FIELD_SEPARATOR)
  if (fields.length < 3) return null
  const run = fields[1].match(/^run (.*)$/)
  if (!run) return null
  return {
    at: String(fields[0] ?? '').trim(),
    runId: valueOrNull(run[1], ABSENT_RUN),
    task: valueOrNull(fields[2], ABSENT_TASK),
    model:
      fields.length > 3 ? valueOrNull(fields.slice(3).join(FIELD_SEPARATOR), ABSENT_MODEL) : null,
  }
}

// A field, or `null` when it is empty or holds the writer's word for absence.
function valueOrNull(raw, absentWord) {
  const value = String(raw ?? '').trim()
  return value === '' || value === absentWord ? null : value
}

// THE VIEW: this run's latest digest, how old it is, and whether it is late. `null`
// when there is nothing to show, so the renderer has no case of its own for absence.
//
// `interval` is the RAW value out of ralph.config.sh (see digestInterval in
// lib/digest-file.js), not a number: the reading of that knob is one rule shared by the
// three commands that care, and converting it here keeps the staleness policy —
// which interval, how many of them — in one place with the rest of the policy.
export function buildDigestView({ historyText, record, now, interval } = {}) {
  const entry = parseLatestDigest(historyText)
  if (!entry) return null

  // SCOPED TO THIS RUN, by the same rule every other per-run number in this codebase
  // is scoped by: `.ralph/digest.log` is appended forever, so last night's narration
  // is still the first thing in it, and describing a finished run's work as the
  // current state is worse than saying nothing. An absent id on EITHER side matches
  // nothing rather than everything.
  if (!belongsToRun({ run_id: entry.runId }, record?.run_id)) return null

  // Clamped at zero, like formatElapsed: two clocks (a record written on another
  // machine, a system clock stepped by NTP) can put an entry in the future, and
  // `-3min ago` is a bug report about Ralph rather than news about the run.
  const nowMs = finiteOrNull(now)
  const ageMs = nowMs == null ? null : Math.max(0, nowMs - entry.atMs)

  return {
    atMs: entry.atMs,
    // Degrade the LEAF, not the section: with no readable clock the digest is still
    // worth printing, and the age reads `unknown` — the word the rest of this view
    // already uses — instead of the section vanishing over our own failure.
    ageMs,
    model: entry.model,
    task: entry.task,
    // ...and with no age there is no judgement to make: an unknown age is not late.
    stale: ageMs != null && ageMs > staleAfterMs(interval),
    // The RAW narrative. Wrapping is the terminal's business (renderDigestSection),
    // and `--json` publishes this text unwrapped.
    narrative: entry.narrative,
  }
}

// How old a digest may be before the view says so.
function staleAfterMs(interval) {
  return STALE_INTERVALS * intervalSeconds(interval) * 1000
}

// The configured interval in seconds, or the default. parseTimerDuration is the
// grammar `ralph start` and `ralph digest --loop` validate with, so an interval this
// view measures against is one the digest could actually have run on; everything it
// refuses — absent, blank, any spelling of zero, longer than a timer can wait — lands
// on the documented default rather than on a number nobody chose.
//
// AN OFF INTERVAL IS NOT AN ABSENT DIGEST, and this is the seam where that will look
// like a bug. `RALPH_DIGEST_INTERVAL=""` turns the LOOP off — it does not mean no
// narration exists, because `ralph digest` is a documented one-shot a reader can run by
// hand at any moment. So a digest that is on disk and belongs to this run is shown even
// when nothing was configured to produce it: AC#3's "digest disabled or never run" is
// about there being NO ENTRY, which is the case this module already answers `null` to in
// parseLatestDigest. Refusing to render an entry because of a config value would hide a
// narration the reader deliberately asked for. All the interval decides is the ruler
// staleness is measured with, and an unconfigured ruler is this default.
function intervalSeconds(interval) {
  try {
    return parseTimerDuration(interval)
  } catch {
    return DEFAULT_INTERVAL_SECONDS
  }
}

// The section, as lines: its own leading blank line, one heading, then the narrative.
// `[]` for no view, so the live view spreads it unconditionally and a repo with the
// digest off gets a byte-identical `ralph status` (AC#3).
//
// SELF-DELIMITING, on the same principle as formatHistoryEntry: the blank line that
// separates this block from the rows above it belongs to the block, so the caller
// cannot render the section and forget the gap — or leave a stray blank line behind
// when there is no section at all.
export function renderDigestSection(view) {
  if (!view) return []
  return [
    '',
    SECTION_INDENT + heading(`${SECTION_TITLE} (${headingLabel(view)})`),
    ...bodyLines(view.narrative),
  ]
}

// `12min ago · claude-haiku-4-5 · stale` — every clause that has something to say, and
// none that does not. The MODEL clause is dropped entirely when the entry never named
// one (a pre-#63 history file): `· unknown` in a heading reads as a fact about the
// model rather than about our own records. The age is never dropped, because a digest
// with no age is precisely what the reader must not mistake for a current one.
//
// The age and the staleness are OURS and their widths are known; the model is the
// caller's and its width is not, so it is the clause that gives way. It is measured
// against whatever the other two leave of LABEL_WIDTH — never the other way round,
// because a truncated age or a missing `stale` would be a lie, while a truncated model
// name is merely less specific.
function headingLabel({ ageMs, model, stale }) {
  const age = `${formatElapsed(ageMs)} ago`
  const staleness = stale ? 'stale' : null
  const ours = [age, staleness].filter(Boolean)
  const room = LABEL_WIDTH - ours.join(FIELD_SEPARATOR).length - FIELD_SEPARATOR.length
  // `named || null` rather than a branch on the empty string: an unnameable model drops
  // out of the same filter that already drops an absent `stale`, so there is one rule for
  // "a clause with nothing in it does not appear" instead of two.
  return [age, elide(headingField(model), room) || null, staleness]
    .filter(Boolean)
    .join(FIELD_SEPARATOR)
}

// Text that has to share a line with our own: control bytes gone (see CONTROL_BYTES)
// and every run of whitespace collapsed, because a heading is one line by definition
// and a scrubbed escape sequence leaves spaces behind.
function headingField(value) {
  return printable(value).replace(/\s+/g, ' ').trim()
}

// `text`, or as much of it as fits in `room`, with the ellipsis paid for INSIDE the
// budget rather than added to it. `''` when there is no room to shorten into at all —
// which is arithmetic, not policy: a negative `room` would make the `slice` below cut
// from the END and hand back something LONGER than the budget, reintroducing the
// overrunning heading this whole calculation exists to prevent. Unreachable as the
// widths stand (the age clause is at most ~29 columns, so `room` bottoms out in the
// single digits), and it stays because the failure it would cause is silent.
function elide(text, room) {
  if (text === '' || room < ELLIPSIS.length + 1) return ''
  if (text.length <= room) return text
  return text.slice(0, room - ELLIPSIS.length) + ELLIPSIS
}

// The narrative as indented, wrapped, bounded, PRINTABLE lines.
//
// BLANK LINES ARE DROPPED, and that is a layout decision: the narrative's paragraph
// break would put an empty line inside a block whose surroundings use empty lines as
// separators, so the section would read as having ended halfway through. The lines
// still break where the paragraphs do.
//
// A FORGED SECTION HEADING IS ACCEPTED, on the record: the body indent equals the
// heading indent, so prose that writes `── digest (0min ago · evil · stale) ───` gets a
// row that looks exactly like ours one line below the real one. Not neutralised, for
// two reasons — the whole block is already attributed to the digest, so a second
// heading inside it spoofs nothing a reader would act on differently; and `── ` is
// legitimate prose in this repo, where a narration about status.js or digest.js may
// quote the very banner it is describing. Scrubbing it would cost real narration to buy
// nothing. Pinned as a characterisation test in lib/digest-history.qa.test.js. The
// PARSE side is a different matter and is unforgeable — see readEntry.
function bodyLines(narrative) {
  const lines = []
  for (const paragraph of printable(narrative).split('\n')) {
    for (const line of wrap(paragraph.trim())) lines.push(SECTION_INDENT + line)
  }
  if (lines.length <= MAX_BODY_LINES) return lines
  return [...lines.slice(0, MAX_BODY_LINES), SECTION_INDENT + MORE_MARKER]
}

// Word wrap at the body width.
function wrap(text) {
  const lines = []
  let line = ''
  for (const word of breakLongWords(text)) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= BODY_WIDTH) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

// The words of one paragraph, with any word too long for a line of its OWN broken at
// the width. Ordinary prose never reaches the break — a path, a symbol name or a URL a
// reader might copy whole is only broken if it cannot fit on any line, where the choice
// is not "break or keep" but "break or overflow".
//
// And overflowing was not free: MAX_BODY_LINES bounds ARRAY ELEMENTS, so one
// 5000-character token — a base64 blob, a minified stack, a URL a model pasted, which
// is what a TDD log tail is full of — used to be one element occupying eighty terminal
// rows, pushing the attach/kill pair the cap exists to protect off the screen. Breaking
// here is what makes the cap a bound in the dimension it was written for.
function breakLongWords(text) {
  const words = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length <= BODY_WIDTH) words.push(word)
    else for (let i = 0; i < word.length; i += BODY_WIDTH) words.push(word.slice(i, i + BODY_WIDTH))
  }
  return words
}

// Somebody else's text, safe to hand a terminal: see CONTROL_BYTES for what goes and
// why `\n` stays.
function printable(text) {
  return String(text ?? '').replace(CONTROL_BYTES, ' ')
}

// The same padded-heading idiom lib/digest.js uses, at this view's width: the label,
// then `─` to the column where every other heading ends.
function heading(text) {
  const opened = `${HEADING_PREFIX}${text} `
  return opened + '─'.repeat(Math.max(MIN_HEADING_PAD, BODY_WIDTH - opened.length))
}
