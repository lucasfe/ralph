import { describe, expect, it } from 'vitest'
import {
  composeJiraJql,
  JIRA_DEFAULT_ORDER_BY,
  JIRA_DONE_LABEL,
  JIRA_IN_PROGRESS_LABEL,
  JIRA_LABEL_EXCLUSION,
} from './jira-jql.js'

// QA augmentation for #126. The dev's jira-jql.test.js locks the grammar's happy paths —
// an appended exclusion, a relocated ORDER BY, a quoted phrase that must not be cut, and
// the refusal that keeps Ralph's half from selecting a whole Jira site. This file attacks
// the one piece of the module that is a HAND-ROLLED SCANNER, because that is where a
// grammar stops being a grammar:
//
//   THE INPUTS NOBODY TYPED ON PURPOSE. A quote nobody closed, a quote closed by the other
//   kind, an escaped backslash immediately before a closing quote, a lone backslash at end
//   of input. Every one of them decides whether the walker still believes it is inside a
//   string literal, and that belief is the only thing standing between `summary ~ "order
//   by"` and a query cut in half.
//
//   THE WORD BOUNDARY, from both sides. `reorder by`, `ORDER_BY`, `ORDERBY`, `ORDER BYX`
//   and a field literally named `order` must all be ordinary text, because a false positive
//   here does not fail — it silently moves half the user's where-clause into the ordering.
//
//   WHAT SURVIVES A QUERY THAT WAS NEVER LEGAL. Two orderings, an ordering with nothing
//   after it, an ordering with a newline inside it: the module's promise is that the
//   ordering comes back VERBATIM and last, not that the result is valid JQL, and the
//   difference is pinned here rather than assumed. A query Jira rejects costs a count (acli
//   exits non-zero, the caller reads 0); a query Jira ACCEPTS with the wrong meaning costs
//   a wrong count, and those are not the same failure.
//
// Ralph's half is asserted against the EXPORTED CONSTANTS throughout, never against a
// hand-copied string, so an edit to either clause cannot pass by moving a literal with it.
//
// Pure by construction — no clock, no filesystem, no environment, nothing injected.

// Bytes that matter to the walker, spelled from their code points: a fixture whose
// escaping is ambiguous in the source is a fixture nobody can review (the convention
// lib/commands/doctor.identity-box.test.js documents).
const BS = String.fromCharCode(0x5c)
const CR = String.fromCharCode(0x0d)
const LF = String.fromCharCode(0x0a)
const TAB = String.fromCharCode(0x09)

const composed = (jql) => composeJiraJql(jql).jql

// The composed shape, assembled from the exports rather than typed out: `(where) <exclusion>
// <ordering>`, one space between the three parts.
const ralphsHalf = (where, ordering = JIRA_DEFAULT_ORDER_BY) =>
  `(${where}) ${JIRA_LABEL_EXCLUSION} ${ordering}`

const occurrences = (haystack, needle) => haystack.split(needle).length - 1

describe('composeJiraJql — quotes nobody closed (#126 QA)', () => {
  // The walker's whole job is to know whether position i is inside a string literal. Every
  // case below is a literal whose end is ambiguous, and the safe reading is the same one:
  // when in doubt the region stays QUOTED, so nothing is cut and the user's text survives
  // whole. A query Jira then rejects reads as 0 through jira-queue.js, which is the cost of
  // one cycle; a query cut inside a literal would have been a different query that RUNS.

  it('swallows the rest of the input when a double quote is never closed', () => {
    // `summary ~ "order by` — the phrase is inside a literal as far as anyone can tell, so
    // it is not an ordering, and the default one is appended after it.
    expect(composed('summary ~ "order by')).toBe(ralphsHalf('summary ~ "order by'))
  })

  it('hides a REAL trailing ORDER BY behind an unclosed quote, rather than guessing', () => {
    // The direction of this failure is the point. The user's ordering ends up inside the
    // where-clause and Ralph appends its default after it, so the composed query carries two
    // orderings and Jira rejects it outright — a count of 0 and a cycle that says "queue
    // empty". Guessing the quote closed at the whitespace would instead produce a query that
    // RUNS with a where-clause the user never wrote.
    const input = 'summary ~ "abc ORDER BY created ASC'
    expect(composed(input)).toBe(ralphsHalf(input))
    expect(occurrences(composed(input), 'ORDER BY')).toBe(2)
  })

  it('does not let one kind of quote close the other', () => {
    const input = `summary ~ "abc' ORDER BY created ASC`
    expect(composed(input)).toBe(ralphsHalf(input))
  })

  it('closes an EMPTY quoted string, so the ORDER BY right after it is still found', () => {
    // `""` is the shortest literal there is, and a walker that skipped the closing quote
    // (an off-by-one in the escape branch does exactly this) would read everything after it
    // as quoted and never relocate the ordering.
    expect(composed('summary ~ "" ORDER BY updated DESC')).toBe(
      ralphsHalf('summary ~ ""', 'ORDER BY updated DESC'),
    )
  })

  it('reads an ESCAPED BACKSLASH before a closing quote as ending the literal', () => {
    // `"a\\"` is a literal containing one backslash, and the quote after it CLOSES. A walker
    // that consumed the backslash-escape and then also treated the quote as escaped would
    // stay inside the literal for the rest of the input and miss the ordering entirely.
    const input = `summary ~ "a${BS}${BS}" ORDER BY updated DESC`
    expect(composed(input)).toBe(ralphsHalf(`summary ~ "a${BS}${BS}"`, 'ORDER BY updated DESC'))
  })

  it('survives a lone trailing backslash inside a literal at end of input', () => {
    // The escape branch skips the NEXT character; at the last index there is none, so this is
    // the case that walks off the end of the string. It must answer, not throw.
    const input = `project = R AND summary ~ "x${BS}`
    const r = composeJiraJql(input)
    expect(r.ok).toBe(true)
    expect(r.jql).toBe(ralphsHalf(input))
  })

  it('honours a backslash escape inside a SINGLE-quoted literal too', () => {
    // `'say \" order by'` never leaves the literal, so there is no ordering in it.
    const input = `summary ~ 'say ${BS}" order by'`
    expect(composed(input)).toBe(ralphsHalf(input))
  })

  it('treats a backslash OUTSIDE a literal as ordinary text, so the quote after it opens one', () => {
    // The shape a user gets by escaping quotes for the shell and having them survive the
    // config read: `summary ~ \"x\"` opens a literal at the first quote, the escape inside it
    // consumes the closing one, and the ordering after it is swallowed. Pinned because it is
    // reachable from a real ralph.config.sh — see the wiring suites — not because it is right.
    const input = `project = R AND summary ~ ${BS}"x${BS}" ORDER BY created ASC`
    expect(composed(input)).toBe(ralphsHalf(input))
  })
})

describe('composeJiraJql — the word boundary before ORDER (#126 QA)', () => {
  // A false positive here is the expensive direction: the text before the match becomes the
  // whole where-clause and everything after it becomes "the ordering", so a user's filter
  // silently stops applying. Each of these must be ordinary text.
  const notAnOrdering = [
    ['a field whose name ends in order', 'project = R AND sortorder by = 3'],
    ['reorder', 'project = R AND summary ~ reorder by hand'],
    ['myorder', 'project = R AND myorder by y'],
    ['an underscore instead of a space', 'project = R ORDER_BY created'],
    ['no space at all', 'project = R ORDERBY created'],
    ['BY glued to the next word', 'project = R ORDER BYX'],
    ['a field literally named order', 'order = 5 AND project = R'],
  ]

  for (const [label, input] of notAnOrdering) {
    it(`does not relocate anything for ${label}`, () => {
      expect(composed(input)).toBe(ralphsHalf(input))
      // Anti-vacuity: the clause really did survive whole, ordering and all.
      expect(composed(input)).toContain(input)
    })
  }

  it('accepts any non-word character before ORDER, including a closing parenthesis', () => {
    expect(composed('(project = R)ORDER BY created DESC')).toBe(
      ralphsHalf('(project = R)', 'ORDER BY created DESC'),
    )
  })

  it('accepts every whitespace Jira does between the two words, and keeps it verbatim', () => {
    // The dev's suite covers a space, a tab and a newline; these are the two-byte and
    // multi-byte shapes a config edited on Windows or wrapped by an editor produces.
    for (const gap of [`${CR}${LF}`, `${TAB}${TAB}`, ` ${LF} `, '     ']) {
      const ordering = `ORDER${gap}BY created`
      expect(composed(`project = R ${ordering}`), JSON.stringify(gap)).toBe(
        ralphsHalf('project = R', ordering),
      )
    }
  })
})

describe('composeJiraJql — orderings that are legal to write and not legal to run (#126 QA)', () => {
  // The contract is "verbatim and last", NOT "valid". These pin what that costs, because a
  // wart nobody has written down is a wart the next reader has to rediscover from acli's
  // stderr.

  it('re-appends an ORDER BY with nothing after it, producing a query Jira will reject', () => {
    // `ORDER BY` alone is a syntax error, and it stays one: the composed query ends with the
    // bare keyword rather than falling back to the default ordering. The user's typo costs
    // them a count (acli exits non-zero, the caller reads 0) and never a wrong count.
    const r = composeJiraJql('project = R ORDER BY')
    expect(r.ok).toBe(true)
    expect(r.jql).toBe(ralphsHalf('project = R', 'ORDER BY'))
    expect(r.jql).not.toContain(JIRA_DEFAULT_ORDER_BY)
  })

  it('keeps a CR/LF inside a relocated ordering, so the argv can carry a line break', () => {
    // Nothing normalizes the user's text, which means the string handed to acli as one argv
    // element can contain a newline. It travels as an argument and never through a shell
    // (asserted in jira-queue.qa.test.js), so this is cosmetic rather than dangerous — but it
    // is pinned, because "verbatim" is a promise with a consequence.
    const ordering = `ORDER${CR}${LF}BY created`
    const r = composeJiraJql(`project = R ${ordering}`)
    expect(r.jql).toBe(ralphsHalf('project = R', ordering))
    expect(r.jql.includes(LF)).toBe(true)
  })

  it('carries a QUOTED order-by phrase that sits after the real one into the ordering', () => {
    // "Last UNQUOTED match wins" has a tail: everything after that match is the ordering,
    // including a quoted phrase that only looks like one. The alternative — cutting at the
    // quoted mention — would strand a real ORDER BY in the middle of the composed query.
    const r = composeJiraJql('project = R ORDER BY created ASC AND summary ~ "order by"')
    expect(r.jql).toBe(
      ralphsHalf('project = R', 'ORDER BY created ASC AND summary ~ "order by"'),
    )
  })

  it('takes the LAST of three unquoted orderings, not the second', () => {
    // "Last wins" and "second wins" agree on the dev's two-ordering fixture; they part
    // company here, which is why the third one exists.
    expect(composed('project = R ORDER BY a ORDER BY b ORDER BY c')).toBe(
      ralphsHalf('project = R ORDER BY a ORDER BY b', 'ORDER BY c'),
    )
  })
})

describe('composeJiraJql — the refusal at its edges (#126 QA)', () => {
  it('refuses a bare ORDER BY, with no column and no clause', () => {
    // The dev's table covers `ORDER BY created ASC`; this is the shortest input that cuts to
    // an empty where-clause, and the one an interrupted edit leaves behind.
    for (const input of ['ORDER BY', ` ORDER${TAB}BY `, `${LF}order by${LF}`]) {
      const r = composeJiraJql(input)
      expect(r.ok, JSON.stringify(input)).toBe(false)
      expect(r.jql, JSON.stringify(input)).toBe(null)
      expect(r.reason).toMatch(/JIRA_JQL/)
    }
  })

  it('refuses a whitespace-only clause of every byte the config can hold', () => {
    for (const input of [' ', TAB, LF, `${CR}${LF}`, `  ${TAB}${CR}${LF}  `]) {
      expect(composeJiraJql(input).ok, JSON.stringify(input)).toBe(false)
    }
  })

  it('refuses a boxed String, a BigInt and a Proxy that traps every read', () => {
    // `typeof new String('x')` is 'object', so the type check refuses it — which is the
    // conservative answer: a caller that produced a String OBJECT out of a config read has a
    // bug worth surfacing as "not configured" rather than one worth papering over.
    const hostile = [
      new String('project = R'),
      10n,
      new Proxy(
        {},
        {
          get() {
            throw new Error('a config value must never be read through a trap')
          },
        },
      ),
      { valueOf: () => 'project = R' },
      { toString: null },
      Object.freeze({}),
    ]
    for (const input of hostile) {
      const r = composeJiraJql(input)
      expect(r.ok, String(typeof input)).toBe(false)
      expect(r.jql).toBe(null)
    }
  })

  it('answers the SAME refusal object shape on both arms, with no extra keys', () => {
    // The result is a discriminated union a caller switches on (`ralph status` asks `.ok`
    // before it asks anything else). Both arms must carry all three keys, so a caller reading
    // `.jql` on a refusal gets `null` rather than `undefined`.
    const good = composeJiraJql('project = R')
    const bad = composeJiraJql('')
    expect(Object.keys(good).sort()).toEqual(['jql', 'ok', 'reason'])
    expect(Object.keys(bad).sort()).toEqual(['jql', 'ok', 'reason'])
    expect(bad.reason.length).toBeGreaterThan(10)
    // A fresh object per call: a shared, mutable singleton would let one caller's edit
    // travel to the next.
    expect(composeJiraJql('')).not.toBe(bad)
    expect(composeJiraJql('')).toEqual(bad)
  })
})

describe('composeJiraJql — Ralph’s half lands once, from the exported constants (#126 QA)', () => {
  it('appends the exclusion exactly ONCE, and the ordering exactly once', () => {
    const r = composeJiraJql('project = R AND labels = ready')
    expect(occurrences(r.jql, JIRA_LABEL_EXCLUSION)).toBe(1)
    expect(occurrences(r.jql, JIRA_DEFAULT_ORDER_BY)).toBe(1)
  })

  it('spells the exclusion’s two halves as one clause — the IS EMPTY half is load-bearing', () => {
    // In JQL a `NOT IN` comparison never matches a work item whose field is unset, so
    // `labels NOT IN (...)` alone hides every unlabelled ticket — which is most freshly filed
    // ones, i.e. the queue itself. Asserted on the constant, since that is what ships.
    expect(JIRA_LABEL_EXCLUSION).toContain('labels IS EMPTY')
    expect(JIRA_LABEL_EXCLUSION.startsWith('AND (')).toBe(true)
    expect(JIRA_LABEL_EXCLUSION.endsWith(')')).toBe(true)
    // `done` joined this list in #129 and is swept with the rest — the sweep was written when
    // there were three labels and would have gone on passing with the fourth missing.
    for (const label of ['in-progress', 'done', 'failed', 'do-not-ralph']) {
      expect(JIRA_LABEL_EXCLUSION).toContain(label)
    }
  })

  it('DUPLICATES the exclusion when handed a query it already composed (pinned wart)', () => {
    // Composition is not idempotent and nothing stops a caller doing it twice. Today there is
    // exactly one caller (jira-queue.js, from the raw config value), so this is unreachable —
    // pinned so that a second caller that double-composes fails a test instead of quietly
    // sending Jira the exclusion twice.
    const once = composeJiraJql('project = R').jql
    const twice = composeJiraJql(once).jql
    expect(occurrences(twice, JIRA_LABEL_EXCLUSION)).toBe(2)
    // The ORDERING, at least, is relocated rather than duplicated.
    expect(occurrences(twice, JIRA_DEFAULT_ORDER_BY)).toBe(1)
    expect(twice.endsWith(JIRA_DEFAULT_ORDER_BY)).toBe(true)
  })

  it('holds no state between calls — a shared sticky regex cannot leak its lastIndex', () => {
    // The walk locates `ORDER BY` with a STICKY regex, whose `lastIndex` is mutable state,
    // and it sets that index explicitly before each test of it. What this pins is that the
    // explicit set is LOAD-BEARING: drop it and the composition comes out wrong — on the
    // FIRST call, not merely a later one — so the value assertions below are this test's
    // teeth, not the repeat.
    //
    // The regex is declared inside `lastUnquotedOrderBy`, a fresh one per call, which makes
    // a leak structurally impossible rather than merely unobserved. Measured, so that the
    // scope of this claim is honest: hoisting it back to module scope for the one allocation
    // while KEEPING the reset is observationally identical and passes — no test can catch
    // that edit — whereas dropping the reset fails, from either scope. The repeat below (the
    // same input composed before and after a longer one) is kept as a statement of the bug
    // class this walk must not acquire, not as the thing that would detect it.
    const short = 'p = R ORDER BY a'
    const long = 'project = VERYLONGPROJECTKEY AND statusCategory != Done ORDER BY created ASC'
    const first = composed(short)
    composed(long)
    expect(composed(short)).toBe(first)
    expect(first).toBe(ralphsHalf('p = R', 'ORDER BY a'))
    expect(composed(long)).toBe(
      ralphsHalf('project = VERYLONGPROJECTKEY AND statusCategory != Done', 'ORDER BY created ASC'),
    )
  })

  it('does not mutate, intern or share the string it was handed', () => {
    const input = 'project = R ORDER BY created ASC'
    const before = String(input)
    composeJiraJql(input)
    expect(input).toBe(before)
  })
})

describe('composeJiraJql — what the parentheses contain, and what they do not (#126 QA)', () => {
  it('keeps a permissive OR inside the wrap, so the exclusion binds to every branch', () => {
    // The reason the wrap exists: JQL binds AND tighter than OR, so an unwrapped
    // `a OR b AND <exclusion>` means `a OR (b AND <exclusion>)`. Wrapped, the exclusion
    // applies to the whole disjunction — including a clause as wide as `1=1`.
    const r = composeJiraJql('project = R OR 1=1')
    expect(r.jql).toBe(ralphsHalf('project = R OR 1=1'))
    expect(r.jql.indexOf(')')).toBeLessThan(r.jql.indexOf(JIRA_LABEL_EXCLUSION))
  })

  it('does NOT contain a clause that closes Ralph’s parenthesis for it (pinned limitation)', () => {
    // The one shape the wrap cannot survive, and the reason it is worth pinning rather than
    // shrugging at: the result is BALANCED and therefore valid JQL, so nothing errors. The
    // exclusion has become the right-hand branch of an OR, and every work item matching
    // `project = R` is eligible again however it is labelled — the in-progress work the
    // exclusion exists to skip. Nothing in the module checks parenthesis balance.
    const r = composeJiraJql('project = R) OR (1=1')
    expect(r.ok).toBe(true)
    expect(r.jql).toBe(`(project = R) OR (1=1) ${JIRA_LABEL_EXCLUSION} ${JIRA_DEFAULT_ORDER_BY}`)
    // Balanced: the composed query is one Jira will happily run.
    const opens = occurrences(r.jql, '(')
    const closes = occurrences(r.jql, ')')
    expect(opens).toBe(closes)
    // ...and the exclusion is no longer ANDed onto the user's clause.
    expect(r.jql.startsWith(`(project = R) OR (1=1) AND (`)).toBe(true)
  })

  it('leaves a trailing AND or OR exactly where the user left it', () => {
    // A half-finished clause is a syntax error before and after composition; what must not
    // happen is Ralph's exclusion becoming the missing operand of the user's dangling `AND`
    // in a way that RUNS. It does not: the wrap keeps the broken clause broken.
    expect(composed('project = R AND')).toBe(ralphsHalf('project = R AND'))
  })
})

// ---------------------------------------------------------------------------
// #129 QA — THE LABEL THE COMPLETION WRITES. `done` joined the exclusion in this slice, and
// the module says why it carries more weight than its sibling: the transition can be refused
// and the comment is best-effort, so THIS LABEL is the only part of a completion guaranteed to
// take a resolved ticket out of the queue. That makes the exclusion's contents an interface
// with two ends, and the tests below hold both — the constant the writer uses and the clause
// the reader sends — plus the blast radius of adding a fourth name to a list of three.
// ---------------------------------------------------------------------------
describe('the exclusion after `done` joined it (#129 QA)', () => {
  it('names exactly four labels, and both labels Ralph WRITES come from the constants', () => {
    // The drift this prevents is the worst bug this feature can have: a completion that labels
    // `done` beside an exclusion that says something else hands the same resolved ticket out
    // forever, having done the work each time. So the assertion is that the clause CONTAINS the
    // constants rather than that it equals a transcribed string.
    expect(JIRA_LABEL_EXCLUSION).toContain(`(${JIRA_IN_PROGRESS_LABEL}, ${JIRA_DONE_LABEL},`)
    const inside = JIRA_LABEL_EXCLUSION.slice(
      JIRA_LABEL_EXCLUSION.indexOf('NOT IN (') + 'NOT IN ('.length,
      JIRA_LABEL_EXCLUSION.indexOf(') OR'),
    )
    expect(inside.split(', ')).toEqual([JIRA_IN_PROGRESS_LABEL, JIRA_DONE_LABEL, 'failed', 'do-not-ralph'])
    // Four names, each once: a label listed twice would be harmless and a label listed under
    // two spellings would not.
    expect(occurrences(JIRA_LABEL_EXCLUSION, JIRA_DONE_LABEL)).toBe(1)
    expect(occurrences(JIRA_LABEL_EXCLUSION, JIRA_IN_PROGRESS_LABEL)).toBe(1)
  })

  it('keeps `done` unquoted and syntactically indistinguishable from its three siblings', () => {
    // A new name in a comma list is the kind of edit that acquires a stray quote or a hyphen
    // problem. `done` is a bare word like `failed`, so if one of them is legal JQL both are —
    // which is the only assurance available here, since nothing in this repo can run JQL.
    const names = ['in-progress', 'done', 'failed', 'do-not-ralph']
    for (const name of names) {
      expect(JIRA_LABEL_EXCLUSION).toContain(name)
      expect(JIRA_LABEL_EXCLUSION).not.toContain(`"${name}"`)
      expect(JIRA_LABEL_EXCLUSION).not.toContain(`'${name}'`)
    }
    // ...and `done` did not accidentally land inside another word: `do-not-ralph` also begins
    // with `do`, which is exactly the near-miss a substring assertion cannot see.
    expect(/\bdone\b/.test(JIRA_LABEL_EXCLUSION)).toBe(true)
    expect(JIRA_LABEL_EXCLUSION).not.toContain('donedo')
  })

  it('lands once in a composed query, whatever the user wrote', () => {
    // The blast radius of the change, swept: the fourth name must not alter WHERE Ralph's half
    // goes for any of the shapes the composer handles.
    for (const jql of [
      'project = R',
      'project = R ORDER BY created DESC',
      'project = R AND labels = ready',
      'project = R OR project = S',
      'summary ~ "ORDER BY"',
    ]) {
      const r = composeJiraJql(jql)
      expect(r.ok, jql).toBe(true)
      expect(occurrences(r.jql, JIRA_LABEL_EXCLUSION), jql).toBe(1)
      expect(occurrences(r.jql, `, ${JIRA_DONE_LABEL},`), jql).toBe(1)
    }
  })

  it('CONTRADICTS a user query that selects on `done` itself, silently (pinned limitation)', () => {
    // Worth pinning because #129 widened the surface for it: a JIRA_JQL of `labels = done` (a
    // reasonable thing for somebody to write while testing, or for a project that uses `done`
    // as a real label) composes into a query that ANDs `labels = done` with `labels NOT IN
    // (..., done, ...)`, which is valid JQL that can never match. The consequence is a queue
    // that reads as permanently EMPTY — the silent failure mode this module worries about
    // throughout — and nothing here can detect it, because the composer does not parse the
    // user's clause and must not: a query naming `done` for some other reason (`labels != done`
    // is the same shape) is legitimate.
    //
    // WHAT WOULD SURFACE IT, MEASURED RATHER THAN ASSUMED: the composed query is counted by
    // `ralph status` (lib/commands/status.js:232, which renders it as "N waiting") and by
    // `ralph cycle`, so a contradictory JIRA_JQL reads as `0 waiting` there. `ralph doctor` —
    // the command a user actually runs at setup, and the one that would catch this before a
    // night of no-ops — does NOT: its only Jira probe is `acli` auth (lib/commands/doctor.js,
    // #125). It never calls queueCount and never prints a depth. So this is a FOLLOW-UP rather
    // than a tolerable limitation: the diagnostic that should catch it is the one that does not
    // look. Recorded here so a future reader who sees an inexplicably empty Jira queue finds
    // this test.
    const r = composeJiraJql('project = R AND labels = done')
    expect(r.ok).toBe(true)
    expect(r.jql).toBe(ralphsHalf('project = R AND labels = done'))
    // Both halves present, contradicting each other. Asserted so the shape is unmistakable.
    expect(r.jql).toContain('labels = done')
    expect(r.jql).toContain(`labels NOT IN (${JIRA_IN_PROGRESS_LABEL}, ${JIRA_DONE_LABEL},`)
    // ...and the same query naming `in-progress` has been contradictory since #127, so this is
    // a widening of an existing limitation rather than a new class of one.
    expect(composeJiraJql('labels = in-progress').jql).toContain('labels NOT IN')
  })
})
