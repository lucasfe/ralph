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
// bullets, #72's width degradation and #75/#76's reuse from `ralph doctor` and
// `ralph status` all fit inside these three, so no caller has to be revisited to teach
// this module a new fact.
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
 * exported so a caller (and #72's degradation ladder) can reason about the box's size
 * without re-deriving it.
 */
export const BANNER_WIDTH = 60

// The value column. `update` and `cwd` are this slice's labels; #69's longest is
// `context`, which is why the gutter is eight rather than seven — one space of air
// after the longest label there will ever be here, so adding a row never re-flows
// the ones above it.
const LABEL_WIDTH = 8

// The frame. U+256D-family rounded corners, matching nothing else in this codebase
// because nothing else in it draws a box — `ralph status` uses a label column and no
// rule at all. Unicode rather than `+---+`: this box goes wherever the sprite's
// U+2580 does, and #72 owns the terminal that can render neither (it unboxes).
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
const YELLOW = '\u001B[33m'
const YELLOW_OFF = '\u001B[39m'

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
// The bullet glyph is U+2022, which goes wherever the frame's U+256D goes (#72 owns the
// terminal that can render neither). It is a PREFIX applied to a fact, so the builder
// below applies it AFTER the gate — see `whatsNewRows`.
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
 * @param {number} [options.width] the terminal's column count. Absent or unusable
 *   falls back to BANNER_WIDTH; every returned line is guaranteed no wider.
 * @param {object} [options.capabilities] what the terminal will accept. `color`
 *   permits ANSI; with it off, not one escape byte is emitted.
 * @returns {string[]} the lines to print, top rule first, never empty
 */
export function composeBanner({ facts = {}, width = BANNER_WIDTH, capabilities = {} } = {}) {
  // The width the CALLER promised, and the width the box is DRAWN at. They differ on
  // a wide terminal (the box holds its 60) and on a narrow one (the box is drawn at
  // the terminal's width), and both are needed: the second decides the layout, the
  // first is the guarantee every line is finally held to.
  const limit = usableWidth(width)
  const boxWidth = Math.min(limit, BANNER_WIDTH)
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
    rows.push({ label: 'update', value: `${newer} available — run \`ralph update\``, paint: true })
  }
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
    titleLine(facts?.version, boxWidth),
    ...rows.map((row) => rowLine(row, boxWidth, color)),
    bottomLine(boxWidth),
  ].map((line) => render(line, limit))
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

// `╭─ ralph 0.22.0 ─────╮`. The version is IN the rule rather than on a `version` row
// of its own: it is the box's subject, the one fact a reader wants before they have
// decided to read anything, and a title needs no label to say what it is.
//
// Takes the RAW version and gates it here, for the reason given at the rows above: the
// gate belongs to the builder, never to the call site.
function titleLine(version, boxWidth) {
  const title = `ralph ${textOr(version, UNKNOWN)}`
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
  return { text: head + RULE.repeat(Math.max(0, boxWidth - visibleWidth(head) - 1)) + TOP_RIGHT }
}

function bottomLine(boxWidth) {
  return { text: BOTTOM_LEFT + RULE.repeat(Math.max(0, boxWidth - 2)) + BOTTOM_RIGHT }
}

// `│ label   value │`, with the value clipped to fit and the row padded so the right
// border lines up with the ones above and below it.
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
function rowLine({ label, value, paint }, boxWidth, color) {
  const fact = textOr(value, UNKNOWN)
  const inner = Math.max(0, boxWidth - 4)
  const gutter = String(label).padEnd(LABEL_WIDTH)
  const content = clip(gutter + fact, inner)
  const text = `${SIDE} ${content}${' '.repeat(Math.max(0, inner - visibleWidth(content)))} ${SIDE}`
  if (!paint || !color) return { text }
  return { text, paintFrom: 2 + visibleWidth(gutter), paintTo: 2 + visibleWidth(content) }
}

// The one gate every line passes through, and the two guarantees it makes: nothing
// wider than the width the caller gave us, and no escape byte in a line whose visible
// text was not painted.
//
// The clip is here rather than in each builder because "no line exceeds the width" is
// a property of the RETURN VALUE — an invariant a future row cannot forget to honour
// — and because a line that has already been painted cannot be clipped safely.
function render({ text, paintFrom, paintTo }, limit) {
  const clipped = clip(text, limit)
  if (paintFrom == null) return clipped
  const glyphs = [...clipped]
  const to = Math.min(paintTo, glyphs.length)
  // Nothing of the value survived the clip: emit no escapes at all rather than an
  // empty `\u001B[33m\u001B[39m` pair, which is still bytes in a log file and still a
  // lone reset for a terminal to misread.
  if (to <= paintFrom) return clipped
  return (
    glyphs.slice(0, paintFrom).join('') +
    YELLOW +
    glyphs.slice(paintFrom, to).join('') +
    YELLOW_OFF +
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
