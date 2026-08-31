import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { startCommand, StartAbort } from '../../lib/commands/start.js'
import { templatePath } from '../../lib/paths.js'
import { sessionNameFor } from '../../lib/lock.js'
import { globalConfigPath } from '../../lib/utils/global-config.js'
import { readVersionCache, versionCachePath } from '../../lib/version-cache.js'
// #141: the retired spellings, as data. See the migration-warning describe below for why this
// file composes them instead of typing them.
import { LEGACY_LABELS } from '../../lib/labels.js'

const RALPH_TEMPLATE = templatePath('ralph.sh')

// Per-project session name used across the suite. startCommand derives the
// session name from cwd via sessionNameFor; tests default to cwd '/repo'.
const SESSION = sessionNameFor('/repo')

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

function makeExec(handlers) {
  const calls = []
  const exec = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    if (handlers[key]) {
      const v = handlers[key]
      return typeof v === 'function' ? v() : v
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

// #24: home/processEnv/cacheFs are injected on every run so the weekly update
// check resolves its global cache inside memfs and never reads or writes the
// developer's real ~/.config/ralph.
const HOME = '/home/me'

const baseDeps = () => ({
  cwd: '/repo',
  stdout: makeStream(),
  stderr: makeStream(),
  stdin: process.stdin,
  exists: () => false,
  loadEnv: () => ({}),
  hasCommand: () => true,
  ask: async () => false,
  home: HOME,
  processEnv: {},
  cacheFs: new Volume(),
})

// #24/#25: the shared update-flow harness. A full github-source preflight that
// gets all the way to the tmux launch, with a newer version (0.2.0) published on
// the registry, plus the deps every update test starts from. Hoisted to module
// scope so the #24 notice block and the #25 prompt block drive one identical
// preflight — a divergence between them would hide a regression in either.
const ORPHAN_KEY =
  'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"'
const QUEUE_KEY =
  'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length'
const NPM_VIEW = 'npm view @lucasfe/ralph version'
const LAUNCH_KEY = `tmux new -d -s ${SESSION} cd '/repo' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
const T0 = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

const preflight = (overrides = {}) => ({
  [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
  'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
  [ORPHAN_KEY]: { exitCode: 0, stdout: '', stderr: '' },
  [QUEUE_KEY]: { exitCode: 0, stdout: '1', stderr: '' },
  [NPM_VIEW]: { exitCode: 0, stdout: '0.2.0\n', stderr: '' },
  [LAUNCH_KEY]: { exitCode: 0, stdout: '', stderr: '' },
  ...overrides,
})

const updateDeps = (overrides = {}) => {
  const deps = baseDeps()
  deps.currentVersion = '0.1.0'
  deps.now = () => T0
  Object.assign(deps, overrides)
  return deps
}

describe('startCommand', () => {
  it('aborts when this project tmux session already exists', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain(`tmux session '${SESSION}' already exists.`)
    // The error hint prints the per-project attach / kill commands.
    expect(deps.stdout.output()).toContain(`tmux attach -t ${SESSION}`)
    expect(deps.stdout.output()).toContain(`tmux kill-session -t ${SESSION}`)
  })

  it('uses the per-project derived session name, not the literal "ralph"', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    // The uniqueness check targets the derived name and never the literal "ralph".
    expect(deps.exec.calls).toContain(`tmux has-session -t ${SESSION}`)
    expect(deps.exec.calls.some((c) => c === 'tmux has-session -t ralph')).toBe(false)
  })

  it('is not blocked when only another project’s session exists', async () => {
    const deps = baseDeps()
    // Another project's session ("ralph-other-...") is present; ours is not.
    // has-session for OUR derived name returns non-zero, so start proceeds past
    // the uniqueness check even though some other session exists.
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      [`tmux has-session -t ${sessionNameFor('/other-project')}`]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    const result = await startCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stderr.output()).not.toContain('already exists')
  })

  it('aborts when a critical command is missing', async () => {
    const deps = baseDeps()
    deps.hasCommand = (cmd) => cmd !== 'git'
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain("❌ 'git' not found in PATH")
  })

  it('warns but does not abort when a non-critical command is missing', async () => {
    const deps = baseDeps()
    deps.hasCommand = (cmd) => cmd !== 'jq'
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    const result = await startCommand(deps)
    expect(result.exitCode).toBe(0)
    expect(deps.stdout.output()).toContain("⚠️  'jq' not found (optional)")
  })

  it('aborts when gh auth status fails', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 1, stdout: '', stderr: '' },
    })
    await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain('gh not authenticated')
  })

  it('aborts when .mcp.json is invalid', async () => {
    const deps = baseDeps()
    deps.exists = (p) => p.endsWith('.mcp.json')
    const workSession = sessionNameFor('/work')
    deps.exec = makeExec({
      [`tmux has-session -t ${workSession}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'jq -e . /work/.mcp.json': { exitCode: 1, stdout: '', stderr: '' },
    })
    await expect(startCommand({ ...deps, cwd: '/work' })).rejects.toBeInstanceOf(StartAbort)
    expect(deps.stderr.output()).toContain('.mcp.json has invalid JSON')
  })

  it('exits 0 without launching when queue is empty', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    const result = await startCommand(deps)
    expect(result).toEqual({ exitCode: 0, started: false })
    expect(deps.stdout.output()).toContain('No issues in the queue')
    expect(deps.exec.calls.some((c) => c.startsWith(`tmux new -d -s ${SESSION}`))).toBe(false)
  })

  it('launches tmux when queue has issues, with the derived name and RALPH_TMUX_SESSION injected', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '3', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    const result = await startCommand({ ...deps, cwd })
    expect(result).toEqual({ exitCode: 0, started: true, count: 3 })
    expect(deps.stdout.output()).toContain('Ralph started in background. 3 issues in the queue.')
    // The launch targets the derived name and injects RALPH_TMUX_SESSION into the loop env.
    expect(deps.exec.calls).toContain(launchKey)
    // Success message prints the per-project attach / kill commands.
    expect(deps.stdout.output()).toContain(`tmux attach -t ${SESSION}`)
    expect(deps.stdout.output()).toContain(`tmux kill-session -t ${SESSION}`)
  })

  it('injects RALPH_TMUX_SESSION matching the cwd-derived name for a different project', async () => {
    const deps = baseDeps()
    const cwd = '/other-project'
    const session = sessionNameFor(cwd)
    const launchKey = `tmux new -d -s ${session} cd '${cwd}' && RALPH_TMUX_SESSION='${session}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${session}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      [launchKey]: { exitCode: 0, stdout: '', stderr: '' },
    })
    const result = await startCommand({ ...deps, cwd })
    expect(result.started).toBe(true)
    expect(deps.exec.calls).toContain(launchKey)
    expect(session).not.toBe(SESSION)
  })

  it('warns about orphan in-progress labels and never removes them automatically', async () => {
    const deps = baseDeps()
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '  #42 stuck\n  #43 also stuck',
        stderr: '',
      },
      'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '0', stderr: '' },
    })
    await startCommand(deps)
    expect(deps.stdout.output()).toContain("⚠️  Issues with the 'in-progress' label")
    expect(deps.stdout.output()).toContain('Keeping labels')
    expect(deps.stdout.output()).toContain('gh issue edit <n> --remove-label in-progress')
    expect(deps.exec.calls.some((c) => c.includes('--remove-label'))).toBe(false)
  })

  // #141: the retired-label migration warning, beside the orphan notice above and in the same
  // class — something from a previous state of the world needs a human.
  //
  // #140 renamed the two labels the loop stamps without touching anybody's board, on purpose:
  // Ralph has never run `gh label edit` for a user. So a repository upgraded past #140 with the
  // retired in-progress spelling still on live issues loses those issues twice over — the
  // exclusion query spells `in-progress`, so the loop hands one out as fresh work, and the orphan
  // sweep above lists `--label in-progress`, so it cannot see them to report them either.
  //
  // THE RETIRED NAMES ARE COMPOSED HERE, NEVER TYPED, and that is not a style preference: this
  // file is tracked, and lib/labels.parity.test.js sweeps every tracked file outside
  // test/helpers/legacy-label-sweep.js's three-file exemption list for a retired spelling. Typing
  // either retired name below is a red test in that spec, correctly — it is the spelling #140
  // exists to have removed, and writing it back into a tracked file un-lands the rename by one
  // file. (Measured the hard way: the first draft of this very comment spelled one out in prose
  // and the sweep reported it.) Off LEGACY_LABELS' keys instead, which is also how the sweep
  // itself builds its needles.
  describe('legacy label migration warning (#141)', () => {
    const [LEGACY_IN_PROGRESS, LEGACY_FAILED] = Object.keys(LEGACY_LABELS)
    const LABEL_LIST_KEY = 'gh label list --limit 100 --json name'

    // `gh label list --json name` answers with objects, not bare names.
    const labelListing = (...names) => JSON.stringify(names.map((name) => ({ name })))

    // A full github-source preflight that reaches the tmux launch, so every case below can
    // assert the run was not aborted as well as what it printed.
    const legacyPreflight = (listStdout) =>
      makeExec(
        preflight({
          [QUEUE_KEY]: { exitCode: 0, stdout: '1', stderr: '' },
          [LABEL_LIST_KEY]: { exitCode: 0, stdout: listStdout, stderr: '' },
        }),
      )

    // The whole command a user is meant to paste, spelled out rather than assembled from the
    // module: this file's job is to disagree with start.js, not to follow it.
    const MIGRATE_IN_PROGRESS =
      `gh label edit ${LEGACY_IN_PROGRESS} --name in-progress` +
      " --description 'Ralph loop in progress'"
    const MIGRATE_FAILED =
      `gh label edit ${LEGACY_FAILED} --name failed` +
      " --description 'Ralph loop tried and gave up'"

    it('names the retired label, the exact command, and what it costs until it is run', async () => {
      const deps = updateDeps()
      deps.exec = legacyPreflight(labelListing('in-progress', LEGACY_IN_PROGRESS, 'bug'))
      const result = await startCommand(deps)
      const out = deps.stdout.output()
      expect(out).toContain(`⚠️  Retired label '${LEGACY_IN_PROGRESS}' still exists on this board`)
      expect(out).toContain(MIGRATE_IN_PROGRESS)
      // The consequence, in the warning itself, in BOTH of its halves. "Rename this label"
      // without them reads like tidying, and the first draft's single line read worse than
      // that — it said the issues were invisible to Ralph, which is the inverse of what this
      // very run does. The queue below excludes the CURRENT names, so an issue whose only Ralph
      // label is the retired one is selected by it, as fresh work, at an invocation a pass. The
      // thing that cannot see those issues is the orphan sweep, which lists `in-progress`.
      expect(out).toContain('no longer excluded from the queue')
      expect(out).toContain('picks them up again as fresh work')
      expect(out).toContain('The orphan sweep can no longer see them either')
      // The false claim, pinned as absent so it cannot come back as a reword.
      expect(out).not.toContain('invisible to Ralph')
      // ...and the run is not over: a nuisance is not a broken setup.
      expect(result.started).toBe(true)
      expect(result.exitCode).toBe(0)
      expect(deps.exec.calls).toContain(LAUNCH_KEY)
    })

    it('says nothing when the board carries only the current names', async () => {
      const deps = updateDeps()
      deps.exec = legacyPreflight(
        labelListing('in-progress', 'failed', 'pending-merge', 'do-not-ralph'),
      )
      const result = await startCommand(deps)
      expect(deps.stdout.output()).not.toContain('Retired label')
      expect(deps.stdout.output()).not.toContain('gh label edit')
      expect(result.started).toBe(true)
    })

    it('reports both retired labels, each with its own command', async () => {
      const deps = updateDeps()
      deps.exec = legacyPreflight(labelListing(LEGACY_FAILED, LEGACY_IN_PROGRESS))
      const result = await startCommand(deps)
      const out = deps.stdout.output()
      expect(out).toContain(`⚠️  Retired label '${LEGACY_IN_PROGRESS}' still exists on this board`)
      expect(out).toContain(`⚠️  Retired label '${LEGACY_FAILED}' still exists on this board`)
      expect(out).toContain(MIGRATE_IN_PROGRESS)
      expect(out).toContain(MIGRATE_FAILED)
      // Two commands and not one generic instruction: the names differ and so do the
      // descriptions, so a single line could not be pasted for either.
      expect(out.split('gh label edit')).toHaveLength(3)
      expect(result.started).toBe(true)
    })

    it('stays silent, and still launches, when the label list fails', async () => {
      const deps = updateDeps()
      deps.exec = makeExec(
        preflight({
          [QUEUE_KEY]: { exitCode: 0, stdout: '1', stderr: '' },
          [LABEL_LIST_KEY]: { exitCode: 1, stdout: '', stderr: 'gh: HTTP 403' },
        }),
      )
      const result = await startCommand(deps)
      expect(deps.stdout.output()).not.toContain('Retired label')
      expect(deps.stderr.output()).not.toContain('Retired label')
      expect(result.started).toBe(true)
      expect(result.exitCode).toBe(0)
    })

    it('never renames anything itself — the command is printed, never spent', async () => {
      const deps = updateDeps()
      deps.exec = legacyPreflight(labelListing(LEGACY_IN_PROGRESS, LEGACY_FAILED))
      await startCommand(deps)
      expect(deps.stdout.output()).toContain(MIGRATE_IN_PROGRESS)
      expect(deps.exec.calls.some((c) => c.startsWith('gh label edit'))).toBe(false)
    })

    it('attempts no label list at all under TASK_SOURCE=folder', async () => {
      // Folder mode has no board: it tracks progress through the .ralph/tasks status
      // directories, so there is no label to be retired and nothing to warn about. Asserted as
      // the ABSENCE OF THE CALL and not just the absence of the line — a folder run that asked
      // gh anyway would be a network round trip on the one source that never needs gh, and it
      // would be silent, so nothing else in the suite could see it.
      const deps = updateDeps()
      deps.processEnv = { TASK_SOURCE: 'folder' }
      deps.folderQueueCount = async () => 1
      deps.exec = legacyPreflight(labelListing(LEGACY_IN_PROGRESS, LEGACY_FAILED))
      const result = await startCommand(deps)
      expect(deps.exec.calls.some((c) => c.startsWith('gh label list'))).toBe(false)
      expect(deps.stdout.output()).not.toContain('Retired label')
      expect(result.started).toBe(true)
    })
  })

  // #24: the weekly, cache-backed update notice. It replaced the old step-8.5
  // block, which sat AFTER the empty-queue early return (so a user with an empty
  // queue never saw it) and after every gh call. It now runs once, right after
  // the dependency guard and before the first gh invocation.
  describe('weekly update check (#24)', () => {
    const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })

    it('prints a notice on stdout when a newer version is published', async () => {
      const deps = updateDeps()
      deps.exec = makeExec(preflight())
      const result = await startCommand(deps)
      expect(result.started).toBe(true)
      expect(deps.stdout.output()).toContain('New version available: 0.2.0')
    })

    it('prints the notice even when the issue queue is empty', async () => {
      const deps = updateDeps()
      deps.exec = makeExec(preflight({ [QUEUE_KEY]: { exitCode: 0, stdout: '0', stderr: '' } }))
      const result = await startCommand(deps)
      expect(result).toEqual({ exitCode: 0, started: false })
      expect(deps.stdout.output()).toContain('No issues in the queue')
      expect(deps.stdout.output()).toContain('New version available: 0.2.0')
    })

    it('prints nothing when the published version is not newer', async () => {
      const deps = updateDeps({ currentVersion: '0.2.0' })
      deps.exec = makeExec(preflight())
      await startCommand(deps)
      expect(deps.stdout.output()).not.toContain('New version available')
    })

    it('runs the check before the first gh invocation', async () => {
      const deps = updateDeps()
      deps.exec = makeExec(preflight())
      await startCommand(deps)
      const npmIdx = deps.exec.calls.indexOf(NPM_VIEW)
      const firstGh = deps.exec.calls.findIndex((c) => c.startsWith('gh '))
      expect(npmIdx).toBeGreaterThanOrEqual(0)
      expect(firstGh).toBeGreaterThanOrEqual(0)
      expect(npmIdx).toBeLessThan(firstGh)
    })

    it('does not check when this project already has a tmux session', async () => {
      const deps = updateDeps()
      deps.exec = makeExec(
        preflight({ [`tmux has-session -t ${SESSION}`]: { exitCode: 0, stdout: '', stderr: '' } }),
      )
      await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
      expect(deps.exec.calls).not.toContain(NPM_VIEW)
    })

    it('does not check when an alive cycle lock is held', async () => {
      const deps = updateDeps()
      deps.peekLock = () => ({
        holder: { pid: 99, startedAt: '2026-08-22T10:00:00.000Z', repoPath: '/repo' },
        alive: true,
      })
      deps.exec = makeExec(preflight())
      await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
      expect(deps.exec.calls).not.toContain(NPM_VIEW)
    })

    it('does not check when a critical dependency is missing', async () => {
      const deps = updateDeps()
      deps.hasCommand = (cmd) => cmd !== 'git'
      deps.exec = makeExec(preflight())
      await expect(startCommand(deps)).rejects.toBeInstanceOf(StartAbort)
      expect(deps.exec.calls).not.toContain(NPM_VIEW)
    })

    it('makes only one npm view call across two runs inside 7 days', async () => {
      const cacheFs = new Volume()
      const first = updateDeps({ cacheFs })
      first.exec = makeExec(preflight())
      await startCommand(first)
      const second = updateDeps({ cacheFs, now: () => T0 + 3 * DAY })
      second.exec = makeExec(preflight())
      await startCommand(second)
      expect(first.exec.calls.filter((c) => c === NPM_VIEW)).toHaveLength(1)
      expect(second.exec.calls.filter((c) => c === NPM_VIEW)).toHaveLength(0)
      // The notice still fires on the throttled run — from the cached version.
      expect(second.stdout.output()).toContain('New version available: 0.2.0')
    })

    it('makes a fresh npm view call and re-stamps last_check_at after 7 days', async () => {
      const cacheFs = new Volume()
      const first = updateDeps({ cacheFs })
      first.exec = makeExec(preflight())
      await startCommand(first)
      const later = T0 + 8 * DAY
      const second = updateDeps({ cacheFs, now: () => later })
      second.exec = makeExec(preflight())
      await startCommand(second)
      expect(second.exec.calls.filter((c) => c === NPM_VIEW)).toHaveLength(1)
      expect(readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} })).toEqual({
        last_check_at: new Date(later).toISOString(),
        last_prompted_at: null,
        latest_version: '0.2.0',
      })
    })

    it('writes the cache under $XDG_CONFIG_HOME when it is set', async () => {
      const cacheFs = new Volume()
      const deps = updateDeps({ cacheFs, processEnv: { XDG_CONFIG_HOME: '/xdg' } })
      deps.exec = makeExec(preflight())
      await startCommand(deps)
      expect(cacheFs.existsSync(join('/xdg', 'ralph', 'update-check.json'))).toBe(true)
      expect(cacheFs.existsSync(CACHE_PATH)).toBe(false)
    })

    it('writes the cache under ~/.config when XDG_CONFIG_HOME is unset', async () => {
      const cacheFs = new Volume()
      const deps = updateDeps({ cacheFs })
      deps.exec = makeExec(preflight())
      await startCommand(deps)
      expect(cacheFs.existsSync(CACHE_PATH)).toBe(true)
    })

    it('leaves the existing global .env untouched', async () => {
      const envPath = globalConfigPath({ processEnv: {}, home: HOME })
      const envContent = 'CALLMEBOT_KEY=secret\nWHATSAPP_PHONE=+1\n'
      const cacheFs = Volume.fromJSON({ [envPath]: envContent }, '/')
      const deps = updateDeps({ cacheFs })
      deps.exec = makeExec(preflight())
      await startCommand(deps)
      expect(cacheFs.readFileSync(envPath, 'utf8')).toBe(envContent)
      expect(cacheFs.readFileSync(CACHE_PATH, 'utf8')).not.toContain('CALLMEBOT_KEY')
    })

    it('suppresses the check with no npm call and no output when RALPH_NO_UPDATE_CHECK=1', async () => {
      const cacheFs = new Volume()
      const deps = updateDeps({ cacheFs, processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
      deps.exec = makeExec(preflight())
      const result = await startCommand(deps)
      expect(result.started).toBe(true)
      expect(deps.exec.calls).not.toContain(NPM_VIEW)
      expect(deps.stdout.output()).not.toContain('New version available')
      expect(cacheFs.existsSync(CACHE_PATH)).toBe(false)
    })

    it('survives a corrupt cache file and still notices the new version', async () => {
      const cacheFs = Volume.fromJSON({ [CACHE_PATH]: '{ not json at all' }, '/')
      const deps = updateDeps({ cacheFs })
      deps.exec = makeExec(preflight())
      const result = await startCommand(deps)
      expect(result.started).toBe(true)
      expect(deps.stdout.output()).toContain('New version available: 0.2.0')
    })

    it('is silent and non-blocking when the version check fails', async () => {
      const deps = updateDeps()
      deps.exec = makeExec(
        preflight({ [NPM_VIEW]: { exitCode: 1, stdout: '', stderr: 'offline' } }),
      )
      const result = await startCommand(deps)
      expect(result.started).toBe(true)
      expect(deps.stdout.output()).not.toContain('New version available')
      expect(deps.stderr.output()).toBe('')
    })

    it('passes currentVersion, exec, now, processEnv, home and fs to the decision', async () => {
      const seen = []
      const deps = updateDeps({
        processEnv: { FOO: 'bar' },
        update: async (args) => {
          seen.push(args)
          return {
            latestVersion: null,
            isNewer: false,
            shouldPrompt: false,
            source: 'network',
            updatedCache: null,
          }
        },
      })
      deps.exec = makeExec(preflight())
      await startCommand(deps)
      expect(seen).toHaveLength(1)
      expect(seen[0].currentVersion).toBe('0.1.0')
      expect(seen[0].exec).toBe(deps.exec)
      expect(seen[0].now).toBe(deps.now)
      expect(seen[0].processEnv).toBe(deps.processEnv)
      expect(seen[0].home).toBe(HOME)
      expect(seen[0].fs).toBe(deps.cacheFs)
    })
  })

  // #25: #24's passive notice becomes a question when stdin is interactive.
  // Yes delegates to the `ralph update` machinery and returns WITHOUT starting
  // the loop (the running process holds pre-update module state and an old
  // templates/ralph.sh path, so a half-swapped loop is never launched); no
  // starts the loop immediately; an accepted update that fails warns and still
  // starts the loop on the current version.
  //
  // isTTY is passed EXPLICITLY in every test here so the ambient terminal can
  // never decide the outcome — the suite must behave identically under a TTY,
  // under CI, and under a piped `npm test`.
  describe('TTY-gated update prompt (#25)', () => {
    const PROMPT = 'Update now? [y/N]: '

    // Records what was asked and what runUpdate was handed, so the wiring is
    // asserted rather than inferred from output.
    const promptDeps = (overrides = {}) => {
      const asked = []
      const updates = []
      const deps = updateDeps({
        isTTY: true,
        ask: async (question, options) => {
          asked.push({ question, options })
          return true
        },
        runUpdate: async (args) => {
          updates.push(args)
          return { exitCode: 0, updated: true, from: '0.1.0', to: '0.2.0' }
        },
        ...overrides,
      })
      deps.asked = asked
      deps.updates = updates
      deps.exec = makeExec(preflight())
      return deps
    }

    it('asks whether to update when stdin is a TTY and a newer version is published', async () => {
      const deps = promptDeps()
      await startCommand(deps)
      expect(deps.asked).toHaveLength(1)
      expect(deps.asked[0].question).toBe(PROMPT)
      // #25: the first real use of the already-declared `stdin` param.
      expect(deps.asked[0].options.input).toBe(deps.stdin)
      expect(deps.asked[0].options.output).toBe(deps.stdout)
    })

    it('keeps #24’s notice on the TTY path and asks after it', async () => {
      // The ordering half of the name is asserted, not assumed: `ask` records
      // whether the notice was already on stdout at the moment it was called.
      let asks = 0
      let noticeAlreadyPrinted = null
      const deps = promptDeps({
        ask: async () => {
          asks += 1
          noticeAlreadyPrinted = deps.stdout.output().includes('New version available: 0.2.0')
          return true
        },
      })
      await startCommand(deps)
      const lines = deps.stdout.output().split('\n').filter(Boolean)
      const notices = lines.filter((l) => l.includes('New version available: 0.2.0'))
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain('npm i -g @lucasfe/ralph')
      expect(asks).toBe(1)
      expect(noticeAlreadyPrinted).toBe(true)
    })

    it('accepting runs the update and returns without starting the loop', async () => {
      const deps = promptDeps()
      const result = await startCommand(deps)
      expect(result).toEqual({ exitCode: 0, started: false })
      expect(deps.updates).toHaveLength(1)
      expect(deps.updates[0].currentVersion).toBe('0.1.0')
      expect(deps.updates[0].exec).toBe(deps.exec)
      expect(deps.updates[0].stdout).toBe(deps.stdout)
      expect(deps.updates[0].stderr).toBe(deps.stderr)
      const out = deps.stdout.output()
      expect(out).toContain('Updated to 0.2.0')
      expect(out).toContain('run `ralph start` again')
      // The loop was never launched — no half-swapped mixture of two versions.
      expect(deps.exec.calls).not.toContain(LAUNCH_KEY)
      expect(deps.exec.calls.some((c) => c.startsWith('tmux new '))).toBe(false)
    })

    it('never re-execs and never spawns a background install on the accept path', async () => {
      const deps = promptDeps()
      await startCommand(deps)
      // Only the tmux uniqueness guard and the version check ran: the update
      // itself goes through the injected runUpdate, not a spawn from here.
      expect(deps.exec.calls).toEqual([`tmux has-session -t ${SESSION}`, NPM_VIEW])
    })

    it('asks before the first gh invocation, so accepting discards no completed work', async () => {
      const deps = promptDeps()
      await startCommand(deps)
      expect(deps.asked).toHaveLength(1)
      expect(deps.exec.calls.some((c) => c.startsWith('gh '))).toBe(false)
    })

    it('declining starts the loop immediately with no further update output', async () => {
      const deps = promptDeps({ ask: async () => false })
      const result = await startCommand(deps)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(deps.updates).toHaveLength(0)
      expect(deps.exec.calls).toContain(LAUNCH_KEY)
      const out = deps.stdout.output()
      expect(out).toContain('New version available: 0.2.0')
      expect(out).not.toContain('Updated to')
      expect(out).not.toContain('Update did not complete')
      expect(deps.stderr.output()).toBe('')
    })

    it('warns and still launches the loop when an accepted update fails', async () => {
      const deps = promptDeps({
        runUpdate: async () => ({ exitCode: 1, updated: false, from: '0.1.0', to: '0.2.0' }),
      })
      const result = await startCommand(deps)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(deps.stdout.output()).toContain('Update did not complete')
      expect(deps.stdout.output()).toContain('0.1.0')
      expect(deps.exec.calls).toContain(LAUNCH_KEY)
    })

    it('warns and still launches when there is nothing to update here (npx / linked checkout)', async () => {
      // updateCommand's advice path exits 0 with updated:false — gating on `to`
      // instead of `updated` would wrongly report a successful update.
      const deps = promptDeps({
        runUpdate: async () => ({ exitCode: 0, updated: false, from: '0.1.0', to: '0.2.0' }),
      })
      const result = await startCommand(deps)
      expect(result.started).toBe(true)
      expect(deps.stdout.output()).toContain('Update did not complete')
      expect(deps.stdout.output()).not.toContain('Updated to 0.2.0')
    })

    it('warns and still launches when the update throws', async () => {
      const deps = promptDeps({
        runUpdate: async () => {
          throw new Error('npm exploded')
        },
      })
      const result = await startCommand(deps)
      expect(result.started).toBe(true)
      expect(deps.stdout.output()).toContain('Update did not complete')
      expect(deps.exec.calls).toContain(LAUNCH_KEY)
    })

    it('prints the notice, never calls confirm, and launches when stdin is not a TTY', async () => {
      const deps = promptDeps({
        isTTY: false,
        ask: async () => {
          throw new Error('confirm must never be called without a TTY')
        },
      })
      const result = await startCommand(deps)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(deps.updates).toHaveLength(0)
      expect(deps.stdout.output()).toContain('New version available: 0.2.0')
      expect(deps.exec.calls).toContain(LAUNCH_KEY)
    })

    it('does not prompt when the published version is not newer, even on a TTY', async () => {
      const deps = promptDeps({ currentVersion: '0.2.0' })
      const result = await startCommand(deps)
      expect(result.started).toBe(true)
      expect(deps.asked).toHaveLength(0)
      expect(deps.updates).toHaveLength(0)
    })

    it('suppresses the prompt along with the check when RALPH_NO_UPDATE_CHECK=1', async () => {
      const deps = promptDeps({ processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
      const result = await startCommand(deps)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(deps.asked).toHaveLength(0)
      expect(deps.updates).toHaveLength(0)
      expect(deps.exec.calls).not.toContain(NPM_VIEW)
      expect(deps.stdout.output()).not.toContain('New version available')
    })
  })

  // #26: the SECOND weekly window. #24's last_check_at throttles the network
  // call; last_prompted_at throttles the QUESTION, independently, off the same
  // interval. Net behaviour: at most one prompt per 7 days however many times
  // `ralph start` runs and however many repos are involved, while #24's notice
  // keeps printing on every isNewer run. Declining is remembered only until the
  // window rolls over — there is deliberately no declined_version field.
  //
  // isTTY is passed EXPLICITLY here too: the stamp is written when a prompt is
  // SHOWN, so a suite that let the ambient terminal decide would write the cache
  // on some machines and not others.
  describe('weekly prompt throttle + offline prompt-from-cache (#26)', () => {
    const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
    const NOTICE = 'New version available: 0.2.0'
    const OFFLINE = { exitCode: 1, stdout: '', stderr: 'offline' }

    // The whole preflight for an arbitrary cwd — needed because the tmux guard
    // and launch keys are derived from the per-project session name, so a
    // second-repo run cannot reuse /repo's handlers.
    const preflightFor = (cwd, overrides = {}) => {
      const session = sessionNameFor(cwd)
      return {
        [`tmux has-session -t ${session}`]: { exitCode: 1, stdout: '', stderr: '' },
        'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
        [ORPHAN_KEY]: { exitCode: 0, stdout: '', stderr: '' },
        [QUEUE_KEY]: { exitCode: 0, stdout: '1', stderr: '' },
        [NPM_VIEW]: { exitCode: 0, stdout: '0.2.0\n', stderr: '' },
        [`tmux new -d -s ${session} cd '${cwd}' && RALPH_TMUX_SESSION='${session}' bash '${RALPH_TEMPLATE}'`]:
          { exitCode: 0, stdout: '', stderr: '' },
        ...overrides,
      }
    }

    // One interactive run. `answer` is what the user types at the prompt; every
    // ask is recorded so "at most one prompt" is counted, not inferred.
    const run = async ({ answer = false, cwd = '/repo', execOverrides, ...overrides } = {}) => {
      const asked = []
      const updates = []
      const deps = updateDeps({
        cwd,
        isTTY: true,
        ask: async (question, options) => {
          asked.push({ question, options })
          return answer
        },
        runUpdate: async (args) => {
          updates.push(args)
          return { exitCode: 0, updated: false, from: '0.1.0', to: '0.2.0' }
        },
        ...overrides,
      })
      deps.exec = makeExec(preflightFor(cwd, execOverrides))
      deps.asked = asked
      deps.updates = updates
      const result = await startCommand(deps)
      return { deps, result, asked, updates, npmViews: deps.exec.calls.filter((c) => c === NPM_VIEW) }
    }

    const cacheOf = (cacheFs, processEnv = {}) =>
      readVersionCache({ fs: cacheFs, home: HOME, processEnv })

    const seededCache = (cache) => Volume.fromJSON({ [CACHE_PATH]: JSON.stringify(cache) }, '/')

    it('being prompted writes last_prompted_at to the global cache', async () => {
      const cacheFs = new Volume()
      const { asked } = await run({ cacheFs })
      expect(asked).toHaveLength(1)
      expect(cacheOf(cacheFs)).toEqual({
        last_check_at: new Date(T0).toISOString(),
        last_prompted_at: new Date(T0).toISOString(),
        latest_version: '0.2.0',
      })
    })

    it('a DECLINED prompt is not repeated inside the window, but the notice still prints', async () => {
      const cacheFs = new Volume()
      const first = await run({ cacheFs, answer: false })
      const second = await run({ cacheFs, answer: false, now: () => T0 + 3 * DAY })
      expect(first.asked).toHaveLength(1)
      expect(second.asked).toHaveLength(0)
      expect(second.result).toEqual({ exitCode: 0, started: true, count: 1 })
      // #24's contract survives the throttle: the notice is not the question.
      expect(second.deps.stdout.output()).toContain(NOTICE)
    })

    it('an ACCEPTED prompt is not repeated inside the window either', async () => {
      // The install did not take (npx run / linked checkout), so the same version
      // is still newer on the next run — and is still not re-asked.
      const cacheFs = new Volume()
      const first = await run({ cacheFs, answer: true })
      expect(first.updates).toHaveLength(1)
      const second = await run({ cacheFs, answer: true, now: () => T0 + DAY })
      expect(second.asked).toHaveLength(0)
      expect(second.updates).toHaveLength(0)
      expect(second.result).toEqual({ exitCode: 0, started: true, count: 1 })
    })

    it('runs inside the window ask exactly once however many times start is run', async () => {
      const cacheFs = new Volume()
      const asks = []
      for (const now of [T0, T0 + 60_000, T0 + DAY, T0 + 6 * DAY]) {
        const { asked } = await run({ cacheFs, answer: false, now: () => now })
        asks.push(asked.length)
      }
      expect(asks).toEqual([1, 0, 0, 0])
    })

    it('offers the same still-newer version again once the prompt window elapses', async () => {
      const cacheFs = new Volume()
      await run({ cacheFs, answer: false })
      const later = T0 + 8 * DAY
      const second = await run({ cacheFs, answer: false, now: () => later })
      expect(second.asked).toHaveLength(1)
      expect(second.deps.stdout.output()).toContain(NOTICE)
      expect(cacheOf(cacheFs).last_prompted_at).toBe(new Date(later).toISOString())
    })

    it('checks the registry WITHOUT prompting when only the check window is open', async () => {
      const cacheFs = seededCache({
        last_check_at: new Date(T0 - 8 * DAY).toISOString(),
        last_prompted_at: new Date(T0 - DAY).toISOString(),
        latest_version: '0.1.5',
      })
      const { asked, npmViews, deps, result } = await run({ cacheFs })
      expect(npmViews).toHaveLength(1)
      expect(asked).toHaveLength(0)
      expect(deps.stdout.output()).toContain(NOTICE)
      expect(result.started).toBe(true)
      // The check window was re-stamped; the prompt window was left alone.
      expect(cacheOf(cacheFs)).toEqual({
        last_check_at: new Date(T0).toISOString(),
        last_prompted_at: new Date(T0 - DAY).toISOString(),
        latest_version: '0.2.0',
      })
    })

    it('prompts WITHOUT checking the registry when only the prompt window is open', async () => {
      const cacheFs = seededCache({
        last_check_at: new Date(T0 - DAY).toISOString(),
        last_prompted_at: new Date(T0 - 8 * DAY).toISOString(),
        latest_version: '0.2.0',
      })
      const { asked, npmViews, deps } = await run({ cacheFs })
      expect(npmViews).toHaveLength(0)
      expect(asked).toHaveLength(1)
      expect(deps.stdout.output()).toContain(NOTICE)
      expect(cacheOf(cacheFs)).toEqual({
        last_check_at: new Date(T0 - DAY).toISOString(),
        last_prompted_at: new Date(T0).toISOString(),
        latest_version: '0.2.0',
      })
    })

    it('still prompts with the network unavailable and a cached newer version', async () => {
      const cacheFs = seededCache({
        last_check_at: new Date(T0 - 30 * DAY).toISOString(),
        last_prompted_at: null,
        latest_version: '0.2.0',
      })
      const { asked, npmViews, deps, result } = await run({
        cacheFs,
        answer: false,
        execOverrides: { [NPM_VIEW]: OFFLINE },
      })
      expect(npmViews).toHaveLength(1)
      expect(asked).toHaveLength(1)
      expect(deps.stdout.output()).toContain(NOTICE)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
    })

    it('is silent and starts the loop with the network unavailable and no useful cache', async () => {
      for (const cacheFs of [
        new Volume(),
        seededCache({
          last_check_at: new Date(T0 - DAY).toISOString(),
          last_prompted_at: null,
          latest_version: null,
        }),
        seededCache({
          last_check_at: new Date(T0 - DAY).toISOString(),
          last_prompted_at: null,
          latest_version: '0.1.0',
        }),
      ]) {
        const { asked, deps, result } = await run({
          cacheFs,
          execOverrides: { [NPM_VIEW]: OFFLINE },
        })
        expect(asked).toHaveLength(0)
        expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
        expect(deps.stdout.output()).not.toContain('New version available')
        expect(deps.stderr.output()).toBe('')
        // Nothing was prompted, so the prompt window stays open for a run that
        // does have something to offer.
        expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
      }
    })

    it('shares the prompt window across repos', async () => {
      const cacheFs = new Volume()
      const a = await run({ cacheFs, cwd: '/repo-a', answer: false })
      const b = await run({ cacheFs, cwd: '/repo-b', answer: false, now: () => T0 + 2 * DAY })
      expect(a.asked).toHaveLength(1)
      expect(b.asked).toHaveLength(0)
      expect(b.npmViews).toHaveLength(0)
      // Both really were different projects (per-project tmux session names)...
      expect(a.deps.exec.calls[0]).toContain(sessionNameFor('/repo-a'))
      expect(b.deps.exec.calls[0]).toContain(sessionNameFor('/repo-b'))
      // ...and the second one still got the notice, just not the question.
      expect(b.deps.stdout.output()).toContain(NOTICE)
    })

    it('writes no declined_version field — declining is remembered only by the window', async () => {
      const cacheFs = new Volume()
      await run({ cacheFs, answer: false })
      const raw = JSON.parse(cacheFs.readFileSync(CACHE_PATH, 'utf8').toString())
      expect(Object.keys(raw).sort()).toEqual([
        'last_check_at',
        'last_prompted_at',
        'latest_version',
      ])
      expect(raw.declined_version).toBeUndefined()
    })

    it('treats a last_prompted_at in the future as prompt due (clock skew)', async () => {
      const cacheFs = seededCache({
        last_check_at: new Date(T0 - DAY).toISOString(),
        last_prompted_at: new Date(T0 + 90 * DAY).toISOString(),
        latest_version: '0.2.0',
      })
      const { asked } = await run({ cacheFs, answer: false })
      expect(asked).toHaveLength(1)
      // The skewed stamp is corrected, never left to outlive every window.
      expect(cacheOf(cacheFs).last_prompted_at).toBe(new Date(T0).toISOString())
    })

    it('a NON-TTY run never stamps the window, so the next interactive run still prompts', async () => {
      // The headless case (cron, launchd, CI): the notice is printed, no question
      // is ever displayed, and the prompt window must survive intact.
      const cacheFs = new Volume()
      const headless = await run({
        cacheFs,
        isTTY: false,
        ask: async () => {
          throw new Error('confirm must never be called without a TTY')
        },
      })
      expect(headless.deps.stdout.output()).toContain(NOTICE)
      expect(cacheOf(cacheFs).last_prompted_at).toBeNull()
      const interactive = await run({ cacheFs, answer: false, now: () => T0 + DAY })
      expect(interactive.asked).toHaveLength(1)
      expect(cacheOf(cacheFs).last_prompted_at).toBe(new Date(T0 + DAY).toISOString())
    })

    it('a run whose prompt is throttled still stamps nothing new in the cache', async () => {
      const stamped = new Date(T0 - 2 * DAY).toISOString()
      const cacheFs = seededCache({
        last_check_at: new Date(T0 - DAY).toISOString(),
        last_prompted_at: stamped,
        latest_version: '0.2.0',
      })
      const before = cacheFs.readFileSync(CACHE_PATH, 'utf8').toString()
      const { asked, npmViews } = await run({ cacheFs })
      expect(asked).toHaveLength(0)
      expect(npmViews).toHaveLength(0)
      expect(cacheFs.readFileSync(CACHE_PATH, 'utf8').toString()).toBe(before)
    })

    it('an unwritable cache still prompts — the stamp is best-effort', async () => {
      const cacheFs = {
        readFileSync: () => {
          const e = new Error('ENOENT')
          e.code = 'ENOENT'
          throw e
        },
        mkdirSync: () => {
          const e = new Error('EACCES: permission denied')
          e.code = 'EACCES'
          throw e
        },
        writeFileSync: () => undefined,
      }
      const { asked, result, deps } = await run({ cacheFs, answer: false })
      expect(asked).toHaveLength(1)
      expect(result).toEqual({ exitCode: 0, started: true, count: 1 })
      expect(deps.stderr.output()).toBe('')
    })

    it('hands the stamp the same clock, env, home and fs as the decision', async () => {
      const stamps = []
      const cacheFs = new Volume()
      const { deps } = await run({ cacheFs, recordPrompt: (args) => stamps.push(args) })
      expect(stamps).toHaveLength(1)
      expect(stamps[0].now).toBe(deps.now)
      expect(stamps[0].processEnv).toBe(deps.processEnv)
      expect(stamps[0].home).toBe(HOME)
      expect(stamps[0].fs).toBe(cacheFs)
    })

    it('suppresses both windows on the RALPH_NO_UPDATE_CHECK opt-out', async () => {
      const cacheFs = new Volume()
      const { asked, npmViews, deps } = await run({
        cacheFs,
        processEnv: { RALPH_NO_UPDATE_CHECK: '1' },
      })
      expect(asked).toHaveLength(0)
      expect(npmViews).toHaveLength(0)
      expect(deps.stdout.output()).not.toContain('New version available')
      expect(cacheFs.existsSync(CACHE_PATH)).toBe(false)
    })
  })

  it('sends WhatsApp startup notification with default message when credentials are present', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    deps.exists = (p) => p.endsWith('.env.local')
    deps.loadEnv = () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' })
    const waCalls = []
    deps.sendWa = async (args) => {
      waCalls.push(args)
      return { ok: true }
    }
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '2', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    await startCommand({ ...deps, cwd })
    expect(waCalls).toHaveLength(1)
    expect(waCalls[0]).toEqual({
      phone: '+1',
      apiKey: 'k',
      message: '🟢 Ralph started and is active.',
    })
    expect(deps.stdout.output()).toContain('Startup WhatsApp notification sent.')
  })

  it('uses RALPH_STARTUP_MESSAGE override from .env.local when provided', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    deps.exists = (p) => p.endsWith('.env.local')
    deps.loadEnv = () => ({
      CALLMEBOT_KEY: 'k',
      WHATSAPP_PHONE: '+1',
      RALPH_STARTUP_MESSAGE: 'custom hello',
    })
    const waCalls = []
    deps.sendWa = async (args) => {
      waCalls.push(args)
      return { ok: true }
    }
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    await startCommand({ ...deps, cwd })
    expect(waCalls[0].message).toBe('custom hello')
  })

  it('skips WhatsApp startup notification when credentials are missing', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    let waCalled = false
    deps.sendWa = async () => {
      waCalled = true
      return { ok: true }
    }
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    const savedKey = process.env.CALLMEBOT_KEY
    const savedPhone = process.env.WHATSAPP_PHONE
    delete process.env.CALLMEBOT_KEY
    delete process.env.WHATSAPP_PHONE
    try {
      await startCommand({ ...deps, cwd })
    } finally {
      if (savedKey !== undefined) process.env.CALLMEBOT_KEY = savedKey
      if (savedPhone !== undefined) process.env.WHATSAPP_PHONE = savedPhone
    }
    expect(waCalled).toBe(false)
    expect(deps.stdout.output()).toContain('WhatsApp notifications will be skipped')
  })

  it('logs a warning but does not abort when WhatsApp startup notification fails', async () => {
    const deps = baseDeps()
    const cwd = '/repo'
    deps.exists = (p) => p.endsWith('.env.local')
    deps.loadEnv = () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' })
    deps.sendWa = async () => ({ ok: false, reason: 'http_500' })
    const launchKey = `tmux new -d -s ${SESSION} cd '${cwd}' && RALPH_TMUX_SESSION='${SESSION}' bash '${RALPH_TEMPLATE}'`
    deps.exec = makeExec({
      [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
      'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
        { exitCode: 0, stdout: '1', stderr: '' },
      [launchKey]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    })
    const result = await startCommand({ ...deps, cwd })
    expect(result.started).toBe(true)
    expect(deps.stdout.output()).toContain('Startup WhatsApp notification failed: http_500')
  })

  describe('cycle-lock coexistence', () => {
    it('aborts when an alive cycle lock is held', async () => {
      const deps = baseDeps()
      const cwd = '/repo'
      const peekCalls = []
      deps.peekLock = (repoPath) => {
        peekCalls.push(repoPath)
        return {
          holder: {
            pid: 9999,
            startedAt: '2026-04-29T00:00:00.000Z',
            repoPath: cwd,
          },
          alive: true,
        }
      }
      deps.now = () => Date.parse('2026-04-29T02:00:00.000Z')
      deps.exec = makeExec({
        [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      })
      await expect(startCommand({ ...deps, cwd })).rejects.toBeInstanceOf(StartAbort)
      expect(peekCalls).toHaveLength(1)
      expect(peekCalls[0]).toBe(cwd)
      const errOut = deps.stderr.output()
      expect(errOut).toContain('⏸️ Cycle in progress')
      expect(errOut).toContain('PID 9999')
      expect(errOut).toContain('2h')
      expect(errOut).toContain('ralph schedule pause')
      expect(deps.exec.calls.some((c) => c.startsWith('gh auth status'))).toBe(false)
      expect(deps.exec.calls.some((c) => c.startsWith(`tmux new -d -s ${SESSION}`))).toBe(false)
    })

    it('proceeds when the cycle lock holder is stale (alive=false)', async () => {
      const deps = baseDeps()
      const cwd = '/repo'
      deps.peekLock = () => ({
        holder: {
          pid: 4242,
          startedAt: '2025-01-01T00:00:00.000Z',
          repoPath: cwd,
        },
        alive: false,
      })
      deps.exec = makeExec({
        [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
        'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
        'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '0', stderr: '' },
      })
      const result = await startCommand({ ...deps, cwd })
      expect(result.exitCode).toBe(0)
      expect(deps.stderr.output()).not.toContain('Cycle in progress')
    })

    it('proceeds normally when no cycle lock is held', async () => {
      const deps = baseDeps()
      const cwd = '/repo'
      deps.peekLock = () => null
      deps.exec = makeExec({
        [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
        'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
        'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '0', stderr: '' },
      })
      const result = await startCommand({ ...deps, cwd })
      expect(result.exitCode).toBe(0)
      expect(deps.stderr.output()).not.toContain('Cycle in progress')
    })

    it('uses peekLock (read-only) and never acquires the lock', async () => {
      const deps = baseDeps()
      const cwd = '/repo'
      let acquireCalled = false
      deps.peekLock = () => null
      deps.acquireLock = () => {
        acquireCalled = true
        return { acquired: true, holder: { pid: 1, startedAt: '', repoPath: cwd } }
      }
      deps.exec = makeExec({
        [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
        'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
        'gh issue list --state open --label in-progress --json number,title -q .[] | "  #\\(.number) \\(.title)"': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'gh issue list --search state:open -label:in-progress -label:failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '0', stderr: '' },
      })
      await startCommand({ ...deps, cwd })
      expect(acquireCalled).toBe(false)
    })

    it('does not send a WhatsApp notification on the alive-lock abort path', async () => {
      const deps = baseDeps()
      const cwd = '/repo'
      let waCalled = false
      deps.exists = (p) => p.endsWith('.env.local')
      deps.loadEnv = () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' })
      deps.sendWa = async () => {
        waCalled = true
        return { ok: true }
      }
      deps.peekLock = () => ({
        holder: {
          pid: 1234,
          startedAt: '2026-04-29T00:00:00.000Z',
          repoPath: cwd,
        },
        alive: true,
      })
      deps.now = () => Date.parse('2026-04-29T01:00:00.000Z')
      deps.exec = makeExec({
        [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
      })
      await expect(startCommand({ ...deps, cwd })).rejects.toBeInstanceOf(StartAbort)
      expect(waCalled).toBe(false)
    })
  })
})
