// #69 — the two facts the identity box cannot simply be handed: which model the agent will
// use, and which repository the loop will read issues from.
//
// Every other row of that box is a lookup the caller already holds — a version out of
// package.json, a cwd out of argv, a cached version out of a JSON file. These two are
// questions rather than lookups, and each one has a different awkward answer:
//
//   WHICH MODEL. It cannot be known at launch. CLAUDE_ARGV carries no `--model` flag, Ralph
//   has no model setting of its own, and Claude Code exposes no way to ask before the first
//   turn. So the only honest evidence available is what the LAST run used, which the loop
//   already wrote to .ralph/metrics/issues.jsonl on its way past. For Codex there is not
//   even that: its stream carries no model id at all, so RALPH_CODEX_MODEL — the value the
//   loop passes on the command line — is the answer. Two different kinds of evidence, so
//   this module returns a `provenance` tag alongside the model and lib/banner-compose.js
//   words the row differently for each. That tag is the point of the whole module: the box
//   must never state a model with more confidence than its source warrants, which is a
//   correctness requirement here rather than a cosmetic one.
//
//   WHICH REPO. `gh` knows, but asking it costs a GraphQL round trip (see the `gh repo
//   view` in lib/commands/cycle.js) and this row is printed BEFORE the first preflight
//   line. So the slug is resolved from what is already on the disk and in the environment:
//   GH_REPO if it is set, otherwise origin's url out of .git/config. Both are read by the
//   caller and arrive here as strings.
//
// PURE, and asserted so by a static read in banner-model.test.js: no clock, no environment,
// no filesystem. The text of both files arrives as an argument, which is what makes every
// case in that spec a string literal instead of a fixture on disk (#41) — there is no
// .ralph directory, no git remote and no previous run anywhere in it.
//
// NEVER THROWS, on the same grounds as the rest of the banner: this is decoration in front
// of a loop that runs unattended for hours, and no row of it is worth losing a launch over.
// Every input is therefore type-checked rather than coerced — `String(value)` on a hostile
// bag runs its `toString`, and these values come from an ambient environment and two files
// nobody reads as bytes.

// The window map, IMPORTED rather than copied. lib/issue-event.js already owns "how big is
// this model's window" — it is the function that resolves `context_window` when an event is
// WRITTEN — and a second prefix map here is how the box and the log would come to disagree
// about the same model id. It costs this module no capability it did not already have:
// issue-event.js imports only agent-stream.js and is pure for the same reasons.
import { resolveContextWindow } from './issue-event.js'

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

// The metrics log's line tag, spelled here rather than imported. lib/issue-metrics.js owns
// the file and holds the same constant, but it is not exported and importing that module
// would hand this one node:fs — which is the one thing the purity spec next door forbids,
// and the reason this module takes the log's TEXT. One string literal duplicated against a
// line format that has been append-only since it shipped is the cheaper of the two costs.
const ISSUE_EVENT_TAG = 'RALPH_ISSUE_EVENT '

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
  const event = newestEvent(metricsText)
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

/**
 * The repository the loop will read issues from, resolved locally and cheaply.
 *
 * @param {object} [input]
 * @param {string} [input.ghRepo] GH_REPO, as the environment gave it. gh's own spelling is
 *   `[HOST/]OWNER/REPO`, so a host in front is dropped rather than refused.
 * @param {string} [input.gitConfigText] the text of `<cwd>/.git/config` — or anything at
 *   all, since the caller reads it best-effort and may have got nothing
 * @returns {string|null} `owner/name`, or null when it is not cheaply knowable. Never
 *   throws.
 */
export function resolveBannerRepo(input) {
  const { ghRepo, gitConfigText } = bagOf(input)
  // GH_REPO DECIDES WHEN IT IS SET, because it decides for `gh` — the loop's every issue
  // command reads it, so a box that named origin's slug while the loop read someone else's
  // would be wrong in precisely the situation this row was asked for (several checkouts, one
  // of them pointing somewhere unexpected). And when it is set to something that is not a
  // slug the answer is null rather than origin: naming a repo the loop will NOT use is worse
  // than naming none. A blank value is not "set" — that is how an exported-but-empty
  // variable reads to gh too.
  const configured = trimmedOr(ghRepo, '')
  if (configured) return configuredSlug(configured)
  return remoteSlug(originUrl(gitConfigText))
}

// GH_REPO, reduced to `owner/name`.
//
// A GRAMMAR OF ITS OWN, and that is the whole reason this is not `remoteSlug`: gh spells this
// variable `[HOST/]OWNER/REPO`, so THREE segments here means a host was given and is dropped,
// while three segments in a remote's PATH means the url is not a repository at all (its host
// was removed by the scheme parser long before the count). One function taking both would
// have to be told which rule it is applying, which is two functions wearing one name.
function configuredSlug(value) {
  const segments = value.split('/')
  return pathSlug(segments.length === HOST_AND_SLUG ? segments.slice(1).join('/') : value)
}

// `github.com/lucasfe/ralph` — a host and a slug, which is gh's other spelling.
const HOST_AND_SLUG = 3

// `[remote "origin"]`'s url, out of a git config file, or ''.
//
// PARSED RATHER THAN REGEXED WHOLE, because the grammar has three details a single pattern
// gets wrong: section names are case-insensitive while subsection names are not, keys are
// case-insensitive too, and `[core]` in every real file carries keys that a whole-file
// search for `url = ` would happily match. Line by line is also what makes "the LAST url in
// the origin section wins" fall out for free, which is how git itself resolves a repeated
// key.
//
// git's own grammar has more in it than this — line continuations, `[include]`, quoted
// values with escapes — and none of it is honoured here deliberately: this function's job is
// to recognize the file git WRITES, and to answer nothing at all for anything else. A
// missing answer costs one row; a wrong one puts a repo on the screen that the loop is not
// about to read.
function originUrl(text) {
  if (typeof text !== 'string') return ''
  let inOrigin = false
  let url = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = SECTION_LINE.exec(line)
    if (section) {
      inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin'
      continue
    }
    // A BRACKET LINE THIS PARSER CANNOT READ IS STILL A SECTION BOUNDARY, and failing closed
    // here is the difference between a missing row and a WRONG one. Every unrecognized header
    // is a header git accepts and this function does not — a trailing comment on it, git's
    // one-line `[section] key = value`, a hand-edited bracket — and leaving `inOrigin` alone
    // for one would attribute the NEXT section's keys to origin: a fork's config, whose
    // `[remote "upstream"] # the real one` follows origin, would put `them/repo` on the screen
    // while every gh command in the loop read `me/fork`. That is the multi-checkout confusion
    // this row was added to end, and the note above says a wrong answer is the one thing this
    // function may not give. Closing the section costs the safe direction nothing: an
    // unparsed header on origin ITSELF already opened nothing.
    if (line.startsWith('[')) {
      inOrigin = false
      continue
    }
    if (!inOrigin) continue
    const entry = KEY_LINE.exec(line)
    if (entry && entry[1].toLowerCase() === 'url') url = entry[2].trim()
  }
  return url
}

// `[remote "origin"]` — the section type, and the subsection name if there is one.
const SECTION_LINE = /^\[([\w.-]+)(?:\s+"([^"]*)")?\]$/
// `url = git@…`, `URL=git@…`. Values are taken raw and gated by the slug parser below.
const KEY_LINE = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/

// A remote's url, reduced to `owner/name` — or null if it is not one.
//
// TWO GRAMMARS, because git writes two: a url with a scheme, and the scp-like `user@host:path`
// that `git@github.com:owner/name.git` is. A url matching NEITHER is a path on this machine —
// `/srv/git/thing.git`, `../other` — and a `file://` url is one with a scheme; all of them are
// real remotes that are not repositories gh could read an issue from, so all of them answer
// null. Requiring a host is what does that work: `../other` split on `/` is two segments of
// ordinary characters and would otherwise pass for a slug.
function remoteSlug(url) {
  if (typeof url !== 'string' || !url.trim()) return null
  const remote = url.trim()
  const scheme = SCHEME_URL.exec(remote)
  if (scheme) {
    if (!REMOTE_SCHEMES.has(scheme[1].toLowerCase())) return null
    // Everything up to the first `/` is `[user[:password]@]host[:port]`, none of which the
    // slug needs — including a GitHub Enterprise host, because the host is not what a reader
    // is checking when they run Ralph in several checkouts.
    const path = scheme[2].indexOf('/')
    return path === -1 ? null : pathSlug(scheme[2].slice(path + 1))
  }
  if (SCP_URL.test(remote)) return pathSlug(remote.slice(remote.indexOf(':') + 1))
  return null
}

const SCHEME_URL = /^([A-Za-z][\w+.-]*):\/\/(.*)$/
const SCP_URL = /^(?:[^@/]+@)?[^/:]+:/
// The schemes git fetches a remote repository over. `file` is deliberately absent: a bundle
// or a local clone is a real remote and a real workflow, and it is not a repository `gh`
// could read an issue from.
const REMOTE_SCHEMES = new Set(['ssh', 'git', 'http', 'https'])

// `owner/name`, if that is exactly what this path is — after the two decorations git and
// GitHub both put on one: a `.git` suffix and a trailing slash.
//
// STRICT ON PURPOSE. Exactly two segments, each drawn from the characters GitHub allows in an
// owner or a repository name and neither of them a relative path step — so one segment
// (`https://github.com/owner`), three (`https://github.com/a/b/c`), a segment with a space in
// it, `../other` and an empty path (`git@github.com:`) all answer null. gh resolves its base
// repository from more than origin, so a missing answer here means "not cheaply knowable", not
// "no repo" — which is why dropping the row is the right degradation and printing `unknown`
// would not be.
function pathSlug(path) {
  const segments = path.replace(TRAILING_SLASHES, '').replace(DOT_GIT, '').split('/')
  if (segments.length !== 2 || !segments.every((segment) => SLUG_SEGMENT.test(segment))) {
    return null
  }
  return segments.join('/')
}

const TRAILING_SLASHES = /\/+$/
const DOT_GIT = /\.git$/i
// Word characters, dots and hyphens — but never dots ALONE, which is `.` or `..`.
const SLUG_SEGMENT = /^(?!\.+$)[\w.-]+$/

// The newest parseable event in the log, or null.
//
// FROM THE END, because the file is append-only and accumulates across runs: the interesting
// event is the last one, not the first. Parsed with exactly the discipline
// aggregateCycleCounts in lib/issue-metrics.js already applies to the same lines — the tag
// found with `indexOf` rather than `startsWith` (the loop pipes its output through tee and a
// pretty-printer, so a line can carry a prefix), and a parse that throws SKIPPED rather than
// propagated.
//
// A truncated trailing line is the NORMAL state of this file rather than an exceptional one:
// the loop appends with `>>` and can be killed mid-line. So can a line that parses to
// something that is not an event object at all — `null`, a number, an array — which is why
// the shape is checked and not just the parse.
function newestEvent(text) {
  if (typeof text !== 'string' || !text) return null
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const at = lines[index].indexOf(ISSUE_EVENT_TAG)
    if (at === -1) continue
    const event = parsedObject(lines[index].slice(at + ISSUE_EVENT_TAG.length))
    if (event) return event
  }
  return null
}

function parsedObject(json) {
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

// Which agent an event belongs to — see LEGACY_AGENT for why a missing field is a Claude run.
function agentOf(event) {
  return trimmedOr(event.agent, LEGACY_AGENT)
}

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
