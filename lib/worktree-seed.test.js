import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import {
  copyFileSync,
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
import {
  DEFAULT_SEED_FILES,
  SEED_FILES_VAR,
  SEED_FS,
  seedList,
  seedWorktree,
} from './worktree-seed.js'

const ROOT = '/repo'
const WT = '/repo/.ralph/worktrees/issue-7'

function makeStderr() {
  const calls = []
  return { write: (m) => calls.push(m), calls, text: () => calls.join('') }
}

// The main root as a ralph-managed project looks on disk: a tracked file, the two
// gitignored files the default list names, and the `node_modules` a worktree must
// never inherit.
const mainRoot = (extra = {}) =>
  Volume.fromJSON({
    '/repo/.git/HEAD': 'ref: refs/heads/main\n',
    '/repo/README.md': 'tracked\n',
    '/repo/.env.local': 'ANTHROPIC_API_KEY=sk-local\n',
    '/repo/.mcp.json': '{"mcpServers":{}}\n',
    '/repo/node_modules/left-pad/index.js': 'module.exports = 1\n',
    ...extra,
  })

describe('seedList — the configured list (#219)', () => {
  it('defaults to .env.local and .mcp.json when the knob is absent', () => {
    // Absent, not blank: a ralph.config.sh generated before this knob existed
    // assigns nothing, and such a repo must still get the two files Ralph already
    // knows about.
    expect(seedList({ processEnv: {} })).toEqual(['.env.local', '.mcp.json'])
    expect(DEFAULT_SEED_FILES).toEqual(['.env.local', '.mcp.json'])
  })

  it('reads the list off the knob, in the order it was written', () => {
    expect(seedList({ processEnv: { [SEED_FILES_VAR]: '.env.local .env.test' } })).toEqual([
      '.env.local',
      '.env.test',
    ])
  })

  it('treats an EMPTY value as "seed nothing", not as the default', () => {
    // The distinction the shell makes for us: `set -a` + an assignment of "" exports
    // the empty string, while a file that never mentions the name exports nothing at
    // all. So a user who wants no seeding gets it by blanking the line.
    expect(seedList({ processEnv: { [SEED_FILES_VAR]: '' } })).toEqual([])
    expect(seedList({ processEnv: { [SEED_FILES_VAR]: '   ' } })).toEqual([])
  })

  it.each([
    ['spaces', '.env.local .mcp.json'],
    ['commas', '.env.local,.mcp.json'],
    ['a comma and a space', '.env.local, .mcp.json'],
    ['padding at both ends', '  .env.local .mcp.json  '],
    ['a trailing comma', '.env.local,.mcp.json,'],
  ])('separates entries on %s', (_label, value) => {
    expect(seedList({ processEnv: { [SEED_FILES_VAR]: value } })).toEqual([
      '.env.local',
      '.mcp.json',
    ])
  })

  it('does not consult process.env when a bag is injected', () => {
    expect(seedList({ processEnv: { OTHER: 'x' } })).toEqual([...DEFAULT_SEED_FILES])
  })
})

describe('seedWorktree — what lands in a fresh worktree (#219)', () => {
  it('copies every configured file that exists in the main root', () => {
    const vol = mainRoot()
    const copied = seedWorktree(ROOT, WT, { fs: vol, processEnv: {}, stderr: makeStderr() })
    expect(copied).toEqual(['.env.local', '.mcp.json'])
    expect(vol.readFileSync(`${WT}/.env.local`, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
    expect(vol.readFileSync(`${WT}/.mcp.json`, 'utf8')).toBe('{"mcpServers":{}}\n')
  })

  it('is a SILENT no-op for a configured file the main root does not have', () => {
    const vol = Volume.fromJSON({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' })
    const stderr = makeStderr()
    expect(seedWorktree(ROOT, WT, { fs: vol, processEnv: {}, stderr })).toEqual([])
    expect(stderr.calls).toEqual([])
    expect(vol.existsSync(`${WT}/.env.local`)).toBe(false)
  })

  it('seeds the files that ARE there when only some of the list is', () => {
    const vol = Volume.fromJSON({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.mcp.json': '{}\n',
    })
    expect(seedWorktree(ROOT, WT, { fs: vol, processEnv: {}, stderr: makeStderr() })).toEqual([
      '.mcp.json',
    ])
  })

  it('seeds nothing at all when the knob is blank, whatever is on disk', () => {
    const vol = mainRoot()
    const copied = seedWorktree(ROOT, WT, {
      fs: vol,
      processEnv: { [SEED_FILES_VAR]: '' },
      stderr: makeStderr(),
    })
    expect(copied).toEqual([])
    expect(vol.existsSync(`${WT}/.env.local`)).toBe(false)
  })

  it('creates the directory a nested entry needs', () => {
    const vol = mainRoot({ '/repo/.config/local.json': '{"a":1}\n' })
    const copied = seedWorktree(ROOT, WT, {
      fs: vol,
      processEnv: { [SEED_FILES_VAR]: '.config/local.json' },
      stderr: makeStderr(),
    })
    expect(copied).toEqual(['.config/local.json'])
    expect(vol.readFileSync(`${WT}/.config/local.json`, 'utf8')).toBe('{"a":1}\n')
  })

  // --- COPIED, NEVER LINKED -------------------------------------------------
  it('writes a REGULAR file, so the agent cannot write through to the main root', () => {
    const vol = mainRoot()
    seedWorktree(ROOT, WT, { fs: vol, processEnv: {}, stderr: makeStderr() })
    expect(vol.lstatSync(`${WT}/.env.local`).isSymbolicLink()).toBe(false)

    // The claim itself, driven rather than inferred: the agent edits its copy and the
    // main root's file is byte-identical afterwards.
    vol.writeFileSync(`${WT}/.env.local`, 'ANTHROPIC_API_KEY=sk-agent-overwrote-it\n')
    expect(vol.readFileSync('/repo/.env.local', 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
  })

  it('replaces a SYMLINK the checkout put at the destination instead of writing through it', () => {
    // The other end of the same promise. `copyFileSync` follows a link at the DESTINATION
    // too — measured on node v20.20.2 and on memfs alike, the link's target takes the
    // bytes and the link stays — so a repository that TRACKS a symlink at a seeded name
    // has `git worktree add` check that link out into the path this step writes, and the
    // write lands wherever it points. Here that is a file in the main root.
    const vol = mainRoot({ '/repo/victim.txt': 'THE USER FILE\n' })
    vol.mkdirSync(WT, { recursive: true })
    vol.symlinkSync('../../../victim.txt', `${WT}/.env.local`)
    const stderr = makeStderr()

    const copied = seedWorktree(ROOT, WT, {
      fs: vol,
      processEnv: { [SEED_FILES_VAR]: '.env.local' },
      stderr,
    })

    expect(copied).toEqual(['.env.local'])
    expect(vol.readFileSync('/repo/victim.txt', 'utf8')).toBe('THE USER FILE\n')
    expect(vol.lstatSync(`${WT}/.env.local`).isSymbolicLink()).toBe(false)
    expect(vol.readFileSync(`${WT}/.env.local`, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
    // Replaced rather than refused, and it says so naming the entry: skipping would leave
    // the agent holding the link, which is the write-through this whole guard is about.
    expect(stderr.text()).toContain('.env.local')
    expect(stderr.text()).toMatch(/symlink/i)
  })

  it('overwrites a regular file at the destination in SILENCE, which the link case is not', () => {
    // The deliberate asymmetry: laying the user's working copy over what the checkout
    // produced is what the step is for, so a file there earns no warning, while a link
    // there is a shape worth naming because the guard changed what was in the tree.
    const vol = mainRoot()
    vol.mkdirSync(WT, { recursive: true })
    vol.writeFileSync(`${WT}/.env.local`, 'FROM THE CHECKOUT\n')
    const stderr = makeStderr()
    expect(
      seedWorktree(ROOT, WT, {
        fs: vol,
        processEnv: { [SEED_FILES_VAR]: '.env.local' },
        stderr,
      }),
    ).toEqual(['.env.local'])
    expect(vol.readFileSync(`${WT}/.env.local`, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
    expect(stderr.calls).toEqual([])
  })

  // --- REFUSALS -------------------------------------------------------------
  describe('refusals', () => {
    it.each([
      ['an absolute path', '/etc/hosts'],
      ['a parent-directory escape', '../outside.env'],
      ['an escape through a subdirectory', 'sub/../../outside.env'],
      ['the project root itself', '.'],
    ])('refuses %s: nothing is copied and the entry is named on stderr', (_label, entry) => {
      const vol = mainRoot({ '/outside.env': 'SECRET=from-outside\n', '/etc/hosts': '127.0.0.1\n' })
      const stderr = makeStderr()
      expect(
        seedWorktree(ROOT, WT, {
          fs: vol,
          processEnv: { [SEED_FILES_VAR]: entry },
          stderr,
        }),
      ).toEqual([])
      expect(stderr.text()).toMatch(/refusing/i)
      expect(stderr.text()).toContain(entry)
      // Nothing from outside the root reached the worktree, under any name.
      expect(vol.existsSync(`${WT}/outside.env`)).toBe(false)
      expect(vol.existsSync(`${WT}/hosts`)).toBe(false)
    })

    it('WARNS AND CARRIES ON rather than throwing, so one bad config line cannot deadlock the queue', () => {
      // templates/ralph.sh turns a throw out of the create path into `break`, which
      // would abort every future run of the loop until a human edited the config. A
      // refused entry costs its own file and nothing else.
      const vol = mainRoot()
      const stderr = makeStderr()
      const copied = seedWorktree(ROOT, WT, {
        fs: vol,
        processEnv: { [SEED_FILES_VAR]: '.env.local /etc/hosts .mcp.json' },
        stderr,
      })
      expect(copied).toEqual(['.env.local', '.mcp.json'])
      expect(stderr.text()).toContain('/etc/hosts')
      expect(vol.existsSync(`${WT}/.env.local`)).toBe(true)
      expect(vol.existsSync(`${WT}/.mcp.json`)).toBe(true)
    })

    it('refuses a DIRECTORY, which is what keeps node_modules out however it is configured', () => {
      const vol = mainRoot()
      const stderr = makeStderr()
      const copied = seedWorktree(ROOT, WT, {
        fs: vol,
        processEnv: { [SEED_FILES_VAR]: 'node_modules' },
        stderr,
      })
      expect(copied).toEqual([])
      expect(stderr.text()).toContain('node_modules')
      expect(vol.existsSync(`${WT}/node_modules`)).toBe(false)
    })

    it('never symlinks a refused directory either — the worktree gets no node_modules of any kind', () => {
      const vol = mainRoot()
      seedWorktree(ROOT, WT, {
        fs: vol,
        processEnv: { [SEED_FILES_VAR]: 'node_modules .env.local' },
        stderr: makeStderr(),
      })
      // The worktree exists (the .env.local landed) and has no node_modules entry at
      // all, so the negative above is not vacuous.
      expect(vol.existsSync(`${WT}/.env.local`)).toBe(true)
      expect(vol.readdirSync(WT)).toEqual(['.env.local'])
    })

    it('absorbs a copy that FAILS, warning and moving to the next entry', () => {
      // An unreadable source or an unwritable destination is one file lost, not a run:
      // the same reason a refused entry does not throw.
      const vol = mainRoot()
      const stderr = makeStderr()
      const fs = {
        existsSync: (p) => vol.existsSync(p),
        statSync: (p) => vol.statSync(p),
        mkdirSync: (p, o) => vol.mkdirSync(p, o),
        copyFileSync: (src, dest) => {
          if (src.endsWith('.env.local')) throw new Error('EACCES: permission denied')
          vol.copyFileSync(src, dest)
        },
      }
      const copied = seedWorktree(ROOT, WT, { fs, processEnv: {}, stderr })
      expect(copied).toEqual(['.mcp.json'])
      expect(stderr.text()).toContain('.env.local')
      expect(stderr.text()).toContain('permission denied')
    })

    it('refuses a main root that is not an absolute path, so no read is aimed at a cwd', () => {
      // This function's OWN precondition, and deliberately not a second copy of
      // lib/worktree.js's assertSafeRoot: the `/`, `$HOME` and `.git/` policy lives
      // there and has already run by the time createWorktree reaches this step. What
      // is asserted here is only what this step needs to be handed — an absolute root
      // to resolve every configured entry against.
      for (const root of ['', null, undefined, 'repo', './repo']) {
        expect(() =>
          seedWorktree(root, WT, { fs: mainRoot(), processEnv: {}, stderr: makeStderr() }),
        ).toThrow(/refusing/i)
      }
    })

    it('refuses a worktree path that is not absolute either, so no write lands beside the cwd', () => {
      expect(() =>
        seedWorktree(ROOT, 'issue-7', { fs: mainRoot(), processEnv: {}, stderr: makeStderr() }),
      ).toThrow(/refusing/i)
    })
  })
})

// ---------------------------------------------------------------------------
// The write-through guard, past the LAST path component (review round 1 of #219)
// ---------------------------------------------------------------------------
//
// "Copied, never symlinked, so the agent cannot write through to the main root" is the
// criterion, and lstatting the destination itself keeps only the half of it that a link at
// the LEAF can break. Two escapes are left, and both are driven here before they are closed:
// a DIRECTORY component of a nested entry that the checkout made a link, and an injected
// `fs` that cannot lstat at all — which loses the guard without losing the copy.
//
// Real fs and a mkdtemp sandbox for both, not memfs: what is under test is what node's own
// `copyFileSync` and `mkdirSync` do with a link in the path, and a claim about node cannot
// be driven against a model of node. Everything asserted below about them was MEASURED on
// node v20.20.2 / darwin 25.6.0 first. The memfs answers do NOT all match — over the five
// destination shapes, `COPYFILE_EXCL` throws EEXIST on real fs for every one and on memfs
// for every one but a DANGLING link, which it replaces instead. That cell has a spec of its
// own below, driven against memfs on purpose, because a divergence cannot be pinned by the
// side that behaves.
describe('seedWorktree — nothing is written through a link, wherever the link is (#219)', () => {
  // The shape `git worktree add` produces when the repository TRACKS a symlink: root/repo
  // with the seed source in it, the tree three levels down, and whatever `plant` puts in
  // the tree standing in for the checkout.
  function sandbox(plant) {
    const box = mkdtempSync(join(tmpdir(), 'ralph-seed-guard-'))
    const root = join(box, 'repo')
    const tree = join(root, '.ralph', 'worktrees', 'issue-7')
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(root, 'victim.txt'), 'THE USER FILE\n')
    plant({ box, root, tree })
    return { box, root, tree }
  }

  it('refuses a nested entry whose DIRECTORY component the checkout made a symlink', () => {
    // The escape the leaf check cannot see. `.config` is tracked as a link three levels up
    // — which is the main root itself, because that is exactly where the worktree sits
    // relative to it — so `join(tree, '.config/local.json')` names a path in the USER'S
    // repository. MEASURED: `mkdirSync(<link to a dir>, { recursive: true })` succeeds
    // silently and `mkdirSync(<link>/sub, { recursive: true })` creates `sub` inside the
    // TARGET, so neither the mkdir nor the copy notices, and the guard has to run BEFORE
    // the mkdir rather than after it.
    const { box, root, tree } = sandbox(({ root, tree }) => {
      mkdirSync(join(root, '.config'), { recursive: true })
      writeFileSync(join(root, '.config', 'local.json'), '{"seeded":true}\n')
      symlinkSync(join('..', '..', '..'), join(tree, '.config'))
    })
    try {
      const stderr = makeStderr()
      const copied = seedWorktree(root, tree, {
        processEnv: { [SEED_FILES_VAR]: '.config/local.json' },
        stderr,
      })
      expect(copied).toEqual([])
      // Nothing was written into the user's repository, which is the whole claim.
      expect(existsSync(join(root, 'local.json'))).toBe(false)
      // And the checkout's own link is left exactly as git checked it out: a refusal is
      // not a repair, and unlinking a tracked directory link would take content with it.
      expect(lstatSync(join(tree, '.config')).isSymbolicLink()).toBe(true)
      expect(stderr.text()).toMatch(/refusing/i)
      expect(stderr.text()).toContain('.config/local.json')
    } finally {
      rmSync(box, { recursive: true, force: true })
    }
  })

  it('refuses the entry when the injected fs cannot lstat, rather than writing through', () => {
    // The second escape: the guard is only as good as the `fs` it was handed, and an `fs`
    // narrower than this module's own default used to lose it in SILENCE — the copy
    // followed the link, the main root took the bytes, and the entry was reported as
    // seeded. The cost of a missing verb has to be the entry, not the promise.
    const { box, root, tree } = sandbox(({ root, tree }) => {
      writeFileSync(join(root, '.env.local'), 'FROM-THE-MAIN-ROOT\n')
      symlinkSync(join('..', '..', '..', 'victim.txt'), join(tree, '.env.local'))
    })
    try {
      const stderr = makeStderr()
      // Four real verbs, faithfully forwarded, and no `lstatSync` — the shape a test
      // double takes when it only implements what the happy path calls.
      const narrow = { existsSync, statSync, mkdirSync, copyFileSync }
      const copied = seedWorktree(root, tree, {
        fs: narrow,
        processEnv: { [SEED_FILES_VAR]: '.env.local' },
        stderr,
      })
      expect(copied).toEqual([])
      expect(readFileSync(join(root, 'victim.txt'), 'utf8')).toBe('THE USER FILE\n')
      // Left as the checkout had it: without an lstat the step cannot tell a link from a
      // file, so it touches neither.
      expect(lstatSync(join(tree, '.env.local')).isSymbolicLink()).toBe(true)
      expect(stderr.text()).toMatch(/refusing/i)
      expect(stderr.text()).toContain('.env.local')
    } finally {
      rmSync(box, { recursive: true, force: true })
    }
  })

  it('still seeds through that same narrow fs when the destination is EMPTY', () => {
    // The other half of the trade, and the reason the missing verb is not a hard refusal:
    // with nothing at the destination there is no link to write through, so the copy is
    // safe and runs. A double that implements the four verbs the happy path calls still
    // gets the happy path — silently.
    const { box, root, tree } = sandbox(({ root }) => {
      writeFileSync(join(root, '.env.local'), 'FROM-THE-MAIN-ROOT\n')
    })
    try {
      const stderr = makeStderr()
      const narrow = { existsSync, statSync, mkdirSync, copyFileSync }
      expect(
        seedWorktree(root, tree, {
          fs: narrow,
          processEnv: { [SEED_FILES_VAR]: '.env.local' },
          stderr,
        }),
      ).toEqual(['.env.local'])
      expect(readFileSync(join(tree, '.env.local'), 'utf8')).toBe('FROM-THE-MAIN-ROOT\n')
      expect(stderr.calls).toEqual([])
    } finally {
      rmSync(box, { recursive: true, force: true })
    }
  })

  it('replaces a DANGLING link on memfs rather than writing through it', () => {
    // THE ONE CELL WHERE NO_CLOBBER DIVERGES, pinned here so the comment on it stays
    // measured. MEASURED both ways, five destination shapes each: real fs (node v20.20.2 /
    // darwin 25.6.0) throws EEXIST for a regular file, a directory, a link to a file, a
    // link to a directory AND a dangling link; memfs 4.57.2 throws for the first four and
    // COPIES over the fifth — its existence check follows the link, so a link pointing at
    // nothing looks like an empty destination and the flag never fires.
    //
    // What survives the divergence, and is the only thing the guard needs, is that the
    // write does not go THROUGH the link: memfs unlinks it and puts a regular file there,
    // so the escaping target is never created. That is what the last two expectations are.
    // The refusal this fs does not get is a lost WARNING, not a lost boundary.
    const vol = mainRoot()
    vol.mkdirSync(WT, { recursive: true })
    vol.symlinkSync('../../../victim.txt', `${WT}/.env.local`)
    const narrow = {
      existsSync: (p) => vol.existsSync(p),
      statSync: (p) => vol.statSync(p),
      mkdirSync: (p, o) => vol.mkdirSync(p, o),
      copyFileSync: (a, b, m) => vol.copyFileSync(a, b, m),
    }
    const stderr = makeStderr()
    const copied = seedWorktree(ROOT, WT, {
      fs: narrow,
      processEnv: { [SEED_FILES_VAR]: '.env.local' },
      stderr,
    })
    // Copied, and silently — the flag did not fire, so this fs behaves as if the
    // destination had been empty.
    expect(copied).toEqual(['.env.local'])
    expect(stderr.calls).toEqual([])
    // The link is GONE, replaced by a regular file of the worktree's own...
    expect(vol.lstatSync(`${WT}/.env.local`).isSymbolicLink()).toBe(false)
    expect(vol.readFileSync(`${WT}/.env.local`, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-local\n')
    // ...and nothing was written where it pointed, which is the property that holds on both
    // filesystems and the reason this cell is safe to have.
    expect(vol.existsSync('/repo/victim.txt')).toBe(false)
  })

  it('exports the verbs the guard needs as ONE seam, so a caller cannot drop them quietly', () => {
    // lib/worktree.js passes its own `fs` object straight through to this module, and the
    // two verbs the write-through guard rests on are the two whose absence used to cost
    // the guard instead of the entry. Spreading SEED_FS is what keeps that object from
    // drifting away from what the seed step calls; this pins the seam it spreads.
    const verbs = ['copyFileSync', 'existsSync', 'lstatSync', 'mkdirSync', 'statSync', 'unlinkSync']
    for (const verb of verbs) expect(typeof SEED_FS[verb], verb).toBe('function')
  })
})

describe('seedWorktree — the destination is checked as a PATH, not as a string (#219)', () => {
  it('seeds a name that merely BEGINS with two dots, which is not an escape', () => {
    // The guard that refuses a destination outside the tree compares `..` as a path
    // COMPONENT. `..foo` is a legal filename — a `..foo` backup file is the ordinary way to
    // get one — and refusing it for the two characters it starts with would be a lie about
    // where it resolves.
    const vol = mainRoot({ '/repo/..env.local': 'K=1\n' })
    const stderr = makeStderr()
    expect(
      seedWorktree(ROOT, WT, {
        fs: vol,
        processEnv: { [SEED_FILES_VAR]: '..env.local' },
        stderr,
      }),
    ).toEqual(['..env.local'])
    expect(vol.readFileSync(`${WT}/..env.local`, 'utf8')).toBe('K=1\n')
    expect(stderr.calls).toEqual([])
  })
})

describe('seedWorktree — .git is never a seed destination (#219)', () => {
  it('refuses .git and anything under it, so the gitdir POINTER survives', () => {
    // A real worktree has a `.git` FILE holding `gitdir: <main checkout>/.git/worktrees/<h>`,
    // and every git command the agent runs reads it. An entry of `.git/config` asks this
    // step to make a directory where that file is; an entry of `.git` asks it to copy the
    // main checkout's own pointer or repository metadata over it. Both are refused by name
    // rather than left to whatever errno the write happens to raise, because the failure a
    // replaced pointer produces lands nowhere near this module.
    const vol = mainRoot()
    vol.mkdirSync(WT, { recursive: true })
    vol.writeFileSync(`${WT}/.git`, 'gitdir: /repo/.git/worktrees/issue-7\n')
    const stderr = makeStderr()
    const copied = seedWorktree(ROOT, WT, {
      fs: vol,
      processEnv: { [SEED_FILES_VAR]: '.git .git/config ./.git/HEAD .gitignore .env.local' },
      stderr,
    })
    // `.gitignore` is not under `.git` and is absent here, so it is the silent no-op every
    // absent entry is — the prefix must be a path SEGMENT, not a string prefix.
    expect(copied).toEqual(['.env.local'])
    expect(vol.readFileSync(`${WT}/.git`, 'utf8')).toBe('gitdir: /repo/.git/worktrees/issue-7\n')
    expect(vol.lstatSync(`${WT}/.git`).isFile()).toBe(true)
    expect(stderr.calls).toHaveLength(3)
    expect(stderr.text()).toContain('.git/config')
    expect(stderr.text()).toContain('./.git/HEAD')
    expect(stderr.text()).toMatch(/refusing/i)
  })
})
