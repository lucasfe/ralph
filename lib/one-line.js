// One line, whatever the text was. Two functions, no imports (#61, extracted by #108).
//
// WHY THIS IS A MODULE OF ITS OWN, since `oneLine` shipped inside lib/digest.js and worked fine
// there. `ralph doctor` prints a warning about RALPH_AGENT, and that warning has to be worded
// safely — but doctor's import graph is PINNED, by a test that walks it
// (lib/commands/doctor.version-line.qa.test.js), to exactly node:fs, node:os, node:path and
// picocolors. That pin is not fussiness: doctor is the command you run when the machine is
// already broken, so it may not depend on execa, on the network, or on anything that can hang
// while you are trying to find out what is wrong. lib/digest.js imports execa. So a seven-line
// pure function that everybody needs lived behind an exec dependency, and #75 chose to document
// the resulting gap rather than smuggle a refactor into a cosmetics PR. This is that refactor,
// made deliberately, and it is the third of its kind: lib/parse-config-var.js and
// lib/read-config-source.js are both a handful of pure lines pulled out of a heavier module for
// exactly this reason. THIS FILE IMPORTS NOTHING AND MUST KEEP IMPORTING NOTHING — one import
// here reaches every command in the repo, and lib/one-line.test.js fails if one appears.
//
// WHY TWO FUNCTIONS RATHER THAN ONE WITH A FLAG. They make different promises about the same
// hostile text, and the difference is whose sentence it is:
//
//   oneLine     — OUR sentence about someone else's text (an agent's stderr, an exception, a
//                 page of it). Normalising is a kindness: collapse the whitespace, cap it, and
//                 a reader greps one line per failure.
//   oneLineEcho — THEIR value, quoted back at them. Normalising here would LIE. `resolveAgent`
//                 promises the original, untrimmed, original-case value, because a user who
//                 typed three trailing spaces needs to see three trailing spaces to learn that
//                 the padding was not the problem. So this one changes nothing except the
//                 characters that no terminal can be trusted with, one for one.
//
// WHAT THE CONTROL CLASS IS AND WHY IT IS REPLACED RATHER THAN STRIPPED. #108's report: a
// RALPH_AGENT containing a newline made ONE write emit TWO lines, and the second one read as a
// row of `ralph doctor`'s identity box in a pasted bug report — a line composed by nobody, in a
// diagnostic whose whole job is to be trusted. Collapsing whitespace already neutralises LF, CR,
// TAB and U+2028/U+2029, but it leaves the characters that COMMAND a terminal rather than break a
// line (ESC and its C1 twins, BEL, BS, and the DEL/C1 block) and it leaves U+0085 NEL, which ends
// a line and is not in JavaScript's `\s`. Hence the class below. And they become U+FFFD rather
// than nothing, which is the argument lib/banner-compose.js already writes out at length for the
// facts in the box: a stripped value silently MISREPRESENTS what was set — `codx` with a NUL in
// the middle is not `codx`, and showing the second tells the user their setting is something it
// is not — while a placeholder says "there is a character here you cannot see", which is true.
// The SCRUB is one code point in, one code point out, and the count is part of the honesty —
// which is a promise about the replacement pass and NOT about either function end to end:
// `oneLine` also collapses runs and trims, and `cap` truncates. Nothing here preserves length.
//
// Every byte in that class is spelled as an escape rather than typed, which is #107's rule for
// this repo's source: a raw control byte makes `file` call the file `data`, and grep, rg and
// git grep then skip it in silence while Node reads it perfectly well.

// A one-line diagnostic is a promise about SHAPE, and the text it flattens is somebody else's,
// so it is collapsed and capped rather than trusted. Shared by both functions: an echo needs the
// same bound for a reason the diagnostic never had — a very long single line, SOFT-wrapped by the
// terminal, puts arbitrary text at column zero underneath a box with no line break in it at all.
export const DIAGNOSTIC_MAX_CHARS = 200

// C0 (minus nothing — the whitespace collapse gets first refusal at TAB/LF/CR in `oneLine`, and
// in `oneLineEcho` they are exactly the characters we are here for), DEL, the C1 block including
// U+0085 NEL and U+009B CSI, and the two Unicode line terminators.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu
const PLACEHOLDER = '\uFFFD'

// Truncation says so, with the one character that means "there was more". The ellipsis REPLACES
// the last allowed character rather than being appended past it, so a capped string is exactly as
// long as it was asked to be and a caller doing its own width arithmetic is not off by one.
//
// COUNTED AND SLICED IN CODE POINTS, never in UTF-16 units — the same `[...s]` lib/banner-compose.js's
// `clip`/`visibleWidth` spend on it, so the two agree by decision rather than by coincidence. A unit
// slice halves a surrogate pair, and a halved pair has no UTF-8 encoding: Node substitutes U+FFFD on
// the way to the stream, which would have this module showing a "character you cannot see" mark the
// value never contained. It also stops the bound counting what it is named after (200 units of emoji
// is 100 characters). lib/one-line.qa.test.js drives both. An ill-formed string the CALLER supplied
// still passes through untouched: we may hand back what we were given, and may not invent it.
function cap(text) {
  const points = [...text]
  return points.length > DIAGNOSTIC_MAX_CHARS
    ? `${points.slice(0, DIAGNOSTIC_MAX_CHARS - 1).join('')}…`
    : text
}

// OUR sentence about someone else's text. Collapse, scrub, trim, cap — in that order, because
// collapsing FIRST turns a run of newlines and indentation into one space instead of a row of
// placeholders, and trimming AFTER the scrub means a leading NUL is still visible (it is not
// whitespace once it is a placeholder, and it was never whitespace to begin with). Total and
// idempotent: the engine and the CLI shell both apply it to the same string.
export function oneLine(text) {
  const collapsed = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(CONTROL, PLACEHOLDER)
    .trim()
  return cap(collapsed)
}

// THEIR value, echoed back. No collapse and no trim — see the note above about whose sentence
// this is — so the only difference between input and output is that nothing left in it can end
// the line or drive the terminal.
export function oneLineEcho(value) {
  return cap(String(value ?? '').replace(CONTROL, PLACEHOLDER))
}
