import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { existsSync, readFileSync } from 'node:fs'
import { buildPrompt } from './build-prompt.js'
import { templatePath } from './paths.js'

// Regression guard for issue #427: solo mode is permanently retired. The solo
// orchestrator template (`prompt-base.md`) and any solo-only code path were
// removed in favor of the team orchestrator (`prompt-team.md`). This guard
// locks that in so a future refactor cannot silently restore solo mode, and
// asserts the surviving safety/"what-survives-an-update" contract stays intact.

const PROJECT = '/project'

// Mirror build-prompt.test.js's memfs setup so the rendered prompt under test
// is built from the real on-disk templates.
function setupFs() {
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
  return vol
}

describe('solo mode is retired (regression guard for #427)', () => {
  describe('solo is gone', () => {
    it('does not ship the solo orchestrator template (prompt-base.md) on disk', () => {
      // Checked against the REAL filesystem, not memfs: the retired template
      // must never reappear in the package.
      expect(existsSync(templatePath('prompt-base.md'))).toBe(false)
    })

    it('renders no reference to a solo template in the prompt', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).not.toMatch(/prompt-base/i)
    })

    it('carries no solo-vs-team mode toggle or solo activation flag', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // No solo/team mode switch, persona-switching branch, or "solo mode" prose.
      expect(out).not.toMatch(/solo[\s_-]*mode/i)
      expect(out).not.toMatch(/solo[\s_-]*vs[\s_-]*team|team[\s_-]*vs[\s_-]*solo/i)
      expect(out).not.toMatch(/\bsolo\b/i)
    })

    it('does not read prompt-base.md from build-prompt.js source', () => {
      const src = readFileSync(new URL('./build-prompt.js', import.meta.url), 'utf8')
      expect(src).not.toMatch(/prompt-base/i)
      expect(src).not.toMatch(/\bsolo\b/i)
    })
  })

  describe('team contract is present', () => {
    it('renders the team orchestrator as the prompt', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toContain('# Ralph Loop — Team orchestrator')
    })

    it('composes all four specialist roles (Dev, QA, Code reviewer, Tech writer)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toContain('## Dev specialist')
      expect(out).toContain('## QA specialist')
      expect(out).toContain('## Code reviewer specialist')
      expect(out).toContain('## Tech writer specialist')
      // No composition slot left dangling — every {{ROLE_*}} was filled.
      expect(out).not.toMatch(/\{\{ROLE_/)
    })
  })

  describe('safety guarantees / what-survives-an-update contract intact', () => {
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
  })
})
