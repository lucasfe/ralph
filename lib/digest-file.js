// `.ralph/digest.log` — WHERE IT LIVES, HOW IT IS SPELLED, AND WHEN IT IS DUE.
//
// Four modules need some of this and none of them should have to import another to get
// it: lib/digest.js WRITES the file, lib/digest-history.js READS it, lib/commands/
// start.js opens the window that fills it, and lib/commands/status.js shows the latest
// entry from it. Before this module existed the reader and the two commands reached
// into the writer, which put the status view — a command people run from a shell prompt
// — one import away from execa and the digest engine, and closed lib/commands/status.js
// and lib/digest.js into the repo's only import cycle (lib/digest.js borrows
// `collectStatus` for its context, which is an inversion this file's existence keeps
// from becoming a loop).
//
// PURE, AND THE POINT OF IT IS THAT IT STAYS THAT WAY: no fs, no exec, no clock, no
// config path. It holds constants and two total functions over text. Anything that
// needs a side effect belongs in one of the four modules above, so that importing the
// file's grammar can never cost a caller anything at import time.
//
// ONE SET OF LITERALS FOR THE WRITER AND THE READER. `formatHistoryEntry`
// (lib/digest.js) composes an entry out of these and `parseLatestDigest`
// (lib/digest-history.js) takes one apart with the same ones, so the format cannot be
// changed on one side only — which used to be true by test and is now also true by
// construction. The pad WIDTH deliberately stays with the writer: the reader strips the
// trailing `─` run by anchoring on the end of the line, so it never needs to know how
// wide the writer padded to, and a view that changes its own width cannot break a parse.

import { join } from 'node:path'
import { parseConfigVar } from './parse-config-var.js'

// One file, appended forever, next to the run record and the metrics the same directory
// already holds.
const HISTORY_FILE = 'digest.log'

export function digestLogPath(projectRoot) {
  return join(projectRoot, '.ralph', HISTORY_FILE)
}

// THE ENTRY FORMAT. `\n── {at} · run {id} · {task} · {model} ───…\n`, then every
// narrative line at ENTRY_INDENT, then a blank line. Each of these three is load-bearing
// and the reasoning for each is on `formatHistoryEntry`, which is where an entry is
// built; in short, the indent is what keeps a narrative that begins `── ` from forging a
// heading of its own, and it is why `grep '^── '` counts entries exactly.
export const HEADING_PREFIX = '── '
export const FIELD_SEPARATOR = ' · '
export const ENTRY_INDENT = '  '

// The writer's words for a field it had nothing to put in — a record too broken to name
// its run, a digest with no task in flight, an entry written before the model was a
// field. The READER treats each of these as ABSENCE rather than as data, which is only
// safe while both sides agree on the exact word, so they live here rather than twice.
export const ABSENT_RUN = 'unknown'
export const ABSENT_TASK = 'none'
export const ABSENT_MODEL = 'unknown'

// ...and the one field with no honest unknown. A stamp is what `12min ago` is computed
// from, so the reader does not treat this as absence: it fails to parse, and the whole
// entry is unusable rather than a digest of unknown age. It is spelled anyway, so a
// human reading the file sees which field the writer could not fill.
export const ABSENT_AT = 'unknown'

// The digest's interval as ralph.config.sh spells it, '' when the digest is off (#60).
// Zeroing a knob is how a shell config turns it off, and an interval of zero is not an
// interval — so ANY spelling of zero reads as off, not just a bare `0`.
// `RALPH_DIGEST_INTERVAL=0m` is the likelier way to write it, since the live value
// carries a unit. A leading-number parse is the whole test, because the value is an
// interval and the unit follows the number.
//
// TRIMMED FIRST, and that is not cosmetic (#62): a value that is only whitespace —
// one edited out by hand with a space left behind, or `="$SOMETHING_UNSET "` — says
// nothing about an interval, and `ralph digest --loop` already reads a blank one as
// no interval at all. Without the trim the two entry points disagreed and the
// disagreement was sticky: the launch box advertised `every    ` while stderr warned
// about an interval the user never set, on every launch from then on. Whitespace
// INSIDE the value is left to the grammar (./duration.js) to refuse.
//
// THREE COMMANDS, ONE READING: `ralph start` opens the window with it, `ralph digest
// --loop` waits on it, and since #63 `ralph status` measures staleness against it. A
// local copy in any of them would drift silently — the launch box saying `every 30m`
// while the status view judged lateness by something else. Takes TEXT, not a path: a
// caller wanting two settings out of ralph.config.sh reads the file once and asks twice.
export function digestInterval(configText) {
  const raw = parseConfigVar(configText, 'RALPH_DIGEST_INTERVAL').trim()
  if (raw === '') return ''
  return Number.parseFloat(raw) === 0 ? '' : raw
}
