import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Volume } from 'memfs'
import { createWorktree, removeWorktree, worktreePath, worktreesRoot } from './worktree.js'

// QA augmentation for #218. lib/worktree.test.js owns the happy path — the derived
// path, the fetch-then-add order, the two fallbacks, the CLI's three exit codes. This
// file attacks the one thing this module does that nothing else in the package does:
// it computes a filesystem path and then hands that path to `git worktree remove
// --force` and to `rmSync(path, { recursive: true, force: true })`. The derivation IS
// the safety boundary, so it is probed from both sides — nothing unsafe may get
// through, and nothing ORDINARY may be refused, because the ordinary case is "a repo
// somewhere under $HOME" and a false refusal there breaks every user at once.
//
// The second half attacks IDEMPOTENCY, which is the property that decides whether one
// dead iteration costs a run or costs every future run of that issue. Everything
// asserted there about real git's behaviour was MEASURED against the git on this
// machine (2.50.1) before being written down, and the loop-level twin in
// test/loop.worktree.qa.test.js re-measures it against a real repository so the
// claims cannot rot into folklore:
//
//   • `git worktree add` over a path whose directory is gone but whose administrative
//     record survives exits 128 (`fatal: '<handle>' is already used by worktree at
//     '<path>'`). An unconditional `git worktree prune` first makes the same add
//     succeed (`Preparing worktree (resetting branch …)`).
//   • `git worktree remove --force` — one --force — REFUSES a locked worktree
//     (`fatal: cannot remove a locked working tree; use 'remove -f -f' to override`),
//     and `git worktree prune -v` does NOT drop a locked worktree's record even after
//     its directory is deleted. That pair is what USED to turn this module's fs
//     fallback into an orphaned registration; BOTH verbs now escalate to `--force
//     --force` through one shared `removeThroughGit`, which exits 0 on a locked tree and
//     takes both its directory and its record. Neither caller gates that ask on the
//     directory existing, because git's answer to it does not depend on the directory: a
//     locked record whose directory is already gone is refused by one --force and cleared
//     by `-f -f` just the same, and it is the record — not the directory — that makes the
//     next `worktree add` fail. So a leftover that is merely LOCKED recovers on its own,
//     in the teardown and in createWorktree's leftover-clearing alike. One residual state
//     is left uncleared on purpose and is called out where the code makes that choice
//     (lib/worktree.js, the prune comment in createWorktree): a leftover that is locked
//     AND whose `.git` is a real directory defeats `-f -f` too, and a human's single `git
//     worktree unlock` is what unsticks it. The tests below pin the recoveries rather
//     than describing a live defect.
//   • `git clean -xdf` in the main root does NOT delete a nested worktree even when
//     its path is gitignored — git protects it. So that route to an orphaned
//     registration is closed and is deliberately not claimed below.
//
// Section 5 was added for #219, when creating the tree stopped being purely a git
// operation: the create path now COPIES a configured list of gitignored files into the
// tree it just made. The selection rules live in lib/worktree-seed.qa.test.js; what is
// here is only what needs the create path itself — the widened default `fs` seam driven
// against real git, the environment transport the loop uses, the CLI exit code a refused
// entry must not change, and the seed's own half of idempotency.

// Control characters are spelled with String.fromCharCode rather than written raw:
// test/source-control-bytes.test.js forbids a raw C0 byte in a tracked file, and a raw
// NUL in particular makes grep, rg and git grep skip the whole file in silence.
const TAB = String.fromCharCode(9)
const NUL = String.fromCharCode(0)

const HOME = '/home/dev'
const ROOT = '/repo'
const WT = '/repo/.ralph/worktrees/issue-7'

// git's refusal on a LOCKED worktree, verbatim from `git worktree remove --force
// <path>` on git 2.50.1 (Apple Git-155) — both halves, because the second line is the
// one that names the escalation the module now performs.
const LOCKED =
  "fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first\n"

// One recorder for BOTH seams, because half of what is asked below is about the ORDER
// of a git call relative to an fs mutation ("is the record dropped after the sweep?",
// "did anything touch the disk before the refusal?"), and two separate doubles cannot
// answer that. `script` maps an argv PREFIX to the result that invocation returns;
// anything unmatched succeeds, so a test that scripts nothing exercises the happy path.
function recorder({ script = {}, present = [] } = {}) {
  const trace = []
  const argvShapes = []
  const stderrCalls = []
  const paths = new Set(present)
  const git = (args, opts = {}) => {
    argvShapes.push(Array.isArray(args))
    const line = Array.isArray(args) ? args.join(' ') : String(args)
    trace.push({ kind: 'git', line, argv: args, cwd: opts.cwd })
    for (const [prefix, result] of Object.entries(script)) {
      if (line.startsWith(prefix)) return { status: 0, stdout: '', stderr: '', ...result }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  const fs = {
    existsSync: (p) => paths.has(p),
    mkdirSync: (p, opts) => {
      trace.push({ kind: 'mkdir', path: p, opts })
      paths.add(p)
    },
    rmSync: (p, opts) => {
      trace.push({ kind: 'rm', path: p, opts })
      paths.delete(p)
    },
  }
  const pick = (kind) => trace.filter((t) => t.kind === kind)
  return {
    git,
    fs,
    stderr: { write: (m) => stderrCalls.push(m) },
    trace,
    stderrCalls,
    argvShapes,
    gitLines: () => pick('git').map((t) => t.line),
    gitCalls: () => pick('git'),
    rms: () => pick('rm'),
    mkdirs: () => pick('mkdir'),
    // The interleaved script, one string per step, which is what an ordering
    // assertion can be written against.
    steps: () => trace.map((t) => (t.kind === 'git' ? `git ${t.line}` : `${t.kind} ${t.path}`)),
  }
}

const deps = (r) => ({ fs: r.fs, git: r.git, home: HOME, stderr: r.stderr })

// ---------------------------------------------------------------------------
// 1. The derivation boundary, from both directions
// ---------------------------------------------------------------------------

describe('worktree path derivation — what must be ALLOWED (#218 QA)', () => {
  // THE FALSE-POSITIVE HALF, and the more dangerous half to get wrong. The refusal
  // list names $HOME itself; a guard that read "under $HOME" instead would refuse
  // ~/repos/anything, which is where most users keep every repository they own.
  it.each([
    ['a repository directly under $HOME', `${HOME}/app`],
    ['a repository nested under $HOME', `${HOME}/repos/work/app`],
    ['a repository whose name starts with the home directory name', `${HOME}-backup/app`],
    ['a path with a space in it', '/repo dir/app'],
    ['a path under a dotted directory', `${HOME}/.local/share/app`],
    ['a path whose basename ends in .git (a bare-repo naming convention)', '/srv/app.git'],
    ['a path with a .github segment, which is not .git', '/repo/.github'],
    ['a deeply nested path', '/a/b/c/d/e/f/g'],
  ])('allows %s', (_label, root) => {
    expect(worktreePath(root, 'issue-7', { home: HOME })).toBe(
      `${root}/.ralph/worktrees/issue-7`,
    )
    expect(worktreesRoot(root, { home: HOME })).toBe(`${root}/.ralph/worktrees`)
  })

  it.each([
    ['a plain issue handle', 'issue-7'],
    ['a multi-digit issue handle', 'issue-12345'],
    ['a single character', 'a'],
    ['a bare digit', '1'],
    ['dots, dashes and underscores after the first character', 'A.b_c-d'],
  ])('allows %s as a handle', (_label, handle) => {
    expect(worktreePath(ROOT, handle, { home: HOME })).toBe(`/repo/.ralph/worktrees/${handle}`)
  })

  it('allows a long handle rather than truncating it to something that collides', () => {
    // 300 chars is past every filesystem's per-component limit, so the failure has to
    // come from the filesystem with a name a human can read — never from this module
    // silently shortening two different handles to the same directory.
    const long = 'i'.repeat(300)
    expect(worktreePath(ROOT, long, { home: HOME })).toBe(`/repo/.ralph/worktrees/${long}`)
  })
})

describe('worktree path derivation — what must be REFUSED (#218 QA)', () => {
  // Every row is a DIFFERENT SPELLING of a root the dev's own list already refuses,
  // reached through resolve()'s normalization rather than through string equality —
  // which is the only thing standing between `$HOME/..` and an `rmSync` at /home.
  it.each([
    ['$HOME spelled with a trailing dot', `${HOME}/.`],
    ['$HOME reached by climbing out of a subdirectory', `${HOME}/repos/..`],
    ['$HOME spelled with doubled separators', `//home//dev`],
    ['$HOME spelled with a redundant ./ segment', `/home/./dev`],
    ['the filesystem root reached by climbing', '/repo/..'],
    ['the filesystem root reached by climbing past itself', '/..'],
    ['the filesystem root spelled with a dot', '/.'],
    ['a whitespace-only root', '   '],
    ['a tab-only root', TAB],
    ['a root that is not a string at all', 42],
    ['a root that is an array', ['/repo']],
    ['a root that is an object', {}],
    ['a relative root that would resolve against the caller cwd', './repo'],
    ['a bare relative root', 'repo'],
    ['a tilde that no shell expanded', '~/app'],
    ['git metadata directory', '/repo/.git'],
    ['a path inside git metadata', '/repo/.git/worktrees/issue-1'],
    ['a submodule git directory', '/repo/.git/modules/sub'],
  ])('refuses %s', (_label, root) => {
    expect(() => worktreePath(root, 'issue-7', { home: HOME })).toThrow(/refusing/i)
    expect(() => worktreesRoot(root, { home: HOME })).toThrow(/refusing/i)
  })

  it.each([
    ['the current directory', '.'],
    ['the parent directory', '..'],
    ['git metadata', '.git'],
    ['a traversal dressed as an issue handle', 'issue-1/../../../etc'],
    ['a bare traversal', '../../etc'],
    ['an absolute path', '/etc'],
    ['a path separator anywhere', 'issue/7'],
    ['a backslash separator', 'issue\\7'],
    ['a trailing space', 'issue-7 '],
    ['a leading space', ' issue-7'],
    ['a trailing newline', 'issue-7\n'],
    ['an interior newline', 'issue\n7'],
    ['a carriage return', 'issue-7\r'],
    ['a NUL byte', `issue-7${NUL}`],
    ['a leading dash, which git would read as a flag', '-f'],
    ['a long git flag', '--force'],
    ['a bare dash', '-'],
    ['a shell command separator', 'issue-7;rm -rf /'],
    ['a command substitution', 'issue-$(id)'],
    ['a backquoted command', 'issue-`id`'],
    ['a pipe', 'issue|7'],
    ['a glob', 'issue-*'],
    ['a tilde', '~'],
    ['a non-ASCII letter', 'issue-é'],
    ['a leading underscore', '_issue'],
    ['a leading dot on an otherwise fine name', '.issue-7'],
    ['an empty handle', ''],
    ['a whitespace-only handle', ' '],
    ['a numeric handle', 7],
    ['an undefined handle', undefined],
  ])('refuses %s as a handle', (_label, handle) => {
    expect(() => worktreePath(ROOT, handle, { home: HOME })).toThrow(/refusing/i)
  })

  it('names the offending value in every refusal, since a tmux pane is the only reader', () => {
    expect(() => worktreePath('./repo', 'issue-7', { home: HOME })).toThrow('./repo')
    expect(() => worktreePath(ROOT, '../etc', { home: HOME })).toThrow('../etc')
  })
})

describe('the refusal fires BEFORE anything can happen (#218 QA)', () => {
  // The dev's file proves this for one case (an unsafe root in each verb). The point
  // generalizes: derivation is the first statement of both functions, so NO refusal
  // may be reached after a spawn or after a write. These rows are the ones that could
  // regress independently — a handle or ref check moved below the mkdir, say.
  const unsafe = [
    ['an unsafe root', HOME, 'issue-7', 'dev'],
    ['a root inside .git', '/repo/.git', 'issue-7', 'dev'],
    ['a relative root', 'repo', 'issue-7', 'dev'],
    ['a traversal handle', ROOT, '../../etc', 'dev'],
    ['a flag-shaped handle', ROOT, '--force', 'dev'],
    ['an empty handle', ROOT, '', 'dev'],
    ['a flag-shaped base ref', ROOT, 'issue-7', '-f'],
    ['a base ref that names git a different transport', ROOT, 'issue-7', '--upload-pack=/bin/sh'],
    ['a base ref with a shell separator', ROOT, 'issue-7', 'dev;rm -rf /'],
    ['a base ref with a command substitution', ROOT, 'issue-7', '$(id)'],
    ['a base ref with a newline', ROOT, 'issue-7', 'dev\nrm -rf /'],
    ['a base ref with a leading space', ROOT, 'issue-7', ' dev'],
    ['an empty base ref', ROOT, 'issue-7', ''],
    ['a whitespace-only base ref', ROOT, 'issue-7', '   '],
    ['a null base ref', ROOT, 'issue-7', null],
  ]

  it.each(unsafe)('createWorktree spawns no git and writes nothing for %s', (_l, r, h, b) => {
    const rec = recorder()
    expect(() => createWorktree(r, h, b, deps(rec))).toThrow(/refusing/i)
    expect(rec.trace).toEqual([])
  })

  it.each([
    ['an unsafe root', HOME, 'issue-7'],
    ['the filesystem root', '/', 'issue-7'],
    ['a relative root', 'repo', 'issue-7'],
    ['a traversal handle', ROOT, '../../etc'],
    ['a separator in the handle', ROOT, 'issue/7'],
    ['an empty handle', ROOT, ''],
  ])('removeWorktree spawns no git and deletes nothing for %s', (_label, root, handle) => {
    const rec = recorder({ present: [WT] })
    expect(() => removeWorktree(root, handle, deps(rec))).toThrow(/refusing/i)
    expect(rec.trace).toEqual([])
  })

  it.each([
    ['main', 'main'],
    ['dev', 'dev'],
    ['a slashed release branch', 'release/1.2'],
    ['a slashed feature branch', 'feature/a-b.c'],
    ['a tag-shaped ref', 'v1.0'],
  ])('accepts %s as a base ref, because real branches look like that', (_label, ref) => {
    const rec = recorder()
    expect(createWorktree(ROOT, 'issue-7', ref, deps(rec))).toBe(WT)
    expect(rec.gitLines()).toContain(`fetch origin ${ref}`)
    expect(rec.gitLines()).toContain(`worktree add -B issue-7 ${WT} origin/${ref}`)
  })

  it('hands git an argv ARRAY on every single call, so nothing is re-read as shell syntax', () => {
    // The refusals above make a shell-metacharacter argument unreachable anyway; this
    // is the second line of defence, and it is the one that survives a widened regex.
    const create = recorder()
    createWorktree(ROOT, 'issue-7', 'release/1.2', deps(create))
    const remove = recorder({ present: [WT] })
    removeWorktree(ROOT, 'issue-7', deps(remove))
    expect(create.argvShapes.length).toBeGreaterThan(0)
    expect(remove.argvShapes.length).toBeGreaterThan(0)
    expect(create.argvShapes.every(Boolean)).toBe(true)
    expect(remove.argvShapes.every(Boolean)).toBe(true)
    // …and no single element smuggles two arguments through a space.
    for (const call of [...create.gitCalls(), ...remove.gitCalls()]) {
      for (const arg of call.argv) expect(typeof arg).toBe('string')
    }
  })

  it('runs git in the resolved main root even when the caller spelled a trailing slash', () => {
    const rec = recorder()
    createWorktree('/repo/', 'issue-7', 'dev', deps(rec))
    for (const call of rec.gitCalls()) expect(call.cwd).toBe(ROOT)
  })
})

// ---------------------------------------------------------------------------
// 2. removeWorktree: the only recursive delete in the package
// ---------------------------------------------------------------------------

describe('removeWorktree — the recursive delete can only ever reach one directory (#218 QA)', () => {
  it('deletes EXACTLY the derived path, with the flags the header claims', () => {
    const rec = recorder({ script: { 'worktree remove': { status: 128 } }, present: [WT] })
    removeWorktree(ROOT, 'issue-7', deps(rec))
    expect(rec.rms()).toHaveLength(1)
    expect(rec.rms()[0].path).toBe(WT)
    expect(rec.rms()[0].opts).toEqual({ recursive: true, force: true })
  })

  it.each([
    ['issue-1'],
    ['issue-999999'],
    ['a'],
    ['A.b_c-d'],
    ['1'],
  ])('for handle %s the delete target is still one directory under .ralph/worktrees', (handle) => {
    const target = `/repo/.ralph/worktrees/${handle}`
    const rec = recorder({ script: { 'worktree remove': { status: 128 } }, present: [target] })
    removeWorktree(ROOT, handle, deps(rec))
    const [rm] = rec.rms()
    expect(rm.path).toBe(target)
    // The four paths a bug here would be catastrophic for, stated as the assertion
    // rather than as a comment.
    expect(rm.path).not.toBe(ROOT)
    expect(rm.path).not.toBe(HOME)
    expect(rm.path).not.toBe('/')
    expect(rm.path).not.toBe(worktreesRoot(ROOT, { home: HOME }))
    expect(rm.path.split('/')).not.toContain('.git')
    // Exactly one segment below the worktrees root, so no handle can add depth.
    expect(rm.path.slice(`${worktreesRoot(ROOT, { home: HOME })}/`.length)).toBe(handle)
  })

  it('and the git remove it tries first names the same path, never a directory above it', () => {
    const rec = recorder({ present: [WT] })
    removeWorktree(ROOT, 'issue-7', deps(rec))
    const removeCall = rec.gitCalls().find((c) => c.line.startsWith('worktree remove'))
    expect(removeCall.argv).toEqual(['worktree', 'remove', '--force', WT])
  })

  it('touches nothing at all when the directory is not there — a no-op, not a wild delete', () => {
    const rec = recorder({ present: [] })
    expect(removeWorktree(ROOT, 'issue-7', deps(rec))).toBe(true)
    expect(rec.rms()).toEqual([])
    expect(rec.stderrCalls).toEqual([])
    // git is still asked, because a REGISTRATION can outlive the directory (that is
    // what `prune` is for) — but nothing was deleted from the disk.
    //
    // TWO lines because THIS DOUBLE answers an unscripted remove with success, which is
    // what a prunable (unlocked) leftover record really does: MEASURED, `worktree remove
    // --force <path>` on an unlocked record whose directory is missing exits 0 and drops
    // the record. Real git on a path it has NO record for exits 128 (`fatal: '<path>' is
    // not a working tree`) for both spellings, so the real sequence in that other case is
    // three commands, not two — asserted from the double's default here only to pin the
    // ORDER and the absence of anything else, not the count.
    expect(rec.gitLines()).toEqual([`worktree remove --force ${WT}`, 'worktree prune'])
  })

  it('never deletes the branch, which is what carries the commits to the PR', () => {
    const rec = recorder({ script: { 'worktree remove': { status: 128 } }, present: [WT] })
    removeWorktree(ROOT, 'issue-7', deps(rec))
    for (const line of rec.gitLines()) {
      expect(line).not.toMatch(/^branch /)
      expect(line).not.toMatch(/\bbranch -[dD]\b/)
      expect(line).not.toMatch(/^update-ref/)
    }
  })

  it('warns only when git actually declined, so a clean teardown is silent', () => {
    const declined = recorder({ script: { 'worktree remove': { status: 128, stderr: 'nope\n' } }, present: [WT] })
    removeWorktree(ROOT, 'issue-7', deps(declined))
    expect(declined.stderrCalls).toHaveLength(1)
    expect(declined.stderrCalls[0]).toMatch(/declined/)

    // git reported success but something else re-created or kept the directory: the
    // sweep still runs (it must — the next run needs the path clear) and says nothing,
    // because there is no git verdict to report.
    const kept = recorder({ present: [WT] })
    kept.fs.rmSync = (p, o) => kept.trace.push({ kind: 'rm', path: p, opts: o })
    removeWorktree(ROOT, 'issue-7', deps(kept))
    expect(kept.rms()).toHaveLength(1)
    expect(kept.stderrCalls).toEqual([])
  })

  it('collapses git multi-line diagnostics to one warning line', () => {
    const rec = recorder({
      script: { 'worktree remove': { status: 128, stderr: 'fatal: one\nhint: two\nhint: three\n' } },
      present: [WT],
    })
    removeWorktree(ROOT, 'issue-7', deps(rec))
    expect(rec.stderrCalls.join('').trimEnd().split('\n')).toHaveLength(1)
    expect(rec.stderrCalls.join('')).toContain('fatal: one')
    expect(rec.stderrCalls.join('')).not.toContain('hint: two')
  })
})

// ---------------------------------------------------------------------------
// 3. Idempotency: what one dead iteration costs
// ---------------------------------------------------------------------------

describe('createWorktree — a crashed or half-torn-down run must not deadlock the issue (#218 QA)', () => {
  const clean = () => recorder()

  it('clears a leftover DIRECTORY and then adds, in that order', () => {
    // The dev's file asserts the remove precedes the add; this pins the whole
    // sequence, including that the fs sweep is the last resort rather than the first —
    // BOTH remove spellings are scripted to fail here, which is what it takes to reach
    // the sweep at all. The prune sits between the sweep and the add on purpose: the
    // sweep is one of the two things that can leave a record with no directory (the
    // other is a killed process), and a prune ahead of it would run while the directory
    // was still there and find nothing to drop.
    const rec = recorder({ script: { 'worktree remove': { status: 128 } }, present: [WT] })
    createWorktree(ROOT, 'issue-7', 'dev', deps(rec))
    expect(rec.steps()).toEqual([
      'mkdir /repo/.ralph/worktrees',
      `git worktree remove --force ${WT}`,
      `git worktree remove --force --force ${WT}`,
      `rm ${WT}`,
      'git fetch origin dev',
      'git rev-parse --verify --quiet origin/dev',
      'git worktree prune',
      `git worktree add -B issue-7 ${WT} origin/dev`,
    ])
  })

  // THE LOCK, which is the ONE refusal the prune below cannot repair afterwards, and
  // therefore the one the clearing above has to escalate rather than absorb. MEASURED
  // on git 2.50.1 (Apple Git-155) against a throwaway repository, on a worktree created
  // by this very module and then `git worktree lock`ed:
  //
  //   git worktree remove --force  <path>   -> 128, `fatal: cannot remove a locked
  //                                            working tree;` / `use 'remove -f -f' to
  //                                            override or unlock first`
  //   rm -rf <path>                         -> (the fs sweep)
  //   git worktree prune -v                 -> prints NOTHING; .git/worktrees/issue-95
  //                                            is still there
  //   git worktree add -B issue-95 <path> origin/main
  //                                         -> 128, `fatal: 'issue-95' is already used
  //                                            by worktree at '<path>'`
  //
  // …and templates/ralph.sh turns that throw into `break`, so absorbing the refusal
  // costs every future run of the issue, not one iteration. `git worktree remove --force
  // --force <path>` on the same tree exits 0 and takes the directory AND the record with
  // it, which is why the escalation — not the prune — is what closes the locked case.
  it('escalates a declined leftover remove to --force --force, as the teardown does', () => {
    const rec = recorder({
      script: { [`worktree remove --force ${WT}`]: { status: 128, stderr: LOCKED } },
      present: [WT],
    })
    expect(createWorktree(ROOT, 'issue-7', 'dev', deps(rec))).toBe(WT)
    expect(rec.gitLines().filter((l) => l.startsWith('worktree remove'))).toEqual([
      `worktree remove --force ${WT}`,
      `worktree remove --force --force ${WT}`,
    ])
    // And the escalation comes BEFORE the recursive delete, which is the whole point:
    // git is given every chance to drop its own record while the directory it points at
    // is still standing, rather than being handed a headless one to prune.
    const steps = rec.steps()
    expect(steps.indexOf(`git worktree remove --force --force ${WT}`)).toBeLessThan(
      steps.indexOf(`rm ${WT}`),
    )
  })

  // THE SAME LOCK WITH NO DIRECTORY LEFT, which is the variant a `fs.existsSync` gate on
  // the remove would skip — and skipping it is unrecoverable, because it is precisely the
  // record a prune cannot drop. MEASURED on git 2.50.1 (Apple Git-155) in that state
  // (locked, then `rm -rf` — a human clearing a tree that looked stuck): `worktree remove
  // --force <path>` still exits 128 with `fatal: cannot remove a locked working tree;` /
  // `use 'remove -f -f' to override or unlock first`, `--force --force` still exits 0 and
  // leaves `.git/worktrees` empty, and the `worktree add -B issue-95 <path> origin/main`
  // that had been failing 128 with `fatal: 'issue-95' is already used by worktree at
  // '<path>'` then exits 0. So the remove is asked unconditionally: git's answer to it
  // does not depend on the directory, and neither may this module's decision to ask.
  it('escalates for a locked leftover even when no directory is left to clear', () => {
    const rec = recorder({
      script: { [`worktree remove --force ${WT}`]: { status: 128, stderr: LOCKED } },
      present: [],
    })
    expect(createWorktree(ROOT, 'issue-7', 'dev', deps(rec))).toBe(WT)
    expect(rec.gitLines().filter((l) => l.startsWith('worktree remove'))).toEqual([
      `worktree remove --force ${WT}`,
      `worktree remove --force --force ${WT}`,
    ])
    // …and nothing was deleted from the disk, because there was nothing there. Asking git
    // unconditionally is not the same as sweeping unconditionally.
    expect(rec.rms()).toEqual([])
  })

  it('asks git the gentler documented way first, and stops there when git says yes', () => {
    // `-f -f` is only reached once git has said it is the only thing that will work —
    // the same rule the teardown follows, asserted here so the two cannot drift.
    const rec = recorder({ present: [WT] })
    createWorktree(ROOT, 'issue-7', 'dev', deps(rec))
    expect(rec.gitLines().filter((l) => l.startsWith('worktree remove'))).toEqual([
      `worktree remove --force ${WT}`,
    ])
  })

  // THE GAP THIS GUARDS AGAINST, which #218 shipped with and then closed: the prune
  // used to sit inside the `if (fs.existsSync(path))` branch, so it never ran when the
  // DIRECTORY was gone and the REGISTRATION was not. MEASURED on this machine: `git
  // worktree add -B <handle> <path> <start>` in that state exits 128 with `fatal:
  // '<handle>' is already used by worktree at '<path>'`, and an unconditional `git
  // worktree prune` immediately before the add makes the identical add succeed. A
  // createWorktree that threw there would meet templates/ralph.sh:740-744, which turns
  // the throw into `break` — so the regression this pins is not a slow iteration, it is
  // every future run of that issue aborting the whole loop until a human prunes by hand.
  it('prunes stale registrations even when no directory is left to clear', () => {
    const rec = recorder({ present: [] })
    createWorktree(ROOT, 'issue-7', 'dev', deps(rec))
    const lines = rec.gitLines()
    expect(lines).toContain('worktree prune')
    expect(lines.indexOf('worktree prune')).toBeLessThan(
      lines.findIndex((l) => l.startsWith('worktree add')),
    )
  })

  // THE STATE THAT PRODUCED IT, reached entirely through this module's own two verbs
  // and nothing exotic. MEASURED: a LOCKED worktree makes `git worktree remove
  // --force` exit 128 ("use 'remove -f -f' to override or unlock first"), and `git
  // worktree prune -v` does not drop a locked worktree's record even with the directory
  // already deleted. A teardown that absorbed that refusal, let its fs fallback take
  // the directory and pruned before the sweep therefore left exactly the state the test
  // above describes, with the next create paying for it. removeWorktree closes that
  // from both ends now — it escalates to `--force --force`, and its prune follows the
  // sweep — and this test pins the second half, by scripting BOTH remove spellings to
  // fail so the sweep is reached at all.
  it('a teardown that fell back to the fs sweep leaves a create that still works', () => {
    const teardown = recorder({
      script: { 'worktree remove': { status: 128, stderr: LOCKED } },
      present: [WT],
    })
    removeWorktree(ROOT, 'issue-7', deps(teardown))
    // The directory is gone…
    expect(teardown.rms().map((r) => r.path)).toEqual([WT])
    // …and the prune comes AFTER it, which is what this assertion pins: prune drops the
    // records whose directory is MISSING, so a prune ahead of the sweep runs while the
    // directory is still there and finds nothing to drop. (For a locked worktree git
    // declines even afterwards, which is why `--force --force` is the other half of the
    // fix and a reordering alone would not have been enough.)
    const steps = teardown.steps()
    expect(steps.filter((s) => s === 'git worktree prune').length).toBeGreaterThan(0)
    expect(steps.lastIndexOf('git worktree prune')).toBeGreaterThan(steps.indexOf(`rm ${WT}`))
  })

  it('never creates the worktree directory itself — only its parent, so git owns the checkout', () => {
    const rec = clean()
    createWorktree(ROOT, 'issue-7', 'dev', deps(rec))
    expect(rec.mkdirs().map((m) => m.path)).toEqual(['/repo/.ralph/worktrees'])
    expect(rec.mkdirs()[0].opts).toEqual({ recursive: true })
  })

  it('makes the parent BEFORE it asks git for anything, since git will not make it', () => {
    const rec = clean()
    createWorktree(ROOT, 'issue-7', 'dev', deps(rec))
    expect(rec.steps()[0]).toBe('mkdir /repo/.ralph/worktrees')
  })

  it('clears a leftover that is a FILE rather than a directory', () => {
    // A crashed run, an editor swap file, a `>` redirection that guessed the path:
    // existsSync answers true for either, and the recursive+force rmSync handles both.
    const rec = recorder({ script: { 'worktree remove': { status: 128 } }, present: [WT] })
    expect(createWorktree(ROOT, 'issue-7', 'dev', deps(rec))).toBe(WT)
    expect(rec.rms().map((r) => r.path)).toEqual([WT])
  })

  it('warns exactly once per failed fetch and still reaches the add', () => {
    const rec = recorder({ script: { fetch: { status: 128, stderr: 'could not resolve host\nhint\n' } } })
    expect(createWorktree(ROOT, 'issue-7', 'dev', deps(rec))).toBe(WT)
    expect(rec.stderrCalls).toHaveLength(1)
    expect(rec.stderrCalls[0].trimEnd().split('\n')).toHaveLength(1)
  })

  it('reports git exit status when git failed silently, rather than an empty parenthesis', () => {
    const rec = recorder({ script: { 'worktree add': { status: 128, stderr: '' } } })
    expect(() => createWorktree(ROOT, 'issue-7', 'dev', deps(rec))).toThrow(/exit 128/)
  })

  it('does not attempt the add when no base commit could be resolved', () => {
    const rec = recorder({ script: { 'rev-parse': { status: 1 } } })
    expect(() => createWorktree(ROOT, 'issue-7', 'dev', deps(rec))).toThrow(/cannot resolve/)
    expect(rec.gitLines().some((l) => l.startsWith('worktree add'))).toBe(false)
    // Both candidates were tried, in the documented order, before giving up. The leading
    // remove is the unconditional leftover-clearing ask: this double answers it with
    // success, so it stops at one line here, and it runs before any ref is resolved.
    expect(rec.gitLines()).toEqual([
      `worktree remove --force ${WT}`,
      'fetch origin dev',
      'rev-parse --verify --quiet origin/dev',
      'rev-parse --verify --quiet dev',
    ])
  })

  it('bases the tree on the LOCAL branch only after saying so on stderr', () => {
    const rec = recorder({ script: { 'rev-parse --verify --quiet origin/dev': { status: 1 } } })
    createWorktree(ROOT, 'issue-7', 'dev', deps(rec))
    expect(rec.stderrCalls).toHaveLength(1)
    expect(rec.stderrCalls[0]).toContain('origin/dev does not exist')
    expect(rec.gitLines()).toContain(`worktree add -B issue-7 ${WT} dev`)
  })
})

// ---------------------------------------------------------------------------
// 4. The CLI process contract, which is the surface templates/ralph.sh depends on
// ---------------------------------------------------------------------------

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'worktree.js')

function cli(...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('worktree.js CLI — the process contract the loop reads (#218 QA)', () => {
  it('exits 2 on every incomplete invocation, and 2 is distinguishable from a refusal', () => {
    // templates/ralph.sh only tests `if ! issue_worktree=$(…)`, so 1 and 2 are the
    // same to it today — but they are not the same fault (a bad argv is a Ralph bug, a
    // refusal is the user's repository) and the codes have to keep saying which.
    for (const argv of [[], ['path'], ['path', '/tmp/p'], ['remove'], ['remove', '/tmp/p'], ['create', '/tmp/p', 'issue-7']]) {
      const res = cli(...argv)
      expect(res.status, `argv: ${JSON.stringify(argv)}`).toBe(2)
      expect(res.stderr).toMatch(/^usage: worktree\.js /)
      expect(res.stdout).toBe('')
    }
  })

  it.each([
    ['a capitalized verb', ['PATH', '/tmp/p', 'issue-7']],
    ['a near-miss verb', ['paths', '/tmp/p', 'issue-7']],
    ['an inherited Object property as the verb', ['constructor', '/tmp/p', 'issue-7']],
    ['a prototype-shaped verb', ['__proto__', '/tmp/p', 'issue-7']],
    ['a verb with surrounding whitespace', [' path ', '/tmp/p', 'issue-7']],
  ])('rejects %s with usage rather than running something', (_label, argv) => {
    const res = cli(...argv)
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(/^usage: worktree\.js /)
  })

  it.each([
    ['path', ['path', '/', 'issue-7']],
    ['path with a traversal handle', ['path', '/tmp/p', '../../etc']],
    ['remove', ['remove', '/', 'issue-7']],
    ['remove with a flag-shaped handle', ['remove', '/tmp/p', '--force']],
    ['create with a flag-shaped base ref', ['create', '/tmp/p', 'issue-7', '-f']],
  ])('turns a %s refusal into one stderr line, exit 1, no stack and no stdout', (_label, argv) => {
    const res = cli(...argv)
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/^worktree\.js: \w+ failed \(refusing /)
    expect(res.stderr.trimEnd().split('\n')).toHaveLength(1)
    expect(res.stderr).not.toContain('    at ')
    expect(res.stdout).toBe('')
  })

  it('prints the path and nothing else — one line, one trailing newline', () => {
    const res = cli('path', '/tmp/ralph-wt-qa/project', 'issue-7')
    expect(res.stdout).toBe('/tmp/ralph-wt-qa/project/.ralph/worktrees/issue-7\n')
    expect(res.stderr).toBe('')
    expect(res.status).toBe(0)
  })

  it('ignores a trailing argument `path` has no use for, rather than failing the loop', () => {
    const res = cli('path', '/tmp/ralph-wt-qa/project', 'issue-7', 'dev', 'extra')
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe('/tmp/ralph-wt-qa/project/.ralph/worktrees/issue-7')
  })

  it('`remove` against a path that was never a repository is a silent success', () => {
    // The loop calls remove with `|| true`, but the exit code still has to be honest:
    // there is nothing to remove and nothing went wrong.
    const dir = mkdtempSync(join(tmpdir(), 'ralph-wt-qa-rm-'))
    try {
      const res = cli('remove', dir, 'issue-7')
      expect(res.status).toBe(0)
      expect(res.stdout).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('`create` against a path that is not a repository fails with prose, not a stack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-wt-qa-create-'))
    try {
      const res = cli('create', dir, 'issue-7', 'main')
      expect(res.status).toBe(1)
      expect(res.stdout).toBe('')
      expect(res.stderr).not.toContain('    at ')
      // The last line is the verdict; the lines above it are the two best-effort
      // warnings, which is what a human needs to see in that order.
      const lines = res.stderr.trimEnd().split('\n')
      expect(lines[lines.length - 1]).toMatch(/^worktree\.js: create failed \(/)
      // It got as far as making the parent directory before git said no. Stated
      // because it is a real side effect on a path that turned out to be unusable.
      expect(existsSync(join(dir, '.ralph', 'worktrees'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 5. The seed step in the create path (#219 QA)
// ---------------------------------------------------------------------------
//
// lib/worktree-seed.qa.test.js drives the selection rules with no git in sight. What is
// left over for this file is the two questions that need the create path itself:
//
//   • the DEFAULT seams. createWorktree's `fs` seam widened for #219 (copyFileSync and
//     statSync joined existsSync/mkdirSync/rmSync) and the only production caller is the
//     CLI at the bottom of lib/worktree.js, which passes no seams at all. A default
//     object missing one of the four is a TypeError inside the seed step, and — since
//     templates/ralph.sh:745-749 turns a throw out of `create` into `❌ … Aborting the
//     loop.` and `break` — a per-issue deadlock rather than a lost file. So the first test
//     here overrides NOTHING but `home` and drives real git against a real repository.
//   • IDEMPOTENCY, which section 3 above establishes for the git half. The seed half has
//     its own version of it: the second run of the same handle must re-seed from the main
//     root rather than inherit whatever the dead run's agent left in the tree.
//
// The measurements the first test rests on, taken on git 2.50.1 (Apple Git-155) against a
// throwaway repository whose .gitignore lists `.env.local` and `node_modules/` and which
// has both on disk: `git worktree add -B issue-7 <path> main` exits 0 and produces a tree
// holding exactly `.git`, `.gitignore` and `README.md` — the gitignored pair is in no tree
// and no checkout can produce it — and an add into a directory that already holds one file
// exits 128 with `fatal: '<path>' already exists`, which is why the seed can only run
// after the add.

// A real repository on one commit, gitignoring the two things #219 is about, with both of
// them on disk and untracked. No remote: `git fetch origin main` and `rev-parse
// origin/main` both fail, so createWorktree takes its documented local-branch fallback and
// writes two warnings — which is the offline path a user on a plane gets, exercised here
// for free.
function realRepo() {
  const sandbox = mkdtempSync(join(tmpdir(), 'ralph-seed-git-'))
  const root = join(sandbox, 'project')
  mkdirSync(root, { recursive: true })
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  g('init', '-q', '--initial-branch=main')
  g('config', 'user.email', 'ralph@example.test')
  g('config', 'user.name', 'Ralph Test')
  g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), '.ralph/\n.env.local\nnode_modules/\n')
  writeFileSync(join(root, 'README.md'), 'tracked\n')
  g('add', '.')
  g('commit', '-q', '-m', 'chore: seed')
  writeFileSync(join(root, '.env.local'), 'ANTHROPIC_API_KEY=sk-local\n')
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  return { sandbox, root, git: g }
}

describe('createWorktree against real git, with the module its own default seams (#219 QA)', () => {
  it('seeds the gitignored file into a tree git could not have produced it in', () => {
    const { sandbox, root, git } = realRepo()
    try {
      // THE VACUITY CONTROL, first and by hand: the same repository, the same commit, a
      // plain `git worktree add` and no seed step. If `.env.local` showed up here, every
      // assertion about seeding in this package would be passing for the wrong reason.
      const plain = join(sandbox, 'plain-add')
      git('worktree', 'add', '-q', '-B', 'issue-9', plain, 'main')
      expect(readdirSync(plain).sort()).toEqual(['.git', '.gitignore', 'README.md'])

      // No `fs` and no `git` override — the real defaults, which is the point.
      const path = createWorktree(root, 'issue-7', 'main', {
        home: join(sandbox, 'not-a-home'),
        processEnv: {},
        stderr: { write: () => {} },
      })
      expect(path).toBe(join(root, '.ralph', 'worktrees', 'issue-7'))
      expect(readdirSync(path).sort()).toEqual(['.env.local', '.git', '.gitignore', 'README.md'])
      expect(readFileSync(join(path, '.env.local'), 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
      // A copy, so the agent cannot write through to the user's file…
      expect(lstatSync(join(path, '.env.local')).isSymbolicLink()).toBe(false)
      writeFileSync(join(path, '.env.local'), 'ANTHROPIC_API_KEY=sk-agent-overwrote-it\n')
      expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
      // …and node_modules is in neither form, while the main root still has one, so the
      // negative is about the seed step and not about a fixture that never had the
      // directory.
      expect(existsSync(join(path, 'node_modules'))).toBe(false)
      expect(existsSync(join(root, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('reads the knob off the process environment when nothing is injected', () => {
    // The transport the loop actually uses: templates/ralph.sh sources ralph.config.sh
    // with `set -a`, so the value arrives as an ordinary environment variable of the
    // `node lib/worktree.js create` child. Nothing overrides `processEnv` here, so the
    // default parameter (`process.env`) is what answers — restored by the suite's
    // per-test snapshot (test/setup/hermetic-env.js).
    const { sandbox, root } = realRepo()
    process.env.RALPH_WORKTREE_SEED_FILES = ''
    try {
      const path = createWorktree(root, 'issue-7', 'main', {
        home: join(sandbox, 'not-a-home'),
        stderr: { write: () => {} },
      })
      expect(existsSync(join(path, '.env.local'))).toBe(false)
      expect(readdirSync(path).sort()).toEqual(['.git', '.gitignore', 'README.md'])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('worktree.js CLI — a refused seed entry must not fail the create (#219 QA)', () => {
  it('exits 0 with the path on stdout and the refusal on stderr', () => {
    // The whole anti-deadlock decision, at the only boundary that can enforce it: the
    // loop reads `if ! issue_worktree=$(node lib/worktree.js create …)`, so a non-zero
    // exit here is `break` — every future iteration of every issue gone until a human
    // edits the config line. One typo on that line must cost one file.
    const { sandbox, root } = realRepo()
    try {
      const res = spawnSync(process.execPath, [CLI, 'create', root, 'issue-7', 'main'], {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          HOME: join(sandbox, 'not-a-home'),
          RALPH_WORKTREE_SEED_FILES: '/etc/hosts ../../../outside.env node_modules .env.local',
        },
      })
      const path = join(root, '.ralph', 'worktrees', 'issue-7')
      expect(res.status).toBe(0)
      expect(res.stdout).toBe(`${path}\n`)
      // Every refused entry is named, once each, and the legitimate one still landed.
      expect(res.stderr).toContain('/etc/hosts')
      expect(res.stderr).toContain('../../../outside.env')
      expect(res.stderr).toContain('node_modules')
      expect(res.stderr).not.toContain('    at ')
      expect(readFileSync(join(path, '.env.local'), 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
      expect(readdirSync(path).sort()).toEqual(['.env.local', '.git', '.gitignore', 'README.md'])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('createWorktree — the seed survives a second run of the same handle (#219 QA)', () => {
  // A git double that MAKES the tree, so the fs the seed step writes into looks like a
  // checkout: `.git` as a gitdir pointer FILE (not a directory) and one tracked file.
  // Section 3's recorder cannot be reused here — its fs seam is the three methods
  // removeWorktree needs, and the seed step reads and copies.
  const checkoutGit = (vol) => (args) => {
    if (args.join(' ').startsWith('worktree add')) {
      vol.mkdirSync(WT, { recursive: true })
      vol.writeFileSync(`${WT}/.git`, 'gitdir: /repo/.git/worktrees/issue-7\n')
      vol.writeFileSync(`${WT}/README.md`, 'tracked\n')
    }
    return { status: 0, stdout: '', stderr: '' }
  }

  it('re-seeds from the main root and drops what the dead run left behind', () => {
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.env.local': 'ANTHROPIC_API_KEY=sk-local\n',
    })
    const deps = {
      fs: vol,
      git: checkoutGit(vol),
      home: HOME,
      processEnv: {},
      stderr: { write: () => {} },
    }
    createWorktree(ROOT, 'issue-7', 'dev', deps)
    expect(vol.readFileSync(`${WT}/.env.local`, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')

    // The iteration crashes here. Its agent had edited the seeded copy and left a scratch
    // file, and the tree is still on disk — the state section 3 above is about.
    vol.writeFileSync(`${WT}/.env.local`, 'ANTHROPIC_API_KEY=sk-agent-edited\n')
    vol.writeFileSync(`${WT}/scratch.txt`, 'from the dead run\n')

    createWorktree(ROOT, 'issue-7', 'dev', deps)
    // A FRESH copy of the user's file, not the dead run's edit: the seed is part of
    // making the tree, not a one-off migration.
    expect(vol.readFileSync(`${WT}/.env.local`, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
    // …and the leftover-clearing rmSync took the scratch file with the tree, without
    // reaching the main root's copy of the seed file.
    expect(vol.existsSync(`${WT}/scratch.txt`)).toBe(false)
    expect(vol.readFileSync('/repo/.env.local', 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
  })

  it('never deletes the main root file it seeds from, whatever the leftover state', () => {
    // The recursive delete in the create path is aimed at the worktree, and the seed step
    // hands it a second reason to be sure of that: the source of every copy lives in the
    // main root. Both remove spellings are scripted to fail so the fs sweep is reached.
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.env.local': 'ANTHROPIC_API_KEY=sk-local\n',
      '/repo/.ralph/worktrees/issue-7/stale': 'leftover\n',
    })
    const rms = []
    const fs = {
      existsSync: (p) => vol.existsSync(p),
      mkdirSync: (p, o) => vol.mkdirSync(p, o),
      rmSync: (p, o) => {
        rms.push(p)
        vol.rmSync(p, o)
      },
      statSync: (p) => vol.statSync(p),
      copyFileSync: (a, b) => vol.copyFileSync(a, b),
    }
    const git = (args) => {
      const line = args.join(' ')
      if (line.startsWith('worktree remove')) return { status: 128, stderr: 'nope\n' }
      return checkoutGit(vol)(args)
    }
    createWorktree(ROOT, 'issue-7', 'dev', {
      fs,
      git,
      home: HOME,
      processEnv: {},
      stderr: { write: () => {} },
    })
    expect(rms).toEqual([WT])
    expect(vol.readFileSync('/repo/.env.local', 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
    expect(vol.readFileSync(`${WT}/.env.local`, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
  })
})
