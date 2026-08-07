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

// Read ralph.config.sh at `path` and return the raw TASK_SOURCE value ('' when
// the file is missing/unreadable or the setting is absent). Injectable fs for
// tests.
export function readConfigSource(path, { exists = realExistsSync, readFile = realReadFileSync } = {}) {
  try {
    if (!path || !exists(path)) return ''
    return parseConfigSource(readFile(path, 'utf8'))
  } catch {
    return ''
  }
}
