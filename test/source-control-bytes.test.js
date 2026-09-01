import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { RALPH_HOME } from '../lib/paths.js'
import {
  CONTROL_CODES,
  ESC_CODE,
  HOW_TO_FIX,
  NUL_CODE,
  OTHER_CONTROL_CODES,
  TEXT_CONTROL_CODES,
  offenders,
  textFiles,
} from './helpers/source-control-bytes.js'

// #107 — no raw control byte may be committed into this repo's source.
//
// WHY A GUARD RATHER THAN A THIRD ONE-OFF FIX
// The convention is already written down — lib/commands/doctor.identity-box.test.js explains
// that the ESC byte is built with `String.fromCharCode` rather than embedded literally — and
// #75 fixed the same defect in its own new file. Writing it down did not stop it being
// introduced twice, and the failure mode is silent by construction: Node reads the byte
// perfectly well, so the suite stays green while a whole test file leaves the searchable
// repo. So the property gets asserted instead. Same shape as the repo's other source-level
// guards (lib/i18n-portuguese-leakage.qa.test.js's Portuguese sweep, the import-graph walks
// in lib/commands/doctor.version-line.qa.test.js) — read our own files, assert a property of
// them, name the offenders on failure.
//
// WHAT EACH BYTE COSTS is in test/helpers/source-control-bytes.js, alongside the detector
// both this file and its QA augmentation share; the three `expect` messages below repeat the
// short version at the point of failure, which is where a reader needs it.
//
// The `file -b` half of the contract needs no separate assertion: `file` says `data` BECAUSE
// of the control byte, so control-byte-freedom IS that verdict.

// THE SCOPE IS TRACKED-MINUS-DECLARED-BINARY, and the second half of that is younger than the
// first. The sweep was unscoped — every file git tracks, full stop — and stayed that way
// deliberately, because the extension list it replaced made a file kind outside the list
// invisible to the guard. Then a bug-report screenshot was committed, a PNG is very largely
// raw NULs, and the guard went red on a byte nobody authored.
//
// A CONTENT SNIFF WAS THE WRONG WAY OUT, which is the part worth reading twice. git decides
// binary by looking for a NUL in the first 8000 bytes — the byte under guard — so letting
// content vote would let a .js that acquired a NUL near the top reclassify itself as an asset,
// leave the sweep, and carry its own offence out with it. `.gitattributes` cannot do that
// quietly: it names the kind on the record, and the QA guard fails if a source extension ever
// appears there or if a tracked binary is left undeclared. See `textFiles()` for the argument.
const FILES = textFiles()
const rel = (file) => relative(RALPH_HOME, file)
const JS_FILES = FILES.filter((file) => file.endsWith('.js'))

// Directories that exist in EVERY checkout and hold nothing git tracks. Named only to prove
// the scope rule below is doing real work — they are not a skip list, and adding the next one
// would be a mistake rather than a maintenance task.
//
// WHY ONLY TWO. The list has to survive a fresh clone, because the loop below asserts each
// tree EXISTS before asserting it contributed nothing — without that precondition a missing
// directory would satisfy the scope assertion vacuously, which is the failure mode this whole
// file is about. .github/workflows/ci.yml is `actions/checkout@v4` plus `npm ci`, and that
// produces exactly `.git/` and `node_modules/`. An earlier draft also named `logs/`, `.ralph/`
// and `.claude/`; all three are absent on a clean checkout (the first two only appear once
// ralph has RUN, and `.claude/` is not even in this repo's .gitignore — it is excluded by the
// developer's global one), so the anti-vacuity guard turned three machine-local accidents into
// a red CI run for anyone who had not happened to create them.
//
// THIS NARROWS WHAT THIS TEST WITNESSES, NOT THE PROPERTY. The strong claim — that depth is
// not a special case, that the rule is tracking rather than the path's spelling, and that a
// file force-added INSIDE an ignored directory is therefore swept — is proven far better by
// the `scope-depth` test in test/source-control-bytes.qa.test.js, which builds its own
// .gitignore and its own vendored trees in a throwaway repository rather than borrowing
// whatever happens to be lying around this working tree. Borrowing was the weakness: the tree
// had a vote on the verdict. What is left here is the cheap local corollary, and it is still
// worth having, because it fails if `trackedFiles()` is ever swapped back for a directory walk.
const UNTRACKED_TREES = ['node_modules', '.git']

describe('source hygiene — no raw control bytes in committed source (#107)', () => {
  it('lists the files git tracks (sanity: fails closed, never sweeps an empty set)', () => {
    const rels = FILES.map(rel)
    expect(rels.length).toBeGreaterThan(100)
    expect(rels).toContain('package.json')
    expect(rels).toContain('bin/ralph.js')
    expect(rels).toContain('lib/paths.js')
    expect(rels).toContain('lib/commands/start.js')
    expect(rels).toContain('templates/ralph.sh')
    expect(rels).toContain('README.md')
    // The two files #107 found unsearchable must be in scope, or the guard would have
    // passed on the very defect it exists for.
    expect(rels).toContain('lib/commands/start.launch-box.qa.test.js')
    expect(rels).toContain('lib/read-config-agent.test.js')
  })

  it('scans what git tracks and nothing else — no vendored, generated or ignored file', () => {
    // The scope is expressed as a rule ("what git tracks") rather than as a list of
    // directories to skip, which is what keeps a `coverage/` report, a `.DS_Store` or the
    // `.env.local` the README asks you to create from ever reaching a sweep and going red
    // over a byte nobody authored. See trackedFiles() for the argument.
    const rels = FILES.map(rel)
    for (const tree of UNTRACKED_TREES) {
      expect(
        existsSync(join(RALPH_HOME, tree)),
        `${tree}/ is missing, so the assertion below would pass over nothing. Run \`npm ci\`. ` +
          'If a checkout legitimately no longer has this directory, drop it from ' +
          'UNTRACKED_TREES rather than dropping the existence check.',
      ).toBe(true)
      expect(
        rels.filter((r) => r === tree || r.startsWith(`${tree}/`)),
        `${tree}/ reached the sweep`,
      ).toEqual([])
    }
  })

  it('scans itself and its own helper, so neither can be the exception', () => {
    const rels = JS_FILES.map(rel)
    expect(rels).toContain('test/source-control-bytes.test.js')
    expect(rels).toContain('test/source-control-bytes.qa.test.js')
    expect(rels).toContain('test/helpers/source-control-bytes.js')
  })

  it('partitions the control bytes, so one failure names one property', () => {
    // Disjoint and exhaustive: no byte is checked twice, and none falls between the three
    // assertions. TAB/LF/CR are the only omissions and are deliberate.
    expect([NUL_CODE, ESC_CODE, ...OTHER_CONTROL_CODES].sort((a, b) => a - b)).toEqual(
      CONTROL_CODES.slice().sort((a, b) => a - b),
    )
    expect(OTHER_CONTROL_CODES).not.toContain(NUL_CODE)
    expect(OTHER_CONTROL_CODES).not.toContain(ESC_CODE)
    for (const textual of TEXT_CONTROL_CODES) expect(CONTROL_CODES).not.toContain(textual)
  })

  it('contains ZERO raw U+0000 (NUL) in any tracked file — the byte that hides a file from grep', () => {
    const hits = offenders(FILES, [NUL_CODE])
    expect(
      hits,
      'Raw NUL in source. `file` calls these `data`, so grep, rg and git grep skip them ' +
        `silently while Node reads them fine.\n${HOW_TO_FIX(NUL_CODE)}\n${hits.join('\n')}`,
    ).toEqual([])
  })

  it('contains ZERO raw U+001B (ESC) in .js — the byte that recolours a pager', () => {
    const hits = offenders(JS_FILES, [ESC_CODE])
    expect(
      hits,
      'Raw ESC in JavaScript source. cat/less one of these and the terminal takes the ' +
        `colour from that line on.\n${HOW_TO_FIX(ESC_CODE)}\n${hits.join('\n')}`,
    ).toEqual([])
  })

  it('contains ZERO other raw C0/DEL control bytes in .js — the rest of the same class', () => {
    const hits = offenders(JS_FILES, OTHER_CONTROL_CODES)
    // The other two sweeps own one code each, so their remedy can name it. This one owns 28,
    // and the remedy NAMES THE BYTE — so it is read back off the offenders instead of being
    // hardcoded to 0x01. Hardcoded, it listed a U+0007 offender correctly and then told the
    // reader to re-spell U+0001 — a fix for a byte that is not in their file. The trailing
    // `U+XXXX` is the report format `offenders()` documents and
    // test/source-control-bytes.qa.test.js pins code by code; on a green run `hits` is empty,
    // so this costs nothing and produces nothing.
    const remedy = [...new Set(hits.map((hit) => hit.slice(hit.lastIndexOf('U+') + 2)))]
      .map((found) => HOW_TO_FIX(parseInt(found, 16)))
      .join('\n')
    expect(
      hits,
      'Raw control byte in JavaScript source. Neither NUL nor ESC, and still costly: ' +
        'U+0001 and U+001A keep `file` on `data` (so the file is unsearchable), U+0007 rings ' +
        `the bell.\n${remedy}\n${hits.join('\n')}`,
    ).toEqual([])
  })
})
