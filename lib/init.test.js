import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { initCommand } from './commands/init.js'

const PROJECT = '/project'

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
    if (Object.prototype.hasOwnProperty.call(handlers, key)) {
      const v = handlers[key]
      return typeof v === 'function' ? v() : v
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
const fail = () => ({ exitCode: 1, stdout: '', stderr: '' })

function defaultGitHandlers({
  root = PROJECT,
  mainBranchRef = 'refs/remotes/origin/main',
  branches = ['* main', '  remotes/origin/HEAD -> origin/main', '  remotes/origin/main'],
} = {}) {
  return {
    'git rev-parse --show-toplevel': ok(root),
    'git symbolic-ref refs/remotes/origin/HEAD': ok(mainBranchRef),
    'git branch -a': ok(branches.join('\n')),
  }
}

function setup({ files = {}, exec, root = PROJECT } = {}) {
  const vol = Volume.fromJSON({ [`${root}/.keep`]: '' }, '/')
  for (const [k, v] of Object.entries(files)) {
    vol.mkdirSync(k.substring(0, k.lastIndexOf('/')), { recursive: true })
    vol.writeFileSync(k, v)
  }
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    vol,
    stdout,
    stderr,
    run: () =>
      initCommand({
        cwd: root,
        stdout,
        stderr,
        exec: exec ?? makeExec(defaultGitHandlers({ root })),
        fs: vol,
      }),
  }
}

describe('initCommand — empty dir', () => {
  it('writes every expected file when project is empty', async () => {
    const { vol, stdout, run } = setup()
    const result = await run()

    expect(result.exitCode).toBe(0)
    expect(result.stack).toBe('unknown')
    expect(result.mainBranch).toBe('main')
    expect(result.devBranch).toBe('main')
    expect(result.prTarget).toBe('main')

    const files = vol.toJSON()
    expect(files[`${PROJECT}/ralph.config.sh`]).toBeDefined()
    expect(files[`${PROJECT}/PROMPT.md`]).toBeDefined()
    expect(files[`${PROJECT}/.env.local.example`]).toBeDefined()
    expect(files[`${PROJECT}/ralph-notify.sh.example`]).toBeDefined()
    expect(files[`${PROJECT}/.claude/commands/ralph.md`]).toBeDefined()
    expect(files[`${PROJECT}/.gitignore`]).toBeDefined()

    const out = stdout.output()
    expect(out).toContain('Wrote ralph.config.sh')
    expect(out).toContain('Wrote PROMPT.md')
    expect(out).toContain('Wrote .env.local.example')
    expect(out).toContain('Wrote ralph-notify.sh.example')
    expect(out).toContain('Wrote .claude/commands/ralph.md')
    expect(out).toContain('Updated .gitignore')
  })

  it('emits the unknown-stack warning when no manifest is present', async () => {
    const { stdout, run } = setup()
    await run()
    const out = stdout.output()
    expect(out).toContain('No supported manifest detected')
    expect(out).toContain('Stack:        unknown')
  })

  it('writes empty INSTALL_CMD/TEST_CMD/LINT_CMD into ralph.config.sh on unknown stack', async () => {
    const { vol, run } = setup()
    await run()
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('INSTALL_CMD=""')
    expect(cfg).toContain('TEST_CMD=""')
    expect(cfg).toContain('LINT_CMD=""')
    expect(cfg).toContain('MERGE_STRATEGY="squash"')
    expect(cfg).toContain('AUTO_MERGE="true"')
    expect(cfg).toContain('MERGE_POLL_INTERVAL=30')
    expect(cfg).toContain('MERGE_POLL_MAX=40')
  })
})

describe('initCommand — stack autodetect', () => {
  it('writes detected npm commands when package.json is present', async () => {
    const { vol, stdout, run } = setup({
      files: { [`${PROJECT}/package.json`]: '{}' },
    })
    const result = await run()
    expect(result.stack).toBe('npm')

    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('INSTALL_CMD="npm ci"')
    expect(cfg).toContain('TEST_CMD="npm test"')
    expect(cfg).toContain('LINT_CMD="npm run lint"')

    const out = stdout.output()
    expect(out).toContain('Stack:        npm')
    expect(out).toContain('INSTALL_CMD:  npm ci')
    expect(out).toContain('TEST_CMD:     npm test')
    expect(out).toContain('LINT_CMD:     npm run lint')
  })
})

describe('initCommand — branch autodetect', () => {
  it('uses dev branch when origin/dev exists', async () => {
    const exec = makeExec(
      defaultGitHandlers({
        branches: [
          '* dev',
          '  main',
          '  remotes/origin/HEAD -> origin/main',
          '  remotes/origin/dev',
          '  remotes/origin/main',
        ],
      }),
    )
    const { vol, run } = setup({ exec })
    const result = await run()
    expect(result.devBranch).toBe('dev')
    expect(result.prTarget).toBe('dev')

    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('MAIN_BRANCH="main"')
    expect(cfg).toContain('DEV_BRANCH="dev"')
    expect(cfg).toContain('PR_TARGET="dev"')
  })

  it('falls back to develop when origin/dev is absent but origin/develop exists', async () => {
    const exec = makeExec(
      defaultGitHandlers({
        branches: [
          '  main',
          '  remotes/origin/HEAD -> origin/main',
          '  remotes/origin/main',
          '  remotes/origin/develop',
        ],
      }),
    )
    const { run } = setup({ exec })
    const result = await run()
    expect(result.devBranch).toBe('develop')
  })

  it('sets DEV_BRANCH equal to MAIN_BRANCH when neither origin/dev nor origin/develop exist', async () => {
    const exec = makeExec(
      defaultGitHandlers({
        branches: [
          '* main',
          '  remotes/origin/HEAD -> origin/main',
          '  remotes/origin/main',
        ],
      }),
    )
    const { vol, run } = setup({ exec })
    const result = await run()
    expect(result.mainBranch).toBe('main')
    expect(result.devBranch).toBe('main')

    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('MAIN_BRANCH="main"')
    expect(cfg).toContain('DEV_BRANCH="main"')
  })

  it('extracts MAIN_BRANCH from origin/HEAD symbolic ref (master)', async () => {
    const exec = makeExec(
      defaultGitHandlers({
        mainBranchRef: 'refs/remotes/origin/master',
        branches: ['* master', '  remotes/origin/HEAD -> origin/master', '  remotes/origin/master'],
      }),
    )
    const { run } = setup({ exec })
    const result = await run()
    expect(result.mainBranch).toBe('master')
    expect(result.devBranch).toBe('master')
  })

  it('falls back to "main" when origin/HEAD lookup fails', async () => {
    const exec = makeExec({
      'git rev-parse --show-toplevel': ok(PROJECT),
      'git symbolic-ref refs/remotes/origin/HEAD': fail(),
      'git branch -a': ok(''),
    })
    const { run } = setup({ exec })
    const result = await run()
    expect(result.mainBranch).toBe('main')
  })
})

describe('initCommand — slash command handling', () => {
  it('skips writing .claude/commands/ralph.md when it already exists', async () => {
    const existing = '# user-customized slash command\nDo not overwrite me.'
    const { vol, stdout, run } = setup({
      files: { [`${PROJECT}/.claude/commands/ralph.md`]: existing },
    })
    await run()
    const after = vol.readFileSync(`${PROJECT}/.claude/commands/ralph.md`, 'utf8')
    expect(after).toBe(existing)
    expect(stdout.output()).toContain(
      '.claude/commands/ralph.md already exists — skipping',
    )
  })
})

describe('initCommand — .gitignore idempotency', () => {
  it('appends ralph entries when .gitignore does not exist', async () => {
    const { vol, run } = setup()
    await run()
    const gi = vol.readFileSync(`${PROJECT}/.gitignore`, 'utf8')
    expect(gi).toContain('# Ralph')
    expect(gi).toContain('.ralph/')
    expect(gi).toContain('ralph-notify.sh')
    expect(gi).toContain('.env.local')
  })

  it('appends only missing lines when .gitignore already has some entries', async () => {
    const { vol, run } = setup({
      files: { [`${PROJECT}/.gitignore`]: 'node_modules\n.env.local\n' },
    })
    await run()
    const gi = vol.readFileSync(`${PROJECT}/.gitignore`, 'utf8')
    expect(gi).toContain('node_modules')
    expect(gi).toContain('.ralph/')
    expect(gi).toContain('ralph-notify.sh')
    expect(occurrences(gi, '.env.local')).toBe(1)
  })

  it('does nothing on a second run — no duplicate ralph lines', async () => {
    const { vol, run } = setup()
    await run()
    const after1 = vol.readFileSync(`${PROJECT}/.gitignore`, 'utf8')

    // Re-run with a fresh exec but same volume
    const stdout2 = makeStream()
    const stderr2 = makeStream()
    await initCommand({
      cwd: PROJECT,
      stdout: stdout2,
      stderr: stderr2,
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
    })
    const after2 = vol.readFileSync(`${PROJECT}/.gitignore`, 'utf8')

    expect(after2).toBe(after1)
    expect(occurrences(after2, '.ralph/')).toBe(1)
    expect(occurrences(after2, 'ralph-notify.sh')).toBe(1)
    expect(occurrences(after2, '.env.local')).toBe(1)
    expect(stdout2.output()).toContain('.gitignore already has Ralph entries')
  })

  it('does not overwrite ralph.config.sh on re-run', async () => {
    const { vol, run } = setup()
    await run()
    const original = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    const tweaked = original.replace('MERGE_POLL_MAX=40', 'MERGE_POLL_MAX=99')
    vol.writeFileSync(`${PROJECT}/ralph.config.sh`, tweaked)

    const stdout2 = makeStream()
    await initCommand({
      cwd: PROJECT,
      stdout: stdout2,
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
    })
    expect(vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')).toBe(tweaked)
    expect(stdout2.output()).toContain('ralph.config.sh already exists')
  })

  it('does not overwrite PROMPT.md on re-run', async () => {
    const { vol, run } = setup({
      files: { [`${PROJECT}/PROMPT.md`]: '# my custom prompt' },
    })
    const stdout = makeStream()
    await initCommand({
      cwd: PROJECT,
      stdout,
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
    })
    expect(vol.readFileSync(`${PROJECT}/PROMPT.md`, 'utf8')).toBe(
      '# my custom prompt',
    )
    expect(stdout.output()).toContain('PROMPT.md already exists')
  })
})

describe('initCommand — summary output', () => {
  it('prints the WhatsApp setup block with CallMeBot URL and env vars', async () => {
    const { stdout, run } = setup()
    await run()
    const out = stdout.output()
    expect(out).toContain('WhatsApp notifications')
    expect(out).toContain(
      'https://www.callmebot.com/blog/free-api-whatsapp-messages/',
    )
    expect(out).toContain('CALLMEBOT_KEY')
    expect(out).toContain('WHATSAPP_PHONE')
  })

  it('prints the three command vars and the three branch vars', async () => {
    const exec = makeExec(
      defaultGitHandlers({
        branches: ['* dev', '  remotes/origin/HEAD -> origin/main', '  remotes/origin/dev', '  remotes/origin/main'],
      }),
    )
    const { stdout, run } = setup({
      files: { [`${PROJECT}/package.json`]: '{}' },
      exec,
    })
    await run()
    const out = stdout.output()
    expect(out).toContain('INSTALL_CMD:  npm ci')
    expect(out).toContain('TEST_CMD:     npm test')
    expect(out).toContain('LINT_CMD:     npm run lint')
    expect(out).toContain('MAIN_BRANCH:  main')
    expect(out).toContain('DEV_BRANCH:   dev')
    expect(out).toContain('PR_TARGET:    dev')
  })
})

function occurrences(haystack, needle) {
  let count = 0
  let i = 0
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++
    i += needle.length
  }
  return count
}
