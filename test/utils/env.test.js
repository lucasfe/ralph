import { describe, it, expect } from 'vitest'
import { parseEnvFile } from '../../lib/utils/env.js'

describe('parseEnvFile', () => {
  it('parses simple key=value pairs', () => {
    const env = parseEnvFile('FOO=bar\nBAZ=qux')
    expect(env).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('ignores blank lines and comments', () => {
    const env = parseEnvFile('# comment\n\nFOO=bar\n# another\nBAZ=qux\n')
    expect(env).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('strips surrounding quotes', () => {
    const env = parseEnvFile('A="hello world"\nB=\'hi\'')
    expect(env).toEqual({ A: 'hello world', B: 'hi' })
  })

  it('strips export prefix', () => {
    const env = parseEnvFile('export FOO=bar')
    expect(env).toEqual({ FOO: 'bar' })
  })

  it('handles values containing equals', () => {
    const env = parseEnvFile('TOKEN=abc=def=ghi')
    expect(env).toEqual({ TOKEN: 'abc=def=ghi' })
  })
})
