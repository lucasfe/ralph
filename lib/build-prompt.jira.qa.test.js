import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join, relative } from 'node:path'
import { readFileSync } from 'node:fs'
import { buildPrompt } from './build-prompt.js'
import { resolveSource } from './task-source.js'
import { templatePath } from './paths.js'
// The docs sweep in section 6 is built from the SHARED primitives #53 already put in
// test/helpers/, not from a second copy: `claimText`/`repoMarkdown`/the pattern list from
// doc-guard.js, and `trackedFiles` — the repo's documented, fail-closed source enumerator —
// from source-control-bytes.js.
import { claimText, repoMarkdown, JIRA_AGENTLESS_CLAIM_PATTERNS, REPO_ROOT } from '../test/helpers/doc-guard.js'
import { trackedFiles } from '../test/helpers/source-control-bytes.js'
// The bound and the placeholder are IMPORTED rather than re-spelled: the cap the key is now
// subject to is one constant shared with the RALPH_AGENT echo, and a test that hardcoded 200
// would pass while the two silently disagreed.
import { DIAGNOSTIC_MAX_CHARS } from './one-line.js'

// QA companion to `describe('jira task source selection (#128)')` in lib/build-prompt.test.js.
// That suite owns the happy path — jira beats the agent template, the key reaches the four
// places the template names the ticket, no leftover placeholder, no stderr. This file attacks
// the two things #128 actually added to this module, and both are hostile-input seams:
//
//   1. `SOURCE_TEMPLATES` IS A PLAIN-OBJECT MAP INDEXED BY A USER-CONTROLLED STRING. The
//      ternary it replaced could only ever answer folder-or-not; a map lookup can answer
//      with something inherited. MEASURED, in this file rather than asserted from memory:
//      `({}).constructor` is a FUNCTION, so `SOURCE_TEMPLATES[key] ?? spec` never reaches the
//      `??` for `constructor`, and `templatePath(fn)` then throws
//      `TypeError: The "path" argument must be of type string`. What stops that is
//      `resolveSource`'s allowlist running FIRST — so the lookup is only ever handed one of
//      three literals. That ordering is the safety property, and the tests below prove it
//      end-to-end (through buildPrompt) rather than trusting the reading.
//
//   2. `RALPH_TASK_KEY` IS A VALUE A REMOTE SYSTEM CHOSE, and #128 is what puts it in a
//      rendered prompt. It arrives from acli's own JSON via `lib/jira-queue.js` → bash's
//      `export` → this module, and `lib/jira-key.js`'s `usableJiraKey` deliberately PASSES
//      THROUGH a key its grammar does not recognise (its header explains why: Jira names its
//      own tickets). So the prompt has to be pinned against keys that are not `FOO-123`:
//      absent, empty, padded, and carrying the characters that mean something in MARKDOWN
//      rather than in a shell.
//
//      WHEN THIS FILE WAS WRITTEN it measured `grep -c oneLine lib/build-prompt.js` as 0 and
//      pinned the consequences as hazards. #128's dev pass closed three of them, and the
//      tests that pinned those now assert the fix instead (each says so where it sits): the
//      key goes through `usableJiraKey` (lib/jira-key.js) and then `oneLineEcho`
//      (lib/one-line.js) — the same pair `queuePick` in lib/jira-queue.js and agent-registry.js:237
//      respectively already use — so a newline can no longer split the fenced command, a
//      padded key can no longer disagree with the loop's own log path, and a keyless jira
//      render now warns on stderr instead of rendering holes in silence. What is still NOT
//      sanitized is everything that means something to MARKDOWN rather than to a terminal:
//      backticks, fences and `{{…}}` all reach the prompt verbatim, and the rows below pin
//      that as the deliberate remainder.
//
// Control characters are built with String.fromCharCode — no literal control byte in this
// source, which test/source-control-bytes.test.js guards.
//
// NO TEST HERE SPAWNS ANYTHING. buildPrompt is pure given an injected `fs`; every template is
// copied into a memfs volume from the real one on disk, so the assertions are about the
// SHIPPED prompt text and not about a fixture.

const PROJECT = '/project'

function makeStderr() {
  const calls = []
  return {
    write: (m) => {
      calls.push(m)
      return true
    },
    calls,
  }
}

// Same volume the dev's suite builds, kept as its own copy rather than exported from there:
// a helper shared across files is a helper whose next edit silently retargets both.
function setupFs({ projectFiles = {} } = {}) {
  const vol = Volume.fromJSON({}, '/')
  vol.mkdirSync(templatePath('roles'), { recursive: true })
  for (const name of [
    'prompt-team.md',
    'prompt-team-codex.md',
    'prompt-team-folder.md',
    'prompt-team-jira.md',
    'roles/dev.md',
    'roles/qa.md',
    'roles/reviewer.md',
    'roles/writer.md',
    'roles/explorer.md',
  ]) {
    vol.writeFileSync(templatePath(name), readFileSync(templatePath(name), 'utf8'))
  }
  vol.mkdirSync(PROJECT, { recursive: true })
  for (const [k, v] of Object.entries(projectFiles)) vol.writeFileSync(join(PROJECT, k), v)
  return vol
}

// THE FIRST LINE, not a `toContain`. All four orchestrator headings start with
// `# Ralph Loop — Team orchestrator`, so `toContain('# Ralph Loop — Team orchestrator')` is
// true of every one of them and would pass whichever template was selected. The full first
// line is the only cheap discriminator.
const CLAUDE_H1 = '# Ralph Loop — Team orchestrator'
const CODEX_H1 = '# Ralph Loop — Team orchestrator (Codex)'
const FOLDER_H1 = '# Ralph Loop — Team orchestrator (folder mode)'
const JIRA_H1 = '# Ralph Loop — Team orchestrator (Jira mode)'

const headerLine = (out) => out.split(String.fromCharCode(10))[0]

const render = (env, { projectFiles, stderr } = {}) =>
  buildPrompt({ projectRoot: PROJECT, env, fs: setupFs({ projectFiles }), stderr })

const jiraRender = (key, opts) =>
  render(key === undefined ? { TASK_SOURCE: 'jira' } : { TASK_SOURCE: 'jira', RALPH_TASK_KEY: key }, opts)

// ---------------------------------------------------------------------------
// 1. The SOURCE_TEMPLATES map — every source × agent combination.
// ---------------------------------------------------------------------------
//
// The dev's suite checks jira×{claude,codex}, folder×codex and github×{claude,codex}. What it
// cannot show is that the map DID NOT change the arms nobody was thinking about: an unset
// source, a whitespace-only one, an unrecognized one, and a value that merely LOOKS like a map
// key. Those are the rows a `SOURCE_TEMPLATES[env.TASK_SOURCE]` written one line earlier — i.e.
// before normalization — would get wrong, and each of them is a silent wrong-template rather
// than an error.
describe('QA #128 SOURCE_TEMPLATES — the source × agent matrix', () => {
  // Expected header per (source, agent). The github column is agent-selected (that is the
  // pre-#565 behaviour this slice must not have touched); the folder and jira rows ignore the
  // agent entirely, which is the whole claim of the map.
  const SOURCES = [
    ['jira', JIRA_H1],
    ['JIRA', JIRA_H1],
    ['  jira  ', JIRA_H1],
    ['folder', FOLDER_H1],
    ['  FOLDER', FOLDER_H1],
    ['github', null],
    [undefined, null],
    ['', null],
    ['   ', null],
    // Not a source. `jira-cloud` is here specifically because a prefix or `startsWith`
    // match — a plausible way for somebody to "improve" the lookup later — would select the
    // jira orchestrator for it.
    ['gitlab', null],
    ['jira-cloud', null],
    ['jiraa', null],
  ]
  const AGENTS = [
    [undefined, CLAUDE_H1],
    ['claude', CLAUDE_H1],
    ['codex', CODEX_H1],
    ['  CODEX  ', CODEX_H1],
    // An unrecognized agent falls back to claude inside resolveAgent, which is why this row
    // shares an expectation with the two above it rather than being an error case.
    ['gpt-9', CLAUDE_H1],
  ]

  const rows = []
  for (const [source, sourceHeader] of SOURCES) {
    for (const [agent, agentHeader] of AGENTS) {
      rows.push([
        `TASK_SOURCE=${JSON.stringify(source)} RALPH_AGENT=${JSON.stringify(agent)}`,
        source,
        agent,
        sourceHeader ?? agentHeader,
      ])
    }
  }

  it.each(rows)('%s renders %#', (_label, source, agent, expected) => {
    const env = {}
    if (source !== undefined) env.TASK_SOURCE = source
    if (agent !== undefined) env.RALPH_AGENT = agent
    // Injected even though this row asserts nothing about it: the 15 jira rows set no
    // RALPH_TASK_KEY, so the real process.stderr default would print 15 keyless-render
    // warnings into the suite's own output. Selection is what this table measures; the
    // warning has its own tests below.
    expect(headerLine(render(env, { stderr: makeStderr() }))).toBe(expected)
  })

  it('covers all four orchestrators, so no row above is silently checking the same file', () => {
    // Anti-vacuity for the table: 60 rows that all resolved to one template would pass every
    // assertion above and prove nothing about selection.
    const seen = new Set(rows.map(([, , , expected]) => expected))
    expect([...seen].sort()).toEqual([CLAUDE_H1, CODEX_H1, FOLDER_H1, JIRA_H1].sort())
  })
})

// ---------------------------------------------------------------------------
// 2. A TASK_SOURCE that collides with Object.prototype.
// ---------------------------------------------------------------------------
describe('QA #128 SOURCE_TEMPLATES — a TASK_SOURCE that names an inherited property', () => {
  // The premise, MEASURED here rather than asserted about JS from memory: an own-property
  // check fails for these names while a bare `[key]` read returns something truthy. That is
  // what makes the negative tests below non-vacuous — the fallback is doing real work.
  const PROTO_KEYS = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']

  it('a bare map lookup WOULD return an inherited value for each of these names', () => {
    const map = { folder: 'prompt-team-folder.md', jira: 'prompt-team-jira.md' }
    for (const key of PROTO_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(map, key), key).toBe(false)
      // Truthy, so `map[key] ?? fallback` never reaches the fallback.
      expect(map[key] ?? 'FELL-BACK', key).not.toBe('FELL-BACK')
    }
  })

  it.each(PROTO_KEYS)('resolveSource folds TASK_SOURCE=%s to github before the lookup ever runs', (key) => {
    // The guard is resolveSource's allowlist (`VALID_SOURCES.includes`), not the map's shape.
    // Pinned on the normalizer directly so a future refactor that moves the lookup ahead of
    // the normalization has to break THIS test as well as the buildPrompt one below.
    expect(resolveSource({ TASK_SOURCE: key })).toBe('github')
  })

  it.each(PROTO_KEYS)('buildPrompt renders the agent template for TASK_SOURCE=%s and does not throw', (key) => {
    // A map read before normalization would hand `templatePath` a Function or
    // Object.prototype. MEASURED: that throws `TypeError: The "path" argument must be of type
    // string` out of node:path — so the failure mode is a dead loop iteration, not a subtly
    // wrong prompt. Either way the assertion is the same: the github arm, unharmed.
    const stderr = makeStderr()
    const out = buildPrompt({
      projectRoot: PROJECT,
      env: { TASK_SOURCE: key },
      fs: setupFs({ projectFiles: { 'PROMPT.md': '' } }),
      stderr,
    })
    expect(headerLine(out)).toBe(CLAUDE_H1)
    expect(out).not.toContain(JIRA_H1)
    expect(stderr.calls).toEqual([])
  })

  it.each(PROTO_KEYS)('renders TASK_SOURCE=%s to a prompt byte-identical to the unset one', (key) => {
    // Stronger than "does not contain the string": the github orchestrator has no
    // `{{TASK_SOURCE}}` site at all (MEASURED: the placeholder appears only in
    // prompt-team-folder.md:23 and prompt-team-jira.md:22), so a raw-name leak could only show
    // up somewhere unexpected. Byte-equality with the no-source render covers all of them at
    // once, including any site a later template edit adds.
    expect(render({ TASK_SOURCE: key })).toBe(render({}))
  })

  it('renders TASK_SOURCE as the RESOLVED name, so the agent is told the flow it is really in', () => {
    // The positive half, and the anti-vacuity anchor for the row above: the placeholder DOES
    // get substituted where it exists, and with resolveSource's normalized value — `  JIRA  `
    // renders `jira`, not the raw string. That line is how the agent knows which flow it is in.
    expect(render({ TASK_SOURCE: '  JIRA  ', RALPH_TASK_KEY: 'FOO-9' })).toContain(
      'Task source: `jira`. Your ticket is **`FOO-9`**',
    )
    expect(render({ TASK_SOURCE: 'FOLDER' })).toContain('Task source: `folder`')
  })
})

// ---------------------------------------------------------------------------
// 3. The absent / empty / padded key — pinned hazards.
// ---------------------------------------------------------------------------
//
// `RALPH_TASK_KEY: env.RALPH_TASK_KEY ?? ''` — `??` does not default an empty string, and the
// suite already pins that exact quirk for RALPH_HEAVY_TIER. For the tier it renders a cosmetic
// blank; here it rendered a prompt whose every mention of the ticket was a HOLE, with no
// warning on stderr and no leftover placeholder for the dev's `/\{\{[A-Z_]+\}\}/` sweep to
// catch. THE PROMPT STILL RENDERS THOSE HOLES — a throw here would turn a nameless ticket into
// a dead loop iteration, which is the one outcome the jira arm is written to avoid — but as of
// #128 the render is no longer SILENT, and that is what the rows below now pin.
describe('QA #128 RALPH_TASK_KEY absent or empty — what the agent is actually told', () => {
  it('renders the same prompt bytes whether the key is unset or empty, but says which on stderr', () => {
    // The PROMPT still collapses the two states, deliberately: both are "no ticket", and there
    // is no honest thing to write into `--key` for either. What #128 added is a channel where
    // they are distinguishable, because the two have different causes — "bash never exported a
    // key" (a non-jira shell that set TASK_SOURCE by hand) versus "a jira arm exported an empty
    // one" (a pick that produced nothing) — and an operator reading the run log needs to know
    // which one happened.
    const unset = makeStderr()
    const empty = makeStderr()
    expect(jiraRender(undefined, { stderr: unset })).toBe(jiraRender('', { stderr: empty }))
    expect(unset.calls).toHaveLength(1)
    expect(empty.calls).toHaveLength(1)
    expect(unset.calls[0]).toContain('unset')
    expect(empty.calls[0]).toContain("''")
    expect(unset.calls[0]).not.toBe(empty.calls[0])
  })

  it('tells the agent to view a work item with NO KEY, and now WARNS about it (#128 fix)', () => {
    // WAS `and warns nobody` — this row pinned the hazard, and the assertion on the last line
    // is the one that flipped. The literal render is unchanged and still spelled out, because
    // it is what an agent is handed when a jira iteration loses its key: a well-formed
    // instruction to run a command with a missing argument, and a commit message with an empty
    // parenthetical. Eight of the thirteen {{RALPH_TASK_KEY}} sites (MEASURED: `grep -o` counts
    // 13 in templates/prompt-team-jira.md; it was 9 before #129 added step 7). Two of the eight
    // are new and are the loudest of the lot: an empty key renders `complete ""` and
    // `comment "" "<body>"`, which those verbs refuse by value rather than running — see
    // lib/jira-queue.js's key guards — so the warning below is still the only thing that tells
    // anybody why. The EMPTY QUOTES are the shape review round 1 asked for: an unquoted empty
    // key rendered `complete` with no argument at all, which the CLI reads as a usage error
    // (exit 2) rather than as the unusable key it is.
    const stderr = makeStderr()
    const out = jiraRender('', { projectFiles: { 'PROMPT.md': '' }, stderr })
    expect(out).toContain('Your ticket is **``**')
    expect(out).toContain('acli jira workitem view --key  --fields "*all" --json')
    expect(out).toContain('"fix: <description> ()"')
    expect(out).toContain('   Resolves ' + String.fromCharCode(10))
    expect(out).toContain('logs/ralph-issue-.log')
    expect(out).toContain('jira-queue.js" complete ""')
    expect(out).toContain('jira-queue.js" comment "" "<body>"')
    expect(out).toContain('NEVER write to `` with `acli` yourself')
    // The fix. interpolate() still has nothing to report — the key is PRESENT in the vars bag,
    // just empty, so no unknown-placeholder warning and no leftover token could ever have
    // caught this — so the warning has to come from buildPrompt itself, on the same injected
    // `stderr` seam every other test in this file reads.
    expect(stderr.calls).toHaveLength(1)
    expect(stderr.calls[0]).toContain('TASK_SOURCE=jira')
    expect(stderr.calls[0]).toContain('RALPH_TASK_KEY')
    // ONE line, terminated: this shares a stream with the agent's own output.
    expect(stderr.calls[0].endsWith(String.fromCharCode(10))).toBe(true)
    expect(stderr.calls[0].split(String.fromCharCode(10)).filter(Boolean)).toHaveLength(1)
    expect(out).not.toContain('{{RALPH_TASK_KEY}}')
    expect(out).not.toMatch(/\{\{[A-Za-z_]/)
  })

  it('normalizes a padded key, so the prompt and the loop`s own log path agree (#128 fix)', () => {
    // WAS `does not trim a padded key — the padding lands inside the acli argv`. The divergence
    // was real and reachable: nothing trimmed an AMBIENT RALPH_TASK_KEY, while the loop's
    // `$task_key` is post-`usableJiraKey` (`queuePick` in lib/jira-queue.js runs it on the pick,
    // as do `claimTask`, `completeTask` and `commentTask` on the key they are handed), so the
    // prompt could quote `logs/ralph-issue-  FOO-123  .log` for a file bash had written as
    // `logs/ralph-issue-FOO-123.log`. buildPrompt now runs the SAME function, so the two agree
    // by construction rather than by both happening to be handed a tidy value.
    const out = jiraRender('  FOO-123  ')
    expect(out).toContain('Your ticket is **`FOO-123`**')
    expect(out).toContain('acli jira workitem view --key FOO-123 --fields')
    expect(out).toContain('logs/ralph-issue-FOO-123.log')
    expect(out).not.toContain('  FOO-123  ')
  })

  it('renders a lowercase key in Jira`s own spelling, the way the record and the argv do', () => {
    // The other half of `usableJiraKey`: the project key is uppercased and the NUMBER is left
    // exactly as written (leading zeros and all — renumbering it would ask about a different
    // ticket). Pinned here because it is the visible consequence of routing through that
    // module rather than through a bespoke trim.
    const out = jiraRender('  foo-007  ')
    expect(out).toContain('acli jira workitem view --key FOO-007 --fields')
    expect(out).not.toContain('foo-007')
  })

  it('leaves the OTHER two sources unable to leak a stale key into their prompts', () => {
    // The github and folder orchestrators name no ticket key, so an ambient RALPH_TASK_KEY —
    // which a jira run in the same shell would have exported — cannot reach either prompt.
    // MEASURED on the rendered output, since "the template has no placeholder" is exactly the
    // kind of claim that a template edit breaks silently. Since #128 there is a SECOND guard
    // behind that one: buildPrompt only reads the env var at all when the resolved source is
    // jira, so a template edit that added the placeholder to either of these would render a
    // blank rather than somebody's stale ticket.
    for (const [source, header] of [
      ['github', CLAUDE_H1],
      ['folder', FOLDER_H1],
    ]) {
      const out = render({ TASK_SOURCE: source, RALPH_TASK_KEY: 'QA-STALE-9999' })
      expect(headerLine(out), source).toBe(header)
      expect(out, source).not.toContain('QA-STALE-9999')
      // Anti-vacuity: a truncated render would also "not contain" it.
      expect(out.length, source).toBeGreaterThan(5000)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. A hostile key reaching the rendered prompt.
// ---------------------------------------------------------------------------
//
// test/loop.jira.adversarial.test.js already proves bash does not EXECUTE a hostile key: it is
// always one quoted argument. #128 opens the other half of that surface — the same value is now
// pasted into MARKDOWN a model reads as instructions — and the characters that matter there are
// different ones. Two classes, and #128 answers only one of them:
//
//   • Characters that END A LINE or DRIVE A TERMINAL are replaced, one code point for one,
//     because `oneLineEcho` is now in the path. That is the class that could forge a whole
//     extra line of instruction, so it is the class that got fixed.
//   • Characters that mean something to MARKDOWN — backticks, fences, `{{…}}` — are NOT, and
//     the rows below pin that as the deliberate remainder rather than an oversight: a fence in
//     a key is inert text on a line the reader can see, and neutering markdown would mean this
//     module deciding how a prompt is written.
describe('QA #128 RALPH_TASK_KEY carrying markdown that means something', () => {
  const LF = String.fromCharCode(10)
  const REPLACEMENT = String.fromCharCode(0xfffd)

  it('collapses a NEWLINE in the key so step 1 stays ONE command in the fenced block (#128 fix)', () => {
    // WAS `lets a key containing a NEWLINE split step 1 into two commands inside the fenced
    // block`, and it was the strongest row in this file. `usableJiraKey` TRIMS but does not
    // reject interior whitespace (lib/jira-key.js: the grammar validates and never gates), so
    // the key still arrives whole — what changed is that `oneLineEcho` then replaces the LF
    // with U+FFFD, so the fenced code block in step 1 is one line again and the injected tail
    // sits ON it as inert text instead of UNDER it as a second shell line carrying the rest of
    // Ralph's own flags. Bash was always safe here (one quoted argument, pinned in
    // test/loop.jira.adversarial.test.js); the PROMPT is what #128 fixed.
    const out = jiraRender('FOO-1' + LF + 'rm -rf /')
    const fenceLines = out.split(LF)
    const viewIdx = fenceLines.findIndex((l) => l.includes('acli jira workitem view --key FOO-1'))
    expect(viewIdx).toBeGreaterThan(-1)
    expect(fenceLines[viewIdx].trim()).toBe(
      `acli jira workitem view --key FOO-1${REPLACEMENT}rm -rf / --fields "*all" --json`,
    )
    // The line AFTER the read is the closing fence again, which is the whole property.
    expect(fenceLines[viewIdx + 1].trim()).toBe('```')
    // And it is fixed at the SOURCE, not at this one site: no line anywhere in the render ends
    // with the key's first half, so none of the other twelve sites split either.
    expect(fenceLines.some((l) => l.endsWith('FOO-1'))).toBe(false)
    expect((out.match(/rm -rf \//g) || []).length).toBe(13)
  })

  it('lets a key containing a fence marker close the step-1 code block early', () => {
    // STILL PINNED AS A HAZARD, and deliberately so: `oneLineEcho` replaces only what can end
    // a line or drive a terminal, and a backtick is neither. The damage is bounded in a way the
    // newline's was not — the text stays on the line a reader is looking at.
    const out = jiraRender('A' + '```' + 'B')
    expect(out).toContain('acli jira workitem view --key A```B --fields')
  })

  it('does NOT re-interpolate a placeholder embedded in the key (single pass), and warns about none of it', () => {
    // Mirrors the existing {{ROLE_WRITER}} / {{RALPH_HEAVY_TIER}} PROMPT.md precedents, one
    // level closer to the attacker: the token is inside the injected VALUE. interpolate()
    // replaces in one pass and never re-scans a replacement, so the token survives literally.
    // MEASURED count: thirteen, one per `{{RALPH_TASK_KEY}}` site in templates/prompt-team-jira.md
    // (`grep -o '{{RALPH_TASK_KEY}}' | wc -l` → 13; it was 9 before #129 added step 7).
    const stderr = makeStderr()
    const out = jiraRender('{{RALPH_HEAVY_TIER}}', { projectFiles: { 'PROMPT.md': '' }, stderr })
    expect((out.match(/\{\{RALPH_HEAVY_TIER\}\}/g) || []).length).toBe(13)
    // The template's OWN tier line still resolved — the survivors are all injected copies.
    expect(out).toContain('Current effort tier: `0`')
    expect(stderr.calls).toEqual([])
  })

  it('does not let a key impersonate a role composition slot', () => {
    // The five {{ROLE_*}} slots are filled by `.replace()` BEFORE interpolate runs, so a key
    // naming one arrives too late to be expanded — the role is composed once, from its own
    // file, and the key stays literal text.
    const out = jiraRender('{{ROLE_DEV}}')
    expect(out).toContain('## Dev specialist')
    expect((out.match(/\{\{ROLE_DEV\}\}/g) || []).length).toBe(13)
  })

  it('caps a very long key at the same bound as the RALPH_AGENT echo (#108), visibly (#128 fix)', () => {
    // WAS `does not truncate or sanitize a very long key, unlike the RALPH_AGENT echo (#108)`,
    // which pinned the divergence. #128 chose to CONVERGE: the key goes through the same
    // `oneLineEcho` lib/agent-registry.js:237 uses, so it inherits that module's single
    // DIAGNOSTIC_MAX_CHARS bound rather than a second jira-specific one.
    //
    // The bound matters more here than it does there, and for a different reason: the value
    // lands in THIRTEEN sites (MEASURED: `grep -o '{{RALPH_TASK_KEY}}'
    // templates/prompt-team-jira.md | wc -l` → 13, up from 9 when #129 added step 7's two
    // `jira-queue.js` calls), so an N-character key is 13N characters of remote-chosen text in the
    // context. And the truncation is VISIBLE — `cap` ends the value with `…`, which no key
    // contains — so the agent's own `acli … view` fails on a name that is obviously not one,
    // rather than on a plausible key naming a different ticket.
    const key = 'F'.repeat(5000) + '-1'
    const capped = 'F'.repeat(DIAGNOSTIC_MAX_CHARS - 1) + '…'
    const out = jiraRender(key)
    expect(out).not.toContain(key)
    expect(out).toContain('acli jira workitem view --key ' + capped + ' --fields')
    // All thirteen sites carry the capped value — `split` rather than a regex, because the needle
    // is 200 characters of literal text and one of them is a metacharacter-free ellipsis.
    expect(out.split(capped).length - 1).toBe(13)
  })

  it('does not re-interpolate a literal {{RALPH_TASK_KEY}} written in the project PROMPT.md', () => {
    // PROMPT.md is injected as {{PROJECT_PROMPT}} in the same single pass, so a project that
    // documents the token keeps it verbatim and the orchestrator's own thirteen sites still
    // resolve. No warning, because the token was never scanned.
    const projectPrompt = '## Stack' + LF + 'Our runbook cites {{RALPH_TASK_KEY}} by name.'
    const stderr = makeStderr()
    const out = jiraRender('FOO-123', { projectFiles: { 'PROMPT.md': projectPrompt }, stderr })
    expect(out).toContain(projectPrompt)
    expect((out.match(/\{\{RALPH_TASK_KEY\}\}/g) || []).length).toBe(1)
    expect(out).toContain('acli jira workitem view --key FOO-123')
    expect(stderr.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Prose invariants that must not drift.
// ---------------------------------------------------------------------------
//
// Every negative below is anchored: the region is asserted NON-TRIVIAL first, or the same
// assertion is shown to be TRUE of another template. An unanchored `not.toContain` on a slice
// that silently became empty is the vacuity trap this repo's own conventions call out.
describe('QA #128 the jira orchestrator says nothing it must not say', () => {
  const jira = () => render({ TASK_SOURCE: 'jira', RALPH_TASK_KEY: 'FOO-123', TEST_CMD: 't', LINT_CMD: 'l' })
  const github = () => render({ TEST_CMD: 't', LINT_CMD: 'l' })

  it('mentions the word `gh` NOWHERE in the fully composed prompt, roles included', () => {
    // The dev's suite checks `gh issue` / `gh pr create` / `gh pr merge`. This is the whole
    // claim: MEASURED, `grep -cE '\bgh\b' templates/prompt-team-jira.md` is 0, and it stays 0
    // once the five roles are composed in. Anchored against the github render, where the same
    // pattern MUST match — otherwise a broken regex would pass both halves.
    expect(jira()).not.toMatch(/\bgh\b/)
    expect(github()).toMatch(/\bgh\b/)
  })

  it('asks for NO acli write at all now that #129 owns every board write', () => {
    // WAS `asks for no acli WRITE except the failure-path comment`, and the exception is what
    // #129 removed: the failure comment used to be a hand-rolled `acli jira workitem comment`,
    // and it is now `node lib/jira-queue.js comment`, the same verb step 7 uses. So the claim
    // tightened rather than moved — every board write in this template goes through Ralph's own
    // module, and the ONLY `acli jira workitem` subcommand left anywhere in it is the step-1
    // READ. Not a keyword search: the template still names transitions and labels in its
    // PROHIBITIONS, so what is asserted is that no write COMMAND is spelled out.
    const out = jira()
    const subcommands = [...out.matchAll(/acli jira workitem ([a-z]+)/g)].map((m) => m[1])
    expect([...new Set(subcommands)]).toEqual(['view'])
    // Anchored: the writes ARE present, through the verb that owns their flags. Without this
    // the assertion above would also pass a template that had lost its board bookkeeping.
    expect(out).toContain('lib/jira-queue.js" complete "FOO-123"')
    expect(out).toContain('lib/jira-queue.js" comment "FOO-123"')
  })

  it('never asks the agent to add `in-progress` or to re-claim the ticket', () => {
    const out = jira()
    // The positive first, so the negatives below are read against a section that exists.
    expect(out).toContain('**The ticket is already claimed — claim nothing**')
    expect(out).toContain('Add NO label here')
    expect(out).not.toMatch(/add the `in-progress` label/i)
    expect(out).not.toMatch(/label it `in-progress`/i)
  })

  it('carries no folder-mode task lane and no folder-mode hitl lane', () => {
    // The two templates are siblings; these are the folder-only paths that would read as
    // instructions to touch a directory tree a jira repo does not have.
    const out = jira()
    const folderOut = render({ TASK_SOURCE: 'folder' })
    for (const lane of ['.ralph/tasks/', '.ralph/tasks/hitl/', 'afk/todo', 'afk/done']) {
      expect(folderOut, lane).toContain(lane)
      expect(out, lane).not.toContain(lane)
    }
  })

  it('promises no push, and says the commit stays local instead', () => {
    // MEASURED: `grep -c push templates/ralph.sh` is 0 — the loop pushes on NO arm — so the
    // folder template's "The bash pushes ... for you" is false and must not have been copied.
    const out = jira()
    expect(out).toMatch(/commit stays local/i)
    expect(out).not.toMatch(/bash pushes/i)
    expect(out).not.toMatch(/git push (?!--force|-f)/)
    expect(render({ TASK_SOURCE: 'folder' })).toMatch(/bash pushes/i)
  })

  it('leaves no placeholder of ANY case behind under a fully populated adversarial env', () => {
    // The dev's sweep is `/\{\{[A-Z_]+\}\}/`, which would miss `{{Role_Dev}}` or
    // `{{ralph_task_key}}`. interpolate's own PLACEHOLDER regex accepts a leading lowercase
    // letter, so the honest sweep is the suite's broader `/\{\{[A-Za-z_]/`. Run with a
    // NON-EMPTY PROMPT.md so {{PROJECT_PROMPT}} is a real substitution rather than a blank.
    const stderr = makeStderr()
    const out = buildPrompt({
      projectRoot: PROJECT,
      env: {
        TASK_SOURCE: 'jira',
        RALPH_TASK_KEY: 'FOO-123',
        RALPH_AGENT: 'codex',
        RALPH_HEAVY_TIER: '1',
        INSTALL_CMD: 'poetry install',
        TEST_CMD: 'pytest -q',
        LINT_CMD: 'ruff check',
        MAIN_BRANCH: 'trunk',
        DEV_BRANCH: 'integration',
        PR_TARGET: 'trunk',
        MERGE_STRATEGY: 'rebase',
      },
      fs: setupFs({ projectFiles: { 'PROMPT.md': '## Stack' + String.fromCharCode(10) + 'Python' } }),
      stderr,
    })
    expect(out).not.toMatch(/\{\{[A-Za-z_]/)
    expect(stderr.calls).toEqual([])
    // ...and the values really did land, so the sweep above is not passing on an empty string.
    expect(out).toContain('pytest -q')
    expect(out).toContain('git checkout integration')
    expect(out).toContain('## Stack')
  })
})

// ---------------------------------------------------------------------------
// 6. No document still says this slice's work does not happen.
// ---------------------------------------------------------------------------
//
// WHY THIS SWEEP EXISTS, and it is a review finding rather than a precaution. #128 made the
// jira arm dispatch the agent, which falsified the sentence "no agent is invoked for a Jira
// ticket" everywhere it was written — and the dev pass corrected TWO hunks of README.md while
// FIVE more copies of the same claim stood, plus the one in lib/task-source.js, the registry a
// reader opens first. The file then argued both sides of itself. THE CAUSE, measured while the
// falsehoods were still standing: `grep -rn 'no agent is invoked' --include='*.test.js' .`
// returned NOTHING, so not one test anywhere pinned that prose — which is exactly how five
// falsehoods outlived the change that falsified them. This section is the reason that grep
// answers today: MEASURED after the fix, the only places left in the repo that spell any of
// those sentences are this file's positive control, the pattern list's own documentation, and
// lib/digest.js's two honest uses about a run that never started — no doc and no other module.
//
// THREE SURFACES, because the argument is made on all three. Markdown comes from
// `repoMarkdown()`, which ENUMERATES rather than lists so a stale claim cannot hide in a doc
// file added later; the `.js` comments and the `.sh` ones come from `trackedFiles()`, which is
// git's answer rather than a walk's and throws instead of sweeping nothing. The `.sh` half is
// not padding: templates/ralph.config.sh makes this same argument to the user in a 40-line
// comment block above `TASK_SOURCE`, which is the first place a `--source jira` repo reads it.
describe('QA #128 no doc or comment still claims a jira ticket gets no agent', () => {
  // The two files that MUST contain the forbidden sentences in order to do their job: the
  // module that defines the patterns, and this file, which spells the pre-fix wording out as a
  // positive control below. The exclusion is derived rather than a convenience list — each is
  // the definition site of the very strings under ban — and the anchor test proves both really
  // do match, so an entry that stops earning its place shows up as a failure.
  const SELF_REFERENTIAL = [join('test', 'helpers', 'doc-guard.js'), join('lib', 'build-prompt.jira.qa.test.js')]

  const swept = () => {
    const md = repoMarkdown()
    const code = trackedFiles()
      .map((abs) => relative(REPO_ROOT, abs))
      .filter((rel) => rel.endsWith('.js') || rel.endsWith('.sh'))
    return [...md, ...code].filter((rel) => !SELF_REFERENTIAL.includes(rel))
  }

  it.each(SELF_REFERENTIAL)('%s is excluded because it really does carry the banned strings', (rel) => {
    // The anchor the comment above promises. Read off DISK, not quoted here: an exclusion
    // justified by "this file defines the strings" is only honest while that stays true, and
    // rewording doc-guard.js's header would otherwise leave a file permanently unswept with
    // nothing saying so. Both are read the same way the sweep reads its own files, so the two
    // agree by construction. (This file is untracked until #128 lands, so `trackedFiles()`
    // cannot see it yet — which is precisely why the anchor reads the path directly.)
    const text = claimText(readFileSync(join(REPO_ROOT, rel), 'utf8'))
    expect(JIRA_AGENTLESS_CLAIM_PATTERNS.some((p) => p.test(text)), rel).toBe(true)
  })

  it('sweeps the real surface (the negative guard is not vacuous)', () => {
    const files = swept()
    // The five files that carried, or could carry, the claim — README.md and the registry are
    // where review found it, and the template, the config's comment block and the arm's tests
    // are where it would land next.
    expect(files).toContain('README.md')
    expect(files).toContain(join('templates', 'prompt-team-jira.md'))
    expect(files).toContain(join('templates', 'ralph.config.sh'))
    expect(files).toContain(join('lib', 'task-source.js'))
    expect(files).toContain(join('test', 'loop.jira.adversarial.test.js'))
    // Floors, not equalities, so adding a doc or a module does not redden the suite — but a
    // walk that collapses to a handful of root files does.
    expect(files.filter((f) => f.endsWith('.md')).length).toBeGreaterThanOrEqual(14)
    expect(files.filter((f) => f.endsWith('.js')).length).toBeGreaterThanOrEqual(150)
    expect(files.filter((f) => f.endsWith('.sh')).length).toBeGreaterThanOrEqual(2)
  })

  it.each(swept())('%s claims no such thing', (rel) => {
    // `claimText` and not `prose`: every real spelling of this claim was wrapped in markdown
    // emphasis (`**No agent is invoked…**`) or split across two `//` lines, and the
    // plain-phrase grep that hunted them missed one for exactly that reason.
    const text = claimText(readFileSync(join(REPO_ROOT, rel), 'utf8'))
    for (const pattern of JIRA_AGENTLESS_CLAIM_PATTERNS) {
      expect(text, `${rel} matched ${pattern}`).not.toMatch(pattern)
    }
  })

  it('the patterns really do catch every sentence #128 had to delete', () => {
    // Positive control, and these are not invented: each is the VERBATIM text that stood in
    // the repo when review gated this slice, so the sweep above is proven to be doing work
    // rather than testing regexes that can never fire.
    const deleted = [
      '**No agent is invoked for a Jira ticket**, so nothing is coded, committed or opened as a PR',
      'selects the oldest eligible ticket and claims it; **no agent is\ninvoked**, so the work itself is still missing',
      'But with no agent invoked it is also *all* a run does',
      'each iteration selects the oldest eligible ticket, records it and labels it `in-progress` — but **no agent is invoked**',
      'selects a ticket and claims it, and invokes no agent on it, so a green `jira auth`',
      '// picks a ticket and claims it with the `in-progress` label. No agent is invoked\n// for one yet, so the work itself is still missing.',
      'the loop exits `Queue empty` having labelled the tickets and worked none of them',
      '**`jira` is flag-only**, which is deliberate while it resolves no ticket',
    ]
    for (const sentence of deleted) {
      const text = claimText(sentence)
      expect(
        JIRA_AGENTLESS_CLAIM_PATTERNS.some((p) => p.test(text)),
        sentence,
      ).toBe(true)
    }
  })

  it('leaves honest prose about an absent agent alone', () => {
    // THE CONSTRAINT THAT KEEPS THIS NARROW, and it is a real sentence in a real module rather
    // than a hypothetical: lib/digest.js says "no agent invoked" twice about a run that never
    // STARTED, which is true and must stay sayable. So is every "no PR" / "nothing pushes"
    // sentence about this source, all of which are still accurate. A pattern list that reddened
    // any of these would force the docs to get vaguer to stay green.
    const honest = [
      "//   'no-run' — nothing has ever run here; no agent invoked, no entry written",
      '// NOTHING HAS EVER RUN HERE. One honest line and out — no agent invoked and no\n// history entry',
      'commits straight to `DEV_BRANCH` — no feature branch, no PR, no auto-merge, and nothing pushes',
      'Jira mode opens no PRs.',
      'no `gh` command runs in a `jira` iteration',
      'A `jira` run works one ticket per iteration and reports nothing back to the board.',
    ]
    for (const sentence of honest) {
      const text = claimText(sentence)
      const fired = JIRA_AGENTLESS_CLAIM_PATTERNS.filter((p) => p.test(text))
      expect(fired, `${sentence} matched ${fired}`).toEqual([])
    }
    // And the two digest.js lines are read off the REAL module, not just quoted here — a
    // reworded comment there must re-prove itself against this guard.
    const digest = claimText(readFileSync(join(REPO_ROOT, 'lib', 'digest.js'), 'utf8'))
    expect(digest).toContain('no agent invoked')
    for (const pattern of JIRA_AGENTLESS_CLAIM_PATTERNS) {
      expect(digest, `lib/digest.js matched ${pattern}`).not.toMatch(pattern)
    }
  })
})
