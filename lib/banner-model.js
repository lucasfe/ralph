// #69 — which model the agent is about to use, and how much that claim is worth.
//
// Every other row of the identity box is a lookup the caller already holds: a version out of
// package.json, a cwd out of argv, a cached version out of a JSON file, a repository slug out
// of the grammar in lib/git-remote-slug.js. This one is a question rather than a lookup, and
// its answer is awkward.
//
// IT CANNOT BE KNOWN AT LAUNCH. CLAUDE_ARGV carries no `--model` flag, Ralph has no model
// setting of its own, and Claude Code exposes no way to ask before the first turn. So the only
// honest evidence available is what the LAST run used, which the loop already wrote to
// .ralph/metrics/issues.jsonl on its way past. For Codex there is not even that: its stream
// carries no model id at all, so RALPH_CODEX_MODEL — the value the loop passes on the command
// line — is the answer. Two different kinds of evidence, so this module returns a `provenance`
// tag alongside the model and lib/banner-compose.js words the row differently for each. That
// tag is the point of the whole module: the box must never state a model with more confidence
// than its source warrants, which is a correctness requirement here rather than a cosmetic one.
//
// #116 MOVED THE BOX'S OTHER RESOLVED FACT OUT. `resolveBannerRepo` and its hundred-odd lines of
// git-config and url grammar used to occupy the back half of this file — not its bottom: six of
// the model's own helpers went on below them, which is part of why nobody read the seam. They are
// lib/git-remote-slug.js now, cases and comments carried across unedited. The two halves shared
// this module's purity, its never-throws contract and two five-line helpers, and nothing else —
// no code path, no caller's question, and no test that asserted both. So the move changed
// nothing here but the prose and the helpers the other file now keeps its own copy of.
//
// PURE, and asserted so by a static read in banner-model.test.js: no clock, no environment,
// no filesystem. The text of the metrics log arrives as an argument, which is what makes every
// case in that spec a string literal instead of a fixture on disk (#41) — there is no .ralph
// directory and no previous run anywhere in it.
//
// NEVER THROWS, on the same grounds as the rest of the banner: this is decoration in front
// of a loop that runs unattended for hours, and no row of it is worth losing a launch over.
// Every input is therefore type-checked rather than coerced — `String(value)` on a hostile
// bag runs its `toString`, and these values come from an ambient environment and a file
// nobody reads as bytes.

// The window map, IMPORTED rather than copied. lib/issue-event.js already owns "how big is
// this model's window" — it is the function that resolves `context_window` when an event is
// WRITTEN — and a second prefix map here is how the box and the log would come to disagree
// about the same model id. It costs this module no capability it did not already have:
// issue-event.js imports only agent-stream.js and is pure for the same reasons.
import { resolveContextWindow } from './issue-event.js'

// The log's line grammar, IMPORTED for the same reason and since #121. This module used to hold
// its own copy of the tag and its own reverse walk over the lines, with a comment here arguing
// that one duplicated string literal was cheaper than the alternative — and the alternative it
// weighed was importing lib/issue-metrics.js, which would indeed have handed this file `node:fs`
// and broken the purity spec next door. That was the wrong pair of options. There were THREE
// copies of the walk by then (here, in `aggregateCycleCounts`, and in `parseIssueEvents`), all
// reading the same append-only file, and the day two of them drifted the symptom would not look
// like drift: it would look like the launch box contradicting `ralph status` about the same run.
// lib/issue-event-lines.js is the third option — the tag and the walk with no imports of their
// own, so this module gains a seam and no capability. `newestIssueEvent` is the `newestEvent`
// that used to sit below, under a name that says whose lines it walks: same scan from the end,
// same early return on the first line that parses, which is the property the log path below
// depends on rather than merely benefits from.
import { newestIssueEvent } from './issue-event-lines.js'

/**
 * The three kinds of evidence this module can have about a model, and the vocabulary
 * lib/banner-compose.js keys its wording on.
 *
 * Exported so the box's spec can ENUMERATE them rather than restate them: a fourth tag
 * added here with no sentence written for it there fails a test instead of printing a row
 * nobody wrote. The box itself does not import this — its purity spec pins its import list
 * at one and the argument for that is written in the module — so banner-compose.test.js
 * holds the two together, the same way it holds SPRITE_MIN_WIDTH against the sprite.
 *
 *   `last-run`   the model the previous run actually used, out of the metrics log. Evidence
 *                about the PAST, which is why the row it produces says so.
 *   `configured` the model the loop will be told to use. Evidence about this run, but only
 *                because Codex takes the model as an argument.
 *   `unknown`    no evidence at all. The row names the agent and promises nothing.
 */
export const MODEL_PROVENANCE = Object.freeze({
  LAST_RUN: 'last-run',
  CONFIGURED: 'configured',
  UNKNOWN: 'unknown',
})

// The agent every event with no `agent` field belongs to. That field arrived with #554's
// multi-agent support; every event written before it is a Claude run, and a repo that has
// been on Ralph since then still has those lines in its log. Reading them as Claude runs is
// what lets an old checkout's box say something on its first launch after an upgrade.
const LEGACY_AGENT = 'claude'

// The one agent whose model comes from a KNOB rather than from the log. Claude's stream
// carries the model id, so the log is the only place the box can learn it; Codex's stream
// does not carry one at all, so RALPH_CODEX_MODEL is the answer and the log is never
// consulted for it. Named rather than spelled inline because it is a claim about an agent's
// stream, which is the kind of fact that changes.
const CONFIGURED_MODEL_AGENT = 'codex'

/**
 * Which agent is about to run, which model it will use, and how much that claim is worth.
 *
 * @param {object} [input]
 * @param {string} [input.metricsText] the whole metrics log, as text — or anything at all,
 *   including a read that failed and handed back `null`
 * @param {string} [input.agent] the RESOLVED agent (see resolveAgent in
 *   lib/agent-registry.js), not the raw RALPH_AGENT: the box reports what will run, not
 *   what was typed
 * @param {string} [input.configuredModel] RALPH_CODEX_MODEL, as the config or the
 *   environment gave it. Ignored for every other agent.
 * @param {string|number} [input.configuredWindow] RALPH_CONTEXT_WINDOW, as the config or the
 *   environment gave it — text, since it comes out of a shell config. Read only on the
 *   `configured` path: a `last-run` window comes from the event, which was written with
 *   whatever override THAT run had.
 * @returns {{agent: string|null, model: string|null, contextWindow: number|null,
 *   provenance: string}} `provenance` is always one of MODEL_PROVENANCE's three values, and
 *   `model` is null whenever it is `unknown`. Never throws.
 */
export function resolveBannerModel(input) {
  const { metricsText, agent, configuredModel, configuredWindow } = bagOf(input)
  // Echoed back so the row has an agent to name whatever else it learns — and echoed only
  // when it is a string, because a caller that passed an object passed no agent.
  const named = typeof agent === 'string' ? agent : null
  const answer = (model, contextWindow, provenance) => ({
    agent: named,
    model,
    contextWindow,
    provenance,
  })
  const nothing = () => answer(null, null, MODEL_PROVENANCE.UNKNOWN)

  // THE CODEX PATH, and it does not consult the log. Codex's stream carries no model id, so
  // what the log holds for a Codex run is whatever was CONFIGURED at the time — the same
  // value this function already has, one indirection and one stale run further away. Reading
  // it would also let a log full of Claude runs put a Claude model on a Codex row.
  if (named === CONFIGURED_MODEL_AGENT) {
    const model = trimmedOr(configuredModel, '')
    if (!model) return nothing()
    // The window comes from the shared map because for Codex the model is known BEFORE the
    // run, so the same lookup the telemetry writer will do is available now and is right —
    // INCLUDING its second argument. RALPH_CONTEXT_WINDOW is what the run will actually work
    // with, so a row that reported the map's default while an override was in force would be
    // contradicted by the very first event that run writes. The knob is handed over rather
    // than parsed here for the same reason the map is not copied: `resolveContextWindow` owns
    // "finite and positive, or the model decides", and two readings of one knob is how the box
    // and the log come to disagree.
    //
    // TYPE-GATED BEFORE IT IS HANDED OVER, on this module's own rule: `resolveContextWindow`
    // starts with `Number(override)`, which runs `valueOf` and then `toString` on whatever it
    // is given — and this value arrives from an ambient environment, where a bag whose
    // `toString` throws is exactly the input the never-throws contract at the top of this file
    // is about. A knob that is neither text nor a number is a knob nobody set.
    const knob = typeof configuredWindow === 'string' || typeof configuredWindow === 'number'
    return answer(
      model,
      resolveContextWindow(model, knob ? configuredWindow : undefined),
      MODEL_PROVENANCE.CONFIGURED,
    )
  }

  // THE LOG PATH: the newest parseable event, and nothing else. Claude takes it, and so does
  // an agent nobody recognizes — a shape only reachable from a caller that skipped
  // resolveAgent, and one the comparison below answers conservatively all by itself.
  //
  // DECIDE BY THE NEWEST EVENT, FULL STOP. If that event carries no usable model then the
  // answer is `unknown` — this deliberately does NOT walk further back for one that does,
  // because an older run's model is not a fact about the last run, and labelling it
  // `last-run` is exactly the over-confidence the provenance tag exists to prevent. The same
  // reasoning covers an event belonging to a DIFFERENT agent, which is what the bottom of
  // the log looks like in a repo that switched RALPH_AGENT: that run says nothing about
  // which model Claude will pick, and reaching past it to a Claude event from three runs ago
  // would be a lie about which run it was.
  //
  // "NEWEST PARSEABLE" is the shared walk's word, not this module's (#121): it reads from the
  // END and returns on the first line that yields an event object, so a trailing line the loop
  // was killed halfway through — the normal state of a file appended to with `>>` — and one
  // holding a bare `null`, a number or an array are stepped over rather than answered with. A
  // line that DOES parse ends the walk, which is what the paragraph above depends on.
  const event = newestIssueEvent(metricsText)
  if (!event) return nothing()
  if (agentOf(event) !== named) return nothing()
  const model = trimmedOr(event.model, '')
  if (!model) return nothing()
  // The window is a SEPARATE fact and a separate row: it is taken from the event rather than
  // from the map, because the event's own `context_window` already includes whatever
  // RALPH_CONTEXT_WINDOW override that run was given. An event whose model the map did not
  // know wrote `null` there, and the honest answer is then no window rather than a second
  // guess at one.
  return answer(model, positiveNumberOr(event.context_window, null), MODEL_PROVENANCE.LAST_RUN)
}

// Which agent an event belongs to — see LEGACY_AGENT for why a missing field is a Claude run.
function agentOf(event) {
  return trimmedOr(event.agent, LEGACY_AGENT)
}

// The two helpers below have a twin at the bottom of lib/git-remote-slug.js, which #116 split
// off. Duplicated rather than shared on purpose, and the argument for it is written there once
// rather than in both places: a ten-line utils module standing between two grammars that have
// nothing to say to each other would put back exactly the coupling the split removed.

// A bag, whatever was passed. `= {}` covers an absent argument but not a `null` one, and
// destructuring `null` throws — which is the one way a decorative module could still take a
// launch down.
function bagOf(input) {
  return input && typeof input === 'object' ? input : {}
}

// A string fact, trimmed, or the fallback. Refused rather than coerced for the reason the
// header gives, and trimmed because RALPH_CODEX_MODEL is a value people edit by hand in a
// shell file where a trailing space is invisible.
function trimmedOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length ? trimmed : fallback
}

// A numeric fact, or the fallback. `typeof` first and no `Number(...)`: a string that looks
// like a number is not a number here, and coercing one would run a hostile `valueOf`. Zero
// and negatives are not windows, and neither is a NaN a JSON file is free to contain as null.
function positiveNumberOr(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return value
}
