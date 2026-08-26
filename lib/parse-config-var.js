// Extract a single `VAR=value` assignment out of ralph.config.sh text WITHOUT
// sourcing it (#554, #565). The bash loop sources the file, but the JS layer only
// needs a named setting or two out of it (RALPH_AGENT, TASK_SOURCE,
// RALPH_DIGEST_INTERVAL) to make a decision, so a tiny text parse avoids shelling
// out. Takes TEXT rather than a path, so a caller wanting two settings reads the
// file once and asks twice — see lib/commands/start.js. Returns the raw value (''
// when absent) — the caller passes it through the relevant registry
// (resolveAgent/resolveSource) or its own guard for validation/fallback.
//
// Recognizes: `VAR=value`, `VAR="value"`, `VAR='value'`, an optional `export`
// prefix, and surrounding whitespace. Commented lines (leading `#`) are ignored.
// The LAST uncommented assignment wins (bash semantics). Never throws.

// Escape a variable name for safe embedding in the assignment regex.
function escapeName(name) {
  return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function parseConfigVar(text, varName) {
  if (!text || !varName) return ''
  const assign = new RegExp(`^\\s*(?:export\\s+)?${escapeName(varName)}\\s*=\\s*(.+?)\\s*$`)
  let value = ''
  for (const line of String(text).split('\n')) {
    if (/^\s*#/.test(line)) continue
    const m = line.match(assign)
    if (!m) continue
    let raw = m[1].trim()
    // Strip an inline comment on an unquoted value (e.g. `codex # note`).
    if (raw[0] !== '"' && raw[0] !== "'") {
      raw = raw.replace(/\s+#.*$/, '').trim()
    }
    // Strip matching surrounding quotes.
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1)
    }
    value = raw
  }
  return value
}
