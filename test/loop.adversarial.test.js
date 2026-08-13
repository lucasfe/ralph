import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templatePath } from '../lib/paths.js'

const RALPH_TEMPLATE = templatePath('ralph.sh')
// Resolve the REAL node binary so the stub can delegate agent-invocation.js
// (the JS→bash bridge) to it; the loop now FAILS FAST if that resolution yields
// nothing, so the bridge must run for real. build-prompt.js stays an echo.
const REAL_NODE = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
  encoding: 'utf8',
}).trim()

// Adversarial / edge-case companions to test/loop.test.js. These reuse the same
// stub-on-PATH harness but exercise the corners of the issue #505 fix that the
// dev's happy-path tests don't reach:
//   - jq `fromjson? // empty` tolerance for stray non-JSON on STDOUT
//   - queue draining through a transient claude failure (claude-failed advances)
//   - the zero-progress guard only firing on CONSECUTIVE identical re-selection
//   - claude's stderr landing in the per-issue log (no empty-log signal loss)
//   - PIPESTATUS[1] reflecting claude's exit, not the tail of the pipe
//   - --once mode exiting 0
//   - empty queue / count="0" immediate exit

let workdir
let bindir

function writeStub(name, body) {
  const p = join(bindir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
}

// A FAITHFUL jq stub (PURE BASH — must not depend on the stubbed \`node\`) that
// emulates the real \`jq -rR 'fromjson? // empty | ...'\` contract: each input
// line is parsed; non-JSON lines are silently dropped (fromjson? // empty),
// valid JSON lines are summarized. It NEVER errors on non-JSON input — that is
// precisely the tolerance the fix relies on. This lets us prove the FILTER
// design swallows stray stdout noise instead of dying. Recognition is by simple
// substring matching (sufficient for the fixed stream-json the tests emit).
// Non-streaming jq uses (@uri, .labels, .state) are handled elsewhere/no-op'd.
const FAITHFUL_JQ = `#!/bin/bash
is_stream=0
for a in "$@"; do
  case "$a" in
    *".type =="*) is_stream=1 ;;
  esac
done
if [ "$is_stream" -ne 1 ]; then
  cat > /dev/null 2>/dev/null || true
  exit 0
fi
while IFS= read -r line; do
  case "$line" in
    *'"type":"result"'*)
      sub="ok"
      case "$line" in
        *'"subtype":"'*'"'*)
          sub="\${line#*\\"subtype\\":\\"}"
          sub="\${sub%%\\"*}"
          ;;
      esac
      echo "==> result: $sub"
      ;;
    *'"type":"assistant"'*'"text":"'*)
      txt="\${line#*\\"text\\":\\"}"
      txt="\${txt%%\\"*}"
      echo "$txt"
      ;;
    *) : ;;  # fromjson? // empty -> drop stray non-JSON, never fatal
  esac
done
exit 0
`

function runLoop({ timeout = 15000, extraEnv = {}, args = [] } = {}) {
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    RALPH_TMUX_SESSION: 'ralph-test',
    CALLMEBOT_KEY: '',
    WHATSAPP_PHONE: '',
    ...extraEnv,
  }
  return spawnSync('bash', [RALPH_TEMPLATE, ...args], {
    cwd: workdir,
    env,
    timeout,
    encoding: 'utf8',
  })
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ralph-adv-'))
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
`
  )

  writeStub(
    'node',
    `#!/bin/bash
# The JS→bash agent bridge must run for real (the loop fails fast without it);
# everything else (build-prompt.js) just needs to emit a dummy prompt.
case "$*" in
  *agent-invocation.js*) exec "${REAL_NODE}" "$@" ;;
esac
echo "PROMPT"
exit 0
`
  )

  // tmux/curl no-ops.
  writeStub('tmux', `#!/bin/bash\nexit 0\n`)
  writeStub('curl', `#!/bin/bash\nexit 0\n`)

  // Default to the faithful jq; individual tests can override.
  writeStub('jq', FAITHFUL_JQ)
})

afterEach(() => {
  if (workdir && existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true })
  }
})

describe('ralph.sh main loop — adversarial / edge cases (#505 fix)', () => {
  it('tolerates stray NON-JSON on claude STDOUT (fromjson? // empty) and still drains', () => {
    // claude prints a stray non-JSON banner line on STDOUT, interleaved with
    // real stream-json. Real jq -rR with `fromjson?` must skip the bad line,
    // not abort with a parse error. We use the FAITHFUL jq stub so this test
    // validates the FILTER design, not a permissive stub.
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo "Warning: deprecated flag --foo (this is NOT json)"   # stray stdout noise
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
echo 'not json either {{{'
echo '{"type":"result","subtype":"success"}'
exit 0
`
    )
    writeFileSync(join(workdir, 'count.txt'), '2')
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
    *labels*) echo "" ;;
    *state*)  echo "CLOSED" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
exit 0
`
    )

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)
    // No jq parse error must surface anywhere.
    expect(`${res.stdout}\n${res.stderr}`).not.toMatch(/parse error|Invalid numeric literal/i)
    expect(res.stdout).toContain('Queue empty, exiting.')
    // The valid JSON was still summarized through the tolerant filter.
    expect(res.stdout).toContain('==> result: success')
  })

  it('drains the queue THROUGH a transient claude failure (claude-failed advances the queue)', () => {
    // First selected issue (#50) fails: claude exits non-zero, no label yet.
    // The loop must apply claude-failed; the gh stub then DROPS #50 from the
    // search so the next iteration selects a DIFFERENT issue (#51), which
    // succeeds. The queue drains; the guard must NOT break on the transient.
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
NUM=$(cat "${join(workdir, 'current.txt')}" 2>/dev/null || echo "")
if [ "$NUM" = "50" ]; then
  echo "Credit balance too low" >&2
  exit 1
fi
echo '{"type":"result","subtype":"success"}'
exit 0
`
    )
    // gh: returns #50 first; once #50 is labeled claude-failed, search returns
    // #51, then empties. View reports the labels we recorded via edit.
    writeFileSync(join(workdir, 'failed50.txt'), '')
    writeStub(
      'gh',
      `#!/bin/bash
FAILED="${join(workdir, 'failed50.txt')}"
CUR="${join(workdir, 'current.txt')}"
SEL="${join(workdir, 'selected.log')}"
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  # record claude-failed on the issue number ($3)
  echo "$3" >> "$FAILED"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  if grep -q "50" "$FAILED" 2>/dev/null; then
    if [ -f "${join(workdir, 'done51.txt')}" ]; then
      n=0
    else
      n=51
    fi
  else
    n=50
  fi
  case "$*" in
    *sort:created-asc*)
      echo "$n" >> "$SEL"
      echo "$n" > "$CUR"
      echo "$n"
      [ "$n" = "51" ] && touch "${join(workdir, 'done51.txt')}"
      ;;
    *)
      [ "$n" = "0" ] && echo "0" || echo "1"
      ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  num=$(cat "$CUR")
  case "$*" in
    *labels*)
      if [ "$num" = "50" ] && grep -q "50" "$FAILED" 2>/dev/null; then
        echo "claude-failed"
      else
        echo ""
      fi
      ;;
    *state*)
      if [ "$num" = "51" ]; then echo "CLOSED"; else echo "OPEN"; fi
      ;;
    *) echo "" ;;
  esac
  exit 0
fi
exit 0
`
    )

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)
    // Queue must have advanced to a DIFFERENT issue, not broken on the guard.
    const selected = readFileSync(join(workdir, 'selected.log'), 'utf8').trim().split('\n')
    expect(selected).toContain('50')
    expect(selected).toContain('51')
    // No zero-progress abort message — the queue drained normally.
    expect(res.stderr).not.toMatch(/no progress/)
    expect(res.stdout).toContain('Queue empty, exiting.')
    // #50 ends a failure, #51 a success.
    expect(res.stdout).toMatch(/1 ok, 1 failed|1 ok/)
  })

  it('guard fires ONLY on consecutive identical re-selection (A, B, A does not trigger)', () => {
    // Selection sequence: 70, 71, 70, then empty. None of these are
    // *consecutive* duplicates, so prev_num never equals num and the
    // zero-progress guard must never fire. claude succeeds each time but the
    // issues stay OPEN+unlabeled (so they're counted failures, not successes) —
    // the point is purely that the loop drains by sequence, not by guard-break.
    writeFileSync(join(workdir, 'seq.idx'), '0')
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo '{"type":"result","subtype":"success"}'
exit 0
`
    )
    writeStub(
      'gh',
      `#!/bin/bash
IDX="${join(workdir, 'seq.idx')}"
SEL="${join(workdir, 'selected.log')}"
SEQ=(70 71 70)
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  i=$(cat "$IDX")
  case "$*" in
    *sort:created-asc*)
      n="\${SEQ[$i]}"
      echo "$n" >> "$SEL"
      echo "$n"
      echo "$((i + 1))" > "$IDX"
      ;;
    *)
      if [ "$i" -ge "\${#SEQ[@]}" ]; then echo "0"; else echo "1"; fi
      ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "" ;;
    *state*)  echo "OPEN" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
exit 0
`
    )

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)
    const selected = readFileSync(join(workdir, 'selected.log'), 'utf8').trim().split('\n')
    expect(selected).toEqual(['70', '71', '70'])
    // Guard must NOT have fired — no abort message.
    expect(res.stderr).not.toMatch(/no progress/)
    expect(res.stdout).toContain('Queue empty, exiting.')
  })

  it("writes claude's stderr line to the per-issue log (no empty-log signal loss)", () => {
    // The issue called out empty logs. claude writes an auth error to STDERR.
    // The fix routes stderr to `tee -a "$log_file" >&2`, so the error must land
    // in logs/ralph-issue-<N>.log. Use the FAILING-on-non-json behavior plus
    // the zero-progress single-issue setup so the loop terminates via the guard.
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo "Credit balance too low (auth error)" >&2
exit 1
`
    )
    writeStub(
      'gh',
      `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*) echo "98"; exit 0 ;;
    *) echo "1"; exit 0 ;;
  esac
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "" ;;
    *state*)  echo "OPEN" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
exit 0
`
    )

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    const logPath = join(workdir, 'logs', 'ralph-issue-98.log')
    expect(existsSync(logPath), `expected per-issue log at ${logPath}`).toBe(true)
    const logContents = readFileSync(logPath, 'utf8')
    // The stderr error line must reach the per-issue log IN FULL (the issue's
    // core complaint was an EMPTY/lost log on failure). The truncate-vs-append
    // race is now fixed: the log is truncated ONCE up front and both tees only
    // append, so no writer can clobber another's leading bytes. Assert the
    // COMPLETE stderr line to guard that no-clobber property.
    expect(logContents).toMatch(/Credit balance too low \(auth error\)/)
  })

  it('sets claude_failed from claude exit (PIPESTATUS[1]) even when jq+tee succeed', () => {
    // claude exits non-zero but emits VALID json that jq/tee process fine
    // (so the tail of the pipe is success). The fix reads PIPESTATUS[1]
    // (claude), so claude_failed must be 1 -> the loop applies claude-failed.
    // Observable consequence: `gh issue edit --add-label claude-failed` is
    // called for the issue.
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo '{"type":"result","subtype":"error_during_execution"}'
exit 1
`
    )
    writeStub(
      'gh',
      `#!/bin/bash
EDIT="${join(workdir, 'edits.log')}"
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  echo "$*" >> "$EDIT"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*) echo "98"; exit 0 ;;
    *) echo "1"; exit 0 ;;
  esac
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "" ;;
    *state*)  echo "OPEN" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
exit 0
`
    )

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    const edits = existsSync(join(workdir, 'edits.log'))
      ? readFileSync(join(workdir, 'edits.log'), 'utf8')
      : ''
    expect(edits, 'claude_failed must have triggered an --add-label claude-failed edit').toMatch(
      /--add-label claude-failed/
    )
  })

  it('resolves the agent even when the node bridge prints a warning to STDERR (#555)', () => {
    // Regression: resolve_agent_invocation must capture the bridge's stderr
    // SEPARATELY so stdout stays pristine for eval. Here the node stub delegates
    // agent-invocation.js to REAL_NODE (emitting valid RALPH_AGENT_* assignments
    // on stdout) AND prints a node-style warning to stderr. If stderr were folded
    // into $sh (the old 2>&1 bug), eval would hit the warning line and die with a
    // syntax error, RALPH_AGENT_ARGS would never be set, and under `set -u` the
    // loop would abort with an unbound-variable error. The loop must still drain.
    writeStub(
      'node',
      `#!/bin/bash
case "$*" in
  *agent-invocation.js*)
    "${REAL_NODE}" "$@"
    echo "(node:12345) ExperimentalWarning: some transitive dep warning" >&2
    exit 0
    ;;
esac
echo "PROMPT"
exit 0
`
    )
    writeStub(
      'claude',
      `#!/bin/bash
cat > /dev/null
echo '{"type":"result","subtype":"success"}'
exit 0
`
    )
    // Count drains after #88 is resolved (CLOSED) so the loop terminates.
    writeStub(
      'gh',
      `#!/bin/bash
DONE="${join(workdir, 'done88.txt')}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case "$*" in
    *sort:created-asc*) echo "88"; touch "$DONE"; exit 0 ;;
    *) [ -f "$DONE" ] && echo "0" || echo "1"; exit 0 ;;
  esac
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) echo "" ;;
    *state*)  echo "CLOSED" ;;
    *)        echo "" ;;
  esac
  exit 0
fi
exit 0
`
    )

    const res = runLoop()
    expect(res.signal, `loop hung. stdout:\n${res.stdout}`).toBeNull()
    expect(res.status).toBe(0)
    // eval must NOT have choked on the warning line, and set -u must NOT have
    // tripped on an unset RALPH_AGENT_ARGS.
    expect(`${res.stdout}\n${res.stderr}`).not.toMatch(
      /syntax error|unbound variable|RALPH_AGENT_ARGS/,
    )
    // The abort branch must NOT have fired despite the stderr noise.
    expect(res.stderr).not.toMatch(/failed to resolve agent invocation/)
    // The loop resolved the agent and drained the queue normally.
    expect(res.stdout).toContain('==> result: success')
    expect(res.stdout).toContain('Queue empty, exiting.')
  })

  it('empty queue: exits cleanly with 0 ok / 0 failed when count is "0" immediately', () => {
    writeStub(
      'gh',
      `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  echo "0"   # length 0 on the count query; loop breaks before selecting
  exit 0
fi
exit 0
`
    )
    const res = runLoop()
    expect(res.signal).toBeNull()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Queue empty, exiting.')
    expect(res.stdout).toMatch(/0 ok, 0 failed|0 ok/)
  })

  it('--once mode exits 0 and skips end-of-run notify/tmux teardown', () => {
    writeStub(
      'gh',
      `#!/bin/bash
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  echo "0"
  exit 0
fi
exit 0
`
    )
    // tmux stub records any kill-session call so we can assert it's skipped.
    writeStub(
      'tmux',
      `#!/bin/bash
echo "$*" >> "${join(workdir, 'tmux.log')}"
exit 0
`
    )
    const res = runLoop({ args: ['--once'] })
    expect(res.signal).toBeNull()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Queue empty, exiting.')
    // --once must exit before the tmux kill-session teardown.
    const tmuxLog = existsSync(join(workdir, 'tmux.log'))
      ? readFileSync(join(workdir, 'tmux.log'), 'utf8')
      : ''
    expect(tmuxLog).not.toMatch(/kill-session/)
  })
})
