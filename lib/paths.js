import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const RALPH_HOME = resolve(__dirname, '..')
export const TEMPLATES_DIR = join(RALPH_HOME, 'templates')

export function templatePath(name) {
  return join(TEMPLATES_DIR, name)
}
