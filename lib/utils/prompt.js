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

// #5: free-text sibling of `confirm` — same injection shape (readline
// createInterface over input/output), but resolves the trimmed answer verbatim
// instead of a yes/no boolean. Injectable so tests never touch real stdin.
export function promptValue(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output })
    rl.question(question, (answer) => {
      rl.close()
      resolve((answer || '').trim())
    })
  })
}
