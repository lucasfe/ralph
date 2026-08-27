// Read the TASK_SOURCE assignment out of ralph.config.sh WITHOUT sourcing it
// (#565). The cycle preflight needs this one value to decide whether gh auth is
// required (github) or not (folder), so a tiny text parse avoids shelling out.
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
// Separate from readConfigSource below because a caller wanting TWO settings out of
// this file must read it ONCE (`ralph start` needs the source and the digest interval;
// `ralph status` needs the source and the same interval, #63) — reading it twice would
// let a config rewritten in between answer the two questions differently. Shared
// rather than copied into each command, so there is one never-throws guard around
// this file instead of one per caller.
export function readConfigText(path, { exists = realExistsSync, readFile = realReadFileSync } = {}) {
  try {
    if (!path || !exists(path)) return ''
    return readFile(path, 'utf8')?.toString() || ''
  } catch {
    return ''
  }
}

// Read ralph.config.sh at `path` and return the raw TASK_SOURCE value ('' when
// the file is missing/unreadable or the setting is absent). Injectable fs for
// tests.
export function readConfigSource(path, deps = {}) {
  return parseConfigSource(readConfigText(path, deps))
}
