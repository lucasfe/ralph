import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Volume } from 'memfs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beginRun, beginTask, readRunState } from './run-state.js'

// QA augmentation for #222, the WRITER's side. lib/run-state.test.js owns the field's
// contract (recorded, verbatim, present-and-null, replaced every iteration) and
// lib/run-state.cli.qa.test.js owns one row of the new argument. What is left is the part
// the loop leans on and neither file asks about:
//
//   1. THE 5TH ARGUMENT IS POSITIONAL, WITH NO PARSER BEHIND IT. `runCli` destructures
//      `rest`, so a path is whatever bash handed over — including a value that LOOKS like a
//      flag, a value nobody meant to send, and a 6th argument from a future loop. None of
//      those may become an option, a refusal, or a record with the wrong field in it.
//   2. A LEGACY RECORD IS READ-MODIFY-WRITTEN, NOT MERGED. `current` is rebuilt whole on
//      every `beginTask`, which is what stops a previous task's path lingering — and also
//      what decides what happens to a `current` a human hand-edited. Asserted for the
//      record written before #222 existed, which is the compatibility case the issue names,
//      and for a second `beginTask` that has no worktree to record.
//   3. THE RECORD IS DATA, NEVER CODE. It is JSON, so a path carrying a quote, a newline or
//      a backslash has to come back out of `readRunState` as the same string — a path is the
//      first value in this record that can contain a Windows-style backslash or a space.
//   4. ONLY A STRING IS A PATH. `textOrNull` is the whole rule, so every non-string a
//      library caller can reach it with is `null` rather than a coerced `"42"` — the record
//      says "no directory" rather than naming one that cannot exist.
//
// Hermetic: memfs for the library half, a throwaway temp root for the CLI half (which has
// to spawn, because argv handling is the thing under test).

const ROOT = '/repo'
const PATH = `${ROOT}/.ralph/run-state.json`
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'run-state.js')

const vol = (json = {}) => Volume.fromJSON(json)
const onDisk = (v) => JSON.parse(v.readFileSync(PATH, 'utf8').toString())

const WORKTREE = '/repo/.ralph/worktrees/issue-31'
const CURRENT_KEYS = ['number', 'task_key', 'started_at', 'iteration', 'worktree']

// The record a machine that upgraded MID-RUN has on disk: written by the pre-#222 writer,
// so `current` has four keys and no `worktree` among them.
const LEGACY = {
  schema: 1,
  run_id: 'run-1',
  session: 'ralph-repo-1',
  source: 'github',
  status: 'running',
  started_at: '2026-08-25T16:20:00.000Z',
  queue_at_start: 6,
  current: { number: 30, task_key: null, started_at: '2026-08-25T18:00:00.000Z', iteration: 2 },
  finished_at: null,
  ok: null,
  failed: null,
}

describe('beginTask — only a string is a path (#222 QA)', () => {
  it('records null for every other type, rather than coercing one into a directory', () => {
    // `textOrNull` tests `typeof value === 'string'` first, and that order is the assertion:
    // the CLI can only ever hand over a string, but this is an exported function and a
    // number is exactly what a caller reaching for `number`/`iteration`'s coercion would
    // pass. `"42"` recorded as a path would send `ralph status` — and a reader after it — to
    // a directory that cannot exist.
    const v = vol()
    for (const worktree of [42, 0, true, false, {}, [], ['/repo'], new Date(), NaN, () => '/repo']) {
      beginTask(ROOT, { number: 31, iteration: 1, worktree }, v)
      expect(onDisk(v).current.worktree, String(worktree)).toBe(null)
      expect(Object.keys(onDisk(v).current), String(worktree)).toEqual(CURRENT_KEYS)
    }
  })

  it('records the whitespace INSIDE a path and refuses a path that is only whitespace', () => {
    // Blankness is decided on the trimmed text and the value is then written untrimmed, which
    // is two rules rather than one: `'   '` is a half-expanded variable, while `'/repo/my
    // dir/'` and even `'/repo/dir '` are directories somebody really has. The record's job is
    // to say what the loop measured, so the trailing space stays — it is part of the name.
    const v = vol()
    for (const blank of ['   ', '\t', '\n', ' \t\n ']) {
      beginTask(ROOT, { number: 31, iteration: 1, worktree: blank }, v)
      expect(onDisk(v).current.worktree, JSON.stringify(blank)).toBe(null)
    }
    for (const path of ['/repo/my dir/issue-1', '/repo/dir ', ' /repo/dir', '/repo/two  spaces']) {
      beginTask(ROOT, { number: 31, iteration: 1, worktree: path }, v)
      expect(onDisk(v).current.worktree, JSON.stringify(path)).toBe(path)
    }
  })

  it('round-trips a path through JSON that could otherwise close the string', () => {
    // The record is written with `JSON.stringify` and read with `JSON.parse`, and a path is
    // the first value in it that can hold a backslash: `\` is an escape on the way out and
    // has to survive the way back in. A corrupted record here is not a wrong path — it is no
    // record at all for every reader, `ralph status` included, because the parse fails.
    const v = vol()
    for (const path of [
      '/repo/say "hi"/issue-1',
      '/repo/back\\slash/issue-1',
      '/repo/two\nlines',
      '/repo/tab\there',
      '/repo/' + String.fromCharCode(27) + '[31m/issue-1',
      '/repo/' + String.fromCharCode(0) + '/issue-1',
      '/repo/ünïcødé/issue-1',
    ]) {
      beginTask(ROOT, { number: 31, iteration: 1, worktree: path }, v)
      expect(readRunState(ROOT, v).current.worktree, JSON.stringify(path)).toBe(path)
    }
  })
})

describe('beginTask over a record written before the field existed (#222 QA)', () => {
  it('leaves a coherent record when the next iteration has no worktree either', () => {
    // The sibling suite fills the field in from a legacy record; this is the other half of
    // that upgrade, and the one a jira run takes on every iteration: the writer is new, the
    // value is absent. The field must appear ANYWAY — present-and-null is what lets both
    // renderers key on `worktree === null` instead of probing for the key — and every run
    // field the older writer left has to survive the read-modify-write.
    const v = vol({ [PATH]: JSON.stringify(LEGACY, null, 2) + '\n' })
    beginTask(ROOT, { number: 31, iteration: 3 }, v)
    const after = onDisk(v)
    expect(Object.keys(after.current)).toEqual(CURRENT_KEYS)
    expect(after.current.worktree).toBe(null)
    expect(after).toMatchObject({
      schema: 1,
      run_id: 'run-1',
      session: 'ralph-repo-1',
      source: 'github',
      status: 'running',
      started_at: LEGACY.started_at,
      queue_at_start: 6,
    })
    // Nothing outside `current` moved, so a status view reading this record cannot tell the
    // difference between a run that started before the upgrade and one that started after.
    const { current: _a, ...envelopeAfter } = after
    const { current: _b, ...envelopeBefore } = LEGACY
    expect(envelopeAfter).toEqual(envelopeBefore)
  })

  it('replaces a hand-edited `current` whole, rather than merging a field into it', () => {
    // `current: {...}` is written from scratch every iteration, and that is load-bearing in
    // both directions: a stale `worktree` from the previous task can never survive into the
    // next one, and a key a human invented can never survive into a record `ralph status`
    // reads. Measured on the worst shape the file can hold — a `current` that is an ARRAY,
    // which `readRunState` hands back verbatim because the RECORD is the object it guards.
    const v = vol({
      [PATH]: JSON.stringify(
        { ...LEGACY, current: ['/repo/.ralph/worktrees/issue-9', { worktree: '/somewhere/else' }] },
        null,
        2,
      ),
    })
    beginTask(ROOT, { number: 31, iteration: 4, worktree: WORKTREE }, v)
    expect(Array.isArray(onDisk(v).current)).toBe(false)
    expect(Object.keys(onDisk(v).current)).toEqual(CURRENT_KEYS)
    expect(onDisk(v).current.worktree).toBe(WORKTREE)

    const stale = vol({
      [PATH]: JSON.stringify({ ...LEGACY, current: { legacy_field: 'kept?', worktree: '/old' } }, null, 2),
    })
    beginTask(ROOT, { number: 32, iteration: 5 }, stale)
    expect(Object.keys(onDisk(stale).current)).toEqual(CURRENT_KEYS)
    expect(onDisk(stale).current.worktree).toBe(null)
  })

  it('reads a record whose worktree is the wrong TYPE on disk, verbatim and without throwing', () => {
    // `readRunState` guards the RECORD's shape and nothing inside it (its own comment says
    // so), so a hand-edited or future-schema `worktree` arrives at the renderers as whatever
    // it is. That is the contract both surfaces are written against — and the next
    // `beginTask` is what puts a string or a null back.
    for (const worktree of [42, true, { path: '/repo' }, ['/repo'], null]) {
      const v = vol({
        [PATH]: JSON.stringify({ ...LEGACY, current: { ...LEGACY.current, worktree } }, null, 2),
      })
      let read
      expect(() => (read = readRunState(ROOT, v)), JSON.stringify(worktree)).not.toThrow()
      expect(read.current.worktree, JSON.stringify(worktree)).toEqual(worktree)
      beginTask(ROOT, { number: 31, iteration: 3, worktree: WORKTREE }, v)
      expect(onDisk(v).current.worktree, JSON.stringify(worktree)).toBe(WORKTREE)
    }
  })

  it('keeps `beginRun`’s fresh record free of the previous run’s directory', () => {
    // A new run must never inherit the last one's in-flight task, worktree included: the
    // previous run's tree may already have been removed (#220), and a record naming it would
    // have `ralph status` point at a directory that is gone. `beginRun` writes `current:
    // null` rather than merging, so the field cannot outlive the run that measured it.
    const v = vol()
    beginTask(ROOT, { number: 31, iteration: 1, worktree: WORKTREE }, v)
    beginRun(ROOT, { runId: 'run-2', session: 's', source: 'github', queueDepth: 3 }, v)
    expect(onDisk(v).current).toBe(null)
    expect(JSON.stringify(onDisk(v))).not.toContain('worktrees')
  })
})

// --- the CLI's 5th argument, which is bash's only way in ---------------------
describe('run-state.js CLI — the 5th argument has no parser behind it (#222 QA)', () => {
  let sandbox
  let root

  const cli = (...args) => {
    const res = spawnSync(process.execPath, [CLI, ...args], {
      cwd: sandbox,
      encoding: 'utf8',
      timeout: 15000,
    })
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }
  const recordOf = () => JSON.parse(readFileSync(join(root, '.ralph', 'run-state.json'), 'utf8'))

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'ralph-runstate-worktree-'))
    root = join(sandbox, 'project')
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
  })

  it('records a path that LOOKS like a flag as a path', () => {
    // There is no option parser in this CLI — `rest` is destructured positionally — and this
    // is the assertion that keeps it that way. A worktree cannot normally begin with a dash,
    // but `$task_worktree` is whatever `lib/worktree.js` printed, and the failure mode of a
    // parser appearing here would be silent: the path would become an unknown option, the
    // record would name no directory, and every call site in the loop says `|| true`.
    for (const path of ['-v', '--force', '--worktree=/repo/wt', '-', '--']) {
      const res = cli('begin-task', root, '31', '1', '', path)
      expect(res.status, path).toBe(0)
      expect(res.stderr, path).toBe('')
      expect(recordOf().current.worktree, path).toBe(path)
    }
  })

  it('records a path carrying a space, a quote or a newline as ONE argument', () => {
    // argv, not a shell, so the only question is whether anything here re-splits or re-quotes
    // it. `/Users/me/my repo/...` is an ordinary macOS path and the loop passes it through
    // `"$task_worktree"`; the newline row is the shape a hand-edited variable would take.
    for (const path of [
      '/Users/someone/my repo/.ralph/worktrees/issue-31',
      '/repo/say "hi"/issue-1',
      "/repo/it's/issue-1",
      '/repo/two\nlines',
      '/repo/semi;colon && true',
      '/repo/$(touch pwned)/issue-1',
      '/repo/`touch pwned`/issue-1',
    ]) {
      const res = cli('begin-task', root, '31', '1', '', path)
      expect(res.status, path).toBe(0)
      expect(recordOf().current.worktree, path).toBe(path)
    }
    // Nothing ran: the strings above are data on both sides of the process boundary.
    expect(existsSync(join(sandbox, 'pwned'))).toBe(false)
    expect(existsSync(join(root, 'pwned'))).toBe(false)
  })

  it('ignores arguments past the fifth, so a surplus argument is never fatal', () => {
    // The mirror image of the four-argument row the dev's suite covers, and the same contract
    // read from the other end: this CLI's positional list is CLOSED at five, so a sixth
    // argument is surplus rather than fatal and cannot land in the record under some other
    // field's name. Argued from the arity contract and NOT from a version skew — the loop
    // script is run in place from the install and resolves this module relative to itself, so
    // no caller of this CLI is ever a version ahead of it. What the test buys is that a stray
    // extra argument — a hand-written call, a debugging line, a sixth this record has no field
    // for yet — changes neither the record nor the exit code.
    const res = cli('begin-task', root, '31', '1', 'FOO-9', '/repo/wt', 'something-else', '7')
    expect(res.status).toBe(0)
    expect(res.stderr).toBe('')
    expect(res.stdout).toBe('')
    expect(recordOf().current).toEqual({
      number: 31,
      task_key: 'FOO-9',
      started_at: recordOf().current.started_at,
      iteration: 1,
      worktree: '/repo/wt',
    })
    expect(JSON.stringify(recordOf())).not.toContain('something-else')
  })

  it('records a 5 KB path in full — the record is not where the bound lives', () => {
    // The terminal row bounds what it draws (lib/progress.js's RAW_PATH_LIMIT); the record
    // does not, deliberately and consistently with `task_key` and `run_id`. What a machine
    // reads has to be the path, whole, or it is a wrong answer rather than a long line.
    const long = '/repo/' + 'w'.repeat(5000)
    expect(cli('begin-task', root, '31', '1', '', long).status).toBe(0)
    expect(recordOf().current.worktree).toBe(long)
    expect(recordOf().current.worktree.length).toBe(long.length)
  })

  it('writes the record silently, so a `$(...)` capture around this call stays empty', () => {
    // Unchanged by #222 and re-asserted with the new argument in place: the loop interleaves
    // this sidecar's output with its own, and the #55 QA suite pins the empty-stdout rule for
    // the four-argument form. A path echoed back would also be the one value in this record
    // large enough to flood a tmux pane.
    const res = cli('begin-task', root, '31', '1', '', '/repo/.ralph/worktrees/issue-31')
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
    expect(res.status).toBe(0)
  })
})
