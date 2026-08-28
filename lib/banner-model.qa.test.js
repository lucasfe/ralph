// #69 QA — adversarial specs for the two facts the identity box has to WORK OUT rather than
// be handed: which model the agent will use, and which repository the loop will read.
//
// banner-model.test.js proves the intended matrix — the newest event wins, a Codex model comes
// from the knob, origin's url in every spelling git writes it. This file attacks the same two
// functions from outside that matrix, along the four seams that make them different in kind
// from every other fact in the box:
//
//   * THE INPUTS ARE FILES NOBODY READS AS BYTES. `.ralph/metrics/issues.jsonl` is appended to
//     with `>>` by a loop that can be killed mid-line, and `.git/config` is edited by hand, by
//     `git remote`, and by whatever tool set up the checkout. Both arrive here as TEXT, so
//     every shape either file can be in is a string literal — a truncated tail, CRLF endings,
//     a six-megabyte accumulation, a `.git` that is a FILE rather than a directory.
//   * THE ANSWER IS A CLAIM ABOUT CONFIDENCE. The one requirement that matters here is that
//     the box never states a model with more confidence than its source warrants, so the
//     interesting assertions are all NEGATIVE: a stale model, a foreign agent's model, or a
//     model reported alongside the tag that says there is none are each a real defect, and a
//     dropped row is never one.
//   * THE SLUG IS A GRAMMAR. `resolveBannerRepo` parses two url grammars and gh's own
//     `[HOST/]OWNER/REPO`, and the failure that costs something is a WRONG slug — a repo on
//     screen that the loop is not about to read. So the table below is mostly refusals, and
//     it closes with a property asserted over every input in the file at once: whatever comes
//     back is either null or exactly `owner/name`.
//   * NEITHER FUNCTION MAY THROW. Both feed a decoration printed before the first preflight
//     line of a command whose job is to get an unattended loop running.
//
// Control bytes are built with `String.fromCharCode` rather than embedded, for the reason
// test/source-control-bytes.test.js states: a raw one makes `file` call this source `data` and
// makes grep skip it silently. Nothing here reads a clock, an environment or a real file (#41).

import { describe, expect, it } from 'vitest'
import { MODEL_PROVENANCE, resolveBannerModel, resolveBannerRepo } from './banner-model.js'

const ESC = String.fromCharCode(27)
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const NUL = String.fromCharCode(0)
const C1_CSI = String.fromCharCode(0x9b)
const BOM = String.fromCharCode(0xfeff)

/** One metrics line, spelled the way lib/issue-metrics.js's writer spells it. */
const event = (fields) => `RALPH_ISSUE_EVENT ${JSON.stringify(fields)}`
const forClaude = (metricsText) => resolveBannerModel({ metricsText, agent: 'claude' })
const forCodex = (configuredModel, metricsText = '') =>
  resolveBannerModel({ metricsText, agent: 'codex', configuredModel })

const CLAUDE_RUN = { agent: 'claude', model: 'claude-opus-5', context_window: 1_000_000 }
const OLDER_RUN = { agent: 'claude', model: 'claude-sonnet-4', context_window: 200_000 }
/** The answer for "no evidence at all", which is what most of this file expects. */
const NOTHING = { agent: 'claude', model: null, contextWindow: null, provenance: 'unknown' }

describe('QA #69 banner-model — the metrics log in every state a killed loop leaves it', () => {
  it('reads a log that was never newline-terminated', () => {
    // `>>` appends, and the loop can be killed between the JSON and the newline it writes
    // after it — so the last line of a real file is as often unterminated as terminated. The
    // spec next door always terminates its fixtures, which is the half of the file this
    // covers.
    expect(forClaude(event(CLAUDE_RUN))).toEqual({
      agent: 'claude',
      model: 'claude-opus-5',
      contextWindow: 1_000_000,
      provenance: MODEL_PROVENANCE.LAST_RUN,
    })
  })

  it('reads a log written with CRLF endings', () => {
    // A checkout on a Windows filesystem, a log copied through a tool that rewrote its
    // endings, or a `tee` on a mount that did. The CR lands INSIDE the sliced JSON, where it
    // is whitespace to a JSON parser — this pins that it stays whitespace and never becomes
    // part of a model id, which would put a bare CR in a terminal row.
    const lines = `${event(OLDER_RUN)}${CR}${LF}${event(CLAUDE_RUN)}${CR}${LF}`
    expect(forClaude(lines).model).toBe('claude-opus-5')
    expect(forClaude(lines).contextWindow).toBe(1_000_000)
  })

  it('answers nothing when the log’s ONLY line is truncated mid-JSON', () => {
    // The first run of a repo whose very first append was interrupted. There is no older
    // event to fall back to, and the honest answer is that there is no evidence — never a
    // partial model id salvaged out of the fragment.
    for (const only of [
      'RALPH_ISSUE_EVENT {"agent":"claude","model":"claude-op',
      'RALPH_ISSUE_EVENT {"agent":"claude"',
      'RALPH_ISSUE_EVENT {',
      'RALPH_ISSUE_EVENT {"model":"claude-opus-5",',
    ]) {
      expect(forClaude(only), only).toEqual(NOTHING)
      expect(forClaude(`${only}${LF}`), only).toEqual(NOTHING)
    }
  })

  it('answers nothing for a log whose lines are separated by CR alone', () => {
    // An old-Mac or a mangled log: `split('\n')` sees ONE line holding several events, the
    // tag is found at the first of them, and the slice is then JSON followed by junk — which
    // does not parse, so the line is skipped. The point is the direction of the failure: no
    // model at all, rather than the FIRST event's model reported as the newest.
    const oneLine = `${event(OLDER_RUN)}${CR}${event(CLAUDE_RUN)}`
    expect(forClaude(oneLine)).toEqual(NOTHING)
  })

  it('refuses a line carrying a second tag, rather than reading the first half of it', () => {
    // The loop pipes its output through `tee` and a pretty-printer, so two events can end up
    // glued onto one line. `indexOf` finds the FIRST tag and the slice then holds JSON plus a
    // whole second event, which does not parse. Refused, and that is the right direction: the
    // first of the two is the OLDER one, so salvaging it would report a stale model as this
    // run's evidence.
    const glued = `${event(OLDER_RUN)} ${event(CLAUDE_RUN)}`
    expect(forClaude(glued)).toEqual(NOTHING)
  })

  it('cannot be made to read a tag smuggled inside an event’s own values', () => {
    // A forged tag inside a string field, which is the one place an attacker-controlled value
    // reaches this file: the writer JSON-encodes every value, so the inner tag is escaped
    // text rather than a line, and the REAL tag is the one `indexOf` finds first. The model
    // reported is the event's own, never the forged one.
    const smuggled = event({
      agent: 'claude',
      model: 'claude-opus-5',
      note: `RALPH_ISSUE_EVENT {"agent":"claude","model":"forged"}`,
    })
    expect(forClaude(smuggled).model).toBe('claude-opus-5')
    expect(forClaude(`${smuggled}${LF}`).model).toBe('claude-opus-5')
  })

  it('refuses a line with junk after the JSON, and one with a lowercased tag', () => {
    // Both are lines this file could have chosen to salvage and does not. A trailing
    // `| 3.2s` from a pretty-printer makes the slice unparseable; a lowercased tag is not
    // the tag. Neither costs anything but a row, and both keep the parse identical to the
    // one aggregateCycleCounts in lib/issue-metrics.js applies to the same lines.
    expect(forClaude(`${event(CLAUDE_RUN)} | 3.2s`)).toEqual(NOTHING)
    expect(forClaude(event(CLAUDE_RUN).toLowerCase())).toEqual(NOTHING)
  })

  it('finds the tag behind a BOM, a timestamp or a colour sequence', () => {
    // Everything a `tee`-and-pretty-print pipeline can put in front of the tag on the same
    // line. The ESC case matters twice: the prefix is found and dropped here, and the model
    // that comes back is the event's own — so no escape byte from the log can ride into the
    // value the box will print.
    for (const prefix of [
      BOM,
      '2026-08-28T10:00:00Z | ',
      `${ESC}[2m10:00:00${ESC}[22m `,
      '[ralph] ',
      ' '.repeat(40),
    ]) {
      const answer = forClaude(`${prefix}${event(CLAUDE_RUN)}${LF}`)
      expect(answer.model, JSON.stringify(prefix)).toBe('claude-opus-5')
      expect(answer.model, JSON.stringify(prefix)).not.toContain(ESC)
    }
  })

  it('tolerates extra whitespace between the tag and the JSON', () => {
    // Pinned as a decision rather than as an accident: the slice starts after the tag's own
    // trailing space, and JSON.parse skips whatever whitespace follows. A pretty-printer that
    // aligns its columns therefore costs no row.
    expect(forClaude(`RALPH_ISSUE_EVENT   ${JSON.stringify(CLAUDE_RUN)}`).model).toBe(
      'claude-opus-5',
    )
  })

  it('takes the LAST value when a corrupt line repeats a key, as JSON.parse does', () => {
    // A hand-edited or double-written line. Pinned because the alternative reading — the
    // first value — would be a different model on the row, and because it is the one place
    // this module's answer is decided by JSON.parse rather than by its own code.
    const doubled = 'RALPH_ISSUE_EVENT {"agent":"claude","model":"first","model":"second"}'
    expect(forClaude(doubled).model).toBe('second')
  })

  it('never lets a `__proto__` key in the log become the model', () => {
    // The log is a file a foreign writer can put anything in, and `JSON.parse` puts a
    // `__proto__` key on the object as an own property rather than on its prototype — so the
    // read below is of the event's own `model`, which this line does not have.
    const polluted = 'RALPH_ISSUE_EVENT {"agent":"claude","__proto__":{"model":"pwned"}}'
    expect(forClaude(polluted)).toEqual(NOTHING)
    expect(forClaude(polluted).model).not.toBe('pwned')
    // ...and the pollution did not escape into the next parse either.
    expect(forClaude('RALPH_ISSUE_EVENT {"agent":"claude"}')).toEqual(NOTHING)
  })

  it('scans from the END and stays cheap on a six-megabyte log', () => {
    // The file is append-only and accumulates for as long as the repo runs Ralph, and this
    // read happens BEFORE the first preflight line — so the cost of it is part of the
    // feature. Two shapes: the normal one, where the newest event is the last line, and the
    // worst one, where the scan has to walk every line back to the top before it finds
    // anything. The bound is deliberately loose (a smoke test, not a benchmark): what it
    // catches is a scan that became quadratic, not one that got 20% slower.
    const junk = `the loop printed something else${LF}`.repeat(100_000)
    const newestLast = `${junk}${event(CLAUDE_RUN)}${LF}`
    const newestFirst = `${event(CLAUDE_RUN)}${LF}${junk}`
    for (const [label, text] of [
      ['newest at the bottom', newestLast],
      ['newest at the top', newestFirst],
    ]) {
      expect(text.length, label).toBeGreaterThan(3_000_000)
      const started = performance.now()
      expect(forClaude(text).model, label).toBe('claude-opus-5')
      expect(performance.now() - started, label).toBeLessThan(2_000)
    }
  })

  it('reads a log of a hundred thousand real events and answers with the last one', () => {
    // The other large shape: not junk, but history. A repo that has run Ralph for months has
    // exactly this file, and the answer must be the newest event and nothing else.
    const history = `${event(OLDER_RUN)}${LF}`.repeat(100_000)
    expect(forClaude(`${history}${event(CLAUDE_RUN)}${LF}`)).toEqual({
      agent: 'claude',
      model: 'claude-opus-5',
      contextWindow: 1_000_000,
      provenance: MODEL_PROVENANCE.LAST_RUN,
    })
  })
})

describe('QA #69 banner-model — never more confidence than the evidence warrants', () => {
  it('never reports a window without a model to attach it to', () => {
    // THE INVARIANT lib/banner-compose.js's `context` row leans on. That row is drawn from
    // `contextWindow` alone, so a resolver that answered "no model, 1M tokens" would put a
    // window on screen beside a row saying the model resolves at first run. Asserted over
    // every shape this module can be handed rather than over one, because it is a property
    // of the function and not of a case.
    const bags = [
      {},
      { agent: 'claude' },
      { agent: 'codex' },
      { agent: 'claude', metricsText: event({ agent: 'claude', context_window: 1_000_000 }) },
      { agent: 'claude', metricsText: event({ agent: 'claude', model: '', context_window: 1e6 }) },
      { agent: 'claude', metricsText: event({ agent: 'codex', model: 'x', context_window: 1e6 }) },
      { agent: 'gemini', metricsText: event(CLAUDE_RUN) },
      { agent: 'codex', configuredModel: '   ', metricsText: event(CLAUDE_RUN) },
      { agent: 'codex', configuredModel: 42, metricsText: event(CLAUDE_RUN) },
      { agent: 42, metricsText: event(CLAUDE_RUN) },
      { agent: 'claude', metricsText: 'RALPH_ISSUE_EVENT {"context_window":1000000}' },
    ]
    for (const bag of bags) {
      const answer = resolveBannerModel(bag)
      if (answer.model === null) {
        expect(answer.contextWindow, JSON.stringify(bag)).toBe(null)
        expect(answer.provenance, JSON.stringify(bag)).toBe(MODEL_PROVENANCE.UNKNOWN)
      }
    }
  })

  it('never tags a missing model as evidence, and never names one on the unknown tag', () => {
    // The two halves of the correctness requirement, as a claim about the RETURN VALUE: a
    // `last-run` or `configured` tag always comes with a model, and an `unknown` tag never
    // does. Every input in this file goes through it below; these are the shapes most likely
    // to break it.
    const bags = [
      { agent: 'claude', metricsText: `${event(CLAUDE_RUN)}${LF}${event({ agent: 'codex' })}` },
      { agent: 'claude', metricsText: `${event(CLAUDE_RUN)}${LF}RALPH_ISSUE_EVENT {"trunc` },
      { agent: 'codex', configuredModel: '', metricsText: event(CLAUDE_RUN) },
      { agent: 'codex', configuredModel: LF, metricsText: event(CLAUDE_RUN) },
      { agent: 'claude', metricsText: event({ agent: 'claude', model: '   ' }) },
    ]
    for (const bag of bags) {
      const { model, provenance } = resolveBannerModel(bag)
      const tagged = provenance !== MODEL_PROVENANCE.UNKNOWN
      expect(tagged, JSON.stringify(bag)).toBe(model !== null)
    }
  })

  it('never reaches past a foreign agent’s run for a model, however deep the history', () => {
    // A repo that switched RALPH_AGENT has the other agent's run at the bottom of its log and
    // dozens of claude runs above it. Reporting one of those as "last run" would be a lie
    // about WHICH run it was, so the answer is no evidence — asserted with the newest event
    // belonging to each of the agents that are not the one about to launch.
    // ...for each of the agent spellings that are NOT ours. `claude ` is absent on purpose:
    // the field is trimmed, so that one IS ours (pinned two tests down), and so is a blank
    // field, which reads as the legacy Claude run.
    const history = `${event(OLDER_RUN)}${LF}`.repeat(20)
    for (const foreign of ['codex', 'gemini', 'CLAUDE', 'claude-code', 'claude-4', 'cl aude']) {
      const lines = `${history}${event({ agent: foreign, model: 'not-ours' })}${LF}`
      expect(forClaude(lines), foreign).toEqual(NOTHING)
    }
  })

  it('reads a corrupt `agent` field as the legacy claude run it cannot tell it apart from', () => {
    // Pinned as a decision. `agent` arrived with #554 and a MISSING one means a Claude run,
    // which is what lets an old checkout's box say something; the same fallback catches a
    // field that is not a string at all. That is the lenient direction, and it is the safe
    // one here for one reason: the model on such a line came out of Claude's own stream, so
    // naming it is not a claim about an agent nobody can identify.
    for (const agent of [undefined, null, 42, {}, [], '', '   ', false]) {
      const lines = event({ agent, model: 'claude-opus-5', context_window: 1_000_000 })
      expect(forClaude(lines).model, JSON.stringify(agent)).toBe('claude-opus-5')
      expect(forClaude(lines).provenance, JSON.stringify(agent)).toBe(MODEL_PROVENANCE.LAST_RUN)
    }
    // ...and the padded spelling of the agent that IS ours still matches, since the field is
    // trimmed — a log line hand-copied with a stray space costs no row.
    expect(forClaude(event({ agent: ' claude ', model: 'claude-opus-5' })).model).toBe(
      'claude-opus-5',
    )
  })

  it('hands a model’s control bytes on untouched — sanitising is the box’s job, not this one', () => {
    // DELIBERATE, and worth a test of its own because the alternative looks safer and is
    // worse. This module answers a question; lib/banner-compose.js's `textOr` gate is what
    // stands between a value and a terminal (asserted in banner-compose.model-rows.qa.test.js
    // for exactly these bytes). A module that scrubbed here as well would put two owners on
    // one rule, and the day they disagreed the box would trust the wrong one.
    for (const byte of [ESC, LF, CR, NUL, C1_CSI]) {
      const model = `claude${byte}opus`
      expect(forClaude(event({ agent: 'claude', model })).model).toBe(model)
    }
    // The same for the Codex knob, which is a value out of a shell config file.
    expect(forCodex(`gpt-5-codex${ESC}[31m`).model).toBe(`gpt-5-codex${ESC}[31m`)
  })

  it('lets the configured Codex model win over a stale Codex run in the log', () => {
    // The Codex path does not consult the log at all, and this is the case that proves it is
    // the right call rather than an optimisation: the log's newest event is a CODEX run with
    // a different model, so a resolver that read it would report the model of the run before
    // the one the user just reconfigured — tagged `configured`, which would make it a claim
    // about this run.
    const stale = event({ agent: 'codex', model: 'gpt-4o', context_window: 128_000 })
    expect(forCodex('gpt-5-codex', `${stale}${LF}`)).toEqual({
      agent: 'codex',
      model: 'gpt-5-codex',
      contextWindow: 400_000,
      provenance: MODEL_PROVENANCE.CONFIGURED,
    })
  })

  it('is a function of its arguments alone, and mutates neither of them', () => {
    // The bag comes from `ralph start`, which built it out of a config file and an
    // environment; the text is a whole file another consumer of the same read holds a
    // reference to (#60's launch projection reads it after the banner is drawn).
    const bag = { metricsText: `${event(OLDER_RUN)}${LF}${event(CLAUDE_RUN)}${LF}`, agent: 'claude' }
    const snapshot = JSON.stringify(bag)
    const first = resolveBannerModel(bag)
    const second = resolveBannerModel(bag)
    expect(JSON.stringify(bag)).toBe(snapshot)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })
})

describe('QA #69 banner-model — the repo, degraded rather than guessed', () => {
  const origin = (...urls) =>
    ['[remote "origin"]', ...urls.map((url) => `\turl = ${url}`), ''].join(LF)

  // Every shape a `.git/config` can be in that is NOT the plain repository git writes, and the
  // answer each one must earn: a slug when it is unambiguously one, null otherwise. Collected
  // in one table because the interesting property is the SET of answers, which the last test
  // in this file reads back out of it.
  const CONFIGS = [
    // A worktree or a submodule: `<cwd>/.git` is a FILE holding a gitdir pointer, so what the
    // caller reads is either this text or nothing at all. Either way there is no url in it.
    ['a .git file’s gitdir pointer', 'gitdir: /repo/.git/worktrees/feature\n', null],
    ['a gitdir pointer with a remote-looking path', 'gitdir: git@github.com:o/n.git\n', null],
    // Subsection names are CASE-SENSITIVE to git, so `Origin` is a different remote and the
    // one this box names is not in the file.
    ['[remote "Origin"] — a different remote', '[remote "Origin"]\n\turl = git@github.com:o/n.git\n', null],
    ['[remote "ORIGIN"]', '[remote "ORIGIN"]\n\turl = git@github.com:o/n.git\n', null],
    ['[remote] with no subsection', '[remote]\n\turl = git@github.com:o/n.git\n', null],
    ['[remote ""] — an empty subsection', '[remote ""]\n\turl = git@github.com:o/n.git\n', null],
    // The real remote lives in an included file this module never reads. No row beats a row
    // naming whatever else the file happens to hold.
    ['an [include] holding the real remote', '[include]\n\tpath = ../real-config\n', null],
    [
      'an [includeIf] before a real origin',
      '[includeIf "gitdir:~/work/"]\n\tpath = work\n[remote "origin"]\n\turl = git@github.com:o/n.git\n',
      'o/n',
    ],
    // `[core]` in every real file carries keys a whole-file search for `url =` would match.
    ['a url under [core]', '[core]\n\turl = evil/repo\n\tbare = false\n', null],
    ['a url under [core] above a real origin', `[core]\n\turl = evil/repo\n${origin('git@github.com:o/n.git')}`, 'o/n'],
    // Shapes git itself accepts and this parser deliberately does not: it recognizes the file
    // git WRITES, and answers nothing for anything else.
    ['a section header with a trailing comment', '[remote "origin"] # main\n\turl = git@github.com:o/n.git\n', null],
    // ...and the REVERSED direction of that same unparsed header, which is the one that could
    // put a wrong repo on screen rather than none: the header above closes nothing, so before
    // this parser learned to treat any bracket line it cannot read as a section boundary, the
    // upstream url below was attributed to origin — the box naming `them/repo` while every gh
    // command in the loop read `me/fork`. Added to this table rather than pinned as a gap
    // because a wrong slug is the one answer this function may never give (review of #69).
    [
      'an unparsed header on the remote AFTER origin',
      '[remote "origin"]\n\turl = git@github.com:me/fork.git\n[remote "upstream"] # the real one\n\turl = git@github.com:them/repo.git\n',
      'me/fork',
    ],
    [
      'git’s one-line section-and-key spelling after origin',
      '[remote "origin"]\n\turl = git@github.com:me/fork.git\n[remote "upstream"] fetch = +refs/heads/*\n\turl = git@github.com:them/repo.git\n',
      'me/fork',
    ],
    [
      'an [url] rewrite block with a commented header after origin',
      '[remote "origin"]\n\turl = git@github.com:me/fork.git\n[url "https://github.com/"] # rewrite\n\turl = git@github.com:them/repo.git\n',
      'me/fork',
    ],
    ['an inline comment after the url', '[remote "origin"]\n\turl = git@github.com:o/n.git # main\n', null],
    ['a quoted url value', '[remote "origin"]\n\turl = "git@github.com:o/n.git"\n', null],
    ['a url split over a line continuation', '[remote "origin"]\n\turl = git@github.com:o/\\\n\tn.git\n', null],
    ['only a pushurl', '[remote "origin"]\n\tpushurl = git@github.com:o/n.git\n', null],
    // Remotes that are real remotes and are not repositories gh could read an issue from.
    ['a file:// url', origin('file:///srv/git/thing.git'), null],
    ['an ftp url', origin('ftp://github.com/o/n.git'), null],
    ['an rsync url', origin('rsync://github.com/o/n.git'), null],
    ['an absolute path', origin('/srv/git/thing.git'), null],
    ['a relative path', origin('../other'), null],
    ['a relative path with a colon in it', origin('./x:y/z'), null],
    ['a windows drive path', origin('C:/repos/thing'), null],
    // Paths that are not `owner/name`.
    ['an scp url with an empty path', origin('git@github.com:'), null],
    ['an scp url whose path is a step up', origin('git@github.com:../evil'), null],
    ['an scp url whose path is a dot', origin('git@github.com:./n'), null],
    ['a host and nothing else', origin('https://github.com/'), null],
    ['a doubled slash before the slug', origin('https://github.com//o/n'), null],
    ['three path segments', origin('ssh://git@github.com:22/a/b/c.git'), null],
    ['a name that is only a .git suffix', origin('git@github.com:o/.git'), null],
    ['a slug with a space in it', origin('git@github.com:o/a name'), null],
    ['a non-ASCII slug', origin('git@github.com:ünïcode/rälph.git'), null],
    // A control byte anywhere in the url. The slug grammar admits word characters, dots and
    // hyphens only, so this can never come back as a value — which is what keeps an escape
    // sequence out of the row before the box's own gate ever sees it.
    ['an ESC inside the url', origin(`git@github.com:o/n${ESC}[31m.git`), null],
    ['an LF inside the url', origin(`git@github.com:o/n${NUL}ame.git`), null],
    // ...and the shapes that DO resolve, so the table is not one-sided and a parser that
    // simply answered null would fail here.
    ['CRLF line endings', `[remote "origin"]${CR}${LF}\turl = git@github.com:o/n.git${CR}${LF}`, 'o/n'],
    ['an uppercase scheme', origin('HTTPS://github.com/o/n.git'), 'o/n'],
    ['a padded, mixed-case key', '[remote "origin"]\n\t  UrL   =   git@github.com:o/n.git  \n', 'o/n'],
    ['the origin section opened twice', `${origin('git@github.com:old/name.git')}[core]\n${origin('git@github.com:o/n.git')}`, 'o/n'],
    ['a GitHub Enterprise host', origin('git@ghe.internal.example:o/n.git'), 'o/n'],
    ['a semicolon-commented decoy above origin', `; url = decoy/repo\n${origin('git@github.com:o/n.git')}`, 'o/n'],
    ['a hash-commented decoy above origin', `# url = decoy/repo\n${origin('git@github.com:o/n.git')}`, 'o/n'],
    ['an underscore in both segments', origin('git@github.com:my_org/my_repo.git'), 'my_org/my_repo'],
    ['a dot inside the name', origin('git@github.com:o/n.js.git'), 'o/n.js'],
  ]

  for (const [label, gitConfigText, expected] of CONFIGS) {
    it(`answers ${JSON.stringify(expected)} for ${label}`, () => {
      expect(resolveBannerRepo({ gitConfigText })).toBe(expected)
    })
  }

  // GH_REPO, which is the value gh itself reads first and is therefore the value the box has
  // to honour — including when it is nonsense, because naming origin instead would name a
  // repository the loop is NOT about to read.
  const GH_REPOS = [
    ['gh’s host-prefixed spelling', 'github.com/o/n', 'o/n'],
    ['a GitHub Enterprise host prefix', 'ghe.internal.example/o/n', 'o/n'],
    ['three segments, none of them a host', 'a/b/c', 'b/c'],
    ['four segments', 'a/b/c/d', null],
    ['a whole url', 'https://github.com/o/n', null],
    ['an ssh url', 'git@github.com:o/n.git', null],
    ['one segment', 'ralph', null],
    ['a .git suffix', 'o/n.git', 'o/n'],
    ['an uppercase .GIT suffix', 'o/n.GIT', 'o/n'],
    ['a doubled .git suffix', 'o/n.git.git', 'o/n.git'],
    ['a trailing slash', 'o/n/', null],
    ['two trailing slashes', 'o/n//', 'o/n'],
    ['a leading slash', '/o/n', 'o/n'],
    ['a doubled inner slash', 'o//n', null],
    ['case preserved', 'O/N', 'O/N'],
    ['surrounding whitespace', '  o/n  ', 'o/n'],
    ['a set-but-blank value', '', null],
    ['a whitespace-only value', '   ', null],
    ['a step up', '../n', null],
    ['a step up as the name', 'o/..', null],
    ['a dot as the name', 'o/.', null],
    ['a query string', 'o/n?ref=main', null],
    ['a fragment', 'o/n#readme', null],
    ['a percent escape', 'o/n%2e', null],
    ['a space in the name', 'o/n ame', null],
  ]

  for (const [label, ghRepo, expected] of GH_REPOS) {
    it(`answers ${JSON.stringify(expected)} for a GH_REPO with ${label}`, () => {
      expect(resolveBannerRepo({ ghRepo })).toBe(expected)
      // ...and it still wins over a perfectly good origin, including when it answers null:
      // a set GH_REPO is what gh reads, so origin is not the loop's repository at all.
      expect(
        resolveBannerRepo({ ghRepo, gitConfigText: origin('git@github.com:someone/else.git') }),
      ).toBe(ghRepo.trim() ? expected : 'someone/else')
    })
  }

  it('refuses a GH_REPO carrying a control byte, rather than passing one into a row', () => {
    // GH_REPO is an ambient environment variable, which is the least trustworthy input in
    // this file. The slug grammar admits no control byte in either segment, so the answer is
    // no row — and the box's own gate never has to be the only thing standing there.
    // INSIDE either segment, every one of them — including the two that a `trim` would have
    // removed had they been at an edge.
    for (const byte of [LF, CR, ESC, NUL, C1_CSI, String.fromCharCode(0x85)]) {
      const at = byte.charCodeAt(0).toString()
      expect(resolveBannerRepo({ ghRepo: `o${byte}/n` }), at).toBe(null)
      expect(resolveBannerRepo({ ghRepo: `o/n${byte}ame` }), at).toBe(null)
      expect(resolveBannerRepo({ ghRepo: `o/${byte}n` }), at).toBe(null)
    }
    // ...and at either EDGE, for the bytes `trim` does not consider whitespace — an escape
    // sequence appended to an otherwise valid slug is the shape that would have cost the most.
    for (const byte of [ESC, NUL, C1_CSI, String.fromCharCode(0x85)]) {
      const at = byte.charCodeAt(0).toString()
      expect(resolveBannerRepo({ ghRepo: `o/n${byte}` }), at).toBe(null)
      expect(resolveBannerRepo({ ghRepo: `${byte}o/n` }), at).toBe(null)
    }
    // A TRAILING newline, though, is whitespace and trims away — so a value exported by a
    // script that forgot to chomp its `read` still resolves. Pinned as the deliberate reading
    // it is: a lost row for a stray newline would be a worse trade than a dropped one.
    expect(resolveBannerRepo({ ghRepo: `o/n${LF}` })).toBe('o/n')
    expect(resolveBannerRepo({ ghRepo: `${CR}${LF}o/n${CR}${LF}` })).toBe('o/n')
  })

  it('answers null or exactly `owner/name` — never anything else, for every input above', () => {
    // THE PROPERTY, over every case in this file at once: whatever this function answers is
    // either no row or a slug of exactly two ordinary segments. That is what makes "the row
    // degrades to nothing rather than to something wrong" a claim about the function instead
    // of a claim about the forty inputs above.
    const SLUG = /^[\w.-]+\/[\w.-]+$/
    const inputs = [
      ...CONFIGS.map(([, gitConfigText]) => ({ gitConfigText })),
      ...GH_REPOS.map(([, ghRepo]) => ({ ghRepo })),
      ...GH_REPOS.map(([, ghRepo]) => ({ ghRepo, gitConfigText: origin('git@github.com:o/n.git') })),
      { gitConfigText: origin(`o/n${ESC}`) },
      { ghRepo: {}, gitConfigText: 42 },
      undefined,
      null,
      42,
      'a string bag',
    ]
    for (const bag of inputs) {
      const answer = resolveBannerRepo(bag)
      if (answer === null) continue
      expect(answer, JSON.stringify(bag)).toMatch(SLUG)
      expect(answer.split('/').every((segment) => !/^\.+$/.test(segment)), answer).toBe(true)
      expect(answer, JSON.stringify(bag)).toBe(answer.trim())
    }
  })

  it('never throws on a config file that is not a config file at all', () => {
    // The caller reads `<cwd>/.git/config` best-effort and hands over whatever came back, so
    // this function's input can be a binary, a lock file, an HTML error page or a truncated
    // read. All of them are one row's worth of nothing.
    const junk = [
      NUL.repeat(1000),
      `${ESC}[31mnot a config${ESC}[0m`,
      '['.repeat(5000),
      `[remote "origin"${LF}\turl = git@github.com:o/n.git${LF}`,
      '<!DOCTYPE html><html><body>404</body></html>',
      `[remote "origin"]${LF}${'\turl = '.repeat(1000)}`,
      'x'.repeat(2_000_000),
    ]
    for (const gitConfigText of junk) {
      expect(resolveBannerRepo({ gitConfigText }), gitConfigText.slice(0, 24)).toBe(null)
    }
  })
})
