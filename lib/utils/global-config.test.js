import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { globalConfigPath, createCredentialResolver } from './global-config.js'

// #3: a single shared source of truth for (a) the global config path and (b)
// the repo → process.env → global precedence chain. These unit tests inject
// loadEnv + processEnv + home so no real filesystem is ever touched.

describe('globalConfigPath — resolve ~/.config/ralph/.env honoring XDG_CONFIG_HOME', () => {
  it('uses $XDG_CONFIG_HOME when set', () => {
    const path = globalConfigPath({
      processEnv: { XDG_CONFIG_HOME: '/xdg' },
      home: '/home/me',
    })
    expect(path).toBe(join('/xdg', 'ralph', '.env'))
  })

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    const path = globalConfigPath({ processEnv: {}, home: '/home/me' })
    expect(path).toBe(join('/home/me', '.config', 'ralph', '.env'))
  })

  it('falls back to ~/.config when XDG_CONFIG_HOME is blank/whitespace', () => {
    const path = globalConfigPath({
      processEnv: { XDG_CONFIG_HOME: '   ' },
      home: '/home/me',
    })
    expect(path).toBe(join('/home/me', '.config', 'ralph', '.env'))
  })

  it('trims surrounding whitespace from XDG_CONFIG_HOME', () => {
    const path = globalConfigPath({
      processEnv: { XDG_CONFIG_HOME: '  /xdg  ' },
      home: '/home/me',
    })
    expect(path).toBe(join('/xdg', 'ralph', '.env'))
  })
})

describe('createCredentialResolver — repo → process.env → global precedence', () => {
  const globalEnv = {
    CALLMEBOT_KEY: 'global-key',
    WHATSAPP_PHONE: 'global-phone',
    RALPH_STARTUP_MESSAGE: 'global-msg',
  }
  const loadEnv = () => ({ ...globalEnv })

  it('prefers the repo value over process.env and global', () => {
    const resolve = createCredentialResolver({
      repoEnv: { CALLMEBOT_KEY: 'repo-key' },
      processEnv: { CALLMEBOT_KEY: 'proc-key' },
      home: '/home/me',
      loadEnv,
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('repo-key')
  })

  it('prefers process.env over global when repo lacks the key', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: { CALLMEBOT_KEY: 'proc-key' },
      home: '/home/me',
      loadEnv,
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('proc-key')
  })

  it('falls back to the global file when repo and process.env both lack the key', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: {},
      home: '/home/me',
      loadEnv,
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('global-key')
    expect(resolve('WHATSAPP_PHONE')).toBe('global-phone')
    expect(resolve('RALPH_STARTUP_MESSAGE')).toBe('global-msg')
  })

  it('returns undefined when no source has the key', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: {},
      home: '/home/me',
      loadEnv: () => ({}),
    })
    expect(resolve('CALLMEBOT_KEY')).toBeUndefined()
  })

  it('reads the global file from the resolved global config path', () => {
    let seenPath
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: { XDG_CONFIG_HOME: '/xdg' },
      home: '/home/me',
      loadEnv: (p) => {
        seenPath = p
        return { WHATSAPP_PHONE: 'g' }
      },
    })
    expect(resolve('WHATSAPP_PHONE')).toBe('g')
    expect(seenPath).toBe(join('/xdg', 'ralph', '.env'))
  })

  it('is a silent no-op when the global file is absent (loadEnv returns {})', () => {
    const resolve = createCredentialResolver({
      repoEnv: { CALLMEBOT_KEY: 'repo-key' },
      processEnv: {},
      home: '/home/me',
      loadEnv: () => ({}),
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('repo-key')
    expect(resolve('WHATSAPP_PHONE')).toBeUndefined()
  })

  it('tolerates loadEnv returning null/undefined (still resolves other sources)', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: { WHATSAPP_PHONE: 'proc' },
      home: '/home/me',
      loadEnv: () => null,
    })
    expect(resolve('WHATSAPP_PHONE')).toBe('proc')
    expect(resolve('CALLMEBOT_KEY')).toBeUndefined()
  })
})
