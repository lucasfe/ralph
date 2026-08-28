// #116 QA — adversarial specs for the git-config remote grammar, moved here with the code.
//
// Every case below was written for #69 and lived in banner-model.qa.test.js, whose framing it
// shared with a model resolver it shares nothing else with. git-remote-slug.test.js proves the
// intended matrix — GH_REPO first, then origin's url in every spelling git writes it. This
// file attacks the same function from outside that matrix, along the three seams that make it
// different in kind from every other fact in the identity box:
//
//   * THE INPUT IS A FILE NOBODY READS AS BYTES. `.git/config` is edited by hand, by
//     `git remote`, and by whatever tool set up the checkout. It arrives here as TEXT, so
//     every shape it can be in is a string literal — a `.git` that is a FILE rather than a
//     directory, CRLF endings, an `[include]`, two megabytes of junk.
//   * THE SLUG IS A GRAMMAR. `resolveBannerRepo` parses two url grammars and gh's own
//     `[HOST/]OWNER/REPO`, and the failure that costs something is a WRONG slug — a repo on
//     screen that the loop is not about to read. So the table below is mostly refusals, and
//     it closes with a property asserted over every input in the file at once: whatever comes
//     back is either null or exactly `owner/name`.
//   * IT MAY NOT THROW. It feeds a decoration printed before the first preflight line of a
//     command whose job is to get an unattended loop running.
//
// Control bytes are built with `String.fromCharCode` rather than embedded, for the reason
// test/source-control-bytes.test.js states: a raw one makes `file` call this source `data` and
// makes grep skip it silently. Nothing here reads a clock, an environment or a real file (#41).

import { describe, expect, it } from 'vitest'
import { resolveBannerRepo } from './git-remote-slug.js'

const ESC = String.fromCharCode(27)
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const NUL = String.fromCharCode(0)
const C1_CSI = String.fromCharCode(0x9b)

describe('QA #69 git-remote-slug — the repo, degraded rather than guessed', () => {
  const origin = (...urls) =>
    ['[remote "origin"]', ...urls.map((url) => `\turl = ${url}`), ''].join(LF)

  // Every shape a `.git/config` can be in that is NOT the plain repository git writes, and the
  // answer each one must earn: a slug when it is unambiguously one, null otherwise. Collected
  // in one table because the interesting property is the SET of answers, which the last test
  // in this file reads back out of it.
  const CONFIGS = [
    // A worktree or a submodule: `<cwd>/.git` is a FILE holding a gitdir pointer, so what the
    // caller reads is either this text or nothing at all. Either way there is no url in it.
    ['a .git file’s gitdir pointer', 'gitdir: /repo/.git/worktrees/feature\n', null],
    ['a gitdir pointer with a remote-looking path', 'gitdir: git@github.com:o/n.git\n', null],
    // Subsection names are CASE-SENSITIVE to git, so `Origin` is a different remote and the
    // one this box names is not in the file.
    ['[remote "Origin"] — a different remote', '[remote "Origin"]\n\turl = git@github.com:o/n.git\n', null],
    ['[remote "ORIGIN"]', '[remote "ORIGIN"]\n\turl = git@github.com:o/n.git\n', null],
    ['[remote] with no subsection', '[remote]\n\turl = git@github.com:o/n.git\n', null],
    ['[remote ""] — an empty subsection', '[remote ""]\n\turl = git@github.com:o/n.git\n', null],
    // The real remote lives in an included file this module never reads. No row beats a row
    // naming whatever else the file happens to hold.
    ['an [include] holding the real remote', '[include]\n\tpath = ../real-config\n', null],
    [
      'an [includeIf] before a real origin',
      '[includeIf "gitdir:~/work/"]\n\tpath = work\n[remote "origin"]\n\turl = git@github.com:o/n.git\n',
      'o/n',
    ],
    // `[core]` in every real file carries keys a whole-file search for `url =` would match.
    ['a url under [core]', '[core]\n\turl = evil/repo\n\tbare = false\n', null],
    ['a url under [core] above a real origin', `[core]\n\turl = evil/repo\n${origin('git@github.com:o/n.git')}`, 'o/n'],
    // Shapes git itself accepts and this parser deliberately does not: it recognizes the file
    // git WRITES, and answers nothing for anything else.
    ['a section header with a trailing comment', '[remote "origin"] # main\n\turl = git@github.com:o/n.git\n', null],
    // ...and the REVERSED direction of that same unparsed header, which is the one that could
    // put a wrong repo on screen rather than none: the header above closes nothing, so before
    // this parser learned to treat any bracket line it cannot read as a section boundary, the
    // upstream url below was attributed to origin — the box naming `them/repo` while every gh
    // command in the loop read `me/fork`. Added to this table rather than pinned as a gap
    // because a wrong slug is the one answer this function may never give (review of #69).
    [
      'an unparsed header on the remote AFTER origin',
      '[remote "origin"]\n\turl = git@github.com:me/fork.git\n[remote "upstream"] # the real one\n\turl = git@github.com:them/repo.git\n',
      'me/fork',
    ],
    [
      'git’s one-line section-and-key spelling after origin',
      '[remote "origin"]\n\turl = git@github.com:me/fork.git\n[remote "upstream"] fetch = +refs/heads/*\n\turl = git@github.com:them/repo.git\n',
      'me/fork',
    ],
    [
      'an [url] rewrite block with a commented header after origin',
      '[remote "origin"]\n\turl = git@github.com:me/fork.git\n[url "https://github.com/"] # rewrite\n\turl = git@github.com:them/repo.git\n',
      'me/fork',
    ],
    ['an inline comment after the url', '[remote "origin"]\n\turl = git@github.com:o/n.git # main\n', null],
    ['a quoted url value', '[remote "origin"]\n\turl = "git@github.com:o/n.git"\n', null],
    ['a url split over a line continuation', '[remote "origin"]\n\turl = git@github.com:o/\\\n\tn.git\n', null],
    ['only a pushurl', '[remote "origin"]\n\tpushurl = git@github.com:o/n.git\n', null],
    // Remotes that are real remotes and are not repositories gh could read an issue from.
    ['a file:// url', origin('file:///srv/git/thing.git'), null],
    ['an ftp url', origin('ftp://github.com/o/n.git'), null],
    ['an rsync url', origin('rsync://github.com/o/n.git'), null],
    ['an absolute path', origin('/srv/git/thing.git'), null],
    ['a relative path', origin('../other'), null],
    ['a relative path with a colon in it', origin('./x:y/z'), null],
    ['a windows drive path', origin('C:/repos/thing'), null],
    // Paths that are not `owner/name`.
    ['an scp url with an empty path', origin('git@github.com:'), null],
    ['an scp url whose path is a step up', origin('git@github.com:../evil'), null],
    ['an scp url whose path is a dot', origin('git@github.com:./n'), null],
    ['a host and nothing else', origin('https://github.com/'), null],
    ['a doubled slash before the slug', origin('https://github.com//o/n'), null],
    ['three path segments', origin('ssh://git@github.com:22/a/b/c.git'), null],
    ['a name that is only a .git suffix', origin('git@github.com:o/.git'), null],
    ['a slug with a space in it', origin('git@github.com:o/a name'), null],
    ['a non-ASCII slug', origin('git@github.com:ünïcode/rälph.git'), null],
    // A control byte anywhere in the url. The slug grammar admits word characters, dots and
    // hyphens only, so this can never come back as a value — which is what keeps an escape
    // sequence out of the row before the box's own gate ever sees it.
    ['an ESC inside the url', origin(`git@github.com:o/n${ESC}[31m.git`), null],
    ['an LF inside the url', origin(`git@github.com:o/n${NUL}ame.git`), null],
    // ...and the shapes that DO resolve, so the table is not one-sided and a parser that
    // simply answered null would fail here.
    ['CRLF line endings', `[remote "origin"]${CR}${LF}\turl = git@github.com:o/n.git${CR}${LF}`, 'o/n'],
    ['an uppercase scheme', origin('HTTPS://github.com/o/n.git'), 'o/n'],
    ['a padded, mixed-case key', '[remote "origin"]\n\t  UrL   =   git@github.com:o/n.git  \n', 'o/n'],
    ['the origin section opened twice', `${origin('git@github.com:old/name.git')}[core]\n${origin('git@github.com:o/n.git')}`, 'o/n'],
    ['a GitHub Enterprise host', origin('git@ghe.internal.example:o/n.git'), 'o/n'],
    ['a semicolon-commented decoy above origin', `; url = decoy/repo\n${origin('git@github.com:o/n.git')}`, 'o/n'],
    ['a hash-commented decoy above origin', `# url = decoy/repo\n${origin('git@github.com:o/n.git')}`, 'o/n'],
    ['an underscore in both segments', origin('git@github.com:my_org/my_repo.git'), 'my_org/my_repo'],
    ['a dot inside the name', origin('git@github.com:o/n.js.git'), 'o/n.js'],
  ]

  for (const [label, gitConfigText, expected] of CONFIGS) {
    it(`answers ${JSON.stringify(expected)} for ${label}`, () => {
      expect(resolveBannerRepo({ gitConfigText })).toBe(expected)
    })
  }

  // GH_REPO, which is the value gh itself reads first and is therefore the value the box has
  // to honour — including when it is nonsense, because naming origin instead would name a
  // repository the loop is NOT about to read.
  const GH_REPOS = [
    ['gh’s host-prefixed spelling', 'github.com/o/n', 'o/n'],
    ['a GitHub Enterprise host prefix', 'ghe.internal.example/o/n', 'o/n'],
    ['three segments, none of them a host', 'a/b/c', 'b/c'],
    ['four segments', 'a/b/c/d', null],
    ['a whole url', 'https://github.com/o/n', null],
    ['an ssh url', 'git@github.com:o/n.git', null],
    ['one segment', 'ralph', null],
    ['a .git suffix', 'o/n.git', 'o/n'],
    ['an uppercase .GIT suffix', 'o/n.GIT', 'o/n'],
    ['a doubled .git suffix', 'o/n.git.git', 'o/n.git'],
    ['a trailing slash', 'o/n/', null],
    ['two trailing slashes', 'o/n//', 'o/n'],
    ['a leading slash', '/o/n', 'o/n'],
    ['a doubled inner slash', 'o//n', null],
    ['case preserved', 'O/N', 'O/N'],
    ['surrounding whitespace', '  o/n  ', 'o/n'],
    ['a set-but-blank value', '', null],
    ['a whitespace-only value', '   ', null],
    ['a step up', '../n', null],
    ['a step up as the name', 'o/..', null],
    ['a dot as the name', 'o/.', null],
    ['a query string', 'o/n?ref=main', null],
    ['a fragment', 'o/n#readme', null],
    ['a percent escape', 'o/n%2e', null],
    ['a space in the name', 'o/n ame', null],
  ]

  for (const [label, ghRepo, expected] of GH_REPOS) {
    it(`answers ${JSON.stringify(expected)} for a GH_REPO with ${label}`, () => {
      expect(resolveBannerRepo({ ghRepo })).toBe(expected)
      // ...and it still wins over a perfectly good origin, including when it answers null:
      // a set GH_REPO is what gh reads, so origin is not the loop's repository at all.
      expect(
        resolveBannerRepo({ ghRepo, gitConfigText: origin('git@github.com:someone/else.git') }),
      ).toBe(ghRepo.trim() ? expected : 'someone/else')
    })
  }

  it('refuses a GH_REPO carrying a control byte, rather than passing one into a row', () => {
    // GH_REPO is an ambient environment variable, which is the least trustworthy input in
    // this file. The slug grammar admits no control byte in either segment, so the answer is
    // no row — and the box's own gate never has to be the only thing standing there.
    // INSIDE either segment, every one of them — including the two that a `trim` would have
    // removed had they been at an edge.
    for (const byte of [LF, CR, ESC, NUL, C1_CSI, String.fromCharCode(0x85)]) {
      const at = byte.charCodeAt(0).toString()
      expect(resolveBannerRepo({ ghRepo: `o${byte}/n` }), at).toBe(null)
      expect(resolveBannerRepo({ ghRepo: `o/n${byte}ame` }), at).toBe(null)
      expect(resolveBannerRepo({ ghRepo: `o/${byte}n` }), at).toBe(null)
    }
    // ...and at either EDGE, for the bytes `trim` does not consider whitespace — an escape
    // sequence appended to an otherwise valid slug is the shape that would have cost the most.
    for (const byte of [ESC, NUL, C1_CSI, String.fromCharCode(0x85)]) {
      const at = byte.charCodeAt(0).toString()
      expect(resolveBannerRepo({ ghRepo: `o/n${byte}` }), at).toBe(null)
      expect(resolveBannerRepo({ ghRepo: `${byte}o/n` }), at).toBe(null)
    }
    // A TRAILING newline, though, is whitespace and trims away — so a value exported by a
    // script that forgot to chomp its `read` still resolves. Pinned as the deliberate reading
    // it is: a lost row for a stray newline would be a worse trade than a dropped one.
    expect(resolveBannerRepo({ ghRepo: `o/n${LF}` })).toBe('o/n')
    expect(resolveBannerRepo({ ghRepo: `${CR}${LF}o/n${CR}${LF}` })).toBe('o/n')
  })

  it('answers null or exactly `owner/name` — never anything else, for every input above', () => {
    // THE PROPERTY, over every case in this file at once: whatever this function answers is
    // either no row or a slug of exactly two ordinary segments. That is what makes "the row
    // degrades to nothing rather than to something wrong" a claim about the function instead
    // of a claim about the forty inputs above.
    const SLUG = /^[\w.-]+\/[\w.-]+$/
    const inputs = [
      ...CONFIGS.map(([, gitConfigText]) => ({ gitConfigText })),
      ...GH_REPOS.map(([, ghRepo]) => ({ ghRepo })),
      ...GH_REPOS.map(([, ghRepo]) => ({ ghRepo, gitConfigText: origin('git@github.com:o/n.git') })),
      { gitConfigText: origin(`o/n${ESC}`) },
      { ghRepo: {}, gitConfigText: 42 },
      undefined,
      null,
      42,
      'a string bag',
    ]
    for (const bag of inputs) {
      const answer = resolveBannerRepo(bag)
      if (answer === null) continue
      expect(answer, JSON.stringify(bag)).toMatch(SLUG)
      expect(answer.split('/').every((segment) => !/^\.+$/.test(segment)), answer).toBe(true)
      expect(answer, JSON.stringify(bag)).toBe(answer.trim())
    }
  })

  it('never throws on a config file that is not a config file at all', () => {
    // The caller reads `<cwd>/.git/config` best-effort and hands over whatever came back, so
    // this function's input can be a binary, a lock file, an HTML error page or a truncated
    // read. All of them are one row's worth of nothing.
    const junk = [
      NUL.repeat(1000),
      `${ESC}[31mnot a config${ESC}[0m`,
      '['.repeat(5000),
      `[remote "origin"${LF}\turl = git@github.com:o/n.git${LF}`,
      '<!DOCTYPE html><html><body>404</body></html>',
      `[remote "origin"]${LF}${'\turl = '.repeat(1000)}`,
      'x'.repeat(2_000_000),
    ]
    for (const gitConfigText of junk) {
      expect(resolveBannerRepo({ gitConfigText }), gitConfigText.slice(0, 24)).toBe(null)
    }
  })
})
