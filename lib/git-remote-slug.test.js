// #116 — the spec for the git-config remote grammar, moved here with the code it describes.
//
// Every case below was written for #69 and lived in banner-model.test.js, because the grammar
// did. It reads better here for the reason the module does: none of it is about a model, and
// none of the model spec next door is about a url.
//
// WHAT IS BEING ASSERTED. `resolveBannerRepo` answers the identity box's `repo` row without a
// `gh repo view` — that is a GraphQL round trip, and the row is printed before `ralph start`'s
// first preflight line. So the answer is parsed out of two strings the caller already read:
// GH_REPO, and the text of `.git/config`. The interesting half is what it REFUSES: a wrong
// slug names a repository the loop is not about to read, while a missing one costs a row the
// composer's gate drops anyway.
//
// PURE, and asserted so by a static read at the bottom — no clock, no environment, no
// filesystem, and no imports at all. That is what makes the whole table below testable
// without a git remote or a checkout of any kind (#41).
//
// TABLE-DRIVEN wherever the input is a shape rather than a value, since one url spelling is
// one row.

import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { resolveBannerRepo } from './git-remote-slug.js'

describe('resolveBannerRepo — the repo the box names, resolved locally (#69)', () => {
  const origin = (...urls) =>
    ['[remote "origin"]', ...urls.map((url) => `\turl = ${url}`), ''].join('\n')

  it('takes GH_REPO when it is set — it is what gh itself would read', () => {
    expect(resolveBannerRepo({ ghRepo: 'lucasfe/ralph' })).toBe('lucasfe/ralph')
    // gh spells it `[HOST/]OWNER/REPO`, so a host in front is dropped rather than refused.
    expect(resolveBannerRepo({ ghRepo: 'github.com/lucasfe/ralph' })).toBe('lucasfe/ralph')
    expect(resolveBannerRepo({ ghRepo: '  lucasfe/ralph  ' })).toBe('lucasfe/ralph')
  })

  it('lets GH_REPO win over the remote, because gh does', () => {
    expect(
      resolveBannerRepo({
        ghRepo: 'someone/else',
        gitConfigText: origin('git@github.com:lucasfe/ralph.git'),
      }),
    ).toBe('someone/else')
  })

  it('falls back to origin’s url, in every spelling git writes it', () => {
    const spellings = [
      'git@github.com:lucasfe/ralph.git',
      'git@github.com:lucasfe/ralph',
      'https://github.com/lucasfe/ralph.git',
      'https://github.com/lucasfe/ralph',
      'https://github.com/lucasfe/ralph/',
      'https://user:token@github.com/lucasfe/ralph.git',
      'ssh://git@github.com/lucasfe/ralph.git',
      'ssh://git@ssh.github.com:443/lucasfe/ralph.git',
      'git://github.com/lucasfe/ralph.git',
      // A GitHub Enterprise host is still a slug, and the box names the slug: the host is
      // not what a reader is checking when they run Ralph in several checkouts.
      'git@github.example.com:lucasfe/ralph.git',
    ]
    for (const url of spellings) {
      expect(resolveBannerRepo({ gitConfigText: origin(url) }), url).toBe('lucasfe/ralph')
    }
  })

  it('reads the LAST url in the origin section, like git does', () => {
    const text = origin('git@github.com:old/name.git', 'git@github.com:new/name.git')
    expect(resolveBannerRepo({ gitConfigText: text })).toBe('new/name')
  })

  it('reads origin and no other remote', () => {
    const text = [
      '[remote "upstream"]',
      '\turl = git@github.com:upstream/name.git',
      '[remote "origin"]',
      '\turl = git@github.com:mine/name.git',
      '[remote "fork"]',
      '\turl = git@github.com:fork/name.git',
      '',
    ].join('\n')
    expect(resolveBannerRepo({ gitConfigText: text })).toBe('mine/name')
    // ...and a config with no origin at all is no answer, not the first remote it finds.
    expect(resolveBannerRepo({ gitConfigText: text.replace('"origin"', '"other"') })).toBe(null)
  })

  it('ends the origin section on a bracket line it cannot parse, rather than reading past it', () => {
    // FAIL CLOSED ON AN UNRECOGNIZED HEADER, and this is the one place in this module where
    // the difference between a missing answer and a wrong one is visible in the same file.
    // The parser deliberately recognizes only the header git WRITES, so a trailing comment on
    // one — legal to git, written by hand all the time — matches neither the section pattern
    // nor the key pattern. Falling through both without closing the section left the reader
    // INSIDE origin, and the NEXT remote's url was then reported as origin's: the box would
    // name `them/repo` while every `gh` command in the loop read `me/fork`, which is the
    // multi-checkout confusion this row was added to end.
    const forked = (header) =>
      [
        '[remote "origin"]',
        '\turl = git@github.com:me/fork.git',
        header,
        '\turl = git@github.com:them/repo.git',
        '',
      ].join('\n')
    for (const header of [
      '[remote "upstream"] # the real one',
      '[remote "upstream"] ; the real one',
      // git's own one-line spelling of a section and a key, and a bracket nobody can parse.
      '[remote "upstream"] fetch = +refs/heads/*:refs/remotes/upstream/*',
      '[[upstream]]',
      '[remote "upstream',
    ]) {
      expect(resolveBannerRepo({ gitConfigText: forked(header) }), header).toBe('me/fork')
    }
    // ...and the direction that was always right stays right: an unparsed header on ORIGIN
    // itself opens nothing, so its own url is not attributed to a section nobody named.
    expect(
      resolveBannerRepo({
        gitConfigText: '[remote "origin"] # main\n\turl = git@github.com:me/fork.git\n',
      }),
    ).toBe(null)
  })

  it('accepts the whole grammar git writes a config file in', () => {
    // Section names are case-insensitive, keys are too, whitespace around the `=` is free,
    // and `[core]` sits above the remote in every real file.
    const text = [
      '[core]',
      '\trepositoryformatversion = 0',
      '\turl = not-a-remote/at-all',
      '[REMOTE "origin"]',
      '\tURL=git@github.com:lucasfe/ralph.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[branch "main"]',
      '\tremote = origin',
      '',
    ].join('\n')
    expect(resolveBannerRepo({ gitConfigText: text })).toBe('lucasfe/ralph')
  })

  it('answers null rather than guessing, for everything that is not a GitHub slug', () => {
    // A row that cannot be resolved is DROPPED, never filled in: this box may not state a
    // repo with more confidence than its source warrants, which is the same rule the model
    // row beside it answers to. gh resolves its base repo from more than origin, so a missing
    // answer here means "not cheaply knowable", not "no repo".
    const refusals = [
      ['no config text at all', {}],
      ['an empty config', { gitConfigText: '' }],
      ['a non-string config', { gitConfigText: 42 }],
      ['an origin with no url', { gitConfigText: '[remote "origin"]\n\tfetch = +refs/*\n' }],
      ['a blank url', { gitConfigText: origin('   ') }],
      ['a local path remote', { gitConfigText: origin('/srv/git/thing.git') }],
      ['a relative path remote', { gitConfigText: origin('../other') }],
      ['a file url', { gitConfigText: origin('file:///srv/git/thing.git') }],
      ['a host and nothing else', { gitConfigText: origin('git@github.com:') }],
      ['one path segment', { gitConfigText: origin('https://github.com/lucasfe') }],
      ['three path segments', { gitConfigText: origin('https://github.com/a/b/c') }],
      ['a segment with a space in it', { gitConfigText: origin('git@github.com:a b/c') }],
      ['a GH_REPO of one segment', { ghRepo: 'ralph' }],
      ['a GH_REPO of four segments', { ghRepo: 'a/b/c/d' }],
      ['a blank GH_REPO', { ghRepo: '   ' }],
      ['a non-string GH_REPO', { ghRepo: 42 }],
      ['an object GH_REPO', { ghRepo: {} }],
    ]
    for (const [label, bag] of refusals) {
      expect(resolveBannerRepo(bag), label).toBe(null)
    }
  })

  it('never throws and never coerces, whatever it is handed', () => {
    const hostile = {
      toString() {
        throw new Error('a fact must never be coerced')
      },
    }
    for (const bag of [undefined, null, {}, { ghRepo: hostile, gitConfigText: hostile }, 42]) {
      expect(resolveBannerRepo(bag), JSON.stringify(bag)).toBe(null)
    }
  })
})

describe('git-remote-slug — purity', () => {
  it('reads no clock, no environment and no filesystem — and imports nothing', () => {
    // Same method and the same reason as banner-model.test.js's own purity spec, which this
    // one was split off from (#116): the ABSENCE of a capability cannot be shown by
    // exercising happy paths. This module is handed the text of a file it must never open
    // itself, which is the whole reason every case above is a string literal rather than a
    // fixture on disk (#41).
    const code = codeWithoutComments(new URL('./git-remote-slug.js', import.meta.url))

    expect(code).not.toMatch(/\bprocess\b/)
    expect(code).not.toMatch(/\bDate\b/)
    expect(code).not.toMatch(/Math\s*\.\s*random/)
    expect(code).not.toMatch(/\brequire\s*\(/)
    expect(code).not.toMatch(/node:(fs|os|path|child_process|tty)/)
    // ZERO imports, which is a stronger claim than the one banner-model.js can make and the
    // reason the two tiny helpers at the bottom of this file are duplicated rather than
    // shared: a module extracted to stop two grammars leaning on each other would be a poor
    // trade if it took a dependency in order to save ten lines. The comment there says so too.
    expect([...code.matchAll(/^import .* from '(.*)'$/gm)]).toEqual([])
  })
})
