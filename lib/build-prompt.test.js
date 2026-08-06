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
  const codexTemplate = readFileSync(templatePath('prompt-team-codex.md'), 'utf8')
  const devRole = readFileSync(templatePath('roles/dev.md'), 'utf8')
  const qaRole = readFileSync(templatePath('roles/qa.md'), 'utf8')
  const reviewerRole = readFileSync(templatePath('roles/reviewer.md'), 'utf8')
  const writerRole = readFileSync(templatePath('roles/writer.md'), 'utf8')
  const explorerRole = readFileSync(templatePath('roles/explorer.md'), 'utf8')
  const vol = Volume.fromJSON({}, '/')
  vol.mkdirSync(templatePath('roles'), { recursive: true })
  vol.writeFileSync(templatePath('prompt-team.md'), orchestratorTemplate)
  vol.writeFileSync(templatePath('prompt-team-codex.md'), codexTemplate)
  vol.writeFileSync(templatePath('roles/dev.md'), devRole)
  vol.writeFileSync(templatePath('roles/qa.md'), qaRole)
  vol.writeFileSync(templatePath('roles/reviewer.md'), reviewerRole)
  vol.writeFileSync(templatePath('roles/writer.md'), writerRole)
  vol.writeFileSync(templatePath('roles/explorer.md'), explorerRole)
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

  describe('three-tier triage (Tier-2 Heavy, gated)', () => {
    function triageSection(out) {
      const start = out.search(/3b\.\s/)
      const end = out.search(/\n4\.\s+\*\*Resolve via the dev specialist\*\*/)
      return out.slice(start, end === -1 ? undefined : end)
    }

    it('names three tiers — Light, Standard/Substantive, and Tier 2 / Heavy', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      // Tier labels: the existing light/substantive language plus the new heavy tier.
      expect(section).toMatch(/three tiers?/i)
      expect(section).toMatch(/light/i)
      expect(section).toMatch(/substantive/i)
      expect(section).toMatch(/tier[\s-]*2/i)
      expect(section).toMatch(/heavy/i)
    })

    it('lists the Tier-2 trigger signals: multi-file/module scope, audit, refactor, migration, multi-hypothesis investigation', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      expect(section).toMatch(/multi-(file|module)/i)
      expect(section).toMatch(/audit/i)
      expect(section).toMatch(/refactor/i)
      expect(section).toMatch(/migration/i)
      expect(section).toMatch(/multi-hypothesis/i)
    })

    it('documents the ralph-heavy label override forcing Tier 2', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      expect(section).toMatch(/ralph-heavy/)
      // The label FORCES Tier 2.
      expect(section).toMatch(/ralph-heavy[\s\S]{0,80}(forces?|force)[\s\S]{0,40}tier[\s-]*2/i)
    })

    it('gates Tier 2 behind the RALPH_HEAVY_TIER flag (off when the flag is 0)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      expect(section).toMatch(/RALPH_HEAVY_TIER/)
      // Tier 2 is unavailable / off when the flag is 0.
      expect(section).toMatch(/(off|disabled|unavailable|not available)[\s\S]{0,40}(0|flag)|flag[\s\S]{0,40}0/i)
    })

    it('includes a degrade-to-Tier-1 instruction for non-convergence (no looping)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      expect(section).toMatch(/(degrade|fall back|fallback|drop back)[\s\S]{0,80}tier[\s-]*1/i)
      expect(section).toMatch(/converge|non-convergence|fails? to converge/i)
    })

    it('defaults to Tier 1 when the classifier is uncertain', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      // When uncertain, default to Tier 1 (not Tier 2).
      expect(section).toMatch(/(uncertain|in doubt|unsure)[\s\S]{0,80}tier[\s-]*1/i)
    })

    it('keeps the three-tier prose inside step 3b and does not strand placeholders under custom env', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '## Stack\nRust' } })
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { RALPH_HEAVY_TIER: '1' },
        fs: vol,
      })
      const section = triageSection(out)
      expect(section).toMatch(/tier[\s-]*2/i)
      expect(section).not.toMatch(/\{\{[A-Za-z_]/)
    })

    it('does not warn on unknown placeholders once the three-tier prose is added', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('three-tier triage — QA hardening', () => {
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
      RALPH_HEAVY_TIER: '2',
    }

    function triageSection(out) {
      const start = out.search(/3b\.\s/)
      const end = out.search(/\n4\.\s+\*\*Resolve via the dev specialist\*\*/)
      return out.slice(start, end === -1 ? undefined : end)
    }

    // The region from the dev dispatch (step 4) to the end. Tier-2 trigger
    // prose lives ONLY in step 3b; the gated-tier line in the intro header
    // legitimately references it, but nothing past step 4 should.
    function afterTriageRegion(out) {
      const start = out.search(/\n4\.\s+\*\*Resolve via the dev specialist\*\*/)
      return out.slice(start)
    }

    it('confines the Tier-2 trigger prose to step 3b — no leak into the dispatch steps (4 onward)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const after = afterTriageRegion(out)
      // These tokens are unique to the Tier-2 classifier prose in 3b. If any
      // appears past step 4, the heavy-tier prose has leaked out of its region.
      expect(after).not.toMatch(/ralph-heavy/)
      expect(after).not.toMatch(/multi-hypothesis/i)
      expect(after).not.toMatch(/multi-(file|module)/i)
      // And step 3b really does carry them (so the negative above is meaningful).
      const section = triageSection(out)
      expect(section).toMatch(/ralph-heavy/)
      expect(section).toMatch(/multi-hypothesis/i)
    })

    it('keeps all three tiers and strands no placeholder under a fully-populated custom env (RALPH_HEAVY_TIER=2)', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '## Stack\nRust + cargo' } })
      const out = buildPrompt({ projectRoot: PROJECT, env: FULL_ENV, fs: vol })
      const section = triageSection(out)
      expect(section).toMatch(/tier[\s-]*0/i)
      expect(section).toMatch(/tier[\s-]*1/i)
      expect(section).toMatch(/tier[\s-]*2/i)
      expect(section).toMatch(/light/i)
      expect(section).toMatch(/substantive/i)
      expect(section).toMatch(/heavy/i)
      expect(section).not.toMatch(/\{\{[A-Za-z_]/)
    })

    it('does not warn under explicit RALPH_HEAVY_TIER=0 and a NON-empty PROMPT.md', () => {
      const vol = setupFs({
        projectFiles: { 'PROMPT.md': '## Stack\nRust + cargo\n\nProject notes.' },
      })
      const stderr = makeStderr()
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { ...FULL_ENV, RALPH_HEAVY_TIER: '0' },
        fs: vol,
        stderr,
      })
      const section = triageSection(out)
      expect(section).not.toMatch(/\{\{[A-Za-z_]/)
      expect(stderr.calls).toHaveLength(0)
    })

    it('resolves doubt toward the SAFE direction — uncertain maps to Tier 1, and Tier 2-on-a-guess is forbidden', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      // Uncertain → Tier 1 (the conservative default), expressed explicitly.
      expect(section).toMatch(/(uncertain|in doubt|unsure)[\s\S]{0,80}tier[\s-]*1/i)
      // Guessing UP to Tier 2 must be explicitly prohibited (not just absent).
      expect(section).toMatch(/never[\s\S]{0,40}tier[\s-]*2[\s\S]{0,20}(guess|doubt|uncertain)|tier[\s-]*2[\s\S]{0,20}(on a )?guess/i)
      // The unsafe inversion (uncertain → Tier 2) must NOT be present.
      expect(section).not.toMatch(/(uncertain|in doubt|unsure)[\s\S]{0,40}default[\s\S]{0,20}tier[\s-]*2/i)
    })

    it('pins the dark-launch invariant: flag 0 means heavy is off AND you fall back to Tier 1 (behavior identical to today)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      // Flag 0 → off/unavailable...
      expect(section).toMatch(/(`0`|flag is `?0`?)[\s\S]{0,80}(off|unavailable|disabled)/i)
      // ...and the explicit fall-back-to-Tier-1 behavior under that flag.
      // Tolerate the prose wrap ("fall\n     back to Tier 1").
      expect(section).toMatch(/fall\s+back[\s\S]{0,40}tier[\s-]*1/i)
    })

    it('ties the ralph-heavy override to the flag being on (the forced Tier 2 is conditional, not absolute)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      // The override forces Tier 2...
      expect(section).toMatch(/ralph-heavy[\s\S]{0,120}forces?[\s\S]{0,40}tier[\s-]*2/i)
      // ...but is qualified by the flag being on (subject to / when the flag is on).
      expect(section).toMatch(/(subject to|provided|when|if)[\s\S]{0,30}flag[\s\S]{0,20}(being )?on|flag[\s\S]{0,20}(being )?on/i)
    })

    it('preserves the legacy light-path skip semantics: Tier 0 skips dev-TDD AND QA but still runs review + writer', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = triageSection(out)
      // The three-tier rewrite must not silently drop the light path's skip
      // semantics that the legacy two-path tests rely on.
      expect(section).toMatch(/skip dev-TDD and QA|skip.+dev.TDD.+QA/i)
      expect(section).toMatch(/steps?\s+4\s+and\s+4b/i)
      expect(section).toMatch(/light review/i)
      expect(section).toMatch(/writer/i)
      expect(section).toMatch(/steps?\s+4c.+4d|4c.+4d/i)
    })
  })

  describe('explorer specialist role composition', () => {
    it('composes the explorer role into the rendered prompt', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/##+ .*Explorer/i)
    })

    it('frames the explorer as a read-only hypothesis investigator', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const start = out.search(/##+ .*Explorer/i)
      const section = out.slice(start)
      expect(section).toMatch(/read-only/i)
      expect(section).toMatch(/hypothesis/i)
      // It investigates / reads but does not write code.
      expect(section).toMatch(/investigat/i)
      expect(section).toMatch(/(does not|never|no).+(write|edit|modif)/i)
    })

    it('requires the explorer to produce a structured return', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const start = out.search(/##+ .*Explorer/i)
      const section = out.slice(start)
      expect(section).toMatch(/structured return/i)
    })

    it('fully replaces the {{ROLE_EXPLORER}} placeholder (none left in output)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).not.toContain('{{ROLE_EXPLORER}}')
    })

    it('leaves no unreplaced {{ROLE_*}} composition placeholder anywhere in the output', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).not.toMatch(/\{\{ROLE_/)
    })

    it('does not warn on unknown placeholders once the explorer role is composed', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('Tier-2 explorer fan-out + inline synthesis', () => {
    function understandSection(out) {
      const start = out.search(/##+ .*Tier 2[^\n]*understand/i)
      const end = out.search(/\n4\.\s+\*\*Resolve via the dev specialist\*\*/)
      return out.slice(start, end === -1 ? undefined : end)
    }

    it('dispatches exactly three explorers on a Tier-2 run', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = understandSection(out)
      // Fixed fan-out width of 3.
      expect(section).toMatch(/(three|3)\s+explorer/i)
    })

    it('gives the three explorers competing / different hypotheses', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = understandSection(out)
      expect(section).toMatch(/competing|different|distinct/i)
      expect(section).toMatch(/hypothes/i)
    })

    it('runs the explorers read-only (no writes during the understand phase)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = understandSection(out)
      expect(section).toMatch(/read-only/i)
    })

    it('has a named, sectioned synthesizer seam run inline by the orchestrator', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // A named, reviewable seam — the Synthesizer — distinct from the explorers.
      expect(out).toMatch(/##+ .*Synthesiz/i)
      const section = understandSection(out)
      expect(section).toMatch(/synthesiz/i)
      // Runs inline in the orchestrator, not as a separate subagent dispatch.
      expect(section).toMatch(/inline/i)
    })

    it('synthesizes the three explorer returns into a single plan', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = understandSection(out)
      expect(section).toMatch(/(single|one)\s+plan/i)
    })

    it('hands the synthesized plan plus the issue to the dev (dev contract unchanged)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = understandSection(out)
      // On Tier 2 the dev receives the synthesized plan + issue.
      expect(section).toMatch(/plan\s*\+\s*issue|plan and (the )?issue/i)
    })

    it('keeps the dev step-4 contract intact: the dev still receives the issue title and body', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // The existing dev dispatch contract must remain verbatim.
      expect(out).toMatch(/4\.\s+\*\*Resolve via the dev specialist\*\*/)
      expect(out).toMatch(/issue title and body/i)
    })

    it('places the Tier-2 understand phase after triage (3b) and before the dev dispatch (step 4)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const triageIdx = out.search(/3b\.\s+\*\*Triage and scale/i)
      const understandIdx = out.search(/##+ .*Tier 2[^\n]*understand/i)
      const devDispatchIdx = out.search(/\n4\.\s+\*\*Resolve via the dev specialist\*\*/)
      expect(triageIdx).toBeGreaterThan(-1)
      expect(understandIdx).toBeGreaterThan(-1)
      expect(devDispatchIdx).toBeGreaterThan(-1)
      expect(understandIdx).toBeGreaterThan(triageIdx)
      expect(understandIdx).toBeLessThan(devDispatchIdx)
    })

    it('does not warn on unknown placeholders once the Tier-2 understand phase is added', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('Tier-2 explorer fan-out — QA hardening', () => {
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
      RALPH_HEAVY_TIER: '2',
    }

    function understandSection(out) {
      const start = out.search(/##+ .*Tier 2[^\n]*understand/i)
      const end = out.search(/\n4\.\s+\*\*Resolve via the dev specialist\*\*/)
      return out.slice(start, end === -1 ? undefined : end)
    }

    // Everything from the dev dispatch (step 4) to the end of the prompt. The
    // understand-phase prose lives ONLY between triage (3b) and step 4; if any
    // of its unique tokens appears here, the section has leaked downstream.
    function afterDevDispatch(out) {
      const start = out.search(/\n4\.\s+\*\*Resolve via the dev specialist\*\*/)
      return out.slice(start)
    }

    // Everything BEFORE the triage step (3b). The understand phase sits after
    // triage, so its tokens must not appear in the header/select/branch prose.
    // (The intro header legitimately mentions the gated heavy tier, so scope the
    // negative assertions to the understand-phase-unique tokens.)
    function beforeTriage(out) {
      const end = out.search(/3b\.\s/)
      return out.slice(0, end)
    }

    // 1. Region confinement — understand-phase tokens must not leak past step 4.
    it('confines the understand-phase prose to the region between triage (3b) and dev dispatch (step 4)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const after = afterDevDispatch(out)
      // Tokens unique to the understand phase must NOT appear after step 4.
      // ("explorer"/"Synthesizer seam"/"competing hypothes" are the unique
      // understand-phase markers; {{RALPH_HEAVY_TIER}} / a Tier-2 header mention
      // are legitimate elsewhere and are deliberately not asserted against.)
      expect(after).not.toMatch(/Synthesizer seam/i)
      expect(after).not.toMatch(/competing[\s-]*hypothes/i)
      expect(after).not.toMatch(/explorer/i)
      // The understand phase comes after triage, so its tokens must not appear
      // before step 3b either.
      const before = beforeTriage(out)
      expect(before).not.toMatch(/Synthesizer seam/i)
      expect(before).not.toMatch(/competing[\s-]*hypothes/i)
      expect(before).not.toMatch(/explorer/i)
      // And the understand section really does carry them (so the negatives bite).
      const section = understandSection(out)
      expect(section).toMatch(/explorer/i)
      expect(section).toMatch(/competing|distinct/i)
    })

    // 2. Custom-env survival — no stranded placeholder, no stderr warning.
    it('strands no {{...}} placeholder in the understand section under a fully-populated custom env (RALPH_HEAVY_TIER=2) and a NON-empty PROMPT.md', () => {
      const vol = setupFs({
        projectFiles: { 'PROMPT.md': '## Stack\nRust + cargo\n\nProject notes.' },
      })
      const stderr = makeStderr()
      const out = buildPrompt({ projectRoot: PROJECT, env: FULL_ENV, fs: vol, stderr })
      const section = understandSection(out)
      expect(section).toMatch(/explorer/i)
      // No leftover placeholder anywhere in the understand section.
      expect(section).not.toMatch(/\{\{[A-Za-z_]/)
      // And the whole composition stays warning-free under the custom env.
      expect(stderr.calls).toHaveLength(0)
    })

    // 2b. The explorer role section itself interpolates any cmd placeholders it
    //     carries; if it carries none, there must simply be no leftovers.
    it('leaves no {{TEST_CMD}}/{{LINT_CMD}} placeholder in the explorer role section under a custom env', () => {
      const vol = setupFs()
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { TEST_CMD: 'cargo test --all', LINT_CMD: 'cargo clippy --strict' },
        fs: vol,
      })
      const start = out.search(/##+ .*Explorer specialist/i)
      const end = out.search(/##+ .*Synthesizer seam/i)
      const explorerSection = out.slice(start, end === -1 ? undefined : end)
      expect(explorerSection).not.toContain('{{TEST_CMD}}')
      expect(explorerSection).not.toContain('{{LINT_CMD}}')
      expect(explorerSection).not.toMatch(/\{\{[A-Za-z_]/)
    })

    // 3. Exactly three, not "at least" — no contradictory width.
    it('pins the fan-out to exactly three with no contradictory width mentioned', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = understandSection(out)
      expect(section).toMatch(/(three|3)\s+explorer/i)
      // No alternative widths that would contradict the fixed 3.
      expect(section).not.toMatch(/(two|five|4|5|6)\s+explorer/i)
      expect(section).not.toMatch(/explorers?\s+\(.*\b(2|4|5)\b/i)
      // No "at least"/"up to" hedging that would let it drift to a variable count.
      expect(section).not.toMatch(/(at least|up to|as many as|one or more)\s+(three|3)?\s*explorer/i)
    })

    it('frames the width-of-three as fixed/deliberate, not a cost ceiling (guards against a future variable count)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = understandSection(out)
      // The "fixed / deliberate, not a cost ceiling" framing must be present so a
      // future edit can't silently turn 3 into a tunable knob.
      expect(section).toMatch(/fixed/i)
      expect(section).toMatch(/not a cost ceiling|deliberate/i)
    })

    // 4. Synthesizer is inline, NOT a subagent dispatch.
    it('frames the synthesizer as inline in the orchestrator and explicitly NOT a subagent dispatch', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = understandSection(out)
      // Inline / in the orchestrator.
      expect(section).toMatch(/synthesiz/i)
      expect(section).toMatch(/inline/i)
      expect(section).toMatch(/orchestrator/i)
      // Explicitly NOT dispatched as a subagent (the subtle correctness point).
      expect(section).toMatch(/not[\s\S]{0,40}(a )?(separate )?subagent|no subagent/i)
    })

    it('distinguishes the synthesizer (inline) from the explorers (context-isolated subagents)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = understandSection(out)
      // Explorers ARE context-isolated subagents...
      expect(section).toMatch(/context-isolated\s+subagent/i)
      // ...while the synthesizer is the inline seam, not a dispatch. Both framings
      // must coexist in the same section so the contrast is explicit.
      expect(section).toMatch(/inline/i)
    })

    // 5. Dev contract truly unchanged on Tier 0/1.
    it('keeps the dev step-4 dispatch text "issue title and body" verbatim and scopes "plan + issue" to the understand phase', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // Step 4's own contract is unchanged: dev receives the issue title and body.
      expect(out).toMatch(/4\.\s+\*\*Resolve via the dev specialist\*\*/)
      const step4Start = out.search(/\n4\.\s+\*\*Resolve via the dev specialist\*\*/)
      const step4bStart = out.search(/\n4b\.\s+\*\*Harden via the QA/)
      const step4 = out.slice(step4Start, step4bStart === -1 ? undefined : step4bStart)
      expect(step4).toMatch(/issue title and body/i)
      // The "plan + issue" handoff must NOT be bolted onto step 4 itself.
      expect(step4).not.toMatch(/plan\s*\+\s*issue/i)
      // It lives in the Tier-2 understand phase instead.
      const section = understandSection(out)
      expect(section).toMatch(/plan\s*\+\s*issue|plan and (the )?issue/i)
    })

    // 6. Structured-return adversarial — explicit enumerated fields.
    it('enumerates the explorer structured-return fields by name (a free-form return cannot pass)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const start = out.search(/##+ .*Explorer specialist/i)
      const end = out.search(/##+ .*Synthesizer seam/i)
      const explorerSection = out.slice(start, end === -1 ? undefined : end)
      expect(explorerSection).toMatch(/structured return/i)
      // The stable field names the synthesizer relies on.
      expect(explorerSection).toMatch(/\bHypothesis\b/)
      expect(explorerSection).toMatch(/\bVerdict\b/)
      expect(explorerSection).toMatch(/\bEvidence\b/)
      expect(explorerSection).toMatch(/Proposed approach/i)
      expect(explorerSection).toMatch(/Risks/i)
    })

    // 7. Explorer role renders after triage and exactly once (no duplication).
    it('renders the Explorer specialist heading exactly once and after the triage step (3b)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const headings = out.match(/##+ .*Explorer specialist/gi) || []
      expect(headings.length).toBe(1)
      const triageIdx = out.search(/3b\.\s+\*\*Triage and scale/i)
      const explorerIdx = out.search(/##+ .*Explorer specialist/i)
      expect(triageIdx).toBeGreaterThan(-1)
      expect(explorerIdx).toBeGreaterThan(triageIdx)
    })
  })

  describe('Tier-2 reviewer panel verify gate', () => {
    function verifySection(out) {
      const start = out.search(/##+ .*Tier 2[^\n]*verify/i)
      const end = out.search(/\n4d\.\s+\*\*Document via the tech writer/)
      return out.slice(start, end === -1 ? undefined : end)
    }

    it('dispatches a panel of three reviewers on a Tier-2 run', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      expect(section).toMatch(/##+ .*Tier 2[^\n]*verify/i)
      expect(section).toMatch(/(three|3)\s+reviewer/i)
      expect(section).toMatch(/panel/i)
    })

    it('reuses the existing reviewer contract rather than duplicating the maintainability standard', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      // Reuses the existing reviewer role (the "Code reviewer specialist").
      expect(section).toMatch(/reviewer (role|contract)|existing reviewer/i)
      // The maintainability standard is NOT re-stated in the verify section: the
      // "Ralph-authored maintainability standard" heading text appears only in
      // the pre-existing step 4c prose + the reviewer role file (its 2 baseline
      // sites), never re-printed inside the verify-phase section.
      expect(section).not.toMatch(/Ralph-authored maintainability standard/)
      expect((out.match(/Ralph-authored maintainability standard/g) || []).length).toBe(2)
    })

    it('assigns the three distinct lenses: correctness, security, maintainability', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      expect(section).toMatch(/correctness/i)
      expect(section).toMatch(/security/i)
      expect(section).toMatch(/maintainability/i)
      // The existing maintainability standard becomes the maintainability lens.
      expect(section).toMatch(/maintainability lens/i)
    })

    it('blocks on majority-of-3 (2 of 3); a single reviewer cannot trap the loop', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      // Majority-of-3 / 2 of 3 blocking rule.
      expect(section).toMatch(/majority/i)
      expect(section).toMatch(/2 of 3|two of (the )?three|2 of the 3/i)
      // A single reviewer cannot block / trap the loop on its own.
      expect(section).toMatch(/single reviewer[\s\S]{0,40}(cannot|can't|does not|no).{0,20}(block|trap)/i)
    })

    it('bounds the panel to a maximum of 2 rounds', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      expect(section).toMatch(/(maximum|max|up to|at most).{0,12}2 rounds/i)
      // Blocking findings loop back to the dev.
      expect(section).toMatch(/back to the dev|return.+dev|hand.+back/i)
    })

    it('opens the PR anyway on non-convergence with a [!WARNING] block, Tier-1-consistent', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      // Non-convergence opens the PR anyway.
      expect(section).toMatch(/open.+PR anyway|PR is opened anyway/i)
      expect(section).toMatch(/non-convergence|converge/i)
      // With a [!WARNING] block.
      expect(section).toMatch(/\[!WARNING\]/)
      // Semantics identical / consistent with Tier 1 — no Tier-2 special case.
      expect(section).toMatch(/(identical|consistent).{0,40}tier[\s-]*1|tier[\s-]*1.{0,40}(identical|consistent)/i)
    })

    it('runs only on a Tier-2 run and leaves Tier 0/1 single-reviewer step 4c unchanged', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      // Gated behind the heavy-tier flag and scoped to Tier-2 runs.
      expect(section).toMatch(/RALPH_HEAVY_TIER/)
      expect(section).toMatch(/Tier[\s-]*2 run/i)
      // Tier 0 / 1 keeps the existing single reviewer (step 4c) unchanged.
      expect(section).toMatch(/Tier 0[\s\S]{0,40}(1|Tier 1)/i)
      expect(section).toMatch(/single[\s-]reviewer|step 4c/i)
    })

    it('places the verify phase after the reviewer step (4c) and before step 4d and the Open PR step', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const reviewerStepIdx = out.search(/\b4c\.\s+\*\*Review via the code reviewer/)
      const verifyIdx = out.search(/##+ .*Tier 2[^\n]*verify/i)
      const step4dIdx = out.search(/\n4d\.\s+\*\*Document via the tech writer/)
      const openPrIdx = out.search(/\bOpen PR\b/)
      expect(reviewerStepIdx).toBeGreaterThan(-1)
      expect(verifyIdx).toBeGreaterThan(-1)
      expect(step4dIdx).toBeGreaterThan(-1)
      expect(openPrIdx).toBeGreaterThan(-1)
      expect(verifyIdx).toBeGreaterThan(reviewerStepIdx)
      expect(verifyIdx).toBeLessThan(step4dIdx)
      expect(verifyIdx).toBeLessThan(openPrIdx)
    })

    it('strands no {{...}} placeholder in the verify section under a fully-populated custom env', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '## Stack\nRust + cargo' } })
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: {
          INSTALL_CMD: 'pnpm install',
          TEST_CMD: 'cargo test --all',
          LINT_CMD: 'cargo clippy',
          PR_TARGET: 'integration',
          MERGE_STRATEGY: 'merge',
          RALPH_HEAVY_TIER: '2',
        },
        fs: vol,
      })
      const section = verifySection(out)
      expect(section).toMatch(/reviewer/i)
      expect(section).not.toMatch(/\{\{[A-Za-z_]/)
    })

    it('does not warn on unknown placeholders once the verify phase is added', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const stderr = makeStderr()
      buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol, stderr })
      expect(stderr.calls).toHaveLength(0)
    })
  })

  describe('Tier-2 reviewer panel verify gate — QA hardening', () => {
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
      RALPH_HEAVY_TIER: '2',
    }

    // The verify phase: from its heading up to the step-4d (tech writer) marker.
    function verifySection(out) {
      const start = out.search(/##+ .*Tier 2[^\n]*verify/i)
      const end = out.search(/\n4d\.\s+\*\*Document via the tech writer/)
      return out.slice(start, end === -1 ? undefined : end)
    }

    // Everything from step 4d onward (the writer step, validate, commit, Open PR,
    // failure, restrictions). Verify-phase-unique tokens must not leak here.
    function afterVerify(out) {
      const start = out.search(/\n4d\.\s+\*\*Document via the tech writer/)
      return out.slice(start)
    }

    // Everything strictly before the verify heading (intro header, triage,
    // understand phase, steps 4 / 4b / 4c). The adversarial-panel prose is unique
    // to the verify phase and must not appear upstream.
    function beforeVerify(out) {
      const end = out.search(/##+ .*Tier 2[^\n]*verify/i)
      return out.slice(0, end)
    }

    // 1. Region confinement — verify-phase tokens must not leak downstream/upstream.
    it('confines the adversarial-panel prose to the verify section — no leak before it or after step 4d', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const before = beforeVerify(out)
      const after = afterVerify(out)
      // Tokens unique to the verify phase must not appear in the writer/validate/
      // PR region downstream...
      expect(after).not.toMatch(/adversarial panel/i)
      expect(after).not.toMatch(/majority/i)
      expect(after).not.toMatch(/2 of 3/i)
      // ...nor in the header/triage/understand/single-reviewer prose upstream.
      expect(before).not.toMatch(/adversarial panel/i)
      expect(before).not.toMatch(/majority/i)
      expect(before).not.toMatch(/2 of 3/i)
      // And the verify section really does carry them (so the negatives bite).
      const section = verifySection(out)
      expect(section).toMatch(/adversarial panel/i)
      expect(section).toMatch(/majority/i)
      expect(section).toMatch(/2 of 3/i)
    })

    // 2. No SECOND "Code reviewer specialist" heading — the panel reuses the one
    //    composed at 4c; it does not redeclare the role.
    it('introduces no second "Code reviewer specialist" heading — the count stays exactly 1', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // The verify phase reuses the reviewer composed at 4c; it must not compose a
      // second copy of the role heading.
      expect((out.match(/##+ .*Code reviewer specialist/gi) || []).length).toBe(1)
      // The verify section itself must NOT carry a fresh role heading.
      const section = verifySection(out)
      expect(section).not.toMatch(/##+ .*Code reviewer specialist/i)
      // It explicitly points back to the reuse instead.
      expect(section).toMatch(/reuse|existing reviewer|composed above/i)
    })

    // 3. No-duplication adversarial — the maintainability-standard RULE BODIES are
    //    not re-printed in the verify section (it only names the lens + points to 4c).
    it('does not restate the maintainability rule bodies inside the verify section', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      // The verify section may NAME the lens / its rules, but must not re-print the
      // rule prose bodies that live in step 4c + reviewer.md.
      expect(section).not.toContain('flag files that have grown too large')
      expect(section).not.toContain('reject tangled control flow')
      expect(section).not.toContain('abstractions must earn their keep')
      expect(section).not.toContain('remove it rather than adding another')
      expect(section).not.toContain('Green tests are the floor')
      // The "Ralph-authored maintainability standard" heading is one of its two
      // baseline sites (step 4c prose + reviewer.md) and is NOT duplicated here.
      expect(section).not.toMatch(/Ralph-authored maintainability standard/)
      expect((out.match(/Ralph-authored maintainability standard/g) || []).length).toBe(2)
      // It explicitly defers to step 4c rather than restating.
      expect(section).toMatch(/step 4c/i)
    })

    // 4. Exactly three, not "at least" — no contradictory width, no hedging.
    it('pins the panel width to exactly three with no contradictory width and no hedging', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      expect(section).toMatch(/(three|3)\s+reviewer/i)
      // No alternative widths that would contradict the fixed 3.
      expect(section).not.toMatch(/(two|four|five|6)\s+reviewer/i)
      expect(section).not.toMatch(/reviewers?\s+\(.*\b(2|4|5)\b/i)
      // No "at least"/"up to" hedging that would let the panel drift to a
      // variable count.
      expect(section).not.toMatch(/(at least|up to|as many as|one or more)\s+(three|3)?\s*reviewer/i)
    })

    // 5. Majority semantics adversarial — 2-of-3 is the threshold; unsafe
    //    inversions (lone-reviewer block, unanimity-required) are absent.
    it('fixes the block threshold at 2-of-3 and forbids the unsafe inversions', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      // 2-of-3 majority is the gate.
      expect(section).toMatch(/majority/i)
      expect(section).toMatch(/2 of 3|two of (the )?three|2 of the 3/i)
      // A single / lone reviewer cannot block on its own.
      expect(section).toMatch(/single reviewer[\s\S]{0,40}(cannot|can't|does not|no)/i)
      // The unsafe inversions must NOT be stated. Use \b(can|may|must)\b so the
      // SAFE phrase "single reviewer cannot block" (where "can" is a substring of
      // "cannot") is not mistaken for an unsafe "single reviewer CAN block".
      expect(section).not.toMatch(/single reviewer[\s\S]{0,30}\b(can|may|must)\b[\s\S]{0,20}block/i)
      // Requiring all three / unanimity to block is also forbidden.
      expect(section).not.toMatch(/(unanim|all three reviewers must|all 3 reviewers must)/i)
    })

    // 6. Custom-env survival + warning-free under a fully-populated env and a
    //    NON-empty PROMPT.md.
    it('strands no {{...}} in the verify section and emits no warning under a full custom env (RALPH_HEAVY_TIER=2) and a NON-empty PROMPT.md', () => {
      const vol = setupFs({
        projectFiles: { 'PROMPT.md': '## Stack\nRust + cargo\n\nProject notes.' },
      })
      const stderr = makeStderr()
      const out = buildPrompt({ projectRoot: PROJECT, env: FULL_ENV, fs: vol, stderr })
      const section = verifySection(out)
      expect(section).toMatch(/reviewer/i)
      // The panel re-runs the test+lint commands, which must interpolate cleanly.
      expect(section).toContain('cargo test --all')
      expect(section).toContain('cargo clippy --strict')
      expect(section).not.toMatch(/\{\{[A-Za-z_]/)
      // And the whole composition stays warning-free under the custom env.
      expect(stderr.calls).toHaveLength(0)
    })

    // 7. Tier 0/1 unchanged invariant — single-reviewer 4c intact, verify skipped.
    it('leaves the single-reviewer step 4c intact and explicitly skips the panel on Tier 0/1', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // Step 4c (the single-reviewer gate) is still present and unchanged.
      expect(out).toMatch(/\b4c\.\s+\*\*Review via the code reviewer/)
      // The verify phase declares itself skipped on a Tier 0 / Tier 1 run, leaving
      // 4c untouched.
      const section = verifySection(out)
      expect(section).toMatch(/Tier 0[\s\S]{0,40}(Tier )?1[\s\S]{0,80}skip/i)
      expect(section).toMatch(/single-reviewer step 4c[\s\S]{0,40}(unchanged|left)/i)
    })

    // 8. Ordering robustness — verify strictly after 4c, strictly before 4d /
    //    Open PR, with the understand phase also present upstream.
    it('orders the verify phase strictly after step 4c and strictly before step 4d and Open PR, with the understand phase present upstream', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const understandIdx = out.search(/##+ .*Tier 2[^\n]*understand/i)
      const step4cIdx = out.search(/\b4c\.\s+\*\*Review via the code reviewer/)
      const verifyIdx = out.search(/##+ .*Tier 2[^\n]*verify/i)
      const step4dIdx = out.search(/\n4d\.\s+\*\*Document via the tech writer/)
      const openPrIdx = out.search(/\*\*Open PR\*\*/)
      for (const idx of [understandIdx, step4cIdx, verifyIdx, step4dIdx, openPrIdx]) {
        expect(idx).toBeGreaterThan(-1)
      }
      // understand phase comes before the single reviewer, which comes before the
      // panel, which comes before the writer and the PR step.
      expect(understandIdx).toBeLessThan(step4cIdx)
      expect(step4cIdx).toBeLessThan(verifyIdx)
      expect(verifyIdx).toBeLessThan(step4dIdx)
      expect(verifyIdx).toBeLessThan(openPrIdx)
    })

    // 9. Non-convergence is Tier-1-consistent — reuses step 7's [!WARNING] block
    //    so the outer bash needs no Tier-2 special case.
    it('routes non-convergence through the SAME step-7 [!WARNING] block, needing no Tier-2 bash special case', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      const section = verifySection(out)
      // Opens the PR anyway on non-convergence...
      expect(section).toMatch(/open the PR \*\*anyway\*\*|open.+PR anyway|PR is opened anyway/i)
      expect(section).toMatch(/converge/i)
      // ...via the same [!WARNING] block step 7 already prepends (reuse, not a new
      // mechanism)...
      expect(section).toMatch(/\[!WARNING\]/)
      expect(section).toMatch(/step 7/)
      // ...and the bash needs NO Tier-2 special case for success/failure accounting.
      expect(section).toMatch(/no[\s\S]{0,20}Tier-?2 special case|Tier-?2 special case/i)
      // The verify section must NOT define a fresh warning template of its own — it
      // points at the one step 7 already prepends. The literal block body (the
      // "> [!WARNING]" line plus its "Unresolved review concerns" heading) is
      // authored exactly once, in step 7; the verify prose only references it.
      expect((out.match(/> \[!WARNING\]/g) || []).length).toBe(1)
      expect((out.match(/Unresolved review concerns/g) || []).length).toBe(1)
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

  describe('agent selection (#554)', () => {
    it('uses the Claude orchestrator by default (RALPH_AGENT unset)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toContain('# Ralph Loop — Team orchestrator')
      expect(out).not.toContain('running under the\n**Codex** CLI')
    })

    it('selects the Codex orchestrator when RALPH_AGENT=codex', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: { RALPH_AGENT: 'codex' }, fs: vol })
      expect(out).toContain('Team orchestrator (Codex)')
      expect(out).toContain('Codex')
    })

    it('falls back to the Claude orchestrator on an unrecognized RALPH_AGENT', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: { RALPH_AGENT: 'codx' }, fs: vol })
      expect(out).toContain('# Ralph Loop — Team orchestrator')
      expect(out).not.toContain('Team orchestrator (Codex)')
    })

    it('composes all five roles and interpolates vars in the Codex orchestrator too', () => {
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '## Stack\nGo' } })
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: {
          RALPH_AGENT: 'codex',
          INSTALL_CMD: 'go mod download',
          TEST_CMD: 'go test ./...',
          LINT_CMD: 'golangci-lint run',
          DEV_BRANCH: 'dev',
          PR_TARGET: 'dev',
        },
        fs: vol,
      })
      // No unresolved role placeholders or vars remain.
      for (const p of ['{{ROLE_DEV}}', '{{ROLE_QA}}', '{{ROLE_REVIEW}}', '{{ROLE_WRITER}}', '{{ROLE_EXPLORER}}']) {
        expect(out).not.toContain(p)
      }
      expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/)
      expect(out).toContain('go test ./...')
      expect(out).toContain('git checkout dev')
      expect(out).toContain('## Stack\nGo')
    })
  })
})
