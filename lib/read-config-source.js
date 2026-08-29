// Read the TASK_SOURCE assignment out of ralph.config.sh WITHOUT sourcing it
// (#565). The cycle preflight needs this one value to decide whether gh auth is
// required (every source but folder) or not (folder), so a tiny text parse avoids
// shelling out.
// Returns the raw value ('' when absent) — the caller passes it through
// resolveSource for validation/fallback. See parse-config-var.js for the shared
// assignment grammar. Never throws.

import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { parseConfigVar } from './parse-config-var.js'

export function parseConfigSource(text) {
  return parseConfigVar(text, 'TASK_SOURCE')
}

// ralph.config.sh as TEXT, '' when the file is missing or unreadable. NEVER THROWS:
// a config nobody can read leaves every setting at its default rather than aborting a
// launch or breaking a read-only view.
//
// TEXT rather than a parsed value, because a caller wanting TWO settings out of this
// file must read it ONCE — `ralph start` and `ralph cycle` want the source and the
// digest interval, `ralph status` asks FOUR questions of one read (source, digest
// interval, RALPH_BANNER, JIRA_JQL — #63, #126), and `ralph doctor` reads it for the
// source. Reading it twice would let a config rewritten in between answer the two
// questions differently. Shared rather than copied into each command, so there is one
// never-throws guard around this file instead of one per caller.
//
// There is deliberately no read-and-parse one-liner beside it any more. There was one
// — `readConfigSource(path)`, i.e. `parseConfigSource(readConfigText(path))` — and #126
// orphaned it when `ralph cycle`, its last caller, grew a second question to ask of the
// same text. Every consumer now spells the two steps out, which is the shape that
// survives a caller wanting one more setting; a wrapper that reads and parses in one
// call is the shape that has to be abandoned the moment it does.
export function readConfigText(path, { exists = realExistsSync, readFile = realReadFileSync } = {}) {
  try {
    if (!path || !exists(path)) return ''
    return readFile(path, 'utf8')?.toString() || ''
  } catch {
    return ''
  }
}
