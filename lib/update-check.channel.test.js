import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import {
  fetchLatestVersion,
  NPM_VERSION_QUERY,
  PACKAGE_NAME,
  VERSION_FORMAT,
} from './update-check.js'
import { classifyInstall } from './install-target.js'

// #199: "what is the latest version?" is a question asked of THE CHANNEL this
// copy came from, so `fetchLatestVersion` takes a query descriptor — the argv to
// spawn plus the format to parse — instead of holding one npm query for every
// layout. This file is the query side of that: the npm descriptor's regression
// guard, and the Homebrew descriptor's parse.
//
// The policy side (`resolveUpdateDecision`) is untouched by #199 and stays pinned
// in `update-check.decision.test.js`; `fetchLatestVersion`'s pre-#199 contract
// stays in `update-check.fetch-latest.test.js`, which passes unmodified BECAUSE
// the source parameter defaults to npm's.

function makeExec(handler = async () => ({ exitCode: 0, stdout: '', stderr: '' })) {
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return handler({ cmd, args, opts })
  }
  exec.calls = calls
  return exec
}

const okOut = (stdout) => async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false })

// The Homebrew descriptor is read off the SHIPPED classification rather than
// retyped here: a hand-written twin would let the table and the parser drift, and
// the parse below is only interesting if it is parsing what the table asks for.
// A Cellar path is decided by its markers alone, so no exec and no real
// filesystem is involved (pinned in install-target.qa.test.js).
const BREW_CELLAR = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const brewQuery = async () => {
  const target = await classifyInstall({
    ralphHome: BREW_CELLAR,
    exec: null,
    fs: Volume.fromJSON({}),
  })
  expect(target.kind).toBe('global-brew')
  return target.latest
}

// What `brew info --json=v2 <formula>` really emits, measured against Homebrew
// 6.0.21-34-ga8820d0 (`brew info --json=v2 jq`): a two-key document,
// `{"formulae": [...], "casks": []}`, whose one formula carries
// `versions: {"stable":"1.8.2","head":"HEAD","bottle":true}`.
// Only `formulae[0].versions.stable` is read — the version an upgrade would move
// to — so this fixture carries the neighbouring keys the real document has rather
// than the single field the parser wants.
const brewJson = (stable, extra = {}) =>
  JSON.stringify({
    formulae: [
      {
        name: 'ralph',
        full_name: 'ralph',
        versions: { stable, head: null, bottle: false },
        ...extra,
      },
    ],
    casks: [],
  })

describe('NPM_VERSION_QUERY — the npm channel as a descriptor (#199)', () => {
  it('is the argv fetchLatestVersion has spawned since #21, unmoved', () => {
    expect(NPM_VERSION_QUERY.argv).toEqual(['npm', 'view', PACKAGE_NAME, 'version'])
    expect(NPM_VERSION_QUERY.format).toBe(VERSION_FORMAT.SEMVER_LINE)
  })

  it('carries the wording a failure needs to name its channel', () => {
    // `ralph update` interpolates this rather than composing a channel name of
    // its own, which is what stops a brew user being told the npm registry is
    // unreachable.
    expect(typeof NPM_VERSION_QUERY.unreachable).toBe('string')
    expect(NPM_VERSION_QUERY.unreachable).toMatch(/npm registry/)
  })
})

describe('fetchLatestVersion — the npm query with no source argument (#199)', () => {
  // The regression guard for the whole change: adding a channel must be invisible
  // to an npm user. Every existing caller passes no source.
  it('spawns exactly the npm query — same argv, same timeout, same reject:false', async () => {
    const exec = makeExec(okOut('0.16.0\n'))
    expect(await fetchLatestVersion(exec)).toBe('0.16.0')
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0].cmd).toBe('npm')
    expect(exec.calls[0].args).toEqual(['view', '@lucasfe/ralph', 'version'])
    expect(exec.calls[0].opts).toMatchObject({ timeout: 5000, reject: false })
  })

  it('spawns the same call as passing NPM_VERSION_QUERY explicitly', async () => {
    // Stronger than two independent argv assertions: the default and the
    // descriptor are compared to each other, so they cannot drift apart.
    const implicit = makeExec(okOut('0.16.0'))
    const explicit = makeExec(okOut('0.16.0'))
    await fetchLatestVersion(implicit, 1234)
    await fetchLatestVersion(explicit, 1234, NPM_VERSION_QUERY)
    expect(implicit.calls).toEqual(explicit.calls)
  })

  it('falls back to the npm query for a source that carries no argv', async () => {
    // A classification from before #199 — or a stub in a test written then —
    // carries no descriptor at all, and npm is the right default for it.
    for (const source of [undefined, null, {}, { argv: [] }, { argv: 'brew info' }]) {
      const exec = makeExec(okOut('0.16.0'))
      expect(await fetchLatestVersion(exec, 5000, source)).toBe('0.16.0')
      expect(exec.calls[0].args).toEqual(['view', PACKAGE_NAME, 'version'])
    }
  })
})

describe('fetchLatestVersion — the Homebrew query (#199)', () => {
  it('spawns `brew info --json=v2 <formula>`, bounded like the npm query', async () => {
    const exec = makeExec(okOut(brewJson('0.17.0')))
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBe('0.17.0')
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0].cmd).toBe('brew')
    expect(exec.calls[0].args).toEqual(['info', '--json=v2', 'ralph'])
    // The same bounds as npm's: a version query may not hang `ralph update`.
    expect(exec.calls[0].opts).toMatchObject({ timeout: 5000, reject: false })
  })

  it('honors a caller-supplied timeout', async () => {
    const exec = makeExec(okOut(brewJson('0.17.0')))
    await fetchLatestVersion(exec, 1234, await brewQuery())
    expect(exec.calls[0].opts).toMatchObject({ timeout: 1234 })
  })

  it('reads the stable version out of the `--json=v2` document', async () => {
    const source = await brewQuery()
    for (const version of ['0.17.0', '1.0.0-rc.1', '1.0.0+build.5', '10.20.30']) {
      const exec = makeExec(okOut(brewJson(version)))
      expect(await fetchLatestVersion(exec, 5000, source)).toBe(version)
    }
  })

  it('reads `stable` and never the installed or head version', async () => {
    // A Cellar holds every version the machine has ever had, and `head` is a
    // git build with no version at all. `brew upgrade` moves to `stable`, so
    // that is the only field an "is there an upgrade?" question may read.
    const exec = makeExec(
      okOut(
        brewJson('0.17.0', {
          installed: [{ version: '0.15.6' }],
          versions: { stable: '0.17.0', head: 'HEAD', bottle: true },
        }),
      ),
    )
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBe('0.17.0')
  })

  it('trims padding around the version, as the npm format does', async () => {
    const exec = makeExec(okOut(brewJson('  0.17.0 ')))
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBe('0.17.0')
  })
})

describe('fetchLatestVersion — a Homebrew document it cannot read (#199)', () => {
  // Every one of these must answer null and never throw: this runs inside
  // `ralph update`, where an unreadable version query is a reported failure and a
  // clean exit 1, not a stack trace.
  const unreadable = [
    ['empty output', ''],
    ['whitespace only', '   \n'],
    ['not JSON at all', 'Error: No available formula with the name "ralph".'],
    ['a truncated document', '{"formulae":[{"versions":{"stable":"0.17.0"'],
    ['a JSON scalar', '"0.17.0"'],
    ['JSON null', 'null'],
    ['a top-level array', '[]'],
    ['no formulae key', '{"casks":[]}'],
    ['an empty formulae list', '{"formulae":[],"casks":[]}'],
    ['formulae as an object, not a list', '{"formulae":{"0":{"versions":{"stable":"0.17.0"}}}}'],
    ['a formula with no versions', '{"formulae":[{"name":"ralph"}],"casks":[]}'],
    ['versions with no stable', '{"formulae":[{"versions":{"head":"HEAD"}}],"casks":[]}'],
    ['a null stable version', '{"formulae":[{"versions":{"stable":null}}],"casks":[]}'],
    ['a non-string stable version', '{"formulae":[{"versions":{"stable":1.7}}],"casks":[]}'],
    ['a stable version that is not semver', '{"formulae":[{"versions":{"stable":"HEAD"}}]}'],
    ['a v-prefixed stable version', '{"formulae":[{"versions":{"stable":"v0.17.0"}}]}'],
    ['brew noise ahead of the document', 'Warning: tap is shallow\n{"formulae":[]}'],
  ]

  for (const [label, stdout] of unreadable) {
    it(`answers null for ${label}`, async () => {
      const exec = makeExec(okOut(stdout))
      await expect(fetchLatestVersion(exec, 5000, await brewQuery())).resolves.toBeNull()
    })
  }

  it('answers null when a non-string reaches the parser', async () => {
    // execa yields a string, so these come from a broken stub — but coercing one
    // would run a hostile `toString`, and `.trim()` on an object would throw
    // straight out of a function whose whole contract is that it does not.
    for (const stdout of [undefined, null, {}, 42, Buffer.from('{"formulae":[]}')]) {
      const exec = makeExec(async () => ({ exitCode: 0, stdout, timedOut: false }))
      await expect(fetchLatestVersion(exec, 5000, await brewQuery())).resolves.toBeNull()
    }
  })

  it('answers null when brew exits non-zero, however good the output looks', async () => {
    // Measured: `brew info --json=v2 ralph` with no such formula tapped exits 1
    // with empty stdout ('Error: No available formula with the name "ralph".' on
    // stderr). The exit code is checked before the document is read either way.
    const exec = makeExec(async () => ({ exitCode: 1, stdout: brewJson('0.17.0'), stderr: '' }))
    expect(await fetchLatestVersion(exec, 5000, await brewQuery())).toBeNull()
  })

  it('answers null when the brew query times out or cannot be spawned', async () => {
    const timedOut = makeExec(async () => ({ exitCode: 0, stdout: brewJson('0.17.0'), timedOut: true }))
    expect(await fetchLatestVersion(timedOut, 5000, await brewQuery())).toBeNull()

    const throwing = makeExec(async () => {
      const e = new Error('spawn brew ENOENT')
      e.code = 'ENOENT'
      throw e
    })
    expect(await fetchLatestVersion(throwing, 5000, await brewQuery())).toBeNull()
  })

  it('answers null for a format nothing knows how to parse, without spawning twice', async () => {
    const exec = makeExec(okOut('0.17.0'))
    const source = { ...(await brewQuery()), format: 'yaml-someday' }
    expect(await fetchLatestVersion(exec, 5000, source)).toBeNull()
    expect(exec.calls).toHaveLength(1)
  })
})
