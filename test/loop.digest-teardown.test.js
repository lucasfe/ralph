import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

// #62 — the loop must take its SESSION down when it aborts, not just when it finishes.
//
// Before #62 window 0 was the session's only window, so any `exit` ended the session
// with it and only the happy path needed an explicit `tmux kill-session`. The digest
// window changed that arithmetic: window 1 keeps the session alive, so an abort left
// `ralph digest --loop` narrating a run that never started — on a timer, calling a
// paid model — and left the session name taken, which makes the next `ralph start`
// refuse as "already running" until someone runs `ralph stop`.
//
// Two facts, and they pull in opposite directions, which is why they are tested
// together: every abort under `ralph start` must tear the session down, and `--once`
// (the path `ralph cycle` drives) must NEVER tear one down — it is not running inside
// a session, and the one it might name could be somebody else's.
//
// Same stubbed-PATH harness as test/loop.test.js: git/node/tmux are shadowed on PATH,
// and the tmux stub is a recorder, so no test here talks to a real multiplexer.

const RALPH_TEMPLATE = templatePath('ralph.sh')
const SESSION = 'ralph-digest-teardown-test'
// The real node, so the one bridge the loop cannot do without can still run while
// `node` on PATH is a stub for everything else.
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

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-digest-teardown-'))
  bindir = join(workdir, 'bin')
  mkdirSync(bindir, { recursive: true })
  // Every tmux call, recorded. Exits 0 so the loop cannot tell the difference.
  writeStub('tmux', `#!/bin/bash\necho "$*" >> "${join(workdir, 'tmux.log')}"\nexit 0\n`)
})

afterEach(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true })
})

function runLoop({ once = false, session = SESSION, timeout = 20000 } = {}) {
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    // A HOME of its own, and NOT the workdir: the loop refuses to run with
    // PROJECT_ROOT == $HOME, which would abort it one guard earlier than intended.
    HOME: join(workdir, 'home'),
    XDG_CONFIG_HOME: join(workdir, 'xdg'),
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
  }
  if (session) env.RALPH_TMUX_SESSION = session
  else delete env.RALPH_TMUX_SESSION
  const args = once ? [RALPH_TEMPLATE, '--once'] : [RALPH_TEMPLATE]
  return spawnSync('bash', args, { cwd: workdir, env, timeout, encoding: 'utf8' })
}

const tmuxLog = () => {
  const f = join(workdir, 'tmux.log')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

// The abort a real user hits: a git root exists, but the agent bridge cannot be
// resolved (no node, a broken install, an unknown RALPH_AGENT). The loop exits 1
// from the middle of its startup — with a digest window already open beside it.
function seedAgentResolutionFailure() {
  writeStub(
    'git',
    `#!/bin/bash
if [ "$1" = "rev-parse" ]; then echo "${workdir}"; exit 0; fi
exit 0
`,
  )
  writeStub('node', `#!/bin/bash\necho "node: cannot find module" >&2\nexit 1\n`)
}

describe('ralph.sh — the session dies on EVERY exit, now that a digest window shares it (#62)', () => {
  it('kills the session by name when the agent bridge cannot be resolved', () => {
    seedAgentResolutionFailure()
    const res = runLoop()
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('failed to resolve agent invocation')
    expect(tmuxLog()).toContain(`kill-session -t ${SESSION}`)
  })

  it('kills the session by name when it refuses to run outside a git repository', () => {
    // The earliest abort in the file, before anything is read or resolved: proof the
    // teardown covers the paths that run before the loop has any state at all.
    writeStub('git', `#!/bin/bash\nexit 128\n`)
    const res = runLoop()
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('not inside a git repository')
    expect(tmuxLog()).toContain(`kill-session -t ${SESSION}`)
  })

  it('kills it exactly once, so teardown cannot be a race with itself', () => {
    seedAgentResolutionFailure()
    runLoop()
    const kills = tmuxLog().split('\n').filter((l) => l.includes('kill-session'))
    expect(kills).toHaveLength(1)
  })

  it('still kills the session when the run ends normally', () => {
    // The teardown moved from the last line of the file into the trap, so the path
    // that ALWAYS worked needs a witness of its own: an empty queue, a clean end, and
    // the session still taken down by name.
    writeStub(
      'git',
      `#!/bin/bash
if [ "$1" = "rev-parse" ]; then echo "${workdir}"; exit 0; fi
exit 0
`,
    )
    // The agent bridge must resolve for real — it is the loop's only hard dependency
    // before the queue — so that one call goes to the real node and nothing else does.
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
    writeStub('jq', `#!/bin/bash\nexit 0\n`)
    const res = runLoop()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(tmuxLog()).toContain(`kill-session -t ${SESSION}`)
  })

  it('never kills a session in --once mode, whatever the environment names', () => {
    // `ralph cycle` drives `--once` and does NOT run inside a tmux session; a stale
    // RALPH_TMUX_SESSION in the ambient environment must not make an aborting cycle
    // kill somebody else's session.
    seedAgentResolutionFailure()
    const res = runLoop({ once: true })
    expect(res.status).not.toBe(0)
    expect(tmuxLog()).not.toContain('kill-session')
  })

  it('kills nothing when no session was named — a hand-run loop owns no session', () => {
    // `bash templates/ralph.sh` outside `ralph start`: there is no session to take
    // down, and `kill-session -t ralph` would be a guess at somebody else's.
    seedAgentResolutionFailure()
    const res = runLoop({ session: null })
    expect(res.status).not.toBe(0)
    expect(tmuxLog()).not.toContain('kill-session')
  })

  it('tears down the session it is RUNNING IN, not one ralph.config.sh renamed', () => {
    // The trap is installed at the top of the file; ralph.config.sh is sourced ~70 lines
    // later with `set -a`. So the guard that decides whether to install the trap reads
    // one value and — if the trap body re-expanded the variable at exit — the body would
    // read another. A config that assigns RALPH_TMUX_SESSION would then make an aborting
    // loop kill a session it has nothing to do with and leave its own alive, with the
    // digest window still narrating inside it and the name still taken.
    //
    // Capturing the name once at install time is what makes the guard and the body one
    // decision. Asserted as both halves, because "killed the right one" and "did not
    // kill the wrong one" are different failures.
    seedAgentResolutionFailure()
    writeFileSync(
      join(workdir, 'ralph.config.sh'),
      'RALPH_TMUX_SESSION="somebody-elses-session"\n',
    )
    const res = runLoop()
    expect(res.status).not.toBe(0)
    expect(tmuxLog()).toContain(`kill-session -t ${SESSION}`)
    expect(tmuxLog()).not.toContain('somebody-elses-session')
  })

  it('kills the SESSION and never a window or a pane, on every path', () => {
    // The invariant that makes #62's teardown work at all: a session takes its windows
    // with it, so one `kill-session` reaches the digest window without this script
    // knowing the window exists. A `kill-window` or `kill-pane` here would close window
    // 0 and leave window 1 narrating a run that ended.
    //
    // Proved by RUNNING the script against the recording stub rather than by greping its
    // source, so a comment mentioning `kill-window` cannot fail it and a real call
    // cannot hide from it.
    seedAgentResolutionFailure()
    runLoop()
    const aborted = tmuxLog()
    expect(aborted).toContain('kill-session')
    expect(aborted).not.toMatch(/kill-window|kill-pane|kill-server/)

    rmSync(join(workdir, 'tmux.log'), { force: true })
    writeStub(
      'git',
      `#!/bin/bash
if [ "$1" = "rev-parse" ]; then echo "${workdir}"; exit 0; fi
exit 0
`,
    )
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
    writeStub('jq', `#!/bin/bash\nexit 0\n`)
    const clean = runLoop()
    expect(clean.status).toBe(0)
    expect(tmuxLog()).toContain('kill-session')
    expect(tmuxLog()).not.toMatch(/kill-window|kill-pane|kill-server/)
  })
})
