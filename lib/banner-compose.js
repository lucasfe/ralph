// #68 — the banner's COMPOSITION: resolved facts in, terminal lines out.
//
// lib/sprite-data.js is the pixels, lib/sprite-render.js turns them into strings and
// lib/sprite-banner.js decides whether they may be drawn at all (#67). None of them
// knows a single fact about the run. This module is the other half of the banner: the
// box under the sprite that says which Ralph this is, and it knows nothing about
// pixels. #68 gives it its first two facts — the installed version and the working
// directory — plus the one piece of advice the box carries, an update hint.
//
// PURE, and asserted so by a static read in banner-compose.test.js: no process, no
// clock, no fs, and no cache read of its own. Every fact arrives as an argument
// because the whole feature's testability rests on it (#41) — a module that read
// `stdout.columns` or `~/.config/ralph/update-check.json` itself would turn every
// case in that table into a test of the machine the suite happens to run on. The
// callers resolve the facts (see `ralph start`'s step 0) and print what comes back.
//
// THREE INPUTS, AND THE SHAPE IS THE POINT (the PRD's composition module): fully
// resolved `facts`, a terminal `width`, and a `capabilities` bag. Later slices add
// LINES, not parameters — #69's agent/model/context/source/repo rows, #70's what's-new
// bullets and #75/#76's reuse from `ralph doctor` and `ralph status` all fit inside these
// three, so no caller has to be revisited to teach this module a new fact. #72's width
// degradation fit inside them too, and it is the one that came home to roost here: the
// whole ladder — unbox under 44 columns, no sprite under 26 — is `bannerLayout` below,
// decided from the injected `width` alone, which is what makes every rung of it testable
// without a terminal. lib/sprite-banner.js asks the same function rather than keeping its
// own copy of 26.
//
// ONE IMPORT, and it is a rule rather than a helper: the newer-than question is
// answered by the very two functions that decide whether `ralph start` prints its
// step-2.5 update notice (#21/#24). A second semver comparison here is how the box
// and the notice would come to disagree about what "newer" means — the box hinting at
// an update the notice does not offer, in the same screenful of output.
import { compareSemver, isValidSemver } from './update-check.js'

/**
 * The box's design width, and the default for a width that cannot be used.
 *
 * 60 columns is the PRD's target: wide enough for a deep working directory and for
 * #69's model ids, narrow enough to sit under a 26-column sprite without the eye
 * losing the rule. It is a TARGET rather than a minimum — a 200-column terminal gets
 * the same box, because a 200-wide rule is a line nobody can follow — and it is
 * exported so a caller can reason about the box's size without re-deriving it.
 *
 * It is also the top of #72's ladder and the FALLBACK at the bottom of it: a width that
 * cannot be used at all is treated as this one, because the alternative — degrading on a
 * pipe, where `stdout.columns` is `undefined` — would change what every launchd log and
 * CI transcript has ever contained.
 */
export const BANNER_WIDTH = 60

/**
 * The narrowest terminal that still gets a FRAME.
 *
 * 44 columns is where the box stops paying for itself. Four of them go to the frame
 * (`│ ` and ` │`) and eight to the label gutter, so at 44 a value has 32 columns and at
 * 43 the frame is spending an eighth of the screen on decoration. Below it the rows
 * print BARE — `key   value`, no border, no rule — which is the same information with
 * those four columns handed back to the fact.
 *
 * A floor on the BOX, not on the banner: there is no width at which this module returns
 * nothing. A 12-column terminal still says which Ralph and where.
 */
export const BOX_MIN_WIDTH = 44

/**
 * The narrowest terminal the SPRITE may be drawn on.
 *
 * 26 is the sprite's own cell width, and it is the lower rung because of where the
 * sprite sits: ABOVE the box rather than beside it. That makes the sprite the narrow
 * element and the box the wide one, so the box gives way first and the sprite is dropped
 * last — at 26 it fits exactly, and below that it cannot be drawn at all. A clipped
 * sprite is not a smaller sprite, it is half a face with a torn edge, so it goes whole.
 *
 * NOT imported from lib/sprite-data.js, deliberately: this module's header says it knows
 * nothing about pixels, and a `spriteWidth` import here would be the first line of it
 * that did — the box would then depend on the art, which is the coupling the two-file
 * split exists to prevent. The two numbers are held together by a test instead
 * (banner-compose.test.js asserts `spriteWidth === SPRITE_MIN_WIDTH`), so the day the
 * art is redrawn wider the suite says so rather than a 26-column terminal tearing.
 */
export const SPRITE_MIN_WIDTH = 26

// The value column. `update` and `cwd` are this slice's labels; #69's longest is
// `context`, which is why the gutter is eight rather than seven — one space of air
// after the longest label there will ever be here, so adding a row never re-flows
// the ones above it.
const LABEL_WIDTH = 8

// The frame. U+256D-family rounded corners, matching nothing else in this codebase
// because nothing else in it draws a box — `ralph status` uses a label column and no
// rule at all. Unicode rather than `+---+`: this box goes wherever the sprite's U+2580
// does, and under BOX_MIN_WIDTH none of it is drawn at all (#72). A terminal that can
// render the width but not the GLYPHS is still out of scope — #72 turned out to be a
// question about columns, and a font capability is not something a column count reveals.
const TOP_LEFT = '╭'
const TOP_RIGHT = '╮'
const BOTTOM_LEFT = '╰'
const BOTTOM_RIGHT = '╯'
const RULE = '─'
const SIDE = '│'

// What a clipped value ends in. One column wide, so it costs exactly the character it
// replaces, and unmistakable — a reader who sees it knows the value continues rather
// than wondering whether their repo is really called `/Users/someone/repos/dee`.
const ELLIPSIS = '…'

// The one thing in this box that is advice rather than fact, in the one colour this
// package already uses for it: `\u001B[33m`/`\u001B[39m` are the bytes picocolors
// emits for `yellow`, which is what lib/update-gate.js wraps the step-2.5 notice in.
// Spelled out rather than imported, for two reasons: picocolors decides ONCE AT IMPORT
// whether colour is allowed, from the real `process.env` that no injected bag can
// reach — so importing it here would hand this module an ambient capability behind
// this file's back — and it would make the escapes below a fact about the developer's
// shell instead of a fact about the `capabilities` argument.
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
// place to ask which kind it is holding. See `rowLine`.
const YELLOW = '\u001B[33m'
const GREEN = '\u001B[32m'
const COLOR_OFF = '\u001B[39m'

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
// code point in for one code point out, so the width accounting below stays exact
// without a second pass.
//
// NOT bidi controls (U+202E and friends), deliberately: those reorder text that a
// terminal is otherwise printing normally, which is the same class of problem as an
// East Asian glyph occupying two cells — see visibleWidth. Replacing them would also
// mangle a legitimate path containing a ZWJ emoji sequence, and this box would be
// misreporting a real directory to defend against a rewritten one.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu
const PLACEHOLDER = '\uFFFD'

// #70's section, in the constants it is made of.
//
// THREE BULLETS: enough to say what a release was about, few enough that the box stays a
// box under a 26-column sprite. The rest are not truncated away, they are simply not
// shown — which is what the pointer is for. `ralph changelog` is #71's command and is
// named here on the day this ships, because a teaser with no verb is a dead end.
//
// The bullet glyph is U+2022, which goes wherever the frame's U+256D goes — including
// into the bare form under 44 columns, since the bullet is part of what the row SAYS and
// the frame is not. It is a PREFIX applied to a fact, so the builder below applies it
// AFTER the gate — see `whatsNewRows`.
const WHATS_NEW_LIMIT = 3
const WHATS_NEW_LABEL = 'new'
const BULLET_GLYPH = '•'
// The pointer's own row, labelled like every other row rather than tucked under the last
// bullet: a reader scanning the label column finds it, and it survives the clip on a
// narrow terminal as a line of its own instead of as the tail of a bullet. Worded like the
// update hint above it (`… — run \`ralph update\``) because they are the same kind of
// sentence: a fact, then the verb that acts on it.
const MORE_LABEL = 'more'
const WHATS_NEW_POINTER = 'run `ralph changelog` for the rest'

// What a fact we were not given reads as. The same word `ralph start` already uses
// for a version it could not read out of package.json ("starting Ralph on unknown"),
// and the same discipline lib/progress.js states at length: name what is missing,
// never invent it and never print a plausible-looking stand-in.
const UNKNOWN = 'unknown'

// #75's section, in the constants it is made of.
//
// THE DIAGNOSTIC ROWS: what `ralph doctor` used to print in two lines of its own — a
// `platform: … — agent: …` header and #27's `version: … — cached latest: …` verdict —
// folded into this box so that ONE paste into a bug report carries all of it. They are
// LINES, not parameters, exactly as this file's header promised, and every one of them is
// gated on a fact `ralph start` does not pass: that is what keeps the banner above the loop
// byte-identical to what #74 shipped, and banner-compose.test.js pins it as a literal.
//
// `os` RATHER THAN `platform`, and the reason is arithmetic rather than taste: the label
// gutter is eight columns and `padEnd` does not grow, so `platform` would print
// `platformmac` with no air at all. Widening LABEL_WIDTH would re-flow every row of `ralph
// start`'s box for the sake of one word, so the word gives way instead — and `os` is what
// `lib/platform.js` actually answers ('mac', 'linux'), which was never a platform TRIPLE.
//
// DECLARED AS A TABLE so `factRows` stays one gate rather than one gate per fact, and #76's
// `ralph status` rows are an entry here rather than a new branch. The `from` key names the
// fact; the `label` is a literal in this file, as every label in this box is.
const DIAGNOSTIC_ROWS = [
  { label: 'os', from: 'os' },
  { label: 'agent', from: 'agent' },
]

// #27's verdict, and its label. `cached` is the wording that survived the move, deliberately:
// doctor REPORTS what the last check found, it does not check — the registry query and the
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
// that changed here. The verb changed because it does not fit: at 60 columns a value has 48,
// and `0.18.0 — update available (run npm i -g @lucasfe/ralph)` is 55 — it would clip to
// `…(run npm i -g @lucasfe/ral…`, a hint a user cannot follow. `ralph update` is Ralph's own
// verb for the same act and it is what the `update` row has told `ralph start` users since
// #68. The PHRASING changed for the same arithmetic: `update available (run \`ralph update\`)`
// is 37 columns of it, which a 13-character prerelease ('0.23.0-beta.1') pushes to 53 and the
// clip then eats the verb anyway. `X available — run \`ralph update\`` is 44 at that same
// version, says the identical thing, and is already on screen everywhere else.
const UPDATE_VERB = 'run `ralph update`'
const newerSentence = (version) => `${version} available — ${UPDATE_VERB}`

// ...and the other verdict, which is the one #27 shipped in green. Unchanged wording: a user
// who grepped their last bug report for it finds it in this one.
const UP_TO_DATE = 'up to date'

// #72's TWO LINE FORMS, as data rather than as branches.
//
// The degradation is a choice between two ways of drawing the SAME row list, and this is
// the shape that keeps it one choice: `composeBanner` picks a frame once and every
// builder below reads it. The alternative — an `if (boxed)` inside the title builder,
// another inside the row builder, a third around the bottom rule — is three places for
// the forms to disagree, and the first disagreement is a box whose top is framed and
// whose rows are not.
//
// Five members, and each one is a thing the frame DECIDES rather than a glyph it owns:
//
//   `inner`  how much of `boxWidth` a row's content may use. The box spends four columns
//            on `│ ` and ` │`; the bare form spends none.
//   `indent` where a row's content STARTS, in columns from the left of the line. It is
//            what `render`'s paint offsets are measured from, so the update hint's yellow
//            lands on the value and not on two glyphs of frame.
//   `wrap`   content in, line out. The box also pads to the right border so the four
//            sides line up; the bare form pads NOT AT ALL, because trailing spaces are
//            noise in a log file and a bare line has no border to reach.
//   `title`  the box's subject. Framed, it is `╭─ ralph 0.22.0 ──╮`; bare, it is the
//            same sentence with nothing around it.
//   `close`  the bottom rule, as a LIST — one line for the box, none for the bare form,
//            which is how "no bottom rule" is expressed without a conditional at the
//            call site. A rule with no border above it to close is an orphan.
const BOXED = {
  inner: (boxWidth) => Math.max(0, boxWidth - 4),
  indent: 2,
  wrap: (content, inner) =>
    `${SIDE} ${content}${' '.repeat(Math.max(0, inner - visibleWidth(content)))} ${SIDE}`,
  title: (title, boxWidth) => {
    // Clipped HERE, against the box, and not left to `render` — because `render` holds
    // lines to the TERMINAL's width, and on a terminal wider than 60 that is not the same
    // number. A 52-character prerelease version ('1.0.0-alpha.20260101.build.1234+sha…')
    // would otherwise close its corner at column 63 while every row below closed at 60:
    // a box with a ragged right border, which reads as a rendering bug in Ralph rather
    // than as a long version. One column is reserved for the corner, so the clipped title
    // and TOP_RIGHT together are exactly `boxWidth`.
    const head = clip(`${TOP_LEFT}${RULE} ${title} `, Math.max(0, boxWidth - 1))
    // `Math.max(0, …)`: a title that fills the box leaves no rule at all, and a
    // `repeat(-3)` would throw.
    return head + RULE.repeat(Math.max(0, boxWidth - visibleWidth(head) - 1)) + TOP_RIGHT
  },
  close: (boxWidth) => [
    { text: BOTTOM_LEFT + RULE.repeat(Math.max(0, boxWidth - 2)) + BOTTOM_RIGHT },
  ],
}

// The bare form is the boxed one with every decoration answered "none": the whole width
// is content, the content starts at column 0, nothing wraps it, nothing closes it. It
// still clips its title, because `boxWidth` is the layout width and a 60-column cap on a
// 200-column terminal is a cap the bare form keeps too — a bare banner is a narrow
// terminal's banner, not a licence to run a long version across the whole screen.
const BARE = {
  inner: (boxWidth) => boxWidth,
  indent: 0,
  wrap: (content) => content,
  title: (title, boxWidth) => clip(title, boxWidth),
  close: () => [],
}

/**
 * The degradation ladder, as one decision — #72's whole story in four fields.
 *
 * Pure, total and the ONLY place either rung is read: lib/sprite-banner.js asks this
 * function whether it may draw rather than holding a 26 of its own, because two copies
 * of a threshold are two thresholds the day one of them moves.
 *
 * @param {number} [width] the terminal's column count, as the caller found it —
 *   `stdout.columns` is `undefined` on a pipe and `0` on some CI runners
 * @returns {{width: number, boxWidth: number, boxed: boolean, sprite: boolean}}
 *   `width` is the usable limit every line is held to (see `usableWidth`: anything that
 *   is not a whole positive number falls back to BANNER_WIDTH). `boxWidth` is the width
 *   the rows are LAID OUT at, which is smaller on a narrow terminal and capped at the
 *   60-column target on a wide one. `boxed` is whether the frame is drawn, `sprite`
 *   whether the sprite may be. Never throws — a banner is not worth losing a run over.
 */
export function bannerLayout(width) {
  const limit = usableWidth(width)
  return {
    width: limit,
    boxWidth: Math.min(limit, BANNER_WIDTH),
    boxed: limit >= BOX_MIN_WIDTH,
    sprite: limit >= SPRITE_MIN_WIDTH,
  }
}

/**
 * The identity box, as terminal lines.
 *
 * @param {object} [options]
 * @param {object} [options.facts] fully-resolved facts about the run:
 *   `version` (the installed Ralph), `latestVersion` (the newest version the global
 *   update-check cache knows of, or null), `cwd`, and `whatsNew` (#70: the newest
 *   changelog entry's bullets, in file order — anything but a non-empty array of usable
 *   strings drops the section). Anything that is not a non-blank string reads as unknown
 *   — the caller has already been where it could fail.
 *
 *   #75 adds three OPTIONAL facts, and optional is the operative word: `os`, `agent` and
 *   `cachedLatest` each draw a row only when they are there, so a caller that knows none of
 *   them gets the box it always got. `cachedLatest` is the one with a third state —
 *   ABSENT means "this caller never consulted the cache" and draws nothing, while `null`
 *   means "consulted, no answer" and draws the row that says so. That distinction is why
 *   it is a separate fact from `latestVersion` rather than a second reading of it: the two
 *   express different sentences about the same cached number ("act on this" versus "here is
 *   what the last check found"), and a caller is free to want either, both or neither.
 * @param {number} [options.width] the terminal's column count. Absent or unusable
 *   falls back to BANNER_WIDTH; every returned line is guaranteed no wider. Under
 *   BOX_MIN_WIDTH the frame is dropped and the rows print bare (#72) — see
 *   `bannerLayout`, which is where that is decided.
 * @param {object} [options.capabilities] what the terminal will accept. `color`
 *   permits ANSI; with it off, not one escape byte is emitted.
 * @returns {string[]} the lines to print, title first, never empty
 */
export function composeBanner({ facts = {}, width = BANNER_WIDTH, capabilities = {} } = {}) {
  // THE LADDER, CONSULTED ONCE (#72), and the three things it hands back.
  //
  // `limit` is the width the CALLER promised and every line is finally held to; `boxWidth`
  // is the width the rows are LAID OUT at, and the two differ on a wide terminal (the box
  // holds its 60) as well as on a narrow one (the rows are drawn at the terminal's width).
  // `frame` is which of the two line forms this width gets — chosen HERE, once, so that
  // every builder below draws the same form. See the note on BOXED/BARE for why the
  // alternative (a conditional inside each builder) is the arrangement that tears.
  const { width: limit, boxWidth, boxed } = bannerLayout(width)
  const frame = boxed ? BOXED : BARE
  const color = capabilities?.color === true

  // The rows, in the order a reader needs them: what is actionable first, then what
  // identifies the run, then (#70) what changed in the release they are running. #69's
  // agent/model/context/source/repo rows are further entries in this list — which is the
  // whole reason the layout below reads rows rather than being written out line by line.
  //
  // RAW FACTS GO IN. Every value pushed here is whatever the caller handed us, and the
  // three builders below each gate their own inputs — `rowLine` and `titleLine` through
  // `textOr`, `newerVersion` through it twice. That is deliberate and it is the only
  // arrangement that survives this list growing: a sanitised value pushed at the call
  // site is a CONVENTION, which the next author has to know about, while a builder that
  // gates what it is given is a RULE, the same way `render` is the rule for width.
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
  // `ralph doctor` printed them in before they were rows at all. Each one appears only when
  // the caller passed the fact behind it, so `ralph start`, which passes none of them, is
  // unchanged to the byte.
  rows.push(...factRows(facts))
  rows.push(...updateCheckRows(facts?.cachedLatest, facts?.version))
  rows.push({ label: 'cwd', value: facts?.cwd })
  // #70's what's-new bullets — LINES, not parameters, exactly as the header promised: the
  // newest release's bullets arrive in the same `facts` object as everything else, already
  // read out of the shipped CHANGELOG.md by the caller (lib/changelog-file.js) and reduced
  // to one entry (lib/changelog.js). This module is told nothing about versions, dates or
  // section headings, so it cannot be made to disagree with `ralph changelog` about them.
  //
  // LAST, under the facts: `update` is what a reader must act on and `cwd` is what
  // identifies the run, while this is news — and it is the part that grows, so putting it
  // at the bottom keeps the rows above it at a fixed place on the screen from run to run.
  rows.push(...whatsNewRows(facts?.whatsNew))

  // Built as records rather than strings so the width guarantee and the colour can be
  // applied in the only order that is correct: clip the VISIBLE text, then wrap what
  // survived in escapes. Doing it the other way round cuts an escape sequence in half
  // at some widths, which is a corrupt terminal rather than a truncated line.
  return [
    titleLine(facts?.version, frame, boxWidth),
    ...rows.map((row) => rowLine(row, frame, boxWidth, color)),
    ...frame.close(boxWidth),
  ].map((line) => render(line, limit))
}

// #75's plain diagnostic rows — the platform and the agent — one per fact that is actually
// there, in DIAGNOSTIC_ROWS' order.
//
// ABSENT MEANS NO ROW, and that is the whole gate. Every other row in this box says
// `unknown` for a fact it was not given, because `ralph start` always asks all of its
// questions and a missing answer is news. These are different: a caller that does not pass
// `os` is not a caller whose platform is unknown, it is a caller that never asked — and
// `os      unknown` in a pasted bug report would send a reader looking for a platform
// detection bug that does not exist. It is also, and not incidentally, the mechanism that
// keeps `ralph start`'s banner byte-identical: `start` passes neither fact, so it draws
// neither row, and no future row added to the table above can change that.
//
// GATED HERE, with `textOr`, on the argument the row gate makes at `rowLine`: the builder
// that makes a row owns that row's sanitisation. It matters more here than anywhere else in
// this file, because `agent` comes out of RALPH_AGENT — an ambient environment variable — and
// `os` out of a platform detector: `textOr` refusing non-strings is what stops a hostile
// bag's `toString` running just because someone put an object in the facts. The value pushed
// is the string that survived, and `rowLine` gates it again, which is idempotent and left in
// place deliberately (see `whatsNewRows` for the same note).
function factRows(facts) {
  const rows = []
  for (const { label, from } of DIAGNOSTIC_ROWS) {
    const text = textOr(facts?.[from], '')
    if (text) rows.push({ label, value: text })
  }
  return rows
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
// the fact list in composeBanner's JSDoc for why that is a distinct fact from `latestVersion`.
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
// THE BULLET GATE, and the reason this is a builder of its own rather than three pushes at
// the call site. Every other fact in this box is a scalar that `rowLine` can gate on the
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
// SURVIVES, so a list that begins with an empty string still shows three.
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

// `╭─ ralph 0.22.0 ─────╮`, or just `ralph 0.22.0` where there is no room for a frame at
// all (#72). The version is IN the title rather than on a `version` row of its own: it is
// the box's subject, the one fact a reader wants before they have decided to read
// anything, and a title needs no label to say so. Which is also why the bare form is the
// same sentence unadorned rather than a `version` row — dropping the frame must not
// change what the banner SAYS, only how much ink is around it.
//
// Takes the RAW version and gates it here, for the reason given at the rows above: the
// gate belongs to the builder, never to the call site. The frame decides the shape and
// this decides the words, so neither form can drift from the other's subject.
function titleLine(version, frame, boxWidth) {
  const title = `ralph ${textOr(version, UNKNOWN)}`
  return { text: frame.title(title, boxWidth) }
}

// `│ label   value │`, or `label   value` bare (#72), with the value clipped to fit and
// — in the box — the row padded so the right border lines up with the ones above and
// below it.
//
// THE ROW GATE. Every row's value passes through `textOr` HERE, on the way in, and this
// is the same argument `render` makes for the width: an invariant that lives in the one
// function every row goes through cannot be forgotten by the next row, and an invariant
// applied at each push site can. #69 adds five rows to that list and #70 adds bullets;
// if the sanitisation sat at the call sites, `{ label: 'model', value: facts.model }`
// would be a plain-looking line that re-opens all three of the hostile-fact defects at
// once — a `\n` from ralph.config.sh forging an unframed line outside the width
// guarantee, an ESC leaking into a run that promised none, and `gutter + value`
// coercing a hostile object's `toString` on a value that came from a JSON cache.
//
// Which is also why the concatenation below is safe to write plainly: `fact` is a string
// by construction, because `textOr` refuses everything that is not one. `label` takes no
// gate because labels are literals in this file, never facts (see the rows above).
//
// The paint range is recorded as offsets rather than applied here so that `render`
// can clip first: `paintFrom` is where the value starts, `paintTo` where it ends,
// both in columns from the start of the line — measured the same way, in code points,
// because two offsets into one string that disagree about what a column is would paint
// the wrong span the first time a label or a value stopped being ASCII.
//
// ONE BUILDER FOR BOTH FORMS (#72), and `frame.indent` is why it can be: the bare form
// moves the content two columns left, so the offsets are measured from the frame's own
// indent rather than from a literal 2. A second builder for the bare row would be a
// second copy of the gate, the gutter and the clip — and the day one of them changed,
// only one form would have moved.
function rowLine({ label, value, paint }, frame, boxWidth, color) {
  const fact = textOr(value, UNKNOWN)
  const inner = frame.inner(boxWidth)
  const gutter = String(label).padEnd(LABEL_WIDTH)
  const content = clip(gutter + fact, inner)
  const text = frame.wrap(content, inner)
  if (!paint || !color) return { text }
  return {
    text,
    paintFrom: frame.indent + visibleWidth(gutter),
    paintTo: frame.indent + visibleWidth(content),
    // #75: the row names its own colour, and `render` spends it. A `paint: true` was enough
    // while yellow was the only colour in the box; the verdict row is green when it says "up
    // to date", and the alternative — `render` deciding from the label, or from whether the
    // value contains the word "available" — would put the meaning of a row in the one
    // function that is supposed to know nothing about rows.
    ink: paint,
  }
}

// The one gate every line passes through, and the two guarantees it makes: nothing
// wider than the width the caller gave us, and no escape byte in a line whose visible
// text was not painted.
//
// The clip is here rather than in each builder because "no line exceeds the width" is
// a property of the RETURN VALUE — an invariant a future row cannot forget to honour
// — and because a line that has already been painted cannot be clipped safely.
function render({ text, paintFrom, paintTo, ink }, limit) {
  const clipped = clip(text, limit)
  // TWO WAYS TO BE UNPAINTED, and both are checked because #75 split what used to be one
  // fact. While `paint` was a boolean and the opener was a constant in this function, an
  // offset with no colour was not expressible; now the opener travels WITH the row, so a
  // future builder that sets the offsets and forgets `ink` would splice the literal text
  // `undefined` into a terminal line. Unreachable today — `rowLine` is the only producer and
  // it sets all three together — and cheap enough to make unreachable by construction.
  if (paintFrom == null || !ink) return clipped
  const glyphs = [...clipped]
  const to = Math.min(paintTo, glyphs.length)
  // Nothing of the value survived the clip: emit no escapes at all rather than an
  // empty `\u001B[33m\u001B[39m` pair, which is still bytes in a log file and still a
  // lone reset for a terminal to misread.
  if (to <= paintFrom) return clipped
  return (
    glyphs.slice(0, paintFrom).join('') +
    // The COLOUR IS THE ROW'S (#75) — this function opens whichever one it was handed and
    // closes it with the one reset both of them share. It stays the only place an escape byte
    // is written, which is what keeps the clip above safely ahead of the paint.
    ink +
    glyphs.slice(paintFrom, to).join('') +
    COLOR_OFF +
    glyphs.slice(to).join('')
  )
}

// The width the box may use. Absent, negative, zero, fractional, non-finite or not a
// number at all: all of it falls back to the target rather than throwing, because
// every caller of this module reads its width off a terminal that is free to lie —
// `stdout.columns` is `undefined` on a pipe and `0` on some CI runners — and a banner
// is never worth losing a run over.
function usableWidth(width) {
  if (typeof width !== 'number' || !Number.isFinite(width)) return BANNER_WIDTH
  const columns = Math.floor(width)
  return columns >= 1 ? columns : BANNER_WIDTH
}

// A fact, or the word for not having one. Non-strings are refused rather than
// coerced: `String(value)` on a hostile object runs its `toString`, and this module
// takes its inputs from a JSON cache and a caller's argv. Trimmed, so a config value
// edited by hand with a space left behind reads as absent rather than as a version
// called `" "` — the same rule version-cache.js normalizes the cache with.
// THE SANITISATION ITSELF, applied by the three builders that take a fact — `titleLine`,
// `rowLine` and `newerVersion` — each on the way in, so `composeBanner` may push raw
// facts and no call site can forget. It is NOT applied in `render`, which is where the
// width gate lives, for one reason: `render` is where this module adds its own escapes,
// so a scrub there would either delete them or have to tell its bytes from a fact's. It
// is applied BEFORE the width accounting, so `clip` measures exactly what is printed.
//
// Trim first, replace second: `'\n'` alone is a fact that was never given (it reads as
// unknown, like any blank), while a newline BETWEEN two path segments is a fact that
// contains something unprintable and must survive as such.
//
// It also closes the hint's door a second time. `newerVersion` compares what comes out
// of here, so a cached `latest_version` of `'2.0.0\u001B[31m'` is still not semver after
// the replacement and still earns no row — the box cannot be made to announce a version
// the registry never published by hiding control bytes in the cache file.
function textOr(value, fallback) {
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

// Code points, not UTF-16 units: `[...s].length` is what keeps a surrogate pair from
// counting as two columns. It is deliberately NOT a display-width function — an
// East Asian glyph or an emoji occupies two cells and is counted here as one, so a
// path full of them can still look wider than the box. Modelling that needs a
// character-width table this package will not carry for a banner; the guarantee this
// module makes is stated in code points, and the tests measure it the same way.
function visibleWidth(text) {
  return [...text].length
}

// Cut to `columns`, marking that something was cut. The ellipsis REPLACES a column
// rather than being appended to one, so a clipped string is exactly as wide as it was
// asked to be.
function clip(text, columns) {
  if (columns <= 0) return ''
  const glyphs = [...text]
  if (glyphs.length <= columns) return text
  return glyphs.slice(0, columns - 1).join('') + ELLIPSIS
}
