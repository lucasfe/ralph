import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const RALPH_HOME = resolve(__dirname, '..')
export const TEMPLATES_DIR = join(RALPH_HOME, 'templates')

export function templatePath(name) {
  return join(TEMPLATES_DIR, name)
}

// How Ralph re-invokes Ralph. argv[1] is the path this process was started from, so a
// global install, an `npx ralph` and a linked dev checkout each hand out the binary
// they ARE rather than whatever `ralph` happens to resolve to on the PATH of some
// other shell — which matters because both callers write this path somewhere it will
// be run later and unattended: `ralph schedule` into a launchd plist / crontab line,
// and `ralph start` into the tmux window that runs `ralph digest --loop` (#62).
// Shared so those two can never disagree about which Ralph that is; `'ralph'` is the
// last resort for an embedder that has no argv[1] at all.
export function defaultRalphBinary() {
  return process.argv[1] || 'ralph'
}
