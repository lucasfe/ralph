import { describe, it, expect } from 'vitest'
import { stopCommand, StopAbort } from '../../lib/commands/stop.js'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
  }
}

function makeExec(handlers) {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    if (handlers[key]) return handlers[key]
    throw new Error(`unexpected exec: ${key}`)
  }
}

describe('stopCommand', () => {
  it('reports no session when tmux has-session fails', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 1, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: false })
    expect(stdout.output()).toContain("Nenhuma sessão tmux 'ralph'")
  })

  it('kills the session when present', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 0, stdout: '', stderr: '' },
      'tmux kill-session -t ralph': { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(stdout.output()).toContain("Sessão tmux 'ralph' encerrada")
  })

  it('throws StopAbort when kill-session fails', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      'tmux has-session -t ralph': { exitCode: 0, stdout: '', stderr: '' },
      'tmux kill-session -t ralph': { exitCode: 1, stdout: '', stderr: 'boom' },
    })
    await expect(stopCommand({ stdout, stderr, exec })).rejects.toBeInstanceOf(StopAbort)
    expect(stderr.output()).toContain('Falha ao matar sessão tmux')
  })
})
