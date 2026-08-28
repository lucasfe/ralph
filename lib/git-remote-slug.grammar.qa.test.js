// #116 QA — the config spellings and url shapes the moved table does not name.
//
// git-remote-slug.qa.test.js is #69's adversarial table, carried across unedited by the move,
// and it is the reason this file is short: almost every hostile shape a `.git/config` can be in
// is already a row over there. What is left is the boundary a MOVE cannot change and a moved
// suite can still leave untested — the spellings that arrive from an editor or a hand-edit
// rather than from `git remote add`, and the two url schemes that sit just outside the set this
// grammar admits. Every row below was checked against that table first; a shape it already
// holds is not repeated here.
//
// WHY THESE AND NOT MORE. The extraction is asserted next door
// (git-remote-slug.extraction.qa.test.js): same code, same exports, same helpers. So the risk
// this file addresses is not the move — it is that a grammar nobody has to look at any more,
// in a file of its own, is a grammar whose edges are whatever the last table happened to
// cover. The answers here are therefore pinned as READINGS, several of them refusals of a
// spelling git itself accepts: a missing row costs one line of decoration, and this module's
// whole design is that the wrong row would cost a reader's afternoon.
//
// Invisible characters are built from their code points rather than embedded — a BOM pasted
// into a source file is exactly as unfindable as the raw control bytes
// test/source-control-bytes.test.js forbids, and the label beside it is the only reason a
// reader knows the case is there at all. Nothing here reads a clock, an environment or a real
// file (#41).

import { describe, expect, it } from 'vitest'
import { resolveBannerRepo } from './git-remote-slug.js'

const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const BOM = String.fromCharCode(0xfeff)
const NBSP = String.fromCharCode(0xa0)

const origin = (...urls) =>
  ['[remote "origin"]', ...urls.map((url) => `\turl = ${url}`), ''].join(LF)

describe('QA #116 git-remote-slug — the file as an editor and a hand-edit leave it', () => {
  // Whole-file shapes, each one a way a real `.git/config` differs from the one `git remote`
  // writes. The interesting half is which of them still resolve: a parser tightened by
  // accident would answer null for the lot, and null is invisible in a box with no repo row.
  const FILES = [
    // A BOM is what a Windows editor prepends when it saves the file, and it lands in front
    // of the FIRST section header — where a whole-file regex would tolerate it and a
    // line-by-line parser might not. `trim()` treats U+FEFF as whitespace, so it does.
    ['a BOM in front of the origin header', `${BOM}${origin('git@github.com:o/n.git')}`, 'o/n'],
    ['a BOM in front of the url line', `[remote "origin"]${LF}${BOM}\turl = git@github.com:o/n.git${LF}`, 'o/n'],
    // No trailing newline at all: `split('\n')` hands the last chunk over as a line, so the
    // url on the final line of a hand-edited file is read. Every case in the moved table ends
    // in a newline, so this is the one shape that would have proved the loop's last iteration
    // does something.
    ['origin’s url as the last line, unterminated', '[remote "origin"]\n\turl = git@github.com:o/n.git', 'o/n'],
    ['a section header as the last line, unterminated', '[remote "origin"]', null],
    // CR ALONE is not a line ending to this parser, so a classic-Mac or CR-mangled file is one
    // enormous line and answers nothing. Pinned as the refusal it is rather than fixed: git
    // does not write such a file either, and a row is the whole cost.
    ['CR-only line endings', `[remote "origin"]${CR}\turl = git@github.com:o/n.git${CR}`, null],
    // The header's own internal whitespace. `\s+` between the section and its subsection is
    // the grammar, so a tab or two spaces are the same header...
    ['a tab between the section and the subsection', `[remote\t"origin"]${LF}\turl = git@github.com:o/n.git${LF}`, 'o/n'],
    ['two spaces between them', `[remote  "origin"]${LF}\turl = git@github.com:o/n.git${LF}`, 'o/n'],
    // ...while a space INSIDE the closing bracket is a header this parser cannot read, and an
    // unreadable header on origin itself opens nothing. Same reading as the trailing-comment
    // row in the moved table, reached by a different typo.
    ['a space before the closing bracket', `[remote "origin" ]${LF}\turl = git@github.com:o/n.git${LF}`, null],
    ['an indented section header', `  [remote "origin"]${LF}\turl = git@github.com:o/n.git${LF}`, 'o/n'],
    // Indentation of the KEY is free, whatever it is made of. The moved table already pins a
    // tab-and-spaces prefix; NBSP is here because it is the one whitespace character a reader
    // would expect to break the key pattern — a value pasted out of a browser brings one — and
    // `trim()` removes it too.
    ['a url line indented with NBSP', `[remote "origin"]${LF}${NBSP}url = git@github.com:o/n.git${LF}`, 'o/n'],
    ['tabs around the equals sign', `[remote "origin"]${LF}\turl\t=\tgit@github.com:o/n.git${LF}`, 'o/n'],
    // A key with no section above it — the head of a file whose first header was deleted.
    // There is no implicit origin, so there is no url.
    ['a bare url key above every header', `url = git@github.com:o/n.git${LF}`, null],
    // A key whose NAME merely starts with `url`. The key pattern captures the whole name and
    // compares it, so `urlx` is not `url` — which is what keeps a future git key nobody has
    // heard of from answering for this row.
    ['a key whose name only starts with url', `[remote "origin"]${LF}\turlx = git@github.com:o/n.git${LF}`, null],
    // TWO `[remote "origin"]` BLOCKS, which is what a hand-merged config or a botched
    // `git remote add origin` leaves behind. git reads the last value of a repeated key, and
    // so does this — across blocks, not just within one...
    ['the origin section repeated, the second holding the url', `${origin('git@github.com:old/name.git')}${origin('git@github.com:new/name.git')}`, 'new/name'],
    // ...and the last URL wins rather than the last BLOCK, which is the same rule and the
    // shape that tells the two apart: a second origin section carrying only a `fetch` line
    // must not blank the answer the first one gave.
    ['the origin section repeated, the second holding no url', `${origin('git@github.com:o/n.git')}[remote "origin"]${LF}\tfetch = +refs/heads/*:refs/remotes/origin/*${LF}`, 'o/n'],
  ]

  for (const [label, gitConfigText, expected] of FILES) {
    it(`answers ${JSON.stringify(expected)} for ${label}`, () => {
      expect(resolveBannerRepo({ gitConfigText })).toBe(expected)
    })
  }
})

describe('QA #116 git-remote-slug — url shapes at the edge of the two grammars', () => {
  // One url spelling is one row, all of them out of origin's `url` key.
  const URLS = [
    // THE SCHEME SET IS A CLOSED LIST, and these two are the entries a reader is most likely
    // to expect in it: `git+ssh://` and `ssh+git://` are aliases git fetches over, and both
    // answer no row here. Pinned rather than filed, because the cost is one row on a setup
    // almost nobody has and the alternative — admitting a scheme this file has never been
    // handed — is a guess. If a real checkout ever turns up with one, this is the row that
    // says the answer was chosen.
    ['a git+ssh scheme', 'git+ssh://git@github.com/o/n.git', null],
    ['an ssh+git scheme', 'ssh+git://git@github.com/o/n.git', null],
    // A url that stops at the authority: everything up to the first `/` is host and port, so
    // there is no path left to be a slug. The moved table's shortest url still has the slash
    // (`https://github.com/`), and this is the branch on the other side of it — the one shape
    // where the scheme grammar has to answer null WITHOUT ever consulting the slug parser.
    ['a port and no path at all', 'ssh://git@github.com:22', null],
    // The scp grammar has NO port field — `git@host:22/o/n.git` means the path is `22/o/n.git`
    // to git as well, so three segments is the right refusal rather than a parse of the port.
    ['an scp url with a port-looking first segment', 'git@github.com:22/o/n.git', null],
    // A punycode owner is ordinary word characters and hyphens, so the slug resolves — and it
    // is the shape a non-ASCII owner actually reaches a config file in. The moved table pins
    // the raw non-ASCII spelling as null; this is the same owner, encoded the way git writes
    // it, and it must not be refused with it.
    ['a punycode owner', 'git@github.com:xn--brger-kva/n.git', 'xn--brger-kva/n'],
    // The `.git` strip is anchored at the END of the whole path, which is the only place git
    // and GitHub put one. An owner that happens to end in `.git` keeps it: the segment is
    // reported as the config spelled it rather than edited into a repository nobody named.
    ['an owner ending in .git', 'git@github.com:o.git/n.git', 'o.git/n'],
  ]

  for (const [label, url, expected] of URLS) {
    it(`answers ${JSON.stringify(expected)} for ${label}`, () => {
      expect(resolveBannerRepo({ gitConfigText: origin(url) })).toBe(expected)
    })
  }
})

describe('QA #116 git-remote-slug — a value that is not a string, and one that is far too long', () => {
  // Every non-string shape GH_REPO can arrive as from a caller that read it out of a JSON
  // config, a proxy, or an object pretending to be text. All of them answer no row, and NONE
  // of them is coerced: the module's contract is that a hostile `toString` is never run, and
  // the three below throw from theirs so a coercion would be a red test rather than a silent
  // slug. `Symbol.toPrimitive` earns its own row because it is the hook `String(value)` calls
  // FIRST — a coercion added later would trip this one before it ever reached `toString`.
  const coerced = () => {
    throw new Error('a fact must never be coerced')
  }
  const VALUES = [
    ['a number', 42],
    ['a bigint', 10n],
    ['a boolean', true],
    ['a symbol', Symbol('o/n')],
    ['an array of slugs', ['o/n']],
    ['a bag whose toString throws', { toString: coerced }],
    ['a bag whose valueOf throws', { valueOf: coerced }],
    ['a bag whose Symbol.toPrimitive throws', { [Symbol.toPrimitive]: coerced }],
  ]

  for (const [label, ghRepo] of VALUES) {
    it(`answers null for a GH_REPO that is ${label}`, () => {
      expect(resolveBannerRepo({ ghRepo })).toBe(null)
      // ...and it does not fall through to origin either. A GH_REPO that is not text is a
      // GH_REPO nobody set, which is the one reading that makes the box agree with `gh`.
      expect(resolveBannerRepo({ ghRepo, gitConfigText: origin('git@github.com:o/n.git') })).toBe(
        'o/n',
      )
    })
  }

  it('takes a bag by its own shape rather than by its constructor', () => {
    // `bagOf` asks `typeof input === 'object'`, so an ARRAY carrying the fact is a bag and a
    // null-prototype object is too. Both are pinned because both are what a caller that built
    // the bag from a parsed document hands over, and because "an array is not a bag" is the
    // kind of thing a future guard would add without a test to say otherwise.
    expect(resolveBannerRepo(Object.assign(['irrelevant'], { ghRepo: 'o/n' }))).toBe('o/n')
    expect(resolveBannerRepo(Object.assign(Object.create(null), { ghRepo: 'o/n' }))).toBe('o/n')
    // A bag of the wrong kind with no fact in it is simply no facts — never a throw.
    for (const bag of [Object.create(null), new Date(), new Map([['ghRepo', 'o/n']]), []]) {
      expect(resolveBannerRepo(bag)).toBe(null)
    }
  })

  it('answers a half-megabyte value without a throw and without a stall', () => {
    // NO LENGTH CAP, deliberately: clipping is the composer's job (`…` at the box's width),
    // and a cap here would be a second opinion about what a row can hold. What has to be true
    // is that the grammar stays linear — every pattern in this file is anchored and none of
    // them nests a quantifier, so the pathological inputs below cannot backtrack. A pattern
    // that could would not fail this assertion, it would blow vitest's own timeout, which is
    // exactly the signal wanted.
    const owner = 'a'.repeat(500_000)
    expect(resolveBannerRepo({ ghRepo: `${owner}/n` })).toBe(`${owner}/n`)
    // The same length in the two shapes that make a regex work hardest: a segment of nothing
    // but dots (which the `(?!\.+$)` guard has to reject) and one that fails on its last
    // character only.
    expect(resolveBannerRepo({ ghRepo: `${'.'.repeat(100_000)}/n` })).toBe(null)
    expect(resolveBannerRepo({ ghRepo: `${owner} /n` })).toBe(null)
  })
})
