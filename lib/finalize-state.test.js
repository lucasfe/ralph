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

  // #554: record the resolved agent so tooling can read which coding agent the
  // project is configured for without re-parsing ralph.config.sh.
  it('records agent: claude by default (RALPH_AGENT unset)', () => {
    const v = vol({
      [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify(partialState()),
    })
    const result = finalizeState({ projectRoot: PROJECT, fs: v, env: {} })
    expect(result.agent).toBe('claude')
    const onDisk = JSON.parse(
      v.readFileSync(`${PROJECT}/.ralph/state.json`, 'utf8').toString(),
    )
    expect(onDisk.agent).toBe('claude')
  })

  it('records agent: codex when RALPH_AGENT=codex', () => {
    const v = vol({
      [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify(partialState()),
    })
    const result = finalizeState({
      projectRoot: PROJECT,
      fs: v,
      env: { RALPH_AGENT: 'codex' },
    })
    expect(result.agent).toBe('codex')
  })

  it('falls back to claude and records it when RALPH_AGENT is a typo', () => {
    const v = vol({
      [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify(partialState()),
    })
    const result = finalizeState({
      projectRoot: PROJECT,
      fs: v,
      env: { RALPH_AGENT: 'codx' },
    })
    expect(result.agent).toBe('claude')
  })

  // -------------------------------------------------------------------------
  // QA augmentation (#554): switching agents rewrites the persisted value, and
  // the recorded agent is normalized (never the raw env string).
  // -------------------------------------------------------------------------

  it('QA: switching agent OVERWRITES a previously persisted agent field', () => {
    const v = vol({
      [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
      // state already records codex from a prior run.
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify(partialState({ agent: 'codex' })),
    })
    const result = finalizeState({
      projectRoot: PROJECT,
      fs: v,
      env: { RALPH_AGENT: 'claude' },
    })
    expect(result.agent).toBe('claude')
    const onDisk = JSON.parse(
      v.readFileSync(`${PROJECT}/.ralph/state.json`, 'utf8').toString(),
    )
    expect(onDisk.agent).toBe('claude')
  })

  it('QA: records the NORMALIZED (lowercased/trimmed) agent, not the raw env value', () => {
    const v = vol({
      [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify(partialState()),
    })
    const result = finalizeState({
      projectRoot: PROJECT,
      fs: v,
      env: { RALPH_AGENT: '  CODEX  ' },
    })
    expect(result.agent).toBe('codex')
  })

  it('QA: an empty/whitespace RALPH_AGENT records claude (sane default)', () => {
    const v = vol({
      [`${PROJECT}/ralph.config.sh`]: 'X=1\n',
      [`${PROJECT}/.ralph/state.json`]: JSON.stringify(partialState({ agent: 'codex' })),
    })
    const result = finalizeState({
      projectRoot: PROJECT,
      fs: v,
      env: { RALPH_AGENT: '   ' },
    })
    // Whitespace-only => unset => claude default; the stale codex is replaced.
    expect(result.agent).toBe('claude')
  })
})
