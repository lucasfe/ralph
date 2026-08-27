import { describe, it, expect } from 'vitest'
import { buildDigestView, parseLatestDigest, renderDigestSection } from './digest-history.js'
import { formatHistoryEntry } from './digest.js'

// #63 — the digest, read back. Three pure functions and one property that matters
// more than any of them: the READER is tested against bytes the WRITER produced.
// Every fixture below that stands for a real history file is built with
// formatHistoryEntry rather than hand-typed, so the day the entry format changes
// this suite fails here instead of quietly reading `null` in the field.
//
// Hermetic: no clock, no filesystem, no config file. `now` and the interval are
// parameters, because a view that reads the wall clock cannot be pinned.

const RUN = 'ralph-ralph-b36ff7b1'
const OTHER_RUN = 'ralph-ralph-0000dead'
const AT = '2026-08-26T04:40:12Z'
const AT_MS = Date.parse(AT)
const MIN = 60000
const NOW = AT_MS + 12 * MIN // the mock in the issue: `12min ago`

const NARRATIVE = [
  '#031 is in the TDD red phase, editing SettingsRowDescriptor.swift.',
  '',
  'Suite went 1454 → 1598 passing. Heaviest task in the queue.',
].join('\n')

// One history file, written the only way one is ever written.
const entry = (overrides = {}) =>
  formatHistoryEntry({
    at: AT,
    runId: RUN,
    task: '#031',
    model: 'claude-haiku-4-5',
    narrative: NARRATIVE,
    ...overrides,
  })

const record = (overrides = {}) => ({ run_id: RUN, ...overrides })

const view = (overrides = {}) =>
  buildDigestView({ historyText: entry(), record: record(), now: NOW, ...overrides })

describe('parseLatestDigest — the last entry a digest wrote (#63)', () => {
  it('reads back exactly what formatHistoryEntry wrote', () => {
    expect(parseLatestDigest(entry())).toEqual({
      at: AT,
      atMs: AT_MS,
      runId: RUN,
      task: '#031',
      model: 'claude-haiku-4-5',
      narrative: NARRATIVE,
    })
  })

  it('takes the LAST entry of a night, not the first', () => {
    const night =
      entry({ at: '2026-08-26T01:00:00Z', task: '#028', narrative: 'first' }) +
      entry({ at: '2026-08-26T02:00:00Z', task: '#029', narrative: 'second' }) +
      entry()
    const latest = parseLatestDigest(night)
    expect(latest.at).toBe(AT)
    expect(latest.task).toBe('#031')
    expect(latest.narrative).toBe(NARRATIVE)
  })

  it('reads a pre-#63 three-field heading with no model, rather than nothing', () => {
    // A history file written by an earlier Ralph is still this run's history: the
    // model is what is missing, not the digest.
    const legacy = `\n── ${AT} · run ${RUN} · #031 ${'─'.repeat(20)}\n  older ralph\n\n`
    expect(parseLatestDigest(legacy)).toEqual({
      at: AT,
      atMs: AT_MS,
      runId: RUN,
      task: '#031',
      model: null,
      narrative: 'older ralph',
    })
  })

  it('answers null for nothing at all — absent, empty, whitespace', () => {
    for (const text of [undefined, null, '', '   \n\n  \n']) {
      expect(parseLatestDigest(text), String(text)).toBe(null)
    }
  })

  it('answers null for a file with no heading in it at all', () => {
    expect(parseLatestDigest('some notes a human left here\nand another line\n')).toBe(null)
  })

  it('answers null for a heading whose timestamp cannot be read', () => {
    expect(parseLatestDigest(entry({ at: 'yesterday' }))).toBe(null)
    expect(parseLatestDigest(entry({ at: '' }))).toBe(null)
  })

  it('falls back to the previous entry when the last one was torn mid-append', () => {
    // A digest crashing between the heading and the body must not hide the digest
    // before it: that one is real, and its age is what keeps the reading honest.
    const torn = entry() + `\n── 2026-08-26T05:10:00Z · run ${RUN} · #031 · m ${'─'.repeat(20)}\n`
    const latest = parseLatestDigest(torn)
    expect(latest.at).toBe(AT)
    expect(latest.narrative).toBe(NARRATIVE)
  })

  it('keeps the narrative’s own blank lines and strips the entry indent', () => {
    const latest = parseLatestDigest(entry())
    expect(latest.narrative).toBe(NARRATIVE)
    expect(latest.narrative.split('\n')).toHaveLength(3)
    expect(latest.narrative.startsWith('#031')).toBe(true)
  })

  it('cannot be made to read a forged heading out of the narrative', () => {
    // The writer indents every body line for exactly this reason; the reader has to
    // honour it, or model output could attribute prose to another run.
    const forged = entry({
      narrative: `── 1999-01-01T00:00:00Z · run ${OTHER_RUN} · #999 · evil ${'─'.repeat(20)}\ninvented`,
    })
    const latest = parseLatestDigest(forged)
    expect(latest.runId).toBe(RUN)
    expect(latest.narrative).toContain('invented')
  })

  it('reads the writer’s words for absence as absence, not as data', () => {
    // formatHistoryEntry spells a missing run `unknown` and a missing task `none`.
    // Reading those back as values would let a run with no id match an entry with
    // no id — see buildDigestView's scoping rule.
    const nameless = formatHistoryEntry({ at: AT, narrative: 'x' })
    expect(parseLatestDigest(nameless)).toEqual({
      at: AT,
      atMs: AT_MS,
      runId: null,
      task: null,
      model: null,
      narrative: 'x',
    })
  })
})

describe('buildDigestView — this run’s digest, and how old it is (#63)', () => {
  it('carries the age, the model, the task and the raw narrative', () => {
    expect(view()).toEqual({
      atMs: AT_MS,
      ageMs: 12 * MIN,
      model: 'claude-haiku-4-5',
      task: '#031',
      stale: false,
      narrative: NARRATIVE,
    })
  })

  it('marks a digest older than two intervals stale, and not one a minute younger', () => {
    const at = (minutesAgo) => entry({ at: new Date(NOW - minutesAgo * MIN).toISOString() })
    const staleness = (minutesAgo, interval) =>
      buildDigestView({ historyText: at(minutesAgo), record: record(), now: NOW, interval }).stale
    // 15m configured → two intervals is 30m. The boundary itself is NOT stale: a
    // digest that landed exactly on time is on time.
    expect(staleness(29, '15m')).toBe(false)
    expect(staleness(30, '15m')).toBe(false)
    expect(staleness(31, '15m')).toBe(true)
  })

  it('judges staleness against a documented default when nothing is configured', () => {
    // No RALPH_DIGEST_INTERVAL (or one turned off, or one the grammar refuses): the
    // template's own suggestion of 30m is the assumption, so 60m is the ceiling.
    const at = (minutesAgo) => entry({ at: new Date(NOW - minutesAgo * MIN).toISOString() })
    for (const interval of ['', '   ', undefined, null, '0m', 'half an hour']) {
      const label = String(interval)
      expect(
        buildDigestView({ historyText: at(59), record: record(), now: NOW, interval }).stale,
        label,
      ).toBe(false)
      expect(
        buildDigestView({ historyText: at(61), record: record(), now: NOW, interval }).stale,
        label,
      ).toBe(true)
    }
  })

  it('shows nothing for the PREVIOUS run’s digest', () => {
    expect(view({ historyText: entry({ runId: OTHER_RUN }) })).toBe(null)
  })

  it('scopes on the run id the way every other per-run number is scoped', () => {
    // An absent id matches nothing rather than everything, on either side.
    expect(view({ historyText: entry({ runId: null }) })).toBe(null)
    expect(view({ record: {} })).toBe(null)
    expect(view({ record: null })).toBe(null)
    expect(view({ record: record({ run_id: '' }) })).toBe(null)
  })

  it('shows nothing when there is no entry to show', () => {
    expect(view({ historyText: '' })).toBe(null)
    expect(view({ historyText: 'junk with no heading' })).toBe(null)
    expect(buildDigestView()).toBe(null)
  })

  it('clamps a digest from the future to an age of zero rather than a negative one', () => {
    const ahead = view({ historyText: entry({ at: new Date(NOW + 5 * MIN).toISOString() }) })
    expect(ahead.ageMs).toBe(0)
    expect(ahead.stale).toBe(false)
  })

  it('reports an unreadable clock as an unknown age instead of hiding the digest', () => {
    const noClock = view({ now: Number.NaN })
    expect(noClock.ageMs).toBe(null)
    expect(noClock.stale).toBe(false)
    expect(noClock.narrative).toBe(NARRATIVE)
  })
})

describe('renderDigestSection — a compact block inside the live view (#63)', () => {
  const WIDTH = 64
  const MAX_BODY_LINES = 8
  const TRUNCATED = '  … full narration in .ralph/digest.log'

  it('renders nothing at all when there is no digest', () => {
    expect(renderDigestSection(null)).toEqual([])
    expect(renderDigestSection(undefined)).toEqual([])
  })

  it('opens with its own blank line, so the caller can spread it unconditionally', () => {
    const lines = renderDigestSection(view())
    expect(lines[0]).toBe('')
    expect(lines[1]).toMatch(/^ {2}── digest \(12min ago · claude-haiku-4-5\) ─+$/)
    expect(lines[1]).toHaveLength(WIDTH)
  })

  it('indents the narrative under the heading and wraps it inside the width', () => {
    const lines = renderDigestSection(view()).slice(2)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(line.startsWith('  '), line).toBe(true)
      expect(line.length, line).toBeLessThanOrEqual(WIDTH)
      expect(line.trim(), 'a blank line would end the block early').not.toBe('')
    }
    // Wrapped at WORD boundaries: no word is cut in half.
    expect(lines.join('\n')).toContain('SettingsRowDescriptor.swift.')
    expect(lines[0]).toBe('  #031 is in the TDD red phase, editing')
  })

  it('drops the model clause entirely when the entry never named one', () => {
    const lines = renderDigestSection({ ...view(), model: null })
    expect(lines[1]).toMatch(/^ {2}── digest \(12min ago\) ─+$/)
    expect(lines[1]).not.toContain('unknown')
  })

  it('says so when the digest is stale, rather than presenting it as current', () => {
    const lines = renderDigestSection({ ...view(), ageMs: 80 * MIN, stale: true })
    expect(lines[1]).toMatch(/^ {2}── digest \(1h20m ago · claude-haiku-4-5 · stale\) ─+$/)
  })

  it('says the age is unknown rather than printing a number it does not have', () => {
    const lines = renderDigestSection({ ...view(), ageMs: null })
    expect(lines[1]).toContain('unknown ago')
  })

  // A word too long for a line of its own is BROKEN, not left to overflow. The cap
  // below exists to bound the block in terminal ROWS, and one 5000-character base64
  // blob — which is what a TDD log tail is full of — would otherwise occupy eighty of
  // them inside a three-element array. Such a word cannot fit on any line, so the only
  // choice is between breaking it and losing the view; ordinary prose never reaches
  // this path, so no word a reader would want to copy whole is cut.
  it('breaks a word longer than the width, so the bound is in ROWS and not in elements', () => {
    const word = 'a'.repeat(120)
    const lines = renderDigestSection({ ...view(), narrative: `see ${word} for why` })
    for (const line of lines.slice(2)) expect(line.length, line).toBeLessThanOrEqual(WIDTH)
    // Broken, not dropped: every character survives, in order.
    expect(
      lines
        .slice(2)
        .map((l) => l.trim())
        .join(''),
    ).toContain(word)
    // ...and the words around it still wrap normally.
    expect(lines.some((l) => l.trim() === 'see')).toBe(true)
  })

  it('bounds the block in terminal rows even for one enormous unbreakable token', () => {
    const lines = renderDigestSection({ ...view(), narrative: 'x'.repeat(5000) })
    expect(lines.length).toBeLessThanOrEqual(MAX_BODY_LINES + 3)
    expect(lines.join('\n').length).toBeLessThanOrEqual((MAX_BODY_LINES + 2) * WIDTH)
    expect(lines[lines.length - 1]).toBe(TRUNCATED)
  })

  // The section is the FIRST place `ralph status` prints model prose. Everything else
  // in the view is a number, an id or one of Ralph's own words, so nothing before #63
  // needed a sanitizer — and a narrative opening with ESC[2J ESC[H would erase the
  // reader's screen, attach pair included.
  it('strips control bytes out of every field it prints, not just the narrative', () => {
    const ESC = String.fromCharCode(27)
    const NUL = String.fromCharCode(0)
    const BEL = String.fromCharCode(7)
    const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]')
    for (const narrative of [`${ESC}[2J${ESC}[Hgone`, `${ESC}]0;pwned${BEL}`, `a${NUL}b`]) {
      const lines = renderDigestSection({ ...view(), narrative })
      expect(lines.join('\n'), JSON.stringify(narrative)).not.toMatch(CONTROL)
      // Scrubbed, not swallowed: the readable part of the prose still prints.
      expect(lines.length, JSON.stringify(narrative)).toBeGreaterThan(2)
    }
    // The model comes off the same file and lands in the heading we draw.
    const lines = renderDigestSection({ ...view(), model: `haiku${ESC}[31m` })
    expect(lines[1]).not.toMatch(CONTROL)
    expect(lines[1]).toContain('haiku')
  })

  it('elides a model id too long for the heading rather than overrunning the width', () => {
    for (const model of ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'm'.repeat(160)]) {
      for (const stale of [false, true]) {
        const lines = renderDigestSection({ ...view(), model, stale })
        expect(lines[1].length, `${model.length} chars, stale=${stale}`).toBe(WIDTH)
        // Elided, not dropped: the reader still learns which family answered.
        expect(lines[1]).toContain('…')
        expect(lines[1]).toContain(model.slice(0, 12))
      }
    }
  })

  it('bounds a runaway narrative so the view below it stays reachable', () => {
    const flood = Array.from({ length: 40 }, (_, i) => `line ${i} of a model that would not stop`)
    const lines = renderDigestSection({ ...view(), narrative: flood.join('\n') })
    expect(lines.length).toBeLessThan(flood.length)
    // ...and the last row says WHERE the rest is, not merely that there is more: this
    // view has the habit of pointing at files (`logs  tail -f …`), and the whole
    // narration is on disk, unwrapped.
    expect(lines[lines.length - 1]).toBe(TRUNCATED)
    expect(lines[lines.length - 1]).toContain('.ralph/digest.log')
  })

  it('never leaks a stray blank line out of a narrative’s own paragraphs', () => {
    const lines = renderDigestSection({ ...view(), narrative: 'one\n\n\ntwo' })
    expect(lines.slice(2)).toEqual(['  one', '  two'])
  })
})
