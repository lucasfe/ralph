import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { initCommand, InitAbort } from './commands/init.js'

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
    expect(cfg).toContain('RALPH_HEAVY_TIER=0')
  })
})

describe('initCommand — RALPH_HEAVY_TIER default (QA hardening)', () => {
  it('ships RALPH_HEAVY_TIER=0 on a custom (npm) stack too — the literal survives interpolation unchanged', async () => {
    const { vol, run } = setup({
      files: { [`${PROJECT}/package.json`]: '{}' },
    })
    const result = await run()
    expect(result.stack).toBe('npm')
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    // The line is a literal default, not a {{...}} placeholder, so it must
    // pass through init's interpolation pass verbatim regardless of stack.
    expect(cfg).toContain('RALPH_HEAVY_TIER=0')
    expect(occurrences(cfg, 'RALPH_HEAVY_TIER=0')).toBe(1)
    expect(cfg).not.toContain('{{RALPH_HEAVY_TIER}}')
  })

  it('does not clobber a user-tweaked RALPH_HEAVY_TIER on re-run', async () => {
    const { vol, run } = setup()
    await run()
    const original = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    const tweaked = original.replace('RALPH_HEAVY_TIER=0', 'RALPH_HEAVY_TIER=1')
    expect(tweaked).toContain('RALPH_HEAVY_TIER=1')
    vol.writeFileSync(`${PROJECT}/ralph.config.sh`, tweaked)

    const stdout2 = makeStream()
    await initCommand({
      cwd: PROJECT,
      stdout: stdout2,
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
    })
    // Re-running init must not overwrite the user's tweaked value.
    expect(vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')).toBe(tweaked)
    expect(stdout2.output()).toContain('ralph.config.sh already exists')
  })
})

describe('initCommand — agent selection (#554)', () => {
  it('defaults to RALPH_AGENT="claude" when no flag and not a TTY', async () => {
    const { vol, run } = setup()
    await run()
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="claude"')
    // The Codex model knob ships commented-out by default.
    expect(cfg).toContain('# RALPH_CODEX_MODEL=')
  })

  it('writes RALPH_AGENT="codex" when --agent codex is passed', async () => {
    const { vol } = setup()
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      agent: 'codex',
    })
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="codex"')
  })

  it('rejects an invalid --agent flag with a clear message and writes nothing (#560)', async () => {
    const { vol } = setup()
    const stderr = makeStream()
    let caught
    try {
      await initCommand({
        cwd: PROJECT,
        stdout: makeStream(),
        stderr,
        exec: makeExec(defaultGitHandlers()),
        fs: vol,
        agent: 'codx',
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InitAbort)
    expect(caught.exitCode).toBeGreaterThan(0)
    // Error names the bad value and lists the valid agents.
    const err = stderr.output()
    expect(err).toContain("codx")
    expect(err).toContain('claude')
    expect(err).toContain('codex')
    // Aborts BEFORE any file writes.
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
  })

  it('writes RALPH_AGENT="claude" when --agent claude is passed (no prompt)', async () => {
    const { vol } = setup()
    let asked = false
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      isTTY: true,
      agent: 'claude',
      promptAgent: async () => {
        asked = true
        return 'codex'
      },
    })
    expect(asked).toBe(false)
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="claude"')
  })

  it('written config carries the RALPH_AGENT explanatory comments from the template', async () => {
    const { vol, run } = setup()
    await run()
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('Coding agent Ralph drives')
    expect(cfg).toContain('# RALPH_CODEX_MODEL=')
  })

  it('default prompt is built on the injected confirm helper: true => codex', async () => {
    const { vol } = setup()
    let askedQuestion = null
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      isTTY: true,
      ask: (question) => {
        askedQuestion = question
        return Promise.resolve(true)
      },
    })
    expect(askedQuestion).toBeTruthy()
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="codex"')
  })

  it('default prompt is built on the injected confirm helper: false => claude', async () => {
    const { vol } = setup()
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      isTTY: true,
      ask: () => Promise.resolve(false),
    })
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="claude"')
  })

  it('prompts for the agent when interactive and no flag is given', async () => {
    const { vol } = setup()
    let asked = false
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      isTTY: true,
      promptAgent: async () => {
        asked = true
        return 'codex'
      },
    })
    expect(asked).toBe(true)
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="codex"')
  })

  it('does not prompt when a flag is given even if interactive', async () => {
    const { vol } = setup()
    let asked = false
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      isTTY: true,
      agent: 'codex',
      promptAgent: async () => {
        asked = true
        return 'claude'
      },
    })
    expect(asked).toBe(false)
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="codex"')
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#554): adversarial --agent handling. init runs the choice
// through resolveAgent, so a mixed-case value is normalized and a typo NEVER
// writes garbage into the sourced config; the written line is valid bash.
// ---------------------------------------------------------------------------

describe('QA: initCommand — agent selection (adversarial #554)', () => {
  async function runWith(overrides) {
    const { vol } = setup()
    const stderr = makeStream()
    const result = await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr,
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      ...overrides,
    })
    return {
      cfg: vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8'),
      stderr: stderr.output(),
      result,
    }
  }

  it('normalizes --agent CODEX (mixed/upper case) to lowercase codex', async () => {
    const { cfg, result } = await runWith({ agent: 'CODEX' })
    expect(cfg).toContain('RALPH_AGENT="codex"')
    expect(result.agent).toBe('codex')
  })

  it('normalizes --agent Codex to codex', async () => {
    const { cfg } = await runWith({ agent: 'Codex' })
    expect(cfg).toContain('RALPH_AGENT="codex"')
  })

  it('an INVALID --agent flag is rejected (never written) with a clear message (#560)', async () => {
    const { vol } = setup()
    const stderr = makeStream()
    let caught
    try {
      await initCommand({
        cwd: PROJECT,
        stdout: makeStream(),
        stderr,
        exec: makeExec(defaultGitHandlers()),
        fs: vol,
        agent: 'gpt-9000',
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InitAbort)
    expect(caught.exitCode).toBeGreaterThan(0)
    const err = stderr.output()
    expect(err).toContain('gpt-9000')
    expect(err).toContain('claude')
    expect(err).toContain('codex')
    // Never wrote the garbage value into a config.
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
  })

  it('the written RALPH_AGENT line is a single, valid, quoted bash assignment', async () => {
    const { cfg } = await runWith({ agent: 'codex' })
    // Exactly one uncommented RALPH_AGENT= assignment, double-quoted, sourceable.
    const assignmentLines = cfg
      .split('\n')
      .filter((l) => /^\s*RALPH_AGENT\s*=/.test(l))
    expect(assignmentLines).toHaveLength(1)
    expect(assignmentLines[0]).toMatch(/^RALPH_AGENT="(claude|codex)"$/)
  })

  it('non-TTY without a flag defaults to claude and does NOT call promptAgent', async () => {
    let asked = false
    const { cfg } = await runWith({
      isTTY: false,
      promptAgent: async () => {
        asked = true
        return 'codex'
      },
    })
    expect(asked).toBe(false)
    expect(cfg).toContain('RALPH_AGENT="claude"')
  })

  it('the value written for --agent codex round-trips through parseConfigAgent', async () => {
    const { parseConfigAgent } = await import('./read-config-agent.js')
    const { cfg } = await runWith({ agent: 'codex' })
    expect(parseConfigAgent(cfg)).toBe('codex')
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#560): early --agent flag REJECTION guard. A typo aborts
// hard BEFORE any git/exec calls and BEFORE any file write, but blank/empty/
// whitespace flags are NOT a typo — they fall through to the graceful default.
// Adversarial values (shell/newline injection) must be rejected, never written.
// ---------------------------------------------------------------------------

describe('QA: initCommand — early --agent rejection guard (#560)', () => {
  // Runs init recording every injected-exec call so we can prove the guard
  // fires BEFORE any git detection. Returns the volume, streams and exec.
  function harness(overrides = {}) {
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    const stdout = makeStream()
    const stderr = makeStream()
    const exec = makeExec(defaultGitHandlers())
    const run = () =>
      initCommand({
        cwd: PROJECT,
        stdout,
        stderr,
        exec,
        fs: vol,
        isTTY: false,
        ...overrides,
      })
    return { vol, stdout, stderr, exec, run }
  }

  const ALL_OUTPUTS = [
    `${PROJECT}/ralph.config.sh`,
    `${PROJECT}/PROMPT.md`,
    `${PROJECT}/.env.local.example`,
    `${PROJECT}/ralph-notify.sh.example`,
    `${PROJECT}/.claude/commands/ralph.md`,
    `${PROJECT}/.gitignore`,
  ]

  it('a whitespace-only flag is NOT rejected — it falls through to the claude default (no prompt when not TTY)', async () => {
    let asked = false
    const { vol, exec, run } = harness({
      agent: '   ',
      promptAgent: async () => {
        asked = true
        return 'codex'
      },
    })
    // Guard treats trim()==='' as "no flag": no throw, git detection runs.
    await expect(run()).resolves.toMatchObject({ agent: 'claude' })
    expect(asked).toBe(false)
    expect(exec.calls.length).toBeGreaterThan(0)
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="claude"')
  })

  it('an empty-string flag is NOT rejected — falls through to the claude default', async () => {
    const { vol, run } = harness({ agent: '' })
    await expect(run()).resolves.toMatchObject({ agent: 'claude' })
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="claude"')
  })

  it('a valid flag padded with whitespace ("  codex  ") is accepted and written with NO leaked whitespace in the bash assignment', async () => {
    const { vol, run } = harness({ agent: '  codex  ' })
    await run()
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    const assignmentLines = cfg
      .split('\n')
      .filter((l) => /^\s*RALPH_AGENT\s*=/.test(l))
    expect(assignmentLines).toHaveLength(1)
    // A leaked space (e.g. RALPH_AGENT=" codex ") would be invalid/misleading
    // bash once sourced; the value must be the bare, trimmed token.
    expect(assignmentLines[0]).toBe('RALPH_AGENT="codex"')
  })

  it('normalizes a valid uppercase flag ("CLAUDE") to lowercase claude, not rejected', async () => {
    const { vol, run } = harness({ agent: 'CLAUDE' })
    const result = await run()
    expect(result.agent).toBe('claude')
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="claude"')
  })

  it('rejecting an invalid flag writes NOTHING at all (every output file absent) and throws with exitCode === 1', async () => {
    const { vol, run } = harness({ agent: 'codx' })
    let caught
    try {
      await run()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InitAbort)
    // Exact nonzero code, not merely > 0 — a future refactor to exitCode 0 must fail here.
    expect(caught.exitCode).toBe(1)
    for (const p of ALL_OUTPUTS) {
      expect(vol.existsSync(p)).toBe(false)
    }
  })

  it('rejection happens BEFORE any git/exec call — the injected exec is never invoked', async () => {
    const { exec, run } = harness({ agent: 'not-an-agent' })
    await expect(run()).rejects.toBeInstanceOf(InitAbort)
    // Early exit: resolveProjectRoot / branch detection never ran.
    expect(exec.calls).toHaveLength(0)
  })

  it('a shell-injection value ("codex"; rm -rf /") is rejected, echoed verbatim, and never written', async () => {
    const evil = 'codex"; rm -rf /'
    const { vol, stderr, exec, run } = harness({ agent: evil })
    let caught
    try {
      await run()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InitAbort)
    expect(exec.calls).toHaveLength(0)
    // The raw (dangerous) value is surfaced to the user so the typo is visible,
    // but it never reaches a sourced config file.
    expect(stderr.output()).toContain(evil)
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
  })

  it('a newline-injection value ("claude\\ncodex") is rejected, not silently accepted as claude', async () => {
    const { vol, run } = harness({ agent: 'claude\ncodex' })
    await expect(run()).rejects.toBeInstanceOf(InitAbort)
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
  })

  it('the default confirm prompt asks the exact yes/no question and maps true => codex', async () => {
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    let askedQuestion = null
    let askedOpts = null
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      isTTY: true,
      // No promptAgent override: exercise the REAL defaultPromptAgent, which
      // must route through the injected `ask` (confirm) helper.
      ask: (question, opts) => {
        askedQuestion = question
        askedOpts = opts
        return Promise.resolve(true)
      },
    })
    // Lock the phrasing so a rename of the prompt is caught by CI.
    expect(askedQuestion).toBe('Use Codex instead of Claude Code? [y/N]: ')
    expect(askedOpts).toMatchObject({ output: expect.anything() })
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="codex"')
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
    const out = stdout.output()
    expect(out).toContain('PROMPT.md already exists')
    expect(out).toContain('--reset-prompt')
  })
})

const credentialsFile =
  'CALLMEBOT_KEY=secret-key\nWHATSAPP_PHONE=+1234567890\nRALPH_STARTUP_MESSAGE=hello\n'

describe('initCommand — protects user-authored files', () => {
  it('never writes or modifies an existing .env.local', async () => {
    const { vol, run } = setup({
      files: { [`${PROJECT}/.env.local`]: credentialsFile },
    })
    await run()
    expect(vol.readFileSync(`${PROJECT}/.env.local`, 'utf8')).toBe(
      credentialsFile,
    )
  })

  it('never creates .env.local from scratch', async () => {
    const { vol, run } = setup()
    await run()
    expect(vol.existsSync(`${PROJECT}/.env.local`)).toBe(false)
  })

  it('never overwrites an existing ralph-notify.sh hook script', async () => {
    const customHook =
      '#!/bin/bash\n# my custom slack hook\ncurl -X POST $SLACK_WEBHOOK ...\n'
    const { vol, run } = setup({
      files: { [`${PROJECT}/ralph-notify.sh`]: customHook },
    })
    await run()
    expect(vol.readFileSync(`${PROJECT}/ralph-notify.sh`, 'utf8')).toBe(
      customHook,
    )
  })

  it('never creates ralph-notify.sh (only the .example template)', async () => {
    const { vol, run } = setup()
    await run()
    expect(vol.existsSync(`${PROJECT}/ralph-notify.sh`)).toBe(false)
    expect(vol.existsSync(`${PROJECT}/ralph-notify.sh.example`)).toBe(true)
  })
})

describe('initCommand — --reset-prompt flag', () => {
  it('overwrites PROMPT.md with the package template when resetPrompt is true', async () => {
    const { vol } = setup({
      files: { [`${PROJECT}/PROMPT.md`]: '# my custom prompt' },
    })
    const stdout = makeStream()
    await initCommand({
      cwd: PROJECT,
      stdout,
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      resetPrompt: true,
    })
    const after = vol.readFileSync(`${PROJECT}/PROMPT.md`, 'utf8')
    expect(after).not.toBe('# my custom prompt')
    expect(after).toContain('Project context for Ralph')
    expect(stdout.output()).toContain('Reset PROMPT.md')
  })

  it('still emits the regular "Wrote" message when PROMPT.md is absent and resetPrompt is true', async () => {
    const { vol } = setup()
    const stdout = makeStream()
    await initCommand({
      cwd: PROJECT,
      stdout,
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      resetPrompt: true,
    })
    expect(stdout.output()).toContain('Wrote PROMPT.md')
    expect(stdout.output()).not.toContain('Reset PROMPT.md')
  })

  it('does not affect .env.local even when resetPrompt is true', async () => {
    const { vol } = setup({
      files: { [`${PROJECT}/.env.local`]: credentialsFile },
    })
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      resetPrompt: true,
    })
    expect(vol.readFileSync(`${PROJECT}/.env.local`, 'utf8')).toBe(
      credentialsFile,
    )
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
