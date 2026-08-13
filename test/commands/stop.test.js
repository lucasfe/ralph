import { describe, it, expect } from 'vitest'
import { stopCommand, StopAbort } from '../../lib/commands/stop.js'
import { sessionNameFor } from '../../lib/lock.js'

// Per-project session name used across the suite. stopCommand derives the
// session name from cwd via sessionNameFor; tests default to cwd '/repo'.
const SESSION = sessionNameFor('/repo')

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
  const calls = []
  const exec = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    if (handlers[key]) return handlers[key]
    throw new Error(`unexpected exec: ${key}`)
  }
  exec.calls = calls
  return exec
}

describe('stopCommand', () => {
  it('reports no session when tmux has-session fails', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: '/repo', stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: false })
    expect(stdout.output()).toContain(`No tmux session '${SESSION}'`)
  })

  it('kills the session when present', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: '/repo', stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(stdout.output()).toContain(`tmux session '${SESSION}' terminated`)
  })

  it('throws StopAbort when kill-session fails', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: 'boom' },
    })
    await expect(
      stopCommand({ cwd: '/repo', stdout, stderr, exec }),
    ).rejects.toBeInstanceOf(StopAbort)
    expect(stderr.output()).toContain('Failed to kill tmux session')
  })

  it('targets the cwd-derived session name, not the literal "ralph"', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    await stopCommand({ cwd: '/repo', stdout, stderr, exec })
    expect(exec.calls).toContain(`tmux has-session -t ${SESSION}`)
    expect(exec.calls).toContain(`tmux kill-session -t ${SESSION}`)
    expect(exec.calls.some((c) => c === 'tmux has-session -t ralph')).toBe(false)
    expect(exec.calls.some((c) => c === 'tmux kill-session -t ralph')).toBe(false)
  })

  it('stops only the current project, leaving other projects untouched', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const otherSession = sessionNameFor('/other-project')
    const workSession = sessionNameFor('/work')
    const exec = makeExec({
      [`tmux has-session -t ${workSession}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${workSession}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd: '/work', stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(stdout.output()).toContain(`tmux session '${workSession}' terminated`)
    // Never touches another project's session.
    expect(exec.calls.some((c) => c.includes(otherSession))).toBe(false)
  })

  // --- QA: edge cases & adversarial scenarios -------------------------------

  it('uses a valid, consistent session name for a cwd with spaces/parens', async () => {
    const cwd = '/Users/x/my repo (1)'
    const session = sessionNameFor(cwd)
    // sessionNameFor must sanitize away spaces/parens so the name is a safe
    // tmux target (no characters tmux would misinterpret).
    expect(session).toMatch(/^[A-Za-z0-9_-]+$/)
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await stopCommand({ cwd, stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    // Both calls target the identical derived name (no has/kill mismatch).
    expect(exec.calls).toEqual([
      `tmux has-session -t ${session}`,
      `tmux kill-session -t ${session}`,
    ])
  })

  it('uses the same derived name for has-session and kill-session within one call', async () => {
    // Adversarial: a mismatch between the two would mean checking one session
    // and killing another. Assert internal consistency by capturing the raw
    // session targets passed to exec rather than precomputing them.
    const cwd = '/some/deep/nested/project'
    const stdout = makeStream()
    const stderr = makeStream()
    const targets = []
    const exec = async (cmd, args) => {
      // args = ['has-session'|'kill-session', '-t', <session>]
      targets.push({ sub: args[0], session: args[2] })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await stopCommand({ cwd, stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(targets).toHaveLength(2)
    expect(targets[0].sub).toBe('has-session')
    expect(targets[1].sub).toBe('kill-session')
    expect(targets[0].session).toBe(targets[1].session)
    expect(targets[0].session).toBe(sessionNameFor(cwd))
  })

  it('trailing-slash and clean cwd are internally consistent (each call self-consistent)', async () => {
    // NOTE: in the current impl sessionNameFor('/repo') !== sessionNameFor('/repo/')
    // because the hash is over the full (unnormalized) path. This test does not
    // assert they are equal; it asserts each call uses ONE name consistently.
    for (const cwd of ['/repo', '/repo/']) {
      const session = sessionNameFor(cwd)
      const stdout = makeStream()
      const stderr = makeStream()
      const exec = makeExec({
        [`tmux has-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
        [`tmux kill-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
      })
      const result = await stopCommand({ cwd, stdout, stderr, exec })
      expect(result).toEqual({ exitCode: 0, killed: true })
      expect(exec.calls).toEqual([
        `tmux has-session -t ${session}`,
        `tmux kill-session -t ${session}`,
      ])
    }
  })

  it('defaults cwd to process.cwd() when omitted', async () => {
    const session = sessionNameFor(process.cwd())
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${session}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    // cwd intentionally omitted -> should resolve via process.cwd().
    const result = await stopCommand({ stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: true })
    expect(exec.calls).toContain(`tmux has-session -t ${session}`)
    expect(exec.calls).toContain(`tmux kill-session -t ${session}`)
  })

  it('treats a non-zero, non-1 has-session exit (e.g. 127 / tmux missing) as no session', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: {
        exitCode: 127,
        stdout: '',
        stderr: 'tmux: command not found',
      },
      // Deliberately NO kill-session handler: makeExec throws on unexpected
      // calls, so if stopCommand attempted a kill this test would error out.
    })
    const result = await stopCommand({ cwd: '/repo', stdout, stderr, exec })
    expect(result).toEqual({ exitCode: 0, killed: false })
    expect(exec.calls).toEqual([`tmux has-session -t ${SESSION}`])
    expect(exec.calls.some((c) => c.startsWith('tmux kill-session'))).toBe(false)
    expect(stdout.output()).toContain(`No tmux session '${SESSION}'`)
  })

  it('StopAbort on kill failure carries exitCode 1 and reports the stderr', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: {
        exitCode: 1,
        stdout: '',
        stderr: '  permission denied  ',
      },
    })
    let caught
    try {
      await stopCommand({ cwd: '/repo', stdout, stderr, exec })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StopAbort)
    expect(caught.exitCode).toBe(1)
    // stderr surfaced to the user (trimmed).
    expect(stderr.output()).toContain('permission denied')
    expect(stderr.output()).toContain('Failed to kill tmux session')
    // No success message emitted.
    expect(stdout.output()).not.toContain('terminated')
  })

  it('does not emit a kill message when kill-session fails', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
      [`tmux kill-session -t ${SESSION}`]: { exitCode: 2, stdout: '', stderr: '' },
    })
    await expect(
      stopCommand({ cwd: '/repo', stdout, stderr, exec }),
    ).rejects.toBeInstanceOf(StopAbort)
    // Even with empty stderr, the failure message is still printed.
    expect(stderr.output()).toContain('Failed to kill tmux session')
  })
})
