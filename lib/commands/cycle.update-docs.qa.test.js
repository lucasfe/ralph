import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Volume } from 'memfs'
import { execa } from 'execa'
import { RALPH_HOME } from '../paths.js'
import { runUpdateGate } from '../update-gate.js'
import { resolveUpdateDecision } from '../update-check.js'
import { buildPlist } from '../launchd.js'
import { section, prose, repoMarkdown, STALE_CLAIM_PATTERNS } from '../../test/helpers/doc-guard.js'

// QA augmentation for #53 (document `ralph cycle`'s update notice and prompt).
//
// The dev's guard — lib/commands/cycle.update-docs.test.js — reads the real
// README.md and bin/ralph.js off disk and asserts the #53 claims are written
// down. That is the right shape for a docs contract, and this file does not
// repeat any of it.
//
// What a docs guard fails at is not "missing an assertion" but being VACUOUS or
// BRITTLE: passing whether or not the docs are right, or going red on an
// innocuous edit. So this file attacks the guard itself, in three directions:
//
//   1. HELPER VACUITY — `section()` returns '' for a heading it cannot find,
//      which silently disarms every `not.` assertion made against the slice.
//      Driven here with crafted input: the depth arithmetic, the EOF branch, the
//      un-anchored `indexOf`, and the normalization the claims depend on.
//   2. DOCS-vs-CODE TRUTH — every #53 claim is a claim about real behavior. The
//      dev's suite proves each one is WRITTEN; these tests tie the load-bearing
//      ones back to the code that makes them TRUE, so the docs cannot rot when
//      lib/update-gate.js, lib/commands/cycle.js, lib/commands/doctor.js or
//      lib/launchd.js changes under them.
//   3. THE STALE-CLAIM SWEEP — false-positive controls on the legitimate prose
//      that talks about the check without denying it, plus the wrap-inside-a-
//      phrase case that makes normalization mandatory.
//
// The helpers under test are IMPORTED from test/helpers/doc-guard.js, the module
// the dev's suite runs on too. An earlier version of this file re-derived them
// verbatim so it could drive them with crafted input; that made every defect
// found here a defect of a copy, and left the two guards free to drift. Sharing
// the module makes the crafted-input tests below strictly stronger — they now
// exercise the real thing.
//
// Two directions that used to be here are GONE rather than documented, because
// what they characterized has been deleted: the dev's `commandDescription()`
// source parser (a regex over bin/ralph.js that a trailing `// update check`
// comment could satisfy) and the strict string-literal lexer this file wrote to
// out-parse it. Both are replaced by spawning `ralph cycle --help` — the surface
// the acceptance criterion is about, which no comment shape, formatter or
// extraction bug can fake. The `--help` tests kept below are what remains.
//
// Nothing here mutates README.md or bin/ralph.js. Crafted input is plain strings
// and memfs.

const README = readFileSync(join(RALPH_HOME, 'README.md'), 'utf8')
const BIN_PATH = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))
const BIN = readFileSync(BIN_PATH, 'utf8')
const CYCLE_SRC = readFileSync(join(RALPH_HOME, 'lib', 'commands', 'cycle.js'), 'utf8')
const DOCTOR_SRC = readFileSync(join(RALPH_HOME, 'lib', 'commands', 'doctor.js'), 'utf8')

// The exact one-liner #53 shipped. Pinned as a constant so every assertion below
// is about the same string and a reword shows up once, here.
const CYCLE_ONE_LINER =
  'Run one queue-processing cycle: preflight, lock, update check, drain, notify. Designed for launchd / cron schedules.'

const stripAnsi = (s) => s.replace(/\u001B\[[0-9;]*m/g, '')

const UPDATING_RAW = section(README, '## Updating Ralph')
const WEEKLY_RAW = section(UPDATING_RAW, '### The weekly check')
const WEEKLY = prose(WEEKLY_RAW)


function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => stripAnsi(chunks.join('')),
  }
}

describe('`ralph cycle` update docs — QA augmentation (#53)', () => {
  // =========================================================================
  // 1. HELPER VACUITY
  // =========================================================================
  describe('section(): what it returns when it does not find what it wants', () => {
    it("returns '' for a heading that is not there — which disarms `not.` assertions", () => {
      // The dev's suite is anchored against this (it asserts each slice is over
      // 1000-2000 chars before relying on it), so this is a pin, not a
      // complaint: it records WHY that anchoring is load-bearing, so nobody
      // deletes it as noise. On '' every `not.toMatch`/`not.toContain` passes.
      expect(section(README, '## No Such Heading')).toBe('')
      expect(section(README, '## No Such Heading')).not.toContain('anything at all')
    })

    it('the sibling heading the dev slices AGAINST really exists', () => {
      // cycle.update-docs.test.js:107 proves the weekly slice stops early with
      // `expect(WEEKLY_RAW).not.toContain('### Where the check keeps its state')`.
      // That assertion is only a boundary proof while that heading exists — rename
      // the section and it passes for the trivial reason, leaving the scoping the
      // whole suite depends on unverified. Nothing in the dev's suite asserts it.
      expect(README).toContain('### Where the check keeps its state')
    })

    it('the boundary holds for PROSE, not just for the heading text', () => {
      // Stronger than matching the heading: a sentence that only exists in the
      // NEXT subsection must be absent from the weekly slice. This survives a
      // heading rename, so the scoping stays proven either way.
      const nextSectionOnly = 'Both 7-day windows are **global, not per-repo**'
      expect(README).toContain(nextSectionOnly)
      expect(WEEKLY_RAW).not.toContain(nextSectionOnly)
    })

    it('runs to EOF when its section is the last one', () => {
      // Undocumented branch (`next === -1`). Worth pinning because a doc author
      // appending a new `##` after "Updating Ralph" changes which branch every
      // slice in the dev's suite takes.
      const md = '# T\n\n## A\n\nalpha\n\n## Last\n\nomega\n'
      expect(section(md, '## Last')).toContain('omega')
      expect(section(md, '## A')).toContain('alpha')
      expect(section(md, '## A')).not.toContain('omega')
    })

    it('ends a `###` slice on a sibling `###` but not on a nested `####`', () => {
      // The depth arithmetic the scoping rests on. A `####` under "The weekly
      // check" must stay INSIDE the slice (otherwise adding a sub-subsection
      // silently truncates every claim below it), and a sibling `###` must end it.
      const md = '### Weekly\n\nclaim one\n\n#### Detail\n\nclaim two\n\n### Sibling\n\nelsewhere\n'
      const slice = section(md, '### Weekly')
      expect(slice).toContain('claim one')
      expect(slice).toContain('claim two')
      expect(slice).not.toContain('elsewhere')
    })

    it("its indexOf is not line-anchored, so today's README must not repeat a heading literal", () => {
      // `md.indexOf('## Updating Ralph\n')` matches anywhere, including inside a
      // deeper heading (`### Updating Ralph`) or a code fence. That is fine only
      // as long as each heading literal occurs once; assert it, so a future doc
      // that reuses the wording cannot silently re-point the slice.
      for (const heading of [
        '## Updating Ralph',
        '### The weekly check',
        '### Where the check keeps its state',
      ]) {
        expect(README.split(heading).length - 1).toBe(1)
      }
    })
  })

  describe('prose(): the normalization is load-bearing, not decoration', () => {
    it('is what makes the hard-wrapped "never auto-updates" claim matchable at all', () => {
      // Direct proof the dev was right to normalize: #53's own headline claim is
      // wrapped THROUGH THE MIDDLE in the file. A guard written against the raw
      // text would have to be written around today's column positions.
      expect(README).not.toContain('never auto-updates')
      expect(prose(README)).toContain('never auto-updates on a schedule')
    })

    it('is idempotent, so re-normalizing a slice cannot change a verdict', () => {
      expect(prose(prose(WEEKLY_RAW))).toBe(prose(WEEKLY_RAW))
    })
  })

  // =========================================================================
  // 2. `--help` REALITY — the user-visible surface, not a source string
  // =========================================================================
  describe('the description actually reaches `--help`', () => {
    // The dev asserts on the source literal, which is one inference away from the
    // thing the acceptance criterion is about ("`bin/ralph.js`'s cycle command
    // description mentions the update check" — i.e. what a scheduler owner reads).
    // Spawning the CLI removes the inference. It is safe to do: commander prints
    // help and exits before the action runs, so nothing shells out to git, gh or
    // npm, nothing is written, and nothing is read but package.json. ~90ms, and
    // lib/commands/update.test.js:615-631 already spawns `--help` the same way.
    it('`ralph cycle --help` prints the one-liner, update check included', async () => {
      const r = await execa('node', [BIN_PATH, 'cycle', '--help'], { reject: false })
      expect(r.exitCode).toBe(0)
      // Commander hard-wraps help output, so the printed one-liner is broken
      // across lines exactly the way the README is — normalize before matching.
      expect(prose(r.stdout)).toContain(CYCLE_ONE_LINER)
      expect(prose(r.stdout)).toMatch(/update check/i)
    })

    it('`ralph --help` shows the update check on the `cycle` row', async () => {
      const r = await execa('node', [BIN_PATH, '--help'], { reject: false })
      expect(r.exitCode).toBe(0)
      // In the command table the row wraps mid-phrase ("… lock, update\n
      // check, drain …"), which is the concrete reason a raw-text guard on help
      // output would be wrong. Scope to the row so a mention under some other
      // command cannot satisfy this.
      const row = prose(r.stdout).match(/\bcycle\s+Run one queue-processing[^|]*?schedules\./)
      expect(row).toBeTruthy()
      expect(row[0]).toMatch(/update check/i)
    })

    it('no rationale comment leaks into help output', async () => {
      const r = await execa('node', [BIN_PATH, 'cycle', '--help'], { reject: false })
      const all = `${r.stdout}${r.stderr}`
      expect(all).not.toContain('#53')
      expect(all).not.toContain('earns its place')
      expect(all).not.toContain('scheduler owner')
    })

    it('`cycle --help` does not RUN the cycle', async () => {
      // Hermeticity proof for the two tests above: help must short-circuit before
      // the action, or this file would be starting real cycles in CI.
      const r = await execa('node', [BIN_PATH, 'cycle', '--help'], { reject: false })
      expect(r.stdout).not.toContain('RALPH_CYCLE_EVENT')
      expect(r.stdout).not.toMatch(/New version available/)
      expect(r.stderr).toBe('')
    })
  })

  // =========================================================================
  // 3. DOCS-vs-CODE TRUTH — each claim tied to the code that makes it true
  // =========================================================================
  describe('"Ralph never auto-updates on a schedule" is true of lib/update-gate.js', () => {
    it('a non-TTY run with an OPEN prompt window still installs nothing', () => {
      // The strongest form of the claim: the weekly prompt window is open and the
      // decision says something newer exists — every precondition for an install
      // is met except a terminal. `runUpdateGate` gates the question on
      // `shouldPrompt && isTTY` (lib/update-gate.js:210), so a launchd tick
      // notifies and stops there. If that `&& isTTY` were ever dropped, the
      // README sentence becomes a lie and this test is what says so.
      expect(prose(WEEKLY)).toContain('never auto-updates on a schedule')

      const stdout = makeStream()
      const asked = []
      const installed = []
      return runUpdateGate({
        currentVersion: '1.0.0',
        isTTY: false,
        stdout,
        stderr: makeStream(),
        update: async () => ({ latestVersion: '2.0.0', isNewer: true, shouldPrompt: true }),
        recordPrompt: () => {
          throw new Error('the prompt window must not be stamped on a headless run')
        },
        ask: async (q) => {
          asked.push(q)
          return true
        },
        runUpdate: async () => {
          installed.push('ran')
          return { updated: true, to: '2.0.0' }
        },
      }).then((verdict) => {
        expect(stdout.output()).toContain('New version available: 2.0.0')
        expect(asked).toEqual([])
        expect(installed).toEqual([])
        expect(verdict.prompted).toBe(false)
        expect(verdict.accepted).toBe(false)
        expect(verdict.installed).toBe(false)
      })
    })

    it('the install runs only after an accepted question on a terminal', () => {
      // The other side of the same sentence — "the install runs only after a
      // human answers the question on a terminal". Without this the test above
      // would also pass on a gate that never installs at all.
      const stdout = makeStream()
      const installed = []
      return runUpdateGate({
        currentVersion: '1.0.0',
        isTTY: true,
        stdout,
        stderr: makeStream(),
        update: async () => ({ latestVersion: '2.0.0', isNewer: true, shouldPrompt: true }),
        recordPrompt: () => {},
        ask: async () => true,
        runUpdate: async () => {
          installed.push('ran')
          return { updated: true, to: '2.0.0' }
        },
      }).then((verdict) => {
        expect(installed).toEqual(['ran'])
        expect(verdict.installed).toBe(true)
        expect(verdict.installedVersion).toBe('2.0.0')
      })
    })
  })

  describe('"the check can never block a scheduled tick and never fail one"', () => {
    it('a decision that throws leaves a silent verdict rather than an error', () => {
      // "never fail one" as the code implements it: the decision, the stamp and
      // the install are each guarded, so the worst a broken check can do to a
      // launchd tick is say nothing.
      expect(prose(WEEKLY)).toContain('never block a scheduled tick')
      const stdout = makeStream()
      return runUpdateGate({
        currentVersion: '1.0.0',
        isTTY: false,
        stdout,
        stderr: makeStream(),
        update: async () => {
          throw new Error('registry exploded')
        },
      }).then((verdict) => {
        expect(verdict).toEqual({
          isNewer: false,
          latestVersion: null,
          prompted: false,
          accepted: false,
          installed: false,
          installedVersion: null,
        })
        expect(stdout.output()).toBe('')
      })
    })

    it('a failed install leaves the verdict "not installed", so the pass drains', () => {
      // The README promises a scheduled tick "drains as it always would"; on the
      // hand-run path an accepted-but-failed install must fall through to the
      // drain rather than stopping. `installed` is what cycle.js branches on, and
      // it is gated on `updated` — never on `to`, which updateCommand sets even
      // when the install was refused.
      return runUpdateGate({
        currentVersion: '1.0.0',
        isTTY: true,
        stdout: makeStream(),
        stderr: makeStream(),
        update: async () => ({ latestVersion: '2.0.0', isNewer: true, shouldPrompt: true }),
        recordPrompt: () => {},
        ask: async () => true,
        runUpdate: async () => ({ updated: false, to: '2.0.0' }),
      }).then((verdict) => {
        expect(verdict.accepted).toBe(true)
        expect(verdict.installed).toBe(false)
        expect(verdict.installedVersion).toBeNull()
      })
    })

    it('the one boundary that is NOT swallowed is a stdout that cannot be written', () => {
      // Precision pin, not a contradiction: the README's "never fail one" is
      // about the CHECK's own failures (registry, cache, decision, install). A
      // terminal that throws on write is deliberately left unguarded
      // (lib/update-gate.js:30-41 explains why), so this records the scope of the
      // documented promise instead of leaving a reader to discover the exception.
      const exploding = {
        write: () => {
          throw new Error('EPIPE')
        },
      }
      return expect(
        runUpdateGate({
          currentVersion: '1.0.0',
          isTTY: false,
          stdout: exploding,
          stderr: makeStream(),
          update: async () => ({ latestVersion: '2.0.0', isNewer: true, shouldPrompt: false }),
        }),
      ).rejects.toThrow(/EPIPE/)
    })
  })

  describe('"the cycle stops without draining the queue" is true of lib/commands/cycle.js', () => {
    // Structural rather than behavioral: the dev's #52 suite already drives
    // cycleCommand end to end. What is NOT covered anywhere is the TIE — if the
    // installed branch ever grew a drain, or stopped zeroing its counts, the
    // README paragraph would rot with nothing to notice.
    //
    // Comments are stripped first, and that matters here more than anywhere else
    // in this file: cycle.js's own #52 rationale comment contains the phrases
    // "STOP, without draining" and "`skipped: true`", so an unstripped slice
    // would let the comment satisfy assertions about the code.
    const stripComments = (s) => s.replace(/^[ \t]*\/\/.*$/gm, '')
    const installedAt = CYCLE_SRC.indexOf('if (updateGate.installed)')
    const acceptedAt = CYCLE_SRC.indexOf('} else if (updateGate.accepted)', installedAt)
    const drainAt = CYCLE_SRC.indexOf('await runQueueOnce(')
    const branch = stripComments(CYCLE_SRC.slice(installedAt, acceptedAt))

    it('the branch is where this file thinks it is', () => {
      // Anchor, so every assertion below is about a real slice of the file.
      expect(installedAt).toBeGreaterThan(-1)
      expect(acceptedAt).toBeGreaterThan(installedAt)
      expect(drainAt).toBeGreaterThan(-1)
      expect(branch.length).toBeGreaterThan(80)
    })

    it('returns before the drain, and never drains inside the branch', () => {
      expect(prose(WEEKLY)).toContain('stops without draining the queue')
      expect(installedAt).toBeLessThan(drainAt)
      expect(branch).not.toContain('runQueueOnce')
      expect(branch).toMatch(/return \{[^}]*exitCode: 0/)
    })

    it('emits the `updated` status with every count zero, as documented', () => {
      // The README states the exact event shape ("status `updated`, every count
      // zero") because the daily heartbeat depends on it. Pinned against the code
      // that emits it.
      expect(prose(WEEKLY)).toMatch(/status\s*`?updated`?, every count zero/i)
      expect(branch).toMatch(/emitEvent\(\{\s*status: 'updated'/)
      for (const zeroed of ['ok: 0', 'failed: 0', 'durationMin: 0', 'processed: 0']) {
        expect(branch).toContain(zeroed)
      }
      expect(branch).toMatch(/status: 'updated', processed: 0, skipped: true/)
    })
  })

  describe('"`ralph doctor` … stamps neither window" is true of lib/commands/doctor.js', () => {
    it('doctor only ever READS the cache: no write, no stamp, no registry query', () => {
      // The claim #53 added, and the one the issue text got backwards. The dev
      // documented the truth and asserts the sentence exists; this ties it to the
      // imports that make it true, so adding a write to doctor turns the README
      // paragraph red instead of silently wrong.
      expect(WEEKLY).toMatch(/`ralph doctor`[\s\S]{0,300}?stamps neither window/i)
      const src = DOCTOR_SRC.replace(/^[ \t]*\/\/.*$/gm, '')
      expect(src).toContain('readVersionCache')
      for (const forbidden of [
        'writeVersionCache',
        'recordPromptShown',
        'resolveUpdateDecision',
        'fetchLatestVersion',
        'runUpdateGate',
      ]) {
        expect(src, `doctor.js must not reference ${forbidden}`).not.toContain(forbidden)
      }
    })
  })

  describe('"RALPH_NO_UPDATE_CHECK … in `ralph cycle`" is true of the shipped wiring', () => {
    it('cycle defaults its decision seam to the function that honours the opt-out', () => {
      // Two links in one chain: cycle.js's `update` default IS
      // resolveUpdateDecision, and resolveUpdateDecision short-circuits on the
      // env var. Without the first link the env-var row could be true of
      // `ralph start` only.
      const src = CYCLE_SRC.replace(/^[ \t]*\/\/.*$/gm, '')
      expect(src).toMatch(/update = resolveUpdateDecision/)
      expect(src).toContain("from '../update-check.js'")
    })

    it('the real decision path makes no registry query and prints nothing when set', () => {
      // Behavioral, through the REAL resolveUpdateDecision (left as
      // runUpdateGate's default) rather than a stub, with memfs standing in for
      // ~/.config so nothing outside the repo is touched. `exec` is the registry
      // query: it must never be called.
      const envRow = README.split('\n').find((l) => /^\|\s*`RALPH_NO_UPDATE_CHECK`/.test(l))
      expect(envRow).toMatch(/`ralph cycle`/)

      const execCalls = []
      const stdout = makeStream()
      const asked = []
      return runUpdateGate({
        currentVersion: '0.0.1',
        isTTY: true,
        processEnv: { RALPH_NO_UPDATE_CHECK: '1' },
        home: '/home/qa',
        cacheFs: Volume.fromJSON({ '/home/qa/.keep': '' }, '/'),
        exec: async (...args) => {
          execCalls.push(args)
          return { exitCode: 0, stdout: '99.0.0', stderr: '' }
        },
        stdout,
        stderr: makeStream(),
        update: resolveUpdateDecision,
        ask: async (q) => {
          asked.push(q)
          return true
        },
        runUpdate: async () => ({ updated: true, to: '99.0.0' }),
      }).then((verdict) => {
        expect(execCalls).toEqual([])
        expect(stdout.output()).toBe('')
        expect(asked).toEqual([])
        expect(verdict.isNewer).toBe(false)
        expect(verdict.installed).toBe(false)
      })
    })
  })

  describe('"launchd captures in `logs/ralph-cycle.out.log`" is true of lib/launchd.js', () => {
    const plist = buildPlist({
      slug: 'acme-repo',
      command: '/usr/local/bin/ralph',
      args: ['cycle'],
      intervalSeconds: 14400,
      workingDirectory: '/repos/acme',
      logDir: '/repos/acme/logs',
      kind: 'cycle',
    })

    it('the notice really lands in the file the README names', () => {
      // The weekly-check section names a literal path. A rename in
      // KIND_CONFIG.logBase would send the notice somewhere else and leave the
      // README pointing at a file that no longer exists.
      expect(WEEKLY).toContain('logs/ralph-cycle.out.log')
      expect(plist).toContain('<key>StandardOutPath</key>')
      expect(plist).toContain('<string>/repos/acme/logs/ralph-cycle.out.log</string>')
    })

    it('the agent gets no terminal, which is why a scheduled tick can only print', () => {
      // "launchd attaches no terminal" grounded in the plist: there is no stdin
      // key at all, so `Boolean(stdin?.isTTY)` in cycleCommand is false by
      // construction rather than by convention.
      expect(WEEKLY).toContain('launchd attaches no terminal')
      expect(plist).not.toContain('StandardInPath')
      expect(plist).not.toContain('<key>TTY')
    })

    it('an exported RALPH_NO_UPDATE_CHECK does not reach the agent on its own', () => {
      // The README's sharpest scheduling caveat — "has to reach the launchd
      // agent, which is not the same thing as exporting it in your shell". True
      // because EnvironmentVariables is the plist's only env channel: what is not
      // passed in at install time is not there.
      expect(prose(WEEKLY)).toMatch(/has to reach the launchd agent/)
      expect(plist).not.toContain('RALPH_NO_UPDATE_CHECK')
      const withOptOut = buildPlist({
        slug: 'acme-repo',
        command: 'ralph',
        args: ['cycle'],
        intervalSeconds: 14400,
        workingDirectory: '/repos/acme',
        logDir: '/repos/acme/logs',
        environment: { RALPH_NO_UPDATE_CHECK: '1' },
        kind: 'cycle',
      })
      expect(withOptOut).toContain('<key>RALPH_NO_UPDATE_CHECK</key>')
    })
  })

  // =========================================================================
  // 4. THE STALE-CLAIM SWEEP — the walk, and the controls on its patterns
  // =========================================================================
  // The sweep itself (every doc file x every pattern) runs in the dev's suite off
  // the same shared `repoMarkdown` + `STALE_CLAIM_PATTERNS`. What is left here is
  // what that sweep cannot say about itself: that the WALK finds what it claims
  // to, and that the PATTERNS are narrow enough not to punish honest prose.
  describe('repoMarkdown(): the walk finds what the sweep claims to sweep', () => {
    it('reaches nested markdown under templates/, not just its top level', () => {
      // `DOC_FILES.length > 0` would be satisfied by the root files alone, so a
      // walk that never recursed could pass the sweep. Assert the nested halves.
      const templates = repoMarkdown({ dir: 'templates' })
      expect(templates).toContain(join('templates', 'PROMPT.md'))
      expect(templates.some((p) => p.includes(join('templates', 'roles')))).toBe(true)
      expect(templates.length).toBeGreaterThan(5)
      expect(repoMarkdown({ dir: 'docs' })).toContain(join('docs', 'team-mode-spike.md'))
    })

    it('returns [] for a directory that does not exist, without throwing', () => {
      // docs/ is not tracked as a required directory anywhere; deleting it must
      // shrink the sweep, not break the suite.
      expect(repoMarkdown({ dir: 'no-such-dir' })).toEqual([])
    })

    it('excludes CHANGELOG.md, which is history rather than a live claim', () => {
      // The one deliberate exclusion. A released entry describing pre-#51
      // behavior is a record of what was true then, not a stale claim now — but
      // it must be excluded ON PURPOSE and visibly, not by accident.
      const all = repoMarkdown()
      expect(all).not.toContain('CHANGELOG.md')
      expect(existsSync(join(RALPH_HOME, 'CHANGELOG.md'))).toBe(true)
    })

    it('walks a crafted tree exactly as it walks the real one', () => {
      // memfs, so the recursion and the `.md` filter are exercised against input
      // the real repo does not happen to contain: a nested-nested file, a
      // non-markdown sibling, a directory whose name ends in `.md`, and a
      // CHANGELOG.md that must be skipped at depth too.
      const vol = Volume.fromJSON(
        {
          '/repo/docs/a.md': '#',
          '/repo/docs/notes.txt': 'x',
          '/repo/docs/deep/b.md': '#',
          '/repo/docs/deep/deeper/c.md': '#',
          '/repo/docs/trap.md/inner.md': '#',
          '/repo/docs/CHANGELOG.md': '#',
        },
        '/',
      )
      const found = repoMarkdown({ dir: 'docs', root: '/repo', fs: vol }).sort()
      expect(found).toEqual(
        [
          join('docs', 'a.md'),
          join('docs', 'deep', 'b.md'),
          join('docs', 'deep', 'deeper', 'c.md'),
          join('docs', 'trap.md', 'inner.md'),
        ].sort(),
      )
    })

    it('skips vendor and runtime directories, so the sweep stays bounded', () => {
      // node_modules alone carries thousands of .md files; a walk that entered it
      // would turn the sweep into a minutes-long scan of other people's docs and
      // would flag prose nobody here can edit.
      const vol = Volume.fromJSON(
        {
          '/repo/README.md': '#',
          '/repo/node_modules/pkg/README.md': '#',
          '/repo/dist/out.md': '#',
          '/repo/logs/run.md': '#',
          '/repo/.ralph/state.md': '#',
        },
        '/',
      )
      expect(repoMarkdown({ root: '/repo', fs: vol })).toEqual(['README.md'])
    })

    it('survives an entry that vanishes between the readdir and the stat', () => {
      // The real failure this guards, not a hypothetical: vitest transforms
      // `vitest.config.js` by writing `vitest.config.js.timestamp-<n>.mjs` beside it
      // and unlinking it immediately, so the repo root gains and loses a file while
      // the sweep is walking it. The walk used to die on that `ENOENT` — and only
      // under enough parallel load to overlap a transform with a sweep, which is the
      // worst way for it to fail: green on one branch, red once the suite grows.
      const vol = Volume.fromJSON({ '/repo/README.md': '#', '/repo/docs/a.md': '#' }, '/')
      const fs = {
        existsSync: (p) => vol.existsSync(p),
        readdirSync: (p) => [...vol.readdirSync(p), 'vitest.config.js.timestamp-1787754013931.mjs'],
        statSync: (p) => vol.statSync(p),
      }
      expect(repoMarkdown({ root: '/repo', fs })).toEqual(['README.md', join('docs', 'a.md')])
    })

    it('still throws on a stat failure that is NOT a vanished entry', () => {
      // The narrowness is the point. A sweep whose value is completeness must not
      // quietly get smaller, so only `ENOENT` is forgiven — an unreadable directory
      // has to fail loudly rather than shrink the file list nobody is watching.
      const vol = Volume.fromJSON({ '/repo/README.md': '#' }, '/')
      const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      const fs = {
        existsSync: (p) => vol.existsSync(p),
        readdirSync: (p) => [...vol.readdirSync(p), 'locked'],
        statSync: (p) => {
          if (String(p).endsWith('locked')) throw denied
          return vol.statSync(p)
        },
      }
      expect(() => repoMarkdown({ root: '/repo', fs })).toThrow(/EACCES/)
    })
  })

  describe('STALE_CLAIM_PATTERNS: narrow enough for honest prose, wide enough to fire', () => {
    it('still fires when the hard wrap falls INSIDE a multi-word phrase', () => {
      // Why the sweep must run on normalized prose. `[^.]` already spans
      // newlines, so a wrap between two of a pattern's own tokens is harmless.
      // What is NOT harmless is a wrap inside a literal phrase the pattern spells
      // out — "update\ncheck", or the backticked command name itself — which is
      // exactly what a ~78-column README produces. Invisible on raw text, caught
      // after normalization.
      for (const wrapped of [
        '`ralph cycle` does not run the update\ncheck.',
        '`ralph\ncycle` does not run the update check.',
      ]) {
        expect(STALE_CLAIM_PATTERNS.some((p) => p.test(wrapped)), wrapped).toBe(false)
        expect(STALE_CLAIM_PATTERNS.some((p) => p.test(prose(wrapped))), wrapped).toBe(true)
      }
    })

    it('does not fire on the legitimate prose that talks about the check', () => {
      // False-positive control, and the reason these patterns are narrow. Every
      // string is real README text that mentions an absent or disabled check
      // without ever claiming `cycle` skips one. A sweep that flagged any of them
      // would force the docs to get vaguer to stay green.
      const legitimate = [
        // doctor's literal output, README ~line 87.
        'version: 0.17.0 — cached latest: unknown (no update check cached yet)',
        // The env-var row: describing how to DISABLE the check is not a claim
        // that it does not happen.
        '| `RALPH_NO_UPDATE_CHECK` | unset (check enabled) | Opts out of the weekly update check in `ralph start` and in `ralph cycle`. When set, the check short-circuits before any registry query, any read or write of `~/.config/ralph/update-check.json`, and any notice.',
        // Troubleshooting: "no throttle", not "no check".
        'The notice is the one part of the update check with no throttle on it at all.',
        // Troubleshooting: a scheduled cycle prints but never asks — true, and
        // must not read as "no check".
        'A scheduled `ralph cycle` prints the same unthrottled notice into `logs/ralph-cycle.out.log`, so on a machine with the launchd agents installed, expect one there per pass as well — and never a question after it, since a launchd run has no terminal to ask on.',
        // #53's own new prose.
        'A scheduled cycle is **notice-only**: launchd attaches no terminal, so the question below is never asked and its window is never spent.',
        'the cycle **stops without draining the queue**, for the reason `ralph start` refuses to launch',
        '`ralph doctor` is the exception that draws from neither: it *reads* that same file for its `cached latest:` line and stamps neither window.',
        // #53's own new scheduling prose, which denies BLOCKING rather than checking.
        'And printing is not asking, so the check can **never block a scheduled tick** and never fail one: it prints, and the pass drains as it always would.',
      ]
      for (const ok of legitimate) {
        for (const pattern of STALE_CLAIM_PATTERNS) {
          expect(prose(ok), `false positive on: ${ok.slice(0, 60)}…`).not.toMatch(pattern)
        }
      }
    })

    it('every pattern in the list is reachable (none is dead weight)', () => {
      // A consolidated list is where an unreachable regex hides: it contributes
      // nothing but reads as coverage. One crafted claim per pattern, asserted
      // index by index, so a pattern that can never fire is named.
      const perPattern = [
        '`ralph cycle` does not check for a new version.',
        'A scheduled `ralph cycle` performs no update check.',
        'There is no update check in `ralph cycle`.',
        '`ralph cycle` skips the update check entirely.',
        '`ralph cycle` does not run the update check.',
        'No update check is performed by `ralph cycle`.',
        'Unlike `ralph start`, `ralph cycle` does not.',
        'A scheduled `ralph cycle` drains the queue without any update check.',
        'The update check runs only in `ralph start`.',
        '`ralph cycle` includes no update check.',
      ]
      expect(perPattern).toHaveLength(STALE_CLAIM_PATTERNS.length)
      for (const [i, pattern] of STALE_CLAIM_PATTERNS.entries()) {
        expect(pattern.test(prose(perPattern[i])), `pattern ${i} never fires`).toBe(true)
      }
    })
  })
})
