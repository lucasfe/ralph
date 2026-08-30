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
// too, delegating only the real bridges the loop needs; the `claude` stub records the argv of
// the dispatch #128 now makes for a Jira ticket, which is all this suite asks of it — WHAT the
// agent is told is pinned in test/loop.test.js, against the real prompt builder.
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
// The board's label set, as the acli stub remembers it (#130) — written by the first accepted
// `edit` and read by every `view` after it. Absent until something has been written.
const labelsFile = () => join(workdir, 'acli-labels.txt')
const boardLabels = () => readLog(labelsFile()).trim()
const codexLog = () => join(workdir, 'codex-called.log')
// One line per agent invocation, so "how many times did we pay for this ticket?" is a number.
const agentCalls = (file = claudeLog()) => readLog(file).split(LF).filter(Boolean)

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
//
// AND SINCE #130 IT REMEMBERS WHAT WAS WRITTEN. The loop now READS THE BOARD BACK after the
// agent has run, to decide whether the ticket needs sweeping — so a `view` that always
// replayed the seeded document would report a ticket the agent had just completed as un-done,
// and the sweep tests would be pinning the fixture's amnesia rather than the loop. The first
// successful `edit` therefore writes `acli-labels.txt` (a comma-joined list, exactly what
// `--labels` sends) and every later `view` answers from it. Until then, `view` replays the
// seeded `acli-view.json` — which is what keeps the hostile-SHAPE rows (`labels: "frontend"`,
// a labels field that is not a list at all) testable: nothing there ever writes, so nothing
// there ever leaves the seeded document behind.
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
RALPH_TEST_LABELS="${labelsFile()}"
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
    # The remembered label set once anything has been written, the seeded document until then.
    # Only the \`labels\` array is answered from memory; a work item's key is not read out of
    # this response by lib/jira-queue.js, and building JSON around a hostile key in bash would
    # break the harness rather than the code under test.
    if [ -f "$RALPH_TEST_LABELS" ]; then
      list=$(cat "$RALPH_TEST_LABELS")
      if [ -z "$list" ]; then
        echo '{"fields":{"labels":[]}}'
      else
        echo '{"fields":{"labels":['"$(printf '%s' "$list" | sed 's/[^,][^,]*/"&"/g')"']}}'
      fi
    else
      cat "${join(workdir, 'acli-view.json')}"
    fi ;;
  *" edit "*)
    if [ "$asked" != "$want" ]; then echo "acli: work item $asked not found" >&2; exit 1; fi
    # The seeded body decides whether this write is ACCEPTED — a subshell, so a body that
    # exits keeps its exit code and the board below is left untouched.
    ( ${editBody} ) || exit $?
    prev=""
    for a in "$@"; do
      case "$prev" in
        --labels)
          # The stub picks the harsher of the two readings acli's docs leave open: --labels
          # REPLACES the list. Ralph's writes are read-then-union, so they survive it.
          printf '%s' "$a" > "$RALPH_TEST_LABELS" ;;
        --remove-labels)
          old=$(cat "$RALPH_TEST_LABELS" 2>/dev/null || true)
          new=""
          OLDIFS=$IFS; IFS=','
          for l in $old; do
            [ "$l" = "$a" ] || new="\${new:+$new,}$l"
          done
          IFS=$OLDIFS
          printf '%s' "$new" > "$RALPH_TEST_LABELS" ;;
      esac
      prev="$a"
    done ;;
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

  it('never touches gh in jira mode, and dispatches the agent exactly once, whatever the query says', () => {
    // Two arms, opposite expectations. github's queue must never be reached from a jira
    // run at all. The agent, since #128, IS invoked — but exactly ONCE, for the one ticket
    // the iteration claimed, and a hostile query is the input that could break that: a JQL
    // a shell had split could produce a second pick, and so a second dispatch.
    const res = runJira({ JIRA_JQL: `project = R ; touch pwned-semi` })
    finished(res)
    expect(existsSync(ghLog()), `gh was invoked:\n${readLog(ghLog())}`).toBe(false)
    expect(
      readLog(claudeLog()).split(LF).filter(Boolean),
      `the agent ran:\n${readLog(claudeLog())}`,
    ).toHaveLength(1)
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
      // THREE `edit` invocations per row since #130, and the count is spelled out because it is
      // the CLAIM that these rows are about: `edit[0]`. The agent stub here records its argv and
      // exits without completing anything, so the sweep runs and writes the other two —
      // `--labels frontend,p2,in-progress,failed` and `--remove-labels in-progress`. WAS pinned
      // at 1, when the arm ended at the dispatch.
      expect(edit, `${what}: ${readLog(acliLog())}`).toHaveLength(3)
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
    // BOUNDED, and the bound is measured rather than reasoned: this run makes exactly 12 acli
    // calls, read off the argv log as `count, count, pick, view, edit, view, view, edit, count,
    // pick, view, edit` — two counts before the first pick (the announced queue depth, then the
    // loop's own), then iteration one's claim (view + refused edit), its sweep (#130: `locate`'s
    // view, then `fail`'s view + refused edit), then iteration two's count, pick and claim,
    // which the guard cuts short before the dispatch. A third iteration could not fit under 14,
    // which is what makes this a spin detector and not a formality. WAS 12, when the arm ended
    // at the dispatch and cost 4 calls per iteration.
    expect(acliCalls().length, readLog(acliLog())).toBeLessThan(14)
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
    // ONE ticket's worth of writes: the claim, then the sweep's two (#130 — this stub's agent
    // completes nothing). Counted rather than bounded, because a `--once` that took a second
    // ticket would show up here as six.
    expect(callsFor('edit'), readLog(acliLog())).toHaveLength(3)
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

// ===========================================================================
// #128 QA — the AGENT DISPATCH now sits in the middle of the jira iteration.
// ===========================================================================
//
// Everything above was written when the jira arm ended at the claim. #128 inserts a paid,
// long-running, fallible subprocess between the claim and the zero-progress guard, and that
// changes two things the suite above could not have asked about:
//
//   • TERMINATION now has a new set of ways to go wrong. The arm reads no `claude_failed`
//     (#129/#130 own that), so every agent outcome — non-zero, missing binary, silence,
//     garbage — has to fall through to the guard. `res.signal === null` plus a BOUNDED
//     invocation count is the only honest proof, exactly as for the acli failures above.
//
//   • COST is now observable. Each dispatch is a paid model call, so "the loop terminated" is
//     no longer the whole question: HOW MANY invocations a failure buys is a number worth
//     pinning. When this file was written the zero-progress guard sat AFTER the dispatch, so an
//     unwritable claim bought two paid calls on one ticket; the guard now runs FIRST (MEASURED
//     in templates/ralph.sh: the guard is line 535, the dispatch is line 571), and the count
//     below asserts the one call rather than the two.
//
// The agent stub is never removed from PATH here either, for the same reason acli is not: a
// real `claude` may be installed on this machine. The missing-binary test makes the stub ANSWER
// the way an absent command does (127 + the shell's sentence).
describe('ralph.sh jira arm — every agent outcome still terminates (#128 QA)', () => {
  // A stub that behaves however a test needs while still recording one line per invocation.
  const agentStub = ({ status = 0, stdout = '', stderr = '' } = {}) =>
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo "$*" >> "${claudeLog()}"
${stdout ? `echo ${JSON.stringify(stdout)}` : ''}
${stderr ? `echo ${JSON.stringify(stderr)} >&2` : ''}
exit ${status}
`,
    )

  const outcomes = {
    'exits non-zero': { status: 1, stderr: 'claude: credit balance too low' },
    'answers like a missing binary': { status: 127, stderr: 'bash: claude: command not found' },
    'exits 0 having printed nothing at all': {},
    'prints a non-JSON line jq cannot parse': { stdout: 'Segmentation fault', status: 0 },
    'prints a JSON error result and exits 0': {
      stdout: '{"type":"result","subtype":"error_during_execution"}',
    },
  }

  for (const [what, spec] of Object.entries(outcomes)) {
    it(`finishes the run when the agent ${what}, having dispatched exactly once`, () => {
      agentStub(spec)
      const res = runJira()
      finished(res)
      // ONE dispatch, then the drained queue ends the run. The count is the assertion that
      // separates "handled" from "retried at full price".
      expect(agentCalls(), readLog(claudeLog())).toHaveLength(1)
      expect(res.stdout, what).toContain('==> Iteration for FOO-123 (1 remaining)')
      expect(res.stdout, what).toContain('Queue empty, exiting.')
      expect(acliCalls().length, readLog(acliLog())).toBeLessThan(12)
    })
  }

  it('sweeps a claimed ticket to `failed` when the agent exits 1, leaving no `in-progress` behind (#130)', () => {
    // WAS `leaves a claimed ticket labelled in-progress with no failure trace…`, which pinned
    // the deliberate gap #128 left: the claim succeeded, the agent exited 1, and nothing wrote
    // again — so the ticket sat `in-progress` forever, out of every future count (lib/jira-jql.js
    // excludes that label) with no work done and no trace of why. #130 closed it from THIS FILE
    // rather than from the agent, because the invocation that most needs sweeping is the one that
    // died, and a dead agent writes nothing.
    agentStub({ status: 1, stderr: 'claude: credit balance too low' })
    const res = runJira()
    finished(res)
    // THREE label writes, in order: the claim, then the sweep's add and its removal. Read out of
    // the argv log rather than inferred, because the pair is the whole point — a ticket that
    // gained `failed` while keeping `in-progress` would be excluded twice over and unreadable to
    // whoever comes looking for what Ralph left half-done.
    const edits = callsFor('edit')
    expect(edits, readLog(acliLog())).toHaveLength(3)
    expect(valueAfter(edits[0], '--labels')).toBe('frontend,p2,in-progress')
    expect(valueAfter(edits[1], '--labels')).toBe('frontend,p2,in-progress,failed')
    expect(valueAfter(edits[2], '--remove-labels')).toBe('in-progress')
    // The board as the stub remembers it: the team's own labels survived the sweep, which is
    // read-then-union doing its job on a value bash never sees.
    expect(boardLabels(), readLog(acliLog())).toBe('frontend,p2,failed')
    // A LABEL IS ALL IT WRITES. No comment (there is no SHA to report — nothing landed) and no
    // transition (a workflow can refuse one, so the guarantee cannot depend on it).
    expect(callsFor('comment'), readLog(acliLog())).toEqual([])
    expect(callsFor('transition'), readLog(acliLog())).toEqual([])
    // The operator is told, on stderr, in the loop's own words — naming the ticket and the state
    // the board reported for it.
    expect(res.stderr).toContain('FOO-123 was not completed (state: working). Labelling it failed.')
    // And the run still reports success to whatever scheduled it: one failed ticket is not a
    // failed cycle. The end-of-run summary is where the failure is visible.
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('0 ok, 1 failed')
  })

  it('pays for ONE agent invocation on one ticket when the claim cannot be written (#128 fix)', () => {
    // WAS `pays for TWO agent invocations…`, pinned at 2. The most expensive failure in the arm,
    // and it is invisible from the acli side: an unwritable claim leaves the ticket eligible, so
    // the query returns it again and the loop takes a second iteration on the same key. What
    // changed is WHERE the zero-progress guard sits. With the guard AFTER
    // `run_agent_for_issue`, that second iteration handed the same ticket to a paid agent
    // before the loop noticed nothing had moved; the guard now runs BEFORE the dispatch
    // (templates/ralph.sh: guard 547, dispatch 583), so iteration two aborts having spent
    // nothing. The suite above already pinned the two iterations — what this one owns is the
    // price, asserted exactly rather than bounded.
    seedStubs({ editBody: 'echo "permission denied" >&2; exit 1' })
    agentStub()
    const res = runJira()
    finished(res)
    expect(agentCalls(), readLog(claudeLog())).toHaveLength(1)
    expect(res.stderr).toContain('no progress on FOO-123 (re-selected). Aborting the loop.')
    // Anti-vacuity for the count: the run really did take TWO iterations, so the single
    // dispatch is the guard working rather than the loop having exited early.
    expect(res.stdout.split('==> Iteration for FOO-123').length - 1).toBe(2)
  })

  it('hands the agent the key the iteration announced, overriding a stale ambient RALPH_TASK_KEY', () => {
    // `export RALPH_TASK_KEY="$task_key"` IS the handoff contract (templates/ralph.sh:562), so
    // the value the agent process actually inherits is worth reading out of its environment
    // rather than inferring from the export line. The ambient value is seeded to something else
    // on purpose: a shell that already had RALPH_TASK_KEY set — a previous run, a developer's
    // export — must not be what the agent works on.
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
printf 'KEY:[%s]\\n' "\${RALPH_TASK_KEY-<UNSET>}" >> "${claudeLog()}"
exit 0
`,
    )
    const res = runJira({ RALPH_TASK_KEY: 'STALE-9999' })
    finished(res)
    expect(agentCalls()).toEqual(['KEY:[FOO-123]'])
  })

  it('exports no jira key into a github iteration, leaving the ambient value untouched', () => {
    // The other half: the export lives inside `if [ "$TASK_SOURCE" = "jira" ]`, so a github run
    // must neither invent a key nor rewrite one the operator's own shell provided. Read out of
    // the agent's environment for the same reason as above. (What the github PROMPT does with an
    // ambient key is pinned in lib/build-prompt.jira.qa.test.js: that template has no
    // {{RALPH_TASK_KEY}} site, so it cannot render one.)
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
printf 'KEY:[%s]\\n' "\${RALPH_TASK_KEY-<UNSET>}" >> "${claudeLog()}"
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )
    const res = runLoop({ extraEnv: { RALPH_TASK_KEY: 'STALE-9999' } })
    finished(res)
    expect(res.stdout).toContain('==> Iteration for issue #42')
    // Every invocation of the run — including the lazy config-validation one, which is why this
    // is `toContain` on a set rather than an exact array — saw the ambient value verbatim.
    expect([...new Set(agentCalls())]).toEqual(['KEY:[STALE-9999]'])
    expect(acliCalls()).toEqual([])
  })

  it('names the agent it actually spawned in the iteration line', () => {
    // `[agent: ...]` was added to the jira iteration line by #128 because the dispatch it
    // describes now exists. A label naming a binary other than the one that ran would send a
    // reader to the wrong per-ticket log, so the two are compared: the printed name, and the
    // stub that recorded a call. `codex` resolves through lib/agent-invocation.js, so this also
    // proves the jira arm does not hardcode claude anywhere.
    writeStub('codex', `#!/bin/bash\ncat > /dev/null\necho "$*" >> "${codexLog()}"\nexit 0\n`)
    const res = runJira({ RALPH_AGENT: 'codex' })
    finished(res)
    expect(res.stdout).toContain('==> Iteration for FOO-123 (1 remaining) [agent: codex]')
    expect(agentCalls(codexLog()), readLog(codexLog())).toHaveLength(1)
    // ...and claude was never spawned, which is what makes the line above informative.
    expect(existsSync(claudeLog()), `claude ran:\n${readLog(claudeLog())}`).toBe(false)
  })
})

describe('ralph.sh jira arm — the key becomes a LOG PATH (#128 QA)', () => {
  // `run_agent_for_issue` builds `logs/ralph-issue-$1.log` and `...jsonl` from a value acli
  // chose. That is a remote-chosen string used as a FILENAME, and lib/jira-key.js's
  // `usableJiraKey` deliberately passes through keys its grammar does not recognise — so the
  // separator and the parent-directory characters both reach it. As of #128 the arm passes a
  // SANITIZED HANDLE (`${task_key//[^A-Za-z0-9._-]/_}`) rather than the key itself, so the two
  // questions here are: is the handle still the key for an ordinary ticket, and does a
  // pathological one still get a transcript instead of losing it to a failed redirection.
  const perTicketLog = (key) => join(workdir, 'logs', `ralph-issue-${key}.log`)

  it('writes the per-ticket log and jsonl named by an ordinary key, and no numeric one', () => {
    // The baseline the two hostile rows below are read against — and a pin on the CHOICE of the
    // key over `$num`: `$num` is empty in this mode, so the numeric path would be
    // `logs/ralph-issue-.log` for every ticket that ever runs.
    const res = runJira()
    finished(res)
    expect(existsSync(perTicketLog('FOO-123'))).toBe(true)
    expect(existsSync(join(workdir, 'logs', 'ralph-issue-FOO-123.jsonl'))).toBe(true)
    expect(existsSync(perTicketLog(''))).toBe(false)
    // MEASURED, and it is a real divergence rather than a nicety: lib/run-state.js derives the
    // numeric handle 123 from FOO-123, and lib/digest.js's `inFlightLogPath` builds its tail
    // path from that NUMBER — so the digest looks for logs/ralph-issue-123.log, which #128
    // never writes. Pinned here because the two paths are produced by different files and
    // nothing else compares them.
    expect(record().current.number).toBe(123)
    expect(existsSync(join(workdir, 'logs', 'ralph-issue-123.log'))).toBe(false)
  })

  it('still writes a per-ticket log for a key containing a slash, under a safe handle (#128 fix)', () => {
    // WAS `loses the per-ticket log for a key containing a slash, and still pays for the agent`.
    // `FOO/1` is not a key lib/jira-key.js recognises, and it does not have to be: that module
    // trims and passes anything else through, on the stated grounds that Jira names its own
    // tickets. Passing it straight to `run_agent_for_issue` made
    // `logs/ralph-issue-FOO/1.log`, whose parent directory does not exist — and
    // templates/ralph.sh runs under `set -u` ONLY, no `set -e`, so the failed
    // `: > "$log_file"` redirection stopped nothing: the agent was spawned, was billed, and the
    // transcript that would explain what it did went nowhere.
    //
    // The handle replaces every character outside `[A-Za-z0-9._-]` with `_`, so the transcript
    // now exists and the paid invocation is accounted for.
    seedStubs({ key: 'FOO/1' })
    const res = runJira()
    finished(res)
    expect(agentCalls(), readLog(claudeLog())).toHaveLength(1)
    // The transcript, and its jsonl sibling, both under the handle.
    expect(existsSync(perTicketLog('FOO_1'))).toBe(true)
    expect(existsSync(join(workdir, 'logs', 'ralph-issue-FOO_1.jsonl'))).toBe(true)
    // Nothing was created from the raw key: no `logs/ralph-issue-FOO` directory, no such file.
    expect(existsSync(join(workdir, 'logs', 'ralph-issue-FOO'))).toBe(false)
    expect(existsSync(perTicketLog('FOO/1'))).toBe(false)
    // ...and bash's redirection error is gone, because there is no failed redirection left.
    expect(res.stderr).not.toContain('ralph-issue-FOO/1.log')
    // THE KEY ITSELF IS UNTOUCHED everywhere it is not a path: the acli argv still asks the
    // board for `FOO/1`, and the iteration line still names it, so the handle is a log-naming
    // detail and not a rename of the ticket.
    expect(valueAfter(callsFor('view')[0], '--key')).toBe('FOO/1')
    expect(res.stdout).toContain('==> Iteration for FOO/1 (1 remaining)')
  })

  it('writes nothing outside the project root for a key full of parent-directory hops', () => {
    // The traversal question asked directly, and it is now answered twice over: the `..` hops
    // become `_` in the handle before they are ever a path component, AND
    // `logs/ralph-issue-../../pwned.log` only resolved if `logs/ralph-issue-..` were a
    // directory, which it is not. Asserted on the FILESYSTEM above the workdir rather than on
    // any message, because the message is not the property that matters.
    const parent = join(workdir, '..')
    seedStubs({ key: '../../qa-escape' })
    const res = runJira()
    finished(res)
    expect(existsSync(join(workdir, 'qa-escape.log'))).toBe(false)
    expect(existsSync(join(parent, 'qa-escape.log'))).toBe(false)
    expect(existsSync(join(parent, '..', 'qa-escape.log'))).toBe(false)
    expect(existsSync(join(workdir, 'logs', 'qa-escape.log'))).toBe(false)
    // And what it DID write, which is what makes the four negatives above non-vacuous: one
    // transcript, inside logs/, named by a handle with no path component in it at all.
    expect(existsSync(perTicketLog('.._.._qa-escape'))).toBe(true)
    // It was still one argument the whole way — the traversal is a filename, not a command.
    expect(injected()).toEqual([])
    expect(valueAfter(callsFor('view')[0], '--key')).toBe('../../qa-escape')
  })
})

// ---------------------------------------------------------------------------
// #129 QA — COMPLETION, THROUGH THE WHOLE LOOP. Everything else about #129 is testable in
// process: lib/jira-queue.test.js owns the contract and lib/jira-queue.qa.test.js runs the CLI
// against a fake acli. What NEITHER can reach is the wiring, and completion has three pieces of
// it that exist nowhere else:
//
//   THE AGENT IS THE CALLER. Step 7 of templates/prompt-team-jira.md tells the agent to run
//   `node "$RALPH_PKG_DIR/lib/jira-queue.js" complete {{RALPH_TASK_KEY}}` itself — the loop
//   never completes a ticket. So the completion depends on TWO variables reaching a subprocess
//   of a subprocess: `RALPH_PKG_DIR` (exported near the top of ralph.sh) and `RALPH_TASK_KEY`
//   (exported inside the jira branch). The `claude` stub below runs exactly those two commands,
//   which is the first test anywhere that the instruction in that prompt is executable.
//
//   JIRA_DONE_STATUS TRAVELS THROUGH `set -a`. It has no flag and no loop code of its own: the
//   CLI reads `process.env.JIRA_DONE_STATUS`, and the only thing that puts it there is
//   ralph.sh sourcing ralph.config.sh under `set -a`. That is a claim about bash, so it is
//   asserted by writing a real ralph.config.sh and looking at the argv acli received — with a
//   TWO-WORD status, so a value that had been word-split would be visible as two arguments.
//
//   AND `ok:false` MEANS "STILL IN THE QUEUE" — end to end. The narrow meaning of the exit code
//   is only meaningful if a failed `done` label really does leave the ticket eligible and the
//   loop really does terminate anyway. Here the fake board makes that observable: the label
//   write is what drains this fixture's queue, so a completion that could not write it produces
//   a re-selection, and the zero-progress guard is what stops the run.
//
// The acli stub is the same one the rest of this file uses, unchanged: its `edit` arm touches
// the flag that makes the next `--count` answer 0, so a completion's own label write is what
// drains the queue — and its unmatched branches (transition, comment create) exit 0 with no
// output, which is exactly how acli reports a successful write.
// ---------------------------------------------------------------------------
describe('ralph.sh jira arm — the agent completes the ticket it was given (#129 QA)', () => {
  const agentEnvLog = () => join(workdir, 'agent-env.log')
  const agentErrLog = () => join(workdir, 'agent-stderr.log')
  const agentOutLog = () => join(workdir, 'agent-stdout.log')
  const envLines = () => readLog(agentEnvLog()).split(LF).filter(Boolean)

  // The agent, doing what step 7 of templates/prompt-team-jira.md tells it to do and nothing
  // else: commit (the git stub swallows that), then `complete`, then `comment`. It runs those
  // two commands through `node`, which is itself a stub that delegates jira-queue.js to the
  // real interpreter — so the CLI under test is the real one, spawning the real execa, against
  // the fake acli on PATH.
  //
  // GUARDED ON RALPH_TASK_KEY BEING SET, because the same stub also serves the one-shot config
  // validation ralph.sh runs when a ralph.config.sh is present, and that invocation has no
  // ticket. Which is itself a small proof: the variable is exported inside the jira branch, so
  // an agent run outside it does not see one.
  const completingAgent = (body = 'Resolved by Ralph in abc1234') =>
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo "$*" >> "${claudeLog()}"
if [ -n "\${RALPH_TASK_KEY:-}" ]; then
  {
    echo "KEY=\${RALPH_TASK_KEY}"
    echo "DONE=[\${JIRA_DONE_STATUS-<absent>}]"
    echo "PKG=\${RALPH_PKG_DIR:-<absent>}"
  } >> "${agentEnvLog()}"
  node "$RALPH_PKG_DIR_PLACEHOLDER/lib/jira-queue.js" complete "\$RALPH_TASK_KEY" \
    >> "${agentOutLog()}" 2>> "${agentErrLog()}"
  echo "COMPLETE_EXIT=$?" >> "${agentEnvLog()}"
  node "$RALPH_PKG_DIR_PLACEHOLDER/lib/jira-queue.js" comment "\$RALPH_TASK_KEY" "${body}" \
    >> "${agentOutLog()}" 2>> "${agentErrLog()}"
  echo "COMMENT_EXIT=$?" >> "${agentEnvLog()}"
fi
exit 0
`.replace(/\$RALPH_PKG_DIR_PLACEHOLDER/g, '${RALPH_PKG_DIR}'),
    )

  it('runs all four completion invocations, with a TWO-WORD status out of ralph.config.sh', () => {
    // The ticket already carries `in-progress` — the shape a re-run or a claim from a previous
    // iteration leaves behind — so the claim short-circuits and the COMPLETION is what writes,
    // which makes every one of its four invocations visible in one run.
    seedStubs({ labels: '["frontend","in-progress"]' })
    completingAgent()
    // A real config file, sourced under `set -a`: the only transport JIRA_DONE_STATUS has.
    writeFileSync(join(workdir, 'ralph.config.sh'), `JIRA_DONE_STATUS="In Review"${LF}`)

    const res = runJira()
    finished(res)

    // The knob arrived at the agent's environment, spaces intact.
    expect(envLines()).toContain('DONE=[In Review]')
    expect(envLines()).toContain('KEY=FOO-123')
    expect(envLines()).toContain('COMPLETE_EXIT=0')
    expect(envLines()).toContain('COMMENT_EXIT=0')

    // 1. THE TRANSITION, as one argument. `argc === args.length` is what rules out a status
    // that had been word-split somewhere between ralph.config.sh and acli.
    const transitions = callsFor('transition')
    expect(transitions, readLog(acliLog())).toHaveLength(1)
    expect(transitions[0].args).toEqual([
      'jira', 'workitem', 'transition', '--key', 'FOO-123', '--status', 'In Review', '--yes',
    ])
    expect(transitions[0].argc).toBe(transitions[0].args.length)

    // 2. THE LABEL, read-then-union, preserving the team's own label.
    const edits = callsFor('edit')
    const added = edits.filter((call) => call.args.includes('--labels'))
    expect(added, readLog(acliLog())).toHaveLength(1)
    expect(valueAfter(added[0], '--labels')).toBe('frontend,in-progress,done')
    expect(added[0].args.at(-1)).toBe('--yes')

    // 3. AND `in-progress` OFF, with the flag that means "remove" rather than "set".
    const removed = edits.filter((call) => call.args.includes('--remove-labels'))
    expect(removed, readLog(acliLog())).toHaveLength(1)
    expect(valueAfter(removed[0], '--remove-labels')).toBe('in-progress')
    expect(removed[0].args.at(-1)).toBe('--yes')

    // 4. The comment, one argument, spaces and all.
    const comments = callsFor('comment')
    expect(comments, readLog(acliLog())).toHaveLength(1)
    expect(comments[0].args[3]).toBe('create')
    expect(valueAfter(comments[0], '--body')).toBe('Resolved by Ralph in abc1234')
    expect(comments[0].argc).toBe(comments[0].args.length)

    // The claim read the ticket and wrote nothing (it was already labelled), so the three `view`
    // calls are the claim's, the completion's and the sweep's `locate` (#130) — proof that both
    // label paths go through a read, that the completion did not reuse a stale list, and that the
    // loop asks the BOARD what happened rather than the agent's exit code. WAS 2, before the
    // outcome branch existed.
    expect(callsFor('view'), readLog(acliLog())).toHaveLength(3)
    // AND THE SWEEP FOUND IT DONE, so it wrote nothing: the two edits above are the completion's
    // own, and a third `--labels` carrying `failed` is exactly what a sweep firing on a finished
    // ticket would look like here.
    expect(edits, readLog(acliLog())).toHaveLength(2)
    expect(res.stderr).not.toContain('was not completed')

    // AND THE QUEUE DRAINED. In this fixture the label write is what makes the next count
    // answer 0, so "Queue empty" is the completion having taken effect on the board.
    expect(res.stdout).toContain('Queue empty, exiting.')
    // One ticket, one agent dispatch for it — plus the config-validation run that a present
    // ralph.config.sh triggers, which carries no ticket.
    expect(agentCalls().length).toBe(2)
    expect(readLog(agentOutLog())).toBe('')
  })

  it('completes with no transition and ONE warning when JIRA_DONE_STATUS is not configured', () => {
    // The default configuration — templates/ralph.config.sh ships `JIRA_DONE_STATUS=""` — and
    // the one that has to work on a board Ralph knows nothing about. No config file at all
    // here, which is the absent case rather than the empty one.
    seedStubs({ labels: '["frontend","in-progress"]' })
    completingAgent()

    const res = runJira()
    finished(res)

    expect(envLines()).toContain('DONE=[<absent>]')
    expect(envLines()).toContain('COMPLETE_EXIT=0')
    // NO transition was attempted: an unset status skips the board move rather than guessing a
    // status name, because a wrong `--status` is a write.
    expect(callsFor('transition'), readLog(acliLog())).toEqual([])
    // The label work still happened, which is what drains the queue.
    expect(callsFor('edit').filter((c) => c.args.includes('--labels'))).toHaveLength(1)
    expect(res.stdout).toContain('Queue empty, exiting.')

    // ONE warning, on stderr, naming the knob and whose job the board move now is. Counted,
    // because a completion that warned per invocation would bury it.
    const warnings = readLog(agentErrLog()).split(LF).filter(Boolean)
    expect(warnings, readLog(agentErrLog())).toHaveLength(1)
    expect(warnings[0]).toContain('JIRA_DONE_STATUS is not set')
    expect(warnings[0]).toContain('yours to do by hand')
  })

  it('leaves the ticket IN the queue when the `done` label cannot be written — and terminates', () => {
    // The narrow meaning of `ok:false`, end to end. `editBody: exit 1` makes every label write
    // fail, so: the claim fails (warns, carries on), the agent's completion exits 1, the flag
    // that drains this fixture's queue is never set, the same ticket is selected again, and the
    // ZERO-PROGRESS GUARD is what ends the run. A loop without that guard would hand this
    // ticket out forever, which is why `signal` and a BOUNDED call count are the assertions
    // that matter rather than the message.
    seedStubs({ labels: '["frontend","in-progress"]', editBody: 'exit 1' })
    completingAgent()

    const res = runJira()
    // EXIT 0, and that is deliberate: the guard `break`s out of the loop rather than aborting
    // the process, because one ticket Ralph cannot label must not take a whole scheduled cycle
    // down with it. `signal` null is the assertion that it stopped at all.
    finished(res)
    expect(res.stderr).toContain('no progress on FOO-123 (re-selected). Aborting the loop.')
    // TWO iterations, not more and not forever: the same ticket came back once, and the guard
    // caught it on the second look.
    const iterations = res.stdout.split(LF).filter((line) => line.includes('==> Iteration for'))
    expect(iterations, res.stdout).toHaveLength(2)

    // The completion reported the ONE failure it has, on stderr, and nothing on stdout —
    // EXACTLY ONCE, because the jira arm's guard runs BEFORE the dispatch: the second look at
    // the same ticket ends the loop without paying for another agent invocation. So an
    // unwritable `done` label costs one agent run, not one per look.
    expect(envLines().filter((line) => line === 'COMPLETE_EXIT=1')).toHaveLength(1)
    expect(agentCalls()).toHaveLength(1)
    expect(readLog(agentErrLog())).toContain('could not label FOO-123 done')
    expect(readLog(agentOutLog())).toBe('')

    // NOTHING WAS REMOVED after the failed add: a ticket that lost `in-progress` without
    // gaining `done` would be back in the queue with no owner. That holds for the #130 sweep
    // too, which runs here — the board reads `working`, so the sweep tries `failed`, and the
    // same refusing `editBody` means its add fails and its removal is therefore never reached.
    expect(callsFor('edit').filter((c) => c.args.includes('--remove-labels'))).toEqual([])
    // …and it said so — ONCE, for the one iteration that reached the dispatch; the second look
    // ends at the guard, above both the agent and the sweep.
    const swept = res.stderr.split(LF).filter((l) => l.includes('was not completed'))
    expect(swept, res.stderr).toHaveLength(1)
    // Bounded: two iterations' worth of calls, not an unbounded spin.
    expect(acliCalls().length, readLog(acliLog())).toBeLessThan(20)
  })

  it('still comments — and still exits 0 — when the comment itself is refused', () => {
    // Best-effort by contract: the work is committed by the time step 7 comments, so acli
    // refusing the post must not turn a finished ticket into a failed iteration. The acli stub
    // is made to fail EVERY invocation whose subcommand it does not recognise, which for this
    // fixture is `transition` and `comment create`.
    seedStubs({ labels: '["frontend","in-progress"]' })
    // Rewrite only the comment arm: a `comment` invocation exits 1, everything else is as
    // seeded. Appending a case ahead of the default is simpler than parameterising the stub.
    const acliPath = join(bindir, 'acli')
    const patched = readFileSync(acliPath, 'utf8').replace(
      'case "$*" in',
      `case "$*" in${LF}  *" comment "*) exit 1 ;;`,
    )
    writeFileSync(acliPath, patched, { mode: 0o755 })
    chmodSync(acliPath, 0o755)
    completingAgent()

    const res = runJira()
    finished(res)
    expect(envLines()).toContain('COMPLETE_EXIT=0')
    // ZERO, still: `comment` cannot fail a run.
    expect(envLines()).toContain('COMMENT_EXIT=0')
    expect(readLog(agentErrLog())).toContain('could not comment on FOO-123')
    expect(res.stdout).toContain('Queue empty, exiting.')
  })

  it('refuses a body the agent forgot to write, without touching acli, and exits 0', () => {
    // The caller is an LLM composing a shell command, so an empty body is a real shape. An
    // empty comment on a board reads as Ralph having recorded something, so it is refused
    // before a process starts — and still exits 0.
    seedStubs({ labels: '["frontend","in-progress"]' })
    completingAgent('')

    const res = runJira()
    finished(res)
    expect(envLines()).toContain('COMMENT_EXIT=0')
    expect(callsFor('comment'), readLog(acliLog())).toEqual([])
    expect(readLog(agentErrLog())).toContain('no comment body to post to FOO-123')
  })

  it('passes a HOSTILE key from acli through the completion as one argument, running none of it', () => {
    // The key is chosen by a remote system and step 7 of the prompt interpolates it into two
    // shell commands. Here the agent quotes it — as the prompt's own example does — so the
    // whole string reaches acli as one argument and none of it is executed. The fixture's
    // board answers to this key, so the completion really does run against it.
    seedStubs({ key: 'FOO-1$(touch pwned-key)', labels: '["in-progress"]' })
    completingAgent()

    const res = runJira()
    finished(res)
    expect(injected(), `a shell ran part of the key: ${injected().join(', ')}`).toEqual([])
    const added = callsFor('edit').filter((c) => c.args.includes('--labels'))
    expect(added, readLog(acliLog())).toHaveLength(1)
    expect(valueAfter(added[0], '--key')).toBe('FOO-1$(touch pwned-key)')
    expect(added[0].argc).toBe(added[0].args.length)
  })
})

describe('ralph.sh jira arm — the outcome branch, adversarially (#130 QA)', () => {
  // What the happy-path sweep tests cannot reach. The outcome branch reads ONE WORD off a
  // command substitution and then calls a second CLI with `|| true`, so three things are
  // interface rather than implementation and none of them is producible through the acli stub:
  //
  //   A `locate` THAT PRINTS NOTHING AT ALL. `${outcome:-unknown}` exists for exactly that —
  //   a node that died before writing a word — and no acli answer can produce it, because the
  //   verb always prints one. Untested until here.
  //
  //   A `locate` THAT PRINTS SOMETHING ELSE. The value is compared with `[ ... ]` and then
  //   interpolated into an `echo`, so it crosses a shell twice; the row below carries a
  //   semicolon and a command substitution, and the assertion is the FILES a shell would have
  //   left rather than the text alone.
  //
  //   A `fail` THAT EXITS NON-ZERO. The loop discards that code on purpose and forces the
  //   outcome to `failed`, so the run must reach its summary and record the ticket either way.
  //
  // The seam for all three is the harness's own `node` stub, which delegates jira-queue.js to
  // the real interpreter; `overrideVerb` puts an arm AHEAD of that delegation so ONE verb can
  // be made to misbehave while every other bridge the loop needs still runs for real.
  const overrideVerb = (verb, body) => {
    const nodePath = join(bindir, 'node')
    const patched = readFileSync(nodePath, 'utf8').replace(
      'case "$*" in',
      `case "$*" in${LF}  *jira-queue.js*${verb}*)${LF}${body}${LF}  ;;`,
    )
    writeFileSync(nodePath, patched, { mode: 0o755 })
    chmodSync(nodePath, 0o755)
  }

  it('sweeps with `state: unknown` when locate prints nothing at all', () => {
    // The one input `${outcome:-unknown}` is for. The sweep itself is the REAL verb, so this
    // also measures that an empty word reaches it as an ordinary un-done ticket.
    seedStubs({ labels: '["frontend","p2"]' })
    overrideVerb('locate', `    exit 0`)

    const res = runJira()
    finished(res)
    expect(res.stderr).toContain('FOO-123 was not completed (state: unknown). Labelling it failed.')
    // Read-then-union, then the claim off — the board as the stub remembers it.
    expect(boardLabels()).toBe('frontend,p2,failed')
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).toContain('0 ok, 1 failed')
    expect(res.stdout).toContain('FAIL: #FOO-123')
    // One paid invocation for one ticket, which is the whole point of the guarantee.
    expect(agentCalls()).toHaveLength(1)
  })

  it('sweeps whatever garbage locate printed, and runs none of it', () => {
    // A sentence rather than a state word, carrying a semicolon and a command substitution,
    // and printed by a verb that then exits non-zero — which the loop discards, because the
    // capture is an assignment and its status is never tested.
    seedStubs({ labels: '["frontend","p2"]' })
    overrideVerb('locate', `    printf '%s' 'ERROR: not logged in; \$(touch pwned-sub)'${LF}    exit 1`)

    const res = runJira()
    finished(res)
    expect(injected(), `a shell ran part of the outcome: ${injected().join(', ')}`).toEqual([])
    expect(res.stderr).toContain(
      'FOO-123 was not completed (state: ERROR: not logged in; $(touch pwned-sub)). Labelling it failed.',
    )
    expect(boardLabels()).toBe('frontend,p2,failed')
    expect(res.stdout).toContain('0 ok, 1 failed')
    expect(agentCalls()).toHaveLength(1)
  })

  it('records a failure and finishes the run when the `fail` verb exits non-zero', () => {
    // `|| true` spelled as behaviour: the loop does not branch on that code, it forces the
    // outcome to `failed` and carries on to the summary.
    seedStubs({ labels: '["frontend","p2"]' })
    overrideVerb('fail', `    echo "jira-queue.js: could not label FOO-123 failed" >&2${LF}    exit 1`)

    const res = runJira()
    finished(res)
    expect(res.stdout).toContain('0 ok, 1 failed')
    expect(res.stdout).toContain('FAIL: #FOO-123')
    // STDERR IS NOT SUPPRESSED for this call, unlike the folder arm's `mv`, so the verb's own
    // sentence is in the run's log — the only record of why the board never changed.
    expect(res.stderr).toContain('jira-queue.js: could not label FOO-123 failed')
    // Only the claim ever wrote.
    expect(boardLabels()).toBe('frontend,p2,in-progress')
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(agentCalls()).toHaveLength(1)
  })

  it('finishes the run when acli itself refuses the sweep, leaving the claim as the exclusion', () => {
    // The realistic version of the case above: Ralph may edit labels, the claim landed, and
    // the write carrying `failed` is refused. Driven through the REAL verb, so the refusal is
    // acli's rather than a stub of the CLI.
    //
    // WHY THE RUN STILL TERMINATES, measured rather than argued: `in-progress` is excluded by
    // the composed query too, so a claimed ticket whose sweep never landed is out of the next
    // count anyway. The zero-progress guard is the backstop for the case where the CLAIM is
    // what failed, which the #127 QA section above covers.
    seedStubs({
      labels: '["frontend","p2"]',
      editBody: `case "\$*" in *failed*) exit 1 ;; esac${LF}touch "\$RALPH_TEST_FLAG"`,
    })

    const res = runJira()
    finished(res)
    expect(res.stderr).toContain('FOO-123 was not completed (state: working). Labelling it failed.')
    expect(res.stderr).toContain('jira-queue.js: could not label FOO-123 failed')
    expect(boardLabels()).toBe('frontend,p2,in-progress')
    // NOTHING IS REMOVED AFTER AN ADD THAT FAILED: a ticket that lost its claim without
    // gaining the terminal label would be back in the queue with no owner at all.
    const removals = callsFor('edit').filter((call) => call.args.includes('--remove-labels'))
    expect(removals, readLog(acliLog())).toEqual([])
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).toContain('0 ok, 1 failed')
    expect(agentCalls()).toHaveLength(1)
  })

  it('leaves the ticket alone when locate says `done`, whatever the board holds', () => {
    // The contract stated as an isolation: the branch trusts ONE word on stdout and nothing
    // else — not the agent's exit code, and not a second look at the board. The board here
    // still says `in-progress`, and no sweep runs.
    seedStubs({ labels: '["frontend","p2"]' })
    overrideVerb('locate', `    echo done${LF}    exit 0`)

    const res = runJira()
    finished(res)
    expect(res.stderr).not.toContain('was not completed')
    expect(res.stdout).toContain('1 ok, 0 failed')
    expect(res.stdout).toContain('OK: #FOO-123')
    expect(res.stdout).toContain('FAIL: -')
    // The claim is the only write, so no argv carries the sweep's label.
    const edits = callsFor('edit')
    expect(edits, readLog(acliLog())).toHaveLength(1)
    expect(valueAfter(edits[0], '--labels')).toBe('frontend,p2,in-progress')
    expect(boardLabels()).toBe('frontend,p2,in-progress')
  })

  it('abandons the ticket to the guard when the claim AND the sweep both fail', () => {
    // Both writes refused, which is the only shape that keeps the ticket eligible: the loop
    // then re-selects it and the zero-progress guard is what stops the run rather than the
    // sweep. Asserted as a BOUNDED number of paid invocations — one, because the guard sits
    // ahead of the dispatch in this arm — plus `signal === null`, because a loop that spun
    // forever would satisfy the text assertions just as happily.
    seedStubs({ labels: '["frontend","p2"]', editBody: 'exit 1' })

    const res = runJira()
    finished(res)
    expect(res.stderr).toContain('FOO-123 was not completed (state: open). Labelling it failed.')
    expect(res.stderr).toContain('no progress on FOO-123 (re-selected). Aborting the loop.')
    expect(agentCalls(), readLog(claudeLog())).toHaveLength(1)
    expect(boardLabels()).toBe('')
    expect(res.stdout).toContain('0 ok, 1 failed')

    // THE CEILING ASSERTED ELSEWHERE IN THIS FILE, RE-MEASURED HERE AS THE EXACT SEQUENCE.
    // `every failure path terminates` bounds this same run at fewer than 14 acli calls and its
    // comment spells the twelve out; a ceiling cannot tell a reordering from a spin, and a
    // prose breakdown is only as good as the run it was read off. This is that breakdown,
    // measured: two counts before the first pick (the announced queue depth, then the loop's
    // own), iteration one's claim (view + refused edit), its sweep (`locate`'s view, then
    // `fail`'s view + refused edit), then iteration two's count, pick and claim, which the
    // guard cuts short ahead of the dispatch.
    const kindOfCall = (call) =>
      call.args[2] === 'search' ? (call.args.includes('--count') ? 'count' : 'pick') : call.args[2]
    expect(acliCalls().map(kindOfCall), readLog(acliLog())).toEqual([
      'count',
      'count',
      'pick',
      'view',
      'edit',
      'view',
      'view',
      'edit',
      'count',
      'pick',
      'view',
      'edit',
    ])
  })
})
