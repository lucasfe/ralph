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
// prefix, a SPACE-OR-TAB indent before the name, and SPACE-OR-TAB padding either side of
// the value (bash assigns a value that starts or ends with anything wider, so those
// characters are kept — #147 follow-up) — with ONE deliberate exception, a CR, U+2028 or
// U+2029 at the very END of a value, which is stripped where bash keeps it, because this
// repo's line-ending policy outranks bash there (see `trimPadding` below). NOT
// whitespace between the name and the `=`, which bash reads as a command rather than an
// assignment; and NOT an indent bash does not count as a blank either — U+00A0, a UTF-8
// BOM, U+000B, U+000C, U+2028 and U+2029 are all `\s` to a JS regex and all ordinary word
// characters to bash, so a line indented with one of them is a COMMAND to the shell that
// sources this file (#147, transcripts above `assignmentHead`). Commented lines (leading
// `#`) are ignored. The LAST uncommented assignment wins (bash semantics), including when
// the last one is blank. Never throws.

// Escape a variable name for safe embedding in the assignment regex.
function escapeName(name) {
  return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The HEAD of the grammar — optional `export`, optional indent, the name, the `=` — and the reason
// it is a function rather than two copies of a regex. Both readers in this module have to agree
// about what an assignment IS: `parseConfigVar` appends a value to this and answers what bash would
// have read, `configAssignsVar` stops here and answers whether bash would have assigned anything at
// all. Written twice, the pair would drift the first time this grammar is revised — it already has
// been twice (#62 reworked the quote and inline-comment rule, #147 the whitespace) — and the drift
// would be silent, because each function would still look right on its own.
//
// THE NAME MUST END AT THE `=` (#147). There is no `\s*` in front of it, and that absence is the
// whole of one bug: `VAR = value` is not an assignment to bash, it is a COMMAND named VAR with two
// arguments, so the sourcing shell assigns nothing and keeps whatever it already held. Measured:
//
//   $ printf 'TASK_SOURCE = folder\n' > t1.sh
//   $ TASK_SOURCE=github bash -c 'set -a; . ./t1.sh; set +a; printf "[%s]\n" "${TASK_SOURCE-«unset»}"'
//   ./t1.sh: line 1: TASK_SOURCE: command not found
//   [github]
//
//   $ printf 'export TASK_SOURCE = folder\n' > t3.sh
//   $ bash -c 'set -a; . ./t3.sh; set +a; printf "[%s]\n" "${TASK_SOURCE-«unset»}"'
//   ./t3.sh: line 1: export: `=': not a valid identifier
//   [«unset»]
//
// So the JS layer used to resolve a value NO RUN WOULD EVER USE, and — worse than merely being
// wrong — it MASKED the environment the loop actually reads: the first transcript is a config line
// beating an exported `github` in `ralph start`'s box while the loop ran on `github`. The knob it
// cost the most was TASK_SOURCE, where the two answers are two different QUEUES; `RALPH_AGENT`
// (#118) and `GH_REPO` (#120) inherited it through their `configAssignsVar` presence test, which
// answered "the file set this" about a line the file's own shell ran as a command.
//
// AND THE INDENT MUST BE ONE BASH SKIPS (#147). `[ \t]*`, not `\s*` — because JS `\s` is a strict
// SUPERSET of bash's blanks, and the difference is the same bug as the one above, one character
// class over: a line this parser called an assignment while the shell sourcing the same file ran it
// as a COMMAND. The class is the shell TOKENIZER's `blank` — space and tab, and nothing else. Not
// `$IFS`: IFS splits the result of an EXPANSION into fields and has no say in how a source line is
// broken into words, which is measurable in both directions —
//
//   $ printf '\302\240TASK_SOURCE=folder\n' > c.sh              # U+00A0 put INTO IFS
//   $ TASK_SOURCE=github bash -c 'IFS=$(printf "\302\240"); set -a; . ./c.sh; set +a; printf "[%s]" "$TASK_SOURCE"'
//   ./c.sh: line 1: <U+00A0>TASK_SOURCE=folder: command not found
//   [github]                                                    # still not a blank at the head
//
//   $ printf '   TASK_SOURCE=folder\n' > d.sh                   # IFS emptied entirely
//   $ TASK_SOURCE=github bash -c 'IFS=; set -a; . ./d.sh; set +a; printf "[%s]" "$TASK_SOURCE"'
//   [folder]                                                    # a space indent still assigns
//
// — and the evidence for `[ \t]` is not a sample either: parse-config-var.boundary.qa.test.js's
// `lands on exactly the class bash accepts, swept rather than sampled` asks a real bash about all 24
// characters JS `\s` matches apart from LF, in both the indent and the post-`export` position, and
// gets exactly U+0009 and U+0020 in both. An indent of anything else leaves the name, the `=` and
// the value in ONE word:
//
//   $ printf '\302\240TASK_SOURCE=folder\n' > c.sh          # U+00A0 as the indent
//   $ TASK_SOURCE=github bash -c 'set -a; . ./c.sh; set +a; printf "[%s]" "${TASK_SOURCE-«unset»}"'
//   ./c.sh: line 1: <U+00A0>TASK_SOURCE=folder: command not found
//   [github]
//
//   $ printf '\357\273\277TASK_SOURCE=folder\n' > c.sh      # a UTF-8 BOM
//   ./c.sh: line 1: $'\357\273\277TASK_SOURCE=folder': command not found
//   [github]
//
//   $ printf '\015TASK_SOURCE=folder\n' > c.sh              # a lone CR
//   ./c.sh: line 1: $'\rTASK_SOURCE=folder': command not found
//   [github]
//
// U+000B, U+000C, U+2028 and U+2029 measure identically — `command not found`, ambient value kept.
// The `export` SEPARATOR takes the same two blanks and no others, which is why it is `[ \t]+` and
// not `\s+`; measured on the same shell (GNU bash 5.3.15, aarch64-apple-darwin25.4.0):
//
//   $ printf 'export\011TASK_SOURCE=folder\n' > c.sh        # a tab: assigns
//   [folder]
//   $ printf 'export \011 TASK_SOURCE=folder\n' > c.sh      # space and tab mixed: assigns
//   [folder]
//   $ printf 'export\013TASK_SOURCE=folder\n' > c.sh        # U+000B: one word
//   ./c.sh: line 1: $'export\vTASK_SOURCE=folder': command not found
//   [github]
//   $ printf 'export\302\240TASK_SOURCE=folder\n' > c.sh    # U+00A0: one word
//   ./c.sh: line 1: export<U+00A0>TASK_SOURCE=folder: command not found
//   [github]
//
// Nobody types these on purpose, and the exposure is not that they would: U+00A0 arrives by pasting
// a config snippet out of anything that renders HTML, and a BOM by editing the file on Windows — a
// route this module already supports for line endings (#565). The COMMENT test in the loop below
// still uses `\s`, deliberately: it decides whether to SKIP a line, so a class wider than bash's
// makes this parser read LESS than the shell, never more, and `<U+00A0>#X=v` is not an assignment to
// either program. parse-config-var.boundary.qa.test.js measures every row above.
//
// WHITESPACE AFTER THE `=` IS A DIFFERENT BASH RULE AND IS DELIBERATELY LEFT ALONE. `X= folder`
// parses fine and assigns nothing either — the `X=` is an environment prefix scoped to the command
// `folder` — and this parser still reads `folder` there:
//
//   $ printf 'TASK_SOURCE=github\nTASK_SOURCE= folder\n' > t6.sh
//   $ bash -c 'set -a; . ./t6.sh; set +a; printf "[%s]\n" "${TASK_SOURCE-«unset»}"'
//   ./t6.sh: line 2: folder: command not found
//   [github]
//
//   $ printf 'export TASK_SOURCE= folder\n' > t7.sh    # export CHANGES the answer:
//   $ bash -c 'set -a; . ./t7.sh; set +a; printf "[%s]\n" "${TASK_SOURCE-«unset»}"'
//   []                                                 # assigned, and empty
//
//   $ printf 'TASK_SOURCE=fol der\n' > t8.sh           # the same rule, no `=` in sight:
//   $ bash -c 'set -a; . ./t8.sh; set +a; printf "[%s]\n" "${TASK_SOURCE-«unset»}"'
//   ./t8.sh: line 1: der: command not found
//   [«unset»]
//
// Those three are ONE rule — where bash ends an assignment WORD — and this parser has never
// modelled it: `X= folder` is no more wrong here than `X=a b`, and the `export` line shows the rule
// is not even "a space after the `=` assigns nothing". Tightening the first and not the other two
// would leave a grammar that is bash-faithful in a way no comment can state in one sentence, so all
// three stay, pinned as divergences in parse-config-var.qa.test.js's table beside the comment ones.
// What the `=` itself decides — the head above — is a rule that CAN be stated: the name ends there.
//
// TWO THINGS THAT DECISION OWNS, rather than glosses. First, the family is internally inconsistent
// about INTENT: `RALPH_DIGEST_INTERVAL=  2h  ` is a SUPPORTED spelling here (a row in
// lib/commands/start.digest-window.qa.test.js's padded-interval table, and a launch that opens the
// window) while `TASK_SOURCE= folder` is a pinned DIVERGENCE — and bash assigns nothing for either
// one. The same `[ \t]*` below produces both readings; which of them is a feature is a judgement about
// the knob, not about the grammar, and there is no line in this regex where that judgement lives.
//
// Second, this family does not only INVENT values, it DESTROYS them. `X= ""` reads as blank here and
// `configAssignsVar` calls it PRESENT, and present-and-blank is the combination that overwrites, so
// a live earlier line is cleared — where bash leaves that line standing:
//
//   $ printf 'X=live\nX= ""\n' > t9.sh
//   $ bash -c 'set -a; . ./t9.sh; set +a; printf "[%s]\n" "${X-«unset»}"'
//   ./t9.sh: line 2: : command not found
//   [live]                                             # and this parser says ''
//
// That is the sharper direction of the same divergence and the one the transcripts above do not
// show: reading `folder` off a line bash ignores costs a wrong answer, clearing `live` off a line
// bash ignores costs the RIGHT one. Both are pinned in parse-config-var.boundary.qa.test.js.
function assignmentHead(varName) {
  return `^[ \\t]*(?:export[ \\t]+)?${escapeName(varName)}=`
}

// The PADDING around a value — and the same class question the head answers, at the other end of
// the line (#147 follow-up). It was `.trim()` and a `\s*` on each side of the value group, and JS
// `\s` is a superset of bash's blanks there too. But the failure it caused is NOT the head's: at
// the head, a wider class made this parser read a line bash never assigned. Here, BASH ASSIGNS —
// it just assigns a different string, and the extra characters this parser deleted were part of
// the value. Measured on the route templates/ralph.sh uses, with an ambient `X=AMBIENT`:
//
//   $ printf 'X=\302\240folder\n' > v.sh                # U+00A0 right after the `=`
//   $ X=AMBIENT bash -c 'set -a; . ./v.sh; set +a; printf "[%s]" "${X-«unset»}"'
//   [<U+00A0>folder]                                    # no stderr: bash ASSIGNED
//
//   $ printf 'X=folder\302\240\n' > v.sh                # U+00A0 as trailing padding
//   [folder<U+00A0>]
//
//   $ printf 'X=folder\343\200\200\n' > v.sh            # U+3000 IDEOGRAPHIC SPACE
//   [folder<U+3000>]
//
//   $ printf 'X=\302\240\n' > v.sh                      # U+00A0 as the WHOLE value
//   [<U+00A0>]                                          # and this parser said ''
//
//   $ printf 'X=folder \n' > v.sh                       # the control: a real blank
//   [folder]                                            # dropped by bash, so dropped here
//
// WHY THAT IS THE #147 DEFECT AND NOT THE SCOPE EXCLUSION ABOVE. `X= folder` is excluded because
// bash assigns NOTHING there (its WORD rule) and because a shipped configuration depends on the
// looser reading (`RALPH_DIGEST_INTERVAL=  2h  `). Neither holds here: there is a right answer to
// inherit, and no configuration depends on a no-break space being deleted. What the deletion
// produced was worse than a wrong string — it manufactured a VALID enum value out of an invalid
// one, which is exactly how #147 masked a run. Measured against the loop's own dispatch block:
//
//   $ printf 'TASK_SOURCE=\302\240folder\n' > s.sh      # and the folder<U+00A0> spelling too
//   $ TASK_SOURCE=github bash -c 'set -a; . ./s.sh; set +a' + templates/ralph.sh's dispatch
//   [github]                                            # the loop rejects it
//   > resolveSource({ TASK_SOURCE: parseConfigSource(text) })
//   'folder'                                            # and `ralph start` announced it
//
// So: `[ \t]` on both sides, in all three places that trimmed — the regex's two paddings, this
// helper where `.trim()` was, and the tail of the inline-comment strip, which called `.trim()`
// again and would have put every character above straight back in the bin.
//
// THE TRAILING LINE-ENDING CLASS STAYS WIDER, deliberately, and is the one thing here that is not
// bash's answer: a CR from a CRLF file, U+2028 and U+2029 are stripped from the END of a value
// where bash keeps them (`X=abc<CR>` is `abc<CR>` to a shell). That is this repo's line-ending
// policy, not an accident of the class — #565 for the CR, #133 for the other two — and a config
// edited on Windows must not hand a control character to `gh` or to a printed line. It is pinned
// as a divergence in parse-config-var.boundary.qa.test.js ("a line terminator at the END of a
// value"), and narrowing the class had to keep it, which is why the trailing strip names those
// three characters instead of inheriting them from `\s`.
//
// ONLY THE TRAILING HALF ACTUALLY FIRES, and the leading one is kept for symmetry rather than
// for effect — said here so the pair does not read as two live rules. Neither call site can hand
// it a string that starts with a blank: the regex's `[ \t]*` after the `=` is greedy and never
// backtracks into what it ate (the value group `[^\n]*?` can always match the rest of the line,
// so the tail never fails and never asks it to give a character back), and the comment-strip
// branch passes a PREFIX of a string this helper already trimmed. Swept rather than reasoned:
// 67,500 config lines built from every combination of the padding classes, quote and comment
// shapes, `export` prefixes and terminators above fire the trailing strip constantly and the
// leading strip zero times.
const trimPadding = (raw) =>
  String(raw)
    .replace(/^[ \t]+/, '')
    .replace(/[ \t\r\u2028\u2029]+$/, '')

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
  // empty.
  //
  // WHAT MAKES IT WORTH FIXING is that such a LINE is legal at all, not any one route to
  // writing one: bash reads `JIRA_JQL="a<U+2028>b"` as one whole value, and the template
  // invites hand edits of exactly that line ("If you edit this line by hand...",
  // templates/ralph.config.sh), so a config written by hand or by a tool reaches this
  // parser however the value got there. `ralph init` is ONE of those routes and a
  // version-dependent one: measured at the real prompt, readline hands both separators
  // back intact on every node measured from 18.20.8 up to 23.11.1 and ends the line at
  // one on 24.16.0, so a PASTED query carries a separator through init on the older
  // runtimes and cannot on the newer (both are inside this package's `>=18`; the six
  // versions actually measured, and the 23 -> 24 boundary, are pinned in
  // lib/init.qa.test.js).
  //
  // The lines are already split at LF, so they cannot contain one and this class is
  // exactly "the rest of this line". CRLF endings still lose their \r, and since the
  // padding narrowed to `[ \t]*` (#147 follow-up) the mechanism is no longer the group's
  // laziness: the trailing padding cannot match a CR, so the group is forced to KEEP it
  // and it is `trimPadding`'s trailing class — which names CR, U+2028 and U+2029 for
  // exactly this reason — that removes it. Measured on the regex this line builds:
  //
  //   > 'X=abc\r'.match(assign)[1]   // 'abc\r'  — the CR is INSIDE the group
  //   > 'X=\r'.match(assign)[1]      // '\r'     — and with an empty tail it is the whole of it
  //   > 'X=abc '.match(assign)[1]    // 'abc'    — a real blank DOES fall to the padding
  //
  // so the outcome is unchanged from when the padding was `\s*` and the reason for it is
  // not: this strip is now the only thing standing between a CRLF file and a control
  // character in a printed line. That is a DIVERGENCE from
  // bash, which keeps the CR (`X=folder<CR>` is `folder<CR>` to a shell), and a deliberate
  // one: this repo's line-ending policy, #565 for the CR and #133 for the other two. It is
  // measured against a real bash and pinned as a divergence in
  // parse-config-var.boundary.qa.test.js ("a line terminator at the END of a value").
  //
  // `*?` AND NOT `+?` (#147). Requiring a character meant a bare `VAR=` matched nothing at
  // all, so the loop SKIPPED the line — and a skipped line is not "an assignment of
  // nothing", it is "no assignment here", which left an earlier live line standing as the
  // answer. `VAR=value` then `VAR=` therefore read as `value`, breaking this module's own
  // documented rule two lines up: bash resolves a repeated key by taking the last one, and
  // the last one there is empty. Measured:
  //
  //   $ printf 'GH_REPO=committed/repo\nGH_REPO=\n' > t5.sh
  //   $ GH_REPO=ambient/repo bash -c 'set -a; . ./t5.sh; set +a; printf "[%s]\n" "${GH_REPO-«unset»}"'
  //   []
  //
  // The spelling with a note on it — `VAR= # off for now` — always worked, because the
  // comment gave the group something to match and the strip below then removed it. So the
  // rule held for the annotated edit and failed for the plain one, which is the harder half
  // to notice: `configAssignsVar` said PRESENT for both (it is the case #118 added it for),
  // so the pair disagreed about the one shape they exist to agree about, and the caller was
  // told "the file set this, to the value on the line above".
  //
  // Nothing newly MATCHES here except a tail that is empty or only whitespace, and every one
  // of those reads as '' — the same answer the quote-and-comment rules below already gave
  // for `VAR=""` and `VAR= # off`.
  const assign = new RegExp(`${assignmentHead(varName)}[ \\t]*([^\\n]*?)[ \\t]*$`)
  let value = ''
  for (const line of String(text).split('\n')) {
    if (/^\s*#/.test(line)) continue
    const m = line.match(assign)
    if (!m) continue
    let raw = trimPadding(m[1])
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
    // `trimPadding` and not `.trim()`, for the same reason as above: this strip runs AFTER the
    // comment is removed, so a `.trim()` here would put every character the padding class was
    // narrowed for straight back in the bin (`X=<U+00A0>folder` reached this line intact and left
    // it as `folder`).
    //
    // THE `\s+` INSIDE THE PATTERN IS THE SAME SUPERSET, STILL UNNARROWED, and this comment used
    // to claim it was bash's own comment rule. It is not: a comment opens at a `#` that begins a
    // WORD, and bash's word separators there are the same space and tab the padding narrowed to,
    // so `\s+` opens a comment where bash keeps data. Measured on the same shell, ambient
    // `X=AMBIENT`, both rows with EMPTY stderr — bash assigned:
    //
    //   $ printf 'X=\302\240#off\n' > w.sh
    //   $ X=AMBIENT bash -c 'set -a; . ./w.sh; set +a; printf "[%s]" "${X-«unset»}"'
    //   [<U+00A0>#off]                                     # and this parser says ''
    //
    //   $ printf 'X=folder\302\240#off\n' > w.sh
    //   [folder<U+00A0>#off]                               # and this parser says 'folder'
    //
    // The first row is the DESTROYS direction `assignmentHead`'s comment calls the sharper one
    // ("this family does not only INVENT values, it DESTROYS them"): present-and-blank, so it
    // clears a live line above it — reachable by the same HTML-paste route as `X=<U+00A0>folder`.
    // It is a KNOWN REMAINING INSTANCE of the defect this class was narrowed for, left wide
    // DELIBERATELY and out of scope here: narrowing it to `[ \t]+` changes what this parser reads
    // for a shape it currently reads wrongly, which is a behaviour change and belongs to its own
    // issue rather than riding along inside the padding fix. Both rows are pinned as measured
    // divergences in parse-config-var.boundary.qa.test.js's padding block, so the day the class is
    // narrowed that test goes red and names itself.
    else if (raw[0] !== '"' && raw[0] !== "'") raw = trimPadding(raw.replace(/(^|\s+)#.*$/, ''))
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
