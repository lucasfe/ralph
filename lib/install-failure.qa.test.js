import { describe, it, expect } from 'vitest'
import { installFailureDetails } from './install-failure.js'

// QA augmentation for #23, at the level where every wording and every bound is
// decided: the pure module. The dev's update.test.js drives this through
// `updateCommand` with realistic npm output; these tests attack the seams that a
// realistic input cannot reach:
//   1. the BOUND, adversarially: 200k lines, one 5 MB line with no `\n`, CRLF,
//      whitespace-only logs, and the exact off-by-one at TAIL_COLUMNS
//   2. the permission signals in BOTH directions — a miss is a wrong hint, and a
//      false positive is a wrong hint too
//   3. `Object.hasOwn(PERMISSION_FIX, argv[0])` with a hostile argv[0]
//   4. malformed `failure` / `target` objects: never throw, never print a blank
//      or garbage line
//   5. the line contract the caller depends on: one whole line per element,
//      already indented, no colour of its own
//
// TAIL_LINES = 12 and TAIL_COLUMNS = 200 are the module's constants; they are not
// exported, so they are spelled here and asserted as observable behavior.
const TAIL_LINES = 12
const TAIL_COLUMNS = 200

const strip = (s) => s.replace(/\u001B\[[0-9;]*m/g, '')
const text = (lines) => strip(lines.join('\n'))

const NPM = {
  argv: ['npm', 'install', '-g', '@lucasfe/ralph@latest'],
  label: 'npm install -g @lucasfe/ralph@latest',
}

// The detail lines for a stderr-only failure, which is the shape #23 is about.
const forStderr = (stderr, target = NPM) => installFailureDetails({ stderr }, target)

// The manager output block only, without the `… wrote:` header and without the
// hint: what `boundedTail` produced, unindented.
const tailOf = (lines) =>
  lines
    .slice(1)
    .filter((l) => l.startsWith('     ') && !/^ {5}(Point it|Or re-run)/.test(l))
    .map((l) => l.slice(5))

const numbered = (n, prefix = 'npm error line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n')

const hinted = (lines) => lines.some((l) => /that is a permission error/i.test(l))

describe('installFailureDetails — the bound is a bound, whatever the log (#23 QA)', () => {
  it('bounds a 200k-line log to the last 12 lines plus one omitted-count line', async () => {
    const lines = forStderr(numbered(200_000))
    // 1 header + 1 omitted marker + 12 kept lines. Nothing else, ever.
    expect(lines).toHaveLength(2 + TAIL_LINES)
    expect(tailOf(lines)).toHaveLength(TAIL_LINES + 1)
    expect(text(lines)).toContain('npm error line 200000')
    expect(text(lines)).toContain('npm error line 199989')
    expect(text(lines)).not.toContain('npm error line 199988\n')
    expect(text(lines)).not.toContain('npm error line 1\n')
    // The whole report stays a few hundred bytes, not megabytes.
    expect(text(lines).length).toBeLessThan(2000)
  })

  it('reports how many lines it dropped, and gets the count right', async () => {
    const lines = forStderr(numbered(200_000))
    expect(tailOf(lines)[0]).toBe(`… ${200_000 - TAIL_LINES} earlier lines omitted`)
  })

  it('clips ONE 5 MB line with no newline at all instead of printing it', async () => {
    const lines = forStderr(`npm error ${'x'.repeat(5 * 1024 * 1024)}`)
    expect(lines).toHaveLength(2)
    const [clipped] = tailOf(lines)
    expect(clipped).toHaveLength(TAIL_COLUMNS)
    expect(clipped.endsWith('…')).toBe(true)
    expect(clipped.startsWith('npm error xxx')).toBe(true)
  })

  it('clips at exactly TAIL_COLUMNS: 200 columns is untouched, 201 becomes 200 with a marker', async () => {
    const exact = tailOf(forStderr('x'.repeat(TAIL_COLUMNS)))[0]
    expect(exact).toHaveLength(TAIL_COLUMNS)
    expect(exact).not.toContain('…')

    const over = tailOf(forStderr('x'.repeat(TAIL_COLUMNS + 1)))[0]
    // The clip must not grow the line past the bound it is enforcing.
    expect(over).toHaveLength(TAIL_COLUMNS)
    expect(over.endsWith('…')).toBe(true)
    expect(over.slice(0, -1)).toBe('x'.repeat(TAIL_COLUMNS - 1))
  })

  it('keeps 12 lines with no omitted marker, and marks the 13th in the singular', async () => {
    const twelve = tailOf(forStderr(numbered(TAIL_LINES, 'L')))
    expect(twelve).toHaveLength(TAIL_LINES)
    expect(text(forStderr(numbered(TAIL_LINES, 'L')))).not.toMatch(/omitted/)

    const thirteen = tailOf(forStderr(numbered(TAIL_LINES + 1, 'L')))
    expect(thirteen[0]).toBe('… 1 earlier line omitted')
    expect(thirteen).toHaveLength(TAIL_LINES + 1)
    expect(thirteen.at(-1)).toBe('L 13')
    expect(thirteen).not.toContain('L 1')
  })

  it('strips the CR from CRLF output instead of writing it into the terminal', async () => {
    // A Windows manager writes `\r\n`. A surviving `\r` would make the terminal
    // overwrite the line it just printed.
    const lines = forStderr('npm error a\r\nnpm error b\r\nnpm error code EACCES\r\n')
    for (const line of lines) {
      expect(line).not.toContain('\r')
    }
    expect(tailOf(lines)).toEqual(['npm error a', 'npm error b', 'npm error code EACCES'])
  })

  it('splits on newlines only — a bare CR mid-line is not a line break', async () => {
    // Characterized: only `\n` ends a line, so a progress-bar CR stays inside the
    // one line it arrived on rather than inventing a second write.
    const lines = forStderr('npm error start\rnpm error end')
    expect(tailOf(lines)).toHaveLength(1)
  })

  it('says "no output" for a log made of nothing but blank or whitespace lines', async () => {
    for (const blank of ['\n\n\n\n', '   \t \n  \n', '\r\n\r\n', ' ', '\n']) {
      const lines = forStderr(blank)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('printed no output')
      // Never an empty `npm wrote:` block, which would read as "it said nothing"
      // while claiming it said something.
      expect(text(lines)).not.toContain('wrote:')
    }
  })

  it('never emits a blank, whitespace-only or multi-line element', async () => {
    const logs = [
      'npm error a\n\n\nnpm error b',
      numbered(50),
      `npm error ${'y'.repeat(1000)}`,
      'npm error code EACCES\n   \nnpm error errno -13',
      'a\r\n\r\nb',
    ]
    for (const log of logs) {
      for (const line of forStderr(log)) {
        expect(line.trim()).not.toBe('')
        expect(line).not.toContain('\n')
        // Already indented for the caller, which writes each element verbatim.
        expect(line.startsWith('   ')).toBe(true)
      }
    }
  })

  it('drops the blank lines inside a log and counts what it kept (characterized)', async () => {
    // The omitted count is computed AFTER blank lines are filtered out, so it
    // reads as "content lines dropped", not "raw lines dropped": 26 raw lines
    // (13 of them blank) reports 1, not 14.
    const interleaved = Array.from({ length: 26 }, (_, i) => (i % 2 ? '' : `L${i / 2 + 1}`))
    const lines = forStderr(interleaved.join('\n'))
    expect(tailOf(lines)[0]).toBe('… 1 earlier line omitted')
    expect(tailOf(lines).filter((l) => l === '')).toHaveLength(0)
  })

  it('adds no colour of its own — the caller owns that', async () => {
    const lines = forStderr('npm error code EACCES')
    for (const line of lines) expect(line).toBe(strip(line))
  })
})

describe('installFailureDetails — permission signals, in both directions (#23 QA)', () => {
  const fires = [
    ['npm code EACCES', 'npm error code EACCES'],
    ['npm errno -13', 'npm error errno -13'],
    ['errno with a colon', 'npm error errno: -13'],
    ['errno -13 followed by punctuation', 'npm error   errno: -13,'],
    ['Windows EPERM', 'npm error code EPERM'],
    ['lowercase permission denied', "Error: permission denied, mkdir '/usr/local/lib'"],
    ['uppercase OPERATION NOT PERMITTED', 'error: OPERATION NOT PERMITTED'],
  ]

  for (const [label, stderr] of fires) {
    it(`treats ${label} as a permission failure`, async () => {
      expect(hinted(forStderr(stderr))).toBe(true)
    })
  }

  const staysQuiet = [
    ['a 404', 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x'],
    ['ENOTFOUND', 'npm error code ENOTFOUND\nnpm error network getaddrinfo ENOTFOUND'],
    ['a typo with one letter too many', 'npm error code EACCESS'],
    ['EACCES glued to another word', 'npm error NOTEACCES'],
    ['EPERM glued to another word', 'npm error EPERMS'],
    ['lowercase eacces alone', 'npm error code eacces'],
    ['a package whose name merely contains eacces', 'npm error 404 eacces-utils is not in this registry'],
    // The `\b` after `-13` is what keeps a three-digit errno out: `-130` is a
    // different error (EPROTO family), and hinting at permissions there would
    // send the user to change a prefix that is not the problem.
    ['errno -130', 'npm error errno -130'],
    ['errno -1300', 'npm error errno -1300'],
    ['errno -113', 'npm error errno -113'],
    ['a -13 that is not an errno', 'npm error exit code -13'],
  ]

  for (const [label, stderr] of staysQuiet) {
    it(`adds no permission hint for ${label}`, async () => {
      const lines = forStderr(stderr)
      expect(hinted(lines)).toBe(false)
      expect(text(lines)).not.toMatch(/sudo|prefix/i)
    })
  }

  it('hints on a permission phrase quoted by an unrelated dependency (characterized)', async () => {
    // A known false positive of a text signal: the real failure is a 404, but a
    // postinstall script quoted `permission denied` on its way past. The hint is
    // additive — the raw output is right above it — so a spurious hint costs a
    // line, while missing a real one costs the user the fix.
    const lines = forStderr(
      [
        'npm warn some-dep postinstall: chmod: /tmp/x: permission denied',
        'npm error code E404',
        'npm error 404 Not Found',
      ].join('\n'),
    )
    expect(hinted(lines)).toBe(true)
  })

  it('matches the signal BEFORE truncation, so a clipped-away code still hints', async () => {
    // Real npm prints `code EACCES` at the TOP of its error block and 18 more
    // lines of guidance after it, so the tail does not contain the code at all.
    // The hint must not depend on the code surviving the clip.
    const realNpmLog = [
      'npm error code EACCES',
      'npm error syscall mkdir',
      'npm error path /usr/local/lib/node_modules/@lucasfe',
      'npm error errno -13',
      "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@lucasfe'",
      'npm error     at Object.mkdirSync (node:fs:1372:26)',
      'npm error   errno: -13,',
      "npm error   code: 'EACCES',",
      "npm error   syscall: 'mkdir',",
      'npm error }',
      'npm error',
      'npm error The operation was rejected by your operating system.',
      'npm error It is likely you do not have the permissions to access this file as the current user',
      'npm error',
      'npm error If you believe this might be a permission error, please double-check the',
      'npm error permissions of the file and its containing directories, or try running',
      'npm error the command again as root/Administrator.',
      'npm error',
      'npm error A complete log of this run can be found in: /Users/me/.npm/_logs/x-debug-0.log',
    ].join('\n')
    const lines = forStderr(realNpmLog)
    expect(text(lines)).not.toContain('npm error code EACCES')
    expect(hinted(lines)).toBe(true)
    expect(text(lines)).toContain('npm config set prefix')
  })

  it('hints from `code` alone when the output says nothing about permissions', async () => {
    const lines = installFailureDetails({ stderr: 'npm error something opaque', code: 'EACCES' }, NPM)
    expect(hinted(lines)).toBe(true)
    // And the raw output is still reported, not replaced by the hint.
    expect(text(lines)).toContain('npm error something opaque')
  })

  it('never interpolates the failure text into the command it invites you to paste', async () => {
    // The sudo line is built from the target, never from manager output: a log
    // quoting shell metacharacters must not end up inside a copy-pasteable line.
    const lines = forStderr('npm error EACCES: permission denied `; rm -rf ~`  $(whoami)')
    const sudo = lines.find((l) => l.includes('sudo'))
    expect(sudo).toBe(`     Or re-run this install with elevated privileges: \`sudo ${NPM.label}\``)
    expect(sudo).not.toMatch(/rm -rf|whoami/)
  })
})

describe('installFailureDetails — the per-manager fix, keyed on argv[0] (#23 QA)', () => {
  const knobs = [
    ['npm', 'npm config set prefix ~/.npm-global'],
    ['pnpm', 'pnpm setup'],
    ['yarn', 'yarn config set prefix ~/.yarn'],
    ['bun', 'export BUN_INSTALL="$HOME/.bun"'],
  ]

  for (const [manager, knob] of knobs) {
    it(`names ${manager}'s own global-prefix knob, and no other manager's`, async () => {
      const argv = [manager, 'add', '-g', '@lucasfe/ralph@latest']
      const lines = installFailureDetails({ stderr: 'EACCES' }, { argv, label: argv.join(' ') })
      expect(text(lines)).toContain(`\`${knob}\``)
      expect(text(lines)).toContain(`sudo ${argv.join(' ')}`)
      for (const [other, otherKnob] of knobs) {
        if (other !== manager) expect(text(lines)).not.toContain(otherKnob)
      }
    })
  }

  const hostile = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']

  for (const manager of hostile) {
    it(`answers no fix for an inherited key as argv[0] (\`${manager}\`)`, async () => {
      const argv = [manager, 'install', '-g', 'x']
      let lines
      expect(() => {
        lines = installFailureDetails({ stderr: 'EACCES' }, { argv, label: argv.join(' ') })
      }).not.toThrow()
      // Generic wording, and above all NOT npm's knob for a command that is not npm.
      expect(text(lines)).toMatch(/point it somewhere you own \(see/i)
      expect(text(lines)).not.toContain('npm config set prefix')
      expect(text(lines)).not.toContain('pnpm setup')
      // Whatever the key, the fix line must be one line of text, not a function.
      for (const line of lines) expect(typeof line).toBe('string')
    })
  }

  it('is case-sensitive on the manager name (characterized)', async () => {
    // `NPM` is not `npm`: an argv[0] that is not the lowercase binary name gets
    // the generic wording rather than a knob that may not apply.
    const lines = installFailureDetails(
      { stderr: 'EACCES' },
      { argv: ['NPM', 'install', '-g', 'x'], label: 'NPM install -g x' },
    )
    expect(text(lines)).not.toContain('npm config set prefix')
    expect(text(lines)).toMatch(/see NPM's global-prefix setting/)
  })

  it("names brew's ownership fix, and offers no sudo at all", async () => {
    // AMENDED BY #198. This test was written for #23, when brew was purely
    // hypothetical: it stood in for "a manager Ralph has no data for" and pinned
    // the generic wording plus the sudo line. #198 made a brew install a shipped
    // path (`ralph update` now runs `brew upgrade ralph`), which turned both of
    // those into advice Homebrew refuses to run:
    //   "see brew's global-prefix setting" — there is no such setting; brew's
    //     prefix is fixed per platform and chosen when brew itself was installed.
    //   "sudo brew upgrade ralph" — `brew` aborts as root outright ("Running
    //     Homebrew as root is extremely dangerous and no longer supported",
    //     Library/Homebrew/brew.sh's check-run-command-as-root), so it cannot be
    //     followed at all — which is why the line is dropped, not reworded.
    // The generic fallback it used to cover is still covered, by the hostile-key
    // and case-sensitivity tests above and by update.test.js's MacPorts stand-in.
    const argv = ['brew', 'upgrade', 'ralph']
    const lines = installFailureDetails({ stderr: 'EACCES' }, { argv, label: argv.join(' ') })
    // `brew doctor` rather than a chown written here: the directories that must be
    // writable are brew's own list (`Keg.must_be_writable_directories`), it
    // includes a cache that is not under the prefix, and brew's docs rule out
    // recursively chowning the prefix without identifying the path first.
    expect(text(lines)).toContain('`brew doctor`')
    expect(text(lines)).not.toContain('chown')
    expect(text(lines)).not.toMatch(/see brew's global-prefix setting/)
    expect(text(lines)).not.toMatch(/point it somewhere you own/i)
    expect(text(lines)).not.toContain('sudo brew')
    expect(text(lines)).not.toContain('elevated privileges')
  })

  it('drops exactly the sudo line for brew, and keeps every other line npm gets', async () => {
    // The suppression is one line, not a different hint: the headline and the
    // reported output are the same, and only the elevated re-run is gone. Pinned
    // by count as well as by wording, so a future row cannot quietly lose more.
    const failure = { stderr: 'EACCES' }
    const npm = installFailureDetails(failure, NPM)
    const brew = installFailureDetails(failure, {
      argv: ['brew', 'upgrade', 'ralph'],
      label: 'brew upgrade ralph',
    })
    expect(brew).toHaveLength(npm.length - 1)
    // From index 1: line 0 is the `<manager> wrote:` header, which names the
    // manager and so differs by design.
    expect(brew.slice(1, -1)).toEqual(npm.slice(1, -2))
    expect(brew.at(-1)).toContain('brew doctor')
    expect(npm.at(-1)).toContain('elevated privileges')
  })

  it('still offers sudo to every manager that is not brew', async () => {
    // The other side of the same change: `rootAborts` is one row's data, so it
    // must not have become the default for the table.
    for (const [manager] of knobs) {
      const argv = [manager, 'install', '-g', 'x']
      const lines = installFailureDetails({ stderr: 'EACCES' }, { argv, label: argv.join(' ') })
      expect(text(lines)).toContain(`sudo ${argv.join(' ')}`)
      expect(text(lines)).not.toContain('brew doctor')
    }
  })
})

describe('installFailureDetails — malformed input never throws and never prints garbage (#23 QA)', () => {
  const malformed = [
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a string instead of an object', 'EACCES: permission denied'],
    ['a number', 7],
    ['stderr: null', { stderr: null }],
    ['stderr: undefined with nothing else', { stderr: undefined, stdout: undefined, message: undefined }],
    ['stderr: an empty string', { stderr: '', stdout: '' }],
    ['stderr: whitespace only', { stderr: '  \n \t ' }],
    ['stderr: a number', { stderr: 123 }],
    ['stderr: an object', { stderr: {} }],
    ['stderr: an array', { stderr: ['a', 'b'] }],
    ['stderr: a Buffer', { stderr: Buffer.from('npm error code EACCES') }],
    ['a frozen object', Object.freeze({ stderr: 'npm error code EACCES' })],
    ['a null-prototype object', Object.assign(Object.create(null), { stderr: 'npm error code E404' })],
  ]

  for (const [label, failure] of malformed) {
    it(`returns printable lines for ${label}`, async () => {
      let lines
      expect(() => {
        lines = installFailureDetails(failure, NPM)
      }).not.toThrow()
      expect(Array.isArray(lines)).toBe(true)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(typeof line).toBe('string')
        expect(line.trim()).not.toBe('')
        expect(line).not.toContain('\n')
        expect(line).not.toContain('undefined')
        expect(line).not.toContain('[object Undefined]')
      }
    })
  }

  it('reads a Buffer stderr as text (execa returns one with encoding:null)', async () => {
    const lines = installFailureDetails(
      { stderr: Buffer.from('npm error code EACCES\nnpm error errno -13') },
      NPM,
    )
    expect(tailOf(lines)).toEqual(['npm error code EACCES', 'npm error errno -13'])
    expect(hinted(lines)).toBe(true)
  })

  it('reports a non-string stderr as the manager output it is (characterized)', async () => {
    // `String()` is the coercion, so a stub (or a manager) that hands back a
    // number reports `123` rather than crashing or claiming silence.
    expect(tailOf(installFailureDetails({ stderr: 123 }, NPM))).toEqual(['123'])
  })

  it('falls back to stdout only when stderr is empty, never both', async () => {
    const both = installFailureDetails({ stderr: 'from stderr', stdout: 'from stdout' }, NPM)
    expect(text(both)).toContain('from stderr')
    expect(text(both)).not.toContain('from stdout')

    const onlyOut = installFailureDetails({ stderr: '   \n', stdout: 'from stdout' }, NPM)
    expect(tailOf(onlyOut)).toEqual(['from stdout'])
  })

  it('never claims a manager printed nothing when it printed something', async () => {
    for (const failure of [{ stderr: '0' }, { stdout: '0' }, { stderr: 'false' }, { stdout: '.' }]) {
      // Falsy-looking but real output: `'0'` is output, and the no-output
      // wording would be a lie.
      expect(text(installFailureDetails(failure, NPM))).not.toContain('printed no output')
    }
  })
})

describe('installFailureDetails — a malformed target still names something runnable (#23 QA)', () => {
  it('falls back to a generic name with no target at all', async () => {
    const lines = installFailureDetails({ stderr: 'npm error code EACCES' })
    expect(lines[0]).toContain('the install command wrote:')
    expect(text(lines)).toContain('sudo the install command')
    for (const line of lines) expect(line).not.toContain('undefined')
  })

  const emptyTargets = [
    ['an empty argv', { argv: [] }],
    ['a null argv and null label', { argv: null, label: null }],
    ['an empty-string label', { argv: [], label: '' }],
  ]

  for (const [label, target] of emptyTargets) {
    it(`never prints "undefined" for ${label}`, async () => {
      const lines = installFailureDetails({ stderr: 'boom' }, target)
      expect(text(lines)).toContain('the install command')
      for (const line of lines) expect(line).not.toContain('undefined')
    })
  }

  it('derives the command from argv when the target carries no label', async () => {
    // update.js reads both fields off one classification; a classification that
    // set argv but no label must still name the command that actually ran.
    const argv = ['pnpm', 'add', '-g', '@lucasfe/ralph@latest']
    const lines = installFailureDetails({ stderr: 'EACCES' }, { argv })
    expect(text(lines)).toContain(`sudo ${argv.join(' ')}`)
    expect(text(lines)).toContain('pnpm setup')
    expect(text(lines)).not.toContain('undefined')
  })

  it('prefers the label over argv when the two disagree (characterized)', async () => {
    // Garbage in: the knob follows argv[0] while the re-run line follows the
    // label, so a caller that lets them drift names two different commands.
    // classifyInstall derives label from argv, so they cannot drift in practice.
    const lines = installFailureDetails(
      { stderr: 'EACCES' },
      { argv: ['pnpm', 'add', '-g', 'x'], label: 'npm install -g x' },
    )
    expect(text(lines)).toContain('pnpm setup')
    expect(text(lines)).toContain('sudo npm install -g x')
  })

  it('names the command to run by hand when there is no output to show', async () => {
    const lines = installFailureDetails({ stderr: '', stdout: '' }, NPM)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`Run \`${NPM.label}\` yourself`)
  })
})
