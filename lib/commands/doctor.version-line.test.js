import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { doctorCommand } from './doctor.js'

// #27: `ralph doctor` answers "am I current?" beside the dependency report, from
// the GLOBAL update-check cache #24 writes — never from the network. doctor is
// what people reach for when things are already broken (possibly offline), so it
// must stay fast and must not grow a network dependency. The line is additive
// OUTPUT only: doctor's exit code must never move because a new version shipped,
// or every wrapper/CI step gating on `ralph doctor` starts failing on release day.
//
// #75 MOVED THE LINE INTO THE IDENTITY BOX, and this file moved with it rather than
// being replaced. Every state below is the same state and every verdict is the same
// verdict; what changed is where they are read from — the installed version is the
// box's TITLE and the cached verdict is its `cached` ROW — and the wording of the
// update hint, which is now the box's own `ralph update` verb (see newerSentence in
// lib/banner-compose.js for the width arithmetic that forced it). The two helpers
// below are the whole of that translation, so the states stay one table.

// Strip ANSI color codes so assertions on the rendered box hold whether or not
// picocolors emits color — it DOES when CI=true, which is how CI runs the suite.
// The ESC byte is built with fromCharCode rather than embedded literally: the
// sequence is ESC + '[33m', and a pattern that drops only the '[33m' tail leaves
// a stray ESC that breaks the exact-match and startsWith assertions below.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (s) => s.replace(ANSI_RE, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => stripAnsi(chunks.join('')),
  }
}

const allPresent = () => true
const HOME = '/home/me'
const CWD = '/repo'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')

// A warm cache as writeVersionCache would leave it.
function warmCache(latestVersion) {
  return Volume.fromJSON(
    {
      [CACHE_PATH]: JSON.stringify({
        last_check_at: new Date('2026-08-20T00:00:00.000Z').toISOString(),
        last_prompted_at: null,
        latest_version: latestVersion,
      }),
    },
    '/',
  )
}

// Records every fs op so a test can prove doctor only ever READS the cache.
function spyFs(vol) {
  const ops = []
  return {
    ops,
    readFileSync: (p, ...rest) => {
      ops.push({ op: 'read', path: p })
      return vol.readFileSync(p, ...rest)
    },
    writeFileSync: (p, ...rest) => {
      ops.push({ op: 'write', path: p })
      return vol.writeFileSync(p, ...rest)
    },
    mkdirSync: (p, ...rest) => {
      ops.push({ op: 'mkdir', path: p })
      return vol.mkdirSync(p, ...rest)
    },
  }
}

// #75: the two facts the box carries that this file is about, read out of the frame.
//
// `titleVersion` is what `version: X` became: the installed version is the box's SUBJECT,
// which is why it has no label (see titleLine in lib/banner-compose.js). `verdict` is what
// `— cached latest: …` became: a labelled row of its own, so the answer survives on a narrow
// terminal as a line rather than as the tail of a longer sentence.
//
// Read through the frame rather than by index or by substring, deliberately: an assertion that
// only searched stdout for '0.18.0' would pass on a version that leaked into a dependency
// install hint, and one that sliced by line number would break the day a row is added.
const GUTTER = 8
const titleVersion = (out) => {
  const line = out.split('\n').find((l) => l.startsWith('╭'))
  const match = line === undefined ? null : /^╭─ ralph (.*?) ─+╮$/.exec(line)
  return match ? match[1] : undefined
}
const verdict = (out) => {
  const prefix = `│ ${'cached'.padEnd(GUTTER)}`
  const line = out.split('\n').find((l) => l.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length, -2).trimEnd()
}

// Every run injects both the cache fs AND home, so no test can touch the real
// ~/.config/ralph/update-check.json.
//
// #75 adds two more injections for the same reason: `cwd`, which the box now prints, and
// `exists`, because doctor reads ralph.config.sh for RALPH_BANNER — neither the developer's
// working directory nor whether they happen to keep a config in it may decide what these
// tests see.
async function runDoctor({
  cacheFs = new Volume(),
  home = HOME,
  cwd = CWD,
  currentVersion = '0.17.0',
  hasCommand = allPresent,
  env = {},
  extra = {},
} = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  const result = await doctorCommand({
    stdout,
    stderr,
    hasCommand,
    platform: 'mac',
    env,
    currentVersion,
    cacheFs,
    home,
    cwd,
    exists: () => false,
    ...extra,
  })
  return { result, out: stdout.output(), err: stderr.output() }
}

describe('doctor version line (#27) — installed version', () => {
  it('prints the installed version', async () => {
    const { out } = await runDoctor({ currentVersion: '0.17.0' })
    expect(titleVersion(out)).toBe('0.17.0')
  })

  it('falls back to "unknown" when no currentVersion is threaded in', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    await doctorCommand({
      stdout,
      stderr,
      hasCommand: allPresent,
      platform: 'mac',
      env: {},
      cacheFs: new Volume(),
      home: HOME,
      cwd: CWD,
      exists: () => false,
    })
    expect(titleVersion(stdout.output())).toBe('unknown')
  })
})

describe('doctor version line (#27) — cache states', () => {
  it('a newer cached version is shown and named as an available update', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.18.0'), currentVersion: '0.17.0' })
    expect(titleVersion(out)).toBe('0.17.0')
    expect(verdict(out)).toContain('0.18.0')
    expect(verdict(out)).toMatch(/available/i)
    // Honest about its source: a cached value, not a live check. The label carries that
    // now — `cached  0.18.0 …` — which is the same claim in one word instead of two.
    expect(out).toMatch(/^│ cached /m)
    // And it names the command that fixes it, like `ralph start`'s notice does. #75 changed
    // WHICH command it names: `ralph update` rather than the npm invocation behind it,
    // because the npm form is 55 columns against a 48-column value and would clip mid-hint.
    expect(verdict(out)).toContain('ralph update')
  })

  it('says the install is current when the cache equals the installed version', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.17.0'), currentVersion: '0.17.0' })
    expect(titleVersion(out)).toBe('0.17.0')
    expect(verdict(out)).toMatch(/up to date/i)
    expect(out).toMatch(/^│ cached /m)
    expect(out).not.toMatch(/available/i)
  })

  it('an OLDER cached version is not an update (a local build ahead of the registry)', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.16.0'), currentVersion: '0.17.0' })
    expect(verdict(out)).toMatch(/up to date/i)
    expect(out).not.toMatch(/available/i)
  })

  it('reports the latest as unknown on a cold start (no cache file yet)', async () => {
    const { out } = await runDoctor({ cacheFs: new Volume(), currentVersion: '0.17.0' })
    expect(titleVersion(out)).toBe('0.17.0')
    // The row still names the question that went unanswered, which is the whole reason it
    // prints at all on a cold cache: a missing row would read as "no news is good news".
    expect(verdict(out)).toBe('unknown (no update check cached yet)')
    expect(out).not.toMatch(/available/i)
    expect(out).not.toMatch(/up to date/i)
  })

  it('degrades to unknown on a corrupt (non-JSON) cache file', async () => {
    const cacheFs = Volume.fromJSON({ [CACHE_PATH]: '{ not json at all' }, '/')
    const { out, result } = await runDoctor({ cacheFs })
    expect(titleVersion(out)).toBe('0.17.0')
    expect(verdict(out)).toMatch(/unknown/i)
    expect(out).not.toMatch(/available/i)
    expect(result.exitCode).toBe(0)
  })

  it('degrades to unknown when the cached latest_version is not a version', async () => {
    // Survives version-cache normalization (it is a non-blank string) but is not
    // comparable — no fabricated verdict.
    const cacheFs = warmCache('banana')
    const { out } = await runDoctor({ cacheFs })
    expect(verdict(out)).toMatch(/unknown/i)
    expect(out).not.toMatch(/banana/)
    expect(out).not.toMatch(/available/i)
    expect(out).not.toMatch(/up to date/i)
  })

  it('degrades to unknown when the cache file is unreadable', async () => {
    const cacheFs = {
      readFileSync: () => {
        const e = new Error('permission denied')
        e.code = 'EACCES'
        throw e
      },
    }
    const { out, result } = await runDoctor({ cacheFs })
    expect(verdict(out)).toMatch(/unknown/i)
    expect(result.exitCode).toBe(0)
  })

  it('degrades to unknown when the cache path itself cannot be computed', async () => {
    // A null home throws a TypeError out of readVersionCache's `path` default
    // parameter, which evaluates BEFORE its own try blocks. doctor must not abort.
    const { out, result } = await runDoctor({ home: null })
    expect(verdict(out)).toMatch(/unknown/i)
    expect(result.exitCode).toBe(0)
  })

  it('makes no comparison when the installed version is not a version', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.18.0'), currentVersion: 'unknown' })
    expect(titleVersion(out)).toBe('unknown')
    // Both facts stated, neither verdict claimed — the row is the cached number alone.
    expect(verdict(out)).toBe('0.18.0')
    expect(out).not.toMatch(/up to date/i)
    expect(out).not.toMatch(/available/i)
  })
})

describe('doctor version line (#27) — exit code is never affected by staleness', () => {
  it('exits 0 with all deps present and a NEWER version cached', async () => {
    const { result } = await runDoctor({ cacheFs: warmCache('9.9.9') })
    expect(result.exitCode).toBe(0)
    expect(result.missingCritical).toEqual([])
  })

  it('returns the identical exit code for every cache state', async () => {
    const states = [new Volume(), warmCache('0.17.0'), warmCache('9.9.9'), warmCache('banana')]
    for (const cacheFs of states) {
      const { result } = await runDoctor({ cacheFs })
      expect(result.exitCode).toBe(0)
    }
  })

  it('still exits 1 for a missing critical dep, and still prints the version line', async () => {
    const { result, out } = await runDoctor({
      cacheFs: warmCache('9.9.9'),
      hasCommand: (cmd) => cmd !== 'git',
    })
    expect(result.exitCode).toBe(1)
    expect(result.missingCritical.map((r) => r.name)).toEqual(['git'])
    expect(titleVersion(out)).toBe('0.17.0')
    expect(verdict(out)).toMatch(/available/i)
  })

  it('keeps the structured shape unchanged', async () => {
    const { result } = await runDoctor({ cacheFs: warmCache('9.9.9') })
    expect(Object.keys(result).sort()).toEqual([
      'exitCode',
      'missingCritical',
      'missingNonCritical',
      'platform',
    ])
    expect(result.platform).toBe('mac')
  })
})

describe('doctor version line (#27) — no network, read-only', () => {
  it('reads the cache and writes nothing', async () => {
    const cacheFs = spyFs(warmCache('0.18.0'))
    await runDoctor({ cacheFs })
    expect(cacheFs.ops.filter((o) => o.op === 'read').map((o) => o.path)).toEqual([CACHE_PATH])
    expect(cacheFs.ops.filter((o) => o.op !== 'read')).toEqual([])
  })

  it('never touches the global credential store beside the cache', async () => {
    const cacheFs = spyFs(warmCache('0.18.0'))
    await runDoctor({ cacheFs })
    const envPath = join(HOME, '.config', 'ralph', '.env')
    expect(cacheFs.ops.some((o) => o.path === envPath)).toBe(false)
  })

  it('does not call fetch', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = () => {
      calls += 1
      throw new Error('doctor must not hit the network')
    }
    try {
      const { result } = await runDoctor({ cacheFs: warmCache('0.18.0') })
      expect(result.exitCode).toBe(0)
    } finally {
      globalThis.fetch = original
    }
    expect(calls).toBe(0)
  })

  it('takes no exec/fetch dependency by construction', async () => {
    // By construction, not by observation: doctor must not be able to acquire a
    // network dependency by accident. Its source may not reach for execa, fetch,
    // or the NETWORKED update-check entry points.
    //
    // #75: read WITHOUT comments, because #75's own comments argue about execa and the
    // network at length — and a guard that a paragraph of prose can trip is a guard people
    // learn to work around by not writing the paragraph.
    const code = codeWithoutComments(new URL('./doctor.js', import.meta.url))
    expect(code).not.toMatch(/execa/)
    expect(code).not.toMatch(/\bfetch\b/)
    expect(code).not.toMatch(/resolveUpdateDecision|fetchLatestVersion/)
    // And an injected `exec` is simply not part of the contract: handing one over
    // changes nothing.
    const withExec = await runDoctor({
      cacheFs: warmCache('0.18.0'),
      extra: {
        exec: () => {
          throw new Error('doctor must not shell out')
        },
      },
    })
    expect(withExec.result.exitCode).toBe(0)
    expect(withExec.out).toMatch(/available/i)
  })
})
