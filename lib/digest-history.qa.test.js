import { describe, it, expect } from 'vitest'
import { buildDigestView, parseLatestDigest, renderDigestSection } from './digest-history.js'
import { digestInterval } from './digest-file.js'
import { formatHistoryEntry } from './digest.js'
import { calendarInstantOrNull, formatElapsed } from './progress.js'

// QA augmentation for #63 — the digest, read back. The dev's lib/digest-history.test.js
// pins the contract on entries a digest actually wrote: the round trip, the last entry of
// a night, a torn tail, the run scoping, the staleness boundary at two intervals, and the
// rendered block's shape. What is attacked HERE is the one fact that makes all of that
// interesting and none of the dev's fixtures treat as hostile: `.ralph/digest.log` IS
// MODEL OUTPUT. Its narrative is prose an agent wrote, appended to a file a human can
// edit, read back by a command whose promise is that it cannot fail.
//
//   1. THE ROUND TRIP AS A PROPERTY, NOT AS A CASE. Every hostile shape below is fed
//      through `formatHistoryEntry` — the real writer — and the assertion is uniform:
//      whatever the prose contains, the reader recovers the fields the WRITER named and
//      the narrative the writer was handed, and never a field the prose invented. That
//      covers the forgery family (a `── ` heading in the prose, a whole second entry as
//      the narrative, ` · ` separators, CR/CRLF, NUL, ANSI, an RTL override) with one
//      expectation instead of one per attack, so a regression cannot hide in the gap
//      between two hand-written cases.
//   2. TRUNCATION AND INTERLEAVING. A history file is appended to by a process that can
//      die mid-write and by two digests at once: a torn heading, a heading with no body,
//      a body with no heading, no trailing newline, a whole-file CRLF rewrite. All of it
//      must answer `null` or the previous good entry — never a heading with nothing under
//      it, which is the one shape the renderer would print as a lie.
//   3. CLOCK EDGES AGAINST THE PUBLISHED INSTANT. The stamp in the heading is
//      TRANSCRIBED, not derived, so it is checked against the same `calendarInstantOrNull`
//      bounds lib/progress.js publishes through: an entry stamped `+275760-09-13` must not
//      be able to put an expanded-year form in the document.
//   4. THE STALENESS ARITHMETIC, END TO END FROM ralph.config.sh. `digestInterval` moved
//      out of lib/commands/start.js in this change — it lives in lib/digest-file.js, the
//      pure module the writer, the reader and both commands share, and that is where this
//      file imports it from, the same place production does — so the seam that matters is
//      config TEXT → threshold, not string → threshold: a trailing comment, a commented-out
//      line, every spelling of off, and a value the grammar refuses all have to land on the
//      documented default rather than on a number nobody chose.
//   5. THE BLOCK CANNOT BREAK THE VIEW (AC#6). Three of the assertions in this section
//      were written against a first implementation that failed them, and all three
//      defects were fixed in response: a control byte reached the terminal verbatim, a
//      single long word defeated the eight-line bound in the dimension the bound exists
//      for (terminal rows), and the section heading overran its own 64 columns for a
//      model id `RALPH_DIGEST_MODEL` invites. What each now guards is on the test.
//
// Hermetic like the dev's file: no clock, no filesystem, no config path — `now` and the
// interval are parameters. Control characters are built with `String.fromCharCode` rather
// than embedded, so the file stays greppable and diffable.

const RUN = 'ralph-ralph-b36ff7b1'
const OTHER_RUN = 'ralph-ralph-0000dead'
const AT = '2026-08-26T04:40:12Z'
const AT_MS = Date.parse(AT)
const TASK = '#031'
const MODEL = 'claude-haiku-4-5'
const MIN = 60000
const NOW = AT_MS + 12 * MIN

const WIDTH = 64
const MAX_BODY_LINES = 8

const ESC = String.fromCharCode(27)
const NUL = String.fromCharCode(0)
const BEL = String.fromCharCode(7)
const RTL = String.fromCharCode(0x202e) // RIGHT-TO-LEFT OVERRIDE
const LSEP = String.fromCharCode(0x2028)
const DASH = String.fromCharCode(0x2500) // the box-drawing dash both headings are made of
const SEP = ` ${String.fromCharCode(0xb7)} ` // the field separator, ' · '
const PAD = DASH.repeat(20)

// Everything a terminal acts on rather than shows. \t, \n and \r are excluded on purpose:
// the wrapper collapses them as whitespace, which is a real defence, and \r in particular
// is the overwrite attack this leaves neutralised.
const CONTROL_CHARS = new RegExp(`[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]`)

// One history file, written the only way one is ever written.
const entry = (overrides = {}) =>
  formatHistoryEntry({ at: AT, runId: RUN, task: TASK, model: MODEL, narrative: 'hello world', ...overrides })

const viewOf = (overrides = {}) =>
  buildDigestView({ historyText: entry(), record: { run_id: RUN }, now: NOW, ...overrides })

// A heading typed by hand, for the shapes the writer cannot produce (a legacy entry, a
// truncated tail). `fields` is joined with the real separator and padded like the real
// writer pads.
const heading = (...fields) => `${DASH}${DASH} ${fields.join(SEP)} ${PAD}`

describe('parseLatestDigest — hostile prose cannot become a field (#63 QA)', () => {
  // The narrative is the only part of an entry a model chooses. Each of these is prose
  // that LOOKS like history-file structure; the writer's indent is the only thing standing
  // between it and a forged field, so the property is asserted on the writer's own bytes.
  const forgeries = {
    'a heading line as the first line of the prose': `${heading('1999-01-01T00:00:00Z', `run ${OTHER_RUN}`, '#999', 'evil')}\ninvented`,
    'a whole second entry as the narrative': formatHistoryEntry({
      at: '1999-01-01T00:00:00Z',
      runId: OTHER_RUN,
      task: '#999',
      model: 'evil',
      narrative: 'invented',
    }),
    'the heading opener mid-sentence': `I rewrote the ${DASH}${DASH} banner in status.js`,
    'field separators throughout': `a${SEP}b${SEP}c${SEP}d`,
    'a CR before a forged heading (overwrite attack)': `real prose\r${heading(AT, `run ${OTHER_RUN}`, '#999', 'evil')}`,
    'CRLF line endings inside the prose': 'first line\r\nsecond line',
    'a lone NUL': `before${NUL}after`,
    'an ANSI clear-screen sequence': `${ESC}[2J${ESC}[Hgone`,
    'an RTL override': `plain ${RTL}sdrawkcab`,
    'a unicode line separator': `a${LSEP}b`,
    'a 5000-character word': 'x'.repeat(5000),
    'two hundred lines': Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),
    'blank lines around the prose': '\n\nthe real news\n\n',
    'lines that are themselves indented': '  two spaces\n    four spaces',
    'JSON that looks like a run state': JSON.stringify({ run_id: OTHER_RUN, status: 'running' }),
  }

  for (const [label, narrative] of Object.entries(forgeries)) {
    it(`recovers the writer’s fields, not the prose’s, given ${label}`, () => {
      const parsed = parseLatestDigest(entry({ narrative }))
      expect(parsed, 'the entry became unreadable').not.toBe(null)
      // The four fields belong to the WRITER. Not one of them may come from the prose.
      expect(parsed.at).toBe(AT)
      expect(parsed.runId, 'prose was attributed to another run').toBe(RUN)
      expect(parsed.task).toBe(TASK)
      expect(parsed.model).toBe(MODEL)
      // ...and the narrative is exactly what the writer was handed, trimmed the one way
      // formatHistoryEntry trims it. Nothing added, nothing eaten.
      expect(parsed.narrative).toBe(String(narrative).trim())
    })
  }

  it('never lets forged prose reach buildDigestView as another run’s digest', () => {
    // The same attack one layer up, where the damage would be: the view is what the
    // reader sees, and a narrative claiming to be a fresh digest for THIS run must not
    // displace the real entry's age, model or text.
    const forged = heading(new Date(NOW).toISOString(), `run ${RUN}`, '#999', 'gpt-evil')
    const view = viewOf({ historyText: entry({ narrative: `${forged}\nall is well` }) })
    expect(view.model).toBe(MODEL)
    expect(view.task).toBe(TASK)
    expect(view.atMs).toBe(AT_MS)
    expect(view.ageMs).toBe(12 * MIN)
    expect(view.narrative.startsWith(DASH), 'the forged heading became the narrative').toBe(true)
  })

  it('reads exactly one heading per entry no matter what the prose contains', () => {
    // The structural invariant behind every assertion above, stated as a fact about the
    // bytes: a body line can never sit at column 0, so it can never open an entry.
    for (const narrative of Object.values(forgeries)) {
      const text = entry({ narrative })
      const openers = text.split('\n').filter((line) => line.startsWith(`${DASH}${DASH} `))
      expect(openers, `a body line reached column 0: ${openers.length} openers`).toHaveLength(1)
    }
  })
})

describe('parseLatestDigest — torn, interleaved and rewritten files (#63 QA)', () => {
  // Shapes a crashed append, two concurrent digests, or a human with an editor can leave.
  // The rule for all of them: `null`, or the last entry that IS complete. Never an entry
  // whose narrative is empty, because the renderer would print a heading over nothing.
  const shapes = {
    'a heading cut off mid-field': `\n${DASH}${DASH} ${AT}${SEP}run ${RUN}`,
    'a heading with no body at all': `\n${heading(AT, `run ${RUN}`, TASK, MODEL)}\n`,
    'a body with no heading above it': '  orphaned prose\n',
    'a heading whose body is only whitespace': `\n${heading(AT, `run ${RUN}`, TASK, MODEL)}\n   \n\n`,
    'a single newline': '\n',
    'only whitespace': '   \n\n  \t\n',
    'the empty string': '',
    'a heading missing its run field': `\n${heading(AT, TASK, MODEL)}\n  prose\n\n`,
    'a heading with two fields': `\n${heading(AT, `run ${RUN}`)}\n  prose\n\n`,
    'a heading with no dash padding': `\n${DASH}${DASH} ${AT}${SEP}run ${RUN}${SEP}${TASK}\n  prose\n\n`,
    'a whole file rewritten with CRLF endings': entry().replace(/\n/g, '\r\n'),
    'a run id long enough to be eaten by the 200-char cap': entry({ runId: 'R'.repeat(200) }),
  }

  for (const [label, text] of Object.entries(shapes)) {
    it(`answers null rather than a half-entry for ${label}`, () => {
      // Every one of these degrades to no section (AC#5). The CRLF row is
      // CHARACTERISATION, not a demand: a history file rewritten by a Windows editor is
      // unreadable to this parser, and unreadable degrades to silence — which is the
      // documented outcome, but worth pinning so a future `\r`-tolerant regex is a
      // deliberate change rather than an accident.
      expect(parseLatestDigest(text)).toBe(null)
    })
  }

  it('falls back past a torn tail to the last COMPLETE entry, however deep', () => {
    const good = entry({ narrative: 'the real news' })
    const torn =
      good +
      `\n${heading('2026-08-26T05:10:00Z', `run ${RUN}`, TASK, MODEL)}\n` +
      `\n${DASH}${DASH} 2026-08-26T05:40:00Z${SEP}run ${RUN}` +
      `\n${heading('not a date', `run ${RUN}`, TASK, MODEL)}\n  prose\n\n`
    expect(parseLatestDigest(torn).narrative).toBe('the real news')
  })

  it('survives two appends interleaved without a separating blank line', () => {
    // A single append of this size is atomic on POSIX, but a crash between the write and
    // the flush can still glue two entries together.
    const glued = `\n${entry({ narrative: 'first' }).trim()}${entry({ narrative: 'second' })}`
    expect(parseLatestDigest(glued).narrative).toBe('second')
  })

  it('reads an entry that was never terminated by its trailing blank line', () => {
    expect(parseLatestDigest(entry({ narrative: 'unterminated' }).replace(/\n+$/, '')).narrative).toBe(
      'unterminated',
    )
  })

  it('reads a pre-#63 three-field entry and a #63 four-field entry out of the same file', () => {
    // The upgrade case as one file rather than two: 0.21.0 wrote three fields, this
    // version writes four, and a history file spans the upgrade.
    const mixed =
      `\n${heading(AT, `run ${RUN}`, '#028')}\n  written by 0.21.0\n\n` +
      entry({ at: '2026-08-26T05:00:00Z', narrative: 'written after the upgrade' })
    expect(parseLatestDigest(mixed).model).toBe(MODEL)
    // ...and the older one still reads, with the model absent rather than wrong.
    const legacyOnly = `\n${heading(AT, `run ${RUN}`, '#028')}\n  written by 0.21.0\n\n`
    expect(parseLatestDigest(legacyOnly)).toMatchObject({ model: null, narrative: 'written by 0.21.0' })
  })

  it('is total over anything a caller could hand it', () => {
    // The module header promises nothing here throws. `readFile` can answer a Buffer, a
    // stub can answer a number, and a destructured default can answer undefined.
    for (const input of [undefined, null, 0, 123, {}, [], Buffer.from('nothing here')]) {
      expect(() => parseLatestDigest(input), String(input)).not.toThrow()
      expect(parseLatestDigest(input), String(input)).toBe(null)
    }
  })
})

describe('buildDigestView — clock edges cannot publish a bad instant (#63 QA)', () => {
  // The stamp is TRANSCRIBED out of somebody else's file, so it is held to the same bounds
  // lib/progress.js holds every transcribed instant to. `Date.parse` accepts expanded
  // years (`+275760-09-13`) and negative ones, and both are outside what `%Y-%m-%d` can
  // print — so the view may carry the millisecond, but the document must refuse the text.
  const stamps = {
    'the maximum time value': '+275760-09-13T00:00:00Z',
    'one day past the maximum': '+275760-09-14T00:00:00Z',
    'the year 10000': '+010000-01-01T00:00:00Z',
    'the year zero': '0000-01-01T00:00:00Z',
    'a negative year': '-000001-12-31T00:00:00Z',
    'no timezone at all': '2026-08-26T04:40:12',
    'a date with no time': '2026-08-26',
    'the words Invalid Date': 'Invalid Date',
    'prose': 'about ten minutes ago',
    'an impossible date': '2026-13-45T99:99:99Z',
    'a bare number': '1787719212000',
    'the empty string': '',
  }

  for (const [label, at] of Object.entries(stamps)) {
    it(`never publishes an unprintable instant for ${label}`, () => {
      const view = viewOf({ historyText: entry({ at }) })
      if (view === null) return // refused outright, which is the safest answer
      // Either the millisecond is one `%Y-%m-%dT%H:%M:%SZ` can express — the guard answers
      // the number back — or the document's leaf is null. What must never happen is an
      // expanded-year form (`+275760-09-13T00:00:00.000Z`) reaching a `jq` filter.
      const published = calendarInstantOrNull(view.atMs)
      if (published !== null) {
        expect(new Date(published).toISOString(), at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      }
      // ...and the age is never negative and never NaN, in either direction.
      expect(view.ageMs === null || view.ageMs >= 0, `ageMs = ${view.ageMs}`).toBe(true)
      expect(formatElapsed(view.ageMs)).not.toMatch(/NaN|undefined|Infinity/)
    })
  }

  it('refuses a stamp beyond the range of a Date rather than showing an unknown age', () => {
    // One day past the maximum time value is `NaN` from `Date.parse`, and the module's own
    // rule is that a digest which cannot say WHEN is not an entry at all.
    expect(viewOf({ historyText: entry({ at: '+275760-09-14T00:00:00Z' }) })).toBe(null)
  })

  it('clamps a digest from the future and does not call it stale', () => {
    const ahead = viewOf({ historyText: entry({ at: new Date(NOW + 6 * 60 * MIN).toISOString() }) })
    expect(ahead.ageMs).toBe(0)
    expect(ahead.stale).toBe(false)
    expect(renderDigestSection(ahead)[1]).toContain('0min ago')
  })

  it('degrades the age leaf, not the section, for every unreadable clock', () => {
    for (const now of [Number.NaN, undefined, null, Number.POSITIVE_INFINITY, 'soon', {}]) {
      const view = viewOf({ now })
      expect(view, String(now)).not.toBe(null)
      expect(view.ageMs, String(now)).toBe(null)
      expect(view.stale, 'an unknown age is not a judgement').toBe(false)
      expect(renderDigestSection(view)[1]).toContain('unknown ago')
    }
  })
})

describe('buildDigestView — staleness, from ralph.config.sh to the threshold (#63 QA)', () => {
  const at = (minutesAgo) => entry({ at: new Date(NOW - minutesAgo * MIN).toISOString() })
  const staleAfter = (interval, minutesAgo) =>
    buildDigestView({ historyText: at(minutesAgo), record: { run_id: RUN }, now: NOW, interval }).stale

  // The threshold is two intervals, and everything the duration grammar refuses lands on
  // the documented 30-minute default (a 60-minute ceiling). `24d` is the last interval a
  // timer can actually wait, so it is accepted; `25d` is past MAX_TIMER_MS and is not.
  const thresholds = {
    '90s': 3,
    '15m': 30,
    '30m': 60,
    '2h': 240,
    '1800': 60, // a bare number is seconds, per the grammar
    '24d': 69120,
    '25d': 60, // refused: longer than a timer can wait -> default
    '0': 60,
    '0m': 60,
    '00': 60,
    '': 60,
    '   ': 60,
    '0.5h': 60, // the grammar takes no fractions
    '-5m': 60,
    'abc': 60,
    '30 m': 60,
    '99999999999999999999d': 60,
  }

  for (const [interval, minutes] of Object.entries(thresholds)) {
    it(`treats ${JSON.stringify(interval)} as ${minutes} minutes before stale`, () => {
      // The boundary itself is not stale: a digest that landed exactly on time is on time.
      expect(staleAfter(interval, minutes), `${minutes} min`).toBe(false)
      expect(staleAfter(interval, minutes + 1), `${minutes + 1} min`).toBe(true)
    })
  }

  for (const interval of [undefined, null, 0, {}, [], Number.NaN]) {
    it(`falls back to the default rather than throwing for ${String(interval)}`, () => {
      expect(staleAfter(interval, 59)).toBe(false)
      expect(staleAfter(interval, 61)).toBe(true)
    })
  }

  // The seam that actually runs in production: config TEXT, through the `digestInterval`
  // that moved into lib/digest.js in this change, into the threshold. Reading the knob is
  // one rule shared by three commands, so it is tested from the bytes of the file.
  const configs = {
    'RALPH_DIGEST_INTERVAL=90s': 3,
    'RALPH_DIGEST_INTERVAL="90s"': 3,
    'RALPH_DIGEST_INTERVAL=" 90s "': 3,
    'RALPH_DIGEST_INTERVAL=90s # every ninety seconds': 3,
    'RALPH_DIGEST_INTERVAL="90s" # the template invites a note here': 3,
    'RALPH_DIGEST_INTERVAL=2h': 240,
    'RALPH_DIGEST_INTERVAL=""': 60, // off -> the default, so a stale digest is still marked
    'RALPH_DIGEST_INTERVAL=0': 60,
    '# RALPH_DIGEST_INTERVAL=90s': 60, // commented out
    'RALPH_DIGEST_INTERVAL_OLD=90s': 60, // a similarly named variable is not this one
    'RALPH_DIGEST_INTERVAL=90s\nRALPH_DIGEST_INTERVAL=2h': 240, // bash: last wins
    'TASK_SOURCE=folder': 60, // absent
    '': 60,
  }

  for (const [configText, minutes] of Object.entries(configs)) {
    it(`reads ${JSON.stringify(configText)} as ${minutes} minutes before stale`, () => {
      const interval = digestInterval(configText)
      expect(staleAfter(interval, minutes), `${minutes} min`).toBe(false)
      expect(staleAfter(interval, minutes + 1), `${minutes + 1} min`).toBe(true)
    })
  }
})

describe('buildDigestView — the run scoping cannot be talked around (#63 QA)', () => {
  const scoped = (entryRunId, recordRunId) =>
    buildDigestView({
      historyText: entry({ runId: entryRunId }),
      record: recordRunId === undefined ? undefined : { run_id: recordRunId },
      now: NOW,
    })

  it('shows nothing when either side has no id, whatever shape the absence takes', () => {
    for (const [label, args] of Object.entries({
      'no id in the entry': [null, RUN],
      'the writer’s word for no id': ['unknown', RUN],
      'an empty id in the entry': ['', RUN],
      'no record at all': [RUN, undefined],
      'an empty id on the record': [RUN, ''],
      'a null id on the record': [RUN, null],
      'another run entirely': [OTHER_RUN, RUN],
      'a prefix of this run': [RUN.slice(0, -2), RUN],
      'this run plus a suffix': [`${RUN}x`, RUN],
      'a case-shifted id': [RUN.toUpperCase(), RUN],
    })) {
      expect(scoped(...args), label).toBe(null)
    }
  })

  it('matches a record whose run id is a number, because ids are compared as text', () => {
    expect(buildDigestView({ historyText: entry({ runId: '42' }), record: { run_id: 42 }, now: NOW })).not.toBe(
      null,
    )
  })
})

describe('renderDigestSection — the block cannot break the view (#63 QA / AC#6)', () => {
  const bodyOf = (narrative) => renderDigestSection({ ...viewOf(), narrative }).slice(2)

  it('keeps a control byte out of the terminal', () => {
    // THE DEFECT THIS FOUND, now fixed. This is the first view in Ralph that prints
    // MODEL PROSE to a human terminal — every other line of `ralph status` is a number,
    // an id or one of this repo's own words — and it printed it verbatim. A narrative
    // beginning `ESC[2J ESC[H` cleared the reader's screen and took the attach/kill pair
    // with it; `ESC]0;...BEL` retitled their window; a NUL truncated the line for some
    // terminals. The wrapper collapsed \r, \n and \t as whitespace, so those were already
    // neutralised — which is exactly why the remaining bytes read as an oversight rather
    // than a decision.
    //
    // WHAT IT GUARDS NOW: `printable` in lib/digest-history.js, applied on the RENDER path
    // only — to the narrative and to the model, which also comes off the file and lands in
    // the heading the section draws. C0, DEL and C1 become spaces (not nothing, so a
    // scrubbed sequence cannot fuse the words on either side); `\n` survives because
    // bodyLines splits paragraphs on it. `--json` is deliberately NOT scrubbed and never
    // was affected: JSON.stringify escapes every code unit below 0x20, so the wire is safe
    // by construction and a machine consumer receives what the model actually wrote.
    for (const [label, narrative] of Object.entries({
      'a clear-screen sequence': `${ESC}[2J${ESC}[Hgone`,
      'a window-title sequence': `${ESC}]0;pwned${BEL}`,
      'a colour sequence': `${ESC}[31mred${ESC}[0m`,
      'a NUL': `before${NUL}after`,
    })) {
      expect(bodyOf(narrative).join('\n'), label).not.toMatch(CONTROL_CHARS)
    }
  })

  it('bounds the block in terminal ROWS, not merely in array elements', () => {
    // THE DEFECT THIS FOUND, now fixed. MAX_BODY_LINES exists so "the attach/kill pair
    // below it is one glance away". It caps the number of STRINGS, and a word longer than
    // the width was left whole — so one 5000-character token (a base64 blob, a minified
    // stack, a URL a model pasted) yielded a three-element section that occupied ~79 rows
    // on a 64-column terminal and pushed the rest of the view off the screen. The cap did
    // not bound the thing it was written to bound.
    //
    // WHAT IT GUARDS NOW: `breakLongWords` in lib/digest-history.js hard-breaks a word
    // longer than the wrap width — a word that cannot fit on any line, so the choice was
    // never "break or keep" but "break or overflow". Ordinary prose never reaches it, and
    // MAX_BODY_LINES is a bound in ROWS again. Asserted in CHARACTERS against a row budget
    // rather than in array length, because array length is the measure that lied.
    const section = renderDigestSection({ ...viewOf(), narrative: 'x'.repeat(5000) })
    const budget = (MAX_BODY_LINES + 2) * WIDTH
    const total = section.join('\n').length
    expect(total, `the section is ${total} characters, ~${Math.ceil(total / WIDTH)} rows`).toBeLessThanOrEqual(
      budget,
    )
  })

  it('keeps its heading inside its own width for a model id the config knob invites', () => {
    // THE DEFECT THIS FOUND, now fixed. `heading()` clamps its PADDING at three dashes but
    // never shortened the label, so a long model name ran the line past 64 columns and out
    // of the box every other row of the view is drawn in. RALPH_DIGEST_MODEL is documented
    // as a free-text knob and a Bedrock or Vertex model id is exactly this long, so it was
    // reachable from a config file, not just from a hand-edited history.
    //
    // WHAT IT GUARDS NOW: LABEL_WIDTH in lib/digest-history.js is DERIVED from the section
    // width — the heading opener, its closing space, `digest ()` and MIN_HEADING_PAD are
    // all subtracted — and the model is elided to whatever the age and staleness clauses
    // leave of it. So the padding floor is exactly consumed instead of being overrun, and
    // the line is 64 columns for every combination of the three clauses. The model is the
    // clause that gives way because it is the only one whose width is somebody else's; a
    // truncated age or a dropped `stale` would be a lie rather than less detail.
    for (const model of [
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'anthropic.claude-3-5-haiku-20241022-v1:0',
      'm'.repeat(160),
    ]) {
      const lines = renderDigestSection({ ...viewOf(), model })
      expect(lines[1].length, `model ${model.length} chars -> heading ${lines[1].length}`).toBeLessThanOrEqual(
        WIDTH,
      )
    }
  })

  it('CHARACTERISATION: a hand-assembled empty view renders a bare heading', () => {
    // NOT a defect through the real pipeline: `buildDigestView` cannot produce an empty
    // narrative (`readEntry` refuses a body that trims to nothing), so `collectStatus`
    // never reaches this. But `renderStatus({ digest })` IS a public seam with its own
    // test, and the renderer trusts the parser's invariant rather than restating it — so
    // a caller who builds a view by hand gets a heading over nothing, the exact shape the
    // parser exists to prevent. Pinned so the coupling is visible.
    for (const narrative of ['', '   ', '\n\n', undefined, null]) {
      const lines = renderDigestSection({ ...viewOf(), narrative })
      expect(lines, JSON.stringify(narrative)).toHaveLength(2)
      expect(lines[1]).toMatch(/^ {2}── digest \(/)
    }
  })

  it('renders every hostile narrative as a well-formed block', () => {
    // The shape assertions that hold for all of them: one blank opener, one heading line,
    // then indented non-empty rows, and a bounded number of them.
    const narratives = [
      'x'.repeat(5000),
      Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),
      `${ESC}[2Jcleared`,
      `plain ${RTL}sdrawkcab`,
      `a${LSEP}b`,
      `${DASH.repeat(80)}`,
      'word '.repeat(400),
      '\t\ttabs\t\tonly',
      `${String.fromCharCode(0x65e5).repeat(120)}`,
    ]
    for (const narrative of narratives) {
      const lines = renderDigestSection({ ...viewOf(), narrative })
      expect(lines[0], 'the block owns its separating blank line').toBe('')
      expect(lines[1]).toMatch(/^ {2}── digest \(/)
      expect(lines.length, 'the block outgrew its bound').toBeLessThanOrEqual(MAX_BODY_LINES + 3)
      for (const line of lines.slice(2)) {
        expect(line.startsWith('  '), JSON.stringify(line.slice(0, 20))).toBe(true)
        expect(line.trim(), 'a blank row would end the block early').not.toBe('')
      }
    }
  })

  it('CHARACTERISATION: wraps by code unit, so a CJK narration is twice as wide as the box', () => {
    // Not filed as a defect — this repo counts code units everywhere it pads — but pinned
    // because it IS the layout promise failing for a non-Latin narration: 62 code units of
    // Japanese occupy ~124 terminal columns. If the wrap ever becomes width-aware, this
    // test is the one that should change.
    const words = Array.from({ length: 40 }, () => String.fromCharCode(0x65e5, 0x672c, 0x8a9e)).join(' ')
    const body = bodyOf(words)
    expect(Math.max(...body.map((l) => l.length))).toBeLessThanOrEqual(WIDTH)
    expect(Math.max(...body.map((l) => l.length)), 'code units, not columns').toBeGreaterThan(WIDTH / 2)
  })

  it('CHARACTERISATION: prose can draw a second heading inside the section', () => {
    // A model that writes `── digest (0min ago · opus · stale) ───` gets a line that is
    // visually identical to Ralph's own heading, one row below the real one. Cosmetic
    // rather than dangerous — the true heading is always the line above, and the parse
    // side is unforgeable — but it is UI spoofing by untrusted text, and the same scrub
    // that fixes the control-byte leak above would cover it.
    const body = bodyOf(`${DASH}${DASH} digest (0min ago${SEP}evil${SEP}stale) ${PAD}\nfake prose`)
    expect(body[0]).toMatch(/^ {2}── digest \(0min ago · evil · stale\)/)
  })

  it('drops the model clause rather than printing our own uncertainty as a model', () => {
    for (const model of [null, undefined, '']) {
      const lines = renderDigestSection({ ...viewOf(), model })
      expect(lines[1], String(model)).toMatch(/^ {2}── digest \(12min ago\) ─+$/)
      expect(lines[1]).not.toContain('unknown')
    }
  })

  it('renders nothing at all for every shape of no-digest', () => {
    for (const view of [null, undefined, false, 0, '']) {
      expect(renderDigestSection(view), String(view)).toEqual([])
    }
  })

  it('is total over a view assembled by hand', () => {
    for (const view of [{}, { narrative: 42 }, { narrative: {} }, { ageMs: 'soon', narrative: 'x' }]) {
      expect(() => renderDigestSection(view), JSON.stringify(view)).not.toThrow()
    }
  })
})
