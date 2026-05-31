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
  const vol = Volume.fromJSON({}, '/')
  vol.mkdirSync(templatePath('roles'), { recursive: true })
  vol.writeFileSync(templatePath('prompt-team.md'), orchestratorTemplate)
  vol.writeFileSync(templatePath('roles/dev.md'), devRole)
  vol.writeFileSync(templatePath('roles/qa.md'), qaRole)
  vol.writeFileSync(templatePath('roles/reviewer.md'), reviewerRole)
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
