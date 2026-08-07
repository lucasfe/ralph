import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { initCommand, InitAbort } from './commands/init.js'

// QA augmentation for #565. The dev's init.test.js locks the source-selection
// happy paths. These attack idempotency (re-running init must not clobber real
// tasks) and the flag/prompt precedence guards under adversarial input.

const PROJECT = '/project'

function makeStream() {
  const chunks = []
  return { write: (s) => (chunks.push(s), true), output: () => chunks.join('') }
}

function makeExec() {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    if (key === 'git rev-parse --show-toplevel') return { exitCode: 0, stdout: PROJECT, stderr: '' }
    if (key === 'git symbolic-ref refs/remotes/origin/HEAD')
      return { exitCode: 0, stdout: 'refs/remotes/origin/main', stderr: '' }
    if (key === 'git branch -a') return { exitCode: 0, stdout: '* main\n', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

function newVol() {
  const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
  return vol
}

function run(vol, opts = {}) {
  return initCommand({
    cwd: PROJECT,
    stdout: makeStream(),
    stderr: opts.stderr ?? makeStream(),
    exec: makeExec(),
    fs: vol,
    ...opts,
  })
}

describe('initCommand — folder scaffold idempotency (#565 QA)', () => {
  it('running init --source folder twice does not crash and keeps existing tasks', async () => {
    const vol = newVol()
    await run(vol, { source: 'folder' })
    // Simulate a real queued task the author added after the first init.
    vol.writeFileSync(`${PROJECT}/.ralph/tasks/afk/todo/001-real-task.md`, 'do the thing')

    // Second init must not throw and must not clobber the task file.
    const result = await run(vol, { source: 'folder' })
    expect(result.exitCode).toBe(0)
    expect(vol.existsSync(`${PROJECT}/.ralph/tasks/afk/todo/001-real-task.md`)).toBe(true)
    expect(vol.readFileSync(`${PROJECT}/.ralph/tasks/afk/todo/001-real-task.md`, 'utf8')).toBe(
      'do the thing',
    )
  })

  it('all five lane dirs exist after scaffold', async () => {
    const vol = newVol()
    await run(vol, { source: 'folder' })
    for (const d of [
      'afk/todo',
      'afk/in-progress',
      'afk/done',
      'afk/failed',
      'hitl/todo',
    ]) {
      expect(vol.existsSync(`${PROJECT}/.ralph/tasks/${d}`)).toBe(true)
    }
  })

  it('a whitespace-only --source is not a typo — falls through to the github default', async () => {
    const vol = newVol()
    const result = await run(vol, { source: '   ', isTTY: false })
    expect(result.source).toBe('github')
    expect(vol.existsSync(`${PROJECT}/.ralph/tasks`)).toBe(false)
  })

  it('rejects an invalid --source with a nonzero abort BEFORE any file writes', async () => {
    const vol = newVol()
    const stderr = makeStream()
    let caught
    try {
      await run(vol, { source: 'GitLab', stderr })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InitAbort)
    expect(caught.exitCode).toBe(1)
    // Nothing was written — the guard runs before writeConfig.
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
    expect(vol.existsSync(`${PROJECT}/.ralph/tasks`)).toBe(false)
  })

  it('--source folder beats a would-be interactive prompt (flag wins, prompt not called)', async () => {
    const vol = newVol()
    let prompted = false
    const result = await run(vol, {
      source: 'folder',
      isTTY: true,
      promptAgent: async () => 'claude',
      promptSource: async () => {
        prompted = true
        return 'github'
      },
    })
    expect(prompted).toBe(false)
    expect(result.source).toBe('folder')
  })
})
