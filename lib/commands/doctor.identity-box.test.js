import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { doctorCommand } from './doctor.js'

// #75 — the identity box at the head of `ralph doctor`.
//
// Doctor is the command people paste into a bug report, so one paste has to carry which
// Ralph, which platform, which agent, what the last update check found and where it ran.
// It already printed two of those in two lines of its own — a `platform: … — agent: …`
// header and #27's `version: … — cached latest: …` verdict — so this slice FOLDS those
// into the box rather than printing the same facts twice. The box's shape, its width
// ladder and its colours are lib/banner-compose.js's and are asserted there; what this
// file asserts is everything that is doctor's:
//
//   1. THE BOX IS FIRST, above the dependency report and above the missing-critical
//      early return — a broken setup is exactly when "which version, which agent" is
//      the question being asked.
//   2. NO SPRITE, NO ANIMATION, at any setting. Doctor may be piped into a bug report;
//      it draws no pixels and moves no cursor, and it cannot even reach the code that
//      would (asserted on the source, not just on the output).
//   3. NOTHING ELSE MOVED. The exit codes are the contract wrappers and CI steps gate
//      on, and a box is additive output: 0 for a clean machine, 1 for a missing critical
//      dep, in every banner mode.
//   4. STILL INERT. No socket, no exec, no registry query — the one new read is
//      ralph.config.sh, through the same injected `exists`/`readFile` seams `ralph
//      start` uses, so the RALPH_BANNER knob answers the same in both commands.
//
// Every run injects the cache fs, the home, the cwd and the config seams, so no test
// here can touch the real ~/.config/ralph or the real ralph.config.sh (#41).

// Strip ANSI so assertions on the frame hold whether or not colour is emitted — it IS
// when CI=true, which is how CI runs this suite.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (s) => s.replace(ANSI_RE, '')

// The splash player's two cursor sequences (lib/sprite-player.js), as PATTERNS rather than
// as bytes — `\u001B` and not a literal ESC, for the same reason ANSI_RE is built out of
// fromCharCode: a control byte committed into a source file makes `file` call it `data` and
// takes the whole test file out of grep, rg and git grep. A suite nobody can search is a
// suite nobody maintains, and it fails silently — Node reads the byte perfectly well.
const HIDE_OR_SHOW_CURSOR = /\u001B\[\?25[lh]/
const MOVE_CURSOR_UP = /\u001B\[\d*[AF]/

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => stripAnsi(chunks.join('')),
    raw: () => chunks.join(''),
  }
}

const allPresent = () => true
const HOME = '/home/me'
const CWD = '/repo'
const CONFIG = join(CWD, 'ralph.config.sh')
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')

function warmCache(latestVersion) {
  return Volume.fromJSON(
    { [CACHE_PATH]: JSON.stringify({ latest_version: latestVersion }) },
    '/',
  )
}

// ralph.config.sh as a text seam: absent by default, so no test depends on the file the
// developer happens to have in their checkout.
function configSeams(text) {
  const reads = []
  return {
    reads,
    exists: (p) => {
      reads.push({ op: 'exists', path: String(p) })
      return text !== undefined
    },
    readFile: (p) => {
      reads.push({ op: 'read', path: String(p) })
      return text ?? ''
    },
  }
}

async function runDoctor({
  cacheFs = new Volume(),
  home = HOME,
  cwd = CWD,
  currentVersion = '0.17.0',
  hasCommand = allPresent,
  env = {},
  config,
  stdout = makeStream(),
  extra = {},
} = {}) {
  const stderr = makeStream()
  const seams = configSeams(config)
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
    color: false,
    exists: seams.exists,
    readFile: seams.readFile,
    ...extra,
  })
  return { result, out: stdout.output(), err: stderr.output(), stdout, seams }
}

/** The box's rows are `label value` pairs in an eight-column gutter. */
const GUTTER = 8
const prefixFor = (label) => `│ ${label.padEnd(GUTTER)}`
const rowValue = (out, label) => {
  const prefix = prefixFor(label)
  const line = out.split('\n').find((l) => l.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length, -2).trimEnd()
}
const titleVersion = (out) => {
  const line = out.split('\n').find((l) => l.startsWith('╭'))
  const match = line === undefined ? null : /^╭─ ralph (.*?) ─+╮$/.exec(line)
  return match ? match[1] : undefined
}
const boxLines = (out) => out.split('\n').filter((l) => /^[╭│╰]/.test(l))
/** Everything above the blank line that separates the identity block from the report. */
const head = (out) => out.split('\n\n')[0]
const firstDepIndex = (out) => out.split('\n').findIndex((l) => /^\s+[✓✗!]\s/.test(l))

describe('doctor identity box (#75) — one paste, above the report', () => {
  it('prints the box first, then a blank line, then the dependency report', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.18.0') })
    const lines = out.split('\n')
    expect(lines[0].startsWith('╭─ ralph 0.17.0 ')).toBe(true)
    expect(lines[lines.findIndex((l) => l.startsWith('╰'))]).toMatch(/^╰─+╯$/)
    // The blank line is the separator between the box and the report, and it is the
    // only blank between them.
    const closeIdx = lines.findIndex((l) => l.startsWith('╰'))
    expect(lines[closeIdx + 1]).toBe('')
    expect(firstDepIndex(out)).toBe(closeIdx + 2)
  })

  it('carries the version, platform, agent, cached verdict and cwd in one block', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.18.0'), env: { RALPH_AGENT: 'codex' } })
    expect(titleVersion(out)).toBe('0.17.0')
    expect(rowValue(out, 'os')).toBe('mac')
    expect(rowValue(out, 'agent')).toBe('codex')
    expect(rowValue(out, 'cached')).toBe('0.18.0 available — run `ralph update`')
    expect(rowValue(out, 'cwd')).toBe(CWD)
    // One block: every fact is inside the frame, nothing loose above or below it.
    expect(boxLines(out)).toHaveLength(6)
  })

  it('folds the old header and version line in rather than printing them twice', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('0.17.0') })
    expect(out).not.toContain('Ralph doctor — platform:')
    expect(out.split('\n').filter((l) => l.startsWith('version: '))).toEqual([])
    // Each folded fact appears exactly once in the identity block. Scoped to the block
    // rather than to the whole of stdout on purpose: the dep report below names the agent's
    // BINARY (`✓ claude`), which is a different fact about a different thing, and demanding
    // global uniqueness would be demanding that the report stop naming what it checked.
    for (const fact of ['mac', 'claude', '0.17.0 — up to date']) {
      expect(head(out).split(fact).length - 1, fact).toBe(1)
    }
  })

  it('keeps #27’s three verdicts, in the box', async () => {
    const behind = await runDoctor({ cacheFs: warmCache('0.18.0') })
    expect(rowValue(behind.out, 'cached')).toBe('0.18.0 available — run `ralph update`')
    const current = await runDoctor({ cacheFs: warmCache('0.17.0') })
    expect(rowValue(current.out, 'cached')).toBe('0.17.0 — up to date')
    const cold = await runDoctor({ cacheFs: new Volume() })
    expect(rowValue(cold.out, 'cached')).toBe('unknown (no update check cached yet)')
  })

  it('names the working directory it was given, never the one the test runs in', async () => {
    const { out } = await runDoctor({ cwd: '/Users/me/projects/thing' })
    expect(rowValue(out, 'cwd')).toBe('/Users/me/projects/thing')
  })

  it('forwards the terminal width, so the frame degrades with it (#72)', async () => {
    // The ladder is composeBanner's and is asserted there; what matters here is that
    // doctor hands over a column count at all rather than always drawing 60.
    const stdout = makeStream()
    stdout.columns = 30
    const { out } = await runDoctor({ stdout })
    expect(out).not.toContain('│')
    expect(out.split('\n').find((l) => l.startsWith('agent'))).toBe(`agent   claude`)
  })

  it('keeps the agent-fallback warning beside the box, on stdout', async () => {
    const { out, err } = await runDoctor({ env: { RALPH_AGENT: 'codx' } })
    expect(rowValue(out, 'agent')).toBe('claude')
    const lines = out.split('\n')
    const warnIdx = lines.findIndex((l) => l.includes('unrecognized'))
    // Below the frame it annotates, above the blank line and the report.
    expect(lines[warnIdx - 1].startsWith('╰')).toBe(true)
    expect(lines[warnIdx].startsWith('  ! ')).toBe(true)
    expect(lines[warnIdx + 1]).toBe('')
    expect(err).toBe('')
  })
})

describe('doctor identity box (#75) — no sprite, no animation, at any setting', () => {
  for (const banner of [undefined, 'full', 'static', 'off', 'FULL', 'nonsense']) {
    it(`draws no pixels and moves no cursor with RALPH_BANNER=${String(banner)}`, async () => {
      const env = banner === undefined ? {} : { RALPH_BANNER: banner }
      const { stdout } = await runDoctor({ cacheFs: warmCache('0.18.0'), env, config: banner })
      const raw = stdout.raw()
      // The sprite's two glyphs (lib/sprite-render.js) and the player's cursor control.
      expect(raw).not.toContain('▀')
      expect(raw).not.toContain('▄')
      expect(raw).not.toMatch(HIDE_OR_SHOW_CURSOR)
      expect(raw).not.toMatch(MOVE_CURSOR_UP)
    })
  }

  it('cannot reach a sprite at all — asserted on the source, not the output', async () => {
    // The ABSENCE of an animation cannot be shown by exercising happy paths: doctor must
    // not be able to acquire one by accident. picocolors is already its colour source,
    // which is why `color` defaults to `pc.isColorSupported` rather than to
    // sprite-banner's `colorEnabled` — importing that for one boolean would put the
    // pixels one edit away.
    // Read WITHOUT comments, because the comments are where the argument for all of this is
    // written down and they name the modules they are arguing against.
    const code = codeWithoutComments(new URL('./doctor.js', import.meta.url))
    expect(code).not.toMatch(/sprite/i)
    expect(code).not.toMatch(/playSplash|renderSplashFrames|colorEnabled/)
  })
})

describe('doctor identity box (#75) — the box survives the early return', () => {
  it('prints the box above the missing-critical report and still exits 1', async () => {
    const { out, result } = await runDoctor({
      cacheFs: warmCache('9.9.9'),
      hasCommand: (cmd) => cmd !== 'git',
    })
    expect(result.exitCode).toBe(1)
    expect(titleVersion(out)).toBe('0.17.0')
    expect(rowValue(out, 'agent')).toBe('claude')
    expect(rowValue(out, 'cached')).toContain('9.9.9 available')
    expect(firstDepIndex(out)).toBeGreaterThan(out.split('\n').findIndex((l) => l.startsWith('╰')))
  })

  it('exits with the same code in every path, box or no box', async () => {
    const paths = [
      ['all present', allPresent, 0],
      ['a missing critical dep', (c) => c !== 'tmux', 1],
      ['a missing optional dep', (c) => c !== 'jq', 0],
    ]
    for (const [label, hasCommand, exitCode] of paths) {
      for (const env of [{}, { RALPH_BANNER: 'off' }, { RALPH_BANNER: 'nonsense' }]) {
        const { result } = await runDoctor({ hasCommand, env, cacheFs: warmCache('9.9.9') })
        expect(result.exitCode, `${label} / ${JSON.stringify(env)}`).toBe(exitCode)
      }
    }
  })

  it('keeps the returned shape unchanged', async () => {
    const { result } = await runDoctor({ cacheFs: warmCache('9.9.9') })
    expect(Object.keys(result).sort()).toEqual([
      'exitCode',
      'missingCritical',
      'missingNonCritical',
      'platform',
    ])
  })
})

describe('doctor identity box (#75) — RALPH_BANNER', () => {
  it('prints nothing at all for an explicit RALPH_BANNER=off', async () => {
    const { out, result } = await runDoctor({
      cacheFs: warmCache('0.18.0'),
      env: { RALPH_BANNER: 'off' },
    })
    expect(boxLines(out)).toEqual([])
    expect(out).not.toContain('0.18.0')
    // Not one byte between the command line and the report, exactly as `off` means in
    // `ralph start` — no orphan blank line either.
    expect(firstDepIndex(out)).toBe(0)
    expect(out).toContain('All deps present.')
    expect(result.exitCode).toBe(0)
  })

  it('honours RALPH_BANNER=off out of ralph.config.sh, not just the environment', async () => {
    const { out, seams } = await runDoctor({ config: 'RALPH_BANNER=off\nTASK_SOURCE=github\n' })
    expect(boxLines(out)).toEqual([])
    // Read through the injected seams, at the cwd it was given — the same file and the
    // same reader `ralph start` uses, so the knob cannot answer differently there.
    expect(seams.reads).toEqual([
      { op: 'exists', path: CONFIG },
      { op: 'read', path: CONFIG },
    ])
  })

  it('lets the environment win over the config, like `ralph start` does', async () => {
    const { out } = await runDoctor({
      config: 'RALPH_BANNER=off\n',
      env: { RALPH_BANNER: 'full' },
    })
    expect(titleVersion(out)).toBe('0.17.0')
  })

  it('keeps the box for a value it does not recognize, and says nothing about it', async () => {
    // A typo'd knob costs a picture at worst, never a diagnostic — and doctor does not print the
    // warning `ralph start` prints. Since #108 that is an editorial choice and nothing more:
    // `oneLine` was extracted into lib/one-line.js (which imports nothing), so the old reason —
    // that reaching it meant a transitive execa dependency through lib/digest.js — is gone, and
    // what is left is that a typo in a COSMETIC knob does not earn a line in a diagnostic. See
    // doctor.js.
    const { out, err } = await runDoctor({ env: { RALPH_BANNER: 'sprite-only-please' } })
    expect(titleVersion(out)).toBe('0.17.0')
    expect(err).toBe('')
    expect(out).not.toContain('RALPH_BANNER')
  })

  it('draws the box when there is no config file and nothing in the environment', async () => {
    const { out, seams } = await runDoctor()
    expect(titleVersion(out)).toBe('0.17.0')
    // A missing file is not a failure and is never read.
    expect(seams.reads).toEqual([{ op: 'exists', path: CONFIG }])
  })

  const hostile = [
    ['a cwd that is not a path', { cwd: 42 }],
    ['a null cwd', { cwd: null }],
    ['an exists() that throws', { extra: { exists: () => { throw new Error('boom') } } }],
    ['a readFile() that throws', { config: '', extra: { readFile: () => { throw new Error('boom') } } }],
    ['a readFile() returning a number', { config: '', extra: { readFile: () => 42 } }],
  ]

  for (const [label, opts] of hostile) {
    it(`never lets the config read cost the run — ${label}`, async () => {
      const { result, out } = await runDoctor(opts)
      expect(result.exitCode).toBe(0)
      expect(out).toContain('All deps present.')
    })
  }
})

describe('doctor identity box (#75) — still inert', () => {
  it('makes no network call and takes no exec dependency', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = () => {
      calls += 1
      throw new Error('doctor must not hit the network')
    }
    try {
      const { result, out } = await runDoctor({
        cacheFs: warmCache('0.18.0'),
        extra: {
          exec: () => {
            throw new Error('doctor must not shell out')
          },
        },
      })
      expect(result.exitCode).toBe(0)
      expect(rowValue(out, 'cached')).toContain('0.18.0 available')
    } finally {
      globalThis.fetch = original
    }
    expect(calls).toBe(0)
  })

  it('writes nothing, and reads the config file at most once', async () => {
    const ops = []
    const vol = warmCache('0.18.0')
    const cacheFs = {
      readFileSync: (...a) => {
        ops.push({ op: 'read', path: String(a[0]) })
        return vol.readFileSync(...a)
      },
      writeFileSync: (...a) => ops.push({ op: 'write', path: String(a[0]) }),
      mkdirSync: (...a) => ops.push({ op: 'mkdir', path: String(a[0]) }),
    }
    const { seams } = await runDoctor({ cacheFs, config: 'RALPH_BANNER=full\n' })
    expect(ops).toEqual([{ op: 'read', path: CACHE_PATH }])
    expect(seams.reads.filter((r) => r.op === 'read')).toHaveLength(1)
  })
})
