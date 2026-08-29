// #68 — the banner's COMPOSITION: resolved facts in, terminal lines out.
//
// lib/sprite-data.js is the pixels, lib/sprite-render.js turns them into strings and
// lib/sprite-banner.js decides whether they may be drawn at all (#67). None of them
// knows a single fact about the run. This module is the other half of the banner: the
// box under the sprite that says which Ralph this is, and it knows nothing about
// pixels. #68 gives it its first two facts — the installed version and the working
// directory — plus the one piece of advice the box carries, an update hint.
//
// #122 SPLIT IT IN TWO, and the seam is "columns" versus "text". This file is the FRAME half:
// the width ladder, the two line forms, the label gutter, the code-point clip and the one
// function that writes an escape byte. WHICH SENTENCE a fact earns is lib/banner-rows.js's
// half, and this one is deliberately ignorant of it — it asks `bannerRows` for a list of
// `{ label, value, paint }` records and paints them without knowing what any of them means.
// The only fact named in this file is the box's SUBJECT, the version in its title, which needs
// no label to say so; banner-rows.qa.test.js asserts that ignorance as a property of this text,
// because both arrangements draw the same box and no rendered line could show the difference.
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
// three, so no caller has to be revisited to teach the banner a new fact. Every one of those
// slices landed in the row half, which is what #122 finally drew a line around; #72's width
// degradation is the one that came home to roost HERE, and it is the reason this half exists
// at all: the whole ladder — unbox under 44 columns, no sprite under 26 — is `bannerLayout`
// below, decided from the injected `width` alone, which is what makes every rung of it
// testable without a terminal. lib/sprite-banner.js asks the same function rather than keeping
// its own copy of 26.
//
// ONE IMPORT, still, and #122 changed which one: the row half. The semver rule the update
// machinery owns went with the two rows that ask it, so what this file borrows now is exactly
// the row list, the word for a fact nobody gave us, the gate that decides what counts as a
// fact, and the reset that closes a painted span. The edge runs one way — the row half cannot
// see this one, which is what keeps a cycle out of the first line of every run.
import { COLOR_OFF, UNKNOWN, bannerRows, textOr } from './banner-rows.js'

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

// The value column. `update` and `cwd` were #68's labels; #69's `context` is the longest one
// this box draws, which is why the gutter is eight rather than seven — one space of air after
// the longest label there will ever be here, so adding a row never re-flows the ones above it.
//
// #122 LEFT IT HERE, on this side of the seam, and that is the whole shape of the split: a
// gutter is a number of COLUMNS, so the half that knows how wide the terminal is owns it. The
// row MODULE never mentions it — banner-rows.test.js sweeps its source for the name — and the
// claim that actually matters is made about the labels instead: every one of them fits this
// number, with air after the longest.
//
// EXPORTED for the specs that make that claim, on both sides of the seam, so a gutter of nine
// is one edit rather than four. The QA oracles still restate `8` on purpose: an oracle written
// from the module it audits is satisfied by any mistake the module and it agree on.
export const LABEL_WIDTH = 8

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
 * @param {object} [options.facts] fully-resolved facts about the run. This module reads
 *   exactly one of them — `version`, the box's SUBJECT, drawn as the title because a title
 *   needs no label to say so — and hands the whole bag to lib/banner-rows.js, which decides
 *   which of the rest earns a row and what that row says. The fact list is documented there,
 *   at `bannerRows`, so that there is one place to read it rather than two that can drift.
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

  // THE ROWS ARE ASKED FOR, NOT BUILT (#122). What each fact says, which facts earn a row at
  // all and the order they sit in are lib/banner-rows.js's decisions; this function's job
  // starts at "here is a list of records" and ends at "here are lines no wider than `limit`".
  // That is why nothing below names a fact: a `label === 'update'` here would be this half
  // holding an opinion about a row's meaning, which is exactly what #75 took out of `render`.
  //
  // RAW FACTS GO THROUGH. The records carry whatever survived the row half's own gates, and
  // the two builders below gate again on the way in — `titleLine` and `rowLine` through
  // `textOr`, which is the row half's gate borrowed rather than a second copy of it. An
  // invariant that lives in the one function every row goes through cannot be forgotten by
  // the next row; one applied at each push site can.
  const rows = bannerRows(facts)

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

// `╭─ ralph 0.22.0 ─────╮`, or just `ralph 0.22.0` where there is no room for a frame at
// all (#72). The version is IN the title rather than on a row of its own: it is
// the box's subject, the one fact a reader wants before they have decided to read
// anything, and a title needs no label to say so. Which is also why the bare form is the
// same sentence unadorned rather than a row — dropping the frame must not
// change what the banner SAYS, only how much ink is around it.
//
// Takes the RAW fact and gates it here, for the reason given at `rowLine`: the
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
// applied at each push site can. #69 added three rows to that list and rebuilt a fourth,
// and #70 adds bullets; if the sanitisation sat at the push sites in lib/banner-rows.js,
// a plain-looking `{ label, value: facts.repo }` would re-open all three of the hostile-fact
// defects at once — a `\n` out of GH_REPO or a hand-edited `.git/config` forging an unframed
// line outside the width guarantee, an ESC leaking into a run that promised none, and
// `gutter + value` coercing a hostile object's `toString` on a value that came from a JSON
// cache. That the row half ALSO gates whatever it concatenates is not a duplication to be
// tidied away: a builder that gates what it is given is a rule, and idempotence is what makes
// keeping both cheap.
//
// Which is also why the concatenation below is safe to write plainly: `fact` is a string
// by construction, because `textOr` refuses everything that is not one. `label` takes no
// gate because labels are literals in lib/banner-rows.js, never facts.
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
  // empty opener-and-reset pair, which is still bytes in a log file and still a
  // lone reset for a terminal to misread.
  if (to <= paintFrom) return clipped
  return (
    glyphs.slice(0, paintFrom).join('') +
    // The COLOUR IS THE ROW'S (#75) — this function opens whichever one it was handed and
    // closes it with the one reset both of them share, which is lib/banner-rows.js's constant
    // because that is where the two openers live and #75's argument is that all three are one
    // decision. It stays the only place an escape byte is written, which is what keeps the
    // clip above safely ahead of the paint.
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
