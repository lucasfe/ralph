// #70 — WHERE the changelog is, and what to do when it is not there.
//
// The thin, impure half of lib/changelog.js: it resolves one path, reads one file and
// hands the text to the parser. Everything about the FORMAT lives next door; everything
// about the FILESYSTEM lives here. That is the same split lib/digest-file.js and
// lib/digest-history.js make, and it is what lets the parser be tested with string
// literals and this module be tested with an injected fs.
//
// RESOLVED AGAINST THE INSTALLED MODULE, NEVER THE WORKING DIRECTORY. This is the whole
// reason the function below exists instead of a `join(cwd, 'CHANGELOG.md')` at the call
// site: `ralph start` runs inside the user's repo, and that repo has a CHANGELOG.md of its
// own. A cwd-relative read would put somebody else's release notes in Ralph's banner —
// and on a globally installed Ralph in a repo without one, it would find nothing at all.
// RALPH_HOME comes from lib/paths.js, which derives it from `import.meta.url`, so an npm
// global, an `npx ralph` and a linked dev checkout each read the file they shipped with.
//
// NO NETWORK, BY CONSTRUCTION: CHANGELOG.md is listed in package.json's `files`, so it is
// already on disk beside lib/ when the banner wants it. That is what makes a what's-new
// section affordable on every single `ralph start` — the alternative (a releases API call)
// would put a round trip in front of the first paint, which #24 already refuses for the
// update hint.
//
// EVERY FAILURE IS NO ENTRIES. A missing file (a pruned install, a tarball built without
// it), an unreadable one, a directory where the file should be, an fs that is not one, and
// content nothing can be made of: all of it returns `[]` and none of it throws. The caller
// is the first thing `ralph start` prints, before the tmux check and before the config
// read, and a banner is never worth losing a run over — the same rule, for the same
// reason, that `cachedLatestVersion` applies to the update-check cache in that command.

import { readFileSync as realReadFileSync } from 'node:fs'
import { join } from 'node:path'
import { RALPH_HOME } from './paths.js'
import { parseChangelog } from './changelog.js'

// The name the file has in the repo, in the tarball and in package.json's `files`. Named
// here so `ralph changelog` (#71) can point at the same one.
const CHANGELOG_FILE = 'CHANGELOG.md'

/** The shipped changelog's absolute path — inside the installed package, not the cwd. */
export function changelogPath() {
  return join(RALPH_HOME, CHANGELOG_FILE)
}

/**
 * The shipped changelog, parsed.
 *
 * @param {object} [options]
 * @param {object} [options.fs] fs impl, injected in tests (memfs) so no spec reads the
 *   real file unless that is the thing it means to assert.
 * @param {string} [options.path] the file to read. Defaults to this package's own.
 * @returns {Array} entries as lib/changelog.js returns them, or `[]` for any failure
 */
export function readChangelogEntries({ fs = defaultFs, path = changelogPath() } = {}) {
  try {
    // `.toString()` because an fs is free to ignore the encoding argument and answer with
    // a Buffer, and `?? ''` because one is free to answer with nothing at all. The parser
    // refuses a non-string anyway; this keeps the refusal from depending on that.
    const text = fs.readFileSync(path, 'utf8')?.toString() ?? ''
    return parseChangelog(text)
  } catch {
    // ONE catch for both halves, deliberately. The read is what actually fails in the
    // field, and the parser is total by contract — but "total by contract" is a promise
    // made in another file, and the cost of it being wrong here is a `ralph start` that
    // dies before printing anything. The parser's own totality is pinned in
    // changelog.test.js, so this catch is insurance rather than the guarantee.
    return []
  }
}

const defaultFs = { readFileSync: realReadFileSync }
