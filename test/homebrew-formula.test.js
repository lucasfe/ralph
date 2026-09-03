// #197 — Formula/ralph.rb, rendered from a version and a tarball digest.
//
// Two things are under test and they are deliberately different sizes.
// scripts/lib/render-homebrew-formula.js holds every word of Ruby that will ever
// reach the tap, so it gets the bulk of this file; scripts/generate-homebrew-formula.js
// is argument plumbing, so it gets plumbing specs plus one that asserts it holds
// no formula text of its own.
//
// The specs live here rather than beside the code they exercise because
// vitest.config.js's `include` is ['test/**/*.test.js', 'src/**/*.test.js',
// 'lib/**/*.test.js'] — a spec file under scripts/ is collected by nothing and
// "passes" by never running.
//
// The formula is checked by PARSING the rendered text rather than by diffing it
// against a golden file. A golden file would have to be rewritten for every
// wording change, and it would still not prove the property that matters most:
// that the version asserted in `test do` is the version in `url`. That one is
// checked across several versions, so it cannot pass by coincidence.
//
// The `desc` specs encode rules read out of Homebrew's own auditor, not guessed:
// /opt/homebrew/Library/Homebrew/rubocops/shared/desc_helper.rb sets
// MAX_DESC_LENGTH = 80 and rejects a description that starts with the formula
// name, starts lowercase, or ends with a full stop. package.json's description
// breaks two of those, which is why the renderer normalizes rather than copies.

import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderFormula } from '../scripts/lib/render-homebrew-formula.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const RENDERER = join(REPO_ROOT, 'scripts', 'lib', 'render-homebrew-formula.js')
const CLI = join(REPO_ROOT, 'scripts', 'generate-homebrew-formula.js')

// Nothing in the renderer cares which 64 hex characters it is handed, so the
// fixture digest is a readable pattern instead of a real tarball hash.
const DIGEST = '0123456789abcdef'.repeat(4)

// The package's own metadata, verbatim, because that is what the CLI passes in.
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

/** The version Homebrew will derive from the formula: the one in the tag URL. */
function urlVersion(text) {
  return /archive\/refs\/tags\/v(.+)\.tar\.gz$/.exec(field(text, 'url') ?? '')?.[1] ?? null
}

/** The version the `test do` block asserts `ralph --version` prints. */
function testBlockVersion(text) {
  return /assert_match "(.+)", shell_output/.exec(text)?.[1] ?? null
}

const workDirs = []

afterAll(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true })
})

function workDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-brew-formula-'))
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

describe('renderFormula — the formula it writes', () => {
  it('opens with a do-not-edit banner naming the generator', () => {
    expect(render().split('\n')[0]).toMatch(/generated/i)
    expect(render()).toMatch(/scripts\/generate-homebrew-formula\.js/)
    expect(render()).toMatch(/#197/)
  })

  it('opens the class Homebrew expects for a formula file named ralph.rb', () => {
    expect(render()).toMatch(/^class Ralph < Formula$/m)
    expect(render().trimEnd().endsWith('\nend')).toBe(true)
  })

  it('points url at the tag tarball for the version it was given', () => {
    expect(field(render({ version: '0.25.4' }), 'url')).toBe(
      'https://github.com/lucasfe/ralph/archive/refs/tags/v0.25.4.tar.gz',
    )
  })

  it('sources from the git tag rather than a published npm tarball', () => {
    // The whole reason this channel exists: the SOURCE has to be the tag, so a
    // refused `npm publish` cannot stop a release from being installable. The
    // install step does still resolve dependencies through npm — what may not
    // appear is a registry URL standing in as the formula's source.
    expect(field(render(), 'url')).toMatch(/^https:\/\/github\.com\//)
    expect(render()).not.toMatch(/npmjs\.(org|com)/)
  })

  it('embeds the digest it was handed, and only that digest', () => {
    expect(field(render(), 'sha256')).toBe(DIGEST)
  })

  it('carries homepage and license through from the package metadata', () => {
    expect(field(render(), 'homepage')).toBe(META.homepage)
    expect(field(render(), 'license')).toBe(META.license)
  })

  it('declares node as a dependency so the user never installs one', () => {
    expect(render()).toMatch(/^ {2}depends_on "node"$/m)
  })

  it('installs with the npm arguments Homebrew supplies for node packages', () => {
    // MEASURED, and not the spelling #197 asked for. `brew audit --strict`
    // (Homebrew 6.0.21-34-ga8820d0) on the rendered formula answered:
    //   * line 16, col 46: Possible typo: `Language::Node` does not respond to
    //     `std_npm_args`. Did you mean `std_npm_install_args`?
    // It is right: `std_npm_args` is a Formula INSTANCE method
    // (Library/Homebrew/formula.rb:2262, `prefix: libexec` by default, delegating
    // to Language::Node.std_npm_install_args), and docs/Language-Specific-Formulae.md
    // spells the standard npm install `system "npm", "install", *std_npm_args`.
    // Language::Node defines no `std_npm_args` at all — its install-argument
    // methods are std_npm_install_args (language/node.rb:80) and
    // local_npm_install_args (:106) — so the qualified form names a method that
    // does not exist.
    expect(render()).toMatch(/^ {4}system "npm", "install", \*std_npm_args$/m)
    expect(render()).not.toMatch(/Language::Node/)
  })

  it('symlinks the ralph executable out of libexec into bin', () => {
    expect(render()).toMatch(/^ {4}bin\.install_symlink libexec\/"bin\/ralph"$/m)
  })

  it('checks the installed binary in test do by running it', () => {
    expect(render()).toMatch(/^ {2}test do$/m)
    expect(render()).toMatch(/shell_output\("#\{bin\}\/ralph --version"\)/)
  })

  // Criterion 4, and the reason this file parses instead of eyeballing: the
  // version in `test do` and the version in `url` come from one input, and the
  // only way to prove they cannot drift is to pull both back out of the text.
  it.each(['0.25.4', '1.0.0', '10.20.30', '1.2.3-rc.1'])(
    'asserts the same version in test do that url declares (%s)',
    (version) => {
      const text = render({ version })
      expect(urlVersion(text)).toBe(version)
      expect(testBlockVersion(text)).toBe(version)
    },
  )

  it('ends with exactly one trailing newline', () => {
    expect(render().endsWith('\n')).toBe(true)
    expect(render().endsWith('\n\n')).toBe(false)
  })
})

describe('renderFormula — desc, as brew audit demands it', () => {
  it('drops the formula name audit will not let a desc start with', () => {
    // desc_helper.rb: "Description shouldn't start with the formula name."
    expect(field(render(), 'desc')).toBe('Autonomous GitHub issue resolution loop, packaged as a CLI')
  })

  it('drops the trailing full stop and capitalizes what is left', () => {
    const desc = field(render({ description: 'ralph: does a thing.' }), 'desc')
    expect(desc).toBe('Does a thing')
  })

  it('leaves a description that already satisfies the rules alone', () => {
    expect(field(render({ description: 'Resolves GitHub issues in a loop' }), 'desc')).toBe(
      'Resolves GitHub issues in a loop',
    )
  })

  it('drops the leading article audit rejects', () => {
    // desc_helper.rb: /^(the|an?)(?=\s)/i is an offense, and its autocorrect
    // deletes the article rather than rewording.
    expect(field(render({ description: 'The autonomous issue loop' }), 'desc')).toBe('Autonomous issue loop')
  })

  it('hyphenates "command line", which audit spells "command-line"', () => {
    expect(field(render({ description: 'Command line loop for GitHub issues' }), 'desc')).toBe(
      'Command-line loop for GitHub issues',
    )
  })

  it('refuses a description holding a symbol audit will not allow', () => {
    // \p{So} — the category desc_helper.rb rejects. Deleting the character
    // silently would change the package's own words, so this one throws.
    expect(() => render({ description: 'Resolves GitHub issues ☂' })).toThrow(/desc/i)
  })

  it('refuses a description too long for the 80 characters audit allows', () => {
    expect(() => render({ description: `Does ${'x'.repeat(80)}` })).toThrow(/80/)
  })

  it('refuses a description that normalizes away to nothing', () => {
    expect(() => render({ description: 'Ralph.' })).toThrow(/desc/i)
  })
})

describe('renderFormula — inputs it refuses to render', () => {
  it.each([
    ['too short', DIGEST.slice(0, 63)],
    ['too long', `${DIGEST}0`],
    ['not hex', `${'z'.repeat(64)}`],
    ['padded with whitespace', ` ${DIGEST} `],
    ['prefixed like shasum output', `sha256:${DIGEST}`],
    ['empty', ''],
    ['missing', undefined],
    ['a number', 1234],
  ])('refuses a digest that is %s', (_label, sha256) => {
    expect(() => render({ sha256 })).toThrow(/sha256/i)
  })

  it('accepts an uppercase digest and writes it in the lowercase Homebrew uses', () => {
    expect(field(render({ sha256: DIGEST.toUpperCase() }), 'sha256')).toBe(DIGEST)
  })

  it.each([
    ['tag-shaped', 'v1.2.3'],
    ['two-part', '1.2'],
    ['four-part', '1.2.3.4'],
    ['a dist-tag', 'latest'],
    ['zero-padded', '01.2.3'],
    ['trailing whitespace', '1.2.3 '],
    ['empty', ''],
    ['missing', undefined],
    ['a number', 1.2],
  ])('refuses a version that is %s', (_label, version) => {
    expect(() => render({ version })).toThrow(/version/i)
  })

  it.each(['description', 'homepage', 'license'])('refuses a missing %s', (key) => {
    expect(() => render({ [key]: undefined })).toThrow(new RegExp(key, 'i'))
  })

  it.each([
    ['a double quote', 'Resolves "GitHub" issues'],
    ['a backslash', 'Resolves GitHub\\issues'],
    ['a Ruby interpolation', 'Resolves #{issues}'],
    ['a newline', 'Resolves GitHub\nissues'],
  ])('refuses metadata holding %s, which would break the Ruby literal', (_label, description) => {
    expect(() => render({ description })).toThrow()
  })
})

describe('renderFormula — pure, and therefore reproducible', () => {
  it('renders byte-identical text for the same inputs', () => {
    expect(render()).toBe(render())
  })

  it('imports nothing and reaches for nothing ambient', () => {
    // Criterion 1 is purity, and purity is a property of the source, not of one
    // call: a single-call assertion cannot see a lazily read file or a cached
    // clock. So the source itself is checked for the ways it could stop being a
    // function of its arguments.
    const source = readFileSync(RENDERER, 'utf8')
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/require\(/)
    expect(source).not.toMatch(/\bprocess\b/)
    expect(source).not.toMatch(/Date\.|Math\.random|fetch\(/)
  })

  it('stays out of lib/, the tree package.json publishes', () => {
    expect(existsSync(RENDERER)).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'lib', 'render-homebrew-formula.js'))).toBe(false)
    expect(existsSync(join(REPO_ROOT, 'lib', 'homebrew-formula.js'))).toBe(false)
  })
})

describe('scripts/generate-homebrew-formula.js — argument plumbing only', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

  it('prints the formula on stdout when no output path is given', () => {
    const result = runCliOk(['--sha256', DIGEST])
    expect(result.stdout).toMatch(/^class Ralph < Formula$/m)
  })

  it('defaults the version to the one in package.json, wherever it is run from', () => {
    // cwd is a temp directory, so a package.json found by walking up from cwd
    // would not be this repo's — the version can only come from the script's
    // own location.
    const result = runCliOk(['--sha256', DIGEST])
    expect(urlVersion(result.stdout)).toBe(pkg.version)
  })

  it('renders exactly what the renderer renders for the package metadata', () => {
    // The pairing that keeps formula text out of the CLI: whatever the script
    // prints has to be, byte for byte, the renderer's output for package.json's
    // own fields.
    const result = runCliOk(['--sha256', DIGEST])
    expect(result.stdout).toBe(
      renderFormula({
        version: pkg.version,
        sha256: DIGEST,
        description: pkg.description,
        homepage: pkg.homepage,
        license: pkg.license,
      }),
    )
  })

  it('takes a version override for a tag that is not the working tree version', () => {
    const result = runCliOk(['--sha256', DIGEST, '--version', '9.9.9'])
    expect(urlVersion(result.stdout)).toBe('9.9.9')
    expect(testBlockVersion(result.stdout)).toBe('9.9.9')
  })

  it('writes to the path given with --out, and says so on stdout', () => {
    const dir = workDir()
    const result = runCliOk(['--sha256', DIGEST, '--out', 'ralph.rb'], dir)
    const written = readFileSync(join(dir, 'ralph.rb'), 'utf8')
    expect(written).toBe(runCliOk(['--sha256', DIGEST], dir).stdout)
    expect(result.stdout).toMatch(/ralph\.rb/)
    expect(result.stdout).not.toMatch(/class Ralph/)
  })

  it('fails when no digest is given rather than rendering a formula without one', () => {
    const result = runCli([])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/sha256|usage/i)
    expect(result.stdout).not.toMatch(/class Ralph/)
  })

  it('leaves no output file behind when the digest is malformed', () => {
    const dir = workDir()
    const result = runCli(['--sha256', 'nope', '--out', 'ralph.rb'], dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/sha256/i)
    expect(existsSync(join(dir, 'ralph.rb'))).toBe(false)
  })

  it('rejects an unknown flag instead of ignoring it', () => {
    const result = runCli(['--sha256', DIGEST, '--shasum', DIGEST])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unknown|usage/i)
  })

  it('answers --help on stdout and exits 0', () => {
    const result = runCliOk(['--help'])
    expect(result.stdout).toMatch(/usage/i)
    expect(result.stdout).toMatch(/--sha256/)
    expect(result.stdout).not.toMatch(/class Ralph/)
  })

  it('holds no formula text: every line of Ruby comes from the renderer', () => {
    const source = readFileSync(CLI, 'utf8')
    for (const ruby of [
      'class Ralph',
      '< Formula',
      'depends_on',
      'Language::Node',
      'install_symlink',
      'archive/refs/tags',
      'assert_match',
      'shell_output',
    ]) {
      expect(source, `CLI should not spell Ruby: ${ruby}`).not.toContain(ruby)
    }
  })
})
