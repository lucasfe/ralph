// #202 — the `homebrew` job in .github/workflows/release.yml, and the tap probe it
// runs.
//
// WHY A SPEC OVER A WORKFLOW FILE AT ALL. This job is the release gate the whole
// Homebrew feature exists for, and every property #202 asks of it is a property of
// the *graph and the step order*, not of anything a unit test can call: that it is a
// SIBLING of the npm `publish` job rather than a dependent, that the three `brew`
// pre-flight commands run BEFORE the push, that the push is gated on a secret that
// does not exist yet. None of that can be exercised locally — a macOS runner and a
// real tap are the only place it executes — so the honest instrument is the one the
// repo already uses for claims about its own text: read the file, parse it, assert a
// property, name the offender. See CONTRIBUTING's "What a static source sweep may be
// asked (#119)" for the boundary. "Is `homebrew` downstream of `publish`" is exactly
// the kind of question a sweep answers exactly.
//
// THE GRAPH IS READ FROM THE RESOLVED YAML, NOT FROM A GREP. #202 asks for the
// dependency to be verified "by reading the resolved graph, not by intent", so this
// file parses release.yml with `yaml` (a devDependency; package.json's `files` is an
// allow-list, so it never ships) and walks `needs` transitively. A grep for
// `needs: release-please` would pass just as happily on `needs: [release-please,
// publish]`.
//
// THE TAP PROBE IS DRIVEN FOR REAL, because the one case #202 singles out is the one
// a text assertion cannot see: an EMPTY tap. lucasfe/homebrew-ralph exists with no
// commits, and that state was measured rather than assumed —
// `git clone --depth 1 https://github.com/lucasfe/homebrew-ralph` exits 0 under
// git 2.50.1, prints "warning: You appear to have cloned an empty repository." on
// stderr, and leaves a directory holding nothing but .git/, whose HEAD is a symref
// to `main`. `git init --bare --initial-branch=main` reproduces that byte for byte
// locally (same exit status, same empty tree, same symref), so the probe specs below
// build their own taps and use the real `git` rather than reaching for the network.
//
// Two of the API-shaped probes were rejected for this job and are recorded so they
// are not "restored" as simplifications, both measured against the real empty tap:
// `gh api repos/lucasfe/homebrew-ralph/contents/Formula/ralph.rb` exits **1** with
// `{"message":"This repository is empty."}`, and `gh api .../commits` answers HTTP
// **409**. Either would have to have its failure swallowed to mean "no", and a
// swallowed failure cannot tell an empty tap from a broken one. A clone that exits 0
// can.

import { describe, expect, it, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { renderFormula, tagTarballUrl } from '../scripts/lib/render-homebrew-formula.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release.yml')
const TAP_PLAN = join(REPO_ROOT, 'scripts', 'homebrew-tap-plan.js')
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

const SOURCE = readFileSync(WORKFLOW, 'utf8')
const WORKFLOW_YAML = parse(SOURCE)
const JOBS = WORKFLOW_YAML?.jobs ?? {}
const HOMEBREW = JOBS.homebrew
const PUBLISH = JOBS.publish

/** `needs:` as an array, whichever of YAML's two spellings was used. */
function needsOf(job) {
  const needs = job?.needs
  if (needs === undefined || needs === null) return []
  return Array.isArray(needs) ? needs : [needs]
}

/**
 * Every job the named one waits for, transitively — the resolved graph, which is
 * what "is `homebrew` downstream of `publish`" is a question about. A direct `needs`
 * read cannot answer it: `needs: [release-please]` would still be downstream of
 * `publish` if `release-please` ever grew a `needs: publish` of its own.
 */
function resolvedNeeds(name, seen = new Set()) {
  for (const parent of needsOf(JOBS[name])) {
    if (seen.has(parent)) continue
    seen.add(parent)
    resolvedNeeds(parent, seen)
  }
  return seen
}

/**
 * The verbatim text of one job, comments included, so a claim about the *prose* in
 * the file can be asserted. Cut from the `jobs:` block by the only indentation a job
 * key ever has (two spaces, nothing after the colon) and ending at the next such key
 * — a job body is indented four or more, so nothing inside one can be mistaken for
 * the start of the next.
 *
 * THROWS rather than returning '' on a name it cannot find, following the argument in
 * CONTRIBUTING's "A spec that cannot go red (#122)": a slicer that fails open turns
 * every search over its output into a tautology.
 */
function jobSource(name) {
  const jobsAt = SOURCE.indexOf('\njobs:\n')
  if (jobsAt < 0) throw new Error(`${WORKFLOW} has no top-level \`jobs:\` block`)
  const region = SOURCE.slice(jobsAt + 1)
  const starts = [...region.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)]
  const at = starts.findIndex((match) => match[1] === name)
  if (at < 0) {
    throw new Error(
      `${WORKFLOW} declares no job named \`${name}\`; it declares ` +
        `${starts.map((match) => match[1]).join(', ')}`,
    )
  }
  const end = at + 1 < starts.length ? starts[at + 1].index : region.length
  return region.slice(starts[at].index, end)
}

/**
 * The workflow with every comment line dropped — the YAML that configures the run,
 * and the shell that executes in it, with the prose taken out.
 *
 * Two assertions below sweep for an anti-pattern the file is EXPECTED to NAME:
 * `continue-on-error`, because the homebrew job argues at length that the run must
 * stay red, and `git archive`, because it records the two digests that differ. Over
 * the raw bytes those sweeps would go red on the warning rather than on the mistake —
 * a spec that cannot stay green while the file is correct. Whole-line comments only,
 * which is all this workflow has; shared between the two so they cannot drift apart.
 */
function runnableLines() {
  return SOURCE.split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

const steps = () => (Array.isArray(HOMEBREW?.steps) ? HOMEBREW.steps : [])
const runOf = (step) => (typeof step?.run === 'string' ? step.run : '')
/** Index of the first step whose `run` holds the needle, or -1. */
const stepRunning = (needle) => steps().findIndex((step) => runOf(step).includes(needle))
const ifOf = (step) => (typeof step?.if === 'string' ? step.if : '')

const isCommentLine = (line) => /^\s*#/.test(line)
/** One step's `run` with the shell's own comment lines dropped: what it executes. */
const commandsOf = (step) => runOf(step).split('\n').filter((line) => !isCommentLine(line)).join('\n')

/**
 * The post-push smoke step (#216), found by the one command that is unique to it: an
 * install of the BARE formula name. The pre-flight installs `"$PREFLIGHT_TAP/ralph"`,
 * which does not contain this substring, so the needle cannot pick up the local
 * stand-in by accident — and it is the property under test rather than a proxy for it,
 * since the bare name is the whole point of the step.
 *
 * Matched against the COMMANDS rather than the whole `run`, and that is not
 * cosmetic: the step's own prose quotes `brew install ralph` three times while
 * explaining the failure it exists for (counted, not eyeballed — the run body holds
 * three quotations and one command), so a locator over the raw text would still find it
 * after somebody deleted the command — the haystack half of CONTRIBUTING's "A spec
 * that cannot go red (#122)", measured here by mutation rather than assumed.
 */
const smokeStep = () =>
  steps().findIndex((step) => commandsOf(step).includes('brew install ralph'))

/**
 * The verbatim text of one step of the `homebrew` job, INCLUDING the comment block
 * immediately above its `- name:`. That inclusion is the reason this exists rather
 * than reading `step.run`: the steps in this job put the argument for why they exist
 * at all above the `- name:`, and only the shell's own commentary inside `run: |`
 * survives the YAML parse, so a claim about a step's prose that read the parsed step
 * would be asking half the question.
 *
 * Steps are cut at the six-space `- ` items a step of this job always begins with,
 * and the cut walks back over the contiguous comment lines above each one so a
 * leading block belongs to the step it introduces rather than to the step before it.
 *
 * THROWS on a fragment it cannot find, for the reason jobSource() does and
 * CONTRIBUTING's "A spec that cannot go red (#122)" spells out: a slicer that fails
 * open turns every search over its output into a tautology.
 */
function homebrewStepSource(nameFragment) {
  const lines = jobSource('homebrew').split('\n')
  const starts = []
  for (const [index, line] of lines.entries()) {
    if (!/^ {6}- /.test(line)) continue
    let from = index
    while (from > 0 && /^\s*#/.test(lines[from - 1])) from -= 1
    starts.push({ from, head: index })
  }
  const at = starts.findIndex(({ head }) => lines[head].includes(nameFragment))
  if (at < 0) {
    throw new Error(
      `no step of the \`homebrew\` job declares \`${nameFragment}\`; it declares ` +
        `${starts.map(({ head }) => lines[head].trim()).join(' | ')}`,
    )
  }
  const end = at + 1 < starts.length ? starts[at + 1].from : lines.length
  return lines.slice(starts[at].from, end).join('\n')
}

describe('#202 — the release workflow declares a `homebrew` job', () => {
  it('parses as YAML and names both release channels', () => {
    // Fails closed: every assertion below reads off this parse, so a workflow that
    // stopped parsing must go red here rather than making the rest vacuous.
    expect(Object.keys(JOBS)).toContain('release-please')
    expect(Object.keys(JOBS)).toContain('publish')
    expect(Object.keys(JOBS)).toContain('homebrew')
  })

  it('waits on `release-please` ALONE — not on `publish`', () => {
    expect(needsOf(HOMEBREW)).toEqual(['release-please'])
  })

  it('is downstream of `publish` nowhere in the RESOLVED graph', () => {
    // The criterion #202 asks to be checked against the graph rather than the
    // intent. `publish` failing on its 403 must not skip this job, and GitHub skips
    // a job only for something in its transitive `needs`.
    const upstream = [...resolvedNeeds('homebrew')].sort()
    expect(upstream).toEqual(['release-please'])
    expect(upstream).not.toContain('publish')
  })

  it('mentions `needs.publish` nowhere in its own body', () => {
    // A `needs:` edge is not the only way to become downstream of the npm job: an
    // `if:` reading `needs.publish.result` would do it too, without appearing in
    // the graph at all.
    expect(jobSource('homebrew')).not.toMatch(/needs\.publish/)
  })

  it('carries the npm job\'s own always-run guard, character for character', () => {
    // Not "an equivalent guard": the same one. A run where release-please created
    // nothing must still evaluate this job and short-circuit on the version check,
    // which is the same reason the npm job runs unconditionally.
    expect(HOMEBREW?.if).toBe(PUBLISH?.if)
    expect(HOMEBREW?.if).toMatch(/^always\(\)/)
  })

  it('runs on macOS, the only runner that has `brew`', () => {
    expect(HOMEBREW?.['runs-on']).toMatch(/^macos/)
  })

  it('takes `contents: read` and NO `id-token`', () => {
    // Nothing in this job speaks OIDC — the tap is read anonymously over https and
    // written with a PAT — so `id-token: write` would be an unused write scope on a
    // job that runs `brew install` over fetched bytes.
    expect(HOMEBREW?.permissions).toEqual({ contents: 'read' })
  })
})

describe('#202 — the push is gated on a secret that does not exist yet', () => {
  /** The job-level env keys whose value is a `secrets.X != ''` boolean. */
  const secretBooleans = () =>
    Object.entries(HOMEBREW?.env ?? {}).filter(([, value]) =>
      /^\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*!=\s*''\s*\}\}$/.test(String(value)),
    )

  it('surfaces the secret as exactly one job-level `env` boolean', () => {
    // `secrets` is not available in a step-level `if`, so the only way to condition
    // a step on a secret's presence is to evaluate it where `secrets` IS available —
    // `jobs.<id>.env` — and read the resulting string back.
    expect(secretBooleans().map(([key]) => key)).toHaveLength(1)
  })

  it('conditions the push step on that boolean and on the version check', () => {
    const [[key]] = secretBooleans()
    const push = steps()[stepRunning('git push')]
    expect(ifOf(push)).toContain(`env.${key} == 'true'`)
    expect(ifOf(push)).toContain("carries_version == 'false'")
  })

  it('reads no secret from an `if:`, which would silently never match', () => {
    // An `if:` naming `secrets.X` is not an error — it evaluates to the empty
    // string, so the step is skipped forever, including after the secret lands.
    for (const line of jobSource('homebrew').split('\n')) {
      if (/^\s*if:/.test(line)) expect(line).not.toMatch(/secrets\./)
    }
  })
})

describe('#202 — pre-flight runs before the push, and a failure stops it', () => {
  it('pushes from exactly one step, and only the smoke test follows it', () => {
    // THIS ASSERTED "THE PUSH IS THE LAST STEP" UNTIL #216, and the property it was
    // protecting is unchanged: no pre-flight check may run after the push, because a
    // check that runs after the push cannot stop a bad formula from reaching the tap.
    // What #216 changed is only that the push is no longer FINAL — it added a smoke
    // test that installs from the real remote, which is a thing that can only exist
    // once the bytes are public. So the order is `pre-flight < push < smoke` BY
    // DESIGN, and it is spelled out as those three positions rather than relaxed to
    // "the push is somewhere in the middle": exactly one step pushes, exactly one
    // step follows it, and that step is the smoke test. Move a `brew` pre-flight down
    // past the push and this goes red exactly as it did before.
    const pushes = steps().filter((step) => runOf(step).includes('git push'))
    expect(pushes).toHaveLength(1)
    const push = stepRunning('git push')
    expect(smokeStep(), 'the smoke test does not run immediately after the push').toBe(
      push + 1,
    )
    expect(smokeStep(), 'a step was added after the smoke test').toBe(steps().length - 1)
  })

  it('installs, tests and audits the rendered formula BEFORE that step', () => {
    const push = stepRunning('git push')
    for (const command of ['brew install --build-from-source', 'brew test', 'brew audit']) {
      const at = stepRunning(command)
      expect(at, `no step runs \`${command}\``).toBeGreaterThanOrEqual(0)
      expect(at, `\`${command}\` runs after the push`).toBeLessThan(push)
    }
  })

  it('lets no step swallow its own failure', () => {
    // `continue-on-error` on a pre-flight step would let a formula that does not
    // install reach a user, which is the one thing a fallback channel may not do.
    // On the npm job it would be worse than useless: it would retire the pressure
    // to fix the 403 while making a future, different npm failure look identical to
    // today's known one.
    //
    // Asserted over the SETTING and over the runnable lines, not over the file's
    // bytes — see runnableLines() for why the prose is exempt. Both halves are kept:
    // the parsed read is what actually answers the question, and the text sweep
    // catches the setting somewhere the parse does not reach (a `strategy`, a
    // reusable-workflow `with:`, a job added below).
    for (const [name, job] of Object.entries(JOBS)) {
      expect(job['continue-on-error'], `job ${name}`).toBeUndefined()
      for (const step of job.steps ?? []) {
        expect(step['continue-on-error'], `a step of ${name}`).toBeUndefined()
      }
    }
    expect(runnableLines()).not.toMatch(/continue-on-error/)
  })

  it('short-circuits every step after the tap probe on the version check', () => {
    const probe = stepRunning('homebrew-tap-plan.js')
    expect(probe, 'no step runs the tap probe').toBeGreaterThanOrEqual(0)
    const id = steps()[probe].id
    expect(id, 'the tap probe step needs an `id` for later steps to read').toBeTruthy()
    for (const step of steps().slice(probe + 1)) {
      expect(
        ifOf(step),
        `step "${step.name ?? runOf(step).split('\n')[0]}" would run again on a re-run`,
      ).toContain(`steps.${id}.outputs.carries_version == 'false'`)
    }
  })
})

// #216 — the pre-flight above cannot see the one failure that mattered.
//
// All three pre-flight steps passed on the formula the 0.26.0 release pushed, and
// that formula could not be tapped at all: on Homebrew 7.0.0,
// `brew tap lucasfe/ralph` clones the tap and then refuses it — "Refusing to load
// formula lucasfe/ralph/ralph from untrusted tap lucasfe/ralph", reported as
// `Invalid formula` once per platform brew enumerates and ending
// `Error: Cannot tap lucasfe/ralph: invalid syntax in tap!` — after which
// `brew install ralph` answers `No available formula with the name "ralph"`. The
// pre-flight is blind to that STRUCTURALLY, not by bad luck, and the reason is not the
// one this comment used to give (that a local `brew tap-new --no-git` tap is trusted
// implicitly — `Tap#implicitly_trusted?` is `official? && canonical_remote?` and
// `official?` is `user == "Homebrew"`, so `ralphci/preflight` is not). It is that
// `brew install` writes a trust entry for any fully-qualified `<user>/<tap>/<formula>`
// name out of a non-official tap as it installs it — `cmd/install.rb:197` calling
// `Trust.trust_fully_qualified_items!`, and the 0.26.0 run's log printing
// `==> Trusted formula ralphci/preflight/ralph` — plus the plainer half: the pre-flight
// never runs `brew tap` against a remote at all, which is where the refusal fires.
// Both readable in `$(brew --repository)` at tags 6.0.21 and 7.0.0; the workflow's own
// comment block carries the citations.
//
// So these specs are about a step that runs AFTER the push, and they are a sweep for
// the same reason every spec above is one: the real install path exists only on a
// macOS runner with a real remote tap, and nothing in this repository can execute it.
// What a sweep can pin exactly is the shape of the step — where it sits relative to
// the push, which name it addresses the formula by, which gate it carries, and that
// it takes the local stand-in away first so its own assertion can fail.
describe('#216 — a smoke test installs from the REMOTE tap, the way a user does', () => {
  const smoke = () => steps()[smokeStep()]
  /** What the step runs, prose taken out — see runnableLines() for why that matters. */
  const smokeCommands = () => (smokeStep() >= 0 ? commandsOf(smoke()) : '')
  /**
   * Everything the step argues, wherever it argues it: the block above `- name:` and
   * the commentary inside `run: |`. Both halves carry load here — the placement
   * argument sits above the step, the `brew trust` measurements sit beside the call —
   * and which one holds a given sentence is an editing decision no assertion should
   * pin.
   */
  const smokeCommentary = () =>
    homebrewStepSource('Smoke test').split('\n').filter(isCommentLine).join('\n')

  it('exists, and runs after the push rather than before it', () => {
    // Fails closed: every assertion below reads off this step.
    expect(smokeStep(), 'no step installs the formula by its bare name').toBeGreaterThanOrEqual(0)
    expect(smokeStep()).toBeGreaterThan(stepRunning('git push'))
  })

  it('taps the real remote instead of building another local stand-in', () => {
    expect(smokeCommands()).toMatch(/^\s*brew tap /m)
    // `tap-new` is the pre-flight's instrument and the reason it cannot see this
    // failure class. A smoke test that reached for it would be a third pre-flight.
    expect(smokeCommands()).not.toMatch(/brew tap-new/)
  })

  it('installs the BARE name, never a tap-qualified one', () => {
    // The bare name is what install instructions can tell somebody to type, and it is
    // the only spelling that proves the tap landed on brew's SEARCH PATH rather than
    // merely on disk. A tap-qualified `lucasfe/ralph/ralph` hands brew the tap instead
    // of asking it to find one, so it cannot see the second half of the failure #216
    // measured: `No available formula with the name "ralph"`, with a stranger's package
    // suggested in its place.
    const installs = smokeCommands()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('brew install'))
    expect(installs).toEqual(['brew install ralph'])
  })

  it('asserts the version the push published, taken from the probe', () => {
    expect(smokeCommands()).toMatch(/ralph --version/)
    expect(smoke()?.env?.VERSION).toBe('${{ steps.tap.outputs.version }}')
    expect(smokeCommands()).toContain('$VERSION')
    // No release number written down anywhere in the commands — a literal would be a
    // second copy of the version, and a copy that stopped matching the tap would
    // fail this step on a release that was perfectly fine. Prose is exempt: the
    // comments quote measured Homebrew versions on purpose.
    expect(smokeCommands()).not.toMatch(/\d+\.\d+\.\d+/)
  })

  it('invokes `brew trust` unconditionally, before it taps', () => {
    // THIS ASSERTED A `brew commands` PROBE AHEAD OF THE TRUST until review round 1.
    // The probe was there because the step claimed the runner's brew might not have the
    // subcommand and that nothing here could find out; the second half was false.
    // `$(brew --repository)` is a full Homebrew checkout, so every tagged version is
    // readable: `git show 6.0.21:Library/Homebrew/cmd/trust.rb` prints the command with
    // its `switch "--tap", "--taps"`, and `git tag --contains` gives the same earliest
    // tag (5.1.15) for the commit that added `brew trust` and the commit that added the
    // enforcement — they shipped together. A brew that can refuse this tap can clear it,
    // and one too old to clear it has nothing to refuse, so the branch guarded a world
    // that cannot occur. What survives is the property that mattered: trust is invoked,
    // it is not hidden behind a condition, and it runs before the tap.
    const commands = smokeCommands()
    // Column zero in the dedented `run` body: not nested inside an `if`/`else`.
    expect(commands, 'the trust call is indented, so something is branching on it').toMatch(
      /^brew trust --tap "\$TAP_NAME"$/m,
    )
    expect(commands.indexOf('brew trust')).toBeLessThan(commands.indexOf('brew tap "'))
    expect(commands, 'the deleted `brew commands` probe is back').not.toMatch(/brew commands/)
  })

  it('records the runner\'s Homebrew before anything depends on it', () => {
    // Every claim this step makes about the runner's brew — that it has `trust`, that it
    // enforces the tap-trust gate — rests on a version no run of this job has ever
    // printed: #216 reports 6.0.21 and the 0.26.0 log contains no `brew --version` line
    // and no `HOMEBREW_*` variable. Both diagnostics were added in review round 1, and
    // the step's comment block now says so, which is why they are pinned: a later edit
    // that drops them would leave that comment false, and comment accuracy is the review
    // class this repo blocks on. First, too — a version printed after the failure it
    // would have explained is a version printed too late.
    const commands = smokeCommands()
    expect(commands).toMatch(/^brew --version$/m)
    expect(commands, 'nothing dumps the image\'s HOMEBREW_* environment').toMatch(
      /^env \| grep '\^HOMEBREW_'/m,
    )
    expect(commands.indexOf('brew --version')).toBeLessThan(commands.indexOf('brew trust'))
  })

  it('carries the push step\'s own gate, character for character', () => {
    // Not "an equivalent gate": the same one, for the same reason the job carries the
    // npm job's `always()` verbatim. This step asserts a formula is installable FROM
    // THE TAP, so it is meaningless unless the push it is checking actually ran —
    // both on the idempotence skip (`carries_version == 'true'`, where the tap
    // already carried this version and this run pushed nothing) and on the
    // secret-missing skip, where nothing was pushed at all and `brew tap` would
    // install a stale formula or fail on an empty tap.
    //
    // A third expectation stood here, `toMatch(/env\.[A-Z_]+ == 'true'/)`, and it is
    // gone rather than strengthened: QA measured that flipping `&&` to `||` in BOTH
    // gates left all three green — the equality holds when the two steps are wrong
    // together, and the regex matches any env boolean at all. What it was reaching for
    // is now asserted where it can fail on its own, in the sibling
    // `homebrew-release-job.qa.test.js`: the secret boolean is re-derived from the
    // job's env block by shape and named, and the gate is EVALUATED over the four
    // worlds of (carries_version, secret present). A wildcard that cannot go red is
    // indirection this repo would rather not carry.
    const push = steps()[stepRunning('git push')]
    expect(ifOf(smoke())).toBe(ifOf(push))
    expect(ifOf(smoke())).toContain("carries_version == 'false'")
  })

  it('takes the pre-flight tap and keg away first, so the install can go red', () => {
    // The assertion this step makes is unfalsifiable without this. By the time it
    // runs, `ralph` IS installed — the first pre-flight step built it — and
    // `ralphci/preflight` is still tapped, so a bare `brew install ralph` is answered
    // by the local stand-in rather than by the remote tap, at the same version, and
    // `ralph --version` then reports the pushed version no matter what the tap holds.
    // See CONTRIBUTING's "A spec that cannot go red (#122)": a check satisfied by
    // something other than the thing under test is not a check.
    const commands = smokeCommands()
    expect(commands).toMatch(/brew uninstall/)
    expect(commands).toMatch(/brew untap "\$PREFLIGHT_TAP"/)
    for (const teardown of ['brew uninstall', 'brew untap']) {
      expect(
        commands.indexOf(teardown),
        `\`${teardown}\` runs after the install it exists to make meaningful`,
      ).toBeLessThan(commands.indexOf('brew install ralph'))
    }
  })

  it('names the Homebrew it measured and quotes the refusal it prevents', () => {
    // `brew trust` reads like defensive noise unless the failure is written next to
    // it, and a reader who cannot see the failure will delete the call — this repo's
    // review gate blocks on comment accuracy for exactly this reason. So the step
    // carries the version the gate was measured on and brew's own words for it.
    expect(smokeCommentary()).toMatch(/Homebrew 7/)
    expect(smokeCommentary()).toMatch(/Refusing to load formula/)
  })

  it('says plainly that it runs after the bytes are already public', () => {
    // The one thing this step cannot do, stated where somebody deciding what to do
    // with a red run will read it: it did not stop the formula from shipping, and it
    // cannot. Unlike the pre-flight it is a report, not a gate.
    expect(smokeCommentary()).toMatch(/already public/i)
  })
})

describe('#202 — the digest comes from the bytes that were fetched', () => {
  it('hashes a file it downloaded, in the same step', () => {
    const at = stepRunning('shasum -a 256')
    expect(at, 'no step hashes a tarball').toBeGreaterThanOrEqual(0)
    expect(runOf(steps()[at])).toMatch(/curl/)
  })

  it('never builds the tarball locally', () => {
    // `git archive` of the same tag produces a DIFFERENT tarball to the one GitHub
    // serves, so a digest taken from it installs as a checksum mismatch on a user's
    // machine. The renderer's `url` points at GitHub's archive endpoint; the bytes
    // hashed have to come from there.
    //
    // Comment lines are exempt for the same reason they are in the
    // `continue-on-error` assertion above: the workflow is expected to NAME the
    // anti-pattern — it records the two digests that differ — and a sweep over the
    // raw bytes would go red on the warning rather than on the mistake.
    expect(runnableLines()).not.toMatch(/git archive/)
  })

  it('takes the URL from the probe rather than spelling it a second time', () => {
    // The tag tarball URL is built in exactly one place — `tagTarballUrl` in
    // scripts/lib/render-homebrew-formula.js — and the job asks the probe for it.
    // A literal here would be a second copy of the endpoint that the formula's own
    // `url` line could drift away from, and drift means a digest computed over
    // bytes the formula does not point at.
    //
    // Comments are NOT exempt here, unlike the two sweeps above, and the difference
    // is deliberate rather than an oversight: those two ask the file to name an
    // anti-pattern, while nothing about this job needs the endpoint written down at
    // all. A stale URL in prose is the review class this repo blocks on, so the
    // cheapest guard is to keep the string out of the job entirely.
    expect(jobSource('homebrew')).not.toMatch(/archive\/refs\/tags/)
    expect(jobSource('homebrew')).toMatch(/outputs\.tarball_url/)
  })
})

describe('#202 — the npm job is untouched, and the run still goes red', () => {
  it('leaves `publish` on the same graph edge and the same scopes', () => {
    expect(needsOf(PUBLISH)).toEqual(['release-please'])
    expect(PUBLISH?.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
  })

  it('keeps every flag and every line of instrumentation the 403 hunt paid for', () => {
    const publish = jobSource('publish')
    for (const needle of [
      'npm view "@lucasfe/ralph@$VERSION" version',
      'ARGS=(--provenance)',
      'ARGS+=(--tag rc)',
      '--loglevel verbose',
      "grep -hiE 'oidc|exchange|trusted|403|PUT https|Forbidden|2fa|bypass|deprecat|notice'",
      'exit 1',
    ]) {
      expect(publish, `the publish job lost \`${needle}\``).toContain(needle)
    }
  })

  it('keeps Homebrew out of the npm job entirely', () => {
    expect(jobSource('publish')).not.toMatch(/brew|homebrew|formula/i)
  })
})

describe('#202 — the comments a later reader must not tidy away', () => {
  const commentary = () =>
    jobSource('homebrew')
      .split('\n')
      .filter((line) => /^\s*#/.test(line))
      .join('\n')

  it('argues the sibling relationship where the `needs` edge is', () => {
    // The sibling relationship is the whole feature: it is why a 403 on npm cannot
    // stop a Homebrew release. It also looks exactly like an oversight — "surely the
    // formula should publish after npm" — so the reason has to be at the edge.
    expect(commentary()).toMatch(/sibling/i)
  })

  it('argues why the run stays red when npm fails', () => {
    expect(commentary()).toMatch(/\bred\b/i)
  })
})

// --------------------------------------------------------------------------------
// scripts/homebrew-tap-plan.js — the probe, driven for real against real taps.
// --------------------------------------------------------------------------------

const temps = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/**
 * A tap remote, as a bare repository on disk. `formula` null leaves it EMPTY — no
 * commits, no files — which is the measured current state of lucasfe/homebrew-ralph
 * and the case #202 singles out.
 *
 * @returns {{remote: string, into: string}} a clone URL git accepts, and a path to
 *   clone into that does not exist yet
 */
function tap(formula) {
  const root = mkdtempSync(join(tmpdir(), 'ralph-tap-'))
  temps.push(root)
  const remote = join(root, 'tap.git')
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore' })
  git(['init', '--bare', '--initial-branch=main', remote])
  if (formula !== null) {
    const work = join(root, 'work')
    git(['clone', remote, work])
    mkdirSync(join(work, 'Formula'))
    writeFileSync(join(work, 'Formula', 'ralph.rb'), formula)
    // Identity on the command line, not in a config file: the suite sandboxes HOME
    // (test/setup/hermetic-env.js), so there is no global git config to inherit one
    // from and `git commit` would refuse.
    git(['add', 'Formula/ralph.rb'], work)
    git(['-c', 'user.name=Tap', '-c', 'user.email=tap@example.invalid', 'commit', '-m', 'init'], work)
    git(['push', 'origin', 'HEAD:refs/heads/main'], work)
  }
  return { remote, into: join(root, 'clone') }
}

/** The probe's stdout parsed as the `key=value` lines a job appends to GITHUB_OUTPUT. */
function plan(args) {
  const result = spawnSync(process.execPath, [TAP_PLAN, ...args], { encoding: 'utf8' })
  const outputs = Object.fromEntries(
    result.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
  return { ...result, outputs }
}

const FORMULA_FOR = (version) =>
  renderFormula({
    version,
    sha256: '0123456789abcdef'.repeat(4),
    description: PKG.description,
    homepage: PKG.homepage,
    license: PKG.license,
  })

describe('scripts/homebrew-tap-plan.js — does the tap already carry this version?', () => {
  it('reads an EMPTY tap as "no", and exits 0', () => {
    // The case that would otherwise look like a broken release when nothing is
    // wrong. This job is blocked only on #197, so it can run before #203 commits
    // the initial formula, and it must carry on rather than die on the 404 every
    // API-shaped probe returns for a repository with no commits.
    const { remote, into } = tap(null)
    const result = plan(['--remote', remote, '--into', into])
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs.carries_version).toBe('false')
  })

  it('says so on the log stream, not just in an output', () => {
    const { remote, into } = tap(null)
    expect(plan(['--remote', remote, '--into', into]).stderr).toMatch(/empty/i)
  })

  it('reads a tap carrying an OLDER version as "no"', () => {
    const { remote, into } = tap(FORMULA_FOR('0.0.1'))
    const result = plan(['--remote', remote, '--into', into, '--version', PKG.version])
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs.carries_version).toBe('false')
  })

  it('reads a tap carrying THIS version as "yes", and says so', () => {
    // The idempotence half: a re-run, or an unrelated push to main, must not
    // re-push or double-bump.
    const { remote, into } = tap(FORMULA_FOR(PKG.version))
    const result = plan(['--remote', remote, '--into', into, '--version', PKG.version])
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs.carries_version).toBe('true')
    expect(result.stderr).toContain(PKG.version)
  })

  it('reports the tarball URL the formula will point at, from the renderer', () => {
    // The identity the digest step depends on: the bytes it hashes come from this
    // URL, and this URL is the one the formula's own `url` line will hold.
    const { remote, into } = tap(null)
    const result = plan(['--remote', remote, '--into', into, '--version', '1.2.3'])
    expect(result.outputs.tarball_url).toBe(tagTarballUrl('1.2.3'))
    expect(FORMULA_FOR('1.2.3')).toContain(`url "${result.outputs.tarball_url}"`)
  })

  it('defaults the version to this package.json\'s, and reports it', () => {
    const { remote, into } = tap(null)
    const result = plan(['--remote', remote, '--into', into])
    expect(result.outputs.version).toBe(PKG.version)
    expect(result.outputs.tarball_url).toBe(tagTarballUrl(PKG.version))
  })

  it('fails when the remote cannot be cloned at all', () => {
    // An empty tap is not an error; a tap that is not there is. Swallowing both
    // would leave a broken remote looking like a first release forever.
    const root = mkdtempSync(join(tmpdir(), 'ralph-tap-'))
    temps.push(root)
    const result = plan(['--remote', join(root, 'absent.git'), '--into', join(root, 'clone')])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/homebrew-tap-plan/)
  })

  it('rejects an unknown flag rather than ignoring it', () => {
    const { remote, into } = tap(null)
    const result = plan(['--remote', remote, '--into', into, '--push'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--push')
  })

  it('refuses to run with no --remote and no --into', () => {
    expect(plan([]).status).toBe(1)
  })
})
