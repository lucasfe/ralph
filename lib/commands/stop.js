import { execa } from 'execa'

const TMUX_SESSION = 'ralph'

class StopAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export async function stopCommand({
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')
  const err = (msg) => stderr.write(msg + '\n')

  const has = await exec('tmux', ['has-session', '-t', TMUX_SESSION], { reject: false })
  if (has.exitCode !== 0) {
    out(`ℹ️  Nenhuma sessão tmux '${TMUX_SESSION}' em execução.`)
    return { exitCode: 0, killed: false }
  }

  const result = await exec('tmux', ['kill-session', '-t', TMUX_SESSION], { reject: false })
  if (result.exitCode !== 0) {
    err(`❌ Falha ao matar sessão tmux: ${(result.stderr || '').trim()}`)
    throw new StopAbort('tmux kill-session failed', 1)
  }
  out(`✅ Sessão tmux '${TMUX_SESSION}' encerrada.`)
  return { exitCode: 0, killed: true }
}

export { StopAbort }
