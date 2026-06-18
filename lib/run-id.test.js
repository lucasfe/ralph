import { describe, it, expect } from 'vitest'
import { buildRunId } from './run-id.js'

describe('buildRunId', () => {
  it('joins session name and epoch seconds with a hyphen', () => {
    expect(buildRunId('ralph-agenthub-1a2b3c4d', 1718000000)).toBe(
      'ralph-agenthub-1a2b3c4d-1718000000',
    )
  })

  it('pins the exact <session>-<epoch> format', () => {
    expect(buildRunId('ralph', 0)).toBe('ralph-0')
    expect(buildRunId('s', 42)).toBe('s-42')
  })

  // QA augmentation: edge cases.
  it('coerces a numeric epoch and a string epoch to the same shape', () => {
    expect(buildRunId('ralph', 1718000000)).toBe('ralph-1718000000')
    expect(buildRunId('ralph', '1718000000')).toBe('ralph-1718000000')
  })

  it('preserves hyphens in the session name (last hyphen separates the epoch)', () => {
    const id = buildRunId('ralph-agent-hub', 1718000000)
    expect(id).toBe('ralph-agent-hub-1718000000')
    // round-trip shape: epoch is the segment after the final hyphen
    const idx = id.lastIndexOf('-')
    expect(id.slice(0, idx)).toBe('ralph-agent-hub')
    expect(id.slice(idx + 1)).toBe('1718000000')
  })

  it('handles an empty session name => leading hyphen', () => {
    expect(buildRunId('', 1718000000)).toBe('-1718000000')
  })
})
