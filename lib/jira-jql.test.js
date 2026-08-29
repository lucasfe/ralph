// #126 — the spec for the JQL composition grammar, next to the code it describes.
//
// WHAT IS BEING ASSERTED. The user writes ELIGIBILITY in ralph.config.sh ("which tickets
// are mine to work on") and Ralph writes the rest: the label exclusion that keeps the loop
// off work already in flight, and an ordering, because a queue with no order is a queue
// that hands out a different ticket every poll. Everything interesting here is about the
// SEAM between those two halves — a user clause must survive verbatim, and Ralph's half
// must land where Jira will accept it.
//
// TWO HAZARDS drive most of the table. Jira demands ORDER BY be the LAST clause, so an
// exclusion cannot simply be appended to a query that has one; and `ORDER BY` is also just
// two words, so a query searching for the phrase must not be cut in half by the relocation.
//
// THE REFUSAL IS THE MOST IMPORTANT CASE. An empty JIRA_JQL must not compose to a bare
// exclusion: `labels NOT IN (...)` on its own selects EVERY ticket on the Jira site, and a
// count taken from that is a queue depth for someone else's board. It answers "not
// configured" instead, and the caller decides what a misconfigured source is worth.
//
// PURE, asserted by a static read at the bottom — no clock, no environment, no filesystem,
// no imports at all, exactly like git-remote-slug.js next door (#41).

import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import {
  composeJiraJql,
  JIRA_DEFAULT_ORDER_BY,
  JIRA_DONE_LABEL,
  JIRA_IN_PROGRESS_LABEL,
  JIRA_LABEL_EXCLUSION,
} from './jira-jql.js'

const composed = (jql) => composeJiraJql(jql).jql

// #129 — the two labels Ralph WRITES are both named here, in the module that composes the
// query that EXCLUDES them, and both are composed INTO that clause rather than retyped
// beside it. The failure this prevents is one bug with two spellings: a loop that stamps
// `done` and excludes something else hands the resolved ticket straight back out on the
// next pass, and one that transitions the ticket but never labels it does the same on any
// board whose workflow refused the move. Spelled once, so the ends cannot drift.
describe('the labels Ralph writes are the labels the query excludes (#129)', () => {
  it('names `done` beside `in-progress`, one constant each', () => {
    expect(JIRA_IN_PROGRESS_LABEL).toBe('in-progress')
    expect(JIRA_DONE_LABEL).toBe('done')
  })

  it('composes BOTH of them into the exclusion, from the constants and not by hand', () => {
    // Composed, not merely present: a literal `done` typed into the clause would satisfy a
    // `toContain` while leaving `JIRA_DONE_LABEL` free to say something else.
    expect(JIRA_LABEL_EXCLUSION).toContain(`(${JIRA_IN_PROGRESS_LABEL}, ${JIRA_DONE_LABEL},`)
    for (const label of [JIRA_IN_PROGRESS_LABEL, JIRA_DONE_LABEL, 'failed', 'do-not-ralph']) {
      expect(JIRA_LABEL_EXCLUSION, label).toContain(label)
    }
    // The `IS EMPTY` half is still load-bearing: in JQL a `NOT IN` never matches an item
    // whose field is unset, so without it every unlabelled ticket — most of the queue —
    // would be invisible.
    expect(JIRA_LABEL_EXCLUSION).toContain('labels IS EMPTY')
  })

  it('so a COMPLETED ticket drops out of the next composed query', () => {
    // The acceptance criterion, asserted where it lives. There is no second Jira to run the
    // query against, and faking one would prove the fake — but the ticket completeTask
    // labels is the ticket this clause refuses, and that is one string in one place.
    const jql = composed('project = RALPH AND statusCategory != Done')
    expect(jql).toContain(`labels NOT IN (${JIRA_IN_PROGRESS_LABEL}, ${JIRA_DONE_LABEL},`)
  })
})

describe('composeJiraJql — Ralph’s half of the query (#126)', () => {
  it('spells the exclusion and the default ordering in one named place', () => {
    // The clause is the interface — pinned here so a change to it is a change to a test,
    // not a silent change to which tickets every Ralph run considers eligible.
    expect(JIRA_LABEL_EXCLUSION).toBe(
      'AND (labels NOT IN (in-progress, done, failed, do-not-ralph) OR labels IS EMPTY)',
    )
    // The analog of github mode's `sort:created-asc`: oldest first, so a queue drains
    // rather than churning on whatever was filed last.
    expect(JIRA_DEFAULT_ORDER_BY).toBe('ORDER BY created ASC')
  })

  it('appends the exclusion and the default ordering when the user wrote no ORDER BY', () => {
    const r = composeJiraJql('project = RALPH AND statusCategory != Done')
    expect(r.ok).toBe(true)
    expect(r.reason).toBe(null)
    expect(r.jql).toBe(
      '(project = RALPH AND statusCategory != Done)' +
        ' AND (labels NOT IN (in-progress, done, failed, do-not-ralph) OR labels IS EMPTY)' +
        ' ORDER BY created ASC',
    )
  })

  it('injects the exclusion BEFORE a trailing ORDER BY and leaves the ordering last, verbatim', () => {
    const r = composeJiraJql('project = RALPH ORDER BY priority ASC')
    expect(r.ok).toBe(true)
    expect(r.jql).toBe(
      '(project = RALPH)' +
        ' AND (labels NOT IN (in-progress, done, failed, do-not-ralph) OR labels IS EMPTY)' +
        ' ORDER BY priority ASC',
    )
    // The two claims Jira actually enforces, spelled as claims rather than as one string.
    expect(r.jql.endsWith('ORDER BY priority ASC')).toBe(true)
    expect(r.jql.indexOf('labels NOT IN')).toBeLessThan(r.jql.indexOf('ORDER BY'))
    // ...and the user's ordering REPLACES the default rather than joining it.
    expect(r.jql).not.toContain(JIRA_DEFAULT_ORDER_BY)
  })

  it('relocates the ordering in every case and spacing Jira accepts', () => {
    const orderings = [
      'ORDER BY priority ASC',
      'order by priority ASC',
      'Order By priority ASC',
      'oRdEr bY priority ASC',
      'ORDER   BY priority ASC',
      'ORDER\tBY priority ASC',
      'ORDER\nBY priority ASC',
      'ORDER BY priority ASC, created DESC',
      'ORDER BY cf[10001] DESC',
      'order by created',
    ]
    for (const ordering of orderings) {
      const r = composeJiraJql(`project = RALPH ${ordering}`)
      expect(r.ok, ordering).toBe(true)
      // Verbatim and last: the ordering is the user's text, not a normalized rewrite of it.
      expect(r.jql, ordering).toBe(
        `(project = RALPH) ${JIRA_LABEL_EXCLUSION} ${ordering}`,
      )
    }
  })

  it('reads the LAST unquoted ORDER BY, so a where-clause mention cannot strand one', () => {
    // Not legal JQL to begin with, but the direction of the failure matters: cutting at the
    // FIRST match would leave an ORDER BY in the middle of the composed query, which Jira
    // rejects outright. Cutting at the last one keeps whatever the user meant at the end.
    const r = composeJiraJql('project = RALPH ORDER BY created ASC ORDER BY priority DESC')
    expect(r.jql.endsWith('ORDER BY priority DESC')).toBe(true)
    expect(r.jql.indexOf(JIRA_LABEL_EXCLUSION)).toBeLessThan(r.jql.lastIndexOf('ORDER BY'))
  })

  it('does NOT split on an ORDER BY inside a quoted string literal', () => {
    // `summary ~ "order by"` is a text search for a phrase. Splitting there would send Jira
    // `(summary ~ ") AND (...) order by"` — a syntax error at best, and at worst a query
    // that means something else entirely.
    const quoted = [
      'summary ~ "order by"',
      "summary ~ 'order by'",
      'project = RALPH AND summary ~ "ORDER BY"',
      'summary ~ "please order by priority"',
      // A quote escaped INSIDE the literal must not be read as closing it.
      'summary ~ "say \\" order by" AND project = RALPH',
    ]
    for (const jql of quoted) {
      expect(composed(jql), jql).toBe(`(${jql}) ${JIRA_LABEL_EXCLUSION} ${JIRA_DEFAULT_ORDER_BY}`)
    }
  })

  it('splits on the real ordering even when a quoted ORDER BY sits in front of it', () => {
    const r = composeJiraJql('summary ~ "order by" AND project = RALPH ORDER BY updated DESC')
    expect(r.jql).toBe(
      `(summary ~ "order by" AND project = RALPH) ${JIRA_LABEL_EXCLUSION} ORDER BY updated DESC`,
    )
  })

  it('wraps the user’s clause in parentheses, so an OR in it cannot be widened by the AND', () => {
    // JQL binds AND tighter than OR. Appending `AND <exclusion>` to `a OR b` would mean
    // `a OR (b AND <exclusion>)` — leaving every ticket matching `a` eligible however it is
    // labelled, which is precisely the in-progress work the exclusion exists to skip.
    const r = composeJiraJql('project = RALPH OR project = OTHER')
    expect(r.jql.startsWith('(project = RALPH OR project = OTHER) AND (')).toBe(true)
  })

  it('appends Ralph’s exclusion even to a query that already mentions labels', () => {
    // Ralph's half is not conditional on the user's half. A user filtering by their own
    // label still gets the in-progress exclusion, because that one is about the LOOP's
    // state and not about the user's taxonomy.
    const r = composeJiraJql('project = RALPH AND labels = ready')
    expect(r.ok).toBe(true)
    expect(r.jql).toBe(
      `(project = RALPH AND labels = ready) ${JIRA_LABEL_EXCLUSION} ${JIRA_DEFAULT_ORDER_BY}`,
    )
    expect(r.jql).toContain('labels = ready')
    expect(r.jql).toContain('labels NOT IN (in-progress, done, failed, do-not-ralph)')
  })

  it('trims the user’s clause without touching what is inside it', () => {
    expect(composed('  project = RALPH  ')).toBe(
      `(project = RALPH) ${JIRA_LABEL_EXCLUSION} ${JIRA_DEFAULT_ORDER_BY}`,
    )
    expect(composed('project = RALPH   ORDER BY created ASC   ')).toBe(
      `(project = RALPH) ${JIRA_LABEL_EXCLUSION} ORDER BY created ASC`,
    )
  })

  it('is deterministic — the same input composes the same query every time', () => {
    const jql = 'project = RALPH AND assignee = currentUser() ORDER BY created ASC'
    expect(composeJiraJql(jql)).toEqual(composeJiraJql(jql))
  })
})

describe('composeJiraJql — the refusal, which must never select a whole Jira site', () => {
  const misconfigured = [
    ['nothing at all', undefined],
    ['null', null],
    ['an empty string', ''],
    ['spaces', '   '],
    ['a tab and a newline', '\t\n'],
    // An ORDER BY with no eligibility clause is the dangerous case dressed up as a
    // configured one: the where-clause is empty, so the query selects everything.
    ['an ordering and no clause', 'ORDER BY created ASC'],
    ['a lowercase ordering and no clause', '  order by created  '],
    // Not strings: a caller handing us a parsed number/object gets a refusal, not a cast.
    ['a number', 42],
    ['an object', {}],
    ['an array', []],
    ['a function', () => 'project = RALPH'],
    ['a boolean', true],
  ]

  for (const [label, input] of misconfigured) {
    it(`refuses ${label}`, () => {
      const r = composeJiraJql(input)
      expect(r.ok).toBe(false)
      expect(r.jql).toBe(null)
      // The reason NAMES THE SETTING, because the only fix is in ralph.config.sh.
      expect(r.reason).toMatch(/JIRA_JQL/)
    })
  }

  it('never composes a query out of Ralph’s half alone', () => {
    for (const [, input] of misconfigured) {
      expect(composeJiraJql(input).jql).toBe(null)
    }
  })

  it('never throws and never coerces, whatever it is handed', () => {
    const hostile = {
      toString() {
        throw new Error('a config value must never be coerced')
      },
    }
    for (const input of [hostile, Object.create(null), Symbol('jql')]) {
      expect(composeJiraJql(input).ok, String(typeof input)).toBe(false)
    }
  })
})

describe('jira-jql — purity', () => {
  it('reads no clock, no environment and no filesystem — and imports nothing', () => {
    // The ABSENCE of a capability cannot be shown by exercising happy paths, so it is
    // asserted statically, the way every other pure module in lib/ asserts it. This one is
    // handed a string a caller already read out of ralph.config.sh, which is what makes the
    // whole table above testable with no config file, no acli and no Jira site (#41).
    const code = codeWithoutComments(new URL('./jira-jql.js', import.meta.url))

    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/node:(fs|os|path|child_process|tty)/)
    expect([...code.matchAll(/^import .* from '(.*)'$/gm)]).toEqual([])
  })
})
