import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { claimTask, queueCount, queuePick } from './jira-queue.js'
import { composeJiraJql, JIRA_IN_PROGRESS_LABEL } from './jira-jql.js'

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
    // ./jira-key.js joined the list in #127 (the claim needs the key grammar) and is pure and
    // edgeless like ./jira-jql.js — the test below measures that of both, which is what keeps
    // this pin a statement about the graph rather than about a file count.
    expect(staticImports.sort()).toEqual(['./jira-jql.js', './jira-key.js', 'node:path', 'node:url'])
    expect(importLines.some((line) => line.includes('execa'))).toBe(false)
    expect(code).not.toMatch(/child_process/)
    // The one reference to a spawner is a DYNAMIC import, and there is exactly one of them.
    expect([...code.matchAll(/await import\('execa'\)/g)]).toHaveLength(1)
  })

  it('the pure modules it depends on import nothing at all', () => {
    // Anti-vacuity for the claim above: every static edge out of this module leads to a
    // module with no edges, so the whole library half of the graph is three files.
    for (const pure of ['./jira-jql.js', './jira-key.js']) {
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
  // MEASURED, and this is the one case in this file that the implementation does not pass.
  //
  // `{"fields":{"labels":[{"name":"frontend"},{"name":"p2"}]}}` — an envelope that spells
  // labels as objects rather than as strings — is READ SUCCESSFULLY: `findLabelArray` finds
  // an array, so the "labels are unknown" refusal does not fire. `writableLabels` then drops
  // every entry (there is no text to send), and the recorded write argv is
  //
  //   ['jira','workitem','edit','--key','FOO-123','--labels','in-progress','--yes']
  //
  // which under REPLACE semantics is the ticket's entire new label set. That is the exact
  // wipe the read exists to prevent, arriving through the read: `frontend` and `p2` were
  // read out of acli's own answer and then sent to Jira as nothing.
  //
  // The module already knows the right answer for this class — it refuses `labels:
  // "frontend"` with "its labels are unknown and were left alone", and its header says an
  // unreadable list is "a claim that has to be abandoned, not one to be made
  // optimistically". A list whose every entry was discarded is unreadable in exactly that
  // sense, and the module cannot tell it apart from `labels: []` once `writableLabels` has
  // run. Both send `--labels in-progress`; only one of them is correct.
  // MEASURED, both rows: each sends `--labels in-progress` today, with two exec calls.
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
    // `labels: []` is a common, correct answer and must claim; a list of two entries none of
    // which could be sent is a read that failed and must not. Today both produce the same
    // write.
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
