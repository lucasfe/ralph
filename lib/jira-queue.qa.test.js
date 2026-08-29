import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { queueCount } from './jira-queue.js'
import { composeJiraJql } from './jira-jql.js'

// QA augmentation for #126. The dev's jira-queue.test.js locks the argv, the parse and the
// degradation table. This file adds the three things that table cannot reach:
//
//   THE ARGV AS AN EXACT CALL, options object included. This module is the only place in
//   Ralph that knows `acli` exists, so the spawn is an interface: a `shell: true` sneaking
//   into those options would hand a JQL full of quotes and parentheses to a shell, and the
//   dev's `objectContaining({ reject: false })` would not notice.
//
//   THE RESULT SHAPES A REAL SPAWNER PRODUCES, not only invented ones — execa's ENOENT
//   result (`{ failed: true }`, no `exitCode` at all), a CRLF-terminated count, a Buffer,
//   an object whose `toString` throws, and the exact `Number.MAX_SAFE_INTEGER` boundary the
//   parse is written against.
//
//   THE CLI FOOTER, which nothing covered. templates/ralph.sh is meant to shell out to
//   `node jira-queue.js count "<jql>"`, and `runCli` is NOT exported — so the only way to
//   test the verb, its exit codes and its lazily-resolved spawner is to run it as a process.
//   It is run against a FAKE `acli` on a PATH containing nothing else, which is what makes
//   that hermetic: the count comes back from a shell script in a temp directory, the real
//   Atlassian CLI is unreachable by construction, and the script records the argv it was
//   handed so the end-to-end spawn is asserted rather than assumed.
//
// NOTHING HERE IMPORTS execa OR node:child_process TO SPAWN acli. The library half injects
// `exec`; the CLI half spawns node and nothing else.

const JQL = 'project = RALPH AND statusCategory != Done'
const COMPOSED = composeJiraJql(JQL).jql
const ACLI_ARGV = ['jira', 'workitem', 'search', '--jql', COMPOSED, '--count']
const LF = String.fromCharCode(0x0a)
const CR = String.fromCharCode(0x0d)
const TAB = String.fromCharCode(0x09)

const resultOf = (stdout, extra = {}) =>
  vi.fn(async () => ({ exitCode: 0, stdout, stderr: '', ...extra }))

describe('queueCount — the argv IS the interface (#126 QA)', () => {
  it('calls exec exactly once, with the exact argv and the exact options object', async () => {
    // `toEqual` on the WHOLE call rather than `objectContaining` on the options: the options
    // are the half where a regression is silent. `shell: true` here would send a JQL
    // containing quotes, parentheses and commas through /bin/sh, and `cwd`/`env` additions
    // would make a queue depth depend on where the command was run from.
    const exec = resultOf('7' + LF)
    await queueCount(JQL, { exec })
    expect(exec.mock.calls).toEqual([['acli', ACLI_ARGV, { reject: false }]])
  })

  it('passes the composed query as ONE argv element, never split and never quoted', async () => {
    // The composed query contains spaces, parentheses, commas and (when the user wrote one)
    // quotes. As one element it reaches acli's own argv parser untouched; split or re-quoted
    // it would be a different query.
    const exec = resultOf('7')
    await queueCount(`summary ~ "order by" AND project = R`, { exec })
    const argv = exec.mock.calls[0][1]
    expect(argv).toHaveLength(6)
    const sent = argv[argv.indexOf('--jql') + 1]
    expect(sent).toBe(composeJiraJql(`summary ~ "order by" AND project = R`).jql)
    expect(sent).toContain(`summary ~ "order by"`)
    // Nothing added shell quoting around it.
    expect(sent.startsWith(String.fromCharCode(0x27))).toBe(false)
  })

  it('sends a RELOCATED ordering, so the user’s ORDER BY reaches acli last', async () => {
    const exec = resultOf('7')
    await queueCount('project = R ORDER BY priority DESC', { exec })
    const sent = exec.mock.calls[0][1][4]
    expect(sent.endsWith('ORDER BY priority DESC')).toBe(true)
    expect(sent.indexOf('labels NOT IN')).toBeLessThan(sent.lastIndexOf('ORDER BY'))
  })

  it('does not retry, whatever came back', async () => {
    // A retry would double the cost of every `ralph status` in jira mode, and acli is a
    // network round trip. Asserted for a success, a failure and an unparseable answer.
    for (const result of [
      { exitCode: 0, stdout: '3' },
      { exitCode: 1, stdout: '', stderr: 'not logged in' },
      { exitCode: 0, stdout: 'seven' },
    ]) {
      const exec = vi.fn(async () => result)
      await queueCount(JQL, { exec })
      expect(exec).toHaveBeenCalledTimes(1)
    }
  })
})

describe('queueCount — a spawner that misbehaves in every way it can (#126 QA)', () => {
  it('answers 0 when exec throws SYNCHRONOUSLY rather than rejecting', async () => {
    // A non-async spawner double, and the shape a wrapper with an argument-validation guard
    // produces. The dev's suite covers the async throw and the rejected promise.
    const exec = vi.fn(() => {
      throw new Error('EACCES')
    })
    expect(await queueCount(JQL, { exec })).toBe(0)
  })

  it('counts a SYNCHRONOUS result — awaiting a non-promise is still awaiting', async () => {
    const exec = vi.fn(() => ({ exitCode: 0, stdout: '5' }))
    expect(await queueCount(JQL, { exec })).toBe(5)
  })

  it('answers 0 for every non-callable exec', async () => {
    for (const exec of [null, undefined, 0, 'acli', {}, [], Symbol('exec')]) {
      expect(await queueCount(JQL, { exec }), String(typeof exec)).toBe(0)
    }
  })

  it('rejects when the DEPS BAG itself is null (pinned: no shipped caller does this)', async () => {
    // The one input that gets past "never throws": destructuring `{ exec }` out of `null`
    // throws before the try block, so the promise rejects. Both shipped callers pass an
    // object literal (`{ jql, exec }` from status.js and cycle.js), and both wrap the call in
    // a try anyway — so this is pinned as the shape of the gap rather than as a behaviour
    // anything relies on. A default of `= {}` only covers `undefined`, never `null`.
    await expect(queueCount(JQL, null)).rejects.toThrow(TypeError)
  })
})

describe('queueCount — the result shapes acli and execa can actually produce (#126 QA)', () => {
  const zeroCases = {
    'execa’s ENOENT result: failed, with no exitCode at all': { failed: true },
    'execa’s timeout result': { timedOut: true, failed: true, stdout: '7' },
    'a null exitCode': { exitCode: null, stdout: '7' },
    'a signalled kill (exitCode undefined, signal set)': { signal: 'SIGKILL', stdout: '7' },
    'a count printed on the second line': { exitCode: 0, stdout: 'Searching...' + LF + '7' + LF },
    'two counts': { exitCode: 0, stdout: '7' + LF + '8' + LF },
    'a JSON document': { exitCode: 0, stdout: '{"count":7}' },
    'an HTML error page': { exitCode: 0, stdout: '<html><body>502 Bad Gateway</body></html>' },
    'a colourised count': {
      exitCode: 0,
      stdout: String.fromCharCode(0x1b) + '[32m7' + String.fromCharCode(0x1b) + '[0m',
    },
    'a signed count': { exitCode: 0, stdout: '+7' },
    'a count with a decimal point': { exitCode: 0, stdout: '7.0' },
    'a Buffer of something that is not a count': { exitCode: 0, stdout: Buffer.from('none' + LF) },
    'a count one past Number.MAX_SAFE_INTEGER': { exitCode: 0, stdout: '9007199254740992' },
  }

  for (const [label, result] of Object.entries(zeroCases)) {
    it(`answers 0 for ${label}`, async () => {
      expect(await queueCount(JQL, { exec: vi.fn(async () => result) })).toBe(0)
    })
  }

  it('reads a CRLF-terminated count, and one padded with tabs', async () => {
    expect(await queueCount(JQL, { exec: resultOf('7' + CR + LF) })).toBe(7)
    expect(await queueCount(JQL, { exec: resultOf(TAB + '12' + TAB) })).toBe(12)
  })

  it('reads Number.MAX_SAFE_INTEGER itself — the boundary is inclusive', async () => {
    // The pair with the case above it: 9007199254740991 is exactly representable and
    // 9007199254740992 is not, and `Number.isSafeInteger` is the line between them.
    expect(await queueCount(JQL, { exec: resultOf('9007199254740991') })).toBe(
      Number.MAX_SAFE_INTEGER,
    )
  })

  it('reads a stdout that is neither a string nor a Buffer but stringifies to digits', async () => {
    // The tolerance exists for Buffers (`stdout?.toString?.()`), and it is not Buffer-shaped:
    // anything with a `toString` gets the same treatment. Pinned so the reach of that line is
    // visible — the parse still refuses anything that does not stringify to digits alone.
    expect(await queueCount(JQL, { exec: resultOf({ toString: () => '5' }) })).toBe(5)
    expect(await queueCount(JQL, { exec: resultOf({ toString: () => 'five' }) })).toBe(0)
  })

  it('answers 0 — never throws — when reading stdout throws', async () => {
    // A stream wrapper whose getter or toString explodes is a diagnostic problem, and a
    // scheduled `ralph cycle` must not abort over one.
    const poisoned = {
      toString() {
        throw new Error('stdout is gone')
      },
    }
    expect(await queueCount(JQL, { exec: resultOf(poisoned) })).toBe(0)
    const throwingGetter = {
      exitCode: 0,
      get stdout() {
        throw new Error('stream already destroyed')
      },
    }
    expect(await queueCount(JQL, { exec: vi.fn(async () => throwingGetter) })).toBe(0)
  })

  it('checks the exit code BEFORE the text, even when the text is a perfect count', async () => {
    // acli printing `7` while exiting non-zero is a CLI explaining itself, not a count.
    const exec = vi.fn(async () => ({ exitCode: 3, stdout: '7' + LF, stderr: 'usage: ...' }))
    expect(await queueCount(JQL, { exec })).toBe(0)
  })
})

describe('queueCount — a misconfigured query spawns NOTHING (#126 QA)', () => {
  // The acceptance criterion this module owns: no acli process is started for a JIRA_JQL
  // that composes to nothing, because Ralph's half on its own selects every work item on the
  // Jira site. The exec double THROWS, so a call would fail loudly rather than being read as
  // a zero by accident.
  const exploding = () =>
    vi.fn(() => {
      throw new Error('acli must not be reached for a misconfigured query')
    })

  for (const [label, jql] of [
    ['a whitespace-only value', '  ' + TAB + CR + LF + ' '],
    ['a value that is only an ordering', 'order by created desc'],
    ['a boxed String object', new String(JQL)],
    ['a Symbol', Symbol('project = R')],
    ['a BigInt', 7n],
    ['an array of clauses', ['project = R']],
    ['a function returning a clause', () => JQL],
  ]) {
    it(`answers 0 and starts no process for ${label}`, async () => {
      const exec = exploding()
      expect(await queueCount(jql, { exec })).toBe(0)
      expect(exec).not.toHaveBeenCalled()
    })
  }
})

describe('jira-queue.js — no spawner on the import path (#126 QA)', () => {
  const SOURCE = new URL('./jira-queue.js', import.meta.url)
  const code = codeWithoutComments(SOURCE)

  it('imports no process spawner STATICALLY — the CLI resolves execa inside its verb', () => {
    // What this buys, stated exactly: a module-scope `import { execa }` — which a defaulted
    // `exec` parameter would require — puts execa on the import graph of EVERY importer of
    // this file, including a caller that only wanted the pure count. Keeping it inside the CLI
    // verb keeps the spawner out of the loaded set at runtime.
    //
    // What it does NOT buy is reachability from `ralph doctor`. That guard
    // (doctor.version-line.qa.test.js) extracts dynamic specifiers as well as static ones and
    // greps every file on the graph for the token `execa`, so this module would fail it either
    // way: it must not appear on doctor's graph at all. A diagnostic wanting Jira knowledge
    // imports ./jira-jql.js, which is pure and edgeless.
    const importLines = code.split(LF).filter((line) => line.startsWith('import '))
    const staticImports = importLines.map((line) => line.match(/from '(.*)'/)[1])
    expect(staticImports.sort()).toEqual(['./jira-jql.js', 'node:path', 'node:url'])
    expect(importLines.some((line) => line.includes('execa'))).toBe(false)
    expect(code).not.toMatch(/child_process/)
    // The one reference to a spawner is a DYNAMIC import, and there is exactly one of them.
    expect([...code.matchAll(/await import\('execa'\)/g)]).toHaveLength(1)
  })

  it('the pure composer it depends on imports nothing at all', () => {
    // Anti-vacuity for the claim above: the only static edge out of this module leads to a
    // module with no edges, so the whole library half of the graph is two files.
    const jqlCode = codeWithoutComments(new URL('./jira-jql.js', import.meta.url))
    expect([...jqlCode.matchAll(/^import .* from '(.*)'$/gm)]).toEqual([])
  })
})

// --- the CLI footer, as a process ------------------------------------------------------
//
// `runCli` is module-private, so this is the only way to reach the verb, its exit codes and
// its lazily-imported spawner. Hermetic by construction: PATH holds ONE directory, a temp
// one, and the only `acli` in it is a shell script this test wrote. The real Atlassian CLI
// cannot be reached even if the implementation regressed, and the fake one records the argv
// it was handed, so the end-to-end spawn is asserted rather than trusted.
describe('jira-queue.js CLI — the surface the bash loop shells out to (#126 QA)', () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), 'jira-queue.js')
  // A POSIX shim; Windows has no /bin/sh to give it a shebang.
  const runnable = process.platform !== 'win32'

  // Returns { status, stdout, stderr, argv } where argv is what the fake acli was handed, or
  // null when it was never started at all.
  function cli(args, { stdout: acliStdout = '999', exit = '0' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-jira-cli-'))
    const log = join(dir, 'argv.log')
    const shim = join(dir, 'acli')
    writeFileSync(
      shim,
      [
        '#!/bin/sh',
        'printf "%s' + String.fromCharCode(0x5c) + 'n" "$@" > "$ACLI_ARGV_LOG"',
        'printf "%s" "$ACLI_STDOUT"',
        'exit "$ACLI_EXIT"',
      ].join(LF) + LF,
    )
    chmodSync(shim, 0o755)
    try {
      const res = spawnSync(process.execPath, [CLI, ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 20000,
        // PATH is the whole point: one temp directory, holding one fake acli.
        env: { PATH: dir, ACLI_ARGV_LOG: log, ACLI_STDOUT: acliStdout, ACLI_EXIT: exit },
      })
      const argv = existsSync(log)
        ? readFileSync(log, 'utf8').split(LF).slice(0, -1)
        : null
      return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', argv }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it.skipIf(!runnable)('prints the count acli reported, and hands it the composed argv', () => {
    const r = cli(['count', JQL], { stdout: '999' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('999' + LF)
    // The whole interface, end to end through a real execa: the subcommand, the flags, and
    // the COMPOSED query (Ralph's exclusion and ordering included) as one argument.
    expect(r.argv).toEqual(ACLI_ARGV)
    expect(r.stderr).toBe('')
  })

  it.skipIf(!runnable)('prints 0 and starts NO process for a query the composer refuses', () => {
    // The acceptance criterion, at the CLI: an unconfigured query counts nothing and runs
    // nothing. `argv === null` is the fake acli never having been executed.
    const r = cli(['count', 'ORDER BY created ASC'], { stdout: '999' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('0' + LF)
    expect(r.argv).toBe(null)
  })

  it.skipIf(!runnable)('prints 0 for an acli that exits non-zero while printing a number', () => {
    const r = cli(['count', JQL], { stdout: '999', exit: '1' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('0' + LF)
    // It DID run — this is the exit-code-before-text rule at process level, not a refusal.
    expect(r.argv).toEqual(ACLI_ARGV)
  })

  it.skipIf(!runnable)('prints 0 for output no count can be read out of', () => {
    expect(cli(['count', JQL], { stdout: 'Total: 7 work items' }).stdout).toBe('0' + LF)
  })

  it.skipIf(!runnable)('exits 2 with a usage line when the jql is missing', () => {
    // The exit code matters to the loop: 2 is "you called me wrong", the same code
    // folder-queue.js uses, and it must not be confused with a count of 2 on stdout.
    for (const args of [[], ['count'], ['count', '']]) {
      const r = cli(args)
      expect(r.status, JSON.stringify(args)).toBe(2)
      expect(r.stdout, JSON.stringify(args)).toBe('')
      expect(r.stderr).toContain('usage: jira-queue.js count')
      expect(r.argv).toBe(null)
    }
  })

  it.skipIf(!runnable)('exits 2 and names the verb it does not know', () => {
    const r = cli(['depth', JQL])
    expect(r.status).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain(`jira-queue.js: unknown command 'depth'`)
    expect(r.argv).toBe(null)
  })

  it.skipIf(!runnable)('writes the count to stdout and nothing else — the loop captures it', () => {
    // `$(node jira-queue.js count "$JIRA_JQL")` must yield a number and no prose, so a
    // stray progress line on stdout would become part of the count.
    const r = cli(['count', JQL], { stdout: '4' })
    expect(r.stdout).toBe('4' + LF)
    expect(r.stdout.trim()).toMatch(/^[0-9]+$/)
    expect(r.stderr).toBe('')
  })
})
