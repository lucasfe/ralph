import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { liveCommand, LiveAbort } from './live.js'
import { sessionNameFor } from '../lock.js'

// #167 — `ralph live` attaches this terminal to the loop running in the repo you are
// standing in, so the `tmux attach -t ralph-<name>-<hash>` line stops being something a
// user copies out of `ralph start`'s launch box.
//
// Everything below is hermetic: an injected `exec` that records what it was asked and
// answers with execa-shaped results, injected streams, an injected environment bag and
// an injected `hasCommand`, so no test here reaches a real tmux, a real git or a real
// terminal. The failure shapes are execa's own — with `{ reject: false }` a missing
// binary resolves as `{ failed: true, exitCode: undefined }` rather than throwing
// (measured against execa 9).
//
// The command's decision order is the thing under test, and it is FIXED: no tmux
// binary, then already inside tmux WITH a live session to switch to, then no terminal,
// then no live session, then the attach. Each step prints exactly one answer, so every
// test below asserts both what was printed and — where the step is a refusal — that no
// attach was spawned.

const REPO = '/repo'
const SUBDIR = '/repo/lib/commands'
const SESSION = sessionNameFor(REPO)

const TOPLEVEL = 'git rev-parse --show-toplevel'
const HAS = `tmux has-session -t ${SESSION}`
const ATTACH = `tmux attach -t ${SESSION}`

function makeStream(extra = {}) {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      // Backpressure: a real stdout can answer false, and the command must not care
      // (it never waits for 'drain').
      return false
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
    ...extra,
  }
}

// tmux is answered per SUBCOMMAND, because this command spends the runner two different
// ways on the same binary: captured for `has-session`, `stdio: 'inherit'` for the attach.
//
// `has-session` is asked TWICE on the attach path and the two answers are separate knobs:
// the first decides whether there is anything to attach to, the second — after tmux
// returns — decides whether the session outlived the client. `hasSessionAfterAttach`
// defaults to the first answer, which is the ordinary case (you detached, nothing else
// happened), so only the tests about the race have to say anything about it.
function makeExec({
  gitResult = { exitCode: 0, stdout: `${REPO}\n` },
  hasSessionResult = { exitCode: 0 },
  hasSessionAfterAttach = hasSessionResult,
  attachResult = { exitCode: 0 },
} = {}) {
  const calls = []
  let attached = false
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'git') return gitResult
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return attached ? hasSessionAfterAttach : hasSessionResult
    }
    if (cmd === 'tmux' && args[0] === 'attach') {
      attached = true
      return attachResult
    }
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
  }
  exec.calls = calls
  exec.keys = () => calls.map((c) => c.key)
  exec.at = (key) => calls.find((c) => c.key === key)
  return exec
}

// A repo whose loop is up, in a terminal, outside tmux, with tmux installed: the one
// state that reaches the attach. Every test below is this minus one thing.
const deps = (overrides = {}) => ({
  cwd: SUBDIR,
  stdout: makeStream(),
  stderr: makeStream(),
  exec: makeExec(),
  hasCommand: () => true,
  // Explicitly injected rather than inherited (#41): `$TMUX` is set in every shell a
  // developer runs this suite from inside tmux, and it is the knob step 2 keys on.
  processEnv: {},
  isTTY: true,
  ...overrides,
})

describe('ralph live — step 1: no tmux binary (#167)', () => {
  it('refuses, names tmux, points at `ralph doctor`, and exits non-zero', async () => {
    const d = deps({ hasCommand: () => false })
    const error = await liveCommand(d).catch((e) => e)
    expect(error).toBeInstanceOf(LiveAbort)
    expect(error.exitCode).toBe(1)
    expect(d.stderr.output()).toContain("'tmux' not found in PATH")
    expect(d.stderr.output()).toContain('ralph doctor')
  })

  it('spawns nothing at all — not even the toplevel probe', async () => {
    // The PATH check is pure, so it costs nothing to run first, and running it first is
    // what keeps the refusal from being preceded by two spawns of a binary that is not
    // there. `ralph live` on a machine with no tmux gets one named answer, not tmux's
    // ENOENT twice over.
    const d = deps({ hasCommand: () => false })
    await liveCommand(d).catch(() => {})
    expect(d.exec.keys()).toEqual([])
    expect(d.stdout.output()).toBe('')
  })

  it('asks about tmux and nothing else', async () => {
    const asked = []
    const d = deps({
      hasCommand: (cmd) => {
        asked.push(cmd)
        return false
      },
    })
    await liveCommand(d).catch(() => {})
    expect(asked).toEqual(['tmux'])
  })
})

describe('ralph live — step 2: already inside tmux (#167)', () => {
  const INSIDE = { TMUX: '/private/tmp/tmux-501/default,74212,0' }

  it('refuses rather than nesting, and exits non-zero', async () => {
    const d = deps({ processEnv: INSIDE })
    const error = await liveCommand(d).catch((e) => e)
    expect(error).toBeInstanceOf(LiveAbort)
    expect(error.exitCode).toBe(1)
    expect(d.exec.at(ATTACH)).toBe(undefined)
  })

  it('carries the exact `tmux switch-client` line for THIS repo, plus the detach hint', async () => {
    const d = deps({ processEnv: INSIDE })
    await liveCommand(d).catch(() => {})
    const out = d.stderr.output()
    expect(out).toContain(`tmux switch-client -t ${SESSION}`)
    // The same detach wording `ralph start`'s launch box prints, so a reader who has
    // seen one has seen the other.
    expect(out).toContain('Ctrl+B then D')
  })

  it('names the session of the repo containing the cwd, not the cwd', async () => {
    const d = deps({ processEnv: INSIDE })
    await liveCommand(d).catch(() => {})
    expect(d.stderr.output()).toContain(`tmux switch-client -t ${sessionNameFor(REPO)}`)
    expect(d.stderr.output()).not.toContain(sessionNameFor(SUBDIR))
  })

  it('answers the SESSION question first: a dead session gets step 4, not this refusal', async () => {
    // The remedy this arm exists to print is `switch-client -t <session>`, and tmux answers
    // `can't find session` to that when the session is gone — so a user inside tmux whose
    // loop has stopped would be handed a command that fails and would never be told the
    // thing that matters. Being inside tmux only changes the answer when there is a live
    // session to switch to.
    const d = deps({ processEnv: INSIDE, exec: makeExec({ hasSessionResult: { exitCode: 1 } }) })
    const result = await liveCommand(d)
    expect(result).toEqual({ exitCode: 0, attached: false, session: SESSION })
    expect(d.stderr.output()).toBe('')
    expect(d.stdout.output()).toContain(`No tmux session '${SESSION}' running`)
    expect(d.exec.at(ATTACH)).toBe(undefined)
  })

  const notInside = {
    'TMUX is absent': {},
    'TMUX is present but empty': { TMUX: '' },
    'TMUX is whitespace only': { TMUX: '   ' },
  }

  for (const [label, processEnv] of Object.entries(notInside)) {
    it(`treats "${label}" as NOT inside tmux`, async () => {
      // An empty `$TMUX` names no socket. It is the shape a shell leaves behind after
      // `export TMUX=` or `unset`-adjacent tooling, and reading it as "inside tmux"
      // would refuse to attach for a user who is not in tmux at all.
      const d = deps({ processEnv })
      const result = await liveCommand(d)
      expect(result.attached).toBe(true)
      expect(d.exec.at(ATTACH)).not.toBe(undefined)
    })
  }
})

describe('ralph live — step 3: not a terminal (#167)', () => {
  it('refuses with a message about the terminal, before spawning tmux attach', async () => {
    // `ralph live | cat`, a git hook, a CI step. Without this the user gets tmux's own
    // `open terminal failed: not a terminal`, which says nothing about what they did.
    const d = deps({ isTTY: false })
    const error = await liveCommand(d).catch((e) => e)
    expect(error).toBeInstanceOf(LiveAbort)
    expect(error.exitCode).toBe(1)
    expect(d.stderr.output()).toContain('needs a terminal')
    // The two READ-ONLY probes have already run by now — the inside-tmux refusal above
    // needs the session NAME, so ../repo-session.js answers all three of its questions
    // before either refusal is reached. What must not have happened is the attach, which
    // is the only spawn that could put tmux's own `open terminal failed` on the screen.
    expect(d.exec.keys()).toEqual([TOPLEVEL, HAS])
    expect(d.exec.at(ATTACH)).toBe(undefined)
  })

  it('derives terminal-ness from the resolved streams when nothing is injected', async () => {
    const d = deps({
      isTTY: undefined,
      stdout: makeStream({ isTTY: true }),
      stdin: { isTTY: true },
    })
    expect((await liveCommand(d)).attached).toBe(true)
  })

  const halves = {
    'stdout is not a TTY (piped into another process)': [{ isTTY: false }, { isTTY: true }],
    'stdin is not a TTY (redirected from /dev/null)': [{ isTTY: true }, { isTTY: false }],
    'neither stream is a TTY': [{ isTTY: false }, { isTTY: false }],
    'neither stream says anything about it': [{}, {}],
  }

  for (const [label, [stdoutExtra, stdin]] of Object.entries(halves)) {
    it(`refuses when ${label}`, async () => {
      // tmux needs a real terminal on BOTH ends, so either half missing is a refusal.
      const d = deps({ isTTY: undefined, stdout: makeStream(stdoutExtra), stdin })
      const error = await liveCommand(d).catch((e) => e)
      expect(error).toBeInstanceOf(LiveAbort)
      expect(d.exec.at(ATTACH)).toBe(undefined)
    })
  }
})

describe('ralph live — step 4: no live session is a benign no-op (#167)', () => {
  const dead = { hasSessionResult: { exitCode: 1, stderr: "can't find session" } }

  it('prints one line naming the session, `ralph status`, `ralph start` and the directory, and exits 0', async () => {
    const d = deps({ exec: makeExec(dead) })
    const result = await liveCommand(d)
    expect(result).toEqual({ exitCode: 0, attached: false, session: SESSION })
    // ONE line, the way `ralph stop` already reports the same absence: there is nothing
    // wrong with a repo whose loop is not running.
    expect(d.stdout.lines()).toHaveLength(1)
    expect(d.stdout.output()).toContain(`No tmux session '${SESSION}' running`)
    expect(d.stdout.output()).toContain('ralph status')
    expect(d.stdout.output()).toContain('ralph start')
    expect(d.stderr.output()).toBe('')
  })

  it('offers `ralph status` BEFORE `ralph start`, because only one of them can start a duplicate', async () => {
    // "No session under this name" is a weaker claim than "no loop". A loop launched by
    // `ralph start` in a subdirectory runs under `sessionNameFor(cwd)` (start.js:679, spent
    // at :983) and is invisible here, but NOT to `ralph status`: templates/ralph.sh:57
    // anchors `PROJECT_ROOT` on the git toplevel wherever it was launched from and records
    // the run there (ralph.sh:395-398), and status.js:305,312 reads `record?.session ||
    // sessionNameFor(root)` off that same toplevel. Meanwhile templates/ralph.sh takes no
    // lock of its own and `ralph start`'s only guard is a `has-session` on its own
    // cwd-derived name (start.js:703), so a `ralph start` at the root over a
    // subdirectory-launched loop puts a SECOND agent loop on one working tree. Order is the
    // whole mitigation available inside #167's scope, so it is asserted rather than left to
    // read nicely.
    const d = deps({ exec: makeExec(dead) })
    await liveCommand(d)
    const line = d.stdout.lines()[0]
    expect(line.indexOf('ralph status')).toBeGreaterThan(-1)
    expect(line.indexOf('ralph status')).toBeLessThan(line.indexOf('ralph start'))
  })

  it('names the REPO ROOT as the place to run `ralph start`, not the cwd it was typed in', async () => {
    // Without the directory the advice is wrong from a subdirectory: `ralph start` hashes
    // the cwd it is handed (start.js:679) while this line's session name is the hash of the
    // toplevel, so an unqualified `ralph start` typed in `lib/commands` opens a SECOND loop
    // under a different name instead of the one just reported missing.
    const d = deps({ cwd: SUBDIR, exec: makeExec(dead) })
    await liveCommand(d)
    expect(d.stdout.output()).toContain(REPO)
    expect(d.stdout.output()).not.toContain(SUBDIR)
  })

  it('never spawns the attach', async () => {
    const d = deps({ exec: makeExec(dead) })
    await liveCommand(d)
    expect(d.exec.keys()).toEqual([TOPLEVEL, HAS])
  })

  const noSession = {
    'tmux exited 1 (no such session)': { exitCode: 1 },
    'tmux exited 127': { exitCode: 127, stderr: 'tmux: command not found' },
    'tmux answered with an execa failure shape': { failed: true },
    'tmux timed out': { timedOut: true, failed: true },
  }

  for (const [label, hasSessionResult] of Object.entries(noSession)) {
    it(`treats "${label}" as no live session`, async () => {
      const d = deps({ exec: makeExec({ hasSessionResult }) })
      expect(await liveCommand(d)).toEqual({ exitCode: 0, attached: false, session: SESSION })
    })
  }
})

describe('ralph live — step 5: the attach, and the notice after it (#167)', () => {
  it('spawns `tmux attach -t <session>` with inherited stdio', async () => {
    const d = deps()
    await liveCommand(d)
    const attach = d.exec.at(ATTACH)
    expect(attach.args).toEqual(['attach', '-t', SESSION])
    expect(attach.options.stdio).toBe('inherit')
    // `reject: false` so tmux's exit code reaches the caller as a value rather than as
    // an exception — this command's exit code IS tmux's.
    expect(attach.options.reject).toBe(false)
    // Never through a shell: the session is one argv element.
    expect(attach.options.shell).toBe(undefined)
  })

  it('probes, attaches, then probes again — in that order', async () => {
    // Four spawns and no more: the toplevel, the liveness probe that decides there is
    // something to attach to, the attach, and the probe that decides which closing notice
    // is true. The second `has-session` is not a re-check of the first — it is asked about a
    // different moment in time, after tmux has handed the terminal back.
    const d = deps()
    await liveCommand(d)
    expect(d.exec.keys()).toEqual([TOPLEVEL, HAS, ATTACH, HAS])
  })

  const codes = {
    'tmux exited 0 (clean detach)': [{ exitCode: 0 }, 0],
    'tmux exited 1': [{ exitCode: 1 }, 1],
    'tmux exited 3': [{ exitCode: 3 }, 3],
    'tmux reported no exit code at all': [{ failed: true }, 1],
    'tmux answered with an empty result': [{}, 1],
  }

  for (const [label, [attachResult, exitCode]] of Object.entries(codes)) {
    it(`exits with tmux's own code when ${label}`, async () => {
      const d = deps({ exec: makeExec({ attachResult }) })
      const result = await liveCommand(d)
      expect(result).toEqual({ exitCode, attached: true, session: SESSION })
    })
  }

  it('says the loop is still running only when tmux still has the session afterwards', async () => {
    const d = deps()
    await liveCommand(d)
    const out = d.stdout.output()
    expect(out).toContain('still running')
    expect(out).toContain(`'${SESSION}'`)
    expect(out).toContain('ralph status')
    expect(out).toContain('ralph stop')
    expect(d.stderr.output()).toBe('')
  })

  it('says the session is GONE when the loop ended under the client, though tmux still exited 0', async () => {
    // Measured against tmux 3.6b on an isolated socket: a session whose own process exits
    // while a client is attached, and a session another client kills while a client is
    // attached, both make `tmux attach` exit 0 — the same 0 a deliberate Ctrl+B D gives.
    // templates/ralph.sh:50 makes this the NORMAL ending of a watched run: the loop's EXIT
    // trap kills its own session. So the exit code cannot decide the notice and the fact is
    // asked for instead.
    const d = deps({
      exec: makeExec({ attachResult: { exitCode: 0 }, hasSessionAfterAttach: { exitCode: 1 } }),
    })
    const result = await liveCommand(d)
    expect(result).toEqual({ exitCode: 0, attached: true, session: SESSION })
    const out = d.stdout.output()
    expect(out).not.toContain('still running')
    // Nor an offer to kill what is already dead.
    expect(out).not.toContain('ralph stop')
    expect(out).toContain(`Session '${SESSION}' is gone`)
    expect(out).toContain('ralph status')
    expect(d.stderr.output()).toBe('')
  })

  it('asks tmux again rather than trusting the code it just got', async () => {
    const d = deps()
    await liveCommand(d)
    const probes = d.exec.calls.filter((c) => c.args[0] === 'has-session')
    expect(probes).toHaveLength(2)
    // Captured, not inherited: the answer is a code this command reads, and tmux's own
    // `can't find session` on the terminal would be noise after a detach.
    expect(probes[1].options.stdio).toBe(undefined)
    expect(probes[1].options.reject).toBe(false)
    expect(probes[1].args).toEqual(['has-session', '-t', SESSION])
  })

  const failedAttaches = {
    'tmux exited 1 (the session was already gone)': { exitCode: 1 },
    'tmux reported no exit code at all': { failed: true },
  }

  for (const [label, attachResult] of Object.entries(failedAttaches)) {
    it(`says nothing, and asks nothing more, when ${label}`, async () => {
      // A non-zero code means tmux never got as far as a session, and it has already put
      // its own reason on the inherited stderr. There is no notice to choose between, so
      // there is nothing to ask: the second probe is skipped and this command's exit code
      // carries the answer.
      const d = deps({ exec: makeExec({ attachResult }) })
      await liveCommand(d)
      expect(d.stdout.output()).toBe('')
      expect(d.exec.keys()).toEqual([TOPLEVEL, HAS, ATTACH])
    })
  }

  it('prints the notice AFTER tmux returns, never before', async () => {
    // Printed before the attach it would be scrolled off by tmux's own screen, or —
    // worse — land inside the pane. The order is asserted by recording when the write
    // happened relative to the spawn.
    const events = []
    const stdout = makeStream()
    const write = stdout.write
    stdout.write = (s) => {
      events.push(`out:${s.trim()}`)
      return write(s)
    }
    const exec = async (cmd, args = [], options = {}) => {
      events.push(`exec:${cmd} ${args.join(' ')}`)
      if (cmd === 'git') return { exitCode: 0, stdout: `${REPO}\n` }
      return { exitCode: 0 }
    }
    await liveCommand(deps({ stdout, exec }))
    expect(events.filter((e) => e.startsWith('exec:'))).toEqual([
      `exec:${TOPLEVEL}`,
      `exec:${HAS}`,
      `exec:${ATTACH}`,
      `exec:${HAS}`,
    ])
    expect(events.indexOf(`exec:${ATTACH}`)).toBeLessThan(events.findIndex((e) => e.startsWith('out:')))
  })

  it('says nothing on either stream before the attach', async () => {
    // The whole screen belongs to tmux. A `ralph live` that announced itself first would
    // put a line above a full-screen pane the user can never scroll back to.
    const events = []
    const tap = (label) => {
      const stream = makeStream()
      stream.write = (s) => {
        events.push(`${label}:${s.trim()}`)
        return true
      }
      return stream
    }
    const exec = async (cmd, args = []) => {
      events.push(`exec:${cmd} ${args.join(' ')}`)
      if (cmd === 'git') return { exitCode: 0, stdout: `${REPO}\n` }
      return { exitCode: 0 }
    }
    await liveCommand(deps({ stdout: tap('out'), stderr: tap('err'), exec }))
    const printed = events.findIndex((e) => !e.startsWith('exec:'))
    expect(printed, 'nothing was printed at all').toBeGreaterThan(-1)
    // Every spawn this command makes happens before its first written line — including the
    // post-attach probe, which is what the first written line is chosen by.
    expect(events.slice(0, printed)).toEqual([
      `exec:${TOPLEVEL}`,
      `exec:${HAS}`,
      `exec:${ATTACH}`,
      `exec:${HAS}`,
    ])
  })
})

describe('ralph live — the repo, from any directory inside it (#167)', () => {
  it('anchors on the git toplevel, probed in the directory it was handed', async () => {
    const d = deps()
    await liveCommand(d)
    expect(d.exec.at(TOPLEVEL).options.cwd).toBe(SUBDIR)
    expect(d.exec.at(HAS).args).toEqual(['has-session', '-t', sessionNameFor(REPO)])
  })

  it('behaves identically from the repo root and from a subdirectory', async () => {
    // The acceptance criterion, stated as an equality rather than as two assertions: the
    // spawns and the printed text must not depend on which directory you typed the
    // command in, only on which repo it is.
    const runs = []
    for (const cwd of [REPO, SUBDIR, '/repo/lib', '/repo/test/commands']) {
      const d = deps({ cwd })
      const result = await liveCommand(d)
      runs.push({ result, keys: d.exec.keys(), out: d.stdout.output() })
    }
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0])
  })

  it('falls back to the cwd outside a git work tree', async () => {
    const cwd = '/tmp/not-a-repo'
    const session = sessionNameFor(cwd)
    const d = deps({
      cwd,
      exec: makeExec({ gitResult: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }),
    })
    const result = await liveCommand(d)
    expect(result.session).toBe(session)
    expect(d.exec.keys()).toEqual([
      TOPLEVEL,
      `tmux has-session -t ${session}`,
      `tmux attach -t ${session}`,
      `tmux has-session -t ${session}`,
    ])
  })

  it('never touches another repo\'s session', async () => {
    const d = deps()
    await liveCommand(d)
    const other = sessionNameFor('/other-project')
    expect(d.exec.keys().some((k) => k.includes(other))).toBe(false)
  })
})

describe('ralph live — a session name from a directory named anything (#167)', () => {
  // A repo directory can be called anything, and every message that names the session
  // has to carry the derived name VERBATIM — the byte the user pastes into tmux.
  const hostile = '/Users/me/repos/my repo (1); rm -rf $HOME #'
  const session = sessionNameFor(hostile)
  const exec = (overrides) => makeExec({ gitResult: { exitCode: 0, stdout: `${hostile}\n` }, ...overrides })

  it('interpolates it into the inside-tmux refusal', async () => {
    const d = deps({ cwd: hostile, exec: exec(), processEnv: { TMUX: '/tmp/tmux-501/default,1,0' } })
    await liveCommand(d).catch(() => {})
    expect(d.stderr.output()).toContain(`tmux switch-client -t ${session}`)
  })

  it('interpolates it into the no-session notice', async () => {
    const d = deps({ cwd: hostile, exec: exec({ hasSessionResult: { exitCode: 1 } }) })
    await liveCommand(d)
    expect(d.stdout.output()).toContain(`No tmux session '${session}' running`)
  })

  it('interpolates it into the closing notice, and spawns it as one argv element', async () => {
    const d = deps({ cwd: hostile, exec: exec() })
    await liveCommand(d)
    expect(d.stdout.output()).toContain(`'${session}'`)
    expect(d.exec.at(`tmux attach -t ${session}`).args).toEqual(['attach', '-t', session])
  })
})

describe('ralph live — CLI registration (#167)', () => {
  const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))

  it('appears in `ralph --help` with a one-line description', async () => {
    const result = await execa('node', [BIN, '--help'], { reject: false })
    expect(result.exitCode).toBe(0)
    const line = result.stdout.split('\n').find((l) => /^\s+live\b/.test(l))
    expect(line, '`ralph --help` no longer lists a live command').not.toBe(undefined)
    expect(line.replace(/^\s+live\s+/, '').trim().length).toBeGreaterThan(0)
  })

  it('takes no arguments and no flags of its own', async () => {
    const result = await execa('node', [BIN, 'live', '--help'], { reject: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage: ralph live')
    // `-h, --help` is commander's; anything else would be a flag #167 did not specify.
    const flags = result.stdout.match(/--[a-z][\w-]*/g) ?? []
    expect([...new Set(flags)]).toEqual(['--help'])
  })
})
