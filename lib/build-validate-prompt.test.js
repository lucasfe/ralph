import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildValidatePrompt } from './build-validate-prompt.js'
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
  const template = readFileSync(templatePath('validate-config.md'), 'utf8')
  const v = Volume.fromJSON({}, '/')
  v.mkdirSync(templatePath(''), { recursive: true })
  v.writeFileSync(templatePath('validate-config.md'), template)
  v.mkdirSync(PROJECT, { recursive: true })
  for (const [k, body] of Object.entries(projectFiles)) {
    v.writeFileSync(join(PROJECT, k), body)
  }
  return v
}

describe('buildValidatePrompt', () => {
  it('interpolates PROJECT_ROOT, CURRENT_CONFIG_HASH and RALPH_VERSION', () => {
    const cfgBody = 'INSTALL_CMD=""\nTEST_CMD=""\nLINT_CMD=""\n'
    const v = setupFs({ projectFiles: { 'ralph.config.sh': cfgBody } })
    const expectedHash = createHash('sha256').update(cfgBody).digest('hex')

    const out = buildValidatePrompt({
      projectRoot: PROJECT,
      ralphVersion: '0.1.0-alpha.0',
      fs: v,
    })

    expect(out).toContain('rooted at `/project`')
    expect(out).toContain(`Pre-validation \`ralph.config.sh\` sha256: \`${expectedHash}\``)
    expect(out).toContain('Ralph package version: `0.1.0-alpha.0`')
    expect(out).not.toContain('{{CURRENT_CONFIG_HASH}}')
    expect(out).not.toContain('{{RALPH_VERSION}}')
    expect(out).not.toContain('{{PROJECT_ROOT}}')
  })

  it('falls back to RALPH_VERSION env when ralphVersion option is omitted', () => {
    const v = setupFs({ projectFiles: { 'ralph.config.sh': 'X=1\n' } })
    const stderr = makeStderr()
    const out = buildValidatePrompt({
      projectRoot: PROJECT,
      ralphVersion: process.env.RALPH_VERSION ?? '9.9.9-test',
      fs: v,
      stderr,
    })
    expect(out).toMatch(/Ralph package version: `[^`]+`/)
    expect(stderr.calls).toHaveLength(0)
  })

  it('throws when ralph.config.sh is missing (no config to validate)', () => {
    const v = setupFs()
    expect(() => buildValidatePrompt({ projectRoot: PROJECT, fs: v })).toThrow()
  })
})
