import { execa } from 'execa'
import { sessionNameFor } from '../lock.js'

class StopAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export async function stopCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')
  const err = (msg) => stderr.write(msg + '\n')

  // Per-project tmux session name so `stop` only touches THIS repo's loop,
  // leaving other projects' running loops untouched.
  const session = sessionNameFor(cwd)

  const has = await exec('tmux', ['has-session', '-t', session], { reject: false })
  if (has.exitCode !== 0) {
    out(`ℹ️  No tmux session '${session}' running.`)
    return { exitCode: 0, killed: false }
  }

  const result = await exec('tmux', ['kill-session', '-t', session], { reject: false })
  if (result.exitCode !== 0) {
    err(`❌ Failed to kill tmux session: ${(result.stderr || '').trim()}`)
    throw new StopAbort('tmux kill-session failed', 1)
  }
  out(`✅ tmux session '${session}' terminated.`)
  return { exitCode: 0, killed: true }
}

export { StopAbort }
