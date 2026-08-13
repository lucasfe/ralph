import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { upsertEnvContent, writeGlobalCreds } from './global-config-writer.js'

// #5: surgical upsert into the global dotenv file — update matching KEY= lines
// in place, append missing keys, and preserve comments and unrelated lines. The
// writer enforces 0700 on the dir and 0600 on the file and is fully injectable
// (fs impl + path) so these tests drive it against memfs, never the real home.

describe('upsertEnvContent — surgical upsert', () => {
  it('updates a matching KEY= line in place', () => {
    const out = upsertEnvContent('WHATSAPP_PHONE=old\n', { WHATSAPP_PHONE: 'new' })
    expect(out).toBe('WHATSAPP_PHONE=new\n')
  })

  it('appends a key that is missing', () => {
    const out = upsertEnvContent('WHATSAPP_PHONE=+1\n', { CALLMEBOT_KEY: 'abc' })
    expect(out).toBe('WHATSAPP_PHONE=+1\nCALLMEBOT_KEY=abc\n')
  })

  it('preserves comments and unrelated lines while updating', () => {
    const content = [
      '# my ralph config',
      'RALPH_STARTUP_MESSAGE=hi',
      '',
      'CALLMEBOT_KEY=old',
      '# trailing note',
    ].join('\n') + '\n'
    const out = upsertEnvContent(content, { CALLMEBOT_KEY: 'new', WHATSAPP_PHONE: '+1' })
    expect(out).toBe(
      [
        '# my ralph config',
        'RALPH_STARTUP_MESSAGE=hi',
        '',
        'CALLMEBOT_KEY=new',
        '# trailing note',
        'WHATSAPP_PHONE=+1',
      ].join('\n') + '\n',
    )
  })

  it('handles the export prefix when matching a key', () => {
    const out = upsertEnvContent('export CALLMEBOT_KEY=old\n', { CALLMEBOT_KEY: 'new' })
    expect(out).toBe('CALLMEBOT_KEY=new\n')
  })

  it('writes both keys into an empty file', () => {
    const out = upsertEnvContent('', { WHATSAPP_PHONE: '+1', CALLMEBOT_KEY: 'abc' })
    expect(out).toBe('WHATSAPP_PHONE=+1\nCALLMEBOT_KEY=abc\n')
  })
})

describe('writeGlobalCreds — injectable file writer', () => {
  const HOME = '/home/test'
  const PATH = join(HOME, '.config', 'ralph', '.env')

  function fsVol(seed = {}) {
    const vol = Volume.fromJSON(seed, '/')
    return vol
  }

  it('creates the file at the resolved global path with 0600 and dir 0700', () => {
    const vol = fsVol()
    const path = writeGlobalCreds({
      values: { WHATSAPP_PHONE: '+1', CALLMEBOT_KEY: 'abc' },
      fs: vol,
      home: HOME,
      processEnv: {},
    })
    expect(path).toBe(PATH)
    expect(vol.readFileSync(PATH, 'utf8')).toContain('WHATSAPP_PHONE=+1')
    expect(vol.readFileSync(PATH, 'utf8')).toContain('CALLMEBOT_KEY=abc')
    expect(vol.statSync(PATH).mode & 0o777).toBe(0o600)
    expect(vol.statSync(join(HOME, '.config', 'ralph')).mode & 0o777).toBe(0o700)
  })

  it('honors XDG_CONFIG_HOME for the path', () => {
    const vol = fsVol()
    const path = writeGlobalCreds({
      values: { WHATSAPP_PHONE: '+1' },
      fs: vol,
      home: HOME,
      processEnv: { XDG_CONFIG_HOME: '/xdg' },
    })
    expect(path).toBe(join('/xdg', 'ralph', '.env'))
    expect(vol.readFileSync(path, 'utf8')).toContain('WHATSAPP_PHONE=+1')
  })

  it('preserves existing unrelated content on update', () => {
    const seed = {
      [PATH]: '# note\nRALPH_STARTUP_MESSAGE=hi\nWHATSAPP_PHONE=old\n',
    }
    const vol = fsVol(seed)
    writeGlobalCreds({
      values: { WHATSAPP_PHONE: 'new', CALLMEBOT_KEY: 'abc' },
      fs: vol,
      home: HOME,
      processEnv: {},
    })
    const out = vol.readFileSync(PATH, 'utf8')
    expect(out).toContain('# note')
    expect(out).toContain('RALPH_STARTUP_MESSAGE=hi')
    expect(out).toContain('WHATSAPP_PHONE=new')
    expect(out).toContain('CALLMEBOT_KEY=abc')
    expect(out).not.toContain('WHATSAPP_PHONE=old')
  })
})
