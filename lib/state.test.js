import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { createHash } from 'node:crypto'
import { hashConfig, readState, statePath, writeState } from './state.js'

const PROJECT = '/project'

function vol(initial = {}) {
  return Volume.fromJSON(initial, '/')
}

describe('statePath', () => {
  it('joins .ralph/state.json under the project root', () => {
    expect(statePath('/foo/bar')).toBe('/foo/bar/.ralph/state.json')
  })
})

describe('readState', () => {
  it('returns null when .ralph/state.json is absent', () => {
    expect(readState(PROJECT, vol())).toBeNull()
  })

  it('returns the parsed object when state file exists', () => {
    const v = vol({
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify({
        config_hash: 'abc',
        ralph_version: '0.1.0',
      }),
    })
    expect(readState(PROJECT, v)).toEqual({
      config_hash: 'abc',
      ralph_version: '0.1.0',
    })
  })

  it('returns null when state file contains invalid JSON', () => {
    const v = vol({ [`${PROJECT}/.ralph/state.json`]: 'not json' })
    expect(readState(PROJECT, v)).toBeNull()
  })
})

describe('writeState', () => {
  it('creates .ralph/ and writes pretty JSON when missing', () => {
    const v = vol()
    writeState(PROJECT, { config_hash: 'abc' }, v)
    const written = v.readFileSync(`${PROJECT}/.ralph/state.json`, 'utf8').toString()
    expect(JSON.parse(written)).toEqual({ config_hash: 'abc' })
    expect(written.endsWith('\n')).toBe(true)
    expect(written).toContain('\n  "config_hash"')
  })

  it('overwrites the previous state on rewrite', () => {
    const v = vol({
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify({ old: true }),
    })
    writeState(PROJECT, { fresh: true }, v)
    const written = v.readFileSync(`${PROJECT}/.ralph/state.json`, 'utf8').toString()
    expect(JSON.parse(written)).toEqual({ fresh: true })
  })
})

describe('hashConfig', () => {
  it('returns the sha256 hex digest of the file contents', () => {
    const body = 'INSTALL_CMD="npm ci"\nTEST_CMD="npm test"\n'
    const v = vol({ [`${PROJECT}/ralph.config.sh`]: body })
    const expected = createHash('sha256').update(body).digest('hex')
    expect(hashConfig(`${PROJECT}/ralph.config.sh`, v)).toBe(expected)
  })

  it('produces different hashes for different content', () => {
    const v = vol({
      [`${PROJECT}/a.sh`]: 'foo',
      [`${PROJECT}/b.sh`]: 'bar',
    })
    expect(hashConfig(`${PROJECT}/a.sh`, v)).not.toBe(
      hashConfig(`${PROJECT}/b.sh`, v),
    )
  })

  it('is stable across calls for unchanged content', () => {
    const v = vol({ [`${PROJECT}/x.sh`]: 'stable' })
    expect(hashConfig(`${PROJECT}/x.sh`, v)).toBe(
      hashConfig(`${PROJECT}/x.sh`, v),
    )
  })
})
