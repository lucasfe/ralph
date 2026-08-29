import { describe, it, expect } from 'vitest'
import { REQUIRED_DEPS, checkDeps } from './deps.js'
import { resolveSource, VALID_SOURCES } from './task-source.js'

// ---------------------------------------------------------------------------
// QA augmentation for #125 — the SECOND source-gated dependency.
//
// The dev's deps.test.js proves what each of the three known sources pulls in.
// This file attacks the gate itself, because #125 is the slice that turned
// `info.source && info.source !== source` from a special case for gh into a
// MECHANISM, and a mechanism deserves the questions a special case does not:
//
//   1. WHAT DOES AN UNRECOGNIZED source DO? checkDeps takes the RESOLVED source
//      and compares it with `!==`, so it is strict where resolveSource is
//      forgiving. That is fine as long as nothing can reach it with an unresolved
//      value — which is a claim about the COMPOSITION of the two functions, and
//      that composition is what these tests pin.
//   2. IS THE GATE EXCLUSIVE? Exactly one source-gated dep may appear in any
//      result set, and no dep may be gated on both an agent and a source (the two
//      `continue`s would compound and skip a dep in a combination nobody tested).
//   3. IS THE NEW TABLE ENTRY WELL FORMED? Every platform `installFor` can ask
//      for, one pasteable line each, and the linux/wsl pair identical byte for
//      byte the way every other entry in the table treats it.
//
// checkDeps never runs a command — `hasCommand` is the seam and it is injected in
// every test here — so nothing in this file can invoke a real `acli`.
// ---------------------------------------------------------------------------

const allPresent = () => true
const names = (results) => results.map((r) => r.name)
const gatedIn = (source) =>
  names(checkDeps({ hasCommand: allPresent, source })).filter((n) => n === 'gh' || n === 'acli')

describe('checkDeps — the source gate as a MECHANISM (#125 QA)', () => {
  it('composes with resolveSource: every valid source yields exactly one gated dep', () => {
    // The claim that makes the strict `!==` safe. Whatever a user writes in
    // ralph.config.sh goes through resolveSource first, and every possible OUTPUT
    // of that function is a value this gate understands.
    const expected = { github: ['gh'], folder: [], jira: ['acli'] }
    for (const source of VALID_SOURCES) {
      expect(gatedIn(source), source).toEqual(expected[source])
    }
    // ...and the same, driven end-to-end from the env value a user actually types.
    for (const raw of ['jira', 'JIRA', '  Jira\n', 'jiras', 'folder', '', undefined]) {
      const resolved = resolveSource({ TASK_SOURCE: raw })
      expect(gatedIn(resolved), String(raw)).toEqual(expected[resolved])
      expect(gatedIn(resolved).length).toBeLessThan(2)
    }
  })

  it('is STRICT about case — it receives a resolved source, so it must not normalize', () => {
    // Pinned so nobody later assumes checkDeps normalizes: 'JIRA' matches nothing,
    // which is exactly right (resolveSource already lower-cased it) and exactly the
    // wrong thing to rely on from a new call site. A caller that skips the resolver
    // gets NEITHER gated dep, silently.
    for (const source of ['JIRA', 'Jira', 'jira ', ' jira', 'GITHUB', 'Github']) {
      expect(gatedIn(source), source).toEqual([])
    }
  })

  it('an unknown or nullish source drops BOTH gated deps and keeps everything else', () => {
    // The honest reading of today's behaviour, pinned in both directions. An
    // explicitly-passed `undefined` takes the parameter default and behaves like
    // github; `null`, '' and a bogus name defeat the default and land on a set with
    // no source CLI at all. Nothing crashes, and the shared deps are untouched —
    // so the worst case is a machine that is under-checked, never one that is told
    // to install the wrong CLI.
    expect(gatedIn(undefined)).toEqual(['gh'])
    for (const source of [null, '', 'gitlab', 0, false, NaN, {}, []]) {
      const got = names(checkDeps({ hasCommand: allPresent, source }))
      expect(got, String(source)).not.toContain('gh')
      expect(got, String(source)).not.toContain('acli')
      for (const shared of ['git', 'tmux', 'node', 'npm', 'jq', 'curl']) {
        expect(got, String(source)).toContain(shared)
      }
    }
  })

  it('asks hasCommand for acli exactly once, by that exact name, and never for gh', () => {
    const asked = []
    checkDeps({
      hasCommand: (cmd) => {
        asked.push(cmd)
        return true
      },
      source: 'jira',
    })
    expect(asked.filter((c) => c === 'acli')).toEqual(['acli'])
    expect(asked).not.toContain('gh')
    // One probe per dep, no dep probed twice — a duplicate would mean two rows in
    // `ralph doctor` for the same tool.
    expect(asked).toEqual([...new Set(asked)])
    // The order the report is printed in, which is the table's own order.
    expect(asked).toEqual(['git', 'acli', 'tmux', 'claude', 'node', 'npm', 'jq', 'curl'])
  })

  it('the gate is generic — a made-up jira-gated dep rides it with no new branch', () => {
    // The dev's comment claims "adding a source adds no branch here". This is that
    // claim, tested against a table the implementation has never seen.
    const deps = {
      fictional: {
        critical: false,
        source: 'jira',
        install: { mac: 'brew install fictional', linux: 'apt install fictional', wsl: 'apt install fictional' },
      },
    }
    expect(names(checkDeps({ hasCommand: allPresent, deps, source: 'jira' }))).toEqual(['fictional'])
    expect(names(checkDeps({ hasCommand: allPresent, deps, source: 'github' }))).toEqual([])
    expect(names(checkDeps({ hasCommand: allPresent, deps, source: 'folder' }))).toEqual([])
  })

  it('the jira result set is otherwise identical to the folder one, plus acli', () => {
    // A source gate NARROWS, it never replaces: the difference between two sources
    // must be exactly the gated dep and nothing else.
    const jira = names(checkDeps({ hasCommand: allPresent, source: 'jira' }))
    const folder = names(checkDeps({ hasCommand: allPresent, source: 'folder' }))
    expect(jira.filter((n) => n !== 'acli')).toEqual(folder)
    const github = names(checkDeps({ hasCommand: allPresent, source: 'github' }))
    expect(github.filter((n) => n !== 'gh')).toEqual(folder)
  })

  it('reads the SAME present/critical shape for acli as for gh', () => {
    // Two source CLIs, one contract: whatever a consumer already does with the gh
    // row it can do with the acli row, field for field.
    const acli = checkDeps({ hasCommand: allPresent, source: 'jira' }).find((r) => r.name === 'acli')
    const gh = checkDeps({ hasCommand: allPresent, source: 'github' }).find((r) => r.name === 'gh')
    expect(Object.keys(acli).sort()).toEqual(Object.keys(gh).sort())
    expect(Object.keys(acli).sort()).toEqual(['critical', 'install', 'name', 'present'])
    expect(acli.critical).toBe(gh.critical)
    // present tracks hasCommand in both directions, and only for its own name.
    expect(
      checkDeps({ hasCommand: (c) => c !== 'acli', source: 'jira' }).find((r) => r.name === 'acli')
        .present,
    ).toBe(false)
    expect(
      checkDeps({ hasCommand: (c) => c !== 'gh', source: 'jira' }).find((r) => r.name === 'acli')
        .present,
    ).toBe(true)
  })

  it('does not mutate REQUIRED_DEPS, whatever the source', () => {
    const before = JSON.stringify(REQUIRED_DEPS)
    for (const source of [...VALID_SOURCES, 'gitlab', null]) {
      checkDeps({ hasCommand: allPresent, source })
    }
    expect(JSON.stringify(REQUIRED_DEPS)).toBe(before)
  })

  it('documents that a result SHARES the table\'s install object (pre-existing)', () => {
    // Every row has handed out the table's own `install` reference since the
    // function was written, so a caller could edit the install hints of the whole
    // process through a result. Pre-existing and true of all ten deps, not
    // something #125 introduced — recorded because acli's hint is the longest one
    // in the table and the most tempting to "fix up" at a call site.
    const acli = checkDeps({ hasCommand: allPresent, source: 'jira' }).find((r) => r.name === 'acli')
    expect(acli.install).toBe(REQUIRED_DEPS.acli.install)
  })
})

describe('REQUIRED_DEPS — table invariants the new entry has to satisfy (#125 QA)', () => {
  const entries = Object.entries(REQUIRED_DEPS)

  it('every dep declares a boolean critical and a full mac/linux/wsl install triple', () => {
    // `installFor` falls back to `install.linux`, so a MISSING linux key is the one
    // omission that renders `install: undefined` into the report.
    for (const [name, info] of entries) {
      expect(typeof info.critical, name).toBe('boolean')
      expect(Object.keys(info.install).sort(), name).toEqual(['linux', 'mac', 'wsl'])
      for (const platform of ['mac', 'linux', 'wsl']) {
        expect(typeof info.install[platform], `${name}.${platform}`).toBe('string')
        expect(info.install[platform].trim(), `${name}.${platform}`).not.toBe('')
      }
    }
  })

  it('no dep is gated on BOTH an agent and a source', () => {
    // The two `continue`s in checkDeps are independent, so a dep carrying both keys
    // would be skipped in combinations nobody enumerates — e.g. "codex agent, jira
    // source" silently dropping a critical tool.
    for (const [name, info] of entries) {
      expect(Boolean(info.agent && info.source), name).toBe(false)
    }
    expect(REQUIRED_DEPS.acli.agent).toBeUndefined()
    expect(REQUIRED_DEPS.acli.source).toBe('jira')
  })

  it('every source-gated dep names a source the registry actually knows', () => {
    // A dep gated on a name resolveSource can never return is a dep that is never
    // checked — a silent no-op rather than a failure.
    for (const [name, info] of entries) {
      if (!info.source) continue
      expect(VALID_SOURCES, name).toContain(info.source)
    }
    expect(entries.filter(([, i]) => i.source).map(([n]) => n)).toEqual(['gh', 'acli'])
  })

  it('acli is critical, and gh and acli agree on that', () => {
    // A jira run has no fallback path to a ticket without acli, exactly as a github
    // run has none without gh. If one of the two is ever demoted to optional the
    // other should be too, or `ralph doctor`'s exit code means different things in
    // the two modes.
    expect(REQUIRED_DEPS.acli.critical).toBe(true)
    expect(REQUIRED_DEPS.acli.critical).toBe(REQUIRED_DEPS.gh.critical)
  })

  it('the acli install hints are single pasteable lines, linux and wsl identical', () => {
    const { mac, linux, wsl } = REQUIRED_DEPS.acli.install
    expect(mac).toBe('brew tap atlassian/acli && brew install acli')
    // Byte for byte, not merely "both mention curl": WSL is Linux for this purpose.
    expect(linux).toBe(wsl)
    for (const hint of [mac, linux]) {
      // One line — the hint is printed after `install: ` and a newline in it would
      // break the report's one-row-per-dep grammar.
      expect(hint).not.toMatch(/[\r\n]/)
      // Nothing to fill in before pasting: a hint the user has to edit is worse
      // than a longer one that just works.
      expect(hint).not.toMatch(/[<>]/)
      expect(hint).not.toContain('...')
      expect(hint.trim()).toBe(hint)
    }
    expect(linux).toContain('https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli')
    expect(linux).toContain('chmod +x acli')
  })

  it('every platform installFor can be asked for resolves to a real string', () => {
    // detectPlatform answers mac/linux/wsl today; `installFor` also falls back to
    // linux for anything else. Both halves asserted on the new entry.
    const install = REQUIRED_DEPS.acli.install
    for (const platform of ['mac', 'linux', 'wsl']) {
      expect(install[platform] || install.linux, platform).toBe(install[platform])
    }
    for (const platform of ['freebsd', 'win32', 'android', '', undefined]) {
      expect(install[platform] || install.linux, String(platform)).toBe(install.linux)
    }
  })

  it('acli sits beside gh in the table, so the two gated rows print together', () => {
    // Purely about the REPORT's readability: checkDeps preserves insertion order,
    // so the source CLI lands in the same place in every mode's output.
    const keys = Object.keys(REQUIRED_DEPS)
    expect(keys[keys.indexOf('gh') + 1]).toBe('acli')
    expect(keys[0]).toBe('git')
  })
})
