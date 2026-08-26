import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { digestLogPath, runDigest } from '../lib/digest.js'
import { buildProgress } from '../lib/progress.js'

// #61 — the digest engine against a REAL child process and a REAL filesystem. The
// unit tests in lib/digest.test.js inject `exec`, which proves the wiring but not
// that a prompt survives an OS pipe, that a non-zero exit code arrives as one, or
// that a hanging CLI is actually killed. This file spawns a stub agent CLI off a
// PATH we control (the technique test/loop.codex.test.js uses for the bash loop)
// and asserts the three behaviours the issue calls out: the append, the failure
// path, and the timeout.
//
// `collect` is still injected: the gathering half of `ralph status` probes tmux,
// counts a `gh` queue and reads a lock, and none of that is what this file is
// about. Everything else here is real.

const RUN_ID = 'ralph-stub-run'
const NOW = Date.parse('2026-08-26T04:40:12.500Z')
const LOG_MARKER = 'Editing SettingsRowDescriptor.swift — red phase'
const NARRATIVE = '#031 is in the TDD red phase. Suite went 1454 → 1598 passing.'

let root
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

const record = () => ({
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
})

const METRICS = [
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","issue_number":11,"duration_ms":2520000,"total_cost_usd":3.2}`,
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","issue_number":12,"duration_ms":3000000,"total_cost_usd":4}`,
  '',
].join('\n')

const collect = async () => ({
  root,
  record: record(),
  mode: 'running',
  session: RUN_ID,
  tmuxAlive: true,
  queue: 6,
  metricsText: METRICS,
  now: NOW,
  progress: buildProgress({ metricsText: METRICS, record: record(), queue: 6, now: NOW }),
})

// The real thing, all of it: execa spawning off our PATH, the real fs appending to a
// real .ralph/, and an injected clock so the history stamps are pinned.
const deps = (overrides = {}) => ({
  cwd: root,
  collect,
  exec: execa,
  readFile: readFileSync,
  appendFile: appendFileSync,
  mkdir: mkdirSync,
  now: () => NOW,
  stderr: { write: () => true },
  env: { ...process.env, PATH: `${bindir}:${process.env.PATH}` },
  ...overrides,
})

const historyPath = () => digestLogPath(root)
const history = () => (existsSync(historyPath()) ? readFileSync(historyPath(), 'utf8') : null)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ralph-digest-stub-'))
  bindir = join(root, 'stub-bin')
  mkdirSync(bindir, { recursive: true })
  mkdirSync(join(root, 'logs'), { recursive: true })
  writeFileSync(
    join(root, 'logs', 'ralph-issue-31.log'),
    ['==> Iteration for issue #31', LOG_MARKER, ''].join('\n'),
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('runDigest against a stubbed agent CLI — the append (#61)', () => {
  beforeEach(() => {
    // Captures the prompt it was piped and answers with prose, exactly as
    // `claude -p --output-format text` does.
    writeStub(
      'claude',
      `#!/bin/bash
cat > "${join(root, 'prompt.txt')}"
printf '%s\\n' "$*" > "${join(root, 'argv.txt')}"
echo "${NARRATIVE}"
`,
    )
  })

  it('prints prose, appends one entry, and the prompt arrived whole over the pipe', async () => {
    const result = await runDigest(deps())

    expect(result.status).toBe('ok')
    expect(result.narrative).toBe(NARRATIVE)

    // The prompt reached the CLI on stdin, carrying the context inline.
    const prompt = readFileSync(join(root, 'prompt.txt'), 'utf8')
    expect(prompt).toContain(LOG_MARKER)
    expect(prompt).toContain(RUN_ID)
    expect(prompt).toContain('#031')

    // ...with no tools available to it.
    const argv = readFileSync(join(root, 'argv.txt'), 'utf8')
    expect(argv).toContain('--tools')
    expect(argv).toContain('--model haiku')

    // ...and one history entry, stamped, under .ralph/.
    expect(historyPath()).toBe(join(root, '.ralph', 'digest.log'))
    expect(history()).toContain(NARRATIVE)
    expect(history()).toContain('2026-08-26T04:40:12Z')
    expect(history()).toContain(RUN_ID)
    expect(history()).toContain('#031')
  })

  it('APPENDS across runs — the history reads as the whole night', async () => {
    await runDigest(deps())
    const first = history()
    expect(first).not.toBe(null)

    // A second digest, with a different answer.
    writeStub('claude', `#!/bin/bash\ncat >/dev/null\necho "later: the queue drained"\n`)
    await runDigest(deps())

    const both = history()
    expect(both.startsWith(first)).toBe(true)
    expect(both).toContain(NARRATIVE)
    expect(both).toContain('later: the queue drained')
    expect(both.indexOf(NARRATIVE)).toBeLessThan(both.indexOf('later: the queue drained'))
  })

  it('creates .ralph/ when it does not exist yet', async () => {
    expect(existsSync(join(root, '.ralph'))).toBe(false)
    await runDigest(deps())
    expect(existsSync(join(root, '.ralph', 'digest.log'))).toBe(true)
  })

  it('extracts the prose from a codex-shaped JSONL stream', async () => {
    // The output kind comes from the registry spec, so this is the same engine
    // taking a completely different stdout shape with no agent-specific branch.
    writeStub(
      'codex',
      `#!/bin/bash
cat >/dev/null
echo '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"codex says the queue is stalled"}}'
echo '{"type":"turn.completed"}'
`,
    )
    const result = await runDigest(
      deps({ env: { ...process.env, PATH: `${bindir}:${process.env.PATH}`, RALPH_AGENT: 'codex' } }),
    )
    expect(result.status).toBe('ok')
    expect(result.narrative).toBe('codex says the queue is stalled')
    expect(history()).toContain('codex says the queue is stalled')
  })

  it('honours RALPH_DIGEST_MODEL end to end', async () => {
    await runDigest(
      deps({
        env: { ...process.env, PATH: `${bindir}:${process.env.PATH}`, RALPH_DIGEST_MODEL: 'sonnet' },
      }),
    )
    expect(readFileSync(join(root, 'argv.txt'), 'utf8')).toContain('--model sonnet')
  })
})

describe('runDigest against a stubbed agent CLI — the failure path (#61)', () => {
  it('a non-zero exit writes no history entry and does not throw', async () => {
    writeStub('claude', `#!/bin/bash\ncat >/dev/null\necho "Invalid API key" >&2\nexit 1\n`)
    const result = await runDigest(deps())

    expect(result.status).toBe('failed')
    expect(result.narrative).toBe(null)
    expect(result.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
    expect(existsSync(historyPath())).toBe(false)
  })

  it('an agent that prints nothing at all is a failure, not an empty entry', async () => {
    writeStub('claude', `#!/bin/bash\ncat >/dev/null\nexit 0\n`)
    const result = await runDigest(deps())
    expect(result.status).toBe('failed')
    expect(existsSync(historyPath())).toBe(false)
  })

  it('an uninstalled agent CLI degrades to one diagnostic', async () => {
    // Nothing named `claude` anywhere on this PATH.
    const result = await runDigest(deps({ env: { PATH: bindir } }))
    expect(result.status).toBe('failed')
    expect(existsSync(historyPath())).toBe(false)
  })

  it('a failed digest leaves an EARLIER history entry intact', async () => {
    writeStub('claude', `#!/bin/bash\ncat >/dev/null\necho "${NARRATIVE}"\n`)
    await runDigest(deps())
    const before = history()

    writeStub('claude', `#!/bin/bash\ncat >/dev/null\nexit 7\n`)
    await runDigest(deps())
    expect(history()).toBe(before)
  })
})

describe('runDigest against a stubbed agent CLI — the timeout (#61)', () => {
  it('kills a hanging agent, writes no entry, and says so once', async () => {
    writeStub('claude', `#!/bin/bash\ncat >/dev/null\nsleep 5\n`)
    const started = Date.now()
    const result = await runDigest(deps({ timeout: 500 }))
    const elapsed = Date.now() - started

    expect(result.status).toBe('failed')
    expect(result.diagnostic).toMatch(/timed out/i)
    expect(result.diagnostic.split('\n').filter(Boolean)).toHaveLength(1)
    expect(existsSync(historyPath())).toBe(false)
    // The bound is real: a 5s sleep did not hold the digest for 5s.
    expect(elapsed).toBeLessThan(4000)
  })
})
