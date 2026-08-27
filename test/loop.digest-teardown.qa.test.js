import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

// QA augmentation for #62's teardown fix — the EXIT trap at templates/ralph.sh:16-38.
//
// The fix moved session teardown from the last line of the file into a trap, which is
// the right shape and also the widest behavioural change in the slice: teardown now
// happens on EVERY exit of EVERY run, not just the one path that used to reach the
// bottom of the file. So the interesting questions are no longer "does an abort kill
// the session" (the dev's test/loop.digest-teardown.test.js covers that) but what
// ELSE moved with it:
//
//   • does the trap change the run's exit status — including when tmux itself fails,
//     or is not installed at all?
//   • does it fire BEFORE the end-of-run notifications it used to sit after?
//   • can it fire twice, or fire for a run that owns no session?
//   • is the session name safe inside the trap's shell string?
//   • does it cover the ways a human and tmux actually end a run — Ctrl+C, `ralph
//     stop`, a killed pane — and not only `exit`?
//
// Same stubbed-PATH shape as the dev's file and test/loop.test.js: git/node/tmux/gh
// are shadowed on PATH and the tmux stub is a recorder, so nothing here talks to a
// real multiplexer, a real agent or the network. The recorder logs ARGC and each
// argument separately (the dev's logs `$*`), because half of what is asked below is
// whether the session name survived as ONE argument.

const RALPH_TEMPLATE = templatePath('ralph.sh')
const SESSION = 'ralph-qa-teardown'
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

const logPath = () => join(workdir, 'order.log')
const logLines = () => {
  const f = logPath()
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean)
}
const killLines = () => logLines().filter((l) => l.startsWith('tmux:'))

// Every stub appends to ONE log, so the questions about ORDER (did teardown wait for
// the notifications?) are answered by reading it top to bottom.
function seedTmuxRecorder() {
  const log = logPath()
  writeStub(
    'tmux',
    `#!/bin/bash
printf 'tmux:ARGC=%s\\n' "$#" >> "${log}"
for a in "$@"; do printf 'tmux:ARG[%s]\\n' "$a" >> "${log}"; done
exit 0
`,
  )
}

function seedGitAtRoot() {
  writeStub(
    'git',
    `#!/bin/bash
if [ "$1" = "rev-parse" ]; then echo "${workdir}"; exit 0; fi
exit 0
`,
  )
}

// The abort a real user hits: a git root, but no resolvable agent bridge.
function seedAgentResolutionFailure() {
  seedGitAtRoot()
  writeStub('node', `#!/bin/bash\necho "node: cannot find module" >&2\nexit 1\n`)
}

// A complete, empty-queue run: reaches the end-of-run notifications and the trap.
function seedCleanRun() {
  seedGitAtRoot()
  writeStub(
    'node',
    `#!/bin/bash
case "$*" in
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
esac
exit 0
`,
  )
  writeStub('gh', `#!/bin/bash\nif [ "$1" = "issue" ]; then echo "0"; fi\nexit 0\n`)
  writeStub('jq', `#!/bin/bash\necho "encoded-message"\nexit 0\n`)
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-qa-teardown-'))
  bindir = join(workdir, 'bin')
  mkdirSync(bindir, { recursive: true })
  seedTmuxRecorder()
})

afterEach(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true })
})

function loopEnv({ session = SESSION, once = false, extra = {} } = {}) {
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    HOME: join(workdir, 'home'),
    XDG_CONFIG_HOME: join(workdir, 'xdg'),
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    ...extra,
  }
  if (session) env.RALPH_TMUX_SESSION = session
  else delete env.RALPH_TMUX_SESSION
  if (once) env.RALPH_ONCE = '1'
  else delete env.RALPH_ONCE
  return env
}

function runLoop({ session = SESSION, once = false, flag = false, extra = {}, timeout = 20000 } = {}) {
  return spawnSync('bash', flag ? [RALPH_TEMPLATE, '--once'] : [RALPH_TEMPLATE], {
    cwd: workdir,
    env: loopEnv({ session, once, extra }),
    timeout,
    encoding: 'utf8',
  })
}

describe('QA ralph.sh teardown — the trap must not change what a run REPORTS (#62)', () => {
  it('leaves an aborting run aborting and a clean run clean', async () => {
    // The trap runs a command, and a command has an exit status. If that status leaked
    // into the script's, `ralph start`'s abort would look like a success to `ralph
    // cycle`, to a watchdog and to the run record — the loudest possible regression
    // from a change whose whole point was tidying up quietly.
    seedAgentResolutionFailure()
    const aborted = runLoop()
    expect(aborted.status).toBe(1)
    expect(killLines().filter((l) => l.includes('kill-session'))).toHaveLength(1)

    rmSync(logPath(), { force: true })
    seedCleanRun()
    const clean = runLoop()
    expect(clean.status).toBe(0)
    expect(clean.stdout).toContain('Queue empty, exiting.')
  })

  it('leaves the exit status alone even when tmux itself fails', () => {
    // `|| true` in the trap is what makes this true, and it is one character away from
    // not being: a session that has already died — the ordinary case for `ralph stop`,
    // which kills it from outside — makes kill-session exit non-zero.
    seedAgentResolutionFailure()
    writeStub('tmux', '#!/bin/bash\necho "no such session" >&2\nexit 1\n')
    const res = runLoop()
    expect(res.status).toBe(1)
    expect(res.stderr).not.toContain('no such session')

    seedCleanRun()
    writeStub('tmux', '#!/bin/bash\nexit 3\n')
    const clean = runLoop()
    expect(clean.status).toBe(0)
  })

  it('survives a tmux that is not installed at all, silently', () => {
    // A loop started by `ralph start` always has tmux; a loop whose PATH was rewritten
    // mid-run, or a container that lost it, does not. The trap must not turn that into
    // a `command not found` on the reader's last screen or into a failed run.
    seedAgentResolutionFailure()
    rmSync(join(bindir, 'tmux'), { force: true })
    const res = runLoop()
    expect(res.status).toBe(1)
    expect(res.stderr).not.toMatch(/tmux/)
    expect(res.stderr).not.toMatch(/command not found/)
  })

  it('never trips `set -u` inside the trap', () => {
    // The trap body expands the captured session name under `set -u`, in a frame that
    // runs after everything else has been unset or gone wrong. `set -u` is what makes
    // "captured in the same branch that installs the trap" load-bearing rather than
    // tidy: an expansion of a name that was never assigned aborts the trap.
    seedAgentResolutionFailure()
    const res = runLoop()
    expect(res.stderr).not.toMatch(/unbound variable/)
    expect(res.stderr).not.toMatch(/ralph\.sh: line/)
  })
})

describe('QA ralph.sh teardown — order and count (#62)', () => {
  it('kills the session AFTER the end-of-run notifications, not during them', () => {
    // The teardown used to be the last line of the file, below WhatsApp and the
    // project's own hook. As a trap it fires when the shell exits — which is still
    // after them, and this is the test that keeps it there: killing the session first
    // would cut the notification off mid-flight, and the notification is the whole
    // reason anyone runs the loop detached.
    seedCleanRun()
    writeStub('curl', `#!/bin/bash\nprintf 'whatsapp\\n' >> "${logPath()}"\nexit 0\n`)
    writeFileSync(
      join(workdir, 'ralph-notify.sh'),
      `#!/bin/bash\nprintf 'notify\\n' >> "${logPath()}"\nexit 0\n`,
      { mode: 0o755 },
    )
    chmodSync(join(workdir, 'ralph-notify.sh'), 0o755)

    const res = runLoop({ extra: { CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' } })
    expect(res.status).toBe(0)
    const lines = logLines()
    expect(lines).toContain('whatsapp')
    expect(lines).toContain('notify')
    // Both hooks ran, and the kill is strictly after both of them.
    const firstKill = lines.findIndex((l) => l.includes('kill-session'))
    expect(firstKill).toBeGreaterThan(lines.indexOf('whatsapp'))
    expect(firstKill).toBeGreaterThan(lines.indexOf('notify'))
    // And teardown is the last thing the run does: the recorder logs the argument
    // count and then each argument, so the session name closes the log.
    expect(lines.slice(-4)).toEqual([
      'tmux:ARGC=3',
      'tmux:ARG[kill-session]',
      'tmux:ARG[-t]',
      `tmux:ARG[${SESSION}]`,
    ])
  })

  it('kills the session exactly once on a clean run', () => {
    // The old explicit `tmux kill-session` line was deleted when the trap arrived. If
    // it had been left in place the happy path would kill twice — harmless in tmux,
    // and a sign that two sites disagree about who owns teardown.
    seedCleanRun()
    const res = runLoop()
    expect(res.status).toBe(0)
    expect(logLines().filter((l) => l.includes('kill-session'))).toHaveLength(1)
  })

  it('makes exactly one tmux call in its whole life — teardown and nothing else', () => {
    // The digest window is opened by `ralph start`, not from in here. If this loop ever
    // starts talking to tmux itself, the two owners of the session layout have to be
    // read together, and this test is the notice.
    seedCleanRun()
    runLoop()
    const argcLines = logLines().filter((l) => l.startsWith('tmux:ARGC='))
    expect(argcLines).toEqual(['tmux:ARGC=3'])
  })
})

describe('QA ralph.sh teardown — whose session is it (#62)', () => {
  it('does not kill a session in --once mode, on a CLEAN end either', () => {
    // The dev's file proves an aborting `--once` kills nothing. The clean end is the
    // other half: `ralph cycle` runs the loop to completion many times a day, and each
    // of those runs must leave every session on the machine alone.
    seedCleanRun()
    const res = runLoop({ flag: true })
    expect(res.status).toBe(0)
    expect(logLines().filter((l) => l.includes('kill-session'))).toHaveLength(0)
  })

  it('does not kill a session when RALPH_ONCE is set in the ENVIRONMENT', () => {
    // This is the production once-mode path and it is NOT the `--once` flag the dev's
    // test uses: lib/commands/cycle.js spawns the loop with `RALPH_ONCE: '1'` in its
    // env and no argument at all (cycle.js:478). If the guard had keyed on the flag,
    // every scheduled cycle that aborted would kill a session it does not own.
    seedAgentResolutionFailure()
    const aborted = runLoop({ once: true })
    expect(aborted.status).toBe(1)
    expect(logLines().filter((l) => l.includes('kill-session'))).toHaveLength(0)

    rmSync(logPath(), { force: true })
    seedCleanRun()
    const clean = runLoop({ once: true })
    expect(clean.status).toBe(0)
    expect(logLines().filter((l) => l.includes('kill-session'))).toHaveLength(0)
  })

  it('passes a session name with a space as ONE argument', () => {
    // `ralph start` derives the name from the cwd (lib/lock.js sessionNameFor), so a
    // repo under a path with a space in it is the ordinary case, not an attack. Inside
    // the trap the name is expanded into a shell string that has already been parsed
    // once — this is the test that says it stays one word.
    seedAgentResolutionFailure()
    const name = 'ralph qa session'
    const res = runLoop({ session: name })
    expect(res.status).toBe(1)
    expect(logLines()).toEqual([
      'tmux:ARGC=3',
      'tmux:ARG[kill-session]',
      'tmux:ARG[-t]',
      `tmux:ARG[${name}]`,
    ])
  })

  it('passes a session name full of shell metacharacters through verbatim, unexecuted', () => {
    // The value reaches the trap from the environment, and the trap body is a string
    // the shell evaluates at exit. If that string were built by interpolation rather
    // than expansion, this name would run.
    seedAgentResolutionFailure()
    const name = `ralph'; touch ${join(workdir, 'pwned')}; :'$(id)\`id\``
    const res = runLoop({ session: name })
    expect(res.status).toBe(1)
    expect(logLines()).toEqual([
      'tmux:ARGC=3',
      'tmux:ARG[kill-session]',
      'tmux:ARG[-t]',
      `tmux:ARG[${name}]`,
    ])
    expect(existsSync(join(workdir, 'pwned'))).toBe(false)
  })

  it('kills nothing when the session is named only in ralph.config.sh', () => {
    // Pinned, not endorsed, and it is the stated cost of installing the trap early: the
    // guard reads RALPH_TMUX_SESSION from the ENVIRONMENT, near the top of the file,
    // before `set -a; . ./ralph.config.sh` runs — so a session named only in the config
    // is not torn down. That is the right answer for the only supported arrangement
    // (`ralph start` passes the name it created in the command string, and `ralph stop`
    // derives the same name from the cwd, so the config is not a place to name a
    // session), but it is worth a witness, because the pre-#62 teardown ran at the
    // bottom of the file and would have used the sourced value.
    //
    // The companion is the test in loop.digest-teardown.test.js that a config which
    // renames the session does not redirect the kill: same boundary, other side.
    seedAgentResolutionFailure()
    writeFileSync(join(workdir, 'ralph.config.sh'), 'RALPH_TMUX_SESSION="named-in-config"\n')
    const res = runLoop({ session: null })
    expect(res.status).toBe(1)
    expect(logLines().filter((l) => l.includes('kill-session'))).toHaveLength(0)
  })
})

// The ways a run actually ends in the field, none of which are `exit`: Ctrl+C in the
// attached window, `ralph stop` killing the session from outside (the pane gets a
// SIGHUP), a supervisor sending SIGTERM. Before #62 none of them needed teardown,
// because window 0 dying took the session with it. Now the digest window survives all
// three, so if the trap does not cover signals the orphan is back — with the added
// twist that the human thinks they already stopped it.
describe('QA ralph.sh teardown — signals, not just exits (#62)', () => {
  // Blocks after the trap is installed and after the config is sourced: an agent
  // bridge that never answers, which is also a real way for a run to hang.
  function seedHang() {
    seedGitAtRoot()
    writeStub(
      'node',
      `#!/bin/bash
case "$*" in
  *agent-invocation.js*) sleep 3 ;;
esac
exit 0
`,
    )
  }

  function runAndSignal(signal) {
    return new Promise((resolve) => {
      const child = spawn('bash', [RALPH_TEMPLATE], {
        cwd: workdir,
        env: loopEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let settled = false
      const done = (result) => {
        if (settled) return
        settled = true
        clearTimeout(guard)
        resolve(result)
      }
      const guard = setTimeout(() => {
        child.kill('SIGKILL')
        done({ timedOut: true })
      }, 15000)
      child.on('close', (code, sig) => done({ code, sig }))
      // Long enough to be inside the hang, short enough to keep the suite quick.
      setTimeout(() => child.kill(signal), 900)
    })
  }

  it.each([['SIGINT'], ['SIGTERM'], ['SIGHUP']])(
    'tears the session down when the run is ended by %s',
    async (signal) => {
      seedHang()
      const res = await runAndSignal(signal)
      expect(res.timedOut, 'the loop did not end after the signal').toBeFalsy()
      expect(logLines().filter((l) => l.includes('kill-session'))).toHaveLength(1)
      expect(logLines().at(-1)).toBe(`tmux:ARG[${SESSION}]`)
    },
    20000,
  )

  it('kills nothing on a signal in --once mode', async () => {
    // A cycle interrupted mid-run is still a cycle: it owns no session.
    seedHang()
    const res = await new Promise((resolve) => {
      const child = spawn('bash', [RALPH_TEMPLATE], {
        cwd: workdir,
        env: loopEnv({ once: true }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const guard = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ timedOut: true })
      }, 15000)
      child.on('close', (code, sig) => {
        clearTimeout(guard)
        resolve({ code, sig })
      })
      setTimeout(() => child.kill('SIGTERM'), 900)
    })
    expect(res.timedOut).toBeFalsy()
    expect(logLines().filter((l) => l.includes('kill-session'))).toHaveLength(0)
  }, 20000)
})
