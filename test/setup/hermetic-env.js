// #41 — the ONE place the test suite is made hermetic.
//
// Wired as the single `setupFiles` entry in vitest.config.js, so it runs in every
// test worker before every test file is imported. A newly added test file
// inherits everything below without importing anything or opting in.
//
// WHY THIS EXISTS
// ~20 modules under lib/ default a parameter to the ambient environment
// (`processEnv = process.env`, `env = process.env`, `home = homedir()`), and the
// bash-loop tests under test/ spawn `templates/ralph.sh` with `{ ...process.env,
// … }`. Without neutralization the invoking shell becomes silent test input:
// XDG_CONFIG_HOME, TASK_SOURCE and ~30 RALPH_* names change behaviour, so the
// suite is green on one machine and red on another. Note that `ralph` itself
// runs `npm test` with RALPH_AGENT / RALPH_RUN_ID / PROJECT_ROOT exported, so
// "the invoking shell" is not hypothetical. #35 shipped a red `main` this way: a
// write honored an ambient XDG_CONFIG_HOME while the matching read did not.
//
// WHAT IT DOES, in order
//   1. Deletes every ralph-domain variable from the worker's process.env. The
//      name set is DERIVED FROM THE SOURCES (see "WHICH NAMES" below) rather
//      than hand-maintained, because the name nobody remembers to add is exactly
//      how #35 happened.
//   2. Repoints HOME at a per-worker sandbox under the OS temp dir, so anything
//      resolved from `homedir()` — ~/.config/ralph/.env, the update-check cache —
//      lands in throwaway space instead of the developer's real home.
//   3. Snapshots the resulting environment before each test and restores it
//      afterwards, so an explicit opt-in stays possible and stays local.
//
// HOW TO OPT IN TO A SPECIFIC VALUE
//   - Unit tests: inject, don't mutate. Every affected module takes an explicit
//     bag — `globalConfigPath({ processEnv: { XDG_CONFIG_HOME: '/xdg' }, home:
//     '/home/me' })`. Injection is unaffected by this file.
//   - Integration tests that spawn a child and cannot inject: set the variable on
//     the child env (`spawnSync(…, { env: { ...process.env, TASK_SOURCE: 'folder' } })`)
//     or assign `process.env.X = …` inside the test. Step 3 reverts it before the
//     next test runs, including a delete or an overwrite of HOME.
//   - Mutate in a `beforeEach`, not a `beforeAll`. The per-test snapshot is taken
//     after `beforeAll` has run, so a value set there becomes part of the
//     baseline every later test in the file is restored TO — i.e. it is sticky
//     for the whole file instead of being reverted per test.
//
// The behaviour of this file is asserted by test/hermetic-env.test.js and, from
// the outside (re-running the suite under a hostile shell), by
// test/hermetic-env.qa.test.js + test/hermetic-env.idempotence.qa.test.js.

import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// ---------------------------------------------------------------------------
// WHICH NAMES
// ---------------------------------------------------------------------------

// Everything RALPH_* is ralph's own namespace, so a prefix match is exhaustive
// and stays correct as new RALPH_* knobs appear.
const AMBIENT_PREFIXES = ['RALPH_']

// Never delete these, whatever the scan below turns up: they belong to the OS and
// the toolchain, and node, bash and the stub PATH the loop tests build need them.
const TOOLCHAIN_NAMES = ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SHELL']

// Prefixless names that no source file *declares*, so the scan cannot find them.
// This residue is the only hand-maintained part, and it is deliberately tiny.
const UNDECLARED_AMBIENT_NAMES = [
  // Read by lib/utils/global-config.js, lib/version-cache.js and the
  // ${XDG_CONFIG_HOME:-$HOME/.config} expression in templates/ralph.sh.
  'XDG_CONFIG_HOME',
  // Exported by templates/ralph.sh to every child it spawns.
  'PROJECT_ROOT',
  'TASKS_ROOT',
  // NOT read anywhere in lib/ — they appear only in the commented-out examples
  // of templates/ralph-notify.sh.example, i.e. in a notify hook a USER may write.
  // Kept on purpose: a developer with a real webhook exported must not have the
  // bash-loop tests fire it. Do not remove these as dead entries.
  'SLACK_WEBHOOK_URL',
  'DISCORD_WEBHOOK_URL',
  // Belt and braces, deliberately redundant with the derivation below. Of the five
  // resolveCred() keys, this is the only one covered by a SINGLE net: the other
  // four are either RALPH_*-prefixed or declared in a scanned template, while this
  // one is found only by the `resolveCred('LITERAL')` regex. Rewriting
  // lib/commands/cycle.js:84 as `resolveCred(SOME_CONST)` would make it invisible
  // to the scan — and this is the exact name that shipped the leak (#41 D1), so it
  // gets a second net that no refactor can remove.
  'HEALTHCHECK_URL',
  // #67: read by lib/sprite-banner.js (through the env bag `ralph start` injects) to
  // suppress the sprite. Undeclared here because the derivation below only finds
  // names that are resolveCred() keys or assignments in a scanned template, and
  // NO_COLOR is neither — it is a cross-tool convention nobody declares. It is NOT a
  // toolchain name either: a developer with NO_COLOR exported would otherwise flip
  // every colour-gated assertion in the suite, which is precisely the class of
  // shell-dependence #41 exists to kill.
  'NO_COLOR',
  // #167: read by lib/commands/live.js (through the env bag, `processEnv.TMUX`) to
  // refuse to nest one tmux session inside another. Undeclared here for the same
  // reason as NO_COLOR — the derivation below finds only resolveCred() keys and
  // assignments in a scanned template, never a `processEnv.X` reference — but with a
  // sharper edge: tmux EXPORTS this name in every shell inside a session, so a
  // developer running the suite from the tmux window `ralph start` opened has it set,
  // and any test that lets `liveCommand`'s `processEnv` default would take the
  // inside-tmux branch on that machine and not on CI. Verified against the same
  // scanner the QA specs use: test/helpers/env-surface.js reports TMUX with source
  // lib/commands/live.js.
  'TMUX',
]

// The derivation FAILS CLOSED: an unreadable source would silently shrink the name
// set and hand hermeticity back to the shell, so a read error aborts the run
// instead. It aborts with its own name attached, because otherwise whoever renames
// a template sees a bare ENOENT and no hint that the test harness's env derivation
// is why every spec in the suite just died.
function readDerivationSource(read, target, role) {
  try {
    return read()
  } catch (cause) {
    throw new Error(
      `hermetic-env (#41): cannot read ${target}, which this file scans to derive the set of ` +
        `ambient environment variables the suite must neutralize (${role}). Failing closed rather ` +
        `than running non-hermetically with a partial set. If you moved, renamed or deleted that ` +
        `path, update jsSources()/CONFIG_SURFACE_FILES in test/setup/hermetic-env.js to match.`,
      { cause },
    )
  }
}

function jsSources(dir, out = []) {
  const entries = readDerivationSource(
    () => readdirSync(dir, { withFileTypes: true }),
    dir,
    'the lib/ tree searched for resolveCred() credential keys',
  )
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) jsSources(p, out)
    // Production sources only: a *.test.js file's own fixtures are not a read of
    // the ambient environment.
    else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) out.push(p)
  }
  return out
}

// createCredentialResolver() resolves an ARBITRARY key through
// repo .env.local → process.env → global file, and `processEnv` defaults to
// process.env. So every literal key handed to a resolver is an ambient read that
// no `processEnv.X` reference spells out — HEALTHCHECK_URL was exactly that:
// prefixless, read by lib/commands/cycle.js, and missing from the first version
// of this file's hand-written list.
const CRED_KEY = /resolveCred\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g

// Assignments in the generated config files. Every name ralph.config.sh or
// env.local.example declares is a name the shell loop and lib/ read out of the
// environment, so an ambient value of the same name is a leak vector.
const SHELL_ASSIGN = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm
const CONFIG_SURFACE_FILES = [
  join('templates', 'ralph.config.sh'),
  join('templates', 'env.local.example'),
]

// ~6ms per test file: 46 sources plus two templates, no dependencies.
function derivedAmbientNames() {
  const names = new Set()
  for (const file of jsSources(join(REPO_ROOT, 'lib'))) {
    const src = readDerivationSource(
      () => readFileSync(file, 'utf8'),
      file,
      'a lib/ source searched for resolveCred() credential keys',
    )
    for (const m of src.matchAll(CRED_KEY)) names.add(m[1])
  }
  for (const rel of CONFIG_SURFACE_FILES) {
    const src = readDerivationSource(
      () => readFileSync(join(REPO_ROOT, rel), 'utf8'),
      rel,
      'a generated config template whose assignments ARE the config surface',
    )
    for (const m of src.matchAll(SHELL_ASSIGN)) names.add(m[1])
  }
  return names
}

const AMBIENT_NAMES = new Set(
  [...derivedAmbientNames(), ...UNDECLARED_AMBIENT_NAMES].filter(
    (name) => !TOOLCHAIN_NAMES.includes(name),
  ),
)

function isAmbientRalphVar(name) {
  return AMBIENT_PREFIXES.some((prefix) => name.startsWith(prefix)) || AMBIENT_NAMES.has(name)
}

for (const name of Object.keys(process.env)) {
  if (isAmbientRalphVar(name)) delete process.env[name]
}

// ---------------------------------------------------------------------------
// THE SANDBOX HOME
// ---------------------------------------------------------------------------

// Keyed on the vitest worker id as well as the pid: the pid is NOT unique per
// worker (a thread-based pool runs every worker inside one process), and a shared
// path would let one spec file's rmSync destroy the sandbox another spec file is
// still using.
const SANDBOX_HOME = join(
  tmpdir(),
  `ralph-test-home-${process.pid}-${process.env.VITEST_WORKER_ID ?? '1'}`,
)

// Recreated empty for each test file and removed in afterAll — nothing is left in
// the temp dir once the run ends.
rmSync(SANDBOX_HOME, { recursive: true, force: true })
mkdirSync(SANDBOX_HOME, { recursive: true })
// The sandbox is created for real because bash children do `mkdir -p "$HOME/…"`
// and JS callers stat it. HOME drives os.homedir() on POSIX; USERPROFILE is its
// win32 equivalent, set so the sandbox holds there too.
process.env.HOME = SANDBOX_HOME
process.env.USERPROFILE = SANDBOX_HOME

// Assert the override actually took, rather than assuming it. Writing
// process.env.HOME reaches os.homedir() — and so every `home = homedir()` default
// in lib/ — only when the worker is its own PROCESS. In a worker THREAD
// process.env is a JS-level copy that never reaches libuv's getenv, so
// os.homedir() keeps reporting the developer's REAL home while process.env.HOME
// shows the sandbox: hermeticity would be gone and the suite would quietly write
// to the real ~/.config/ralph. vitest.config.js pins `pool: 'forks'` so that
// cannot happen by default; this check turns an override (`--pool=threads`) into
// an immediate, named failure instead of a silent loss.
if (homedir() !== SANDBOX_HOME) {
  const reported = homedir()
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
  throw new Error(
    `hermetic-env (#41): HOME was repointed at ${SANDBOX_HOME} but os.homedir() still reports ` +
      `${reported}, so every \`home = homedir()\` default in lib/ would resolve against the real ` +
      `home. This is what happens when spec files run in worker THREADS, where process.env is a ` +
      `thread-local copy. Run with the pinned \`pool: 'forks'\` from vitest.config.js.`,
  )
}

// ---------------------------------------------------------------------------
// SNAPSHOT / RESTORE
// ---------------------------------------------------------------------------

let envSnapshot

beforeEach(() => {
  envSnapshot = { ...process.env }
})

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in envSnapshot)) delete process.env[name]
  }
  for (const [name, value] of Object.entries(envSnapshot)) {
    if (process.env[name] !== value) process.env[name] = value
  }
})

// Registered before any hook a test file declares, so vitest's default 'stack'
// order runs it last: a test file's own afterAll still sees the sandbox.
afterAll(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})
