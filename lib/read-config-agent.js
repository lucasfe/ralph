// Read the RALPH_AGENT assignment out of ralph.config.sh WITHOUT sourcing it
// (#554). The bash loop sources the file, but the JS cycle preflight only needs
// the one value to decide which auth probe to run, so a tiny text parse avoids
// shelling out. Returns the raw value ('' when absent) — the caller passes it
// through resolveAgent for validation/fallback.
//
// Recognizes: `RALPH_AGENT=codex`, `RALPH_AGENT="codex"`, `RALPH_AGENT='codex'`,
// an optional `export` prefix, and surrounding whitespace. Commented lines
// (leading `#`) are ignored. The LAST uncommented assignment wins (bash
// semantics). Never throws.

import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { parseConfigVar } from './parse-config-var.js'

export function parseConfigAgent(text) {
  return parseConfigVar(text, 'RALPH_AGENT')
}

// Read ralph.config.sh at `path` and return the raw RALPH_AGENT value ('' when
// the file is missing/unreadable or the setting is absent). Injectable fs for
// tests.
export function readConfigAgent(path, { exists = realExistsSync, readFile = realReadFileSync } = {}) {
  try {
    if (!path || !exists(path)) return ''
    return parseConfigAgent(readFile(path, 'utf8'))
  } catch {
    return ''
  }
}
