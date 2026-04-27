import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { RALPH_HOME, TEMPLATES_DIR, templatePath } from '../lib/paths.js'

describe('paths', () => {
  it('RALPH_HOME points to the package root (contains package.json)', () => {
    expect(isAbsolute(RALPH_HOME)).toBe(true)
    expect(existsSync(`${RALPH_HOME}/package.json`)).toBe(true)
  })

  it('TEMPLATES_DIR is the templates dir under the package and exists', () => {
    expect(isAbsolute(TEMPLATES_DIR)).toBe(true)
    expect(basename(TEMPLATES_DIR)).toBe('templates')
    expect(existsSync(TEMPLATES_DIR)).toBe(true)
  })

  it('templatePath joins relative names against TEMPLATES_DIR', () => {
    const p = templatePath('ralph.sh')
    expect(p.startsWith(TEMPLATES_DIR)).toBe(true)
    expect(p.endsWith('/ralph.sh')).toBe(true)
    expect(existsSync(p)).toBe(true)
  })
})
