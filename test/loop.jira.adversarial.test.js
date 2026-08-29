import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeJiraJql } from '../lib/jira-jql.js'
import { templatePath } from '../lib/paths.js'

// QA companion to `describe('ralph.sh jira task source — issue #127')` in test/loop.test.js.
// That suite owns the jira arm's happy path — select, claim, record, name the key. This file
// asks the questions a happy path cannot, and every one of them is about the SHELL rather
// than about the JS:
//
//   1. TWO NEW HOSTILE STRINGS CROSS A SHELL HERE, and neither existed before #127.
//      `JIRA_JQL` comes out of ralph.config.sh — a human wrote it, quotes and parentheses and
//      all — and `task_key` comes out of ACLI'S OWN JSON, so the loop now interpolates a
//      value chosen by a remote system into `claim "$task_key"` and into an `echo`. Both are
//      asserted the only way an injection can honestly be ruled out: the fake acli records
//      `$#` and each argument on its own line, and the test looks for the FILES a command
//      substitution would have created.
//
//   2. THE LOOP MUST TERMINATE on every failure, and that is not obvious. A claim that
//      cannot be written leaves the ticket eligible, so the query keeps returning it, so the
//      loop would hand the same ticket out forever — the zero-progress guard is what stops
//      that, and `res.signal === null` plus a BOUNDED acli call count is what proves it
//      stopped. A test that only checked the warning text would pass just as happily against
//      an infinite loop killed by its own timeout.
//
//   3. `set -u` IS ON AND `task_key` IS SHARED. One `begin-task` call serves all three
//      sources, so the two arms that have no key must still run — proven here by running
//      them, not by reading the declaration, because the failure mode is a fatal
//      `unbound variable` rather than a wrong value.
//
// NO TEST HERE RUNS THE REAL `acli`. It is a bash script on a prepended PATH, a claim is a
// WRITE to somebody's board, and this machine may well have the real Atlassian CLI installed
// — so the stub is never removed from PATH, not even by the test about a missing binary
// (that one makes the stub answer the way an absent command does instead). `node` is stubbed
// too, delegating only the real bridges the loop needs; the `claude` stub exists purely to
// record that #127 invokes NO agent for a Jira ticket.
//
// Control characters are built with String.fromCharCode and reach the fixtures through
// JSON.stringify — no literal control byte in this source (test/source-control-bytes.test.js
// guards that), and no shell quoting of a hostile value either: every acli payload is written
// to a FILE from Node and `cat`ted by the stub, so a key containing a quote cannot break the
// harness instead of the code under test.

const RALPH_TEMPLATE = templatePath('ralph.sh')
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

const JQL = 'project = RALPH AND statusCategory != Done'
const LF = String.fromCharCode(0x0a)
const TAB = String.fromCharCode(0x09)

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

const readLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
const acliLog = () => join(workdir, 'acli-called.log')
const ghLog = () => join(workdir, 'gh-called.log')
const claudeLog = () => join(workdir, 'claude-called.log')
const claimedFlag = () => join(workdir, 'acli-claimed')

// Every acli invocation as `{ argc, args }`. ARGC PLUS ONE LINE PER ARGUMENT is the whole
// point of logging it this way: a query a shell had split would arrive as several arguments,
// and a joined `$*` log — the shape test/loop.test.js uses, correctly, for its own questions
// — cannot tell that apart from one argument that merely contains spaces.
function acliCalls() {
  const calls = []
  for (const line of readLog(acliLog()).split(LF)) {
    if (line.startsWith('ARGC:')) calls.push({ argc: Number(line.slice(5)), args: [] })
    else if (line.startsWith('ARG:') && calls.length > 0) calls.at(-1).args.push(line.slice(4))
  }
  return calls
}
// `jira workitem <sub> …` — the third argument names the operation.
const callsFor = (sub) => acliCalls().filter((call) => call.args[2] === sub)
const searches = (flag) => callsFor('search').filter((call) => call.args.includes(flag))
const valueAfter = (call, flag) => call.args[call.args.indexOf(flag) + 1]

// The files a shell would have created had any of these values been interpolated into one.
// Checked in the loop's own cwd, which is where a `$(touch …)` inside it would land.
const INJECTION_ARTIFACTS = ['pwned-sub', 'pwned-tick', 'pwned-semi', 'pwned-key']
const injected = () => INJECTION_ARTIFACTS.filter((name) => existsSync(join(workdir, name)))

// One acli stub for the whole file, and it reads its answers from FILES this function
// writes — so an arbitrary key or summary never has to survive shell quoting to be tested.
// The `search` arms consult the flag the `edit` arm writes, which is this fixture's stand-in
// for Jira honouring #126's `in-progress` exclusion: it is what makes a SUCCESSFUL claim
// drain the queue and an unsuccessful one keep returning the same ticket.
//
// IT IS ALSO KEY-AWARE, and that is not decoration: `view`/`edit` refuse a `--key` that is
// not the ticket the search handed out, the way a real board refuses a work item that does
// not exist. Without that, a test in which bash MANGLES the key would still see a claim
// succeed against the mangled name and would call the queue drained — the fixture would be
// hiding the bug the test was written to find.
function seedStubs({
  key = 'FOO-123',
  summary = 'Do the thing',
  labels = '["frontend","p2"]',
  count = '1',
  pickJson = null,
  editBody = 'touch "$RALPH_TEST_FLAG"',
} = {}) {
  writeFileSync(join(workdir, 'acli-count.txt'), `${count}${LF}`)
  // The key the board would answer to — trimmed, because lib/jira-key.js trims before it
  // sends and a trimmed key names the same ticket.
  writeFileSync(join(workdir, 'acli-key.txt'), key.trim())
  writeFileSync(
    join(workdir, 'acli-pick.json'),
    pickJson ?? JSON.stringify([{ key, fields: { summary } }]),
  )
  writeFileSync(
    join(workdir, 'acli-view.json'),
    `{"key":${JSON.stringify(key)},"fields":{"labels":${labels}}}`,
  )
  writeStub(
    'node',
    `#!/bin/bash
case "$*" in
  *jira-queue.js*) exec "${REAL_NODE}" "$@" ;;
  *run-state.js*) exec "${REAL_NODE}" "$@" ;;
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
  *folder-queue.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`,
  )
  writeStub(
    'acli',
    `#!/bin/bash
RALPH_TEST_FLAG="${claimedFlag()}"
{
  echo "ARGC:$#"
  for a in "$@"; do echo "ARG:$a"; done
} >> "${acliLog()}"
# The value of --key, taken from the argv rather than from a fixed position.
asked=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--key" ]; then asked="$a"; fi
  prev="$a"
done
want=$(cat "${join(workdir, 'acli-key.txt')}")
case "$*" in
  *--count*)
    if [ -f "$RALPH_TEST_FLAG" ]; then echo 0; else cat "${join(workdir, 'acli-count.txt')}"; fi ;;
  *"--limit 1"*)
    if [ -f "$RALPH_TEST_FLAG" ]; then
      echo '[]'
    else
      cat "${join(workdir, 'acli-pick.json')}"
    fi ;;
  *" view "*)
    if [ "$asked" != "$want" ]; then echo "acli: work item $asked not found" >&2; exit 1; fi
    cat "${join(workdir, 'acli-view.json')}" ;;
  *" edit "*)
    if [ "$asked" != "$want" ]; then echo "acli: work item $asked not found" >&2; exit 1; fi
    ${editBody} ;;
esac
exit 0
`,
  )
  writeStub('jq', `#!/bin/bash\ncat > /dev/null 2>/dev/null || true\nexit 0\n`)
  writeStub('gh', `#!/bin/bash\necho "$*" >> "${ghLog()}"\nexit 0\n`)
  writeStub('claude', `#!/bin/bash\ncat > /dev/null\necho "$*" >> "${claudeLog()}"\nexit 0\n`)
}

function runLoop({ timeout = 25000, extraEnv = {}, args = [] } = {}) {
  return spawnSync('bash', [RALPH_TEMPLATE, ...args], {
    cwd: workdir,
    env: {
      ...process.env,
      PATH: `${bindir}:${process.env.PATH}`,
      RALPH_TMUX_SESSION: 'ralph-test',
      CALLMEBOT_KEY: '',
      WHATSAPP_PHONE: '',
      ...extraEnv,
    },
    timeout,
    encoding: 'utf8',
  })
}

const runJira = (extraEnv = {}, args = []) =>
  runLoop({ extraEnv: { TASK_SOURCE: 'jira', JIRA_JQL: JQL, ...extraEnv }, args })

const record = () => JSON.parse(readFileSync(join(workdir, '.ralph', 'run-state.json'), 'utf8'))

// A run that FINISHED rather than one that was killed. `signal` is the assertion that matters
// most in this file: a loop that spins forever dies of the timeout with SIGTERM, and most of
// the other expectations below would still pass against it.
const finished = (res) => {
  expect(res.signal, `loop hung. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeNull()
  expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-jira-adv-'))
  bindir = join(workdir, 'bin')
  mkdirSync(bindir, { recursive: true })
  mkdirSync(join(workdir, 'logs'), { recursive: true })
  mkdirSync(join(workdir, '.ralph'), { recursive: true })
  writeFileSync(join(workdir, '.ralph', 'state.json'), '{}')
  writeStub(
    'git',
    `#!/bin/bash
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  echo "${workdir}"
  exit 0
fi
exit 0
`,
  )
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
  seedStubs()
})

afterEach(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true })
})

describe('ralph.sh jira arm — a hostile JIRA_JQL crosses a shell (#127 QA)', () => {
  // Each row is a query somebody could plausibly write, carrying characters a shell acts on.
  // The composed value is compared against lib/jira-jql.js's own output, so the test knows
  // what ONE argument is supposed to look like without re-spelling the composition here.
  const queries = {
    'quotes around a phrase': `project = R AND summary ~ "order by" AND labels != x`,
    'a command substitution': `project = R AND summary ~ "$(touch pwned-sub)"`,
    'a backquoted command': 'project = R AND summary ~ "`touch pwned-tick`"',
    'a semicolon and a second command': `project = R ; touch pwned-semi`,
    'single quotes and a glob': `project = R AND summary ~ '*' AND assignee != me`,
    'a dollar-brace expansion': `project = R AND summary ~ "\${HOME}"`,
  }

  for (const [what, jql] of Object.entries(queries)) {
    it(`sends ${what} to acli as ONE argument, and runs none of it`, () => {
      const res = runJira({ JIRA_JQL: jql })
      finished(res)
      // Nothing was executed — the assertion an argv check alone cannot make, because a
      // substitution that ran and produced empty output leaves the argv looking innocent.
      expect(injected(), `a shell ran part of the query: ${injected().join(', ')}`).toEqual([])

      const composed = composeJiraJql(jql).jql
      const counted = searches('--count')
      const picked = searches('--limit')
      expect(counted.length, readLog(acliLog())).toBeGreaterThan(0)
      expect(picked.length, readLog(acliLog())).toBeGreaterThan(0)
      for (const call of [...counted, ...picked]) {
        // ONE element holds the whole composed query, and argc equals the number of elements
        // logged — so the query was neither split into words nor re-quoted on the way.
        expect(call.args, `${what}: ${JSON.stringify(call.args)}`).toContain(composed)
        expect(call.argc, `${what}: ${JSON.stringify(call.args)}`).toBe(call.args.length)
      }
      // ...and the user's own clause is in there un-mangled, beside Ralph's exclusion.
      expect(
        counted[0].args.some((a) => a.includes(jql)),
        what,
      ).toBe(true)
    })
  }

  it('never touches gh or the agent in jira mode, whatever the query says', () => {
    // Two arms Ralph must NOT have wandered into: github's queue, and the agent #127
    // deliberately does not invoke for a Jira ticket yet.
    const res = runJira({ JIRA_JQL: `project = R ; touch pwned-semi` })
    finished(res)
    expect(existsSync(ghLog()), `gh was invoked:\n${readLog(ghLog())}`).toBe(false)
    expect(existsSync(claudeLog()), `the agent ran:\n${readLog(claudeLog())}`).toBe(false)
  })

  it('spawns no acli at all for an unconfigured JIRA_JQL, and still exits cleanly', () => {
    // The refusal lives in lib/jira-jql.js — Ralph's half of the query alone would select
    // every work item on the whole Jira site — and the loop reads it as an empty queue. All
    // three spellings of "not configured" that bash can hand over: absent, empty, blank.
    for (const value of [undefined, '', '   ']) {
      rmSync(acliLog(), { force: true })
      const res =
        value === undefined
          ? runLoop({ extraEnv: { TASK_SOURCE: 'jira' } })
          : runJira({ JIRA_JQL: value })
      finished(res)
      expect(res.stdout, String(value)).toContain('Queue empty, exiting.')
      expect(acliCalls(), `${value}: ${readLog(acliLog())}`).toEqual([])
      expect(existsSync(ghLog()), String(value)).toBe(false)
    }
  })
})

describe('ralph.sh jira arm — a hostile task_key crosses a shell (#127 QA)', () => {
  // The key comes from ACLI'S JSON, so it is the first value in Ralph's loop that a REMOTE
  // system chooses and bash then interpolates — into `claim "$task_key"`, into `begin-task`
  // and into an `echo`. Each row is what a compromised, misconfigured or simply odd Jira
  // could answer with.
  const keys = {
    'a semicolon and a second command': 'FOO-1; touch pwned-semi',
    'a command substitution': 'FOO-1$(touch pwned-key)',
    'a backquoted command': 'FOO-1`touch pwned-tick`',
    'a leading dash, which could read as a flag': '--key=FOO-1',
    'a glob': 'FOO-*',
    'quotes of both kinds': `FOO-1"'`,
    'a dollar-brace expansion': 'FOO-${HOME}',
    'a trailing space': 'FOO-1 ',
  }

  for (const [what, key] of Object.entries(keys)) {
    it(`claims a key carrying ${what} as ONE argument, executing none of it`, () => {
      seedStubs({ key })
      const res = runJira()
      finished(res)
      expect(injected(), `a shell ran part of the key: ${injected().join(', ')}`).toEqual([])

      // The claim's READ names the key as one argument, and argc proves nothing was split.
      const read = callsFor('view')
      expect(read.length, readLog(acliLog())).toBeGreaterThan(0)
      // A trailing space is the one row where the key reaching acli is not the key acli sent:
      // lib/jira-key.js trims, because a trimmed key still names the same ticket.
      expect(valueAfter(read[0], '--key'), what).toBe(key.trim())
      expect(read[0].argc, JSON.stringify(read[0].args)).toBe(read[0].args.length)
      // ...and the iteration line names the ticket, as `ralph status` will.
      expect(res.stdout, what).toContain(`==> Iteration for ${key.trim()}`)
    })
  }

  it('records a hostile key in the run record without breaking the record', () => {
    // `.ralph/run-state.json` is written by lib/run-state.js and read by `ralph status`, so a
    // key full of shell metacharacters has to land as a JSON STRING VALUE rather than as a
    // file the status view can no longer parse.
    seedStubs({ key: 'FOO-1; touch pwned-semi' })
    const res = runJira()
    finished(res)
    expect(record().current.task_key).toBe('FOO-1; touch pwned-semi')
    // Not a key the grammar recognises, so there is no number to derive from it: a name and
    // no handle, which is a shape the record has always allowed.
    expect(record().current.number).toBe(null)
    expect(injected()).toEqual([])
  })

  it('does not execute a key containing a NEWLINE, and still terminates', () => {
    // A newline is the one metacharacter neither the `$(…)` capture nor the tab cut removes,
    // so `task_key` genuinely holds two lines here. The assertions are deliberately narrower
    // than the rows above — a one-line-per-argument log cannot be read unambiguously once an
    // argument contains a line break — but the two that matter still hold: nothing ran, and
    // the loop ended.
    seedStubs({ key: `FOO-1${LF}touch pwned-key` })
    const res = runJira()
    finished(res)
    expect(injected(), `a shell ran part of the key: ${injected().join(', ')}`).toEqual([])
    expect(res.stdout).toContain('==> Iteration for FOO-1')
    // It reached acli as TEXT: the second line is in the argv log, not in a filesystem.
    expect(readLog(acliLog())).toContain('touch pwned-key')
  })

  it('cuts the key at the FIRST tab, and the zero-progress guard ends the run', () => {
    // A key containing a tab collides with the `<key>\t<summary>` wire format the CLI prints:
    // bash reads `FOO` and tries to claim THAT, the board has no such work item, so the real
    // ticket keeps matching the query and would be handed out forever. Measured end to end,
    // because the graceful part is not the claim — it is the guard — and only a bounded call
    // count proves the loop did not spin.
    seedStubs({ key: `FOO${TAB}-1` })
    const res = runJira()
    finished(res)
    expect(res.stdout).toContain('==> Iteration for FOO ')
    expect(valueAfter(callsFor('view')[0], '--key')).toBe('FOO')
    expect(res.stderr).toContain('Could not claim FOO')
    expect(res.stderr).toContain('no progress on FOO (re-selected). Aborting the loop.')
    expect(acliCalls().length, readLog(acliLog())).toBeLessThan(12)
  })
})

describe('ralph.sh jira arm — the summary cannot be mistaken for the key (#127 QA)', () => {
  // `pick` prints `<key>\t<summary>` on one line and bash keeps the part before the tab, so
  // every one of these summaries must leave the SAME key behind. The summary itself is never
  // passed anywhere — nothing in the jira arm forwards it — which is what makes it cheap to
  // be exhaustive here.
  const summaries = {
    'a summary full of spaces': 'Fix the thing that broke',
    'a summary containing a tab': `before${TAB}after`,
    'a summary containing quotes': `a "quoted" thing`,
    'a summary containing a dollar sign': 'costs $5 to $(run)',
    'a summary containing a newline': `first${LF}second`,
    'an empty summary': '',
  }

  for (const [what, summary] of Object.entries(summaries)) {
    it(`claims FOO-123 with ${what}`, () => {
      seedStubs({ summary })
      const res = runJira()
      finished(res)
      expect(res.stdout, what).toContain('==> Iteration for FOO-123 (1 remaining)')
      const edit = callsFor('edit')
      expect(edit, `${what}: ${readLog(acliLog())}`).toHaveLength(1)
      // The union survived and the write is unattended — both re-asserted here because a
      // summary that leaked into the argv would show up in exactly these two places.
      expect(valueAfter(edit[0], '--labels'), what).toBe('frontend,p2,in-progress')
      expect(edit[0].args.at(-1), what).toBe('--yes')
      expect(record().current.task_key, what).toBe('FOO-123')
      expect(injected(), what).toEqual([])
      // MEASURED, not assumed: the summary reaches no argv at all. Every acli argument of the
      // whole run is checked, which is what makes "the summary is display text" a fact here
      // rather than a reading of the script.
      if (summary !== '') {
        const leaked = acliCalls().flatMap((call) => call.args.filter((a) => a.includes(summary)))
        expect(leaked, what).toEqual([])
      }
    })
  }
})

describe('ralph.sh jira arm — every failure path terminates (#127 QA)', () => {
  it('warns, carries on, and aborts on re-selection when the claim cannot be written', () => {
    // The failure the whole arm is designed around: acli reads fine and refuses to WRITE, so
    // the ticket stays eligible and the query keeps returning it. Two iterations, a warning
    // each, then the guard — and the run still exits 0, because one unwritable ticket must
    // not take a scheduled cycle down with it.
    seedStubs({ editBody: 'echo "permission denied" >&2; exit 1' })
    const res = runJira()
    finished(res)
    const iterations = res.stdout.split(LF).filter((l) => l.includes('==> Iteration for'))
    expect(iterations, res.stdout).toHaveLength(2)
    expect(res.stderr).toContain('Could not claim FOO-123')
    expect(res.stderr).toContain('no progress on FOO-123 (re-selected). Aborting the loop.')
    // The CLI's own sentence reaches the operator too — it is the only record of what acli
    // said, and the loop's `2>/dev/null` is on the PICK, not on the claim.
    expect(res.stderr).toContain('jira-queue.js:')
    // Bounded: four acli calls per iteration at most, so a spin would be an order of
    // magnitude past this.
    expect(acliCalls().length, readLog(acliLog())).toBeLessThan(12)
  })

  it('stops when the read the claim depends on comes back unusable — no write, no spin', () => {
    // The claim's other refusal, and the more interesting one: acli answers, but not with a
    // label LIST. lib/jira-queue.js writes nothing rather than guess, which means the board
    // never changes and the ticket is re-selected — so again it is the guard that ends the
    // run, and the absence of an `edit` argv is what proves nothing was overwritten.
    seedStubs({ labels: '"frontend"' })
    const res = runJira()
    finished(res)
    expect(callsFor('edit'), readLog(acliLog())).toHaveLength(0)
    expect(res.stderr).toContain('left alone')
    expect(res.stderr).toContain('Aborting the loop.')
  })

  it('exits on a count that promises work the pick cannot produce', () => {
    // count and pick are two acli calls with a gap between them, so a ticket somebody else
    // claimed inside that gap is an ordinary race rather than a corner case. The loop must
    // read the empty pick as an empty queue instead of claiming an empty key.
    seedStubs({ count: '5', pickJson: '[]' })
    const res = runJira()
    finished(res)
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).not.toContain('==> Iteration for')
    // Nothing was claimed and nothing was even read: an empty key must not reach a write.
    expect(callsFor('view'), readLog(acliLog())).toHaveLength(0)
    expect(callsFor('edit'), readLog(acliLog())).toHaveLength(0)
  })

  it('drains the queue in --once mode and exits 0', () => {
    // `ralph cycle` drives `--once`, and the early exit for it sits AFTER the loop — so once
    // mode DRAINS rather than stopping after one ticket. Pinned because the jira arm
    // `continue`s past every outcome-handling block below it, which is precisely where an
    // early exit would have been.
    const res = runJira({}, ['--once'])
    finished(res)
    expect(res.stdout).toContain('==> Iteration for FOO-123 (1 remaining)')
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(callsFor('edit')).toHaveLength(1)
    expect(record().current.task_key).toBe('FOO-123')
  })

  it('reads an acli that answers like a missing binary as an empty queue', () => {
    // The state on any machine where the Atlassian CLI is not installed. The stub is NOT
    // removed from PATH to model this — a real `acli` may well be installed on the machine
    // running these tests, and no test in this repo may reach it — so it answers the way an
    // absent command does instead: 127, with the shell's own words on stderr.
    writeStub(
      'acli',
      `#!/bin/bash
echo "ARGC:$#" >> "${acliLog()}"
echo "bash: acli: command not found" >&2
exit 127
`,
    )
    const res = runJira()
    finished(res)
    // `queue_count` swallows the error and floors at 0, so the run ends cleanly rather than
    // aborting under `set -e` or announcing a queue it cannot see.
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).not.toContain('==> Iteration for')
  })
})

describe('ralph.sh — the other two sources still run under a shared task_key (#127 QA)', () => {
  // `task_key` is declared once outside the loop and passed by the ONE `begin-task` call that
  // serves all three sources, with `set -u` on. These tests are the proof that the arms
  // WITHOUT a key still work: the regression would be `task_key: unbound variable`, a fatal
  // shell error rather than a wrong value, and no library test can see it.
  it('runs a github iteration and records task_key null', () => {
    writeFileSync(join(workdir, 'count.txt'), '1')
    writeStub(
      'gh',
      `#!/bin/bash
echo "$*" >> "${ghLog()}"
CNT="${join(workdir, 'count.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cnt=$(cat "$CNT")
  case "$*" in
    *sort:created-asc*) echo 42; echo 0 > "$CNT" ;;
    *) echo "$cnt" ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *state*) echo "CLOSED" ;;
    *) echo "" ;;
  esac
  exit 0
fi
exit 0
`,
    )
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo "$*" >> "${claudeLog()}"
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )
    const res = runLoop()
    finished(res)
    expect(`${res.stdout}${res.stderr}`).not.toContain('unbound variable')
    expect(res.stdout).toContain('==> Iteration for issue #42')
    // A number and no key — the mirror image of the jira record above.
    expect(record().current).toMatchObject({ number: 42, task_key: null })
    // The github arm knows nothing about Jira, and did not learn.
    expect(acliCalls(), readLog(acliLog())).toEqual([])
  })

  it('runs the folder arm with no tasks and no unbound variable', () => {
    // The cheapest folder-mode path that still executes the source dispatch and
    // `queue_count`: an empty tasks root. The folder happy path itself belongs to
    // test/loop.test.js and is not re-tested here.
    mkdirSync(join(workdir, '.ralph', 'tasks', 'afk', 'todo'), { recursive: true })
    const res = runLoop({ extraEnv: { TASK_SOURCE: 'folder' } })
    finished(res)
    expect(`${res.stdout}${res.stderr}`).not.toContain('unbound variable')
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(acliCalls()).toEqual([])
  })

  it('treats a TASK_SOURCE that is not exactly `jira` as github (pinned boundary)', () => {
    // MEASURED: the loop's dispatch is an EXACT string compare, so `JIRA`, `Jira` and
    // ` jira` all run the github arm.
    //
    // AND THAT IS A DIVERGENCE RATHER THAN A FALLBACK. This comment used to call it "the
    // documented zero-regression fallback for an unknown value" and say "the loop mirrors
    // lib/task-source.js" — review caught both as false, and they were the sentences that
    // would have stopped anyone from ever finding this. `resolveSource`
    // (lib/task-source.js) trims and lowercases before it matches, so all three values
    // above are RECOGNISED as `jira` by every JS command, and README documents the knob as
    // "case-insensitive and trimmed". Only bash disagrees, so there is nothing being
    // mirrored here.
    //
    // WHAT THE DISAGREEMENT COSTS, per site: bash counts and drains the GITHUB queue and
    // invokes the agent on a GitHub issue, while lib/build-prompt.js interpolates
    // `TASK_SOURCE=jira` into the prompt that agent reads, and `ralph status`, `ralph
    // cycle` and `ralph doctor` all read the JIRA queue for the same run. Two things that
    // are NOT affected, checked rather than assumed: the run record says `github` (the loop
    // writes the value it resolved itself), and lib/capture-issue-event.js resolves `jira`
    // but takes every branch `github` takes, so the event it appends is identical.
    //
    // BEHAVIOUR DELIBERATELY LEFT ALONE: the divergence predates this slice — `FOLDER` has
    // had it since #565 — and teaching bash the same trim-and-lowercase belongs in a slice
    // that fixes both values at once. Pinned so the trap is discoverable instead of silent.
    for (const value of ['JIRA', 'Jira', ' jira']) {
      rmSync(ghLog(), { force: true })
      rmSync(acliLog(), { force: true })
      writeStub('gh', `#!/bin/bash\necho "$*" >> "${ghLog()}"\necho 0\nexit 0\n`)
      const res = runLoop({ extraEnv: { TASK_SOURCE: value, JIRA_JQL: JQL } })
      finished(res)
      expect(res.stdout, value).toContain('Queue empty, exiting.')
      // gh answered the count, and acli was never asked.
      expect(readLog(ghLog()), value).toContain('issue list')
      expect(acliCalls(), value).toEqual([])
    }
  })
})
