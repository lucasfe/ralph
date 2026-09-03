// #122 — the identity box's ROWS: resolved facts in, `{ label, value, paint }` records out.
//
// This is one half of what lib/banner-compose.js used to be. That module answered two questions
// in one file — WHICH SENTENCE a fact earns, and HOW that sentence survives a 30-column terminal
// — and the second one had grown into a small machine of its own: a width ladder, two line
// forms, a code-point clip, a paint-offset pass. Nine hundred lines in which a reader looking for
// the wording of the agent row had to walk past `Math.max(0, boxWidth - 4)` to find it, and in
// which a spec about the wording could only be written by composing a box and slicing the
// borders back off.
//
// SO THE SEAM IS "TEXT" VERSUS "COLUMNS", and it runs one way. Everything here is pure text: not
// one column count, not one `padEnd`, no idea whether a frame will be drawn around what it
// returns — banner-rows.test.js asserts that as a property of this file's source, because it is
// a claim about the text rather than about any rendered line (#119). lib/banner-compose.js
// imports this module and turns the list into terminal lines; this module cannot see it. A
// cycle between the two would not fail loudly under ESM, so banner-rows.qa.test.js pins the
// direction too.
//
// THE ORDER OF THE LIST IS THIS MODULE'S DECISION, and it is the one property no per-row spec can
// see: `bannerRows` is the whole ordered box, so a builder that stopped being called or moved
// above the one it used to sit under is a red test rather than something a reader notices in a
// screenshot. WHAT each row says is the builders' decision, below it.
//
// THE PALETTE CAME ACROSS WHOLE, and deliberately: a row NAMES ITS OWN COLOUR (#75) — `paint`
// carries an opener rather than `true` — so the two openers and the one reset they share are one
// decision, and splitting them across the seam would leave half of #75's argument in each file.
// lib/banner-compose.js's `render` imports the reset from here and is still the only place an
// escape byte is written.
//
// PURE, and asserted so by a static read in banner-rows.test.js: no process, no clock, no fs, no
// randomness, and picocolors in particular — it decides colour ONCE AT IMPORT from the real
// `process.env` that no injected bag can reach, so importing it would hand this module an
// ambient capability behind the `capabilities` argument's back.
//
// ONE IMPORT, and it is a rule rather than a helper: the newer-than question is answered by the
// very two functions that decide whether `ralph start` prints its step-2.5 update notice
// (#21/#24). A second semver comparison here is how the box and the notice would come to
// disagree about what "newer" means — the box hinting at an update the notice does not offer, in
// the same screenful of output. It came across the seam with the two rows that ask it.
import { compareSemver, isValidSemver } from './update-check.js'

// The one thing in this box that is advice rather than fact, in the one colour this
// package already uses for it: `\u001B[33m`/`\u001B[39m` are the bytes picocolors
// emits for `yellow`, which is what lib/update-gate.js wraps the step-2.5 notice in.
// Spelled out rather than imported, for two reasons: picocolors decides ONCE AT IMPORT
// whether colour is allowed, from the real `process.env` that no injected bag can
// reach — so importing it here would hand this module an ambient capability behind
// this file's back — and it would make the escapes below a fact about the developer's
// shell instead of a fact about the `capabilities` argument lib/banner-compose.js reads.
//
// #75 ADDS THE SECOND COLOUR, and it is a second colour rather than a second meaning:
// `\u001B[32m` is picocolors' `green`, which is what #27's version line already wrapped
// "up to date" in — so the verdict a `ralph doctor` reader learned to skim for keeps the
// colour it always had. ONE RESET for both, because both of them reset with `39`: naming it
// COLOR_OFF rather than YELLOW_OFF is the whole of that rename, and it is worth the churn
// so that nobody adds a third colour and a third off-code that is the same byte.
//
// A ROW NAMES ITS OWN COLOUR from here on — `paint` carries one of these strings rather
// than `true` — because the box now has two kinds of painted row and `render` is the wrong
// place to ask which kind it is holding. #122 is why COLOR_OFF is exported and the two
// openers are not: the reset is the only one of the three the FRAME half spends, in the one
// function that splices escapes into a line. The openers travel on the rows.
const YELLOW = '\u001B[33m'
const GREEN = '\u001B[32m'
export const COLOR_OFF = '\u001B[39m'

// Every code point a terminal reads as an INSTRUCTION rather than as text, and what
// each one is replaced by. C0 (U+0000-U+001F) is where the three that matter live: LF
// and CR, which end a line — and a returned string containing one is TWO terminal rows,
// the second composed by nobody and covered by no width guarantee, with CR's tail
// redrawing over the box's own frame — and ESC, which starts a sequence that can repaint
// the screen, retitle the window, or (cut in half by the clip) swallow the frame bytes
// after it as parameters to a sequence that never ends. U+007F-U+009F adds DEL and the
// C1 block, whose U+009B is a single-byte CSI introducer: the same attack without an ESC.
//
// REPLACED, not stripped, and the choice is the same one lib/progress.js argues for
// facts in general: `/a\nb` stripped reads as `/ab`, a directory that does not exist, so
// the box would be lying about where it is running. A placeholder says "there is a
// character here you cannot see", which is the truth. U+FFFD because that is precisely
// what it means and because it is not a character a path is likely to contain — and one
// code point in for one code point out, so the frame half's width accounting stays exact
// without a second pass.
//
// NOT bidi controls (U+202E and friends), deliberately: those reorder text that a
// terminal is otherwise printing normally, which is the same class of problem as an
// East Asian glyph occupying two cells — see `visibleWidth` in lib/banner-compose.js.
// Replacing them would also mangle a legitimate path containing a ZWJ emoji sequence, and
// this box would be misreporting a real directory to defend against a rewritten one.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu
const PLACEHOLDER = '\uFFFD'

// #70's section, in the constants it is made of.
//
// THREE BULLETS: enough to say what a release was about, few enough that the box stays a
// box under a narrow sprite. The rest are not truncated away, they are simply not
// shown — which is what the pointer is for. `ralph changelog` is #71's command and is
// named here on the day this ships, because a teaser with no verb is a dead end.
//
// The bullet glyph is U+2022, which goes wherever the frame's U+256D goes — including
// into the bare form the frame half degrades to, since the bullet is part of what the row
// SAYS and the frame is not. It is a PREFIX applied to a fact, so the builder below applies
// it AFTER the gate — see `whatsNewRows`.
const WHATS_NEW_LIMIT = 3
const WHATS_NEW_LABEL = 'new'
const BULLET_GLYPH = '•'
// The pointer's own row, labelled like every other row rather than tucked under the last
// bullet: a reader scanning the label column finds it, and it survives the frame half's clip
// on a narrow terminal as a line of its own instead of as the tail of a bullet. Worded like
// the update hint above it (`… — run \`ralph update\``) because they are the same kind of
// sentence: a fact, then the verb that acts on it.
const MORE_LABEL = 'more'
const WHATS_NEW_POINTER = 'run `ralph changelog` for the rest'

// What a fact we were not given reads as. The same word `ralph start` already uses
// for a version it could not read out of package.json ("starting Ralph on unknown"),
// and the same discipline lib/progress.js states at length: name what is missing,
// never invent it and never print a plausible-looking stand-in.
//
// EXPORTED because it is the fallback the frame half passes to `textOr` for the two things it
// gates itself — the title's version and a row's scalar value (see `titleLine` and `rowLine`).
// One word for "we do not have this", on both sides of the seam.
export const UNKNOWN = 'unknown'

// #75's section, in the constants it is made of.
//
// THE DIAGNOSTIC ROWS: what `ralph doctor` used to print in two lines of its own — a
// `platform: … — agent: …` header and #27's `version: … — cached latest: …` verdict —
// folded into this box so that ONE paste into a bug report carries all of it. They are
// LINES, not parameters, exactly as the composition module's header promised, and every one of
// them is still gated on a fact `ralph start` does not pass: `os` and `cachedLatest` are
// DOCTOR's questions, so its box is what they draw on and start's is unchanged by them, which
// banner-rows.test.js pins as a literal. (Until #69 that gate was also the whole reason
// start's box was byte-identical to #74's. It is not any more — start now asks questions of
// its own and draws rows for them — so what the gate buys today is the other direction:
// every row added for one command leaves the other two boxes exactly where they were.)
//
// `os` RATHER THAN `platform`, and the reason is arithmetic rather than taste: the frame half's
// label gutter is eight columns and `padEnd` does not grow, so `platform` would print
// `platformmac` with no air at all. Widening that gutter would re-flow every row of `ralph
// start`'s box for the sake of one word, so the word gives way instead — and `os` is what
// `lib/platform.js` actually answers ('mac', 'linux'), which was never a platform TRIPLE.
//
// DECLARED AS A TABLE so `factRows` stays one gate rather than one gate per fact, and #76's
// `ralph status` rows are an entry here rather than a new branch. The `from` key names the
// fact; the `label` is a literal in this file, as every label in this box is.
//
// #69 TOOK `agent` OUT of this table, and the table is what stayed behind: the agent row is
// no longer a lone fact but a SENTENCE built from three of them (see `agentRows`), and a
// table entry cannot say "…unless a provenance came with it". What doctor passes still prints
// exactly what it printed — that is the first thing `agentRows` decides — so the row moved
// builders without moving a column.
const DIAGNOSTIC_ROWS = [{ label: 'os', from: 'os' }]

// #69's other two rows, and they are a SECOND table read by the same gate rather than two
// pushes in the assembler: `source` and `repo` are plain facts, exactly the shape
// DIAGNOSTIC_ROWS is for, and the only thing that separates them from `os` is WHERE they sit
// — under `cwd`, because all three answer "where is this running" and the two that #69 adds
// are the ones a reader checks when the same loop runs in several checkouts.
//
// `repo` IS ONLY EVER DRAWN IN GITHUB MODE, and that is the caller's decision rather than a
// branch here: `ralph start` passes the slug only when the task source is github (there is no
// repository a folder run reads issues from), and an unresolvable slug is passed as nothing at
// all. The gate below turns both into no row.
const RUN_ROWS = [
  { label: 'source', from: 'source' },
  { label: 'repo', from: 'repo' },
]

// #201's row, and a THIRD table read by the same gate — for the same reason RUN_ROWS is the
// second one: `channel` is a plain fact, exactly the shape DIAGNOSTIC_ROWS is for, and all
// that separates it from `os` is where it sits. It goes directly under `cached`, because the
// two are one thought: npm and the Homebrew tap hold different versions on purpose (#196), so
// "0.18.0 available" means nothing until a reader knows WHICH channel answered. `cached`
// without `channel` is a number a reader cannot place.
//
// SEVEN COLUMNS, which is the widest a label in this box can be — the gutter is eight and
// lib/banner-compose.js needs one for the space. It fits, and banner-rows.test.js measures
// every label in this file against LABEL_WIDTH rather than trusting that sentence.
//
// The WORDING of the value is not decided here, and deliberately so: it comes from
// lib/install-markers.js, where the words live on the same table row as the path marker that
// earned them, so a marker and the channel it is reported as cannot drift. This file's job is
// where the row goes.
//
// `ralph start` and `ralph status` pass no `channel`, so the gate below takes not one line
// from their boxes. Only `ralph doctor` asks — it is the command whose output ends up pasted
// into a bug report, which is the whole reason the fact is worth a row.
const RELEASE_ROWS = [{ label: 'channel', from: 'channel' }]

// #69's own two labels. `agent` is the one row in this box built from more than one fact and
// `context` is the one numeric row, so neither is a table entry — but both are labelled the
// way every other row is, with a literal in this file.
const AGENT_LABEL = 'agent'
const CONTEXT_LABEL = 'context'

// The three kinds of evidence the box can have about a model, and the sentence each one
// earns. lib/banner-model.js resolves the tag; this decides the words.
//
// PROVENANCE DRIVES THE WORDING, and it is a correctness requirement rather than a cosmetic
// one. The Claude model cannot be known at launch, so what this box has is the model the LAST
// run used — and a row that presented it as a promise about THIS run would state a fact it
// does not have. So `last run` is said out loud, `configured` names the knob it came from,
// and no evidence at all says exactly that and names no model.
//
// SPELLED HERE, NOT IMPORTED, and the same argument this file's header makes about its import
// list: it is one line long and the reason is written at the top. banner-rows.test.js holds the
// two together instead — it enumerates MODEL_PROVENANCE and demands a DISTINCT sentence for
// every tag in it, so a fourth tag added there with no wording here fails a test rather than
// printing a row nobody wrote.
//
// A MAP rather than an object literal, deliberately: the tag arrives as a caller's string and
// `{}['constructor']` is a function, so a plain object would answer for keys nobody put in it.
//
// ALL THREE TAGS ARE KEYS, including the one whose sentence names no model: `unknown` maps to
// NO SUFFIX, which is a wording decision written down rather than a branch somewhere else. That
// makes this table the complete vocabulary it claims to be, and makes the drift guard next door
// structural — a fourth tag is a MISSING KEY here, not a value that quietly falls through the
// same path an unrecognized string takes.
const MODEL_SUFFIX = new Map([
  ['last-run', 'last run'],
  ['configured', 'configured'],
  ['unknown', null],
])

// What the row says when there is no model to name: it names the AGENT — the one thing the
// box always knows — and states plainly that the rest is decided by the run itself. Worded as
// a fact about the future rather than as a failure ("unknown model" would read as a detection
// bug in Ralph), because on every fresh checkout this is simply the truth.
const MODEL_UNKNOWN = 'model resolves at first run'

// The context window's unit, and the two scales it is written at. Exact rather than pretty: a
// window a reader cannot match against the RALPH_CONTEXT_WINDOW they set is a number that
// helps nobody, so only an exactly divisible value is abbreviated and everything else prints
// as itself. `tokens` is the unit the telemetry, the statusline and the config all use.
const TOKENS = 'tokens'
const MILLION = 1_000_000
const THOUSAND = 1_000

// #27's verdict, and its label. `cached` is the wording that survived the move, deliberately:
// doctor REPORTS what the last check found, it does not check — the version query and the
// throttle belong to `ralph start` (#24) — and a row labelled `latest` would promise a
// freshness this box cannot deliver. Six columns, so it clears the gutter with air to spare.
const CACHED_LABEL = 'cached'

// ...and what the row says when the cache had no answer. It names THE QUESTION that went
// unanswered rather than leaving a bare `unknown` beside a version number, because in a
// pasted bug report `cached  unknown` reads as "the version is unknown" — which is a
// different, and much more alarming, sentence than "nobody has checked yet". Worded exactly
// as #27's line worded it, so a user grepping their old paste finds the same string.
const NO_CACHED_ANSWER = `${UNKNOWN} (no update check cached yet)`

// ONE SENTENCE FOR "THERE IS A NEWER ONE", and it is the sentence #68 already shipped.
//
// Two rows in this box now say it — `update`, which `ralph start` draws off `latestVersion`,
// and `cached`, which `ralph doctor` draws off `cachedLatest` — and they say it with the same
// words, out of the same builder, because the alternative is a box that phrases one fact two
// ways in one screenful.
//
// #27's version line said `update available (run npm i -g @lucasfe/ralph)`, and BOTH halves of
// that changed here. The verb changed because it does not fit: at the box's design width a value
// has 48 columns, and `0.18.0 — update available (run npm i -g @lucasfe/ralph)` is 55 — it would
// clip to `…(run npm i -g @lucasfe/ral…`, a hint a user cannot follow. `ralph update` is Ralph's
// own verb for the same act and it is what the `update` row has told `ralph start` users since
// #68. The PHRASING changed for the same arithmetic: `update available (run \`ralph update\`)`
// is 37 columns of it, which a 13-character prerelease ('0.23.0-beta.1') pushes to 53 and the
// clip then eats the verb anyway. `X available — run \`ralph update\`` is 44 at that same
// version, says the identical thing, and is already on screen everywhere else.
const UPDATE_VERB = 'run `ralph update`'
const newerSentence = (version) => `${version} available — ${UPDATE_VERB}`

// ...and the other verdict, which is the one #27 shipped in green. Unchanged wording: a user
// who grepped their last bug report for it finds it in this one.
const UP_TO_DATE = 'up to date'

/**
 * Every row the box draws for these facts, in the order a reader reads them.
 *
 * @param {object} [facts] fully-resolved facts about the run:
 *   `version` (the installed Ralph — the box's SUBJECT, drawn by lib/banner-compose.js as the
 *   title rather than by a row here, and read here only to answer "is the cached one newer"),
 *   `latestVersion` (the newest version the global update-check cache knows of, or null),
 *   `cwd`, and `whatsNew` (#70: the newest changelog entry's bullets, in file order — anything
 *   but a non-empty array of usable strings drops the section). Anything that is not a
 *   non-blank string reads as unknown — the caller has already been where it could fail.
 *
 *   #75's three are OPTIONAL, and optional is the operative word: `os`, `agent` and
 *   `cachedLatest` each draw a row only when they are there, so a caller that knows none of
 *   them gets the box it always got. `cachedLatest` is the one with a third state —
 *   ABSENT means "this caller never consulted the cache" and draws nothing, while `null`
 *   means "consulted, no answer" and draws the row that says so. That distinction is why
 *   it is a separate fact from `latestVersion` rather than a second reading of it: the two
 *   express different sentences about the same cached number ("act on this" versus "here is
 *   what the last check found"), and a caller is free to want either, both or neither.
 *
 *   #69 adds five more, optional on the same terms and today all `ralph start`'s: `model` and
 *   `provenance`, which together decide what the AGENT row says (see `agentRows`, and
 *   lib/banner-model.js for where the pair is resolved); `contextWindow`, a number of tokens
 *   and the box's one numeric fact; `source`, the resolved task source; and `repo`,
 *   `owner/name`, passed only in github mode and only when it was cheaply knowable. Note that
 *   `provenance` changes what another fact MEANS rather than drawing a row of its own — the
 *   model is never reported without it, because a model with no stated source would be this
 *   box claiming more than it knows.
 * @returns {Array<{label: string, value: unknown, paint?: string}>} the rows, top to bottom. A
 *   FRESH array of fresh records every time, because three commands compose a box out of this
 *   list and one of them is free to keep or splice it. Never throws — a banner is not worth
 *   losing a run over, and this call sits one line above `ralph start`'s first preflight.
 */
export function bannerRows(facts) {
  // The rows, in the order a reader needs them: what is actionable first, then what
  // identifies the run, then (#70) what changed in the release they are running. #69's
  // agent/model/context/source/repo rows are further entries in this list — which is the
  // whole reason lib/banner-compose.js reads rows rather than being written out line by line,
  // and the whole reason this function is what #122 exported rather than the six builders
  // under it: the ORDER is a decision, and a list is where it is testable.
  //
  // RAW FACTS GO IN. Every value pushed here is whatever the caller handed us, and the
  // builders below each gate their own inputs — lib/banner-compose.js's `rowLine` and
  // `titleLine` through `textOr`, `newerVersion` through it twice. That is deliberate and it is
  // the only arrangement that survives this list growing: a sanitised value pushed at the push
  // site is a CONVENTION, which the next author has to know about, while a builder that gates
  // what it is given is a RULE, the same way `render` is the rule for width.
  const rows = []
  const newer = newerVersion(facts?.latestVersion, facts?.version)
  if (newer) {
    // The version, then the command — a reader who already knows the number still
    // needs the verb, and one line carrying both is one line a scrollback keeps
    // together. Deliberately NOT worded like the step-2.5 notice ("New version
    // available: x"), because these are two different sentences about the same fact
    // and a run can print both.
    rows.push({ label: 'update', value: newerSentence(newer), paint: YELLOW })
  }
  // #75's diagnostic rows, between the advice and the location — which is where a reader
  // looking for "which machine, which agent, how stale" expects them, and it is the order
  // `ralph doctor` printed them in before they were rows at all. That order is still what
  // this sequence draws, even though #69 moved the agent row into the builder below: it
  // lands in the same place on the screen, immediately after `os`. Each row here appears
  // only when the caller passed the fact behind it, so `ralph start`, which passes none of
  // this table's, takes not one line from it.
  rows.push(...factRows(facts, DIAGNOSTIC_ROWS))
  // #69's model rows, directly under the agent they are about — which is where they belong
  // for the same reason they are two rows and not one: `agent   claude — claude-opus-5 (last
  // run)` is the sentence the whole feature was asked for, and the window is a separate fact
  // that is often not knowable at all. Both are gated on facts `ralph doctor` and `ralph
  // status` do not pass, so their boxes are unchanged to the byte.
  rows.push(...agentRows(facts))
  rows.push(...contextRows(facts?.contextWindow))
  rows.push(...updateCheckRows(facts?.cachedLatest, facts?.version))
  // #201's channel, immediately under the verdict it qualifies: the `cached` row reports what
  // the last check found, and this one reports the channel that check was about. A reader of
  // a pasted box needs them adjacent, because the two channels hold different versions by
  // design. Gated on a fact only `ralph doctor` passes, so the other two boxes are unchanged
  // to the byte.
  rows.push(...factRows(facts, RELEASE_ROWS))
  rows.push({ label: 'cwd', value: facts?.cwd })
  // ...and #69's two locations, under the cwd, because they answer the same question about
  // this run that it does. Same gate, same table shape, different place in the box.
  rows.push(...factRows(facts, RUN_ROWS))
  // #70's what's-new bullets — LINES, not parameters, exactly as the composition module's
  // header promised: the newest release's bullets arrive in the same `facts` object as
  // everything else, already read out of the shipped CHANGELOG.md by the caller
  // (lib/changelog-file.js) and reduced to one entry (lib/changelog.js). Neither half of the
  // box is told anything about versions, dates or section headings, so neither can be made to
  // disagree with `ralph changelog` about them.
  //
  // LAST, under the facts: `update` is what a reader must act on and `cwd` is what
  // identifies the run, while this is news — and it is the part that grows, so putting it
  // at the bottom keeps the rows above it at a fixed place on the screen from run to run.
  rows.push(...whatsNewRows(facts?.whatsNew))
  return rows
}

// The box's plain single-fact rows — one per fact that is actually there, in the order of the
// table it is handed. #75's `os` is one; #69's `source` and `repo` are the other two. (The
// AGENT row started here and left when it became a sentence built from three facts — see
// `agentRows` — so the argument below is now made with `os` as its example rather than with
// the row that prompted it.)
//
// ABSENT MEANS NO ROW, and that is the whole gate. Every other row in this box says
// `unknown` for a fact it was not given, because `ralph start` always asks all of its
// questions and a missing answer is news. These are different: a caller that does not pass
// `os` is not a caller whose platform is unknown, it is a caller that never asked — and
// `os      unknown` in a pasted bug report would send a reader looking for a platform
// detection bug that does not exist. It is also, and not incidentally, the mechanism that keeps
// every OTHER command's box byte-identical when a row is added here: `ralph start` passes
// `source` and `repo` and no `os`, `ralph doctor` and `ralph status` pass `os` and neither of
// the other two, and each draws exactly what it asked for.
//
// GATED HERE, with `textOr`, on the argument the row gate makes at `rowLine`: the builder
// that makes a row owns that row's sanitisation. It matters more here than anywhere else in
// this file, because `repo` comes out of GH_REPO — a variable an ambient environment or a
// committed `ralph.config.sh` may set (#120) — and a `.git/config` nobody reads as bytes, and
// `os` out of a platform detector: `textOr` refusing non-strings is what stops a hostile bag's
// `toString` running just because someone put an object in the facts. The value pushed is the
// string that survived, and `rowLine` gates it again on the far side of the seam, which is
// idempotent and left in place deliberately (see `whatsNewRows` for the same note).
// ONE GATE, THREE TABLES (#69, #201): the rows it draws are named by the `table` it is handed
// rather than by a constant it reads, so `source` and `repo` — and #201's `channel`, which
// sits in a third place again — cost a table entry rather than another copy of the gate above.
// Three tables is the evidence the seam was the right shape: the second one needed a
// parameter, and the third needed nothing at all.
function factRows(facts, table) {
  const rows = []
  for (const { label, from } of table) {
    const text = textOr(facts?.[from], '')
    if (text) rows.push({ label, value: text })
  }
  return rows
}

// #69's headline row: which agent is about to run, and which model it will use — with the
// wording chosen by WHERE the model came from.
//
// FOUR ANSWERS, and the order they are decided in is the argument:
//
//   no agent          NO ROW. Same gate as `factRows`': a caller that passed no agent is not
//                     a caller whose agent is unknown, it is one that never asked.
//   no tag at all     THE BARE ROW `ralph doctor` has printed since #75, and the reason a tag
//                     the table does not know is checked before anything else about the model.
//                     Doctor's box is a diagnostic about an INSTALLATION, not a report about a
//                     run; `claude — model resolves at first run` in a pasted bug report would
//                     be a sentence about a run doctor never looked at. An unrecognized tag
//                     lands here too, which is the conservative direction: evidence of unknown
//                     kind claims nothing rather than picking one of the sentences below at
//                     random. `unknown` is NOT this case — it is a tag the table knows, whose
//                     sentence is the one below.
//   a tag, no model   The sentence that names no model — `unknown`'s own answer, and also what
//                     a `last-run` tag with no model to name gets. That second shape is
//                     unreachable from the resolver, which never tags a missing model
//                     `last-run`, and cheap to make unreachable by construction: `claude —
//                     (last run)` is a row that states nothing while looking like it states
//                     something.
//   a tag and a model `claude — claude-opus-5 (last run)`.
//
// GATED HERE, before the concatenation, for the reason `whatsNewRows` gives about its bullet
// prefix: this row is BUILT from three facts, two of which come out of a shell config and an
// ambient environment, so `${agent} — ${model}` on an ungated value is precisely the coercion
// the row gate exists to prevent. `rowLine` gates the result again on the far side of the seam,
// which is idempotent and left in place deliberately — the rule is that every row is gated by
// the builder that makes it, not that every value is gated exactly once.
function agentRows(facts) {
  const agent = textOr(facts?.agent, '')
  if (!agent) return []
  const row = (value) => [{ label: AGENT_LABEL, value }]
  const provenance = textOr(facts?.provenance, '')
  if (!MODEL_SUFFIX.has(provenance)) return row(agent)
  const suffix = MODEL_SUFFIX.get(provenance)
  const model = textOr(facts?.model, '')
  if (!suffix || !model) return row(`${agent} — ${MODEL_UNKNOWN}`)
  return row(`${agent} — ${model} (${suffix})`)
}

// #69's window row: how much context the model above works with, when that is known.
//
// SHOWN WHEN KNOWN, ABSENT WHEN NOT, and the absence is deliberate rather than lazy: a
// `context unknown` beside a named model reads as a detection bug in Ralph, when the truth is
// that not every model reveals its window — an id the shared map has never heard of resolves
// to null both here and in the telemetry.
function contextRows(contextWindow) {
  const tokens = windowTokens(contextWindow)
  return tokens ? [{ label: CONTEXT_LABEL, value: tokens }] : []
}

// A window, as the row says it: `1M tokens`, `200k tokens`, `1500 tokens`.
//
// THE BOX'S FIRST NUMERIC FACT, and `textOr` is the wrong gate for it: a number is not a
// string, and coercing one to check it would run a hostile `valueOf` on a value that arrived
// from a JSON log. So this is the gate, on the same rule — refuse rather than coerce — and it
// returns a STRING, which is what `rowLine`'s own gate then accepts. A string that looks like
// a number ('1000000') is not a number here, deliberately: this fact is numeric everywhere it
// is written, and accepting text would be accepting whatever else text can be.
//
// ABBREVIATED ONLY WHEN EXACT. `1M` for a round million and `200k` for a round thousand,
// because those are the numbers every model's window actually is; anything else — an odd
// RALPH_CONTEXT_WINDOW override — prints as itself rather than rounding to a friendlier lie a
// reader cannot match against the value they set.
function windowTokens(value) {
  if (typeof value !== 'number') return ''
  // Floored, because a fractional token count is not a thing and `1.5M tokens` would be a
  // number this box invented.
  const tokens = Math.floor(value)
  // GATED ON THE FLOORED COUNT, NOT THE RAW VALUE, and that ordering is the whole guard. A
  // window between zero and one — `RALPH_CONTEXT_WINDOW=0.5`, which lib/capture-issue-event.js
  // accepts and writes to the log, and which lib/banner-model.js reads back on the same terms —
  // is positive before the floor and zero after it, and `0 % MILLION === 0`, so gating the raw
  // value drew `context  0M tokens`: a window no model has and nobody set, invented by this
  // function's own arithmetic. banner-rows.test.js pins `0` as no row; a value that BECOMES
  // zero here is that same number and gets that same answer.
  //
  // AND SAFE-INTEGER, which is one rule for two absurdities. Above 2^53 a count is no longer
  // the count that was passed — JS cannot hold it exactly — and past 1e21 it is not even
  // spelled in digits, so `1e+30 tokens` and `1000000000000000M tokens` both reach a reader as
  // something they cannot match against the RALPH_CONTEXT_WINDOW they set, which is the one
  // thing the abbreviation rule above exists to prevent. A number this box cannot state exactly
  // is a number it does not state: no row, exactly as for a window it never had. `Infinity` and
  // `NaN` fall out here too, which is why the finite check above the floor is gone rather than
  // duplicated.
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return ''
  if (tokens % MILLION === 0) return `${tokens / MILLION}M ${TOKENS}`
  if (tokens % THOUSAND === 0) return `${tokens / THOUSAND}k ${TOKENS}`
  return `${tokens} ${TOKENS}`
}

// #75's verdict row: #27's `cached latest: …` sentence, moved into the box whole.
//
// THREE STATES, and the reason all three had to survive the move is that #27's line was a
// DIAGNOSTIC, not a nag. "up to date" is a real answer to a real question — a user pasting
// this into a bug report is often being asked whether they are current — and "no update check
// cached yet" is the answer that stops a reader concluding the user is current when nobody has
// looked. A box that only spoke up when an update existed would be a smaller diagnostic than
// the line it replaced.
//
// FOUR states, counting the one that prints nothing: an ABSENT `cachedLatest` is a caller that
// never consulted the cache, which is every caller but doctor, and it earns no row at all. See
// the fact list in `bannerRows`'s JSDoc for why that is a distinct fact from `latestVersion`.
//
// ONE OWNER OF "NEWER", still: the comparison is `newerVersion`, the same function the
// `update` row above asks, which is itself `compareSemver`/`isValidSemver` from
// lib/update-check.js. Doctor therefore cannot come to disagree with the box, with the box's
// own hint, or with `ralph start`'s step-2.5 notice about what "newer" means — which is
// exactly the defect #27's own helper was one duplicated comparison away from.
//
// AND AN UNUSABLE INSTALLED VERSION IS TWO FACTS AND NO VERDICT, deliberately: a `version` of
// 'unknown' (a package.json the caller could not read) makes the comparison impossible, so
// the row states the cached number and claims nothing — unpainted, because there is no
// verdict to colour. #27 shipped that same trade for the same reason.
function updateCheckRows(cachedLatest, version) {
  if (cachedLatest === undefined) return []
  // The row this builder returns, whatever it decides to say: one label, named once, so the
  // three states below read as three STATES rather than as three copies of a row literal.
  const row = (value, paint) => [{ label: CACHED_LABEL, value, paint }]
  const latest = textOr(cachedLatest, '')
  // Anything the registry could not have published — a blank, a hand-edited 'banana', a
  // 'v1.0.0', a number — is a cache with no usable answer in it, which reads the same way an
  // empty cache does. `textOr` first, so a `latest_version` hiding control bytes
  // ('2.0.0\u001B[31m') is still not semver after the replacement and still earns no verdict.
  if (!isValidSemver(latest)) return row(NO_CACHED_ANSWER)
  if (!isValidSemver(textOr(version, ''))) return row(latest)
  const behind = newerVersion(latest, version) !== null
  return behind
    ? row(newerSentence(latest), YELLOW)
    : row(`${latest} — ${UP_TO_DATE}`, GREEN)
}

// #70's rows: `new` labelling the first bullet, the rest hanging under it, and the pointer
// at the bottom. Returns an EMPTY LIST — not a heading, not a placeholder bullet, not a
// pointer to a command with nothing behind it — whenever there is nothing to show, which
// is what makes "a pruned install just starts" a property of this module rather than a
// condition every caller has to remember.
//
// THE BULLET GATE, and the reason this is a builder of its own rather than three pushes in
// the assembler. Every other fact in this box is a scalar that `rowLine` can gate on the
// way in; a bullet is one of a LIST and it is PREFIXED, so something has to concatenate,
// and `'• ' + bullet` on a value that came out of a file is precisely the coercion the row
// gate exists to prevent — a hostile object's `toString` would run before `rowLine` ever
// saw it. So the gate happens HERE, first: `textOr` refuses everything that is not a
// string, and only what survives it is concatenated. `rowLine` gates the result again,
// which is idempotent and left in place deliberately — the rule is that every row is
// gated by the builder that makes it, not that each value is gated exactly once.
//
// A bullet is the least trusted text in this box, and it is worth saying why: it is
// committed markdown, which nobody reads as bytes, shipped inside the package and rendered
// above every preflight line. A `\n` in one would forge an unframed line outside the width
// guarantee; an ESC would leak a sequence into a run that promised none. `textOr` replaces
// both, as it does for a path or a cached version.
//
// SKIPS what it cannot use rather than dropping the section: three usable bullets past a
// blank and a null are still three bullets, and losing a release's news to one stray
// element in the list would be the worse of the two failures. The cap is applied to what
// SURVIVES, so a list that begins with an empty string still shows three — and to a COPY, so
// a caller's own list still holds everything it held.
function whatsNewRows(bullets) {
  // Not an array — absent, null, a string, a hostile bag, a Set — is nothing to show.
  // Checked rather than iterated: `for…of` on a non-iterable throws, and a Set of strings
  // is not a shape this box has any reason to accept from a caller that reads a file.
  if (!Array.isArray(bullets)) return []
  const shown = []
  for (const bullet of bullets) {
    const text = textOr(bullet, '')
    if (text) shown.push(text)
    if (shown.length === WHATS_NEW_LIMIT) break
  }
  if (!shown.length) return []
  return [
    ...shown.map((text, index) => ({
      // The label on the FIRST row only. A reader needs the section named once; repeating
      // it three times spends the label column on a word they have already read.
      label: index === 0 ? WHATS_NEW_LABEL : '',
      value: `${BULLET_GLYPH} ${text}`,
    })),
    { label: MORE_LABEL, value: WHATS_NEW_POINTER },
  ]
}

/**
 * A fact, or the word for not having one — the gate both halves of the box share.
 *
 * Non-strings are refused rather than coerced: `String(value)` on a hostile object runs its
 * `toString`, and the box takes its inputs from a JSON cache and a caller's argv. Trimmed, so a
 * config value edited by hand with a space left behind reads as absent rather than as a version
 * called `" "` — the same rule version-cache.js normalizes the cache with.
 *
 * THE SANITISATION ITSELF, applied by every builder that takes a fact — the five above, plus
 * lib/banner-compose.js's `titleLine` and `rowLine` on the far side of the seam — each on the
 * way in, so `bannerRows` may push raw facts and no push site can forget. It is EXPORTED for
 * exactly those two frame-half builders and for no other reason: "what counts as a fact" is one
 * decision, and a second copy of it over there is how the title would come to accept something
 * the rows refuse. It is NOT applied in `render`, which is where the width gate lives, for one
 * reason: `render` is where the box adds its own escapes, so a scrub there would either delete
 * them or have to tell its bytes from a fact's. It is applied BEFORE the width accounting, so
 * `clip` measures exactly what is printed.
 *
 * Trim first, replace second: `'\n'` alone is a fact that was never given (it reads as
 * unknown, like any blank), while a newline BETWEEN two path segments is a fact that
 * contains something unprintable and must survive as such.
 *
 * It also closes the hint's door a second time. `newerVersion` compares what comes out
 * of here, so a cached `latest_version` of `'2.0.0\u001B[31m'` is still not semver after
 * the replacement and still earns no row — the box cannot be made to announce a version
 * the registry never published by hiding control bytes in the cache file.
 *
 * @param {unknown} value the fact, as the caller had it
 * @param {string} fallback what to answer when it is not usable text — UNKNOWN for a row the
 *   box always draws, `''` for one that is absent unless asked for
 * @returns {string} the trimmed text with every control code point replaced, or the fallback
 */
export function textOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length ? trimmed.replace(CONTROL, PLACEHOLDER) : fallback
}

// The hint's whole condition: a cached version that is a version, an installed version
// that is a version, and the first strictly above the second. Both halves matter —
// an `unknown` installed version (a package.json `ralph start` could not read) is not
// a comparison, so it gets no hint rather than an unconditional one, exactly as
// `resolveUpdateDecision` decides for the notice.
//
// Returns the version to name, so the caller has nothing to re-derive.
function newerVersion(latestVersion, installedVersion) {
  const latest = textOr(latestVersion, '')
  const installed = textOr(installedVersion, '')
  if (!isValidSemver(latest) || !isValidSemver(installed)) return null
  return compareSemver(latest, installed) > 0 ? latest : null
}
