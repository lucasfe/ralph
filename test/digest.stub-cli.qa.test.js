import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { digestLogPath, runDigest } from '../lib/digest.js'
import { collectStatus } from '../lib/commands/status.js'
import { buildProgress } from '../lib/progress.js'

// QA augmentation for #61 — the digest engine against a REAL child, a REAL PATH and a
// REAL filesystem. The dev's test/digest.stub-cli.test.js proves the append, one
// failure path and one timeout. What is attacked HERE:
//
//   1. ARGV PER ELEMENT. The dev's stub records `"$*"`, which JOINS argv with spaces —
//      so `--tools ''` and a dropped `--tools` are INDISTINGUISHABLE in that file.
//      This stub records one element per line with a count, which is the only way to
//      see the empty string that disables every tool.
//   2. THE GRANDCHILD THAT HOLDS THE PIPE. Measured: a stub whose child outlives it
//      keeps execa's promise pending long after the child is signalled. That is the
//      case the hard deadline exists for, and it is not the case a plain `sleep 5`
//      exercises.
//   3. A HOSTILE .ralph/. A file where the directory should be, a directory where the
//      history file should be, and a read-only directory — the three shapes a
//      permissions accident actually takes.
//   4. APPEND-NEVER-TRUNCATE FOR REAL. A pre-existing history with no trailing
//      newline, two digests racing, a large existing file, and the ENTRY DELIMITER
//      against the two-paragraph narrative templates/digest.md asks for.
//   5. AC#9 THROUGH THE REAL GATHERER. `collect` is injected in every other digest
//      test, so nothing yet proves what happens when the run-state file on disk is
//      absent, truncated mid-write, or terminal.
//   6. THE PIPE ITSELF. A prompt larger than an OS pipe buffer, a CLI that exits
//      before reading stdin, multibyte content, and stderr that must not leak into
//      the prose.
//   7. AN ACCESSORY THAT TOUCHES NOTHING ELSE. After a successful digest, exactly one
//      path under the project root may be new.
//
// Layout: the project root, the stub bin and the stubs' own scratch files live in
// three SIBLING directories, so a tree walk over the project root sees only what the
// digest itself wrote.

const RUN_ID = 'ralph-stub-qa61'
const NOW = Date.parse('2026-08-26T04:40:12.500Z')
const LOG_MARKER = 'Editing SettingsRowDescriptor.swift — red phase'
const NARRATIVE = '#031 is in the TDD red phase and the run looks healthy.'

let base
let root
let bindir
let scratch

// `/bin:/usr/bin` and nothing else after the stub dir: a real `claude` or `codex`
// installed on this machine must never be reachable from these tests, and the stubs
// still need `cat`.
const stubPath = () => `${bindir}:/bin:/usr/bin`

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

// Records argv ONE ELEMENT PER LINE with a count, so an empty-string element is
// visible as `[]` and a dropped one changes the count.
const argvRecorder = (extra = '') => `#!/bin/bash
printf 'count=%s\\n' "$#" > "${join(scratch, 'argv.txt')}"
for a in "$@"; do printf '[%s]\\n' "$a" >> "${join(scratch, 'argv.txt')}"; done
printf '%s\\n' "$PWD" > "${join(scratch, 'cwd.txt')}"
cat > "${join(scratch, 'prompt.txt')}"
${extra}
echo "${NARRATIVE}"
`

const argv = () => readFileSync(join(scratch, 'argv.txt'), 'utf8')
const argvElements = () =>
  argv()
    .split('\n')
    .filter((l) => l.startsWith('[') && l.endsWith(']'))
    .map((l) => l.slice(1, -1))
const promptSeen = () => readFileSync(join(scratch, 'prompt.txt'), 'utf8')

const record = (overrides = {}) => ({
  schema: 1,
  run_id: RUN_ID,
  session: RUN_ID,
  source: 'github',
  status: 'running',
  started_at: '2026-08-26T01:20:00.000Z',
  queue_at_start: 8,
  current: { number: 31, started_at: '2026-08-26T04:00:00.000Z', iteration: 3 },
  finished_at: null,
  ok: null,
  failed: null,
  ...overrides,
})

const METRICS = [
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","issue_number":11,"duration_ms":2520000,"total_cost_usd":3.2}`,
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","issue_number":12,"duration_ms":3000000,"total_cost_usd":4}`,
  '',
].join('\n')

const collectFor = (rec = record()) => async () => ({
  root,
  record: rec,
  mode: 'running',
  session: RUN_ID,
  tmuxAlive: true,
  queue: 6,
  metricsText: METRICS,
  now: NOW,
  progress: buildProgress({ metricsText: METRICS, record: rec, queue: 6, now: NOW }),
})

const deps = (overrides = {}) => ({
  cwd: root,
  collect: collectFor(),
  exec: execa,
  readFile: readFileSync,
  appendFile: appendFileSync,
  mkdir: mkdirSync,
  now: () => NOW,
  stderr: { write: () => true },
  env: { PATH: stubPath() },
  ...overrides,
})

const historyPath = () => digestLogPath(root)
const history = () => (existsSync(historyPath()) ? readFileSync(historyPath(), 'utf8') : null)

// Every path under the project root, relative and sorted — the before/after snapshot
// that proves a digest is an accessory.
function tree(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    out.push(rel)
    if (statSync(full).isDirectory()) out.push(...tree(full, rel))
  }
  return out
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ralph-digest-qa61-'))
  root = join(base, 'project')
  bindir = join(base, 'bin')
  scratch = join(base, 'scratch')
  for (const d of [root, bindir, scratch, join(root, 'logs')]) mkdirSync(d, { recursive: true })
  writeFileSync(
    join(root, 'logs', 'ralph-issue-31.log'),
    ['==> Iteration for issue #31', LOG_MARKER, ''].join('\n'),
  )
  writeStub('claude', argvRecorder())
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. The argv that actually reached the OS
// ---------------------------------------------------------------------------

describe('QA: the no-tool argv reaches the OS with the empty string intact (#61)', () => {
  it('the child receives 7 arguments, with `--tools` followed by an empty one', async () => {
    // The security property, at the only layer where it counts: not what the builder
    // returned, but what execve got. A `.filter(Boolean)` anywhere in between would
    // hand claude `--tools --output-format` — a flag consuming a flag — and every
    // assertion phrased over the joined string would still pass.
    const result = await runDigest(deps())
    expect(result.status).toBe('ok')

    expect(argv()).toContain('count=7')
    const elements = argvElements()
    expect(elements).toEqual(['-p', '--tools', '', '--output-format', 'text', '--model', 'haiku'])
    expect(elements[elements.indexOf('--tools') + 1]).toBe('')
  })

  it('a model carrying shell metacharacters arrives as ONE argument and executes nothing', async () => {
    const canary = join(scratch, 'pwned')
    const hostile = `haiku; touch ${canary}`
    const result = await runDigest(deps({ env: { PATH: stubPath(), RALPH_DIGEST_MODEL: hostile } }))

    expect(result.status).toBe('ok')
    expect(argv()).toContain('count=7')
    expect(argvElements().at(-1), 'the model was split by a shell').toBe(hostile)
    expect(existsSync(canary), 'the model value was executed').toBe(false)
  })

  it('the child runs at the project root, so its own cwd cannot be a surprise', async () => {
    await runDigest(deps())
    // Compared against the resolved path: macOS temp dirs reach here via the
    // /var → /private/var symlink, and `$PWD` in the child is the resolved one.
    expect(readFileSync(join(scratch, 'cwd.txt'), 'utf8').trim()).toBe(realpathSync(root))
  })

  it('codex gets the `-` stdin marker LAST, after the model', async () => {
    writeStub(
      'codex',
      `#!/bin/bash
printf 'count=%s\\n' "$#" > "${join(scratch, 'argv.txt')}"
for a in "$@"; do printf '[%s]\\n' "$a" >> "${join(scratch, 'argv.txt')}"; done
cat >/dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"codex narrated it"}}'
`,
    )
    const result = await runDigest(
      deps({ env: { PATH: stubPath(), RALPH_AGENT: 'codex', RALPH_DIGEST_MODEL: 'gpt-5-nano' } }),
    )
    expect(result.status).toBe('ok')
    const elements = argvElements()
    expect(elements.at(-1)).toBe('-')
    expect(elements.at(-2)).toBe('gpt-5-nano')
    expect(elements.at(-3)).toBe('-m')
    expect(elements[elements.indexOf('--sandbox') + 1]).toBe('read-only')
  })
})

// ---------------------------------------------------------------------------
// 2. The grandchild that holds the pipe
// ---------------------------------------------------------------------------

describe('QA: a child whose orphan holds stdout is abandoned, not waited on (#61)', () => {
  it('bounds the wait far below the orphan’s own lifetime', async () => {
    // MEASURED: execa's `timeout` signals the CHILD, but its promise settles when
    // STDOUT CLOSES — and here a backgrounded `sleep` inherits that descriptor, so the
    // promise stays pending for the orphan's whole lifetime no matter what became of
    // the child. Probed directly: still unsettled 5s after a 300ms timeout. This is the
    // case a plain `sleep 5` stub cannot reach, and the reason `runDigest` needs a
    // deadline on the WAIT and not just on the child.
    //
    // The orphan is forked FIRST, before stdin is read, so it takes hold within a few
    // ms of exec. What is asserted is the BOUND, not the diagnostic's wording: whether
    // execa's own timeout or the hard deadline wins depends on how fast this machine
    // forks bash, and under a loaded suite the child can still be pre-fork when the
    // first bound fires. The two wordings are pinned deterministically against an
    // injected exec in lib/digest.qa.test.js ('reports a child-level timeout and a
    // pipe-level one as different diagnostics').
    writeStub('claude', `#!/bin/bash\nsleep 8 &\ncat >/dev/null\nexit 0\n`)
    const started = Date.now()
    const result = await runDigest(deps({ timeout: 800 }))
    const elapsed = Date.now() - started

    expect(result.status).toBe('failed')
    expect(result.diagnostic).toMatch(/timed out/i)
    expect(result.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
    expect(existsSync(historyPath())).toBe(false)
    // The child's own bound plus the 2s grace — and nothing like the orphan's 8s, which
    // is exactly how long this wait lasted before the deadline existed.
    expect(elapsed, 'the wait was not bounded — the orphan held it').toBeLessThan(6000)
  })

  it('a digest after an abandoned one still works — nothing is left wedged', async () => {
    writeStub('claude', `#!/bin/bash\nsleep 6 &\ncat >/dev/null\nexit 0\n`)
    expect((await runDigest(deps({ timeout: 300 }))).status).toBe('failed')

    writeStub('claude', argvRecorder())
    const second = await runDigest(deps())
    expect(second.status).toBe('ok')
    expect(history()).toContain(NARRATIVE)
  })
})

// ---------------------------------------------------------------------------
// 3. A hostile .ralph/
// ---------------------------------------------------------------------------

describe('QA: the history file cannot be written, but the digest still answers (#61)', () => {
  const stillNarrates = async () => {
    const result = await runDigest(deps())
    expect(result.status, 'a broken history file cost the narrative').toBe('ok')
    expect(result.narrative).toBe(NARRATIVE)
    expect(result.diagnostic, 'the reader was not told the entry was lost').toMatch(/could not append/i)
    expect(result.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
    return result
  }

  it('a FILE where .ralph/ should be', async () => {
    writeFileSync(join(root, '.ralph'), 'not a directory\n')
    await stillNarrates()
    // ...and the file it found is left exactly as it was.
    expect(readFileSync(join(root, '.ralph'), 'utf8')).toBe('not a directory\n')
  })

  it('a DIRECTORY where digest.log should be', async () => {
    mkdirSync(join(root, '.ralph', 'digest.log'), { recursive: true })
    await stillNarrates()
    expect(statSync(historyPath()).isDirectory()).toBe(true)
  })

  it('a read-only .ralph/', async () => {
    if (process.getuid?.() === 0) return // root ignores the mode bits
    mkdirSync(join(root, '.ralph'), { recursive: true })
    chmodSync(join(root, '.ralph'), 0o500)
    try {
      await stillNarrates()
      expect(existsSync(historyPath())).toBe(false)
    } finally {
      chmodSync(join(root, '.ralph'), 0o700)
    }
  })

  it('an existing history file with no write permission', async () => {
    if (process.getuid?.() === 0) return
    mkdirSync(join(root, '.ralph'), { recursive: true })
    writeFileSync(historyPath(), '── an earlier entry ───\nprose\n\n')
    chmodSync(historyPath(), 0o400)
    try {
      await stillNarrates()
      // The earlier night's history is not damaged by the attempt.
      expect(readFileSync(historyPath(), 'utf8')).toBe('── an earlier entry ───\nprose\n\n')
    } finally {
      chmodSync(historyPath(), 0o600)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Append, never truncate (AC#7)
// ---------------------------------------------------------------------------

describe('QA: the history file is only ever appended to (#61)', () => {
  it('appends after a history file that was left without a trailing newline', async () => {
    // A digest interrupted mid-append, or a file a human edited, leaves the last line
    // unterminated. The new entry's heading has to START a line, or every `grep '^──'`
    // over the history silently misses it — and the two entries read as one.
    mkdirSync(join(root, '.ralph'), { recursive: true })
    writeFileSync(historyPath(), '── 2026-08-25T23:00:00Z · run older · #030 ───\ntruncated mid-write')

    const result = await runDigest(deps())
    expect(result.status).toBe('ok')

    const lines = history().split('\n')
    const headings = lines.filter((l) => l.startsWith('── '))
    expect(headings, 'the new heading was glued onto the previous line').toHaveLength(2)
    expect(headings[1]).toContain(RUN_ID)
  })

  it('a TWO-PARAGRAPH narrative — the shape templates/digest.md asks for — stays ONE entry', async () => {
    // The template says "two short paragraphs at most", and the entry delimiter is a
    // blank line. One digest must still be one block, or a night of digests cannot be
    // split back into digests by the delimiter the format chose.
    writeStub(
      'claude',
      `#!/bin/bash
cat >/dev/null
printf '%s\\n\\n%s\\n' "The run is on #031, editing SettingsRowDescriptor.swift." "Nothing looks wrong."
`,
    )
    const result = await runDigest(deps())
    expect(result.status).toBe('ok')

    const blocks = history()
      .split('\n\n')
      .filter((b) => b.trim() !== '')
    expect(blocks, 'one digest produced more than one delimited entry').toHaveLength(1)
  })

  it('two digests racing both survive, and neither truncates the other', async () => {
    writeStub('claude', `#!/bin/bash\ncat >/dev/null\necho "digest from pid $$"\n`)
    const [a, b] = await Promise.all([runDigest(deps()), runDigest(deps())])

    expect([a.status, b.status]).toEqual(['ok', 'ok'])
    const text = history()
    expect(text.match(/^── /gm), 'a concurrent append lost an entry').toHaveLength(2)
    expect(new Set(text.match(/digest from pid \d+/g)).size).toBe(2)
  })

  it('a large existing history is kept byte-for-byte as a prefix', async () => {
    mkdirSync(join(root, '.ralph'), { recursive: true })
    const existing = Array.from({ length: 4000 }, (_, i) => `── night ${i} ───\nentry ${i}\n`).join('\n')
    writeFileSync(historyPath(), existing)

    await runDigest(deps())
    const after = history()
    expect(after.startsWith(existing), 'the existing history was rewritten').toBe(true)
    expect(after.slice(existing.length)).toContain(NARRATIVE)
  })

  it('a narrative that is itself a fenced code block does not corrupt the file', async () => {
    writeStub(
      'claude',
      `#!/bin/bash
cat >/dev/null
printf '%s\\n' 'The log shows: \`\`\`' 'not-a-heading' '\`\`\` and it looks fine.'
`,
    )
    const result = await runDigest(deps())
    expect(result.status).toBe('ok')
    expect(history().match(/^── /gm)).toHaveLength(1)
    expect(history()).toContain('not-a-heading')
  })
})

// ---------------------------------------------------------------------------
// 5. AC#9 through the REAL gatherer
// ---------------------------------------------------------------------------

describe('QA: no active run, read off a real .ralph/run-state.json (#61)', () => {
  // The real gathering half of `ralph status`. `collect` is injected in every other
  // digest test, so nothing else proves that a missing or corrupt run-state file
  // reaches the no-run gate rather than an exception.
  const realDeps = (overrides = {}) => deps({ collect: collectStatus, ...overrides })
  const spawned = () => existsSync(join(scratch, 'argv.txt'))

  it('no .ralph/ at all: no spawn, no history, one diagnostic', async () => {
    const result = await runDigest(realDeps())
    expect(result.status).toBe('no-run')
    expect(spawned(), 'a model was asked to narrate a project that never ran').toBe(false)
    expect(existsSync(historyPath())).toBe(false)
    expect(existsSync(join(root, '.ralph')), '.ralph/ was created for nothing').toBe(false)
    expect(result.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
  })

  it.each([
    ['truncated mid-write', '{"schema":1,"run_id":"x","current":{"number":3'],
    ['empty', ''],
    ['whitespace', '   \n\n'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON scalar', '"running"'],
    ['not JSON at all', 'RALPH_RUN_STATE=running\n'],
  ])('a %s run-state file reads as no run, not as an error', async (_label, content) => {
    mkdirSync(join(root, '.ralph'), { recursive: true })
    writeFileSync(join(root, '.ralph', 'run-state.json'), content)

    const result = await runDigest(realDeps())
    expect(result.status).toBe('no-run')
    expect(spawned()).toBe(false)
    expect(existsSync(historyPath())).toBe(false)
  })

  it('a TERMINAL record is narrated — that is what the history file is for', async () => {
    // idle and interrupted are deliberately NOT the no-run case: a run that has just
    // finished is exactly the thing somebody asks about in the morning. A terminal
    // status also keeps the gatherer off `gh`, so this stays hermetic.
    mkdirSync(join(root, '.ralph'), { recursive: true })
    writeFileSync(
      join(root, '.ralph', 'run-state.json'),
      JSON.stringify(record({ status: 'partial', finished_at: '2026-08-26T04:30:00.000Z', ok: [11], failed: [12] })),
    )

    const result = await runDigest(realDeps())
    expect(result.status).toBe('ok')
    expect(spawned()).toBe(true)
    expect(history()).toContain(NARRATIVE)
    // The mode the model was told, and the record it was shown, are the real ones.
    expect(promptSeen()).toContain('idle')
    expect(promptSeen()).toContain('"status": "partial"')
    // ...and a temp dir is not a repo, which is a fact and not a failure.
    expect(promptSeen()).toMatch(/git reported nothing|## /)
  })
})

// ---------------------------------------------------------------------------
// 6. The pipe itself
// ---------------------------------------------------------------------------

describe('QA: the prompt over a real OS pipe (#61)', () => {
  it('arrives byte-identical, even well past the pipe buffer', async () => {
    // A 64KB pipe buffer means a large prompt is written in several chunks while the
    // child reads. Anything that got the ordering wrong would truncate it silently.
    const bulky = record({ ok: Array.from({ length: 20000 }, (_, i) => i) })
    const result = await runDigest(deps({ collect: collectFor(bulky) }))

    expect(result.status).toBe('ok')
    expect(result.prompt.length, 'the prompt never got large enough to test this').toBeGreaterThan(
      200000,
    )
    expect(promptSeen()).toBe(result.prompt)
  })

  it('a CLI that answers and exits WITHOUT reading stdin degrades, never hangs', async () => {
    // The realistic shape of a rejected flag or a failed auth check: the CLI prints and
    // exits while Ralph is still writing 200KB into its stdin, so the write gets EPIPE.
    writeStub('claude', `#!/bin/bash\necho "I did not read your prompt" >&2\nexit 2\n`)
    const bulky = record({ ok: Array.from({ length: 20000 }, (_, i) => i) })

    const started = Date.now()
    const result = await runDigest(deps({ collect: collectFor(bulky), timeout: 3000 }))
    expect(Date.now() - started, 'an unread stdin hung the digest').toBeLessThan(4000)
    expect(result.status).toBe('failed')
    expect(result.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
    expect(existsSync(historyPath())).toBe(false)
  })

  it('multibyte log content crosses the pipe without a replacement character', async () => {
    writeFileSync(
      join(root, 'logs', 'ralph-issue-31.log'),
      `${'é'.repeat(9000)}\n${LOG_MARKER} — 完了 🎉\n`,
    )
    const result = await runDigest(deps())
    expect(result.status).toBe('ok')
    expect(promptSeen(), 'truncation corrupted a character').not.toContain('�')
    expect(promptSeen()).toContain('完了 🎉')
  })

  it('the agent’s stderr never becomes the narrative or an entry', async () => {
    writeStub(
      'claude',
      `#!/bin/bash
cat >/dev/null
echo "WARNING: your CLI is out of date" >&2
echo "${NARRATIVE}"
echo "another WARNING" >&2
`,
    )
    const result = await runDigest(deps())
    expect(result.narrative).toBe(NARRATIVE)
    expect(history()).not.toContain('WARNING')
    // A successful digest with noisy stderr has nothing to report.
    expect(result.diagnostic).toBe(null)
  })

  it('the assembled context carries the progress figures AC#4 asks for', async () => {
    await runDigest(deps())
    const prompt = promptSeen()
    // The in-flight task and its log tail...
    expect(prompt).toContain(LOG_MARKER)
    expect(prompt).toContain(join(root, 'logs', 'ralph-issue-31.log'))
    // ...the run record...
    expect(prompt).toContain('"queue_at_start": 8')
    // ...and the snapshot's key figures, by the names `ralph status --json` uses.
    for (const key of ['per_task_min', 'remaining_min', 'finish_at', 'projected_usd', 'samples']) {
      expect(prompt, `the model was not shown ${key}`).toContain(key)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. An accessory touches nothing else
// ---------------------------------------------------------------------------

describe('QA: a digest writes exactly one file and changes nothing else (#61)', () => {
  it('adds only .ralph/ and .ralph/digest.log to the project root', async () => {
    const before = tree(root)
    const logBefore = readFileSync(join(root, 'logs', 'ralph-issue-31.log'), 'utf8')

    const result = await runDigest(deps())
    expect(result.status).toBe('ok')

    const added = tree(root).filter((p) => !before.includes(p))
    expect(added.sort()).toEqual(['.ralph', '.ralph/digest.log'])
    // The in-flight log it read is untouched — a digest reads a run, it never edits one.
    expect(readFileSync(join(root, 'logs', 'ralph-issue-31.log'), 'utf8')).toBe(logBefore)
  })

  it('a FAILED digest adds nothing at all', async () => {
    writeStub('claude', `#!/bin/bash\ncat >/dev/null\necho "Invalid API key" >&2\nexit 1\n`)
    const before = tree(root)
    const result = await runDigest(deps())

    expect(result.status).toBe('failed')
    expect(tree(root).filter((p) => !before.includes(p)), 'a failed digest left debris').toEqual([])
  })

  it('the git it runs is read-only: nothing is staged, committed or stashed', async () => {
    // A real repo this time, so `git status` and `git log` actually answer — and so the
    // index is a thing that could be damaged.
    const g = (...args) => execa('git', args, { cwd: root, reject: false })
    await g('init', '-q')
    await g('config', 'user.email', 'qa@example.com')
    await g('config', 'user.name', 'QA')
    writeFileSync(join(root, 'a.txt'), 'one\n')
    await g('add', 'a.txt')
    await g('commit', '-q', '-m', 'first')
    writeFileSync(join(root, 'a.txt'), 'two\n')

    const before = (await g('status', '--porcelain')).stdout
    const headBefore = (await g('rev-parse', 'HEAD')).stdout

    const result = await runDigest(deps())
    expect(result.status).toBe('ok')

    // `.ralph/digest.log` is the one new untracked path; everything else is as it was.
    const after = (await g('status', '--porcelain')).stdout
    expect(after.replace(/^\?\? \.ralph\/\n?/m, '')).toBe(before)
    expect((await g('rev-parse', 'HEAD')).stdout).toBe(headBefore)
    expect((await g('stash', 'list')).stdout).toBe('')
    // ...and the model was shown the real branch line, which is what AC#4 wants.
    expect(promptSeen()).toMatch(/^## /m)
    expect(promptSeen()).toContain('first')
  })
})

// ---------------------------------------------------------------------------
// 8. Codex's JSONL, from a real stream
// ---------------------------------------------------------------------------

describe('QA: codex JSONL off a real pipe (#61)', () => {
  const codexStub = (lines, exit = 0) =>
    writeStub(
      'codex',
      `#!/bin/bash\ncat >/dev/null\n${lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join('\n')}\nexit ${exit}\n`,
    )
  const codexDeps = (overrides = {}) =>
    deps({ env: { PATH: stubPath(), RALPH_AGENT: 'codex' }, ...overrides })

  it('a stream of nothing but tool events is a failure, not an entry of JSON', async () => {
    codexStub([
      '{"type":"item.completed","item":{"type":"command_execution","command":"git status"}}',
      '{"type":"item.completed","item":{"type":"error","message":"read-only sandbox denied a write"}}',
      '{"type":"turn.failed"}',
    ])
    const result = await runDigest(codexDeps())
    expect(result.status).toBe('failed')
    expect(existsSync(historyPath()), 'a screenful of JSONL was appended as prose').toBe(false)
  })

  it('a stream truncated mid-line keeps the last complete message', async () => {
    writeStub(
      'codex',
      `#!/bin/bash
cat >/dev/null
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"the complete answer"}}'
printf '%s' '{"type":"item.completed","item":{"type":"agent_mess'
`,
    )
    const result = await runDigest(codexDeps())
    expect(result.status).toBe('ok')
    expect(result.narrative).toBe('the complete answer')
    expect(history()).toContain('the complete answer')
  })

  it('a message carrying a template placeholder is stored verbatim, not interpolated', async () => {
    codexStub([
      '{"type":"item.completed","item":{"type":"agent_message","text":"the log mentions {{RUN_STATE}} literally"}}',
    ])
    const result = await runDigest(codexDeps())
    expect(result.narrative).toBe('the log mentions {{RUN_STATE}} literally')
    expect(history()).toContain('{{RUN_STATE}}')
  })

  it('a non-zero exit with a valid message on stdout is still a failure', async () => {
    // The exit code is authoritative: a codex that printed prose and then died did not
    // finish looking, and half an answer in the history reads as a whole one.
    codexStub(
      ['{"type":"item.completed","item":{"type":"agent_message","text":"half an answer"}}'],
      3,
    )
    const result = await runDigest(codexDeps())
    expect(result.status).toBe('failed')
    expect(existsSync(historyPath())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 9. The entry format on a REAL file, across appends — the round-2 fix. The format
//    is now self-delimiting by construction: the body is indented and the append
//    leads with a newline. Both claims are about bytes on disk, so they are checked
//    on disk, with the two counts a reader actually uses (`grep '^── '` for entries
//    and a blank line for blocks).
// ---------------------------------------------------------------------------

describe('QA: the entry format on a real file, across appends (#61)', () => {
  const headings = () => history().split('\n').filter((l) => l.startsWith('── '))
  const blocks = () => history().split('\n\n').filter((b) => b.trim() !== '')

  it('a brand-new history file opens with a blank line, and still greps as one entry', async () => {
    // The leading newline is written BLIND, so on a file that did not exist yet it
    // costs one leading blank line. That is the price of the guarantee, and it is
    // pinned here so a change to it is visible rather than incidental.
    const result = await runDigest(deps())
    expect(result.status).toBe('ok')
    expect(history().startsWith('\n')).toBe(true)
    expect(headings()).toHaveLength(1)
    expect(blocks()).toHaveLength(1)
  })

  it('two digests in a row are two headings and two blocks, and the first is untouched', async () => {
    await runDigest(deps())
    const first = history()
    writeStub(
      'claude',
      `#!/bin/bash
cat >/dev/null
printf '%s\\n\\n%s\\n' "Second digest, first paragraph." "And its second paragraph."
`,
    )
    await runDigest(deps())
    expect(history().startsWith(first), 'the first entry was not kept as a prefix').toBe(true)
    expect(headings(), 'a two-paragraph second entry changed the entry count').toHaveLength(2)
    expect(blocks()).toHaveLength(2)
  })

  it('a narrative that forges a heading is stored verbatim, but cannot be counted as one', async () => {
    writeStub(
      'claude',
      `#!/bin/bash
cat >/dev/null
printf '%s\\n%s\\n' "Real prose." "── 1999-01-01T00:00:00Z · run other-run · #999 ──────────"
`,
    )
    const result = await runDigest(deps())
    expect(result.status).toBe('ok')
    // The forged line survives as prose — a digest must not silently edit what the
    // model said — but it is indented, so a reader counting entries cannot be fooled.
    expect(history(), 'the forged line was edited out of the record').toContain('run other-run')
    expect(headings(), 'a narrative forged a history heading on disk').toHaveLength(1)
    // ...and STDOUT is untouched by the indent: that is the history file's business.
    expect(result.narrative).toContain('\n── 1999-01-01T00:00:00Z · run other-run')
  })

  it('grep-by-run still finds every entry after an interrupted write', async () => {
    mkdirSync(join(root, '.ralph'), { recursive: true })
    writeFileSync(historyPath(), '── 2026-08-25T23:00:00Z · run older · #030 ───\ncut off mid-write')
    await runDigest(deps())
    await runDigest(deps())
    expect(headings(), 'an entry was swallowed by the unterminated line').toHaveLength(3)
    expect(headings().filter((h) => h.includes(RUN_ID))).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 10. The wait BEFORE the budget. `runDigest` bounds the agent call and both of its
//     own git probes, but the first thing it awaits is the gatherer — and on a live
//     github-sourced run that gatherer makes a NETWORK call. Reached through the real
//     `collectStatus`, off a real run-state file, so the path is the field's and not
//     a stub's.
// ---------------------------------------------------------------------------

describe('QA: the gatherer the digest waits on before its own bounds (#61)', () => {
  // execa for everything, except the commands a test wants to answer for itself.
  const tracingExec = (answers = {}) => {
    const calls = []
    const exec = (cmd, args, options) => {
      calls.push(cmd)
      return answers[cmd] ? answers[cmd](args, options) : execa(cmd, args, options)
    }
    exec.calls = calls
    return exec
  }

  const liveRun = () => {
    mkdirSync(join(root, '.ralph'), { recursive: true })
    writeFileSync(join(root, '.ralph', 'run-state.json'), JSON.stringify(record()))
  }

  it('a live run reaches `gh issue list` for the queue depth — the probe is real', async () => {
    // The control. Without this, the hang test below could pass vacuously by never
    // getting near the network at all.
    liveRun()
    const exec = tracingExec({
      tmux: () => Promise.resolve({ exitCode: 0, stdout: '' }),
      gh: () => Promise.resolve({ exitCode: 0, stdout: '4\n' }),
    })
    const result = await runDigest(deps({ collect: collectStatus, exec }))
    expect(result.status).toBe('ok')
    expect(exec.calls, 'the queue is not counted over the network after all').toContain('gh')
    expect(promptSeen()).toContain('running')
  })

  it('a `gh` that never answers cannot hang the digest', async () => {
    // `collectStatus` awaits `git rev-parse`, `tmux has-session` and `gh issue list`
    // with no timeout on any of them, and `runDigest` awaits it before the budget it
    // derives its own bounds from. `gh` is the one that talks to a network — a captive
    // portal, a hung TLS handshake, a credential helper on a tty — so this WAS the
    // remaining way `ralph digest` never returned. `runDigest` now races the gatherer
    // against a share of the timeout: 500ms here, so it gives up at ~83ms and the
    // 1500ms sentinel is ~18x that — it can only fire on a genuine regression.
    liveRun()
    const exec = tracingExec({
      tmux: () => Promise.resolve({ exitCode: 0, stdout: '' }),
      gh: () => new Promise(() => {}),
    })
    const outcome = await Promise.race([
      runDigest(deps({ collect: collectStatus, exec, timeout: 500 })),
      new Promise((resolve) => setTimeout(() => resolve('NEVER-RETURNED'), 1500)),
    ])
    expect(outcome, 'ralph digest hung on the queue probe, before any of its own bounds')
      .not.toBe('NEVER-RETURNED')
    // ...and it gave up for the RIGHT reason. A silent network probe is a failure to
    // report, not a run that is suddenly absent: `no-run` here would mean the digest
    // had quietly reinterpreted a hung `gh` as "nothing is running".
    expect(outcome.status, 'a hung queue probe was reported as no run at all').toBe('failed')
    expect(outcome.diagnostic).toMatch(/run state/i)
    expect(outcome.narrative, 'a narrative was invented without a run state').toBe(null)
    expect(exec.calls, 'the agent was spawned with no run state to talk about')
      .not.toContain('claude')
    expect(history(), 'a digest with no run state still reached the history file').toBe(null)
  })
})
