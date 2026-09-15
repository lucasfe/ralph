// #216 QA augmentation — the smoke step read as SHELL and as a GATE.
//
// A sibling file rather than more `it`s in test/homebrew-release-job.test.js, following
// the pair this repo already keeps for the formula itself
// (homebrew-formula.test.js / homebrew-formula.qa.test.js): the dev's specs say what the
// step is FOR, these say what an ordinary later edit can break while every one of those
// stays green. Keeping them apart also keeps the augmentation honest — nothing here
// imports the dev's locators, so a locator that can be fooled is caught by disagreement
// rather than inherited.
//
// WHAT THE DEV'S NINE SPECS ALREADY PIN, so nothing below repeats it: that the step
// exists and runs after the push and last; that it taps a remote rather than a second
// `brew tap-new` stand-in; that it installs `ralph` BARE and nothing else; that VERSION
// comes from the probe's output and no release number is written down in the commands;
// that `brew commands` precedes `brew trust`; that its `if` equals the push step's
// character for character; that BOTH teardown commands precede the install; and two
// claims about its prose (a Homebrew 7 figure, brew's own refusal, "already public").
//
// WHAT THAT GREEN CANNOT DISTINGUISH — five properties, each of them a claim the step's
// own comments make about themselves and no assertion holds them to:
//
//   1. THE ORDER WITHIN THE TEARDOWN. "The keg goes before the untap so the name still
//      resolves when it is uninstalled" is argued in the step and pinned nowhere; both
//      commands merely have to precede the install. Same for "TRUST BEFORE TAP, the
//      opposite order to the by-hand session", which is the one ordering claim the step
//      says it deliberately inverted.
//   2. WHICH env BOOLEAN THE GATE READS. `toMatch(/env\.[A-Z_]+ == 'true'/)` is
//      satisfied by any env boolean at all, and the equality against the push step's
//      `if` is satisfied by BOTH steps being wrong in the same way. So the gate is
//      re-derived here from the job's env block by shape, and then EVALUATED over the
//      four worlds it can meet, which is the question the criterion actually asks: can
//      this step run on a skip path?
//   3. THE TAP-NAME↔REPO IDENTITY. `${TAP_REPO/homebrew-/}` is an unanchored
//      first-match replacement, so it is correct for the repo it is pointed at today
//      and silently wrong for an owner whose own name carries the prefix. Nothing
//      checked the derivation against the repo in the job's env.
//   4. WHETHER EVERY VARIABLE THE SHELL READS IS DECLARED. GitHub runs a `run:` block
//      as `bash -e {0}` — no `-u` (this workflow sets no `defaults.run.shell`, and none
//      of the steps sets `shell:`), so a mistyped `$TAP_REPOO` expands to the empty
//      string instead of failing.
//   5. WHETHER THE MEASURED-VERSION CLAIMS ARE TRUE. This repo's review gate blocks on
//      comment accuracy above all else, and the dev's prose specs ask only that SOME
//      Homebrew 7 figure and SOME quoted refusal are present — never that a sentence
//      about which Homebrew a figure came from is right. One of them is not. See
//      `attributes its Homebrew figures to the versions they were taken on`.
//
// WHAT WAS MEASURED HERE, and what was only read. Everything below is a sweep over the
// workflow's text and its parse; the real install path exists only on a macOS runner
// with a real remote tap and nothing in this repository can execute it, exactly as the
// dev's file argues. Three things were run by hand on this machine on 2026-09-14 while
// writing these specs, all of them read-only, and they are recorded because they decide
// which claims below are checkable and which are quotation:
//
//   $ brew --version                       -> Homebrew 7.0.0
//   $ brew help trust                      -> "Trust non-official tap formulae, casks
//                                             or commands so Homebrew may load them.",
//                                             "--tap, --taps  Trust the named tap.",
//                                             and the store at
//                                             ${XDG_CONFIG_HOME}/homebrew/trust.json
//                                             or ~/.homebrew/trust.json
//   $ brew commands | tr -s '[:space:]' '\n' | grep -qx trust   -> exit 0
//
// So the step's `brew help trust` quotations, its `--tap` spelling and its probe are
// accurate for 7.0.0 — this machine IS a 7.0.0 machine, which is the fact the offending
// sentence in the step contradicts. No `brew tap`, `brew trust`, `brew install`,
// `brew uninstall` or `brew untap` was run: those mutate a real Homebrew, and a QA pass
// does not get to do that to somebody's laptop.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release.yml')
const SOURCE = readFileSync(WORKFLOW, 'utf8')
const HOMEBREW = parse(SOURCE)?.jobs?.homebrew

const steps = () => (Array.isArray(HOMEBREW?.steps) ? HOMEBREW.steps : [])
const runOf = (step) => (typeof step?.run === 'string' ? step.run : '')
const ifOf = (step) => (typeof step?.if === 'string' ? step.if : '')
const isComment = (line) => /^\s*#/.test(line)
/** One step's `run` with the shell's own prose dropped: the commands, and only those. */
const commandsOf = (step) => runOf(step).split('\n').filter((line) => !isComment(line)).join('\n')

/**
 * The `homebrew` job's verbatim text, comments included — the same cut the dev's file
 * makes, re-derived rather than imported so a defect in one slicer cannot hide in both.
 * THROWS rather than returning '', per CONTRIBUTING's "A spec that cannot go red
 * (#122)": a slicer that fails open turns every search over its output into a tautology.
 */
function homebrewSource() {
  const jobsAt = SOURCE.indexOf('\njobs:\n')
  if (jobsAt < 0) throw new Error(`${WORKFLOW} has no top-level \`jobs:\` block`)
  const region = SOURCE.slice(jobsAt + 1)
  const starts = [...region.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)]
  const at = starts.findIndex((match) => match[1] === 'homebrew')
  if (at < 0) throw new Error(`${WORKFLOW} declares no job named \`homebrew\``)
  const end = at + 1 < starts.length ? starts[at + 1].index : region.length
  return region.slice(starts[at].index, end)
}

/**
 * Comment lines as FLOWING PROSE — `#` and the indentation taken off, joined with a
 * single space. Every sentence in this job is wrapped across several lines, so a claim
 * asserted against the raw comment text can only ever match a fragment of one; the
 * sentence this file reports as false is spread over three lines and is invisible to a
 * per-line regex. This is the haystack a claim about a SENTENCE has to be read from.
 */
const proseOf = (text) =>
  text
    .split('\n')
    .filter(isComment)
    .map((line) => line.replace(/^\s*#\s?/, ''))
    .join(' ')

/**
 * The smoke step, located by its declared `name` — deliberately NOT by the command the
 * dev's locator looks for. Two independent routes to the same step is the only way a
 * sweep can notice that a locator has started matching something else, and the first
 * spec below asserts the two agree.
 */
const smokeIndexByName = () =>
  steps().findIndex((step) => String(step?.name ?? '').includes('Smoke test'))
const smoke = () => steps()[smokeIndexByName()]
const smokeCommands = () => (smokeIndexByName() >= 0 ? commandsOf(smoke()) : '')

/**
 * The step's whole argument: the comment block above its `- name:` plus the commentary
 * inside `run: |`. The block above the key does not survive the YAML parse, and it is
 * where the placement argument lives, so a prose claim read off the parsed step would be
 * asking half the question. Cut at the six-space `- ` a step of this job always begins
 * with, walking back over the contiguous comment lines above each one.
 */
function smokeSource() {
  const lines = homebrewSource().split('\n')
  const bounds = []
  for (const [index, line] of lines.entries()) {
    if (!/^ {6}- /.test(line)) continue
    let from = index
    while (from > 0 && isComment(lines[from - 1])) from -= 1
    bounds.push({ from, head: index })
  }
  const at = bounds.findIndex(({ head }) => lines[head].includes('Smoke test'))
  if (at < 0) {
    throw new Error(
      'no step of the `homebrew` job declares `Smoke test`; it declares ' +
        bounds.map(({ head }) => lines[head].trim()).join(' | '),
    )
  }
  const end = at + 1 < bounds.length ? bounds[at + 1].from : lines.length
  return lines.slice(bounds[at].from, end).join('\n')
}

/** The one job-level env key whose value is a `secrets.X != ''` boolean, by SHAPE. */
function secretBooleanKey() {
  const entries = Object.entries(HOMEBREW?.env ?? {}).filter(([, value]) =>
    /^\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*!=\s*''\s*\}\}$/.test(String(value)),
  )
  if (entries.length !== 1) {
    throw new Error(
      `the \`homebrew\` job declares ${entries.length} secret booleans, not one; ` +
        `this spec cannot say which one the gate should read`,
    )
  }
  return entries[0][0]
}

/**
 * Evaluate a step-level `if` of the ONE shape this job uses — a conjunction of
 * `<context.path> == '<literal>'` tests — against a world, and THROW on anything else.
 *
 * Throwing is the whole value of this over a regex. An `if` rewritten with `||`, or with
 * a term this spec has no value for, does not quietly evaluate to something plausible:
 * it stops the spec with the offending term named. A gate is the one part of this step
 * whose meaning is a truth table, and a truth table is a thing a test can actually
 * check rather than pattern-match.
 */
function gateHolds(expression, world) {
  const terms = expression.split('&&').map((term) => term.trim()).filter(Boolean)
  return terms.every((term) => {
    const parsed = /^([A-Za-z0-9_.]+)\s*==\s*'([^']*)'$/.exec(term)
    if (!parsed) {
      throw new Error(
        `\`${term}\` is not a \`<context> == '<literal>'\` test, so this spec cannot ` +
          `evaluate the gate \`${expression}\`; it was written for the conjunction the ` +
          `push step and the smoke step both carried`,
      )
    }
    const [, path, literal] = parsed
    if (!(path in world)) {
      throw new Error(
        `the gate reads \`${path}\`, which this spec has no value for (it knows ` +
          `${Object.keys(world).join(', ')}) — a gate on a context the skip paths do ` +
          `not describe is not a gate on the push having run`,
      )
    }
    return world[path] === literal
  })
}

/** The two inputs that decide whether the push step ran at all. */
const world = (carriesVersion, secretPresent) => ({
  'steps.tap.outputs.carries_version': carriesVersion,
  [`env.${secretBooleanKey()}`]: secretPresent,
})

/** Index of a needle in the step's commands, asserted present so `-1` cannot order. */
function commandAt(needle) {
  const at = smokeCommands().indexOf(needle)
  expect(at, `the smoke step runs no \`${needle}\``).toBeGreaterThanOrEqual(0)
  return at
}

describe('#216 QA — the smoke step is one step, found two ways', () => {
  it('is the step the dev\'s locator finds, reached by its declared name instead', () => {
    // Fails closed: every assertion in this file reads off this step, and it is located
    // by `name` while the dev's file locates it by `brew install ralph` in the commands.
    // Agreement is the point. If a future step were to install the bare name too, the
    // dev's locator would silently retarget to whichever came first and its specs would
    // keep passing about the wrong step; this is where that shows up.
    const byName = smokeIndexByName()
    expect(byName, 'no step of the `homebrew` job is named `Smoke test …`').toBeGreaterThanOrEqual(0)
    const byCommand = steps().findIndex((step) => commandsOf(step).includes('brew install ralph'))
    expect(byCommand, 'the two locators disagree about which step is the smoke test').toBe(byName)
    expect(steps().filter((step) => commandsOf(step).includes('brew install ralph'))).toHaveLength(1)
  })
})

describe('#216 QA — the shell runs in the order the comments claim', () => {
  it('uninstalls the keg BEFORE untapping the tap it came from', () => {
    // The step's own words: "The keg goes before the untap so the name still resolves
    // when it is uninstalled." The dev's spec requires only that both precede the
    // install, so swapping these two lines — the single most plausible tidy-up here,
    // since "remove the tap, then the thing it installed" reads more natural — breaks
    // the stated reason and leaves the suite green. An unpinned claim is a claim that
    // becomes false without anybody noticing, which is the review class this repo
    // blocks on.
    //
    // Not a claim about what brew DOES with an untapped keg: that was not measured here
    // (it would mean uninstalling something on this machine). The claim under test is
    // narrower and entirely checkable — the file says keg first, so the file must do
    // keg first.
    expect(commandAt('brew uninstall')).toBeLessThan(commandAt('brew untap'))
  })

  it('trusts the tap BEFORE tapping it, the inversion it says it made on purpose', () => {
    // "TRUST BEFORE TAP, the opposite order to the by-hand session, so `brew tap` never
    // has to fail on the way to succeeding." That is the one ordering in this step that
    // is deliberately NOT the order the failure was reproduced in, which makes it the
    // one most likely to be "corrected" back by a reader who has the transcript in
    // front of them — and on a Homebrew with the gate, tap-then-trust is a step that
    // goes red on its own `brew tap` line before the trust it needs has run.
    expect(commandAt('brew trust')).toBeLessThan(commandAt('brew tap "'))
  })

  it('removes the local stand-in before tapping the remote', () => {
    // Two formulae called `ralph` tapped at once is the ambiguity the step's comment
    // says was NOT measured ("which of the two brew would do was NOT measured"). The
    // way to not depend on the answer is to never be in that state, which is an
    // ordering property: untap first, tap second.
    expect(commandAt('brew untap')).toBeLessThan(commandAt('brew tap "'))
  })

  it('taps, then installs, then asks what it installed', () => {
    // The end of the chain. `brew install ralph` before `brew tap` would be answered by
    // whatever brew already knows — on a runner, `ralph-orchestrator`'s neighbourhood
    // and not this tap — and a `ralph --version` read before the install is a reading
    // of the pre-flight's keg.
    expect(commandAt('brew tap "')).toBeLessThan(commandAt('brew install ralph'))
    expect(commandAt('brew install ralph')).toBeLessThan(commandAt('ralph --version'))
  })
})

describe('#216 QA — the gate, evaluated rather than pattern-matched', () => {
  it('reads the SECRET boolean by name, not merely some env boolean', () => {
    // `/env\.[A-Z_]+ == 'true'/` matches `env.SOMETHING_ELSE == 'true'` just as
    // happily, and the equality against the push step's `if` is satisfied by both steps
    // reading the same WRONG boolean. So the key is re-derived from the job's env block
    // by the shape #202 already identifies it by — `secrets.X != ''` — and the gate has
    // to name that one.
    expect(ifOf(smoke())).toContain(`env.${secretBooleanKey()} == 'true'`)
  })

  it('holds on the push path and on NEITHER skip path', () => {
    // The criterion in its own terms: "The step runs only when the push step ran — not
    // on the skip paths." That is a truth table over two inputs, so it is asserted as
    // one. A regex over the `if` cannot answer it — `carries_version == 'true'` would
    // match `toContain("carries_version == 'false'")`… no, but an `||` between the two
    // terms passes every text assertion the dev's file makes and makes the step run
    // with no secret and nothing pushed. Here it throws with the term named.
    const gate = ifOf(smoke())
    expect(gate, 'the smoke step carries no `if` at all').not.toBe('')
    expect(gateHolds(gate, world('false', 'true')), 'the push ran and the step skipped').toBe(true)
    expect(gateHolds(gate, world('true', 'true')), 'the idempotence skip still runs it').toBe(false)
    expect(gateHolds(gate, world('false', 'false')), 'a missing secret still runs it').toBe(false)
    expect(gateHolds(gate, world('true', 'false')), 'both skips still run it').toBe(false)
  })

  it('reaches for no `always()`, which would grade a tap nothing pushed to', () => {
    // The other half of "runs only when the push step ran", and the half no text in
    // either file mentions. GitHub skips the steps after a FAILED step unless their
    // `if` names `always()`, `failure()` or `cancelled()` — so the plain conjunction
    // above is also what keeps this step from running when the push itself blew up,
    // where the tap holds the previous release and `ralph --version` would report it.
    // It is exactly the edit somebody reaches for when a red smoke test looks like it
    // is "hiding" the push's own error, so it is worth a spec.
    expect(ifOf(smoke())).not.toMatch(/always\(|failure\(|cancelled\(/)
  })
})

describe('#216 QA — the tap name is derived, and the derivation is checked', () => {
  const TAP_REPO = String(HOMEBREW?.env?.TAP_REPO ?? '')

  it('derives it from TAP_REPO and spells the tap name nowhere', () => {
    // "One identity, one place it is written down" — the step's claim. Worth pinning
    // because the failure mode of a second copy is a step that taps somebody else's
    // repository and reports a green install of it.
    expect(smokeCommands()).toMatch(/TAP_NAME="\$\{TAP_REPO[^}]*\}"/)
    const tapName = TAP_REPO.replace(/^([^/]+)\/homebrew-/, '$1/')
    expect(smokeCommands(), `the tap name \`${tapName}\` is written out as a literal`).not.toContain(
      tapName,
    )
  })

  it('gets the right tap name out of the repo the job is actually pointed at', () => {
    // `${TAP_REPO/homebrew-/}` is an UNANCHORED FIRST-MATCH replacement, and the
    // tap-name rule it is standing in for is anchored: a tap `<owner>/<name>` lives at
    // `github.com/<owner>/homebrew-<name>`, so the prefix that comes out is the one
    // after the slash. The two agree for `lucasfe/homebrew-ralph` and disagree for an
    // owner whose own name carries the prefix — `homebrew-mac/homebrew-ralph` derives
    // `mac/homebrew-ralph`, a tap that does not exist, and the step would then `brew
    // tap` it and fail with brew's 404 rather than with anything a reader can act on.
    //
    // So this spec does not assert the expansion's TEXT (the dev's spec does that); it
    // APPLIES it to the TAP_REPO in the job's env and checks the answer against the
    // anchored rule. A repo edit that breaks the derivation goes red here, in the file
    // that made the edit possible.
    expect(TAP_REPO, 'TAP_REPO is not a `<owner>/homebrew-<name>` tap repository').toMatch(
      /^[^/]+\/homebrew-[^/]+$/,
    )
    const expansion = /TAP_NAME="\$\{TAP_REPO\/([^/}]*)\/([^}]*)\}"/.exec(smokeCommands())
    expect(
      expansion,
      'TAP_NAME is no longer a `${TAP_REPO/pattern/replacement}` expansion, so this ' +
        'spec can no longer model the derivation — re-derive it or replace this check',
    ).not.toBeNull()
    const [, pattern, replacement] = expansion
    // bash's pattern half is a GLOB. `String.replace` with a string needle is the same
    // operation only while the pattern has no metacharacters, so the spec refuses to
    // pretend otherwise rather than quietly modelling the wrong thing.
    expect(pattern, 'the expansion grew a glob this spec models as a literal').not.toMatch(
      /[*?[\]]/,
    )
    expect(TAP_REPO.replace(pattern, replacement)).toBe(TAP_REPO.replace(/^([^/]+)\/homebrew-/, '$1/'))
  })
})

describe('#216 QA — nothing the shell reads is undeclared', () => {
  it('declares every variable it expands, in the step env or the job env', () => {
    // GitHub runs a `run:` block as `bash -e {0}`: no `-u`. This workflow sets no
    // `defaults.run.shell` and no step sets `shell:`, so an expansion of a name nobody
    // declared is the empty string and not an error — `brew untap "$PREFLIGHT_TAPP"`
    // becomes `brew untap ""`, and `TAP_NAME="${TAP_REPOO/homebrew-/}"` becomes an
    // empty tap name that `brew tap ""` reports in brew's words rather than in the
    // job's. This step reads FOUR names it does not assign, three of them out of the
    // job's env block and one out of its own, which is more indirection than any other
    // step in the job has.
    const commands = smokeCommands()
    const assigned = new Set(
      [...commands.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1]),
    )
    // Set by the runner itself, not by this workflow.
    const RUNNER_PROVIDED = new Set(['RUNNER_TEMP', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'HOME', 'PATH'])
    const declared = [
      ...Object.keys(HOMEBREW?.env ?? {}),
      ...Object.keys(smoke()?.env ?? {}),
    ]
    const referenced = new Set(
      [...commands.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]),
    )
    expect(referenced.size, 'the step expands nothing at all, which cannot be right').toBeGreaterThan(0)
    for (const name of referenced) {
      if (assigned.has(name) || RUNNER_PROVIDED.has(name)) continue
      expect(declared, `the step expands \`$${name}\`, which nothing declares`).toContain(name)
    }
  })

  it('cannot pass with an empty VERSION', () => {
    // THE ONE WAY THIS STEP CAN GO GREEN WITHOUT CHECKING ANYTHING. The verdict is
    // `[[ "$INSTALLED" != *"$VERSION"* ]]`, and with VERSION empty that is
    // `[[ "$INSTALLED" != ** ]]` — false for every possible install, including a tap
    // serving the previous release. Under `-e` alone nothing catches it: the expansion
    // is legal, the test succeeds, the step is green, and the assertion it exists to
    // make has evaporated.
    //
    // Reachable how, exactly: not from the probe as it stands today —
    // scripts/homebrew-tap-plan.js writes `version=`, `tarball_url=` and
    // `carries_version=` in one `process.stdout.write`, so the output is there whenever
    // `carries_version` is. It is reachable from an EDIT: a renamed output, a renamed
    // step id, a `VERSION: ${{ steps.tap.outputs.tap_version }}` typo, or the same
    // rename that #216's own diff had to make in three other comments. Every one of
    // those turns this step from a check into a decoration, silently, and the run stays
    // green — which is exactly the shape CONTRIBUTING's "A spec that cannot go red
    // (#122)" is about, applied to the workflow rather than to a test file.
    //
    // Any of the ordinary guards satisfies this: `${VERSION:?…}`, an explicit `-z` or
    // `-n` test, or a `set -u` at the top of the step. The spec asks for a guard, not
    // for a spelling.
    const commands = smokeCommands()
    const guarded =
      /\$\{VERSION:[?]/.test(commands) ||
      /-[zn]\s+"?\$\{?VERSION\}?"?/.test(commands) ||
      /^\s*set\s+-[a-z]*u/m.test(commands)
    expect(
      guarded,
      'nothing stops an empty $VERSION from making the version check vacuous: with ' +
        'VERSION unset, `[[ "$INSTALLED" != *"$VERSION"* ]]` is false for every ' +
        'install, so the step passes on any formula the tap serves. Add a guard — ' +
        '`: "${VERSION:?the probe reported no version}"`, an explicit `-z` test, or ' +
        '`set -u`.',
    ).toBe(true)
  })
})

describe('#216 QA — the prose is held to what was measured', () => {
  const jobProse = () => proseOf(homebrewSource())
  const smokeProse = () => proseOf(smokeSource())

  // The two Homebrews this job's figures were taken on, and which is which. Both are
  // read out of the file's own prose; `7.0.0` is additionally the version of the brew on
  // the machine these specs were written on (`brew --version` -> Homebrew 7.0.0, run
  // 2026-09-14), which is why the trust and tap figures could be taken at all and the
  // 6.0.21 pre-flight figures could not be re-taken.
  const PREFLIGHT_HOMEBREW = '6.0.21-34-ga8820d0'
  const TRUST_HOMEBREW = '7.0.0'

  it('cites both Homebrews it took figures on', () => {
    // Fails closed for the spec below: it argues that a universal claim naming ONE of
    // these is false because the OTHER is also cited, so both have to be here for the
    // argument to be about anything.
    expect(jobProse(), 'the pre-flight figures no longer name the Homebrew they were taken on').toContain(
      PREFLIGHT_HOMEBREW,
    )
    expect(smokeProse(), 'the smoke step no longer names the Homebrew the trust gate was measured on').toContain(
      TRUST_HOMEBREW,
    )
  })

  it('attributes its Homebrew figures to the versions they were taken on', () => {
    // THE CLAIM UNDER TEST, quoted from the smoke step's `brew trust` block:
    //
    //   "Every Homebrew figure written down in this job was taken on
    //    6.0.21-34-ga8820d0, #216 reports the runner on 6.0.21 too, …"
    //
    // It is false, and the counter-example is thirty lines above it in the same block:
    // the refusal is labelled "MEASURED by hand on 2026-09-13, Homebrew 7.0.0", the
    // `brew commands` probe "Measured on 7.0.0", and `brew help trust` is quoted "on
    // 7.0.0" twice more. Those are Homebrew figures, they are written down in this job,
    // and they were not taken on 6.0.21-34-ga8820d0. What is true is narrower and is
    // what the sentence was reaching for: the PRE-FLIGHT figures (the disabled
    // `brew audit [path ...]`, the `tap-new` dry run, the `audit --strict` and `style`
    // runs) came from 6.0.21-34-ga8820d0, the trust and tap figures in this block came
    // from 7.0.0, and neither is the runner's — #216 reports that on 6.0.21, which is
    // the thing the guard is actually for.
    //
    // WHY A SPEC AND NOT JUST A FIX: a version attribution is the one kind of comment
    // in this file that decays on its own. The trust figures were taken on a machine
    // that had been upgraded since the pre-flight ones were, and the next measurement
    // will be taken on something else again — so "all of the figures here came from X"
    // is a sentence that is at best true on the day it is written. This spec refuses
    // the shape rather than the sentence: a universal claim scoped to the whole job or
    // file, naming a version, while a second measured version is cited in it.
    //
    // A claim scoped to a STEP or to the pre-flight is deliberately out of scope — a
    // narrower attribution is the correct fix, and a spec that went red on the fix
    // would be worse than no spec.
    const universal =
      /\b(?:every|all|each)\b[^.]{0,160}?\bin this (?:job|file)\b[^.]{0,200}?\b(?:taken|measured)\b[^.]{0,60}?(\d+\.\d+\.\d+(?:-\d+-g[0-9a-f]+)?)/i
    const claim = universal.exec(jobProse())
    const alsoCited = claim
      ? [PREFLIGHT_HOMEBREW, TRUST_HOMEBREW].filter(
          (version) => version !== claim[1] && jobProse().includes(version),
        )
      : []
    expect(
      alsoCited,
      claim
        ? `"${claim[0]}" is false: this job also writes down figures taken on ` +
          `${alsoCited.join(' and ')}. Scope the attribution to the measurements it ` +
          `covers instead — the pre-flight figures came from ${PREFLIGHT_HOMEBREW}, ` +
          `the trust and tap figures from ${TRUST_HOMEBREW}, and the runner is a third ` +
          `thing (#216 reports 6.0.21).`
        : 'unreachable',
    ).toEqual([])
  })

  it('quotes `brew help trust` for the flag it runs, not for a neighbouring one', () => {
    // The step prefers `--tap` over `--formula` and says so at length, quoting
    // `brew help trust` for the flag's own documentation. Both quotations were checked
    // against the real thing on this machine (Homebrew 7.0.0, 2026-09-14): `brew help
    // trust` prints "Trust non-official tap formulae, casks or commands so Homebrew may
    // load them." and "--tap, --taps  Trust the named tap.", so the step's prose is
    // accurate — this pins it there, because the flag and its justification are the
    // part of the step a reader is most likely to simplify to the bare `brew trust
    // <tap>` the transcript shows.
    expect(smokeCommands()).toMatch(/brew trust --tap/)
    expect(smokeProse()).toMatch(/Trust the named tap/)
  })

  it('says what a red run here MEANS, not merely that it comes late', () => {
    // The acceptance criterion has two halves — that the step runs after the bytes are
    // public, and what that implies for the failure it reports — and the dev's spec
    // pins only the first (`/already public/i`). The second is the half a reader needs:
    // a red here is not "the release was stopped", it is "the release shipped and
    // nobody can install it", and it is red on purpose rather than by oversight. A
    // reader who has only the first half is a reader who reasonably concludes the step
    // is in the wrong place and moves it.
    expect(smokeProse()).toMatch(/already public/i)
    expect(smokeProse()).toMatch(/fail(?:s|ing)? the job/i)
    expect(smokeProse()).toMatch(/shipped/i)
  })
})
