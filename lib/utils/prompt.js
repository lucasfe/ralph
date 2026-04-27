import { createInterface } from 'node:readline'

export function confirm(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output })
    rl.question(question, (answer) => {
      rl.close()
      const a = (answer || '').trim().toLowerCase()
      resolve(a === 'y')
    })
  })
}
