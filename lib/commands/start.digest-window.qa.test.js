import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execa } from 'execa'
import { startCommand } from './start.js'
import { digestCommand } from './digest.js'
import { sessionNameFor } from '../lock.js'
import { templatePath } from '../paths.js'
import { parseDuration, parseTimerDuration } from '../duration.js'

// QA augmentation for #62's second tmux window. The dev's start.digest-window.test.js
// proves the happy path and the three named failures. This file attacks the parts
// that are only dangerous once, in the field:
//
//   - the COMMAND STRING. `openDigestWindow` builds one shell line out of three
//     values Ralph does not own — a path, a config value, argv[1] — and hands it to
//     tmux, which hands it to a shell. Every case here runs the string Ralph actually
//     built through a REAL bash, with `cd` replaced by a recorder and the binary
//     replaced by a name no shell can resolve, so the argument vector and the
//     environment the digest would have been given are observable and nothing runs.
//   - AC#5 as BYTE IDENTITY of the whole stdout stream, not just the box, for every
//     spelling of "no digest" a shell config can produce — because every repo on
//     earth is on that path today.
//   - AC#7 against exec returns nobody designed for: undefined, null, a malformed
//     object, a thrown string, a rejection with no message. `started: true` in all of
//     them, or the accessory has cost someone their run.
//   - AC#6 from the other end: not "does stop kill the session" (it does) but "can
//     anything in here outlive it" — a `&`, a nohup, a loop that exits without
//     teardown.
//
// No test in this file spawns tmux, an agent or a network call.

const REPO = '/repo'
const HOME = '/home/me'
const SESSION = sessionNameFor(REPO)
const RALPH_BIN = '/usr/local/bin/ralph'
// A command word with no slash that no shell can resolve, so bash's own
// `command_not_found_handle` hook fires and reports what it was asked to run.
const PROBE_BIN = 'ralph-qa-no-such-binary'

function makeStream(timeline = [], tag = 'out') {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      timeline.push(`${tag}:${String(s).trim()}`)
      return true
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

// tmux's session guard finds nothing, the loop window launches, gh answers a
// three-issue queue. `newWindow` is what a hostile tmux does to the SECOND window.
function makeExec({ newWindow = { exitCode: 0, stdout: '', stderr: '' }, loopWindow } = {}, timeline = []) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    timeline.push(`exec:${key}`)
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd === 'tmux' && args[0] === 'new') {
      return loopWindow ?? { exitCode: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'tmux' && args[0] === 'new-window') {
      if (typeof newWindow === 'function') return newWindow({ cmd, args, options })
      return newWindow
    }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
      return { exitCode: 0, stdout: '3', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const deps = ({
  config = 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n',
  newWindow,
  loopWindow,
  exists,
  ...overrides
} = {}) => {
  const timeline = []
  const stdout = makeStream(timeline, 'out')
  const stderr = makeStream(timeline, 'err')
  return {
    cwd: REPO,
    stdout,
    stderr,
    timeline,
    exec: makeExec({ newWindow, loopWindow }, timeline),
    exists: exists ?? ((p) => String(p).endsWith('ralph.config.sh')),
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
    ralphBinary: RALPH_BIN,
    ...overrides,
  }
}

const windowCalls = (d) => d.exec.calls.filter((c) => c.cmd === 'tmux' && c.args[0] === 'new-window')
const digestCommandString = (d) => windowCalls(d)[0].args.at(-1)

// The stdout a repo with no digest gets, byte for byte. Hardcoded rather than
// captured, because "unchanged from today" is a claim about these exact characters.
const BOX_WITHOUT_DIGEST = [
  'ℹ️  CALLMEBOT_KEY/WHATSAPP_PHONE missing; WhatsApp notifications will be skipped.',
  '✅ Ralph started in background. 3 issues in the queue.',
  '   Progress:       ralph status',
  `   Watch live:     tmux attach -t ${SESSION}`,
  '   Detach:         inside the session, Ctrl+B then D',
  '   List:           tmux ls',
  `   Kill:           tmux kill-session -t ${SESSION}`,
  '   Logs:           logs/ralph-issue-*.log',
]

const digestLine = (interval, opened = true) =>
  opened
    ? `   Digest:         every ${interval} — runs alongside the loop`
    : `   Digest:         every ${interval} — NOT running (see the warning on stderr)`

const boxWithDigest = (interval, opened = true) => [
  ...BOX_WITHOUT_DIGEST.slice(0, 3),
  digestLine(interval, opened),
  ...BOX_WITHOUT_DIGEST.slice(3),
]

// ---------------------------------------------------------------------------
// The command string, parsed by a real shell. `cd` becomes a recorder and the binary
// becomes a name bash cannot resolve, so we see the chdir target, the command word,
// the argument vector and RALPH_DIGEST_MODEL — and nothing at all executes.
// ---------------------------------------------------------------------------

const PREAMBLE =
  'cd() { printf "CDARGC<<%s>>\\n" "$#"; printf "CD<<%s>>\\n" "$1"; }; ' +
  'command_not_found_handle() { printf "CMD<<%s>>\\n" "$1"; ' +
  'printf "MODEL<<%s>>\\n" "${RALPH_DIGEST_MODEL-«unset»}"; ' +
  'printf "AGENT<<%s>>\\n" "${RALPH_AGENT-«unset»}"; shift; ' +
  'for a in "$@"; do printf "ARG<<%s>>\\n" "$a"; done; return 0; }; '

// The one string that can only appear in the output if the shell EXECUTED something
// it should have carried as data. Every hostile value below embeds `echo <MARK>`, and
// the assertion is "no line of output is just the mark" — the mark showing up inside a
// reported value is the whole point, it means the value survived as a value.
const MARK = 'RALPHQAPWNED'

async function probe(command) {
  const shell = await execa('bash', ['-c', PREAMBLE + command], { reject: false })
  // Delimited rather than line-based, because a value can legitimately contain a
  // newline (a directory name can) and it still has to be readable as ONE value.
  const pick = (tag) =>
    [...shell.stdout.matchAll(new RegExp(`${tag}<<([\\s\\S]*?)>>`, 'g'))].map((m) => m[1])
  return {
    raw: shell,
    ran: shell.stdout.split('\n').some((l) => l.trim() === MARK),
    cdArgc: pick('CDARGC')[0],
    cd: pick('CD')[0],
    cmd: pick('CMD')[0],
    model: pick('MODEL')[0],
    agent: pick('AGENT')[0],
    args: pick('ARG'),
  }
}

describe('QA: the digest window command — quoted, not interpolated (#62)', () => {
  it('hands the shell exactly one chdir target, one command word and four arguments', async () => {
    const d = deps({ ralphBinary: PROBE_BIN })
    await startCommand(d)
    const got = await probe(digestCommandString(d))
    expect(got).toMatchObject({
      cdArgc: '1',
      cd: REPO,
      cmd: PROBE_BIN,
      model: '«unset»',
      agent: '«unset»',
      args: ['digest', '--loop', '--interval', '30m'],
    })
  })

  it.each([
    ['codex with its own digest model', 'codex', 'gpt-5-mini'],
    ['codex on the registry default model', 'codex', null],
    ['claude named explicitly', 'claude', 'haiku'],
  ])(
    'forwards the config RALPH_AGENT into the window: %s',
    async (_label, agent, model) => {
      // The window inherits `ralph start`'s environment, NOT ralph.config.sh: window 0
      // gets the file because templates/ralph.sh sources it, and nothing sources
      // anything for window 1. lib/digest.js resolves which CLI to run from
      // `env.RALPH_AGENT` alone, so an unforwarded agent means the two windows run
      // different agents — `RALPH_AGENT="codex"` in the config and `claude --model
      // gpt-5-mini` in the pane, which fails every tick into a pane nobody is attached
      // to while the box advertises a digest all night.
      const lines = ['TASK_SOURCE=folder', 'RALPH_DIGEST_INTERVAL=30m', `RALPH_AGENT="${agent}"`]
      if (model) lines.push(`RALPH_DIGEST_MODEL="${model}"`)
      const d = deps({ config: `${lines.join('\n')}\n`, ralphBinary: PROBE_BIN })
      await startCommand(d)
      const got = await probe(digestCommandString(d))
      expect(got.agent).toBe(agent)
      expect(got.model).toBe(model ?? '«unset»')
      expect(got.args).toEqual(['digest', '--loop', '--interval', '30m'])
      // Both assignments stay in front of the binary, where a shell reads them as that
      // command's environment rather than as arguments.
      const command = digestCommandString(d)
      expect(command.indexOf('RALPH_AGENT=')).toBeLessThan(command.indexOf(PROBE_BIN))
    },
  )

  it('forwards no agent at all when the config names none, so the ambient one still wins', async () => {
    // A repo whose config has no RALPH_AGENT line must keep the behaviour it has today:
    // the digest resolves the agent from whatever environment `ralph start` was run in.
    // Emitting `RALPH_AGENT=''` here would override an exported one with nothing.
    const d = deps({ ralphBinary: PROBE_BIN })
    await startCommand(d)
    expect(digestCommandString(d)).not.toContain('RALPH_AGENT')
    expect((await probe(digestCommandString(d))).agent).toBe('«unset»')
  })

  it.each([
    ['an empty value', 'RALPH_AGENT=""'],
    ['whitespace only', 'RALPH_AGENT="   "'],
    ['a commented-out line', '# RALPH_AGENT="codex"'],
    ['a value commented out in place', 'RALPH_AGENT=#was codex'],
  ])('sends no agent for %s — an absent setting is not an empty one', async (_label, line) => {
    const d = deps({
      config: `TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\n${line}\n`,
      ralphBinary: PROBE_BIN,
    })
    await startCommand(d)
    expect(digestCommandString(d)).not.toContain('RALPH_AGENT')
    expect((await probe(digestCommandString(d))).agent).toBe('«unset»')
  })

  it.each([
    ['a quote-and-echo escape', `codex'; echo ${MARK}; :'`],
    ['a command substitution', `codex$(echo ${MARK})`],
    ['backticks', `codex\`echo ${MARK}\``],
    ['a semicolon', `codex; echo ${MARK}`],
  ])('passes an agent containing %s through verbatim, unexecuted', async (_label, agent) => {
    // RALPH_AGENT comes out of a file Ralph reads as text and never sources, exactly
    // like the model — so it gets the same quoting, and the registry (not a shell)
    // decides it is not an agent.
    const d = deps({
      config: `TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\nRALPH_AGENT=${agent}\n`,
      ralphBinary: PROBE_BIN,
    })
    await startCommand(d)
    const got = await probe(digestCommandString(d))
    expect(got.ran, 'a metacharacter in RALPH_AGENT was executed').toBe(false)
    expect(got.agent).toBe(agent)
    expect(got.args).toEqual(['digest', '--loop', '--interval', '30m'])
  })

  it.each([
    ['a single quote', "/repo's code"],
    ['a command substitution', `/repo/$(echo ${MARK})`],
    ['a backtick substitution', `/repo/\`echo ${MARK}\``],
    ['a statement separator', `/repo; echo ${MARK}`],
    ['an and-chain', `/repo && echo ${MARK}`],
    ['a pipe', `/repo | echo ${MARK}`],
    ['a subshell', `/repo/(echo ${MARK})`],
    ['a newline', `/repo\necho ${MARK}`],
    ['a glob and a tilde', '/repo/*/~'],
    ['a variable reference', '/repo/$HOME/${IFS}'],
    ['a quote AND a substitution', `/repo'; echo ${MARK}; :'$(id)`],
  ])('survives a cwd containing %s as one literal word', async (_label, cwd) => {
    // The cwd is whatever directory the user ran `ralph start` in. It reaches tmux as
    // part of a shell string, so a repo checked out under a path with a quote in it
    // must produce a `cd` to that exact path — not two words, and not an execution.
    const d = deps({ cwd, ralphBinary: PROBE_BIN, folderQueueCount: async () => 3 })
    await startCommand(d)
    const got = await probe(digestCommandString(d))
    expect(got.cdArgc).toBe('1')
    // Exactly the raw path: not truncated at the metacharacter, and not the RESULT of
    // a substitution either.
    expect(got.cd).toBe(cwd)
    expect(got.ran, 'a metacharacter in the cwd was executed').toBe(false)
    expect(got.args).toEqual(['digest', '--loop', '--interval', '30m'])
  })

  it.each([
    ['a quote-and-echo escape', `cheap'; echo ${MARK}; :'`],
    ['a command substitution', `cheap$(echo ${MARK})`],
    ['backticks', `cheap\`echo ${MARK}\``],
    ['a semicolon', `cheap; echo ${MARK}`],
    ['a newline', `cheap\necho ${MARK}`],
    ['a variable reference', '$HOME'],
    ['a redirect', 'cheap > /tmp/ralph-qa-pwned'],
  ])('passes a model containing %s through verbatim, unexecuted', async (_label, model) => {
    // RALPH_DIGEST_MODEL comes out of ralph.config.sh, which Ralph reads as TEXT and
    // never sources. Whatever is in it must arrive at the digest process as one
    // environment value — the digest engine decides it is not a model, not a shell.
    const d = deps({
      config: `TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\nRALPH_DIGEST_MODEL=${model}\n`,
      ralphBinary: PROBE_BIN,
    })
    await startCommand(d)
    const got = await probe(digestCommandString(d))
    expect(got.ran, 'a metacharacter in RALPH_DIGEST_MODEL was executed').toBe(false)
    // A newline ends the assignment line, so compare against what the config parser
    // actually yielded rather than against the raw input.
    expect(got.model).toBe(model.split('\n')[0])
    expect(got.args).toEqual(['digest', '--loop', '--interval', '30m'])
  })

  it('keeps a binary path with a space and a quote in it as a single command word', async () => {
    // `npx ralph`, a linked dev checkout, a global install under "Application
    // Support" — argv[1] is a path Ralph did not choose. If it were split, the shell
    // would report a DIFFERENT word than the one Ralph meant to run.
    const binary = "/opt/ra lph/bi'n/ralph"
    const d = deps({ ralphBinary: binary })
    await startCommand(d)
    const command = digestCommandString(d)
    const shell = await execa('bash', ['-c', 'cd() { :; }; ' + command], { reject: false })
    // Nothing at that path, so bash names the word it tried to run — the whole path.
    expect(shell.exitCode).toBe(127)
    expect(shell.stderr).toContain(binary)
    // ...and it never tried the truncated prefix instead.
    expect(shell.stderr).not.toMatch(/\/opt\/ra:/)
    expect(shell.stdout).toBe('')
  })

  it('never lets a hostile interval reach a shell at all — it is validated first', async () => {
    // The interval is the one of the three values that is checked against the shared
    // grammar BEFORE the command is built, so nothing outside `[0-9smhd]` can ever be
    // in that string. Asserted as "no window was opened", which is the stronger claim.
    // (A newline is not in this list because it cannot be in the value: a config
    // assignment ends at the end of its line, so `RALPH_DIGEST_INTERVAL=30m\n...`
    // yields `30m` and the rest is another line of config.)
    for (const interval of [
      '30m; rm -rf /tmp/ralph-qa',
      `30m'; echo ${MARK}; :'`,
      '$(id)',
      '`id`',
      `30m && echo ${MARK}`,
      '30m | tee /tmp/ralph-qa',
      '--version',
      '-30m',
    ]) {
      const d = deps({ config: `TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=${interval}\n` })
      const result = await startCommand(d)
      expect(result.started, interval).toBe(true)
      expect(windowCalls(d), interval).toHaveLength(0)
      expect(d.stderr.lines(), interval).toHaveLength(1)
    }
  })

  it('passes the interval as ONE argv element even when it carries an inner space', async () => {
    // `30 m` is accepted by the shared grammar, so it can legitimately reach the
    // window. Unquoted it would arrive as two arguments and the digest would refuse.
    const d = deps({
      config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="30 m"\n',
      ralphBinary: PROBE_BIN,
    })
    await startCommand(d)
    const got = await probe(digestCommandString(d))
    expect(got.args).toEqual(['digest', '--loop', '--interval', '30 m'])
    expect(parseDuration(got.args.at(-1))).toBe(1800)
  })

  it('sends no model at all for an empty one, and a blank one cannot break the command', async () => {
    const empty = deps({
      config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\nRALPH_DIGEST_MODEL=""\n',
      ralphBinary: PROBE_BIN,
    })
    await startCommand(empty)
    expect(digestCommandString(empty)).not.toContain('RALPH_DIGEST_MODEL')
    expect((await probe(digestCommandString(empty))).model).toBe('«unset»')

    // A whitespace-only model is forwarded as a quoted blank — harmless, because the
    // engine trims it back to "use the default". What matters is that the command
    // still parses and the digest still gets its arguments.
    const blank = deps({
      config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\nRALPH_DIGEST_MODEL="   "\n',
      ralphBinary: PROBE_BIN,
    })
    await startCommand(blank)
    const got = await probe(digestCommandString(blank))
    expect(got.args).toEqual(['digest', '--loop', '--interval', '30m'])
  })

  it('addresses tmux with a fixed argument vector, so the command is never a flag', async () => {
    const d = deps()
    await startCommand(d)
    expect(windowCalls(d)[0].args).toEqual([
      'new-window',
      '-d',
      '-t',
      SESSION,
      '-n',
      'digest',
      digestCommandString(d),
    ])
    // `reject: false`, like every other tmux call in this command: a non-zero exit is
    // data here, not an exception.
    expect(windowCalls(d)[0].options).toMatchObject({ reject: false })
  })
})

// ---------------------------------------------------------------------------
// AC#7. The loop is already running when this is attempted, so there is no failure
// left that is worth a launch.
// ---------------------------------------------------------------------------

describe('QA: a digest window that will not open never costs the launch (#62)', () => {
  const FAILURES = [
    ['a non-zero exit', { exitCode: 1, stdout: '', stderr: 'no space for a new window' }],
    ['exit code 127', { exitCode: 127, stdout: '', stderr: '' }],
    ['undefined', () => undefined],
    ['null', () => null],
    ['an empty object', () => ({})],
    ['an object with a null exit code', () => ({ exitCode: null, stderr: null })],
    ['a string', () => 'what even is this'],
    ['a thrown Error', () => {
      throw new Error('spawn tmux ENOENT')
    }],
    ['a thrown string', () => {
      throw 'tmux is gone'
    }],
    ['a thrown object with no message', () => {
      throw { code: 'ENOENT' }
    }],
    ['a rejection with no message', () => Promise.reject(new Error())],
    ['a rejected non-Error', () => Promise.reject('nope')],
    ['a multi-line, padded stderr', { exitCode: 1, stdout: '', stderr: '  can\'t find\n\tsession\r\n\n' }],
  ]

  it.each(FAILURES)('starts anyway when tmux answers %s', async (_label, newWindow) => {
    const d = deps({ newWindow })
    const result = await startCommand(d)

    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    // The launch box still reports the RUN as fine, because it is — but the Digest line
    // now says the window is not there. Advertising `runs alongside the loop` for a
    // window tmux refused is the one thing the box may not do: a reader who attaches,
    // finds one window and concludes Ralph is broken was misled by this line, and the
    // fact needed to prevent that is the return value of openDigestWindow.
    expect(d.stdout.lines()).toEqual(boxWithDigest('30m', false))
    // One line of warning, on stderr, with no stack and no wrapping.
    const said = d.stderr.lines()
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/digest/i)
    expect(said[0]).toContain('The loop is running.')
    expect(said[0]).not.toContain('at ')
    expect(said[0]).not.toContain('\n')
  })

  it('collapses a five-line tmux complaint into one readable line', async () => {
    // A warning that wraps into five lines reads as five problems.
    const d = deps({
      newWindow: {
        exitCode: 1,
        stdout: '',
        stderr: 'can\'t find window\n  in session\n\n\tralph-x\r\nfailed\n',
      },
    })
    await startCommand(d)
    expect(d.stderr.lines()).toHaveLength(1)
    expect(d.stderr.output()).toContain("can't find window in session ralph-x failed")
  })

  it('caps a long multi-line tmux complaint instead of wrapping the terminal', async () => {
    // tmux can fail with a page of it — a bad socket path, a server/client version
    // mismatch — and an uncapped join turns one warning into a screenful that reads as
    // a broken run rather than a missing accessory. The cap is lib/digest.js's exported
    // `oneLine`, which is the same flattener every digest diagnostic goes through, so
    // there is one answer to "how long is a diagnostic" rather than two.
    const noisy = Array.from({ length: 40 }, (_, i) => `tmux: line ${i} of a very long complaint`)
    const d = deps({ newWindow: { exitCode: 1, stdout: '', stderr: `${noisy.join('\n')}\n` } })
    const result = await startCommand(d)

    expect(result.started).toBe(true)
    const said = d.stderr.lines()
    expect(said).toHaveLength(1)
    expect(said[0]).not.toContain('\n')
    // Bounded: the collapsed diagnostic is capped at 200 characters and elided, so the
    // whole warning fits in the width of a couple of terminal lines rather than 40.
    expect(said[0].length).toBeLessThan(300)
    expect(said[0]).toContain('…')
    // It still starts with the reason, and still ends with the reassurance.
    expect(said[0]).toContain('tmux: line 0 of a very long complaint')
    expect(said[0]).toContain('The loop is running.')
    // ...and the raw 40-line blob never reached stdout.
    expect(d.stdout.output()).not.toContain('line 39')
  })

  it('warns BEFORE printing the launch box, not after it', async () => {
    // Read off one timeline across both streams: a warning printed after the box
    // would be the last thing a user sees and read as "the run failed".
    const d = deps({ newWindow: { exitCode: 1, stdout: '', stderr: 'boom' } })
    await startCommand(d)
    const warnAt = d.timeline.findIndex((e) => e.startsWith('err:') && /digest/i.test(e))
    const boxAt = d.timeline.findIndex((e) => e.includes('Ralph started in background'))
    expect(warnAt).toBeGreaterThan(-1)
    expect(warnAt).toBeLessThan(boxAt)
  })

  it('still sends the startup WhatsApp notification after a failed digest window', async () => {
    // Everything downstream of the window must still happen. The notification is the
    // last step of a launch and the easiest one to lose to an early return.
    const sent = []
    const d = deps({
      newWindow: () => {
        throw new Error('spawn tmux ENOENT')
      },
      loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' }),
      exists: () => true,
      sendWa: async (args) => {
        sent.push(args)
        return { ok: true }
      },
    })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(sent).toHaveLength(1)
    expect(d.stdout.output()).toContain('📲 Startup WhatsApp notification sent.')
  })
})

// ---------------------------------------------------------------------------
// AC#5. Every repo on earth is on this path today: no interval configured, so
// nothing about `ralph start` may move — not one character of stdout, not one extra
// tmux call.
// ---------------------------------------------------------------------------

describe('QA: no interval configured — byte-identical to a pre-#62 run (#62)', () => {
  it.each([
    ['no assignment at all', 'TASK_SOURCE=folder\n'],
    ['an empty string', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=""\n'],
    ['empty single quotes', "TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=''\n"],
    ['a bare =', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=\n'],
    ['zero', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0\n'],
    ['quoted zero', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="0"\n'],
    ['zero seconds', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0s\n'],
    ['zero minutes', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0m\n'],
    ['zero hours', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0h\n'],
    ['zero days', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0d\n'],
    ['double zero', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=00\n'],
    ['a decimal zero', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0.0\n'],
    ['a zero with a trailing space', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="0 "\n'],
    ['commented out', 'TASK_SOURCE=folder\n# RALPH_DIGEST_INTERVAL=30m\n'],
    ['commented out with leading space', 'TASK_SOURCE=folder\n   # RALPH_DIGEST_INTERVAL=30m\n'],
    ['a live zero after a commented example', 'TASK_SOURCE=folder\n# RALPH_DIGEST_INTERVAL=30m\nRALPH_DIGEST_INTERVAL=0\n'],
    ['30m overridden by a later empty (bash: last wins)', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\nRALPH_DIGEST_INTERVAL=""\n'],
    ['a similarly named variable', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL_OLD=30m\nMY_RALPH_DIGEST_INTERVAL=2h\n'],
    ['a model but no interval', 'TASK_SOURCE=folder\nRALPH_DIGEST_MODEL="haiku"\n'],
  ])('%s: one window, no Digest line, clean stderr', async (_label, config) => {
    const d = deps({ config })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(d.stdout.lines()).toEqual(BOX_WITHOUT_DIGEST)
    expect(d.stderr.output()).toBe('')
    // Exactly one tmux window in the session: the loop's.
    expect(windowCalls(d)).toHaveLength(0)
    expect(d.exec.calls.filter((c) => c.cmd === 'tmux').map((c) => c.args[0])).toEqual([
      'has-session',
      'new',
    ])
  })

  it.each([
    ['no ralph.config.sh at all', { exists: () => false }],
    ['a config that cannot be read', {
      readFile: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      },
    }],
    ['a config read as an empty buffer', { readFile: () => Buffer.from('') }],
    ['an exists() that throws', {
      exists: (p) => {
        if (String(p).endsWith('ralph.config.sh')) throw new Error('EIO')
        return false
      },
    }],
  ])('%s: no digest, and the launch is unaffected', async (_label, overrides) => {
    // A missing or unreadable config leaves every setting at its default, and the
    // digest's default is off. These runs fall back to the github source, so the box
    // is the same box by a different route.
    const d = deps({ config: '', ...overrides })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(d.stdout.lines()).toEqual(BOX_WITHOUT_DIGEST)
    expect(d.stderr.output()).toBe('')
    expect(windowCalls(d)).toHaveLength(0)
  })

  // One run of `ralph start` per config line, reduced to the three things AC#5 is
  // about: what stdout said, what stderr said, how many windows were opened.
  const outcomeOf = async (line) => {
    const d = deps({ config: `TASK_SOURCE=folder\n${line}\n` })
    await startCommand(d)
    const windows = windowCalls(d)
    return {
      stdout: d.stdout.lines(),
      stderr: d.stderr.output(),
      interval: windows.length ? windows[0].args.at(-1).match(/--interval '(.*)'/)?.[1] : null,
    }
  }

  it('a value that is only whitespace is not an interval, however it is spelled', async () => {
    // A blank value says NOTHING about an interval, and `ralph digest --loop` agrees:
    // digest.js checks `String(interval).trim() === ''` and refuses to loop. So a
    // config carrying one must get the same answer here — the untouched box, a silent
    // stderr, one window — and not a warning about an interval the user never set plus
    // a `Digest: every    ` line in the box of every launch from then on.
    //
    // How it happens in the field: a value edited out by hand and a space left behind,
    // or `RALPH_DIGEST_INTERVAL="$SOME_UNSET_VAR "` — and it is sticky, because the
    // box then advertises a digest window that was never opened.
    const spellings = ['RALPH_DIGEST_INTERVAL=" "', 'RALPH_DIGEST_INTERVAL="   "', 'RALPH_DIGEST_INTERVAL="\t"']
    const results = await Promise.all(spellings.map(outcomeOf))
    expect(results).toEqual(
      spellings.map(() => ({ stdout: BOX_WITHOUT_DIGEST, stderr: '', interval: null })),
    )
  })

  it('reads the value, not the trailing comment a documented knob invites', async () => {
    // The shipped template documents this variable in prose above it, so a user
    // annotating their own choice on the line — the most natural thing to do in a
    // shell config — is a case worth surviving. Both rows are the same root cause: the
    // raw text after `=` is used as the interval without being normalized first.
    // Both rows in one comparison, so a run reports both rather than stopping at the
    // first: a comment with no value must leave the launch alone, and a comment after
    // a value must leave the value alone.
    const got = await Promise.all([
      outcomeOf('RALPH_DIGEST_INTERVAL= # off for now'),
      outcomeOf('RALPH_DIGEST_INTERVAL=30m # every half hour, alongside the loop'),
    ])
    expect(got).toEqual([
      { stdout: BOX_WITHOUT_DIGEST, stderr: '', interval: null },
      { stdout: boxWithDigest('30m'), stderr: '', interval: '30m' },
    ])
  })
})

// ---------------------------------------------------------------------------
// The Digest line and the window it describes, as ONE fact. `openDigestWindow` knows
// whether the window opened; the box has to say so. A launch that ends with `Digest:
// every 0.5h — runs alongside the loop` on stdout, with the only contradiction buried
// in preflight output on stderr, sends the reader looking for a window that was
// refused four lines earlier.
// ---------------------------------------------------------------------------

describe('QA: the Digest line never advertises a window that was refused (#62 fix)', () => {
  const REFUSALS = [
    // The fractional interval start.js's own comment names as the likeliest reach.
    ['a fractional interval', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=0.5h\n', '0.5h'],
    ['an interval past the timer ceiling', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30d\n', '30d'],
    ['a zero-padded typo', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="3 0m"\n', '3 0m'],
    ['a word', 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=hourly\n', 'hourly'],
  ]

  it.each(REFUSALS)('%s: the line names the digest AND says it is not running', async (_l, config, interval) => {
    const d = deps({ config })
    const result = await startCommand(d)

    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(windowCalls(d)).toHaveLength(0)
    // Both halves of the requirement in one comparison: the interval the repo asked
    // for is still named — a reader with a typo must not be left with silence about the
    // knob they just edited — and the box does not claim it is running.
    expect(d.stdout.lines()).toEqual(boxWithDigest(interval, false))
    expect(d.stderr.lines()).toHaveLength(1)
  })

  it.each(REFUSALS)('%s: the not-running state is on STDOUT, not only on stderr', async (_l, config) => {
    // The failure this replaces: `ralph start > launch.log` collected a box promising a
    // digest and the contradiction went to a terminal nobody kept. Whichever stream a
    // reader has, they get the truth.
    const d = deps({ config })
    await startCommand(d)
    expect(d.stdout.output()).toMatch(/Digest:.*NOT running/)
  })

  it('says "runs alongside the loop" only when a window was actually opened', async () => {
    // The positive control, and the reason the line is keyed on the RESULT rather than
    // on the config: both runs below have a perfectly good interval, and only one of
    // them has a digest.
    const ok = deps()
    await startCommand(ok)
    expect(windowCalls(ok)).toHaveLength(1)
    expect(digestBoxLine(ok)).toBe(digestLine('30m'))

    const refusedByTmux = deps({ newWindow: { exitCode: 1, stdout: '', stderr: 'no space' } })
    await startCommand(refusedByTmux)
    expect(windowCalls(refusedByTmux)).toHaveLength(1)
    expect(digestBoxLine(refusedByTmux)).toBe(digestLine('30m', false))
    expect(digestBoxLine(refusedByTmux)).not.toContain('runs alongside the loop')
  })

  it('leaves the NO-digest path with no Digest line at all, either way', async () => {
    // The honest line is for a repo that ASKED for a digest. A repo that did not must
    // still get the pre-#62 box byte for byte — the new wording must not leak into it.
    const d = deps({ config: 'TASK_SOURCE=folder\n' })
    await startCommand(d)
    expect(d.stdout.lines()).toEqual(BOX_WITHOUT_DIGEST)
    expect(d.stdout.output()).not.toContain('Digest')
    expect(d.stdout.output()).not.toContain('NOT running')
  })
})

// ---------------------------------------------------------------------------
// When the window must not be opened at all. The digest keeps the LOOP company; every
// path that ends without a loop must end without a digest too.
// ---------------------------------------------------------------------------

describe('QA: no loop, no digest window (#62)', () => {
  it('opens nothing when the queue is empty — there is nothing to narrate', async () => {
    const d = deps({ folderQueueCount: async () => 0 })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(windowCalls(d)).toHaveLength(0)
    expect(d.stdout.output()).toContain('No issues in the queue')
    expect(d.stdout.output()).not.toContain('Digest')
    expect(d.stderr.output()).toBe('')
  })

  it('opens nothing when this project already has a session', async () => {
    const d = deps({
      exec: (() => {
        const calls = []
        const exec = async (cmd, args) => {
          calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args })
          if (cmd === 'tmux' && args[0] === 'has-session') {
            return { exitCode: 0, stdout: '', stderr: '' }
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        exec.calls = calls
        return exec
      })(),
    })
    await expect(startCommand(d)).rejects.toThrow(/session/i)
    expect(windowCalls(d)).toHaveLength(0)
  })

  it('opens nothing when a cycle holds the lock', async () => {
    const d = deps({
      peekLock: () => ({ alive: true, holder: { pid: 4242, startedAt: new Date().toISOString() } }),
    })
    await expect(startCommand(d)).rejects.toThrow()
    expect(windowCalls(d)).toHaveLength(0)
  })

  it('opens nothing when tmux is missing entirely — the dep check aborts first', async () => {
    // The one case where an interval IS configured and tmux cannot be relied on. The
    // critical-dependency check owns it, and it runs long before step 9.
    const d = deps({ hasCommand: (name) => name !== 'tmux' })
    await expect(startCommand(d)).rejects.toThrow()
    expect(windowCalls(d)).toHaveLength(0)
    expect(d.stderr.output()).toMatch(/tmux/)
  })

  it('opens nothing when an accepted update ends the run early', async () => {
    // `ralph start` exits after installing so the loop never runs a half-swapped
    // version. A digest window opened here would narrate a loop that does not exist,
    // in a session nothing will ever tear down.
    const d = deps({
      isTTY: true,
      currentVersion: '0.1.0',
      update: async () => ({
        latestVersion: '0.2.0',
        isNewer: true,
        shouldPrompt: true,
        source: 'npm',
        updatedCache: null,
      }),
      recordPrompt: () => {},
      ask: async () => true,
      runUpdate: async () => ({ updated: true, to: '0.2.0' }),
    })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(windowCalls(d)).toHaveLength(0)
    expect(d.exec.calls.some((c) => c.args[0] === 'new')).toBe(false)
  })

  it('opens nothing when the loop window itself fails, whatever the interval says', async () => {
    const d = deps({ loopWindow: { exitCode: 1, stdout: '', stderr: 'no server running' } })
    await expect(startCommand(d)).rejects.toThrow()
    expect(windowCalls(d)).toHaveLength(0)
  })

  it('opens nothing when the loop window THROWS instead of failing', async () => {
    // `reject: false` covers a tmux that answers non-zero; nothing covers a tmux that
    // cannot be spawned, and the launch is over either way.
    const d = deps({
      loopWindow: undefined,
      exec: (() => {
        const calls = []
        const exec = async (cmd, args) => {
          calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args })
          if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
          if (cmd === 'tmux' && args[0] === 'new') throw new Error('spawn tmux ENOENT')
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        exec.calls = calls
        return exec
      })(),
    })
    await expect(startCommand(d)).rejects.toThrow(/ENOENT/)
    expect(windowCalls(d)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Identity. The digest window is only reachable by teardown if it is in the session
// teardown addresses, and that name is DERIVED from the cwd — so a project other
// than /repo has to work too.
// ---------------------------------------------------------------------------

describe('QA: the digest window lives in the session teardown addresses (#62)', () => {
  it.each([
    '/Users/me/projects/ralph',
    '/tmp/a b c',
    "/tmp/it's-a-repo",
    '/tmp/UPPER-and-lower',
  ])('targets sessionNameFor(%s), the same session as the loop window', async (cwd) => {
    const d = deps({ cwd })
    await startCommand(d)
    const digest = windowCalls(d)[0].args
    const loop = d.exec.calls.find((c) => c.cmd === 'tmux' && c.args[0] === 'new').args
    const expected = sessionNameFor(cwd)
    expect(digest[digest.indexOf('-t') + 1]).toBe(expected)
    expect(loop[loop.indexOf('-s') + 1]).toBe(expected)
    // ...and the box points a human at that same session.
    expect(d.stdout.output()).toContain(`tmux attach -t ${expected}`)
  })

  it('prints the Digest line in the box, in its place, with the configured interval', async () => {
    for (const interval of ['30m', '60', '2h', '1d', '45s']) {
      const d = deps({ config: `TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=${interval}\n` })
      await startCommand(d)
      expect(d.stdout.lines(), interval).toEqual(boxWithDigest(interval))
    }
  })
})

// ---------------------------------------------------------------------------
// AC#6. Nothing new was built for teardown, and that is the design: both paths kill
// the SESSION and a session takes its windows with it. So the risk is not in `stop`
// — it is anything in here that could outlive a session, and any way the session can
// survive the loop.
// ---------------------------------------------------------------------------

describe('QA: nothing the digest window runs can outlive its session (#62)', () => {
  it('builds a foreground command — no background &, no nohup, no setsid, no disown', async () => {
    // A backgrounded digest would survive `tmux kill-session` as an orphan calling a
    // paid model on a timer with no window to print into.
    const d = deps()
    await startCommand(d)
    const command = digestCommandString(d)
    expect(command).not.toMatch(/(^|[^&])&\s*$/)
    expect(command).not.toMatch(/\bnohup\b|\bsetsid\b|\bdisown\b|\bscreen\b/)
    expect(command).not.toContain('&>')
    // Exactly one `&&`, the one joining the chdir to the digest.
    expect(command.match(/&&/g)).toHaveLength(1)
    expect(command).not.toContain(';')
  })

  it('asks for a plain window, not one that lingers after its process dies', async () => {
    // `remain-on-exit` would leave a dead pane behind, and a dead pane keeps the
    // session alive — which is how a finished run stops being able to start again.
    const d = deps()
    await startCommand(d)
    const args = windowCalls(d)[0].args
    expect(args.join(' ')).not.toContain('remain-on-exit')
    expect(args[0]).toBe('new-window')
    expect(args).not.toContain('-P')
    expect(args).not.toContain('split-window')
  })

  it('the loop template tears the session down on EVERY exit, not just the happy one', async () => {
    // The one interaction #62 introduced that has no code of its own. Before #62 the
    // loop was the session's ONLY window, so any `exit` ended the session with it.
    // Now there is a second window: when ralph.sh aborts — not a git repo, an agent
    // invocation it cannot resolve, a validation that produced no state — window 0
    // closes, the digest window keeps the session alive, and `ralph digest --loop`
    // narrates a run that never started, on a timer, until someone notices. The
    // session name is also still taken, so the next `ralph start` refuses.
    //
    // Either shape fixes it: an EXIT trap that kills the session, or teardown at each
    // abort. Both are asserted as one because the invariant is "no abort leaves the
    // session up", not which mechanism gets there.
    const loop = readFileSync(templatePath('ralph.sh'), 'utf8')
    const lines = loop.split('\n')
    const trapKillsSession = /trap\s+[^\n]*kill-session/.test(loop)
    const unguarded = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^\s*exit 1\s*$/.test(line))
      .filter(({ n }) => !lines.slice(Math.max(0, n - 8), n).some((l) => l.includes('kill-session')))
      .map(({ n }) => n)
    expect(
      trapKillsSession || unguarded.length === 0,
      `templates/ralph.sh aborts at line(s) ${unguarded.join(', ')} without killing the session it is running in — with a digest window open, the session and the digest survive the loop`,
    ).toBe(true)
  })

  // Everything else about that teardown — that it kills the SESSION and never a window
  // or a pane, on which paths, how many times, and under which signals — belongs to
  // test/loop.digest-teardown.*, which proves it by RUNNING the script against a
  // recording tmux stub rather than by reading it.
})

// ---------------------------------------------------------------------------
// AC#3/#9. The shipped template is what every `ralph init` writes, so its default is
// the default. Asserted through startCommand rather than by reading the file, because
// "defaults to disabled" is a claim about behaviour, not about a string.
// ---------------------------------------------------------------------------

const TEMPLATE = readFileSync(templatePath('ralph.config.sh'), 'utf8')

describe('QA: the shipped config template, read back through ralph start (#62)', () => {
  it('starts with the digest OFF, and prints the pre-#62 box', async () => {
    const d = deps({ config: TEMPLATE.replace('{{TASK_SOURCE}}', 'folder') })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(windowCalls(d)).toHaveLength(0)
    expect(d.stdout.lines()).toEqual(BOX_WITHOUT_DIGEST)
    expect(d.stderr.output()).toBe('')
  })

  it('leaks no {{PLACEHOLDER}} into either digest variable', async () => {
    // Both ship as literals, not as interpolated values — so an unrendered
    // placeholder here would reach the duration parser as a config value.
    expect(TEMPLATE).toMatch(/^RALPH_DIGEST_INTERVAL=""$/m)
    expect(TEMPLATE).not.toMatch(/RALPH_DIGEST_\w+=\s*"?\{\{/)
    const digestLines = TEMPLATE.split('\n').filter((l) => l.includes('RALPH_DIGEST_'))
    for (const line of digestLines) expect(line).not.toContain('{{')
  })

  it('declares the interval exactly once, live, and last', async () => {
    // bash takes the LAST assignment, so a live line after the documented default
    // would silently win. One live assignment, and the commented example is above it.
    const live = TEMPLATE.split('\n').filter((l) => /^\s*(export\s+)?RALPH_DIGEST_INTERVAL\s*=/.test(l))
    expect(live).toEqual(['RALPH_DIGEST_INTERVAL=""'])
    // The model knob is commented, i.e. not an active assignment of an empty model —
    // which would forward `RALPH_DIGEST_MODEL=''` and mean nothing.
    expect(TEMPLATE).not.toMatch(/^\s*(export\s+)?RALPH_DIGEST_MODEL\s*=/m)
    expect(TEMPLATE).toMatch(/^#\s*RALPH_DIGEST_MODEL="haiku"$/m)
  })

  it('every duration the comment advertises is one the shared parser accepts', async () => {
    // The comment tells a user to write `60`, `30m`, `2h` or `1d`. If the grammar and
    // the documentation ever disagree, the user finds out in a pane at 4am.
    const comment = TEMPLATE.slice(
      TEMPLATE.indexOf('# How often the digest runs'),
      TEMPLATE.indexOf('RALPH_DIGEST_INTERVAL='),
    )
    const advertised = comment.match(/\b\d+[smhd]?\b(?=[\s,.)])/g) ?? []
    expect(advertised).toContain('30m')
    for (const value of ['60', '30m', '2h', '1d']) {
      expect(comment, value).toContain(value)
      expect(() => parseDuration(value), value).not.toThrow()
    }
  })

  it('works end to end when a user does exactly what the comment says', async () => {
    // Uncomment the model, fill in the interval, get a window running the documented
    // command with the documented values.
    const config = TEMPLATE.replace('{{TASK_SOURCE}}', 'folder')
      .replace('RALPH_DIGEST_INTERVAL=""', 'RALPH_DIGEST_INTERVAL="30m"')
      .replace('# RALPH_DIGEST_MODEL="haiku"', 'RALPH_DIGEST_MODEL="haiku"')
    const d = deps({ config, ralphBinary: PROBE_BIN })
    await startCommand(d)
    expect(windowCalls(d)).toHaveLength(1)
    const got = await probe(digestCommandString(d))
    expect(got.model).toBe('haiku')
    expect(got.args).toEqual(['digest', '--loop', '--interval', '30m'])
    expect(d.stdout.lines()).toEqual(boxWithDigest('30m'))
    expect(d.stderr.output()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// The value AFTER normalization. `digestInterval` now trims before it decides whether
// the digest is on, and a trim that reached only that decision would be worse than no
// trim at all: the box would advertise `every    ` while the window ran on something
// else, or the argv would carry padding the loop's own parser then had to forgive. So
// every case below reads the SAME value three times — the box line a human is given,
// the argv a real bash builds out of the command string, and the shared grammar — and
// asserts the three agree.
// ---------------------------------------------------------------------------

const digestBoxLine = (d) => d.stdout.lines().find((l) => l.startsWith('   Digest:')) ?? null

describe('QA: a padded interval is the same interval everywhere it is read (#62 fix)', () => {
  it.each([
    ['double quotes with a space each side', 'RALPH_DIGEST_INTERVAL=" 30m "', '30m'],
    ['single quotes with a space each side', "RALPH_DIGEST_INTERVAL=' 45s '", '45s'],
    ['unquoted, padded after the =', 'RALPH_DIGEST_INTERVAL=  2h  ', '2h'],
    ['a tab each side, quoted', 'RALPH_DIGEST_INTERVAL="\t1d\t"', '1d'],
    ['padding AND a trailing comment', 'RALPH_DIGEST_INTERVAL= 60  # hourly', '60'],
    ['no padding at all — the control row', 'RALPH_DIGEST_INTERVAL="90s"', '90s'],
  ])('%s: box, argv and grammar all see the trimmed value', async (_label, line, expected) => {
    // How it happens in the field: a value pasted with the whitespace that came with
    // it, or `="$SOMETHING "`. Nothing about the padding is the user's intent, and the
    // three readers of the value must not each make their own decision about it.
    const d = deps({ config: `TASK_SOURCE=folder\n${line}\n`, ralphBinary: PROBE_BIN })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(windowCalls(d)).toHaveLength(1)
    const got = await probe(digestCommandString(d))
    // The shell's own argument vector: the trimmed value, as one word, and nothing ran.
    expect(got.args).toEqual(['digest', '--loop', '--interval', expected])
    expect(got.ran).toBe(false)
    // The box a human reads, byte for byte, with no padding smuggled into it.
    expect(d.stdout.lines()).toEqual(boxWithDigest(expected))
    expect(d.stderr.output()).toBe('')
    // And it is a duration the window's own parser would have accepted.
    expect(parseTimerDuration(got.args.at(-1))).toBe(parseTimerDuration(expected))
  })

  it('never prints a Digest line the argument vector disagrees with', async () => {
    // The box line is keyed on the CONFIG value and the argv on the same value after
    // validation — two reads of one variable, in two functions, and this is the test
    // that keeps them one value. Every row is asserted in one comparison so a run
    // reports all the disagreements it found rather than the first.
    const rows = ['30m', ' 30m ', '  2h', '1d ', '60', '45s', '24d', '30 m']
    const got = []
    for (const value of rows) {
      const d = deps({
        config: `TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="${value}"\n`,
        ralphBinary: PROBE_BIN,
      })
      await startCommand(d)
      const argv = windowCalls(d).length ? (await probe(digestCommandString(d))).args.at(-1) : null
      got.push({ value, box: digestBoxLine(d), argv })
    }
    expect(got).toEqual(
      rows.map((value) => {
        const trimmed = value.trim()
        return { value, box: digestLine(trimmed), argv: trimmed }
      }),
    )
  }, 20000)

  it('still refuses whitespace INSIDE the value rather than quietly repairing it', async () => {
    // The trim is at the EDGES only, and that boundary matters: `3 0m` is a typo for
    // `30m`, and a parser that healed it would run a digest every three seconds while
    // the box said `every 3 0m`. `30 m` on the other hand is accepted by the shared
    // grammar (it allows space between number and unit), so the refusal has to be
    // precise about which is which — both rows in one comparison.
    const outcomes = []
    for (const value of ['3 0m', '30 m']) {
      const d = deps({ config: `TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="${value}"\n` })
      await startCommand(d)
      outcomes.push({
        value,
        windows: windowCalls(d).length,
        stderr: d.stderr.lines(),
        box: digestBoxLine(d),
      })
    }
    expect(outcomes).toEqual([
      {
        value: '3 0m',
        windows: 0,
        stderr: [
          '⚠️  Digest window not opened — invalid interval: 3 0m (expected e.g. 60, 30m, 2h, 1d). The loop is running.',
        ],
        // The line stays — a reader with a typo'd interval needs to be told about the
        // digest in the place they configured it — and it tells the truth: the value
        // they wrote, and the fact that nothing is running on it.
        box: digestLine('3 0m', false),
      },
      {
        value: '30 m',
        windows: 1,
        stderr: [],
        box: digestLine('30 m'),
      },
    ])
  })

  it.each([
    ['a padded zero', 'RALPH_DIGEST_INTERVAL=" 0 "'],
    ['a padded zero with a unit', 'RALPH_DIGEST_INTERVAL=" 0m "'],
    ['a tab-padded zero', 'RALPH_DIGEST_INTERVAL="\t0h\t"'],
    ['a zero and a note', 'RALPH_DIGEST_INTERVAL=0  # off until the queue drains'],
    ['padded empty single quotes', "RALPH_DIGEST_INTERVAL='  '"],
  ])('%s reads as OFF, with the pre-#62 box byte for byte', async (_label, line) => {
    // Zero is how a shell config turns a knob off, and padding does not change what a
    // user meant by it. The box has to be the box every repo without a digest gets —
    // not `every 0m`, and not a warning about an interval nobody set.
    const d = deps({ config: `TASK_SOURCE=folder\n${line}\n` })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(d.stdout.lines()).toEqual(BOX_WITHOUT_DIGEST)
    expect(d.stderr.output()).toBe('')
    expect(windowCalls(d)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The two entry points, side by side. `ralph start` decides whether to OPEN the window
// and `ralph digest --loop` — inside it, minutes later, in a pane nobody is attached to
// — decides whether to RUN. If those two ever disagree the failure is invisible: a
// window opens, prints one refusal, and sits there dead for the rest of the night with
// the box claiming a digest every 30 minutes.
// ---------------------------------------------------------------------------

describe('QA: start and the digest in the window refuse exactly the same intervals (#62 fix)', () => {
  // One `ralph digest --loop` with an injected clock and one tick, so the answer is
  // "would this interval have run at all" and no suite waits on a timer.
  const loopOnce = async (interval) => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await digestCommand({
      cwd: REPO,
      env: {},
      stdout,
      stderr,
      loop: true,
      interval,
      sleep: async () => {},
      shouldContinue: () => false,
      run: async () => ({ narrative: 'a line', status: 'ok' }),
    })
    return { ran: result.runs > 0, status: result.status, stderr: stderr.lines() }
  }

  const startWith = async (interval) => {
    const d = deps({ config: `TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="${interval}"\n` })
    await startCommand(d)
    return { opened: windowCalls(d).length === 1, stderr: d.stderr.lines() }
  }

  it('agrees on every interval a config can carry — zero disagreements', async () => {
    // The agreement is shared code (duration.js's parseTimerDuration) rather than a
    // number written down twice, and this is the test that proves the sharing rather
    // than trusting it. Reported as a LIST of disagreements so one run names all of
    // them, and compared against [] so the failure message is readable.
    const battery = [
      // accepted, both ends of the range
      '1', '30', '60', '90s', '1m', '30m', '2h', '1d', '7d', '24d',
      '2147483', '2147483s', '35791m', '596h', '30 m', '1S', '30M', '2H', '1D',
      // off / not an interval at all
      '', '   ', '0', '00', '0s', '0m', '0h', '0d', '0.0',
      // past the timer's ceiling
      '2147484', '2147484s', '35792m', '597h', '25d', '30d', '365d', '9999999999',
      String(Number.MAX_SAFE_INTEGER),
      // not the grammar
      '0.5h', '1.5', '-30m', '+30m', '1e3', '1_000', '3 0m', 'abc', '30 minutes', 'm30',
      '30m30s', '1w', '1y', 'Infinity', 'NaN',
    ]
    const disagreements = []
    for (const interval of battery) {
      const [start, loop] = [await startWith(interval), await loopOnce(interval)]
      if (start.opened !== loop.ran) {
        disagreements.push({ interval, startOpenedWindow: start.opened, loopRanDigest: loop.ran })
      }
    }
    expect(disagreements).toEqual([])
  }, 30000)

  it('names the timer ceiling on stderr and opens nothing, at 30d', async () => {
    // The user-visible half of the ceiling: the sentence has to say what is wrong with
    // the value AND what the largest usable one is, because the reader is looking at
    // their own config file while they read it.
    const d = deps({ config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="30d"\n' })
    const result = await startCommand(d)
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(windowCalls(d)).toHaveLength(0)
    expect(d.stderr.lines()).toEqual([
      '⚠️  Digest window not opened — an interval of 30d is longer than a timer can wait (the longest is 24d). The loop is running.',
    ])
    // The loop itself is untouched by the refusal: window 0 was created first and this
    // run reports success.
    expect(d.exec.calls.filter((c) => c.cmd === 'tmux').map((c) => c.args[0])).toEqual([
      'has-session',
      'new',
    ])
  })

  it('opens the window at 24d, the largest interval a timer can hold', async () => {
    // The other side of the same boundary, through the same entry point: one second
    // more is refused above, and this must not be.
    const d = deps({ config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="24d"\n', ralphBinary: PROBE_BIN })
    await startCommand(d)
    expect(windowCalls(d)).toHaveLength(1)
    expect(d.stderr.output()).toBe('')
    const got = await probe(digestCommandString(d))
    expect(got.args).toEqual(['digest', '--loop', '--interval', '24d'])
    // And the interval the window was given is one the loop inside it will hold.
    expect(parseTimerDuration('24d') * 1000).toBeLessThanOrEqual(2 ** 31 - 1)
  })

  it('says the same thing on stderr as the window would have, word for word', async () => {
    // Two channels, two prefixes, one sentence in the middle: `ralph start` wraps the
    // parser's message in "Digest window not opened — … The loop is running." and the
    // loop wraps the same message in "ralph digest: not looping — …". If they ever
    // diverge, a user who reads one and greps for the other finds nothing.
    for (const interval of ['30d', '2147484', '0.5h', '3 0m']) {
      const start = await startWith(interval)
      const loop = await loopOnce(interval)
      const core = start.stderr[0]
        .replace('⚠️  Digest window not opened — ', '')
        .replace('. The loop is running.', '')
      expect(loop.stderr, interval).toEqual([`ralph digest: not looping — ${core}\n`.trimEnd()])
    }
  })
})

// ---------------------------------------------------------------------------
// The shared parser's comment handling, from the end a user sees. #62 widened it (the
// commented-out-value case) and both digest knobs are read through it, so this is where
// the widening either helps or costs someone a digest.
// ---------------------------------------------------------------------------

describe('QA: a note on the config line, read through the launch (#62)', () => {
  it('sends no model when the model line is commented out, and keeps a hash inside one', async () => {
    // `RALPH_DIGEST_MODEL=#haiku` is how the shipped template's own commented example
    // gets half-uncommented, and it must mean "no model" — not a model literally named
    // `#haiku`, which the agent would reject in a pane nobody is watching. A hash in
    // the MIDDLE of a model name is part of the name, because bash reads it that way.
    const off = deps({
      config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\nRALPH_DIGEST_MODEL=#haiku\n',
      ralphBinary: PROBE_BIN,
    })
    await startCommand(off)
    expect(digestCommandString(off)).not.toContain('RALPH_DIGEST_MODEL')
    expect((await probe(digestCommandString(off))).model).toBe('«unset»')

    const kept = deps({
      config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL=30m\nRALPH_DIGEST_MODEL=claude#3\n',
      ralphBinary: PROBE_BIN,
    })
    await startCommand(kept)
    expect((await probe(digestCommandString(kept))).model).toBe('claude#3')
  })

  it('opens the window for a QUOTED interval that carries a note', async () => {
    // The shipped template writes this knob quoted — `RALPH_DIGEST_INTERVAL=""` — so
    // filling it in and annotating the choice is the most likely edit anyone makes to
    // that file, and bash reading the same line gets `30m`.
    //
    // The end-to-end guard for parseConfigVar's quoted-value rule, from the end a user
    // sees. The regression it stops: a parser that only asked whether the value STARTS
    // with a quote handed `"30m" # every half hour` to the duration grammar whole, so
    // this launch opened NO window, warned about an interval nobody typed, and printed a
    // Digest line quoting the comment. Three symptoms, one rule — which is why the
    // assertion below is the window, the argv, the box and stderr together.
    const d = deps({
      config: 'TASK_SOURCE=folder\nRALPH_DIGEST_INTERVAL="30m" # every half hour\n',
      ralphBinary: PROBE_BIN,
    })
    const result = await startCommand(d)
    expect(result.started).toBe(true)
    expect(windowCalls(d)).toHaveLength(1)
    expect((await probe(digestCommandString(d))).args).toEqual([
      'digest',
      '--loop',
      '--interval',
      '30m',
    ])
    expect(d.stdout.lines()).toEqual(boxWithDigest('30m'))
    expect(d.stderr.output()).toBe('')
  })
})
