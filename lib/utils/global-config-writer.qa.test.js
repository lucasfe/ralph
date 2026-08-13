import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { upsertEnvContent, writeGlobalCreds } from './global-config-writer.js'
import { parseEnvFile } from './env.js'

// #5 QA augmentation. The dev's global-config-writer.test.js locks the happy
// paths (update-in-place, append, comment preservation, empty file, export
// prefix, 0600/0700, XDG). These attack the corners the happy path left
// implicit: values with `=`, duplicate keys, whitespace/export variants,
// substring key collisions, empty-value updates, trailing-newline idempotency,
// CRLF, and non-ENOENT read errors. All FS access is injected — nothing touches
// the real home dir.

describe('QA upsertEnvContent — value payload edge cases', () => {
  it('preserves the WHOLE value when it contains an "=" (append)', () => {
    const out = upsertEnvContent('', { CALLMEBOT_KEY: 'a=b=c' })
    expect(out).toBe('CALLMEBOT_KEY=a=b=c\n')
    // Round-trips: parseEnvFile splits on the FIRST '=' so the value survives.
    expect(parseEnvFile(out).CALLMEBOT_KEY).toBe('a=b=c')
  })

  it('preserves the WHOLE value when it contains an "=" (update-in-place)', () => {
    const out = upsertEnvContent('CALLMEBOT_KEY=old\n', { CALLMEBOT_KEY: 'x=y' })
    expect(out).toBe('CALLMEBOT_KEY=x=y\n')
    expect(parseEnvFile(out).CALLMEBOT_KEY).toBe('x=y')
  })

  it('updates a value to the empty string in place', () => {
    const out = upsertEnvContent('WHATSAPP_PHONE=+1\n', { WHATSAPP_PHONE: '' })
    expect(out).toBe('WHATSAPP_PHONE=\n')
    expect(parseEnvFile(out).WHATSAPP_PHONE).toBe('')
  })

  it('appends a key with an empty-string value', () => {
    const out = upsertEnvContent('CALLMEBOT_KEY=abc\n', { WHATSAPP_PHONE: '' })
    expect(out).toBe('CALLMEBOT_KEY=abc\nWHATSAPP_PHONE=\n')
  })
})

describe('QA upsertEnvContent — key matching corners', () => {
  it('does NOT false-match a key that is a substring of another (KEY vs MYKEY)', () => {
    const out = upsertEnvContent('MYKEY=untouched\n', { KEY: 'new' })
    // MYKEY must be left alone; KEY appended fresh.
    expect(out).toBe('MYKEY=untouched\nKEY=new\n')
  })

  it('does NOT false-match when the target is the substring (MYKEY vs KEY line)', () => {
    const out = upsertEnvContent('KEY=untouched\n', { MYKEY: 'new' })
    expect(out).toBe('KEY=untouched\nMYKEY=new\n')
  })

  it('matches an "export "-prefixed key and normalizes the prefix away', () => {
    const out = upsertEnvContent('export WHATSAPP_PHONE=old\n', { WHATSAPP_PHONE: '+1' })
    expect(out).toBe('WHATSAPP_PHONE=+1\n')
  })

  it('matches a key with leading indentation and spaces around the "="', () => {
    const out = upsertEnvContent('   WHATSAPP_PHONE = old  \n', { WHATSAPP_PHONE: '+1' })
    expect(out).toBe('WHATSAPP_PHONE=+1\n')
  })

  it('matches an export-prefixed key with surrounding whitespace', () => {
    const out = upsertEnvContent('  export   CALLMEBOT_KEY = old \n', { CALLMEBOT_KEY: 'new' })
    expect(out).toBe('CALLMEBOT_KEY=new\n')
  })

  it('does NOT touch a key that appears only inside a comment', () => {
    const out = upsertEnvContent('# WHATSAPP_PHONE=commented\n', { WHATSAPP_PHONE: '+1' })
    expect(out).toBe('# WHATSAPP_PHONE=commented\nWHATSAPP_PHONE=+1\n')
  })
})

describe('QA upsertEnvContent — duplicate keys already in the file', () => {
  it('updates the FIRST occurrence and leaves later duplicates untouched', () => {
    const content = 'WHATSAPP_PHONE=old1\nWHATSAPP_PHONE=old2\n'
    const out = upsertEnvContent(content, { WHATSAPP_PHONE: 'new' })
    expect(out).toBe('WHATSAPP_PHONE=new\nWHATSAPP_PHONE=old2\n')
  })

  it('LATENT ISSUE: after upserting a duplicate-key file, parseEnvFile still resolves the STALE last value', () => {
    // Documents a real interaction: upsert rewrites the first line, but
    // parseEnvFile is last-wins, so the update is invisible to the resolver.
    // Requires a hand-mangled file with duplicate keys; flagged for the dev.
    const content = 'WHATSAPP_PHONE=old1\nWHATSAPP_PHONE=old2\n'
    const out = upsertEnvContent(content, { WHATSAPP_PHONE: 'new' })
    expect(parseEnvFile(out).WHATSAPP_PHONE).toBe('old2')
  })
})

describe('QA upsertEnvContent — whitespace / newline / structure preservation', () => {
  it('is idempotent on trailing newline for a file with no trailing newline', () => {
    const out = upsertEnvContent('WHATSAPP_PHONE=old', { WHATSAPP_PHONE: 'new' })
    expect(out).toBe('WHATSAPP_PHONE=new\n')
  })

  it('does not add a second trailing newline when input already ends with one', () => {
    const once = upsertEnvContent('WHATSAPP_PHONE=old\n', { WHATSAPP_PHONE: 'new' })
    const twice = upsertEnvContent(once, { WHATSAPP_PHONE: 'new' })
    expect(twice).toBe('WHATSAPP_PHONE=new\n')
    expect(twice).toBe(once)
  })

  it('preserves interior blank lines and comment-only lines', () => {
    const content = '# header\n\n\nCALLMEBOT_KEY=old\n\n# footer\n'
    const out = upsertEnvContent(content, { CALLMEBOT_KEY: 'new' })
    expect(out).toBe('# header\n\n\nCALLMEBOT_KEY=new\n\n# footer\n')
  })

  it('returns empty string for empty input with no updates', () => {
    expect(upsertEnvContent('', {})).toBe('')
  })

  it('leaves comment-only content unchanged when there are no updates', () => {
    expect(upsertEnvContent('# just a comment\n', {})).toBe('# just a comment\n')
  })

  it('documents CRLF handling: updated line loses its \\r; untouched lines keep theirs', () => {
    const content = 'RALPH_X=keep\r\nWHATSAPP_PHONE=old\r\n'
    const out = upsertEnvContent(content, { WHATSAPP_PHONE: '+1' })
    // Untouched line still carries its \r; rewritten line is normalized to LF.
    expect(out).toBe('RALPH_X=keep\r\nWHATSAPP_PHONE=+1\n')
  })
})

describe('QA writeGlobalCreds — read paths and error propagation', () => {
  const HOME = '/home/test'
  const PATH = join(HOME, '.config', 'ralph', '.env')

  it('creates a fresh file when the global config does not exist (ENOENT swallowed)', () => {
    const vol = Volume.fromJSON({}, '/')
    writeGlobalCreds({
      values: { WHATSAPP_PHONE: '+1', CALLMEBOT_KEY: 'abc' },
      fs: vol,
      home: HOME,
      processEnv: {},
    })
    expect(vol.readFileSync(PATH, 'utf8')).toBe('WHATSAPP_PHONE=+1\nCALLMEBOT_KEY=abc\n')
    // Parent dir created with 0700, file with 0600.
    expect(vol.statSync(join(HOME, '.config', 'ralph')).mode & 0o777).toBe(0o700)
    expect(vol.statSync(PATH).mode & 0o777).toBe(0o600)
  })

  it('re-tightens permissions to 0600 even when updating a pre-existing file', () => {
    const vol = Volume.fromJSON({}, '/')
    vol.mkdirSync(join(HOME, '.config', 'ralph'), { recursive: true })
    vol.writeFileSync(PATH, 'WHATSAPP_PHONE=old\n', { mode: 0o644 })
    writeGlobalCreds({
      values: { WHATSAPP_PHONE: 'new' },
      fs: vol,
      home: HOME,
      processEnv: {},
    })
    expect(vol.readFileSync(PATH, 'utf8')).toBe('WHATSAPP_PHONE=new\n')
    expect(vol.statSync(PATH).mode & 0o777).toBe(0o600)
  })

  it('propagates a NON-ENOENT read error (e.g. EACCES) instead of swallowing it', () => {
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    let wroteAnything = false
    const fakeFs = {
      readFileSync: () => {
        throw eacces
      },
      mkdirSync: () => {},
      writeFileSync: () => {
        wroteAnything = true
      },
    }
    expect(() =>
      writeGlobalCreds({
        values: { WHATSAPP_PHONE: '+1' },
        fs: fakeFs,
        home: HOME,
        processEnv: {},
      }),
    ).toThrow(/permission denied/)
    // Must NOT clobber a file it could not read.
    expect(wroteAnything).toBe(false)
  })

  it('passes the mode options through to the injected fs calls', () => {
    const calls = { mkdir: null, write: null }
    const fakeFs = {
      readFileSync: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      },
      mkdirSync: (_p, opts) => {
        calls.mkdir = opts
      },
      writeFileSync: (_p, _data, opts) => {
        calls.write = opts
      },
    }
    writeGlobalCreds({
      values: { WHATSAPP_PHONE: '+1' },
      fs: fakeFs,
      home: HOME,
      processEnv: {},
    })
    expect(calls.mkdir).toEqual({ recursive: true, mode: 0o700 })
    expect(calls.write).toEqual({ mode: 0o600 })
  })
})
