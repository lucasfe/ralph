# Contributing to `@lucasfe/ralph`

Thanks for your interest. Ralph is an autonomous GitHub-issue resolution
loop packaged as a CLI. It was extracted from the
[`agenthub`](https://github.com/lucasfe/agenthub) monorepo (where it was
dogfooded into maturity) and now lives standalone at
[`lucasfe/ralph`](https://github.com/lucasfe/ralph).

## Local development

```bash
git clone https://github.com/lucasfe/ralph.git
cd ralph
npm install
npm test            # vitest run
npm run test:watch  # vitest watch mode
```

The package has no build step — the published artefact is the source.
Three runtime deps (`commander`, `execa`, `picocolors`); tests use
`vitest` + `memfs` for hermetic filesystem assertions.

### Test hermeticity (#41)

`vitest.config.js` loads exactly one setup file — `test/setup/hermetic-env.js` —
in every worker. It deletes the ambient ralph-domain variables, repoints `HOME` at
a throwaway sandbox under the OS temp dir, and restores `process.env` between
tests. So `npm test` gives the same answer on a laptop and on CI, and a new test
file inherits that with no opt-in.

The name set is **derived from the sources**, not hand-maintained: `RALPH_*` by
prefix, every key passed to `resolveCred()` in `lib/`, and every variable declared
by `templates/ralph.config.sh` / `templates/env.local.example`, plus a short list
of names no file declares (`XDG_CONFIG_HOME`, `PROJECT_ROOT`, `NO_COLOR`, `TMUX`, …).
Add a new credential or config knob and it is neutralized automatically. `NO_COLOR`
earns its place on that undeclared list for a reason worth stating: it is a cross-tool
convention nobody declares in a template, and a contributor who happens to export it
would otherwise flip every colour-gated assertion in the suite at once (see
[the sprite banner](#the-sprite-banner-generated-asset-placeholder-art)).
`TMUX` (#167) is the same class with a sharper edge, and it names the gap to watch
for: the derivation finds `resolveCred()` keys and template assignments, so a
variable a module reads off its **injected env bag** — `processEnv.TMUX` in
`lib/commands/live.js` — is invisible to it and needs a hand entry. Miss it and the
suite answers differently on one machine than on CI, because *tmux itself* exports
that name in every shell inside a session: a contributor running `npm test` in the
window `ralph start` opened has it set, so a spec that lets `liveCommand`'s
`processEnv` default — against a live session, which is what its own default deps
build — would take the inside-tmux branch there and nowhere else. Add a
`processEnv.X` read for an ambient, tool-exported name and add the name here with it.
`pool: 'forks'` is pinned in the same config for a reason documented there: the `HOME` sandbox
travels through `process.env`, which only reaches `os.homedir()` when each worker
is its own process.

To assert environment resolution, opt in **explicitly**: inject the bag
(`processEnv: { XDG_CONFIG_HOME: '/xdg' }`, `home: '/home/me'`) for unit tests, or
set the variable on the child env / `process.env` inside a test that spawns a
process — it is reverted before the next test. Mutate in a `beforeEach`, not a
`beforeAll`: the per-test snapshot is taken after `beforeAll`, so a value set there
is sticky for the rest of the file. Never rely on a variable the invoking shell
happens to export. The contract is asserted by `test/hermetic-env.test.js`,
`test/hermetic-env.qa.test.js` and `test/hermetic-env.idempotence.qa.test.js`.

### Source hygiene: no raw control bytes (#107)

No file committed here may carry a raw C0 control byte (TAB, LF and CR excepted)
or DEL. Plenty of tests need those bytes — most of the suite's ANSI assertions do —
so write them as **escapes**: `\u001B` in a string, template or regex literal, or
`String.fromCharCode(27)` when a sequence is assembled into a `RegExp`. Both
spellings are byte-identical to the raw byte at runtime, so what the code under
test receives is unchanged; only what a reader and a search tool can see changes.

Two bytes are worth naming, because neither cost is obvious. A raw **U+0000
(NUL)** makes `file` classify the source as `data`, and grep, `rg` and `git grep`
then skip the file — silently, without so much as a line count, while Node reads
it perfectly well. #107 found two committed test files in exactly that state: the
coverage existed and nothing could find it. A raw **U+001B (ESC)** stays
greppable but is a live escape sequence, so `cat`-ing or `less`-ing the file
recolours the reader's terminal from that line on.

The rule is **asserted** rather than merely written down, because it *was* written
down — in `lib/commands/doctor.identity-box.test.js` — and violated twice anyway,
and the failure is silent by construction: the suite stays green while a whole test
file leaves the searchable repo. The guard's scope is **what `git ls-files`
tracks**, which is a rule rather than a hand-maintained skip list: a `coverage/`
report, a `.DS_Store`, or the `.env.local` the README asks you to create is not
authored source and never reaches the sweep, and nothing under `.git/` or
`node_modules/` needs excusing. The cost of that choice, stated so it does not
surprise you: a new file is out of scope until it is staged. It also **fails
closed** — a missing `git`, a directory that is not a repository, or an empty file
list throws rather than reporting a clean sweep, since a guard that quietly scans
nothing is the same blind spot #107 is about. NUL is forbidden in **every** tracked
file; ESC and the rest of the class are checked in `.js`. The contract is asserted
by `test/source-control-bytes.test.js` and `test/source-control-bytes.qa.test.js`
(which plants offenders and proves the detector actually fires), both driving the
one shared detector in `test/helpers/source-control-bytes.js`.

### What a static source sweep may be asked (#119)

Several specs here read this repository's own source and assert something about
the set of files they find. That is a legitimate instrument with a boundary:
a sweep answers a question about **the text** exactly, and a question about
**what a user sees** only by proxy. "Where is this sentence composed", "which
modules can reach this module", "is anybody still pointed at the old door" are
properties of the source, and a sweep is the honest way to ask them — it is why
`git-remote-slug.extraction.qa.test.js` reads files off disk while the three
specs beside it read none, since source is not a fixture and needs no checkout
of anybody's repository. "Who prints this line" is **not** that kind of
question. The nearest thing a sweep can see is how the read is *spelled*, and
the spelling is not the property anybody cares about. Drive the stream instead.

#119 is where that cost was paid, and it was paid twice, in opposite
directions. The `RALPH_AGENT` fallback warning is composed in one place and
returned rather than printed (`resolveAgent`, #108), so which modules put it in
front of somebody was pinned by a sweep of `lib/` for a `warning`-shaped
pattern. **Loose, it read prose as code:** "mentions the word `warning`" matched
`lib/commands/start.js` on `banner.warning` — `lib/banner-mode.js`'s own
unrelated fallback warning — and on a line of text telling a user to look at
stderr, so a module joined the printer set on the strength of another object's
field and a sentence addressed to a human. **Tightened to a destructure or a
`warning:` key (#69), it stopped seeing code:** `resolveAgent(env).warning`, or
that same read through a variable, matches neither, so a new printer written
that way would have left the swept set unchanged and the literal list would
still have compared equal — the test whose entire purpose is to know who prints
the warning, passing while a printer walked in behind its back. The mirror image
is as bad: refactoring an existing consumer's destructure into a property read
turns it red for a change that moved no bytes on any stream.

So that claim is **behavioural** now: one row per call site, each driven with an
unrecognised `RALPH_AGENT`. The four printers must carry the resolver's own
sentence — the resolver is the oracle, so the needle cannot drift from the
wording — on the stream that command actually writes to, and every other caller
must carry it on **no** channel, `stdout` and `stderr` plus an `elsewhere` that
folds in generated files, logged lines and returned artefacts, because a
diagnostic smuggled into the file the loop sources is as visible as one on a
stream. Every row also asserts **which agent the module resolved**, since a
silence assertion is worthless if the driver never reached the call site. Two
sweeps survive #119, and they survive on the rule rather than in spite of it:
where the sentence is composed (with comments stripped, exactly one module under
`lib/` spells the assignment-shaped prefix `RALPH_AGENT='`), and which modules
can reach the resolver at all — re-asked as a question about the **import
edge**, `lib/`, `bin/` and `scripts/` swept for the specifier
`agent-registry.js`, which a static `from`, an `import()`, a `require()` and a
re-export all have to write down and which no rename at the boundary can hide.
Roster completeness is a claim about the codebase and a sweep belongs on it; who
prints is a claim about a user and a sweep never did. A sweep whose value is
completeness is also made to find things it must find, for the same reason
#107's byte guard fails closed.

Two notes on needles, since both mistakes are easy to make again. **A needle
must be unique to the thing under test**: the bare word `unrecognized` is not,
because `lib/banner-mode.js` composes `RALPH_BANNER=<value> unrecognized;
falling back to …` for a different knob, so it names the *genre* of fallback
warning rather than this one — #69's ambiguity wearing a needle's clothes. **And
a channel that legitimately carries the assignment can only bear the composed
sentence**: `ralph start` shell-quotes the configured value into the digest
window's command line on purpose, so a repo that committed `codx` has an argv
holding `RALPH_AGENT='codx'` while behaving exactly as designed, and keying that
channel on the prefix or on the raw value would go red on correct behaviour —
#119's own false red, one channel over. The contract is asserted by
`lib/agent-registry.warning.consumers.qa.test.js` (ten rows across nine modules;
`lib/commands/doctor.js` holds two call sites with opposite specifications) and
`lib/agent-registry.warning.consumers.coverage.qa.test.js` (the roster on the
import edge, plus two channels nothing watched before — `ralph init`'s six
generated files, and the exec argv a `ps` or an audit log records), with the
surviving composition sweep in `lib/agent-registry.warning.qa.test.js`.

### A spec that cannot go red (#122)

The section above is about a needle. This one is about the other two ways a
source-reading spec passes for a reason nobody chose — **the haystack it was cut
from**, and **the yardstick it measured against** — because #122 found one of
each, in opposite directions, and both fixes are conventions rather than tests.

**Slice a function body with `functionBody` from `test/helpers/source-code.js`,
never with a private copy.** Several specs ask whether *this* builder calls a
gate — "does `factRows` call `textOr`" — and a whole-file grep cannot answer it:
the gate's own definition satisfies the match, and so does any other builder's
call to it. So the haystack has to be cut down to one body, and the cut has to
be the **next top-level declaration**. Four private copies ended a slice at
`\nfunction ` alone, which an `export function` does not match, so a slice
beginning at the last *non*-exported function ran to **end of file** and
swallowed every exported declaration after it. That fails **open** — it returns
more text than it was asked for — and open is the direction that turns a search
into a tautology: a gate written to find a *call* to `textOr` was answered by
`export function textOr(`, so the spec could not go red however the builder was
written. The shared slicer stops at `export`, `default` and `async` too, and
**throws** on a name it cannot find rather than returning `''`, since a silent
empty string is the same blind spot one file over. Four other `bodyOf` helpers
(two in `lib/commands/status.json.qa.test.js`, one each in `lib/digest.qa.test.js`
and `lib/issue-metrics.qa.test.js`) are **not** stragglers and should stay: two of
them cut at the first column-0 `}`, and `issue-metrics`' matches braces because
its claim is that two bodies are **byte-identical** and the braces are part of
what it compares. Both of those cuts fail **short** — they return less than was
asked for, and a spec starved of haystack goes red rather than green. Do not write
a fifth that fails long.

**Import the subject, restate the yardstick.** `LABEL_WIDTH` is the frame half's
number and every label is the row half's string, so #122's seam made the label
gutter a *cross-module* decision and the constant is now exported for it.
Exporting it is not a licence to import it everywhere: ask what the number is
doing in the spec. Where the gutter is what the claim is **about** — "every label
this module draws fits the gutter with air after it", in `banner-rows.test.js`
and `banner-compose.test.js` — **import** it, because a literal `8` in the
pattern is a second copy of one decision and a gutter widened to nine would
leave the spec quietly asserting the old one. Where the gutter is what the claim
is **measured with** — the independent reimplementations of the gutter and the
clip in `banner-rows.qa.test.js` and `banner-rows.seam.qa.test.js`, which exist
to compare the rendered box against something *neither half built* — **restate**
it as a literal, and leave the comment saying why. An oracle that imported the
frame's own constant would be satisfied by any mistake the two halves agreed on,
which is the single failure mode a seam has and the only one those files are for.
The duplication is the instrument; do not "DRY" it away.

### Label names live in one module (#139)

`lib/labels.js` is the **only JavaScript in this repository that spells a Ralph
GitHub label**, and the place the issue-eligibility query is *composed* rather
than typed. It exports the four names — `IN_PROGRESS_LABEL`, `FAILED_LABEL`,
`PENDING_MERGE_LABEL`, and `SKIP_LABEL`, the `do-not-ralph` marker a **human**
applies and the only one of the four Ralph never creates — plus `RALPH_LABELS`
(all four, in the order the exclusion uses them), `MANAGED_LABELS` (the three
Ralph *does* create, each with the colour and the user-visible description
`gh label create` publishes), `LEGACY_LABELS` (each name Ralph has **retired**,
mapped to the name that replaced it — #140 filled it with the two labels that
used to carry a `claude-` prefix), `LABEL_EXCLUSION` (the `-label:` clauses
alone) and
`ISSUE_SEARCH_QUERY` (the whole `state:open …` query), plus the one function in
the module — `findLegacyLabels({ exec })`, #141's read of `LEGACY_LABELS` in the
other direction, described at the bottom of this section. It has **no ambient
I/O** — no clock, no environment, no filesystem, and no imports at all, like
`git-remote-slug.js` and `jira-jql.js` beside it — and everything it hands
out is frozen *down to the spec objects*, because a module-level array every
command imports is shared mutable state and one `.push` in a consumer would
change the vocabulary for the whole process.

**Import a name; never retype one.** Every label is one half of a mechanism
whose other half is somewhere else: the loop **stamps** a label and the query
**excludes** it, `ralph start` **creates** it and `lib/issue-event.js` **reads it
back** to decide an issue's outcome, and `lib/orphan-cleanup.js` **hunts**
exactly the issues the query hides. If any two of those spellings disagree the
queue stops draining — Ralph is handed the same issue on every pass, forever, at
a paid agent invocation each time, having already done the work. Before #139 the
in-progress name was a literal in four modules under `lib/`, and the exclusion
query was hand-typed in *three* commands (`ralph start`, `ralph cycle`,
`ralph status`) with nothing checking that the three copies agreed. The clause
**order** in `RALPH_LABELS` is part of the contract while you are at it: `gh
issue list --search` does not care, but the pre-existing command specs use the
assembled query as whole exec-mock command lines, so a reordering is a behaviour
change as far as the suite is concerned (`lib/labels.js`'s header carries the
measured count).

**#140 spent the mechanism, and changed what a text sweep can prove.** The two
labels Ralph stamps on an issue used to carry a `claude-` prefix; they now say
what the *loop* is doing instead, because Ralph has driven Codex as well as
Claude since #554. On the JavaScript side that was the one-line edit the module
was built for. On the sweeps it cost something worth knowing about before you
write another one: the old spellings were coinages nothing else in this
repository had a use for, so "this file does not contain the string" was a
faithful proxy for "this file does not spell the label". The new ones are not —
the folder lane's status directories, the Jira lane's own board labels, and
plain English all write them. So the static guards were re-pointed at needles
that are still exact (a name next to the `gh` flag that issues it; the retired
spellings, which remain unique) and the claim they could no longer make was
handed to the behavioural spec. **Absence of a label's name from a file is no
longer evidence about labels** — say what shape you are looking for.

Five specs hold that up, and they fail in different directions on purpose:

- `lib/labels.test.js` — the module's own contract, plus a sweep of every
  non-test `.js` under `lib/` for a leftover literal. Since #140 that sweep asks
  about `PENDING_MERGE_LABEL` alone: nine modules legitimately write the other
  two names for the folder, Jira and digest lanes, and an allowlist of them
  would go stale the next time anybody writes `status: 'failed'`. The sweep
  reads source with `codeWithoutComments`, so **a comment may still name a
  label** — several explain the mechanism and should.
- `lib/labels.seam.qa.test.js` — substitutes the module with an obviously fake
  vocabulary (`qa-…`), drives the consumers for real, and reads back the argv
  they hand `gh`. Absence of a literal is a static argument; this is the
  behavioural one, and it is what a rename actually depends on. Since #140 it is
  also the *only* spec that can still catch a consumer that retyped one of the
  two renamed names, because substitution does not care that a label is spelled
  like an English word. The fake names must not **contain** a real one, either:
  `qa-in-progress` became `qa-claimed` when the real label became `in-progress`.
- `lib/labels.parity.test.js` — the copies that **cannot** import:
  `templates/ralph.sh` composes its own `SEARCH_QUERY` because it runs
  standalone in tmux, and a prompt template is text an agent reads. It asks
  three questions at three strengths: what each file **writes** (a table of
  exact `gh` argv fragments, flag and name together — the strong half, added by
  #140), what each file **mentions** (the per-file name table, in both
  directions, with the negative half scoped to the two names still unique to
  Ralph), and whether any **retired** spelling survives anywhere — a sweep over
  every file `git ls-files` reports, whose matcher and argued exemption list it
  shares with the QA spec below (`test/helpers/legacy-label-sweep.js`).
- `lib/labels.vocabulary.qa.test.js` — the direction a hardcoded table cannot
  look: it globs `templates/` from the filesystem, so a **new** label-bearing
  template goes red the day it lands, and it runs the legacy check against the
  real retired spellings while demonstrating on a green tree that the matcher
  reports something when there is something to report.
- `lib/labels.rename.qa.test.js` — the questions the four above only ask
  *separately*. That the word a copy **stamps** is the word its own query
  **excludes**, parsed out of that file's own text rather than looked up, so the
  two halves of the invariant are compared to each other instead of both being
  compared to the module. That no copy of the exclusion is a **partial** copy —
  an almost-copy is invisible to a verbatim count, and is how a doc comes to
  describe a filter that does not run. And, since the rename put Ralph's label
  names into the space of words other boards already use, that a colliding
  third-party label is not read as Ralph's own bookkeeping.

**One exemption, and it is allowlisted rather than tolerated.**
`lib/jira-jql.js` still spells `do-not-ralph` itself, because its purity spec
pins that module at **zero imports** — the property that keeps `ralph doctor`
able to reach Jira knowledge without dragging anything onto its import graph is
worth more than deduplicating one string, and the Jira lane names it beside the
exclusion it feeds either way. So the `lib/` sweep never guarded that name, and
it is guarded instead as an allowlist of exactly one file: a *second*
`do-not-ralph` literal has to be argued for.

**Editing a doc can turn the suite red.** `README.md` and `CONTRIBUTING.md` are
rows in the parity table, because a rename that skipped them would leave the
documented remediation instructions describing a query that no longer runs.
README is asserted to carry all four names **and exactly one verbatim copy** of
`ISSUE_SEARCH_QUERY` — counted, not merely contained, so a second copy is a
deliberate table edit rather than an accident. `CONTRIBUTING.md` is listed with
the human's `do-not-ralph` **only**, and the negative half of the table means
writing `PENDING_MERGE_LABEL`'s name out in full here fails the suite. Naming
the other three by their export identifiers rather than by their words is still
the habit worth keeping — it is what the negative half enforced until #140 made
two of those words ordinary English — and this section spends `in-progress` and
`failed` only where the sentence is *about* the spelling. `CHANGELOG.md` is out
of the table on purpose: every mention of a label there sits inside a shipped
release entry describing what a past version did, so it keeps the **retired**
spelling and the repo-wide sweep exempts it by name. Leave it alone — a rename
that "completed" itself through the changelog would be falsifying history.

`README.md` earns an exemption of the same shape for the opposite reason, and it
is the one likelier to catch you, because README is a file you have every reason
to edit. Its troubleshooting section carries the **upgrade note** for #140's
rename, and an instruction telling a reader how to rename a label cannot avoid
naming the label being renamed — so the repo-wide sweep and the table's
**retired-name** half both skip README by name. Only those: every *current* name
is still pinned in the table exactly as above, so this is an exemption from one
question, not from the row. What it gives up is the whole **file** rather than
the paragraph that argued for it, so the rest of that quarter-megabyte is held by
`lib/labels.rename.qa.test.js` instead — a retired spelling may appear in README
**only inside the one troubleshooting entry that carries the migration
commands**, and a failure names the lead line of whichever entry reintroduced it
rather than just the file. The two `gh label edit` lines inside that entry are
pinned **byte-for-byte** to what `findLegacyLabels` composes at runtime: each
verbatim, each exactly once in the file, and together the only lines in a single
fenced `bash` block. Treat them as code that happens to sit in a doc. Reflowing
one across a line break, tucking a `gh auth login` in beside them, or letting an
editor turn the ASCII `'` around a description into a typographic quote each turn
the suite red — and the last of those also breaks the paste the note exists to
be, silently, in the one paragraph a stuck upgrader is reading.

**#141 reads the mapping the other way, and it is the only thing in this module
that shells out.** `findLegacyLabels({ exec })` runs one
`gh label list --limit 100 --json name` and answers *which names #140 retired are
still on this board*, pairing each hit with the `gh label edit … --name …
--description …` line that migrates it. The command is composed **here**, off
`MANAGED_LABELS`, for the reason the whole module exists: a caller that assembled
its own remediation would be a second place the vocabulary is known.
`lib/commands/start.js` calls it exactly once, inside the same
`source !== 'folder'` block as label creation and the orphan sweep — so a `jira`
run asks too, and a `folder` run makes no `gh label` call of any verb — and
prints **four lines per retired name still present**, beside the orphan notice
and after the creates. It **never aborts**: #140's clean break was deliberate,
Ralph has never run `gh label edit` on a user's behalf, and this does not change
that — the run goes on to the queue check and the launch.

Two properties of that function are load-bearing, and both are pinned:

- **The `exec` is a parameter with no default.** That is the only reason a
  function which spawns can live in a module whose own spec pins it at zero
  imports (`lib/labels.test.js`, "reads no clock, no environment and no
  filesystem — and imports nothing"). Do not "tidy" it into a module-scope
  `import { execa }` — every command that wanted four words would gain execa on
  its import graph. `ralph start` already defaults its own `exec = execa` and
  hands that one down, the same way round as the Jira modules below.
- **Empty on every failure, and never a synchronous throw.** A non-zero exit,
  unparseable output, no `gh` on `PATH`, an `exec` that rejects or is not a
  function at all, no argument at all: every one of them answers exactly as a
  clean board does. The conflation is deliberate — this is a diagnostic in a
  preflight, and a diagnostic that cannot run must never be the thing that stops
  a loop from starting.

Substituting the module in a test now means substituting that function too:
`lib/labels.seam.qa.test.js` stubs it as `async () => []` beside its empty
`LEGACY_LABELS`, because without the stub `ralph start` reaches for an export the
fake vocabulary does not have and the seam's assertions die on a `TypeError`
instead of measuring anything. The function's own contract lives in
`lib/labels.test.js`, with the adversarial half in
`lib/labels.legacy-check.qa.test.js` — the listing shapes it accepts, the seam
under abuse, the single round trip, and the order and shell-safety of the command
it composes — and the printed warning's in
`lib/commands/start.legacy-warning.qa.test.js`.

### A README transcript is compared against real output (#169)

Two blocks in `README.md` are no longer prose about a command — they are the
command's output, lifted out of the file and compared against what the code prints
today. `ralph start`'s launch box is compared **whole**, every line of it, in
`lib/commands/start.live-hint.qa.test.js`; `ralph status`'s two transcripts are
compared on the rows #169 was about — the running view's `attach` / `kill` pair, and
the `scheduled` branch's own last two rows, which that issue deliberately left alone
— against the renderer itself, in `lib/commands/status.live-hint.qa.test.js`. Both
files also sweep the **whole** README for the pre-#169 spelling of the row they own,
because a screenshot caption or a second worked example is exactly where a corrected
transcript leaves its old self behind. So **changing a line either surface prints
makes the README hunk part of that change** rather than a follow-up: the suite goes
red on the doc, naming the block, before anybody reads the wording.

**Extract fenced blocks with `fenced` from `test/helpers/doc-guard.js`, never with a
private copy** — the same shape of rule as `functionBody` above, and #169 is why it
lives there: the walk was written twice, byte-identically, once per surface, which is
the first move of the drift a shared helper makes impossible. Two guards that
disagree about what counts as a transcript are two guards that are each right about a
different document. It returns contents only, with the delimiters and any info string
dropped, and an unbalanced fence **drops** the block it opened rather than running it
to EOF — a guard that invented a last block would be asserting about prose.

Three things follow for anyone editing one of those blocks. Each guard asserts there
is **exactly one** block of its shape in the file, so a second worked example of the
same surface is a deliberate edit rather than an accident. The transcripts spell the
session `ralph-ralph-b36ff7b1` — substituted for the fixture's own name in the launch
box's guard, since a hash of a path is the one thing a doc cannot reproduce, and used
as the record's session outright in `status`'s — and the launch box's numbers are that
fixture's worked example, so a hand-tuned figure or a different session name is a red
suite, and the fixture is what to edit when the example itself should change. And
every `ralph <word>` either surface prints is checked against the `.command('…')`
registrations in `bin/ralph.js`: a hint may only name a command that exists, and
nothing else in the suite can catch a typo there, because no test ever runs the string
a hint hands a reader.

## Pull requests

- Branch off `main` and open a PR against `main`.
- Keep PRs scoped to a single change — every change should be reviewable
  on its own and rollback-friendly via `git revert`.
- Use [Conventional Commit](https://www.conventionalcommits.org/) titles
  (`feat:`, `fix:`, `chore:`, `docs:`, …). release-please reads them to
  compute the next version and generate the changelog, so the title is
  load-bearing: `fix:` → patch, `feat:` → minor, `!`/`BREAKING CHANGE` →
  major.
- Run `npm test` before pushing. CI runs `npm ci && npm test` on every
  push and pull request.
- Follow strict semver: patch = bug fix, minor = additive feature,
  major = breaking with migration notes added to `CHANGELOG.md`.

## Orchestrator templates: edit them all, always

Ralph ships **four** orchestrator templates:

- `templates/prompt-team.md` — the Claude Code orchestrator (GitHub source).
- `templates/prompt-team-codex.md` — the Codex orchestrator (GitHub source).
- `templates/prompt-team-folder.md` — the folder-mode orchestrator (#565),
  selected by `build-prompt.js` when `TASK_SOURCE=folder`. It composes the
  **same** shared role files as the others but forks the intake and
  completion prose: it reads a local task file, moves it `todo → in-progress`,
  commits straight to `DEV_BRANCH`, and moves the file to `done/` (no PR/merge).
- `templates/prompt-team-jira.md` — the Jira orchestrator (#128), selected the
  same way when `TASK_SOURCE=jira`. **Derived from the folder template**, because
  the two share a delivery shape: direct commit to `DEV_BRANCH`, no feature
  branch, no PR, no auto-merge. What is forked is the intake, the ticket's
  name and the completion — the agent is handed a key through `{{RALPH_TASK_KEY}}`
  (the one variable no other template uses) and reads its own work item with
  `acli jira workitem view`, never `gh`; and where folder mode's completion is a
  file move, this template's step 7 records the ticket on the board through
  `lib/jira-queue.js complete` and `comment` (#129) — the only board writes it is
  allowed to make, and never before the commit exists. The `failed` sweep is
  deliberately **not** the agent's (#130): the template forbids it, and
  `templates/ralph.sh` runs `locate` and `fail` itself after the dispatch returns,
  because the invocation most in need of sweeping is the one that died.

The last two are picked by source rather than by agent: `build-prompt.js` keeps a
`SOURCE_TEMPLATES` map (`{ folder, jira }`) whose entry **overrides** the
agent-selected orchestrator, so a `folder` or `jira` repo gets its own template
whatever `RALPH_AGENT` says, while `github` keeps the agent's.

The shared specialist roles (`templates/roles/*.md`) are composed into all four via
the same `{{ROLE_DEV}}` / `{{ROLE_QA}}` / `{{ROLE_REVIEW}}` / `{{ROLE_WRITER}}` /
`{{ROLE_EXPLORER}}` placeholders, and all four consume the same `{{INSTALL_CMD}}`,
`{{TEST_CMD}}`, branch and `{{RALPH_HEAVY_TIER}}` variables. The **merge**
variables are the exception, and deliberately so: `{{PR_TARGET}}` and
`{{MERGE_STRATEGY}}` appear only in the two GitHub templates, because a
commit-direct template that interpolated a merge strategy would be describing a
flow its own mode does not have. Only the **orchestrator body** is forked — it
describes how each agent delegates (Claude Code's subagents vs. Codex's
sequential-persona degradation) and, for the folder and Jira templates, how
intake/completion differ from the GitHub flow, so the bodies are deliberately not
identical.

**When you change one orchestrator template, change the others to match.** Any
edit to a shared placeholder, a numbered step heading, the `## Absolute
restrictions` block, or a PR-body section name must land in **all** the files it
applies to. `lib/template-parity.test.js` enforces this in CI over **two pairs**,
not one:

- **Claude ↔ Codex** (#554) — both GitHub templates carry the same role
  placeholders, variables, step headings, restriction rules, and PR-body
  sections, so a one-sided edit fails the suite instead of shipping a skewed
  Codex prompt.
- **folder ↔ Jira** (#128) — both commit-direct templates carry the same role
  placeholders, shared variables, step headings and commit-summary sections, and
  **neither** may reference a PR/merge variable. The two places they are asserted
  to *differ* are pinned as well, so the divergence stays deliberate:
  `{{RALPH_TASK_KEY}}` is Jira-only, and the folder-only `.ralph/tasks/hitl/`
  lane is swapped for the `do-not-ralph` label in the restrictions.

Separately, the `## Dispatch discipline` section is asserted across the three
**Claude-driven** templates (`prompt-team.md`, `prompt-team-folder.md`,
`prompt-team-jira.md`) — including the paragraph that names what an orphaned
dispatch already cost — and asserted **absent** from the Codex one, which degrades
to sequential personas and so has no pending dispatch to orphan.

What no assertion ties together is the **Claude ↔ folder** relationship outside
that section, so a `prompt-team.md` edit to a step all four share can still leave
the commit-direct pair behind: keep that one in sync by hand. The forked
orchestrator prose is not asserted either, so you are free to word each agent's
delegation instructions differently — just keep the shared structure in lockstep.

The **label names** these templates spell have a guard of their own, because a
template cannot import the module that owns them: see
[Label names live in one module](#label-names-live-in-one-module-139). A per-file
table pins which of Ralph's four labels each template carries — and a sweep that
starts from the filesystem rather than from that table catches a *new*
label-bearing template the day it lands.

### Codex maturity, sandbox, and network — do not "tighten" these

- **The Codex path is experimental.** It is unit- and stub-tested (registry,
  stream parsing, invocation argv, auth probe, template parity, and the full
  bash loop against a stubbed `codex`), but it has **not** been run end-to-end
  against a live `codex` CLI. The default Claude path is unchanged and fully
  exercised. Keep the README's experimental callout honest — do not upgrade the
  claim until a real live run has happened.
- **The `workspace-write` sandbox is a *partial* boundary.** In design testing
  it did not block a write to the system temp directory, so the Codex
  orchestrator's stay-inside-the-project rule — not the sandbox — is what
  contains a run. The `## Absolute restrictions` note in
  `prompt-team-codex.md` documents this deliberately; do not delete it.
- **Network access is required and enabled on purpose.** `codex exec` runs with
  `sandbox_workspace_write.network_access=true` (see `lib/agent-registry.js`)
  because the loop must run `gh`, `npm`, and `git push` every iteration.
  Disabling network access breaks the loop — no PR can be opened or merged. Do
  not "harden" it away.

### Jira maturity — the stub is the only Jira Ralph has met

- **No test has ever spoken to a real Jira site, and none should.** The `acli`
  the suite drives is a bash script on a prepended `PATH`, and it never comes off
  `PATH` — not even in the test about a missing binary, which makes the stub answer
  the way an absent command does instead. Four of the eight `acli` invocations are
  **writes** to somebody's board — the claim's label, the completion's transition
  and label removal, and the comment (#129) — so this is a standing rule and not a
  gap to close: if you need to see the real thing, do it by hand against a throwaway
  project, never from the suite. #130's sweep added two verbs and no invocation of
  its own: `locate` is the claim's label read, and `fail` reuses the label write
  and the removal. The eighth is #132's batch title lookup, which `ralph status`
  makes **once** for the whole task table however many ticket keys are on it — a
  **read**, so the four writes above are still all of them, and the eight argv
  builders in `lib/jira-acli.js` are still the whole surface.
- **The `acli` interface is transcribed, not measured.** The flag spellings, the
  fields `search` accepts, the ordering assumption behind `--limit 1`, the `--yes`
  on `comment create` (extrapolated from the three writes documented as taking one),
  the `key IN (…)` title lookup — which passes the ticket count as its own `--limit`
  precisely because acli's default page size is not something this repo can
  measure — and the JSON envelope a work item arrives in are all what Atlassian's
  documentation describes — or, in those cases, what it does not.
  `lib/jira-acli.js` keeps every argv in one place and says so at each one — that
  is where a field-reported usage error is fixed, and the comments naming which
  lines are unmeasured are load-bearing. Do not delete them. `lib/jira-queue.js`
  above it holds the verbs and their policy: what a failure MEANS for a queue, and
  which failures a caller must hear about.
- **Keep the README's live-Jira callout honest** — the same rule as the Codex one
  above. `TASK_SOURCE="jira"` carries a warning that none of it has run against a
  live Jira; do not upgrade that claim until a real run against a real project has
  happened (#136).

## Task-source modules: the `folder` and `jira` queues

`TASK_SOURCE` is resolved in **one** pure place, `lib/task-source.js` — `VALID_SOURCES`
is `['github', 'folder', 'jira']`, `DEFAULT_SOURCE` is `github`, and anything unset,
blank or unrecognised falls back to the default so a typo never aborts a run. Read its
header before adding a fourth name: a value that used to fall back to `github` arrives at
every `resolveSource` caller as *itself*, so a gate spelled `=== 'github'` silently stops
firing for it. `worksThroughGitHub(source)` is the allowlist that exists because of that
lesson — prefer it to a `!== 'folder'` chain, so a new source gets the safe answer by
default and has to opt **in** to GitHub's bookkeeping.

`github` needs no queue module of its own — the loop shells out to `gh` directly. The
other two each get one, and they are **structural mirrors**: a library API for the JS
commands, plus a `node <module>.js <verb>` CLI so neither `templates/ralph.sh` nor the
orchestrator prompt has to hold queue knowledge of its own.

- `lib/folder-queue.js` — the `.ralph/tasks/` queue. `queueCount` / `queuePick` /
  `locateTask` plus the status moves, over the four `afk` status directories and the
  human-only `hitl` lane. Its seam is an **injectable `fs`** (`{ fs }`), which
  *does* default to `node:fs`, so a test drives it against memfs.
- `lib/task-file.js` — the pure half of folder mode: `parseTaskFile` (the YAML-ish
  frontmatter), `taskIdFromFilename` and `nextTaskNumber`. No I/O.
- `lib/jira-queue.js` — the **verbs and their policy** for the Jira queue:
  `queueCountResult` / `queueCount`, `queuePick`, `claimTask`, `completeTask`,
  `commentTask`, `locateTask`, `failTask`, `titlesFor`. It holds no `acli` spelling — it
  holds *what a failure means for a queue*, which is where the interesting decisions
  live. Read the header for the two that a change is most likely to break: every label
  write is **read-then-union** (a bare `--labels` write would wipe a team's labels if
  `--labels` turns out to replace rather than append, and nothing here can find out
  which), and `ok: false` on `completeTask`/`failTask` means **only** that the terminal
  label could not be written — a refused transition and a stuck `in-progress` are
  warnings on `stderr` and a successful write.
- `lib/jira-jql.js` — **pure JQL composition, no I/O.** `composeJiraJql` wraps the user's
  `JIRA_JQL` in parentheses, appends `JIRA_LABEL_EXCLUSION`, and appends
  `JIRA_DEFAULT_ORDER_BY` (`ORDER BY created ASC`) unless the user's clause ends with an
  ordering of its own, in which case that ordering is cut off and put back verbatim last.
  It also **owns the three label constants** — `JIRA_IN_PROGRESS_LABEL`,
  `JIRA_DONE_LABEL`, `JIRA_FAILED_LABEL` — and that is deliberate rather than incidental:
  the module that composes the query which *excludes* a label is the module that names it,
  so the write and the exclusion cannot drift into a loop that hands the same ticket out
  forever. An empty value is a **refusal** (`ok: false`), never a permissive default,
  because Ralph's half alone selects every work item on the site.
- `lib/jira-key.js` — the key grammar, `/^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/`, and **two
  deliberate postures** that a change must not collapse into one. STRICT (`isJiraKey`,
  `normalizeJiraKey`, `numberFromKey`) refuses anything the grammar does not recognise,
  and is what guards the one place a key becomes **query syntax** (`titlesFor`'s
  `key IN (…)`). PERMISSIVE (`usableJiraKey`) passes any non-blank string through,
  because everywhere else the key is the *subject* of an `acli` call in its own argv slot
  — refusing a project key Ralph's regex has never seen would be Ralph overruling the
  board.
- `lib/jira-acli.js` — the argv layer and the spawn seam; see [Jira maturity](#jira-maturity--the-stub-is-the-only-jira-ralph-has-met)
  above, which is the section that governs edits to it.
- `lib/jira-auth.js` — `probeJiraAuth`, the one `acli jira auth status` invocation, shared
  by `ralph doctor`'s `jira auth` row and `ralph cycle`'s preflight. **Sharing the
  function and not just the argv is the guarantee**: the diagnostic cannot report
  `✓ jira auth` on a machine where the cycle refuses to start.

### Testing them: injected `exec`, and never a real `acli`

Every Jira module that spawns takes its process spawner as an **injected `exec`, with no
default** — `jira-queue.js`, `jira-acli.js` and `jira-auth.js` all do. Two properties
depend on that and both are pinned:

- **No importer gains a spawner.** A defaulted parameter would need a module-scope
  `import { execa }`, which would put execa on the import graph of every importer —
  including a command that only wanted the pure count. So callers hand the spawner down
  (`lib/commands/status.js` and `lib/commands/cycle.js` each default their own
  `exec = execa`; `bin/ralph.js` injects one for `doctorCommand`), and `jira-queue.js`
  names `execa` exactly once, as a **dynamic** import inside its CLI verb.
  `lib/jira-queue.qa.test.js` pins the static import list to
  `['./jira-acli.js', './jira-jql.js', './jira-key.js', 'node:path', 'node:url']` and
  asserts those three are **edgeless** — they import nothing at all. Adding a name to
  that import list means updating the pin; do not reflow an `import` line in
  `jira-queue.js`, because the pin reads the specifier off every line beginning
  `import ` and a wrapped statement makes it throw rather than fail.
- **`ralph doctor` stays reachable-from-nothing.** `lib/jira-queue.js` must not appear on
  doctor's import graph at all — `lib/commands/doctor.version-line.qa.test.js` extracts
  dynamic specifiers as well as static ones and greps every file on the graph for the
  token `execa`, so the laziness above is a runtime property and not a pass. A diagnostic
  that wants Jira knowledge imports `./jira-jql.js` or `./jira-acli.js`, both pure and
  edgeless; anything needing a live count belongs behind an injected seam.

**No test may invoke the real `acli`, ever** — the standing rule from
[Jira maturity](#jira-maturity--the-stub-is-the-only-jira-ralph-has-met), restated here
because it is a rule about *tests* and not about documentation. Four of the eight `acli`
invocations write to somebody's live board, and there is no `acli` in CI. Unit tests pass
a fake `exec` and assert the argv it was handed. The tests that must exercise a real
spawn — `lib/jira-queue.qa.test.js`'s CLI-footer suite and
`test/loop.jira.adversarial.test.js`, which drives the whole bash arm end to end — write
a **bash script named `acli` into a temp directory and put that directory on `PATH`**
(the CLI-footer suite makes it the *only* entry; the loop test prepends it), so the real
CLI is not what gets run, and the stub records every argv it was handed. The stub never
comes off `PATH`, not even in the test about a missing binary: that test has the stub
answer the way an absent command does instead. If
you need to see the real thing, do it by hand against a throwaway project.

## The sprite banner: generated asset, placeholder art

`ralph start` plays a one-second pixel-sprite splash as its first output on a
colour terminal, settles it on a still frame, and prints an identity box on every
run — **beside** the sprite from 72 columns up (#161) and under it on every
narrower window — or as much of that as `RALPH_BANNER` asked for (see
[the README](./README.md#quick-start)). Since #75 `ralph doctor` heads its report
with that same box, and since #76 `ralph status` heads its human view with it
too — out of the same composer and the same setting, and with none of the pixels
in either: three commands share this half, one shares both. Twelve published
modules under `lib/` back the two halves, the join between them and the setting
that governs them, the first of them fed by a generator that is not published at
all:

- `lib/sprite-data.js` — **GENERATED. Do not edit by hand.** It is the committed
  asset: a palette plus one row-per-pixel grid per frame. Regenerate it, never
  patch it:
  ```bash
  node scripts/generate-sprite.js <source.gif>   # → lib/sprite-data.js
  ```
  The generator is deterministic — same GIF, same flags, byte-identical module —
  which is the whole reason hand-editing is pointless. `--help` lists the grid,
  palette-size and near-black flags; the defaults are the measured values for the
  intended source art.
- `lib/sprite-render.js` — the pure half-block renderer (two pixel rows per text
  row, so a 26x34 grid draws as 26 columns x 17 lines).
- `lib/sprite-banner.js` — the *decision*: may we draw, and what exactly gets
  printed. All three of its inputs (**stdout** TTY-ness, the colour policy, and the
  terminal's `width`) arrive as arguments, and `ralph start` resolves them into
  injectable `stdoutIsTTY` / `color` / `width` options rather than reading
  `process.stdout` or `process.env` anywhere down the stack. Keep it that way — a
  module that read `process.env.NO_COLOR` itself would turn every test that injects
  an environment into a test of the contributor's shell, which is what
  [test hermeticity](#test-hermeticity-41) exists to prevent. `NO_COLOR` is
  honoured on **presence** here, deliberately unlike picocolors' truthiness test;
  the reasoning is in the module's docstring and the README's env-var row, and both
  should move together if it ever changes. The width is asked **last** and is only
  ever a reason to stay silent, so no column count can talk a piped stream into a
  screenful of escapes — and it holds no threshold of its own: it asks
  `bannerLayout` (below) for the verdict. Do not give this module a 26 of its own.
  Two copies of that number are two thresholds the day one of them moves, and the
  failure would be silent — a sprite still drawn at 25 columns above a box that had
  already unboxed. Since #73 that one gate answers **two** entry points:
  `renderSplashFrames`, every frame in the order the splash plays them, which is what
  `ralph start` calls; and `renderStaticBanner`, the poster frame alone, which **no
  command calls any more and which stays anyway**. It is the oracle — three specs
  compare the frame the animation settles on against its output, so "the splash ends
  on the frame an unanimated banner would have drawn" is a comparison between two
  functions instead of a claim about one. Do not retire it as dead code; a caller
  with no stream to write to has no other answer available.
- `lib/sprite-player.js` — the splash (#73), and the **one impure module** in this
  list: it writes bytes to a stream and waits between them, which is why it is a
  file of its own rather than a loop inside `start.js`. Everything it is impure
  through arrives as an argument — the stream, the `sleep`, the signal source, the
  re-raise — so a one-second animation is a sequence a test compares byte for byte
  in microseconds, with no timer and no listener on the real process. Two rules
  worth keeping — and the second is why #161 grew the frames without touching this
  file. **The bound is structural:** `splashSequence` builds a fixed array
  before the first byte goes out and the loop is a `for...of` over it, so a splash
  can never hang a `ralph start`; there is no `while`, no clock comparison and no
  interval, and a static read in the spec asserts that absence. **It knows no
  height:** every cursor-up is counted off the **newlines in the chunk just
  written**, so regenerating
  the art at another size cannot desync the animation from it — a hardcoded `17`
  here is the bug that walks the cursor up through the previous run's output. That
  is also the whole reason #161 could hand this module frames with an identity box
  glued into their right-hand margin and change nothing here: a wider or taller
  frame redraws exactly as correctly as a bare one, because the count came from the
  chunk rather than from the sprite. It
  holds no gate either: `renderSplashFrames` answers with an empty list on a pipe,
  under `NO_COLOR` and below 26 columns, and an empty list plays *nothing* — not a
  sleep, not a cursor toggle, not one byte. `cycles: 1` is byte-for-byte the
  unanimated banner, and that is the whole of `RALPH_BANNER=static` (#74): the mode
  resolver hands this module the same frames and a `cycles` of 1, and adds nothing
  else here — no mode, no knob, no notion of `full`/`static`/`off`. Keep it that way;
  a `RALPH_BANNER` read in this file would put the policy in two places, and the one
  that matters is `lib/banner-mode.js`'s. The two seams are
  this module's defaults and **`start.js` forwards them rather than defaulting them
  itself**, so `sleep` and `signals` are named once, here, where the spec asserts them.
  The consequence for a contributor: any test that drives `startCommand` over a TTY
  stdout has to inject both, or it buys a real second of wall clock per run and hangs a
  SIGINT listener on the vitest worker's own process.
- `lib/banner-compose.js` — the banner's *other half*: the identity box, composed
  from **resolved facts**. Since #122 it is the **frame** alone — every line's
  width, clip, colour and border — and the rows it draws come out of
  `lib/banner-rows.js` below; the paragraphs here that name a particular row
  still say *why that row reads the way it does*, and the file to edit for its
  wording is the other one. Pure in the same way and for the same reason — no
  `process`, no clock, no fs, and no cache read of its own — so `ralph start`
  resolves every fact on the impure side (the installed version, the working
  directory, the cached `latest_version`, the newest release's changelog
  bullets, and since #69 the agent, its model and that model's *provenance*, the
  context window, the task source and the repo slug) and hands them over. Injectable options carry the rest: `columns`,
  defaulting to `stdout?.columns`; `readCache`, defaulting to `readVersionCache`;
  and `readChangelog`, defaulting to `readChangelogEntries`, with a `changelogFs`
  beneath it so the default wiring is testable too. The last two are seams for the
  same reason: no suite may read a real `~/.config/ralph` or the shipped release
  notes, so neither a contributor's own pending update nor whatever this week's
  changelog happens to say can add a row to another suite's expected output. Later
  slices add **rows, not parameters**: `composeBanner`'s three arguments (`facts`,
  `width`, `capabilities`) are the seam, and a new fact belongs in the object
  `start` already builds — which is exactly how #70's what's-new rows landed, as a
  `whatsNew` entry in that object with the signature untouched. #75 added the
  second caller on that same seam: `ralph doctor` passes `os`, `agent` and
  `cachedLatest` and gets the `os` / `agent` / `cached` rows for them, while
  `ralph start` passed none of the three and was unchanged to the byte — because
  each of those rows is **gated on its fact being present**, unlike every older
  row, which says `unknown` when it was not given one. A caller that never asked
  a question has no answer to report, and `os      unknown` in a pasted bug
  report would send a reader hunting a platform-detection bug that does not
  exist. #69 then landed five more facts on the same seam and made `agent` the
  one both callers pass, and the gate is what kept `doctor`'s box byte-identical
  regardless: `agent` is no longer a lone fact but a **sentence** built from
  three (`agent`, `model`, `provenance`), and a caller that passes no
  `provenance` gets the bare `claude` row it has printed since #75 — decided
  *first*, before anything about the model. Keep that ordering. `doctor` is a
  diagnostic about an **installation**, and `claude — model resolves at first
  run` in a pasted bug report would be a sentence about a run `doctor` never
  looked at. The wording per provenance lives with the rows rather than in the
  resolver (`MODEL_SUFFIX`, and `MODEL_UNKNOWN` for the tag that names no
  model), and it is deliberately not *imported* from `banner-model.js` — each
  half's import list is one line long on purpose — so `banner-rows.test.js`
  holds the two together instead: it enumerates `MODEL_PROVENANCE` and demands a
  **distinct** sentence for every tag in it, which makes a fourth tag with no
  wording a red test rather than a row nobody wrote. `context` is the one
  **numeric** row in the box, which is why it has a gate of its own (`textOr` is
  the wrong one for a number, and coercing one to check it would run a hostile
  `valueOf` on a value that came out of a JSON log); it is also what fixes the
  label gutter at eight, since `context` is the longest label this box will ever
  draw — the row is composed next door, `LABEL_WIDTH` is measured here.
  `cachedLatest` is deliberately a separate fact from `latestVersion`
  rather than a second reading of it: `latestVersion` is advice and draws a row
  only when there is something to act on, `cachedLatest` is a *reading of the
  cache* and always draws one, including the "nobody has checked yet" state a
  diagnostic must not swallow. Keep them apart, or `ralph start` grows a row and
  `doctor` loses a verdict. `os` rather than `platform` is arithmetic, not taste:
  the label gutter is eight columns and `padEnd` does not grow, so `platform`
  would print `platformmac`. #76 added the third caller, and it is the argument
  for this seam rather than a strain on it: `ralph status` passes `version` and
  `cwd` and nothing else, and gets a one-row box out of the same composer with no
  new parameter, no new row, and not a line changed in this module — which is what
  "rows, not parameters" was supposed to buy. The `width`
  argument is the one that came home to roost: `bannerLayout(width)` is the whole
  degradation ladder in one pure, total function — box from `BOX_MIN_WIDTH` (44)
  up, sprite from `SPRITE_MIN_WIDTH` (26) up, box *beside* the sprite from 72 up,
  and any width that cannot be used at all falling back to the 60-column
  `BANNER_WIDTH` rather than throwing or degrading. That third rung is #161's and
  it is **derived, never spelled**: `beside` is `width - SPRITE_MIN_WIDTH -
  BESIDE_GAP >= BOX_MIN_WIDTH`, so 72 is the three published numbers added up
  rather than a fourth constant to keep in step with them, and it is true only
  where the leftover can hold a *framed* box — a bare box is always a stacked one.
  `besideWidth` is that same leftover capped at `BANNER_WIDTH`, which is 44 at the
  rung and 60 from 88 columns up, and it is what `start.js` composes the box at
  when it is going to glue it on; the field is floored at zero rather than left
  negative because it reaches a `repeat` in `banner-beside.js`, and it is
  meaningless — not absent — wherever `beside` is false. `BESIDE_GAP` (2) lives
  here rather than next to the join for the reason `LABEL_WIDTH` does: a gutter is
  a number of *columns*, so the half that knows how wide the terminal is owns it,
  and exporting it is what keeps the subtraction and the spaces from disagreeing.
  It is the *only* place any rung is read — `start.js` asks it where to put the box
  exactly as `sprite-banner.js` asks it whether it may draw, and neither holds a
  number of its own — which is what makes every
  one of them testable without a terminal, and the two line forms it selects
  between (`BOXED` / `BARE`) are data rather than a conditional inside each builder
  — so a box whose top is framed and whose rows are not is unreachable. `26` is
  deliberately **not** imported from `sprite-data.js` (this half knows nothing about
  pixels); a test pins `spriteWidth === SPRITE_MIN_WIDTH` instead, so redrawing the
  art wider goes red in the suite rather than tearing on a narrow terminal. The box is
  deliberately **not** capability-gated the way the sprite is — facts belong in a
  launchd log too — so a piped `ralph start` is no longer byte-identical to a
  pre-banner one, and an assertion about what a non-TTY run does *not* print has to
  name the sprite rather than ANSI in general (`expectNoSprite` in
  `lib/commands/start.banner.qa.test.js`, whose comment says why).
- `lib/banner-rows.js` — the rows (#122), split out of the composer once that
  file had grown two jobs: **what the box says** and **how wide it is**. The seam
  is text versus columns. `bannerRows(facts)` answers with an ordered list of
  `{ label, value, paint }` records and is the only export the frame calls; every
  builder behind it (`factRows`, `agentRows`, `contextRows`, `updateCheckRows`,
  `whatsNewRows`) reads facts and returns strings, and not one of them knows a
  width, a border glyph or a terminal. Three rules worth keeping. **The order of
  the list is this module's decision, not the frame's** — the frame draws what it
  is handed, in the order it is handed it, so a row that should sit above `cwd`
  moves here and nowhere else. **The gates travel with the rows**: `textOr` (which
  *refuses* a non-string rather than coercing it, then trims, then replaces control
  bytes with `U+FFFD`) and the separate numeric gate on `context` guard the values
  on the way in, which is why a hostile `toString` on a fact out of a JSON log
  cannot reach the frame at all. **A row names its own colour**, so the palette
  (`YELLOW`, `GREEN`, and the shared `COLOR_OFF`) lives here and the frame only
  splices what it was given and closes it — which is what keeps the frame half free
  of escape sequences entirely. Pure and total like its neighbours, and asserted so
  by a static read: no `process`, no clock, no fs, no `picocolors`, and — the new
  part — no width arithmetic and no sight of `26`/`44`/`60`. Its import list is one
  line long (`update-check.js`, for the semver comparison behind the update hint),
  and the frame's is now one line long too: `banner-rows.js`. The seam runs one way;
  a row that reaches back for the frame is the split undone. **So a new row is a
  one-file change — this one** — with exactly one obligation on the far side of the
  seam: its label must fit the frame's gutter with air after it, which means **at
  most seven columns**, because `rowLine`'s `padEnd` does not grow and an
  eight-character label prints `platformmac` with no space at all. That number
  cannot be *imported* here — the purity sweep forbids this file the string
  `LABEL_WIDTH` along with every other width — so it is held across the seam by a
  spec instead: `banner-rows.test.js` imports the constant and measures the labels
  `bannerRows` actually produces against it, and `banner-rows.seam.qa.test.js` asks
  the same question of the rendered box at every rung of the ladder. A ninth-column
  label is a red test, not a squashed row. See
  [the yardstick rule](#a-spec-that-cannot-go-red-122) for why one of those two
  imports the gutter and the other retypes it.
- `lib/banner-model.js` — the fact the box cannot simply be *handed* (#69, and
  the only one left here since #116 gave the repo slug a module of its own
  below): which model the agent will use. Every other row is a lookup the caller
  already holds; this one is a question, and its answers differ in **quality** —
  which is the whole reason `resolveBannerModel` returns a **`provenance`**
  alongside the model, and why `MODEL_PROVENANCE` (`last-run` / `configured` /
  `unknown`) is exported and frozen. That tag is a **correctness requirement,
  not a garnish**: the box must never state a model with more confidence than
  its source warrants, so if you add a fourth kind of evidence, add a sentence
  for it in `banner-rows.js` in the same commit — the spec next door will
  tell you if you forget. Pure and total in the same way the composer is, and
  asserted so by a static read: no clock, no `process`, no fs. The file it
  reasons about arrives as **text**, which is what makes every case in its spec
  a string literal rather than a fixture on disk (see
  [test hermeticity](#test-hermeticity-41)) — there is no `.ralph` directory and
  no previous run anywhere in that suite. Four rules worth keeping.
  **The log answers for Claude, the config answers for Codex:** Codex's stream
  carries no model id, so what the log holds for a Codex run is the configured
  `RALPH_CODEX_MODEL` one run staler, and consulting it would also let a log full
  of Claude runs put a Claude model on a Codex row the first time a project
  switched agents. **The newest parseable event decides, full stop:** an event
  with no model, or one belonging to a *different* agent, answers `unknown` rather
  than sending the scan further back, because an older run's model is not a fact
  about the last run and tagging it `last-run` would be exactly the overstatement
  the tag exists to prevent. Do not "improve" that into a search. A truncated or
  garbage trailing line is skipped, which is the normal state of a file the loop
  appends to with `>>` and can be killed mid-write — and since #121 that skipping is
  `lib/issue-event-lines.js`'s, not this module's, so a change to what counts as a
  log line belongs there. **Both of its imports are borrowed from the telemetry
  side, not copied:** `resolveContextWindow` comes from `lib/issue-event.js`, the
  very function that resolves `context_window` when an event is *written*, and
  `newestIssueEvent` comes from `lib/issue-event-lines.js`, the same *gate* over the
  same `RALPH_ISSUE_EVENT` lines that `ralph cycle` and `ralph status` read them
  with, walked from the other end: those two go forward through every event, the box
  wants only the newest, so it reads from the tail and stops at the first line that
  parses. One argument twice: the box and the log cannot come to disagree about a
  model id or about which lines are events, and a second prefix map or a second
  parser here is precisely how they would — which is what #121 removed, three copies
  of the walk at a time. Neither edge costs the box a capability — `issue-event.js`
  reaches only `agent-stream.js`, and `issue-event-lines.js` imports nothing at all,
  which is the whole reason the shared walk is its own module rather than part of
  `lib/issue-metrics.js`, where it would have arrived wrapped around `node:fs`. The
  static reads next door pin that rather than trusting it. **And it never
  throws**, on the same grounds as the rest of the banner: every input is
  type-checked rather than coerced, because `String(value)` on a hostile bag runs
  its `toString` and these values come from an ambient environment and a file
  nobody reads as bytes. #69 changed **nothing**
  about the telemetry: no new event field, no changed event shape — the box is a
  reader of `issues.jsonl` and never a writer of it.
- `lib/git-remote-slug.js` — the box's *other* resolved fact, and the whole of
  #116: which repository the loop will read issues from, which is git's config
  format and git's two url grammars reduced to `owner/name`. It was written in the
  **back half** of `banner-model.js` (#69) rather than at its bottom — six of that
  module's own helpers went on below it, which is part of why the seam went
  unread — and carried out of it **unedited**: the two halves shared that module's
  purity, its never-throws contract and two five-line helpers, and no code path,
  no caller's question and no test that asserted both, which is what made #116 a
  move rather than a rewrite. It is the same discipline as the resolver above,
  applied to a *grammar* instead of to evidence. `GH_REPO` decides when it is set
  (it decides for `gh`, so it decides for the loop), otherwise `origin`'s url out
  of `.git/config`, parsed line by line rather than with one whole-file regex —
  and a bracket line the parser cannot read **closes** the origin section rather
  than leaving it open, because attributing a fork's `[remote "upstream"]` keys to
  `origin` would put a repository on screen that the loop is not about to read. A
  slug it cannot resolve is `null`, which the composer's gate turns into no row;
  `unknown` would be a claim, and a missing row is not. **What "set" means is the
  caller's business and has never been visible in this module:** #120 made
  `bannerRepoSlug` resolve that value out of `ralph.config.sh` **over** the process
  environment — the loop's own precedence, on the presence test the `banner-mode.js`
  entry below argues for `RALPH_AGENT` — and this module still takes one string and
  asks nothing about where it was found. A committed `GH_REPO=""` therefore arrives as the blank it is,
  and a blank is not "set" here, which is exactly the `origin` row the loop's own `gh`
  calls will resolve for that file. That the grammar was unchanged by #120, and would
  be unchanged by the next such decision, is what the seam is for. Pure the way the
  rest of this list is pure and one step further — it **imports nothing at all** — and
  asserted so by a static read of its own. The config file arrives as an argument,
  which is what makes every case across its three **behavioural** specs a string
  literal rather than a fixture on disk (see
  [test hermeticity](#test-hermeticity-41)): there is no `.git` directory and no
  checkout anywhere in any of the three. Its **fourth** spec —
  `git-remote-slug.extraction.qa.test.js`, the guard over the move's own seams —
  does read files off disk, by design: what it reads is *this repository's own
  source*, a static sweep of `lib/`, `bin/` and `test/` for a caller still pointed
  at the old door. Source is not a fixture and needs no checkout of anybody's
  repository, which is the distinction that keeps both claims true at once. Two
  decisions of #116's are argued at length in the module header, and neither is
  worth re-litigating from this file. **The two helpers are duplicated rather than
  shared:** `bagOf` and `trimmedOr` have a twin in `banner-model.js`, because the
  nearest existing home for them — `lib/utils/env.js` — opens `node:fs` on its
  first line and would cost this module precisely the purity its own spec asserts,
  and a third module whose only reason to exist is being imported twice would put
  back the coupling the split just removed, one indirection worse. Ten lines with
  no behaviour between them are the cheaper of the two costs; a drift guard in
  `git-remote-slug.extraction.qa.test.js` holds the twins identical, and a *third*
  caller is the point to reconsider, not this one.
  **And the export keeps its caller-oriented name** in a module named for the
  grammar: `remoteSlug` / `pathSlug` are the general half, and `resolveBannerRepo`
  is the banner's particular question layered on top of it (`GH_REPO` first, because
  that is what `gh` reads first). A general name over that particular *policy* would
  be the inaccuracy — nothing about `owner/name` says `GH_REPO` wins — so the name
  stayed where #69 put it. A second command with a different question adds a second
  export beside it rather than a rename.
- `lib/changelog.js` — `CHANGELOG.md` **as data**, for the box's what's-new rows:
  text in, ordered release entries out, and nothing else. Pure, and it takes a
  *string* rather than a path, so every shape it has to survive (an empty file, a
  bullet wrapped over three lines, a CRLF checkout) is a string literal in a test
  instead of a fixture. It is **total** — a changelog nothing can be made of is
  *no entries*, never a throw, because `ralph start` prints this box before its
  first preflight line and must not abort over its own release notes. It holds no
  semver opinion either: release-please writes newest-first, so the parser reports
  the order it read rather than sorting, which is the same refusal to have a second
  version opinion that `banner-rows.js` makes above it.
- `lib/changelog-file.js` — the impure half of that pair: one path, one read.
  `changelogPath()` joins `RALPH_HOME` (which `lib/paths.js` derives from
  `import.meta.url`) and **never the cwd** — `ralph start` runs inside the user's
  repo, and that repo has a `CHANGELOG.md` of its own, so a cwd-relative read would
  put somebody else's release notes in Ralph's banner. Every failure is `[]`: a
  missing file, an unreadable one, an fs that is not one — a policy that belongs
  to `readChangelogEntries` and the banner **alone**, because that read happens
  before `ralph start`'s first preflight line. `lib/commands/changelog.js`
  (`ralph changelog`, #71) takes the same `changelogPath()` and the same
  `parseChangelog`, so the two can never disagree about what a release
  contained, but does its own guarded read on purpose: a user who *typed* a
  command about the changelog is owed the failure, named, with the path in it and
  a non-zero exit. Do not unify them on the reader that swallows everything.
  `CHANGELOG.md` is in `package.json`'s `files`, which is what makes the section
  affordable on every start — the answer is already on disk beside `lib/`, so
  there is no round trip in front of the first paint — and what makes
  `ralph changelog` answerable offline, from any directory. Keep it that way if
  you touch either file.
- `lib/banner-beside.js` — the **join** (#161), and the only module in this list
  that touches both halves: `joinBeside({ spriteLines, boxLines, spriteWidth, gap })`
  takes two blocks of *finished* lines and returns one, with the box glued into the
  sprite's right-hand margin, top-aligned (box line 0 on sprite line 0) behind
  `BESIDE_GAP` columns of air. It is one degree purer than the rest of the banner
  and that is the rule to keep: **not one escape byte of its own**. The painting is
  over before the join begins, so what it puts between the blocks is spaces — a
  module that wrote an escape here would be a second place a line could be
  corrupted, downstream of the clip in `banner-compose.js` that made the first one
  safe. **The sprite's width is stated, never measured**, which is the whole reason
  this is a module and not two lines at the call site: `sprite-render.js` writes a
  reset, a foreground and a half-block per cell, so a 26-cell row is well over two
  hundred code points and no honest count of the string is where the box's first
  column goes. `start.js` passes `spriteWidth` from `sprite-data.js`; do not
  replace it with `line.length`, and do not teach this file to strip an escape.
  Two shapes are deliberate in the output: a row the box does not reach is the
  sprite's own string **byte for byte, with no trailing padding** (the sprite has
  no right border to reach, and ninety trailing spaces per row is noise in every
  transcript), and a row the sprite does not reach is the box indented into the
  same column, so a box taller than the picture keeps all four of its sides — which
  no shipped caller produces, since `ralph start`'s box is at most 12 rows against
  the sprite's 17, but the join is total either way — it runs before the first
  preflight line, so a nonsensical width or a list that is not a list has to cost a
  worse-looking banner and never the run. `BESIDE_MAX_COLUMNS` (1000) is the half of
  that worth naming: the padding is built with `String.prototype.repeat`, so a
  `Number.MAX_SAFE_INTEGER` that satisfied every shape guard could still only ever
  throw a `RangeError` from inside a picture. Same defect `SPLASH_MAX_FRAMES` closes
  in `sprite-player.js`, stated in the same words — a safe integer is a shape, not a
  size — and it is a **ceiling, not a clamp**: over the line falls back to no
  columns for a width and `BESIDE_GAP` for a gap, because clamping a billion to a
  thousand would draw the box a thousand columns off the left edge of an
  eighty-column terminal. Nothing in the CLI can reach it. The one import is
  `BESIDE_GAP` from `banner-compose.js` and the edge runs one way: that file knows
  nothing about this one.
- `lib/banner-mode.js` — the *policy* (#74), and the one module here that sits above
  both halves: how much of all of the above the user actually asked for. One pure
  function — `resolveBannerMode({ configured, override, isTTY, color, width })` —
  returning the three decisions `start.js` needs (the effective `mode`, whether there
  is a `sprite`, whether the `box` prints at all) plus a `warning` it does **not**
  print, for the same reason `resolveAgent` returns one: a module that wrote to stderr
  could not be asserted as a table, and only the caller knows which stream a warning
  belongs on. Three rules worth keeping. **Precedence is environment over config**,
  deliberately the opposite of the `TASK_SOURCE` line in `start.js`, because a task
  source is a property of the repository while a banner is a property of one
  invocation — do not "harmonize" the two, and do not describe precedence in the docs
  as if one rule covered both. **The capability cap runs downward only:** `full` into
  a pipe behaves as `off`, and no value, spelling or combination can put a sprite on a
  non-terminal — the only hatch is still the programmatic one `sprite-banner.js`
  documents. **And the cap stops at the sprite:** `mode` is what the terminal can
  effect, `box` is what the user *requested*, which is why they are two answers rather
  than one — a piped `ralph start` has printed the identity box since #68, and only an
  explicit `off` may take it away. It holds no threshold of its own (`bannerLayout`
  answers the sprite rung, exactly as `sprite-banner.js` asks it) and no opinion about
  what the box *looks* like: an earlier draft of #74 resolved the frame here and passed
  it down as a capability, which made two owners of one decision, so it is gone. The
  impure half is the caller's, and it moved for this: `start.js` reads
  `ralph.config.sh` (text-parsed with `parseConfigVar`, never sourced) at the **top**
  of `startCommand`, above the picture that file decides, and puts the warning on
  stderr behind the same `⚠️` prefix `ralph init` uses for a mistyped `RALPH_AGENT`.
  Only the read moved, and #69 moved exactly one derivation up after it: `TASK_SOURCE`
  is now resolved beside the banner's other facts, because the box *names* it (the
  `source` row), and the preflight step that spends it reads that same binding rather
  than resolving a second one. `RALPH_DIGEST_INTERVAL` is still derived at the step that
  uses it, out of that same one read, and #69's three knobs — `RALPH_AGENT`,
  `RALPH_CODEX_MODEL` and `RALPH_CONTEXT_WINDOW` — are text-parsed out of it too, with a
  **fourth** since #120: `GH_REPO`, behind the `repo` row. That one is `gh`'s variable
  rather than Ralph's and no template declares it, which is the whole case for having
  read only the environment and is not enough — a project that has one has it because
  somebody committed it, and `set -a` then makes it decide for every `gh` command the
  loop runs, so a row whose stated guarantee is that it names what the loop will read
  has to read it the same way round. That read sits inside `bannerRepoSlug`, which is
  the only reason that helper is handed a config reader at all — since #149 it takes the
  `sourcedValue` **closure** rather than `configText`, so the read still happens *inside*
  its `try` and a hostile `GH_REPO` accessor costs the row instead of the launch. So
  three of those four are read at
  the box's own call site; `RALPH_AGENT` is not, since #118 moved its `resolveAgent`
  call up beside the banner's warning. The command now has
  to *warn* about a mistyped value as well as name the resolved one, and the box spends
  that same binding rather than resolving a second time — two sites resolving one value
  are two owners of one decision, and a box naming one agent under a warning naming
  another fallback is exactly the confusion #69 was filed about. All of those take the
  **file over the environment**, matching the loop, which sources `ralph.config.sh` with
  `set -a`; `RALPH_BANNER` is the one exception in
  the other direction and the paragraph above is why. Since #149 that precedence is
  **one rule** rather than a rule plus a recorded divergence, and it is a **presence**
  test rather than a truthiness one — `configAssignsVar(configText, name)
  ? parseConfigVar(configText, name) : processEnv[name]`, one ternary, declared once at
  the top of `startCommand` as a single-argument `sourcedValue(name)` closure and called at **every**
  knob of the box: `RALPH_AGENT`, `GH_REPO`, `RALPH_CODEX_MODEL`,
  `RALPH_CONTEXT_WINDOW` and `TASK_SOURCE`. The reason is that `parseConfigVar`
  answers `''` both for a file that never mentions the knob and for one that blanks
  it, while bash treats those two as opposites: `set -a` exports a blank assignment
  *over* an inherited value. Do not "simplify" any of them back to a `||`, and do not
  add a knob that skips the closure. On `RALPH_AGENT` a `||` reads the environment for
  a `RALPH_AGENT=""` the loop will mask, which warns about a value no run will read
  and puts an agent in the box the loop is not about to launch. On `GH_REPO` it names
  a whole **repository** no call in the run will touch: a blank assignment masks the
  environment, so the loop's `gh` reads an empty variable, treats it as unset and
  resolves its base repository from `origin` — and `resolveBannerRepo` treats a blank
  `ghRepo` the same way, which is why handing the blank straight through is what puts
  `origin`'s slug on the row while a `||` would reach past it into the environment.
  On `RALPH_CODEX_MODEL` and `RALPH_CONTEXT_WINDOW` — the two knobs #149 was filed
  about, `||` until then — it was cosmetic but wrong in the box's own terms: a repo
  that blanks `RALPH_CODEX_MODEL` while the invoking shell exports one got a row
  naming a model `buildAgentInvocation` would never be handed (it now reads *model
  resolves at first run*, with no `context` row at all, which is what a run passing
  no `--model` actually does), and a blanked `RALPH_CONTEXT_WINDOW` got the shell's
  number over the window `capture-issue-event.js` records for the run's very first
  event. On `TASK_SOURCE` it was never cosmetic: the box's `source` row and the
  **preflight** read one binding, so a blanked knob made the command count a folder
  queue and skip `gh auth status` for a loop about to read GitHub issues. That knob is
  an ordinary caller of the closure like every other: the review looked for a reader
  of its own to preserve and found none, since `lib/read-config-source.js` defines
  `parseConfigSource` as `parseConfigVar(text, 'TASK_SOURCE')` verbatim. Two tripwires
  keep that honest, one per half. `lib/commands/start.sourced-value.qa.test.js` asserts
  the two **readers** agree on every config shape, so a `parseConfigSource` that grew
  spellings of its own would part `ralph start` from the `cycle`/`status`/`doctor` trio
  that still call it. `lib/parse-config-var.test.js` asserts the shared reader never
  calls a line **absent** while the value reader reads a value out of it, which is what
  keeps one knob's **value** and its **presence** on one grammar.
  What a *name* still buys, now that the rule is the default, is that a knob which
  **departs** is visible **by not calling it**, and exactly one does: `RALPH_BANNER`,
  inverted. Do not read the closure as an inventory of the command's config reads
  either. `RALPH_DIGEST_INTERVAL` and the digest window's `RALPH_AGENT` and
  `RALPH_DIGEST_MODEL` sit outside it, **all three** of them **config-only** with no
  environment fallback at all — `digestInterval` in `lib/digest-file.js` reads only the
  text it is handed, exactly like the two `parseConfigVar` calls at the window's launch —
  which is a *third* precedence, after this rule and after `RALPH_BANNER`'s inversion. Which is where
  "matching the loop", above, needs its one caveat, and #122 measured it against a
  real bash: of the six ways a file can blank a knob — `=""`, `=''`, a bare `=`,
  unquoted trailing spaces, an `export` of any of those, and quoted whitespace —
  **five leave the loop holding the empty string**, which the presence test now
  matches on all five; only quoted whitespace is a value bash keeps, and on that one
  spelling nothing changed, because a kept value is a value. A **seventh** spelling
  only looks like one of those six: `NAME= ""`, with a space after the `=`, is bash's
  environment-prefix syntax, so bash assigns nothing and the loop keeps whatever it
  inherited. The #149 review found `parseConfigVar` reading that line as
  present-and-blank — masking a value bash leaves standing, and clearing a live
  earlier line in the same file — and `envPrefixedNothing` in
  `lib/parse-config-var.js` now refuses it on both readers. Two review rounds then
  found the same defect one spelling over — `NAME= ""`, then `NAME=# off`, where the
  `#` opens no comment because a comment only opens at a `#` that *begins* a word — so
  the refusal is no longer drawn around spellings at all: it models bash's own **word
  rule** (an assignment followed by a command word is an environment prefix and dies
  with that command), which sweeps in the *inventing* half of the same family
  (`NAME= folder`, read as `folder` by a parser bash assigns nothing for) along with
  it. Both halves are measured in `lib/parse-config-var.qa.test.js` — see *reads
  NOTHING off a line whose assignment bash throws away, and says so on both readers* —
  and the family is swept row by row against a real shell in
  `lib/commands/start.sourced-value.qa.test.js`. Four things stay outside the
  refusal. Three because bash really does assign there: an `export` prefix (the
  builtin applies the `NAME=` itself), a blank with nothing behind it (`NAME= `, a real
  assignment to empty), and a **line continuation that reaches the scan before any word
  does** — a backslash at the very end of a line is bash's continuation rather than a
  word, so on `NAME=v \` the line runs on and nothing is left to be a command word: bash
  assigns `v`, and the #149 review caught the refusal reaching that tail, which is #149's
  own defect one spelling over.
  That third rule is **narrower than "a tail ending in a backslash"**, and reading it that
  wide is licence to drop the half of the guard that does the work: `endOfWord` declines
  only where the word it is scanning is **still empty** (`i === start`). Where a word
  already has characters in it, a continuation can only add to a word that exists, and
  bash runs that word — `NAME=v a\` reports `a: command not found`, and `NAME=v \\`
  reports `\: command not found` (two backslashes are an *escaped* one, which is a word).
  The inherited value stands on both, and the refusal correctly fires on both; they are
  in the `refused` list in `lib/commands/start.sourced-value.qa.test.js`, so widening the
  rule to the whole tail turns those rows red. The other half of the same narrowness is a
  cost rather than a saving: where the **continuation line** is what carries the command
  word, bash assigns nothing and this reader still reads the line — `NAME=v \` over an
  `echo hi` leaves the shell holding what it inherited while the readers say `v \`. That
  is not a #149 regression (`main` reads the same two lines identically) and closing it
  needs the next line, which is a different scanner; it is argued at `endOfWord`'s guard.
  (The *value* on a real continuation is a separate, older divergence: bash joins the next
  line and drops the backslash, these readers stop at the newline and keep it, so
  `NAME=v \` reads as `v \` — and a *quoted* value keeps its quote pair too, because a
  tail outside the pair defeats the rule that would have unwrapped it, so `NAME="v" \`
  reads as `"v" \` where bash holds `v`. Write each assignment on one line.) The
  fourth is the **operator** tail, and it is a bail-out rather than a verdict: `;` and
  `&&` really do assign (`NAME=v ; true` leaves `v` standing), while `| cat` and `&`
  assign in a **subshell**, so the sourcing shell keeps what it held and this reader
  still reads the line — pinned rather than fixed, because no
  refusal reaches it without also refusing the tails that assign. The price was
  one spelling: `RALPH_DIGEST_INTERVAL=  2h  ` now opens no digest window, which is
  what bash makes of it, and no configuration this repo ships is written that way.
  `lib/commands/start.precedence.qa.test.js` drives a blanked file through the whole
  command and asserts that from outside, at every knob — including the preflight the
  `source` row is spent on. **`||` is not `set -a`**, and three commands still spell
  it: `lib/commands/cycle.js`, `lib/commands/status.js` and `lib/commands/doctor.js`
  read `TASK_SOURCE` as `parseConfigSource(configText) || env`, so a blanked knob
  makes them disagree with `ralph start` about which queue a run reads. That is the
  named follow-up, argued at `doctor.js`'s own site. Since #75 and #76
  this resolver has **three** callers, reading different parts of one answer:
  `lib/commands/doctor.js` does the same text-parsed read of the same file with the
  same precedence — which is what makes `RALPH_BANNER` one knob rather than two that
  share a name — but reads `box` alone. It passes **no `isTTY`**, so no arrangement of
  its arguments can authorise a sprite, and it **drops the warning deliberately**. That
  used to be half a constraint: wording one safely meant `oneLine`, which lived in
  `lib/digest.js` and so behind execa, and `doctor` is the command people run when
  things are already broken — it **imports** no process spawner and opens no socket, and a
  QA spec walks its whole import graph to keep it that way. Since #125 that import graph is
  the whole of the guarantee, because `doctor` does now *take* an `exec`: the Jira auth row
  runs `acli jira auth status`, and the runner reaches it as an **undefaulted option** that
  `bin/ralph.js` passes in, while `lib/jira-auth.js` — the module that spends it — imports
  nothing at all. Copy that shape if a diagnostic ever needs another subprocess, and do not
  give the option a default: a capability handed in as an argument keeps the graph closed,
  and a caller that supplies none gets a row saying the question went unasked rather than a
  verdict nobody observed. #108 removed the constraint
  (`oneLine` now lives in `lib/one-line.js`, which imports nothing, and `doctor` reaches
  it transitively for the `RALPH_AGENT` warning it *does* print) and left the judgement,
  which was always the better half: a typo in a **cosmetic** knob does not earn a line in
  a diagnostic. Do not "fix" that silence into a warning; it costs a `doctor` user
  nothing, and `ralph start` names it. `lib/commands/status.js` is the third, on the
  same read, the same precedence, the same absent `isTTY` and the same `box`-alone
  answer — and it drops the warning for a reason of its own, simpler and stronger
  than `doctor`'s: that command has **no stderr channel at all** (no `stderr` in its
  deps bag, deliberately), which is what keeps `ralph status --json` pipeable. Do not
  give it one in order to word a banner typo. It is also the one caller that does not
  always ask: `never-run` short-circuits *before* the resolver, because that mode is
  pinned as reading nothing — `ralph.config.sh` included — so resolving there would
  answer "draw the default box" out of a config nobody opened, and the box names a
  run that mode does not have.

**The committed art is a placeholder.** This repository carries no Wreck-It Ralph
GIF and never did — #66 made the source a developer-supplied *input*, which is why
the generator takes a path instead of a constant — so `lib/sprite-data.js` was
generated from a synthesized, original, obviously-not-Ralph stand-in put through
the real generator unedited:

```bash
node scripts/placeholder-sprite-source.js   # deterministic GIF, written to the OS temp dir
node scripts/generate-sprite.js <the path it just printed>
```

Swapping in real art is **one command** (`node scripts/generate-sprite.js
ralph.gif`) — no test pins a pixel or a colour. Afterwards, four placeholder files
are deleted **together**, and the two spec files among them are designed to go red
the moment the real art lands, which is the reminder:

```
scripts/placeholder-sprite-source.js
scripts/lib/placeholder-art.js
test/sprite-placeholder-source.test.js
test/sprite-placeholder-source.qa.test.js
```

In that last one, **keep or move the packaging block** (the `npm pack` manifest
closure check) — it guards what the published tarball contains and is worth having
with or without a placeholder.

Everything under `scripts/` is **development-only and unpublished by
construction**: `package.json`'s `files` is an allow-list (`bin`, `lib`,
`templates`, and two markdown files), so there is no ignore rule to keep in sync.
`lib/` *is* published, which is how the committed sprite data reaches an installed
Ralph. Nothing under `lib/` or `bin/` may import from `scripts/` or `test/`, and
that is asserted rather than trusted.

## Manual smoke test (pre-release recipe)

Before each release we exercise the package against an unrelated project
to catch path/template bugs that unit tests can't surface.

1. **Pack a tarball locally** from the repo root:
   ```bash
   npm pack
   # → lucasfe-ralph-<version>.tgz
   ```
2. **Install the tarball into a sibling project** (a real git repo of
   your choice, ideally a stack different from the host so
   `detect-stack` is exercised):
   ```bash
   cd /path/to/other-project
   npm i -g /absolute/path/to/lucasfe-ralph-<version>.tgz
   ```
3. **Run `ralph init`** at the project root and verify that:
   - `ralph.config.sh`, `PROMPT.md`, `.env.local.example`,
     `ralph-notify.sh.example`, and `.claude/commands/ralph.md`
     are created.
   - Detected `INSTALL_CMD`, `TEST_CMD`, `LINT_CMD`, `MAIN_BRANCH`,
     `DEV_BRANCH`, `PR_TARGET` match the project's stack.
   - `.gitignore` gets `.ralph/`, `ralph-notify.sh`, `.env.local`
     appended (idempotent — re-running init must not duplicate).
4. **Run `ralph doctor`** and confirm that:
   - The dep summary is correct for the OS (`brew install ...` on
     macOS, `apt install ...` on Linux/WSL).
   - The **source-gated deps follow the committed line, not your shell** (#125),
     which is the half only a real config file settles. Write
     `TASK_SOURCE="folder"` into the project's `ralph.config.sh`, export nothing,
     and the `gh` row must be **gone** — before #125 `doctor` read this knob from
     the environment alone, so a repo configured the way `ralph init` writes it
     still took a `gh` row it did not need. Then write `TASK_SOURCE="jira"` and the
     report must swap that row for an `acli` one, critical, with the platform's
     install hint (the Linux/WSL hint is a `curl` binary download rather than a
     package manager — paste it and check it actually works), plus one **`jira
     auth`** row. Two of its three states are expected here and neither is a
     failure: `✓ jira auth` on a logged-in machine, and — after an
     `acli jira auth logout` — `! jira auth (not authenticated)` carrying the
     `acli jira auth login` hint. The thing to confirm deliberately is that
     `doctor`'s **exit code is unchanged** across both, because that row is reported
     and never enforced **by `doctor`** — `ralph cycle` is the command that enforces
     it, from #134: its preflight defaults to the same `lib/jira-auth.js` probe, so
     the logged-out half of this step is also a repo where a scheduled pass aborts
     with `jira not authenticated — run: acli jira auth login`. Log back in before
     smoke-testing anything that starts a `jira` run. `! jira auth (not verified)`
     is the state a real `ralph doctor` should *never* show you: it means the command
     had no process runner to ask with, which for the shipped CLI means
     `bin/ralph.js` stopped handing `doctor` its `exec`. A **missing** `acli` is not
     that state — it reads `not authenticated`, next to the `✗ acli` dep row that
     names the real problem.
   - The **identity box** heads the output (#75) — above the dep report and
     above the abort on a missing required dep — with the tarball version you
     just installed as its title and `os`, `agent`, `cached` and `cwd` rows
     under it. No sprite, no animation and no cursor movement belong anywhere
     in it, at any `RALPH_BANNER` value, and a mistyped `RALPH_AGENT` puts its
     warning line *under* the closing `╰──╯` — **one** line, whatever the value
     was (#108). Worth typing once, because it is the defect that issue closed:
     `RALPH_AGENT=$'codx\nos      linux' ralph doctor` must print a box with its
     real `os` row and no second one, and a warning holding a visible `U+FFFD`
     where the newline was. Every echo of a user's value in `doctor` and `init`
     goes through `oneLineEcho` from `lib/one-line.js` for this; if you add
     another one, use it.
   - The `cached` row comes from the global update-check cache, which is
     written by the weekly check in `ralph start` and in `ralph cycle` — so it
     reads `unknown (no update check cached yet)` on a machine where neither
     has run, and a real version on a machine with scheduled cycles installed:
     `<version> — up to date`, or ``<version> available — run `ralph update` ``
     when the cache is ahead of the tarball. All three are expected here; none
     is a failure. `doctor` must return immediately either way: it makes no
     registry query.
   - `RALPH_BANNER=off ralph doctor` prints **no box and not one blank line**,
     so the output starts at the first dep line, while
     `RALPH_BANNER=loud ralph doctor` prints the default box and **no warning
     on either stream** — the one place this knob behaves differently from
     `ralph start`, and the thing a contributor is most likely to "fix" by
     accident.
5. **Pick a real open issue** in the project and run `ralph start`.
   Watch with `ralph live` — since #169 the box's `Watch live:` row names it first,
   and it needs no name typed — or via the `tmux attach` command the row keeps on
   the line under it (the session is per-project: `ralph-<repo>-<hash>`). Run
   `ralph start` itself **at the repo root** so `live` and `start` agree on the
   session (see the `ralph live` item below). Verify that:
   - The **sprite** is drawn as the very first thing on the terminal, above the
     preflight lines, with the **identity box** beside it on any window of 72
     columns or more and immediately under it on a narrower one (#161) — and since #73 it
     *animates* for about a second before it settles, so watch this one rather than
     glancing at it. This is the one place a real TTY is exercised — the hermetic suite
     injects `stdoutIsTTY` and `columns`, and `sleep` and `signals` besides, and never
     touches a terminal — so the splash is only ever *seen* here. Five things to look
     for that no spec can show you: the frames must redraw **in place**, so when the run
     is over the scrollback holds one sprite and not five, and nothing above the sprite
     has been walked over; the box's `╭─` must land clean, with no stray escape in front
     of the corner — on the sprite's **top** row and two columns clear of its right edge
     on a window of 72 or more, under the settled frame on a narrower one; on the wide
     window the box must ride **every** frame rather than arrive after the last one, so
     no frame flashes without it and no box is drawn twice (#161 — the bug this change
     would most easily introduce is one box in each place, so count them); the **cursor
     must be visible again** for the
     rest of the run (if it has vanished, the restore did not happen — `reset` your shell
     and treat that as a bug, not a quirk); and a `Ctrl-C` *through the middle of
     the animation* must leave the cursor visible and exit **130** (`echo $?`), the same
     as a `Ctrl-C` anywhere else in the run — and, on a wide window, must leave the
     scrollback holding a whole box rather than one with three sides, since the box is
     now inside the frame the abort lands in. Then check both suppressions here as
     well. Piped: `ralph start 2>/dev/null | cat -v` must show no sprite and no
     truecolor escape (`^[[38;2;`, `^[[48;2;`) — and none of the splash's control
     sequences either (`^[[?25l`, `^[[?25h`, `^[[17A`), because a suppressed sprite is
     not animated at half volume — while the box is **still there**, in plain text,
     holding its 60 columns, with the remaining lines and the exit code unchanged. It
     must also come back no slower than it used to: nothing is waited for on a pipe.
     Value-less `NO_COLOR`: `NO_COLOR= ralph start` on the same terminal must drop the
     sprite while the ✅ / ⚠️ lines stay coloured — the divergence from
     picocolors is intentional, so this is the pass condition, not a bug — and the
     box must survive it too, losing only the yellow on its `update` row.
   - **The three `RALPH_BANNER` modes** (#74), which are the other thing only a real
     terminal can show you. `RALPH_BANNER=static ralph start` must land the settled
     frame **once**, with no visible redraw and no flicker, and the box in the same
     place `full` would have put it — beside the frame on a wide window, under it on a
     narrow one — since `static` keeps the arrangement and drops only the animation. It
     is the same picture `full` ends on, arrived at without the second of animation.
     `RALPH_BANNER=off ralph start` must print **nothing** above its first preflight
     line: no sprite, no box, not one blank line, and the rest of the run unchanged.
     `RALPH_BANNER=loud ralph start` must draw the **full** banner anyway and put one
     `⚠️` line on stderr — so `RALPH_BANNER=loud ralph start 2>/dev/null` shows the
     banner and no warning at all, which is the check that stdout stayed clean. Then
     write `RALPH_BANNER="off"` into the project's `ralph.config.sh` and confirm both
     directions: a bare `ralph start` draws nothing, while a `RALPH_BANNER=full`
     prefixed onto the same command animates anyway, because the environment wins
     over the file here — the opposite way round to `TASK_SOURCE`, and the one thing
     about this knob a contributor is most likely to assume backwards.
   - The box's **`update` row depends on machine state**, and since #69 it is not the
     only row that does (see the next item): it is printed only when the global
     update-check cache already holds something newer than the tarball you just
     installed, so on a machine where nothing has ever checked there is nothing to see
     and that is not a failure. Resize the window
     too, and walk the whole ladder from wide to narrow: from 88 columns up the box
     sits **beside** the sprite at its full 60; from 87 down to 72 it stays beside and
     narrows a column at a time to 44; at **71** it drops **under** the sprite and
     *widens* back to 60, which is the one step of this ladder that gets bigger on the
     way down and therefore the one to eyeball rather than trust (#161); under 60
     columns the box must narrow and clip
     its values with `…`, never wrapping a line or running its right border ragged;
     under 44 it must drop the border entirely and print bare `label   value` rows;
     and under 26 the sprite must go as well — whole, not clipped — leaving those
     bare rows behind it. No width may wrap a line, tear a row, or lose the version.
     And `RALPH_NO_UPDATE_CHECK=1 ralph start` must leave every other row of the box —
     its title, `agent`, `context`, `cwd`, `source`, `repo` and its what's-new rows —
     alone.
   - The **`agent`, `context`, `source` and `repo` rows** (#69), which are the rows a
     hermetic suite can only assert against injected text. On the **first**
     `ralph start` in a fresh project there is no `.ralph/metrics/issues.jsonl` yet, so
     the row must read ``agent   claude — model resolves at first run`` and there must
     be **no `context` row at all** — never `claude — null`, never `context unknown`,
     and never a model id guessed from anywhere. Run it again once an issue has
     completed and the row must name the model that actually ran, tagged `(last run)`,
     with a `context` row holding that model's window (`1M tokens` for opus or sonnet).
     The check that it is *evidence* and not a default: `tail -1
     .ralph/metrics/issues.jsonl | jq .model,.context_window` must print exactly what
     the two rows say. On a **Codex** project (`RALPH_AGENT=codex` with a
     `RALPH_CODEX_MODEL` set) the row must instead read
     ``codex — gpt-5-codex (configured)`` on the very first start with no run behind
     it, and must **not** turn into a Claude model id in a repo that has Claude runs in
     its log — that is the confusion the `configured` path exists to prevent, and it is
     only reproducible on a real project that switched agents. `source` must match
     `TASK_SOURCE`, and `repo` must be `origin`'s `owner/name`. Two deliberate
     asymmetries to confirm rather than file: in a **folder-mode** project there is
     **no `repo` row whatever** (not an empty one), and `GH_REPO=someone/else ralph
     start` must print `someone/else` even though `origin` says otherwise, because that
     is what every `gh` call in the loop is about to read. That check has a
     **committed half** since #120, and it is the half only a real sourcing shell
     settles: write `GH_REPO="someone/else"` into the project's `ralph.config.sh`
     and `GH_REPO=other/one ralph start` must still print `someone/else`, because
     the loop sources that file *after* inheriting your environment. Then blank the
     committed line — `GH_REPO=` — and with that same environment value still on
     the command line the row must print **`origin`'s** slug and not `other/one`,
     since a blank assignment masks the environment in the sourcing shell, so the
     loop's `gh` reads an empty variable as unset and resolves its base repository
     from `origin`. Attach and run `gh repo view --json nameWithOwner` inside the
     loop's own window if either answer surprises you: that `gh` is the oracle for
     this row, and the box exists to agree with it. A checkout with no `origin` —
     or one whose `origin` is a local path — must print **no `repo` row** rather
     than `unknown`. Last, the thing only a terminal shows: the box must land **as
     fast as it always did**. That slug is read from `.git/config` on purpose and
     `gh repo view` is deliberately never called; if the box ever pauses before it
     appears, somebody has put a network round trip in front of the first paint.
   - **A mistyped `RALPH_AGENT`, on both mouths** (#118), which is a real terminal's
     business twice over. Write `RALPH_AGENT="codx"` into the project's
     `ralph.config.sh` and run `ralph start`: exactly one `⚠️  RALPH_AGENT='codx'
     unrecognized; falling back to 'claude'.` must land on **stderr above the splash**,
     where the banner's own fallback warning goes, the launch must succeed, and the box's
     `agent` row must read `claude` — the agent that will actually run — with no second
     opinion inside the frame. `ralph start 2>/dev/null` must show the banner and no
     warning at all, which is the check that stdout stayed clean, and `RALPH_BANNER=off`
     must silence the picture and not the diagnostic. Then attach: the **loop** prints
     that same sentence again in its own window, because `resolve_agent_invocation`
     forwards the node bridge's stderr instead of discarding it on a successful resolve.
     The price of that is visible right here and is **not** a bug to file: a node
     deprecation notice or an nvm/shim banner now reaches the window on every start,
     where it used to vanish into the temp file. Fix the value and start again — a valid
     or unset `RALPH_AGENT` must add no line to either stream, in either place.
   - The box's **`new` rows** are read from the `CHANGELOG.md` inside the tarball you
     just installed, and this step is the only place that read happens for real — the
     hermetic suite injects an fs and never touches the file. They must show the three
     bullets at the top of **Ralph's** newest entry (clipped with `…`), even though the
     sibling project you are standing in very likely has a `CHANGELOG.md` of its own:
     anything out of *that* file in the box is a cwd-relative read and a bug. The
     `more` row names `ralph changelog`: run it here too, and from a directory that is
     no Ralph project at all. It must exit 0 and print **Ralph's** releases — the
     newest one with every bullet the box clipped away, and the whole file under
     `--all` — never the release notes of whatever repo you are standing in.
   - Lazy validation runs on first start (`.ralph/state.json` did not
     exist), Claude rewrites the config if needed, and the state file
     is created.
   - The loop selects the issue, opens a PR, polls until merge,
     closes the issue, and emits the end-of-run summary on stdout.
   - `logs/ralph-issue-N.log` exists for the issue.
   - `ralph status` — run once from the project root and once from a
     subdirectory — reports `running`, the same run id both times, a `progress`
     line naming the issue in flight, and a live queue depth. This step is the
     only place the loop's
     run-state writes are exercised for real: `.ralph/run-state.json` is
     written by `templates/ralph.sh`, which the unit suite can only drive
     against stubs. The same holds for `.ralph/metrics/issues.jsonl`, which
     backs the `pace` / `eta` / `spend` lines: once the first issue completes
     they must show real numbers instead of `unknown` (on a Codex project
     `spend` stays `unknown`, which is correct — the Codex stream carries no
     cost).
   - The **task table** under that line (#56), which is the other half of what
     `issues.jsonl` backs and the one place its `gh issue list --state all` title
     lookup meets a real GitHub: before the first issue completes the table is the
     header and one `🔄 live` row, and after it a closed row appears with a
     verdict, a cost and a duration — never `$0.00` where nothing was recorded, and
     on a Codex project a `–` in the `cost` column for the same reason `spend`
     reads `unknown`. The rows must carry **issue titles** rather than bare
     numbers, which is what proves the extra call resolved; numbers alone mean it
     failed, and it fails silently by design, so the unit suite cannot tell you.
     Then break it on purpose: with `gh auth logout` the same view must still print
     the whole table, numbered rather than titled, with nothing on stderr and exit
     `0`. On a **folder-mode** project the rows are numbers for good — that mode
     makes no `gh` call at all.
   - The **identity box** heads that same human view (#76), above the `▸ ralph`
     line, with the tarball version as its title and a single `cwd` row under it —
     no `update`, `os` or `agent` row, and no sprite, no animation and no cursor
     movement at any `RALPH_BANNER` value. That row is the git **toplevel**, so the
     subdirectory run above must print the *same* `cwd` as the root run rather than
     the directory you typed it in. `RALPH_BANNER=off ralph status` must print no
     box and not one blank line, so the output starts at `▸ ralph`, while
     `RALPH_BANNER=loud ralph status` prints the default box and **no warning on
     either stream** — as in `doctor`, and here for the stronger reason that this
     command writes to stderr in no mode at all.
   - `ralph status --json | jq .` prints one document and no `jq` error, and —
     once `eta.finish_at` is non-null —
     `ralph status --json | jq '.eta.finish_at | fromdate'` prints an epoch
     number. The hermetic suite pins the document's shape but never runs `jq`,
     so this is the one place the timestamp format meets the parser it is
     truncated to the second for. It must stay one document with the box turned
     **on** as well (`RALPH_BANNER=full ralph status --json | jq .`): a frame on
     that path is a broken parse for every consumer downstream.
   - The startup box's `Projection:` lines, for the same reason. On the **first**
     `ralph start` in a fresh project there is no `.ralph/metrics/issues.jsonl`
     yet, so the block is correctly **absent** — never `~0 min/task · ~$0/task`.
     Run `ralph start` again once an issue has completed (with something left in
     the queue) and it must show real minutes and dollars per task, a total, and
     a plausible local finish clock. On a Codex project the dollar segments drop
     out and the minutes stay, which is correct.
   - The **digest window**, which is the part of it the hermetic suite can only
     drive against a stubbed `tmux`. Set `RALPH_DIGEST_INTERVAL="2m"` in
     `ralph.config.sh` and run `ralph start` again:
     `tmux list-windows -t ralph-<repo>-<hash>` must show a second window named
     `digest` beside the loop's, the startup box must read `Digest: every 2m —
     runs alongside the loop`, and within a couple of minutes that pane *and*
     `.ralph/digest.log` must both carry a narrative (on a Codex project, one
     produced by Codex — `start` forwards `RALPH_AGENT` into the window). Then
     set the interval to something the grammar refuses (`0.5h`) and start once
     more: the launch must still succeed, with `⚠️  Digest window not opened`
     on stderr and `NOT running` on the box's digest line.
   - **`ralph live`** (#167), which is only exercised for real here: the hermetic
     suite injects the streams, stubs `tmux` and never attaches, so a terminal on
     **both** ends, a `$TMUX` that tmux itself set, and a session that dies under an
     attached client are all things only this step can produce. Run it from the
     project root and from a subdirectory — both must land in the **same** session,
     since it anchors on the git toplevel rather than the directory you typed it in.
     Then the deliberate asymmetry to confirm rather than file, until `ralph start`
     moves onto `lib/repo-session.js` too (#168 moved `ralph stop` onto it — its own
     subdirectory check belongs to step 6, since running `stop` here would take the
     session down mid-bullet): `ralph start` still hashes its own cwd, so a loop
     launched by a `ralph start` typed *in a subdirectory* runs under a name derived
     from that subdirectory, and `ralph live` and `ralph stop` both report **no
     session** for it — while `ralph status`, which reads the record the loop writes
     at the toplevel, still finds that run. Do not "fix" that by starting a second
     loop: nothing in `templates/ralph.sh` takes a lock, and two agent loops in one
     working tree is the failure mode, which is why the no-session line names
     `ralph status` before `ralph start`. Inside the loop's own window `ralph live`
     must **refuse rather than nest**, printing
     `tmux switch-client -t ralph-<repo>-<hash>` with the `Ctrl+B then D` detach
     hint — the one place `$TMUX` is genuinely set. `ralph live | cat` must refuse
     with the terminal message instead of reaching tmux's own `open terminal
     failed`. Finally the two closing notices, which are the pair the exit code
     cannot tell apart: a `Ctrl+B` `D` detach must print
     `the loop is still running` with `ralph status` and
     `ralph stop` under it, while **staying attached until the last issue in the
     queue finishes** — `templates/ralph.sh` kills its own session from an `EXIT`
     trap — must instead print `Session '…' is gone` with `ralph status` alone and
     no `ralph stop`. After step 6 the same command must print the no-session line
     and exit `0` (`echo $?`).
   - WhatsApp delivery works when `.env.local` is configured (else
     skipped silently).
   - The custom hook fires when `ralph-notify.sh` is present and
     executable (else skipped).
6. **Run `ralph stop`, and type it in a subdirectory** — #168 anchors it on the git
   toplevel, so `ralph stop` in `lib/` must kill the repo's session exactly as one
   typed at the root would — then confirm the tmux session is gone:
   ```bash
   tmux ls   # must not list the project's ralph-<repo>-<hash> session
   ```
   `ralph status` must now read `interrupted`, not `running`: `stop` is a
   `tmux kill-session`, so the loop never gets to write a terminal record —
   precisely the case that mode exists for. With a digest interval still
   configured, this is also the teardown check: `stop` kills the *session*, so
   the `digest` window must be gone with it and the next `ralph start` must not
   report the session name as already taken.
7. **Re-run `ralph start`** with no eligible issues and confirm it
   exits with `ℹ️  No issues in the queue. Nothing to do.`
8. **Edit `ralph.config.sh`** by hand (e.g. change `MERGE_STRATEGY`),
   then `ralph start` again. Lazy validation should re-run because
   the sha256 of the file changed.
9. **Bump `RALPH_VERSION` mismatch** by editing
   `.ralph/state.json` to a fake `ralph_version`. Next `ralph start`
   must re-validate.

If any step misbehaves, [file an issue](https://github.com/lucasfe/ralph/issues)
with the reproduction command and `logs/`.

## Releasing

Releases are automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml) via
[release-please](https://github.com/googleapis/release-please) and npm
[Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers).
The maintainer flow is:

1. Land `feat:` / `fix:` PRs on `main`.
2. release-please opens (or updates) a **Release PR** that bumps
   `package.json` and prepends a `CHANGELOG.md` entry.
3. Review and merge the Release PR. The merge tags `vX.Y.Z` and, on the
   resulting `push: main`, the `publish` job publishes `@lucasfe/ralph`
   to npm with provenance (prereleases go to the `rc` dist-tag; stable
   to `latest`).

No long-lived npm token is stored — publishing authenticates via OIDC,
so the npm Trusted Publisher for `@lucasfe/ralph` must point at this repo
(`lucasfe/ralph`) and the `release.yml` workflow.

## The Homebrew formula: a generator, and no tap yet

npm is the only channel that flow reaches, and releases have stopped arriving on it.
Three measurements, all taken at the time of writing. `npm view @lucasfe/ralph
dist-tags` answers `{ rc: '0.6.0-rc.1', latest: '0.23.0' }`, so a plain
`npm install -g @lucasfe/ralph` still lands **0.23.0**. `git tag` here lists six tags
above that — `v0.24.0` through `v0.25.4` — each with a `CHANGELOG.md` entry. And the
newest of them serves a real artifact: `curl -sL
https://github.com/lucasfe/ralph/archive/refs/tags/v0.25.4.tar.gz` returns a gzip
tarball of `ralph-0.25.4/`. Six releases tagged and changelogged, none of them
installable. Why the publish is refused is #196's subject, not this section's.

#196's answer is a **second, independent channel**: Homebrew, built from the source
tarball GitHub serves for the release tag release-please already creates. That is
the whole point of choosing the tag over the registry — the tag exists the moment
the Release PR merges, so a refused `npm publish` cannot stop a release from being
installable.

#197 is the first slice, and deliberately the *inside* half: two modules that turn a
version and a digest into the text of `Formula/ralph.rb`, and nothing that publishes
it anywhere. They split the way the sprite generator's modules do, purity on one
side of the seam and I/O on the other, and for the same reason. Both sit under
`scripts/`, so both are unpublished by construction — `package.json`'s `files` is an
allow-list naming `bin`, `lib`, `templates` and two markdown files, and no entry on
it matches `scripts/`.

- `scripts/lib/render-homebrew-formula.js` — **pure: metadata in, formula text
  out.** `renderFormula({ version, sha256, description, homepage, license })`
  returns the complete source of `Formula/ralph.rb` as a string with one trailing
  newline. It **imports nothing** — no fs, no clock, no `process` — so the same
  arguments always produce the same bytes, and it is the only file of the pair that
  spells any Ruby at all. It also **refuses** input rather than papering over it: a
  version that is not semver (a leading `v` included, so it cannot end up doubled in
  the tag URL), a digest that is not 64 hex characters, a `desc` over 80 characters
  or holding a Unicode Other Symbol, and any value that would break out of a Ruby
  double-quoted literal. The module header argues each of those at length; the one
  worth repeating here is the one that is wrong in both directions, because the
  interpolation check covers `#@`, `#@@` and `#$` as well as `#{`, while a **bare `#`
  stays legal** — this package's own homepage is
  `https://github.com/lucasfe/ralph#readme`, and a guard that refused every `#` would
  refuse it. It normalizes rather than copies, too: `package.json`'s description is
  `Ralph — autonomous GitHub issue resolution loop, packaged as a CLI.`, which breaks
  two of the auditor's rules at once (a desc may not start with the formula's name,
  and may not end with a full stop), and what gets rendered is
  `desc "Autonomous GitHub issue resolution loop, packaged as a CLI"`.
- `scripts/generate-homebrew-formula.js` — the CLI, and **argument plumbing only**:
  `--sha256`, `--version`, `--out`, `--help`, hand-rolled the way
  `scripts/generate-sprite.js` is hand-rolled, because `commander` is a *runtime*
  dependency of the published CLI and a development-only script has no business
  widening what the package ships. It reads `package.json` relative to its own
  location rather than to `cwd`, so the version it defaults to is this repository's
  wherever the script is invoked from. An unknown flag is **rejected**, not ignored.
  `--help` goes to stdout and exits `0`; every other usage problem is stderr and
  exit `1` (a bad digest, a missing digest and an unknown flag were each run — all
  three exit `1`), so a mistyped flag cannot look like a successful render.

Running it takes two commands, because the digest is an **argument** and not
something the script computes: hashing a tarball it fetched itself would make the
output depend on the network at the moment it ran. Measured at `v0.25.4` — and note
the `.local` suffix on the output path, which `.gitignore`'s `*.local` line already
covers, so a rendered formula cannot be committed by accident:

```bash
curl -sL https://github.com/lucasfe/ralph/archive/refs/tags/v0.25.4.tar.gz | shasum -a 256
# 010d0b38ad1dab35f41ebcf3cd9ef62e3ff2acd36b024d0a133a2295ed9a94cc  -

node scripts/generate-homebrew-formula.js \
  --sha256 010d0b38ad1dab35f41ebcf3cd9ef62e3ff2acd36b024d0a133a2295ed9a94cc \
  --out ralph-formula.local
# wrote ralph-formula.local
#   version     0.25.4
#   sha256      010d0b38ad1dab35f41ebcf3cd9ef62e3ff2acd36b024d0a133a2295ed9a94cc
```

Checking what it wrote needs one detour worth writing down, because the obvious
command is gone. **`brew audit [path ...]` is disabled** — on Homebrew
6.0.21-34-ga8820d0, `brew audit --strict ./ralph.rb` answers
``Error: Calling `brew audit [path ...]` is disabled! Use `brew audit [name ...]` instead.``
So audit **by name**, out of a throwaway tap:

```bash
brew tap-new --no-git ralphdocs/audit
cp ralph-formula.local "$(brew --repository ralphdocs/audit)/Formula/ralph.rb"
brew audit --strict ralphdocs/audit/ralph   # exit 0, no output at all
brew style ralphdocs/audit/ralph            # 1 file inspected, no offenses detected
brew untap ralphdocs/audit
brew developer off   # `brew audit` turns developer mode on for you; this puts it back
```

Both pass on the formula rendered above, unedited. Two edits that look harmless and
are not, each run through that recipe rather than reasoned about:

- **Do not reorder the fields.** They are emitted `desc`, `homepage`, `url`,
  `sha256`, `license`, and swapping just `homepage` and `url` fails *both* commands:
  `` * line 9, col 3: `homepage` (line 9) should be put before `url` (line 8) ``
  from `brew audit --strict`, and the same sentence from `brew style` with the cop
  named — `FormulaAudit/ComponentsOrder`, "1 offense detected, 1 offense
  autocorrectable". The order in the renderer's `lines` array is a rule.
- **Do not qualify `std_npm_args`.** The formula calls it bare, and
  `*Language::Node.std_npm_args` — the qualified spelling that looks more correct —
  is rejected outright: `` * line 16, col 46: Possible typo: `Language::Node` does
  not respond to `std_npm_args`. Did you mean `std_npm_install_args`? `` The bare call
  is the correct one because it is a `Formula` instance method —
  `def std_npm_args(prefix: libexec, ignore_scripts: true)`, at
  `/opt/homebrew/Library/Homebrew/formula.rb:2262`.

The specs are `test/homebrew-formula.test.js` (63 tests) and
`test/homebrew-formula.qa.test.js` (65 tests), and they live under `test/` rather
than beside the code they exercise for the reason any spec here does:
`vitest.config.js`'s `include` is
`['test/**/*.test.js', 'src/**/*.test.js', 'lib/**/*.test.js']`, so a spec file
under `scripts/` is collected by nothing and "passes" by never running. Three of
their pins constrain how the pair may be edited. The first two are **static reads
of the source** rather than assertions about one call:

- **The renderer's purity is asserted against its text.** The spec greps the file
  for `import`, `require(`, `process`, `Date.`, `Math.random` and `fetch(`, because
  a single-call comparison cannot see a lazily read file or a cached clock. Give
  that module an import and the suite goes red even though every rendered byte is
  unchanged — which is the intent, not a false positive.
- **The CLI is pinned to hold no Ruby.** The same file greps it for eight spellings
  (`class Ralph`, `< Formula`, `depends_on`, `Language::Node`, `install_symlink`,
  `archive/refs/tags`, `assert_match`, `shell_output`) *and* compares its stdout
  byte for byte against `renderFormula`'s output for `package.json`'s own fields.
  Moving one line of formula text into the CLI "just for now" fails both halves.

The third is younger, and it is a real call rather than a grep:

- **The formula's *name* is pinned to the command `ralph update` runs (#198), and
  the duplication behind it must not be "fixed" with an import.**
  `lib/install-target.js` spells that name a second time —
  `const HOMEBREW_FORMULA = 'ralph'`, which is at once half of the marker that
  recognizes a Cellar install (`Cellar` + the formula name, as adjacent whole
  segments) and the argument in `brew upgrade ralph`. Neither direction of import
  is available to remove the copy: `lib/` cannot import the renderer, because
  `package.json`'s `files` allow-list publishes `lib/` and not `scripts/`, so the
  import resolves in a checkout and throws `ERR_MODULE_NOT_FOUND` in every
  *installed* copy — and the renderer cannot import `lib/`, because the purity pin
  above leaves it no `import` at all. So the test is the whole mitigation: it reads
  the name back out of the two lines that write it (`bin.install_symlink`, and the
  `shell_output` version check), drives the real `classifyInstall` over a Cellar
  path built from *that* name, and asserts `kind: 'global-brew'` with
  `argv: ['brew', 'upgrade', <name>]`. Rename one side alone and it fails here
  instead of on a user's machine, where it would do both halves of the damage at
  once: the marker stops matching, so a brew install classifies `unknown` and
  `ralph update` goes back to printing `npm install -g @lucasfe/ralph@latest` (the
  #198 bug), *and* the argv names a formula `brew` cannot find. A second assertion
  pins `FORMULA_CLASS` to the same name — they must be equal once lowercased —
  because Homebrew derives a formula's class from its file name
  (`Formulary.class_s`).

**What does not exist yet, and must not be written up as though it does.** There is
no tap, no `brew tap`, and no `brew install ralph`. Nothing under `.github/` and
nothing in `package.json`'s `scripts` mentions the formula — grepping either tree
for `homebrew`, `formula` or `brew` finds nothing — so this generator is run by hand
and its output is consumed by nobody; since #198 its *name* has a consumer, which is
what the third pin above is for. The tap and the release-workflow step that fills it
are later slices of #196. #198 is the far end of the same pipe and nothing more:
`ralph update` now runs `brew upgrade ralph` for a Cellar install, where it used to
classify that layout `unknown`, refuse, and print an `npm install -g` that would
leave a second copy alongside the Homebrew one (the layout table is under
[`ralph update`](./README.md#ralph-update)). Until the tap lands, the install path a
user has is still the npm one [the README](./README.md#install) describes, and that
is the only place install instructions belong.

### The version a channel reports (#199)

#198 taught `ralph update` to run `brew upgrade ralph`, but left it deciding
*whether* to run anything by asking npm — `fetchLatestVersion` spawned
`npm view @lucasfe/ralph version` for every layout there is. That is the wrong
question for a Homebrew install and it fails in both directions: with the registry
behind the formula a brew user is told they are current forever, and with the
registry ahead they are told to upgrade to something `brew` cannot fetch. Pointing
every layout at the tag instead would only invert who gets lied to. So the source
follows the channel.

`classifyInstall` now attaches a **sixth field**, `latest` — the argv to spawn plus
the format to parse plus the wording that names the channel in a failure. Every row
but Homebrew carries `NPM_VERSION_QUERY` from `lib/update-check.js`, and carries the
*same frozen object* rather than a copy of it, so `npx`, a linked checkout, a refusal
and `unknown` all have one too. The Homebrew row carries
`brew info --json=v2 ralph`, built from the same `HOMEBREW_FORMULA` constant the
`brew upgrade` argv is built from — so the query and the upgrade cannot come to name
different formulae, and the #198 pin above still has one literal to read the name out
of rather than two. `fetchLatestVersion(exec,
timeoutMs, source = NPM_VERSION_QUERY)` takes it as a **defaulted third parameter**,
which is why the function has exactly one changed caller: `lib/commands/update.js`
passes `target.latest`, and the only other one — the weekly check in
`resolveUpdateDecision` — is untouched, still spawning the argv it always did.

Three properties are pinned, and each of them is a thing a later reader might
otherwise undo:

- **No consumer switches on `kind` to pick a query.** The descriptor is passed
  through; a `kind` allowlist would be a second place the channel is known, and the
  next channel would need edits in two files instead of a row in `GLOBAL_STORES`.
  `lib/commands/update.channel.test.js` drives an invented `global-frobnicator`
  classification and a `global-brew` one holding the *npm* descriptor: the query
  follows the descriptor both times.
- **`ralph update` classifies before it queries** — the reverse of the order it ran
  in before, and forced by the descriptor being an output of classification. The
  order is asserted on a call log
  rather than inferred, in that file and in
  `lib/commands/update.qa.test.js`. A brew run still makes exactly two spawns, but
  they are different ones — `brew info --json=v2 ralph` then `brew upgrade ralph`,
  where it used to be `npm view` then `brew upgrade` — so #198's exact-spawn
  assertions were updated to name the new pair. What did **not** move is
  the gating order *inside* the command: `advice` still wins over `argv`, so the two
  refusals are still decided before any package manager is named.
- **The Homebrew version is read from the tap already on the machine, and how stale
  that is has no bound.** `brew info` refreshes nothing: `info` is not in
  `Library/Homebrew/utils/auto-update.sh`'s `AUTO_UPDATE_COMMANDS`, which measures as
  `install outdated upgrade bundle release` plus `tap` with an argument. Nor is
  `HOMEBREW_AUTO_UPDATE_SECS` a ceiling on staleness — `env_config.rb` documents it
  as "Run `brew update` once every `$HOMEBREW_AUTO_UPDATE_SECS` seconds **before some
  commands**", i.e. the minimum interval between the refreshes *those* commands
  perform (default 86400). So the answer is as old as the last auto-updating brew
  command the user happened to run: a month, for someone who has installed nothing in
  a month. (A *core* formula would be read from the cached JSON API instead, which
  `brew info` does refresh once it is older than `DEFAULT_API_STALE_SECONDS` — 7 days;
  the 450-second `HOMEBREW_API_AUTO_UPDATE_SECS` applies only to the auto-updating
  commands. `ralph` will live in a custom tap, whose formulae are read off disk, so
  the local-tap path is the one that applies.) None of that is a reason to run a
  `brew update` here — that swaps unbounded staleness for an unbounded network fetch
  inside a command holding the user's terminal, and is stale by the time the upgrade
  runs anyway. What makes it acceptable is the **direction**: an old tap can only
  **under**-report (say up to date while a newer formula exists upstream), never send
  `brew` after a version it cannot fetch, and `brew upgrade` refreshes the tap itself,
  so the next run sees it. Do not "fix" it into a hang.

The document being parsed was measured on Homebrew 6.0.21-34-ga8820d0, with
`brew info --json=v2 jq` standing in for a formula that is actually tapped: the
top level is `{"formulae": [...], "casks": []}`, and the one entry in `formulae` has
a three-key `versions` — `{"stable": "1.8.2", "head": "HEAD", "bottle": true}`. Only
`stable` is read: `head` is a git build with no version, and an `installed` entry
would answer "what is here?" rather than "what would an upgrade fetch?". A formula
Homebrew cannot find — which is every machine today, since there is still no tap —
exits **1 with empty stdout**, putting its diagnosis on stderr (measured:
`brew info --json=v2 ralph`, stderr beginning `Error: No available formula with the
name "ralph"`), so it is the exit code and not the parse that catches it, and the user
gets the channel-named failure and exit 1 rather than a silent no-op.

One caller was deliberately left on npm: the weekly check in `resolveUpdateDecision`.
It runs from `ralph start`, which never classifies — `classifyInstall` has exactly one
non-test caller, `lib/commands/update.js` — and classifying there would add
filesystem probing plus, for any layout no marker matches, an `npm root -g` spawn, to
a path whose whole point is to cost nothing before the loop. The consequence is
written down in both places it shows — `lib/update-check.js` and
[the README](./README.md#the-weekly-check) — because on a Homebrew install the notice
tracks the registry and can therefore name a version `ralph update` then declines to
install, reporting the tapped version as current.

What that costs a user is pinned rather than argued. Accepting the question after such
a notice reports `✅ Ralph is already up to date (<version>).` from the tap and
installs nothing, so the gate's verdict comes back `accepted: true` with
`installed: false` — which is the branch that prints the neutral
`⚠️  Update did not complete` line at `lib/commands/start.js:807` and
`lib/commands/cycle.js:320`, both of which read `accepted` and were left alone.
`lib/update-gate.channel.qa.test.js`'s `DOCUMENTED: npm ahead of the tap nags, then
correctly does nothing` drives the real `updateCommand` through `runUpdateGate` and
holds that verdict, so a later reader can see the shape of the tradeoff instead of
rediscovering it. The README's enumerations of what produces that line name this third
cause alongside the failed install and the two refusals.

The specs are `lib/update-check.channel.test.js` (31 tests, including the
default-versus-explicit equivalence of the npm query and a 17-row table of
unreadable `brew info` output, every row answering `null` and none of them throwing),
`lib/install-target.channel.test.js` (26 tests — every layout carries a descriptor,
the non-brew ones by identity), and `lib/commands/update.channel.test.js` (19 tests:
call order, the stale-tap and newer-tap paths, and the two strings that must name the
detected channel). That last file stubs **no filesystem at all**, on purpose:
`updateCommand` injects only `exec` and `ralphHome`, a pin `update.qa.test.js`
already holds, so an `fs` passed in would be inert and the test would be measuring
its own fiction.

The QA specs beside them are `lib/update-check.channel.qa.test.js` (63 tests),
`lib/commands/update.channel.qa.test.js` (51 tests) and
`lib/update-gate.channel.qa.test.js` (15 tests) — the last being the only one of the
six that drives the gate, a module #199 does not modify and whose staying on npm is
the thing being asserted. Two of its tests are prefixed `DOCUMENTED:` because they
hold a tradeoff rather than a fix: npm ahead of the tap nags and then correctly
installs nothing, and a tap ahead of npm is never noticed by `ralph start` at all —
which is the residual gap #196's tap makes real, since a release the registry refused
is exactly a release only the tap has. A third is prefixed `MEASURED:` and records a
follow-up: the #24 notice still says `run npm i -g @lucasfe/ralph to update` to every
install, so a Homebrew user is hinted at npm here and `brew upgrade ralph` there. The
test greps the three modules that could name that command — `update-gate.js`,
`banner-rows.js`, `commands/update.js`, comments stripped first, since
`banner-rows.js` discusses `npm i -g` in prose while its row says `ralph update` —
and finds the gate alone.
