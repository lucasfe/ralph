import { describe, it, expect } from 'vitest'
import { doctorCommand, assertCriticalDeps } from './commands/doctor.js'
import { REQUIRED_DEPS } from './deps.js'
import { detectPlatform } from './platform.js'
import { EMPTY_VERSION_CACHE } from './version-cache.js'

// Strip ANSI color codes so assertions on symbols (e.g. /✓ git/) hold whether
// or not picocolors emits color. In CI (CI=true / FORCE_COLOR) picocolors wraps
// `✓` in escape codes, which would otherwise break `✓ git`-style matches.
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\u001B\[[0-9;]*m/g, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => stripAnsi(chunks.join('')),
  }
}

const allPresent = () => true
const noneInstalled = () => false

// #125: the two exit codes the jira auth probe distinguishes, as the only thing a
// stub of the injected `exec` has to be able to produce — it keys on the code
// alone and never on output text. Stateless, hence shared rather than built per
// test, and module-scoped because both the dep-gating suite and the auth-row suite
// need to drive a real probe.
const okExec = async () => ({ exitCode: 0, stdout: '', stderr: '' })
const failExec = async () => ({ exitCode: 1, stdout: '', stderr: '' })

// #27: doctor also renders a cached installed-vs-latest version line — #75 folded it into
// the identity box. These suites assert on the dependency report, so they stub the cache
// READER out; no test in this file may touch the real ~/.config/ralph/update-check.json.
// The verdict's own states live in commands/doctor.version-line.test.js.
//
// #75: ...and the same discipline for the box's other two impure inputs. `cwd` is stubbed
// because doctor now prints it, and a test that let it default would print the developer's
// checkout into its own assertions; `exists` is stubbed because doctor reads ralph.config.sh
// for RALPH_BANNER, and whether that file happens to exist in this repo must not decide what
// these tests see.
const runDoctor = (opts) =>
  doctorCommand({
    readCache: () => EMPTY_VERSION_CACHE,
    cwd: '/repo',
    exists: () => false,
    ...opts,
  })

// #75: the box's `agent` row, which is where `platform: … — agent: …` went. The gutter is
// eight columns wide (see LABEL_WIDTH in lib/banner-compose.js), so the label's own padding
// is part of what makes this a row rather than a coincidental substring.
const agentRow = (name) => `agent   ${name}`

describe('doctorCommand', () => {
  it('exits 0 when all deps are present', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
    })
    expect(result.exitCode).toBe(0)
    expect(result.missingCritical).toEqual([])
    expect(stdout.output()).toContain('All deps present')
  })

  it('exits 1 when a critical dep is missing', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'git',
      platform: 'mac',
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.map((r) => r.name)).toEqual(['git'])
    expect(stderr.output()).toContain('Missing 1 required dep')
  })

  it('exits 0 with warning when only a non-critical dep is missing', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'mac',
    })
    expect(result.exitCode).toBe(0)
    expect(result.missingCritical).toEqual([])
    expect(result.missingNonCritical.map((r) => r.name)).toEqual(['jq'])
    expect(stdout.output()).toContain('Optional deps missing: jq')
  })

  it('prints the macOS install command when platform is mac', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'mac',
    })
    expect(stdout.output()).toContain('brew install jq')
  })

  it('prints the linux install command when platform is linux', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'linux',
    })
    expect(stdout.output()).toContain('apt install jq')
  })

  it('prints the wsl install command when platform is wsl', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'wsl',
    })
    expect(stdout.output()).toContain('apt install jq')
  })

  it('lists every required dep for the selected agent in the output', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
      env: {},
    })
    // Default agent is claude and the default source is github: every shared dep
    // + claude + gh appear. The two gated-out names are NOT listed — codex
    // because it is the other agent's CLI, and acli because it belongs to the
    // jira source (#125), which is the same gate gh rides on read the other way.
    for (const name of Object.keys(REQUIRED_DEPS)) {
      if (name === 'codex' || name === 'acli') {
        expect(stdout.output()).not.toContain(name)
      } else {
        expect(stdout.output()).toContain(name)
      }
    }
  })

  it('exits 1 when both critical and non-critical are missing', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: noneInstalled,
      platform: 'mac',
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.length).toBeGreaterThan(0)
    expect(result.missingNonCritical.length).toBeGreaterThan(0)
  })
})

describe('assertCriticalDeps', () => {
  it('returns ok when all critical deps present', () => {
    const result = assertCriticalDeps({ hasCommand: allPresent, platform: 'mac' })
    expect(result.ok).toBe(true)
    expect(result.missingCritical).toEqual([])
  })

  it('returns not ok with formatted message when critical dep missing', () => {
    const result = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'tmux',
      platform: 'mac',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("❌ 'tmux' not found in PATH")
    expect(result.message).toContain('brew install tmux')
  })

  it('does not flag non-critical deps as failures', () => {
    const result = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'jq',
      platform: 'mac',
      env: {},
    })
    expect(result.ok).toBe(true)
  })
})

describe('doctor / deps — agent-aware (#554)', () => {
  it('checks claude and NOT codex when agent is claude (default)', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({ stdout, stderr, hasCommand: allPresent, platform: 'mac', env: {} })
    expect(stdout.output()).toContain(agentRow('claude'))
    // claude present as a checked line; codex never appears.
    expect(stdout.output()).toMatch(/✓ claude/)
    expect(stdout.output()).not.toContain('codex')
  })

  it('checks codex and NOT claude when RALPH_AGENT=codex', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
      env: { RALPH_AGENT: 'codex' },
    })
    expect(stdout.output()).toContain(agentRow('codex'))
    expect(stdout.output()).toMatch(/✓ codex/)
    expect(stdout.output()).not.toMatch(/✓ claude/)
  })

  it('a missing codex CLI is the critical failure on a codex machine (claude irrelevant)', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      // codex absent, claude also absent — only codex should count.
      hasCommand: (cmd) => cmd !== 'codex' && cmd !== 'claude',
      platform: 'mac',
      env: { RALPH_AGENT: 'codex' },
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.map((r) => r.name)).toContain('codex')
    expect(result.missingCritical.map((r) => r.name)).not.toContain('claude')
  })

  it('a missing claude CLI does NOT fail doctor on a codex machine', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'claude',
      platform: 'mac',
      env: { RALPH_AGENT: 'codex' },
    })
    expect(result.exitCode).toBe(0)
  })

  it('reports the fallback warning when RALPH_AGENT is a typo, validates claude', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
      env: { RALPH_AGENT: 'codx' },
    })
    expect(result.exitCode).toBe(0)
    expect(stdout.output()).toContain(agentRow('claude'))
    expect(stdout.output()).toContain('unrecognized')
  })

  it('assertCriticalDeps checks only the selected agent CLI', () => {
    // codex machine, claude missing but codex present => ok.
    const ok = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'claude',
      platform: 'mac',
      env: { RALPH_AGENT: 'codex' },
    })
    expect(ok.ok).toBe(true)
    // codex machine, codex missing => not ok, message names codex.
    const bad = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'codex',
      platform: 'mac',
      env: { RALPH_AGENT: 'codex' },
    })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain("'codex'")
    expect(bad.message).toContain('npm install -g @openai/codex')
  })
})

describe('doctor / deps — source-aware gh gating (#565)', () => {
  it('checks gh when source is github (default)', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({ stdout, stderr, hasCommand: allPresent, platform: 'mac', env: {} })
    expect(stdout.output()).toMatch(/✓ gh/)
  })

  it('does NOT check gh when TASK_SOURCE=folder', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await runDoctor({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
      env: { TASK_SOURCE: 'folder' },
    })
    expect(stdout.output()).not.toContain('gh')
    // other shared deps still shown
    expect(stdout.output()).toMatch(/✓ git/)
  })

  it('a missing gh does NOT fail doctor in folder mode', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'gh',
      platform: 'mac',
      env: { TASK_SOURCE: 'folder' },
    })
    expect(result.exitCode).toBe(0)
  })

  it('a missing gh DOES fail doctor in github mode', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await runDoctor({
      stdout,
      stderr,
      hasCommand: (cmd) => cmd !== 'gh',
      platform: 'mac',
      env: {},
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.map((r) => r.name)).toContain('gh')
  })

  it('assertCriticalDeps ignores a missing gh in folder mode', () => {
    const ok = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'gh',
      platform: 'mac',
      env: { TASK_SOURCE: 'folder' },
    })
    expect(ok.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// #125 — the jira source, as `ralph doctor` reports it. Two halves, and only the
// first of them can move the exit code:
//
//   THE DEP ROW is free: doctor already resolves the source and hands it to
//   checkDeps, so `acli` arrives through the same gate gh rides on and a missing
//   one is a critical failure exactly like a missing gh in github mode.
//   THE AUTH ROW is reported, never enforced — the same treatment doctor already
//   gives agent CLI health. `acli` on PATH and `acli` logged in are different
//   questions, and only the first is a dependency.
//
// `exec` is injected in every test below; nothing here runs a real acli.
// ---------------------------------------------------------------------------
describe('doctor / deps — jira source dependency gating (#125)', () => {
  it('checks acli and NOT gh when TASK_SOURCE=jira', async () => {
    const stdout = makeStream()
    await runDoctor({
      stdout,
      stderr: makeStream(),
      hasCommand: allPresent,
      platform: 'mac',
      env: { TASK_SOURCE: 'jira' },
    })
    expect(stdout.output()).toMatch(/✓ acli/)
    expect(stdout.output()).not.toContain('gh')
    // Shared deps are still there — a source gate narrows, it does not replace.
    expect(stdout.output()).toMatch(/✓ git/)
  })

  // THE DOCUMENTED PATH, and the one that was silently missing: `ralph init
  // --source jira` writes TASK_SOURCE="jira" into ralph.config.sh and never
  // exports it, so a doctor that read only the environment reported a github repo
  // to every user who configured the source the way init writes it. Config first,
  // environment second — the same `parseConfigSource(configText) || env` shape
  // start.js and status.js spell, because this file's own config-read note refuses
  // to let a knob answer differently in `ralph doctor` than in `ralph start`.
  describe('the source is read config-first (#125)', () => {
    const withConfig = (config, opts = {}) =>
      runDoctor({
        stderr: makeStream(),
        hasCommand: allPresent,
        platform: 'mac',
        env: {},
        exists: (p) => String(p).endsWith('ralph.config.sh'),
        readFile: () => config,
        ...opts,
      })

    it('gates acli and the auth row on a config file alone, with no env var', async () => {
      const stdout = makeStream()
      await withConfig('TASK_SOURCE="jira"\n', { stdout, exec: okExec })
      expect(stdout.output()).toMatch(/✓ acli/)
      expect(stdout.output()).toContain('✓ jira auth')
      expect(stdout.output()).not.toContain('gh')
    })

    it('the config BEATS the environment, which is the loop\'s own precedence', async () => {
      const stdout = makeStream()
      await withConfig('TASK_SOURCE="jira"\n', {
        stdout,
        env: { TASK_SOURCE: 'github' },
        exec: okExec,
      })
      expect(stdout.output()).toMatch(/✓ acli/)
      expect(stdout.output()).not.toContain('gh')
    })

    it('an EMPTY config value falls through to the environment', async () => {
      // The `||` shape — the one status.js and cycle.js still carry, and the one `ralph start`
      // LEFT at #149: a blank assignment is not an answer here, so the environment gets to
      // speak. That is now a measured disagreement with `ralph start`, which reads the same
      // file's blank as the file's own answer; the note at doctor.js's `source` binding scopes
      // it and names the follow-up. Pinned rather than endorsed.
      const stdout = makeStream()
      await withConfig('TASK_SOURCE=""\n', { stdout, env: { TASK_SOURCE: 'jira' }, exec: okExec })
      expect(stdout.output()).toMatch(/✓ acli/)
    })

    it('a config naming no source leaves the environment in charge', async () => {
      const stdout = makeStream()
      await withConfig('RALPH_AGENT="claude"\n', { stdout, env: { TASK_SOURCE: 'jira' } })
      expect(stdout.output()).toMatch(/✓ acli/)
      expect(stdout.output()).toContain('! jira auth (not verified)')
    })

    it('a config nobody can read costs the report nothing', async () => {
      // readConfigText never throws, which is the whole reason doctor may read a
      // file at all — see the config-read note in doctor.js.
      const stdout = makeStream()
      const result = await withConfig('', {
        stdout,
        readFile: () => {
          throw new Error('EACCES')
        },
        env: { TASK_SOURCE: 'jira' },
        exec: okExec,
      })
      expect(stdout.output()).toMatch(/✓ acli/)
      expect(result.exitCode).toBe(0)
    })
  })

  it('does NOT check acli in github or folder mode', async () => {
    for (const env of [{}, { TASK_SOURCE: 'folder' }]) {
      const stdout = makeStream()
      await runDoctor({
        stdout,
        stderr: makeStream(),
        hasCommand: allPresent,
        platform: 'mac',
        env,
      })
      expect(stdout.output()).not.toContain('acli')
    }
  })

  it('a missing acli DOES fail doctor in jira mode, with the mac install hint', async () => {
    const stdout = makeStream()
    const result = await runDoctor({
      stdout,
      stderr: makeStream(),
      hasCommand: (cmd) => cmd !== 'acli',
      platform: 'mac',
      env: { TASK_SOURCE: 'jira' },
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.map((r) => r.name)).toEqual(['acli'])
    expect(stdout.output()).toContain('brew tap atlassian/acli && brew install acli')
  })

  it('a missing acli does NOT fail doctor in github mode', async () => {
    const result = await runDoctor({
      stdout: makeStream(),
      stderr: makeStream(),
      hasCommand: (cmd) => cmd !== 'acli',
      platform: 'mac',
      env: {},
    })
    expect(result.exitCode).toBe(0)
  })

  it('assertCriticalDeps fails on a missing acli under TASK_SOURCE=jira', () => {
    const bad = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'acli',
      platform: 'mac',
      env: { TASK_SOURCE: 'jira' },
    })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain("❌ 'acli' not found in PATH")
    expect(bad.message).toContain('brew tap atlassian/acli && brew install acli')
    // ...and it is the ONLY line: gh is not a jira dependency, so a machine with
    // no gh at all must not be told to install one.
    expect(bad.message.split('\n')).toHaveLength(1)
  })

  it('assertCriticalDeps carries the linux hint on linux, and the same one on wsl', () => {
    const hints = ['linux', 'wsl'].map(
      (platform) =>
        assertCriticalDeps({
          hasCommand: (cmd) => cmd !== 'acli',
          platform,
          env: { TASK_SOURCE: 'jira' },
        }).message,
    )
    expect(hints[0]).toContain('https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli')
    expect(hints[1]).toBe(hints[0])
  })

  it('assertCriticalDeps ignores a missing gh in jira mode', () => {
    const ok = assertCriticalDeps({
      hasCommand: (cmd) => cmd !== 'gh',
      platform: 'mac',
      env: { TASK_SOURCE: 'jira' },
    })
    expect(ok.ok).toBe(true)
  })
})

describe('doctor — the jira auth row (#125)', () => {
  const jira = (opts = {}) =>
    runDoctor({
      stderr: makeStream(),
      hasCommand: allPresent,
      platform: 'mac',
      env: { TASK_SOURCE: 'jira' },
      ...opts,
    })

  it('reports authenticated when the probe exits zero', async () => {
    const stdout = makeStream()
    const result = await jira({ stdout, exec: okExec })
    expect(stdout.output()).toContain('✓ jira auth')
    expect(result.exitCode).toBe(0)
  })

  it('reports NOT authenticated, with a login hint, and still exits 0', async () => {
    // Auth is REPORTED, not enforced — the same treatment doctor gives agent CLI
    // health. A wrapper gating on `ralph doctor` must not start failing because a
    // token expired: that is what the loop's own preflight is for.
    const stdout = makeStream()
    const result = await jira({ stdout, exec: failExec })
    expect(stdout.output()).toContain('! jira auth (not authenticated)')
    expect(stdout.output()).toContain('login: acli jira auth login')
    expect(result.exitCode).toBe(0)
  })

  it('reports NOT authenticated when the probe throws, rather than crashing', async () => {
    const stdout = makeStream()
    const result = await jira({
      stdout,
      exec: async () => {
        throw new Error('ENOENT: acli not found')
      },
    })
    expect(stdout.output()).toContain('! jira auth (not authenticated)')
    expect(result.exitCode).toBe(0)
  })

  it('reports NOT VERIFIED when no exec seam was injected', async () => {
    // doctor is the command people run when things are already broken, so a
    // caller that supplies no way to run acli gets an honest "nobody asked"
    // rather than a fabricated failure — and never a crash.
    const stdout = makeStream()
    const result = await jira({ stdout })
    expect(stdout.output()).toContain('! jira auth (not verified)')
    expect(stdout.output()).toContain('check: acli jira auth status')
    expect(stdout.output()).not.toContain('not authenticated')
    expect(result.exitCode).toBe(0)
  })

  it('prints NO auth row in github or folder mode, and never runs the probe there', async () => {
    for (const env of [{}, { TASK_SOURCE: 'folder' }]) {
      const stdout = makeStream()
      let calls = 0
      await runDoctor({
        stdout,
        stderr: makeStream(),
        hasCommand: allPresent,
        platform: 'mac',
        env,
        exec: async () => {
          calls += 1
          return { exitCode: 0 }
        },
      })
      expect(stdout.output()).not.toContain('jira auth')
      expect(calls).toBe(0)
    }
  })

  it('runs `acli jira auth status` through the injected exec, exit code only', async () => {
    const calls = []
    await jira({
      stdout: makeStream(),
      exec: async (cmd, args, opts) => {
        calls.push([cmd, args, opts])
        return { exitCode: 0 }
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('acli')
    expect(calls[0][1]).toEqual(['jira', 'auth', 'status'])
    expect(calls[0][2]).toMatchObject({ reject: false })
  })

  it('takes the probe from an injectable seam', async () => {
    let seen
    const stdout = makeStream()
    await jira({
      stdout,
      exec: okExec,
      probeJiraAuth: async (args) => {
        seen = args
        return { ok: false, reason: 'jira not authenticated' }
      },
    })
    expect(typeof seen.exec).toBe('function')
    expect(stdout.output()).toContain('! jira auth (not authenticated)')
  })

  it('adds NO field to the returned object, in any auth state', async () => {
    // doctor.version-line.qa.test.js pins these four keys exactly; the auth row
    // is output and nothing else.
    for (const exec of [okExec, failExec, undefined]) {
      const result = await jira({ stdout: makeStream(), exec })
      expect(Object.keys(result).sort()).toEqual([
        'exitCode',
        'missingCritical',
        'missingNonCritical',
        'platform',
      ])
    }
  })

  it('still exits 1 for a missing critical dep, and the auth row is unrelated to it', async () => {
    const stdout = makeStream()
    const result = await jira({
      stdout,
      hasCommand: (cmd) => cmd !== 'acli',
      exec: okExec,
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.map((r) => r.name)).toEqual(['acli'])
    // The row prints ABOVE the early return, so a broken setup still gets it.
    expect(stdout.output()).toContain('✓ jira auth')
  })

  // The probe is an INJECTED SEAM, so it is a caller's value and doctor must be
  // total for it — the same argument (and the same guard) `cachedLatestVersion`
  // makes for `readCache`. A diagnostic that crashed over its own arguments would
  // fail in exactly the situation it exists for.
  const brokenProbes = [
    ['throws synchronously', () => { throw new Error('probe blew up') }],
    ['rejects', async () => { throw new Error('probe rejected') }],
    ['is not callable', 'nope'],
    ['answers with a throwing ok getter', async () => ({ get ok() { throw new Error('hostile') } })],
  ]

  for (const [label, probeJiraAuth] of brokenProbes) {
    it(`reports NOT VERIFIED when the probe ${label}`, async () => {
      // A probe that blew up left the question UNASKED, which is the same
      // epistemic state as having no exec — so it gets that state's wording. The
      // alternative, "not authenticated", would be a verdict doctor never reached.
      const stdout = makeStream()
      const result = await jira({ stdout, exec: okExec, probeJiraAuth })
      expect(stdout.output()).toContain('! jira auth (not verified)')
      expect(stdout.output()).toContain('check: acli jira auth status')
      expect(stdout.output()).not.toContain('✓ jira auth')
      // ...and the rest of the report, plus a dep-only exit code and no fifth key.
      expect(stdout.output()).toContain('✓ acli')
      expect(result.exitCode).toBe(0)
      expect(Object.keys(result).sort()).toEqual([
        'exitCode',
        'missingCritical',
        'missingNonCritical',
        'platform',
      ])
    })

    it(`still exits 1 on the DEP verdict when the probe ${label}`, async () => {
      const result = await jira({
        stdout: makeStream(),
        exec: okExec,
        probeJiraAuth,
        hasCommand: (cmd) => cmd !== 'acli',
      })
      expect(result.exitCode).toBe(1)
      expect(result.missingCritical.map((r) => r.name)).toEqual(['acli'])
    })
  }

  it('reports NOT VERIFIED for an exec that is not callable', async () => {
    // Review round 1: `typeof exec === 'function'`, not truthiness. A caller that
    // passed garbage for the seam is as unable to run acli as one that passed
    // nothing, so it lands in the same state — "not authenticated" would be a login
    // failure nothing observed.
    for (const exec of ['acli', 42, {}, true]) {
      const stdout = makeStream()
      const result = await jira({ stdout, exec })
      expect(stdout.output(), String(exec)).toContain('! jira auth (not verified)')
      expect(stdout.output(), String(exec)).not.toContain('not authenticated')
      expect(result.exitCode, String(exec)).toBe(0)
    }
  })

  it('never paints the green row for a probe that answered nothing', async () => {
    for (const answer of [undefined, null, {}, false, 0, 'yes']) {
      const stdout = makeStream()
      const result = await jira({ stdout, exec: okExec, probeJiraAuth: async () => answer })
      expect(stdout.output(), String(answer)).not.toContain('✓ jira auth')
      expect(stdout.output(), String(answer)).toMatch(
        /! jira auth \((not authenticated|not verified)\)/,
      )
      expect(result.exitCode, String(answer)).toBe(0)
    }
  })
})

describe('detectPlatform', () => {
  it('returns mac for darwin', () => {
    expect(detectPlatform({ platform: 'darwin' })).toBe('mac')
  })

  it('returns linux when /proc/version has no microsoft tag', () => {
    expect(
      detectPlatform({ platform: 'linux', readProcVersion: () => 'Linux version 5.x ...' }),
    ).toBe('linux')
  })

  it('returns wsl when /proc/version mentions Microsoft', () => {
    expect(
      detectPlatform({
        platform: 'linux',
        readProcVersion: () => 'Linux version 5.x Microsoft WSL2',
      }),
    ).toBe('wsl')
  })

  it('returns wsl when /proc/version mentions microsoft (lowercase)', () => {
    expect(
      detectPlatform({
        platform: 'linux',
        readProcVersion: () => 'linux 5.x microsoft-standard',
      }),
    ).toBe('wsl')
  })

  it('returns linux when /proc/version is unreadable', () => {
    expect(detectPlatform({ platform: 'linux', readProcVersion: () => '' })).toBe('linux')
  })
})
