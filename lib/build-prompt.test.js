import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { buildPrompt } from './build-prompt.js'
import { templatePath } from './paths.js'

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

function setupFs({ projectFiles = {} } = {}) {
  const orchestratorTemplate = readFileSync(templatePath('prompt-team.md'), 'utf8')
  const devRole = readFileSync(templatePath('roles/dev.md'), 'utf8')
  const qaRole = readFileSync(templatePath('roles/qa.md'), 'utf8')
  const reviewerRole = readFileSync(templatePath('roles/reviewer.md'), 'utf8')
  const writerRole = readFileSync(templatePath('roles/writer.md'), 'utf8')
  const vol = Volume.fromJSON({}, '/')
  vol.mkdirSync(templatePath('roles'), { recursive: true })
  vol.writeFileSync(templatePath('prompt-team.md'), orchestratorTemplate)
  vol.writeFileSync(templatePath('roles/dev.md'), devRole)
  vol.writeFileSync(templatePath('roles/qa.md'), qaRole)
  vol.writeFileSync(templatePath('roles/reviewer.md'), reviewerRole)
  vol.writeFileSync(templatePath('roles/writer.md'), writerRole)
  vol.mkdirSync(PROJECT, { recursive: true })
  for (const [k, v] of Object.entries(projectFiles)) {
    vol.writeFileSync(join(PROJECT, k), v)
  }
  return vol
}

describe('buildPrompt', () => {
  it('substitutes the runtime placeholders from env into the orchestrator template', () => {
    const vol = setupFs({ projectFiles: { 'PROMPT.md': '## Stack\nFoo' } })
    const out = buildPrompt({
      projectRoot: PROJECT,
      env: {
        INSTALL_CMD: 'npm ci',
        TEST_CMD: 'npm test',
        LINT_CMD: 'npm run lint',
        MAIN_BRANCH: 'main',
        DEV_BRANCH: 'dev',
        PR_TARGET: 'dev',
        MERGE_STRATEGY: 'rebase',
        MERGE_POLL_INTERVAL: '15',
        MERGE_POLL_MAX: '60',
      },
      fs: vol,
    })
    expect(out).toContain('run `npm ci`')
    expect(out).toContain('npm test')
    expect(out).toContain('npm run lint')
    expect(out).toContain('git checkout dev')
    expect(out).toContain('--base dev')
    expect(out).toContain('--auto --rebase')
    expect(out).toContain('every\n     15s')
    expect(out).toContain('60 polls')
    expect(out).toContain('Your project root is `/project`')
  })

  it("appends the project's PROMPT.md as {{PROJECT_PROMPT}}", () => {
    const vol = setupFs({
      projectFiles: { 'PROMPT.md': '## Stack\nReact + Vite' },
    })
    const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
    expect(out).toContain('## Stack\nReact + Vite')
    expect(out.indexOf('## Stack\nReact + Vite')).toBeGreaterThan(
      out.indexOf('## Absolute restrictions'),
    )
    expect(out).not.toContain('{{PROJECT_PROMPT}}')
  })

  it('renders an empty PROJECT_PROMPT when no project PROMPT.md exists', () => {
    const vol = setupFs()
    const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
    expect(out).not.toContain('{{PROJECT_PROMPT}}')
  })

  it('falls back to safe defaults when env vars are missing', () => {
    const vol = setupFs()
    const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
    expect(out).toContain('--auto --squash')
    expect(out).toContain('every\n     30s')
    expect(out).toContain('40 polls')
    expect(out).toContain('git checkout main')
  })

  it('does not warn when every placeholder is satisfied', () => {
    const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
    const stderr = makeStderr()
    buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
    expect(stderr.calls).toHaveLength(0)
  })

  describe('TDD workflow', () => {
    it('instructs the agent to write a failing test before implementing the fix', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/TDD/)
      expect(out).toMatch(/red.{0,3}green.{0,3}refactor/i)
      expect(out).toMatch(/write.+failing.+test/i)
    })

    it('tells the agent to confirm the test fails before writing implementation', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/confirm.+(fail|red)/i)
    })

    it('asks the PR body to document the TDD process (tests added, before/after results)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/document.+TDD/i)
      expect(out).toMatch(/PR (body|description)/i)
    })

    it('allows skipping TDD only for changes with no code impact (docs, config)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/skip.+TDD|TDD.+(only|skip)/i)
      expect(out).toMatch(/docs|documentation|config/i)
    })
  })

  describe('team orchestrator composition', () => {
    it('composes the orchestrator template into the rendered prompt', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toContain('# Ralph Loop — Team orchestrator')
      expect(out).toMatch(/orchestrator/i)
    })

    it('describes dispatching context-isolated subagents via the Task/Agent tool', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/Task\/Agent tool/)
      expect(out).toMatch(/isolated|context-isolated/i)
    })

    it('appends PROMPT.md after the orchestrator template, with no leftover placeholder', () => {
      const vol = setupFs({
        projectFiles: { 'PROMPT.md': '## Stack\nReact + Vite' },
      })
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toContain('## Stack\nReact + Vite')
      expect(out.indexOf('## Stack\nReact + Vite')).toBeGreaterThan(
        out.indexOf('# Ralph Loop — Team orchestrator'),
      )
      expect(out).not.toContain('{{PROJECT_PROMPT}}')
    })

    it('preserves the never-touch file list verbatim', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toContain(
        "NEVER touch: `.env*`, `.git/`, `node_modules/`, `dist/`, `logs/`,\n  `ralph.sh`, `start-ralph.sh`, `PROMPT.md`, `ralph.config.sh`,\n  `.claude/`.",
      )
    })

    it('preserves the absolute restrictions (force-push, direct push, manual merge/close)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toContain('NEVER `git push --force` or `git push -f`.')
      expect(out).toMatch(/NEVER push directly to/)
      expect(out).toMatch(/NEVER merge PRs directly/)
      expect(out).toMatch(/NEVER close issues manually/)
    })

    it('does not warn on unknown placeholders for the orchestrator template', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('dev specialist role composition', () => {
    it('composes the dev role into the rendered prompt', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/##+ .*Dev(eloper)?/i)
    })

    it('infers the dev persona from the issue and stack rather than a fixed role name', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/infer/i)
      expect(out).toMatch(/stack/i)
      // Persona is not hard-coded to one language/framework.
      expect(out).toMatch(/persona/i)
    })

    it('carries the TDD red → green → refactor contract in the dev role', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/red.{0,3}green.{0,3}refactor/i)
    })

    it('tells the dev to write a failing test first and confirm it fails for the right reason', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/write.+failing.+test/i)
      expect(out).toMatch(/confirm.+fail/i)
    })

    it('preserves the repeated-test-failure give-up backstop alongside the dev role', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/breaks 3 times in a row/)
      expect(out).toMatch(/CLAUDE_GIVE_UP/)
    })

    it('does not warn on unknown placeholders once the dev role is composed', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('QA specialist role composition', () => {
    it('composes the QA role into the rendered prompt', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/##+ .*QA/i)
    })

    it('describes QA augmenting the suite after the dev suite is green', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/augment/i)
      expect(out).toMatch(/after.+green|green.+suite/i)
      expect(out).toMatch(/edge.case/i)
      expect(out).toMatch(/adversarial/i)
    })

    it('renders the QA role after the dev role (ordering reflects QA-after-green)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const devIdx = out.search(/##+ .*Dev specialist/i)
      const qaIdx = out.search(/##+ .*QA specialist/i)
      expect(devIdx).toBeGreaterThan(-1)
      expect(qaIdx).toBeGreaterThan(-1)
      expect(qaIdx).toBeGreaterThan(devIdx)
    })

    it('states that QA-found bugs block until green (go back to the dev to fix)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/block until green/i)
      expect(out).toMatch(/back to the dev|return.+dev|hand.+back/i)
    })

    it('reaffirms the give-up backstop as the bound on the block-until-green loop', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/breaks 3 times in a row/)
      expect(out).toMatch(/CLAUDE_GIVE_UP/)
    })

    it('does not warn on unknown placeholders once the QA role is composed', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('reviewer specialist role composition', () => {
    it('composes the reviewer role into the rendered prompt', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/##+ .*review/i)
    })

    it('carries a Ralph-authored maintainability standard with nothing vendored or fetched', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/Ralph.authored/i)
      expect(out).toMatch(/no.+(vendor|third-party|fetch)/i)
    })

    it('includes the oversized-file guard, anti-spaghetti, abstraction-quality, and prefer-deleting-indirection rules', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/oversized.file|file.+too (large|big|long)/i)
      expect(out).toMatch(/spaghetti|ad.hoc conditional/i)
      expect(out).toMatch(/abstraction/i)
      expect(out).toMatch(/delet.+indirection/i)
    })

    it('refuses to approve on behavior alone', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/not.+approv.+behavior|behavior.+(seems|alone)/i)
    })

    it('gates before the PR is opened (reviewer content precedes the Open PR step)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const reviewerIdx = out.search(/##+ .*Code reviewer specialist/i)
      const openPrIdx = out.search(/\bOpen PR\b/)
      expect(reviewerIdx).toBeGreaterThan(-1)
      expect(openPrIdx).toBeGreaterThan(-1)
      expect(reviewerIdx).toBeLessThan(openPrIdx)
      expect(out).toMatch(/pre.PR|before.+PR/i)
    })

    it('renders the reviewer role after the QA role', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const qaIdx = out.search(/##+ .*QA specialist/i)
      const reviewerIdx = out.search(/##+ .*Code reviewer specialist/i)
      expect(qaIdx).toBeGreaterThan(-1)
      expect(reviewerIdx).toBeGreaterThan(-1)
      expect(reviewerIdx).toBeGreaterThan(qaIdx)
    })

    it('loops blocking findings back to the dev, bounded to a maximum of 2 rounds', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/back to the dev|return.+dev|hand.+back/i)
      expect(out).toMatch(/(maximum|max|up to|at most).{0,12}2 rounds/i)
    })

    it('opens the PR anyway after the round limit with a prominent warning in the PR body', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/open.+PR anyway|PR is opened anyway/i)
      expect(out).toMatch(/warning/i)
      expect(out).toMatch(/PR (body|description)/i)
      expect(out).toMatch(/unresolved/i)
    })

    it('does not warn on unknown placeholders once the reviewer role is composed', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('writer specialist role composition', () => {
    it('composes the writer role into the rendered prompt', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/##+ .*(tech )?writer/i)
    })

    it('discovers documentation targets from the diff rather than from configuration', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/infer|discover/i)
      expect(out).toMatch(/diff/i)
      expect(out).toMatch(/not.+configur|rather than.+configur|without.+configur/i)
    })

    it('mentions the kinds of docs it discovers (README, CLAUDE.md/AGENTS.md, docs/, docstrings)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/README/)
      expect(out).toMatch(/AGENTS\.md/)
      expect(out).toMatch(/docs\//)
      expect(out).toMatch(/docstring/i)
    })

    it('respects the never-touch list (CLAUDE.md editable; PROMPT.md / ralph.config.sh / .claude/ off-limits)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const writerStart = out.search(/##+ .*(tech )?writer/i)
      const writerSection = out.slice(writerStart)
      expect(writerSection).toMatch(/CLAUDE\.md.+(editable|not on the|allowed)/i)
      expect(writerSection).toMatch(/PROMPT\.md/)
      expect(writerSection).toMatch(/ralph\.config\.sh/)
      expect(writerSection).toMatch(/\.claude\//)
    })

    it('renders the writer role after the reviewer role (writer runs after the review gate)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const reviewerIdx = out.search(/##+ .*Code reviewer specialist/i)
      const writerIdx = out.search(/##+ .*(tech )?writer specialist/i)
      expect(reviewerIdx).toBeGreaterThan(-1)
      expect(writerIdx).toBeGreaterThan(-1)
      expect(writerIdx).toBeGreaterThan(reviewerIdx)
    })

    it("places the writer's step 4d before the Validate locally / Open PR steps", () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const writerIdx = out.search(/##+ .*(tech )?writer specialist/i)
      const validateIdx = out.search(/Validate locally/)
      const openPrIdx = out.search(/\bOpen PR\b/)
      expect(writerIdx).toBeGreaterThan(-1)
      expect(validateIdx).toBeGreaterThan(-1)
      expect(openPrIdx).toBeGreaterThan(-1)
      expect(writerIdx).toBeLessThan(validateIdx)
      expect(writerIdx).toBeLessThan(openPrIdx)
    })

    it('does not warn on unknown placeholders once the writer role is composed', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('writer specialist role composition — adversarial edge cases', () => {
    it('fully replaces the {{ROLE_WRITER}} placeholder (none left in the composed template)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // The dev's "no stderr warning" test is indirect; assert the literal
      // composition placeholder is actually gone from the rendered prompt.
      expect(out).not.toContain('{{ROLE_WRITER}}')
    })

    it('leaves no unreplaced {{ROLE_*}} composition placeholder anywhere in the output', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // Catches a future role added to the template but not wired into
      // build-prompt.js (it would survive composition as a dangling {{ROLE_…}}).
      expect(out).not.toMatch(/\{\{ROLE_/)
    })

    it('orders the writer strictly after the dev, QA, and reviewer roles', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const devIdx = out.search(/##+ .*Dev specialist/i)
      const qaIdx = out.search(/##+ .*QA specialist/i)
      const reviewerIdx = out.search(/##+ .*Code reviewer specialist/i)
      const writerIdx = out.search(/##+ .*(tech )?writer specialist/i)
      expect(devIdx).toBeGreaterThan(-1)
      expect(qaIdx).toBeGreaterThan(-1)
      expect(reviewerIdx).toBeGreaterThan(-1)
      expect(writerIdx).toBeGreaterThan(-1)
      expect(writerIdx).toBeGreaterThan(devIdx)
      expect(writerIdx).toBeGreaterThan(qaIdx)
      expect(writerIdx).toBeGreaterThan(reviewerIdx)
    })

    it('places the step "4d" marker after the reviewer step and before step 5 "Validate locally"', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const step4dIdx = out.search(/\b4d\.\s/)
      const reviewerStepIdx = out.search(/\b4c\.\s/)
      const validateIdx = out.search(/5\.\s+\*\*Validate locally\*\*/)
      expect(step4dIdx).toBeGreaterThan(-1)
      expect(reviewerStepIdx).toBeGreaterThan(-1)
      expect(validateIdx).toBeGreaterThan(-1)
      expect(step4dIdx).toBeGreaterThan(reviewerStepIdx)
      expect(step4dIdx).toBeLessThan(validateIdx)
    })

    it('presents CLAUDE.md / AGENTS.md / README as editable, not forbidden', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const writerStart = out.search(/##+ .*(tech )?writer specialist/i)
      const writerSection = out.slice(writerStart)
      // Inverse of the dev's "off-limits names appear" test: the editable docs
      // must be explicitly framed as editable / fair game, never as off-limits.
      expect(writerSection).toMatch(/CLAUDE\.md`?\*? is editable/i)
      expect(writerSection).toMatch(/`AGENTS\.md`.*are likewise fair game|fair game/i)
      // CLAUDE.md must not be described as never-touch / off-limits here.
      expect(writerSection).not.toMatch(/CLAUDE\.md[^\n]*never touch/i)
      expect(writerSection).not.toMatch(/CLAUDE\.md[^\n]*off-limits/i)
    })

    it('interpolates {{TEST_CMD}} / {{LINT_CMD}} inside the writer section', () => {
      const vol = setupFs()
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { TEST_CMD: 'cargo test --all', LINT_CMD: 'cargo clippy --strict' },
        fs: vol,
      })
      const writerStart = out.search(/##+ .*(tech )?writer specialist/i)
      const writerSection = out.slice(writerStart)
      expect(writerSection).toContain('cargo test --all')
      expect(writerSection).toContain('cargo clippy --strict')
      expect(writerSection).not.toContain('{{TEST_CMD}}')
      expect(writerSection).not.toContain('{{LINT_CMD}}')
    })

    it("does not clobber, corrupt, or re-template a project PROMPT.md that contains a literal {{ROLE_WRITER}}", () => {
      // Adversarial: the project's own PROMPT.md mentions the literal
      // {{ROLE_WRITER}} and {{TEST_CMD}}. PROMPT.md is injected as the value of
      // {{PROJECT_PROMPT}} during interpolate's single pass, so replacement
      // values are NOT re-scanned. Pin the real behavior: the writer role still
      // composes correctly, the project's literal text survives verbatim, and
      // composition neither throws nor emits a warning.
      const projectPrompt =
        '## Stack\nOur docs literally cite {{ROLE_WRITER}} and run {{TEST_CMD}} ourselves.'
      const vol = setupFs({ projectFiles: { 'PROMPT.md': projectPrompt } })
      const stderr = makeStderr()
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { TEST_CMD: 'pytest -q' },
        fs: vol,
        stderr,
      })
      // Writer role still composed correctly (not clobbered by the stray token).
      expect(out).toContain('## Tech writer specialist')
      // The project's literal text is preserved verbatim — not re-interpolated.
      expect(out).toContain(projectPrompt)
      // Exactly one {{ROLE_WRITER}} survives: the one inside PROMPT.md, the
      // composition slot itself was filled.
      expect((out.match(/\{\{ROLE_WRITER\}\}/g) || []).length).toBe(1)
      // The stray token in PROMPT.md does not trigger an interpolate warning,
      // because injected replacement values are not re-scanned.
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('triage-and-scale', () => {
    it('instructs the orchestrator to classify/triage each issue before dispatching', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/triage|classif/i)
      expect(out).toMatch(/scale.+team|team.+(size|scales)/i)
    })

    it('routes trivial / non-behavioral changes (pure docs, plain config, dependency bumps) to a light path', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/trivial/i)
      expect(out).toMatch(/pure docs/i)
      expect(out).toMatch(/plain config/i)
      expect(out).toMatch(/dependency bump/i)
    })

    it('skips the dev-TDD and QA phases for trivial issues, running only a light review plus the writer', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/skip.+(dev.TDD|TDD).+(and )?QA|skip.+QA/i)
      expect(out).toMatch(/light review/i)
      expect(out).toMatch(/writer/i)
    })

    it('runs the full team for substantive changes', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/substantive/i)
      expect(out).toMatch(/full team/i)
    })

    it('keeps the trivial boundary conservative — config that carries logic is treated as substantive', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/conservative/i)
      expect(out).toMatch(/config.+logic|logic.+config/i)
      expect(out).toMatch(/substantive/i)
    })

    it('places the triage/scale step before the dev dispatch (step 4)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const triageIdx = out.search(/triage|classif/i)
      const devDispatchIdx = out.search(/4\.\s+\*\*Resolve via the dev specialist\*\*/)
      expect(triageIdx).toBeGreaterThan(-1)
      expect(devDispatchIdx).toBeGreaterThan(-1)
      expect(triageIdx).toBeLessThan(devDispatchIdx)
    })

    it('does not warn on unknown placeholders once the triage/scale section is added', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('per-role PR body', () => {
    it('adds a Dev/TDD section to the PR body template', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/## Dev\/TDD/)
    })

    it('adds a QA scenarios section to the PR body template', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/## QA scenarios/i)
    })

    it('adds a Review verdict section that flags unresolved concerns when the round limit was hit', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/## Review verdict/i)
      expect(out).toMatch(/unresolved/i)
      expect(out).toMatch(/round limit|2-round limit|round.limit/i)
    })

    it('adds a Docs updated section to the PR body template', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/## Docs updated/i)
    })

    it('retains a single per-issue log (no per-role logs)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/single per-issue log/i)
      expect(out).toMatch(/no per-role log/i)
    })

    it('orders the per-role PR-body sections Dev/TDD → QA → Review → Docs', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const devIdx = out.search(/## Dev\/TDD/)
      const qaIdx = out.search(/## QA scenarios/i)
      const reviewIdx = out.search(/## Review verdict/i)
      const docsIdx = out.search(/## Docs updated/i)
      expect(devIdx).toBeGreaterThan(-1)
      expect(qaIdx).toBeGreaterThan(devIdx)
      expect(reviewIdx).toBeGreaterThan(qaIdx)
      expect(docsIdx).toBeGreaterThan(reviewIdx)
    })

    it('keeps the per-role PR-body sections inside the Open PR step', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const openPrIdx = out.search(/\bOpen PR\b/)
      const devIdx = out.search(/## Dev\/TDD/)
      expect(openPrIdx).toBeGreaterThan(-1)
      expect(devIdx).toBeGreaterThan(openPrIdx)
    })

    it('does not warn on unknown placeholders once the per-role PR body is added', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('triage-and-scale — QA hardening', () => {
    const FULL_ENV = {
      INSTALL_CMD: 'pnpm install --frozen-lockfile',
      TEST_CMD: 'cargo test --all',
      LINT_CMD: 'cargo clippy --strict',
      MAIN_BRANCH: 'release',
      DEV_BRANCH: 'integration',
      PR_TARGET: 'integration',
      MERGE_STRATEGY: 'merge',
      MERGE_POLL_INTERVAL: '7',
      MERGE_POLL_MAX: '99',
    }

    function triageSection(out) {
      const start = out.search(/3b\.\s/)
      const end = out.search(/\n4\.\s+\*\*Resolve via the dev specialist\*\*/)
      return out.slice(start, end === -1 ? undefined : end)
    }

    it('survives interpolation with custom env — no leftover {{...}} in the triage section', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '## Stack\nRust' } })
      const out = buildPrompt({ projectRoot: PROJECT, env: FULL_ENV, fs: vol })
      const section = triageSection(out)
      expect(section).toMatch(/triage/i)
      // The prose is static, but the whole prompt must not strand any
      // placeholder under a fully-populated env.
      expect(section).not.toMatch(/\{\{[A-Za-z_]/)
    })

    it('places step 3b strictly AFTER "Prepare branch" (step 3) and BEFORE the dev dispatch (step 4)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const prepareIdx = out.search(/3\.\s+\*\*Prepare branch\*\*/)
      const triageIdx = out.search(/3b\.\s+\*\*Triage and scale/i)
      const devDispatchIdx = out.search(/\n4\.\s+\*\*Resolve via the dev specialist\*\*/)
      expect(prepareIdx).toBeGreaterThan(-1)
      expect(triageIdx).toBeGreaterThan(-1)
      expect(devDispatchIdx).toBeGreaterThan(-1)
      expect(triageIdx).toBeGreaterThan(prepareIdx)
      expect(triageIdx).toBeLessThan(devDispatchIdx)
    })

    it('places step 3b before every downstream dispatch step (4, 4b, 4c, 4d)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const triageIdx = out.search(/3b\.\s+\*\*Triage and scale/i)
      const step4Idx = out.search(/\n4\.\s+\*\*Resolve via the dev/)
      const step4bIdx = out.search(/\b4b\.\s+\*\*Harden via the QA/)
      const step4cIdx = out.search(/\b4c\.\s+\*\*Review via the code reviewer/)
      const step4dIdx = out.search(/\b4d\.\s+\*\*Document via the tech writer/)
      for (const idx of [step4Idx, step4bIdx, step4cIdx, step4dIdx]) {
        expect(idx).toBeGreaterThan(-1)
        expect(triageIdx).toBeLessThan(idx)
      }
    })

    it('states the conservative direction: when in doubt, treat as substantive (not merely that both words appear)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      // The boundary must resolve doubt TOWARD substantive, not the reverse.
      // Tolerate the prose wrap between the two phrases (newline + indent).
      expect(section).toMatch(/when in doubt[\s\S]{0,60}substantive/i)
    })

    it('ties runtime-read / logic-carrying config explicitly to "substantive", not trivial', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      // Config that the code reads at runtime / carries logic must be called
      // out as substantive (i.e. NOT plain config).
      expect(section).toMatch(/config.+(carries )?logic[\s\S]{0,160}substantive/i)
      expect(section).toMatch(/runtime/i)
    })

    it('keeps the trivial light path explicit: skips dev-TDD AND QA, but still runs review + writer', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      // Skips steps 4 and 4b (dev-TDD + QA)...
      expect(section).toMatch(/skip.+dev.TDD.+QA|skip.+TDD.+QA/i)
      expect(section).toMatch(/steps?\s+4\s+and\s+4b/i)
      // ...but still runs the review (4c) and writer (4d).
      expect(section).toMatch(/light review/i)
      expect(section).toMatch(/4c.+4d|steps?\s+4c.+4d/i)
      expect(section).toMatch(/writer/i)
    })

    it('does not warn under a NON-empty PROMPT.md and a fully-populated custom env', () => {
      const vol = setupFs({
        projectFiles: { 'PROMPT.md': '## Stack\nRust + cargo\n\nSome project notes.' },
      })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: FULL_ENV, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('per-role PR body — QA hardening', () => {
    function prBodySection(out) {
      const start = out.search(/Closes #N/)
      const end = out.search(/## Notes/)
      return out.slice(start, end)
    }

    it('places all four per-role sections between "Closes #N" and "## Notes"', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const closesIdx = out.search(/Closes #N/)
      const notesIdx = out.search(/## Notes/)
      expect(closesIdx).toBeGreaterThan(-1)
      expect(notesIdx).toBeGreaterThan(closesIdx)
      const section = prBodySection(out)
      expect(section).toMatch(/## Dev\/TDD/)
      expect(section).toMatch(/## QA scenarios/)
      expect(section).toMatch(/## Review verdict/)
      expect(section).toMatch(/## Docs updated/)
    })

    it('places the PR-body template after the "Open PR" step heading', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const openPrIdx = out.search(/\*\*Open PR\*\*/)
      const closesIdx = out.search(/Closes #N/)
      expect(openPrIdx).toBeGreaterThan(-1)
      expect(closesIdx).toBeGreaterThan(openPrIdx)
    })

    it('renders exactly one of each per-role heading (no accidental duplication)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect((out.match(/## Dev\/TDD/g) || []).length).toBe(1)
      expect((out.match(/## QA scenarios added/g) || []).length).toBe(1)
      expect((out.match(/## Review verdict/g) || []).length).toBe(1)
      expect((out.match(/## Docs updated/g) || []).length).toBe(1)
    })

    it('replaced the old standalone "## TDD" heading with "## Dev/TDD" (no bare ## TDD left)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // The renamed section must not leave a bare "## TDD" line behind.
      expect(out).not.toMatch(/^\s*## TDD\s*$/m)
    })

    it('ties the TDD-skipped PR-body instruction to the triage step (3b), not the old step 4', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // The skip instruction must reference triage / step 3b as the trigger.
      expect(out).toMatch(/skipped per the triage in step 3b|skipped.+triage.+3b/i)
      // And it must replace the Dev/TDD section (the renamed one), plus mark QA skipped.
      expect(out).toMatch(/replace the Dev\/TDD section/i)
      expect(out).toMatch(/QA scenarios section with.+Skipped/i)
    })

    it('survives interpolation with custom env — no leftover {{...}} in the Open-PR / PR-body region', () => {
      const vol = setupFs()
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { PR_TARGET: 'integration', MERGE_STRATEGY: 'merge' },
        fs: vol,
      })
      const start = out.search(/\*\*Open PR\*\*/)
      const end = out.search(/## Absolute restrictions/)
      const region = out.slice(start, end)
      expect(region).toContain('--base integration')
      expect(region).not.toMatch(/\{\{[A-Za-z_]/)
    })

    it('keeps the unresolved-concern warning block tied to the Review verdict section', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // After the 2-round limit, concerns are flagged in Review verdict AND a
      // warning block is prepended.
      expect(out).toMatch(/flag them in the Review verdict section/i)
      expect(out).toMatch(/\[!WARNING\]/)
      expect(out).toMatch(/Unresolved review concerns/i)
    })

    it('does not warn under a NON-empty PROMPT.md and a fully-populated custom env', () => {
      const vol = setupFs({
        projectFiles: { 'PROMPT.md': '## Stack\nGo + go test\n\nNotes here.' },
      })
      const stderr = makeStderr()
      buildPrompt({
        projectRoot: PROJECT,
        env: {
          INSTALL_CMD: 'go mod download',
          TEST_CMD: 'go test ./...',
          LINT_CMD: 'golangci-lint run',
          PR_TARGET: 'dev',
          MERGE_STRATEGY: 'rebase',
        },
        fs: vol,
        stderr,
      })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('RALPH_HEAVY_TIER (dark-launch foundation)', () => {
    it('interpolates the default RALPH_HEAVY_TIER value (0) into the composed prompt', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).not.toContain('{{RALPH_HEAVY_TIER}}')
      expect(out).toMatch(/effort tier[^\n]*0/i)
    })

    it('interpolates a custom RALPH_HEAVY_TIER value from env', () => {
      const vol = setupFs()
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { RALPH_HEAVY_TIER: '1' },
        fs: vol,
      })
      expect(out).not.toContain('{{RALPH_HEAVY_TIER}}')
      expect(out).toMatch(/effort tier[^\n]*1/i)
    })

    it('does not warn on the RALPH_HEAVY_TIER placeholder', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('RALPH_HEAVY_TIER — QA hardening (edge / adversarial)', () => {
    function tierLine(out) {
      const m = out.match(/Current effort tier:[^\n]*/)
      return m ? m[0] : null
    }

    it('fully replaces {{RALPH_HEAVY_TIER}} — no placeholder survives anywhere', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // Mirror the "no leftover composition placeholder" hardening tests.
      expect(out).not.toContain('{{RALPH_HEAVY_TIER}}')
      expect((out.match(/\{\{RALPH_HEAVY_TIER\}\}/g) || []).length).toBe(0)
    })

    it('renders the resolved tier value exactly once (no duplication)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // The template carries a single "Current effort tier:" line; the value
      // must appear once as a backtick-wrapped resolved value.
      expect((out.match(/Current effort tier:/g) || []).length).toBe(1)
      expect((out.match(/Current effort tier: `0`/g) || []).length).toBe(1)
    })

    it("treats env value '0' explicitly the same as the default", () => {
      const vol = setupFs()
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { RALPH_HEAVY_TIER: '0' },
        fs: vol,
      })
      expect(out).not.toContain('{{RALPH_HEAVY_TIER}}')
      expect(tierLine(out)).toContain('`0`')
    })

    it("interpolates a non-default value '2'", () => {
      const vol = setupFs()
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { RALPH_HEAVY_TIER: '2' },
        fs: vol,
      })
      expect(out).not.toContain('{{RALPH_HEAVY_TIER}}')
      expect(tierLine(out)).toContain('`2`')
    })

    it("pins the real behavior for an empty-string env value: ?? only catches null/undefined, so '' passes through as an empty resolved value", () => {
      const vol = setupFs()
      const stderr = makeStderr()
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { RALPH_HEAVY_TIER: '' },
        fs: vol,
        stderr,
      })
      // The placeholder is still fully replaced (interpolate resolves a known
      // key to its value regardless of emptiness).
      expect(out).not.toContain('{{RALPH_HEAVY_TIER}}')
      // Documented quirk: `?? '0'` does NOT default an empty string, so the
      // tier renders as an empty value between the backticks, not `0`.
      expect(tierLine(out)).toContain('Current effort tier: ``')
      expect(tierLine(out)).not.toContain('`0`')
      // No warning — the key is present in vars, just empty.
      expect(stderr.calls).toHaveLength(0)
    })

    it('does not re-interpolate a literal {{RALPH_HEAVY_TIER}} embedded in the project PROMPT.md (single-pass) and emits no warning', () => {
      // Adversarial: the project's own PROMPT.md cites the literal token. It is
      // injected as the value of {{PROJECT_PROMPT}} in interpolate's single
      // pass, so replacement values are NOT re-scanned. Mirror the existing
      // {{ROLE_WRITER}} adversarial test.
      const projectPrompt =
        '## Stack\nOur docs literally cite {{RALPH_HEAVY_TIER}} as a flag.'
      const vol = setupFs({ projectFiles: { 'PROMPT.md': projectPrompt } })
      const stderr = makeStderr()
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { RALPH_HEAVY_TIER: '1' },
        fs: vol,
        stderr,
      })
      // The orchestrator's own tier line resolved to the env value.
      expect(tierLine(out)).toContain('`1`')
      // The project's literal text survives verbatim — not re-interpolated.
      expect(out).toContain(projectPrompt)
      // Exactly one {{RALPH_HEAVY_TIER}} survives: the one inside PROMPT.md.
      // The orchestrator's own slot was filled.
      expect((out.match(/\{\{RALPH_HEAVY_TIER\}\}/g) || []).length).toBe(1)
      // The stray token in PROMPT.md does not trigger a warning.
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('issue selection query', () => {
    function selectQuery(out) {
      const match = out.match(/gh issue list[^\n]*--search '([^']+)'/)
      return match ? match[1] : null
    }

    it('excludes pending-merge issues from the selection query', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const query = selectQuery(out)
      expect(query).not.toBeNull()
      expect(query).toContain('-label:pending-merge')
    })

    it('excludes do-not-ralph issues from the selection query', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const query = selectQuery(out)
      expect(query).not.toBeNull()
      expect(query).toContain('-label:do-not-ralph')
    })

    it('keeps the existing claude-working and claude-failed exclusions', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const query = selectQuery(out)
      expect(query).not.toBeNull()
      expect(query).toContain('-label:claude-working')
      expect(query).toContain('-label:claude-failed')
    })
  })
})
