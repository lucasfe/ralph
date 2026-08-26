import { describe, it, expect } from 'vitest'
import {
  scheduleInstallCommand,
  scheduleRemoveCommand,
  schedulePauseCommand,
  scheduleResumeCommand,
  scheduleStatusCommand,
  scheduleHeartbeatCommand,
  ScheduleAbort,
} from './schedule.js'
import { buildPlist } from '../launchd.js'
import { isUpdateCheckDisabled } from '../update-check.js'

// #6 QA augmentation — all six schedule subcommands guard on platform and, when
// #6 translated them, must emit the SAME English "only supports macOS" line
// with the detected platform interpolated. The dev did not add a parametrized
// test that every entry point stays consistent; a one-sided miss (one command
// left in Portuguese) would slip through otherwise.

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

const COMMANDS = [
  ['scheduleInstallCommand', scheduleInstallCommand],
  ['scheduleRemoveCommand', scheduleRemoveCommand],
  ['schedulePauseCommand', schedulePauseCommand],
  ['scheduleResumeCommand', scheduleResumeCommand],
  ['scheduleStatusCommand', scheduleStatusCommand],
  ['scheduleHeartbeatCommand', scheduleHeartbeatCommand],
]

describe('QA schedule — every platform guard emits identical English on non-mac (#6)', () => {
  it.each(COMMANDS)('%s rejects linux with the English "only supports macOS" line + platform', async (_name, cmd) => {
    const stderr = makeStream()
    await expect(
      cmd({ stderr, stdout: makeStream(), platform: 'linux' }),
    ).rejects.toBeInstanceOf(ScheduleAbort)
    expect(stderr.output()).toContain('❌ ralph schedule only supports macOS (detected: linux).')
    // The detected platform is interpolated, not hard-coded.
    expect(stderr.output()).not.toMatch(/só suporta|detectado/)
  })

  it.each(COMMANDS)('%s interpolates the ACTUAL platform value (windows) into the message', async (_name, cmd) => {
    const stderr = makeStream()
    await expect(
      cmd({ stderr, stdout: makeStream(), platform: 'windows' }),
    ).rejects.toBeInstanceOf(ScheduleAbort)
    expect(stderr.output()).toContain('(detected: windows).')
  })
})

// #51 QA augmentation — the plist environment. `ralph cycle` now runs the update
// gate inside its lock, and a launchd agent reads no shell profile, so the
// documented off-switch only reaches it through the plist's EnvironmentVariables
// dict. schedule.test.js pins the fresh-install forwarding (set / unset / empty).
// This group attacks the parts that file does not reach:
//
//   * the `--force` re-install RE-TAKING the snapshot, which README now promises
//     and which the relocated tests no longer cover (they install into a machine
//     with no plists, so the force path never runs);
//   * the values that keep the check ON surviving verbatim instead of being
//     helpfully normalized away;
//   * the round trip — the env dict the install writes, read back through the
//     runtime predicate that actually decides, so "forwarded" is proven to mean
//     "honored" rather than "present";
//   * everything the install must NOT forward: credentials (the plist lives in
//     ~/Library/LaunchAgents, which is not a 0600 secret store), the heartbeat
//     time it consumes into StartCalendarInterval, and every other RALPH_* var;
//   * XML: the value is caller-controlled text spliced into a document, so a
//     `<`/`&`/`"`/newline payload must not be able to break out of its <string>.
describe('QA schedule #51 — the forwarded opt-out has to survive the trip', () => {
  const HOME = '/Users/me'
  const REPO = '/Users/me/repos/agenthub'
  const SLUG = 'agenthub'

  function trackInstalls() {
    const calls = []
    const installAgent = async (args) => {
      calls.push(args)
      const kind = args.kind ?? 'cycle'
      return {
        plistPath: `${HOME}/Library/LaunchAgents/label-${kind}.plist`,
        label: `label-${kind}`,
        kind,
        loadResult: { exitCode: 0 },
      }
    }
    installAgent.calls = calls
    installAgent.env = (kind = 'cycle') =>
      calls.find((c) => c.kind === kind)?.environment
    return installAgent
  }

  const makeExec = () => async (cmd, args) =>
    `${cmd} ${args.join(' ')}` === 'git rev-parse --show-toplevel'
      ? { exitCode: 0, stdout: `${REPO}\n`, stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' }

  // A machine with no agents installed yet, unless a test says otherwise.
  const install = async (overrides = {}) => {
    const installAgent = overrides.installAgent ?? trackInstalls()
    await scheduleInstallCommand({
      cwd: REPO,
      stdout: makeStream(),
      stderr: makeStream(),
      exec: makeExec(),
      exists: (p) => !p.endsWith('.plist'),
      home: HOME,
      platform: 'mac',
      ralphBinary: '/usr/local/bin/ralph',
      loadEnv: () => ({}),
      removeAgent: async () => ({}),
      ...overrides,
      installAgent,
    })
    return installAgent
  }

  it('a --force re-install re-takes the snapshot: dropping the var drops the key', async () => {
    // README's new paragraph promises the value is captured at install time and
    // that changing your mind means `ralph schedule install --force`. Nothing
    // tested the second half, and the force path is a DIFFERENT branch — it runs
    // removeAgent first — so it needs its own coverage.
    const first = await install({
      processEnv: { PATH: '/usr/bin', RALPH_NO_UPDATE_CHECK: '1' },
    })
    expect(first.env().RALPH_NO_UPDATE_CHECK).toBe('1')

    const removals = []
    const second = await install({
      exists: () => true,
      force: true,
      removeAgent: async (args) => {
        removals.push(args.kind)
        return {}
      },
      processEnv: { PATH: '/usr/bin' },
    })
    expect(removals).toEqual(['cycle', 'heartbeat'])
    expect(Object.keys(second.env())).toEqual(['PATH'])
  })

  it('a --force re-install re-takes the snapshot: adding the var adds the key', async () => {
    const first = await install({ processEnv: { PATH: '/usr/bin' } })
    expect(Object.keys(first.env())).toEqual(['PATH'])

    const second = await install({
      exists: () => true,
      force: true,
      processEnv: { PATH: '/usr/bin', RALPH_NO_UPDATE_CHECK: 'yes' },
    })
    expect(second.env().RALPH_NO_UPDATE_CHECK).toBe('yes')
    expect(second.env('heartbeat').RALPH_NO_UPDATE_CHECK).toBe('yes')
  })

  it('a --force re-install re-takes the snapshot: a CHANGED value replaces the old one', async () => {
    const second = await install({
      exists: () => true,
      force: true,
      processEnv: { PATH: '/usr/bin', RALPH_NO_UPDATE_CHECK: 'off' },
    })
    expect(second.env().RALPH_NO_UPDATE_CHECK).toBe('off')
  })

  // The values isUpdateCheckDisabled() deliberately treats as "keep checking".
  // They must be forwarded VERBATIM rather than dropped as "not really an
  // opt-out": the plist is a snapshot, and a `0` in it is the user pinning the
  // check ON for scheduled runs even if their shell later says otherwise.
  for (const keepOn of ['0', 'false', 'FALSE', ' 0 ', 'False']) {
    it(`forwards the check-stays-on value ${JSON.stringify(keepOn)} verbatim`, async () => {
      const agent = await install({
        processEnv: { PATH: '/usr/bin', RALPH_NO_UPDATE_CHECK: keepOn },
      })
      expect(agent.env().RALPH_NO_UPDATE_CHECK).toBe(keepOn)
      // And it still means "keep checking" once launchd hands it back.
      expect(isUpdateCheckDisabled(agent.env())).toBe(false)
    })
  }

  // The round trip: whatever lands in the dict is read by the SAME predicate
  // resolveUpdateDecision uses, so this is the acceptance criterion end to end
  // rather than a claim about a key being present.
  for (const disabling of ['1', 'true', 'TRUE', 'yes', 'no', 'off', 'disabled', ' 1 ']) {
    it(`a scheduled run really is silenced by ${JSON.stringify(disabling)}`, async () => {
      const agent = await install({
        processEnv: { PATH: '/usr/bin', RALPH_NO_UPDATE_CHECK: disabling },
      })
      expect(isUpdateCheckDisabled(agent.env())).toBe(true)
      expect(isUpdateCheckDisabled(agent.env('heartbeat'))).toBe(true)
    })
  }

  it('a scheduled run still checks when the var was never set', async () => {
    const agent = await install({ processEnv: { PATH: '/usr/bin' } })
    expect(isUpdateCheckDisabled(agent.env())).toBe(false)
  })

  it('never forwards credentials into the plist', async () => {
    // ~/Library/LaunchAgents is not a secret store — writeGlobalCreds goes to
    // 0600 ~/.config/ralph/.env precisely because this file is not that. The
    // shell loop and the heartbeat resolve creds at RUNTIME from .env.local and
    // the global config, so there is nothing to forward and everything to lose.
    const agent = await install({
      processEnv: {
        PATH: '/usr/bin',
        RALPH_NO_UPDATE_CHECK: '1',
        CALLMEBOT_KEY: 'super-secret',
        WHATSAPP_PHONE: '+15550001111',
        HEALTHCHECK_URL: 'https://hc-ping.com/secret-uuid',
        GH_TOKEN: 'ghp_secret',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
      },
      loadEnv: () => ({ CALLMEBOT_KEY: 'super-secret', WHATSAPP_PHONE: '+15550001111' }),
    })
    expect(Object.keys(agent.env()).sort()).toEqual(['PATH', 'RALPH_NO_UPDATE_CHECK'])
    expect(JSON.stringify(agent.env())).not.toMatch(/secret|ghp_|sk-ant|\+1555/)
  })

  it('consumes RALPH_DAILY_SUMMARY_TIME into the schedule instead of forwarding it', async () => {
    const agent = await install({
      processEnv: {
        PATH: '/usr/bin',
        RALPH_NO_UPDATE_CHECK: '1',
        RALPH_DAILY_SUMMARY_TIME: '07:30',
      },
    })
    const heartbeat = agent.calls.find((c) => c.kind === 'heartbeat')
    expect(heartbeat.startCalendarInterval).toEqual({ hour: 7, minute: 30 })
    expect(Object.keys(agent.env()).sort()).toEqual(['PATH', 'RALPH_NO_UPDATE_CHECK'])
  })

  it('forwards ONE key, not every RALPH_* var it can see', async () => {
    const agent = await install({
      processEnv: {
        PATH: '/usr/bin',
        RALPH_NO_UPDATE_CHECK: '1',
        RALPH_AGENT: 'codex',
        TASK_SOURCE: 'folder',
        RALPH_DEBUG: '1',
      },
    })
    expect(Object.keys(agent.env()).sort()).toEqual(['PATH', 'RALPH_NO_UPDATE_CHECK'])
  })

  it('does not forward an opt-out that only exists in .env.local', async () => {
    // Correct as-is, and pinned so it stays deliberate: the runtime gate reads
    // the process env and never .env.local (same as `ralph start`), so
    // forwarding it from there would create a knob that looks honored in the
    // plist and is ignored by every non-scheduled run.
    const agent = await install({
      exists: (p) => !p.endsWith('.plist'),
      loadEnv: () => ({ RALPH_NO_UPDATE_CHECK: '1', CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' }),
      processEnv: { PATH: '/usr/bin' },
    })
    expect(Object.keys(agent.env())).toEqual(['PATH'])
  })

  // Non-string values cannot come from a real process.env, but they can from an
  // injected bag, and escapeXml()'s String() coercion is the only thing standing
  // between them and a malformed document.
  for (const [label, value] of [
    ['a number', 1],
    ['a boolean', true],
    ['an object', {}],
    ['an array', ['1']],
    ['a symbol', Symbol('nope')],
  ]) {
    it(`survives ${label} as the value without malforming the plist`, async () => {
      const agent = await install({
        processEnv: { PATH: '/usr/bin', RALPH_NO_UPDATE_CHECK: value },
      })
      expect(agent.env().RALPH_NO_UPDATE_CHECK).toBe(value)
      expect(() => plistFor(agent.env())).not.toThrow()
      expect(structure(plistFor(agent.env()))).toEqual(structure(BENIGN_PLIST))
      // Whatever it stringifies to, the runtime predicate must still answer
      // without throwing rather than aborting a cycle over a hostile bag.
      expect(() => isUpdateCheckDisabled(agent.env())).not.toThrow()
    })
  }

  it('drops a numeric 0, which lands on the same answer as forwarding it would', async () => {
    // The `if (processEnv.X)` truthiness check drops number 0 where it keeps the
    // string '0'. Harmless — both mean "keep checking" — but pinned so the
    // asymmetry is a known one rather than a surprise.
    const agent = await install({
      processEnv: { PATH: '/usr/bin', RALPH_NO_UPDATE_CHECK: 0 },
    })
    expect(Object.keys(agent.env())).toEqual(['PATH'])
    expect(isUpdateCheckDisabled(agent.env())).toBe(false)
    expect(isUpdateCheckDisabled({ RALPH_NO_UPDATE_CHECK: 0 })).toBe(false)
  })

  // ---- XML: the value is caller text spliced into a document. -------------
  const plistFor = (environment) =>
    buildPlist({
      slug: SLUG,
      command: '/usr/local/bin/ralph',
      args: ['cycle'],
      intervalSeconds: 14400,
      workingDirectory: REPO,
      logDir: `${REPO}/logs`,
      environment,
      kind: 'cycle',
    })

  // Structural fingerprint: tag counts, which is what "well-formed and not
  // broken out of" reduces to here. Compared against a benign document rather
  // than hard-coded, so it survives any future plist-layout change.
  const structure = (xml) => ({
    key: (xml.match(/<key>/g) || []).length,
    string: (xml.match(/<string>/g) || []).length,
    stringClose: (xml.match(/<\/string>/g) || []).length,
    dict: (xml.match(/<dict>/g) || []).length,
    dictClose: (xml.match(/<\/dict>/g) || []).length,
    array: (xml.match(/<array>/g) || []).length,
    integer: (xml.match(/<integer>/g) || []).length,
    programArguments: (xml.match(/<key>ProgramArguments<\/key>/g) || []).length,
  })
  const BENIGN_PLIST = plistFor({ PATH: '/usr/bin', RALPH_NO_UPDATE_CHECK: '1' })

  // The text content of the <string> that follows a given <key>, i.e. exactly the
  // span the payload controls. Non-greedy, so a payload carrying its own
  // `</string>` cannot widen it.
  const valueOf = (xml, key) =>
    xml.match(new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`))?.[1]

  // Entity decode in the inverse order of escapeXml (& LAST), so an escaping bug
  // shows up as a round-trip mismatch instead of being quietly undone here.
  const decode = (s) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')

  for (const [label, payload] of [
    ['an XML break-out attempt', '1</string><key>ProgramArguments</key><array><string>/bin/sh</string></array><string>x'],
    ['a bare closing tag', '</string>'],
    ['a forged dict', '</string></dict><dict><key>RunAtLoad</key><true/><string>x'],
    ['an ampersand', 'a&b'],
    ['a quote', 'say "yes"'],
    ['an apostrophe', "it's on"],
    ['a less-than', '<1'],
    ['a greater-than', '>1'],
    ['an entity that is already escaped', '&amp;lt;'],
    ['a newline', '1\nRALPH_NO_UPDATE_CHECK=0'],
    ['a CRLF plus a forged key', '1\r\n<key>Label</key>'],
    ['an inline forged key', '1 <key>x</key>'],
  ]) {
    it(`escapes ${label} instead of letting it restructure the plist`, async () => {
      const agent = await install({
        processEnv: { PATH: '/usr/bin', RALPH_NO_UPDATE_CHECK: payload },
      })
      const xml = plistFor(agent.env())
      // Same shape as a benign document: no element added, none closed early.
      expect(structure(xml)).toEqual(structure(BENIGN_PLIST))
      // The one key is still one key, and nothing new appeared beside it.
      expect((xml.match(/<key>RALPH_NO_UPDATE_CHECK<\/key>/g) || []).length).toBe(1)
      // The span the payload controls carries no live markup...
      const value = valueOf(xml, 'RALPH_NO_UPDATE_CHECK')
      expect(value).toBeDefined()
      expect(value).not.toMatch(/[<>"]/)
      expect(value).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/)
      // ...and the escaping is lossless, so launchd hands the cycle back the
      // exact string the user set: a hostile value is inert, not mangled.
      expect(decode(value)).toBe(String(payload))
    })
  }

  it('a throwing getter on the new key fails exactly like a throwing getter on PATH', async () => {
    // Neither read is guarded, and that is consistent rather than a regression:
    // scheduleInstallCommand is not a total function (it already throws
    // ScheduleAbort, and already reads processEnv.PATH and
    // processEnv.RALPH_DAILY_SUMMARY_TIME unguarded). What matters is that the
    // new read adds no NEW failure mode of its own and installs nothing on the
    // way out. Asserted differentially so it cannot pass by both runs aborting
    // somewhere earlier and in common.
    const results = []
    for (const key of ['PATH', 'RALPH_NO_UPDATE_CHECK']) {
      const installAgent = trackInstalls()
      const processEnv = { PATH: '/usr/bin' }
      Object.defineProperty(processEnv, key, {
        enumerable: true,
        get() {
          throw new Error(`getter: ${key}`)
        },
      })
      const outcome = await install({ processEnv, installAgent }).then(
        () => 'resolved',
        (e) => e.message,
      )
      results.push(outcome)
      expect(installAgent.calls).toEqual([])
    }
    expect(results).toEqual(['getter: PATH', 'getter: RALPH_NO_UPDATE_CHECK'])
  })

  it('an install on a machine that never set it writes the pre-#51 plist byte for byte', async () => {
    // The compatibility half of the fix: the overwhelmingly common install must
    // be unchanged, not merely "close".
    const agent = await install({ processEnv: { PATH: '/usr/local/bin:/usr/bin' } })
    expect(plistFor(agent.env())).toBe(
      plistFor({ PATH: '/usr/local/bin:/usr/bin' }),
    )
  })
})
