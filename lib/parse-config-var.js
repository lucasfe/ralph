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
// WHITESPACE AFTER THE `=` IS A DIFFERENT BASH RULE, AND SINCE THE #149 REVIEW IT IS MODELLED
// RATHER THAN EXCLUDED. `X= folder` parses fine and assigns NOTHING: the `X=` is an environment
// prefix scoped to the command `folder`, so the binding lives for that command and dies with it.
// `X=a b` is the same rule with no space after the `=`, and so is `X=# off`, where the `#` does not
// open a comment because a comment only opens at a `#` that BEGINS a word. Measured on GNU bash
// 5.3.15(1)-release (aarch64-apple-darwin25.4.0), with an exported `X=ambient` in place:
//
//   X= folder       -> [ambient]     ./c.sh: line 1: folder: command not found
//   X=a b           -> [ambient]     ./c.sh: line 1: b: command not found
//   X=fol der       -> [ambient]     ./c.sh: line 1: der: command not found
//   X=# off         -> [ambient]     ./c.sh: line 1: off: command not found
//   X=#c off        -> [ambient]     ./c.sh: line 1: off: command not found
//   X=""#c off      -> [ambient]     ./c.sh: line 1: off: command not found
//   X=""# c         -> [ambient]     ./c.sh: line 1: c: command not found
//   X=# ""          -> [ambient]     ./c.sh: line 1: : command not found
//   X= ""           -> [ambient]     ./c.sh: line 1: : command not found
//
// THE RULE, STATED ONCE, and it is bash's own rather than this module's: the assignment on such a
// line does not survive it, because the line has a COMMAND WORD after the assignment. Both readers
// here refuse those lines — `parseConfigVar` skips the line and `configAssignsVar` says no — and it
// is worth being blunt about why, because the previous version of this comment refused only the
// narrowest slice of it. The two verdicts a line like this used to get were the worst pair
// available. A value read off a line the shell ignored INVENTS an answer (`TASK_SOURCE= folder`
// naming a queue no run reads). A PRESENT verdict about it DESTROYS one, and since #149 pointed
// every knob of `ralph start`'s box at `configAssignsVar`, present-and-blank is precisely what
// masks the environment the loop is about to read: `TASK_SOURCE=# off` beside an exported
// `TASK_SOURCE=folder` put the box, the `gh auth status` preflight and an abort on the github
// queue while the loop ran folder. Two review rounds each found "the same class, one spelling
// over" — `X= ""`, then `X=#c off` — which is the signature of a rule drawn around spellings
// instead of around the rule.
//
// WHAT IS NOT REFUSED, every row because bash really does assign there, and every row measured:
//
//   export X= ""      -> []        the builtin is handed `X=` and `""` as two arguments and applies
//                                  the first, so this blanks. `export` is outside the refusal
//                                  altogether (`export X=# off` assigns `#`, `export X=a b` too).
//   X=                -> []        a blank with nothing behind it: no word for the `X=` to prefix.
//   X= # off          -> []        a `#` that BEGINS a word is a comment, so again no command word.
//   X=v ;             -> [v]       and `; true`, `&& true`, `|| true`, `> /dev/null`, `< /dev/null`
//                                  and `2> /dev/null` — an OPERATOR is not a command word.
//   X= Y=w            -> []        a second ASSIGNMENT is not one either, and X really is blanked
//                                  here. `X=v Y=w true` assigns nothing, so the scan walks PAST
//                                  assignment words looking for the command rather than stopping.
//   X=v $UNSET        -> [v]       an unquoted expansion can vanish, leaving no word at all. A
//                                  QUOTED one cannot: `X=v ""` assigns nothing.
//   X=$(echo a b)     -> [a b]     a blank inside a substitution, an expansion, a quoted string or
//   X=${U:-a b}       -> [a b]     behind a backslash is not a word separator.
//   X=`echo a b`      -> [a b]
//   X="a b"           -> [a b]
//   X=a\ b            -> [a b]
//
// WHICH IS WHY THE REFUSAL IS A SCAN AND NOT A REGEX (`endOfWord` below). A backtracking regex
// cannot express "the FIRST unquoted blank": handed `X=${U:-a b}` it re-reads the `$` as a bare
// dollar, finds the blank inside the expansion and refuses a line bash assigns — and a false
// refusal loses a value the loop really holds, which is the same class of damage in the other
// direction. Swept rather than argued, and the sweep is what caught the one tail this scan did get
// wrong (the LINE CONTINUATION paragraph below): 4,176 config lines, each one sourced by a real bash
// exactly the way templates/ralph.sh sources it, and its PRESENCE verdict compared with this
// module's.
//
// THE INVARIANT IS WHAT THE SWEEP IS FOR, and it is the claim to carry forward rather than any
// count: NOT ONE REFUSAL IN THE TABLE LANDED ON A LINE BASH ASSIGNED. That is the direction that
// loses a value the loop really holds, and it is empty.
//
// The table is 4 indents x {bare, `export`} x 18 value shapes x 29 tails, and the axes are spelled
// out here because a count nobody can rebuild is not a measurement — this sweep is a one-off driver
// rather than a suite test, so the comment is the only record of it. Indents: ``, ` `, `\t`, ` \t `.
// Value shapes, which are the families the tables on this page already walk through: `v`, empty,
// `""`, `''`, `"v"`, `'v'`, `"a b"`, `a\ b`, `$(echo a b)`, `${U:-a b}`, `` `echo a b` ``, `#`, `#c`,
// `""#c`, `folder`, `2h`, `a>b`, `~`. Tails: nothing, ` `, `  `, `\t`, ` folder`, ` ""`, ` ''`,
// ` a b`, ` #off`, ` # off`, ` #`, ` Y=w`, ` Y=w true`, ` $UNSET`, ` "$UNSET"`, ` ;`, ` ; true`,
// ` && true`, ` || true`, ` > /dev/null`, ` < /dev/null`, ` 2> /dev/null`, ` | cat`, ` &`, ` \`,
// ` a\`, ` \\`, ` ~w`, and a bare CR. On that table 936 of the 4,176 are lines bash assigns nothing
// on and 544 of those are refused here.
//
// THE 392-ROW REMAINDER IS A PROPERTY OF THIS TABLE AND NOT OF THE MODULE. A wider tail list puts
// more shapes into it, and each one is one of the bail-outs the next paragraph documents, so the
// remainder is a list of DISCLOSED limits rather than a hole — but it is not "one named group", and
// a later sweep that adds a tail should expect to find its own. In this table it is four groups:
//
//   144 rows with a ` | cat` tail   bash makes the assignment in a SUBSHELL, so the sourcing shell
//   144 rows with a ` &` tail       keeps what it held. Read rather than refused, as before #149.
//    72 rows with a ` ~w` tail      the `~` bail-out — a tilde word may expand to nothing.
//    32 rows whose VALUE is `a>b`   the operator bail-out reached through the VALUE rather than the
//                                   tail: 4 indents x 8 of the remaining tails, bare only.
//
// AND `export` ROWS ARE IN THAT REMAINDER — half of each subshell group, 72 + 72 = 144 rows, which
// is what the group sizes say out loud: 144 is 4 indents x TWO prefixes x 18 values. The builtin
// really does apply the `NAME=` it is handed, which is why `export` is outside the refusal
// everywhere else on this page, but a PIPELINE or a background `&` runs the builtin ITSELF in a
// subshell, so nothing it assigns ever reaches the sourcing shell. Measured, with an exported
// `X=INHERITED` in place:
//
//   $ printf 'export X=v | cat\n' > k.sh
//   $ X=INHERITED bash -c 'set -a; . ./k.sh; set +a; printf "[%s]" "${X-«unset»}"'
//   [INHERITED]           no stderr: the `export` ran, in a subshell, and died with it
//   $ printf 'export X=v &\n' > k.sh
//   [INHERITED]           the same
//
// while this module answers `configAssignsVar` = true for both, with `parseConfigVar` reading
// `v | cat` off the first and `v &` off the second. So those really are `export` rows in the
// remainder — lines bash assigns NOTHING on — diverging in PRESENCE exactly like their bare
// spellings, and not, as this comment used to claim, lines bash assigns that diverge only in value.
//
// The ` ~w` group is bare-only for precisely the reason the subshell groups are not: `export X=v ~w`
// hands the builtin `X=v` and `~w`, which it rejects (``export: `~w': not a valid identifier``)
// after applying the first, so it assigns `[v]` and is a line bash ASSIGNS.
//
// WHAT THE SCAN STILL DOES NOT MODEL, and in every case it declines to refuse, so the line keeps
// EXACTLY the reading it had before this change: a quote, `$( )`, `${ }` or backtick this scanner
// cannot find the end of. That is a limit of the SCANNER, not a verdict on the line — the scanner
// reads one line, and bash does not: a `$(` opened here and closed two lines down is ordinary bash,
// so "unclosed" here means only "this scanner declines to say", which is why it bails out rather
// than refusing. Also a word beginning with `$`, a backtick or a `~`, which may expand to nothing
// and leave bash with no command word after all; and a word carrying `;`, `&`, `|`, `<`, `>`, `(`
// or `)`, which is an operator or a redirection such as `2>` rather than part of a word.
// `X=v | cat` and `X=v &` are in that last group, and are the two TAILS in the table above where
// bash assigns NOTHING (the assignment happens in a subshell), so they stay as they were: read, not
// refused. They are not the only rows of the group bash assigns nothing on, though, and the sweep
// says so: `X=v ~w` is the `~` bail-out (`~w: command not found`, inherited value stands) and
// `X=a>b folder` is the operator bail-out reached through the VALUE rather than the tail
// (`folder: command not found`, inherited value stands). All three are the same trade — a disclosed
// bail-out, priced so that no refusal can reach the operator tails bash DOES assign on.
//
// AND A LINE ENDING IN A BACKSLASH IS THE SAME LIMIT, WITH A REGRESSION BEHIND IT — the #149 review
// found this refusal reaching a whole tail bash assigns on, which is #149's own defect one spelling
// over. A backslash at the very END of a line is not an escape of a character and not a word: it is
// bash's LINE CONTINUATION, so the line runs on into the next one and the word after the assignment
// may not begin until a line this scanner was never handed. Measured on the route
// templates/ralph.sh uses (GNU bash 5.3.15(1)-release, aarch64-apple-darwin25.4.0), each row as the
// whole file, with an exported `X=INHERITED` in place:
//
//   $ printf 'X=v \\\n' > k.sh
//   $ X=INHERITED bash -c 'set -a; . ./k.sh; set +a; printf "[%s]" "${X-«unset»}"'
//   [v]                     no stderr: bash ASSIGNED — the continuation joins the empty next line,
//                           so nothing is left to be a command word. `X=v\`, `X="v" \` and a tab
//                           before the backslash measure the same, and so does a following blank
//                           line or a following `# a note`.
//   X= \              -> []               a blank with only a continuation behind it still BLANKS.
//   X= ""\            -> [INHERITED]      the word is `""`, so the refusal is right here whatever
//                                         the next line holds.
//   X=v a\            -> [INHERITED]      `a: command not found` — the word is `a`.
//   X=v \\            -> [INHERITED]      `\: command not found` — TWO backslashes are an ESCAPED
//                                         one, which is a word.
//
// So the bail-out is scoped to exactly the case the scanner cannot resolve: a trailing continuation
// where the word being scanned is still EMPTY (`i === start` in `endOfWord`). Where the word already
// has characters, a continuation can only ADD to a word that exists, so the refusal keeps its
// reading — which is what holds the four `[INHERITED]` rows above. THE VALUE IS A SEPARATE MATTER
// AND STILL DIVERGES: this reader stops at the newline, so `X=v \` reads as `v \` where bash holds
// `v`, and a QUOTED value keeps its quote pair too, because a tail outside the pair defeats the
// unwrapping rule below (`X="v" \` reads as `"v" \`, where bash holds `v`) — exactly as both did
// before #149. Wrong string, right presence — which is the smaller half of the pair, since a wrong
// presence verdict masks the environment the loop reads. "Right presence" is scoped to the rows
// above, where the continuation joins a line with no command word on it; where the NEXT line
// supplies one, presence diverges too, and `endOfWord`'s own note measures that row. Both are swept
// against a real shell in lib/commands/start.sourced-value.qa.test.js's FAMILY property, which names
// the value-divergent rows one by one.
//
// AND THE ONE JUDGEMENT THIS COST, said plainly because the previous version of this comment argued
// the other way. `RALPH_DIGEST_INTERVAL=  2h  ` used to be a supported spelling here and is now no
// assignment at all, which is what bash makes of it (`2h: command not found`). Nothing this repo
// SHIPS depended on the old reading: templates/ralph.config.sh writes `RALPH_DIGEST_INTERVAL=""`,
// and no file directly under templates/ has a line with an unquoted blank after the `=` followed by a
// word — ralph.sh included, though this parser never reads it — measured as zero matches, and swept
// on every run by lib/commands/start.sourced-value.qa.test.js. What depended on it was TWO
// rows of one QA table in lib/commands/start.digest-window.qa.test.js and the test written to defend
// them, all flipped by this change with the reason written on them.
//
// THE TWO BOUNDARIES most likely to be broken by a later "simplification", measured the same way:
//
//   $ printf 'X= \n'          > t9.sh  ->  (no stderr)                        []
//   $ printf 'export X= ""\n' > t9.sh  ->  export: `': not a valid identifier []
//
// A blank after the `=` with NOTHING behind it is a real assignment to empty and must keep blanking.
// And `export` changes the answer, so it stays an assignment here too. The first is pinned in
// parse-config-var.boundary.qa.test.js; the second only in
// lib/commands/start.sourced-value.qa.test.js (`export ${name}= ""` there), because it is a shape
// that block was written around. The whole family is swept against a real shell in
// parse-config-var.qa.test.js.
function assignmentHead(varName) {
  return `^[ \\t]*(?:export[ \\t]+)?${escapeName(varName)}=`
}

// The characters that end a word by being an OPERATOR or a redirection rather than part of it (`;`,
// `&&`, `| cat`, `> f`, `2> f`), used ONLY by `endOfWord` and only UNQUOTED — see its own note for
// why finding one is a bail-out rather than a refusal. And a second ASSIGNMENT rather than a command
// (`Y=w`), which the refusal walks past in case a command follows it. Both are measured above.
const OPERATOR_CHARS = /[;&|<>()]/
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

// Where bash ends a WORD, and nothing more than that. Returns the index just past the word starting
// at `i`, or -1 for a construct THIS SCANNER cannot resolve within the single line it was handed —
// a quote, `$( )`, `${ }` or backtick whose close it does not find, an unquoted OPERATOR, or a word
// that would begin at a trailing LINE-CONTINUATION backslash, whose first character is on the next
// line — so the caller can decline to answer instead of guessing. -1 is not a claim that the line is
// malformed:
// bash reads across lines and this does not, so a construct opened here and closed further down the
// file lands here too, and declining is the only safe answer for it. Only a space or a tab ends a
// word: not `\s`, for the reason `assignmentHead` gives at length, and not a blank inside quotes,
// behind a backslash, or inside a substitution or expansion. A carriage return does not end one
// either — bash's tokenizer treats it as an ordinary word character, so a CRLF file's `X= ` has the
// `\r` as its COMMAND WORD and assigns nothing, which is pinned in
// lib/commands/start.sourced-value.qa.test.js's family sweep.
//
// The operator bail-out is measured, not defensive. `X=codex; echo hi` ends the assignment at the
// `;` and really does assign `codex` — as do `X=a>f`, `X=a&&b` and `X=a|b` — so a scan that read
// `codex;` as one word and `echo` as a command word would refuse a line bash assigns, which is the
// one kind of mistake this refusal must never make (it would lose a value the loop really holds).
// And it only ever sees UNQUOTED characters, because the quote and backslash branches jump the whole
// span they open and nothing inside it is tested — which is the point, since quoting or escaping an
// operator character makes it part of the word again: `X= "a;b"` runs a command named `a;b` and
// assigns nothing, so the bail-out must not fire there. Those rows are
// pinned in the same sweep, one spelling over from the ones this fix was first written against.
function endOfWord(line, i) {
  const start = i
  while (i < line.length) {
    const c = line[i]
    if (c === ' ' || c === '\t') break
    if (OPERATOR_CHARS.test(c)) return -1
    if (c === '\\') {
      // A backslash at the very END of the line is bash's LINE CONTINUATION rather than an escape
      // of the next character: the line runs on into the one below, and this scanner does not. So
      // where the word being scanned is still EMPTY, what its first character will be lives on a
      // line this function was not handed — the `-1` case exactly as the paragraph above defines
      // it. If the word already has characters in it, the continuation can only ADD to a word that
      // exists, so the scan keeps its own reading of it.
      //
      // DECLINING IS THE SAFER ANSWER HERE, NOT AN INFALLIBLE ONE, and the shape that costs it is
      // named here because nothing else on this page names it. `-1` means "do not refuse", so the
      // line is read as an ordinary assignment — and where the CONTINUATION LINE is the one that
      // supplies the command word, that reading is wrong in the DESTROYING direction. Measured on
      // the route templates/ralph.sh takes, the two lines as the whole file:
      //
      //   $ printf 'X=v \\\necho hi\n' > k.sh
      //   $ X=INHERITED bash -c 'set -a; . ./k.sh; set +a; printf "[%s]" "${X-«unset»}"'
      //   hi
      //   [INHERITED]           no stderr: bash ran `echo hi` with `X=v` as its PREFIX, and the
      //                         binding died with that command
      //   > configAssignsVar(text, 'X')   // true
      //   > parseConfigVar(text, 'X')     // 'v \'
      //
      // so `sourcedValue` resolves a value the loop will not hold, which is #149's own damage class:
      // `TASK_SOURCE=github \` over an `echo hi`, beside an exported `TASK_SOURCE=folder`, has
      // `ralph start` name github, run the `gh auth status` preflight and count the GitHub queue
      // while the loop works folder. NOT A REGRESSION — `git show main:lib/parse-config-var.js`
      // answers `true` and `'v \'` for the same two lines, so this guard neither opened the shape
      // nor closed it. Closing it needs the NEXT line, which is a change to what this scanner is
      // handed rather than to what it decides, and the whole point of the `i === start` half is that
      // widening the refusal to the tail instead costs the rows bash really does assign on (`X=v a\`,
      // `X=v \\`). Write each assignment on one line.
      if (i + 1 >= line.length && i === start) return -1
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const close = line.indexOf(c, i + 1)
      if (close === -1) return -1
      i = close + 1
      continue
    }
    if (c === '$' && (line[i + 1] === '(' || line[i + 1] === '{')) {
      const open = line[i + 1]
      const shut = open === '(' ? ')' : '}'
      let depth = 0
      let j = i + 1
      for (; j < line.length; j++) {
        if (line[j] === open) depth++
        else if (line[j] === shut && --depth === 0) break
      }
      if (depth !== 0) return -1
      i = j + 1
      continue
    }
    i++
  }
  return i
}

// The refusal those paragraphs describe, used by BOTH readers so there is still one grammar — and
// parse-config-var.test.js's tripwire is what holds that: nothing may be called ABSENT while the
// value reader reads a value out of it. A predicate over a LINE rather than a regex string, for the
// reason given above (a backtracking regex finds a blank the shell's tokenizer never sees), and
// bare-`NAME=` only, because `export` really does assign.
function envPrefixedNothing(line, varName) {
  const head = line.match(new RegExp(`^[ \\t]*${escapeName(varName)}=`))
  if (!head) return false
  let i = endOfWord(line, head[0].length)
  if (i < 0) return false
  for (;;) {
    if (i >= line.length) return false
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
    if (i >= line.length) return false
    // A `#` that BEGINS a word opens a comment, so there is no command word after all.
    if (line[i] === '#') return false
    const end = endOfWord(line, i)
    if (end < 0) return false
    const word = line.slice(i, end)
    if (word[0] === '$' || word[0] === '`' || word[0] === '~') return false
    if (ASSIGNMENT_WORD.test(word)) {
      i = end
      continue
    }
    return true
  }
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
    // A line whose assignment does not survive it, refused BEFORE the value rules rather than after
    // them (#149 review) — the whole point is that this line is not an assignment at all, so it must
    // not become the answer AND must not displace an earlier one. `continue` rather than
    // `value = ''`: `X=live` then `X= ""` reads as `live`, which is what bash holds.
    if (envPrefixedNothing(line, varName)) continue
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
// for it, `configAssignsVar(text, N) ? parseConfigVar(text, N) : processEnv[N]` is the whole
// precedence: a present value wins even when blank, and only a truly absent one falls through to
// the process environment. A truthiness test on `parseConfigVar` alone gets the blank case wrong.
// (Spelled "environment" and not the three-letter abbreviation on purpose: #41's ambient-surface
// scanner is a regex over these sources that does not skip comments, and an `env` followed by a
// full stop and a capital reads to it as a real read of a variable named after that letter.)
// #118 and #120 spelled that as `... : null` and then `??`, for two knobs; #149 made it the single
// rule `ralph start` reads every knob of its box through, named `sourcedValue` at
// lib/commands/start.js:272.
//
// Deliberately NOT folded into `parseConfigVar` as a nullable return: that function is read for
// half a dozen knobs whose precedence rules differ from each other — RALPH_BANNER deliberately
// reverses this one, and the digest pair has no environment fallback at all — and three commands
// besides `start` (cycle.js, status.js, doctor.js) still read config knobs on a `||`. Presence is a
// separate question, so it gets a separate answer, and the callers that do not care about it are
// not made to handle a null.
export function configAssignsVar(text, varName) {
  if (!text || !varName) return false
  const head = new RegExp(assignmentHead(varName))
  // Same three rules the loop above applies, in the same order: a line commented out is not an
  // assignment, the name must end at the `=` so RALPH_AGENTX is a different knob, and a bare
  // `NAME=` whose line goes on to hold a COMMAND WORD is bash's environment prefix rather than an
  // assignment that survives the line (#149 review). Anything this says yes to, `parseConfigVar`
  // reads a value out of — possibly the empty string, which is the case this function exists for.
  // parse-config-var.test.js pins that implication as a table.
  return String(text)
    .split('\n')
    .some((line) => !/^\s*#/.test(line) && head.test(line) && !envPrefixedNothing(line, varName))
}
