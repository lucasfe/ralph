// Extract a single `VAR=value` assignment out of ralph.config.sh text WITHOUT
// sourcing it (#554, #565). The bash loop sources the file, but the JS layer only
// needs a named setting or two out of it (RALPH_AGENT, TASK_SOURCE,
// RALPH_DIGEST_INTERVAL) to make a decision, so a tiny text parse avoids shelling
// out. Takes TEXT rather than a path, so a caller wanting two settings reads the
// file once and asks twice — see lib/commands/start.js. Returns the raw value (''
// when absent) — the caller passes it through the relevant registry
// (resolveAgent/resolveSource) or its own guard for validation/fallback.
//
// `configAssignsVar` at the bottom answers the one thing that '' cannot distinguish:
// whether the file assigned the name at all. Both share one definition of what an
// assignment is, so the two cannot disagree about it (#118).
//
// Recognizes: `VAR=value`, `VAR="value"`, `VAR='value'`, an optional `export`
// prefix, and surrounding whitespace. Commented lines (leading `#`) are ignored.
// The LAST uncommented assignment wins (bash semantics). Never throws.

// Escape a variable name for safe embedding in the assignment regex.
function escapeName(name) {
  return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The HEAD of the grammar — optional `export`, optional space, the name, optional space, the `=` —
// and the reason it is a function rather than two copies of a regex. Both readers in this module
// have to agree about what an assignment IS: `parseConfigVar` appends a value to this and answers
// what bash would have read, `configAssignsVar` stops here and answers whether bash would have
// assigned anything at all. Written twice, the pair would drift the first time this grammar is
// revised — it already has been once (#62 reworked the quote and inline-comment rule) — and the
// drift would be silent, because each function would still look right on its own.
function assignmentHead(varName) {
  return `^\\s*(?:export\\s+)?${escapeName(varName)}\\s*=`
}

export function parseConfigVar(text, varName) {
  if (!text || !varName) return ''
  const assign = new RegExp(`${assignmentHead(varName)}\\s*(.+?)\\s*$`)
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

// Does the file ASSIGN this variable at all — the question `parseConfigVar` cannot answer, because
// it returns '' both for a file that never mentions the name and for one that sets it to nothing
// (#118). Those two answers part company in the shell that sources this file: an absent assignment
// leaves an exported value alone, a blank one OVERWRITES it. Measured, and the canonical record of
// it — the two files that act on this behaviour point here rather than repeating the transcript:
//
//   $ printf 'RALPH_AGENT=""\n' > c.sh
//   $ RALPH_AGENT=codx bash -c 'set -a; . ./c.sh; set +a; printf "[%s]" "$RALPH_AGENT"'
//   []
//
// Empty, for `=""`, `=''`, `=` and `export RALPH_AGENT=` alike, because assigning the empty string
// is still assigning. Only a caller that must PREDICT what the loop will see needs this — a JS
// reader deciding what to report about a run bash is about to start (lib/commands/start.js) — and
// for it, `configAssignsVar(text, N) ? parseConfigVar(text, N) : null` is the whole precedence: a
// present value wins even when blank, and only a truly absent one falls through to the process env.
// A truthiness test on `parseConfigVar` alone gets the blank case backwards.
//
// Deliberately NOT folded into `parseConfigVar` as a nullable return: that function is read for
// half a dozen knobs (TASK_SOURCE, RALPH_BANNER, the digest pair) whose precedence rules differ
// from each other, and one of them deliberately reverses this one. Presence is a separate question,
// so it gets a separate answer, and the callers that do not care are not made to handle a null.
export function configAssignsVar(text, varName) {
  if (!text || !varName) return false
  const head = new RegExp(assignmentHead(varName))
  // Same two rules the loop above applies, in the same order: a line commented out is not an
  // assignment, and the name must end at the `=` so RALPH_AGENTX is a different knob. Anything
  // this says yes to, `parseConfigVar` reads a value out of — possibly the empty string, which is
  // the case this function exists for. parse-config-var.test.js pins that implication as a table.
  return String(text)
    .split('\n')
    .some((line) => !/^\s*#/.test(line) && head.test(line))
}
