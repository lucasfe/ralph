import { describe, it, expect } from 'vitest'
import { stopCommand, StopAbort } from './stop.js'
import { sessionNameFor } from '../lock.js'

// #6 QA augmentation — stop.js was fully translated. These probe interpolation
// preservation the dev's suite does not: the per-project session name must be
// interpolated into every English line, and the kill-failure message must carry
// the TRIMMED tmux stderr (adversarial: padded/multiline stderr).

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

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    return handlers[key] ?? { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

describe('QA stop — English lines interpolate the derived session name (#6)', () => {
  const CWD = '/Users/me/repos/some.weird repo'
  const SESSION = sessionNameFor(CWD)

  it('"No tmux session" notice embeds the exact derived session name', async () => {
    const stdout = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: CWD, stdout, stderr: makeStream(), exec })
    expect(result).toEqual({ exitCode: 0, killed: false })
    expect(stdout.output()).toContain(`No tmux session '${SESSION}' running.`)
    expect(stdout.output()).not.toMatch(/Nenhuma|sess[aã]o/i)
  })

  it('success line embeds the derived session name in the English "terminated" message', async () => {
    const stdout = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: CWD, stdout, stderr: makeStream(), exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(stdout.output()).toContain(`tmux session '${SESSION}' terminated.`)
    expect(stdout.output()).not.toMatch(/encerrada/)
  })

  it('kill-failure surfaces the TRIMMED tmux stderr in the English failure line', async () => {
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: {
        exitCode: 1,
        stdout: '',
        stderr: '   server not running on /tmp/tmux\n\n',
      },
    })
    await expect(
      stopCommand({ cwd: CWD, stdout: makeStream(), stderr, exec }),
    ).rejects.toBeInstanceOf(StopAbort)
    expect(stderr.output()).toContain('❌ Failed to kill tmux session: server not running on /tmp/tmux')
    // trailing whitespace/newlines were trimmed off the interpolated value.
    expect(stderr.output()).not.toMatch(/tmux\n\n/)
    expect(stderr.output()).not.toMatch(/Falha ao matar/)
  })
})
