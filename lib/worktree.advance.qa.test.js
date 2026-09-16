import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { advanceOrPark, createDetachedWorktree } from './worktree.js'

// QA augmentation for #221's advance-or-park table. lib/worktree.test.js owns one test
// per state of that table against a scripted git; test/loop.worktree.folder.test.js owns
// three of them against a real repository. What is left over — and what this file is —
// is the two places the decision is made out of PARSED TEXT rather than out of an exit
// code, plus the one race the table's own comment claims to survive:
//
//   1. `git worktree list --porcelain`, whose records this module reads to decide WHO
//      holds the branch. That answer selects between writing a ref, fast-forwarding a
//      human's checkout, and refusing to touch anything — so every record shape git can
//      emit is driven here. MEASURED on git 2.50.1 (Apple Git-155) against a repository
//      holding a main tree, a detached tree, a second branch tree, a LOCKED tree, a
//      PRUNABLE one (its directory deleted) and one whose path contains a space:
//
//        worktree /private/tmp/wtprobe/r        worktree /private/tmp/wtprobe/lockme
//        HEAD d415d83…                          HEAD d415d83…
//        branch refs/heads/main                 branch refs/heads/dev
//                                               locked
//        worktree /private/tmp/wtprobe/det
//        HEAD d415d83…                          worktree /private/tmp/wtprobe/prunable
//        detached                               HEAD d415d83…
//                                               branch refs/heads/feature/x
//        worktree /private/tmp/wtprobe/with space   prunable gitdir file points to non-…
//        HEAD d415d83…
//        branch refs/heads/dev-2
//
//      So: `detached` and `bare` records carry no branch line, a locked or prunable one
//      carries its branch line all the same, the path is printed raw (spaces included,
//      never quoted), and branch lines are full `refs/heads/…` spellings — which is what
//      makes `dev` versus `dev-2` a real question.
//
//   2. The compare-and-swap on `update-ref`. The dev's suite scripts a REFUSAL; this
//      file makes a concurrent writer actually win the race against real git, because
//      "a concurrent writer loses instead of being overwritten" is a claim about git's
//      locking and not about this module's branching.
//
// Everything here injects `git`/`fs` or drives a throwaway repository under the OS temp
// dir. Nothing touches this checkout.

const HOME = '/home/dev'
const ROOT = '/repo'
const TREE = '/repo/.ralph/worktrees/task-7'
const PARKED = 'ralph/task-7'
const SHA = 'a'.repeat(40) // what the agent committed in the worktree
const TIP = 'b'.repeat(40) // where the branch points now

// One recorder for the git seam, prefix-matched in insertion order, defaulting to
// success — the same shape lib/worktree.qa.test.js uses, kept local because what is
// scripted here (five reads, three writes) has nothing to do with the create path.
function recorder(script = {}) {
  const calls = []
  const stderrCalls = []
  const git = (args, opts = {}) => {
    const line = args.join(' ')
    calls.push({ line, argv: args, cwd: opts.cwd })
    for (const [prefix, result] of Object.entries(script)) {
      if (line.startsWith(prefix)) return { status: 0, stdout: '', stderr: '', ...result }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return {
    git,
    calls,
    stderrCalls,
    stderr: { write: (m) => stderrCalls.push(m) },
    lines: () => calls.map((c) => c.line),
    said: () => stderrCalls.join(''),
  }
}

// The five answers advanceOrPark reads — the worktree's HEAD, the branch tip, the holder
// list, the main tree's dirt, and the ancestry test — each with a default so a test states
// only the one it is about. `extra` last: the recorder matches in insertion order, and a
// re-assigned key keeps its original position, so an override cannot be shadowed.
function scriptFor({ sha = SHA, tip = TIP, list, status = '', branch = 'main', ...extra } = {}) {
  return {
    'rev-parse HEAD': { stdout: `${sha}\n` },
    [`rev-parse --verify --quiet refs/heads/${branch}`]: { stdout: `${tip}\n` },
    'worktree list --porcelain': { stdout: list ?? '' },
    'status --porcelain': { stdout: status },
    'merge-base --is-ancestor': { status: 0 },
    ...extra,
  }
}

function advance(rec, { root = ROOT, handle = 'task-7', branch = 'main', tree = TREE } = {}) {
  return advanceOrPark(root, handle, branch, {
    fs: { existsSync: (p) => p === tree },
    git: rec.git,
    home: HOME,
    stderr: rec.stderr,
  })
}

// A `git worktree list --porcelain` body from records spelled as objects, so each test
// below reads as the repository it describes rather than as a string literal.
const porcelain = (...records) =>
  `${records
    .map(({ path, head = TIP, ref, extra = [] }) =>
      [`worktree ${path}`, `HEAD ${head}`, ref ? `branch ${ref}` : 'detached', ...extra].join('\n'),
    )
    .join('\n\n')}\n\n`

// ---------------------------------------------------------------------------
// 1. Who holds the branch — every record shape `worktree list` can emit
// ---------------------------------------------------------------------------

describe('advanceOrPark — the branch-holder parse decides which write is safe (#221 QA)', () => {
  it('treats a repository whose every tree is DETACHED as nobody holding the branch', () => {
    // The main tree itself can be detached (a human bisecting, say). No branch line
    // anywhere means the ref is a file nothing is sitting on, so the ref write is safe
    // and the human's tree is never even asked about its dirt.
    const rec = recorder(
      scriptFor({
        list: porcelain({ path: '/repo' }, { path: TREE, head: SHA }),
      }),
    )
    expect(advance(rec)).toMatchObject({ action: 'advanced', via: 'update-ref' })
    expect(rec.lines()).toContain(`update-ref refs/heads/main ${SHA} ${TIP}`)
    expect(rec.lines().some((l) => l.startsWith('status'))).toBe(false)
    expect(rec.said()).toBe('')
  })

  it('does not let a `bare` record swallow the path of the record after it', () => {
    // MEASURED on git 2.50.1 (Apple Git-155), `worktree list --porcelain` run inside a
    // bare repository with one linked worktree:
    //
    //   worktree /private/tmp/qaprobe/bare.git
    //   bare
    //
    //   worktree /private/tmp/qaprobe/bare-wt
    //   HEAD b43b556…
    //   branch refs/heads/main
    //
    // — so the bare record carries neither HEAD nor branch. The parser tracks the last
    // path it saw, so a record with no branch line must not leave the NEXT record's
    // branch attributed to the wrong tree.
    const rec = recorder(
      scriptFor({
        list: `worktree /repo\nbare\n\nworktree /elsewhere/checkout\nHEAD ${TIP}\nbranch refs/heads/main\n\n`,
      }),
    )
    const res = advance(rec)
    expect(res).toMatchObject({ action: 'parked', reason: 'other-worktree', parkedOn: PARKED })
    // Not a fast-forward of the main root, which is what mis-attributing that branch
    // line to `/repo` would have produced.
    expect(rec.lines().some((l) => l.startsWith('merge --ff-only'))).toBe(false)
    expect(rec.lines().some((l) => l.startsWith('update-ref'))).toBe(false)
  })

  it('recognises the main tree when its path contains a space, rather than parking on it', () => {
    // `worktree list --porcelain` prints paths RAW — MEASURED on git 2.50.1, a worktree
    // at `…/with space` is one unquoted line. A parser that split on whitespace would
    // read a foreign path here and refuse to advance a branch it was allowed to.
    const root = '/re po'
    const tree = `${root}/.ralph/worktrees/task-7`
    const rec = recorder(scriptFor({ list: porcelain({ path: root, ref: 'refs/heads/main' }) }))
    expect(advance(rec, { root, tree })).toMatchObject({ action: 'advanced', via: 'fast-forward' })
    expect(rec.calls.find((c) => c.line.startsWith('merge')).cwd).toBe(root)
  })

  it('compares the whole ref, so `dev` is not held by a tree sitting on `dev-2`', () => {
    // The prefix trap: `refs/heads/dev` is a prefix of `refs/heads/dev-2`, and reading
    // the second as the first would park every task in a repository whose user happens
    // to be on a longer branch name.
    const rec = recorder(
      scriptFor({
        branch: 'dev',
        list: porcelain({ path: '/repo', ref: 'refs/heads/dev-2' }, { path: TREE, head: SHA }),
      }),
    )
    expect(advance(rec, { branch: 'dev' })).toMatchObject({ action: 'advanced', via: 'update-ref' })
    expect(rec.lines()).toContain(`update-ref refs/heads/dev ${SHA} ${TIP}`)
  })

  it('handles a slashed branch name, which is what real dev branches look like', () => {
    const rec = recorder(
      scriptFor({ branch: 'release/1.2', list: porcelain({ path: '/repo', ref: 'refs/heads/release/1.2' }) }),
    )
    expect(advance(rec, { branch: 'release/1.2' })).toMatchObject({
      action: 'advanced',
      via: 'fast-forward',
    })
    // And the ref it resolved is the full spelling, not a truncation at the slash.
    expect(rec.lines()).toContain('rev-parse --verify --quiet refs/heads/release/1.2')
  })

  it.each([
    ['LOCKED', ['locked']],
    ['PRUNABLE (its directory deleted)', ['prunable gitdir file points to non-existent location']],
  ])('parks when a %s worktree elsewhere still claims the branch', (_label, extra) => {
    // MEASURED on git 2.50.1: both record kinds keep their `branch refs/heads/…` line,
    // so both read as a holder here. For the locked one that is exactly right. For the
    // PRUNABLE one it is conservative rather than exact — nothing is really sitting on
    // the branch — and it is unreachable from the loop, because the `create-detached`
    // earlier in the same iteration runs `git worktree prune`, which drops precisely the
    // records whose directory is missing. Pinned as the safe direction: a park loses a
    // fast-forward, never a commit.
    const rec = recorder(
      scriptFor({
        list: porcelain(
          { path: '/repo', ref: 'refs/heads/feature/x' },
          { path: '/repo/.ralph/worktrees/task-9', ref: 'refs/heads/main', extra },
          { path: TREE, head: SHA },
        ),
      }),
    )
    expect(advance(rec)).toMatchObject({ action: 'parked', reason: 'other-worktree' })
  })

  it('reads the record for the branch even when it is the last one, with no trailing blank line', () => {
    const rec = recorder(
      scriptFor({ list: `worktree /repo\nHEAD ${TIP}\nbranch refs/heads/main` }),
    )
    expect(advance(rec)).toMatchObject({ action: 'advanced', via: 'fast-forward' })
  })

  it('parks on ANY dirt in the main tree, whatever shape that dirt has', () => {
    // The dev's suite drives one modified tracked file. `git status --porcelain` reports
    // four more shapes a human's checkout reaches routinely, and the module's rule is
    // ANY of them: a ref that moves under a live index is not ours to risk.
    for (const [label, status] of [
      ['untracked file only', '?? scratch.txt\n'],
      ['staged addition only', 'A  new.js\n'],
      ['an unmerged path', 'UU conflicted.js\n'],
      ['a dirty submodule', ' M vendor/lib\n'],
      ['a status read that itself failed', ''],
    ]) {
      const failed = label === 'a status read that itself failed'
      const rec = recorder(
        scriptFor({
          list: porcelain({ path: '/repo', ref: 'refs/heads/main' }),
          'status --porcelain': { status: failed ? 128 : 0, stdout: status },
        }),
      )
      expect(advance(rec), label).toMatchObject({ action: 'parked', reason: 'dirty-main-tree' })
      expect(rec.lines().some((l) => l.startsWith('merge --ff-only')), label).toBe(false)
      expect(rec.lines().some((l) => l.startsWith('update-ref')), label).toBe(false)
    }
  })

  // THE ASYMMETRY THIS FILE WAS WRITTEN TO FIND, since fixed. `status --porcelain` failing
  // counted as dirt (the row above) — "we did not learn that it was clean" — but `worktree
  // list` failing was read as `null`, i.e. "nobody holds the branch", which selects the ONE
  // branch of the table that writes a ref without asking anything else. So an unreadable
  // `worktree list` produced exactly the outcome the module's own header called
  // unacceptable: the ref moving under a live index in a tree a human is working in. It now
  // parks on the exit code before the parse is even reached (lib/worktree.js: the
  // `holder-unknown` arm), and this row is what keeps that from regressing.
  it('does not treat an UNREADABLE `worktree list` as proof that nobody holds the branch', () => {
    const rec = recorder(
      scriptFor({
        'worktree list --porcelain': {
          status: 128,
          stdout: '',
          stderr: 'fatal: not a git repository\n',
        },
        status: ' M README.md\n',
      }),
    )
    // Deliberately fix-agnostic about WHICH safe answer this becomes — park (matching the
    // failed-`status` row above) or throw (matching the failed-HEAD read) are both fine.
    // The assertion is only that a ref is not moved on the strength of an answer that was
    // never received, so whichever way the dev resolves it, this test keeps holding.
    let res = null
    let threw = null
    try {
      res = advance(rec)
    } catch (e) {
      threw = e
    }
    expect(rec.lines().filter((l) => l.startsWith('update-ref'))).toEqual([])
    expect(threw !== null || res?.action === 'parked').toBe(true)
  })

  // The other side of that coin, added after the fix: "no answer" and "nobody" must stay
  // two different things. Both rows below are the same empty holder set; only the exit
  // code differs, so together they pin that the exit code is what decides.
  it('still advances when the list is EMPTY and git reported it SUCCESSFULLY', () => {
    // A repository whose every tree is detached really does answer "nobody holds this
    // branch", and `''` is a legitimate body for that answer — a repository with no
    // linked worktrees and a detached main tree prints nothing this parse can use. A fix
    // that keyed on emptiness rather than on status would have turned the ordinary
    // ref-write arm into a park for exactly those repositories.
    const rec = recorder(
      scriptFor({ 'worktree list --porcelain': { status: 0, stdout: '' } }),
    )
    expect(advance(rec)).toMatchObject({ action: 'advanced', via: 'update-ref' })
    expect(rec.lines()).toContain(`update-ref refs/heads/main ${SHA} ${TIP}`)
    expect(rec.said()).toBe('')
  })

  it('does not advance on a list that FAILED after printing a body naming nobody', () => {
    // The shape a real failure takes when it is not total: records printed, then a
    // non-zero exit (a worktree whose gitdir went unreadable half-way through the walk).
    // The body alone says "nobody holds `main`" and would select the ref-write arm, over
    // a main tree that is dirty — so the body is not what may be believed.
    const rec = recorder(
      scriptFor({
        'worktree list --porcelain': {
          status: 128,
          stdout: porcelain({ path: '/repo' }, { path: TREE, head: SHA }),
          stderr: 'fatal: cannot read gitdir\n',
        },
        status: ' M README.md\n',
      }),
    )
    let res = null
    let threw = null
    try {
      res = advance(rec)
    } catch (e) {
      threw = e
    }
    expect(rec.lines().filter((l) => l.startsWith('update-ref'))).toEqual([])
    expect(threw !== null || res?.action === 'parked').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Ancestry: the state that precedes the whole table
// ---------------------------------------------------------------------------

describe('advanceOrPark — ancestry decides before anything is asked about trees (#221 QA)', () => {
  it('parks an ORPHAN commit that shares no history with the branch at all', () => {
    // `merge-base --is-ancestor` exits 1 for an unrelated root commit exactly as it does
    // for a diverged one, so the verdict is the same and no fast-forward is attempted.
    const rec = recorder(
      scriptFor({
        'merge-base --is-ancestor': { status: 1 },
        list: porcelain({ path: '/repo', ref: 'refs/heads/main' }),
      }),
    )
    expect(advance(rec)).toMatchObject({ action: 'parked', reason: 'diverged', parkedOn: PARKED })
    // Nothing after the ancestry test was even asked — not the holder, not the dirt.
    expect(rec.lines().some((l) => l.startsWith('worktree list'))).toBe(false)
    expect(rec.lines().some((l) => l.startsWith('status'))).toBe(false)
  })

  it('parks a worktree HEAD that is merely BEHIND the branch, calling it diverged', () => {
    // The branch moved forward under the agent (a human pulled) and the agent committed
    // nothing new: its HEAD is now an ANCESTOR of the tip. `merge-base --is-ancestor
    // <tip> <sha>` exits 1 for that just as it does for a real divergence, so the
    // verdict is `diverged` and a `ralph/task-7` branch is written at a commit the
    // branch already contains. Documented rather than asserted as ideal: it is noise
    // (a warning and a stray branch for a case where there was nothing to deliver),
    // never a loss, and telling the two apart costs a second `--is-ancestor` spawn.
    const rec = recorder(
      scriptFor({ 'merge-base --is-ancestor': { status: 1 } }),
    )
    expect(advance(rec)).toMatchObject({ action: 'parked', reason: 'diverged', parkedOn: PARKED })
    expect(rec.said()).toContain(SHA)
  })

  it('throws, rather than parking, when the worktree HEAD cannot be read', () => {
    // An unborn HEAD in the tree — nothing was committed and nothing was checked out.
    // A broken invocation, not an outcome of a run: the CLI turns it into exit 1 and
    // templates/ralph.sh into a warning that changes no count.
    const rec = recorder(
      scriptFor({ 'rev-parse HEAD': { status: 128, stderr: 'fatal: ambiguous argument HEAD\n' } }),
    )
    expect(() => advance(rec)).toThrow(new RegExp(TREE))
    expect(rec.lines().some((l) => l.startsWith('branch -f'))).toBe(false)
  })

  it('never parks twice, and a second park for the same handle overwrites its own branch', () => {
    // `branch -f` rather than `update-ref` on the park path, so re-running a task whose
    // first attempt parked cannot fail on its own leftover.
    const first = recorder(scriptFor({ status: ' M x\n', list: porcelain({ path: '/repo', ref: 'refs/heads/main' }) }))
    advance(first)
    const second = recorder(scriptFor({ sha: 'c'.repeat(40), status: ' M x\n', list: porcelain({ path: '/repo', ref: 'refs/heads/main' }) }))
    advance(second)
    expect(first.lines()).toContain(`branch -f ${PARKED} ${SHA}`)
    expect(second.lines()).toContain(`branch -f ${PARKED} ${'c'.repeat(40)}`)
    for (const rec of [first, second]) {
      expect(rec.lines().filter((l) => l.startsWith('branch -f'))).toHaveLength(1)
    }
  })

  it('hands git an argv ARRAY on every call, park paths included', () => {
    const rec = recorder(scriptFor({ status: ' M x\n', list: porcelain({ path: '/repo', ref: 'refs/heads/main' }) }))
    advance(rec)
    expect(rec.calls.length).toBeGreaterThan(0)
    for (const call of rec.calls) {
      expect(Array.isArray(call.argv)).toBe(true)
      for (const arg of call.argv) expect(typeof arg).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Real git: the race the compare-and-swap exists for, and a park that fails
// ---------------------------------------------------------------------------

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'worktree.js')

// A repository shaped like a folder-mode run in progress: `main` carries a commit that
// was never pushed (there is no remote at all, which is the point — this source never
// pushes), and the caller adds the task's DETACHED worktree on top with `agentCommits`.
function makeRepo() {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ralph-advance-qa-')))
  const root = join(sandbox, 'project')
  mkdirSync(root, { recursive: true })
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  g('init', '-q', '--initial-branch=main')
  g('config', 'user.email', 'ralph@example.test')
  g('config', 'user.name', 'Ralph Test')
  g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), '.ralph/\n')
  writeFileSync(join(root, 'README.md'), 'seed\n')
  g('add', '.')
  g('commit', '-q', '-m', 'chore: seed')
  writeFileSync(join(root, 'from-iteration-1.txt'), 'local only\n')
  g('add', 'from-iteration-1.txt')
  g('commit', '-q', '-m', 'chore: local only, never pushed')
  const opts = { home: join(sandbox, 'not-a-home'), stderr: { write: () => {} } }
  return { sandbox, root, g, opts, rev: (ref) => g('rev-parse', ref).trim() }
}

// The agent: a commit made inside the detached worktree the module just created.
function agentCommits(root, opts, handle = 'task-7', base = 'main') {
  const tree = createDetachedWorktree(root, handle, base, { ...opts, processEnv: {} })
  const g = (...args) => execFileSync('git', args, { cwd: tree, encoding: 'utf8' })
  writeFileSync(join(tree, 'agent-file.txt'), 'hello from the agent\n')
  g('add', 'agent-file.txt')
  g('commit', '-q', '-m', 'feat: agent work (task #7)')
  return { tree, sha: g('rev-parse', 'HEAD').trim() }
}

describe('advanceOrPark against real git — the compare-and-swap is not decoration (#221 QA)', () => {
  it('loses the race to a concurrent writer instead of overwriting it, and parks the commit', () => {
    // THE RACE THE `update-ref <ref> <new> <old>` OLD VALUE IS FOR. The dev's suite
    // scripts the refusal; here a writer really moves the branch after this module read
    // its tip, and git's own locking is what has to catch it. MEASURED on git 2.50.1
    // (Apple Git-155) in this fixture: exit 128, `fatal: update_ref failed for ref
    // 'refs/heads/main': cannot lock ref 'refs/heads/main': is at <c> but expected <b>`.
    const { sandbox, root, g, opts, rev } = makeRepo()
    try {
      // The human is off on their own branch, so `main` is checked out NOWHERE — the one
      // state that reaches `update-ref` at all.
      g('checkout', '-q', '-b', 'feature/x')
      writeFileSync(join(root, 'README.md'), 'seed\ntheir own work\n')
      g('commit', '-q', '-am', 'chore: their commit')
      const theirs = rev('HEAD')
      const tipBefore = rev('main')
      const { sha } = agentCommits(root, opts)

      // A real git, except that answering the holder question is the moment the
      // concurrent writer gets in — after this module read the tip and before it writes.
      let raced = false
      const racingGit = (args, { cwd } = {}) => {
        if (args.join(' ') === 'worktree list --porcelain' && !raced) {
          raced = true
          execFileSync('git', ['update-ref', 'refs/heads/main', theirs, tipBefore], { cwd: root })
        }
        const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
        return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      }
      const said = []
      const res = advanceOrPark(root, 'task-7', 'main', {
        git: racingGit,
        home: opts.home,
        stderr: { write: (m) => said.push(m) },
      })

      expect(raced).toBe(true)
      expect(res).toMatchObject({ action: 'parked', reason: 'ref-write-refused', parkedOn: 'ralph/task-7' })
      // THE OTHER WRITER'S COMMIT SURVIVED — that is the whole point of passing the old
      // value — and the agent's is reachable by name instead of being lost.
      expect(rev('main')).toBe(theirs)
      expect(rev('refs/heads/ralph/task-7')).toBe(sha)
      expect(said.join('')).toContain(sha)
      expect(said.join('')).toContain('ralph/task-7')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('CLI: a park whose own branch write fails still names the sha, and still exits 0', () => {
    // The last line of defence, driven end-to-end through the process contract the loop
    // reads. A branch named `ralph` makes `ralph/task-7` unwritable — MEASURED on git
    // 2.50.1: `fatal: cannot lock ref 'refs/heads/ralph/task-7': 'refs/heads/ralph'
    // exists; cannot create 'refs/heads/ralph/task-7'` (128) — so the park itself fails
    // and the sha in the warning is the only handle left on the commit. A park is not a
    // failure, so the exit code is still 0 and the task's own verdict still stands.
    const { sandbox, root, g, opts, rev } = makeRepo()
    try {
      g('branch', 'ralph')
      const tipBefore = rev('main')
      const { sha, tree } = agentCommits(root, opts)
      // Dirt in the main tree, on the branch being advanced: the park path.
      writeFileSync(join(root, 'README.md'), 'seed\nuncommitted\n')

      const res = spawnSync(process.execPath, [CLI, 'advance', root, 'task-7', 'main'], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, HOME: join(sandbox, 'not-a-home') },
      })

      expect(res.status).toBe(0)
      expect(res.stdout).toBe('')
      expect(res.stderr).toContain(sha)
      expect(res.stderr).toContain(tree)
      expect(res.stderr).not.toContain('    at ')
      expect(res.stderr.trimEnd().split('\n')).toHaveLength(1)
      // Nothing was written anywhere: not the branch, not a park ref, not the tree.
      expect(rev('main')).toBe(tipBefore)
      expect(
        spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/ralph/task-7'], { cwd: root })
          .status,
      ).not.toBe(0)
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('seed\nuncommitted\n')
      expect(existsSync(join(root, 'agent-file.txt'))).toBe(false)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('parks, rather than fast-forwarding, when the caller spells the root through a symlink', () => {
    // WHOSE TREE IS IT: the holder comparison is `resolve(path) !== resolve(mainRoot)`, and
    // `resolve` does not follow symlinks while git's own record always prints the REAL
    // path. MEASURED on git 2.50.1 (Apple Git-155) with `/tmp/symprobe/link ->
    // /tmp/symprobe/project`: `worktree list --porcelain` run through the link answers
    // `worktree /private/tmp/symprobe/project`, so the main tree does not recognise itself
    // and the outcome is `parked (other-worktree)` where a clean tree would otherwise have
    // been fast-forwarded.
    //
    // PINNED AS THE SAFE DIRECTION, not as the ideal one. It is unreachable from the loop —
    // templates/ralph.sh sets PROJECT_ROOT from `git rev-parse --show-toplevel`, which is
    // already resolved — and the cost of being wrong this way is a warning and a park
    // branch, never a commit. The opposite mistake (treating a foreign tree as ours) would
    // move a ref under somebody's live index.
    const { sandbox, root, opts, rev } = makeRepo()
    try {
      const link = join(sandbox, 'link')
      execFileSync('ln', ['-s', root, link])
      const tipBefore = rev('main')
      const tree = createDetachedWorktree(link, 'task-7', 'main', { ...opts, processEnv: {} })
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'feat: agent work'], { cwd: tree })
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim()

      const said = []
      const res = advanceOrPark(link, 'task-7', 'main', {
        home: opts.home,
        stderr: { write: (m) => said.push(m) },
      })

      expect(res).toMatchObject({ action: 'parked', reason: 'other-worktree', parkedOn: 'ralph/task-7' })
      expect(rev('main')).toBe(tipBefore)
      expect(rev('refs/heads/ralph/task-7')).toBe(sha)
      expect(said.join('')).toContain(sha)
      expect(said.join('')).toContain('main')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('CLI: prints one line and nothing on stdout when the branch is not a local branch', () => {
    // `advance` resolves `refs/heads/<branch>` and throws when that is not there — since
    // #221's fix, after writing `ralph/<handle>` at the commit, so the refusal costs the
    // work nothing (the invariant row in lib/worktree.detached.qa.test.js is what asserts
    // that side). Driven through the CLI because the loop reads the exit code: 1 here,
    // which templates/ralph.sh turns into a warning that changes no count. The single
    // stderr line is the refusal itself; a park's ⚠️ line would be a second one.
    const { sandbox, root, g, opts } = makeRepo()
    try {
      g('tag', 'v1.0')
      agentCommits(root, opts, 'task-7', 'main')
      const res = spawnSync(process.execPath, [CLI, 'advance', root, 'task-7', 'v1.0'], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, HOME: join(sandbox, 'not-a-home') },
      })
      expect(res.status).toBe(1)
      expect(res.stdout).toBe('')
      expect(res.stderr).toMatch(/^worktree\.js: advance failed \(/)
      expect(res.stderr.trimEnd().split('\n')).toHaveLength(1)
      expect(res.stderr).not.toContain('    at ')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('writes the park ref BEFORE refusing a base that is not a local branch', () => {
    // The refusal above, read from the repository's side rather than from the exit code:
    // the non-zero exit is about the CONFIGURATION, and it may not cost the commit. So
    // both halves have to be true at once — the throw, and a ref pointing at the work —
    // and only real git can say whether the ref is really there afterwards.
    const { sandbox, root, g, opts, rev } = makeRepo()
    try {
      g('tag', 'v1.0')
      const tipBefore = rev('main')
      const { sha } = agentCommits(root, opts)

      const said = []
      let threw = null
      try {
        advanceOrPark(root, 'task-7', 'v1.0', { home: opts.home, stderr: { write: (m) => said.push(m) } })
      } catch (e) {
        threw = e
      }

      expect(threw).not.toBeNull()
      expect(threw.message).toContain(sha)
      expect(threw.message).toContain('ralph/task-7')
      expect(rev('refs/heads/ralph/task-7')).toBe(sha)
      // Reachability is the invariant, so it is asked of the repository and not of the
      // module: `for-each-ref --contains` is what a `git gc` would consult.
      expect(g('for-each-ref', '--contains', sha, '--format=%(refname)').trim()).not.toBe('')
      // Nothing else moved, and nothing was said — the CLI above owns the one line, so a
      // warning here would make two lines about one commit.
      expect(rev('main')).toBe(tipBefore)
      expect(said).toEqual([])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('names the sha and the directory when a non-branch base ALSO cannot be parked', () => {
    // Both halves failing is the one state in which no ref points at the commit, so the
    // message is the only handle a human is left with and it has to carry both the sha and
    // the tree it is in. A branch named `ralph` is what makes `ralph/task-7` unwritable —
    // MEASURED on git 2.50.1 (Apple Git-155): `fatal: cannot lock ref
    // 'refs/heads/ralph/task-7': 'refs/heads/ralph' exists`.
    const { sandbox, root, g, opts } = makeRepo()
    try {
      g('branch', 'ralph')
      g('tag', 'v1.0')
      const { sha, tree } = agentCommits(root, opts)

      let threw = null
      try {
        advanceOrPark(root, 'task-7', 'v1.0', { home: opts.home, stderr: { write: () => {} } })
      } catch (e) {
        threw = e
      }
      expect(threw).not.toBeNull()
      expect(threw.message).toContain(sha)
      expect(threw.message).toContain(tree)
      // And the sha it names really is findable in that tree, which is what makes the
      // message actionable rather than decorative.
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim()).toBe(sha)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('parks what comes back when a TAG and a BRANCH share the name DEV_BRANCH is given', () => {
    // THE SEAM BETWEEN THE TWO SPELLINGS. The create verifies `refs/heads/<base>` and then
    // hands the SHORT name to `worktree add`, and for an ambiguous name those are not the
    // same commit. MEASURED on git 2.50.1 (Apple Git-155) with both `refs/tags/main` and
    // `refs/heads/main` present: `git rev-parse main` warns `refname 'main' is ambiguous`
    // and answers the TAG, and `git worktree add --detach <path> main` checks out the TAG
    // too — git's resolution order puts refs/tags before refs/heads.
    //
    // So the agent is cut from the tag's content while `advance` moves the branch. Pinned
    // for the invariant, which still holds: the branch tip is not an ancestor of what the
    // agent committed, so this parks and the commit keeps a name. Nothing is lost and the
    // human is told — but the tree the agent got was not the branch's, so the warning is
    // the only sign of it. Reachable only by naming a tag after a branch.
    const { sandbox, root, g, opts, rev } = makeRepo()
    try {
      g('tag', 'main', 'HEAD~1') // a tag named after the branch, one commit behind it
      const tagSha = rev('refs/tags/main')
      const branchTip = rev('refs/heads/main')
      expect(tagSha).not.toBe(branchTip)

      const { tree, sha } = agentCommits(root, opts)
      // The tree really was cut from the TAG, not from the branch this run will advance.
      expect(
        execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: tree, encoding: 'utf8' }).trim(),
      ).toBe(tagSha)

      const said = []
      const res = advanceOrPark(root, 'task-7', 'main', {
        home: opts.home,
        stderr: { write: (m) => said.push(m) },
      })

      expect(res).toMatchObject({ action: 'parked', reason: 'diverged', parkedOn: 'ralph/task-7' })
      expect(rev('refs/heads/main')).toBe(branchTip)
      expect(rev('refs/heads/ralph/task-7')).toBe(sha)
      expect(said.join('')).toContain(sha)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
