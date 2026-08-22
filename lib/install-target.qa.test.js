import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { classifyInstall, NPM_GLOBAL_UPDATE_LABEL } from './install-target.js'
import { RALPH_HOME } from './paths.js'

// QA augmentation for #21. The dev's install-target.test.js pins the two happy
// classifications (global-npm / unknown). These tests attack the SAFETY
// direction of the path-boundary check — every ambiguous or malformed input must
// fail CLOSED (kind 'unknown', argv null) so `ralph update` never runs
// an install against a copy it does not actually own — plus the exec contract
// (anything other than a clean exit-0 with usable stdout is a refusal).

function makeExec(value) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    return typeof value === 'function' ? value({ cmd, args, options }) : value
  }
  exec.calls = calls
  return exec
}

const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const rootOk = (stdout = `${GLOBAL_ROOT}\n`) => makeExec({ exitCode: 0, stdout, stderr: '' })

describe('classifyInstall — path-boundary adversarial (#21 QA)', () => {
  it('treats a ralphHome equal to the global root itself as global-npm', async () => {
    const result = await classifyInstall({ ralphHome: GLOBAL_ROOT, exec: rootOk() })
    expect(result.kind).toBe('global-npm')
  })

  it('classifies a deeply nested path under the global root as global-npm', async () => {
    const result = await classifyInstall({
      ralphHome: `${GLOBAL_ROOT}/@lucasfe/ralph/lib/commands`,
      exec: rootOk(),
    })
    expect(result.kind).toBe('global-npm')
  })

  it('resolves `..` segments before comparing, so an escape out of the root is unknown', async () => {
    const result = await classifyInstall({
      ralphHome: `${GLOBAL_ROOT}/../node_modules-old/@lucasfe/ralph`,
      exec: rootOk(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
    expect(result.reason).toContain('node_modules-old')
  })

  it('does not treat a parent of the global root as inside it', async () => {
    const result = await classifyInstall({ ralphHome: '/usr/local/lib', exec: rootOk() })
    expect(result.kind).toBe('unknown')
  })

  it('fails closed when the path differs only by case (no case folding)', async () => {
    const result = await classifyInstall({
      ralphHome: '/USR/local/lib/node_modules/@lucasfe/ralph',
      exec: rootOk(),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  it('trims tabs and CRLF around `npm root -g` output', async () => {
    const result = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec: rootOk(`\t${GLOBAL_ROOT}\r\n`),
    })
    expect(result.kind).toBe('global-npm')
  })

  it('fails closed when npm prefixes its own warning line to the root output', async () => {
    const result = await classifyInstall({
      ralphHome: GLOBAL_RALPH,
      exec: rootOk(`npm WARN config global deprecated\n${GLOBAL_ROOT}\n`),
    })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  it('resolves a relative `npm root -g` output against the cwd (characterized)', async () => {
    const result = await classifyInstall({
      ralphHome: 'node_modules/@lucasfe/ralph',
      exec: rootOk('node_modules\n'),
    })
    expect(result.kind).toBe('global-npm')
    expect(result.reason).toContain(resolve('node_modules'))
  })

  it('a null ralphHome falls back to RALPH_HOME, never to the cwd', async () => {
    // A cwd fallback fails OPEN whenever the cwd happens to sit under
    // `npm root -g`; RALPH_HOME is the only directory this copy can own.
    const result = await classifyInstall({ ralphHome: null, exec: rootOk() })
    expect(result.kind).toBe('unknown')
    expect(result.reason).toContain(RALPH_HOME)
  })

  it('a whitespace-only ralphHome is unknown, never global-npm', async () => {
    const result = await classifyInstall({ ralphHome: '   ', exec: rootOk() })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })
})

describe('classifyInstall — exec contract failures all fail closed (#21 QA)', () => {
  const failures = [
    ['resolves undefined', undefined],
    ['resolves null', null],
    ['resolves without an exitCode', { stdout: GLOBAL_ROOT }],
    ['resolves with exitCode null', { exitCode: null, stdout: GLOBAL_ROOT }],
    ['resolves with a string exitCode', { exitCode: '0', stdout: GLOBAL_ROOT }],
    ['resolves with exitCode 0 and no stdout', { exitCode: 0 }],
    ['resolves with exitCode 0 and undefined stdout', { exitCode: 0, stdout: undefined }],
    ['resolves with whitespace-only stdout', { exitCode: 0, stdout: '  \t \n' }],
  ]

  for (const [label, value] of failures) {
    it(`returns unknown when \`npm root -g\` ${label}`, async () => {
      const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: makeExec(value) })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
      expect(typeof result.reason).toBe('string')
      expect(result.reason.length).toBeGreaterThan(0)
    })
  }

  it('returns unknown when exec throws a non-Error value', async () => {
    const exec = async () => {
      throw 'npm exploded'
    }
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(result.kind).toBe('unknown')
    expect(result.argv).toBeNull()
  })

  const nonFunctions = [
    ['a string', 'npm'],
    ['a number', 42],
    ['a plain object', {}],
  ]

  for (const [label, value] of nonFunctions) {
    it(`returns unknown when exec is ${label}`, async () => {
      const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: value })
      expect(result.kind).toBe('unknown')
      expect(result.argv).toBeNull()
    })
  }

  it('never spawns more than the single `npm root -g` probe', async () => {
    const exec = rootOk()
    await classifyInstall({ ralphHome: GLOBAL_RALPH, exec })
    expect(exec.calls.map((c) => c.key)).toEqual(['npm root -g'])
  })
})

describe('classifyInstall — return-shape invariants (#21 QA)', () => {
  it('argv is non-null exactly when kind is global-npm', async () => {
    const stubs = [
      { exitCode: 0, stdout: GLOBAL_ROOT },
      { exitCode: 0, stdout: '/somewhere/else' },
      { exitCode: 1, stdout: '' },
      undefined,
    ]
    for (const stub of stubs) {
      const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: makeExec(stub) })
      expect(result.argv !== null).toBe(result.kind === 'global-npm')
      expect(['global-npm', 'unknown']).toContain(result.kind)
    }
  })

  it('argv is the runnable form and label is derived from it — no empty tokens either way', async () => {
    const result = await classifyInstall({ ralphHome: GLOBAL_RALPH, exec: rootOk() })
    expect(result.argv).toEqual(['npm', 'install', '-g', '@lucasfe/ralph@latest'])
    expect(result.argv.every((t) => typeof t === 'string' && t.trim() === t && t !== '')).toBe(
      true,
    )
    expect(result.label).toBe(result.argv.join(' '))
    expect(result.label).toBe(NPM_GLOBAL_UPDATE_LABEL)
  })

  it('an unknown classification has a null label alongside its null argv', async () => {
    const result = await classifyInstall({ ralphHome: '/somewhere/else', exec: rootOk() })
    expect(result.argv).toBeNull()
    expect(result.label).toBeNull()
  })
})
