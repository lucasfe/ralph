import { delimiter, join } from 'node:path'
import { accessSync, constants } from 'node:fs'

export function commandExists(cmd, env = process.env) {
  const PATH = env.PATH || env.Path || ''
  const exts = process.platform === 'win32' ? (env.PATHEXT || '').split(';') : ['']
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext)
      try {
        accessSync(candidate, constants.X_OK)
        return true
      } catch {
        // try next
      }
    }
  }
  return false
}
