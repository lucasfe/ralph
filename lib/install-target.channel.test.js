import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { classifyInstall } from './install-target.js'
import { NPM_VERSION_QUERY, VERSION_FORMAT } from './update-check.js'

// #199: a classification already says how to UPDATE this copy; now it also says
// how to ask its channel WHAT THE LATEST VERSION IS. The two have to travel
// together, because npm and the Homebrew tap hold different versions: query npm
// for a brew install and Ralph reports "up to date" forever, query the tap for an
// npm install and it reports an upgrade that `npm install -g` cannot fetch.
//
// Every row of the table installs from npm except Homebrew's, so the interesting
// assertions here are (a) NO layout is left without a descriptor — including the
// two refusals and every `unknown`, which are the layouts a future caller is most
// likely to forget — and (b) the one row that differs differs in the argv, not in
// a `kind` string some consumer has to recognize.

function makeExec(stdout = '/usr/local/lib/node_modules\n') {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    return { exitCode: 0, stdout, stderr: '' }
  }
  exec.calls = calls
  return exec
}

const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const GLOBAL_RALPH = `${GLOBAL_ROOT}/@lucasfe/ralph`
const HOME = '/Users/me'
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'

const emptyFs = () => Volume.fromJSON({})

function fsWithSymlink(packageRoot, target = '/Users/me/repos/ralph') {
  const vol = Volume.fromJSON({ [`${target}/package.json`]: '{}' })
  vol.mkdirSync(packageRoot.slice(0, packageRoot.lastIndexOf('/')), { recursive: true })
  vol.symlinkSync(target, packageRoot)
  return vol
}

// Every layout classifyInstall can answer, by the path (and filesystem) that
// produces it. Written as a list rather than as separate tests so that a NEW
// layout added to the table without a descriptor has nowhere to hide: the loops
// below cover whatever this list covers.
const LAYOUTS = [
  ['global-npm', { ralphHome: GLOBAL_RALPH, fs: emptyFs() }],
  ['global-pnpm', { ralphHome: `${HOME}/Library/pnpm/global/5/node_modules/@lucasfe/ralph`, fs: emptyFs() }],
  ['global-yarn', { ralphHome: `${HOME}/.config/yarn/global/node_modules/@lucasfe/ralph`, fs: emptyFs() }],
  ['global-bun', { ralphHome: `${HOME}/.bun/install/global/node_modules/@lucasfe/ralph`, fs: emptyFs() }],
  ['global-brew', { ralphHome: BREW_RALPH, fs: emptyFs() }],
  ['npx', { ralphHome: `${HOME}/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph`, fs: emptyFs() }],
  ['linked', { ralphHome: GLOBAL_RALPH, fs: fsWithSymlink(GLOBAL_RALPH) }],
  [
    'linked',
    {
      ralphHome: '/Users/me/repos/ralph',
      fs: Volume.fromJSON({ '/Users/me/repos/ralph/.git/HEAD': 'ref: refs/heads/main\n' }),
    },
  ],
  ['unknown', { ralphHome: '/Users/me/somewhere/else', fs: emptyFs() }],
  ['unknown', { ralphHome: '   ', fs: emptyFs() }],
  [
    'unknown',
    {
      // Two managers' markers on one path: no argv, and no advice either.
      ralphHome: `${HOME}/.config/yarn/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph`,
      fs: emptyFs(),
    },
  ],
]

const classify = (input) => classifyInstall({ exec: makeExec(), ...input })

describe('classifyInstall — every layout carries its channel version query (#199)', () => {
  it.each(LAYOUTS)('gives %s a spawnable, parseable version query', async (kind, input) => {
    const result = await classify(input)
    expect(result.kind).toBe(kind)

    const { latest } = result
    expect(Array.isArray(latest?.argv)).toBe(true)
    expect(latest.argv.length).toBeGreaterThan(1)
    for (const word of latest.argv) expect(typeof word).toBe('string')
    expect(Object.values(VERSION_FORMAT)).toContain(latest.format)
    // The wording `ralph update` prints when the query fails. Without it the
    // command has to compose a channel name of its own, which is exactly the
    // guess that told brew users the npm registry was unreachable.
    expect(latest.unreachable).toBeTruthy()
    expect(typeof latest.unreachable).toBe('string')
  })

  it.each(LAYOUTS.filter(([kind]) => kind !== 'global-brew'))(
    'hands %s the one shared npm descriptor, not a copy of it',
    async (_kind, input) => {
      // Identity, not equality: pnpm, yarn, bun, npm, npx, a linked install and
      // every `unknown` all install from the npm registry, so they must reference
      // the same descriptor. A per-row copy would let one drift.
      const result = await classify(input)
      expect(result.latest).toBe(NPM_VERSION_QUERY)
    },
  )

  it('freezes the shared npm descriptor, since every layout hands back that object', () => {
    // A caller that mutated it would change the query for every other layout in
    // the process, `resolveUpdateDecision`'s background check included.
    expect(Object.isFrozen(NPM_VERSION_QUERY)).toBe(true)
    expect(Object.isFrozen(NPM_VERSION_QUERY.argv)).toBe(true)
  })
})

describe('classifyInstall — the Homebrew row asks brew, not npm (#199)', () => {
  it('queries the tap with `brew info --json=v2 <formula>`', async () => {
    const result = await classify({ ralphHome: BREW_RALPH, fs: emptyFs() })
    expect(result.latest.argv).toEqual(['brew', 'info', '--json=v2', 'ralph'])
    expect(result.latest.format).toBe(VERSION_FORMAT.BREW_JSON_V2)
    expect(result.latest).not.toBe(NPM_VERSION_QUERY)
  })

  it('names the formula once: the version query and the upgrade agree', async () => {
    // #198 spells the formula name in this file and in the renderer, and
    // test/homebrew-formula.test.js pins those two together. #199 adds a THIRD
    // use of the same name, so this asserts it is the same token rather than a
    // fourth literal — `brew info` reading formula A while `brew upgrade` runs
    // formula B would report an upgrade that never lands.
    const result = await classify({ ralphHome: BREW_RALPH, fs: emptyFs() })
    expect(result.argv).toEqual(['brew', 'upgrade', 'ralph'])
    expect(result.latest.argv.at(-1)).toBe(result.argv.at(-1))
  })

  it('tells the user brew, not the npm registry, when the query fails', async () => {
    const result = await classify({ ralphHome: BREW_RALPH, fs: emptyFs() })
    expect(result.latest.unreachable).toMatch(/brew|homebrew|tap/i)
    expect(result.latest.unreachable).not.toMatch(/npm/i)
  })

  it('still decides a Cellar from its path alone, spawning nothing', async () => {
    // The descriptor is a query to be run LATER, by whoever wants a version.
    // Classification stays pure path matching (#198), so adding it must not make
    // `classifyInstall` shell out.
    const exec = makeExec()
    const result = await classifyInstall({ ralphHome: BREW_RALPH, exec, fs: emptyFs() })
    expect(result.kind).toBe('global-brew')
    expect(exec.calls).toHaveLength(0)
  })
})
