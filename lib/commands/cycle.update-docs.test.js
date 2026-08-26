import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { RALPH_HOME } from '../paths.js'
import { section, prose, repoMarkdown, STALE_CLAIM_PATTERNS } from '../../test/helpers/doc-guard.js'

// #53: documentation guard for `ralph cycle`'s update notice and prompt. #51 and
// #52 gave `cycle` the same weekly check, the same notice and the same TTY-gated
// question `ralph start` has, plus one behavior unique to it: accepting STOPS the
// cycle without draining the queue. That is surprising enough that the docs are
// part of the feature, and both the README prose and `bin/ralph.js`'s one-liner
// can drift out of the truth silently — no test calls either.
//
// So this suite pins the DOCS the way the template and summary-parity suites pin
// files they cannot call: read the real on-disk source, assert the claims are
// there. Every claim asserted here is one the behavior tests in
// lib/commands/cycle.update-notice.test.js and cycle.update-prompt.test.js
// already prove TRUE of the code — this suite only proves it is WRITTEN DOWN.
//
// Patterns are deliberately keyed on the load-bearing words of each claim
// ("stops without draining", "notice-only") rather than whole sentences, so a
// wording tweak stays green while DELETING a claim goes red. They also run
// against WHITESPACE-NORMALIZED prose (see `prose()`): the README is hard-wrapped
// at ~78 columns, so a phrase like "never auto-updates" can land with a newline
// through its middle, and re-flowing a paragraph must not fail a docs guard.
//
// The `cycle` one-liner is asserted by SPAWNING `ralph cycle --help` rather than
// by parsing bin/ralph.js. An earlier version of this file hand-rolled a regex
// extractor for the `.description(...)` string; it was defeatable by a trailing
// `// update check` comment on the same line — a fully reverted description stayed
// green — and hardening it only grew the parser. `--help` is the surface the
// acceptance criterion is actually about, commander already prints it, no comment
// can reach it, and lib/commands/update.test.js:615-631 already spawns the CLI
// this way. Deleting the parser was the fix; see the hermeticity test below.
//
// The markdown walk, the section slicer, the normalizer and the stale-claim
// patterns live in test/helpers/doc-guard.js, shared with the QA suite so the two
// guards cannot drift apart.

const README = readFileSync(join(RALPH_HOME, 'README.md'), 'utf8')
const BIN_PATH = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))

const UPDATING_RAW = section(README, '## Updating Ralph')
const WEEKLY_RAW = section(UPDATING_RAW, '### The weekly check')
const WEEKLY = prose(WEEKLY_RAW)

describe('`ralph cycle` update docs (#53)', () => {
  describe('the sections under test were actually found', () => {
    // Every assertion below runs against a slice of the README. If a heading is
    // renamed, `section()` returns '' and each `toMatch` would fail loudly rather
    // than pass — but a `not.toMatch` would pass VACUOUSLY, so anchor the slices
    // first and make the negative guards meaningful.
    it('finds a non-trivial "Updating Ralph" section', () => {
      expect(UPDATING_RAW.length).toBeGreaterThan(2000)
      expect(UPDATING_RAW).toContain('### The weekly check')
    })

    it('finds a non-trivial "The weekly check" subsection that talks about `cycle`', () => {
      expect(WEEKLY_RAW.length).toBeGreaterThan(1000)
      expect(WEEKLY_RAW).toContain('`ralph cycle`')
    })

    it('the weekly slice stops before the next subsection (boundary, not a heading match)', () => {
      // The scoping every claim below depends on. Asserted with PROSE that only
      // exists in the following subsection rather than with that subsection's
      // heading text: a heading-based boundary proof goes vacuous the moment the
      // heading is renamed, passing for the trivial reason and leaving the scoping
      // unverified. Anchoring on a sentence keeps it proven either way — and the
      // `toContain` on the full README is what stops THIS proof going vacuous.
      const nextSubsectionOnly = 'Both 7-day windows are **global, not per-repo**'
      expect(README).toContain(nextSubsectionOnly)
      expect(WEEKLY_RAW).not.toContain(nextSubsectionOnly)
    })
  })

  describe('`ralph cycle --help`: the one-liner a scheduler owner reads', () => {
    // Scoped to `cycle` BY CONSTRUCTION — `cycle --help` prints this command's
    // description and nothing else, so no separate non-vacuity proof is needed
    // and no sibling command's wording can satisfy these.
    let help

    beforeAll(async () => {
      const r = await execa('node', [BIN_PATH, 'cycle', '--help'], { reject: false })
      expect(r.exitCode).toBe(0)
      // Commander hard-wraps help output at the terminal width, so the printed
      // one-liner arrives broken across lines exactly the way the README is.
      help = prose(r.stdout)
    })

    it('mentions the update check', () => {
      // The primary code change for #53. `--help` is where a user learns what a
      // scheduled tick does, and since #51 the update check is part of that
      // sequence; a one-liner that lists only "preflight, lock, drain, notify"
      // understates it.
      expect(help).toMatch(/update check/i)
    })

    it('still names the queue-processing pass and the launchd / cron intent', () => {
      // Adding the update check must not cost the description what it already
      // said — the one-liner is a summary of the whole pass, not just its new part.
      expect(help).toMatch(/queue-processing/i)
      expect(help).toMatch(/drain/i)
      expect(help).toMatch(/launchd/i)
    })

    it('lists the update check inside the sequence, in the order the code runs it', () => {
      // cycle.js runs preflight (:130), takes the lock (:159), then the update
      // gate (:215), then drains (:292). The one-liner is a sequence, so a reader
      // should be able to read the order off it; assert positions, not presence.
      expect(help.indexOf('preflight')).toBeLessThan(help.indexOf('lock'))
      expect(help.indexOf('lock')).toBeLessThan(help.indexOf('update check'))
      expect(help.indexOf('update check')).toBeLessThan(help.indexOf('drain'))
    })

    it('carries no rationale comment, and printing help does not run the cycle', async () => {
      // Hermeticity + the anti-vacuity property the deleted source parser could
      // not have: commander prints help and exits before the action, so nothing
      // shells out to git, gh or npm, nothing is written, and the `#53` comment
      // explaining the one-liner cannot possibly be what satisfies the assertions
      // above.
      const r = await execa('node', [BIN_PATH, 'cycle', '--help'], { reject: false })
      const all = `${r.stdout}${r.stderr}`
      expect(all).not.toContain('#53')
      expect(all).not.toContain('earns its place')
      expect(r.stdout).not.toContain('RALPH_CYCLE_EVENT')
      expect(r.stderr).toBe('')
    })
  })

  describe('README: the weekly-check section documents `cycle`', () => {
    it('says `cycle` runs the same check and prints the same notice as `start`', () => {
      // #51: the notice is not a `start` feature that `cycle` happens to lack.
      expect(WEEKLY).toMatch(/`ralph cycle`[\s\S]{0,200}?(identical|same)\s+check/i)
      expect(WEEKLY).toMatch(/(same|identical)[^.]{0,40}notice/i)
    })

    it('says the question is asked on a terminal, at most once a week', () => {
      // #52: TTY-gated, and throttled by its own 7-day window — the two halves a
      // user needs to predict when they will be asked.
      expect(WEEKLY).toMatch(/on a terminal[^.]{0,120}(question|asks)/i)
      expect(WEEKLY).toMatch(/at most once every 7 days/i)
    })

    it('says both weekly windows are global and shared with `ralph start`', () => {
      // The windows live in one machine-wide file, so being asked by `start`
      // this week is why `cycle` goes quiet — and vice versa.
      expect(WEEKLY).toMatch(/shared with[^.]{0,40}`ralph start`/i)
      expect(WEEKLY).toMatch(/asked by one[\s\S]{0,160}?(will not|won't|never) ask/i)
    })

    it('says `ralph doctor` reads the same cache but spends neither window', () => {
      // The third command that touches the cache. It only ever READS it (see
      // lib/commands/doctor.js: readVersionCache, no write, no registry query),
      // so — unlike `start` and `cycle` — running `doctor` cannot consume the
      // week's question. Stated here, next to the shared-window claim, because
      // that is where a reader forms the wrong assumption.
      expect(WEEKLY).toMatch(/`ralph doctor`/)
      expect(WEEKLY).toMatch(/`ralph doctor`[\s\S]{0,300}?stamps neither window/i)
      expect(WEEKLY).toMatch(/(never|not) spend[s]?[^.]{0,40}question/i)
    })

    it('says accepting stops the cycle without draining, and why', () => {
      // #52's headline behavior and the single most surprising thing about the
      // cycle path. The "why" matters as much as the "what": stopping is what
      // keeps an issue from being processed by a mixture of two versions.
      expect(WEEKLY).toMatch(/stops? without draining/i)
      expect(WEEKLY).toMatch(/(mixture of two versions|half-swapped|pre-update code)/i)
      // And the recovery, so a stopped cycle does not read as lost work.
      expect(WEEKLY).toMatch(/re-run `ralph cycle`|run `ralph cycle` again/i)
    })

    it('says a scheduled cycle only prints, never blocks, and never auto-updates', () => {
      // The launchd path has no terminal, so it can only notify. Spelled out
      // because "it prompts on a terminal" leaves a scheduler owner wondering
      // whether an unattended tick can hang on a question or swap versions
      // under itself. It cannot: lib/update-gate.js installs only when
      // `shouldPrompt && isTTY` produced an accepted answer.
      expect(WEEKLY).toMatch(/notice-only/i)
      expect(WEEKLY).toMatch(/logs\/ralph-cycle\.out\.log/)
      expect(WEEKLY).toMatch(/never block[s]?[^.]{0,60}(scheduled|tick)/i)
      expect(WEEKLY).toMatch(/never auto-updates?|does not auto-update|will not auto-update/i)
      expect(WEEKLY).toMatch(/human[^.]{0,60}answer/i)
    })

    it('documents RALPH_NO_UPDATE_CHECK as covering `cycle` too', () => {
      // The opt-out is per-command in a user's head and global in the code. The
      // weekly-check section has to say so, and the env-var table row has to
      // agree — a scheduled cycle additionally needs the value to reach launchd.
      expect(WEEKLY).toMatch(/RALPH_NO_UPDATE_CHECK/)
      const envRow = README.split('\n').find((l) => /^\|\s*`RALPH_NO_UPDATE_CHECK`/.test(l))
      expect(envRow).toBeTruthy()
      expect(envRow).toMatch(/`ralph cycle`/)
    })
  })

  describe('no stale claim survives that `cycle` performs no update check', () => {
    // The whole repo's authored markdown, enumerated by the shared walker rather
    // than listed here: a stale claim in a doc file added later is precisely the
    // regression a hardcoded list waves through.
    const DOC_FILES = repoMarkdown()

    it('sweeps the real doc surface (the negative guard is not vacuous)', () => {
      expect(DOC_FILES).toContain('README.md')
      expect(DOC_FILES).toContain('CONTRIBUTING.md')
      expect(DOC_FILES).toContain(join('docs', 'team-mode-spike.md'))
      expect(DOC_FILES).toContain(join('templates', 'roles', 'qa.md'))
      // A floor, not an equality, so adding a doc does not redden the suite —
      // but a walk that collapses to a couple of root files does.
      expect(DOC_FILES.length).toBeGreaterThanOrEqual(14)
    })

    it.each(DOC_FILES)('%s claims no such thing', (rel) => {
      // Normalized like every other prose match here: a stale claim that happens
      // to wrap between "does not" and "check" is still a stale claim, and a
      // guard that only catches the unwrapped spelling is barely a guard.
      const text = prose(readFileSync(join(RALPH_HOME, rel), 'utf8'))
      for (const pattern of STALE_CLAIM_PATTERNS) {
        expect(text, `${rel} matched ${pattern}`).not.toMatch(pattern)
      }
    })

    it('the patterns really do catch a reintroduced stale claim', () => {
      // Positive control: proof the `not.toMatch` sweep above is doing work
      // rather than testing regexes that can never fire. One string per spelling
      // the union list covers.
      const reintroduced = [
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
      for (const claim of reintroduced) {
        expect(
          STALE_CLAIM_PATTERNS.some((p) => p.test(prose(claim))),
          `not caught: ${claim}`,
        ).toBe(true)
      }
    })
  })
})
