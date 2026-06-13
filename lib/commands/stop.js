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
    out(`ℹ️  Nenhuma sessão tmux '${session}' em execução.`)
    return { exitCode: 0, killed: false }
  }

  const result = await exec('tmux', ['kill-session', '-t', session], { reject: false })
  if (result.exitCode !== 0) {
    err(`❌ Falha ao matar sessão tmux: ${(result.stderr || '').trim()}`)
    throw new StopAbort('tmux kill-session failed', 1)
  }
  out(`✅ Sessão tmux '${session}' encerrada.`)
  return { exitCode: 0, killed: true }
}

export { StopAbort }
