// #116 — git's config format and git's two url grammars, reduced to `owner/name`.
//
// Lifted out of lib/banner-model.js, where it was written (#69) and where it did not belong:
// that module answers "which model will the agent use, and how much is that claim worth", and
// this one is a section/key parser, two url grammars and a slug validator. Neither half ever
// read a line of the other's, which is what made #116 a move rather than a rewrite: the cases in
// git-remote-slug.test.js and git-remote-slug.qa.test.js came across unedited, and the only
// assertion added to those two files is the purity read at the bottom of the first.
//
// FOUR SPECS, THEN, NOT TWO: the move also brought two of its own, because a grammar in a file
// of its own is a grammar nobody has to look at again. The grammar table
// (git-remote-slug.grammar.qa.test.js) pins the config spellings and url schemes the #69 table
// never had a row for — the shapes an editor or a hand-edit leaves, rather than the ones
// `git remote add` writes. The extraction-seam guard (git-remote-slug.extraction.qa.test.js)
// reads the MOVE itself: the two export sets, every caller's import, and the two duplicated
// helpers at the bottom of this file. Neither repeats a url the carried pair already holds;
// between them they are the half no behavioural suite can see.
//
// WHY THE ANSWER IS PARSED RATHER THAN ASKED. `gh` knows the repository authoritatively, but
// asking costs a GraphQL round trip (see the `gh repo view` in lib/commands/cycle.js) and the
// row this feeds is printed BEFORE `ralph start`'s first preflight line. A banner that waits on
// api.github.com is a banner that hangs on a bad connection. So the slug comes from what is
// already local: GH_REPO if the environment set it, otherwise origin's url out of `.git/config`.
// Both are read by the caller — see `bannerRepoSlug` in lib/commands/start.js — and arrive here
// as strings.
//
// A MISSING ANSWER IS THE DEGRADATION; A WRONG ONE IS THE DEFECT. Every refusal below is
// written to that asymmetry. `null` is what the composer's gate turns into no row at all, and
// `unknown` would be a claim: gh resolves its base repository from more than origin, so "this
// checkout does not cheaply say" is not the same statement as "there is no repo". Naming a
// repository the loop is not about to read is the one answer this file may never give.
//
// THE EXPORT IS STILL NAMED FOR ITS CALLER, deliberately. The grammar underneath —
// `remoteSlug`, `pathSlug` — is the general half, and it is what a second command reaching for
// this file would want; `resolveBannerRepo` is the banner's particular question on top of it,
// GH_REPO first because that is what `gh` reads first. A general name over that particular
// policy would be the inaccuracy — nothing about `owner/name` says GH_REPO wins — so #116 left
// the name where #69 put it. A second caller with a different question adds a second export
// beside this one.
//
// PURE, and asserted so by a static read in git-remote-slug.test.js: no clock, no environment,
// no filesystem, and — unlike the module this came out of — no imports at all. The config file
// arrives as an argument, which is what makes every case that DRIVES the grammar — all three
// behavioural specs' worth — a string literal instead of a fixture on disk (#41): there is no
// git remote and no checkout anywhere in any of them. The two reads that DO touch a disk are the
// purity read above and the extraction guard's sweep, and what they go looking for is this
// repository's own source. That is what a structural guard is; source is neither a fixture nor a
// checkout of anybody's repository.
//
// NEVER THROWS, on the same grounds as the rest of the banner: this is decoration in front of a
// loop that runs unattended for hours, and no row of it is worth losing a launch over. Every
// input is therefore type-checked rather than coerced — `String(value)` on a hostile bag runs
// its `toString`, and these values come from an ambient environment and a file nobody reads as
// bytes.

/**
 * The repository the loop will read issues from, resolved locally and cheaply.
 *
 * @param {object} [input]
 * @param {string} [input.ghRepo] GH_REPO, as the environment gave it. gh's own spelling is
 *   `[HOST/]OWNER/REPO`, so a host in front is dropped rather than refused.
 * @param {string} [input.gitConfigText] the text of `<cwd>/.git/config` — or anything at
 *   all, since the caller reads it best-effort and may have got nothing
 * @returns {string|null} `owner/name`, or null when it is not cheaply knowable. Never
 *   throws.
 */
export function resolveBannerRepo(input) {
  const { ghRepo, gitConfigText } = bagOf(input)
  // GH_REPO DECIDES WHEN IT IS SET, because it decides for `gh` — the loop's every issue
  // command reads it, so a box that named origin's slug while the loop read someone else's
  // would be wrong in precisely the situation this row was asked for (several checkouts, one
  // of them pointing somewhere unexpected). And when it is set to something that is not a
  // slug the answer is null rather than origin: naming a repo the loop will NOT use is worse
  // than naming none. A blank value is not "set" — that is how an exported-but-empty
  // variable reads to gh too.
  const configured = trimmedOr(ghRepo, '')
  if (configured) return configuredSlug(configured)
  return remoteSlug(originUrl(gitConfigText))
}

// GH_REPO, reduced to `owner/name`.
//
// A GRAMMAR OF ITS OWN, and that is the whole reason this is not `remoteSlug`: gh spells this
// variable `[HOST/]OWNER/REPO`, so THREE segments here means a host was given and is dropped,
// while three segments in a remote's PATH means the url is not a repository at all (its host
// was removed by the scheme parser long before the count). One function taking both would
// have to be told which rule it is applying, which is two functions wearing one name.
function configuredSlug(value) {
  const segments = value.split('/')
  return pathSlug(segments.length === HOST_AND_SLUG ? segments.slice(1).join('/') : value)
}

// `github.com/lucasfe/ralph` — a host and a slug, which is gh's other spelling.
const HOST_AND_SLUG = 3

// `[remote "origin"]`'s url, out of a git config file, or ''.
//
// PARSED RATHER THAN REGEXED WHOLE, because the grammar has three details a single pattern
// gets wrong: section names are case-insensitive while subsection names are not, keys are
// case-insensitive too, and `[core]` in every real file carries keys that a whole-file
// search for `url = ` would happily match. Line by line is also what makes "the LAST url in
// the origin section wins" fall out for free, which is how git itself resolves a repeated
// key.
//
// git's own grammar has more in it than this — line continuations, `[include]`, quoted
// values with escapes — and none of it is honoured here deliberately: this function's job is
// to recognize the file git WRITES, and to answer nothing at all for anything else. A
// missing answer costs one row; a wrong one puts a repo on the screen that the loop is not
// about to read.
function originUrl(text) {
  if (typeof text !== 'string') return ''
  let inOrigin = false
  let url = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = SECTION_LINE.exec(line)
    if (section) {
      inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin'
      continue
    }
    // A BRACKET LINE THIS PARSER CANNOT READ IS STILL A SECTION BOUNDARY, and failing closed
    // here is the difference between a missing row and a WRONG one. Every unrecognized header
    // is a header git accepts and this function does not — a trailing comment on it, git's
    // one-line `[section] key = value`, a hand-edited bracket — and leaving `inOrigin` alone
    // for one would attribute the NEXT section's keys to origin: a fork's config, whose
    // `[remote "upstream"] # the real one` follows origin, would put `them/repo` on the screen
    // while every gh command in the loop read `me/fork`. That is the multi-checkout confusion
    // this row was added to end, and the note above says a wrong answer is the one thing this
    // function may not give. Closing the section costs the safe direction nothing: an
    // unparsed header on origin ITSELF already opened nothing.
    if (line.startsWith('[')) {
      inOrigin = false
      continue
    }
    if (!inOrigin) continue
    const entry = KEY_LINE.exec(line)
    if (entry && entry[1].toLowerCase() === 'url') url = entry[2].trim()
  }
  return url
}

// `[remote "origin"]` — the section type, and the subsection name if there is one.
const SECTION_LINE = /^\[([\w.-]+)(?:\s+"([^"]*)")?\]$/
// `url = git@…`, `URL=git@…`. Values are taken raw and gated by the slug parser below.
const KEY_LINE = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/

// A remote's url, reduced to `owner/name` — or null if it is not one.
//
// TWO GRAMMARS, because git writes two: a url with a scheme, and the scp-like `user@host:path`
// that `git@github.com:owner/name.git` is. A url matching NEITHER is a path on this machine —
// `/srv/git/thing.git`, `../other` — and a `file://` url is one with a scheme; all of them are
// real remotes that are not repositories gh could read an issue from, so all of them answer
// null. Requiring a host is what does that work: `../other` split on `/` is two segments of
// ordinary characters and would otherwise pass for a slug.
function remoteSlug(url) {
  if (typeof url !== 'string' || !url.trim()) return null
  const remote = url.trim()
  const scheme = SCHEME_URL.exec(remote)
  if (scheme) {
    if (!REMOTE_SCHEMES.has(scheme[1].toLowerCase())) return null
    // Everything up to the first `/` is `[user[:password]@]host[:port]`, none of which the
    // slug needs — including a GitHub Enterprise host, because the host is not what a reader
    // is checking when they run Ralph in several checkouts.
    const path = scheme[2].indexOf('/')
    return path === -1 ? null : pathSlug(scheme[2].slice(path + 1))
  }
  if (SCP_URL.test(remote)) return pathSlug(remote.slice(remote.indexOf(':') + 1))
  return null
}

const SCHEME_URL = /^([A-Za-z][\w+.-]*):\/\/(.*)$/
const SCP_URL = /^(?:[^@/]+@)?[^/:]+:/
// The schemes git fetches a remote repository over. `file` is deliberately absent: a bundle
// or a local clone is a real remote and a real workflow, and it is not a repository `gh`
// could read an issue from.
const REMOTE_SCHEMES = new Set(['ssh', 'git', 'http', 'https'])

// `owner/name`, if that is exactly what this path is — after the two decorations git and
// GitHub both put on one: a `.git` suffix and a trailing slash.
//
// STRICT ON PURPOSE. Exactly two segments, each drawn from the characters GitHub allows in an
// owner or a repository name and neither of them a relative path step — so one segment
// (`https://github.com/owner`), three (`https://github.com/a/b/c`), a segment with a space in
// it, `../other` and an empty path (`git@github.com:`) all answer null. gh resolves its base
// repository from more than origin, so a missing answer here means "not cheaply knowable", not
// "no repo" — which is why dropping the row is the right degradation and printing `unknown`
// would not be.
function pathSlug(path) {
  const segments = path.replace(TRAILING_SLASHES, '').replace(DOT_GIT, '').split('/')
  if (segments.length !== 2 || !segments.every((segment) => SLUG_SEGMENT.test(segment))) {
    return null
  }
  return segments.join('/')
}

const TRAILING_SLASHES = /\/+$/
const DOT_GIT = /\.git$/i
// Word characters, dots and hyphens — but never dots ALONE, which is `.` or `..`.
const SLUG_SEGMENT = /^(?!\.+$)[\w.-]+$/

// The two helpers below are DUPLICATED from lib/banner-model.js rather than shared, and that is
// the deliberate half of #116. A third module holding these ten lines would put back the
// coupling the split just removed, one indirection worse: a file whose only reason to exist is
// being imported twice, standing between two grammars that have nothing to say to each other.
// There is no existing home for them either — lib/utils/env.js is the nearest, and it opens
// node:fs on its first line, which is precisely the capability the purity spec next door
// forbids this file. Ten lines with no behaviour between them are the cheaper of the two costs.
// If a THIRD caller ever wants them, that is the point to reconsider, not this one.
//
// AND THE DUPLICATION IS ENFORCED, which is the only thing that makes the trade above safe:
// deliberate duplication stops being deliberate the moment one copy is fixed and the other is
// not, and that divergence is silent — both modules advertise the same never-throws contract, and
// each behavioural suite exercises only its own copy. So git-remote-slug.extraction.qa.test.js
// holds the twins identical: it lifts both copies out as text with formatting normalized away and
// requires them equal, then drives both public functions over the same hostile bags. A one-sided
// fix to `bagOf` or `trimmedOr` is a red test there, not a discovery six months later.

// A bag, whatever was passed. `= {}` covers an absent argument but not a `null` one, and
// destructuring `null` throws — which is the one way a decorative module could still take a
// launch down.
function bagOf(input) {
  return input && typeof input === 'object' ? input : {}
}

// A string fact, trimmed, or the fallback. Refused rather than coerced for the reason the
// header gives, and trimmed because GH_REPO is exported by hand and by scripts — a `read` that
// forgot to chomp its input leaves a newline on the end, and losing the row to it would be a
// worse trade than dropping it.
function trimmedOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length ? trimmed : fallback
}
