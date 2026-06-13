import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { buildPrompt } from './build-prompt.js'
import { templatePath, TEMPLATES_DIR } from './paths.js'

// QA augmentation for issue #427 (solo mode retired). The dev's guard
// (solo-mode-retired.test.js) locks the RENDERED prompt and the
// `build-prompt.js` SOURCE. These adversarial tests close the gaps a future
// refactor could slip through while still passing that guard:
//   - the on-disk SOURCE templates themselves carrying solo prose,
//   - a role file being DROPPED (off-by-one toward a thinner/solo-like flow),
//   - the `prompt-base.md` path guard pointing somewhere it could never exist,
//     making the guard vacuously true.

const PROJECT = '/project'

// The four role source files that get composed into the orchestrator.
const ROLE_FILES = [
  'roles/dev.md',
  'roles/qa.md',
  'roles/reviewer.md',
  'roles/writer.md',
  'roles/explorer.md',
]
const ALL_SOURCE_TEMPLATES = ['prompt-team.md', ...ROLE_FILES]

// Same memfs mirror the dev's guard / build-prompt.test.js use.
function setupFs() {
  const vol = Volume.fromJSON({}, '/')
  vol.mkdirSync(templatePath('roles'), { recursive: true })
  vol.writeFileSync(templatePath('prompt-team.md'), readFileSync(templatePath('prompt-team.md'), 'utf8'))
  for (const role of ROLE_FILES) {
    vol.writeFileSync(templatePath(role), readFileSync(templatePath(role), 'utf8'))
  }
  vol.mkdirSync(PROJECT, { recursive: true })
  return vol
}

describe('solo mode retired — QA augmentation (#427)', () => {
  describe('on-disk source templates carry no solo markers', () => {
    // The dev guards the rendered prompt and build-prompt.js. But a refactor
    // could reintroduce a "solo mode" toggle / persona-switch directly into a
    // SOURCE template. Most would surface in the render, but pinning the
    // source-of-truth files directly catches prose that lands in a section the
    // render check happens not to inspect, and is independent of the
    // composition logic.
    it.each(ALL_SOURCE_TEMPLATES)('%s has no solo-mode toggle or solo prose', (name) => {
      const src = readFileSync(templatePath(name), 'utf8')
      expect(src).not.toMatch(/solo[\s_-]*mode/i)
      expect(src).not.toMatch(/solo[\s_-]*vs[\s_-]*team|team[\s_-]*vs[\s_-]*solo/i)
      expect(src).not.toMatch(/\bsolo\b/i)
      expect(src).not.toMatch(/prompt-base/i)
    })
  })

  describe('the prompt-base.md guard is meaningful, not vacuous', () => {
    it('resolves prompt-base.md INTO the real templates dir', () => {
      // If templatePath('prompt-base.md') resolved somewhere it could never
      // exist, the dev's `existsSync(...) === false` assertion would pass
      // vacuously. Pin that it points at the same dir that DOES hold the live
      // templates, so the absence check is real.
      const basePath = templatePath('prompt-base.md')
      expect(basePath.startsWith(TEMPLATES_DIR)).toBe(true)
      // Sanity anchor: a sibling that genuinely exists resolves the same way
      // and is present, proving the dir is the live templates dir.
      expect(existsSync(templatePath('prompt-team.md'))).toBe(true)
    })

    it('ships no solo orchestrator as a sibling under the templates dir', () => {
      // Broader than the dev's single prompt-base.md filename check: scan the
      // whole templates dir for any solo-flavored orchestrator file.
      const entries = readdirSync(TEMPLATES_DIR)
      expect(entries).not.toContain('prompt-base.md')
      expect(entries.filter((e) => /solo/i.test(e))).toEqual([])
    })
  })

  describe('team-completeness: a dropped role fails loudly (no silent thinning)', () => {
    // The dev asserts all 4 roles ARE present when the render succeeds, but
    // that says nothing about what happens if a role file is removed. A
    // refactor that drops, say, the QA role must NOT degrade to a thinner,
    // solo-like single-pass prompt — it must fail loudly.
    it.each(ROLE_FILES)('throws if %s is missing rather than rendering a thinner prompt', (missing) => {
      const vol = setupFs()
      vol.unlinkSync(templatePath(missing))
      expect(() => buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })).toThrow()
    })

    it('leaves no unfilled {{ROLE_*}} slot AND keeps all four headings (off-by-one guard)', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      // No composition placeholder survives...
      expect(out).not.toMatch(/\{\{ROLE_[A-Z]+\}\}/)
      // ...and exactly the four specialist headings are present (a dropped
      // role can't hide behind a still-passing render).
      const headings = ['Dev specialist', 'QA specialist', 'Code reviewer specialist', 'Tech writer specialist']
      for (const h of headings) expect(out).toContain(`## ${h}`)
    })
  })

  describe('the broad /\\bsolo\\b/i intent is pinned (not accidentally loosened)', () => {
    // The dev flagged /\bsolo\b/i as possibly too broad. Judgment: it is the
    // right strictness here — "solo" is never a benign domain term in this
    // team-only orchestrator, so any future occurrence is a regression. Pin
    // both directions so the intent is explicit and the check can't be quietly
    // weakened: the live render is clean, and an injected "solo" IS caught.
    it('the live rendered prompt is clean under the broad word-boundary check', () => {
      const vol = setupFs()
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).not.toMatch(/\bsolo\b/i)
    })

    it('the broad check actually catches a reintroduced solo mode in a role file', () => {
      const vol = setupFs()
      // Simulate a refactor sneaking solo prose into a composed role.
      vol.writeFileSync(
        templatePath('roles/dev.md'),
        `## Dev specialist\n\nFall back to **Solo mode** when no team is available.\n`,
      )
      const out = buildPrompt({ projectRoot: PROJECT, env: {}, fs: vol })
      expect(out).toMatch(/\bsolo\b/i)
    })
  })
})
