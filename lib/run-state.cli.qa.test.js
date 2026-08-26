import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// QA augmentation for #55, CLI surface. lib/run-state.js is not only a library:
// templates/ralph.sh shells out to it three times per run, so the CLI is the
// interface the loop actually depends on and NOTHING covered it. What matters
// here is not the record (run-state.test.js owns that) but the process contract:
//
//   * bad invocations exit 2 with a usage line, matching folder-queue.js
//   * a write failure exits non-zero with ONE terse stderr line and NO stack
//     trace — this runs inside the tmux pane a human is watching
//   * `read` exits 0 and prints nothing on unusable input (never throws)
//   * the writing subcommands print NOTHING to stdout — the loop interleaves
//     their output with its own, and a future `$(...)` capture must stay safe
//   * bash-supplied strings ('' for a failed count, '' for a missing arg) land
//     as null rather than as an invented 0
//
// Hermetic: every invocation gets a throwaway project root under the OS temp dir
// and run-state.js reads no environment variable at all.

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'run-state.js')
const USAGE = 'usage: run-state.js <begin|begin-task|end|read> <projectRoot> [args]'

let sandbox
let root

function cli(...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: 15000,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const recordOf = (dir = root) =>
  JSON.parse(readFileSync(join(dir, '.ralph', 'run-state.json'), 'utf8'))

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ralph-runstate-cli-'))
  root = join(sandbox, 'project')
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
})

describe('run-state.js CLI — bad invocations (#55 QA)', () => {
  const badArgv = {
    'no arguments at all': [],
    'a subcommand with no project root': ['begin'],
    'begin-task with no project root': ['begin-task'],
    'an empty-string subcommand': ['', '/tmp/whatever'],
  }

  for (const [label, argv] of Object.entries(badArgv)) {
    it(`exits 2 with the usage line for ${label}`, () => {
      const res = cli(...argv)
      expect(res.status).toBe(2)
      expect(res.stderr.trim()).toBe(USAGE)
      expect(res.stdout).toBe('')
    })
  }

  it('exits 2 naming an unknown subcommand', () => {
    const res = cli('bogus', root)
    expect(res.status).toBe(2)
    expect(res.stderr.trim()).toBe("run-state.js: unknown command 'bogus'")
    expect(existsSync(join(root, '.ralph'))).toBe(false)
  })

  it('treats a flag as an unknown subcommand instead of parsing it', () => {
    // No flag parser here on purpose; the guarantee is that a flag can never be
    // mistaken for a write and never produces a stack trace.
    for (const flag of ['--help', '-h', '--begin']) {
      const res = cli(flag, root)
      expect(res.status, flag).toBe(2)
      expect(res.stderr, flag).toContain(`unknown command '${flag}'`)
    }
    expect(existsSync(join(root, '.ralph'))).toBe(false)
  })

  it('refuses an EMPTY project root rather than writing into the cwd', () => {
    // The loop always passes "$PROJECT_ROOT", but an unset variable under a
    // future `set +u` would arrive as ''. Writing `.ralph/` into whatever
    // directory the loop happens to sit in would be the wrong kind of helpful.
    const res = cli('begin', '', 'run-1', 'sess', 'github', '3')
    expect(res.status).toBe(2)
    expect(res.stderr.trim()).toBe(USAGE)
    expect(readdirSync(sandbox)).toEqual(['project'])
    expect(existsSync(join(sandbox, '.ralph'))).toBe(false)
  })

  it('ignores extra trailing arguments instead of failing the run', () => {
    const res = cli('begin', root, 'run-1', 'sess', 'github', '3', 'extra', 'junk')
    expect(res.status).toBe(0)
    expect(recordOf()).toMatchObject({ run_id: 'run-1', queue_at_start: 3 })
  })
})

describe('run-state.js CLI — the writing subcommands are silent on stdout (#55 QA)', () => {
  it('begin, begin-task and end print nothing and exit 0', () => {
    for (const argv of [
      ['begin', root, 'run-1', 'sess', 'github', '3'],
      ['begin-task', root, '31', '1'],
      ['end', root, 'success', '1', '0'],
    ]) {
      const res = cli(...argv)
      expect(res.status, argv[0]).toBe(0)
      expect(res.stdout, argv[0]).toBe('')
      expect(res.stderr, argv[0]).toBe('')
    }
  })

  it('creates .ralph/ under the given root, and only there', () => {
    cli('begin', root, 'run-1', 'sess', 'folder', '2')
    expect(existsSync(join(root, '.ralph', 'run-state.json'))).toBe(true)
    expect(existsSync(join(sandbox, '.ralph'))).toBe(false)
  })

  it('read prints the record as ONE line of JSON and exits 0', () => {
    cli('begin', root, 'run-1', 'sess', 'github', '3')
    const res = cli('read', root)
    expect(res.status).toBe(0)
    expect(res.stdout.trimEnd().split('\n').length).toBe(1)
    expect(JSON.parse(res.stdout)).toMatchObject({ run_id: 'run-1', status: 'running' })
  })
})

describe('run-state.js CLI — bash string arguments (#55 QA)', () => {
  it('an empty queue depth becomes unknown (null), a "0" stays 0', () => {
    cli('begin', root, 'run-1', 'sess', 'github', '')
    expect(recordOf().queue_at_start).toBe(null)
    cli('begin', root, 'run-1', 'sess', 'github', '0')
    expect(recordOf().queue_at_start).toBe(0)
  })

  it('begin with only a run id leaves the remaining run fields null, not "undefined"', () => {
    // `set -u` makes this hard to reach from the loop, but a partially expanded
    // invocation must not stringify undefined into the record.
    const res = cli('begin', root, 'run-1')
    expect(res.status).toBe(0)
    expect(recordOf()).toMatchObject({
      run_id: 'run-1',
      session: null,
      source: null,
      queue_at_start: null,
      status: 'running',
    })
  })

  it('begin-task with no number or iteration records nulls and still exits 0', () => {
    const res = cli('begin-task', root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe('')
    expect(recordOf().current).toMatchObject({ number: null, iteration: null })
    expect(Number.isFinite(Date.parse(recordOf().current.started_at))).toBe(true)
  })

  it('begin-task with a non-numeric task number records null rather than 0', () => {
    cli('begin-task', root, 'null', '1')
    expect(recordOf().current.number).toBe(null)
    cli('begin-task', root, '#31', '1')
    expect(recordOf().current.number).toBe(null)
    cli('begin-task', root, '031', '2')
    expect(recordOf().current).toMatchObject({ number: 31, iteration: 2 })
  })

  it('end with no status records "unknown" — never a status that reads as running', () => {
    const res = cli('end', root)
    expect(res.status).toBe(0)
    expect(recordOf().status).toBe('unknown')
    expect(recordOf().status).not.toBe('running')
  })
})

describe('run-state.js CLI — failures stay terse and non-fatal (#55 QA)', () => {
  // A directory where the record belongs: every write fails at the leaf while
  // the rest of .ralph/ stays writable, which is the shape the loop's
  // best-effort guarantee has to survive.
  const block = () => mkdirSync(join(root, '.ralph', 'run-state.json'), { recursive: true })

  it('a failed write exits 1 with ONE line of stderr and no stack trace', () => {
    block()
    for (const argv of [
      ['begin', root, 'run-1', 'sess', 'github', '3'],
      ['begin-task', root, '31', '1'],
      ['end', root, 'success', '1', '0'],
    ]) {
      const res = cli(...argv)
      expect(res.status, argv[0]).toBe(1)
      expect(res.stdout, argv[0]).toBe('')
      const lines = res.stderr.trimEnd().split('\n')
      expect(lines.length, `${argv[0]} stderr:\n${res.stderr}`).toBe(1)
      expect(lines[0]).toMatch(new RegExp(`^run-state\\.js: ${argv[0]} failed \\(.*\\)$`))
      // The distinguishing marks of an unhandled throw: a node stack frame, the
      // "Error:" header, or the ERR_* code node prints with them.
      expect(res.stderr).not.toMatch(/\n\s+at /)
      expect(res.stderr).not.toContain('node:internal')
      expect(res.stderr).not.toContain('throw')
    }
  })

  it('read exits 0 and prints nothing when a directory sits where the record belongs', () => {
    block()
    const res = cli('read', root)
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
  })

  it('read exits 0 and prints nothing for missing, empty and truncated records', () => {
    const file = join(root, '.ralph', 'run-state.json')
    // Missing.
    expect(cli('read', root)).toMatchObject({ status: 0, stdout: '', stderr: '' })
    mkdirSync(dirname(file), { recursive: true })
    for (const content of ['', '   \n', '{"run_id":"run-1","stat', 'not json', '[]', 'null']) {
      writeFileSync(file, content)
      const res = cli('read', root)
      expect(res.status, JSON.stringify(content)).toBe(0)
      expect(res.stdout, JSON.stringify(content)).toBe('')
      expect(res.stderr, JSON.stringify(content)).toBe('')
    }
  })

  it('read exits 0 for a root that does not exist at all', () => {
    const res = cli('read', join(sandbox, 'no', 'such', 'place'))
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('a write into a nonexistent root creates the tree (mkdir -p, exit 0)', () => {
    const deep = join(sandbox, 'brand', 'new', 'root')
    const res = cli('begin', deep, 'run-1', 'sess', 'github', '1')
    expect(res.status).toBe(0)
    expect(recordOf(deep)).toMatchObject({ run_id: 'run-1' })
  })
})
