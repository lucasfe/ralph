import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { createHash } from 'node:crypto'
import { finalizeState, FinalizeStateError } from './finalize-state.js'

const PROJECT = '/project'

function vol(initial = {}) {
  return Volume.fromJSON(initial, '/')
}

function partialState(overrides = {}) {
  return {
    config_hash: 'STALE_PLACEHOLDER',
    validated_at: '2026-04-27T12:00:00Z',
    ralph_version: '0.1.0-alpha.0',
    detected_stack: 'npm',
    notes: 'no changes needed',
    last_seen_release: '',
    ...overrides,
  }
}

describe('finalizeState', () => {
  it('recomputes config_hash from the current ralph.config.sh', () => {
    const cfg = 'INSTALL_CMD="npm ci"\nTEST_CMD="npm test"\n'
    const v = vol({
      [`${PROJECT}/ralph.config.sh`]: cfg,
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify(partialState()),
    })
    const result = finalizeState({ projectRoot: PROJECT, fs: v })
    const expected = createHash('sha256').update(cfg).digest('hex')
    expect(result.config_hash).toBe(expected)
    const onDisk = JSON.parse(
      v.readFileSync(`${PROJECT}/.ralph/state.json`, 'utf8').toString(),
    )
    expect(onDisk.config_hash).toBe(expected)
  })

  it('preserves validated_at, detected_stack, notes, last_seen_release', () => {
    const v = vol({
      [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify(
        partialState({
          validated_at: '2026-04-27T12:34:56Z',
          detected_stack: 'pnpm',
          notes: 'fixed empty INSTALL_CMD',
          last_seen_release: 'v0.1.0',
        }),
      ),
    })
    const result = finalizeState({ projectRoot: PROJECT, fs: v })
    expect(result.validated_at).toBe('2026-04-27T12:34:56Z')
    expect(result.detected_stack).toBe('pnpm')
    expect(result.notes).toBe('fixed empty INSTALL_CMD')
    expect(result.last_seen_release).toBe('v0.1.0')
  })

  it('overrides ralph_version when provided', () => {
    const v = vol({
      [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify(
        partialState({ ralph_version: '0.0.0' }),
      ),
    })
    const result = finalizeState({
      projectRoot: PROJECT,
      ralphVersion: '0.2.0',
      fs: v,
    })
    expect(result.ralph_version).toBe('0.2.0')
  })

  it('throws when state.json is missing', () => {
    const v = vol({ [`${PROJECT}/ralph.config.sh`]: 'X=1\n' })
    expect(() => finalizeState({ projectRoot: PROJECT, fs: v })).toThrow(
      FinalizeStateError,
    )
  })

  it('throws when state.json is missing required fields', () => {
    const v = vol({
      [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify({ config_hash: 'x' }),
    })
    expect(() => finalizeState({ projectRoot: PROJECT, fs: v })).toThrow(
      /missing required field/,
    )
  })
})
