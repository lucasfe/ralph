// #69 — the spec for the one fact the banner cannot simply be handed: which model.
//
// Every other row of the identity box is a value some caller already holds: a version out
// of package.json, a cwd out of argv, a cached version out of a JSON file, a repository
// slug out of the grammar in lib/git-remote-slug.js. The fact this module resolves is
// different in kind — a question about the PAST or about the ENVIRONMENT rather than a
// lookup. The Claude model cannot be known at launch (CLAUDE_ARGV carries no `--model`,
// Ralph has no model setting, and Claude Code exposes no way to ask), so the only honest
// answer available before the first turn is what the LAST run used, read out of the metrics
// log the loop appends to. For Codex the stream carries no model id at all, so the
// configured value is the answer instead. Two different kinds of evidence, and therefore
// two different sentences: the whole point of the `provenance` tag this module returns is
// that the box must never state a model with more confidence than its source warrants.
//
// #116 MOVED THE REPO HALF OUT, cases and comments unchanged, into
// lib/git-remote-slug.test.js — the module under test there is the git-config grammar this
// file used to hold a `resolveBannerRepo` describe block for. Nothing in the model matrix
// below moved or changed.
//
// PURE, and asserted so by a static read at the bottom: no clock, no environment, no
// filesystem. The text of the metrics log arrives as a string, which is what makes the
// whole table below testable without a .ralph directory or a run that has ever happened
// (#41).
//
// TABLE-DRIVEN wherever the input is a shape rather than a value, because the interesting
// half of this module is what it refuses: a truncated trailing line, an event carrying no
// model, a model belonging to another agent. Each of those is one row here.

import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { resolveContextWindow } from './issue-event.js'
import { MODEL_PROVENANCE, resolveBannerModel } from './banner-model.js'

/** One metrics line, spelled the way lib/issue-metrics.js's writer spells it. */
const event = (fields) => `RALPH_ISSUE_EVENT ${JSON.stringify(fields)}`
/** ...and a whole log, newline-terminated like an append-only file that was not killed. */
const log = (...lines) => `${lines.join('\n')}\n`

const CLAUDE_RUN = { agent: 'claude', model: 'claude-opus-5', context_window: 1_000_000 }
const OLDER_RUN = { agent: 'claude', model: 'claude-sonnet-4', context_window: 200_000 }

const forClaude = (metricsText) => resolveBannerModel({ metricsText, agent: 'claude' })

describe('resolveBannerModel — the Claude path, out of the newest event (#69)', () => {
  it('reports the model and the window the last run used, tagged as the last run', () => {
    expect(forClaude(log(event(CLAUDE_RUN)))).toEqual({
      agent: 'claude',
      model: 'claude-opus-5',
      contextWindow: 1_000_000,
      provenance: MODEL_PROVENANCE.LAST_RUN,
    })
  })

  it('lets the NEWEST event win — an earlier one is never consulted', () => {
    // The log is append-only and accumulates across runs, so the interesting event is the
    // last line rather than the first. Three runs deep, so a bug that took `[0]` and one
    // that took some middle line both fail here.
    const lines = log(event(OLDER_RUN), event(OLDER_RUN), event(CLAUDE_RUN))
    expect(forClaude(lines).model).toBe('claude-opus-5')
    expect(forClaude(lines).contextWindow).toBe(1_000_000)
  })

  it('skips a corrupt or truncated trailing line rather than dying on it', () => {
    // The loop appends with `>>` and can be killed mid-line, so a half-written last line is
    // the NORMAL state of this file rather than an exceptional one. Skipped exactly as
    // aggregateCycleCounts skips it: same tag, same slice, same swallow on a parse throw.
    const truncated = [
      'RALPH_ISSUE_EVENT {"agent":"claude","model":"claude-op',
      'RALPH_ISSUE_EVENT ',
      'RALPH_ISSUE_EVENT null',
      'RALPH_ISSUE_EVENT 42',
      'RALPH_ISSUE_EVENT "a string"',
      'RALPH_ISSUE_EVENT []',
      '',
      'some other line the loop printed',
    ]
    for (const tail of truncated) {
      const lines = log(event(CLAUDE_RUN), tail)
      expect(forClaude(lines), JSON.stringify(tail)).toEqual({
        agent: 'claude',
        model: 'claude-opus-5',
        contextWindow: 1_000_000,
        provenance: MODEL_PROVENANCE.LAST_RUN,
      })
    }
  })

  it('finds the tag wherever it is on the line, like the cycle aggregator does', () => {
    // The loop pipes this through tee and a pretty-printer, so a line can carry a prefix.
    // `indexOf` and not `startsWith`, for exactly the reason issue-metrics.js uses it.
    const prefixed = `2026-08-28T10:00:00Z | ${event(CLAUDE_RUN)}`
    expect(forClaude(log(prefixed)).model).toBe('claude-opus-5')
  })

  it('resolves to unknown when the newest event carries no usable model', () => {
    // THE DECISION THIS FILE EXISTS FOR: decide by the newest parseable event, full stop.
    // An older event that DOES name a model is not an answer about the last run, and
    // reporting it as one is precisely the over-confidence the provenance tag is for.
    for (const model of [undefined, null, '', '   ', 42, {}, []]) {
      const lines = log(event(OLDER_RUN), event({ agent: 'claude', model, context_window: 1e6 }))
      expect(forClaude(lines), JSON.stringify(model)).toEqual({
        agent: 'claude',
        model: null,
        contextWindow: null,
        provenance: MODEL_PROVENANCE.UNKNOWN,
      })
    }
  })

  it('treats an event with no agent field as claude — the field is newer than the log', () => {
    // `agent` arrived with #554; every event written before it is a Claude run, and a repo
    // that has been on Ralph since then still has those lines at the bottom of its log.
    expect(forClaude(log(event({ model: 'claude-opus-5', context_window: 1e6 })))).toEqual({
      agent: 'claude',
      model: 'claude-opus-5',
      contextWindow: 1_000_000,
      provenance: MODEL_PROVENANCE.LAST_RUN,
    })
  })

  it('reads an event belonging to another agent as no evidence at all', () => {
    // A repo that switched RALPH_AGENT has the other agent's run at the bottom of its log.
    // That run says nothing about which model claude will pick, and labelling a claude
    // event from three runs ago "last run" would be a lie about which run it was.
    const lines = log(event(OLDER_RUN), event({ agent: 'codex', model: 'gpt-5-codex' }))
    expect(forClaude(lines)).toEqual({
      agent: 'claude',
      model: null,
      contextWindow: null,
      provenance: MODEL_PROVENANCE.UNKNOWN,
    })
  })

  it('reports the model but no window when the event has no usable one', () => {
    // The window is a separate fact and a separate row: an event whose model is not in the
    // window map has `context_window: null`, and the model is still the model it ran.
    for (const window of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1000000', {}]) {
      const lines = log(event({ agent: 'claude', model: 'claude-opus-5', context_window: window }))
      expect(forClaude(lines), JSON.stringify(window)).toEqual({
        agent: 'claude',
        model: 'claude-opus-5',
        contextWindow: null,
        provenance: MODEL_PROVENANCE.LAST_RUN,
      })
    }
  })

  it('takes the window from the event, never from the configured override', () => {
    // THE EVENT IS THE OVERRIDE'S OWN RECORD on this path: lib/capture-issue-event.js resolves
    // `context_window` against RALPH_CONTEXT_WINDOW as it WRITES the line, so the number in the
    // log is already the one that run worked with. Reading today's knob instead would report a
    // window against a model from a run that never saw it — the same over-confidence the
    // `last-run` tag exists to prevent, one row down. An event with no usable window stays no
    // row for the same reason: the override is a fact about the NEXT run.
    const lines = log(event({ agent: 'claude', model: 'claude-opus-5', context_window: 250_000 }))
    const withKnob = (configuredWindow) =>
      resolveBannerModel({ metricsText: lines, agent: 'claude', configuredWindow })
    expect(withKnob('999').contextWindow).toBe(250_000)
    expect(withKnob(999).contextWindow).toBe(250_000)
    const noWindow = log(event({ agent: 'claude', model: 'claude-opus-5' }))
    expect(
      resolveBannerModel({ metricsText: noWindow, agent: 'claude', configuredWindow: '200000' })
        .contextWindow,
    ).toBe(null)
  })

  it('never names a model when there is no history to name one from', () => {
    // The empty and missing cases, which is every first run in every fresh checkout.
    for (const metricsText of ['', '\n\n', undefined, null, 42, {}, [], 'nothing tagged here']) {
      expect(forClaude(metricsText), JSON.stringify(metricsText)).toEqual({
        agent: 'claude',
        model: null,
        contextWindow: null,
        provenance: MODEL_PROVENANCE.UNKNOWN,
      })
    }
  })
})

describe('resolveBannerModel — the Codex path, out of the configured value (#69)', () => {
  const forCodex = (configuredModel, metricsText = '', configuredWindow) =>
    resolveBannerModel({ metricsText, agent: 'codex', configuredModel, configuredWindow })

  it('reports the configured model, tagged as configured, with the window it implies', () => {
    expect(forCodex('gpt-5-codex')).toEqual({
      agent: 'codex',
      model: 'gpt-5-codex',
      contextWindow: 400_000,
      provenance: MODEL_PROVENANCE.CONFIGURED,
    })
  })

  it('never consults the metrics log for a Codex model', () => {
    // Codex's stream carries no model id, so the log holds whatever was CONFIGURED at the
    // time — which is the same value this path already has, one indirection closer. And a
    // log full of claude runs must not put a claude model on a codex row.
    const lines = log(event(CLAUDE_RUN))
    expect(forCodex('gpt-5-codex', lines).model).toBe('gpt-5-codex')
    expect(forCodex('gpt-5-codex', lines).provenance).toBe(MODEL_PROVENANCE.CONFIGURED)
    expect(forCodex('', lines)).toEqual({
      agent: 'codex',
      model: null,
      contextWindow: null,
      provenance: MODEL_PROVENANCE.UNKNOWN,
    })
  })

  it('resolves to unknown for a knob that is unset, blank or not a string', () => {
    for (const configured of [undefined, null, '', '   ', 42, {}, []]) {
      expect(forCodex(configured), JSON.stringify(configured)).toEqual({
        agent: 'codex',
        model: null,
        contextWindow: null,
        provenance: MODEL_PROVENANCE.UNKNOWN,
      })
    }
  })

  it('trims the configured value, so a knob edited by hand still resolves', () => {
    expect(forCodex('  gpt-5-codex \n').model).toBe('gpt-5-codex')
  })

  it('asks the telemetry writer’s own map for the window, never a second copy of it', () => {
    // One owner of "how big is this model's window": the same function lib/issue-event.js
    // resolves `context_window` with when it WRITES an event. A second prefix map here is
    // how the box and the log would come to disagree about the same model.
    for (const model of ['gpt-5-codex', 'gpt-5-mini', 'gpt-4o', 'o3', 'something-nobody-knows']) {
      expect(forCodex(model).contextWindow, model).toBe(resolveContextWindow(model))
    }
  })

  it('honours RALPH_CONTEXT_WINDOW, which is the window the run it describes will use', () => {
    // THE OVERRIDE IS PART OF THE ANSWER, not a detail of the log. The `last-run` path takes
    // its window from the event, which was written WITH whatever override that run had in
    // force; this path is a statement about the run that is ABOUT to happen, so ignoring the
    // override would put `400k tokens` on screen and then have the very next event written
    // say `200000`. Same map, same second argument the telemetry writer passes it — the knob
    // arrives as text out of a shell config and `resolveContextWindow` is what reads it.
    expect(forCodex('gpt-5-codex', '', '200000').contextWindow).toBe(200_000)
    expect(forCodex('gpt-5-codex', '', 200_000).contextWindow).toBe(200_000)
    // ...and an unusable one leaves the map's answer standing rather than costing the row:
    // this is `resolveContextWindow`'s own rule (finite and positive, or the model decides),
    // which is the whole reason the value is handed to it instead of parsed here.
    for (const unusable of [undefined, null, '', '   ', '0', '-5', 'abc', {}, []]) {
      expect(forCodex('gpt-5-codex', '', unusable).contextWindow, JSON.stringify(unusable)).toBe(
        400_000,
      )
    }
    // A window with no model is still no row: the override says how big the window is, not
    // which model the run will use, and this box states a window only under a model it named.
    expect(forCodex('', '', '200000')).toEqual({
      agent: 'codex',
      model: null,
      contextWindow: null,
      provenance: MODEL_PROVENANCE.UNKNOWN,
    })
  })
})

describe('resolveBannerModel — the agent it was handed, and never a throw (#69)', () => {
  it('echoes the resolved agent back, so the row can name it', () => {
    expect(forClaude('').agent).toBe('claude')
    expect(resolveBannerModel({ agent: 'codex', configuredModel: 'gpt-5-codex' }).agent).toBe('codex')
  })

  it('takes the claude path for an agent it does not recognize, and finds no evidence', () => {
    // `resolveAgent` falls back to claude for an unrecognized RALPH_AGENT, so this shape is
    // only reachable from a caller that skipped it — and the answer stays conservative:
    // a claude event is not evidence about an agent that is not claude.
    const result = resolveBannerModel({ metricsText: log(event(CLAUDE_RUN)), agent: 'gemini' })
    expect(result.model).toBe(null)
    expect(result.provenance).toBe(MODEL_PROVENANCE.UNKNOWN)
    expect(result.agent).toBe('gemini')
  })

  it('never throws, and never coerces, whatever it is handed', () => {
    const hostile = {
      get model() {
        throw new Error('a fact must not be read twice')
      },
      toString() {
        throw new Error('a fact must never be coerced')
      },
    }
    // LABELLED rather than `JSON.stringify(bag)`, which every other table in this file uses:
    // stringifying a bag holding `hostile` reads the getter and throws inside the assertion
    // message, so the spec would fail for its own reason before the module had a chance to.
    // The same hazard the module is being asserted about, one layer up.
    const bags = [
      ['no bag at all', undefined],
      ['an empty bag', {}],
      ['numbers throughout', { agent: 42, metricsText: 42, configuredModel: 42 }],
      ['a hostile configured model', { agent: {}, metricsText: [], configuredModel: hostile }],
      ['a hostile model on the codex path', { agent: 'codex', configuredModel: hostile }],
      ['hostile metrics text', { agent: 'claude', metricsText: hostile }],
      ['nulls throughout', { agent: null, metricsText: null, configuredModel: null }],
    ]
    for (const [label, bag] of bags) {
      const result = resolveBannerModel(bag)
      expect(Object.keys(result).sort(), label).toEqual([
        'agent',
        'contextWindow',
        'model',
        'provenance',
      ])
      expect(result.model, label).toBe(null)
      expect(Object.values(MODEL_PROVENANCE), label).toContain(result.provenance)
    }
  })

  it('answers with one of exactly three provenance tags, and names them once', () => {
    // The tags are this module's vocabulary and lib/banner-rows.js's wording is keyed on
    // them. They are exported so the box's specs can enumerate them rather than restate them
    // — see the drift guards in banner-rows.test.js and banner-compose.test.js.
    expect(Object.values(MODEL_PROVENANCE).sort()).toEqual(['configured', 'last-run', 'unknown'])
    const answers = [
      forClaude(log(event(CLAUDE_RUN))),
      resolveBannerModel({ agent: 'codex', configuredModel: 'gpt-5-codex' }),
      forClaude(''),
    ]
    expect(answers.map((a) => a.provenance)).toEqual([
      MODEL_PROVENANCE.LAST_RUN,
      MODEL_PROVENANCE.CONFIGURED,
      MODEL_PROVENANCE.UNKNOWN,
    ])
  })
})

describe('banner-model — purity', () => {
  it('reads no clock, no environment and no filesystem', () => {
    // Same method and the same reason as lib/banner-compose.test.js's own purity spec: the
    // ABSENCE of a capability cannot be shown by exercising happy paths. This module is
    // handed the text of a file it must never open itself, which is the whole reason every
    // case above is a string literal rather than a fixture on disk (#41).
    const code = codeWithoutComments(new URL('./banner-model.js', import.meta.url))

    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/node:(fs|os|path|child_process|tty)/)
    // ITS TWO IMPORTS, and they are the same argument twice: the alternative to each is a
    // second copy of something the telemetry side already owns, and a copy is how the box and
    // the log come to disagree about the same run.
    //
    //   `./issue-event.js`       the context-window map — the very function that resolves
    //                            `context_window` when an event is WRITTEN, so a model id
    //                            cannot mean one window here and another there.
    //   `./issue-event-lines.js` the log's tag and the walk over its lines (#121). This module
    //                            used to hold its own copy of both, with a comment arguing that
    //                            duplicating one string literal beat importing the module that
    //                            owns the FILE — which was true, and not the only alternative.
    //
    // Neither costs the banner a capability. lib/issue-event.js imports only agent-stream.js;
    // lib/issue-event-lines.js imports nothing at all, and issue-event-lines.test.js asserts
    // that rather than trusting it. Pinned as an exact SET, so a third edge — to the module
    // holding `node:fs`, say — fails here by name instead of quietly loosening the claim.
    expect([...code.matchAll(/^import .* from '(.*)'$/gm)].map((m) => m[1]).sort()).toEqual([
      './issue-event-lines.js',
      './issue-event.js',
    ])
    // ...and the map is IMPORTED rather than inlined: no window constant is spelled here.
    expect(code).not.toMatch(/1_000_000|1000000|400_000|400000|200_000|200000/)
  })

  it('borrows the log’s line grammar from a module with nothing to lend (#121)', () => {
    // WHY THIS ROW EXISTS RATHER THAN A SENTENCE. The list above went from one import to two,
    // and a purity guard that admits a new edge on the strength of a comment is a purity guard
    // that has been loosened. What makes the edge safe is a property of the FAR END: the module
    // holding the tag and the walk has no imports of its own, so there is no `node:fs` reachable
    // through it, this year or after somebody edits it. That is asserted at length in
    // issue-event-lines.test.js — and asserted again here, cheaply, because the claim this file
    // is making is about banner-model.js's whole closure and not about its first hop.
    const shared = codeWithoutComments(new URL('./issue-event-lines.js', import.meta.url))
    expect([...shared.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1])).toEqual([])
    expect(shared).not.toMatch(/\bprocess\b/)
    expect(shared).not.toMatch(/\bDate\b/)
    expect(shared).not.toMatch(/node:/)
  })

  it('writes nothing to the event it reads — criterion 9, as a static read', () => {
    // #69 adds no telemetry field and changes no event shape. This module only ever READS
    // the log, so the guard is that it holds no writer: no append, no JSON.stringify, and
    // no reach into the module that owns the file.
    const code = codeWithoutComments(new URL('./banner-model.js', import.meta.url))
    expect(code).not.toMatch(/appendIssueEvent|issue-metrics|JSON\s*\.\s*stringify/)
  })
})
