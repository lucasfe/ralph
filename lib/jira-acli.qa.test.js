import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import * as acli from './jira-acli.js'
import {
  acliCommentArgv,
  acliCountArgv,
  acliEditLabelsArgv,
  acliPickArgv,
  acliRemoveLabelsArgv,
  acliText,
  acliTitlesArgv,
  acliTransitionArgv,
  acliViewLabelsArgv,
  allWorkItems,
  findLabelArray,
  firstWorkItem,
  parseCount,
  parseJsonOrUndefined,
  summaryOf,
  writableLabels,
} from './jira-acli.js'

// QA augmentation for #129's NEW FILE — the acli layer that came out of jira-queue.js when
// completion took the invocation count from four to seven. The dev's suite tests this module
// THROUGH the verbs (jira-queue.test.js asserts the argv `completeTask` recorded), which is
// the right way round for a contract and leaves three things nothing can see from there:
//
//   THE BUILDERS AS A SET, AND WHICH OF THEM ARE WRITES. This file's own header says
//   "Every WRITE builder below carries [--yes], and jira-queue.test.js asserts that of every
//   recorded write rather than of these lines, so a write added later cannot quietly omit
//   it." That is only true of a write some verb already makes: a NEW builder — added
//   here for a slice that has not wired it up yet, or wired into a path no test drives —
//   inherits nothing. So the sweep below enumerates the module's OWN exports, classifies each
//   by the acli subcommand it names, and holds every write to `--yes` and every read to its
//   absence. It is the structural half of the claim the header makes behaviourally.
//
//   That is not hypothetical any more: #132's `acliTitlesArgv` was the eighth, and this sweep
//   is where it had to be classified. It came out a READ, which is why the write list below is
//   still the same four names it was at seven builders.
//
//   THE READERS AT THEIR OWN BOUNDARIES. `parseCount`, `firstWorkItem`, `summaryOf`,
//   `findLabelArray` and `writableLabels` are reached through two verbs that each swallow
//   most of the distinctions they make (a pick answers null for everything; a claim refuses).
//   Called directly, the distinction between "null, no list" and "[], an empty list" — the
//   one the whole read-then-union safety property turns on — is a value, not an inference.
//
//   THE PRECONDITIONS THE EXPORTS DO NOT DEFEND. This module is pure and edgeless and it
//   VALIDATES NOTHING about its arguments: two of the functions below throw on inputs no
//   caller in the repo can produce. Pinned rather than fixed, because they are pinned as a
//   statement about who may call them — the shape of the gap, so a future importer that
//   hands one of them a raw parse result finds a test that says so.
//
// NOTHING HERE SPAWNS acli. `acliText` takes its spawner as an argument, so every process in
// this file is a `vi.fn`; the argv builders are pure functions of strings.

const LF = String.fromCharCode(0x0a)
const CR = String.fromCharCode(0x0d)
const TAB = String.fromCharCode(0x09)
const NUL = String.fromCharCode(0x00)
const ESC = String.fromCharCode(0x1b)
const QUOTE = String.fromCharCode(0x22)
const BACKSLASH = String.fromCharCode(0x5c)

// Every argv builder this module exports, discovered rather than listed: the point of the
// sweep below is to catch a builder nobody remembered to add to a list.
const BUILDERS = Object.entries(acli)
  .filter(([name, value]) => name.startsWith('acli') && name.endsWith('Argv'))
  .map(([name, build]) => [name, build])

// One representative call per builder. The VALUES are irrelevant to the classification (both
// arguments are always strings); what matters is that every builder is exercised.
const CALLS = {
  acliCountArgv: () => acliCountArgv('project = R'),
  acliPickArgv: () => acliPickArgv('project = R'),
  acliViewLabelsArgv: () => acliViewLabelsArgv('FOO-1'),
  acliEditLabelsArgv: () => acliEditLabelsArgv('FOO-1', 'a,b'),
  acliRemoveLabelsArgv: () => acliRemoveLabelsArgv('FOO-1', 'in-progress'),
  acliTransitionArgv: () => acliTransitionArgv('FOO-1', 'Done'),
  acliCommentArgv: () => acliCommentArgv('FOO-1', 'body'),
  // #132's batch title lookup. Its second argument is a COUNT, and it is handed one as a
  // number here on purpose: `String(limit)` inside the builder is what the all-strings sweep
  // below is checking, and passing a pre-stringified `'1'` would test nothing.
  acliTitlesArgv: () => acliTitlesArgv('key IN (FOO-1)', 1),
}

// Which acli subcommands MUTATE somebody's board. `edit` covers both label writes, and the
// two-word `comment create` is the one whose subcommand sits at index 2 like the rest.
const WRITE_SUBCOMMANDS = ['edit', 'transition', 'comment']
const READ_SUBCOMMANDS = ['search', 'view']

describe('jira-acli — the eight builders as a SET, and which of them are writes (#132 QA)', () => {
  it('exports exactly eight argv builders — the count its own header claims', () => {
    // MEASURED against the module rather than transcribed from the prose: the header says
    // "eight argv builders above" and "there are eight invocations and four of them are
    // WRITES", and both numbers are now assertions. A ninth builder fails this test, which
    // is the point — it is the moment somebody has to decide whether it is a read or a write
    // and whether the sweep below covers it. #132 is the worked example: it arrived as the
    // eighth, this list and the count moved by one, and the write list did not move at all.
    expect(BUILDERS.map(([name]) => name).sort()).toEqual([
      'acliCommentArgv',
      'acliCountArgv',
      'acliEditLabelsArgv',
      'acliPickArgv',
      'acliRemoveLabelsArgv',
      'acliTitlesArgv',
      'acliTransitionArgv',
      'acliViewLabelsArgv',
    ])
    expect(BUILDERS).toHaveLength(8)
    // Anti-vacuity for the sweeps below: every discovered builder has a call recipe, so none
    // of them is skipped by a missing entry in CALLS.
    expect(Object.keys(CALLS).sort()).toEqual(BUILDERS.map(([name]) => name).sort())
  })

  it('four of the eight are WRITES, and every one of them carries --yes LAST', () => {
    // The structural half of the `--yes` promise. The behavioural half (jira-queue.test.js
    // sweeping recorded writes) can only see a write some verb already makes; this sees the
    // LINES, so a builder added for a slice that is not wired yet cannot ship attended.
    //
    // WHY --yes AT ALL: this runs inside a detached tmux pane with no terminal to answer on,
    // so an acli that stopped to confirm would hang the iteration until its caller killed it.
    const writes = []
    const reads = []
    for (const [name] of BUILDERS) {
      const argv = CALLS[name]()
      expect(argv[0], name).toBe('jira')
      expect(argv[1], name).toBe('workitem')
      const sub = argv[2]
      expect([...WRITE_SUBCOMMANDS, ...READ_SUBCOMMANDS], `${name} names ${sub}`).toContain(sub)
      ;(WRITE_SUBCOMMANDS.includes(sub) ? writes : reads).push([name, argv])
    }
    expect(writes.map(([name]) => name).sort()).toEqual([
      'acliCommentArgv',
      'acliEditLabelsArgv',
      'acliRemoveLabelsArgv',
      'acliTransitionArgv',
    ])
    for (const [name, argv] of writes) {
      expect(argv.at(-1), `${name}: ${argv.join(' ')}`).toBe('--yes')
      expect(argv.filter((el) => el === '--yes'), name).toHaveLength(1)
    }
    // ...and the READS do not carry it. Not symmetry for its own sake: `--yes` on a read
    // would be a flag acli may reject outright, and a rejected count is a queue depth lost.
    for (const [name, argv] of reads) {
      expect(argv, name).not.toContain('--yes')
    }
  })

  it('names the ticket with --key on every per-ticket builder, and never with a bare argument', () => {
    // The three searches take a query; the other five take a KEY, and all five spell it the
    // same way. A builder that passed the key positionally would work against one acli
    // subcommand and address the wrong work item under another.
    //
    // #132's title lookup is a search and is skipped here BY ITS `--jql`, which is the right
    // reason: it names its tickets INSIDE the query rather than with `--key`, because it asks
    // about several at once and `--key` addresses one.
    for (const [name] of BUILDERS) {
      const argv = CALLS[name]()
      if (READ_SUBCOMMANDS.includes(argv[2]) && argv.includes('--jql')) continue
      expect(argv, name).toContain('--key')
      expect(argv[argv.indexOf('--key') + 1], name).toBe('FOO-1')
    }
  })

  it('builds every element as a string, and a fresh array per call', () => {
    // A shared array would let one caller's argv travel to the next invocation — the same
    // hazard jira-jql.qa.test.js pins for the composer's refusal object.
    for (const [name] of BUILDERS) {
      const first = CALLS[name]()
      const second = CALLS[name]()
      expect(first, name).not.toBe(second)
      expect(first, name).toEqual(second)
      expect(
        first.every((el) => typeof el === 'string'),
        `${name}: ${JSON.stringify(first)}`,
      ).toBe(true)
    }
  })

  it('puts a hostile value in ONE element, whatever bytes it carries', () => {
    // Every builder takes remote- or human-chosen text (a key out of acli's JSON, a query out
    // of ralph.config.sh, a comment body an LLM wrote), and NOTHING quotes or escapes it —
    // correctly, because the spawner is called with no shell (asserted in
    // jira-queue.qa.test.js as the whole options object). So the property to hold is that the
    // value stays ONE element: a builder that joined or split would turn a summary containing
    // a space into two flags.
    const hostile = [
      `a${LF}b`,
      `a${TAB}b`,
      `a${CR}b`,
      `${QUOTE}quoted${QUOTE}`,
      `back${BACKSLASH}slash`,
      `--key FOO-9`,
      `; touch pwned`,
      `$(touch pwned)`,
      `a${NUL}b`,
      `a${ESC}[31mb`,
      'x'.repeat(100000),
    ]
    for (const value of hostile) {
      const label = JSON.stringify(value.slice(0, 24))
      // The two-argument builders, where the value is the SECOND argument. Asserted
      // POSITIONALLY — the element after the value's own flag — rather than by counting
      // occurrences, because a value that IS a flag legitimately appears twice (see the next
      // test), and a count-based check would have to special-case it and lose the property.
      for (const [name, flag, argv] of [
        ['acliEditLabelsArgv', '--labels', acliEditLabelsArgv('FOO-1', value)],
        ['acliRemoveLabelsArgv', '--remove-labels', acliRemoveLabelsArgv('FOO-1', value)],
        ['acliTransitionArgv', '--status', acliTransitionArgv('FOO-1', value)],
        ['acliCommentArgv', '--body', acliCommentArgv('FOO-1', value)],
      ]) {
        expect(argv, `${name} ${label}`).toHaveLength(name === 'acliCommentArgv' ? 9 : 8)
        expect(argv[argv.indexOf(flag) + 1], `${name} ${label}`).toBe(value)
        expect(argv.at(-1), `${name} ${label}`).toBe('--yes')
      }
      // ...and the KEY position, on the builder that carries both a key and a value.
      const keyed = acliEditLabelsArgv(value, 'done')
      expect(keyed).toHaveLength(8)
      expect(keyed[keyed.indexOf('--key') + 1], label).toBe(value)
    }
  })

  it('is not fooled by a value that looks like its own flag — the value follows the flag', () => {
    // A comment body of `--yes` produces an argv with TWO `--yes` elements, and the LAST one
    // is the flag. Pinned because a test (or a future reader) counting `--yes` occurrences to
    // prove a write is unattended would read this as a double flag; what makes it safe is the
    // POSITION, which is what the sweeps above assert.
    const argv = acliCommentArgv('FOO-1', '--yes')
    expect(argv).toEqual([
      'jira',
      'workitem',
      'comment',
      'create',
      '--key',
      'FOO-1',
      '--body',
      '--yes',
      '--yes',
    ])
    expect(argv.filter((el) => el === '--yes')).toHaveLength(2)
    expect(argv[argv.indexOf('--body') + 1]).toBe('--yes')
    // The same shape for a label list that looks like the removal flag.
    const edit = acliEditLabelsArgv('FOO-1', '--remove-labels')
    expect(edit[edit.indexOf('--labels') + 1]).toBe('--remove-labels')
    expect(edit).not.toContain('--remove-labels-value')
  })

  it('spells the removal with --remove-labels and NEVER with a second --labels', () => {
    // The #129 decision this module argues for at length: `--remove-labels` means the same
    // thing under either reading of `--labels`, whereas expressing a removal as `--labels
    // <everything except in-progress>` would be a bet on replace semantics that does nothing
    // at all if `--labels` appends. Asserted as mutual exclusion, so neither flag can acquire
    // the other's job.
    const removal = acliRemoveLabelsArgv('FOO-1', 'in-progress')
    expect(removal).toContain('--remove-labels')
    expect(removal).not.toContain('--labels')
    const addition = acliEditLabelsArgv('FOO-1', 'a,in-progress')
    expect(addition).toContain('--labels')
    expect(addition).not.toContain('--remove-labels')
    // Same subcommand, different flag — which is why a test that only looked at `subOf(argv)`
    // could not tell the add from the removal.
    expect(removal[2]).toBe(addition[2])
  })

  it('asks the pick for fields inside acli’s documented allowlist, and no more', () => {
    // The module's own note: `--fields` on `search` accepts only issuetype, key, assignee,
    // priority, status, summary, reporter and labels. Swept rather than string-compared, so a
    // field added here is checked against the list instead of merely changing a fixture.
    const ALLOWED = [
      'issuetype',
      'key',
      'assignee',
      'priority',
      'status',
      'summary',
      'reporter',
      'labels',
    ]
    for (const argv of [acliPickArgv('project = R'), acliViewLabelsArgv('FOO-1')]) {
      const fields = argv[argv.indexOf('--fields') + 1].split(',')
      for (const field of fields) expect(ALLOWED, argv.join(' ')).toContain(field)
    }
    // ...and the pick asks for exactly one item, in JSON. Both are what make its reader's
    // "first work item" the ANSWER rather than a guess at a page.
    const pick = acliPickArgv('project = R')
    expect(pick[pick.indexOf('--limit') + 1]).toBe('1')
    expect(pick).toContain('--json')
  })
})

describe('acliText — the one spawn seam, at its edges (#129 QA)', () => {
  // The verbs each swallow this function's distinctions (a pick answers null, a claim
  // refuses), so the three REASONS it can give are only visible from here — and they are
  // what `ralph status` shows a human, so which one comes back for which failure matters.
  const seam = (impl) => acliText(vi.fn(impl), ['jira', 'workitem', 'view'])

  it('reports the SPAWN failure with the error’s own message', async () => {
    const r = await seam(() => {
      throw new Error('spawn acli ENOENT')
    })
    expect(r).toEqual({ ok: false, text: null, reason: acli.SPAWN_FAILED(new Error('spawn acli ENOENT')) })
    expect(r.reason).toContain('spawn acli ENOENT')
  })

  it('survives an error with no message, and a thrown non-Error', async () => {
    // `err?.message || 'unknown error'` is the guard, and these are the three inputs that
    // reach its right-hand side: a throw of undefined, of a string, and of an object.
    for (const thrown of [undefined, null, 'boom', {}, 42, Symbol('x')]) {
      const r = await seam(() => {
        throw thrown
      })
      expect(r.ok, String(typeof thrown)).toBe(false)
      expect(typeof r.reason, String(typeof thrown)).toBe('string')
      expect(r.reason.length, String(typeof thrown)).toBeGreaterThan(10)
    }
  })

  it('reads an EXIT failure before it reads text, and says so in one sentence', async () => {
    for (const result of [
      { exitCode: 1, stdout: '7' },
      { exitCode: null, stdout: '7' },
      { failed: true, stdout: '7' },
      { signal: 'SIGKILL', stdout: '7' },
      undefined,
      null,
      0,
      '',
      'plain text',
    ]) {
      const r = await seam(() => result)
      expect(r, JSON.stringify(result)).toEqual({
        ok: false,
        text: null,
        reason: acli.EXIT_FAILED,
      })
    }
  })

  it('reports UNREADABLE for a clean exit whose text cannot be taken', async () => {
    // Distinct from EXIT_FAILED on purpose: the process WORKED and the write (if this was a
    // write) probably landed. A caller that conflated the two would report a comment it
    // successfully posted as one it could not.
    const throwingGetter = {
      exitCode: 0,
      get stdout() {
        throw new Error('stream already destroyed')
      },
    }
    expect(await seam(() => throwingGetter)).toEqual({
      ok: false,
      text: null,
      reason: acli.UNREADABLE,
    })
    const throwingToString = {
      exitCode: 0,
      stdout: {
        toString() {
          throw new Error('stdout is gone')
        },
      },
    }
    expect(await seam(() => throwingToString)).toEqual({
      ok: false,
      text: null,
      reason: acli.UNREADABLE,
    })
  })

  it('reads a missing, null and Buffer stdout as text rather than as a failure', async () => {
    // A WRITE prints nothing on success, so "no stdout" has to be ok — otherwise every
    // successful label write would report a failure. `''` is the answer, not null.
    expect(await seam(() => ({ exitCode: 0 }))).toEqual({ ok: true, text: '', reason: null })
    expect(await seam(() => ({ exitCode: 0, stdout: null }))).toEqual({
      ok: true,
      text: '',
      reason: null,
    })
    expect(await seam(() => ({ exitCode: 0, stdout: Buffer.from('7' + LF) }))).toEqual({
      ok: true,
      text: '7' + LF,
      reason: null,
    })
    expect(await seam(() => ({ exitCode: 0, stdout: 7 }))).toEqual({
      ok: true,
      text: '7',
      reason: null,
    })
  })

  it('passes the argv and the options through UNTOUCHED, and calls acli by name once', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '' }))
    const argv = acliTransitionArgv('FOO-1', 'Done')
    await acliText(exec, argv)
    expect(exec.mock.calls).toEqual([['acli', argv, { reject: false }]])
    // The SAME array, not a copy: the builder above is the single source of the spelling, so
    // a seam that rewrote it would be a second place argv could change.
    expect(exec.mock.calls[0][1]).toBe(argv)
  })

  it('never throws for a spawner that is not a function, or a promise that rejects', async () => {
    for (const exec of [undefined, null, 0, 'acli', {}, [], Symbol('exec'), 7n]) {
      const r = await acliText(exec, ['jira'])
      expect(r.ok, String(typeof exec)).toBe(false)
      expect(r.reason, String(typeof exec)).toContain('acli could not be run')
    }
    const rejecting = vi.fn(() => Promise.reject(new Error('EACCES')))
    expect((await acliText(rejecting, ['jira'])).ok).toBe(false)
  })
})

describe('jira-acli readers — the boundaries two verbs hide (#129 QA)', () => {
  it('tells NO LIST apart from an EMPTY list — the safety property, as a value', () => {
    // The distinction the whole read-then-union rule turns on, asserted where it is a return
    // value rather than a refusal three layers up. `null` means "Ralph does not know this
    // ticket's labels", and a write built on that guess is the wipe the read exists to
    // prevent; `[]` is a ticket with no labels, which is most of a fresh queue.
    expect(findLabelArray(parseJsonOrUndefined('{"fields":{"labels":[]}}'))).toEqual([])
    expect(findLabelArray(parseJsonOrUndefined('{"fields":{}}'))).toBe(null)
    expect(findLabelArray(parseJsonOrUndefined('{"fields":{"labels":null}}'))).toBe(null)
    expect(findLabelArray(parseJsonOrUndefined('prose'))).toBe(null)
    expect(findLabelArray(parseJsonOrUndefined(''))).toBe(null)
    // ...and the EMPTIED case is NOT this function's to judge: it finds the array, and the
    // decision that an array nothing can be sent out of is unreadable belongs to
    // `readWritableLabels` in jira-queue.js (asserted there).
    expect(findLabelArray(parseJsonOrUndefined('{"labels":[{"name":"a"}]}'))).toEqual([
      { name: 'a' },
    ])
  })

  it('finds the label list at every depth up to four, and refuses the fifth', () => {
    // The bound, from both sides, so the refusal reads as a measurement rather than a typo.
    // The read asks for ONE field, so an envelope this deep is a client nobody has met.
    expect(findLabelArray({ labels: ['a'] })).toEqual(['a'])
    expect(findLabelArray({ a: { b: { c: { d: { labels: ['x'] } } } } })).toEqual(['x'])
    expect(findLabelArray({ a: { b: { c: { d: { e: { labels: ['x'] } } } } } })).toBe(null)
    // An array counts as a level, which is why a one-item page is one wrapper shallower.
    expect(findLabelArray([{ fields: { labels: ['x'] } }])).toEqual(['x'])
  })

  it('prefers a labels array ON a node to one buried inside it', () => {
    // Not a preference for its own sake: the answer has to be DETERMINISTIC for a document
    // that has two, and the shallower one is the work item's own field.
    expect(findLabelArray({ labels: ['mine'], fields: { labels: ['theirs'] } })).toEqual(['mine'])
    // ...and a non-array `labels` does not stop the search finding the real one deeper down.
    expect(findLabelArray({ labels: 'frontend', fields: { labels: ['real'] } })).toEqual(['real'])
  })

  it('drops per ENTRY and reports what can be sent — it does not judge an empty answer', () => {
    // The contract the module states: "This function reports what can be sent; it does not
    // judge what it means that nothing can." So a fully-dropped list comes back as `[]`, the
    // SAME value a genuinely empty list gives — which is exactly why the caller has to keep
    // the original array to tell them apart, and why #127's wipe was possible.
    expect(writableLabels(['frontend', null, 42, {}, [], 'p2'])).toEqual(['frontend', 'p2'])
    expect(writableLabels([{ name: 'frontend' }])).toEqual([])
    expect(writableLabels([])).toEqual([])
    expect(writableLabels([''])).toEqual([])
    expect(writableLabels(['   '])).toEqual([])
    expect(writableLabels([TAB + LF])).toEqual([])
    // Trimmed, de-duplicated, order preserved — and de-duplicated AFTER trimming, so a stray
    // space cannot make one label read as two.
    expect(writableLabels(['  a  ', 'a', 'b', 'a'])).toEqual(['a', 'b'])
    expect(writableLabels(['z', 'm', 'a'])).toEqual(['z', 'm', 'a'])
    // A comma survives, and the module says why: a label Ralph merely found suspicious is not
    // a label to delete. It arrives at Jira as two labels, which is the pinned caveat.
    expect(writableLabels(['a,b'])).toEqual(['a,b'])
  })

  it('THROWS for a non-iterable label list — a precondition, not a guard (pinned)', () => {
    // The one input in this module that escapes as an exception. Unreachable today: the only
    // caller passes the array `findLabelArray` returned, and that is an array or null. Pinned
    // as the shape of the gap, because "nothing in the jira modules throws" is a promise made
    // at the VERB level (jira-queue.js) and this file is below it.
    expect(() => writableLabels(7)).toThrow(TypeError)
    expect(() => writableLabels(null)).toThrow(TypeError)
    expect(() => writableLabels(undefined)).toThrow(TypeError)
    // ...and a STRING does not throw, it iterates by code point — which would send `a,b,c`
    // for a `labels: "abc"` a caller forgot to check. Also unreachable, and also pinned.
    expect(writableLabels('abc')).toEqual(['a', 'b', 'c'])
  })

  it('refuses every count that is not a digit string, and the exact safe-integer boundary', () => {
    for (const [text, expected] of [
      ['7', 7],
      ['0', 0],
      [' 12 ', 12],
      ['7' + CR + LF, 7],
      ['9007199254740991', Number.MAX_SAFE_INTEGER],
      ['9007199254740992', null],
      ['', null],
      ['   ', null],
      ['-3', null],
      ['+7', null],
      ['7.0', null],
      ['1e3', null],
      ['0x10', null],
      ['7' + LF + '8', null],
      ['seven', null],
      ['{"count":7}', null],
      ['007', 7],
    ]) {
      expect(parseCount(text), JSON.stringify(text)).toBe(expected)
    }
  })

  it('reads an envelope’s first work item, and answers undefined rather than throwing', () => {
    expect(firstWorkItem([{ key: 'A-1' }])).toEqual({ key: 'A-1' })
    expect(firstWorkItem({ issues: [{ key: 'A-1' }] })).toEqual({ key: 'A-1' })
    expect(firstWorkItem({ key: 'A-1' })).toEqual({ key: 'A-1' })
    expect(firstWorkItem([])).toBeUndefined()
    expect(firstWorkItem(undefined)).toBeUndefined()
    expect(firstWorkItem(null)).toBeUndefined()
    expect(firstWorkItem('A-1')).toBeUndefined()
    expect(firstWorkItem(7)).toBeUndefined()
    // The wrapper keys are tried in order, and `issues` wins a document carrying two.
    expect(firstWorkItem({ results: [{ key: 'B-9' }], issues: [{ key: 'A-1' }] })).toEqual({
      key: 'A-1',
    })
  })

  it('answers the empty string for every summary that is not text — never "undefined"', () => {
    // This value is printed into a `<key>TAB<summary>` line bash reads, where a template hole
    // would read as a real ticket title.
    for (const item of [
      undefined,
      null,
      {},
      { summary: null },
      { summary: 42 },
      { summary: {} },
      { fields: {} },
      { fields: { summary: [] } },
    ]) {
      expect(summaryOf(item), JSON.stringify(item)).toBe('')
    }
    expect(summaryOf({ fields: { summary: 'nested' }, summary: 'flat' })).toBe('nested')
    expect(summaryOf({ fields: { summary: null }, summary: 'flat' })).toBe('flat')
  })

  it('parses no prototype off the wire', () => {
    // `JSON.parse` makes `__proto__` an own data property rather than invoking the setter, so
    // the payload is inert — measured rather than read out of the spec, because these readers
    // walk whatever came off a pipe.
    const before = Object.getOwnPropertyNames(Object.prototype).length
    const parsed = parseJsonOrUndefined('{"__proto__":{"polluted":true},"labels":["a"]}')
    expect(findLabelArray(parsed)).toEqual(['a'])
    expect({}.polluted).toBeUndefined()
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before)
  })
})

describe('jira-acli — pure, edgeless, and safe for a diagnostic to import (#129 QA)', () => {
  const source = new URL('./jira-acli.js', import.meta.url)
  const raw = readFileSync(source, 'utf8')
  const code = codeWithoutComments(source)

  it('imports nothing at all, and names no spawner in its code', () => {
    // jira-queue.qa.test.js already asserts this file has no import lines. What it does not
    // assert is the CLAIM jira-queue.js's header makes about it: "A diagnostic that wants Jira
    // knowledge should import ./jira-jql.js or ./jira-acli.js, both of which are pure and have
    // no edges". That claim is only true if this file also passes the checks
    // doctor.version-line.qa.test.js runs over every file on doctor's graph — which are
    // TOKEN greps over comment-stripped source, not just import lists.
    expect([...code.matchAll(/^import .* from '(.*)'$/gm)]).toEqual([])
    expect(code).not.toMatch(/require\(/)
  })

  it('passes the same token sweep doctor’s import-graph guard runs on its own files', () => {
    // The banned list is copied from lib/commands/doctor.version-line.qa.test.js's "no source
    // file in the graph calls fetch, execa, or spawns a process". Copied deliberately: if the
    // header's advice is ever taken and a diagnostic imports this file, THAT guard is what
    // would fail, and it would fail in a file whose author never read it. The word `execa`
    // appears in this module's PROSE (explaining an ENOENT result shape), which is exactly
    // why both guards strip comments first — so the claim is about what the code reaches.
    for (const [re, label] of [
      [/\bfetch\s*\(/, 'fetch('],
      [/\bexeca\b/, 'execa'],
      [/child_process/, 'child_process'],
      [/\bspawn(Sync)?\s*\(/, 'spawn('],
      [/\bexecSync\s*\(/, 'execSync('],
      [/\bprocess\./, 'process.'],
    ]) {
      expect(re.test(code), `jira-acli.js must not reference ${label}`).toBe(false)
    }
    // ANTI-VACUITY, and the reason this test is worth having: the token `execa` IS present in
    // the raw file, in prose, so the sweep above would go red without the strip. That makes
    // the strip load-bearing here rather than incidental — and it is the same strip doctor's
    // guard performs, which is what makes the pass above transferable.
    expect(/\bexeca\b/.test(raw)).toBe(true)
    expect(/\bexeca\b/.test(code)).toBe(false)
  })

  it('reaches no clock, no environment and no randomness — every answer is its argument', () => {
    for (const forbidden of [/\bDate\b/, /Math\.random/, /process\.env/, /node:fs/]) {
      expect(forbidden.test(code), String(forbidden)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// QA augmentation for #132 — `allWorkItems`, AND THE PARITY CLAIM IT IS BUILT ON.
//
// `allWorkItems` is the list-shaped sibling `titlesFor` reads its answer through, and it has
// NO test of its own anywhere: the dev's coverage is `lib/jira-queue.test.js` exercising it
// THROUGH `titlesFor`, which only ever sees envelopes a search produces. Two things follow.
//
// FIRST, ITS PARITY WITH `firstWorkItem` IS WORTH ASSERTING WHICHEVER WAY THAT PARITY IS
// ACHIEVED. MEASURED BEFORE THE FIX: `firstWorkItem` had a duplicate body walking the envelope
// a second time, and its comment claimed the two recognised "exactly the same five shapes, in
// the same order, so a wrapper acli starts using is one edit in one place for both" — which was
// false, because the wrapper list was spelled twice. Review rejected the copy, so the wrapper
// names are now the single `WORK_ITEM_WRAPPERS` constant and `firstWorkItem` is
// `allWorkItems(parsed)[0]`: parity holds by construction rather than by two functions being
// kept in step. This sweep is what keeps it that way if anyone ever re-expands the body. It
// asserts the relationship rather than two copies of a shape list: for EVERY envelope,
// `allWorkItems(x)[0]` is `firstWorkItem(x)`. Measured over all twenty shapes below.
//
// SECOND, ITS RETURN TYPE IS A PROMISE TO ITS CALLER. `titlesFor` writes
// `for (const item of allWorkItems(...))`, with no guard, on the render path of
// `ralph status` — so "always an array" is not a nicety, it is the reason a board that
// answered with prose does not throw inside a status view. Asserted on every shape,
// including the ones acli produces when it has nothing to say.
// ---------------------------------------------------------------------------

describe('allWorkItems — the sibling of firstWorkItem, and its parity (#132 QA)', () => {
  // Every shape either function claims to know, plus the ones neither should: the three
  // wrappers, their precedence, the bare-object fallback, and the things acli prints when it
  // is not printing JSON. `JSON.parse` builds the `__proto__` entry so it is an OWN property
  // rather than a prototype — the shape a real parse of hostile output produces.
  const shapes = {
    'a bare list': [{ key: 'A-1' }, { key: 'A-2' }],
    'an empty list': [],
    'an issues envelope': { issues: [{ key: 'A-1' }, { key: 'A-2' }] },
    'a workItems envelope': { workItems: [{ key: 'A-1' }] },
    'a results envelope': { results: [{ key: 'A-1' }] },
    'issues beating results': { results: [{ key: 'B-9' }], issues: [{ key: 'A-1' }] },
    'workItems beating results': { results: [{ key: 'B-9' }], workItems: [{ key: 'A-1' }] },
    'an empty issues envelope': { issues: [] },
    'a bare work item': { key: 'A-1' },
    'a wrapper field that is not a list': { issues: { key: 'A-1' } },
    'null': null,
    'undefined': undefined,
    'a key on its own': 'A-1',
    'a number': 7,
    'a boolean': true,
    'the prose acli prints for no match': 'No work items found',
    'an object whose own __proto__ hides an envelope': JSON.parse(
      '{"__proto__": {"issues": [{"key": "X-1"}]}}',
    ),
    'a nested list': [[{ key: 'A-1' }]],
    'a list of things that are not work items': ['A-1', 7, null],
    'a list with a hole in it': [undefined, { key: 'A-2' }],
  }

  it('agrees with firstWorkItem on its first element, for every shape either knows', () => {
    // THE PARITY CLAIM, asserted as a relationship rather than as two copies of a shape list.
    // It holds by construction today — `firstWorkItem` IS `allWorkItems(parsed)[0]` — so this
    // sweep is a guard against that collapsing back into two envelope walks, not a check on two
    // siblings drifting. Twenty shapes, all agreeing.
    for (const [what, parsed] of Object.entries(shapes)) {
      expect(allWorkItems(parsed)[0], what).toEqual(firstWorkItem(parsed))
    }
  })

  it('always hands back an array, so its caller can iterate without a guard', () => {
    // `titlesFor` iterates the result directly on `ralph status`'s render path. Every shape,
    // including a board that answered with an explanation instead of JSON.
    for (const [what, parsed] of Object.entries(shapes)) {
      expect(Array.isArray(allWorkItems(parsed)), what).toBe(true)
    }
  })

  it('reads exactly the same wrappers in the same order as firstWorkItem', () => {
    // The order is `issues`, `workItems`, `results`, and precedence is only observable when two
    // are present at once — which is the case a wrapper rename would produce mid-migration.
    expect(allWorkItems({ issues: [{ key: 'A-1' }], workItems: [{ key: 'B-1' }], results: [{ key: 'C-1' }] })).toEqual([
      { key: 'A-1' },
    ])
    expect(allWorkItems({ workItems: [{ key: 'B-1' }], results: [{ key: 'C-1' }] })).toEqual([
      { key: 'B-1' },
    ])
    expect(allWorkItems({ results: [{ key: 'C-1' }] })).toEqual([{ key: 'C-1' }])
    // A wrapper NAME neither knows leaves a bare object, which is a list of one — the
    // documented fallback, and the reason an unknown envelope yields one unusable item rather
    // than a throw. `normalizeJiraKey(undefined)` drops it downstream.
    expect(allWorkItems({ tickets: [{ key: 'D-1' }] })).toEqual([{ tickets: [{ key: 'D-1' }] }])
  })

  it('keeps EVERY item, which is the whole difference from firstWorkItem', () => {
    // The reason the sibling exists at all: one acli call answers N keys, so a reader that
    // stopped at the first would make `titlesFor`'s single-call design pointless.
    const many = Array.from({ length: 32 }, (_, i) => ({ key: `FOO-${i + 1}` }))
    expect(allWorkItems(many)).toHaveLength(32)
    expect(allWorkItems({ issues: many })).toHaveLength(32)
    expect(allWorkItems({ workItems: many })).toHaveLength(32)
  })

  it('hands back the parse ITSELF rather than a copy, and mutates nothing', () => {
    // Measured, and worth recording because both callers only iterate: the array branch and the
    // wrapper branch return the parsed array by reference. That is fine for a reader and would
    // not be for a caller that sorted it in place, so the aliasing is stated rather than
    // discovered. What matters for safety is the second half — the input comes back unchanged.
    const items = [{ key: 'A-1' }]
    const envelope = { issues: items }
    expect(allWorkItems(items)).toBe(items)
    expect(allWorkItems(envelope)).toBe(items)
    expect(envelope).toEqual({ issues: [{ key: 'A-1' }] })
  })
})
