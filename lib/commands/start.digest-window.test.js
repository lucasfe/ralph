import { describe, it, expect } from 'vitest'
import { execa } from 'execa'
import { startCommand } from './start.js'
import { stopCommand } from './stop.js'
import { sessionNameFor } from '../lock.js'

// #62 — the digest gets a window, not a lifecycle. `ralph start` already opens a
// detached tmux session for the loop; when ralph.config.sh asks for a digest
// interval it opens ONE more window in that SAME session running `ralph digest
// --loop`. That choice is the whole design: tmux is already a hard dependency of
// `ralph start`, so this works identically on macOS, Linux and WSL2; there is
// nothing to install and nothing to uninstall; `ralph stop` and the loop's own
// end-of-run `tmux kill-session` already reach it; and attaching shows the agent
// stream and the narration side by side.
//
// The digest NEVER costs a launch. Every failure here — an interval nobody can
// parse, a tmux that refuses, a tmux that throws — is one warning and a loop that
// runs anyway.

const REPO = '/repo'
const HOME = '/home/me'
const SESSION = sessionNameFor(REPO)
const RALPH_BIN = '/usr/local/bin/ralph'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

// tmux guard finds nothing, the loop window launches, everything else is a no-op.
// `newWindow` is what a hostile tmux does to the SECOND window only.
function makeExec({ newWindow = { exitCode: 0, stdout: '', stderr: '' } } = {}) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd === 'tmux' && args[0] === 'new-window') {
      if (typeof newWindow === 'function') return newWindow({ cmd, args, options })
      return newWindow
    }
    // A github-sourced queue with three issues and no orphans, for the cases that
    // exercise a config with no TASK_SOURCE in it at all.
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
      return { exitCode: 0, stdout: '3', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

// Driven through the folder source so the queue is a dependency rather than a `gh`
// stub — the digest window is source-independent.
const deps = ({
  config = 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n',
  newWindow,
  ...overrides
} = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const exec = makeExec(newWindow ? { newWindow } : {})
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec,
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? config : ''),
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    update: async () => ({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'disabled',
      updatedCache: null,
    }),
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => 3,
    home: HOME,
    processEnv: {},
    // #62: the binary the digest window runs, injected exactly like schedule.js's
    // `ralphBinary`, so no assertion in this file depends on how vitest was spawned.
    ralphBinary: RALPH_BIN,
    ...overrides,
  }
}

const windowCalls = (d) => d.exec.calls.filter((c) => c.cmd === 'tmux' && c.args[0] === 'new-window')
const loopCall = (d) => d.exec.calls.find((c) => c.cmd === 'tmux' && c.args[0] === 'new')

describe('startCommand — the digest window (#62)', () => {
  it('opens a second window running `ralph digest --loop` on the configured interval', async () => {
    const d = deps()
    const result = await startCommand(d)

    expect(result.started).toBe(true)
    const opened = windowCalls(d)
    expect(opened).toHaveLength(1)
    const args = opened[0].args
    // Detached, so the loop's window stays the one you land on when you attach.
    expect(args).toContain('-d')
    // Named, because an index is not a promise: a user's own base-index setting
    // moves the number, and `tmux kill-window -t <session>:digest` should keep
    // working whatever it is.
    expect(args[args.indexOf('-n') + 1]).toBe('digest')
    const command = args[args.length - 1]
    expect(command).toContain(`cd '${REPO}'`)
    expect(command).toContain(RALPH_BIN)
    expect(command).toContain('digest')
    expect(command).toContain('--loop')
    expect(command).toMatch(/--interval\s+'?30m'?/)
  })

  it('opens it AFTER the loop window, and only when that launch succeeded', async () => {
    const d = deps()
    await startCommand(d)
    const keys = d.exec.calls.map((c) => c.key)
    const loopIdx = keys.findIndex((k) => k.startsWith('tmux new -d'))
    const digestIdx = keys.findIndex((k) => k.startsWith('tmux new-window'))
    expect(loopIdx).toBeGreaterThan(-1)
    expect(digestIdx).toBeGreaterThan(loopIdx)
  })

  it('never opens a digest window when the loop window failed to launch', async () => {
    // The digest keeps the loop company; with no loop there is nothing to narrate,
    // and the launch is aborting anyway.
    const calls = []
    const exec = async (cmd, args, options = {}) => {
      calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (cmd === 'tmux' && args[0] === 'new') return { exitCode: 1, stdout: '', stderr: 'no server' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    exec.calls = calls
    const d = deps({ exec })
    await expect(startCommand(d)).rejects.toThrow()
    expect(calls.some((c) => c.args[0] === 'new-window')).toBe(false)
  })

  it('forwards RALPH_DIGEST_MODEL from the config into the window it opens', async () => {
    // The window inherits `ralph start`'s environment, not ralph.config.sh — the
    // loop gets the file because templates/ralph.sh sources it, and nothing sources
    // anything for the digest. So the model the config asks for has to travel with
    // the command, or the documented knob would only ever work for a user who also
    // exported it by hand.
    const d = deps({
      config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\nRALPH_DIGEST_MODEL="sonnet"\n',
    })
    await startCommand(d)
    const command = windowCalls(d)[0].args.at(-1)
    expect(command).toContain("RALPH_DIGEST_MODEL='sonnet'")
    // ...and the assignment stays in front of the binary, where a shell reads it as
    // that command's environment rather than as an argument.
    expect(command.indexOf('RALPH_DIGEST_MODEL=')).toBeLessThan(command.indexOf(RALPH_BIN))
  })

  it('passes no model at all when the config names none', async () => {
    const d = deps()
    expect(windowCalls(await started(d))[0].args.at(-1)).not.toContain('RALPH_DIGEST_MODEL')
  })

  it('does not let a quote in the configured model escape the command it builds', async () => {
    // The command is a STRING handed to a shell, and the model is a value from a file
    // Ralph does not own. So the invariant is checked the only way that is not
    // wishful thinking: by letting a real shell parse the command Ralph built, with
    // the binary replaced by `echo` so the only thing that can happen is printing.
    const d = deps({
      config: `TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\nRALPH_DIGEST_MODEL=cheap'; echo INJECTED; :'\n`,
      ralphBinary: '/bin/echo',
    })
    await startCommand(d)
    const command = windowCalls(d)[0].args.at(-1).replace(`cd '${REPO}' && `, '')

    const shell = await execa('bash', ['-c', command], { reject: false })
    expect(shell.stdout).not.toContain('INJECTED')
    // ...and the digest still got its arguments.
    expect(shell.stdout).toContain('digest --loop --interval 30m')
  })
})

describe('startCommand — no interval, no window (#62)', () => {
  it.each([
    ['unset', 'TASK_SOURCE=folder\n'],
    ['empty', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=""\n'],
    ['zero', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0\n'],
    ['zero with a unit', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0m\n'],
    ['commented out', 'TASK_SOURCE=folder\n# RALPH_DIGEST_INTERVAL=30m\n'],
    ['no config file at all', ''],
    // A value edited out by hand with a space left behind, or an unset variable
    // interpolated into the quotes. `ralph digest --loop` already reads a blank
    // interval as no interval; the two entry points have to agree, or the box
    // advertises `every    ` and a window that was never opened.
    ['a single space', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=" "\n'],
    ['only whitespace', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="   "\n'],
    ['a tab', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="\t"\n'],
    // In bash a `#` that starts a word starts a comment, so this assignment is
    // empty — the shell that SOURCES this file reads no interval, and neither may we.
    ['a value that is only a comment', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL= # off for now\n'],
  ])('%s: opens exactly one window and says nothing about a digest', async (_label, config) => {
    const d = deps({ config })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(windowCalls(d)).toHaveLength(0)
    expect(d.stdout.output()).not.toContain('Digest')
    expect(d.stderr.output()).toBe('')
  })

  it('leaves the launch box byte-identical to a run before #62', async () => {
    // AC#5: every repo on earth has this config today, so this path is the one that
    // must not move a single character.
    const d = deps({ config: 'TASK_SOURCE=folder\n' })
    await startCommand(d)
    const lines = d.stdout.output().split('\n')
    const box = lines.slice(lines.findIndex((l) => l.startsWith('✅ Ralph started'))).filter(Boolean)
    expect(box).toEqual([
      '✅ Ralph started in background. 3 issues in the queue.',
      '   Progress:       ralph status',
      `   Watch live:     tmux attach -t ${SESSION}`,
      '   Detach:         inside the session, Ctrl+B then D',
      '   List:           tmux ls',
      `   Kill:           tmux kill-session -t ${SESSION}`,
      '   Logs:           logs/ralph-issue-*.log',
    ])
  })
})

describe('startCommand — a digest window that will not open (#62)', () => {
  it('warns and starts anyway when tmux refuses the window', async () => {
    const d = deps({ newWindow: { exitCode: 1, stdout: '', stderr: '  no space for a new window\n' } })
    const result = await startCommand(d)

    expect(result.started).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(d.stderr.output()).toMatch(/digest/i)
    expect(d.stderr.output()).toContain('no space for a new window')
    // The loop's own hint block is untouched: the run is fine, one accessory is not.
    expect(d.stdout.output()).toContain(`   Watch live:     tmux attach -t ${SESSION}`)
  })

  it('warns and starts anyway when tmux THROWS instead of answering', async () => {
    const d = deps({
      newWindow: () => {
        throw new Error('spawn tmux ENOENT')
      },
    })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(d.stderr.output()).toMatch(/digest/i)
    expect(d.stderr.output()).toContain('spawn tmux ENOENT')
    // One line, not a stack trace: the reader's problem is a missing digest.
    expect(d.stderr.lines()).toHaveLength(1)
    expect(d.stderr.output()).not.toContain('at ')
  })

  it('warns and opens nothing when the configured interval is not a duration', async () => {
    // Fractions are the likely typo (`0.5h` for half an hour), and the shared grammar
    // rejects them — the scheduler's accepted formats could not change. Better a
    // warning in the terminal the user is looking at than a pane that dies alone.
    const d = deps({ config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0.5h\n' })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(windowCalls(d)).toHaveLength(0)
    expect(d.stderr.output()).toContain('0.5h')
    expect(d.stderr.output()).toContain('30m')
  })

  it('warns and opens nothing for an interval no timer could wait', async () => {
    // `RALPH_DIGEST_INTERVAL=30d` parses as a duration and cannot be waited: the
    // window's own setTimeout would fire after 1ms and narrate at model speed. What
    // `ralph digest --loop` refuses, `ralph start` must not open a window for — the
    // agreement is the shared parseTimerDuration, not two copies of the number.
    const d = deps({ config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30d\n' })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(windowCalls(d)).toHaveLength(0)
    expect(d.stderr.lines()).toHaveLength(1)
    expect(d.stderr.output()).toContain('30d')
  })

  it('takes a padded interval at its word instead of warning about the padding', async () => {
    // The value a shell config produces when someone lines their assignments up. It
    // IS an interval, so it gets its window — and the box quotes the interval, not the
    // whitespace around it.
    const d = deps({ config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=" 30m "\n' })
    await startCommand(d)
    expect(windowCalls(d)).toHaveLength(1)
    expect(windowCalls(d)[0].args.at(-1)).toContain("--interval '30m'")
    expect(d.stdout.output()).toContain('   Digest:         every 30m — runs alongside the loop')
    expect(d.stderr.output()).toBe('')
  })

  it('opens the window for a QUOTED interval that carries a note', async () => {
    // The shape the shipped template makes likeliest: it writes the knob quoted
    // (`RALPH_DIGEST_INTERVAL=""`) with prose above it inviting a note, so filling it
    // in is `="30m" # every half hour`. bash sources that as `30m`, so the window must
    // open on 30m and the box must quote the interval rather than the line.
    const d = deps({
      config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="30m" # every half hour\n',
    })
    await startCommand(d)
    expect(windowCalls(d)).toHaveLength(1)
    expect(windowCalls(d)[0].args.at(-1)).toContain("--interval '30m'")
    expect(d.stdout.output()).toContain('   Digest:         every 30m — runs alongside the loop')
    expect(d.stderr.output()).toBe('')
  })

  it('keeps a comment after a real interval out of the interval', async () => {
    // The template documents this knob in prose, so annotating the line is the most
    // natural thing a user does to it.
    const d = deps({
      config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m # every half hour\n',
    })
    await startCommand(d)
    expect(windowCalls(d)).toHaveLength(1)
    expect(windowCalls(d)[0].args.at(-1)).toContain("--interval '30m'")
    expect(d.stderr.output()).toBe('')
  })

  it('keeps the warning off stdout, so the launch box stays the launch box', async () => {
    const d = deps({ newWindow: { exitCode: 1, stdout: '', stderr: 'boom' } })
    await startCommand(d)
    expect(d.stdout.output()).not.toContain('boom')
    expect(d.stdout.output()).not.toMatch(/⚠️.*digest/i)
  })
})

// ---------------------------------------------------------------------------
// AC#6 — teardown. Nothing new was built for it, and that IS the design: both
// teardown paths kill the SESSION, and a session takes its windows with it. These
// tests pin the three facts that make that true, because the day one of them drifts
// the leak is a `claude` process narrating a run that ended hours ago.
// ---------------------------------------------------------------------------

describe('the digest window dies with the session (#62)', () => {
  it('is opened in the very session ralph stop kills', async () => {
    const d = deps()
    await startCommand(d)
    const opened = windowCalls(d)[0].args
    const target = opened[opened.indexOf('-t') + 1]
    // Same session as the loop window, and the same name `stop` resolves for REPO — which
    // both commands agree on here because REPO is the directory `start` was given AND the
    // root `stop` resolves to: the runner below answers the toplevel probe #168 added with an
    // empty stdout, so lib/repo-session.js:72 falls back to the cwd it was handed.
    expect(target).toBe(SESSION)
    expect(loopCall(d).args).toContain(SESSION)

    const stopped = []
    await stopCommand({
      cwd: REPO,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: async (cmd, args) => {
        stopped.push(`${cmd} ${args.join(' ')}`)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    expect(stopped).toContain(`tmux kill-session -t ${SESSION}`)
  })

  it('ralph stop kills the session, never one window — so window count cannot orphan anything', async () => {
    const calls = []
    const result = await stopCommand({
      cwd: REPO,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    expect(result.killed).toBe(true)
    expect(calls.some((c) => c.includes('kill-window') || c.includes('kill-pane'))).toBe(false)
    expect(calls.filter((c) => c.startsWith('tmux kill-session'))).toHaveLength(1)
  })

  // The loop's own end-of-run teardown — that templates/ralph.sh kills the SESSION the
  // digest window lives in, by name, and never a single window or pane — belongs to
  // test/loop.digest-teardown.*, which proves it by RUNNING the script against a
  // recording tmux stub. This suite is about what `ralph start` does.
})

async function started(d) {
  await startCommand(d)
  return d
}
