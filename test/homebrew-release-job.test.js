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
  it('pushes from exactly one step, and that step is last', () => {
    const pushes = steps().filter((step) => runOf(step).includes('git push'))
    expect(pushes).toHaveLength(1)
    expect(stepRunning('git push')).toBe(steps().length - 1)
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
