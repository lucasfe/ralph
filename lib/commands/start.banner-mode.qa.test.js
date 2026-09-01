// #74 QA — RALPH_BANNER as a change to a command that reads a file, writes two streams and
// has twelve ways out.
//
// start.banner-mode.test.js proves the four headline claims on the happy path: one read, the
// environment wins, three modes, a typo costs a line. lib/banner-mode.qa.test.js attacks the
// POLICY as a pure table. This file is the third leg, and it exists for the questions neither
// of the other two can reach — the ones that are about a RUN rather than about a value:
//
//   1. THE GRAMMAR × THIS KNOB. `RALPH_BANNER` is not read; a LINE of bash-looking text is
//      read, and lib/parse-config-var.js is what turns one into the other. That parser has
//      documented divergences from real bash, and #74 is the first knob whose value a user is
//      likely to comment, blank, re-assign or quote by hand — the template ships it LIVE, on
//      `full`, which is an invitation to edit. So every shape that file can hold is driven
//      through the real command and pinned to an effective mode, including the four shapes
//      where the answer is deliberately not bash's.
//   2. `off` MEANS THE RUN THIS COMMAND MADE BEFORE THE BANNER EXISTED, BYTE FOR BYTE. The
//      dev's spec asserts that by SUBTRACTING one run from another, which proves the two
//      agree with each other; this file additionally pins it against the pre-#67 LITERAL that
//      lib/commands/start.banner.qa.test.js captured off a pre-banner checkout, on a launch
//      and on an abort, piped and on a TTY. Not one blank line, not one lone reset, not one
//      DECTCEM toggle — and the assertion is on the concatenated stream rather than on a line
//      count, because a line count cannot see a trailing newline.
//   3. `off` MUST NOT COST THE RUN, AND MUST NOT SKIP IT. The cheapest mode is also the one
//      that skips the most code, so what it skips is asserted from both sides: the version
//      cache and the changelog are not read AT ALL (they are resolved inside the `if
//      (banner.box)`), and every line about the run itself — preflight, launch box, digest
//      hint, abort — is still printed, with the same exec calls in the same order.
//   4. THE MOVED READ. #74 lifted `readConfigText` to the top of `startCommand`, above the
//      tmux uniqueness guard. That is the one ordering change in the diff, so it is asserted
//      as: exactly one read per run whatever the mode, a throwing `exists` or `readFile`
//      cannot abort a launch, the four consumers of that one text still get consistent
//      answers, and nothing else moved.
//
// ...plus the two seams a wiring spec is the only place to test: the WARNING's containment
// (one line, on stderr, and stdout stays clean even for a value carrying escapes and
// newlines — a `ralph start | tee` is the run this protects), and the SHIPPED TEMPLATE, which
// is checked by parsing it back through the same grammar and by writing it with the real
// `ralph init` into a memfs volume.
//
// Every capability is injected (#41): the config text, the environment bag, `stdoutIsTTY`,
// `columns`, the sleep, the signal source, the cache and changelog readers, the clock and the
// binary path. Nothing here reads the developer's environment, their `~/.config/ralph` or the
// real `process` — in particular the signal source is ALWAYS injected, because the honest
// default would register a SIGINT listener on the vitest worker on every TTY run below.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { Volume } from 'memfs'
import { StartAbort, startCommand } from './start.js'
import { initCommand } from './init.js'
import { BANNER_MODES, DEFAULT_BANNER_MODE, resolveBannerMode } from '../banner-mode.js'
import { parseConfigVar } from '../parse-config-var.js'
import { templatePath } from '../paths.js'
import { renderSplashFrames, renderStaticBanner } from '../sprite-banner.js'
import { playSplash } from '../sprite-player.js'
import { composeBanner } from '../banner-compose.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'
import { sessionNameFor } from '../lock.js'

const ESC = '\u001B'
// DECTCEM, and the cursor-up the redraw rides on: the two escape families that mean
// "something animated here". Their absence is how `static` is told from `full` by bytes
// rather than by a frame count.
const CURSOR_TOGGLE = `${ESC}[?25`
const CURSOR_UP = /\u001B\[\d+A/

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const SESSION = sessionNameFor(REPO)

// The seventeen rows, and the two byte streams the sprite can arrive as, PRODUCED BY THE
// PLAYER rather than restated — same derivation the dev's spec uses, for the same reason: what
// bytes five frames or one frame are made of is lib/sprite-player.test.js's business, and a
// second copy here would be a second opinion about it.
const BANNER = renderStaticBanner({ isTTY: true, color: true })
const SPLASH_BLOCK = await sprite()
const STATIC_BLOCK = await sprite(1)

async function sprite(cycles, width) {
  const chunks = []
  await playSplash({
    frames: renderSplashFrames({ isTTY: true, color: true, width }),
    cycles,
    stream: { write: (chunk) => chunks.push(chunk) },
    sleep: async () => {},
    // No signal source at all: this is a module-level await in a vitest worker.
    signals: null,
  })
  return chunks.join('')
}

// The identity box, COMPOSED rather than spelled out — for the same reason the sprite above it
// is: which bytes the box is made of is start.banner.qa.test.js's business, and this file's
// subject is which banner MODE a config selects.
//
// #69's facts are handed in because `ralph start` hands them in, and a box composed without
// them is a box no run of this command prints. Every one of them is the same on every run
// below: this bag's `readFile` answers '' for every path but the config, so there is no metrics
// log for a model to have come from (the row says the model resolves at first run) and no
// `.git/config` for a slug (no repo row at all). The SOURCE is the one that varies, because a
// few runs below write `TASK_SOURCE=github` or lose the config entirely, and it is the row that
// then differs — hence a parameter rather than a constant.
const boxLines = (source = 'folder') =>
  composeBanner({
    facts: {
      version: VERSION,
      latestVersion: null,
      cwd: REPO,
      agent: 'claude',
      model: null,
      provenance: 'unknown',
      contextWindow: null,
      source,
      repo: null,
      whatsNew: [],
    },
    capabilities: { color: false },
  })
const boxBlock = (source) => `${boxLines(source).join('\n')}\n`
const BOX = boxLines()
const BOX_BLOCK = boxBlock()

// What each mode looks like as a PREFIX of stdout, and what it costs in wall clock. Three
// modes, three prefixes, three nap patterns — the whole observable difference between them.
const prefixOf = (mode, source) =>
  ({
    full: `${SPLASH_BLOCK}${boxBlock(source)}`,
    static: `${STATIC_BLOCK}${boxBlock(source)}`,
    off: '',
  })[mode]
const PREFIX = {
  full: prefixOf('full'),
  static: prefixOf('static'),
  off: '',
}
const NAPS = { full: [200, 200, 200, 200, 200], static: [200], off: [] }

// The launch bytes `ralph start` printed before #67 existed, SPELLED OUT — captured in
// lib/commands/start.banner.qa.test.js by running an equivalent bag against a pre-banner
// checkout, and reproduced here because that literal is the only thing in this repo that
// knows what "unchanged" means. `RALPH_BANNER=off` has to reproduce it exactly.
const PRE_BANNER_LAUNCH =
  'ℹ️  CALLMEBOT_KEY/WHATSAPP_PHONE missing; WhatsApp notifications will be skipped.\n' +
  '✅ Ralph started in background. 3 issues in the queue.\n' +
  '   Progress:       ralph status\n' +
  `   Watch live:     tmux attach -t ${SESSION}\n` +
  '   Detach:         inside the session, Ctrl+B then D\n' +
  '   List:           tmux ls\n' +
  `   Kill:           tmux kill-session -t ${SESSION}\n` +
  '   Logs:           logs/ralph-issue-*.log\n'

const PRE_BANNER_ABORT_OUT =
  `   Watch:  tmux attach -t ${SESSION}\n` + `   Kill:   tmux kill-session -t ${SESSION}\n`
const PRE_BANNER_ABORT_ERR = `❌ tmux session '${SESSION}' already exists.\n`

function makeStream(events, { isTTY, kind = 'write' } = {}) {
  const chunks = []
  const stream = {
    write: (s) => {
      chunks.push(s)
      events?.push({ kind, detail: s })
      return true
    },
    chunks,
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
  if (isTTY !== undefined) stream.isTTY = isTTY
  return stream
}

// A ralph.config.sh with the task source pinned in every fixture, so a subtraction between two
// runs is a statement about the banner rather than about which queue was counted.
const cfg = (...lines) => ['TASK_SOURCE=folder', ...lines, ''].join('\n')

// A signal source that records rather than listens. Every run below that animates gets one of
// these instead of the real `process`, and the balance of `on` against `off` is one of this
// file's claims: `ralph start` runs for HOURS after its banner, and a SIGINT listener that
// outlived the animation would suppress Node's own disposition for all of them.
function recordingSignals() {
  const calls = []
  return {
    calls,
    on: (signal, handler) => calls.push({ method: 'on', signal, handler }),
    off: (signal, handler) => calls.push({ method: 'off', signal, handler }),
  }
}

// A cache/changelog fs that records rather than acts — every method the readers can reach, so
// a missing one would fail as a TypeError and look like a guard working.
function recordingFs(ops) {
  return {
    readFileSync: (path) => {
      ops.push(`readFileSync ${path}`)
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    },
    writeFileSync: (path) => ops.push(`writeFileSync ${path}`),
    mkdirSync: (path) => ops.push(`mkdirSync ${path}`),
    existsSync: (path) => {
      ops.push(`existsSync ${path}`)
      return false
    },
  }
}

// One bag, driven through the folder source so the queue depth is a dependency rather than a
// `gh` stub. `now` and `ralphBinary` are pinned so two runs of a pair cannot differ on a clock
// or on how the process was spawned rather than on the banner.
function deps({
  isTTY,
  queue = 3,
  sessionExists = false,
  config = cfg(),
  files = ['ralph.config.sh'],
  ...overrides
} = {}) {
  const events = []
  const stdout = makeStream(events, { isTTY })
  const stderr = makeStream(events, { kind: 'stderr' })
  const naps = []
  const reads = []
  const stats = []
  const keys = []
  const cacheReads = []
  const changelogReads = []
  const exec = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    keys.push(key)
    events.push({ kind: 'exec', detail: key })
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec,
    events,
    naps,
    reads,
    stats,
    keys,
    cacheReads,
    changelogReads,
    /** Every read and stat of ralph.config.sh, which is the count criterion 4 is about. */
    configReads: () => reads.filter((path) => path.endsWith('ralph.config.sh')),
    configStats: () => stats.filter((path) => path.endsWith('ralph.config.sh')),
    exists: (p) => {
      stats.push(String(p))
      events.push({ kind: 'exists', detail: String(p) })
      return files.some((f) => String(p).endsWith(f))
    },
    readFile: (p) => {
      reads.push(String(p))
      events.push({ kind: 'readFile', detail: String(p) })
      return String(p).endsWith('ralph.config.sh') ? config : ''
    },
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    currentVersion: VERSION,
    update: async () => ({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'disabled',
      updatedCache: null,
    }),
    recordPrompt: () => {},
    readCache: () => {
      cacheReads.push('readCache')
      return { ...EMPTY_VERSION_CACHE }
    },
    readChangelog: () => {
      changelogReads.push('readChangelog')
      return []
    },
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => queue,
    now: () => 1_700_000_000_000,
    home: HOME,
    processEnv: {},
    ralphBinary: '/usr/local/bin/ralph',
    sleep: async (ms) => {
      naps.push(ms)
    },
    signals: null,
    ...overrides,
  }
}

/** Run the command and describe how it left, in a shape two runs can be compared on. */
async function outcomeOf(d) {
  try {
    return { returned: await startCommand(d) }
  } catch (error) {
    return { abort: error instanceof StartAbort, message: error.message, exitCode: error.exitCode }
  }
}

/**
 * Assert a run produced exactly the mode named, by BYTES and by wall clock.
 *
 * The prefix is what distinguishes the three: `full` opens with a cursor hide, `static` with
 * the settled frame itself, and `off` with the first preflight line. For `off` the claim is
 * stronger than a prefix — no glyph of either half of the banner, and not one escape byte —
 * because "nothing at all" is the whole of what that word means.
 *
 * `source` is the box's own #69 row, and it is a parameter for the runs whose config asks for
 * github or has no readable config at all. It has nothing to do with the mode; it is here
 * because the prefix contains the whole box and the box now names the source.
 */
function expectMode(d, mode, where, source) {
  const output = d.stdout.output()
  expect(output.startsWith(prefixOf(mode, source)), `${where}: prefix`).toBe(true)
  expect(d.naps, `${where}: naps`).toEqual(NAPS[mode])
  if (mode === 'off') {
    expect(output, `${where}: glyphs`).not.toMatch(/[▀▄╭╮╰╯│]/)
    expect(output, `${where}: escapes`).not.toContain(ESC)
  } else {
    expect(output, `${where}: box`).toContain(REPO)
  }
  if (mode === 'static') {
    expect(output, `${where}: cursor toggle`).not.toContain(CURSOR_TOGGLE)
    expect(output, `${where}: cursor up`).not.toMatch(CURSOR_UP)
  }
}

// ---------------------------------------------------------------------------
// 1. The config grammar × this knob.
// ---------------------------------------------------------------------------

// Each row: what a user typed into ralph.config.sh, the mode it must produce, and whether it
// costs a line of stderr. Written as literals a human agreed with rather than derived from the
// parser, because half the point of the table is the rows where the parser and bash differ.
const GRAMMAR = [
  // The five shapes the shared grammar documents as supported.
  ['a bare assignment', 'RALPH_BANNER=off', 'off', false],
  ['double quotes', 'RALPH_BANNER="off"', 'off', false],
  ['single quotes', "RALPH_BANNER='static'", 'static', false],
  ['an export prefix', 'export RALPH_BANNER=off', 'off', false],
  ['an export prefix with quotes', 'export RALPH_BANNER="static"', 'static', false],
  ['a leading indent', '    RALPH_BANNER=off', 'off', false],
  ['a tab indent', '\tRALPH_BANNER=static', 'static', false],
  ['trailing whitespace', 'RALPH_BANNER=off   ', 'off', false],
  // AS STRICT AS BASH SINCE #147, and pinned so it stays that way: `VAR = value` is a
  // command invocation to a shell, not an assignment. This parser used to accept it, which
  // meant a user who typed a space got the banner they asked for from `ralph start` and the
  // loop that SOURCES the same file got nothing — the JS half honouring a line the shell ran
  // as a command. Now neither honours it, so the knob falls to its default and the two halves
  // of one run agree about the file. What a user loses is the typo; what they gain is that
  // every knob in the file means one thing. The transcript is in lib/parse-config-var.js.
  ['spaces around the equals', 'RALPH_BANNER = off', 'full', false],
  // Comments, in the four shapes a hand-edited file grows them in.
  ['an inline comment', 'RALPH_BANNER=off # quiet in cron', 'off', false],
  ['an inline comment on a quoted value', 'RALPH_BANNER="off" # quiet', 'off', false],
  ['a commented-out assignment', '# RALPH_BANNER=off', 'full', false],
  ['a commented-out assignment, tight', '#RALPH_BANNER=off', 'full', false],
  ['a commented-out assignment, indented', '   #   RALPH_BANNER=off', 'full', false],
  // A `#` GLUED TO THE CLOSING QUOTE is a comment here and data to bash (`off#quiet`). The
  // divergence is harmless for this knob for exactly the reason parse-config-var.js gives:
  // bash's reading is not a legal value, so it was going to be rejected anyway — but the
  // JS half resolves `off` while the bash loop would export `off#quiet`, and only one of
  // them is the banner.
  ['a hash glued to the closing quote', 'RALPH_BANNER="off"#quiet', 'off', false],
  // ...and its mirror, where the parser AGREES with bash: an unquoted `#` that does not begin
  // a word is part of the value, so this is a typo and earns a warning. The two rows together
  // are what make the divergence above readable as a rule rather than as an accident.
  ['a hash glued to an unquoted value', 'RALPH_BANNER=off#quiet', 'full', true],
  // A LEADING `#` inside the value is a comment here and data to bash (`#off`). Bash would
  // export `#off`, which this resolver would warn about; the parser reads the value as absent,
  // so the run is a silent default. The louder answer would arguably be better, and it is the
  // shared grammar's call rather than #74's.
  ['a hash as the whole value', 'RALPH_BANNER=#off', 'full', false],
  // Quotes the user doubled up, and quotes with nothing in them.
  ['an empty assignment', 'RALPH_BANNER=', 'full', false],
  ['empty double quotes', 'RALPH_BANNER=""', 'full', false],
  ['quoted whitespace', 'RALPH_BANNER="   "', 'full', false],
  ['quotes inside quotes', `RALPH_BANNER="'off'"`, 'full', true],
  ['an unterminated double quote', 'RALPH_BANNER="off', 'full', true],
  ['an unterminated single quote', "RALPH_BANNER='off", 'full', true],
  // A trailing `;`, which is how a user who thinks in shell scripts ends a line. Bash assigns
  // `off`; this parser keeps the semicolon and the resolver calls it a typo. A divergence
  // worth a row of its own, because the warning is the only thing that tells the user.
  ['a trailing semicolon', 'RALPH_BANNER=off;', 'full', true],
  // Name matching, which is where a text parser gets it wrong by being too eager.
  ['a variable whose name ENDS with the target', 'MY_RALPH_BANNER=off', 'full', false],
  ['a variable whose name STARTS with the target', 'RALPH_BANNER_MODE=off', 'full', false],
  ['a variable whose name merely extends it', 'RALPH_BANNERX=off', 'full', false],
  // A byte-order mark, which is what an editor can leave on the first line of a file. REFUSED
  // SINCE #147's follow-up, and this row is where that change is visible at a command: the
  // shared grammar's indent class used to be `\s`, which in JS holds U+FEFF, so this line read
  // as an assignment here while the shell sourcing the same file ran it as a COMMAND (`c.sh:
  // line 1: $'\357\273\277RALPH_BANNER=off': command not found`). The class is `[ \t]` now —
  // bash's own blanks — so the line is not an assignment in either half and the knob falls to
  // its default.
  //
  // Unlike the TASK_SOURCE case that argument was made for, RALPH_BANNER has NO bash reader:
  // templates/ralph.sh never mentions it, so this is not two readers agreeing, it is the only
  // reader changing its mind. A user whose editor left a BOM on this exact line used to get the
  // quiet banner they asked for and now gets the full one, silently — an empty knob is the
  // documented default and warns about nothing. Pinned rather than hidden, because that is the
  // price of one grammar and this table is where this knob pays it.
  ['a BOM on the assignment line', '\uFEFFRALPH_BANNER=off', 'full', false],
  // Duplicates. Bash takes the last one, so a file with two live assignments is a file whose
  // second line silently wins — which is why the template ships exactly one.
  ['two live assignments', 'RALPH_BANNER=off\nRALPH_BANNER=static', 'static', false],
  ['a later commented reassignment', 'RALPH_BANNER=off\n# RALPH_BANNER=static', 'off', false],
  ['an earlier commented assignment', '# RALPH_BANNER=off\nRALPH_BANNER=static', 'static', false],
  ['a later export reassignment', 'RALPH_BANNER=off\nexport RALPH_BANNER=static', 'static', false],
  // BASH SINCE #147, and it was the row most likely to bite a real user: blanking the knob
  // further down the file used NOT to clear an earlier value, because the parser's value group
  // required a character and an empty tail offered none, so the line matched nothing and was
  // not "the last assignment" at all. A file ending in `RALPH_BANNER=` resolved to the earlier
  // `off`. Bash exports the empty string for that line, and this resolver reads an empty value
  // as no opinion, so both now land on `full`.
  ['a blanking reassignment', 'RALPH_BANNER=off\nRALPH_BANNER=', 'full', false],
  // A line-based parser reads an assignment inside a multi-line VALUE as an assignment. Bash
  // reads it as part of NOTE. Documented in parse-config-var.js as a shape it has never
  // modelled, pinned here because ralph.config.sh is a file users paste things into.
  ['an assignment inside a multi-line value', 'NOTE="\nRALPH_BANNER=off\n"', 'off', false],
  // Files that are not config files at all: JSON, YAML and a stray heredoc. None of them may
  // throw, and none of them may resolve to anything but the default.
  ['a JSON file', '{ "RALPH_BANNER": "off" }', 'full', false],
  ['a YAML file', 'ralph_banner: off\nbanner: off', 'full', false],
  ['prose', 'Set RALPH_BANNER to off if you want quiet.', 'full', false],
]

describe('QA startCommand — the config grammar, one row per shape a user can type (#74)', () => {
  for (const [name, line, expected, warned] of GRAMMAR) {
    it(`reads ${name} as ${expected}${warned ? ' with a warning' : ''}`, async () => {
      const d = deps({ isTTY: true, config: cfg(line) })
      expect(await outcomeOf(d)).toEqual({ returned: { exitCode: 0, started: true, count: 3 } })
      expectMode(d, expected, name)
      // The warning column, asserted as a WHOLE stderr rather than as a substring: a valid
      // value must cost NOTHING, and a typo must cost exactly one line.
      const warnings = d.stderr.output().split('\n').filter((l) => l.includes('RALPH_BANNER'))
      expect(warnings, name).toHaveLength(warned ? 1 : 0)
      if (!warned) expect(d.stderr.output(), name).toBe('')
    })
  }

  it('reads every row through the same one read, and never runs a shell to do it', async () => {
    // Criterion 4, over the whole table rather than on one row: the parse is over TEXT, so no
    // row of the grammar above may cost a second read or a subshell — including the rows that
    // look like shell syntax (`NOTE="`, a trailing `;`, a heredoc-ish blob).
    for (const [name, line] of GRAMMAR) {
      const d = deps({ isTTY: true, config: cfg(line) })
      await startCommand(d)
      expect(d.configReads(), name).toEqual([`${REPO}/ralph.config.sh`])
      expect(d.configStats(), name).toEqual([`${REPO}/ralph.config.sh`])
      for (const key of d.keys) {
        expect(key.startsWith('bash ') || key.startsWith('sh ') || key.startsWith('zsh '), `${name}: ${key}`).toBe(false)
      }
    }
  })

  it('survives a config that is missing, empty, unreadable or not a string at all', async () => {
    // `readConfigText` is total, and the banner must be the last thing to notice. Five shapes
    // of "no usable file", each of which has to be a `full` banner and a launched run rather
    // than a crash — and the two THROWING seams are separate cases on purpose: `exists` throws
    // before the read and `readFile` throws during it, and only one of them was in the diff.
    const cases = [
      ['no file at all', { files: [] }],
      ['an empty file', { config: '' }],
      ['a file of one newline', { config: '\n' }],
      [
        'a readFile that throws',
        {
          readFile: () => {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
          },
        },
      ],
      [
        'an exists that throws for the config',
        {
          exists: (p) => {
            if (String(p).endsWith('ralph.config.sh')) throw new Error('EIO')
            return false
          },
        },
      ],
      ['a readFile that returns a Buffer', { readFile: () => Buffer.from(cfg('RALPH_BANNER=off')) }],
      ['a readFile that returns undefined', { readFile: () => undefined }],
      ['a readFile that returns a number', { readFile: () => 42 }],
    ]
    for (const [name, overrides] of cases) {
      // The task source moves to the environment for these rows on purpose: half of them are
      // configs that cannot be read AT ALL, and `TASK_SOURCE` lives in the same text. Pinning
      // it in the bag keeps every row on the folder path, so the assertions below are about the
      // banner rather than about which queue got counted.
      const d = deps({ isTTY: true, processEnv: { TASK_SOURCE: 'folder' }, ...overrides })
      expect(await outcomeOf(d), name).toEqual({
        returned: { exitCode: 0, started: true, count: 3 },
      })
      // The Buffer case is the one that resolves to something: it holds a real `off`. Every
      // other shape is the default, silently.
      expectMode(d, name === 'a readFile that returns a Buffer' ? 'off' : 'full', name)
      expect(d.stderr.output(), name).toBe('')
    }
  })

  it('answers all four of its questions out of ONE text, even when the file changes underneath', async () => {
    // The claim behind the read count, asserted as BEHAVIOUR rather than as a number. A
    // `readFile` that answers differently on every call is a config being rewritten
    // mid-preflight — and the run must look like exactly one read of it: the banner and the
    // task source must both come from the FIRST answer, never one from each.
    let call = 0
    const d = deps({
      isTTY: true,
      readFile: (p) => {
        if (!String(p).endsWith('ralph.config.sh')) return ''
        call += 1
        return call === 1
          ? 'TASK_SOURCE=folder\nRALPH_BANNER=off\n'
          : 'TASK_SOURCE=github\nRALPH_BANNER=full\n'
      },
    })
    expect(await outcomeOf(d)).toEqual({ returned: { exitCode: 0, started: true, count: 3 } })
    expect(call).toBe(1)
    // The banner came from the first text...
    expectMode(d, 'off', 'a config rewritten mid-run')
    // ...and so did the task source: a `github` run would have called `gh auth status`.
    expect(d.keys.filter((key) => key.startsWith('gh '))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. `off`, byte for byte.
// ---------------------------------------------------------------------------

describe('QA startCommand — RALPH_BANNER=off reproduces the pre-banner bytes (#74)', () => {
  it('prints the pre-#67 launch output exactly, on a pipe and on a TTY', async () => {
    // THE STRONGEST FORM OF CRITERION 3, and the reason the literal is spelled out rather
        // than subtracted: subtracting an `off` run from a default run proves the two agree with
    // each other, and a bug that added a blank line to BOTH would survive it. This compares
    // against bytes captured off a checkout that had never heard of a banner.
    for (const isTTY of [undefined, true]) {
      const d = deps({ isTTY, config: cfg('RALPH_BANNER=off') })
      expect(await outcomeOf(d), String(isTTY)).toEqual({
        returned: { exitCode: 0, started: true, count: 3 },
      })
      expect(d.stdout.output(), String(isTTY)).toBe(PRE_BANNER_LAUNCH)
      expect(d.stderr.output(), String(isTTY)).toBe('')
      // ...and the two things a "nothing" that is nearly nothing would leave behind: a lone
      // leading newline from an `out('')`, and a cursor restore with no hide to match it.
      expect(d.stdout.output(), String(isTTY)).not.toMatch(/^\n/)
      expect(d.stdout.output(), String(isTTY)).not.toContain(CURSOR_TOGGLE)
      expect(d.naps, String(isTTY)).toEqual([])
    }
  })

  it('prints the pre-#67 tmux abort exactly, on both streams', async () => {
    // The aborting run, where the banner is normally the only thing above the error — so `off`
    // is the mode where a stray byte would be most visible and least excusable.
    const d = deps({ isTTY: true, sessionExists: true, config: cfg('RALPH_BANNER=off') })
    expect(await outcomeOf(d)).toEqual({
      abort: true,
      message: 'tmux session already exists',
      exitCode: 1,
    })
    expect(d.stdout.output()).toBe(PRE_BANNER_ABORT_OUT)
    expect(d.stderr.output()).toBe(PRE_BANNER_ABORT_ERR)
  })

  it('leaves the empty-queue early return exactly as it found it', async () => {
    // The other early exit, and the shortest run this command has: nothing but one line, and
    // `off` must not put a blank one above or below it.
    const off = deps({ isTTY: true, queue: 0, config: cfg('RALPH_BANNER=off') })
    const on = deps({ isTTY: true, queue: 0 })
    expect(await outcomeOf(off)).toEqual(await outcomeOf(on))
    expect(off.stdout.output()).toBe(
      on.stdout.output().replace(SPLASH_BLOCK, '').replace(BOX_BLOCK, ''),
    )
    expect(off.stdout.output()).not.toMatch(/^\n/)
    expect(off.stdout.output()).not.toContain(ESC)
  })

  it('is the same run in every other respect: same exec calls, in the same order', async () => {
    // `off` is a request about DECORATION. What the command DOES to the machine — the tmux
    // guard, the launch, the digest window — must be identical to a `full` run, call for call
    // and in order, because the alternative is a banner setting that changes a launch.
    const off = deps({ isTTY: true, config: cfg('RALPH_BANNER=off', 'RALPH_DIGEST_INTERVAL=30m') })
    const full = deps({ isTTY: true, config: cfg('RALPH_BANNER=full', 'RALPH_DIGEST_INTERVAL=30m') })
    expect(await outcomeOf(off)).toEqual(await outcomeOf(full))
    expect(off.keys).toEqual(full.keys)
    expect(off.keys.some((key) => key.startsWith('tmux new-window'))).toBe(true)
    // ...including the launch box's digest line, which is the one line of the run that a
    // config knob two lines above RALPH_BANNER puts there.
    expect(off.stdout.output()).toContain('   Digest:         every 30m — runs alongside the loop')
    expect(off.stdout.output()).toBe(full.stdout.output().replace(PREFIX.full, ''))
  })

  it('costs the run no cache read, no changelog read and no fs operation', async () => {
    // What `off` SKIPS, measured. The version cache and the changelog are resolved INSIDE the
    // `if (banner.box)`, so an explicit `off` is the one mode that pays for neither — which
    // makes it the mode a cron entry or a `--quiet` wrapper should reach for. Asserted through
    // recording readers AND recording filesystems, because a future refactor that hoisted the
    // facts out of the branch would still print nothing and would silently start reading two
    // files again.
    const cacheOps = []
    const changelogOps = []
    const d = deps({
      isTTY: true,
      config: cfg('RALPH_BANNER=off'),
      cacheFs: recordingFs(cacheOps),
      changelogFs: recordingFs(changelogOps),
    })
    await startCommand(d)
    expect(d.cacheReads).toEqual([])
    expect(d.changelogReads).toEqual([])
    // The update GATE at step 2.5 has its own cache reads and is not the banner's business —
    // this bag disables it (`source: 'disabled'`), so any operation here would be the box's.
    expect(cacheOps).toEqual([])
    expect(changelogOps).toEqual([])
    // ...and the run still launched, which is what makes the two empty lists a saving rather
    // than a symptom.
    expect(d.stdout.output()).toContain('✅ Ralph started in background. 3 issues in the queue.')
  })

  it('cannot be broken by a reader that would have thrown, because it never calls one', async () => {
    // The corollary, and a real property rather than a tautology: with the box off, a version
    // cache or a changelog reader that throws is unreachable. A `full` run survives both too
    // (they are guarded), but only `off` never asks.
    const d = deps({
      isTTY: true,
      config: cfg('RALPH_BANNER=off'),
      readCache: () => {
        throw new Error('cache exploded')
      },
      readChangelog: () => {
        throw new Error('changelog exploded')
      },
    })
    expect(await outcomeOf(d)).toEqual({ returned: { exitCode: 0, started: true, count: 3 } })
    expect(d.stdout.output()).toBe(PRE_BANNER_LAUNCH)
  })

  it('silences the banner on every width and colour combination, without silencing the run', async () => {
    // `off` is the one answer no capability can change, in either direction: it is already the
    // bottom of the ladder. Swept over the widths and colour states the other modes degrade
    // through, because a mode resolved from a value must not become width-dependent.
    for (const columns of [undefined, 0, 1, 25, 26, 43, 44, 60, 200]) {
      for (const processEnv of [{}, { NO_COLOR: '1' }]) {
        const where = `${String(columns)} / ${JSON.stringify(processEnv)}`
        const d = deps({ isTTY: true, columns, processEnv, config: cfg('RALPH_BANNER=off') })
        await startCommand(d)
        expect(d.stdout.output(), where).toBe(PRE_BANNER_LAUNCH)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 3. `static`, and what it must NOT write.
// ---------------------------------------------------------------------------

describe('QA startCommand — RALPH_BANNER=static writes #67’s banner and nothing else (#74)', () => {
  it('writes exactly the bytes renderStaticBanner produces, at every width that holds a sprite', async () => {
    // The claim that makes `static` "a choice about plumbing rather than about pixels": one
    // write, and it is the same block the pre-#73 command wrote through a different code path.
    // Asserted at four widths because the sprite is width-gated and the block is not — a
    // `cycles: 1` that had picked up a cursor move would show up here as a prefix on chunk 0.
    //
    // #161 MOVED THE WIDEST OF THE FOUR from 200 to 71, one column under its rung: from 72 up
    // the still frame carries the identity box in its right-hand margin, so it is no longer
    // `renderStaticBanner`'s block alone. That is the arrangement working as designed — `static`
    // is a choice about plumbing, and the box goes where the ladder says at every mode — and the
    // bytes of it are asserted in start.banner-beside.test.js. What this case is about is
    // unchanged: one write, no cursor byte, one beat.
    for (const columns of [26, 43, 60, 71]) {
      const d = deps({ isTTY: true, columns, config: cfg('RALPH_BANNER=static') })
      await startCommand(d)
      const expected = renderStaticBanner({ isTTY: true, color: true, width: columns })
      expect(expected.length, String(columns)).toBe(17)
      expect(d.stdout.chunks[0], String(columns)).toBe(`${expected.join('\n')}\n`)
      expect(d.stdout.chunks[0], String(columns)).not.toContain(CURSOR_TOGGLE)
      expect(d.stdout.chunks[0], String(columns)).not.toMatch(CURSOR_UP)
      // One frame, one beat — a fifth of what `full` costs, and the same 200ms the splash
      // holds its final frame for before the box lands under it.
      expect(d.naps, String(columns)).toEqual([200])
    }
  })

  it('writes the frame as ONE chunk, with the box’s lines after it and nothing between', async () => {
    // A torn frame is the failure a per-row write produces, and the box's top rule glued to
    // the frame's last row is the failure a missing newline produces. Both are visible only in
    // the chunk list.
    const d = deps({ isTTY: true, config: cfg('RALPH_BANNER=static') })
    await startCommand(d)
    expect(d.stdout.chunks[0]).toBe(STATIC_BLOCK)
    expect(d.stdout.chunks[0].split('\n')).toHaveLength(BANNER.length + 1)
    expect(d.stdout.chunks.slice(1, 1 + BOX.length)).toEqual(BOX.map((line) => `${line}\n`))
  })

  it('arms no SIGINT listener at all, in any mode except the one that animates', async () => {
    // THE LISTENER BALANCE, per mode. `ralph start` runs for HOURS after its banner, so a
    // handler that outlived the animation would suppress Node's own SIGINT disposition for all
    // of them — and `static` and `off` have nothing to clean up, so they must arm nothing.
    // `full` arms exactly one and removes exactly the same one: same signal, same function
    // identity, which is what makes `off` a real removal rather than a call that looks like it.
    const expected = { full: 2, static: 0, off: 0 }
    for (const mode of BANNER_MODES) {
      const signals = recordingSignals()
      const d = deps({ isTTY: true, signals, config: cfg(`RALPH_BANNER=${mode}`) })
      await startCommand(d)
      expect(signals.calls.map((call) => call.method), mode).toHaveLength(expected[mode])
      if (expected[mode] === 0) continue
      expect(signals.calls.map((call) => call.method), mode).toEqual(['on', 'off'])
      expect(new Set(signals.calls.map((call) => call.signal)), mode).toEqual(new Set(['SIGINT']))
      expect(signals.calls[0].handler, mode).toBe(signals.calls[1].handler)
    }
  })

  it('arms nothing when the terminal capped the mode down, either', async () => {
    // The capped runs, which are where a listener leak would be hardest to notice: there is no
    // animation on a pipe, so there is nothing whose end would take the handler off again.
    for (const overrides of [{}, { isTTY: true, processEnv: { NO_COLOR: '1' } }, { isTTY: true, columns: 20 }]) {
      for (const mode of BANNER_MODES) {
        const signals = recordingSignals()
        const d = deps({ ...overrides, signals, config: cfg(`RALPH_BANNER=${mode}`) })
        await startCommand(d)
        expect(signals.calls, `${mode} / ${JSON.stringify(overrides)}`).toEqual([])
      }
    }
  })

  it('is the full run with four frames and the cursor control removed, and nothing else', async () => {
    // The subtraction for this mode, taken to an ABORT as well as a launch: what `static`
    // removes is animation, not context, so a failed start still gets its frame and its box
    // above the error.
    const still = deps({ isTTY: true, sessionExists: true, config: cfg('RALPH_BANNER=static') })
    const full = deps({ isTTY: true, sessionExists: true })
    expect(await outcomeOf(still)).toEqual(await outcomeOf(full))
    expect(still.stdout.output().replace(STATIC_BLOCK, '')).toBe(
      full.stdout.output().replace(SPLASH_BLOCK, ''),
    )
    expect(still.stdout.output().startsWith(`${STATIC_BLOCK}${BOX_BLOCK}`)).toBe(true)
    expect(still.stderr.output()).toBe(PRE_BANNER_ABORT_ERR)
  })
})

// ---------------------------------------------------------------------------
// 4. Precedence, and the other readers of the same file.
// ---------------------------------------------------------------------------

describe('QA startCommand — precedence, and the knob next door that runs the other way (#74)', () => {
  it('resolves RALPH_BANNER env-first and TASK_SOURCE config-first in the SAME run', async () => {
    // THE CROSSED TEST, and the reason it is worth one: two knobs, one text, opposite
    // precedence, three lines apart in start.js. A refactor that unified them would break
    // exactly one of the two and no single-knob test would see it. So both are contradicted at
    // once — the config says `full` and `folder`, the environment says `off` and `github` —
    // and the run must obey the environment about the banner and the FILE about the source.
    const d = deps({
      isTTY: true,
      config: cfg('RALPH_BANNER=full'),
      processEnv: { RALPH_BANNER: 'off', TASK_SOURCE: 'github' },
    })
    expect(await outcomeOf(d)).toEqual({ returned: { exitCode: 0, started: true, count: 3 } })
    // The banner: the environment won.
    expectMode(d, 'off', 'crossed precedence')
    // The source: the file won. A `github` run would have called `gh auth status` and counted
    // the queue with `gh issue list`; a folder run calls neither.
    expect(d.keys.filter((key) => key.startsWith('gh '))).toEqual([])
    expect(d.stdout.output()).toContain('3 issues in the queue')
  })

  it('keeps the digest window’s three knobs working out of the same text with the banner off', async () => {
    // Four consumers of one read, and `off` is the mode that skips the most — so this is where
    // a refactor would be most tempted to skip the read itself. The digest window's interval,
    // agent and model all come out of the same string the banner did.
    const d = deps({
      config: cfg(
        'RALPH_BANNER=off',
        'RALPH_DIGEST_INTERVAL=30m',
        'RALPH_AGENT=codex',
        'RALPH_DIGEST_MODEL=gpt-5',
      ),
    })
    await startCommand(d)
    const window = d.keys.find((key) => key.startsWith('tmux new-window'))
    expect(window).toContain("RALPH_AGENT='codex'")
    expect(window).toContain("RALPH_DIGEST_MODEL='gpt-5'")
    expect(window).toContain("--interval '30m'")
    expect(d.configReads()).toHaveLength(1)
  })

  it('is not read from .env.local: there are two sources, not three', async () => {
    // The confusion this forecloses. `.env.local` is loaded at step 3 and its values are
    // CREDENTIALS — they never reach `processEnv`, so a user who writes RALPH_BANNER there
    // gets nothing, and silently. Pinned so the behaviour is a decision: the two sources are
    // the committed config and the invocation's environment, and both are documented in the
    // template.
    const d = deps({
      isTTY: true,
      files: ['ralph.config.sh', '.env.local'],
      loadEnv: () => ({ RALPH_BANNER: 'off', CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: 'p' }),
    })
    await startCommand(d)
    expectMode(d, 'full', '.env.local')
  })

  it('reads the injected environment bag and never the ambient one, in both directions', async () => {
    // (#41) The dev's spec proves an ambient `off` cannot silence an injected run. The other
    // direction matters just as much for a suite: an ambient `full` must not un-silence one,
    // or this file's `off` assertions would pass on a developer's machine and fail in a shell
    // that had exported the variable.
    const ambient = process.env.RALPH_BANNER
    try {
      process.env.RALPH_BANNER = 'full'
      const d = deps({ isTTY: true, config: cfg('RALPH_BANNER=off') })
      await startCommand(d)
      expectMode(d, 'off', 'ambient full')
    } finally {
      if (ambient === undefined) delete process.env.RALPH_BANNER
      else process.env.RALPH_BANNER = ambient
    }
  })

  it('defers to the config for every blank environment value, and to the default for both', async () => {
    // The full precedence grid at the WIRING level, which is where `processEnv` can hold
    // shapes the resolver's table calls hostile: a bag built by a caller rather than by a
    // shell. Nine rows, each pinned to a mode.
    const rows = [
      [undefined, 'RALPH_BANNER=static', 'static'],
      ['', 'RALPH_BANNER=static', 'static'],
      ['   ', 'RALPH_BANNER=static', 'static'],
      ['\n', 'RALPH_BANNER=off', 'off'],
      ['off', 'RALPH_BANNER=full', 'off'],
      ['OFF', 'RALPH_BANNER=full', 'off'],
      [' off ', 'RALPH_BANNER=full', 'off'],
      ['full', 'RALPH_BANNER=off', 'full'],
      [undefined, '# RALPH_BANNER=off', 'full'],
    ]
    for (const [RALPH_BANNER, line, expected] of rows) {
      const where = `${JSON.stringify(RALPH_BANNER)} over ${line}`
      const d = deps({ isTTY: true, config: cfg(line), processEnv: { RALPH_BANNER } })
      await startCommand(d)
      expectMode(d, expected, where)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. The moved read.
// ---------------------------------------------------------------------------

describe('QA startCommand — the config read that moved to the top (#74)', () => {
  it('reads and stats ralph.config.sh exactly once, in every mode and on every exit', async () => {
    // Criterion 4 as a count, over the paths where a second read could hide: a launch, an
    // abort, and an early return. The STAT is counted too — `readConfigText` calls `exists`
    // before it reads — because a second `exists` would be a second decision about whether the
    // file is there, and the two could disagree.
    for (const mode of [...BANNER_MODES, 'blinky', '']) {
      for (const [name, overrides] of [
        ['a launch', {}],
        ['a tmux abort', { sessionExists: true }],
        ['an empty queue', { queue: 0 }],
      ]) {
        const where = `${mode} / ${name}`
        const d = deps({ isTTY: true, ...overrides, config: cfg(`RALPH_BANNER=${mode}`) })
        await outcomeOf(d)
        expect(d.configReads(), where).toEqual([`${REPO}/ralph.config.sh`])
        expect(d.configStats(), where).toEqual([`${REPO}/ralph.config.sh`])
      }
    }
  })

  it('is the first thing that happens, and still the only thing above the banner', async () => {
    // The one ordering change #74 makes, stated as the invariant it must preserve: the read is
    // inert — no shell, no write, nothing printed — so the first thing a USER sees is still the
    // splash, and the first thing the command DOES to the machine is still the tmux guard.
    const d = deps({ isTTY: true })
    await startCommand(d)
    // exists, then readFile — and nothing before either of them.
    expect(d.events[0]).toEqual({ kind: 'exists', detail: `${REPO}/ralph.config.sh` })
    expect(d.events[1]).toEqual({ kind: 'readFile', detail: `${REPO}/ralph.config.sh` })
    // ...then a run of stdout writes — the whole banner — with no exec, no stat, no second read
    // of the config and nothing on stderr threaded through it. Since #69 exactly ONE non-write
    // event is allowed in there and it is named: the read of the metrics log the box's model row
    // is resolved from, which sits between the splash and the box and is inert for precisely the
    // reason the config read above it is. Pinned as a whole list rather than excused, so a THIRD
    // read appearing in that gap fails here.
    const METRICS_READ = `${REPO}/.ralph/metrics/issues.jsonl`
    const inert = ({ kind, detail }) =>
      kind === 'write' || (kind === 'readFile' && detail === METRICS_READ)
    const firstEffect = d.events.findIndex((event, index) => index >= 2 && !inert(event))
    expect(d.events.slice(2, firstEffect).filter((event) => event.kind !== 'write')).toEqual([
      { kind: 'readFile', detail: METRICS_READ },
    ])
    expect(d.stdout.output().slice(0, PREFIX.full.length)).toBe(PREFIX.full)
    // ...and the first thing the command DOES to the machine is still the tmux guard, which is
    // the ordering the move had to preserve: the read is inert, so nothing observable moved
    // above it.
    expect(d.events[firstEffect]).toEqual({
      kind: 'exec',
      detail: `tmux has-session -t ${SESSION}`,
    })
  })

  it('puts the banner above the error on every aborting path, with the mode read first', async () => {
    // The runs where the banner is the only context the failure has. Two guards abort before
    // anything else happens, and both must still be preceded by the whole banner — which is
    // only possible because the mode was resolved above them.
    const aborts = [
      ['tmux session already exists', { sessionExists: true }],
      [
        'cycle lock held',
        { peekLock: () => ({ alive: true, holder: { pid: 4242, startedAt: '2023-11-14T00:00:00Z' } }) },
      ],
      ['missing critical dependency', { hasCommand: (name) => name !== 'gh' }],
    ]
    for (const [name, overrides] of aborts) {
      const full = deps({ isTTY: true, ...overrides })
      const off = deps({ isTTY: true, ...overrides, config: cfg('RALPH_BANNER=off') })
      const fullOutcome = await outcomeOf(full)
      expect(await outcomeOf(off), name).toEqual(fullOutcome)
      expect(fullOutcome.abort, name).toBe(true)
      expect(full.stdout.output().startsWith(`${SPLASH_BLOCK}${BOX_BLOCK}`), name).toBe(true)
      // ...and with the banner off, the same abort with none of it.
      expect(off.stdout.output(), name).toBe(full.stdout.output().replace(PREFIX.full, ''))
      expect(off.stderr.output(), name).toBe(full.stderr.output())
    }
  })

  it('cannot abort a launch through a throwing fs, whichever seam throws', async () => {
    // The risk the move introduces: the read is now the FIRST thing the command does, so a
    // throw from it would take a launch down before any guard, any preflight line and any
    // banner. `readConfigText` swallows both seams — this is what proves the wiring uses it
    // rather than reading the file itself.
    for (const [name, overrides] of [
      ['readFile throws', { readFile: () => { throw new Error('EIO') } }],
      ['exists throws', { exists: (p) => { if (String(p).endsWith('ralph.config.sh')) throw new Error('EIO'); return false } }],
      ['readFile returns a hostile object', { readFile: () => ({ toString: () => cfg('RALPH_BANNER=off') }) }],
    ]) {
      // `TASK_SOURCE` in the bag for the same reason as above: two of these three rows lose the
      // whole file, so the run has to get its source from somewhere for the comparison to be
      // about the banner. The launch is what is being asserted — a throw here would have
      // produced no run at all.
      const d = deps({ isTTY: true, processEnv: { TASK_SOURCE: 'folder' }, ...overrides })
      expect(await outcomeOf(d), name).toEqual({
        returned: { exitCode: 0, started: true, count: 3 },
      })
      expect(d.stderr.output(), name).toBe('')
      // The two rows that lost the text fall through to the default banner; the row that
      // merely stringified a weird object still resolves the `off` it contained.
      expectMode(d, name === 'readFile returns a hostile object' ? 'off' : 'full', name)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. The warning, and where it may not go.
// ---------------------------------------------------------------------------

describe('QA startCommand — the warning a typo earns, contained (#74)', () => {
  it('goes to stderr only, and leaves stdout byte-identical to a valid run', async () => {
    // The `| tee` run: a user piping `ralph start` into a log gets a clean log, and the
    // complaint about their config goes to the stream a script reads errors from. Byte
    // identity with a `full` run is the strong half — a warning that had leaked into stdout
    // would move every subsequent byte.
    const bad = deps({ isTTY: true, config: cfg('RALPH_BANNER=blinky') })
    const good = deps({ isTTY: true, config: cfg('RALPH_BANNER=full') })
    expect(await outcomeOf(bad)).toEqual(await outcomeOf(good))
    expect(bad.stdout.output()).toBe(good.stdout.output())
    expect(bad.stdout.output()).not.toContain('RALPH_BANNER')
    expect(bad.stdout.output()).not.toContain('unrecognized')
    expect(bad.stderr.output()).toBe(
      "⚠️  RALPH_BANNER='blinky' unrecognized; falling back to 'full'. Valid: full, static, off.\n",
    )
  })

  it('is written before the first byte of the banner, so it is not buried under a frame', async () => {
    // Order matters for a diagnostic that shares a terminal with an animation: a warning
    // written after five redrawn frames would land under the box, and a reader scrolling back
    // through a splash is a reader who misses it. The resolver runs before the splash, and
    // this is what pins that the printing does too.
    const d = deps({ isTTY: true, config: cfg('RALPH_BANNER=nope') })
    await startCommand(d)
    const kinds = d.events.map((event) => event.kind)
    expect(kinds.indexOf('stderr')).toBeLessThan(kinds.indexOf('write'))
    expect(d.events[kinds.indexOf('stderr')].detail).toContain('unrecognized')
  })

  it('stays one line for a value carrying a newline, a fake error and a fake success', async () => {
    // A committed file writing Ralph's own diagnostics. The value is echoed, so a newline in
    // it would let ralph.config.sh forge a second line of stderr — an `❌` a wrapper script
    // greps for, or a `✅` a human trusts. `oneLine` (#62) is what collapses it, and this is
    // the assertion that fails if the `oneLine` call at the warning site is ever dropped.
    const d = deps({
      config: cfg(),
      processEnv: { RALPH_BANNER: 'nope\n❌ Ralph exploded\n✅ all good' },
    })
    await startCommand(d)
    expect(d.stderr.output().split('\n').filter(Boolean)).toHaveLength(1)
    expect(d.stderr.output()).toBe(
      "⚠️  RALPH_BANNER='nope ❌ Ralph exploded ✅ all good' unrecognized; falling back to 'full'. Valid: full, static, off.\n",
    )
  })

  it('caps a hundred-thousand-character value rather than filling the terminal with it', async () => {
    // A config line is as long as an editor will let it be, and a warning is read by a human.
    // `oneLine`'s 200-character cap is what keeps a pathological value from becoming a
    // screenful — asserted here rather than in the resolver's spec because the resolver
    // deliberately returns the value UNCAPPED and the caller is the one that trims it.
    const d = deps({ processEnv: { RALPH_BANNER: 'x'.repeat(100_000) } })
    await startCommand(d)
    const lines = d.stderr.output().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0].length).toBeLessThan(220)
    expect(lines[0].endsWith('…')).toBe(true)
    expect(lines[0].startsWith("⚠️  RALPH_BANNER='xxx")).toBe(true)
  })

  it('lets no escape sequence out of the value reach stdout', async () => {
    // The containment that actually matters for a value read off a file: stdout is what a log,
    // a `| tee` and a CI transcript keep, and it must stay plain.
    //
    // STDERR USED TO BE THE ONE-SIDED HALF of this test — the warning echoed the value as
    // written, escapes included, on the argument that showing the user what they typed is the
    // point of the message. #108 made that unnecessary rather than wrong: `oneLine` (now
    // lib/one-line.js) replaces every character that can end a line or drive a terminal with
    // U+FFFD, one for one, so the user still sees WHERE the character was without the terminal
    // obeying it. The resolver itself still hands over the raw value — see
    // lib/banner-mode.qa.test.js, which pins that, because the resolver is pure and the
    // guarantee lives with whoever prints — so this line is where the property is checked.
    const d = deps({ config: cfg(`RALPH_BANNER="${ESC}[31moff${ESC}[0m"`) })
    expect(await outcomeOf(d)).toEqual({ returned: { exitCode: 0, started: true, count: 3 } })
    expect(d.stdout.output()).not.toContain(ESC)
    expect(d.stdout.output()).toBe(`${BOX_BLOCK}${PRE_BANNER_LAUNCH}`)
    expect(d.stderr.output().split('\n').filter(Boolean)).toHaveLength(1)
    expect(d.stderr.output()).toContain('unrecognized')
    expect(d.stderr.output()).not.toContain(ESC)
    expect(d.stderr.output()).toContain(String.fromCharCode(0xfffd))
  })

  it('warns once per run, never twice, whichever source the typo came from', async () => {
    // One value, one line — including when BOTH sources are wrong, where the resolver only
    // ever reads one of them and so may only ever complain about one.
    for (const [name, overrides] of [
      ['config only', { config: cfg('RALPH_BANNER=nope') }],
      ['environment only', { processEnv: { RALPH_BANNER: 'nope' } }],
      ['both wrong', { config: cfg('RALPH_BANNER=bad'), processEnv: { RALPH_BANNER: 'nope' } }],
      ['a duplicate line, both wrong', { config: cfg('RALPH_BANNER=bad', 'RALPH_BANNER=nope') }],
    ]) {
      const d = deps({ isTTY: true, ...overrides })
      await startCommand(d)
      const warnings = d.stderr.output().split('\n').filter((line) => line.includes('RALPH_BANNER'))
      expect(warnings, name).toHaveLength(1)
      expect(warnings[0], name).toContain("RALPH_BANNER='nope' unrecognized")
    }
  })

  it('says nothing at all for any spelling of any valid mode, from either source', async () => {
    // The other half of "warns once": silence for everything that works. Every registered word
    // in every case and padding, through both sources — because a warning on a value that
    // WORKED is the failure that teaches users to ignore warnings.
    for (const mode of BANNER_MODES) {
      for (const spelling of [mode, mode.toUpperCase(), `  ${mode}  `, `\t${mode}\t`]) {
        const fromConfig = deps({ isTTY: true, config: cfg(`RALPH_BANNER="${spelling}"`) })
        const fromEnv = deps({ isTTY: true, processEnv: { RALPH_BANNER: spelling } })
        await startCommand(fromConfig)
        await startCommand(fromEnv)
        expect(fromConfig.stderr.output(), `config ${JSON.stringify(spelling)}`).toBe('')
        expect(fromEnv.stderr.output(), `env ${JSON.stringify(spelling)}`).toBe('')
        // ...and the two sources produce the same run, which is what makes the silence mean
        // "understood" rather than "ignored".
        expect(fromConfig.stdout.output(), JSON.stringify(spelling)).toBe(fromEnv.stdout.output())
      }
    }
  })

  it('never turns a typo into an exit code, a skipped step or a missing box', async () => {
    // The trade the issue asks for, at its sharpest: an unrecognized value is worth one line
    // and nothing else. Not an abort, not a silent no-banner, not a skipped preflight.
    const d = deps({ isTTY: true, config: cfg('RALPH_BANNER=blinky'), columns: 20 })
    expect(await outcomeOf(d)).toEqual({ returned: { exitCode: 0, started: true, count: 3 } })
    // Twenty columns cannot hold a sprite, so the fallback `full` shows up as the box alone —
    // which is the capped-but-not-off answer, still carrying the facts.
    expect(d.stdout.output()).toContain(REPO)
    expect(d.stdout.output()).toContain(`ralph ${VERSION}`)
    expect(d.stdout.output()).toContain('✅ Ralph started in background. 3 issues in the queue.')
    expect(d.stdout.output()).not.toContain(ESC)
  })
})

// ---------------------------------------------------------------------------
// 7. The shipped template.
// ---------------------------------------------------------------------------

describe('QA the shipped ralph.config.sh — the knob a user is invited to edit (#74)', () => {
  const TEMPLATE = readFileSync(templatePath('ralph.config.sh'), 'utf8')

  it('parses back through the same grammar the command reads it with', async () => {
    // The template's own spec asserts the LINE. This asserts the ROUND TRIP: whatever that
    // line is, feeding the whole file through `parseConfigVar` and then through the resolver
    // has to produce a valid mode and no warning. A quoting mistake, a stray placeholder or a
    // trailing comment that ate the value would all fail here rather than on a user's machine.
    const value = parseConfigVar(TEMPLATE, 'RALPH_BANNER')
    expect(BANNER_MODES).toContain(value)
    expect(value).toBe(DEFAULT_BANNER_MODE)
    const resolved = resolveBannerMode({ configured: value, isTTY: true, color: true, width: 80 })
    expect(resolved.warning).toBe(null)
    expect(resolved.mode).toBe(DEFAULT_BANNER_MODE)
    // No unrendered placeholder anywhere near it: `ralph init` substitutes a fixed set, and an
    // unrendered `{{...}}` would reach the resolver as a value and earn every user a warning.
    expect(value).not.toContain('{{')
  })

  it('survives `ralph init` verbatim, and the file it writes resolves to the default', async () => {
    // The interpolation is a `split`/`join` over a fixed placeholder list, so a quoted literal
    // passes through untouched — but "untouched" is a claim about the writer, and this is the
    // one test that makes it by RUNNING it. memfs so no real file is written, and every prompt
    // seam is closed off (`isTTY: false`) so nothing here can block.
    const vol = Volume.fromJSON({ '/project/.keep': '' }, '/')
    const out = []
    const exec = async (cmd, args) => {
      const key = `${cmd} ${args.join(' ')}`
      const answers = {
        'git rev-parse --is-inside-work-tree': 'true',
        'git rev-parse --show-toplevel': '/project',
        'git symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/main',
        'git branch -a': '* main',
      }
      return { exitCode: 0, stdout: answers[key] ?? '', stderr: '' }
    }
    await initCommand({
      cwd: '/project',
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => out.push(s) },
      exec,
      fs: vol,
      isTTY: false,
      home: HOME,
      processEnv: {},
    })
    const written = vol.readFileSync('/project/ralph.config.sh', 'utf8').toString()
    // The line arrives exactly as the template spells it — one live assignment, unmangled.
    const live = written.split('\n').filter((line) => /^\s*(export\s+)?RALPH_BANNER\s*=/.test(line))
    expect(live).toEqual([`RALPH_BANNER="${DEFAULT_BANNER_MODE}"`])
    expect(parseConfigVar(written, 'RALPH_BANNER')).toBe(DEFAULT_BANNER_MODE)

    // ...and the written file drives a run that is byte-identical to a repo with no banner
    // line at all, which is the claim that makes a shipped default safe to ship. `ralph init`
    // writes `TASK_SOURCE="github"`, so the folder source is appended rather than substituted —
    // the last live assignment is the one the grammar honours, which is the same rule the
    // duplicate rows above pin.
    const initialized = deps({ isTTY: true, config: `${written}\nTASK_SOURCE=folder\n` })
    const bare = deps({ isTTY: true })
    await startCommand(initialized)
    await startCommand(bare)
    expect(initialized.stdout.output()).toBe(bare.stdout.output())
    expect(initialized.stderr.output()).toBe('')
  })

  it('documents every mode it accepts, and nothing it does not', async () => {
    // A knob nobody can find is a knob nobody uses, and a comment naming a FOURTH value would
    // be worse than none — a user would type it and get a warning. Both directions, derived
    // from the registry so a new mode fails here until the comment names it.
    const comment = TEMPLATE.slice(0, TEMPLATE.search(/^RALPH_BANNER=/m))
      .split('\n\n')
      .at(-1)
    for (const mode of BANNER_MODES) expect(comment, mode).toContain(`"${mode}"`)
    // Every quoted word in that paragraph is a real mode: no `"quiet"`, no `"none"`, no
    // `"true"` left behind by an earlier draft.
    const quoted = [...comment.matchAll(/"([a-z]+)"/g)].map((match) => match[1])
    for (const word of new Set(quoted)) expect(BANNER_MODES, word).toContain(word)
  })
})
