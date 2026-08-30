import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { cycleCommand } from './cycle.js'
import { doctorCommand } from './doctor.js'
import { probeJiraAuth } from '../jira-auth.js'
import { sessionNameFor } from '../lock.js'
import { codeWithoutComments } from '../../test/helpers/source-code.js'

// ---------------------------------------------------------------------------
// QA augmentation for #134 — the preflight arm each TASK_SOURCE gets, and what an
// unauthed jira run costs before it aborts.
//
// The dev's cycle.test.js proves the three arms and the four consumers of the new
// reason. This file attacks the parts a wiring test does not reach:
//
//   THE GUARD'S ACTUAL BOUNDARY. The jira arm is `if (!jiraAuth?.ok)`, so the abort
//   decision is TRUTHINESS on a property of a value the seam supplies — not
//   `=== true`, and not a shape anything validates. Every hostile answer a probe can
//   give (nothing, null, `{}`, `{ ok: 0 }`, `{ ok: 'yes' }`, a non-promise) is pinned
//   below as a table, because the interesting half of a two-state gate is the values
//   that are neither state. `ralph doctor` reads the same probe with the same
//   truthiness (jiraAuthState), so the two commands agreeing on those values is part
//   of #134's guarantee rather than an accident of two spellings.
//
//   WHAT A THROWING PROBE DOES, which is the one thing the arm is NOT total against.
//   Pinned rather than argued: the rejection propagates out of `cycleCommand`, and
//   the value of pinning it is the two facts that come with it — the abort path's
//   event and notification are SKIPPED (so a throw is invisible to the rollup), and
//   the LOCK IS NEVER TAKEN, because preflight runs before `acquireLock`. So the
//   failure mode is a loud crash that strands nothing, not a lock file that stops
//   the schedule. The gh arm's identical exposure is MEASURED here too rather than
//   asserted in prose, since that symmetry is the argument for leaving it.
//
//   WHICH VALUES OF THE KNOB REACH THE JIRA ARM, including the ones that do not: an
//   unrecognised TASK_SOURCE gets GITHUB's gate (resolveSource collapses a typo to
//   the default long before this gate sees it), which is the opposite of what
//   `runPreflight`'s "a FOURTH TASK_SOURCE proves nothing here" note reads like out
//   of context — that sentence is about a name ADDED TO VALID_SOURCES, and the
//   distinction is worth a test because the two cases differ in behaviour.
//
//   THE COST OF THE ABORT, as zero-call assertions on every seam downstream of
//   preflight: no lock, no update gate, no orphan sweep, no count, no agent, no
//   healthcheck ping — and exactly ONE acli spawn, the probe's, with argv and options
//   pinned element by element.
//
//   THAT DOCTOR AND CYCLE CANNOT DISAGREE, driven as one `exec` through both
//   commands: the same acli exit code decides doctor's row and the cycle's verdict,
//   in both directions, plus the third state (acli missing) where doctor says "not
//   verified" and the cycle refuses — the one pairing that must never invert.
//
// Hermetic: `exec` is injected in every run, so no test here starts a real acli, gh,
// tmux or git; `readFile` answers from literals and the update cache is memfs.
// ---------------------------------------------------------------------------

const REPO = '/repo'
const REPO_SLUG = 'lucasfe/agenthub'
const SESSION = sessionNameFor(REPO)
const NOW_MS = Date.parse('2026-04-29T00:30:00.000Z')
const NL = String.fromCharCode(0x0a)

// The abort reason, spelled from its code point rather than pasted. The separator in
// cycle.js's JIRA_AUTH_FAILURE_REASON is an EM DASH (U+2014); a hyphen or an en dash
// pasted in its place reads identically in a diff and would turn every equality
// assertion below into a confusing red about invisible bytes.
const EM_DASH = String.fromCodePoint(0x2014)
const JIRA_REASON = `jira not authenticated ${EM_DASH} run: acli jira auth login`
const GH_REASON = 'gh not authenticated'

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

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    if (Object.prototype.hasOwnProperty.call(handlers, key)) {
      const v = handlers[key]
      return typeof v === 'function' ? v({ cmd, args, options }) : v
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

function makeWa() {
  const messages = []
  const sendWa = async ({ message }) => {
    messages.push(message)
    return { ok: true }
  }
  sendWa.messages = messages
  return sendWa
}

const baseHandlers = () => ({
  'git rev-parse --show-toplevel': { exitCode: 0, stdout: `${REPO}${NL}`, stderr: '' },
  [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
  'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
  'gh repo view --json nameWithOwner -q .nameWithOwner': {
    exitCode: 0,
    stdout: `${REPO_SLUG}${NL}`,
    stderr: '',
  },
})

// Every seam downstream of preflight, each one COUNTING its calls, so "the abort
// costs nothing" is a set of zeroes rather than a claim. `trace` records the order
// the ones that do run ran in, which is how the probe-before-the-lock ordering is
// asserted without reaching into cycle.js.
const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const sendWa = makeWa()
  const trace = []
  const counted = (name, fn) => {
    const wrapped = (...args) => {
      trace.push(name)
      wrapped.calls.push(args)
      return fn(...args)
    }
    wrapped.calls = []
    return wrapped
  }
  const deps = {
    cwd: REPO,
    stdout,
    stderr,
    exec: makeExec(baseHandlers()),
    exists: () => true,
    loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1', HEALTHCHECK_URL: 'https://hc/x' }),
    acquireLock: counted('acquireLock', () => ({
      acquired: true,
      holder: { pid: 1, startedAt: '2026-04-29T00:00:00.000Z', repoPath: REPO },
    })),
    releaseLock: counted('releaseLock', () => {}),
    findOrphans: counted('findOrphans', async () => []),
    cleanupOrphans: counted('cleanupOrphans', async () => []),
    sendWa,
    pingSuccess: counted('pingSuccess', async () => ({ ok: true })),
    pingFail: counted('pingFail', async () => ({ ok: true })),
    runQueueOnce: counted('runQueueOnce', async () => ({ successes: [], failures: [] })),
    readFile: () => '',
    now: () => NOW_MS,
    processEnv: {},
    home: '/home/me',
    // The update gate runs inside the lock on every cycle; memfs keeps it off the
    // real ~/.config/ralph, and `update`/`ask` are counted so an abort can be shown
    // not to have reached the gate at all.
    cacheFs: new Volume(),
    update: counted('update', () => ({ shouldNotify: false, shouldPrompt: false })),
    ask: counted('ask', async () => false),
    ...overrides,
  }
  deps.trace = trace
  return deps
}

const jiraConfig = `TASK_SOURCE="jira"${NL}JIRA_JQL="project = RALPH"${NL}`

const jiraDeps = (overrides = {}) =>
  baseDeps({
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? jiraConfig : ''),
    // The count is not what these tests are about; 0 makes a run that CLEARED
    // preflight stop at `queue-empty`, which is the observable "it was let through".
    jiraQueueCount: async () => 0,
    ...overrides,
  })

// A probe seam that records every call, so "not probed at all" is assertable on the
// probe itself and not only on the absence of an acli spawn.
const spyProbe = (answer) => {
  const probe = async (...args) => {
    probe.calls.push(args)
    return typeof answer === 'function' ? answer(...args) : answer
  }
  probe.calls = []
  return probe
}

const eventsIn = (deps) =>
  deps.stdout
    .output()
    .split(NL)
    .filter((l) => l.startsWith('RALPH_CYCLE_EVENT '))
    .map((l) => JSON.parse(l.slice('RALPH_CYCLE_EVENT '.length)))

const acliCallsOf = (deps) => deps.exec.calls.filter((c) => c.cmd === 'acli')

// ---------------------------------------------------------------------------
// 1. The guard's boundary: `if (!jiraAuth?.ok)`.
// ---------------------------------------------------------------------------

describe('QA cycle #134 — the jira arm believes TRUTHINESS on `ok`, and nothing else', () => {
  // Answers that must ABORT the run. The first three are the `?.` half of the guard —
  // a probe that returned nothing at all is a probe that proved nothing — and the rest
  // are every falsy `ok` a hostile or half-written probe can produce.
  const aborting = {
    'undefined (a probe that returned nothing)': undefined,
    null: null,
    'an empty object': {},
    'ok: false with NO reason at all': { ok: false },
    'ok: 0': { ok: 0 },
    'ok: "" (the empty string)': { ok: '' },
    'ok: NaN': { ok: Number.NaN },
    'ok: null': { ok: null },
    'ok: undefined beside a reason': { ok: undefined, reason: 'expired' },
  }

  for (const [label, answer] of Object.entries(aborting)) {
    it(`aborts for ${label}`, async () => {
      const deps = jiraDeps({ probeJiraAuth: spyProbe(answer) })
      const result = await cycleCommand(deps)
      expect(result, label).toMatchObject({
        exitCode: 1,
        status: 'preflight-failed',
        processed: 0,
        skipped: false,
        reason: JIRA_REASON,
      })
    })
  }

  // ...and the answers that let the run through. `ok: 'yes'` is the one worth staring
  // at: the guard is truthiness, so a probe that answered with a STRING is believed.
  // That is not a defect, it is the same reading `ralph doctor`'s jiraAuthState makes
  // on purpose ("doctor believes a probe that answered affirmatively rather than
  // second-guessing its shape") — and the two commands taking the same view of a
  // malformed answer is exactly what sharing the probe is for. Pinned so a future
  // `=== true` on one side alone shows up as a disagreement.
  const passing = {
    'ok: true': { ok: true },
    'ok: true with a reason set anyway': { ok: true, reason: 'stale field' },
    'ok: "yes" (a truthy non-boolean)': { ok: 'yes' },
    'ok: 1': { ok: 1 },
    'ok: an empty array (truthy in JS)': { ok: [] },
    'ok: an object': { ok: {} },
  }

  for (const [label, answer] of Object.entries(passing)) {
    it(`lets the run through for ${label}`, async () => {
      const deps = jiraDeps({ probeJiraAuth: spyProbe(answer) })
      const result = await cycleCommand(deps)
      // queue-empty is the proof: the count seam was reached, so preflight passed.
      expect(result.status, label).toBe('queue-empty')
      expect(deps.stderr.output(), label).not.toContain('preflight failed')
    })
  }

  it('accepts a SYNCHRONOUS probe — `await` tolerates a non-thenable, in both verdicts', async () => {
    // The seam's contract is "returns { ok }", not "returns a promise of it", and a
    // caller wiring in a plain function must not be read as a failure (or as a pass).
    const pass = jiraDeps({ probeJiraAuth: () => ({ ok: true, reason: null }) })
    expect((await cycleCommand(pass)).status).toBe('queue-empty')
    const fail = jiraDeps({ probeJiraAuth: () => ({ ok: false, reason: 'nope' }) })
    expect((await cycleCommand(fail)).status).toBe('preflight-failed')
  })

  it('reads `ok` ONCE and does not re-probe — one question, one answer', async () => {
    const probe = spyProbe({ ok: false, reason: 'nope' })
    const deps = jiraDeps({ probeJiraAuth: probe })
    await cycleCommand(deps)
    expect(probe.calls).toHaveLength(1)
  })

  it('hands the probe `{ exec }` and NOTHING else — no cwd, no root, no env', async () => {
    // The probe asks acli about the USER's session; a cwd or an env in this bag would
    // make the answer depend on where the cycle was launched from, and lib/jira-auth.js
    // is asserted (in its own QA file) to forward none of them to the spawn.
    const probe = spyProbe({ ok: true })
    const deps = jiraDeps({ probeJiraAuth: probe })
    await cycleCommand(deps)
    expect(probe.calls[0]).toHaveLength(1)
    expect(Object.keys(probe.calls[0][0])).toEqual(['exec'])
    expect(probe.calls[0][0].exec).toBe(deps.exec)
  })

  it('ignores the probe’s own `reason` — the remedy text is FIXED, never interpolated', async () => {
    // cycle.js composes its own reason on purpose (the probe's is remedy-free so
    // `ralph doctor` does not print the advice twice). A probe wording change must
    // therefore be invisible here, and the probe's text must not leak into any of the
    // four places the failure is read.
    const deps = jiraDeps({
      probeJiraAuth: spyProbe({ ok: false, reason: 'ACLI-4711: token rotated by admin' }),
    })
    const result = await cycleCommand(deps)
    expect(result.reason).toBe(JIRA_REASON)
    const everythingRead = [
      deps.stderr.output(),
      deps.stdout.output(),
      deps.sendWa.messages.join(NL),
    ].join(NL)
    expect(everythingRead).not.toContain('ACLI-4711')
    expect(everythingRead).not.toContain('token rotated')
  })
})

// ---------------------------------------------------------------------------
// 2. A probe that throws — pinned, including what the crash does NOT do.
// ---------------------------------------------------------------------------

describe('QA cycle #134 — a THROWING auth probe: the pinned behaviour, and the lock', () => {
  // Not a defect claim: `probeJiraAuth` is total by contract (its own QA file asserts
  // every hostile `exec` resolves rather than rejects), so the shipped path cannot
  // reach these. They are pinned because "what happens if it does" was previously
  // unwritten, and because the two facts underneath the crash are the reassuring ones.
  const throwing = {
    'a rejected promise': async () => {
      throw new Error('probe exploded')
    },
    'a synchronous throw': () => {
      throw new Error('probe exploded')
    },
    'an `ok` getter that throws': () => ({
      get ok() {
        throw new Error('probe exploded')
      },
    }),
    'a non-callable seam (a caller wired in a value, not a function)': 42,
  }

  for (const [label, probe] of Object.entries(throwing)) {
    it(`propagates out of cycleCommand for ${label}`, async () => {
      const deps = jiraDeps({ probeJiraAuth: probe })
      await expect(cycleCommand(deps)).rejects.toThrow()
    })

    it(`takes NO LOCK and drains nothing for ${label}`, async () => {
      // The load-bearing half. Preflight runs BEFORE `acquireLock`, so a throw here
      // cannot strand a lock file that would make every later scheduled tick report
      // `lock-held` — the failure mode that stops a schedule for good rather than
      // losing one run.
      const deps = jiraDeps({ probeJiraAuth: probe })
      await cycleCommand(deps).catch(() => {})
      expect(deps.acquireLock.calls, label).toHaveLength(0)
      expect(deps.releaseLock.calls, label).toHaveLength(0)
      expect(deps.runQueueOnce.calls, label).toHaveLength(0)
      expect(deps.findOrphans.calls, label).toHaveLength(0)
    })

    it(`emits no event and notifies nobody for ${label} — the cost of not being total`, async () => {
      // The honest half: a throw skips the abort path, so the run is invisible to the
      // RALPH_CYCLE_EVENT stream the digest reads and silent on WhatsApp. Acceptable
      // only because the probe cannot throw; pinned so that stops being true loudly.
      const deps = jiraDeps({ probeJiraAuth: probe })
      await cycleCommand(deps).catch(() => {})
      expect(eventsIn(deps), label).toEqual([])
      expect(deps.sendWa.messages, label).toEqual([])
    })
  }

  it('the GH ARM HAS THE SAME EXPOSURE — measured, not assumed', async () => {
    // #134's argument for leaving the jira arm non-total is that the gh arm beside it
    // has been exactly as exposed since #565 and has never been a problem. That is a
    // testable claim about the current code, so it is tested: a spawner that rejects on
    // `gh auth status` crashes a github cycle the same way, with the same silence.
    const deps = baseDeps({
      exec: makeExec({
        ...baseHandlers(),
        'gh auth status': () => Promise.reject(new Error('spawn gh ENOENT')),
      }),
    })
    await expect(cycleCommand(deps)).rejects.toThrow('spawn gh ENOENT')
    expect(deps.acquireLock.calls).toHaveLength(0)
    expect(eventsIn(deps)).toEqual([])
    expect(deps.sendWa.messages).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. Which resolved source reaches which arm.
// ---------------------------------------------------------------------------

describe('QA cycle #134 — which TASK_SOURCE values reach the jira arm', () => {
  // Every spelling `resolveSource` normalises to 'jira'. The gate only ever sees the
  // resolver's output, so these are about the two-step path (config grammar, then
  // resolver) rather than about the gate.
  const jiraSpellings = {
    bare: `TASK_SOURCE=jira${NL}`,
    'double quoted': `TASK_SOURCE="jira"${NL}`,
    'single quoted': `TASK_SOURCE='jira'${NL}`,
    uppercase: `TASK_SOURCE=JIRA${NL}`,
    'mixed case': `TASK_SOURCE=Jira${NL}`,
    'padded inside quotes': `TASK_SOURCE="  jira  "${NL}`,
    'with a trailing comment': `TASK_SOURCE=jira # the board${NL}`,
  }

  for (const [label, text] of Object.entries(jiraSpellings)) {
    it(`probes JIRA and never gh for a ${label} value`, async () => {
      const probe = spyProbe({ ok: false, reason: 'nope' })
      const deps = jiraDeps({
        readFile: (p) => (String(p).endsWith('ralph.config.sh') ? text : ''),
        probeJiraAuth: probe,
      })
      const result = await cycleCommand(deps)
      expect(result.status, label).toBe('preflight-failed')
      expect(result.reason, label).toBe(JIRA_REASON)
      expect(probe.calls, label).toHaveLength(1)
      expect(deps.exec.calls.some((c) => c.key === 'gh auth status'), label).toBe(false)
    })
  }

  // ...and the values that reach GITHUB's arm instead. The last three are the point:
  // an unrecognised TASK_SOURCE is NOT a fourth source as far as this gate is
  // concerned, because resolveSource has already turned the typo into 'github' — so a
  // misspelled `jira` proves GH AUTH, exactly as it did before #134. `runPreflight`'s
  // note about a fourth source proving nothing is about a name added to VALID_SOURCES,
  // which is a different (and unreachable-from-here) case; these pin the reachable one
  // so nobody reads the allowlist as protection against a typo.
  const githubSpellings = {
    'an explicit github': `TASK_SOURCE=github${NL}`,
    'an empty assignment': `TASK_SOURCE=${NL}`,
    'no TASK_SOURCE line at all': `JIRA_JQL="project = RALPH"${NL}`,
    'a misspelled jira (jria)': `TASK_SOURCE=jria${NL}`,
    'a plausible-looking jira-cloud': `TASK_SOURCE=jira-cloud${NL}`,
    'an unregistered fourth name (gitlab)': `TASK_SOURCE=gitlab${NL}`,
  }

  for (const [label, text] of Object.entries(githubSpellings)) {
    it(`probes GH and never the jira seam for ${label}`, async () => {
      const probe = spyProbe({ ok: false, reason: 'nope' })
      const deps = baseDeps({
        readFile: (p) => (String(p).endsWith('ralph.config.sh') ? text : ''),
        probeJiraAuth: probe,
        exec: makeExec({
          ...baseHandlers(),
          'gh auth status': { exitCode: 1, stdout: '', stderr: 'not authenticated' },
        }),
      })
      const result = await cycleCommand(deps)
      expect(result.status, label).toBe('preflight-failed')
      // GITHUB's reason, unchanged by #134 — byte for byte, since `ralph status` and
      // the digest read this string out of the event stream.
      expect(result.reason, label).toBe(GH_REASON)
      expect(probe.calls, label).toHaveLength(0)
    })
  }

  it('folder mode probes NEITHER seam, with both credentials broken', async () => {
    const probe = spyProbe({ ok: false, reason: 'nope' })
    const deps = baseDeps({
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? `TASK_SOURCE=folder${NL}` : ''),
      folderQueueCount: async () => 0,
      probeJiraAuth: probe,
      exec: makeExec({
        ...baseHandlers(),
        'gh auth status': { exitCode: 1, stdout: '', stderr: 'not authenticated' },
        'acli jira auth status': { exitCode: 1, stdout: '', stderr: 'no session' },
      }),
    })
    expect((await cycleCommand(deps)).status).toBe('queue-empty')
    expect(probe.calls).toHaveLength(0)
    expect(deps.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)
    expect(acliCallsOf(deps)).toEqual([])
  })

  it('an env TASK_SOURCE=jira reaches the jira arm when the config names no source', async () => {
    // The documented fallback: config first, environment second (unlike JIRA_JQL,
    // which is config-only).
    const probe = spyProbe({ ok: false, reason: 'nope' })
    const deps = baseDeps({
      readFile: () => '',
      processEnv: { TASK_SOURCE: 'jira' },
      probeJiraAuth: probe,
    })
    expect((await cycleCommand(deps)).reason).toBe(JIRA_REASON)
    expect(probe.calls).toHaveLength(1)
  })

  it('the CONFIG wins over the environment in both directions', async () => {
    // config jira + env github → the jira arm...
    const jiraProbe = spyProbe({ ok: false, reason: 'nope' })
    const configJira = jiraDeps({
      processEnv: { TASK_SOURCE: 'github' },
      probeJiraAuth: jiraProbe,
    })
    expect((await cycleCommand(configJira)).reason).toBe(JIRA_REASON)
    expect(jiraProbe.calls).toHaveLength(1)
    expect(configJira.exec.calls.some((c) => c.key === 'gh auth status')).toBe(false)

    // ...and config github + env jira → the gh arm.
    const ghProbe = spyProbe({ ok: false, reason: 'nope' })
    const configGithub = baseDeps({
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? `TASK_SOURCE=github${NL}` : ''),
      processEnv: { TASK_SOURCE: 'jira' },
      probeJiraAuth: ghProbe,
      exec: makeExec({
        ...baseHandlers(),
        'gh auth status': { exitCode: 1, stdout: '', stderr: 'not authenticated' },
      }),
    })
    expect((await cycleCommand(configGithub)).reason).toBe(GH_REASON)
    expect(ghProbe.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. What the abort costs, and where it sits.
// ---------------------------------------------------------------------------

describe('QA cycle #134 — an unauthed jira run aborts at second zero', () => {
  const unauthedDefaultProbe = (overrides = {}) =>
    jiraDeps({
      // NO injected probe: the shipped path, refused at the exec level.
      probeJiraAuth: undefined,
      exec: makeExec({
        ...baseHandlers(),
        'acli jira auth status': { exitCode: 1, stdout: '', stderr: 'no session' },
      }),
      ...overrides,
    })

  it('spawns acli EXACTLY ONCE, with the probe’s argv element by element', async () => {
    const deps = unauthedDefaultProbe()
    expect((await cycleCommand(deps)).status).toBe('preflight-failed')
    const calls = acliCallsOf(deps)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['jira', 'auth', 'status'])
    // Options too: `reject: false` strictly (execa's default THROWS on a non-zero
    // exit, which is precisely the state this run is in), and no cwd — a session is
    // the user's, not the repo's.
    expect(calls[0].options).toEqual({ reject: false })
  })

  it('never counts a queue: no `acli jira workitem`, no `gh issue list`, no folder read', async () => {
    let folderReads = 0
    const jiraCounts = []
    const deps = unauthedDefaultProbe({
      jiraQueueCount: async (args) => {
        jiraCounts.push(args)
        return 3
      },
      folderQueueCount: async () => {
        folderReads += 1
        return 7
      },
    })
    await cycleCommand(deps)
    expect(jiraCounts).toEqual([])
    expect(folderReads).toBe(0)
    expect(deps.exec.calls.some((c) => c.key.startsWith('acli jira workitem'))).toBe(false)
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh issue list'))).toBe(false)
  })

  it('reaches NO seam downstream of preflight — lock, update gate, sweep, agent, ping', async () => {
    const deps = unauthedDefaultProbe()
    await cycleCommand(deps)
    // One list rather than six assertions: anything a future edit moves above the
    // preflight check shows up here as a named seam in an empty array.
    expect(deps.trace).toEqual([])
  })

  it('the orphan sweep never runs, so no GitHub label is touched on an unauthed jira tick', async () => {
    // The sweep is `gh`-driven bookkeeping; a jira run that cannot even prove its own
    // session must not go and edit another board's labels on the way out.
    const deps = unauthedDefaultProbe({
      findOrphans: async () => [7, 8],
      cleanupOrphans: async () => [7, 8],
    })
    await cycleCommand(deps)
    expect(deps.stdout.output()).not.toContain('orphan')
    expect(deps.exec.calls.every((c) => c.cmd !== 'gh' || c.key === 'gh repo view --json nameWithOwner -q .nameWithOwner')).toBe(true)
  })

  it('the ONLY commands an unauthed jira cycle runs are the four it needs to report', async () => {
    // Pinned as the whole spawn list, in order: find the repo, check for a live tmux
    // session, learn the slug the notification names, ask acli. Nothing else — and the
    // slug lookup is `gh`, which is why "a jira run runs no gh at all" is not the
    // claim being made anywhere (it runs no gh AUTH and no gh QUERY).
    const deps = unauthedDefaultProbe()
    await cycleCommand(deps)
    expect(deps.exec.calls.map((c) => c.key)).toEqual([
      'git rev-parse --show-toplevel',
      `tmux has-session -t ${SESSION}`,
      'gh repo view --json nameWithOwner -q .nameWithOwner',
      'acli jira auth status',
    ])
  })

  it('probes BEFORE the lock is acquired on a run that PASSES, too', async () => {
    // The ordering claim in the positive direction: an authed run proves the session
    // first and takes the lock second, so the probe can never be reached with the file
    // already written.
    const probe = spyProbe({ ok: true, reason: null })
    const deps = jiraDeps({
      probeJiraAuth: async (...args) => {
        deps.trace.push('probeJiraAuth')
        return probe(...args)
      },
    })
    expect((await cycleCommand(deps)).status).toBe('queue-empty')
    expect(deps.trace.indexOf('probeJiraAuth')).toBe(0)
    expect(deps.trace.indexOf('probeJiraAuth')).toBeLessThan(deps.trace.indexOf('acquireLock'))
  })

  it('a zero exit from acli lets the run through even when acli was NOISY', async () => {
    // Exit code only, all the way through the shipped path: a deprecation banner on
    // stderr must not abort a scheduled drain.
    const deps = jiraDeps({
      probeJiraAuth: undefined,
      exec: makeExec({
        ...baseHandlers(),
        'acli jira auth status': {
          exitCode: 0,
          stdout: 'not logged in?',
          stderr: 'WARNING: acli 2.x deprecates this subcommand',
        },
      }),
    })
    expect((await cycleCommand(deps)).status).toBe('queue-empty')
  })
})

// ---------------------------------------------------------------------------
// 5. The reason string reaches all four readers, and the other two arms did not move.
// ---------------------------------------------------------------------------

describe('QA cycle #134 — the remedy reaches every consumer of a failed cycle', () => {
  it('stderr, the WhatsApp notice, the event and the return value carry the SAME text', async () => {
    const deps = jiraDeps({ probeJiraAuth: spyProbe({ ok: false, reason: 'jira not authenticated' }) })
    const result = await cycleCommand(deps)

    // 1. the return value
    expect(result.reason).toBe(JIRA_REASON)
    // 2. the line launchd captures in logs/ralph-cycle.err.log (lib/launchd.js:67 builds
    //    `${cfg.logBase}.err.log` and wires it to StandardErrorPath at 86-87; logBase for
    //    kind `cycle` is 'ralph-cycle')
    expect(deps.stderr.output()).toBe(`❌ ralph cycle: preflight failed (${JIRA_REASON}).${NL}`)
    // 3. the notification, whole — a body that lost the reason to a template edit is
    //    the exact regression #6's QA block exists for
    expect(deps.sendWa.messages).toEqual([
      `🔴 ralph cycle aborted in ${REPO_SLUG}: ${JIRA_REASON}`,
    ])
    // 4. the event the digest and `ralph status` read
    expect(eventsIn(deps)).toEqual([
      {
        ts: new Date(NOW_MS).toISOString(),
        status: 'preflight-failed',
        ok: 0,
        failed: 0,
        durationMin: 0,
        processed: 0,
        reason: JIRA_REASON,
      },
    ])
  })

  it('the LINE goes to stderr and the EVENT to stdout — which is two different log files', async () => {
    // Which file each half lands in under launchd, since the reason's whole purpose is
    // being read out of one at 3am. lib/launchd.js writes StandardOutPath
    // `ralph-cycle.out.log` and StandardErrorPath `ralph-cycle.err.log`, so the
    // ❌ line — written with `err()` — is in the .ERR log, and only the
    // RALPH_CYCLE_EVENT carrying the same reason reaches the .out log (which is also
    // the file lib/heartbeat.js globs for the daily rollup). Both carry the remedy,
    // which is what matters; the point of pinning it is that the two streams are not
    // interchangeable and a reader sent to the wrong file finds nothing.
    const deps = jiraDeps({ probeJiraAuth: spyProbe({ ok: false }) })
    await cycleCommand(deps)
    expect(deps.stderr.output()).toContain('preflight failed')
    expect(deps.stdout.output()).not.toContain('preflight failed')
    expect(deps.stdout.output()).toContain(`"reason":"${JIRA_REASON}"`)
    const launchd = codeWithoutComments(new URL('../launchd.js', import.meta.url))
    expect(launchd).toContain('`${cfg.logBase}.out.log`')
    expect(launchd).toContain('`${cfg.logBase}.err.log`')
  })

  it('the text names the FINDING and the COMMAND, and mentions no gh', async () => {
    const deps = jiraDeps({ probeJiraAuth: spyProbe({ ok: false }) })
    const reason = (await cycleCommand(deps)).reason
    expect(reason).toContain('jira not authenticated')
    expect(reason).toContain('acli jira auth login')
    // A Jira-only repo may have no GitHub at all; being told about gh here would be
    // the #565 mistake in a new place.
    expect(reason).not.toMatch(/\bgh\b|github/i)
  })

  it('github’s reason is untouched, and says nothing about acli', async () => {
    const deps = baseDeps({
      exec: makeExec({
        ...baseHandlers(),
        'gh auth status': { exitCode: 1, stdout: '', stderr: 'not authenticated' },
      }),
    })
    const result = await cycleCommand(deps)
    expect(result.reason).toBe(GH_REASON)
    expect(deps.stderr.output()).toBe(`❌ ralph cycle: preflight failed (${GH_REASON}).${NL}`)
    expect(deps.sendWa.messages).toEqual([`🔴 ralph cycle aborted in ${REPO_SLUG}: ${GH_REASON}`])
    expect(deps.stderr.output()).not.toMatch(/acli|jira/i)
  })

  it('aborts identically with WhatsApp UNCONFIGURED — the notice is a courtesy, not the verdict', async () => {
    // A scheduled repo with no CALLMEBOT_KEY/WHATSAPP_PHONE is the common case, and the
    // exit code is what launchd reads.
    const deps = jiraDeps({ probeJiraAuth: spyProbe({ ok: false }), loadEnv: () => ({}) })
    const result = await cycleCommand(deps)
    expect(result).toMatchObject({ exitCode: 1, status: 'preflight-failed', reason: JIRA_REASON })
    expect(deps.sendWa.messages).toEqual([])
    expect(eventsIn(deps)[0].reason).toBe(JIRA_REASON)
  })

  it('a WhatsApp send that THROWS cannot swallow the abort', async () => {
    // The notify wrapper is best-effort by design; asserted on the new path because a
    // notification failure turning `exit 1` into an unhandled rejection would break the
    // schedule rather than one run.
    const deps = jiraDeps({
      probeJiraAuth: spyProbe({ ok: false }),
      sendWa: async () => {
        throw new Error('callmebot 502')
      },
    })
    const result = await cycleCommand(deps)
    expect(result).toMatchObject({ exitCode: 1, status: 'preflight-failed', reason: JIRA_REASON })
    expect(eventsIn(deps)[0].status).toBe('preflight-failed')
  })

  it('the other preflight reasons are untouched — the auth arm is the only new one', async () => {
    // The three checks AFTER the auth arm answer for every source, so a jira run must
    // still fail on a missing config or state file with those reasons rather than with
    // the auth one.
    const missingConfig = jiraDeps({
      probeJiraAuth: spyProbe({ ok: true }),
      exists: (p) => !String(p).endsWith('ralph.config.sh'),
    })
    expect((await cycleCommand(missingConfig)).reason).toBe('ralph.config.sh missing')

    const missingState = jiraDeps({
      probeJiraAuth: spyProbe({ ok: true }),
      exists: (p) => !String(p).endsWith('state.json'),
    })
    expect((await cycleCommand(missingState)).reason).toBe('.ralph/state.json missing')
  })

  it('the auth arm runs BEFORE the config and state checks, so a broken repo names auth first', async () => {
    // Order inside runPreflight: the auth question first, then the two files. A machine
    // with no session AND nothing on disk gets the auth reason, which is the one a user
    // fixes. TASK_SOURCE comes from the environment here of necessity — with `exists`
    // false there is no ralph.config.sh to read a source out of, which is itself the
    // fallback the resolver documents.
    const deps = baseDeps({
      processEnv: { TASK_SOURCE: 'jira' },
      probeJiraAuth: spyProbe({ ok: false }),
      exists: () => false,
      readFile: () => '',
    })
    expect((await cycleCommand(deps)).reason).toBe(JIRA_REASON)
  })
})

// ---------------------------------------------------------------------------
// 6. The shared-probe guarantee: doctor and cycle, one exec, one verdict.
// ---------------------------------------------------------------------------

describe('QA #134 — `ralph doctor` and `ralph cycle` cannot disagree about Jira auth', () => {
  // Doctor, driven with the SAME `exec` handlers a cycle gets, in jira mode, with no
  // config on disk so the env resolves the source (doctor's documented precedence).
  const runDoctor = async (exec) => {
    const stdout = makeStream()
    const result = await doctorCommand({
      stdout,
      stderr: makeStream(),
      hasCommand: () => true,
      platform: 'mac',
      env: { TASK_SOURCE: 'jira' },
      currentVersion: '0.17.0',
      cacheFs: new Volume(),
      home: '/home/me',
      cwd: REPO,
      exists: () => false,
      exec,
    })
    // ANSI out: the row is compared as text, and pc may or may not colourise.
    const ESC = String.fromCharCode(27)
    return {
      result,
      out: stdout.output().replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), ''),
    }
  }

  const runCycle = async (exec) =>
    cycleCommand(
      jiraDeps({
        probeJiraAuth: undefined, // the shipped default — the same function doctor holds
        exec,
      }),
    )

  it('acli exits 0 → doctor prints ✓ AND the cycle starts', async () => {
    const handlers = { ...baseHandlers(), 'acli jira auth status': { exitCode: 0, stdout: '', stderr: '' } }
    const { out } = await runDoctor(makeExec(handlers))
    const cycle = await runCycle(makeExec(handlers))
    expect(out).toContain('✓ jira auth')
    expect(out).not.toContain('jira auth (not authenticated)')
    expect(cycle.status).toBe('queue-empty')
  })

  it('acli exits non-zero → doctor prints the warning AND the cycle refuses', async () => {
    const handlers = {
      ...baseHandlers(),
      'acli jira auth status': { exitCode: 1, stdout: '', stderr: 'no session' },
    }
    const { out } = await runDoctor(makeExec(handlers))
    const cycle = await runCycle(makeExec(handlers))
    expect(out).toContain('! jira auth (not authenticated)')
    expect(out).not.toContain('✓ jira auth')
    expect(cycle.status).toBe('preflight-failed')
    expect(cycle.reason).toBe(JIRA_REASON)
  })

  it('acli MISSING (a spawner that rejects) → BOTH read it as not authenticated', async () => {
    // The state a reader might expect to diverge, and it does not: doctor's third state
    // ("not verified") is NOT reachable through a failing spawn, because the shared
    // probe is total — it catches the rejection and answers `ok: false`. So a machine
    // with no acli on PATH gets doctor's warning row and the cycle's refusal, which is
    // the agreement #134 is for. Doctor still exits 0 either way: auth is reported
    // there and enforced here.
    const handlers = {
      ...baseHandlers(),
      'acli jira auth status': () => Promise.reject(new Error('spawn acli ENOENT')),
    }
    const { out, result } = await runDoctor(makeExec(handlers))
    const cycle = await runCycle(makeExec(handlers))
    expect(out).toContain('! jira auth (not authenticated)')
    expect(out).not.toContain('✓ jira auth')
    expect(result.exitCode).toBe(0)
    expect(cycle.status).toBe('preflight-failed')
    expect(cycle.reason).toBe(JIRA_REASON)
  })

  it('doctor’s "not verified" is a NO-SPAWNER state the cycle cannot be in', async () => {
    // Where the three-into-two collapse actually bites: doctor's `exec` is undefaulted
    // (its import graph must reach no spawner), so a caller with nothing to run acli
    // with gets "not verified". The cycle holds execa by default and so can never
    // report that state — which is why it needs two states and not three. Asserted at
    // the seam rather than by running the default, since running it would spawn.
    const { out, result } = await runDoctor(undefined)
    expect(out).toContain('! jira auth (not verified)')
    expect(out).toContain('check: acli jira auth status')
    expect(result.exitCode).toBe(0)
    const cycleCode = codeWithoutComments(new URL('./cycle.js', import.meta.url))
    expect(cycleCode).toContain('exec = execa')
  })

  it('doctor never renders ✓ for any exit code the cycle refuses', async () => {
    // The property behind the three examples above, swept over the exit codes a CLI
    // actually produces. 0 is the only one that may print a tick, and it is the only
    // one that may start a cycle.
    for (const exitCode of [0, 1, 2, 127, -1]) {
      const handlers = {
        ...baseHandlers(),
        'acli jira auth status': { exitCode, stdout: '', stderr: '' },
      }
      const { out } = await runDoctor(makeExec(handlers))
      const cycle = await runCycle(makeExec(handlers))
      const doctorHealthy = out.includes('✓ jira auth')
      const cycleStarted = cycle.status !== 'preflight-failed'
      expect(doctorHealthy, `exit ${exitCode}`).toBe(cycleStarted)
      expect(doctorHealthy, `exit ${exitCode}`).toBe(exitCode === 0)
    }
  })

  it('ONE argv, spelled once in the repo — neither command names acli itself', async () => {
    // The structural half of the guarantee. Sharing the FUNCTION rather than the
    // invocation is what makes the agreement above impossible to break by editing one
    // file, so: the argv lives in lib/jira-auth.js and cycle.js/doctor.js contain no
    // acli spawn of their own outside their prose.
    const cycleCode = codeWithoutComments(new URL('./cycle.js', import.meta.url))
    const doctorCode = codeWithoutComments(new URL('./doctor.js', import.meta.url))
    const probeCode = codeWithoutComments(new URL('../jira-auth.js', import.meta.url))
    expect(probeCode).toContain("['jira', 'auth', 'status']")
    for (const [label, code] of [['cycle.js', cycleCode], ['doctor.js', doctorCode]]) {
      expect(code, label).not.toContain("'acli'")
      // The jira argv specifically: cycle.js DOES spell `['auth', 'status']` for gh,
      // which is its own inline arm and not a second copy of this probe.
      expect(code, label).not.toContain("'jira', 'auth', 'status'")
      // ...and each reaches the probe through the one module.
      expect(code, label).toMatch(/probeJiraAuth as realProbeJiraAuth \} from '\.\.?\/(\.\.\/)?jira-auth\.js'/)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. No regression in doctor: the probe's reason stayed remedy-free.
// ---------------------------------------------------------------------------

describe('QA #134 — the probe’s reason is remedy-free, so doctor prints the advice once', () => {
  it('probeJiraAuth’s reason names no command at all', async () => {
    // The invariant #134 relies on when it composes its own text: the day this reason
    // grows `run: acli jira auth login`, doctor's row prints the remedy twice.
    const failed = await probeJiraAuth({ exec: async () => ({ exitCode: 1 }) })
    expect(failed).toEqual({ ok: false, reason: 'jira not authenticated' })
    expect(failed.reason).not.toMatch(/run:|login|acli/)
  })

  it('doctor’s not-authenticated row names `acli jira auth login` exactly once', async () => {
    const stdout = makeStream()
    await doctorCommand({
      stdout,
      stderr: makeStream(),
      hasCommand: () => true,
      platform: 'mac',
      env: { TASK_SOURCE: 'jira' },
      currentVersion: '0.17.0',
      cacheFs: new Volume(),
      home: '/home/me',
      cwd: REPO,
      exists: () => false,
      exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    })
    const ESC = String.fromCharCode(27)
    const out = stdout.output().replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
    expect(out.split('acli jira auth login')).toHaveLength(2)
    // ...and it keeps its own phrasing, not the cycle's.
    expect(out).toContain('login: acli jira auth login')
    expect(out).not.toContain(JIRA_REASON)
    expect(out).not.toContain('run: acli jira auth login')
  })
})
