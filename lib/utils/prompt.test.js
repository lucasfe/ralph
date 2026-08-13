import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { confirm, promptValue } from './prompt.js'

// #5: promptValue mirrors the confirm helper's shape/signature exactly — it is
// built on node:readline createInterface and is fully injectable (input/output)
// so tests never touch the real stdin/stdout.

function answer(text) {
  const input = new PassThrough()
  const output = new PassThrough()
  const written = []
  output.on('data', (c) => written.push(c.toString()))
  // Deliver the answer on the next tick so createInterface is listening.
  setImmediate(() => input.write(text))
  return { input, output, written }
}

describe('promptValue — injectable trimmed reader', () => {
  it('resolves the trimmed answer', async () => {
    const { input, output } = answer('  +15551234567  \n')
    const value = await promptValue('Phone: ', { input, output })
    expect(value).toBe('+15551234567')
  })

  it('resolves an empty string for a blank line', async () => {
    const { input, output } = answer('   \n')
    const value = await promptValue('Key: ', { input, output })
    expect(value).toBe('')
  })

  it('writes the question prompt to the injected output', async () => {
    const { input, output, written } = answer('x\n')
    await promptValue('CallMeBot key: ', { input, output })
    expect(written.join('')).toContain('CallMeBot key: ')
  })
})

describe('confirm — still works alongside promptValue', () => {
  it('maps "y" to true', async () => {
    const { input, output } = answer('y\n')
    expect(await confirm('ok? ', { input, output })).toBe(true)
  })

  it('maps blank to false', async () => {
    const { input, output } = answer('\n')
    expect(await confirm('ok? ', { input, output })).toBe(false)
  })
})
