// #41 QA support — derives, BY STATIC SCAN OF THE SOURCES, the set of
// environment variable names ralph actually reads from the ambient environment.
//
// WHY THIS IS NOT A LIST
// test/setup/hermetic-env.js neutralizes `RALPH_*` by prefix (exhaustive) plus a
// hand-maintained `AMBIENT_NAMES` array for the non-prefixed names. A
// hand-maintained denylist is exactly what shipped the red `main` in #35: the
// name nobody remembered is the name that leaks. So instead of re-typing the
// dev's list (which would only ever agree with itself), this module recomputes
// the surface from the code that reads it. A new `processEnv.SOMETHING` in lib/
// or a new var in templates/ralph.config.sh shows up here automatically, and the
// specs that consume it start failing until the mechanism covers it.
//
// Consumed by test/hermetic-env.qa.test.js (asserts each name is neutralized in
// the worker and in a spawned child) and by
// test/hermetic-env.idempotence.qa.test.js (exports a poison value for every
// name, then re-runs the suite and demands an identical result).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// Names the scan legitimately finds but that the suite MUST keep: they belong to
// the OS/toolchain, not to ralph, and deleting them would break node, bash and
// the stub PATH the loop tests build. Spelled out so the exclusion is auditable
// — everything else the scan finds is ralph-domain and must be neutralized.
export const TOOLCHAIN_NAMES = ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'TMPDIR']

function jsSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) jsSources(p, out)
    // Production sources only: a *.test.js file's own fixtures are not a read of
    // the ambient environment.
    else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) out.push(p)
  }
  return out
}

// `[A-Z][A-Z0-9_]*` alone matches the leading `P` of `env.Path`; the lookahead
// rejects a name followed by more word characters so only SCREAMING_CASE hits.
const NAME = '([A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])'
const READ_PATTERNS = [
  // `process.env.X`, `processEnv.X`, `env.X` — the default-parameter bag every
  // affected lib/ module exposes.
  new RegExp(String.raw`(?:process\.env|processEnv|\benv)\s*\.\s*${NAME}`, 'g'),
  // `processEnv['X']` / `env["X"]`
  new RegExp(String.raw`(?:process\.env|processEnv|\benv)\s*\[\s*['"]${NAME}['"]\s*\]`, 'g'),
]

// createCredentialResolver() resolves an ARBITRARY key through
// repo .env.local → process.env → global file, so the literal keys handed to it
// are ambient reads that no `processEnv.X` pattern can find.
const RESOLVE_CRED = new RegExp(String.raw`resolveCred\(\s*['"]${NAME}['"]`, 'g')

// Assignments in the generated config files. Every name ralph.config.sh sets is
// a name the shell loop and build-prompt read out of the environment, so an
// ambient value of the same name is a leak vector even if no JS file names it.
const SHELL_ASSIGN = new RegExp(String.raw`^\s*(?:export\s+)?${NAME}\s*=`, 'gm')

const CONFIG_SURFACE_FILES = [
  join('templates', 'ralph.config.sh'),
  join('templates', 'env.local.example'),
]

/**
 * Every key passed as a string literal to a createCredentialResolver() resolver
 * in lib/. These are resolved from `process.env` by default, so an ambient value
 * reaches production code paths without any test opting in.
 */
export function credentialResolverKeys() {
  const found = new Set()
  for (const file of jsSources(join(REPO_ROOT, 'lib'))) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(RESOLVE_CRED)) found.add(m[1])
  }
  return [...found].sort()
}

/**
 * The full ralph-domain ambient surface: names read from an env bag in
 * lib/ + bin/, names resolved through the credential resolver, and names
 * declared by the generated config files — minus TOOLCHAIN_NAMES.
 *
 * @returns {{ name: string, sources: string[] }[]} sorted by name
 */
export function ralphEnvSurface() {
  const found = new Map()
  const add = (name, source) => {
    if (TOOLCHAIN_NAMES.includes(name)) return
    if (!found.has(name)) found.set(name, new Set())
    found.get(name).add(source)
  }

  for (const file of [
    ...jsSources(join(REPO_ROOT, 'lib')),
    ...jsSources(join(REPO_ROOT, 'bin')),
  ]) {
    const src = readFileSync(file, 'utf8')
    const rel = file.slice(REPO_ROOT.length)
    for (const pattern of [...READ_PATTERNS, RESOLVE_CRED]) {
      for (const m of src.matchAll(pattern)) add(m[1], rel)
    }
  }

  for (const rel of CONFIG_SURFACE_FILES) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8')
    for (const m of src.matchAll(SHELL_ASSIGN)) add(m[1], rel)
  }

  return [...found]
    .map(([name, sources]) => ({ name, sources: [...sources].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * A hostile ambient value for every name on the surface — the shape of shell a
 * developer or a CI runner might actually have exported. Values are chosen to be
 * loud if they leak: unreachable paths, failing commands, poison credentials.
 */
export function poisonEnv() {
  const poison = {}
  for (const { name } of ralphEnvSurface()) {
    if (name.endsWith('_CMD')) poison[name] = 'exit 7'
    else if (name.endsWith('_URL')) poison[name] = 'https://qa-leak.invalid/ping'
    else if (name.endsWith('_ROOT')) poison[name] = '/qa-leak-nonexistent'
    else if (name === 'XDG_CONFIG_HOME') poison[name] = '/qa-leak-nonexistent/xdg'
    else poison[name] = 'QA_LEAK'
  }
  // Values that must parse as their declared type to reach deeper code paths
  // rather than being rejected as garbage at the edge.
  Object.assign(poison, {
    TASK_SOURCE: 'folder',
    RALPH_AGENT: 'codex',
    RALPH_HEAVY_TIER: '1',
    RALPH_CONTEXT_WINDOW: '200000',
    RALPH_ISSUE_NUMBER: '999999',
    RALPH_DURATION_MS: '1',
    RALPH_CLAUDE_EXIT: '1',
    MERGE_POLL_INTERVAL: '1',
    MERGE_POLL_MAX: '1',
    AUTO_MERGE: 'false',
    MERGE_STRATEGY: 'rebase',
    WHATSAPP_PHONE: '+15550001',
  })
  return poison
}
