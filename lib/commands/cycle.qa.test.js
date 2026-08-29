import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { readFileSync } from 'node:fs'
import { cycleCommand } from './cycle.js'
import { composeJiraJql } from '../jira-jql.js'
import { sessionNameFor } from '../lock.js'
import { templatePath } from '../paths.js'

// #6 QA augmentation — cycle.js emits several translated status lines and the
// end-of-run summary. The dev's cycle.test.js proves the happy-path text; these
// probe that (a) each translated line still carries its INTERPOLATED dynamic
// values (a translation that dropped ${reason}/${pid}/${count} is a real bug),
// and (b) the English summary shape stays byte-for-byte consistent with the one
// templates/ralph.sh prints, since cycle aggregates the loop's output.

const REPO = '/repo'
const REPO_SLUG = 'lucasfe/agenthub'
const SESSION = sessionNameFor(REPO)
const NOW_MS = Date.parse('2026-04-29T00:30:00.000Z')

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
  'git rev-parse --show-toplevel': { exitCode: 0, stdout: `${REPO}\n`, stderr: '' },
  [`tmux has-session -t ${SESSION}`]: { exitCode: 1, stdout: '', stderr: '' },
  'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
  'gh repo view --json nameWithOwner -q .nameWithOwner': {
    exitCode: 0,
    stdout: `${REPO_SLUG}\n`,
    stderr: '',
  },
})

const baseDeps = (overrides = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const sendWa = makeWa()
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: makeExec(baseHandlers()),
    exists: () => true,
    loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' }),
    acquireLock: () => ({ acquired: true, holder: { pid: 1, startedAt: '2026-04-29T00:00:00.000Z', repoPath: REPO } }),
    releaseLock: () => {},
    findOrphans: async () => [],
    cleanupOrphans: async () => [],
    sendWa,
    pingSuccess: async () => ({ ok: true }),
    pingFail: async () => ({ ok: true }),
    runQueueOnce: async () => ({ successes: [], failures: [] }),
    readFile: () => '',
    now: () => NOW_MS,
    processEnv: {},
    home: '/home/me',
    // #51: the update gate runs inside the lock on every cycle, and `home` here is
    // a fictional path — without an injected cache fs these runs would attempt a
    // real mkdir under /home/me. memfs keeps them off the real filesystem entirely.
    cacheFs: new Volume(),
    ...overrides,
  }
}

const issuesJsonl = (events) =>
  events.map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e)).join('\n') + '\n'

describe('QA cycle — translated lines preserve their interpolated values (#6)', () => {
  it('preflight failure keeps ${reason} in stderr AND ${repoSlug}:${reason} in the notify', async () => {
    const deps = baseDeps({
      // gh not authenticated → preflight fails with that reason.
      exec: makeExec({ ...baseHandlers(), 'gh auth status': { exitCode: 1, stdout: '', stderr: '' } }),
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('preflight-failed')
    expect(deps.stderr.output()).toContain('ralph cycle: preflight failed (gh not authenticated).')
    const notice = deps.sendWa.messages.find((m) => /aborted in/i.test(m))
    expect(notice).toBeDefined()
    // repoSlug and reason must both survive the translation.
    expect(notice).toContain(REPO_SLUG)
    expect(notice).toContain('gh not authenticated')
    // No Portuguese fossils.
    expect(deps.stderr.output()).not.toMatch(/pr[ée]-checagem|abortado/)
  })

  it('lock-held keeps the holder PID and the age-in-minutes in both stdout and notify', async () => {
    const deps = baseDeps({
      acquireLock: () => ({
        acquired: false,
        holder: { pid: 4242, startedAt: '2026-04-29T00:05:00.000Z', repoPath: REPO },
      }),
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('lock-held')
    // 00:05 → 00:30 = 25 minutes.
    expect(deps.stdout.output()).toContain(
      'another instance is already running (PID 4242). Skipping.',
    )
    const notice = deps.sendWa.messages.find((m) => /skipped in/i.test(m))
    expect(notice).toContain('25min')
    expect(notice).toContain('PID 4242')
    expect(deps.stdout.output()).not.toMatch(/rodando|Pulando/i)
  })

  it('orphan cleanup keeps the count and the #-prefixed id list', async () => {
    const deps = baseDeps({
      findOrphans: async () => [12, 34],
      cleanupOrphans: async () => [12, 34],
      // Queue empty afterwards so the run stops right after the cleanup line.
      exec: makeExec({
        ...baseHandlers(),
        'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '0', stderr: '' },
      }),
    })
    await cycleCommand(deps)
    expect(deps.stdout.output()).toContain('ralph cycle: cleaned 2 orphan(s): #12 #34')
    const notice = deps.sendWa.messages.find((m) => /cleaned 2 orphans/i.test(m))
    expect(notice).toContain(REPO_SLUG)
    expect(notice).toContain('#12 #34')
  })

  it('queue-count line keeps ${queueCount} and ${repoSlug}', async () => {
    const deps = baseDeps({
      exec: makeExec({
        ...baseHandlers(),
        'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '7', stderr: '' },
      }),
      readFile: () => '',
    })
    await cycleCommand(deps)
    expect(deps.stdout.output()).toContain(`ralph cycle: 7 issue(s) in the queue in ${REPO_SLUG}.`)
  })
})

describe('QA cycle — English summary shape and parity with templates/ralph.sh (#6)', () => {
  it('summary interpolates the real ok/failed counts in the "Ralph finished:" shape', async () => {
    const deps = baseDeps({
      exec: makeExec({
        ...baseHandlers(),
        'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '3', stderr: '' },
      }),
      readFile: () =>
        issuesJsonl([
          { ts: NOW_MS, verdict: 'pass', issue_number: 1 },
          { ts: NOW_MS, verdict: 'pass', issue_number: 2 },
          { ts: NOW_MS, verdict: 'fail', issue_number: 9 },
        ]),
    })
    await cycleCommand(deps)
    const summary = deps.sendWa.messages.find((m) => /Ralph finished:/.test(m))
    expect(summary).toBeDefined()
    expect(summary).toMatch(/^Ralph finished: 2 ok, 1 failed, \d+min\. OK: #1 #2\| FAIL: #9$/)
    // No Portuguese remnants in the summary.
    expect(summary).not.toMatch(/finalizado|falharam/)
  })

  it('cycle.js and templates/ralph.sh emit the identical English summary skeleton', () => {
    // Both must print "Ralph finished: N ok, M failed, ...min. OK: ...| FAIL: ..."
    const cycleSrc = readFileSync(new URL('./cycle.js', import.meta.url), 'utf8')
    const loopSrc = readFileSync(templatePath('ralph.sh'), 'utf8')
    expect(cycleSrc).toContain('Ralph finished: ${okCount} ok, ${failedCount} failed')
    expect(loopSrc).toContain('Ralph finished: ${ok_count} ok, ${fail_count} failed')
    // Neither may still carry the old Portuguese summary.
    expect(cycleSrc).not.toMatch(/finalizado|falharam/)
    expect(loopSrc).not.toMatch(/finalizado|falharam/)
  })
})

// ---------------------------------------------------------------------------
// QA augmentation for #126 — TASK_SOURCE=jira, where a scheduled run's queue depth stops
// coming from `gh issue list` and starts coming from acli.
//
// The dev's cycle.test.js proves the arm: the seam is asked, the line prints the number, an
// unusable count exits queue-empty, the shipped path reaches the library. This file adds the
// three things a wiring test tends not to reach:
//
//   THE ARGV AS AN ARRAY, not as a joined string. cycle.test.js recognises the acli call by
//   `${cmd} ${args.join(' ')}`, and a composed query SPLIT across several argv elements joins
//   to exactly the same key — so the one thing that would actually break the spawn (acli
//   receiving `--jql (project` and then five more arguments) is invisible from there. Here the
//   call is compared element by element, options object included.
//
//   WHERE THE TWO VALUES COME FROM, including where they do NOT: TASK_SOURCE still falls back
//   to the environment, JIRA_JQL deliberately does not, and the config file is read through a
//   bash-like grammar this knob exercises harder than any before it (quotes inside quotes, an
//   inline comment, a `#`). Those go through the real caller, because what matters is the
//   string that reaches acli.
//
//   THE COUNT AS A DECISION, not as a line of text. `queueCount === 0` is the short circuit,
//   so every value that is not a plain positive integer decides whether a scheduled run works
//   or sleeps — and the values the guard lets through (a negative, a float) are pinned.
//
// Hermetic: `exec` is the same injected spawner the rest of this file uses, so no acli, no gh
// and no tmux process is ever started, and `readFile` answers from a literal.
// ---------------------------------------------------------------------------

const JIRA_JQL = 'project = RALPH AND statusCategory != Done'
const NL = String.fromCharCode(0x0a)
const jiraConfigText = (jql) => `TASK_SOURCE="jira"${NL}JIRA_JQL="${jql}"${NL}`

// The config text is the seam under test, so it is written as config LINES rather than
// injected as an already-parsed value.
const jiraDeps = (text = jiraConfigText(JIRA_JQL), overrides = {}) =>
  baseDeps({
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? text : ''),
    ...overrides,
  })

const acliCallsOf = (deps) => deps.exec.calls.filter((c) => c.cmd === 'acli')

// What reached acli as the --jql argument, or undefined when nothing did.
const jqlSentTo = (deps) => {
  const call = acliCallsOf(deps)[0]
  return call && call.args[call.args.indexOf('--jql') + 1]
}

describe('QA cycle — the acli spawn a jira run actually makes (#126)', () => {
  it('spawns acli exactly once, with the composed query as ONE argv element', async () => {
    // Element-by-element rather than by joined key: the composed query contains spaces,
    // parentheses and commas, and a query split across argv elements produces an identical
    // joined string while being a completely different command line.
    const composed = composeJiraJql(JIRA_JQL).jql
    const deps = jiraDeps(jiraConfigText(JIRA_JQL), {
      exec: makeExec({
        ...baseHandlers(),
        [`acli jira workitem search --jql ${composed} --count`]: {
          exitCode: 0,
          stdout: '5' + NL,
          stderr: '',
        },
      }),
    })
    await cycleCommand(deps)
    const calls = acliCallsOf(deps)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['jira', 'workitem', 'search', '--jql', composed, '--count'])
    // `shell: true` here would hand a query full of quotes and parentheses to /bin/sh; the
    // whole options object is compared so it cannot arrive unnoticed.
    expect(calls[0].options).toEqual({ reject: false })
  })

  it('never asks gh for a count and never touches the folder seam in jira mode', async () => {
    let folderCalls = 0
    const deps = jiraDeps(jiraConfigText(JIRA_JQL), {
      folderQueueCount: async () => {
        folderCalls += 1
        return 7
      },
      jiraQueueCount: async () => 3,
    })
    await cycleCommand(deps)
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh issue list'))).toBe(false)
    expect(folderCalls).toBe(0)
    // ...and `gh auth status` still ran: only the COUNT moved to Jira.
    expect(deps.exec.calls.some((c) => c.key === 'gh auth status')).toBe(true)
  })

  it('sends a RELOCATED ordering, so the user’s ORDER BY reaches acli last', async () => {
    const deps = jiraDeps(jiraConfigText('project = R ORDER BY priority DESC'))
    await cycleCommand(deps)
    const sent = jqlSentTo(deps)
    expect(sent).toBe(composeJiraJql('project = R ORDER BY priority DESC').jql)
    expect(sent.endsWith('ORDER BY priority DESC')).toBe(true)
  })

  const brokenAcli = {
    'acli is not installed (execa ENOENT shape: no exitCode)': { failed: true },
    'the session is not authenticated': { exitCode: 2, stdout: '', stderr: 'not logged in' },
    'acli printed prose instead of a count': { exitCode: 0, stdout: 'Total: 7 work items' },
    'acli printed nothing': { exitCode: 0, stdout: '' },
  }

  for (const [label, result] of Object.entries(brokenAcli)) {
    it(`sleeps with queue-empty, exit 0, when ${label}`, async () => {
      // Through the DEFAULT seam — the shipped path, the one a cron entry gets. A scheduled
      // run must not abort or exit non-zero over a diagnostic problem; it says the queue is
      // empty and the next tick tries again. `ralph status` is where the same failure reads as
      // `unknown`, which is the pair of postures #126 chose on purpose.
      const deps = jiraDeps(jiraConfigText(JIRA_JQL), {
        exec: makeExec({
          ...baseHandlers(),
          [`acli jira workitem search --jql ${composeJiraJql(JIRA_JQL).jql} --count`]: result,
        }),
      })
      const r = await cycleCommand(deps)
      expect(r, label).toMatchObject({ exitCode: 0, status: 'queue-empty', skipped: true })
      expect(acliCallsOf(deps), label).toHaveLength(1)
    })
  }

  it('emits the queue-empty RALPH_CYCLE_EVENT a scheduler parses, with a timestamp', async () => {
    // The event stream is the machine-readable half of this command, and queue-empty is the
    // status a jira run will emit most often. Parsed rather than substring-matched, so a field
    // renamed or dropped fails here.
    const deps = jiraDeps(jiraConfigText(JIRA_JQL), { jiraQueueCount: async () => 0 })
    await cycleCommand(deps)
    const line = deps.stdout
      .output()
      .split(NL)
      .find((l) => l.startsWith('RALPH_CYCLE_EVENT '))
    expect(line).toBeDefined()
    expect(JSON.parse(line.slice('RALPH_CYCLE_EVENT '.length))).toEqual({
      ts: new Date(NOW_MS).toISOString(),
      status: 'queue-empty',
      ok: 0,
      failed: 0,
      durationMin: 0,
      processed: 0,
    })
  })

  it('runs the loop when the jira count is positive — the number is a DECISION, not a line', async () => {
    // Anti-vacuity for every "prints N issue(s)" assertion: the count is what decides whether
    // `runQueueOnce` is reached at all, and the notify line carries it too.
    let ran = 0
    const deps = jiraDeps(jiraConfigText(JIRA_JQL), {
      jiraQueueCount: async () => 3,
      runQueueOnce: async () => {
        ran += 1
        return { successes: [], failures: [] }
      },
    })
    const result = await cycleCommand(deps)
    expect(ran).toBe(1)
    expect(result.status).not.toBe('queue-empty')
    expect(deps.sendWa.messages.some((m) => m.includes('3 issues'))).toBe(true)
  })
})

describe('QA cycle — the counts the zero-guard lets through (#126)', () => {
  // `queueCount === 0` is the short circuit and `Number.isFinite` is the only filter in front
  // of it, so these are the values a misbehaving seam can push past both. None is reachable
  // from the shipped jira-queue library (its parse yields a safe non-negative integer or 0),
  // which is exactly why they are pinned here: a future counter that returns a difference, or
  // an average, would be believed.

  it('treats Infinity as an empty queue, because it is not finite', async () => {
    const deps = jiraDeps(jiraConfigText(JIRA_JQL), { jiraQueueCount: async () => Infinity })
    expect((await cycleCommand(deps)).status).toBe('queue-empty')
  })

  it('BELIEVES a negative count and launches the loop (pinned wart)', async () => {
    // `-3 !== 0`, so the run proceeds and prints "-3 issue(s) in the queue". Harmless today
    // and nonsense to read; the guard would have to be `> 0` to reject it.
    const deps = jiraDeps(jiraConfigText(JIRA_JQL), { jiraQueueCount: async () => -3 })
    const result = await cycleCommand(deps)
    expect(result.status).not.toBe('queue-empty')
    expect(deps.stdout.output()).toContain(`ralph cycle: -3 issue(s) in the queue in ${REPO_SLUG}.`)
  })

  it('BELIEVES a fractional count and prints it verbatim (pinned wart)', async () => {
    const deps = jiraDeps(jiraConfigText(JIRA_JQL), { jiraQueueCount: async () => 2.5 })
    await cycleCommand(deps)
    expect(deps.stdout.output()).toContain(`ralph cycle: 2.5 issue(s) in the queue in ${REPO_SLUG}.`)
  })

  it('reads a count of exactly 0 as the queue really being empty', async () => {
    // The other half of the pair, and the reason "unusable → 0" is a posture rather than a
    // shortcut: 0 from acli and 0 from a failure are indistinguishable HERE by design, because
    // both mean "nothing provable to do this tick".
    const deps = jiraDeps(jiraConfigText(JIRA_JQL), { jiraQueueCount: async () => 0 })
    const result = await cycleCommand(deps)
    expect(result).toMatchObject({ status: 'queue-empty', exitCode: 0, processed: 0 })
  })
})

describe('QA cycle — where TASK_SOURCE and JIRA_JQL come from (#126)', () => {
  it('takes the source from the environment while the query stays config-only', async () => {
    // Both halves of the asymmetry in one run. TASK_SOURCE falls back to `processEnv`, so the
    // jira arm is selected; JIRA_JQL does not, so the query is unconfigured and no process is
    // started — the run sleeps rather than counting the wrong board.
    const deps = jiraDeps(`RALPH_AGENT="claude"${NL}`, {
      processEnv: { TASK_SOURCE: 'jira', JIRA_JQL: 'project = FROMENV' },
    })
    const result = await cycleCommand(deps)
    expect(result.status).toBe('queue-empty')
    expect(acliCallsOf(deps)).toEqual([])
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh issue list'))).toBe(false)
  })

  it('IGNORES a JIRA_JQL in the environment even when the config declares one', async () => {
    // The template ships `JIRA_JQL=""` and the loop sources that file with `set -a`, so every
    // child of a run has the empty value exported: an env fallback would make the query mean
    // one thing in this process and another in the next. The config wins, unconditionally.
    const deps = jiraDeps(jiraConfigText('project = FROMFILE'), {
      processEnv: { JIRA_JQL: 'project = FROMENV' },
    })
    await cycleCommand(deps)
    expect(jqlSentTo(deps)).toBe(composeJiraJql('project = FROMFILE').jql)
  })

  it('reads ralph.config.sh TWICE per cycle — the source read and the preflight agent read', async () => {
    // Pinned as a NUMBER because #126's own comment calls this file's config read "one read
    // answering two questions", and the file it names is opened again a few lines later:
    // `runPreflight` calls readConfigAgent(configPath) for RALPH_AGENT. So the atomicity
    // argument covers TASK_SOURCE and JIRA_JQL relative to each other, and NOT the agent —
    // a config rewritten mid-cycle can still yield an agent from a different revision.
    // Two is the current, deliberate-enough number; three would mean a new re-read crept in.
    const reads = []
    const deps = jiraDeps(jiraConfigText(JIRA_JQL), {
      readFile: (p) => {
        reads.push(String(p))
        return String(p).endsWith('ralph.config.sh') ? jiraConfigText(JIRA_JQL) : ''
      },
      jiraQueueCount: async () => 0,
    })
    await cycleCommand(deps)
    expect(reads.filter((p) => p.endsWith('ralph.config.sh'))).toHaveLength(2)
  })

  const noQuery = {
    'a commented-out assignment': `TASK_SOURCE="jira"${NL}# JIRA_JQL="project = R"${NL}`,
    'the empty value the template ships': `TASK_SOURCE="jira"${NL}JIRA_JQL=""${NL}`,
    'a whitespace-only value': `TASK_SOURCE="jira"${NL}JIRA_JQL="   "${NL}`,
    'a bare assignment with no value': `TASK_SOURCE="jira"${NL}JIRA_JQL=${NL}`,
    'a similarly named knob and nothing else': `TASK_SOURCE="jira"${NL}JIRA_JQLX="project = R"${NL}`,
    'an ordering with no clause in front of it': `TASK_SOURCE="jira"${NL}JIRA_JQL="ORDER BY created ASC"${NL}`,
  }

  for (const [label, text] of Object.entries(noQuery)) {
    it(`starts no process and sleeps for ${label}`, async () => {
      // The acceptance criterion, at the command: Ralph's half of the query on its own selects
      // every work item on the Jira site, so an unconfigured query must count nothing rather
      // than counting everything.
      const deps = jiraDeps(text)
      const result = await cycleCommand(deps)
      expect(result.status, label).toBe('queue-empty')
      expect(acliCallsOf(deps), label).toEqual([])
    })
  }

  const reaching = {
    'an inline comment after the closing quote': [
      `TASK_SOURCE="jira"${NL}JIRA_JQL="project = R" # my board${NL}`,
      'project = R',
    ],
    'a single-quoted value holding a JQL string literal': [
      `TASK_SOURCE="jira"${NL}JIRA_JQL='summary ~ "order by" AND project = R'${NL}`,
      `summary ~ "order by" AND project = R`,
    ],
    'an export prefix': [
      `TASK_SOURCE="jira"${NL}export JIRA_JQL="project = R"${NL}`,
      'project = R',
    ],
    'the LAST of two assignments, as bash would read it': [
      `TASK_SOURCE="jira"${NL}JIRA_JQL="project = A"${NL}JIRA_JQL="project = B"${NL}`,
      'project = B',
    ],
    'an unquoted value': [`TASK_SOURCE="jira"${NL}JIRA_JQL=project=R${NL}`, 'project=R'],
  }

  for (const [label, [text, expected]] of Object.entries(reaching)) {
    it(`sends the composed query to acli for ${label}`, async () => {
      const deps = jiraDeps(text)
      await cycleCommand(deps)
      expect(jqlSentTo(deps), label).toBe(composeJiraJql(expected).jql)
    })
  }

  it('TRUNCATES a value whose JQL literal is double-quoted and followed by a hash', async () => {
    // The sharpest edge this feature has, pinned at the command that will run unattended.
    // parse-config-var.js closes a quoted value at the first quote whose tail looks like a
    // comment and does not model a backslash escape, so `JIRA_JQL="summary ~ \"#123\""` reads
    // as `summary ~ \` — a query Jira rejects, which acli reports as a non-zero exit, which
    // this command reads as an empty queue. A cron entry configured that way sleeps forever
    // and says nothing. The parser's own header argues the divergence is safe because no knob
    // read through it accepts a `#`; JIRA_JQL is the first one that does.
    const BS = String.fromCharCode(0x5c)
    const deps = jiraDeps(`TASK_SOURCE="jira"${NL}JIRA_JQL="summary ~ ${BS}"#123${BS}""${NL}`)
    await cycleCommand(deps)
    expect(jqlSentTo(deps)).toBe(composeJiraJql(`summary ~ ${BS}`).jql)
    expect(jqlSentTo(deps)).not.toContain('123')
  })

  it('resolves an uppercase TASK_SOURCE to the jira arm, query and all', async () => {
    const deps = jiraDeps(`TASK_SOURCE="JIRA"${NL}JIRA_JQL="${JIRA_JQL}"${NL}`)
    await cycleCommand(deps)
    expect(jqlSentTo(deps)).toBe(composeJiraJql(JIRA_JQL).jql)
    expect(deps.exec.calls.some((c) => c.key.startsWith('gh issue list'))).toBe(false)
  })

  it('leaves github mode counting through gh when no TASK_SOURCE is set anywhere', async () => {
    // The default must not have moved: a repo with no config and no environment still counts
    // GitHub issues, and never starts acli.
    const deps = baseDeps({
      exec: makeExec({
        ...baseHandlers(),
        'gh issue list --search state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge --limit 100 --json number -q . | length':
          { exitCode: 0, stdout: '4', stderr: '' },
      }),
    })
    await cycleCommand(deps)
    expect(deps.stdout.output()).toContain(`ralph cycle: 4 issue(s) in the queue in ${REPO_SLUG}.`)
    expect(acliCallsOf(deps)).toEqual([])
  })
})
