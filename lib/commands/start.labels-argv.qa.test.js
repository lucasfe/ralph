// #139 QA augmentation — ARGV IDENTITY UNDER ITERATION.
//
// #139 replaced three literal `await exec('gh', ['label','create', …])` blocks in `ralph
// start` with one loop over MANAGED_LABELS, and claimed the emitted argv is unchanged. That
// claim is the whole risk of the slice: a refactor of three calls into one loop can change
// the ORDER of the calls, the ORDER of the flags inside a call, the `{ reject: false }` that
// keeps a pre-existing label from aborting the launch, or turn three sequential awaits into a
// concurrent `Promise.all` — and every one of those is invisible to the assertions the suite
// had. Measured before this file: the only pre-existing checks were
// `calls.some((c) => c.key.startsWith('gh label create'))` in start.launch-box.qa.test.js and
// a single `'exec:gh label create claude-working'` prefix in start.update-prompt.qa.test.js.
// Neither reads a whole argv, neither counts the calls, and neither looks at the options.
//
// So the three command lines are pinned here as LITERAL ARRAYS, byte for byte as start.js
// spelled them before #139 (read off the pre-refactor source, not off the new module) — which
// is deliberately the OPPOSITE posture to labels.seam.qa.test.js next door: that file proves
// the strings are DERIVED, this one proves the bytes are UNCHANGED. A refactor has to satisfy
// both at once, and a test that only imported MANAGED_LABELS would agree with whatever the
// module now says.
//
// Also here: the MANAGED / RALPH boundary as a NEGATIVE. `do-not-ralph` is the label a HUMAN
// applies to keep Ralph off an issue; a Ralph that created it would be publishing an offer to
// skip its own work. "It is absent from the specs" is asserted in labels.test.js; what is
// asserted here is the consequence — that no `gh label create` for it ever leaves the
// process, and that the loop emits three commands and not four.

import { describe, expect, it } from 'vitest'
import { Volume } from 'memfs'
import { startCommand } from './start.js'

const REPO = '/repo'
const HOME = '/home/me'

// The three command lines as start.js spelled them before #139 — name, then `--color`, then
// `--description`, one `await` each, in this order. Literals on purpose: see the header.
const EXPECTED_CREATE_ARGV = [
  ['label', 'create', 'claude-working', '--color', 'FFA500', '--description', 'Ralph loop in progress'],
  ['label', 'create', 'claude-failed', '--color', 'B60205', '--description', 'Ralph loop tried and gave up'],
  [
    'label',
    'create',
    'pending-merge',
    '--color',
    '0E8A16',
    '--description',
    'Ralph PR merged into staging branch, awaiting rollforward to default',
  ],
]

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
  }
}

// Records whole argv AND options, and measures CONCURRENCY: every call yields to the event
// loop before resolving, and the number of calls in flight at that moment is recorded. Three
// sequential `await`s can never exceed 1; a `Promise.all` over the specs reaches 3. That is
// the only way to tell the two apart from outside, and the difference matters — concurrent
// `gh label create` calls against one repo race, and their order in the recorded log stops
// being the order they were issued in.
function makeExec({ queue = '0', orphans = '' } = {}) {
  const calls = []
  let inFlight = 0
  let maxInFlight = 0
  const exec = async (cmd, args = [], options = {}) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    // Two turns of the microtask queue, so a batch of concurrently-started calls really is
    // observed overlapping rather than finishing in the order it was created.
    await Promise.resolve()
    await Promise.resolve()
    try {
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        if (args.includes('--search')) return { exitCode: 0, stdout: queue, stderr: '' }
        return { exitCode: 0, stdout: orphans, stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    } finally {
      inFlight -= 1
    }
  }
  exec.calls = calls
  exec.maxInFlight = () => maxInFlight
  return exec
}

const baseDeps = (overrides = {}) => ({
  cwd: REPO,
  stdout: makeStream(),
  stderr: makeStream(),
  exec: makeExec(),
  exists: () => false,
  loadEnv: () => ({}),
  hasCommand: () => true,
  ask: async () => true,
  update: async () => ({
    latestVersion: null,
    isNewer: false,
    shouldPrompt: false,
    source: 'disabled',
    updatedCache: null,
  }),
  sendWa: async () => ({ ok: true }),
  peekLock: () => null,
  home: HOME,
  processEnv: { RALPH_BANNER: 'off' },
  cacheFs: new Volume(),
  ...overrides,
})

const createsOf = (exec) =>
  exec.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'label' && c.args[1] === 'create')

describe('QA #139 — `gh label create` argv is byte-identical after the loop replaced three blocks', () => {
  it('emits exactly the three command lines, in the same order, with the same flag order', async () => {
    const deps = baseDeps()
    await startCommand(deps)
    expect(createsOf(deps.exec).map((c) => c.args)).toEqual(EXPECTED_CREATE_ARGV)
  })

  it('keeps `{ reject: false }` on every one — a label that already exists must not abort the launch', async () => {
    // `gh label create` exits non-zero on an existing label, and `ralph start` is expected to
    // be idempotent. If the loop dropped the options object, the SECOND `ralph start` in any
    // repo would throw out of step 6 instead of reaching the launch.
    const deps = baseDeps()
    await startCommand(deps)
    const creates = createsOf(deps.exec)
    expect(creates).toHaveLength(3)
    for (const call of creates) expect(call.options, call.key).toEqual({ reject: false })
  })

  it('issues them SEQUENTIALLY — never a concurrent batch', async () => {
    // The rewrite the loop invites: `await Promise.all(MANAGED_LABELS.map(…))`. It passes an
    // argv-equality test, and every ordering assertion in the suite, while turning three
    // ordered writes to one repo into a race.
    const deps = baseDeps()
    await startCommand(deps)
    expect(deps.exec.maxInFlight()).toBe(1)
  })

  it('runs them after the gh auth gate and before both `gh issue list` calls', async () => {
    // Position in the run, not just presence. The creates have to be inside the
    // `source !== 'folder'` block, after auth (an unauthenticated repo must abort rather than
    // fail three label writes first) and before the orphan sweep and the queue count, which
    // both read labels the creates are supposed to have guaranteed exist.
    const deps = baseDeps()
    await startCommand(deps)
    const keys = deps.exec.calls.map((c) => c.key)
    const auth = keys.indexOf('gh auth status')
    const firstCreate = keys.findIndex((k) => k.startsWith('gh label create'))
    const lastCreate = keys.reduce((acc, k, i) => (k.startsWith('gh label create') ? i : acc), -1)
    const orphanList = keys.findIndex((k) => k.startsWith('gh issue list --state open --label'))
    const queue = keys.findIndex((k) => k.startsWith('gh issue list --search'))
    expect(auth).toBeGreaterThanOrEqual(0)
    expect(firstCreate).toBeGreaterThan(auth)
    expect(orphanList).toBeGreaterThan(lastCreate)
    expect(queue).toBeGreaterThan(orphanList)
  })

  it('emits no `gh label create` at all under folder source', async () => {
    // Folder mode has no board. Pinned as a count of ZERO rather than as "no create for X",
    // so a loop that grew a fourth spec cannot leak one call into a run with no GitHub repo.
    const deps = baseDeps({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : ''),
      folderQueueCount: async () => 0,
    })
    await startCommand(deps)
    expect(createsOf(deps.exec)).toEqual([])
  })
})

describe('QA #139 — the MANAGED / RALPH boundary, asserted as a negative', () => {
  it('never creates `do-not-ralph` — the label a HUMAN applies to keep Ralph off an issue', async () => {
    const deps = baseDeps()
    await startCommand(deps)
    for (const call of createsOf(deps.exec)) {
      expect(call.args, call.key).not.toContain('do-not-ralph')
    }
    // ...and not by any other route either: no `gh` call in the whole run creates a label
    // named for the human's marker.
    const anyCreate = deps.exec.calls.filter((c) => c.key.includes('label create'))
    expect(anyCreate.every((c) => !c.key.includes('do-not-ralph'))).toBe(true)
  })

  it('creates three of the four labels the query excludes, and the fourth is exactly `do-not-ralph`', async () => {
    // The boundary as one statement, read off the SAME RUN: the names Ralph creates and the
    // names Ralph excludes come from one vocabulary, and the only member that is excluded
    // without being created is the human's. A fourth exclude-only label — or a created label
    // missing from the exclusion, which is the drift that makes the loop re-pick its own
    // in-flight work — fails here.
    const deps = baseDeps()
    await startCommand(deps)
    const created = createsOf(deps.exec).map((c) => c.args[2])
    const search = deps.exec.calls.find((c) => c.args.includes('--search'))
    const excluded = [...search.args[search.args.indexOf('--search') + 1].matchAll(/-label:(\S+)/g)].map(
      (m) => m[1],
    )
    expect(created).toHaveLength(3)
    expect(excluded).toHaveLength(4)
    for (const name of created) expect(excluded, name).toContain(name)
    expect(excluded.filter((name) => !created.includes(name))).toEqual(['do-not-ralph'])
  })

  it('sweeps orphans under the same label it created first', async () => {
    // Two halves of one mechanism seen in one run: the label step 6 creates and the label
    // step 7 hunts. They were two literals before #139; if they ever disagree, an interrupted
    // run's issues are permanently invisible to a query that still excludes them.
    const deps = baseDeps()
    await startCommand(deps)
    const created = createsOf(deps.exec).map((c) => c.args[2])
    const list = deps.exec.calls.find(
      (c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args.includes('--label'),
    )
    expect(list.args[list.args.indexOf('--label') + 1]).toBe(created[0])
  })
})
