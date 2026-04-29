import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import {
  buildPlist,
  getAgentStatus,
  installAgent,
  labelFor,
  listInstalledAgents,
  loadAgent,
  parsePlistMetadata,
  pauseAgent,
  plistPathFor,
  removeAgent,
  resumeAgent,
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

describe('pauseAgent', () => {
  it('runs `launchctl unload -w` but keeps the plist file on disk', async () => {
    const v = vol({ [PLIST_PATH]: '<plist/>' })
    const exec = makeExec()
    const result = await pauseAgent({ slug: SLUG, home: HOME, fsImpl: v, exec })
    expect(result.paused).toBe(true)
    expect(result.plistPath).toBe(PLIST_PATH)
    expect(v.existsSync(PLIST_PATH)).toBe(true)
    const call = exec.calls.find((c) => c.cmd === 'launchctl')
    expect(call).toBeDefined()
    expect(call.args).toEqual(['unload', '-w', PLIST_PATH])
  })

  it('returns paused:false and does not call launchctl when the plist is missing', async () => {
    const v = vol()
    const exec = makeExec()
    const result = await pauseAgent({ slug: SLUG, home: HOME, fsImpl: v, exec })
    expect(result.paused).toBe(false)
    expect(exec.calls.length).toBe(0)
  })
})

describe('resumeAgent', () => {
  it('runs `launchctl load -w` against the existing plist', async () => {
    const v = vol({ [PLIST_PATH]: '<plist/>' })
    const exec = makeExec()
    const result = await resumeAgent({
      slug: SLUG,
      home: HOME,
      fsImpl: v,
      exec,
    })
    expect(result.resumed).toBe(true)
    expect(result.plistPath).toBe(PLIST_PATH)
    const call = exec.calls.find((c) => c.cmd === 'launchctl')
    expect(call.args).toEqual(['load', '-w', PLIST_PATH])
  })

  it('returns resumed:false and does not call launchctl when the plist is missing', async () => {
    const v = vol()
    const exec = makeExec()
    const result = await resumeAgent({
      slug: SLUG,
      home: HOME,
      fsImpl: v,
      exec,
    })
    expect(result.resumed).toBe(false)
    expect(exec.calls.length).toBe(0)
  })
})

describe('parsePlistMetadata', () => {
  it('extracts WorkingDirectory and StartInterval', () => {
    const xml = buildPlist({
      slug: SLUG,
      command: '/usr/local/bin/ralph',
      args: ['cycle'],
      intervalSeconds: 1800,
      workingDirectory: '/Users/me/repos/agenthub',
      logDir: '/Users/me/repos/agenthub/logs',
      environment: { PATH: '/usr/bin' },
    })
    const meta = parsePlistMetadata(xml)
    expect(meta.workingDirectory).toBe('/Users/me/repos/agenthub')
    expect(meta.intervalSeconds).toBe(1800)
  })

  it('returns nulls when input is empty or unrecognized', () => {
    expect(parsePlistMetadata('')).toEqual({
      workingDirectory: null,
      intervalSeconds: null,
    })
    expect(parsePlistMetadata(null)).toEqual({
      workingDirectory: null,
      intervalSeconds: null,
    })
    expect(parsePlistMetadata('<plist/>')).toEqual({
      workingDirectory: null,
      intervalSeconds: null,
    })
  })

  it('unescapes XML entities in WorkingDirectory', () => {
    const xml =
      '<key>WorkingDirectory</key>\n<string>/path/&lt;weird &amp; thing&gt;</string>\n' +
      '<key>StartInterval</key>\n<integer>60</integer>'
    const meta = parsePlistMetadata(xml)
    expect(meta.workingDirectory).toBe('/path/<weird & thing>')
    expect(meta.intervalSeconds).toBe(60)
  })
})

describe('listInstalledAgents', () => {
  const LAUNCH_DIR = `${HOME}/Library/LaunchAgents`

  function makePlist(slug, workingDirectory, intervalSeconds) {
    return buildPlist({
      slug,
      command: '/usr/local/bin/ralph',
      args: ['cycle'],
      intervalSeconds,
      workingDirectory,
      logDir: `${workingDirectory}/logs`,
      environment: { PATH: '/usr/bin' },
    })
  }

  it('returns an empty array when LaunchAgents directory does not exist', () => {
    const v = vol()
    expect(listInstalledAgents({ home: HOME, fsImpl: v })).toEqual([])
  })

  it('returns an empty array when no com.lucasfe.ralph.cycle.* plists exist', () => {
    const v = vol({
      [`${LAUNCH_DIR}/com.example.something.plist`]: '<plist/>',
      [`${LAUNCH_DIR}/com.lucasfe.other.plist`]: '<plist/>',
    })
    expect(listInstalledAgents({ home: HOME, fsImpl: v })).toEqual([])
  })

  it('returns one entry per matching plist with parsed metadata, sorted by slug', () => {
    const repoA = '/Users/me/repos/aaa-repo'
    const repoB = '/Users/me/repos/zzz-repo'
    const v = vol({
      [`${LAUNCH_DIR}/com.lucasfe.ralph.cycle.zzz-repo.plist`]: makePlist(
        'zzz-repo',
        repoB,
        7200,
      ),
      [`${LAUNCH_DIR}/com.lucasfe.ralph.cycle.aaa-repo.plist`]: makePlist(
        'aaa-repo',
        repoA,
        14400,
      ),
      [`${LAUNCH_DIR}/com.example.unrelated.plist`]: '<plist/>',
    })
    const list = listInstalledAgents({ home: HOME, fsImpl: v })
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({
      slug: 'aaa-repo',
      label: 'com.lucasfe.ralph.cycle.aaa-repo',
      workingDirectory: repoA,
      intervalSeconds: 14400,
    })
    expect(list[1]).toMatchObject({
      slug: 'zzz-repo',
      workingDirectory: repoB,
      intervalSeconds: 7200,
    })
  })

  it('still returns an entry when a plist is unreadable, with null metadata', () => {
    const v = vol({
      [`${LAUNCH_DIR}/com.lucasfe.ralph.cycle.broken.plist`]: 'not xml at all',
    })
    const list = listInstalledAgents({ home: HOME, fsImpl: v })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      slug: 'broken',
      label: 'com.lucasfe.ralph.cycle.broken',
      workingDirectory: null,
      intervalSeconds: null,
    })
  })
})
