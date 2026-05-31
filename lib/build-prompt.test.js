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
  const vol = Volume.fromJSON({}, '/')
  vol.mkdirSync(templatePath('roles'), { recursive: true })
  vol.writeFileSync(templatePath('prompt-team.md'), orchestratorTemplate)
  vol.writeFileSync(templatePath('roles/dev.md'), devRole)
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
