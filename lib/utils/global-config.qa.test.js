import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { globalConfigPath, createCredentialResolver } from './global-config.js'

// #3 QA augmentation. The dev's global-config.test.js covers the happy path
// (XDG set, unset, whitespace-trimmed; repo>proc>global precedence; a couple of
// missing-source cases). These tests pin the ADVERSARIAL corners the happy path
// left implicit: literal-empty XDG, trailing-slash / relative XDG, and above
// all the `??` (nullish-coalescing) semantics — where an EMPTY STRING is a real
// value that stops fallthrough, while null/undefined does not. All FS access is
// injected; nothing touches the real disk.

describe('QA globalConfigPath — XDG_CONFIG_HOME adversarial values', () => {
  it('falls back to ~/.config when XDG_CONFIG_HOME is the empty string', () => {
    // Distinct from the dev "unset" and "whitespace" cases: XDG present but ''.
    const path = globalConfigPath({
      processEnv: { XDG_CONFIG_HOME: '' },
      home: '/home/me',
    })
    expect(path).toBe(join('/home/me', '.config', 'ralph', '.env'))
  })

  it('falls back to ~/.config when XDG_CONFIG_HOME is tabs/newlines only', () => {
    const path = globalConfigPath({
      processEnv: { XDG_CONFIG_HOME: '\t\n  \n' },
      home: '/home/me',
    })
    expect(path).toBe(join('/home/me', '.config', 'ralph', '.env'))
  })

  it('normalizes a trailing slash on XDG_CONFIG_HOME (no doubled separator)', () => {
    const path = globalConfigPath({
      processEnv: { XDG_CONFIG_HOME: '/xdg/' },
      home: '/home/me',
    })
    // path.join collapses the trailing slash — no '/xdg//ralph'.
    expect(path).toBe(join('/xdg', 'ralph', '.env'))
    expect(path).not.toContain('//')
  })

  it('trims inner-preserving whitespace but keeps the path intact', () => {
    const path = globalConfigPath({
      processEnv: { XDG_CONFIG_HOME: '  /xdg/config  ' },
      home: '/home/me',
    })
    expect(path).toBe(join('/xdg/config', 'ralph', '.env'))
  })

  it('pins behavior for a RELATIVE XDG_CONFIG_HOME: used as-is, NOT resolved to absolute', () => {
    // Documents current behavior — the module does not force an absolute base.
    const path = globalConfigPath({
      processEnv: { XDG_CONFIG_HOME: 'relative/cfg' },
      home: '/home/me',
    })
    expect(path).toBe(join('relative/cfg', 'ralph', '.env'))
    expect(path.startsWith('/')).toBe(false)
  })

  it('ignores home entirely when XDG is set', () => {
    const path = globalConfigPath({
      processEnv: { XDG_CONFIG_HOME: '/xdg' },
      home: '/should/not/appear',
    })
    expect(path).toBe(join('/xdg', 'ralph', '.env'))
    expect(path).not.toContain('should/not/appear')
  })
})

describe('QA createCredentialResolver — `??` semantics: empty string stops fallthrough', () => {
  const global = { CALLMEBOT_KEY: 'global-key', WHATSAPP_PHONE: 'global-phone' }
  const loadEnv = () => ({ ...global })

  it('an EMPTY repo value stops fallthrough and does NOT reach process.env or global', () => {
    const resolve = createCredentialResolver({
      repoEnv: { CALLMEBOT_KEY: '' },
      processEnv: { CALLMEBOT_KEY: 'proc-key' },
      home: '/home/me',
      loadEnv,
    })
    // '' is a real (non-nullish) value: ?? keeps it. This is load-bearing —
    // a blank repo entry silences creds rather than falling back.
    expect(resolve('CALLMEBOT_KEY')).toBe('')
  })

  it('an EMPTY process.env value stops fallthrough to global (repo absent)', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: { CALLMEBOT_KEY: '' },
      home: '/home/me',
      loadEnv,
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('')
  })

  it('a present-but-empty GLOBAL value is returned as "" when repo+proc lack the key', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: {},
      home: '/home/me',
      loadEnv: () => ({ CALLMEBOT_KEY: '' }),
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('')
  })

  it('a null/undefined repo value DOES fall through (nullish, unlike "")', () => {
    const resolve = createCredentialResolver({
      repoEnv: { CALLMEBOT_KEY: null, WHATSAPP_PHONE: undefined },
      processEnv: { CALLMEBOT_KEY: 'proc-key' },
      home: '/home/me',
      loadEnv,
    })
    // null → falls to proc; undefined → falls to proc(absent)→global.
    expect(resolve('CALLMEBOT_KEY')).toBe('proc-key')
    expect(resolve('WHATSAPP_PHONE')).toBe('global-phone')
  })

  it('an empty repo value beats even a real process.env AND real global value', () => {
    const resolve = createCredentialResolver({
      repoEnv: { WHATSAPP_PHONE: '' },
      processEnv: { WHATSAPP_PHONE: '+proc' },
      home: '/home/me',
      loadEnv,
    })
    expect(resolve('WHATSAPP_PHONE')).toBe('')
  })
})

describe('QA createCredentialResolver — every missing-source combination', () => {
  const global = { CALLMEBOT_KEY: 'g', WHATSAPP_PHONE: '+g' }

  it('resolves a key present ONLY in process.env', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: { CALLMEBOT_KEY: 'proc-only' },
      home: '/home/me',
      loadEnv: () => ({}),
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('proc-only')
  })

  it('resolves a key present ONLY in the global file', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: {},
      home: '/home/me',
      loadEnv: () => ({ ...global }),
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('g')
  })

  it('returns undefined for a key present in NO source', () => {
    const resolve = createCredentialResolver({
      repoEnv: { OTHER: 'x' },
      processEnv: { STILL_OTHER: 'y' },
      home: '/home/me',
      loadEnv: () => ({ ANOTHER: 'z' }),
    })
    expect(resolve('CALLMEBOT_KEY')).toBeUndefined()
  })

  it('tolerates loadEnv returning null (|| {} guard) and still reads other sources', () => {
    const resolve = createCredentialResolver({
      repoEnv: { CALLMEBOT_KEY: 'repo' },
      processEnv: {},
      home: '/home/me',
      loadEnv: () => null,
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('repo')
    expect(resolve('WHATSAPP_PHONE')).toBeUndefined()
  })

  it('tolerates loadEnv returning undefined', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: { WHATSAPP_PHONE: '+p' },
      home: '/home/me',
      loadEnv: () => undefined,
    })
    expect(resolve('WHATSAPP_PHONE')).toBe('+p')
    expect(resolve('CALLMEBOT_KEY')).toBeUndefined()
  })

  it('resolves an ARBITRARY (non-WhatsApp) variable through the generic global file', () => {
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: {},
      home: '/home/me',
      loadEnv: () => ({ SOME_RANDOM_TOKEN: 'from-global' }),
    })
    expect(resolve('SOME_RANDOM_TOKEN')).toBe('from-global')
  })
})

describe('QA createCredentialResolver — loadEnv is called once at the computed path', () => {
  it('reads the global file at the ~/.config path when XDG is unset', () => {
    const seen = []
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: {},
      home: '/home/me',
      loadEnv: (p) => {
        seen.push(p)
        return { CALLMEBOT_KEY: 'g' }
      },
    })
    expect(resolve('CALLMEBOT_KEY')).toBe('g')
    expect(seen).toEqual([join('/home/me', '.config', 'ralph', '.env')])
  })

  it('reads the global file at the XDG path when XDG_CONFIG_HOME is set', () => {
    let seenPath
    createCredentialResolver({
      repoEnv: {},
      processEnv: { XDG_CONFIG_HOME: '/custom/xdg' },
      home: '/home/me',
      loadEnv: (p) => {
        seenPath = p
        return {}
      },
    })
    expect(seenPath).toBe(join('/custom/xdg', 'ralph', '.env'))
  })

  it('loads the global file exactly ONCE regardless of how many keys are resolved', () => {
    let calls = 0
    const resolve = createCredentialResolver({
      repoEnv: {},
      processEnv: {},
      home: '/home/me',
      loadEnv: () => {
        calls += 1
        return { A: '1', B: '2', C: '3' }
      },
    })
    resolve('A')
    resolve('B')
    resolve('C')
    resolve('MISSING')
    // The resolver snapshots globalEnv at construction — no per-lookup FS hit.
    expect(calls).toBe(1)
  })
})
