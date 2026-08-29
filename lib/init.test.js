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
    // #16: the git-repo precondition guard runs `git rev-parse
    // --is-inside-work-tree` first; the happy path must report a work tree.
    'git rev-parse --is-inside-work-tree': ok('true'),
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
    // #62: the digest knobs. The interval ships EMPTY — disabled — so no repo that
    // never asked for narration starts paying a model for it; the model override
    // ships commented out, the way RALPH_CODEX_MODEL does.
    expect(cfg).toContain('RALPH_DIGEST_INTERVAL=""')
    expect(cfg).toContain('# RALPH_DIGEST_MODEL=')
  })
})

describe('initCommand — digest knobs in the config template (#62)', () => {
  it('ships the interval disabled and the model commented, on a custom stack too', async () => {
    const { vol, run } = setup({ files: { [`${PROJECT}/package.json`]: '{}' } })
    const result = await run()
    expect(result.stack).toBe('npm')
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    // Literal defaults, not {{...}} placeholders, so they must survive init's
    // interpolation pass verbatim whatever the stack is.
    expect(cfg).toContain('RALPH_DIGEST_INTERVAL=""')
    expect(occurrences(cfg, 'RALPH_DIGEST_INTERVAL=""')).toBe(1)
    expect(cfg).not.toContain('{{RALPH_DIGEST_INTERVAL}}')
    expect(cfg).not.toContain('{{RALPH_DIGEST_MODEL}}')
    // Commented out, i.e. NOT an active assignment of an empty model.
    expect(cfg).toContain('# RALPH_DIGEST_MODEL=')
    expect(cfg).not.toMatch(/^\s*RALPH_DIGEST_MODEL=/m)
  })

  it('explains what the interval buys and what turning it on starts', async () => {
    const { vol, run } = setup()
    await run()
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    // A knob whose default is "off" has to say what "on" does, or nobody finds it:
    // the second tmux window, the durations it accepts, and that 0/empty is off.
    expect(cfg).toMatch(/ralph digest/)
    expect(cfg).toMatch(/window/i)
    expect(cfg).toMatch(/30m/)
    expect(cfg).toMatch(/disable/i)
  })

  it('does not clobber a user-set digest interval on re-run', async () => {
    const { vol, run } = setup()
    await run()
    const original = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    const tweaked = original.replace('RALPH_DIGEST_INTERVAL=""', 'RALPH_DIGEST_INTERVAL="30m"')
    expect(tweaked).toContain('RALPH_DIGEST_INTERVAL="30m"')
    vol.writeFileSync(`${PROJECT}/ralph.config.sh`, tweaked)

    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
    })
    expect(vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')).toBe(tweaked)
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
      ask: async () => false,
      promptAgent: async () => {
        asked = true
        return 'codex'
      },
      promptSource: async () => 'github',
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
      // Return true for the Codex prompt; decline the WhatsApp gate (#5).
      ask: (question) => {
        askedQuestion = question
        return Promise.resolve(question.includes('Codex'))
      },
      promptSource: async () => 'github',
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
      promptSource: async () => 'github',
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
      ask: async () => false,
      promptAgent: async () => {
        asked = true
        return 'codex'
      },
      promptSource: async () => 'github',
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
      ask: async () => false,
      promptAgent: async () => {
        asked = true
        return 'claude'
      },
      promptSource: async () => 'github',
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
        // Capture only the Codex prompt; decline the WhatsApp gate (#5) so it
        // does not overwrite the captured question or read real stdin.
        if (question.includes('Codex')) {
          askedQuestion = question
          askedOpts = opts
          return Promise.resolve(true)
        }
        return Promise.resolve(false)
      },
      promptSource: async () => 'github',
    })
    // Lock the phrasing so a rename of the prompt is caught by CI.
    expect(askedQuestion).toBe('Use Codex instead of Claude Code? [y/N]: ')
    expect(askedOpts).toMatchObject({ output: expect.anything() })
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('RALPH_AGENT="codex"')
  })
})

// ---------------------------------------------------------------------------
// #16: git-repo precondition guard. `ralph init` must refuse to run outside a
// git work tree — aborting hard with InitAbort(exitCode 1) BEFORE any
// interactive prompt or file write, rather than silently scaffolding into a
// non-repo (the old resolveProjectRoot "just use cwd" fallback). Inside a repo
// (including a subdirectory) it must behave exactly as before.
// ---------------------------------------------------------------------------

describe('QA: initCommand — git-repo precondition guard (#16)', () => {
  const ALL_OUTPUTS = [
    `${PROJECT}/ralph.config.sh`,
    `${PROJECT}/PROMPT.md`,
    `${PROJECT}/.env.local.example`,
    `${PROJECT}/ralph-notify.sh.example`,
    `${PROJECT}/.claude/commands/ralph.md`,
    `${PROJECT}/.gitignore`,
  ]

  // exec that reports "not a work tree" for the guard call and would otherwise
  // succeed. If the guard fails to fire, the rest of init would proceed.
  function nonRepoExec() {
    return makeExec({
      ...defaultGitHandlers(),
      'git rev-parse --is-inside-work-tree': fail(),
    })
  }

  it('aborts with InitAbort(exitCode 1) and a clear stderr message outside a git repo', async () => {
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    const stderr = makeStream()
    let caught
    try {
      await initCommand({
        cwd: PROJECT,
        stdout: makeStream(),
        stderr,
        exec: nonRepoExec(),
        fs: vol,
        isTTY: false,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InitAbort)
    expect(caught.exitCode).toBe(1)
    const err = stderr.output()
    expect(err).toContain('git repository')
    expect(err).toContain('git init')
  })

  it('writes NOTHING at all when run outside a git repo (every output file absent)', async () => {
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    await expect(
      initCommand({
        cwd: PROJECT,
        stdout: makeStream(),
        stderr: makeStream(),
        exec: nonRepoExec(),
        fs: vol,
        isTTY: false,
      }),
    ).rejects.toBeInstanceOf(InitAbort)
    for (const p of ALL_OUTPUTS) {
      expect(vol.existsSync(p)).toBe(false)
    }
  })

  it('fires BEFORE any interactive agent/source prompt (no prompt when not a repo, even with a TTY)', async () => {
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    let agentAsked = false
    let sourceAsked = false
    let confirmAsked = false
    await expect(
      initCommand({
        cwd: PROJECT,
        stdout: makeStream(),
        stderr: makeStream(),
        exec: nonRepoExec(),
        fs: vol,
        isTTY: true,
        promptAgent: async () => {
          agentAsked = true
          return 'codex'
        },
        promptSource: async () => {
          sourceAsked = true
          return 'folder'
        },
        ask: async () => {
          confirmAsked = true
          return true
        },
      }),
    ).rejects.toBeInstanceOf(InitAbort)
    expect(agentAsked).toBe(false)
    expect(sourceAsked).toBe(false)
    expect(confirmAsked).toBe(false)
  })

  it('proceeds normally inside a git repo (guard passes)', async () => {
    const { vol, run } = setup()
    const result = await run()
    expect(result.exitCode).toBe(0)
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(true)
  })

  it('a flag typo is still rejected before the git guard runs any exec', async () => {
    // The pure --agent/--source typo rejections must precede the git check, so a
    // bad flag never triggers a git call.
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    const exec = nonRepoExec()
    await expect(
      initCommand({
        cwd: PROJECT,
        stdout: makeStream(),
        stderr: makeStream(),
        exec,
        fs: vol,
        isTTY: false,
        agent: 'codx',
      }),
    ).rejects.toBeInstanceOf(InitAbort)
    expect(exec.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// #16 (QA augmentation): adversarial / edge coverage the happy-path guard tests
// missed. Focus: (a) the guard keys ONLY on exitCode (documented, per the issue
// "fails / returns non-zero"); (b) proof it short-circuits BEFORE branch
// detection AND before any global-config side effect; (c) the exact stderr
// message never leaks onto stdout; (d) --source typo ordering mirrors --agent.
// ---------------------------------------------------------------------------

describe('QA: initCommand — git-repo precondition guard, adversarial (#16)', () => {
  const EXACT_MSG =
    "❌ ralph init must be run inside a git repository. Run 'git init' first (or cd into your repo)."

  const SCAFFOLD_LINES = [
    'Wrote ralph.config.sh',
    'Wrote PROMPT.md',
    'Wrote .env.local.example',
    'Wrote ralph-notify.sh.example',
    'Wrote .claude/commands/ralph.md',
    'Updated .gitignore',
  ]

  function nonRepoExec() {
    return makeExec({
      ...defaultGitHandlers(),
      'git rev-parse --is-inside-work-tree': fail(),
    })
  }

  it('the guard keys ONLY on exitCode: exitCode 0 with stdout "false" is treated as inside a repo (issue says "returns non-zero")', async () => {
    // A bare `.git` dir edge case can print "false" on stdout while still
    // exiting 0. The acceptance criteria (#16) key on the process exit code,
    // not stdout content, so this MUST proceed normally. This test PINS that
    // deliberate choice — it is current-acceptable behavior, not a defect.
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    const exec = makeExec({
      ...defaultGitHandlers(),
      'git rev-parse --is-inside-work-tree': ok('false'),
    })
    const result = await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec,
      fs: vol,
      isTTY: false,
    })
    expect(result.exitCode).toBe(0)
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(true)
  })

  it('outside a repo, branch detection NEVER runs — the ONLY exec call is the guard itself', async () => {
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    const exec = nonRepoExec()
    await expect(
      initCommand({
        cwd: PROJECT,
        stdout: makeStream(),
        stderr: makeStream(),
        exec,
        fs: vol,
        isTTY: false,
      }),
    ).rejects.toBeInstanceOf(InitAbort)
    // Proves it aborts before resolveProjectRoot / symbolic-ref / branch -a.
    expect(exec.calls).toEqual(['git rev-parse --is-inside-work-tree'])
    expect(exec.calls).not.toContain('git rev-parse --show-toplevel')
    expect(exec.calls).not.toContain('git symbolic-ref refs/remotes/origin/HEAD')
    expect(exec.calls).not.toContain('git branch -a')
  })

  it('writes the exact message to STDERR only — stdout stays empty of every scaffold "Wrote" line', async () => {
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    const stdout = makeStream()
    const stderr = makeStream()
    await expect(
      initCommand({
        cwd: PROJECT,
        stdout,
        stderr,
        exec: nonRepoExec(),
        fs: vol,
        isTTY: false,
      }),
    ).rejects.toBeInstanceOf(InitAbort)
    expect(stderr.output()).toContain(EXACT_MSG)
    // The error must NOT be misrouted to stdout, and no success line may print.
    expect(stdout.output()).not.toContain(EXACT_MSG)
    for (const line of SCAFFOLD_LINES) {
      expect(stdout.output()).not.toContain(line)
    }
  })

  it('a --source typo in a non-repo is rejected by the flag guard FIRST — no git exec runs (mirrors --agent ordering)', async () => {
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    const exec = nonRepoExec()
    await expect(
      initCommand({
        cwd: PROJECT,
        stdout: makeStream(),
        stderr: makeStream(),
        exec,
        fs: vol,
        isTTY: false,
        source: 'gitlab',
      }),
    ).rejects.toBeInstanceOf(InitAbort)
    // Flag guards precede the git check, so a bad --source never shells out.
    expect(exec.calls).toHaveLength(0)
  })

  it('aborting outside a repo writes NOTHING to the global WhatsApp config (no side effect), even with a TTY', async () => {
    const HOME = '/home/test'
    const GLOBAL = `${HOME}/.config/ralph/.env`
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    let asked = false
    let valued = false
    await expect(
      initCommand({
        cwd: PROJECT,
        stdout: makeStream(),
        stderr: makeStream(),
        exec: nonRepoExec(),
        fs: vol,
        isTTY: true,
        home: HOME,
        processEnv: {},
        promptAgent: async () => 'claude',
        promptSource: async () => 'github',
        ask: async () => {
          asked = true
          return true
        },
        promptValue: async () => {
          valued = true
          return 'x'
        },
      }),
    ).rejects.toBeInstanceOf(InitAbort)
    // setupWhatsApp runs only after scaffolding — the abort must precede it.
    expect(vol.existsSync(GLOBAL)).toBe(false)
    expect(asked).toBe(false)
    expect(valued).toBe(false)
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

describe('initCommand — task source selection (#565)', () => {
  it('defaults to TASK_SOURCE="github" when no flag and not a TTY', async () => {
    const { vol, run } = setup()
    const result = await run()
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('TASK_SOURCE="github"')
    expect(cfg).not.toContain('{{TASK_SOURCE}}')
    expect(result.source).toBe('github')
  })

  it('writes TASK_SOURCE="folder" when --source folder is passed', async () => {
    const { vol } = setup()
    const result = await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      source: 'folder',
    })
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('TASK_SOURCE="folder"')
    expect(result.source).toBe('folder')
  })

  it('scaffolds the .ralph/tasks tree (empty dirs) when --source folder', async () => {
    const { vol } = setup()
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      source: 'folder',
    })
    for (const d of [
      '.ralph/tasks/afk/todo',
      '.ralph/tasks/afk/in-progress',
      '.ralph/tasks/afk/done',
      '.ralph/tasks/afk/failed',
      '.ralph/tasks/hitl/todo',
    ]) {
      expect(vol.existsSync(`${PROJECT}/${d}`)).toBe(true)
    }
  })

  it('does NOT scaffold the tasks tree for github mode', async () => {
    const { vol, run } = setup()
    await run()
    expect(vol.existsSync(`${PROJECT}/.ralph/tasks`)).toBe(false)
  })

  // #125: jira is the third value the flag accepts. It rides the existing
  // VALID_SOURCES guard, so the only thing worth asserting is that the value
  // reaches the file a shell will source — and that it scaffolds nothing, since
  // the local task tree is folder mode's mechanism and not this one's.
  it('writes TASK_SOURCE="jira" when --source jira is passed (#125)', async () => {
    const { vol } = setup()
    const result = await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      source: 'jira',
    })
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('TASK_SOURCE="jira"')
    expect(cfg).not.toContain('{{TASK_SOURCE}}')
    expect(result.source).toBe('jira')
  })

  it('normalizes an uppercase --source ("JIRA") and scaffolds no task tree (#125)', async () => {
    const { vol } = setup()
    const result = await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      source: '  JIRA  ',
    })
    expect(result.source).toBe('jira')
    expect(vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')).toContain('TASK_SOURCE="jira"')
    expect(vol.existsSync(`${PROJECT}/.ralph/tasks`)).toBe(false)
  })

  it('rejects an invalid --source flag before any writes (mirrors --agent)', async () => {
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
        source: 'gitlab',
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InitAbort)
    expect(caught.exitCode).toBe(1)
    const err = stderr.output()
    expect(err).toContain('gitlab')
    expect(err).toContain('github')
    expect(err).toContain('folder')
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
  })

  it('normalizes an uppercase --source ("FOLDER") to lowercase folder', async () => {
    const { vol } = setup()
    const result = await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      source: 'FOLDER',
    })
    expect(result.source).toBe('folder')
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('TASK_SOURCE="folder"')
  })

  it('prompts for the source when interactive and no flag is given', async () => {
    const { vol } = setup()
    let asked = false
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      isTTY: true,
      ask: async () => false,
      promptAgent: async () => 'claude',
      promptSource: async () => {
        asked = true
        return 'folder'
      },
    })
    expect(asked).toBe(true)
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('TASK_SOURCE="folder"')
  })

  it('does NOT prompt for source when a flag is given even if interactive', async () => {
    const { vol } = setup()
    let asked = false
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      isTTY: true,
      source: 'github',
      ask: async () => false,
      promptAgent: async () => 'claude',
      promptSource: async () => {
        asked = true
        return 'folder'
      },
    })
    expect(asked).toBe(false)
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('TASK_SOURCE="github"')
  })

  it('non-TTY without a flag defaults to github and does NOT call promptSource', async () => {
    const { vol } = setup()
    let asked = false
    await initCommand({
      cwd: PROJECT,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      isTTY: false,
      promptSource: async () => {
        asked = true
        return 'folder'
      },
    })
    expect(asked).toBe(false)
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg).toContain('TASK_SOURCE="github"')
  })

  it('the written config carries the TASK_SOURCE explanatory comment', async () => {
    const { vol, run } = setup()
    await run()
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    expect(cfg.toLowerCase()).toContain('task source')
  })

  it('the TASK_SOURCE comment documents all THREE values, jira included (#125)', async () => {
    // The template's prose is the only documentation a user of a scaffolded repo
    // has in front of them, and a value the resolver accepts but the comment does
    // not mention is a value nobody will find. Asserted on the WRITTEN file rather
    // than on templates/ralph.config.sh so it covers the interpolation too.
    const { vol, run } = setup()
    await run()
    const cfg = vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')
    const comment = cfg.slice(cfg.indexOf('# Task source'), cfg.indexOf('TASK_SOURCE="'))
    expect(comment).toContain('"github"')
    expect(comment).toContain('"folder"')
    expect(comment).toContain('"jira"')
    // What a jira run actually needs — the prerequisite this slice exists to make
    // checkable — and the command that satisfies the half no dep check can see.
    expect(comment).toContain('acli')
    expect(comment).toContain('acli jira auth login')
  })

  it('prints the detected source in the summary', async () => {
    const { vol } = setup()
    const stdout = makeStream()
    await initCommand({
      cwd: PROJECT,
      stdout,
      stderr: makeStream(),
      exec: makeExec(defaultGitHandlers()),
      fs: vol,
      source: 'folder',
    })
    expect(stdout.output()).toContain('TASK_SOURCE:')
    expect(stdout.output()).toContain('folder')
  })
})

// ---------------------------------------------------------------------------
// #5: interactive global WhatsApp setup. After agent/source resolution and the
// file scaffolding, and ONLY when a TTY is present, init reads the global
// config (~/.config/ralph/.env, honoring XDG) and offers to set up or update
// credentials. All prompts + fs + home are injected so we never touch the real
// home dir or stdin.
// ---------------------------------------------------------------------------
describe('initCommand — global WhatsApp setup (#5)', () => {
  const HOME = '/home/test'
  const GLOBAL = `${HOME}/.config/ralph/.env`

  function harness({ global, isTTY = true, confirmAnswers = [], valueAnswers = [] } = {}) {
    const seed = { [`${PROJECT}/.keep`]: '' }
    if (global != null) seed[GLOBAL] = global
    const vol = Volume.fromJSON(seed, '/')
    const stdout = makeStream()
    const askQuestions = []
    const valueQuestions = []
    const cq = [...confirmAnswers]
    const vq = [...valueAnswers]
    const ask = (q) => {
      askQuestions.push(q)
      return Promise.resolve(cq.length ? cq.shift() : false)
    }
    const promptValue = (q) => {
      valueQuestions.push(q)
      return Promise.resolve(vq.length ? vq.shift() : '')
    }
    const run = () =>
      initCommand({
        cwd: PROJECT,
        stdout,
        stderr: makeStream(),
        exec: makeExec(defaultGitHandlers()),
        fs: vol,
        isTTY,
        home: HOME,
        processEnv: {},
        promptAgent: async () => 'claude',
        promptSource: async () => 'github',
        ask,
        promptValue,
      })
    return { vol, stdout, run, askQuestions, valueQuestions }
  }

  it('unset + opt-in: gates on yes, captures phone then key, writes global file', async () => {
    const h = harness({
      global: null,
      confirmAnswers: [true],
      valueAnswers: ['+15551234567', 'mykey123'],
    })
    await h.run()
    expect(h.askQuestions[0]).toMatch(/WhatsApp notifications globally\?/i)
    const out = h.vol.readFileSync(GLOBAL, 'utf8')
    expect(out).toContain('WHATSAPP_PHONE=+15551234567')
    expect(out).toContain('CALLMEBOT_KEY=mykey123')
  })

  it('unset + opt-out: declining leaves notifications off (no global file written)', async () => {
    const h = harness({ global: null, confirmAnswers: [false] })
    await h.run()
    expect(h.vol.existsSync(GLOBAL)).toBe(false)
    expect(h.valueQuestions).toHaveLength(0)
  })

  it('already-set + change: shows phone in full + masked key, captures new values', async () => {
    const h = harness({
      global: 'WHATSAPP_PHONE=+1999\nCALLMEBOT_KEY=abcd3f9a\n',
      confirmAnswers: [true],
      valueAnswers: ['+1888', 'newkey'],
    })
    await h.run()
    const shown = h.stdout.output()
    expect(shown).toContain('+1999')
    expect(shown).toContain('••••3f9a')
    expect(shown).not.toContain('abcd3f9a')
    const out = h.vol.readFileSync(GLOBAL, 'utf8')
    expect(out).toContain('WHATSAPP_PHONE=+1888')
    expect(out).toContain('CALLMEBOT_KEY=newkey')
  })

  it('already-set + keep (change=no): leaves global creds untouched', async () => {
    const original = 'WHATSAPP_PHONE=+1999\nCALLMEBOT_KEY=abcd3f9a\n'
    const h = harness({ global: original, confirmAnswers: [false] })
    await h.run()
    expect(h.vol.readFileSync(GLOBAL, 'utf8')).toBe(original)
    expect(h.valueQuestions).toHaveLength(0)
  })

  it('already-set + change but blank entries keep the existing values', async () => {
    const original = 'WHATSAPP_PHONE=+1999\nCALLMEBOT_KEY=abcd3f9a\n'
    const h = harness({
      global: original,
      confirmAnswers: [true],
      valueAnswers: ['', ''],
    })
    await h.run()
    const out = h.vol.readFileSync(GLOBAL, 'utf8')
    expect(out).toContain('WHATSAPP_PHONE=+1999')
    expect(out).toContain('CALLMEBOT_KEY=abcd3f9a')
  })

  it('non-TTY: skips the WhatsApp prompt silently and leaves existing creds untouched', async () => {
    const original = 'WHATSAPP_PHONE=+1999\nCALLMEBOT_KEY=abcd3f9a\n'
    const h = harness({ global: original, isTTY: false })
    await h.run()
    expect(h.askQuestions).toHaveLength(0)
    expect(h.valueQuestions).toHaveLength(0)
    expect(h.vol.readFileSync(GLOBAL, 'utf8')).toBe(original)
  })
})

describe('initCommand — summary points at global config (#5)', () => {
  it('summary WhatsApp section references the global config, not .env.local.example', async () => {
    const { stdout, run } = setup()
    await run()
    const out = stdout.output()
    expect(out).toContain('WhatsApp notifications')
    expect(out).toContain('ralph/.env')
    expect(out).not.toContain('Copy .env.local.example to .env.local')
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#108): ONE LINE PER WARNING, whatever the agent value holds.
//
// `ralph init` writes two kinds of complaint about an agent value, both by interpolating what
// the user supplied into a single `err()` call: the hard `❌ Unknown agent '<flag>'` rejection
// (#560's guard) and the soft `⚠️  RALPH_AGENT='<value>' unrecognized` fallback that comes
// worded by `resolveAgent`. A value carrying a newline therefore made ONE write emit TWO lines
// of stderr, the second composed by nobody — an `❌` a wrapper script greps for, or a `✅` a
// human trusts. Same defect `ralph doctor` was reported for (#108), same class `ralph start`
// has routed the RALPH_BANNER warning around since #62.
//
// The soft path is fixed at its SOURCE (lib/agent-registry.js) so every caller inherits it; the
// hard path is init's own sentence and is fixed here, where it is written.
// ---------------------------------------------------------------------------

describe('QA: initCommand — one line per warning, whatever the agent value holds (#108)', () => {
  // Built from code points rather than typed: a raw control byte in a test file takes the file
  // out of every grep-based tool (#107).
  const LF = String.fromCharCode(0x0a)
  const CR = String.fromCharCode(0x0d)
  const NUL = String.fromCharCode(0x00)
  const BEL = String.fromCharCode(0x07)
  const ESC = String.fromCharCode(0x1b)
  const C1_CSI = String.fromCharCode(0x9b)
  const PLACEHOLDER = String.fromCharCode(0xfffd)
  const isControlCode = (code) =>
    code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
  const controlsIn = (text) =>
    [...String(text)].map((c) => c.codePointAt(0)).filter((code) => isControlCode(code) && code !== 0x0a)

  function harness(overrides = {}) {
    const vol = Volume.fromJSON({ [`${PROJECT}/.keep`]: '' }, '/')
    const stdout = makeStream()
    const stderr = makeStream()
    const run = () =>
      initCommand({
        cwd: PROJECT,
        stdout,
        stderr,
        exec: makeExec(defaultGitHandlers()),
        fs: vol,
        isTTY: false,
        // Decline the WhatsApp gate (#5) rather than letting `confirm` read the suite's stdin.
        ask: async () => false,
        ...overrides,
      })
    // Every line stderr received, the way a terminal counted them.
    const errLines = () => stderr.output().split('\n').filter(Boolean)
    return { vol, stdout, stderr, errLines, run }
  }

  it('a prompt answer carrying a newline forges no second line of stderr', async () => {
    // The path the fallback warning is actually reachable on: the flag is rejected earlier by
    // #560's guard, so the value that reaches `resolveAgent` comes from the prompt — which is
    // injectable here and is a free-text seam a future prompt could widen.
    const hostile = `x${LF}✅ Ralph is ready`
    const { vol, errLines, run } = harness({ isTTY: true, promptAgent: async () => hostile })
    const result = await run()

    expect(errLines()).toHaveLength(1)
    expect(errLines()[0]).toBe(
      `⚠️  RALPH_AGENT='x${PLACEHOLDER}✅ Ralph is ready' unrecognized; falling back to 'claude'. Valid: claude, codex.`,
    )
    // The fallback itself is unchanged: a stray keystroke at a prompt still costs an unattended
    // run nothing, the config still says claude, and the exit code does not move.
    expect(result.agent).toBe('claude')
    expect(result.exitCode).toBe(0)
    expect(vol.readFileSync(`${PROJECT}/ralph.config.sh`, 'utf8')).toContain('RALPH_AGENT="claude"')
  })

  it('lets no terminal instruction out of that warning either', async () => {
    // Swept as a CLASS rather than as the newline the issue was filed with: CR redraws over
    // whatever is already on the line, the C1 introducer is a CSI needing no ESC, and a NUL
    // truncates the line for some terminals.
    for (const [label, value] of Object.entries({
      'a clear screen': `${ESC}[2J${ESC}[H`,
      'a window title': `${ESC}]0;pwned${BEL}`,
      'a carriage return': `${CR}❌ ralph init failed`,
      'a C1 introducer': `${C1_CSI}2J`,
      'a NUL': `co${NUL}dx`,
    })) {
      const { errLines, stderr, run } = harness({ isTTY: true, promptAgent: async () => value })
      const result = await run()
      expect(errLines(), label).toHaveLength(1)
      expect(controlsIn(stderr.output()), label).toEqual([])
      // Scrubbed is not silenced: the user still learns their choice was not understood.
      expect(errLines()[0], label).toContain('unrecognized')
      expect(result.agent, label).toBe('claude')
      expect(result.exitCode, label).toBe(0)
    }
  })

  it('a hostile --agent flag is rejected on ONE line, and still echoed', async () => {
    // #560's guard, which prints init's own sentence rather than resolveAgent's. The value is
    // still echoed — a typo the user cannot see is a typo they cannot fix — and the abort, the
    // exit code and the "writes nothing" promise are all untouched.
    const { vol, errLines, run } = harness({ agent: `codex${LF}✅ Ralph is ready` })
    await expect(run()).rejects.toBeInstanceOf(InitAbort)
    expect(errLines()).toHaveLength(1)
    expect(errLines()[0]).toBe(
      `❌ Unknown agent 'codex${PLACEHOLDER}✅ Ralph is ready'. Valid agents: claude, codex.`,
    )
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
  })

  it('...and so is a hostile --source flag, which is the same sentence next door', async () => {
    // The guard directly below the agent one, with the same shape and the same hole. Fixed at
    // the same time deliberately: leaving one of a matched pair sanitised is how the next reader
    // learns that the rule is optional.
    const { vol, errLines, run } = harness({ source: `folder${LF}✅ Ralph is ready` })
    await expect(run()).rejects.toBeInstanceOf(InitAbort)
    expect(errLines()).toHaveLength(1)
    expect(errLines()[0]).toBe(
      // #125 added jira to VALID_SOURCES, and the sentence lists the registry
      // rather than a retyped set — so the third value shows up here for free.
      `❌ Unknown task source 'folder${PLACEHOLDER}✅ Ralph is ready'. Valid sources: github, folder, jira.`,
    )
    expect(vol.existsSync(`${PROJECT}/ralph.config.sh`)).toBe(false)
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
