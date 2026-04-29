import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import {
  buildPlist,
  getAgentStatus,
  installAgent,
  labelFor,
  loadAgent,
  plistPathFor,
  removeAgent,
  unloadAgent,
} from './launchd.js'

const HOME = '/Users/me'
const SLUG = 'agenthub'
const LABEL = `com.lucasfe.ralph.cycle.${SLUG}`
const PLIST_PATH = `${HOME}/Library/LaunchAgents/${LABEL}.plist`

function vol(initial = {}) {
  const v = Volume.fromJSON(initial, '/')
  return v
}

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    if (Object.prototype.hasOwnProperty.call(handlers, key)) {
      const v = handlers[key]
      return typeof v === 'function' ? v({ cmd, args, options }) : v
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

describe('labelFor', () => {
  it('builds com.lucasfe.ralph.cycle.<slug>', () => {
    expect(labelFor('agenthub')).toBe('com.lucasfe.ralph.cycle.agenthub')
    expect(labelFor('my-app')).toBe('com.lucasfe.ralph.cycle.my-app')
  })
})

describe('plistPathFor', () => {
  it('returns ~/Library/LaunchAgents/<label>.plist using the given home', () => {
    expect(plistPathFor('agenthub', HOME)).toBe(PLIST_PATH)
  })

  it('differs per slug', () => {
    expect(plistPathFor('a', HOME)).not.toBe(plistPathFor('b', HOME))
  })
})

describe('buildPlist', () => {
  const baseInput = {
    slug: SLUG,
    command: '/usr/local/bin/ralph',
    args: ['cycle'],
    intervalSeconds: 14400,
    workingDirectory: '/Users/me/repos/agenthub',
    logDir: '/Users/me/repos/agenthub/logs',
    environment: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
  }

  it('includes the Label key derived from slug', () => {
    const xml = buildPlist(baseInput)
    expect(xml).toContain('<key>Label</key>')
    expect(xml).toContain(`<string>${LABEL}</string>`)
  })

  it('includes ProgramArguments with command + args in order', () => {
    const xml = buildPlist({ ...baseInput, args: ['cycle', '--verbose'] })
    expect(xml).toMatch(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/usr\/local\/bin\/ralph<\/string>\s*<string>cycle<\/string>\s*<string>--verbose<\/string>\s*<\/array>/,
    )
  })

  it('includes WorkingDirectory', () => {
    const xml = buildPlist(baseInput)
    expect(xml).toContain('<key>WorkingDirectory</key>')
    expect(xml).toContain('<string>/Users/me/repos/agenthub</string>')
  })

  it('includes StartInterval as <integer>', () => {
    const xml = buildPlist(baseInput)
    expect(xml).toMatch(/<key>StartInterval<\/key>\s*<integer>14400<\/integer>/)
  })

  it('includes RunAtLoad set to false', () => {
    const xml = buildPlist(baseInput)
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/)
  })

  it('includes StandardOutPath and StandardErrorPath under logDir', () => {
    const xml = buildPlist(baseInput)
    expect(xml).toContain(
      '<string>/Users/me/repos/agenthub/logs/ralph-cycle.out.log</string>',
    )
    expect(xml).toContain(
      '<string>/Users/me/repos/agenthub/logs/ralph-cycle.err.log</string>',
    )
  })

  it('includes EnvironmentVariables with the PATH entry', () => {
    const xml = buildPlist(baseInput)
    expect(xml).toMatch(
      /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>\s*<\/dict>/,
    )
  })

  it('always sets a default PATH when environment is not provided', () => {
    const xml = buildPlist({ ...baseInput, environment: undefined })
    expect(xml).toContain('<key>PATH</key>')
    expect(xml).toMatch(/<string>[^<]*\/usr\/bin[^<]*<\/string>/)
  })

  it('escapes XML-unsafe characters in working directory', () => {
    const xml = buildPlist({
      ...baseInput,
      workingDirectory: '/Users/me/<weird & path>',
    })
    expect(xml).toContain(
      '<string>/Users/me/&lt;weird &amp; path&gt;</string>',
    )
  })

  it('starts with the XML prolog and DOCTYPE', () => {
    const xml = buildPlist(baseInput)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain(
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    )
    expect(xml).toContain('<plist version="1.0">')
  })
})

describe('installAgent', () => {
  const baseInput = {
    slug: SLUG,
    command: '/usr/local/bin/ralph',
    args: ['cycle'],
    intervalSeconds: 14400,
    workingDirectory: '/Users/me/repos/agenthub',
    logDir: '/Users/me/repos/agenthub/logs',
    environment: { PATH: '/opt/homebrew/bin:/usr/bin' },
    home: HOME,
  }

  it('writes the plist to ~/Library/LaunchAgents and runs `launchctl load -w` on it', async () => {
    const v = vol()
    const exec = makeExec()
    const result = await installAgent({ ...baseInput, fsImpl: v, exec })
    expect(result.plistPath).toBe(PLIST_PATH)
    expect(result.label).toBe(LABEL)
    expect(v.existsSync(PLIST_PATH)).toBe(true)
    const written = v.readFileSync(PLIST_PATH, 'utf8').toString()
    expect(written).toContain(LABEL)
    expect(written).toContain('<integer>14400</integer>')
    const loadCall = exec.calls.find((c) => c.cmd === 'launchctl')
    expect(loadCall).toBeDefined()
    expect(loadCall.args).toEqual(['load', '-w', PLIST_PATH])
  })

  it('creates the LaunchAgents directory if missing', async () => {
    const v = vol()
    const exec = makeExec()
    await installAgent({ ...baseInput, fsImpl: v, exec })
    expect(v.existsSync(`${HOME}/Library/LaunchAgents`)).toBe(true)
  })

  it('overwrites an existing plist (caller is responsible for safety)', async () => {
    const v = vol({
      [PLIST_PATH]: '<old/>',
    })
    v.mkdirSync(`${HOME}/Library/LaunchAgents`, { recursive: true })
    const exec = makeExec()
    await installAgent({ ...baseInput, fsImpl: v, exec })
    const written = v.readFileSync(PLIST_PATH, 'utf8').toString()
    expect(written).not.toBe('<old/>')
    expect(written).toContain(LABEL)
  })
})

describe('removeAgent', () => {
  it('runs `launchctl unload -w` and deletes the plist when present', async () => {
    const v = vol({
      [PLIST_PATH]: '<plist/>',
    })
    const exec = makeExec()
    const result = await removeAgent({ slug: SLUG, home: HOME, fsImpl: v, exec })
    expect(result.removed).toBe(true)
    expect(result.plistPath).toBe(PLIST_PATH)
    expect(v.existsSync(PLIST_PATH)).toBe(false)
    const unloadCall = exec.calls.find((c) => c.cmd === 'launchctl')
    expect(unloadCall.args).toEqual(['unload', '-w', PLIST_PATH])
  })

  it('returns removed:false and does not call launchctl when the plist is missing', async () => {
    const v = vol()
    const exec = makeExec()
    const result = await removeAgent({ slug: SLUG, home: HOME, fsImpl: v, exec })
    expect(result.removed).toBe(false)
    expect(exec.calls.length).toBe(0)
  })
})

describe('loadAgent / unloadAgent', () => {
  it('loadAgent invokes launchctl load -w <path>', async () => {
    const exec = makeExec()
    await loadAgent({ plistPath: PLIST_PATH, exec })
    expect(exec.calls[0].cmd).toBe('launchctl')
    expect(exec.calls[0].args).toEqual(['load', '-w', PLIST_PATH])
  })

  it('unloadAgent invokes launchctl unload -w <path>', async () => {
    const exec = makeExec()
    await unloadAgent({ plistPath: PLIST_PATH, exec })
    expect(exec.calls[0].cmd).toBe('launchctl')
    expect(exec.calls[0].args).toEqual(['unload', '-w', PLIST_PATH])
  })
})

describe('getAgentStatus', () => {
  it('returns loaded:true with parsed last exit code and run interval from `launchctl print`', async () => {
    const exec = makeExec({
      [`launchctl print gui/501/${LABEL}`]: {
        exitCode: 0,
        stdout: [
          `${LABEL} = {`,
          '\tactive count = 0',
          '\tlast exit code = 0',
          '\trun interval = 14400',
          '}',
        ].join('\n'),
        stderr: '',
      },
    })
    const status = await getAgentStatus({ slug: SLUG, exec, uid: 501 })
    expect(status.loaded).toBe(true)
    expect(status.lastExitCode).toBe(0)
    expect(status.nextRun).toMatchObject({ intervalSeconds: 14400 })
  })

  it('falls back to `launchctl list <label>` when print fails but list succeeds', async () => {
    const exec = makeExec({
      [`launchctl print gui/501/${LABEL}`]: {
        exitCode: 113,
        stdout: '',
        stderr: 'service is not loaded',
      },
      [`launchctl list ${LABEL}`]: {
        exitCode: 0,
        stdout: '{\n\t"LastExitStatus" = 0;\n};\n',
        stderr: '',
      },
    })
    const status = await getAgentStatus({ slug: SLUG, exec, uid: 501 })
    expect(status.loaded).toBe(true)
    expect(status.lastExitCode).toBe(0)
  })

  it('returns loaded:false when both print and list fail', async () => {
    const exec = makeExec({
      [`launchctl print gui/501/${LABEL}`]: {
        exitCode: 113,
        stdout: '',
        stderr: 'service is not loaded',
      },
      [`launchctl list ${LABEL}`]: {
        exitCode: 1,
        stdout: '',
        stderr: 'unknown',
      },
    })
    const status = await getAgentStatus({ slug: SLUG, exec, uid: 501 })
    expect(status.loaded).toBe(false)
    expect(status.lastExitCode).toBeNull()
    expect(status.nextRun).toBeNull()
  })

  it('captures a non-zero last exit code from launchctl print', async () => {
    const exec = makeExec({
      [`launchctl print gui/501/${LABEL}`]: {
        exitCode: 0,
        stdout: 'last exit code = 1\nrun interval = 14400\n',
        stderr: '',
      },
    })
    const status = await getAgentStatus({ slug: SLUG, exec, uid: 501 })
    expect(status.loaded).toBe(true)
    expect(status.lastExitCode).toBe(1)
  })
})
