import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

const RALPH_TEMPLATE = templatePath('ralph.sh')
// Resolve the REAL node binary so the stub can delegate the capture-issue-event
// invocation to it (the stub shadows `node` on PATH; build-prompt.js stays an
// echo, but the telemetry sidecar must actually run).
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

// Adversarial coverage for the #40 `claude-working` label sweep in
// templates/ralph.sh. The dev-facing suite (one describe per issue) lives in
// test/loop.test.js; this file carries the hostile paths, which is the split the
// repo already uses (test/loop.adversarial.test.js, lib/*.qa.test.js). Its
// centrepiece is seedStatefulRepo — a stateful mini-`gh` that really mutates
// labels and derives queue eligibility from them, so a test can observe what a
// label edit does to the NEXT iteration's issue SELECTION. The paths covered:
//   • the branch the sweep deliberately does NOT run on (zero progress), where
//     the sticky label is the only thing keeping a stuck issue out of the queue;
//   • classification/accounting integrity — the sweep must not be able to move
//     the success/failure tally;
//   • telemetry integrity — the captured event must reflect what the AGENT left,
//     i.e. the pre-sweep labels/state;
//   • gh failure modes beyond a plain non-zero exit (stderr noise, garbage
//     stdout, exit 2, exit 127 = binary missing).

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

function runLoop({ timeout = 15000, once = false, extraEnv = {} } = {}) {
  // Prepend our stub bin to PATH; keep the real bash + coreutils available.
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-test',
    // Ensure no real notifications fire.
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    ...extraEnv,
  }
  const args = once ? [RALPH_TEMPLATE, '--once'] : [RALPH_TEMPLATE]
  return spawnSync('bash', args, {
    cwd: workdir,
    env,
    timeout,
    encoding: 'utf8',
  })
}

// Collect the RALPH_CYCLE_EVENT lines the loop appended to logs/ralph-cycle.out.log.
function readCycleEvents() {
  const f = join(workdir, 'logs', 'ralph-cycle.out.log')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.includes('RALPH_CYCLE_EVENT'))
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-loop-'))
  bindir = join(workdir, 'bin')
  mkdirSync(bindir, { recursive: true })
  mkdirSync(join(workdir, 'logs'), { recursive: true })
  // Pre-seed .ralph/state.json so the lazy-validation block is bypassed.
  // (Validation only runs when ralph.config.sh exists; we don't create it,
  // so the whole block is skipped and the test isolates the main loop.)
  mkdirSync(join(workdir, '.ralph'), { recursive: true })
  writeFileSync(join(workdir, '.ralph', 'state.json'), '{}')

  // --- git stub: answer rev-parse --show-toplevel with our workdir, and
  // no-op everything else (checkout/pull/branch in cleanup). -----------------
  writeStub(
    'git',
    `#!/bin/bash
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  echo "${workdir}"
  exit 0
fi
exit 0
`
  )

  // --- node stub: the script calls \`node -p require(...).version\` only when
  // ralph.config.sh exists (it doesn't here), and \`node .../build-prompt.js\`
  // inside the loop. The build-prompt invocation just needs to emit *some*
  // prompt text on stdout that the claude stub will read. ---------------------
  writeStub(
    'node',
    `#!/bin/bash
# The telemetry sidecar (capture-issue-event.js) must run for real so the
# .ralph/metrics/issues.jsonl assertion is meaningful; delegate it to the real
# node binary. Everything else (build-prompt.js / build-validate-prompt.js)
# just needs to emit a dummy prompt.
case "$*" in
  *capture-issue-event.js*) exec "${REAL_NODE}" "$@" ;;
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`
  )

  // NOTE: no default `gh`/`claude` stubs here — every test in this file installs
  // its own pair via seedLabelledIssue or seedStatefulRepo, so defaults would be
  // dead setup that never runs.

  // --- jq stub: behave like a minimal real jq for the queries the loop uses,
  // but FAIL loudly on the streaming filter if it ever receives the non-JSON
  // claude stderr (mirrors real jq's "Invalid numeric literal"). We don't
  // implement full jq; we recognize the specific invocations. ----------------
  writeStub(
    'jq',
    `#!/bin/bash
# Detect the streaming pretty-print filter used on claude output.
for a in "$@"; do
  case "$a" in
    *".type == \\"assistant\\""*)
      # Read stdin; if any line isn't JSON, emulate jq's parse error + nonzero.
      while IFS= read -r line; do
        case "$line" in
          '{'*) : ;;        # looks like JSON, ignore
          '') : ;;
          *)
            echo "jq: parse error: Invalid numeric literal at line 1, column 6" >&2
            exit 5
            ;;
        esac
      done
      exit 0
      ;;
  esac
done
# Fallback for other jq uses (e.g. @uri encoding in notifications): no-op.
cat > /dev/null 2>/dev/null || true
exit 0
`
  )

  // tmux/curl stubs so cleanup/notify paths never touch the real system.
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)
})

afterEach(() => {
  if (workdir && existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true })
  }
})

describe('ralph.sh claude-working label hygiene — QA adversarial (#40)', () => {
  // A one-issue GitHub queue whose `gh issue view` reports the given labels +
  // state, and whose `gh issue edit` records the argv it received to
  // gh-edit.log (so a test can prove exactly what the loop asked GitHub to
  // change) and exits with `editExit`. `drains: false` keeps the queue count
  // pinned so the same issue is re-selected and the zero-progress guard fires
  // (the failure path). `logAllCalls` additionally records EVERY gh argv (reads
  // included) to gh-calls.log so a test can assert call ORDER; `editExtra` is
  // bash injected into the `issue edit` branch (stderr noise / garbage stdout).
  // test/loop.test.js carries the same generator without those last two options
  // (harness duplication is the convention here — see loop.adversarial.test.js).
  function seedLabelledIssue({
    labels = 'claude-working',
    state = 'CLOSED',
    editExit = 0,
    claudeExit = 0,
    drains = true,
    logAllCalls = false,
    editExtra = '',
  } = {}) {
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
${logAllCalls ? `echo "$*" >> "${join(workdir, 'gh-calls.log')}"` : ': # not logging every call'}
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cnt=$(cat "$CNT_FILE")
  case "$*" in
    *sort:created-asc*)
      echo "$cnt"
      ${drains ? 'echo "$((cnt - 1))" > "$CNT_FILE"' : ': # queue never drains'}
      ;;
    *)
      echo "$cnt"
      ;;
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
${editExtra || ': # no injected edit behavior'}
  exit ${editExit}
fi
exit 0
`,
    )
  }

  // Every `gh issue edit` argv the loop issued, one per line.
  function readEdits() {
    const f = join(workdir, 'gh-edit.log')
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
  }

  // Every `gh` invocation the loop (and the telemetry sidecar) made, in order.
  // Populated by seedLabelledIssue({ logAllCalls: true }) and by seedStatefulRepo.
  function readAllGhCalls() {
    const f = join(workdir, 'gh-calls.log')
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
  }

  function readIssueEvents() {
    const f = join(workdir, '.ralph', 'metrics', 'issues.jsonl')
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l.slice('RALPH_ISSUE_EVENT '.length)))
  }

  function singleCycleEvent() {
    const lines = readCycleEvents()
    expect(lines.length, `expected one RALPH_CYCLE_EVENT, got:\n${lines.join('\n')}`).toBe(1)
    const idx = lines[0].indexOf('RALPH_CYCLE_EVENT')
    return JSON.parse(lines[0].slice(idx + 'RALPH_CYCLE_EVENT'.length).trim())
  }

  // A STATEFUL mini-gh. seedLabelledIssue's stub reports fixed labels and
  // ignores edits, which is enough to assert "the removal was issued" but
  // structurally cannot show what the removal does to the NEXT iteration's
  // issue SELECTION. This one keeps per-issue label/state files that
  // `gh issue edit --add-label/--remove-label` really mutate, and an
  // `issue list` that evaluates the loop's own exclusion filter
  // (`-label:claude-working -label:claude-failed -label:do-not-ralph
  // -label:pending-merge`) against them — so queue eligibility is derived,
  // not hardcoded. `action` scripts what the AGENT does after claiming the
  // issue with claude-working (prompt-team.md step 2):
  //   close   -> a merged PR closed it via `Closes #N`; neither agent removal
  //              path runs, so claude-working is LEFT behind (this is #40)
  //   pending -> opened a PR: adds pending-merge, removes claude-working
  //   nothing -> claimed the issue, achieved nothing, exited 0
  function seedStatefulRepo(issues) {
    const db = join(workdir, 'issuedb')
    mkdirSync(db, { recursive: true })
    for (const [num, spec] of Object.entries(issues)) {
      writeFileSync(join(db, `${num}.state`), `${spec.state || 'OPEN'}\n`)
      writeFileSync(join(db, `${num}.labels`), `${spec.labels || ''}\n`)
      writeFileSync(join(db, `${num}.action`), `${spec.action || 'nothing'}\n`)
    }
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
DB="${db}"
n=$(cat "$DB/current" 2>/dev/null)
if [ -n "$n" ]; then
# prompt-team.md step 2: claim the issue.
gh issue edit "$n" --add-label claude-working >/dev/null 2>&1
case "$(cat "$DB/$n.action" 2>/dev/null)" in
  close)
    # A merged PR closed it via \`Closes #N\`: claude-working stays on.
    echo "CLOSED" > "$DB/$n.state"
    ;;
  pending)
    gh issue edit "$n" --add-label pending-merge >/dev/null 2>&1
    gh issue edit "$n" --remove-label claude-working >/dev/null 2>&1
    ;;
esac
fi
echo '{"type":"result","subtype":"success"}'
exit 0
`,
    )
    writeStub(
      'gh',
      `#!/bin/bash
DB="${db}"
echo "$*" >> "${join(workdir, 'gh-calls.log')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
elig=""
for f in "$DB"/*.state; do
  [ -e "$f" ] || continue
  n=$(basename "$f"); n="\${n%.state}"
  [ "$(cat "$f")" = "OPEN" ] || continue
  case ",$(cat "$DB/$n.labels" 2>/dev/null)," in
    *,claude-working,*|*,claude-failed,*|*,do-not-ralph,*|*,pending-merge,*) continue ;;
  esac
  elig="$elig $n"
done
case "$*" in
  *sort:created-asc*)
    first=$(for n in $elig; do echo "$n"; done | sort -n | head -1)
    printf '%s\\n' "$first" > "$DB/current"
    echo "$first" >> "${join(workdir, 'selected.log')}"
    echo "$first"
    ;;
  *)
    for n in $elig; do echo "$n"; done | grep -c . || true
    ;;
esac
exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
n="$3"
case "$*" in
  *labels*) printf '%s\\n' "$(cat "$DB/$n.labels" 2>/dev/null)" ;;
  *state*)  printf '%s\\n' "$(cat "$DB/$n.state" 2>/dev/null)" ;;
  *)        echo "" ;;
esac
exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
echo "$*" >> "${join(workdir, 'gh-edit.log')}"
n="$3"; shift 3
while [ $# -gt 0 ]; do
  case "$1" in
    --add-label)
      cur=$(cat "$DB/$n.labels" 2>/dev/null)
      case ",$cur," in
        *,"$2",*) : ;;
        *) if [ -z "$cur" ]; then cur="$2"; else cur="$cur,$2"; fi ;;
      esac
      printf '%s\\n' "$cur" > "$DB/$n.labels"
      shift 2 ;;
    --remove-label)
      cur=$(printf '%s' ",$(cat "$DB/$n.labels" 2>/dev/null)," | sed "s/,$2,/,/g")
      cur="\${cur#,}"; cur="\${cur%,}"
      printf '%s\\n' "$cur" > "$DB/$n.labels"
      shift 2 ;;
    *) shift ;;
  esac
done
exit 0
fi
exit 0
`,
    )
  }

  function readSelections() {
    const f = join(workdir, 'selected.log')
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
  }

  // -----------------------------------------------------------------------
  // Regression guard for the REJECTED first design, which cleared the label
  // unconditionally before the classification block. That made the zero-progress
  // issue eligible again: re-selected, tripped `[ "$num" = "$prev_num" ]` and
  // `break`'d the WHOLE loop, abandoning the rest of the queue (2-of-3 → 0-of-3).
  // The shipped code clears only on the three terminal-exclusion branches. This
  // test fails if a clear_working_label call is ever added to the zero-progress
  // branch.
  // -----------------------------------------------------------------------
  it('QA: a zero-progress iteration keeps claude-working so the rest of the queue still drains', () => {
    seedStatefulRepo({
      // #1: the agent claims the issue then achieves nothing and exits 0 —
      // a routine real outcome (no PR opened, nothing closed, exit 0), so
      // bash does NOT add claude-failed.
      1: { action: 'nothing' },
      // #2 and #3 are perfectly resolvable.
      2: { action: 'close' },
      3: { action: 'close' },
    })

    const res = runLoop({ timeout: 25000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    const selected = readSelections()
    const detail = `selections: [${selected.join(', ')}]\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    expect(selected, `#2 was never worked on — the loop abandoned the queue.\n${detail}`).toContain(
      '2',
    )
    expect(selected, `#3 was never worked on — the loop abandoned the queue.\n${detail}`).toContain(
      '3',
    )
    // Both resolvable issues must be counted as successes.
    expect(res.stdout, detail).toMatch(/2 ok,/)
    // The whole-loop abort must not fire while other issues are still queued.
    expect(res.stderr, detail).not.toMatch(/Aborting the loop/)
  })

  // Control for the test above: when the agent leaves claude-working on an
  // issue a merged PR CLOSED (the actual #40 story), clearing it is harmless —
  // the closed state keeps it out of the queue — and the whole queue drains.
  it('QA: clearing on the CLOSED success path still drains the whole queue', () => {
    seedStatefulRepo({
      1: { action: 'close' },
      2: { action: 'pending' },
      3: { action: 'close' },
    })

    const res = runLoop({ timeout: 25000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    expect(readSelections().sort()).toEqual(['1', '2', '3'])
    expect(res.stdout).toMatch(/3 ok, 0 failed/)

    // Every issue ends with claude-working gone — the acceptance criterion,
    // asserted against the label state gh actually holds, not against argv.
    for (const n of [1, 2, 3]) {
      const labels = readFileSync(join(workdir, 'issuedb', `${n}.labels`), 'utf8').trim()
      expect(labels.split(',').filter(Boolean), `#${n} kept claude-working`).not.toContain(
        'claude-working',
      )
    }
    // ...and pending-merge survived on #2 (the sweep is surgical).
    expect(readFileSync(join(workdir, 'issuedb', '2.labels'), 'utf8')).toContain('pending-merge')
  })

  // -----------------------------------------------------------------------
  // Classification, accounting and telemetry integrity: the sweep runs after
  // the verdict is computed, so it can never move the tally or the event.
  // -----------------------------------------------------------------------
  it.each(['OPEN', 'CLOSED'])(
    'QA: claude-working + claude-failed on a %s issue is still counted a FAILURE (removal cannot corrupt the verdict)',
    (state) => {
      seedLabelledIssue({ labels: 'claude-working,claude-failed', state })

      const res = runLoop({ timeout: 15000 })
      expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
      expect(res.stdout).toMatch(/0 ok, 1 failed/)

      // End-of-run accounting is byte-identical to the pre-#40 tally.
      const ev = singleCycleEvent()
      expect(ev.ok).toBe(0)
      expect(ev.failed).toBe(1)
      expect(ev.processed).toBe(1)
      expect(ev.status).toBe('failed')

      const edits = readEdits()
      expect(edits.some((e) => /--remove-label claude-working/.test(e))).toBe(true)
      // The failure branch touches no labels of its own, so the ONLY edit is
      // the sweep — claude-failed is not re-added, claude-working never re-added.
      expect(edits.filter((e) => /--add-label/.test(e))).toEqual([])

      // Telemetry integrity: the verdict is derived from what the AGENT left
      // (claude-failed wins even over a CLOSED state), never from the
      // post-removal label set.
      const events = readIssueEvents()
      expect(events.length).toBe(1)
      expect(events[0].verdict).toBe('fail')
      expect(events[0].issue_number).toBe(1)
    },
  )

  it('QA: pending-merge success path — accounting + telemetry are captured BEFORE the removal', () => {
    // Label order reversed vs. the dev's test, so the classification cannot
    // be depending on claude-working being last in the joined string.
    seedLabelledIssue({ labels: 'claude-working,pending-merge', state: 'OPEN', logAllCalls: true })

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)

    const ev = singleCycleEvent()
    expect(ev.ok).toBe(1)
    expect(ev.failed).toBe(0)
    expect(ev.status).toBe('success')

    // The captured event reflects the agent-left labels: pending-merge => pass.
    const events = readIssueEvents()
    expect(events.length).toBe(1)
    expect(events[0].verdict).toBe('pass')

    // ORDERING proof, from the real gh call sequence: the label/state reads
    // and the telemetry sidecar's own gh call (fetchPrDiffStats ->
    // `gh pr list --head issue-1`) both happen BEFORE the removal, so no
    // capture can ever observe the post-removal state.
    const calls = readAllGhCalls()
    const trace = `gh calls:\n${calls.join('\n')}`
    const viewLabels = calls.findIndex((c) => /^issue view 1 --json labels/.test(c))
    const sidecar = calls.findIndex((c) => /^pr list --head issue-1/.test(c))
    const removal = calls.findIndex((c) => /^issue edit 1 .*--remove-label claude-working/.test(c))
    expect(viewLabels, trace).toBeGreaterThanOrEqual(0)
    expect(sidecar, trace).toBeGreaterThanOrEqual(0)
    expect(removal, trace).toBeGreaterThanOrEqual(0)
    expect(removal, trace).toBeGreaterThan(viewLabels)
    expect(removal, trace).toBeGreaterThan(sidecar)
  })

  // -----------------------------------------------------------------------
  // gh failure modes beyond the plain exit 1/124 the dev suite covers.
  // -----------------------------------------------------------------------
  it.each([2, 127])(
    'QA: a gh issue edit exiting %i (gh error / binary missing) neither aborts the iteration nor flips the outcome',
    (editExit) => {
      // `gh issue view` still succeeds here, so this is also the "gh works for
      // reads but fails only for the label edit" case.
      seedLabelledIssue({ labels: 'claude-working', state: 'CLOSED', editExit })

      const res = runLoop({ timeout: 15000 })
      expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
      expect(res.stdout).toContain('Queue empty, exiting.')
      expect(res.stdout).toMatch(/1 ok, 0 failed/)
      expect(readEdits().some((e) => /--remove-label claude-working/.test(e))).toBe(true)
      expect(singleCycleEvent().ok).toBe(1)
    },
  )

  it('QA: a gh issue edit that spews stderr and garbage stdout cannot corrupt the loop output', () => {
    seedLabelledIssue({
      labels: 'claude-working',
      state: 'CLOSED',
      editExtra:
        'echo "gh: warning: could not resolve label GARBAGE-STDERR" >&2\n' +
        'echo "GARBAGE-STDOUT-{{ not json"',
    })
    // Drift guard: if `editExtra` is ever renamed in the generator or mistyped
    // here, destructuring silently falls back to '' and the stub emits nothing —
    // every not.toContain below would then pass while testing nothing.
    expect(readFileSync(join(bindir, 'gh'), 'utf8'), 'editExtra was not injected').toContain(
      'GARBAGE-STDERR',
    )

    const res = runLoop({ timeout: 15000 })
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0)
    // `>/dev/null 2>&1` must swallow both streams: neither may leak into the
    // loop's own output (which is what tmux/`ralph cycle` logs are parsed from).
    expect(res.stdout).not.toContain('GARBAGE-STDOUT')
    expect(res.stdout).not.toContain('GARBAGE-STDERR')
    expect(res.stderr).not.toContain('GARBAGE-STDOUT')
    expect(res.stderr).not.toContain('GARBAGE-STDERR')
    expect(res.stdout).toMatch(/1 ok, 0 failed/)
    // The run-event line is still well-formed JSON on its own line.
    const ev = singleCycleEvent()
    expect(ev.ok).toBe(1)
    expect(ev.failed).toBe(0)
  })
})
