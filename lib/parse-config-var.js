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
  // `[^\n]` AND NOT `.` (#133). In a JS regex `.` matches no LINE TERMINATOR — not LF,
  // and not CR, U+2028 or U+2029 either — so a line holding one of those three in the
  // MIDDLE of a value matched nothing here at all: the loop skipped it, and the function
  // returned '' (or, worse, an earlier assignment's value) for a line bash reads whole.
  // Measured, before and after:
  //
  //   $ printf 'JIRA_JQL="a<U+2028>b"\n' > line.sh && bash -n line.sh   # exit 0
  //   $ bash -c 'set -a; . ./line.sh; set +a; printf "[%s]" "$JIRA_JQL"'
  //   [a<U+2028>b]                     # and [a<CR>b] for the CR spelling
  //   > parseConfigVar(text, 'JIRA_JQL')   // was '' — while configAssignsVar said true
  //
  // That mattered most for JIRA_JQL, whose readers split: templates/ralph.sh SOURCES the
  // file, so the loop got the user's query, while `ralph cycle` and `ralph status` read it
  // through here and got "not configured" — depth 0, and a run that says the queue is
  // empty. U+2028 is reachable by PASTING a query (measured in lib/init.qa.test.js: real
  // readline hands both separators back intact), which is what took this from a curiosity
  // to a fix.
  //
  // The lines are already split at LF, so they cannot contain one and this class is
  // exactly "the rest of this line". CRLF endings are untouched: `+?` is lazy, so a
  // trailing \r still falls to the `\s*$` that has always eaten it (pinned in
  // parse-config-var.qa.test.js, which measures the widened class against a real bash).
  const assign = new RegExp(`${assignmentHead(varName)}\\s*([^\\n]+?)\\s*$`)
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
    // comment only opens at a `#` beginning a WORD. For the knobs this trade was struck
    // for — RALPH_AGENT, TASK_SOURCE, RALPH_DIGEST_INTERVAL, RALPH_DIGEST_MODEL, none of
    // which accept a `#` — neither bash answer was a legal value, so the divergence only
    // fired where bash's reading was going to be rejected anyway, and it fired on exactly
    // how a user comments a knob out while keeping the note.
    //
    // JIRA_JQL (#126) IS THE FIRST KNOB READ THROUGH HERE WHOSE VALUE MAY HOLD A `#`, so
    // that trade no longer covers every caller, and the truncation is UNFIXED. A JQL text
    // search on a ticket reference is ordinary (`summary ~ "#123"`, `text ~ "#urgent"`), and
    // spelled with the inner quotes escaped — `JIRA_JQL="summary ~ \"#123\""` — the lazy pair
    // below closes on the first inner quote and the rest is taken for a comment: the value
    // reads as `summary ~ \`, where bash keeps the whole thing. Jira then rejects the
    // composed query, acli exits non-zero, and `ralph cycle` reads that as an empty queue —
    // so a cron'd jira run sleeps forever instead of erroring once. Avoiding the collision is
    // the workaround until this is addressed, and either spelling does it: quote the VALUE with
    // single quotes (`JIRA_JQL='summary ~ "#123"'`), or spell the JQL LITERAL with them
    // (`JIRA_JQL="summary ~ '#123'"`). Both were measured against a real bash rather than
    // reasoned about; what the suite PINS is the failure, at both commands that would suffer
    // it — "TRUNCATES a value whose JQL literal is double-quoted and followed by a hash", in
    // lib/commands/cycle.qa.test.js and lib/commands/status.qa.test.js — plus the
    // single-quoted JQL literal reaching acli whole, on a fixture without a `#` in it.
    //
    // parse-config-var.qa.test.js measures every shape named here against a real bash and
    // pins the difference as a table.
    //
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
