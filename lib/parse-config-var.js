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
    // ONE rule for quotes and inline comments (#62). QUOTED: a matching pair followed by
    // nothing but an optional comment, and the pair's contents ARE the value, `#` and all
    // (`"fol#der"`, `'# literal'`, `"30m" # every half hour` → `30m`). UNQUOTED: the
    // value ends at a `#` that starts a word, the way bash ends it (`codex # note`).
    //
    // Two DELIBERATE divergences from bash's COMMENT rule, one trade: a leading `#`
    // (`VAR=#off` → '') and a `#` glued to a closing quote (`VAR="30m"#note` → `30m`)
    // are comments here, where bash keeps them as data (`#off`, `30m#note`) because a
    // comment only opens at a `#` beginning a WORD. Neither bash answer is a legal value
    // of any knob read through here — RALPH_AGENT, TASK_SOURCE, RALPH_DIGEST_INTERVAL,
    // RALPH_DIGEST_MODEL, none of which accept a `#` — so the divergence only fires where
    // bash's reading was going to be rejected anyway, and it fires on exactly how a user
    // comments a knob out while keeping the note. parse-config-var.qa.test.js measures
    // every shape named here against a real bash and pins the difference as a table.
    // The body is LAZY, and that is load-bearing: it closes the pair at the FIRST quote
    // whose tail is a comment or nothing, so a quote inside the comment stays in the
    // comment. Greedy, `VAR="30m" # not "2h"` would close on the last quote on the line
    // and read the value as `30m" # not "2h` — bash reads `30m`.
    //
    // The one shape this reads as a pair where bash would not is adjacent-word
    // concatenation (`"a""b"` → `a""b`, where bash says `ab`), a divergence this parser
    // predates #62 with and still does not model.
    const quoted = raw.match(/^(["'])([\s\S]*?)\1(?:\s*#.*)?$/)
    if (quoted) raw = quoted[2]
    // No pair at all. Strip a comment only if the value never OPENED a quote, because a
    // value that did is either unterminated ON THIS LINE (`VAR="`, `VAR="30m # note`) — a
    // syntax error to the shell that sources this file unless a LATER line closes it,
    // which is a multi-line value this line-based parser has never modelled (bash reads
    // `X="30m` + `still the value"` as one value spanning both lines; this reads `"30m`)
    // — or closed and then continued (`VAR="30m"extra`). Both are left exactly as
    // written, to be rejected downstream, rather than guessed at. No knob read through
    // here can hold a multi-line value, so the reading this declines to take is one no
    // caller could have used. parse-config-var.test.js pins all three.
    else if (raw[0] !== '"' && raw[0] !== "'") raw = raw.replace(/(^|\s+)#.*$/, '').trim()
    value = raw
  }
  return value
}
