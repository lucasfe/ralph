import { describe, it, expect, vi } from 'vitest'
import { Volume } from 'memfs'
import pc from 'picocolors'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { doctorCommand } from './doctor.js'

// ---------------------------------------------------------------------------
// QA augmentation for #125 — the Jira auth row as `ralph doctor` emits it.
//
// The dev's doctor.test.js proves the three rendered states, the login hint and
// that the row survives the missing-critical early return. This file attacks the
// claims AROUND those three states, because every one of them is a promise made
// to something outside this command:
//
//   1. THE ROW CANNOT MOVE THE EXIT CODE, in any auth state, on any dep verdict.
//      Wrappers and CI steps gate on `ralph doctor`; an expired token must not
//      start failing them. Asserted as a matrix rather than as three examples,
//      including the missing-critical path where the exit code has a REASON and
//      that reason must stay the dep.
//   2. THE RETURNED OBJECT DOES NOT GROW. doctor.version-line.qa.test.js pins the
//      four keys for the github arm; a source that added a fifth would break every
//      consumer that spreads the result. Pinned here for the jira arm, in every
//      auth state and on both dep verdicts.
//   3. NOTHING IS PROBED OUTSIDE JIRA MODE. A probe that fired in github mode
//      would put a latent subprocess in the common path of an offline diagnostic.
//      Asserted on BOTH seams (`exec` and `probeJiraAuth`) seeing zero calls.
//   4. A JIRA REPORT MENTIONS NO `gh` AT ALL — the absence of the token, not
//      merely the absence of a red row, because a Jira-only repo may have no
//      GitHub and being told to install gh is the bug #565 fixed for folder mode.
//   5. THE PROBE SEAM IS TOTAL. doctor's other injected seams degrade rather than
//      crash (see the hostile-readCache suite in doctor.version-line.qa.test.js);
//      this asks the same question of the new one.
//   6. THE IMPORT GRAPH STAYED CLOSED. doctor.js now imports lib/jira-auth.js, and
//      no existing anti-vacuity assertion names that file — so the bare-specifier
//      guard would keep passing about a graph that grew a module.
//
// `exec` is injected in every run, so no test here can invoke a real `acli`, and
// the cache fs / home / cwd / config seams are injected too, so nothing touches
// the real machine.
// ---------------------------------------------------------------------------

const ESC = String.fromCharCode(27)
const LF = String.fromCharCode(10)
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const stripAnsi = (s) => s.replace(ANSI, '')

function makeStream(writeReturns = true) {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return writeReturns
    },
    output: () => stripAnsi(chunks.join('')),
    raw: () => chunks.join(''),
  }
}

const allPresent = () => true
const HOME = '/home/me'
const CWD = '/repo'

// The two exit codes the probe distinguishes, as the only thing a stub has to be
// able to produce.
const okExec = async () => ({ exitCode: 0, stdout: '', stderr: '' })
const failExec = async () => ({ exitCode: 1, stdout: '', stderr: '' })

async function runDoctor({ stdout = makeStream(), stderr = makeStream(), env = {}, ...extra } = {}) {
  const result = await doctorCommand({
    stdout,
    stderr,
    hasCommand: allPresent,
    platform: 'mac',
    env,
    currentVersion: '0.17.0',
    cacheFs: new Volume(),
    home: HOME,
    cwd: CWD,
    exists: () => false,
    ...extra,
  })
  return { result, out: stdout.output(), err: stderr.output(), stdout, stderr }
}

const jira = (opts = {}) => runDoctor({ env: { TASK_SOURCE: 'jira' }, ...opts })

const KEYS = ['exitCode', 'missingCritical', 'missingNonCritical', 'platform']
// The three auth states, named once: the probe answered yes, the probe answered
// no, and nobody could ask.
const AUTH_STATES = [
  ['authenticated', { exec: okExec }, '✓ jira auth'],
  ['not authenticated', { exec: failExec }, '! jira auth (not authenticated)'],
  ['not verified', {}, '! jira auth (not verified)'],
]

describe('doctor jira auth — the row cannot move the exit code (#125 QA)', () => {
  for (const [label, opts, row] of AUTH_STATES) {
    it(`exits 0 with every dep present — ${label}`, async () => {
      const { result, out, err } = await jira(opts)
      expect(out).toContain(row)
      expect(result.exitCode).toBe(0)
      expect(out).toContain('All deps present.')
      // The row is a REPORT, so it never reaches stderr — the stream a user
      // redirecting to a file would lose.
      expect(err).toBe('')
    })

    it(`exits 0 on a missing OPTIONAL dep and keeps the optional summary — ${label}`, async () => {
      const { result, out } = await jira({ ...opts, hasCommand: (c) => c !== 'jq' })
      expect(result.exitCode).toBe(0)
      expect(out).toContain(row)
      expect(out).toContain('Optional deps missing: jq')
    })

    it(`exits 1 for the DEP and only the dep, still printing the row — ${label}`, async () => {
      // The exit code has a reason here, and the auth state must not be able to
      // change it, add to it, or take the row away.
      const { result, out, err } = await jira({ ...opts, hasCommand: (c) => c !== 'acli' })
      expect(result.exitCode).toBe(1)
      expect(result.missingCritical.map((r) => r.name)).toEqual(['acli'])
      expect(out).toContain(row)
      expect(err).toContain('Missing 1 required dep(s): acli')
      // ...and the failing-auth wording never leaks into the dep verdict.
      expect(err).not.toContain('jira auth')
    })

    it(`adds no field to the returned object, on either dep verdict — ${label}`, async () => {
      for (const hasCommand of [allPresent, (c) => c !== 'acli', (c) => c !== 'jq']) {
        const { result } = await jira({ ...opts, hasCommand })
        expect(Object.keys(result).sort()).toEqual(KEYS)
      }
    })
  }

  it('the exit code is identical across all three auth states, dep verdict by dep verdict', async () => {
    for (const [hasCommand, expected] of [
      [allPresent, 0],
      [(c) => c !== 'jq', 0],
      [(c) => c !== 'acli', 1],
      [(c) => c !== 'git', 1],
    ]) {
      for (const [label, opts] of AUTH_STATES) {
        const { result } = await jira({ ...opts, hasCommand })
        expect(result.exitCode, label).toBe(expected)
      }
    }
  })

  it('the report is byte-identical across auth states apart from the two auth lines', async () => {
    // The strongest form of "additive output only": drop the row (and its hint) and
    // three different auth states produce the same report, to the byte.
    const withoutAuth = (out) =>
      out
        .split(LF)
        .filter((l) => !l.includes('jira auth') && !/^\s+(login|check):/.test(l))
        .join(LF)
    let baseline
    for (const [label, opts] of AUTH_STATES) {
      const { out } = await jira(opts)
      if (baseline === undefined) baseline = withoutAuth(out)
      expect(withoutAuth(out), label).toBe(baseline)
    }
  })
})

describe('doctor jira auth — nothing is probed outside jira mode (#125 QA)', () => {
  for (const [label, env] of [
    ['unset (github default)', {}],
    ['github', { TASK_SOURCE: 'github' }],
    ['folder', { TASK_SOURCE: 'folder' }],
    ['a typo that falls back to github', { TASK_SOURCE: 'jiras' }],
    ['whitespace only', { TASK_SOURCE: '   ' }],
  ]) {
    it(`neither seam is called with TASK_SOURCE ${label}`, async () => {
      const exec = vi.fn(async () => ({ exitCode: 0 }))
      const probeJiraAuth = vi.fn(async () => ({ ok: true, reason: null }))
      const { out, result } = await runDoctor({ env, exec, probeJiraAuth })
      expect(exec).not.toHaveBeenCalled()
      expect(probeJiraAuth).not.toHaveBeenCalled()
      expect(out).not.toContain('jira auth')
      expect(out).not.toContain('acli')
      expect(result.exitCode).toBe(0)
    })
  }

  it('probes exactly once per run in jira mode, with a bag holding only `exec`', async () => {
    // One row, one probe: a probe per dep row would be eight subprocesses.
    const exec = okExec
    const probeJiraAuth = vi.fn(async () => ({ ok: true, reason: null }))
    await jira({ exec, probeJiraAuth })
    expect(probeJiraAuth).toHaveBeenCalledTimes(1)
    const bag = probeJiraAuth.mock.calls[0][0]
    expect(Object.keys(bag)).toEqual(['exec'])
    // The very function bin/ralph.js handed in — not a wrapper, not a copy.
    expect(bag.exec).toBe(exec)
  })

  it('a missing acli in jira mode still probes — the two questions are independent', async () => {
    // `acli` on PATH and `acli` logged in are different questions, and doctor asks
    // the second one even when the first answered no. That is the honest ordering:
    // the probe reports what running the command actually did.
    const probeJiraAuth = vi.fn(async () => ({ ok: false, reason: 'jira not authenticated' }))
    const { out, result } = await jira({
      exec: failExec,
      probeJiraAuth,
      hasCommand: (c) => c !== 'acli',
    })
    expect(probeJiraAuth).toHaveBeenCalledTimes(1)
    expect(result.exitCode).toBe(1)
    expect(out).toContain('✗ acli (required)')
    expect(out).toContain('! jira auth (not authenticated)')
  })

  it('an uppercase TASK_SOURCE reaches the jira arm — the resolver is what decides', async () => {
    // The composition, end to end at the command level: env -> resolveSource ->
    // both the dep gate and the auth row.
    for (const TASK_SOURCE of ['JIRA', '  Jira\n', 'jIrA']) {
      const { out } = await jira({ env: { TASK_SOURCE }, exec: okExec })
      expect(out, TASK_SOURCE).toContain('✓ acli')
      expect(out, TASK_SOURCE).toContain('✓ jira auth')
    }
  })
})

describe('doctor jira auth — a jira report names no gh (#125 QA)', () => {
  it('contains no `gh` token at all, in any auth state or dep verdict', async () => {
    // The absence of the TOKEN, not merely of a `✗ gh` row: a Jira-only repo may
    // have no GitHub, and an install hint for a tool the user does not need is the
    // exact complaint #565 fixed for folder mode.
    for (const [label, opts] of AUTH_STATES) {
      for (const hasCommand of [allPresent, () => false]) {
        const { out, err } = await jira({ ...opts, hasCommand })
        const report = out + err
        expect(report, label).not.toMatch(/\bgh\b/)
        expect(report, label).not.toContain('github')
        expect(report, label).not.toContain('brew install gh')
      }
    }
  })

  it('lists acli where github mode lists gh, and neither mode lists the other', async () => {
    const { out: jiraOut } = await jira({ exec: okExec })
    const { out: githubOut } = await runDoctor({ env: {}, exec: okExec })
    expect(jiraOut).toContain('✓ acli')
    expect(githubOut).toContain('✓ gh')
    expect(githubOut).not.toContain('acli')
    expect(githubOut).not.toContain('jira auth')
  })
})

describe('doctor jira auth — placement and appearance (#125 QA)', () => {
  const lineIndex = (out, needle) => out.split(LF).findIndex((l) => l.includes(needle))

  it('prints the auth row AFTER every dep row and BEFORE the summary', async () => {
    const { out } = await jira({ exec: failExec, hasCommand: (c) => c !== 'jq' })
    const lines = out.split(LF)
    const authIdx = lineIndex(out, 'jira auth')
    const acliIdx = lineIndex(out, '✓ acli')
    const lastDepIdx = lines.reduce((acc, l, i) => (/^\s+[✓✗!]\s\w/.test(l) ? i : acc), -1)
    expect(acliIdx).toBeGreaterThan(-1)
    expect(authIdx).toBeGreaterThan(acliIdx)
    // The auth row IS the last of the symbol rows — it joins the dependency block
    // rather than floating after the summary.
    expect(lastDepIdx).toBe(authIdx)
    expect(lineIndex(out, 'Optional deps missing')).toBeGreaterThan(authIdx)
    // The hint is the row's own second line, indented like `install:`.
    expect(lines[authIdx + 1]).toBe('      login: acli jira auth login')
  })

  it('the not-verified hint is the STATUS command, and says nothing about logging in', async () => {
    // Two different sentences for two different findings: "I could not check" tells
    // the user how to check, "you are not logged in" tells them how to log in.
    const { out } = await jira({})
    const lines = out.split(LF)
    const idx = lineIndex(out, 'jira auth')
    expect(lines[idx + 1]).toBe('      check: acli jira auth status')
    expect(out).not.toContain('not authenticated')
    expect(out).not.toContain('auth login')
  })

  it('the row is deterministic — the same run twice is byte-identical', async () => {
    const a = await jira({ exec: failExec })
    const b = await jira({ exec: failExec })
    expect(a.out).toBe(b.out)
    expect(a.stdout.raw()).toBe(b.stdout.raw())
  })

  it('survives RALPH_BANNER=off — the knob silences a picture, never a diagnostic', async () => {
    // Exactly how the agent-fallback warning is treated. And no orphan blank line:
    // `off` means nothing between the command line and the first row of the report.
    for (const [label, opts, row] of AUTH_STATES) {
      const { out, result } = await jira({ ...opts, env: { TASK_SOURCE: 'jira', RALPH_BANNER: 'off' } })
      expect(out, label).toContain(row)
      expect(out, label).not.toContain('╭')
      expect(out.startsWith('  '), label).toBe(true)
      expect(result.exitCode, label).toBe(0)
    }
  })

  it('survives an unrecognized RALPH_AGENT — the warning and the row coexist', async () => {
    const { out, result } = await jira({
      exec: failExec,
      env: { TASK_SOURCE: 'jira', RALPH_AGENT: 'gpt5' },
    })
    expect(out).toContain('unrecognized')
    expect(out).toContain('! jira auth (not authenticated)')
    expect(result.exitCode).toBe(0)
  })

  it('tolerates a stdout whose write() reports backpressure', async () => {
    for (const [label, opts, row] of AUTH_STATES) {
      const stdout = makeStream(false)
      const { result } = await jira({ ...opts, stdout })
      expect(stdout.output(), label).toContain(row)
      expect(result.exitCode, label).toBe(0)
    }
  })

  it.skipIf(!pc.isColorSupported)('paints the failing row YELLOW and never red', async () => {
    // `✗ name (required)` means "doctor exited 1 because of this" in every other
    // line of this report. Borrowing red for a row that exits 0 would make the
    // report's own vocabulary lie.
    const RED = pc.red('x').match(/\d+/)[0]
    const YELLOW = pc.yellow('x').match(/\d+/)[0]
    for (const [label, opts] of AUTH_STATES.slice(1)) {
      const { stdout } = await jira(opts)
      const line = stdout
        .raw()
        .split(LF)
        .find((l) => l.includes('jira auth'))
      expect(line, label).toContain(YELLOW)
      expect(line, label).not.toContain(`[${RED}m`)
    }
    const { stdout } = await jira({ exec: okExec })
    const okLine = stdout
      .raw()
      .split(LF)
      .find((l) => l.includes('jira auth'))
    expect(okLine).toContain(pc.green('x').match(/\d+/)[0])
  })
})

describe('doctor jira auth — the probe seam must be total (#125 QA)', () => {
  // doctor's other injected seams degrade rather than crash, deliberately and with
  // tests: doctor.version-line.qa.test.js sweeps a `readCache` that throws every
  // shape of value AND a non-function one, on the argument that a diagnostic never
  // crashes over its own inputs. `probeJiraAuth` is a defaulted option on the same
  // exported function, so it is the same class of seam and gets the same question.
  const hostile = [
    ['throws synchronously', () => { throw new Error('probe blew up') }],
    ['rejects', async () => { throw new Error('probe rejected') }],
    ['rejects with a non-Error', () => Promise.reject('a bare string')],
    ['is not a function', 'nope'],
  ]

  for (const [label, probeJiraAuth] of hostile) {
    it(`still produces a report and a dep-only exit code when the probe ${label}`, async () => {
      const { result, out } = await jira({ exec: okExec, probeJiraAuth })
      expect(result.exitCode).toBe(0)
      expect(Object.keys(result).sort()).toEqual(KEYS)
      // The dependency report is the part that decides the exit code, and it must
      // survive whatever the auth question did.
      expect(out).toContain('✓ acli')
      expect(out).toContain('All deps present.')
    })

    it(`still exits 1 for a missing critical dep when the probe ${label}`, async () => {
      const { result } = await jira({
        exec: okExec,
        probeJiraAuth,
        hasCommand: (c) => c !== 'acli',
      })
      expect(result.exitCode).toBe(1)
      expect(result.missingCritical.map((r) => r.name)).toEqual(['acli'])
    })
  }

  const odd = [
    ['undefined', async () => undefined],
    ['null', async () => null],
    ['an empty object', async () => ({})],
    ['a string', async () => 'yes'],
    ['the number 0', async () => 0],
    ['false', async () => false],
    ['an ok getter that throws', async () => ({ get ok() { throw new Error('hostile getter') } })],
  ]

  for (const [label, probeJiraAuth] of odd) {
    it(`renders one of the two failure rows when the probe returns ${label}`, async () => {
      const { result, out } = await jira({ exec: okExec, probeJiraAuth })
      expect(result.exitCode).toBe(0)
      // Either failing wording is acceptable — what is not acceptable is a claim of
      // success from a probe that answered nothing, or a crash.
      expect(out).toMatch(/! jira auth \((not authenticated|not verified)\)/)
      expect(out).not.toContain('✓ jira auth')
      expect(Object.keys(result).sort()).toEqual(KEYS)
    })
  }

  it('an `ok` that is merely TRUTHY paints the green row (pins `auth?.ok`)', async () => {
    // Pinned because the render reads `auth?.ok` rather than `auth.ok === true`: a
    // probe that answered with a string DOES paint a ✓. Today's probe always
    // answers a boolean, so this documents which side of the line doctor is on
    // rather than asking it to change sides.
    const { out } = await jira({ exec: okExec, probeJiraAuth: async () => ({ ok: 'yes' }) })
    expect(out).toContain('✓ jira auth')
  })

  it('a truthy non-function `exec` is NOT VERIFIED, not crashed on and not a verdict', async () => {
    // Review round 1 moved this: doctor gates on `typeof exec === 'function'` rather
    // than on truthiness, so a caller that passed garbage for the seam lands in the
    // same state as one that passed nothing — the question could not be put. It was
    // rendering "not authenticated", which is a login failure nobody observed, and
    // the render's own stated rule ("a probe that was never callable did not reach a
    // verdict") already said it should not.
    for (const exec of ['notafunction', 42, {}]) {
      const { out, result } = await jira({ exec })
      expect(out, String(exec)).toContain('! jira auth (not verified)')
      expect(out, String(exec)).not.toContain('not authenticated')
      expect(result.exitCode, String(exec)).toBe(0)
    }
  })
})

describe('doctor jira auth — the import graph stayed closed (#125 QA)', () => {
  // The same walk doctor.version-line.qa.test.js and doctor.agent-warning.qa.test.js
  // make, duplicated here on purpose and for the reason the latter states: the two
  // files fail for different reasons, and a reader chasing #125 should find the
  // constraint in the file about #125. #125 added a hop (doctor -> jira-auth) whose
  // whole content is running a subprocess, and NO existing anti-vacuity assertion
  // names it — so a walker that stopped short would keep asserting "exactly four
  // bare specifiers" about a graph that grew the one module most able to break it.
  const DOCTOR = fileURLToPath(new URL('./doctor.js', import.meta.url))

  function specifiersOf(src) {
    const out = []
    const patterns = [
      /\bfrom\s*['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /^\s*import\s+['"]([^'"]+)['"]/gm,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]
    for (const re of patterns) {
      let m
      while ((m = re.exec(src)) !== null) out.push(m[1])
    }
    return out
  }

  function importGraph(entry) {
    const files = new Map()
    const bare = new Set()
    const stack = [entry]
    while (stack.length > 0) {
      const file = stack.pop()
      if (files.has(file)) continue
      const src = codeWithoutComments(file)
      files.set(file, src)
      for (const spec of specifiersOf(src)) {
        if (spec.startsWith('.')) stack.push(resolve(dirname(file), spec))
        else bare.add(spec)
      }
    }
    return { files, bare }
  }

  const graph = importGraph(DOCTOR)
  const rel = (f) => f.slice(f.indexOf('/lib/') + 1)
  const names = [...graph.files.keys()].map(rel)

  it('actually reached the module #125 added (guards against a vacuous pass)', () => {
    expect(names).toContain('lib/jira-auth.js')
    expect(names).toContain('lib/commands/doctor.js')
  })

  it('still pulls in exactly four bare specifiers with that module on the graph', () => {
    expect([...graph.bare].sort()).toEqual(['node:fs', 'node:os', 'node:path', 'picocolors'])
  })

  it('no file on the graph — the new one included — can shell out or open a socket', () => {
    const banned = [
      [/\bexeca\b/, 'execa'],
      [/child_process/, 'child_process'],
      [/\bspawn(Sync)?\s*\(/, 'spawn('],
      [/\bexecSync\s*\(/, 'execSync('],
      [/\bfetch\s*\(/, 'fetch('],
      [/\bhttps?\.request\b/, 'http.request'],
    ]
    for (const [file, src] of graph.files) {
      for (const [re, label] of banned) {
        expect(re.test(src), `${rel(file)} must not reference ${label}`).toBe(false)
      }
    }
  })

  it('bin/ralph.js is where the spawner is wired in, and it hands doctor an `exec`', () => {
    // The other half of the seam, and it lives in a file vitest does not import
    // (bin/ is outside the include globs and parses argv on load), so it is asserted
    // against its SOURCE the way cycle.update-notice.test.js asserts the same file's
    // version threading. Without this, "the graph is closed" and "the row actually
    // runs acli for a real user" cannot both be checked.
    const bin = codeWithoutComments(fileURLToPath(new URL('../../bin/ralph.js', import.meta.url)))
    expect(bin).toMatch(/import\s*\{\s*execa\s*\}\s*from\s*'execa'/)
    expect(bin).toMatch(/doctorCommand\(\{[^}]*exec:\s*execa/)
  })
})
