import { describe, it, expect } from 'vitest'
import { compareSemver, isValidSemver } from './update-check.js'

describe('isValidSemver', () => {
  it('accepts standard releases', () => {
    expect(isValidSemver('0.1.0')).toBe(true)
    expect(isValidSemver('1.2.3')).toBe(true)
    expect(isValidSemver('10.20.30')).toBe(true)
  })

  it('accepts pre-releases and build metadata', () => {
    expect(isValidSemver('0.1.0-alpha.0')).toBe(true)
    expect(isValidSemver('1.0.0-rc.1')).toBe(true)
    expect(isValidSemver('1.0.0+build.5')).toBe(true)
  })

  it('rejects invalid input', () => {
    expect(isValidSemver('')).toBe(false)
    expect(isValidSemver('not-a-version')).toBe(false)
    expect(isValidSemver('1.2')).toBe(false)
    expect(isValidSemver(null)).toBe(false)
    expect(isValidSemver(undefined)).toBe(false)
  })
})

describe('compareSemver', () => {
  it('orders by major/minor/patch', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1)
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1)
    expect(compareSemver('0.1.1', '0.1.0')).toBe(1)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('treats releases as greater than pre-releases', () => {
    expect(compareSemver('0.1.0', '0.1.0-alpha.0')).toBe(1)
    expect(compareSemver('0.1.0-alpha.0', '0.1.0')).toBe(-1)
  })

  it('compares pre-releases lexicographically when numeric parts equal', () => {
    expect(compareSemver('0.1.0-alpha.1', '0.1.0-alpha.0')).toBe(1)
    expect(compareSemver('0.1.0-alpha.0', '0.1.0-beta.0')).toBe(-1)
  })
})
