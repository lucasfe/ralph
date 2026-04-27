import { describe, it, expect, vi } from 'vitest'
import { interpolate } from './interpolate.js'

function fakeStderr() {
  const calls = []
  return {
    write: (msg) => {
      calls.push(msg)
      return true
    },
    calls,
  }
}

describe('interpolate', () => {
  it('replaces a single {{KEY}} with vars[KEY]', () => {
    expect(interpolate('hello {{NAME}}', { NAME: 'world' })).toBe('hello world')
  })

  it('replaces multiple distinct placeholders', () => {
    const result = interpolate('{{A}}+{{B}}={{C}}', { A: '1', B: '2', C: '3' })
    expect(result).toBe('1+2=3')
  })

  it('replaces every occurrence of a repeated placeholder', () => {
    expect(interpolate('{{X}} {{X}} {{X}}', { X: 'go' })).toBe('go go go')
  })

  it('inserts values verbatim when they contain regex-significant characters', () => {
    const vars = {
      DOLLAR: '$1',
      DOLLAR_AMP: '$&',
      BACK: '\\back',
      AMP: 'a&b',
      NESTED: '{{INNER}}',
    }
    expect(
      interpolate(
        '{{DOLLAR}}|{{DOLLAR_AMP}}|{{BACK}}|{{AMP}}|{{NESTED}}',
        vars,
      ),
    ).toBe('$1|$&|\\back|a&b|{{INNER}}')
  })

  it('does not re-interpolate values that themselves contain placeholders', () => {
    const result = interpolate('{{A}}', { A: '{{A}}', B: 'should-not-appear' })
    expect(result).toBe('{{A}}')
  })

  it('leaves unknown placeholders intact and warns to stderr', () => {
    const stderr = fakeStderr()
    const result = interpolate(
      'known={{KNOWN}} unknown={{MISSING}}',
      { KNOWN: 'ok' },
      { stderr },
    )
    expect(result).toBe('known=ok unknown={{MISSING}}')
    expect(stderr.calls).toHaveLength(1)
    expect(stderr.calls[0]).toContain('MISSING')
  })

  it('warns at most once per unknown placeholder, even if it repeats', () => {
    const stderr = fakeStderr()
    interpolate('{{A}} {{A}} {{B}} {{A}}', {}, { stderr })
    expect(stderr.calls).toHaveLength(2)
    expect(stderr.calls.some((m) => m.includes('A'))).toBe(true)
    expect(stderr.calls.some((m) => m.includes('B'))).toBe(true)
  })

  it('does not write to stderr when every placeholder is known', () => {
    const stderr = fakeStderr()
    interpolate('{{X}}', { X: 'y' }, { stderr })
    expect(stderr.calls).toHaveLength(0)
  })

  it('treats null/undefined vars as empty string', () => {
    expect(interpolate('a={{A}};b={{B}}', { A: null, B: undefined })).toBe('a=;b=')
  })

  it('coerces non-string values to strings', () => {
    expect(interpolate('n={{N}};b={{B}}', { N: 42, B: true })).toBe('n=42;b=true')
  })

  it('returns the empty template unchanged', () => {
    expect(interpolate('', { X: 'y' })).toBe('')
  })

  it('throws TypeError when template is not a string', () => {
    expect(() => interpolate(undefined, {})).toThrow(TypeError)
    expect(() => interpolate(null, {})).toThrow(TypeError)
    expect(() => interpolate(42, {})).toThrow(TypeError)
    expect(() => interpolate({}, {})).toThrow(TypeError)
  })

  it('ignores malformed placeholders that do not match {{IDENT}}', () => {
    const stderr = fakeStderr()
    const template = '{{ X }} {X} {{X plain {{1BAD}}'
    expect(interpolate(template, { X: 'y' }, { stderr })).toBe(template)
    expect(stderr.calls).toHaveLength(0)
  })

  it('uses the default stderr when no options are provided', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      interpolate('{{UNKNOWN_DEFAULT_STDERR}}', {})
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
