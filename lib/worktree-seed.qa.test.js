import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Volume } from 'memfs'
import { DEFAULT_SEED_FILES, SEED_FILES_VAR, seedList, seedWorktree } from './worktree-seed.js'
import { RALPH_HOME, templatePath } from './paths.js'

// QA augmentation for #219. lib/worktree-seed.test.js owns the feature as designed: the
// default list, the five-row separator table, both defaults copied, the silent no-op, the
// four-row refusal table, the directory refusal, one absorbed EACCES, the two precondition
// throws. This file attacks the same three claims from the directions that spec cannot
// reach, and the claims are worth restating because they are what the isolation rests on:
//
//   1. NOTHING OUTSIDE THE WORKTREE IS WRITTEN. The entry guard is a string comparison
//      against the resolved main root, so this file probes the spellings a string
//      comparison can miss (a bare `..`, a trailing slash, a Windows-shaped path, an
//      entry that resolves back INTO the worktree or into `.ralph/`) and then asks the
//      stronger question the refusal table cannot: after a run over a hostile list, is
//      every byte outside the worktree unchanged?
//   2. COPIED, NEVER LINKED. `lstatSync(dest).isSymbolicLink() === false` is one half of
//      it. The other half is what happens when a LINK is already there — in the main root
//      as the source, or in the checkout as the destination — because `copyFileSync`
//      follows both ends. Both are driven here.
//   3. A BAD ENTRY COSTS ITS OWN FILE AND NEVER THE RUN. templates/ralph.sh turns a throw
//      out of the create path into `break` (templates/ralph.sh:745-749, `❌ ralph.sh: could
//      not create a worktree … Aborting the loop.`), so any escape from this module is a
//      per-issue deadlock rather than a lost file. Every fs verb the module calls is
//      therefore made to fail in turn, not just the one the dev's spec fails.
//
// Everything asserted about node's and bash's behaviour below was MEASURED on this
// machine (node v20.20.2, darwin 25.6.0, git 2.50.1 / Apple Git-155, bash 3.2) before it
// was written down; the measurement sits beside the assertion that rests on it.

// Control characters are spelled with String.fromCharCode rather than written raw, the
// same rule lib/worktree.qa.test.js follows: test/source-control-bytes.test.js forbids a
// raw C0 byte in a tracked file. NBSP is not a C0 byte but is written the same way, since
// a literal one is invisible in a diff and this file makes a claim about it.
const TAB = String.fromCharCode(9)
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const NBSP = String.fromCharCode(160)

const ROOT = '/repo'
const WT = '/repo/.ralph/worktrees/issue-7'

function makeStderr() {
  const calls = []
  return { write: (m) => calls.push(m), calls, text: () => calls.join('') }
}

// The main root as a ralph-managed project looks on disk, plus the run state the loop
// keeps at that root (`.ralph/run-state.json`) — which is the one thing under `.ralph/`
// a seed step must never be able to write to.
const mainRoot = (extra = {}) =>
  Volume.fromJSON({
    '/repo/.git/HEAD': 'ref: refs/heads/main\n',
    '/repo/.git/config': '[core]\n\trepositoryformatversion = 0\n',
    '/repo/README.md': 'tracked\n',
    '/repo/.env.local': 'ANTHROPIC_API_KEY=sk-local\n',
    '/repo/.mcp.json': '{"mcpServers":{}}\n',
    '/repo/.ralph/run-state.json': '{"issue":7}\n',
    '/repo/node_modules/left-pad/index.js': 'module.exports = 1\n',
    ...extra,
  })

// Everything the volume holds EXCEPT the worktree, which is the only place a seed step is
// allowed to write. Compared before and after a run, this answers the question a
// per-entry refusal table cannot: did anything at all leak out of the destination tree?
const outsideTheWorktree = (vol) =>
  Object.fromEntries(Object.entries(vol.toJSON()).filter(([p]) => !p.startsWith(`${WT}/`)))

const knob = (value) => ({ [SEED_FILES_VAR]: value })

// ---------------------------------------------------------------------------
// 1. seedList — the values a hand-edited config file can actually hold
// ---------------------------------------------------------------------------

describe('seedList — hostile and malformed knob values (#219 QA)', () => {
  it.each([
    ['a lone comma', ','],
    ['commas and blanks only', ', , ,'],
    ['nothing but commas', ',,,'],
    ['a tab only', TAB],
    ['a CRLF only', CR + LF],
  ])('reads %s as "seed nothing" rather than as one nameless entry', (_label, value) => {
    // The empty string must never reach the copy loop: `resolve(root, '')` IS the root,
    // which would be refused (the dev's table pins `.`), but it would be refused ONCE PER
    // BLANK — a warning per iteration about a value that says nothing.
    expect(seedList({ processEnv: knob(value) })).toEqual([])
  })

  it('drops the empty entry between two separators instead of carrying it', () => {
    expect(seedList({ processEnv: knob('a,,b') })).toEqual(['a', 'b'])
    expect(seedList({ processEnv: knob('.env.local, ,.mcp.json') })).toEqual([
      '.env.local',
      '.mcp.json',
    ])
    expect(seedList({ processEnv: knob(',.env.local,') })).toEqual(['.env.local'])
  })

  // A CONFIG FILE EDITED ON WINDOWS is the case that matters here. MEASURED: bash keeps a
  // trailing CR as part of the value (`RALPH_WORKTREE_SEED_FILES=".env.local"` followed by
  // CRLF exports `.env.local` + CR), and a filename with a CR in it exists nowhere — so a
  // CR that survived into an entry would make the whole feature a silent no-op. JS `\s`
  // covers CR, LF, TAB and U+00A0, so the split absorbs all four.
  it.each([
    ['a trailing CR', `.env.local${CR}`, ['.env.local']],
    ['CRLF between entries', `.env.local${CR}${LF}.mcp.json`, ['.env.local', '.mcp.json']],
    ['a bare newline', `.env.local${LF}.mcp.json`, ['.env.local', '.mcp.json']],
    ['a tab', `.env.local${TAB}.mcp.json`, ['.env.local', '.mcp.json']],
    ['a non-breaking space', `.env.local${NBSP}.mcp.json`, ['.env.local', '.mcp.json']],
  ])('strips %s, so no invisible byte becomes part of a filename', (_label, value, expected) => {
    expect(seedList({ processEnv: knob(value) })).toEqual(expected)
  })

  it.each([
    ['a number', 123, ['123']],
    ['a boolean', false, ['false']],
    ['an array (String() joins it with commas, which is a separator)', ['a', 'b'], ['a', 'b']],
  ])('coerces %s rather than throwing on it', (_label, value, expected) => {
    // The knob's real transport is `set -a`, which can only ever hand this process a
    // string. An embedder that injects its own bag is the case these cover, and the answer
    // that matters is "does not throw": a TypeError here reaches templates/ralph.sh as an
    // aborted loop.
    expect(seedList({ processEnv: knob(value) })).toEqual(expected)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('treats a %s value as UNSET, so the defaults still apply', (_label, value) => {
    expect(seedList({ processEnv: knob(value) })).toEqual([...DEFAULT_SEED_FILES])
  })

  it('survives a missing bag and a null-prototype bag, which is what process.env is like', () => {
    expect(seedList({ processEnv: null })).toEqual([...DEFAULT_SEED_FILES])
    expect(seedList({ processEnv: undefined })).toEqual([...DEFAULT_SEED_FILES])
    const bare = Object.create(null)
    bare[SEED_FILES_VAR] = '.env.local'
    expect(seedList({ processEnv: bare })).toEqual(['.env.local'])
  })

  it('keeps a long list whole, in order, and does NOT de-duplicate it', () => {
    const many = Array.from({ length: 500 }, (_, i) => `f${i}`)
    expect(seedList({ processEnv: knob(many.join(' ')) })).toEqual(many)
    // No dedupe, stated rather than assumed: a name written twice is copied twice, which
    // is only harmless because the copy is idempotent (driven below).
    expect(seedList({ processEnv: knob('.env.local .env.local') })).toEqual([
      '.env.local',
      '.env.local',
    ])
  })
})

// ---------------------------------------------------------------------------
// 2. The path guard, from the spellings a string comparison can miss
// ---------------------------------------------------------------------------

describe('seedWorktree — path escapes the refusal table has to catch (#219 QA)', () => {
  it.each([
    ['a bare parent reference', '..'],
    ['a dot-slash escape', './../x'],
    ['a trailing-slash escape', '../'],
    ['a deep escape that lands on a system file', 'a/b/c/../../../../etc/passwd'],
    ['the filesystem root', '/'],
    ['the project root spelled absolutely', ROOT],
    ['an absolute path INSIDE the root', `${ROOT}/.env.local`],
  ])('refuses %s, copies nothing, and names the value on stderr', (_label, entry) => {
    const vol = mainRoot({ '/outside.env': 'SECRET=from-outside\n', '/etc/passwd': 'root:x\n' })
    const stderr = makeStderr()
    const before = outsideTheWorktree(vol)
    expect(seedWorktree(ROOT, WT, { fs: vol, processEnv: knob(entry), stderr })).toEqual([])
    expect(stderr.text()).toMatch(/refusing/i)
    expect(stderr.text()).toContain(entry)
    // Nothing was created in the worktree either — a refusal is not a rename.
    expect(vol.existsSync(WT)).toBe(false)
    expect(outsideTheWorktree(vol)).toEqual(before)
  })

  // AN ABSOLUTE PATH THAT POINTS INSIDE THE ROOT IS STILL REFUSED, and that is the right
  // answer rather than a missed case: the guard cannot tell `/repo/.env.local` written by
  // a user who meant "this repo" from one written when the loop is running in a different
  // checkout of the same project, and the entry has a spelling that always works.
  it('says why an absolute entry is refused, in the words the config file uses', () => {
    const stderr = makeStderr()
    seedWorktree(ROOT, WT, { fs: mainRoot(), processEnv: knob(`${ROOT}/.env.local`), stderr })
    expect(stderr.text()).toContain('absolute path')
    expect(stderr.text()).toContain('inside the project root')
  })

  // THE PLATFORM ASSUMPTION, disclosed rather than asserted as a virtue. On darwin/linux a
  // Windows-shaped path is an ordinary relative filename with odd characters in it: it
  // resolves INSIDE the root, does not exist, and is therefore the silent no-op every
  // absent entry is. MEASURED: neither spelling warns, and neither copies.
  it.each([
    ['a drive-letter path', 'C:' + String.fromCharCode(92) + 'x'],
    ['a UNC path', String.fromCharCode(92, 92) + 'host' + String.fromCharCode(92) + 'share'],
  ])('treats %s as a name that simply does not exist on a posix host', (_label, entry) => {
    const vol = mainRoot()
    const stderr = makeStderr()
    expect(seedWorktree(ROOT, WT, { fs: vol, processEnv: knob(entry), stderr })).toEqual([])
    expect(stderr.calls).toEqual([])
    expect(vol.existsSync(WT)).toBe(false)
  })

  it('refuses the worktree directory itself, which is inside the root and is a directory', () => {
    // Reachable by hand (`RALPH_WORKTREE_SEED_FILES=".ralph/worktrees/issue-7"`) and, more
    // to the point, the shape a user reaches for when they want "everything Ralph made".
    const vol = mainRoot()
    vol.mkdirSync(WT, { recursive: true })
    const stderr = makeStderr()
    expect(
      seedWorktree(ROOT, WT, {
        fs: vol,
        processEnv: knob('.ralph/worktrees/issue-7'),
        stderr,
      }),
    ).toEqual([])
    expect(stderr.text()).toContain('not a regular file')
    expect(vol.readdirSync(WT)).toEqual([])
  })

  it('cannot reach the loop RUN STATE at the main root, even when the entry names it', () => {
    // `.ralph/run-state.json` resolves inside the root and IS a regular file, so it is
    // copied rather than refused — but the destination is always `join(worktree, entry)`,
    // so what the copy produces is the worktree's own `.ralph/`, and the main root's file
    // is untouched. That is the property, driven rather than reasoned about.
    const vol = mainRoot()
    const copied = seedWorktree(ROOT, WT, {
      fs: vol,
      processEnv: knob('.ralph/run-state.json'),
      stderr: makeStderr(),
    })
    expect(copied).toEqual(['.ralph/run-state.json'])
    expect(vol.readFileSync(`${WT}/.ralph/run-state.json`, 'utf8')).toBe('{"issue":7}\n')
    expect(vol.readFileSync('/repo/.ralph/run-state.json', 'utf8')).toBe('{"issue":7}\n')
  })

  it('leaves every byte outside the worktree alone after a whole hostile list', () => {
    // The question the per-entry table cannot ask. One run, one list holding every shape
    // above plus the two that are allowed, and the whole volume outside the destination
    // compared byte for byte afterwards.
    const vol = mainRoot({ '/outside.env': 'SECRET=from-outside\n' })
    const before = outsideTheWorktree(vol)
    const hostile = [
      '..',
      '../outside.env',
      './../outside.env',
      '/etc/hosts',
      ROOT,
      '.',
      'node_modules',
      'sub/../../outside.env',
      '.env.local',
      '.mcp.json',
    ].join(' ')
    const copied = seedWorktree(ROOT, WT, {
      fs: vol,
      processEnv: knob(hostile),
      stderr: makeStderr(),
    })
    // The two legitimate entries still landed: the run carried on past six refusals.
    expect(copied).toEqual(['.env.local', '.mcp.json'])
    expect(outsideTheWorktree(vol)).toEqual(before)
    expect(vol.readdirSync(WT).sort()).toEqual(['.env.local', '.mcp.json'])
  })

  it('cannot corrupt the gitdir POINTER a real worktree has instead of a .git directory', () => {
    // `git worktree add` writes a `.git` FILE in the tree (`gitdir: …`), and an entry of
    // `.git/config` therefore asks the seed step to make a directory where that file is.
    // MEASURED on node v20.20.2: `mkdirSync(<existing file>, { recursive: true })` throws
    // EEXIST on real fs, and memfs answers the same case from `copyFileSync` with ENOTDIR
    // — either way it is inside the try, so it warns and carries on. What must not happen
    // is the pointer being replaced, which would leave a tree git no longer recognizes.
    const vol = mainRoot()
    vol.mkdirSync(WT, { recursive: true })
    vol.writeFileSync(`${WT}/.git`, 'gitdir: /repo/.git/worktrees/issue-7\n')
    const stderr = makeStderr()
    const copied = seedWorktree(ROOT, WT, {
      fs: vol,
      processEnv: knob('.git/config .env.local'),
      stderr,
    })
    expect(copied).toEqual(['.env.local'])
    expect(stderr.text()).toContain('.git/config')
    expect(vol.readFileSync(`${WT}/.git`, 'utf8')).toBe('gitdir: /repo/.git/worktrees/issue-7\n')
    expect(vol.lstatSync(`${WT}/.git`).isFile()).toBe(true)
  })

  it('copies a name the repository TRACKS if the list says so, with no gitignore check', () => {
    // The disclosed scope of the knob: it is a list of paths, not a query about git's
    // index. A user who names a tracked file gets their working copy of it laid over the
    // checkout — pinned so the trust boundary is visible rather than assumed.
    const vol = mainRoot()
    vol.writeFileSync('/repo/README.md', 'tracked, and edited by the user\n')
    vol.mkdirSync(WT, { recursive: true })
    vol.writeFileSync(`${WT}/README.md`, 'tracked\n')
    expect(
      seedWorktree(ROOT, WT, { fs: vol, processEnv: knob('README.md'), stderr: makeStderr() }),
    ).toEqual(['README.md'])
    expect(vol.readFileSync(`${WT}/README.md`, 'utf8')).toBe('tracked, and edited by the user\n')
  })
})

// ---------------------------------------------------------------------------
// 3. Symlinks, at both ends of the copy
// ---------------------------------------------------------------------------

describe('seedWorktree — links at the source and at the destination (#219 QA)', () => {
  it('follows a symlinked SOURCE that points outside the root, and still writes a plain file', () => {
    // DISCLOSED, not celebrated: the guard reads the ENTRY, so `.env.local` naming a link
    // to `/outside/secret.env` is copied — a repo whose local credentials live in a
    // password vault and are linked in is the ordinary reason for that shape, and refusing
    // it would break that setup for no gain (the agent can read the vault path anyway).
    // What the criterion actually demands survives it: the destination is a REGULAR file,
    // so the agent writing to its copy cannot reach the link's target.
    const vol = mainRoot({ '/outside/secret.env': 'SECRET=smuggled\n' })
    vol.unlinkSync('/repo/.env.local')
    vol.symlinkSync('/outside/secret.env', '/repo/.env.local')
    const stderr = makeStderr()
    const copied = seedWorktree(ROOT, WT, { fs: vol, processEnv: knob('.env.local'), stderr })
    expect(copied).toEqual(['.env.local'])
    expect(vol.readFileSync(`${WT}/.env.local`, 'utf8')).toBe('SECRET=smuggled\n')
    expect(vol.lstatSync(`${WT}/.env.local`).isSymbolicLink()).toBe(false)
    vol.writeFileSync(`${WT}/.env.local`, 'AGENT_OVERWROTE=1\n')
    expect(vol.readFileSync('/outside/secret.env', 'utf8')).toBe('SECRET=smuggled\n')
  })

  it('still refuses node_modules when it is a SYMLINK to a directory elsewhere', () => {
    // The structural reason node_modules cannot be seeded is `statSync().isFile()`, and
    // statSync FOLLOWS links — so the pnpm/monorepo shape (`node_modules` linked into a
    // store) is refused for the same reason a plain directory is, rather than sneaking
    // through as "a link, not a directory".
    const vol = mainRoot({ '/store/left-pad/index.js': 'module.exports = 1\n' })
    vol.rmSync('/repo/node_modules', { recursive: true, force: true })
    vol.symlinkSync('/store', '/repo/node_modules')
    const stderr = makeStderr()
    expect(
      seedWorktree(ROOT, WT, { fs: vol, processEnv: knob('node_modules'), stderr }),
    ).toEqual([])
    expect(stderr.text()).toContain('not a regular file')
    expect(vol.existsSync(`${WT}/node_modules`)).toBe(false)
  })

  it('is a silent no-op for a DANGLING symlink in the main root', () => {
    // `existsSync` follows the link and answers false for a broken one, so this lands in
    // the absent-and-therefore-silent case rather than throwing out of statSync.
    const vol = mainRoot()
    vol.unlinkSync('/repo/.env.local')
    vol.symlinkSync('/repo/gone.env', '/repo/.env.local')
    const stderr = makeStderr()
    expect(
      seedWorktree(ROOT, WT, { fs: vol, processEnv: knob('.env.local'), stderr }),
    ).toEqual([])
    expect(stderr.calls).toEqual([])
  })

  // THE CRITERION, from the direction the dev's spec does not look: a link at the
  // DESTINATION. Real fs and the module's own default seam, because this is a claim about
  // what node's copyFileSync does rather than about what memfs models.
  it('never writes outside the worktree, even when the checkout put a symlink at the destination', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ralph-seed-qa-link-'))
    try {
      const root = join(sandbox, 'repo')
      const tree = join(root, '.ralph', 'worktrees', 'issue-7')
      mkdirSync(tree, { recursive: true })
      writeFileSync(join(root, '.env.local'), 'FROM-THE-MAIN-ROOT\n')
      // The user's own tracked file, three levels up from the worktree — which is exactly
      // where `git worktree add` puts the tree, so a repository that TRACKS a symlink at a
      // seeded name checks that link out into the destination the seed step is about to
      // write.
      //
      // MEASURED on node v20.20.2 / darwin and on memfs alike, copying onto a symlinked
      // destination: the LINK TARGET is overwritten with the source bytes and
      // `lstatSync(dest).isSymbolicLink()` is still true afterwards. So both halves of the
      // module's promise break at once — the write escapes the worktree, and what the agent
      // holds is a link into the main root rather than the copy it was promised. Nothing in
      // the module lstats the destination, so both assertions below are defect claims.
      writeFileSync(join(root, 'victim.txt'), 'THE USER FILE\n')
      symlinkSync(join('..', '..', '..', 'victim.txt'), join(tree, '.env.local'))

      const stderr = makeStderr()
      seedWorktree(root, tree, { processEnv: knob('.env.local'), stderr })

      // The main root is untouched — the whole point of resolving the entry against it.
      expect(readFileSync(join(root, 'victim.txt'), 'utf8')).toBe('THE USER FILE\n')
      // And the tree got a real file of its own, which is the other half of the claim.
      expect(lstatSync(join(tree, '.env.local')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(tree, '.env.local'), 'utf8')).toBe('FROM-THE-MAIN-ROOT\n')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Every fs verb the module calls, made to fail in turn
// ---------------------------------------------------------------------------

describe('seedWorktree — an fs that misbehaves costs a file, never the run (#219 QA)', () => {
  // One fake fs over a real memfs volume, with any single verb overridable. The dev's
  // spec builds the same shape for the EACCES case; this generalizes it so each verb can
  // be failed in turn, which is what "never throws for anything about one entry" means.
  const failing = (vol, overrides) => ({
    existsSync: (p) => vol.existsSync(p),
    statSync: (p) => vol.statSync(p),
    mkdirSync: (p, o) => vol.mkdirSync(p, o),
    copyFileSync: (a, b) => vol.copyFileSync(a, b),
    ...overrides,
  })

  const err = (code, message) => {
    const e = new Error(`${code}: ${message}`)
    e.code = code
    return e
  }

  it('does not throw when the source vanishes between the existence check and the stat', () => {
    // TOCTOU, and the realistic version of it is not a race at all: an `.env.local` on a
    // network mount or an external volume that answers existsSync and then fails the stat
    // (EIO, EPERM), or a user's `rm` landing between the two calls. The invariant this
    // module states for itself is that ONE entry can never cost the run — and a throw here
    // is not a lost file, it is templates/ralph.sh's `break`.
    const vol = mainRoot()
    const stderr = makeStderr()
    const fs = failing(vol, {
      statSync: (p) => {
        if (p.endsWith('.env.local')) throw err('ENOENT', `no such file or directory, stat '${p}'`)
        return vol.statSync(p)
      },
    })
    let copied
    expect(() => {
      copied = seedWorktree(ROOT, WT, { fs, processEnv: {}, stderr })
    }).not.toThrow()
    // The rest of the list is still seeded, and the failure is named on stderr.
    expect(copied).toEqual(['.mcp.json'])
    expect(stderr.text()).toContain('.env.local')
  })

  it('absorbs a destination directory it cannot create, and tries the next entry', () => {
    const vol = mainRoot({ '/repo/.config/local.json': '{"a":1}\n' })
    const stderr = makeStderr()
    const fs = failing(vol, {
      mkdirSync: (p, o) => {
        if (p.endsWith('.config')) throw err('EACCES', `permission denied, mkdir '${p}'`)
        return vol.mkdirSync(p, o)
      },
    })
    const copied = seedWorktree(ROOT, WT, {
      fs,
      processEnv: knob('.config/local.json .env.local'),
      stderr,
    })
    expect(copied).toEqual(['.env.local'])
    expect(stderr.text()).toContain('.config/local.json')
    expect(stderr.text()).toContain('permission denied')
  })

  it('absorbs ENOSPC on the FIRST entry and still seeds the rest of the list', () => {
    // Order matters: a failure on the last entry proves nothing about whether the loop
    // continues. The dev's EACCES case fails `.env.local`, which is first in the default
    // list — this one keeps that shape and adds the count, so a `break` slipped in place
    // of the `continue` would fail here.
    const vol = mainRoot()
    const stderr = makeStderr()
    let calls = 0
    const fs = failing(vol, {
      copyFileSync: (a, b) => {
        calls += 1
        if (calls === 1) throw err('ENOSPC', 'no space left on device, copyfile')
        return vol.copyFileSync(a, b)
      },
    })
    expect(seedWorktree(ROOT, WT, { fs, processEnv: {}, stderr })).toEqual(['.mcp.json'])
    expect(stderr.text()).toContain('no space left on device')
    expect(stderr.calls).toHaveLength(1)
  })

  it('refuses a source that is neither a regular file nor a directory (a FIFO, a socket)', () => {
    const stderr = makeStderr()
    const fs = {
      existsSync: () => true,
      statSync: () => ({ isFile: () => false }),
      mkdirSync: () => {
        throw new Error('reached mkdir for a FIFO')
      },
      copyFileSync: () => {
        throw new Error('reached the copy for a FIFO')
      },
    }
    expect(seedWorktree(ROOT, WT, { fs, processEnv: knob('.sock'), stderr })).toEqual([])
    expect(stderr.text()).toContain('not a regular file')
  })

  it('copies a ZERO-BYTE source, because an empty .env.local is still a file', () => {
    const vol = mainRoot({ '/repo/.env.local': '' })
    expect(
      seedWorktree(ROOT, WT, { fs: vol, processEnv: knob('.env.local'), stderr: makeStderr() }),
    ).toEqual(['.env.local'])
    expect(vol.readFileSync(`${WT}/.env.local`, 'utf8')).toBe('')
  })

  it('warns once per bad entry, on one line, and warns twice for a name written twice', () => {
    const vol = mainRoot()
    const stderr = makeStderr()
    seedWorktree(ROOT, WT, { fs: vol, processEnv: knob('/etc/hosts /etc/hosts'), stderr })
    expect(stderr.calls).toHaveLength(2)
    for (const call of stderr.calls) {
      // Same shape as every other warning this package writes (lib/worktree.js's fetch and
      // origin-ref warnings), so a human scanning a run can tell where it came from.
      expect(call.startsWith('⚠️  worktree: ')).toBe(true)
      expect(call.endsWith(LF)).toBe(true)
      expect(call.trimEnd().split(LF)).toHaveLength(1)
    }
  })

  it('is idempotent for a duplicated entry: the second copy is the same file', () => {
    const vol = mainRoot()
    const copied = seedWorktree(ROOT, WT, {
      fs: vol,
      processEnv: knob('.env.local .env.local'),
      stderr: makeStderr(),
    })
    expect(copied).toEqual(['.env.local', '.env.local'])
    expect(vol.readFileSync(`${WT}/.env.local`, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
    expect(vol.readdirSync(WT)).toEqual(['.env.local'])
  })

  it('keeps the source file MODE, so seeding cannot widen a credential', () => {
    // MEASURED with the module's real default seam on darwin 25.6.0 / node v20.20.2: a
    // 0600 `.env.local` arrives in the worktree as 0600. Worth pinning rather than
    // assuming — the file being seeded is, by default, the one holding API keys, and a
    // copy that landed 0644 would be a quiet downgrade on every iteration.
    const sandbox = mkdtempSync(join(tmpdir(), 'ralph-seed-qa-mode-'))
    try {
      const root = join(sandbox, 'repo')
      const tree = join(root, '.ralph', 'worktrees', 'issue-7')
      mkdirSync(tree, { recursive: true })
      writeFileSync(join(root, '.env.local'), 'ANTHROPIC_API_KEY=sk-local\n')
      chmodSync(join(root, '.env.local'), 0o600)
      expect(
        seedWorktree(root, tree, { processEnv: knob('.env.local'), stderr: makeStderr() }),
      ).toEqual(['.env.local'])
      expect(statSync(join(tree, '.env.local')).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 5. The documentation, as a property of the code rather than prose beside it
// ---------------------------------------------------------------------------

describe('the shipped config template and README agree with the module (#219 QA)', () => {
  const template = readFileSync(templatePath('ralph.config.sh'), 'utf8')
  const readme = readFileSync(join(RALPH_HOME, 'README.md'), 'utf8')

  // The probe the three bash cases below run: it imports the real module and prints what
  // seedList() makes of the ambient environment, so the whole production transport —
  // config line, `set -a`, process.env, seedList — is measured rather than reasoned about.
  const PROBE = `import { seedList } from ${JSON.stringify(pathToFileURL(join(RALPH_HOME, 'lib', 'worktree-seed.js')).href)}\nprocess.stdout.write(JSON.stringify(seedList()))\n`

  function sourcedList(configText) {
    const sandbox = mkdtempSync(join(tmpdir(), 'ralph-seed-qa-cfg-'))
    try {
      const config = join(sandbox, 'ralph.config.sh')
      const probe = join(sandbox, 'probe.mjs')
      writeFileSync(config, configText)
      writeFileSync(probe, PROBE)
      // Exactly what templates/ralph.sh:116-120 does with this file, and the positional
      // arguments keep the paths out of the quoting.
      const res = spawnSync(
        'bash',
        ['-c', 'set -a; . "$1"; set +a; exec "$2" "$3"', '_', config, process.execPath, probe],
        { encoding: 'utf8', timeout: 30000 },
      )
      expect(res.status, `bash/node failed: ${res.stderr}`).toBe(0)
      return JSON.parse(res.stdout)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  }

  it('declares the knob under the one syntax rule the file has: no space either side of =', () => {
    const line = template.split(LF).find((l) => l.startsWith(`${SEED_FILES_VAR}=`))
    expect(line).toBeDefined()
    expect(line).toMatch(new RegExp(`^${SEED_FILES_VAR}="[^"]*"$`))
    // And the value the template ships IS the module's default, not a second opinion
    // about it — the duplication the module's header owns up to, pinned so it cannot rot.
    expect(line).toBe(`${SEED_FILES_VAR}="${DEFAULT_SEED_FILES.join(' ')}"`)
  })

  it('reaches seedList through bash exactly as shipped', () => {
    expect(sourcedList(template)).toEqual([...DEFAULT_SEED_FILES])
  })

  it('means "seed nothing" when the shipped line is blanked, as its own comment promises', () => {
    const blanked = template.replace(
      new RegExp(`^${SEED_FILES_VAR}=.*$`, 'm'),
      `${SEED_FILES_VAR}=""`,
    )
    expect(blanked).toContain(`${SEED_FILES_VAR}=""`)
    expect(sourcedList(blanked)).toEqual([])
  })

  it('falls back to the defaults for a config generated BEFORE the knob existed', () => {
    // The compatibility claim in the module's header, driven against a config file that
    // simply does not mention the name — which is what every ralph.config.sh in the wild
    // is today.
    const older = template
      .split(LF)
      .filter((l) => !l.startsWith(`${SEED_FILES_VAR}=`))
      .join(LF)
    // No ASSIGNMENT is left. The name itself still occurs, inside the comment that
    // explains the blank-versus-absent distinction — which is exactly the difference this
    // test and the one above it separate.
    expect(older.split(LF).some((l) => l.startsWith(`${SEED_FILES_VAR}=`))).toBe(false)
    expect(sourcedList(older)).toEqual([...DEFAULT_SEED_FILES])
  })

  it("the template's comment names both defaults and both refusals it claims", () => {
    // A comment is prose until a test reads it. Each claim below is one the code makes
    // good on in a test above or in the dev's own spec.
    for (const file of DEFAULT_SEED_FILES) expect(template).toContain(file)
    expect(template).toMatch(/EMPTY MEANS SEED NOTHING/)
    expect(template).toMatch(/absolute path/)
    expect(template).toMatch(/DIRECTORY/)
    expect(template).toMatch(/node_modules/)
  })

  it("the README's configuration row spells the same default the module holds", () => {
    // The knob's OWN row, not the `INSTALL_CMD` row that cross-references it.
    const row = readme.split(LF).find((l) => l.startsWith(`| \`${SEED_FILES_VAR}\``))
    expect(row).toBeDefined()
    expect(row).toContain(`\`${DEFAULT_SEED_FILES.join(' ')}\``)
    // …and the two claims that row makes about behaviour, both driven above.
    expect(row).toContain('copied, never symlinked')
    expect(row).toContain('Empty means seed nothing')
  })
})
