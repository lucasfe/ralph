// #197 — a version and a tarball digest → the text of Formula/ralph.rb.
//
// This module owns every line of the formula. The channel it is the first slice of
// does not exist yet — there is no tap and no release job as of this change, both
// later slices of #196. Homebrew builds from the RELEASE TAG's source tarball, not
// from the npm registry, which is the point of having a second channel at all: a
// tag exists the moment release-please merges, so a refused `npm publish` cannot
// stop a release from being installable.
//
// PURE: metadata in, text out. It imports nothing — no fs, no clock, no
// environment — so the same arguments always produce the same string and the
// caller (scripts/generate-homebrew-formula.js) is the only part that touches a
// file. test/homebrew-formula.test.js asserts that emptiness against this source,
// not just against one call.
//
// DEVELOPMENT ONLY, AND NOT PUBLISHED. package.json's `files` is an allow-list
// ("bin", "lib", "templates", and two markdown files), so everything under
// scripts/ is outside the npm tarball by construction — there is no ignore rule
// to keep in sync.
//
// The `desc` rules below are transcribed from Homebrew's own auditor,
// rubocops/shared/desc_helper.rb, rather than guessed: MAX_DESC_LENGTH is 80, and
// a description may not have surrounding whitespace, start with an article, start
// with the formula's name, start lowercase, spell "command line" unhyphenated,
// hold a Unicode Other Symbol, or end with a full stop — except a stop closing
// "etc.", which desc_helper.rb:73 exempts. package.json's description breaks two of
// those rules ("Ralph — …" and the closing "."), so this normalizes it close to the
// way the auditor's own corrector would, and refuses the two things it cannot fix
// without changing what the package says about itself: a description over 80
// characters, and one holding a symbol.
//
// It deviates from the corrector in one direction, always toward a shorter desc: the
// trailing stop is stripped unconditionally, so the exemption above is not honoured.
// Measured — "Manages issues, files, etc." renders `desc "Manages issues, files,
// etc"`. Nothing can fail over it: the result ends in no stop at all, so the /\.$/ the
// exemption guards cannot match. The cost is one character of the package's own
// wording, in exchange for a rule that stays one line long.

// The file this renders is Formula/ralph.rb, so the class Homebrew looks for is
// `Ralph`; the executable it links is package.json's only `bin` entry.
const FORMULA_NAME = 'ralph'
const FORMULA_CLASS = 'Ralph'

// The tag tarball GitHub serves for a release-please tag (`v<version>`). Not
// derived from package.json's `repository` field: that one is
// "git+https://github.com/lucasfe/ralph.git", a clone URL, and this is the archive
// endpoint.
const TAG_TARBALL_PREFIX = 'https://github.com/lucasfe/ralph/archive/refs/tags/v'
const TAG_TARBALL_SUFFIX = '.tar.gz'

// semver.org's recommended pattern with its capture groups made non-capturing:
// three numeric parts with no leading zeros, an optional pre-release and an
// optional build. A leading "v" belongs to the tag, not the version, and is
// rejected so it cannot end up doubled in the URL.
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

// A sha256 as `shasum -a 256` prints it: 64 hex characters, nothing else. Anything
// shorter, longer, prefixed or padded would install as a formula whose checksum
// never matches, and the failure would surface on a user's machine.
const SHA256 = /^[0-9a-fA-F]{64}$/

const MAX_DESC_LENGTH = 80

// A leading formula name and whatever punctuation introduces the rest of the
// sentence: "Ralph — autonomous …" and "ralph: does a thing" both start with the
// name audit rejects. Built from FORMULA_NAME so the two cannot disagree.
const NAME_PREFIX = new RegExp(`^${FORMULA_NAME}\\b[\\s—:,-]*`, 'i')

// A leading article, and the unhyphenated spelling of "command-line": two of the
// rewrites desc_helper.rb's corrector performs on an offending desc (:100 and :108).
// Not "the ones it corrects rather than reports" — `desc_problem` (:89-118) reports
// through add_offense AND attaches a corrector for every rule it handles, symbols
// included (:110 is `correction.gsub!(/\s?\p{So}/, "")`). The length check at :83 is
// the only report-only rule, because it calls `problem` instead. So a corrector
// existing is not the reason this file rewrites these two and refuses a symbol; that
// reason is at the throw.
const LEADING_ARTICLE = /^(?:the|an?)(?=\s)\s*/i
const UNHYPHENATED_COMMAND_LINE = /ommand ?line/gi

// What cannot appear inside a Ruby double-quoted literal without changing what the
// formula means: the quote itself, a backslash, any line break, and an
// interpolation. Checked rather than escaped — these values are a human-written
// description, a homepage and an SPDX identifier, and none of them has a reason to
// hold one.
//
// `#{` is not the only interpolation Ruby honours: `#@ivar`, `#@@cvar` and `#$gvar`
// interpolate with no braces at all. Measured by evaluating the rendered literals in
// a class body under Homebrew's portable ruby 4.0.6:
//
//   "Resolves #@version issues"              -> "Resolves  issues"
//   "Resolves #$stdout issues"               -> "Resolves #<IO:0x…> issues"
//   "Resolves #@@count issues"               -> NameError: uninitialized class
//                                               variable @@count in <the class>
//   "https://github.com/lucasfe/ralph#@readme" -> "https://github.com/lucasfe/ralph"
//
// So the sigil forms lose text or splice a value in silently, and the class variable
// raises while the class body evaluates, which stops brew loading the formula at all.
// Only `#` followed by one of those three sigils is refused: a bare `#` is ordinary
// text — the same ruby returns "https://github.com/lucasfe/ralph#readme" unchanged,
// and that fragment is this package's actual homepage.
const RUBY_UNSAFE = /["\\\n\r]|#[{@$]/

/** @returns {string} the value, once it is a usable string */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(
      `render-homebrew-formula: ${field} must be a non-empty string (got ${JSON.stringify(value ?? null)})`,
    )
  }
  return value
}

/** @returns {string} the value as a Ruby double-quoted literal */
function rubyLiteral(value, field) {
  requireText(value, field)
  if (RUBY_UNSAFE.test(value)) {
    throw new TypeError(
      `render-homebrew-formula: ${field} cannot hold a quote, a backslash, a line break or a ` +
        `Ruby interpolation (got ${JSON.stringify(value)})`,
    )
  }
  return `"${value}"`
}

/** @returns {string} the version, once it is a semver release */
function releaseVersion(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new TypeError(
      `render-homebrew-formula: version must be a semver release such as 1.2.3, with no leading ` +
        `"v" (got ${JSON.stringify(version ?? null)})`,
    )
  }
  return version
}

/** @returns {string} the digest, lowercased the way Homebrew writes it */
function tarballDigest(sha256) {
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw new TypeError(
      `render-homebrew-formula: sha256 must be 64 hex characters, as \`shasum -a 256\` prints ` +
        `them (got ${JSON.stringify(sha256 ?? null)})`,
    )
  }
  return sha256.toLowerCase()
}

/**
 * package.json's `description` → a `desc` brew audit accepts.
 *
 * @param {string} description package.json's description, verbatim
 * @returns {string} the description, normalized to Homebrew's rules
 */
function homebrewDesc(description) {
  requireText(description, 'description')

  let desc = description.trim()

  // Both rules have to hold at once — desc_helper.rb reports a leading article and a
  // leading formula name a few lines apart — and removing one can uncover the other:
  // "The Ralph autonomous issue loop" loses its article and hands the name to the
  // front. `brew audit --strict` was run on that rendering and answered "line 7, col
  // 9: Description shouldn't start with the formula name." So strip until neither
  // matches rather than once each; that terminates because a pass which changes
  // anything makes the string shorter. Article before name inside the pass, which is
  // also the order the auditor's own corrector uses (desc_helper.rb:100 removes
  // `^(the|an?)\s+`, then :109 removes the name with
  // `correction.gsub!(/(^|[^a-z])#{@name}([^a-z]|$)/i, "\\1\\2")`).
  let previous
  do {
    previous = desc
    desc = desc.replace(LEADING_ARTICLE, '').replace(NAME_PREFIX, '')
  } while (desc !== previous)

  desc = desc.replace(UNHYPHENATED_COMMAND_LINE, 'ommand-line')
  desc = desc.replace(/\.+$/, '').trim()

  if (desc === '') {
    throw new TypeError(
      `render-homebrew-formula: description is nothing once the formula name, a leading ` +
        `article and a trailing stop are removed (got ${JSON.stringify(description)}), so ` +
        `there is no desc to write`,
    )
  }
  desc = desc[0].toUpperCase() + desc.slice(1)

  if (/\p{So}/u.test(desc)) {
    throw new TypeError(
      `render-homebrew-formula: desc cannot hold a symbol — brew audit rejects Unicode Other ` +
        `Symbols, and dropping it would change what the package says (got ${JSON.stringify(desc)})`,
    )
  }
  if (desc.length > MAX_DESC_LENGTH) {
    throw new RangeError(
      `render-homebrew-formula: desc must be at most ${MAX_DESC_LENGTH} characters, which is ` +
        `brew audit's limit; ${JSON.stringify(desc)} is ${desc.length}`,
    )
  }
  return desc
}

/**
 * Renders the complete text of Formula/ralph.rb.
 *
 * @param {object} options
 * @param {string} options.version release version, semver, no leading "v"
 * @param {string} options.sha256 sha256 of that tag's source tarball, 64 hex characters
 * @param {string} options.description package.json's description
 * @param {string} options.homepage package.json's homepage
 * @param {string} options.license package.json's license, an SPDX identifier
 * @returns {string} formula source, one trailing newline, deterministic
 */
export function renderFormula(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('render-homebrew-formula: expected an options object')
  }
  const { version, sha256, description, homepage, license } = options
  const release = releaseVersion(version)
  const digest = tarballDigest(sha256)
  const desc = rubyLiteral(homebrewDesc(description), 'description')
  const home = rubyLiteral(homepage, 'homepage')
  const spdx = rubyLiteral(license, 'license')

  // desc, homepage, url, sha256, license, and in that order: swapping any two of
  // them was measured to fail `brew audit --strict` and `brew style` alike, with
  // "FormulaAudit/ComponentsOrder: homepage (line 9) should be put before url".
  const lines = [
    '# GENERATED FILE — do not edit by hand.',
    '#',
    '# Rendered by `node scripts/generate-homebrew-formula.js` in lucasfe/ralph (#197)',
    '# from a release tag and the sha256 of its source tarball. A hand edit is lost',
    '# at the next release: change the renderer, or re-run it.',
    `class ${FORMULA_CLASS} < Formula`,
    `  desc ${desc}`,
    `  homepage ${home}`,
    `  url "${TAG_TARBALL_PREFIX}${release}${TAG_TARBALL_SUFFIX}"`,
    `  sha256 "${digest}"`,
    `  license ${spdx}`,
    '',
    '  depends_on "node"',
    '',
    '  def install',
    // Homebrew has the tag's source tree, not a published tarball, so npm resolves
    // the package's runtime dependencies during `brew install`. That is what
    // docs/Language-Specific-Formulae.md calls the "standard npm installation".
    //
    // Bare `std_npm_args`, NOT `Language::Node.std_npm_args`: it is a Formula
    // instance method (Library/Homebrew/formula.rb:2262) that defaults to
    // `prefix: libexec` and delegates to Language::Node.std_npm_install_args. The
    // qualified form is what #197 asked for and `brew audit` rejects it outright —
    // "Possible typo: `Language::Node` does not respond to `std_npm_args`".
    '    system "npm", "install", *std_npm_args',
    `    bin.install_symlink libexec/"bin/${FORMULA_NAME}"`,
    '  end',
    '',
    '  test do',
    // The version is written in, not interpolated from `version`, so that the two
    // are one substitution of the same argument and a test can prove they agree.
    `    assert_match "${release}", shell_output("#{bin}/${FORMULA_NAME} --version")`,
    '  end',
    'end',
  ]
  return `${lines.join('\n')}\n`
}
