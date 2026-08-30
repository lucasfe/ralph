import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

const RALPH_TEMPLATE = templatePath('ralph.sh')
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

// #140 QA augmentation — THE LABEL NAME IS NOW A COMMON WORD, run through the real bash.
//
// The rename traded two Ralph coinages for two ordinary ones. The retired, `claude-`prefixed
// spellings could only ever have been Ralph's; `failed` is a word other people put on their own
// boards, and so are `build-failed`, `qa-failed` and `failed-review`. templates/ralph.sh
// classifies an iteration by grepping the issue's comma-joined label list:
//
//     if echo ",$labels," | grep -q ",failed,"; then
//
// The commas are the anchors, and before #140 nothing depended on them: no substring of the
// retired failure spelling occurs in anybody's label. Now the whole verdict — success, failure, the
// stale-label sweep, the tally, the cycle event — hangs on those two bytes. If the anchors
// were ever dropped, a repo with a `build-failed` label would have every one of its issues
// classified as a Ralph give-up on the first pass, swept out of the queue, and reported as a
// failure with the work never attempted.
//
// ASKED THROUGH THE REAL LOOP, not through a re-implementation of the grep. lib/issue-event.js
// answers the same question in JavaScript with an ARRAY `includes`, where no anchor can be
// accidental — that half is covered in lib/labels.rename.qa.test.js. The bash half is a string
// match, it is a DIFFERENT mechanism reaching the same verdict, and it is the one that can be
// broken by an edit that looks harmless. So this file runs templates/ralph.sh under stub `gh`
// and `claude` binaries and reads back what the loop actually asked GitHub to do.
//
// WHAT DISCRIMINATES A PASS FROM A FAIL HERE, because the tally alone does not. A colliding
// label like `build-failed` on an OPEN issue whose agent exited 0 falls to the else branch and
// is counted a failure — the same `0 ok, 1 failed` line a genuine `failed` label produces. The
// two branches differ in what they WRITE: the failure branch calls the stale-label sweep, the
// else branch (with a zero exit) writes nothing at all. So every assertion below is against the
// `gh issue edit` log, which is the only observable that tells the branches apart.
//
// Harness duplicated from test/loop.label-hygiene.adversarial.test.js rather than shared, which
// is the convention in this directory (see that file's note on seedLabelledIssue).

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

function runLoop({ timeout = 15000 } = {}) {
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-test',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
  }
  return spawnSync('bash', [RALPH_TEMPLATE], { cwd: workdir, env, timeout, encoding: 'utf8' })
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-label-shape-'))
  bindir = join(workdir, 'bin')
  mkdirSync(bindir, { recursive: true })
  mkdirSync(join(workdir, 'logs'), { recursive: true })
  // No ralph.config.sh, so the lazy-validation block is skipped entirely and the run is only
  // the main loop; .ralph/state.json pre-seeded for the same reason.
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
  // The telemetry sidecar and the agent-invocation resolver must run for real; everything else
  // node is asked for here is a prompt build, which only needs some text on stdout.
  writeStub(
    'node',
    `#!/bin/bash
case "$*" in
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`,
  )
  writeStub('jq', `#!/bin/bash\ncat > /dev/null 2>/dev/null || true\nexit 0\n`)
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true })
})

// A one-issue queue that drains after the pick, whose `gh issue view` reports exactly the label
// string given and whose `gh issue edit` records its argv. The label string is passed through
// verbatim — with the commas gh itself would join with — because the byte layout of that string
// is the thing under test.
function seedIssue({ labels, state = 'OPEN', claudeExit = 0 }) {
  writeStub(
    'claude',
    `#!/bin/bash
cat > /dev/null
echo '{"type":"result","subtype":"success"}'
exit ${claudeExit}
`,
  )
  writeFileSync(join(workdir, 'count.txt'), '1')
  writeStub(
    'gh',
    `#!/bin/bash
CNT_FILE="${join(workdir, 'count.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cnt=$(cat "$CNT_FILE")
  case "$*" in
    *sort:created-asc*)
      echo "$cnt"
      echo "$((cnt - 1))" > "$CNT_FILE"
      ;;
    *) echo "$cnt" ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "${labels}" ;;
    *state*)  echo "${state}" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  echo "$*" >> "${join(workdir, 'gh-edit.log')}"
  exit 0
fi
exit 0
`,
  )
}

// Every `gh issue edit` argv the loop issued, in order. An empty list is a real answer here:
// it is what "the loop classified this iteration as neither failed nor resolved" looks like.
function readEdits() {
  const f = join(workdir, 'gh-edit.log')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
}

// The one-line summary the loop prints on the way out, as `[ok, failed]`.
function tally(stdout) {
  const match = stdout.match(/(\d+) ok, (\d+) failed/)
  expect(match, `no tally line in:\n${stdout}`).not.toBeNull()
  return [Number(match[1]), Number(match[2])]
}

describe('QA #140 — the `,failed,` anchors, against labels that merely contain the word', () => {
  // The controls first, so a green result below is discrimination and not a loop that writes
  // nothing whatever it is handed.
  it('control: the exact `failed` label IS a failure, and the stale-label sweep runs', () => {
    seedIssue({ labels: 'in-progress,failed', state: 'OPEN' })
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(tally(res.stdout)).toEqual([0, 1])
    expect(readEdits()).toEqual(['issue edit 1 --remove-label in-progress'])
  })

  it('control: the exact `pending-merge` label IS a success, and the sweep runs', () => {
    seedIssue({ labels: 'in-progress,pending-merge', state: 'OPEN' })
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(tally(res.stdout)).toEqual([1, 0])
    expect(readEdits()).toEqual(['issue edit 1 --remove-label in-progress'])
  })

  it.each(['build-failed', 'qa-failed', 'failed-review', 'failedd', 'FAILED'])(
    'a board label spelled `%s` does not make the iteration a Ralph give-up',
    (label) => {
      // The regression this guards: drop the commas from the grep and every one of these takes
      // the failure branch — the issue is swept out of the queue and reported as work Ralph
      // gave up on, having never been given a chance. Observable as the sweep's removal edit,
      // which only the failure branch issues on a zero exit.
      seedIssue({ labels: `in-progress,${label}`, state: 'OPEN' })
      const res = runLoop()
      expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
      expect(readEdits(), `\`${label}\` was read as the failure label`).toEqual([])
      // Still counted a failure — by the zero-progress accounting, not by the label — so the
      // queue keeps advancing. Nothing was written to the board.
      expect(tally(res.stdout)).toEqual([0, 1])
    },
  )

  it.each(['pending-merge-later', 'not-pending-merge', 'pending-merged'])(
    'a board label spelled `%s` does not make the iteration a success',
    (label) => {
      // The other anchored grep, and the more expensive direction to get wrong: a false SUCCESS
      // reports an unresolved issue as done and takes it out of the queue for good.
      seedIssue({ labels: `in-progress,${label}`, state: 'OPEN' })
      const res = runLoop()
      expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
      expect(readEdits(), `\`${label}\` was read as the rollforward label`).toEqual([])
      expect(tally(res.stdout)).toEqual([0, 1])
    },
  )

  it.each([
    ['first in the list', 'failed,in-progress'],
    ['last in the list', 'in-progress,failed'],
    ['in the middle', 'bug,failed,in-progress'],
    ['beside a colliding neighbour', 'build-failed,failed,failed-review'],
    ['as the only label', 'failed'],
  ])('the real `failed` label is found when it sits %s', (_where, labels) => {
    // Position independence of the anchored match — the `,$labels,` wrapping is what makes the
    // first and last positions work at all, and the colliding-neighbour row is the case where
    // an unanchored grep and an anchored one would agree by luck.
    seedIssue({ labels, state: 'OPEN' })
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(tally(res.stdout)).toEqual([0, 1])
    expect(readEdits()).toEqual(['issue edit 1 --remove-label in-progress'])
  })
})

describe('QA #140 — the non-zero-exit give-up path, argv for argv', () => {
  it('stamps exactly `--add-label failed`, then strips `in-progress`, in that order', () => {
    // templates/ralph.sh's else branch, end to end. The three tests in the codex suite that also
    // reach this path used to assert the stamp in two pieces: `toContain('--add-label')` beside a
    // bare `toContain(<the retired failure spelling>)` at two of the sites, and only the latter at
    // the third. That was sound while the needle was a `claude-`prefixed coinage nothing else
    // could produce; after the rename it would have been satisfied by `--add-label build-failed`
    // or by a line merely mentioning failure, so #140 tightened all three to the flag and the
    // name in one string. What this test adds on top of the tightened form is the part none of
    // them can express: the two WHOLE command lines, and their ORDER — the give-up stamp must
    // land BEFORE the sweep, because `failed` is what excludes the issue from the next pass and
    // `in-progress` is only stale once it does.
    seedIssue({ labels: 'in-progress', state: 'OPEN', claudeExit: 1 })
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(readEdits()).toEqual([
      'issue edit 1 --add-label failed',
      'issue edit 1 --remove-label in-progress',
    ])
    expect(tally(res.stdout)).toEqual([0, 1])
    expect(res.stderr).toContain('Marking failed.')
  })

  it('and the give-up stamp is the same word the loop’s own query excludes', () => {
    // The half-landed rename, asked of a RUNNING loop rather than of the file: whatever the
    // stamp is, the search the next pass issues must refuse it. Read off the argv the loop
    // handed the stub, so a `SEARCH_QUERY` that had drifted from the `--add-label` would show
    // up here even though both spellings exist in the file.
    seedIssue({ labels: 'in-progress', state: 'OPEN', claudeExit: 1 })
    writeFileSync(join(workdir, 'count.txt'), '1')
    // Re-stub gh to also record the list argv, so the query and the stamp can be compared.
    const listLog = join(workdir, 'gh-list.log')
    writeStub(
      'gh',
      `#!/bin/bash
CNT_FILE="${join(workdir, 'count.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  echo "$*" >> "${listLog}"
  cnt=$(cat "$CNT_FILE")
  case "$*" in
    *sort:created-asc*)
      echo "$cnt"
      echo "$((cnt - 1))" > "$CNT_FILE"
      ;;
    *) echo "$cnt" ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "in-progress" ;;
    *state*)  echo "OPEN" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  echo "$*" >> "${join(workdir, 'gh-edit.log')}"
  exit 0
fi
exit 0
`,
    )
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()

    const stamped = readEdits()
      .map((line) => line.match(/--add-label (\S+)/))
      .filter(Boolean)
      .map((match) => match[1])
    expect(stamped.length, `no give-up stamp in:\n${readEdits().join('\n')}`).toBeGreaterThan(0)

    const searches = readFileSync(listLog, 'utf8')
    for (const name of stamped) {
      expect(searches, `the loop stamps \`${name}\` but never excludes it`).toContain(
        `-label:${name}`,
      )
    }
  })
})

describe('QA #140 — the stale-label sweep has no pre-check, and needs none', () => {
  it('strips `in-progress` from a resolved issue that never carried it', () => {
    // The sweep's header claims "No 'does it have the label?' pre-check: gh no-ops on an absent
    // label." Pinned as behaviour: the removal is issued unconditionally on the terminal
    // branches, so idempotence is gh's problem and not a branch the loop can get wrong. Also
    // the answer to "what happens on an issue that is already clean" — one wasted write, never
    // a changed verdict.
    seedIssue({ labels: 'bug', state: 'CLOSED' })
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(tally(res.stdout)).toEqual([1, 0])
    expect(readEdits()).toEqual(['issue edit 1 --remove-label in-progress'])
  })

  it('and an empty label list cannot be read as any of Ralph’s labels', () => {
    // The `,$labels,` wrapping on an empty string is `,,` — which must match neither grep. An
    // OPEN issue with no labels at all and a clean exit is the "agent did nothing" case, and it
    // must reach the zero-progress accounting rather than a label branch.
    seedIssue({ labels: '', state: 'OPEN' })
    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(readEdits()).toEqual([])
    expect(tally(res.stdout)).toEqual([0, 1])
  })
})
