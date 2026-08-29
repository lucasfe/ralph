import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { claimTask, commentTask, completeTask, queueCount, queuePick } from './jira-queue.js'
import { composeJiraJql, JIRA_DONE_LABEL, JIRA_IN_PROGRESS_LABEL } from './jira-jql.js'

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
    // ./jira-key.js joined the list in #127 (the claim needs the key grammar) and ./jira-acli.js
    // in #129 (the acli layer moved out of this file when completion made it seven invocations).
    // All three are pure and edgeless — the test below measures that of each, which is what
    // keeps this pin a statement about the graph rather than about a file count.
    expect(staticImports.sort()).toEqual([
      './jira-acli.js',
      './jira-jql.js',
      './jira-key.js',
      'node:path',
      'node:url',
    ])
    expect(importLines.some((line) => line.includes('execa'))).toBe(false)
    expect(code).not.toMatch(/child_process/)
    // The one reference to a spawner is a DYNAMIC import, and there is exactly one of them.
    expect([...code.matchAll(/await import\('execa'\)/g)]).toHaveLength(1)
  })

  it('the pure modules it depends on import nothing at all', () => {
    // Anti-vacuity for the claim above: every static edge out of this module leads to a
    // module with no edges, so the whole library half of the graph is four files.
    for (const pure of ['./jira-acli.js', './jira-jql.js', './jira-key.js']) {
      const pureCode = codeWithoutComments(new URL(pure, import.meta.url))
      expect([...pureCode.matchAll(/^import .* from '(.*)'$/gm)], pure).toEqual([])
    }
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

// ---------------------------------------------------------------------------
// #127 QA — SELECTION AND THE CLAIM. The dev's jira-queue.test.js owns the contract of
// both (the argv, the union, the degradation table). This file adds the three angles that
// suite does not take, and the first is the only one in Ralph that can destroy somebody
// else's data:
//
//   THE WRITE ARGV IS THE EVIDENCE. `claimTask` is read-then-union precisely because
//   nothing in this repo knows whether `acli jira workitem edit --labels` appends or
//   REPLACES. Under replace semantics the string after `--labels` is the ticket's entire
//   new label set — so every case below is asserted on that exact string, not on the
//   returned `labels` array. A test that only read the return value would agree with a
//   union that computed the right answer and sent the wrong one.
//
//   AND THE CALL COUNT IS THE OTHER HALF OF IT. The module header promises "a claim that
//   could not read writes NOTHING AT ALL". That is a claim about processes, so it is
//   measured as one: `exec.mock.calls.length`, not the absence of a substring.
//
//   THE ENVELOPE SWEEP FOR `queuePick`. The module documents that it cannot verify what
//   acli prints, so it accepts a bare array, three wrapper keys and a lone object. The
//   sweep below walks every shape a JSON-printing client plausibly emits plus the ones a
//   broken pipe emits, and pins which of them yield a ticket — because being wrong here is
//   a queue that reads as permanently EMPTY, and an empty queue is silent.
//
// Every `exec` is injected and records its argv. NOTHING HERE SPAWNS acli; the CLI half at
// the foot of this file spawns node against a fake acli on a one-directory PATH.
// ---------------------------------------------------------------------------

const KEY = 'FOO-123'
const IP = JIRA_IN_PROGRESS_LABEL
const NUL = String.fromCharCode(0x00)
const ESC_BYTE = String.fromCharCode(0x1b)
const BACKSLASH = String.fromCharCode(0x5c)
const QUOTE = String.fromCharCode(0x22)

// Which acli subcommand an invocation names, so an assertion can talk about "the write"
// rather than about a call index — `claimTask` runs two processes and their RELATIONSHIP
// (read first, write only if the read succeeded) is the property under test.
const subOf = (argv) => argv?.[2]
const writesOf = (exec) =>
  exec.mock.calls.map(([, argv]) => argv).filter((argv) => subOf(argv) === 'edit')
// The value acli would receive as the ticket's new label set. One place, because every
// destructive assertion below is about this exact string.
const sentLabels = (argv) => argv[argv.indexOf('--labels') + 1]

// A spawner that answers the claim's read with `viewStdout` and its write cleanly, and
// records every argv. `exitCode: 0` on the read is the interesting case throughout: this
// suite is about acli SUCCEEDING and printing something Ralph half-understands.
const claimer = (viewStdout, edit = { exitCode: 0, stdout: '', stderr: '' }) =>
  vi.fn(async (_bin, argv) =>
    subOf(argv) === 'view' ? { exitCode: 0, stdout: viewStdout, stderr: '' } : edit,
  )

const labelDoc = (labelsJson) => `{"key":"${KEY}","fields":{"labels":${labelsJson}}}`

describe('claimTask — the write argv, byte for byte, on the destructive path (#127 QA)', () => {
  // MEASURED, not reasoned about: each row is `[what acli printed, what Ralph sent after
  // --labels]`, recorded by running the case. Read the right-hand column as "the ticket's
  // entire label set, if --labels replaces" — which is the semantics the read exists to
  // survive and which nothing in this repo can rule out.
  const measured = [
    // The happy union, and the AC's own example: a team's two labels both survive.
    [labelDoc('["frontend","p2"]'), `frontend,p2,${IP}`],
    [labelDoc('[]'), IP],
    // A NON-STRING ENTRY IS DROPPED and the real ones are kept — the module says so, and
    // this is the row that proves the drop is per-entry rather than per-list.
    [labelDoc('["frontend",null,42,{},[],"p2"]'), `frontend,p2,${IP}`],
    // Duplicates collapse. Harmless under either semantics (Jira holds no duplicate label),
    // and worth pinning because under REPLACE this is Ralph rewriting the set.
    [labelDoc('["a","a","a"]'), `a,${IP}`],
    // Order is PRESERVED and `in-progress` is appended last, so the write is diffable
    // against the read by eye when somebody has to audit one in the field.
    [labelDoc('["z","m","a"]'), `z,m,a,${IP}`],
    // Whitespace-only entries go the way of non-strings. Jira's own label field rejects
    // whitespace, so this cannot be a real label being deleted.
    [labelDoc('["   ","real"]'), `real,${IP}`],
    // A label is TRIMMED before it is sent, so a stray space cannot make `frontend` and
    // `frontend ` read as two labels.
    [labelDoc('["  frontend  ","p2"]'), `frontend,p2,${IP}`],
    // THE COMMA CAVEAT, PINNED. The dev flagged it as unfixed: `--labels` takes ONE
    // comma-joined value, so a label that itself contains a comma arrives at Jira as TWO
    // labels. Kept rather than dropped, because dropping a label Ralph merely found
    // suspicious is the deletion the union exists to avoid. This row is what makes a
    // future fix visible instead of silent.
    [labelDoc(`["a,b"]`), `a,b,${IP}`],
    // The rest of the bytes a label can carry. None of them is escaped, quoted or
    // rejected, and none of them needs to be: this value is ONE argv element handed to a
    // spawner with no shell (asserted separately below), so a quote, a backslash or a
    // newline is just text on its way to acli's own parser.
    [labelDoc(`["two words"]`), `two words,${IP}`],
    [labelDoc(`["say ${BACKSLASH}${QUOTE}hi${BACKSLASH}${QUOTE}"]`), `say ${QUOTE}hi${QUOTE},${IP}`],
    [labelDoc(`["a${BACKSLASH}${BACKSLASH}b"]`), `a${BACKSLASH}b,${IP}`],
    [labelDoc(`["a${BACKSLASH}nb"]`), `a${String.fromCharCode(0x0a)}b,${IP}`],
    [labelDoc(`["a${BACKSLASH}u001bb"]`), `a${ESC_BYTE}b,${IP}`],
    // A LABEL THAT LOOKS LIKE A FLAG. `-rf` is kept verbatim, and the value acli receives
    // therefore STARTS with a hyphen. Ralph adds no `--` separator, so whether acli's own
    // parser reads `-rf,in-progress` as this flag's value or as the next flag is acli's
    // question and is not answerable here — which is exactly why the argv is pinned: if a
    // claim ever fails in the field with a usage error, this row is the reproduction.
    [labelDoc(`["-rf"]`), `-rf,${IP}`],
    // `in-progress` IN A DIFFERENT CASE IS A DIFFERENT LABEL, so the union adds ours beside
    // theirs and the ticket ends up carrying both. Surprising to read and CORRECT for the
    // drain guarantee: the composed query excludes the lowercase spelling
    // (JIRA_LABEL_EXCLUSION), so stopping at `In-Progress` would leave the ticket eligible
    // and hand it out forever. Pinned rather than judged.
    [labelDoc('["In-Progress"]'), `In-Progress,${IP}`],
    [labelDoc('["IN-PROGRESS"]'), `IN-PROGRESS,${IP}`],
  ]

  for (const [stdout, expected] of measured) {
    it(`sends --labels ${JSON.stringify(expected)} for ${stdout.slice(0, 72)}`, async () => {
      const exec = claimer(stdout)
      const result = await claimTask(KEY, { exec })
      expect(result.ok).toBe(true)
      const writes = writesOf(exec)
      expect(writes).toHaveLength(1)
      expect(sentLabels(writes[0])).toBe(expected)
      // The returned array and the sent string are ONE fact, not two. A union that
      // reported `frontend,p2,in-progress` while sending something else would satisfy the
      // dev's return-value assertions and still wipe the board.
      expect(result.labels.join(',')).toBe(expected)
    })
  }

  it('sends the label set as ONE argv element, with no shell anywhere in the options', async () => {
    // The value can contain spaces, quotes, backslashes and newlines (rows above), so a
    // `shell: true` in those options would hand every one of them to /bin/sh. Asserted as
    // the WHOLE call, the same way the #126 count is: `objectContaining` would not notice.
    const exec = claimer(labelDoc(`["two words","say ${BACKSLASH}${QUOTE}hi${BACKSLASH}${QUOTE}"]`))
    await claimTask(KEY, { exec })
    for (const [bin, argv, options] of exec.mock.calls) {
      expect(bin).toBe('acli')
      expect(options).toEqual({ reject: false })
      expect(argv.every((element) => typeof element === 'string')).toBe(true)
    }
    const written = writesOf(exec)[0]
    expect(written).toHaveLength(8)
    expect(sentLabels(written)).toBe(`two words,say ${QUOTE}hi${QUOTE},${IP}`)
  })

  it('carries --yes on EVERY write it makes, swept over every scenario in this file', async () => {
    // Iterated over ALL recorded writes across ALL of these inputs rather than asserted of
    // one, which is the difference between "the write we happened to look at is unattended"
    // and "this module cannot make an attended write". A claim that stopped for a
    // confirmation would hang the iteration inside a detached tmux pane until its caller
    // killed it.
    const everyWrite = []
    for (const stdout of measured.map(([doc]) => doc)) {
      const exec = claimer(stdout)
      await claimTask(KEY, { exec })
      everyWrite.push(...writesOf(exec))
    }
    // Every row of the table above writes exactly once, so the sweep is exhaustive rather
    // than "whatever writes happened to occur" — an implementation that silently stopped
    // writing would make this assertion fail instead of passing vacuously.
    expect(everyWrite).toHaveLength(measured.length)
    for (const argv of everyWrite) {
      expect(argv.at(-1), argv.join(' ')).toBe('--yes')
      expect(argv.filter((element) => element === '--yes'), argv.join(' ')).toHaveLength(1)
    }
  })

  it('does not blow up on a very large label list — one argv element, however long', async () => {
    // 5000 labels is not a real ticket; the point is that the module imposes no bound and
    // therefore has no bound to get wrong. What it produces is one long string in one argv
    // element, which is the same shape as one label, so the failure (if any) belongs to the
    // operating system's argv limit and is acli's to report.
    const many = Array.from({ length: 5000 }, (_, i) => `label-${i}`)
    const exec = claimer(labelDoc(JSON.stringify(many)))
    const result = await claimTask(KEY, { exec })
    expect(result.ok).toBe(true)
    const written = writesOf(exec)[0]
    expect(written).toHaveLength(8)
    expect(sentLabels(written).split(',')).toHaveLength(5001)
    expect(sentLabels(written).endsWith(`,${IP}`)).toBe(true)
  })

  it('is idempotent by SET membership, not by position — an existing label is never doubled', async () => {
    for (const stdout of [
      labelDoc(`["${IP}"]`),
      labelDoc(`["a","${IP}","b"]`),
      labelDoc(`["${IP}","${IP}"]`),
      labelDoc(`["  ${IP}  "]`),
    ]) {
      const exec = claimer(stdout)
      const result = await claimTask(KEY, { exec })
      expect(result.ok, stdout).toBe(true)
      // ONE process, the read. The cheapest idempotence is the one that does not touch a
      // board it has nothing to change on, and this counts it rather than inferring it.
      expect(exec.mock.calls, stdout).toHaveLength(1)
      expect(result.labels.filter((l) => l === IP), stdout).toHaveLength(1)
    }
  })
})

describe('claimTask — an unreadable read must write NOTHING, counted (#127 QA)', () => {
  // The module's own safety property, restated as the only thing that can be measured about
  // it: the number of processes started. Each row is a way acli can EXIT CLEANLY and still
  // not tell Ralph what the labels are — the dangerous half, because a non-zero exit is
  // already obviously a failure.
  const unreadable = {
    'labels as a string instead of a list': labelDoc(`"frontend"`),
    'labels as a number': labelDoc('7'),
    'labels as an object keyed by index': labelDoc('{"0":"frontend"}'),
    'labels explicitly null': labelDoc('null'),
    'a document with no labels field at all': `{"key":"${KEY}","fields":{}}`,
    'an empty document': '{}',
    'an empty array': '[]',
    'prose where JSON was expected': 'ERROR: work item not found',
    'a truncated document': '{"fields":{"labels":["a"',
    'valid JSON that is a scalar': '7',
    'valid JSON that is a string': `"${KEY}"`,
    'valid JSON that is null': 'null',
    'nothing at all': '',
    'whitespace only': '   ',
    // MEASURED: five wrappers around the label list is one more than `findLabelArray` will
    // walk, so the list is never found and the claim is abandoned. Pinned as the limit of the
    // search rather than as a shape acli produces — the read asked for ONE field, so an
    // envelope this deep is a client nobody has met, and refusing is the safe direction.
    'labels buried one wrapper past the depth bound': '{"a":{"b":{"c":{"d":{"e":{"labels":["x"]}}}}}}',
  }

  for (const [what, stdout] of Object.entries(unreadable)) {
    it(`refuses and starts exactly ONE process for ${what}`, async () => {
      const exec = claimer(stdout)
      const result = await claimTask(KEY, { exec })
      expect(result.ok, what).toBe(false)
      expect(result.labels, what).toBe(null)
      expect(typeof result.reason, what).toBe('string')
      // ONE call — the read. Counted, because "no write argv contains --labels" would also
      // be satisfied by a write that went out malformed.
      expect(exec.mock.calls, `${what}: ${JSON.stringify(exec.mock.calls.map(([, a]) => a))}`).toHaveLength(1)
      expect(subOf(exec.mock.calls[0][1])).toBe('view')
    })
  }

  it('reads the labels at FOUR wrappers — so the refusal above is a bound, not a typo', async () => {
    // Anti-vacuity for the last row: the same document one wrapper shallower IS read, which
    // is what makes the row above a measurement of the depth guard rather than of a
    // malformed fixture. Measured both sides: four wrappers claim, five abandon.
    const exec = claimer('{"a":{"b":{"c":{"d":{"labels":["x"]}}}}}')
    expect((await claimTask(KEY, { exec })).labels).toEqual(['x', IP])
  })

  const brokenProcess = {
    'a result with no stdout property at all': { exitCode: 0 },
    'stdout explicitly null': { exitCode: 0, stdout: null },
    'stdout as a throwing getter': {
      exitCode: 0,
      get stdout() {
        throw new Error('stream already destroyed')
      },
    },
    'stdout whose toString throws': {
      exitCode: 0,
      stdout: {
        toString() {
          throw new Error('stdout is gone')
        },
      },
    },
    'no exitCode at all (execa ENOENT)': { failed: true, stdout: labelDoc('["a"]') },
    'a null exitCode': { exitCode: null, stdout: labelDoc('["a"]') },
    'a signalled kill': { signal: 'SIGKILL', stdout: labelDoc('["a"]') },
    'exitCode 0 with prose on stdout': { exitCode: 0, stdout: 'Searching for work items...' },
    'a non-zero exit with a PERFECT label document': { exitCode: 1, stdout: labelDoc('["a"]') },
    'nothing returned at all': undefined,
  }

  for (const [what, view] of Object.entries(brokenProcess)) {
    it(`refuses and writes nothing when the read comes back as ${what}`, async () => {
      const exec = vi.fn(async (_bin, argv) =>
        subOf(argv) === 'view' ? view : { exitCode: 0, stdout: '' },
      )
      const result = await claimTask(KEY, { exec })
      expect(result.ok, what).toBe(false)
      expect(exec.mock.calls, what).toHaveLength(1)
    })
  }

  it('reads a Buffer stdout — the tolerance is real, and it is the ONLY non-string one', async () => {
    // Paired with the two throwing-stdout rows above: `stdout?.toString?.()` exists for
    // Buffers, and this is what it buys. Named so the refusals above read as a bound on the
    // tolerance rather than as an absence of one.
    const exec = vi.fn(async (_bin, argv) =>
      subOf(argv) === 'view'
        ? { exitCode: 0, stdout: Buffer.from(labelDoc('["frontend"]')) }
        : { exitCode: 0, stdout: '' },
    )
    expect((await claimTask(KEY, { exec })).labels).toEqual(['frontend', IP])
  })

  it('never throws, and writes nothing, for a spawner that cannot be called', async () => {
    for (const exec of [undefined, null, 0, 'acli', {}, [], Symbol('exec'), 7n]) {
      const result = await claimTask(KEY, { exec })
      expect(result.ok, String(typeof exec)).toBe(false)
      expect(result.labels, String(typeof exec)).toBe(null)
      expect(result.reason, String(typeof exec)).toContain('acli could not be run')
    }
  })

  it('never throws for a spawner that rejects, or that throws synchronously', async () => {
    const rejecting = vi.fn(async () => {
      throw new Error('spawn acli ENOENT')
    })
    expect((await claimTask(KEY, { exec: rejecting })).ok).toBe(false)
    expect(rejecting).toHaveBeenCalledTimes(1)

    const throwing = vi.fn(() => {
      throw new Error('EACCES')
    })
    expect((await claimTask(KEY, { exec: throwing })).ok).toBe(false)
  })

  it('reports a failed WRITE without retrying it — one edit, ever', async () => {
    // A retry on a write to somebody's board is the wrong instinct: the loop's own warning
    // and the zero-progress guard already handle "the claim did not stick", and a retry
    // doubles a network round trip inside every iteration.
    const exec = claimer(labelDoc('["a"]'), { exitCode: 1, stdout: '', stderr: 'permission denied' })
    const result = await claimTask(KEY, { exec })
    expect(result.ok).toBe(false)
    expect(result.labels).toBe(null)
    expect(writesOf(exec)).toHaveLength(1)
    expect(exec.mock.calls).toHaveLength(2)
  })

  it('spawns NOTHING for every key shape the grammar cannot use — counted, not inferred', async () => {
    // A write whose subject is empty is a request acli resolves however it likes, and this
    // is a write. Every non-usable shape, and the assertion is on the call count.
    for (const key of [
      undefined,
      null,
      '',
      '   ',
      String.fromCharCode(0x09),
      123,
      0,
      NaN,
      {},
      [],
      ['FOO-1'],
      true,
      false,
      Symbol('FOO-1'),
      7n,
      () => 'FOO-1',
      new String('FOO-1'),
      { toString: () => 'FOO-1' },
    ]) {
      const exec = vi.fn(async () => ({ exitCode: 0, stdout: labelDoc('[]') }))
      const result = await claimTask(key, { exec })
      expect(result.ok, String(typeof key)).toBe(false)
      expect(result.reason, String(typeof key)).toBe('no Jira work item key to claim')
      expect(exec, String(typeof key)).not.toHaveBeenCalled()
    }
  })

  it('sends a key acli named even when the grammar refuses it — and sends it verbatim', async () => {
    // `usableJiraKey` VALIDATES and does not GATE (lib/jira-key.js), so these reach an argv.
    // Pinned as the reach of that posture: a NUL makes Node's own spawn throw, which lands
    // as a refused claim rather than as an exception, and a newline is just a byte in one
    // argv element.
    for (const [key, sent] of [
      ['FOO-BAR-1', 'FOO-BAR-1'],
      ['  foo-123  ', 'FOO-123'],
      ['FOO 123', 'FOO 123'],
      [`FOO${String.fromCharCode(0x0a)}BAR-2`, `FOO${String.fromCharCode(0x0a)}BAR-2`],
      [`FOO-1${NUL}`, `FOO-1${NUL}`],
      [`--key`, `--key`],
      [`-1`, `-1`],
    ]) {
      const exec = claimer(labelDoc('[]'))
      await claimTask(key, { exec })
      const read = exec.mock.calls[0][1]
      expect(read[read.indexOf('--key') + 1], key).toBe(sent)
      // ...and the WRITE names the same ticket the read did. A claim that read one ticket
      // and wrote another would be the worst failure this module could have.
      expect(writesOf(exec)[0][writesOf(exec)[0].indexOf('--key') + 1], key).toBe(sent)
    }
  })
})

describe('claimTask — a non-empty label list Ralph cannot SEND (#127 QA)', () => {
  // THE FINDING THIS SUITE WAS WRITTEN FOR, AND THE FIX IT NOW GUARDS. When these tests were
  // first written the implementation FAILED them, and the failure was the worst one available
  // to this module:
  //
  // `{"fields":{"labels":[{"name":"frontend"},{"name":"p2"}]}}` — an envelope that spells
  // labels as objects rather than as strings — is READ SUCCESSFULLY: `findLabelArray` finds an
  // array, so the "labels are unknown" refusal does not fire. `writableLabels` then dropped
  // every entry (there is no text to send), and the write that went out was
  //
  //   ['jira','workitem','edit','--key','FOO-123','--labels','in-progress','--yes']
  //
  // which under REPLACE semantics is the ticket's entire new label set. That is the exact wipe
  // the read exists to prevent, arriving THROUGH the read: `frontend` and `p2` were read out of
  // acli's own answer and then sent to Jira as nothing.
  //
  // `readWritableLabels` now refuses it — "a list that was found and emptied is an unreadable
  // list, not an empty one" — so both rows below write NOTHING, and the distinction between
  // `labels: []` (common, correct, claims) and a list nothing could be sent out of (a read that
  // failed, claims nothing) is the property these tests hold. #129 moved that check into a
  // helper shared with `completeTask`, which is why the #129 QA section further down drives the
  // same documents through BOTH verbs: an extraction is where a safety property loses a caller.
  //
  // MEASURED, both rows: ONE exec call, no `edit` argv at all.
  const dropped = {
    'labels spelled as objects, the way a REST payload spells them': '[{"name":"frontend"},{"name":"p2"}]',
    'labels as a list of lists': '[["frontend"]]',
  }

  for (const [what, labels] of Object.entries(dropped)) {
    it(`refuses when EVERY entry was dropped — ${what}`, async () => {
      const exec = claimer(labelDoc(labels))
      const result = await claimTask(KEY, { exec })
      // What a safe claim looks like: nothing written, and a sentence naming the ticket.
      expect(exec.mock.calls, JSON.stringify(exec.mock.calls.map(([, a]) => a))).toHaveLength(1)
      expect(result.ok, what).toBe(false)
      expect(result.labels, what).toBe(null)
    })
  }

  it('tells an EMPTY list apart from a list it emptied — the two must not send the same argv', async () => {
    // The distinction stated on its own, so the finding survives being read out of context:
    // `labels: []` is a common, correct answer and must claim; a list of entries none of which
    // could be sent is a read that failed and must not. Asserted on the SENT argv rather than on
    // the return value, because it is the argv that would have wiped the ticket.
    const emptied = claimer(labelDoc('[{"name":"frontend"}]'))
    await claimTask(KEY, { exec: emptied })
    const genuinelyEmpty = claimer(labelDoc('[]'))
    await claimTask(KEY, { exec: genuinelyEmpty })
    expect(writesOf(genuinelyEmpty).map(sentLabels)).toEqual([IP])
    expect(writesOf(emptied).map(sentLabels)).not.toEqual([IP])
  })
})

describe('queuePick — every envelope, and which of them yields a ticket (#127 QA)', () => {
  const picked = (stdout) => queuePick(JQL, { exec: vi.fn(async () => ({ exitCode: 0, stdout })) })

  // MEASURED: `[stdout, expected]` where expected is `{key, summary}` or null. Being wrong
  // in the null direction is a queue that reads as permanently empty, which is silent — so
  // the shapes that DO yield a ticket are as load-bearing as the ones that do not.
  const yields = [
    ['[{"key":"FOO-1","fields":{"summary":"s"}}]', { key: 'FOO-1', summary: 's' }],
    ['[{"key":"FOO-1","summary":"s"}]', { key: 'FOO-1', summary: 's' }],
    ['{"issues":[{"key":"FOO-1"}]}', { key: 'FOO-1', summary: '' }],
    ['{"workItems":[{"key":"FOO-1"}]}', { key: 'FOO-1', summary: '' }],
    ['{"results":[{"key":"FOO-1"}]}', { key: 'FOO-1', summary: '' }],
    ['{"key":"FOO-1","summary":"s"}', { key: 'FOO-1', summary: 's' }],
    // The wrapper keys are tried IN ORDER and `issues` wins, which is worth pinning because
    // a document carrying two of them is a client nobody has met and the answer must at
    // least be deterministic.
    ['{"results":[{"key":"BAR-9"}],"issues":[{"key":"FOO-1"}]}', { key: 'FOO-1', summary: '' }],
    // A NESTED summary that is not a string falls through to the FLAT one — `??` only
    // catches null and undefined, so this row is about which of the two the module reads.
    [
      '[{"key":"FOO-1","fields":{"summary":null},"summary":"flat"}]',
      { key: 'FOO-1', summary: 'flat' },
    ],
    // A summary that is not text at all is '', never the word "undefined": this value is
    // printed into a `<key>\t<summary>` line the loop reads, where a template hole would
    // read as a real ticket title.
    ['[{"key":"FOO-1","summary":42}]', { key: 'FOO-1', summary: '' }],
    ['[{"key":"FOO-1","summary":null}]', { key: 'FOO-1', summary: '' }],
    ['[{"key":"FOO-1","summary":{"text":"s"}}]', { key: 'FOO-1', summary: '' }],
    // THE FALL-THROUGH, PINNED AND SURPRISING: no wrapper key holds an ARRAY here, so
    // `firstWorkItem` hands back the WRAPPER, and the wrapper's own `key` is read as the
    // ticket. A paging envelope that reported `issues: null` beside a `key` field of its own
    // would therefore be selected. Recorded as the price of the tolerant reader rather than
    // as a defect: the alternative is a queue that reads empty for a real client.
    ['{"issues":null,"key":"FOO-9"}', { key: 'FOO-9', summary: '' }],
    // The grammar VALIDATES and does not GATE, so an unrecognised project key is still the
    // ticket acli said was next.
    ['[{"key":"FOO-BAR-1"}]', { key: 'FOO-BAR-1', summary: '' }],
    ['[{"key":"  foo-123  "}]', { key: 'FOO-123', summary: '' }],
  ]

  for (const [stdout, expected] of yields) {
    it(`reads ${stdout.slice(0, 64)} as ${JSON.stringify(expected)}`, async () => {
      expect(await picked(stdout)).toEqual(expected)
    })
  }

  const empties = {
    'an empty array': '[]',
    'an empty issues page': '{"issues":[]}',
    'issues explicitly null, with nothing else to read': '{"issues":null}',
    'an array of strings': '["FOO-1"]',
    'an array of numbers': '[1,2,3]',
    'an array of nulls': '[null,null]',
    'an array of arrays': '[["FOO-1"]]',
    'an item with a summary and no key': '[{"summary":"s"}]',
    'an item whose key is a number': '[{"key":123}]',
    'an item whose key is an object': '[{"key":{"id":"FOO-1"}}]',
    'an item whose key is blank': '[{"key":"   "}]',
    'an item whose key is an empty string': '[{"key":""}]',
    'valid JSON that is a bare number': '5',
    'valid JSON that is a bare string': '"FOO-1"',
    'valid JSON that is a boolean': 'true',
    'valid JSON that is null': 'null',
    'a count document from the wrong subcommand': '{"count":3}',
    'truncated JSON': '{"issues":[',
    'prose': 'Error: you are not logged in',
    'empty stdout': '',
    'whitespace-only stdout': `   ${String.fromCharCode(0x09)}${String.fromCharCode(0x0a)} `,
  }

  for (const [what, stdout] of Object.entries(empties)) {
    it(`answers null for ${what} — an empty queue and a misread one are one instruction`, async () => {
      expect(await picked(stdout), what).toBe(null)
    })
  }

  it('reads a 1 MB summary without bounding it — the bound belongs downstream', async () => {
    // Pinned rather than judged. That string is printed into the loop's `pick` capture and
    // handed to lib/run-state.js is NOT — only the key is recorded — but it does cross a
    // pipe, and lib/progress.js caps what it DRAWS (its own RAW_TITLE_LIMIT). So the
    // absence of a bound here is a fact about the pipe, not about the terminal.
    const summary = 'x'.repeat(1_000_000)
    const result = await picked(JSON.stringify([{ key: 'FOO-1', fields: { summary } }]))
    expect(result.key).toBe('FOO-1')
    expect(result.summary).toHaveLength(1_000_000)
  })

  it('passes an unrecognised key through with its control bytes intact', async () => {
    // The consequence chain, stated where it is measurable: a tab in the KEY survives this
    // function, and templates/ralph.sh cuts its `pick` capture at the FIRST tab — so bash
    // reads `FOO` and the real ticket is never claimed. Proven end to end (and shown to
    // TERMINATE rather than spin) in test/loop.jira.adversarial.test.js.
    const TAB_CH = String.fromCharCode(0x09)
    expect(await picked(JSON.stringify([{ key: `FOO${TAB_CH}-1`, summary: 's' }]))).toEqual({
      key: `FOO${TAB_CH}-1`,
      summary: 's',
    })
    expect(await picked(JSON.stringify([{ key: `FOO-1${ESC_BYTE}[31m` }]))).toEqual({
      key: `FOO-1${ESC_BYTE}[31m`,
      summary: '',
    })
  })

  it('moves no prototype for a document carrying __proto__', async () => {
    // `JSON.parse` makes `__proto__` an OWN data property rather than invoking the setter,
    // so the payload is inert — but "inert" is a measurement, not a reading of the spec, and
    // this module's reader walks whatever came off a pipe.
    const before = Object.getOwnPropertyNames(Object.prototype).length
    expect(await picked('{"__proto__":{"key":"EVIL-1"}}')).toBe(null)
    expect(await picked('{"__proto__":{"polluted":true}}')).toBe(null)
    expect(await picked('{"issues":[{"__proto__":{"key":"EVIL-1"}}]}')).toBe(null)
    expect(await picked('[{"key":"FOO-1","constructor":{"prototype":{"polluted":true}}}]')).toEqual({
      key: 'FOO-1',
      summary: '',
    })
    expect({}.polluted).toBeUndefined()
    expect({}.key).toBeUndefined()
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before)
  })

  it('does not retry, and asks for exactly one item', async () => {
    for (const stdout of ['[]', '{"issues":[{"key":"FOO-1"}]}', 'prose']) {
      const exec = vi.fn(async () => ({ exitCode: 0, stdout }))
      await queuePick(JQL, { exec })
      expect(exec, stdout).toHaveBeenCalledTimes(1)
      const argv = exec.mock.calls[0][1]
      expect(argv[argv.indexOf('--limit') + 1], stdout).toBe('1')
      expect(exec.mock.calls[0][2], stdout).toEqual({ reject: false })
    }
  })

  it('starts no process for a misconfigured query, whatever the exec would have said', async () => {
    // The exec THROWS here, so a spawn would fail loudly rather than being mistaken for an
    // empty queue. Same posture as the #126 count sweep above, and the stakes are higher:
    // a pick that ran Ralph's half of the query alone would go and CLAIM a stranger's
    // ticket.
    for (const jql of [
      undefined,
      null,
      '',
      '   ',
      String.fromCharCode(0x09),
      'ORDER BY created ASC',
      'order by created desc',
      42,
      new String(JQL),
      Symbol('project = R'),
      7n,
      ['project = R'],
      () => JQL,
    ]) {
      const exec = vi.fn(() => {
        throw new Error('acli must not be reached for a misconfigured query')
      })
      expect(await queuePick(jql, { exec }), String(typeof jql)).toBe(null)
      expect(exec, String(typeof jql)).not.toHaveBeenCalled()
    }
  })
})

// ---------------------------------------------------------------------------
// #127 QA — THE TWO NEW VERBS AS PROCESSES. `pick` and `claim` are what templates/ralph.sh
// actually runs, and `runCli` is module-private, so a process is the only way to reach the
// verb, its exit code and its lazily-imported spawner. Two things only this layer can show:
//
//   THE `<key>\t<summary>` LINE IS A WIRE FORMAT. Bash cuts the capture at the FIRST tab
//   (`task_key="${pick%%$'\t'*}"`), so the byte layout of that one line is the contract —
//   including what it looks like when the summary is empty, or carries a tab of its own.
//
//   A CLAIM IS TWO PROCESSES, and the fake acli below records each invocation separately.
//   That makes "a failed read writes nothing" measurable AT PROCESS LEVEL rather than
//   through an injected double: if the read fails, there is no second file to read.
//
// Hermetic by construction, like the #126 footer above: PATH holds ONE temp directory whose
// only executable is a shell script this test wrote. The real Atlassian CLI is unreachable
// even if the implementation regressed, and no board can be written to.
// ---------------------------------------------------------------------------

describe('jira-queue.js CLI — pick and claim as the loop runs them (#127 QA)', () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), 'jira-queue.js')
  const runnable = process.platform !== 'win32'
  const BS = String.fromCharCode(0x5c)
  const PICK_ARGV = (jql) => [
    'jira', 'workitem', 'search', '--jql', composeJiraJql(jql).jql,
    '--limit', '1', '--json', '--fields', 'key,summary',
  ]

  // Runs the real CLI against a fake acli that answers per SUBCOMMAND (`$3`) and logs each
  // invocation to a file named by its own PID, with an append-only `order` file recording the
  // sequence — so `calls` is the ordered list of argvs acli was handed, repeats included.
  // Only shell BUILTINS are used inside the shim: PATH holds one directory and no coreutils,
  // so a `cat` in there would fail silently and quietly under-count the invocations.
  // Returns { status, stdout, stderr, calls }.
  function jira(args, opts = {}) {
    const { search = '', view = '', edit = '', searchExit = '0', viewExit = '0', editExit = '0' } = opts
    const dir = mkdtempSync(join(tmpdir(), 'ralph-jira-127-'))
    const shim = join(dir, 'acli')
    writeFileSync(
      shim,
      [
        '#!/bin/sh',
        'printf "%s' + BS + 'n" "$@" > "$ACLI_DIR/argv.$$"',
        'printf "%s' + BS + 'n" "$$" >> "$ACLI_DIR/order"',
        'case "$3" in',
        '  view) out="$ACLI_VIEW"; code="$ACLI_VIEW_EXIT" ;;',
        '  edit) out="$ACLI_EDIT"; code="$ACLI_EDIT_EXIT" ;;',
        '  *) out="$ACLI_SEARCH"; code="$ACLI_SEARCH_EXIT" ;;',
        'esac',
        'printf "%s" "$out"',
        'exit "$code"',
      ].join(LF) + LF,
    )
    chmodSync(shim, 0o755)
    try {
      const res = spawnSync(process.execPath, [CLI, ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 20000,
        // One directory on PATH, and the only acli in it is the script above.
        env: {
          PATH: dir,
          ACLI_DIR: dir,
          ACLI_SEARCH: search,
          ACLI_VIEW: view,
          ACLI_EDIT: edit,
          ACLI_SEARCH_EXIT: searchExit,
          ACLI_VIEW_EXIT: viewExit,
          ACLI_EDIT_EXIT: editExit,
        },
      })
      const orderFile = join(dir, 'order')
      const pids = existsSync(orderFile)
        ? readFileSync(orderFile, 'utf8').split(LF).slice(0, -1)
        : []
      const calls = pids.map((pid) =>
        readFileSync(join(dir, `argv.${pid}`), 'utf8').split(LF).slice(0, -1),
      )
      return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', calls }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it.skipIf(!runnable)('prints exactly `<key>TAB<summary>` and one newline, nothing else', () => {
    const r = jira(['pick', JQL], { search: '[{"key":"FOO-1","fields":{"summary":"Wire the drain"}}]' })
    expect(r.status).toBe(0)
    // Byte for byte. A leading blank line or a trailing space would all survive a `toContain`
    // and would all end up inside `task_key` or the summary bash reads.
    expect(r.stdout).toBe('FOO-1' + TAB + 'Wire the drain' + LF)
    expect(r.stderr).toBe('')
    expect(r.calls).toEqual([PICK_ARGV(JQL)])
  })

  it.skipIf(!runnable)('prints NOTHING and exits 0 for an empty queue — after really asking', () => {
    // Exit 0 with an empty capture is how the loop learns to stop; a non-zero exit here would
    // read as a broken command. `calls` proves the query was actually run, so the silence is
    // an answer rather than a refusal.
    const r = jira(['pick', JQL], { search: '[]' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.calls).toHaveLength(1)
  })

  it.skipIf(!runnable)('prints a TRAILING TAB when the ticket has no summary', () => {
    // The empty-summary line is `FOO-1<TAB><LF>`, which bash's `${pick%%$'\t'*}` still cuts to
    // `FOO-1`. Pinned because the tab is what makes it cuttable: printing the key alone would
    // work today and break the moment a summary came back.
    const r = jira(['pick', JQL], { search: '[{"key":"FOO-1"}]' })
    expect(r.stdout).toBe('FOO-1' + TAB + LF)
    expect(r.stdout.split(TAB)[0]).toBe('FOO-1')
  })

  it.skipIf(!runnable)('survives a summary carrying a tab or a newline — the KEY is still first', () => {
    // Neither is escaped, so the line acli caused is not the shape bash expects. It degrades
    // safely in one direction only: everything before the FIRST tab is still the key, which is
    // the only field templates/ralph.sh reads. Measured here, proven end to end in
    // test/loop.jira.adversarial.test.js.
    const tabbed = jira(['pick', JQL], { search: `[{"key":"FOO-1","summary":"a${BS}tb"}]` })
    expect(tabbed.stdout).toBe('FOO-1' + TAB + 'a' + TAB + 'b' + LF)
    expect(tabbed.stdout.split(TAB)[0]).toBe('FOO-1')

    const lined = jira(['pick', JQL], { search: `[{"key":"FOO-1","summary":"a${BS}nb"}]` })
    expect(lined.stdout).toBe('FOO-1' + TAB + 'a' + LF + 'b' + LF)
    expect(lined.stdout.split(TAB)[0]).toBe('FOO-1')
  })

  it.skipIf(!runnable)('passes a KEY carrying a tab straight through — and loses it to the cut', () => {
    // The consequence chain, at the layer where it becomes visible: `usableJiraKey` validates
    // without gating, so a tab inside the key reaches this line, and bash's cut then yields
    // `FOO` — a key that is not the ticket. It cannot claim anything (acli is asked about
    // `FOO`), and the loop's zero-progress guard is what stops the run; test/
    // loop.jira.adversarial.test.js proves that termination.
    const r = jira(['pick', JQL], { search: `[{"key":"FOO${BS}t-1","summary":"s"}]` })
    expect(r.stdout).toBe('FOO' + TAB + '-1' + TAB + 's' + LF)
    expect(r.stdout.split(TAB)[0]).toBe('FOO')
  })

  it.skipIf(!runnable)('starts NO process, prints nothing and exits 0 for a refused query', () => {
    // The acceptance criterion at the riskiest verb: an unconfigured JIRA_JQL must not select
    // a stranger's ticket. `calls` empty is the fake acli never having been executed.
    for (const jql of ['ORDER BY created ASC', '   ']) {
      const r = jira(['pick', jql], { search: '[{"key":"FOO-1"}]' })
      expect(r.status, jql).toBe(0)
      expect(r.stdout, jql).toBe('')
      expect(r.calls, jql).toEqual([])
    }
  })

  it.skipIf(!runnable)('prints nothing and exits 0 when acli itself failed — a pick has one failure', () => {
    // Deliberately asymmetric with `count`, and the module says why: every reason a pick has
    // no ticket is the same instruction to the loop. So a broken acli reads as an empty queue
    // here, and `queueCount` (which the loop calls FIRST) is the surface that reports Jira
    // being unreachable.
    const r = jira(['pick', JQL], { search: '[{"key":"FOO-1"}]', searchExit: '1' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.calls).toHaveLength(1)
  })

  it.skipIf(!runnable)('exits 2 with a usage line for pick without a query', () => {
    for (const args of [['pick'], ['pick', ''], ['claim'], ['claim', '']]) {
      const r = jira(args)
      expect(r.status, JSON.stringify(args)).toBe(2)
      expect(r.stdout, JSON.stringify(args)).toBe('')
      expect(r.stderr, JSON.stringify(args)).toContain('usage: jira-queue.js')
      // NOTHING RAN. For `claim` that is the important half: exit 2 with a write already sent
      // would be the worst of both.
      expect(r.calls, JSON.stringify(args)).toEqual([])
    }
  })

  it.skipIf(!runnable)('claims by reading THEN writing the union — two processes, in that order', () => {
    const r = jira(['claim', 'FOO-123'], { view: '{"fields":{"labels":["frontend","p2"]}}' })
    expect(r.status).toBe(0)
    // Silent on success: the loop shows its own iteration line, and a claim that narrated
    // itself would print into every iteration's log for no reader.
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
    expect(r.calls).toEqual([
      ['jira', 'workitem', 'view', '--key', 'FOO-123', '--fields', 'labels', '--json'],
      ['jira', 'workitem', 'edit', '--key', 'FOO-123', '--labels', `frontend,p2,${IP}`, '--yes'],
    ])
  })

  it.skipIf(!runnable)('runs ONE process when the ticket is already claimed', () => {
    const r = jira(['claim', 'FOO-123'], { view: `{"fields":{"labels":["${IP}"]}}` })
    expect(r.status).toBe(0)
    expect(r.calls).toHaveLength(1)
  })

  it.skipIf(!runnable)('exits 1 and writes NO SECOND PROCESS when the read was unreadable', () => {
    // The module's central safety promise, measured as processes rather than as a return
    // value: one file in the log directory means acli was run once, so nothing was written.
    const r = jira(['claim', 'FOO-123'], { view: 'ERROR: work item not found' })
    expect(r.status).toBe(1)
    expect(r.calls).toHaveLength(1)
    expect(r.stderr).toContain('jira-queue.js:')
    expect(r.stderr).toContain('left alone')
    // Reason on STDERR, never stdout: the loop's other captures are stdout, so prose there
    // could be read as data by a future verb.
    expect(r.stdout).toBe('')
  })

  it.skipIf(!runnable)('exits 1 when the read process itself failed, with nothing written', () => {
    const r = jira(['claim', 'FOO-123'], { view: '{"fields":{"labels":[]}}', viewExit: '1' })
    expect(r.status).toBe(1)
    expect(r.calls).toHaveLength(1)
    expect(r.stderr).toContain('nothing was written')
  })

  it.skipIf(!runnable)('exits 1 when the WRITE failed, naming the label it could not set', () => {
    const r = jira(['claim', 'FOO-123'], { view: '{"fields":{"labels":["a"]}}', editExit: '1' })
    expect(r.status).toBe(1)
    expect(r.calls).toHaveLength(2)
    expect(r.stderr).toContain(`could not label FOO-123 ${IP}`)
  })

  it.skipIf(!runnable)('hands a hostile key to acli as ONE argument, with no shell in between', () => {
    // The injection proof at process level, and the reason it belongs here rather than in a
    // unit test: this path goes through the real `execa`. A `shell: true` anywhere in it would
    // make the semicolon a command separator and the `$(...)` a substitution; instead the
    // whole string arrives as argv[4], and the fake acli logs it as one line.
    const hostile = `FOO-1; touch pwned $(touch pwned2) ${String.fromCharCode(0x60)}touch pwned3${String.fromCharCode(0x60)}`
    const r = jira(['claim', hostile], { view: '{"fields":{"labels":[]}}' })
    expect(r.status).toBe(0)
    expect(r.calls[0][4]).toBe(hostile)
    expect(r.calls[1][4]).toBe(hostile)
    // ...and the write still carries --yes, on a key nobody validated.
    expect(r.calls[1].at(-1)).toBe('--yes')
  })

  it.skipIf(!runnable)('hands a hostile QUERY to acli as ONE argument too', () => {
    // Same property on the selection side. The composed query already contains parentheses
    // and commas; these add the characters a shell would act on.
    const jql = `project = R AND summary ~ "$(touch pwned)" AND labels != x;y`
    const r = jira(['pick', jql], { search: '[{"key":"FOO-1"}]' })
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([PICK_ARGV(jql)])
    expect(r.calls[0][4]).toContain('$(touch pwned)')
  })
})

// ---------------------------------------------------------------------------
// #129 QA — COMPLETION. The dev's jira-queue.test.js owns the contract: the three writes in
// order, the union string, `--yes` on all three, the refused-transition table, the five
// unreadable-read shapes. This section adds the angles that suite does not take, and they are
// all about the fact that COMPLETION IS THE FIRST VERB IN RALPH THAT RUNS FOUR PROCESSES AND
// FORGIVES THREE OF THEM:
//
//   `ok:false` MEANS EXACTLY ONE THING, so the interesting cases are the ones where something
//   DID fail and the answer is still `ok:true`. Swept as a matrix over the four invocations
//   rather than one row at a time, because the property is about combinations: a transition
//   refused AND a removal refused AND a label written is a successful completion, and no
//   single-failure test can say so.
//
//   THE WARNINGS ARE THE USER INTERFACE OF EVERYTHING IT FORGIVES, so their COUNT is asserted
//   as well as their text — a completion that warned twice about one unset knob would train a
//   reader to skim the one line that matters — and they are driven through a `stderr` that is
//   missing, closed, or lying about having a `write`.
//
//   THE SAFETY PROPERTY NOW HAS TWO CALLERS. #127's empty-vs-emptied rule lives in
//   `readWritableLabels`, which #129 extracted so `claimTask` and `completeTask` share it. An
//   extraction is exactly the moment a property silently applies to one caller and not the
//   other, so the sweep below drives BOTH verbs through the same documents and asserts the
//   same process counts for each.
//
//   AND THE CLI VERBS HAD NO PROCESS-LEVEL TEST AT ALL. `complete` and `comment` are run by an
//   LLM following templates/prompt-team-jira.md, from a shell, with a key it read off a board —
//   so the exit codes, the stdout/stderr split and the argv that reaches a real `execa` are
//   the contract, and the harness at the foot of this section is the only place they are
//   visible. It runs against a fake acli on a one-directory PATH, like the two above it.
//
// NOTHING HERE SPAWNS THE REAL acli, and no test in this file imports execa.
// ---------------------------------------------------------------------------

const DONE = JIRA_DONE_LABEL
const OK_RESULT = { exitCode: 0, stdout: '', stderr: '' }
const FAILED_RESULT = { exitCode: 1, stdout: 'ERROR: nope', stderr: 'boom' }

// A completion runs FOUR different invocations and two of them are the same subcommand, so
// `subOf` alone cannot name them: the add and the removal are both `edit`, told apart by which
// flag they carry. Every assertion below talks about these five names.
const kindOf = (argv) => {
  const sub = subOf(argv)
  if (sub !== 'edit') return sub
  return argv.includes('--remove-labels') ? 'remove' : 'add'
}
const kindsOf = (exec) => exec.mock.calls.map(([, argv]) => kindOf(argv))
const argvOf = (exec, kind) =>
  exec.mock.calls.map(([, argv]) => argv).filter((argv) => kindOf(argv) === kind)

// A spawner for the completion path, answering each of the four invocations independently.
// `view` may be a string (printed, exit 0) or a whole result object.
const completer = ({
  view = labelDoc('[]'),
  transition = OK_RESULT,
  add = OK_RESULT,
  remove = OK_RESULT,
  comment = OK_RESULT,
} = {}) =>
  vi.fn(async (_bin, argv) => {
    switch (kindOf(argv)) {
      case 'view':
        return typeof view === 'string' ? { exitCode: 0, stdout: view, stderr: '' } : view
      case 'transition':
        return transition
      case 'add':
        return add
      case 'remove':
        return remove
      default:
        return comment
    }
  })

// A stderr that records whole writes, so a test can count LINES as well as match text.
const sink = () => {
  const writes = []
  return { writes, write: (text) => writes.push(text) }
}
const warningsOf = (stderr) => stderr.writes.join('').split(LF).filter((line) => line !== '')

describe('completeTask — the four invocations as an ordered SEQUENCE (#129 QA)', () => {
  it('runs transition, read, add, removal — in that order, with the exact options object', async () => {
    // ORDER IS A REAL INVARIANT HERE, not an implementation detail, and the module says why in
    // two places: the transition goes first so a human watching the ticket sees it move and
    // then settle, and `in-progress` comes off LAST so the ticket is never un-owned and
    // un-done at once. So this asserts the SEQUENCE of whole calls rather than a set — the
    // dev's suite asserts the argvs, this asserts that a reordering would be caught.
    //
    // The options object is asserted whole for #126 QA's reason: a `shell: true` sneaking in
    // would hand a comment body or a status containing quotes to /bin/sh, and an
    // `objectContaining` would not notice.
    const exec = completer({ view: labelDoc(`["frontend","${IP}"]`) })
    const stderr = sink()
    const result = await completeTask(KEY, { doneStatus: 'Done', exec, stderr })

    expect(exec.mock.calls).toEqual([
      ['acli', ['jira', 'workitem', 'transition', '--key', KEY, '--status', 'Done', '--yes'], { reject: false }],
      ['acli', ['jira', 'workitem', 'view', '--key', KEY, '--fields', 'labels', '--json'], { reject: false }],
      ['acli', ['jira', 'workitem', 'edit', '--key', KEY, '--labels', `frontend,${IP},${DONE}`, '--yes'], { reject: false }],
      ['acli', ['jira', 'workitem', 'edit', '--key', KEY, '--remove-labels', IP, '--yes'], { reject: false }],
    ])
    // The returned labels are the ticket AS IT NOW STANDS — union minus the removed label —
    // which is what makes the value auditable against the argv above.
    expect(result).toEqual({ ok: true, labels: ['frontend', DONE], reason: null })
    expect(stderr.writes).toEqual([])
  })

  it('keeps that order when the transition is refused — the label work still follows', async () => {
    // A refused transition must not become an early return: the label is what drains the
    // queue, so the three writes after it are the ones that matter most when the board move
    // was lost.
    const exec = completer({ view: labelDoc(`["${IP}"]`), transition: FAILED_RESULT })
    const stderr = sink()
    expect(await completeTask(KEY, { doneStatus: 'Done', exec, stderr })).toEqual({
      ok: true,
      labels: [DONE],
      reason: null,
    })
    expect(kindsOf(exec)).toEqual(['transition', 'view', 'add', 'remove'])
  })

  it('reads the labels AFTER the transition, so the read sees the post-move ticket', async () => {
    // Stated as a relationship rather than as indices: a transition that moved the ticket may
    // itself change labels on some boards (a workflow post-function can), and the read has to
    // be the later of the two or the union would be computed from a stale list.
    const exec = completer()
    await completeTask(KEY, { doneStatus: 'Done', exec, stderr: sink() })
    const kinds = kindsOf(exec)
    expect(kinds.indexOf('transition')).toBeLessThan(kinds.indexOf('view'))
    expect(kinds.indexOf('view')).toBeLessThan(kinds.indexOf('add'))
  })

  it('never runs the removal before the add, even when both are refused', async () => {
    const exec = completer({ view: labelDoc(`["${IP}"]`), add: FAILED_RESULT, remove: FAILED_RESULT })
    await completeTask(KEY, { doneStatus: '', exec, stderr: sink() })
    // The add failed, so there is no removal at all — the module's rule that nothing is
    // removed after a failed add, measured as an absence.
    expect(kindsOf(exec)).toEqual(['view', 'add'])
  })
})

describe('completeTask — ok:false means ONE thing, swept as a matrix (#129 QA)', () => {
  // Each row is [what failed, expected ok, expected invocations]. MEASURED by running the
  // case. The point of the matrix is the combinations: three of the four invocations may fail
  // in any combination and the completion still succeeds, because the only question `ok`
  // answers is "is this resolved ticket still in Ralph's queue?".
  const rows = [
    ['nothing', {}, true, ['transition', 'view', 'add', 'remove']],
    ['the transition', { transition: FAILED_RESULT }, true, ['transition', 'view', 'add', 'remove']],
    ['the removal', { remove: FAILED_RESULT }, true, ['transition', 'view', 'add', 'remove']],
    ['transition AND removal', { transition: FAILED_RESULT, remove: FAILED_RESULT }, true, ['transition', 'view', 'add', 'remove']],
    ['the add', { add: FAILED_RESULT }, false, ['transition', 'view', 'add']],
    ['the add AND the transition', { add: FAILED_RESULT, transition: FAILED_RESULT }, false, ['transition', 'view', 'add']],
    ['the read', { view: FAILED_RESULT }, false, ['transition', 'view']],
  ]

  it.each(rows)('%s failing → ok:%s, and %s ran', async (_what, opts, ok, kinds) => {
    const exec = completer({ view: labelDoc(`["${IP}"]`), ...opts })
    const result = await completeTask(KEY, { doneStatus: 'Done', exec, stderr: sink() })
    expect(result.ok).toBe(ok)
    expect(kindsOf(exec)).toEqual(kinds)
    // The other half of the contract: a failure carries a SENTENCE and a success carries
    // exactly `null` — not undefined, not '' — so a caller can branch on `ok` and print
    // `reason` without ever printing the word "null".
    //
    // `toBeNull` and not `typeof === 'object'`, which was the first spelling here and was a
    // tautology dressed as a check: every object passes it, so `reason: {}` would have too.
    // Same for `labels`, which is an ARRAY on success and null on failure — spelled as two
    // branches rather than as one conditional whose arms were identical.
    if (ok) {
      expect(result.reason).toBeNull()
      expect(Array.isArray(result.labels)).toBe(true)
    } else {
      expect(typeof result.reason).toBe('string')
      expect(result.reason).not.toBe('')
      expect(result.labels).toBeNull()
    }
  })

  it('says the ONE thing that failed it, and names the label — never the transition', async () => {
    // The reason string is what the CLI prints on stderr and what an LLM reads to decide
    // whether the ticket is done. A reason that mentioned the transition would send a reader
    // to the wrong knob.
    const exec = completer({ add: FAILED_RESULT, transition: FAILED_RESULT })
    const result = await completeTask(KEY, { doneStatus: 'Done', exec, stderr: sink() })
    expect(result.reason).toBe(
      `could not label ${KEY} ${DONE}: acli did not exit cleanly — is it installed, and is the session logged in?`,
    )
    expect(result.reason).not.toContain('transition')
    expect(result.reason).not.toContain('Done"')
  })

  it('does NOT claim the queue drop when the add then failed — the sentence waits for the label', async () => {
    // WAS a pinned MEASURED LIMITATION: both transition warnings were written BEFORE the label
    // write while asserting its outcome ("it is labelled done and out of Ralph's queue"), so a
    // failed add put that claim on stderr immediately above a reason saying the label could not
    // be written. Review round 1 of #129 fixed it by HOLDING the transition's sentence until
    // `addLabel` has answered — see the `lostMove` phrase in completeTask — so both endings are
    // written only when they are true. That matters because step 7 of prompt-team-jira.md tells
    // the agent to read exactly this stream before deciding whether the ticket is complete.
    const exec = completer({ transition: FAILED_RESULT, add: FAILED_RESULT })
    const stderr = sink()
    const result = await completeTask(KEY, { doneStatus: 'Done', exec, stderr })
    expect(result.ok).toBe(false)
    const lines = warningsOf(stderr)
    expect(lines).toHaveLength(1)
    // The lost board move is still reported — that half was never in doubt.
    expect(lines[0]).toContain(`Jira refused to transition ${KEY} to "Done"`)
    // ...and the half that used to be false now says the opposite, which is the true thing.
    expect(lines[0]).toContain(`still in Ralph's queue`)
    expect(lines[0]).toContain('NOT complete')
    expect(lines[0]).not.toContain(`out of Ralph's queue`)
    expect(result.reason).toContain(`could not label ${KEY} ${DONE}`)
  })

  it('says the same true thing about an unset status whose add then failed', async () => {
    const exec = completer({ add: FAILED_RESULT })
    const stderr = sink()
    expect((await completeTask(KEY, { exec, stderr })).ok).toBe(false)
    const lines = warningsOf(stderr)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(
      `jira-queue.js: JIRA_DONE_STATUS is not set, so ${KEY} was not moved on the board, and the ` +
        `${DONE} label could not be written either, so it is still in Ralph's queue and this ` +
        `ticket is NOT complete`,
    )
  })

  it('DOES claim the queue drop when the label landed — the same sentence, other ending', async () => {
    // The anchor for the two rows above: the reassuring wording is not gone, it is conditional.
    // Without this, a completeTask that had simply stopped saying anything comforting would
    // pass both negatives up there.
    for (const [what, doneStatus, opts, head] of [
      ['a refused transition', 'Done', { transition: FAILED_RESULT }, `Jira refused to transition ${KEY} to "Done"`],
      ['an unset status', '', {}, 'JIRA_DONE_STATUS is not set'],
    ]) {
      const exec = completer(opts)
      const stderr = sink()
      const result = await completeTask(KEY, { doneStatus, exec, stderr })
      expect(result.ok, what).toBe(true)
      const lines = warningsOf(stderr)
      expect(lines, what).toHaveLength(1)
      expect(lines[0], what).toContain(head)
      expect(lines[0], what).toContain(`labelled ${DONE} and out of Ralph's queue`)
      expect(lines[0], what).toContain('by hand')
      expect(lines[0], what).not.toContain('NOT complete')
    }
  })

  it('reports a failed removal as a WARNING and returns the ticket as it now stands', async () => {
    // `labels` after a failed removal still contains `in-progress`, because the value is the
    // ticket as it IS and not as it was meant to be. A test that expected the tidy answer here
    // would be asking the module to lie.
    const exec = completer({ view: labelDoc(`["frontend","${IP}"]`), remove: FAILED_RESULT })
    const stderr = sink()
    const result = await completeTask(KEY, { doneStatus: 'Done', exec, stderr })
    expect(result).toEqual({ ok: true, labels: ['frontend', IP, DONE], reason: null })
    const lines = warningsOf(stderr)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`could not remove ${IP} from ${KEY}`)
    expect(lines[0]).toContain(`it is labelled ${DONE}, so it is out of Ralph's queue either way`)
  })
})

describe('completeTask — the empty-vs-emptied rule, now that TWO verbs share it (#129 QA)', () => {
  // #129 extracted `readWritableLabels` so `claimTask` and `completeTask` share one
  // read-then-union path. An extraction is exactly the moment a safety property applies to one
  // caller and not the other, so every document below is driven through BOTH verbs and the
  // assertion is the same for each: how many processes ran, and whether either of them wrote.
  //
  // MEASURED, both columns. `labels` found and emptied is UNREADABLE, not empty — the #127 QA
  // finding — and the shapes on the left are the ones a Jira client plausibly prints.
  const emptied = [
    ['[""]', 'an empty string'],
    ['["   "]', 'whitespace'],
    ['[null]', 'a null entry'],
    ['[0]', 'a number'],
    ['[false]', 'a boolean'],
    ['[{"name":"frontend"}]', "a REST payload's object shape"],
    ['[["frontend"]]', 'a nested array'],
    ['[{}]', 'an empty object'],
  ]

  it.each(emptied)('%s (%s) → completeTask writes NOTHING and fails', async (json) => {
    const exec = completer({ view: labelDoc(json) })
    const stderr = sink()
    const result = await completeTask(KEY, { doneStatus: 'Done', exec, stderr })
    expect(result.ok).toBe(false)
    expect(result.labels).toBe(null)
    expect(result.reason).toContain('shape Ralph cannot send back')
    expect(result.reason).toContain('left alone')
    // The TRANSITION still happened — it is not a write to the label field, and the ticket
    // moving on the board is not the hazard the read guards. So exactly two processes.
    expect(kindsOf(exec)).toEqual(['transition', 'view'])
    expect(writesOf(exec)).toEqual([])
  })

  it.each(emptied)('%s (%s) → claimTask still writes NOTHING either (no regression)', async (json) => {
    const exec = claimer(labelDoc(json))
    const result = await claimTask(KEY, { exec })
    expect(result.ok).toBe(false)
    expect(exec.mock.calls).toHaveLength(1)
    expect(writesOf(exec)).toEqual([])
  })

  it('writes the label alone for a genuinely EMPTY list — both verbs', async () => {
    // The other side of the distinction, and the one that must not be broken by the guard
    // above: most of a fresh queue looks like this.
    const completing = completer({ view: labelDoc('[]') })
    expect(await completeTask(KEY, { doneStatus: '', exec: completing, stderr: sink() })).toEqual({
      ok: true,
      labels: [DONE],
      reason: null,
    })
    expect(sentLabels(argvOf(completing, 'add')[0])).toBe(DONE)
    // No `in-progress` to take off, so THREE invocations become two and the removal never runs.
    expect(kindsOf(completing)).toEqual(['view', 'add'])

    const claiming = claimer(labelDoc('[]'))
    expect((await claimTask(KEY, { exec: claiming })).labels).toEqual([IP])
    expect(sentLabels(writesOf(claiming)[0])).toBe(IP)
  })

  it('keeps a PARTIALLY unreadable list writable — both verbs, same union rule', async () => {
    // A list with at least one readable label was read correctly; the dropped entries cannot be
    // labels Jira held. Asserted on the SENT STRING, because under replace semantics that
    // string is the ticket's entire new label set.
    const doc = labelDoc('["frontend",null,42,{"x":1},"  p2  "]')
    const completing = completer({ view: doc })
    await completeTask(KEY, { doneStatus: '', exec: completing, stderr: sink() })
    expect(sentLabels(argvOf(completing, 'add')[0])).toBe(`frontend,p2,${DONE}`)

    const claiming = claimer(doc)
    await claimTask(KEY, { exec: claiming })
    expect(sentLabels(writesOf(claiming)[0])).toBe(`frontend,p2,${IP}`)
  })

  it('refuses a read that FAILED as a process, for both verbs, with nothing written', async () => {
    for (const view of [FAILED_RESULT, undefined, null, { exitCode: 0, stdout: 'ERROR: no such work item' }]) {
      const completing = completer({ view: typeof view === 'undefined' ? { exitCode: 0 } : view })
      const result = await completeTask(KEY, { doneStatus: '', exec: completing, stderr: sink() })
      expect(result.ok, JSON.stringify(view)).toBe(false)
      expect(writesOf(completing), JSON.stringify(view)).toEqual([])
    }
  })
})

describe('completeTask — a hostile JIRA_DONE_STATUS (#129 QA)', () => {
  // The value comes out of ralph.config.sh through the environment, so it is whatever a human
  // typed — and it is interpolated into a warning sentence and into an argv. Every row below
  // must (a) not throw, (b) warn EXACTLY ONCE, and (c) either spawn one transition or none.
  const unsetLike = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a zero', 0],
    ['false', false],
    ['true', true],
    ['an object', {}],
    ['an array', []],
    ['an array of one string', ['Done']],
    ['a symbol', Symbol('Done')],
    ['a bigint', 7n],
    ['a function', () => 'Done'],
    ['the empty string', ''],
    ['one space', ' '],
    ['a tab', TAB],
    ['a newline', LF],
    ['CRLF', CR + LF],
    ['every blank byte', ` ${TAB}${CR}${LF} `],
  ]

  it.each(unsetLike)('%s behaves exactly like unset: no transition, ONE warning', async (_label, doneStatus) => {
    const exec = completer()
    const stderr = sink()
    const result = await completeTask(KEY, { doneStatus, exec, stderr })
    expect(result.ok).toBe(true)
    // NO transition process at all — the guard is `typeof === 'string'` then `.trim()`, so a
    // non-string never reaches an argv and a blank string never becomes `--status ""`.
    expect(kindsOf(exec)).toEqual(['view', 'add'])
    // ONE warning, not two: the reader who has to go and move the ticket by hand gets a single
    // line per completion, so the count is the assertion and not just the text.
    expect(warningsOf(stderr)).toHaveLength(1)
    expect(warningsOf(stderr)[0]).toContain('JIRA_DONE_STATUS is not set')
  })

  it('does not touch a non-string status, so a throwing toString cannot escape', async () => {
    // The adversarial version of the row above: an object whose `toString` explodes would take
    // the whole completion down if the status were coerced or interpolated. `typeof` first is
    // what makes that impossible.
    const hostile = {
      toString() {
        throw new Error('never coerce me')
      },
    }
    const exec = completer()
    const stderr = sink()
    expect((await completeTask(KEY, { doneStatus: hostile, exec, stderr })).ok).toBe(true)
    expect(kindsOf(exec)).toEqual(['view', 'add'])
    expect(warningsOf(stderr)).toHaveLength(1)
  })

  it('treats a boxed String as unset (MEASURED limitation)', async () => {
    // `new String('Done')` is `typeof 'object'`, so it skips the transition and warns about an
    // unset knob. Pinned rather than reported as a bug: nothing in Ralph produces a boxed
    // string (the value arrives from `process.env`, which yields primitives), and widening the
    // check to `instanceof String` would buy a shape no caller has.
    const exec = completer()
    const stderr = sink()
    await completeTask(KEY, { doneStatus: new String('Done'), exec, stderr })
    expect(kindsOf(exec)).toEqual(['view', 'add'])
    expect(warningsOf(stderr)[0]).toContain('JIRA_DONE_STATUS is not set')
  })

  it('sends a status with spaces, quotes and newlines as ONE argv element, trimmed', async () => {
    // Real statuses have spaces ("In Review", "Ready for QA"), and no shell is involved, so the
    // whole value is argv[6]. Trimmed, because a trailing space in a config file is a typo and
    // not a status name — and the TRIMMED value is what the warning quotes too.
    for (const raw of [
      'In Review',
      '  Done  ',
      `Done${QUOTE}`,
      `${QUOTE}Done${QUOTE}`,
      `Ready${TAB}for QA`,
      'Done; touch pwned',
      '$(touch pwned)',
      `Done${BACKSLASH}nDone`,
      'x'.repeat(5000),
    ]) {
      const exec = completer({ transition: FAILED_RESULT })
      const stderr = sink()
      await completeTask(KEY, { doneStatus: raw, exec, stderr })
      const argv = argvOf(exec, 'transition')[0]
      expect(argv, JSON.stringify(raw.slice(0, 20))).toHaveLength(8)
      expect(argv[argv.indexOf('--status') + 1]).toBe(raw.trim())
      expect(argv.at(-1)).toBe('--yes')
      // And the refusal warning quotes the same trimmed value, so the sentence names a status
      // the reader can search their workflow for.
      expect(warningsOf(stderr)).toHaveLength(1)
      expect(warningsOf(stderr)[0]).toContain(`to "${raw.trim()}"`)
    }
  })

  it('warns ONCE per completion even when the status has an embedded newline (MEASURED)', async () => {
    // A status containing a real LF makes ONE warning that PRINTS as two lines — the warning
    // count is one, the line count is two. Pinned because a reader counting lines in a log
    // would double-count it, and because it is the only way `warn` can emit a blank-looking
    // continuation.
    const exec = completer({ transition: FAILED_RESULT })
    const stderr = sink()
    await completeTask(KEY, { doneStatus: `Done${LF}Deployed`, exec, stderr })
    expect(stderr.writes).toHaveLength(1)
    expect(warningsOf(stderr)).toHaveLength(2)
    expect(stderr.writes[0].endsWith(LF)).toBe(true)
  })
})

describe('completeTask — the warnings survive a hostile stderr (#129 QA)', () => {
  // "A completion that threw while reporting a board it could not move would turn a lost
  // transition into a lost run." That is the whole point of the try/catch around `warn`, and
  // it is only visible from here: the dev's suite passes a recording sink.
  const sinks = [
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['a number', 7],
    ['a string', 'stderr'],
    ['an empty object', {}],
    ['a non-function write', { write: 'nope' }],
    ['a write that throws', { write: () => { throw new Error('EPIPE') } }],
    ['a write that returns false', { write: () => false }],
    ['a getter that throws', { get write() { throw new Error('closed') } }],
    ['a proxy that throws on get', new Proxy({}, { get() { throw new Error('revoked') } })],
  ]

  it.each(sinks)('completes normally with %s as stderr', async (_label, stderr) => {
    // `undefined` takes the `process.stderr` default, which is why this row prints TWO real
    // warnings into the suite's own output during the run — the fixture fails both the
    // transition and the removal, and each one warns. Every other row is silent by
    // construction. (MEASURED: they are the two `jira-queue.js:` lines this file emits.)
    const exec = completer({ view: labelDoc(`["${IP}"]`), transition: FAILED_RESULT, remove: FAILED_RESULT })
    const result = await completeTask(KEY, { doneStatus: 'Done', exec, stderr })
    expect(result).toEqual({ ok: true, labels: [IP, DONE], reason: null })
    // All four processes ran: a stream that cannot be written to changed nothing about the work.
    expect(kindsOf(exec)).toEqual(['transition', 'view', 'add', 'remove'])
  })

  it('writes each warning as exactly one call ending in one newline', async () => {
    // The loop's log is line-oriented (templates/ralph.sh tees it), so a warning without a
    // trailing newline would glue itself to the next line of output.
    const exec = completer({ view: labelDoc(`["${IP}"]`), transition: FAILED_RESULT, remove: FAILED_RESULT })
    const stderr = sink()
    await completeTask(KEY, { doneStatus: 'Done', exec, stderr })
    expect(stderr.writes).toHaveLength(2)
    for (const write of stderr.writes) {
      expect(write.startsWith('jira-queue.js: ')).toBe(true)
      expect(write.endsWith(LF)).toBe(true)
      expect(write.slice(0, -1)).not.toContain(LF)
    }
  })

  it('is silent on the wholly happy path — no news is the success signal', async () => {
    const stderr = sink()
    await completeTask(KEY, { doneStatus: 'Done', exec: completer(), stderr })
    expect(stderr.writes).toEqual([])
  })
})

describe('completeTask — idempotence, re-runs, and the keys it will not touch (#129 QA)', () => {
  it('is free to re-run: a ticket already `done` is read and left alone', async () => {
    // A re-run happens for real — an iteration that committed, completed, and then died before
    // the loop recorded it gets the same ticket handed to the same prompt. So the second
    // completion must cost one read and no write.
    const exec = completer({ view: labelDoc(`["frontend","${DONE}"]`) })
    const result = await completeTask(KEY, { doneStatus: '', exec, stderr: sink() })
    expect(result).toEqual({ ok: true, labels: ['frontend', DONE], reason: null })
    expect(kindsOf(exec)).toEqual(['view'])
  })

  it('still removes a stale `in-progress` on a ticket that is already `done`', async () => {
    // The half-finished shape: the add landed, the removal did not. A re-run has to finish the
    // job rather than short-circuit on the label it already has.
    const exec = completer({ view: labelDoc(`["${IP}","${DONE}"]`) })
    const result = await completeTask(KEY, { doneStatus: '', exec, stderr: sink() })
    expect(result).toEqual({ ok: true, labels: [DONE], reason: null })
    expect(kindsOf(exec)).toEqual(['view', 'remove'])
  })

  it('does not write `done` twice for a ticket that carries it many times', async () => {
    const exec = completer({ view: labelDoc(`["${DONE}","${DONE}","frontend"]`) })
    const result = await completeTask(KEY, { doneStatus: '', exec, stderr: sink() })
    // De-duplicated by the reader, so the answer is the SET and no write is needed.
    expect(result.labels).toEqual([DONE, 'frontend'])
    expect(writesOf(exec)).toEqual([])
  })

  it('is CASE SENSITIVE about both labels, so `Done` and `In-Progress` are other labels (MEASURED)', async () => {
    // MEASURED LIMITATION. A ticket a human labelled `Done` gets a second, lower-case `done`
    // added, and an `In-Progress` is never removed — so the ticket ends up carrying both
    // spellings of one idea. Pinned rather than reported as a bug for two reasons: Jira labels
    // ARE case-sensitive, so `Done` and `done` genuinely are different labels, and the queue
    // still drains (the composed exclusion matches the lower-case one Ralph wrote). What it
    // costs is a tidy board.
    const exec = completer({ view: labelDoc('["Done","In-Progress"]') })
    const result = await completeTask(KEY, { doneStatus: '', exec, stderr: sink() })
    expect(sentLabels(argvOf(exec, 'add')[0])).toBe(`Done,In-Progress,${DONE}`)
    expect(kindsOf(exec)).toEqual(['view', 'add'])
    expect(result.labels).toEqual(['Done', 'In-Progress', DONE])
    // No removal ran, so the mixed-case in-progress label stays on the ticket.
    expect(argvOf(exec, 'remove')).toEqual([])
  })

  it('spawns NOTHING for a key it cannot use — not even the transition', async () => {
    // Three writes whose subject is whatever acli decides it is would be three writes to the
    // wrong ticket, so this is the most important absence in the module. Swept over every
    // not-a-key a bash capture or a JSON envelope can produce.
    for (const key of [undefined, null, '', '   ', TAB + LF, 0, 42, {}, [], true, Symbol('FOO-1'), 7n, () => 'FOO-1']) {
      const exec = completer()
      const stderr = sink()
      const result = await completeTask(key, { doneStatus: 'Done', exec, stderr })
      expect(result, String(typeof key)).toEqual({
        ok: false,
        labels: null,
        reason: 'no Jira work item key to complete',
      })
      expect(exec, String(typeof key)).not.toHaveBeenCalled()
      // ...and it does not warn either: there is no ticket to tell anybody to move by hand.
      expect(stderr.writes, String(typeof key)).toEqual([])
    }
  })

  it('normalizes the key IDENTICALLY across all three writes and the read', async () => {
    // `usableJiraKey` runs ONCE and its result is threaded through every invocation, which is
    // the property that matters: four argvs naming three different spellings of one ticket
    // would label one and transition another.
    const exec = completer({ view: labelDoc(`["${IP}"]`) })
    await completeTask('  foo-123  ', { doneStatus: 'Done', exec, stderr: sink() })
    const keys = exec.mock.calls.map(([, argv]) => argv[argv.indexOf('--key') + 1])
    expect(keys).toEqual(['FOO-123', 'FOO-123', 'FOO-123', 'FOO-123'])
    expect(new Set(keys).size).toBe(1)
  })

  it('passes a key the grammar does not recognise through trimmed, and still writes', async () => {
    // PERMISSIVE ON PURPOSE: Jira names the ticket, `jira-key.js` only reads the name. So a
    // key from a site with a numeric project prefix, or one with two hyphens, is used as
    // written — trimmed — rather than refused. The cost is bounded: acli answers about
    // whatever that string is, and every failure is already a value.
    for (const [raw, expected] of [
      ['  ABC-1-2  ', 'ABC-1-2'],
      ['123-45', '123-45'],
      ['lower case thing', 'lower case thing'],
      [`FOO-1${TAB}`, 'FOO-1'],
      ['FOO_1', 'FOO_1'],
    ]) {
      const exec = completer()
      await completeTask(raw, { doneStatus: '', exec, stderr: sink() })
      expect(argvOf(exec, 'add')[0][4], raw).toBe(expected)
    }
  })
})

describe('commentTask — the one artifact that outlives the run (#129 QA)', () => {
  const commenter = (result = OK_RESULT) => vi.fn(async () => result)
  const bodyOf = (exec) => {
    const argv = exec.mock.calls[0][1]
    return argv[argv.indexOf('--body') + 1]
  }

  it('sends the body RAW — one argv element, untrimmed, unescaped, unquoted', async () => {
    // In Jira mode nothing pushes and no PR is opened, so this comment is the only trail from
    // the board back to the commit. It is sent as it was written: trimming it would silently
    // reformat a body an agent composed, and quoting it would put quote characters ON the
    // board.
    for (const body of [
      'Resolved by Ralph in abc1234',
      `line one${LF}line two`,
      `  leading and trailing  `,
      `${QUOTE}quoted${QUOTE}`,
      `back${BACKSLASH}slash`,
      `tab${TAB}separated`,
      `${CR}${LF}crlf`,
      '--yes',
      '--body surprise',
      '; touch pwned',
      '$(touch pwned)',
      `nul${NUL}byte`,
      `ansi${ESC_BYTE}[31mred`,
      'x'.repeat(200000),
      'ìñtërnâtiônàl ✅ 🎉',
    ]) {
      const exec = commenter()
      expect(await commentTask(KEY, body, { exec })).toEqual({ ok: true, reason: null })
      expect(exec.mock.calls).toHaveLength(1)
      expect(bodyOf(exec), JSON.stringify(body.slice(0, 20))).toBe(body)
      expect(exec.mock.calls[0][1]).toHaveLength(9)
      expect(exec.mock.calls[0][1].at(-1)).toBe('--yes')
      // The whole options object, so no shell can appear on the path a 200 000-character body
      // travels down.
      expect(exec.mock.calls[0][2]).toEqual({ reject: false })
    }
  })

  it('checks the body for emptiness on its TRIMMED form but sends the UNTRIMMED one (MEASURED)', async () => {
    // Two different readings of one value, deliberately: "is there anything here?" is a
    // question about content, "what do I post?" is a question about text. So a body of
    // `"  hi  "` posts with its spaces, and a body of `"   "` posts nothing at all.
    const exec = commenter()
    await commentTask(KEY, `  hi  `, { exec })
    expect(bodyOf(exec)).toBe('  hi  ')
  })

  it('refuses an empty body BEFORE starting a process — an empty comment is worse than none', async () => {
    for (const body of ['', '   ', TAB, LF, CR + LF, ` ${TAB}${LF} `]) {
      const exec = commenter()
      const result = await commentTask(KEY, body, { exec })
      expect(result, JSON.stringify(body)).toEqual({
        ok: false,
        reason: `no comment body to post to ${KEY}`,
      })
      expect(exec, JSON.stringify(body)).not.toHaveBeenCalled()
    }
  })

  it('refuses every non-string body without coercing it', async () => {
    // A number, an array or an object would all produce SOMETHING under coercion, and all of
    // them mean the same thing: the caller has no text. The `typeof` check is also what keeps a
    // throwing `toString` from taking the run down.
    const throwing = {
      toString() {
        throw new Error('no')
      },
    }
    for (const body of [undefined, null, 0, 42, true, false, {}, [], ['a'], throwing, Symbol('s'), 7n, () => 'text']) {
      const exec = commenter()
      const result = await commentTask(KEY, body, { exec })
      expect(result.ok, String(typeof body)).toBe(false)
      expect(result.reason, String(typeof body)).toBe(`no comment body to post to ${KEY}`)
      expect(exec, String(typeof body)).not.toHaveBeenCalled()
    }
  })

  it('refuses a missing key before it looks at the body, and spawns nothing', async () => {
    for (const key of [undefined, null, '', '  ', 42, {}, []]) {
      const exec = commenter()
      const result = await commentTask(key, 'a body', { exec })
      expect(result, String(typeof key)).toEqual({
        ok: false,
        reason: 'no Jira work item key to comment on',
      })
      expect(exec, String(typeof key)).not.toHaveBeenCalled()
    }
    // ...and the key's refusal wins over the body's when BOTH are unusable, so the sentence
    // names the thing that has to be fixed first.
    const exec = commenter()
    expect((await commentTask('', '', { exec })).reason).toContain('no Jira work item key')
  })

  it('normalizes the key the same way the other verbs do', async () => {
    const exec = commenter()
    await commentTask('  foo-123  ', 'body', { exec })
    expect(exec.mock.calls[0][1][5]).toBe('FOO-123')
  })

  it('never throws for a spawner that is broken in any way', async () => {
    // Best-effort by contract, and the contract includes "never throws": the work is already
    // committed by the time anything comments, so an exception here would turn a finished
    // ticket into a crashed iteration.
    const shapes = [
      ['throws synchronously', () => { throw new Error('spawn acli ENOENT') }],
      ['rejects', () => Promise.reject(new Error('EACCES'))],
      ['returns undefined', () => undefined],
      ['returns null', async () => null],
      ['exits non-zero', async () => FAILED_RESULT],
      ['has no exitCode', async () => ({ failed: true, stdout: '' })],
      ['returns a string', async () => 'posted'],
      ['returns a number', async () => 0],
    ]
    for (const [label, impl] of shapes) {
      const result = await commentTask(KEY, 'body', { exec: vi.fn(impl) })
      expect(result.ok, label).toBe(false)
      expect(result.reason, label).toContain(`could not comment on ${KEY}`)
    }
    // A missing spawner altogether is the same finding rather than a crash.
    expect((await commentTask(KEY, 'body')).ok).toBe(false)
    expect((await commentTask(KEY, 'body', {})).reason).toContain(`could not comment on ${KEY}`)
  })

  it('reports ok:false for a comment that POSTED but whose stdout could not be read (MEASURED)', async () => {
    // MEASURED LIMITATION, and a benign one. `acliText` treats a clean exit with an unreadable
    // stdout as a failure, so a comment acli accepted — exit 0 — is reported as one that could
    // not be posted when its stdout is a destroyed stream. The consequence is bounded to a log
    // line, because a failed comment changes nothing by contract; what it must never cause is
    // a SECOND comment, and nothing in this module retries.
    const exec = vi.fn(async () => ({
      exitCode: 0,
      get stdout() {
        throw new Error('stream destroyed')
      },
    }))
    const result = await commentTask(KEY, 'Resolved in abc1234', { exec })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(
      `could not comment on ${KEY}: acli exited cleanly but Ralph could not read its output`,
    )
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('treats acli printing nothing as SUCCESS — which is what a write does', async () => {
    for (const stdout of ['', undefined, null, Buffer.alloc(0)]) {
      const exec = vi.fn(async () => ({ exitCode: 0, stdout }))
      expect((await commentTask(KEY, 'body', { exec })).ok, String(stdout)).toBe(true)
    }
  })

  it('posts exactly once per call — a comment is not retried', async () => {
    // The one place a retry would be actively harmful: two comments on a board are two entries
    // in somebody's activity feed, and nothing can tell whether the first landed.
    const exec = commenter(FAILED_RESULT)
    await commentTask(KEY, 'body', { exec })
    expect(exec).toHaveBeenCalledTimes(1)
  })
})

describe('completeTask and commentTask are INDEPENDENT — the step-7 order (#129 QA)', () => {
  it('a failed comment cannot change a completion, and a failed completion still allows a comment', async () => {
    // templates/prompt-team-jira.md step 7 runs `complete` then `comment`, as two commands,
    // and the reason they are two is that their verdicts are unrelated. Asserted as
    // composition, because nothing in the module couples them and this is what stops a future
    // edit from doing so.
    const completing = completer()
    const done = await completeTask(KEY, { doneStatus: '', exec: completing, stderr: sink() })
    const commenting = vi.fn(async () => FAILED_RESULT)
    const commented = await commentTask(KEY, 'Resolved in abc1234', { exec: commenting })
    expect(done.ok).toBe(true)
    expect(commented.ok).toBe(false)
    // The comment's spawner never saw a label write, and the completion's never saw a comment.
    expect(kindsOf(completing)).toEqual(['view', 'add'])
    expect(kindOf(commenting.mock.calls[0][1])).toBe('comment')
  })

  it('a completed ticket drops out of the next pick — by composition, and by the label it wrote', async () => {
    // The end of the acceptance criterion: the ticket Ralph just completed must not be handed
    // out again. Two independent halves, both asserted: the label `completeTask` SENT is one
    // the composed query excludes, and a `queuePick` over a board that now returns nothing
    // yields null.
    const completing = completer({ view: labelDoc('[]') })
    await completeTask(KEY, { doneStatus: '', exec: completing, stderr: sink() })
    expect(sentLabels(argvOf(completing, 'add')[0]).split(',')).toContain(DONE)
    expect(composeJiraJql(JQL).jql).toContain(DONE)

    const picking = vi.fn(async () => ({ exitCode: 0, stdout: '[]', stderr: '' }))
    expect(await queuePick(JQL, { exec: picking })).toBe(null)
  })
})

describe('jira-queue.js CLI — complete and comment as the AGENT runs them (#129 QA)', () => {
  // The gap this closes: `complete` and `comment` are run by an LLM following step 7 of
  // templates/prompt-team-jira.md, from a shell, in a detached tmux pane — and until now every
  // test of them was in-process. What only a process can show is the exit code the prompt
  // branches on, the stdout/stderr split, that JIRA_DONE_STATUS really does arrive through the
  // ENVIRONMENT rather than a flag, and that a body reaches acli as one argument through a real
  // `execa` with no shell in between.
  const CLI = join(dirname(fileURLToPath(import.meta.url)), 'jira-queue.js')
  const runnable = process.platform !== 'win32'
  const BS = String.fromCharCode(0x5c)

  // Same shape as the #127 harness, with the shim keyed on BOTH the subcommand (`$3`) and — for
  // `edit` — the flag at `$6`, because the add and the removal are the same subcommand and this
  // suite needs to fail them independently. `doneStatus: null` means the variable is ABSENT
  // from the environment rather than empty, which is a different case.
  function jira129(args, opts = {}) {
    const {
      view = '{"fields":{"labels":[]}}',
      viewExit = '0',
      transitionExit = '0',
      addExit = '0',
      removeExit = '0',
      commentExit = '0',
      doneStatus = null,
    } = opts
    const dir = mkdtempSync(join(tmpdir(), 'ralph-jira-129-'))
    const shim = join(dir, 'acli')
    writeFileSync(
      shim,
      [
        '#!/bin/sh',
        'printf "%s' + BS + 'n" "$@" > "$ACLI_DIR/argv.$$"',
        'printf "%s' + BS + 'n" "$$" >> "$ACLI_DIR/order"',
        'out=""',
        'case "$3" in',
        '  view) out="$ACLI_VIEW"; code="$ACLI_VIEW_EXIT" ;;',
        '  transition) code="$ACLI_TRANSITION_EXIT" ;;',
        '  comment) code="$ACLI_COMMENT_EXIT" ;;',
        '  edit)',
        '    case "$6" in',
        '      --remove-labels) code="$ACLI_REMOVE_EXIT" ;;',
        '      *) code="$ACLI_ADD_EXIT" ;;',
        '    esac ;;',
        '  *) code=0 ;;',
        'esac',
        'printf "%s" "$out"',
        'exit "$code"',
      ].join(LF) + LF,
    )
    chmodSync(shim, 0o755)
    try {
      const env = {
        PATH: dir,
        ACLI_DIR: dir,
        ACLI_VIEW: view,
        ACLI_VIEW_EXIT: viewExit,
        ACLI_TRANSITION_EXIT: transitionExit,
        ACLI_ADD_EXIT: addExit,
        ACLI_REMOVE_EXIT: removeExit,
        ACLI_COMMENT_EXIT: commentExit,
      }
      // Absent vs empty vs set: all three are real configurations, and the CLI reads
      // `process.env.JIRA_DONE_STATUS` so only a real environment can tell them apart.
      if (doneStatus !== null) env.JIRA_DONE_STATUS = doneStatus
      const res = spawnSync(process.execPath, [CLI, ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 20000,
        env,
      })
      const orderFile = join(dir, 'order')
      const pids = existsSync(orderFile)
        ? readFileSync(orderFile, 'utf8').split(LF).slice(0, -1)
        : []
      const calls = pids.map((pid) =>
        readFileSync(join(dir, `argv.${pid}`), 'utf8').split(LF).slice(0, -1),
      )
      return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', calls }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const kinds = (r) => r.calls.map(kindOf)

  it.skipIf(!runnable)('runs all four invocations, in order, with JIRA_DONE_STATUS from the env', () => {
    const r = jira129(['complete', 'FOO-123'], {
      view: `{"fields":{"labels":["frontend","${IP}"]}}`,
      doneStatus: 'Done',
    })
    expect(r.status).toBe(0)
    // SILENT on the happy path, on both streams: the agent's shell captures neither, and prose
    // on stdout could be read as data by a future verb.
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
    expect(r.calls).toEqual([
      ['jira', 'workitem', 'transition', '--key', 'FOO-123', '--status', 'Done', '--yes'],
      ['jira', 'workitem', 'view', '--key', 'FOO-123', '--fields', 'labels', '--json'],
      ['jira', 'workitem', 'edit', '--key', 'FOO-123', '--labels', `frontend,${IP},${DONE}`, '--yes'],
      ['jira', 'workitem', 'edit', '--key', 'FOO-123', '--remove-labels', IP, '--yes'],
    ])
  })

  it.skipIf(!runnable)('skips the transition and warns ONCE when JIRA_DONE_STATUS is absent', () => {
    // The default configuration: templates/ralph.config.sh ships `JIRA_DONE_STATUS=""`, so
    // this is what most repos get. It must still complete.
    const r = jira129(['complete', 'FOO-123'], { view: `{"fields":{"labels":["${IP}"]}}` })
    expect(r.status).toBe(0)
    expect(kinds(r)).toEqual(['view', 'add', 'remove'])
    expect(r.stderr.split(LF).filter((line) => line !== '')).toHaveLength(1)
    expect(r.stderr).toContain('JIRA_DONE_STATUS is not set')
    expect(r.stdout).toBe('')
  })

  it.skipIf(!runnable)('treats an empty and a whitespace-only JIRA_DONE_STATUS the same way', () => {
    for (const doneStatus of ['', '   ', TAB]) {
      const r = jira129(['complete', 'FOO-123'], { doneStatus })
      expect(r.status, JSON.stringify(doneStatus)).toBe(0)
      expect(kinds(r), JSON.stringify(doneStatus)).toEqual(['view', 'add'])
      expect(r.stderr, JSON.stringify(doneStatus)).toContain('JIRA_DONE_STATUS is not set')
    }
  })

  it.skipIf(!runnable)('sends a multi-word status as ONE argument, with no shell in between', () => {
    // `JIRA_DONE_STATUS="In Review"` is the realistic case and the one a `shell: true` would
    // break into two flags. Through a real execa, so this is the whole path.
    const r = jira129(['complete', 'FOO-123'], { doneStatus: 'In Review' })
    expect(r.status).toBe(0)
    expect(r.calls[0]).toEqual([
      'jira', 'workitem', 'transition', '--key', 'FOO-123', '--status', 'In Review', '--yes',
    ])
  })

  it.skipIf(!runnable)('exits 0 with a warning when the board REFUSES the transition', () => {
    // The commonest real failure: a workflow with no such move from where the ticket sits. It
    // is not a failed task, and the exit code is what the prompt branches on.
    const r = jira129(['complete', 'FOO-123'], { doneStatus: 'Done', transitionExit: '1' })
    expect(r.status).toBe(0)
    expect(kinds(r)).toEqual(['transition', 'view', 'add'])
    expect(r.stderr).toContain('Jira refused to transition FOO-123 to "Done"')
    expect(r.stdout).toBe('')
  })

  it.skipIf(!runnable)('exits 0 with a warning when `in-progress` will not come off', () => {
    const r = jira129(['complete', 'FOO-123'], {
      view: `{"fields":{"labels":["${IP}"]}}`,
      removeExit: '1',
    })
    expect(r.status).toBe(0)
    expect(kinds(r)).toEqual(['view', 'add', 'remove'])
    expect(r.stderr).toContain(`could not remove ${IP} from FOO-123`)
  })

  it.skipIf(!runnable)('exits 1 ONLY when the `done` label could not be written — and writes no removal', () => {
    // The exit code the prompt's "exactly one reason" claim is about, and the absence that
    // makes a failure safe: a ticket that lost `in-progress` without gaining `done` would be
    // back in the queue with no owner.
    const r = jira129(['complete', 'FOO-123'], {
      view: `{"fields":{"labels":["${IP}"]}}`,
      doneStatus: 'Done',
      addExit: '1',
    })
    expect(r.status).toBe(1)
    expect(kinds(r)).toEqual(['transition', 'view', 'add'])
    expect(r.stderr).toContain(`jira-queue.js: could not label FOO-123 ${DONE}`)
    expect(r.stdout).toBe('')
  })

  it.skipIf(!runnable)('exits 1 and writes NOTHING when the read failed or was unreadable', () => {
    for (const opts of [
      { viewExit: '1' },
      { view: 'ERROR: work item not found' },
      { view: '' },
      { view: '{"fields":{}}' },
      { view: '{"fields":{"labels":[{"name":"frontend"}]}}' },
    ]) {
      const r = jira129(['complete', 'FOO-123'], { ...opts, doneStatus: 'Done' })
      expect(r.status, JSON.stringify(opts)).toBe(1)
      // The transition ran, the read ran, and NOTHING was edited.
      expect(kinds(r), JSON.stringify(opts)).toEqual(['transition', 'view'])
      expect(r.stderr, JSON.stringify(opts)).toContain('jira-queue.js:')
    }
  })

  it.skipIf(!runnable)('exits 2 with a usage line and NO process when the key is missing', () => {
    for (const args of [['complete'], ['complete', '']]) {
      const r = jira129(args, { doneStatus: 'Done' })
      expect(r.status, JSON.stringify(args)).toBe(2)
      expect(r.stdout, JSON.stringify(args)).toBe('')
      expect(r.stderr, JSON.stringify(args)).toContain('usage: jira-queue.js')
      expect(r.stderr, JSON.stringify(args)).toContain('complete')
      expect(r.calls, JSON.stringify(args)).toEqual([])
    }
  })

  it.skipIf(!runnable)('exits 1 — not 2 — for a whitespace-only key (MEASURED)', () => {
    // MEASURED, and it makes the prompt's "exits non-zero for exactly one reason — the `done`
    // label could not be written" INEXACT: a key of `"   "` is a caller mistake, it is truthy
    // so it passes the usage gate, and `usableJiraKey` then refuses it — which lands on exit 1,
    // the code the prompt reads as "the label failed". Pinned rather than reported as a bug
    // because both readings are non-zero and the prompt's next instruction (stop and report)
    // is right either way; what is wrong is only the reason a reader would infer. NOTHING RAN,
    // which is the part that matters.
    const r = jira129(['complete', '   '], { doneStatus: 'Done' })
    expect(r.status).toBe(1)
    expect(r.calls).toEqual([])
    expect(r.stderr).toBe('jira-queue.js: no Jira work item key to complete' + LF)
  })

  it.skipIf(!runnable)('posts a comment and ALWAYS exits 0', () => {
    const r = jira129(['comment', 'FOO-123', 'Resolved by Ralph in abc1234'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
    expect(r.calls).toEqual([
      ['jira', 'workitem', 'comment', 'create', '--key', 'FOO-123', '--body', 'Resolved by Ralph in abc1234', '--yes'],
    ])
  })

  it.skipIf(!runnable)('exits 0 even when acli REFUSED the comment, and says so on stderr only', () => {
    // The `|| true` promise as an exit code. The work is already committed by the time step 7
    // comments, so a failed post must not read as a failed iteration.
    const r = jira129(['comment', 'FOO-123', 'body'], { commentExit: '1' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('jira-queue.js: could not comment on FOO-123')
    expect(r.calls).toHaveLength(1)
  })

  it.skipIf(!runnable)('rejoins an UNQUOTED body from every argument it was given', () => {
    // The caller is an LLM writing a shell command, so a body it forgot to quote arrives as
    // many arguments. Joining them with single spaces yields a slightly-squashed comment
    // instead of a truncated one — measured here because `rest.join(' ')` is invisible from
    // any in-process test of `commentTask`.
    const r = jira129(['comment', 'FOO-123', 'Resolved', 'by', 'Ralph', 'in', 'abc1234'])
    expect(r.status).toBe(0)
    expect(r.calls[0][7]).toBe('Resolved by Ralph in abc1234')
    expect(r.calls[0]).toHaveLength(9)
  })

  it.skipIf(!runnable)('squashes runs of whitespace an unquoted body lost to the shell (MEASURED)', () => {
    // What the rejoin CANNOT recover, pinned so the limitation is documented where it is
    // measurable: the shell has already collapsed the spacing and dropped the newlines by the
    // time argv exists, so a multi-line body written without quotes arrives as one line.
    const r = jira129(['comment', 'FOO-123', 'Resolved', '', 'in', 'abc1234'])
    expect(r.calls[0][7]).toBe('Resolved  in abc1234')
  })

  it.skipIf(!runnable)('sends a QUOTED multi-line body as one argument, newlines intact', () => {
    // The shape step 7 actually produces when the agent quotes properly, through a real execa:
    // one argv element carrying real newlines, which is what makes a readable Jira comment.
    const body = `Resolved by Ralph.${LF}${LF}Commit: abc1234`
    const r = jira129(['comment', 'FOO-123', body])
    expect(r.status).toBe(0)
    // The shim logs one line per argument, so a body with newlines spans several LOG lines —
    // which is why this is asserted on the joined tail rather than on `calls[0][7]`.
    const argv = r.calls[0]
    expect(argv.slice(7, -1).join(LF)).toBe(body)
    expect(argv.at(-1)).toBe('--yes')
  })

  it.skipIf(!runnable)('hands a hostile body straight to acli — no shell, no expansion', () => {
    const hostile = `done; touch pwned $(touch pwned2) ${String.fromCharCode(0x60)}touch pwned3${String.fromCharCode(0x60)} ${QUOTE}q${QUOTE} ${BACKSLASH}n`
    const r = jira129(['comment', 'FOO-123', hostile])
    expect(r.status).toBe(0)
    expect(r.calls[0][7]).toBe(hostile)
  })

  it.skipIf(!runnable)('exits 0 and starts NO process for a comment with no body at all', () => {
    // `comment KEY` with nothing after it: an empty comment is worse than no comment, so it is
    // refused before a process starts — and still exits 0, because the verb cannot fail a run.
    for (const args of [['comment', 'FOO-123'], ['comment', 'FOO-123', ''], ['comment', 'FOO-123', '   ']]) {
      const r = jira129(args)
      expect(r.status, JSON.stringify(args)).toBe(0)
      expect(r.calls, JSON.stringify(args)).toEqual([])
      expect(r.stderr, JSON.stringify(args)).toContain('no comment body to post to FOO-123')
      expect(r.stdout, JSON.stringify(args)).toBe('')
    }
  })

  it.skipIf(!runnable)('exits 2 for a comment with no KEY — the one usage error it does report', () => {
    const r = jira129(['comment'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage: jira-queue.js')
    expect(r.calls).toEqual([])
  })

  it.skipIf(!runnable)('normalizes the key at the CLI too, for both verbs', () => {
    // The agent interpolates a key it read off a board, so a key arriving with case or spacing
    // of its own is realistic even now that step 7 quotes it — quoting is what makes the spacing
    // ARRIVE rather than what removes it.
    const completed = jira129(['complete', '  foo-123  '], { doneStatus: 'Done' })
    expect(completed.calls.map((argv) => argv[argv.indexOf('--key') + 1])).toEqual([
      'FOO-123',
      'FOO-123',
      'FOO-123',
    ])
    const commented = jira129(['comment', 'foo-123', 'body'])
    expect(commented.calls[0][5]).toBe('FOO-123')
  })

  it.skipIf(!runnable)('takes a QUOTED key with a space WHOLE — which is why the template quotes it', () => {
    // WAS `applies an unquoted key with a space to the FIRST word only (MEASURED)`, a pinned
    // limitation of the CLI's `[cmd, arg, ...rest]` destructuring: a key arriving as two
    // arguments had its tail silently dropped, so `complete FOO 123` completed a ticket called
    // `FOO`. Review round 1 of #129 fixed it at the source rather than here —
    // templates/prompt-team-jira.md now quotes {{RALPH_TASK_KEY}} at all three call sites — so
    // the shape this test used to pin is one the template no longer produces.
    //
    // WHY THAT IS THE RIGHT PLACE FOR THE FIX: `rest` cannot be rejoined into the key the way
    // the BODY is (`rest.join(' ')`), because for `comment` the rest IS the body. Only the
    // caller can tell Ralph where the key ends, and quoting is how it does.
    //
    // MEASURED through a real execa: the whole string reaches acli as one `--key` value,
    // uppercased and trimmed by `usableJiraKey` but not split. The board has no such work item,
    // so the read fails and NOTHING is written — exit 1, one process.
    const r = jira129(['complete', 'FOO 123'], { view: 'ERROR: no such work item' })
    expect(r.status).toBe(1)
    expect(r.calls.map((argv) => argv[argv.indexOf('--key') + 1])).toEqual(['FOO 123'])
    expect(r.calls).toHaveLength(1)
    // And the unquoted shape still degrades the old way, which is exactly what the template
    // change avoids: pinned here so the reason for quoting stays measurable.
    const split = jira129(['complete', 'FOO', '123'], { view: 'ERROR: no such work item' })
    expect(split.calls.map((argv) => argv[argv.indexOf('--key') + 1])).toEqual(['FOO'])
  })

  it.skipIf(!runnable)('never writes prose to stdout for either verb, under any failure', () => {
    // `complete` and `comment` are run inside a pane whose output is teed to a log, and a
    // future caller capturing stdout must not receive a sentence. Swept across every failure
    // this suite can produce.
    for (const [args, opts] of [
      [['complete', 'FOO-123'], { addExit: '1' }],
      [['complete', 'FOO-123'], { viewExit: '1' }],
      [['complete', 'FOO-123'], { doneStatus: 'Done', transitionExit: '1' }],
      [['complete', 'FOO-123'], { view: `{"fields":{"labels":["${IP}"]}}`, removeExit: '1' }],
      [['comment', 'FOO-123', 'b'], { commentExit: '1' }],
      [['comment', 'FOO-123'], {}],
      [['nonsense', 'FOO-123'], {}],
    ]) {
      expect(jira129(args, opts).stdout, JSON.stringify(args)).toBe('')
    }
  })
})
