#!/bin/bash
# Ralph loop — resolve open GitHub issues one at a time, fully autonomously.
# Invoked by `ralph start` inside a tmux session. Don't run directly.

set -u

# `--once` mode: callable from `ralph cycle`, which owns its own start/end
# notifications, lock, and process lifetime. In once mode we drain the queue a
# single time and exit cleanly without sending end-of-run notifications or
# killing the tmux session (cycle is not running inside one).
RALPH_ONCE_MODE="${RALPH_ONCE:-}"
if [ "${1:-}" = "--once" ]; then
  RALPH_ONCE_MODE=1
fi

# Path safety: anchor the loop to the git project root and refuse to run
# outside a git repo or in $HOME / root. PROJECT_ROOT is exported so child
# tools (Claude, gh, npm) inherit the same anchor.
if ! PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "❌ ralph.sh: not inside a git repository. Aborting." >&2
  exit 1
fi

if [ -z "$PROJECT_ROOT" ] || [ "$PROJECT_ROOT" = "/" ] || [ "$PROJECT_ROOT" = "$HOME" ]; then
  echo "❌ ralph.sh: refusing to run with PROJECT_ROOT='$PROJECT_ROOT'." >&2
  exit 1
fi

cd "$PROJECT_ROOT"
export PROJECT_ROOT

# Locate the package directory (one level up from this template).
RALPH_PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export RALPH_PKG_DIR

# --- Global config read path (#4) -------------------------------------------
# Source ~/.config/ralph/.env for any variable NOT already set in the
# environment. This mirrors lib/utils/global-config.js: the global file is the
# lowest-priority credential source, so the loop's shell-sent WhatsApp
# notifications work without a per-repo .env.local. Called BEFORE .env.local so
# precedence stays repo → process.env → global (already-set vars, including the
# process env, win; the global file only fills the gaps). Absent file is a
# silent no-op. Set-but-empty counts as set, matching the JS `??` resolver.
source_global_config() {
  local global_config="${XDG_CONFIG_HOME:-$HOME/.config}/ralph/.env"
  [ -f "$global_config" ] || return 0
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    # Trim leading whitespace, then skip blanks and comments.
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in ''|'#'*) continue ;; esac
    # Require a KEY=VALUE shape; split on the first '='.
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    key="${key#export }"
    # Trim whitespace around the key.
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    # Only fill vars not already set — repo/process.env keep priority.
    [ -n "${!key+x}" ] && continue
    value="${line#*=}"
    # Trim surrounding whitespace before unquoting, matching parseEnvFile.
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    # Strip a single pair of surrounding matching quotes, like parseEnvFile.
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    export "$key=$value"
  done < "$global_config"
}
# ---------------------------------------------------------------------------

# Source ralph.config.sh first so commands/branches/merge config become env
# vars visible to the prompt builder. Then fill any unset creds from the global
# config, and finally source .env.local so the repo's own values win.
if [ -f ralph.config.sh ]; then
  set -a
  . ./ralph.config.sh
  set +a
fi

source_global_config

if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi

mkdir -p logs

# --- Coding-agent resolution (#554) -----------------------------------------
# Resolve which coding-agent CLI to drive (claude, the default, or codex) and
# the exact argv to invoke it with. lib/agent-invocation.js is the single source
# of truth — it reads RALPH_AGENT / RALPH_CODEX_MODEL from the env we just
# sourced and prints eval-able bash setting RALPH_RESOLVED_AGENT, RALPH_AGENT_CLI,
# the RALPH_AGENT_ARGS array and RALPH_AGENT_STREAM_FILTER. For claude the argv is
# byte-for-byte the flags the loop has always used, so the Claude path is
# unchanged. This bash holds NO agent-specific knowledge of its own.
resolve_agent_invocation() {
  local sh _err
  # Fail fast: bash has no agent defaults to fall back to. If the node bridge
  # fails or yields nothing, abort loudly rather than silently guessing.
  # Capture stderr to a temp file so stdout stays PRISTINE for eval: a node
  # Deprecation/Experimental warning (or nvm/shim banner) on a SUCCESSFUL run
  # must never be folded into $sh, or eval would choke on the warning line.
  _err="$(mktemp)"
  if ! sh="$(node "$RALPH_PKG_DIR/lib/agent-invocation.js" 2>"$_err")" || [ -z "$sh" ]; then
    echo "ralph.sh: failed to resolve agent invocation from lib/agent-invocation.js. Aborting." >&2
    cat "$_err" >&2
    rm -f "$_err"
    exit 1
  fi
  rm -f "$_err"
  eval "$sh"
}
resolve_agent_invocation
export RALPH_RESOLVED_AGENT

# --- Agent streaming helper --------------------------------------------------
# Pretty-prints the agent's JSON stdout via jq into a log file, while keeping
# the agent's stderr OUT of the JSON pipe. Non-JSON stderr lines (auth, credit,
# rate-limit errors, warnings) are tee'd to the terminal + log instead of being
# fed to jq (which would fail with "Invalid numeric literal"). jq uses
# `fromjson?` so any stray non-JSON line on stdout is skipped, not fatal.
#
# The jq stream filter is agent-specific and comes from RALPH_AGENT_STREAM_FILTER
# (resolved from the JS registry via lib/agent-invocation.js), so this bash holds
# no agent knowledge. The filter is cosmetic — the authoritative metrics parse
# happens in Node (capture-issue-event.js via parseAgentStream), never here.
#
# Args: $1 = prompt-builder script path, $2 = log file path, $3 = raw jsonl path
# (optional). Sets the global `claude_failed` to "1" when the agent exits
# non-zero, else "0" (name kept for the telemetry sidecar's RALPH_CLAUDE_EXIT).
run_agent_stream() {
  prompt_script="$1"
  log_file="$2"
  raw_jsonl="${3:-}"
  local stream_filter="$RALPH_AGENT_STREAM_FILTER"
  # Truncate the unique per-issue log ONCE up front, then have BOTH the stderr
  # tee and the stdout tee APPEND. This removes a truncate-vs-append race: if
  # the stdout `tee` opened with O_TRUNC while the stderr `tee -a` was already
  # writing, the leading bytes of a stderr line (e.g. a failure signal) could
  # be clobbered, producing the empty/lost failure log this guards against.
  : > "$log_file"
  if [ -n "$raw_jsonl" ]; then
    # Tee the agent's RAW JSON stdout to "$raw_jsonl" (fresh per issue, so a
    # plain `tee` truncate is fine) BETWEEN the agent and jq. The agent CLI
    # stays pipe element index 1 so ${PIPESTATUS[1]} exit detection is
    # unaffected (node|agent|tee|jq|tee → agent still index 1).
    node "$prompt_script" \
      | "$RALPH_AGENT_CLI" "${RALPH_AGENT_ARGS[@]}" \
          2> >(tee -a "$log_file" >&2) \
      | tee "$raw_jsonl" \
      | jq -rR --unbuffered "$stream_filter" \
      | tee -a "$log_file"
  else
    # No raw path supplied (e.g. the config-validation call) — pipeline is
    # node|agent|jq|tee, agent still index 1.
    node "$prompt_script" \
      | "$RALPH_AGENT_CLI" "${RALPH_AGENT_ARGS[@]}" \
          2> >(tee -a "$log_file" >&2) \
      | jq -rR --unbuffered "$stream_filter" \
      | tee -a "$log_file"
  fi
  # PIPESTATUS[1] is the agent's exit code (index 1 in BOTH variants).
  if [ "${PIPESTATUS[1]}" -ne 0 ]; then
    claude_failed=1
  else
    claude_failed=0
  fi
}

run_agent_for_issue() {
  run_agent_stream "$RALPH_PKG_DIR/lib/build-prompt.js" "logs/ralph-issue-$1.log" "logs/ralph-issue-$1.jsonl"
}
# ---------------------------------------------------------------------------

# --- Lazy config validation -------------------------------------------------
# Run a one-shot validation via the configured agent before the main loop when:
#   • .ralph/state.json is absent, OR
#   • the sha256 of ralph.config.sh changed since last validation, OR
#   • the installed @lucasfe/ralph version changed since last validation, OR
#   • the resolved agent differs from the one recorded in state.json (#562) —
#     the config must be re-checked under the agent that will actually run it,
#     and this also catches an agent switch made via the RALPH_AGENT env var
#     (which leaves config_hash unchanged).
# This lets users edit ralph.config.sh and have Ralph self-correct it.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ -f ralph.config.sh ]; then
  RALPH_VERSION=$(node -p "require('$RALPH_PKG_DIR/package.json').version" 2>/dev/null || echo "unknown")
  export RALPH_VERSION

  current_hash=$(sha256_of ralph.config.sh)
  needs_validate="no"
  if [ ! -f .ralph/state.json ]; then
    needs_validate="yes"
  else
    stored_hash=$(jq -r '.config_hash // ""' .ralph/state.json 2>/dev/null || echo "")
    stored_version=$(jq -r '.ralph_version // ""' .ralph/state.json 2>/dev/null || echo "")
    # #562: also compare the recorded agent against the one just resolved. A
    # legacy state.json without an `agent` field yields stored_agent="", which
    # differs from the resolved agent and triggers exactly one self-healing
    # revalidation (after which finalize-state.js records the agent).
    stored_agent=$(jq -r '.agent // ""' .ralph/state.json 2>/dev/null || echo "")
    if [ "$current_hash" != "$stored_hash" ] \
      || [ "$RALPH_VERSION" != "$stored_version" ] \
      || [ "${RALPH_RESOLVED_AGENT:-claude}" != "$stored_agent" ]; then
      needs_validate="yes"
    fi
  fi

  if [ "$needs_validate" = "yes" ]; then
    echo "==> Validating ralph.config.sh against the project manifests..."
    claude_failed=0
    run_agent_stream "$RALPH_PKG_DIR/lib/build-validate-prompt.js" "logs/ralph-validate.log"

    if [ ! -f .ralph/state.json ]; then
      echo "❌ Validation did not produce .ralph/state.json. Aborting." >&2
      exit 1
    fi

    if ! node "$RALPH_PKG_DIR/lib/finalize-state.js"; then
      echo "❌ Failed to finalize .ralph/state.json. Aborting." >&2
      exit 1
    fi

    # Re-source the config in case the agent edited it during validation.
    set -a
    . ./ralph.config.sh
    set +a
    echo "==> Validation complete."
  fi
fi
# ---------------------------------------------------------------------------

START=$(date +%s)
# Single source of truth for the run_id (`<session>-<start-epoch>`). Both the
# per-issue capture and the end-of-run RALPH_CYCLE_EVENT reference this, so the
# two can never drift apart.
RALPH_RUN_ID="${RALPH_RUN_ID:-${RALPH_TMUX_SESSION:-ralph}-${START}}"
successes=()
failures=()
claude_failed=0

SEARCH_QUERY='state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge'

# --- Task source dispatch (#565) --------------------------------------------
# Ralph draws work from either GitHub issues (the default, unchanged) or a local
# `.ralph/tasks/` folder tree (TASK_SOURCE=folder). The source is read from the
# env sourced from ralph.config.sh. Any value other than an explicit `folder`
# resolves to github, mirroring lib/task-source.js's resolveSource (an unset /
# unknown value => github, the zero-regression path). The github branch of every
# helper below is byte-for-byte the code the loop has always run.
if [ "${TASK_SOURCE:-github}" = "folder" ]; then
  TASK_SOURCE="folder"
else
  TASK_SOURCE="github"
fi
TASKS_ROOT="$PROJECT_ROOT/.ralph/tasks"

# Number of items waiting in the queue.
queue_count() {
  if [ "$TASK_SOURCE" = "folder" ]; then
    node "$RALPH_PKG_DIR/lib/folder-queue.js" count "$TASKS_ROOT" 2>/dev/null || echo 0
  else
    gh issue list --search "$SEARCH_QUERY" --limit 100 --json number -q '. | length'
  fi
}
# ---------------------------------------------------------------------------

# Track the previously-selected issue so we can detect a zero-progress spin:
# if the same issue is re-selected without any exclusion-state changing
# (claude crashed, no label applied, not closed), the queue can never drain
# and the loop would burn API calls forever. We break out instead.
prev_num=""

while :; do
  count=$(queue_count)
  if [ "$count" = "0" ]; then
    echo "Queue empty, exiting."
    break
  fi

  if [ "$TASK_SOURCE" = "folder" ]; then
    # Folder mode: select the lowest-numbered task in afk/todo (id + path). The
    # AGENT owns the happy-path moves (todo→in-progress→done) and commits
    # directly to $DEV_BRANCH — no branch, no PR. Bash owns only the failure /
    # no-op sweep + the zero-progress guard below.
    pick=$(node "$RALPH_PKG_DIR/lib/folder-queue.js" pick "$TASKS_ROOT" 2>/dev/null)
    num="${pick%%$'\t'*}"
    if [ -z "$num" ]; then
      echo "Queue empty, exiting."
      break
    fi
    echo "==> Iteration for task #$num ($count remaining) [agent: ${RALPH_RESOLVED_AGENT:-claude}]"
  else
    num=$(gh issue list --search "$SEARCH_QUERY sort:created-asc" --limit 1 --json number -q '.[0].number')
    echo "==> Iteration for issue #$num ($count remaining) [agent: ${RALPH_RESOLVED_AGENT:-claude}]"
  fi

  # Stream the agent's JSON to jq, but keep stderr OUT of the JSON pipe: any
  # non-JSON line the agent prints to stderr (auth/credit/rate-limit errors,
  # warnings) used to be merged via `2>&1` and broke jq with "Invalid numeric
  # literal". Route stderr to the per-issue log + terminal instead. jq is also
  # made tolerant of stray non-JSON input as defense-in-depth.
  issue_start_ms=$(date +%s000)
  run_agent_for_issue "$num"
  issue_end_ms=$(date +%s000)
  issue_dur_ms=$(( issue_end_ms - issue_start_ms ))

  if [ "$TASK_SOURCE" = "folder" ]; then
    # Terminal directory decides the outcome: the agent moves a completed task
    # to afk/done. Anything still sitting in afk/todo or afk/in-progress is a
    # failure/no-op — bash sweeps it to afk/failed so the queue always drains
    # (this is the folder-mode forward-progress guarantee).
    outcome=$(node "$RALPH_PKG_DIR/lib/folder-queue.js" locate "$TASKS_ROOT" "$num" 2>/dev/null)
    if [ "$outcome" != "done" ]; then
      echo "⚠️  task #$num was not completed (dir: ${outcome:-unknown}). Moving to failed." >&2
      node "$RALPH_PKG_DIR/lib/folder-queue.js" fail "$TASKS_ROOT" "$num" >/dev/null 2>&1 || true
      outcome="failed"
    fi

    # Best-effort per-task telemetry: capture one RALPH_ISSUE_EVENT line into
    # .ralph/metrics/issues.jsonl. TASK_SOURCE=folder makes the sidecar read the
    # task id (RALPH_TASK_ID) as the event number and the terminal directory
    # (RALPH_TASK_OUTCOME: done=>pass, failed=>fail) as the verdict, and skip the
    # gh PR-diff call entirely. Telemetry failure MUST NEVER abort the loop.
    TASK_SOURCE="folder" \
      RALPH_TASK_ID="$num" \
      RALPH_TASK_OUTCOME="$outcome" \
      RALPH_RUN_ID="$RALPH_RUN_ID" \
      RALPH_CLAUDE_EXIT="$claude_failed" \
      RALPH_DEV_BRANCH="${DEV_BRANCH:-}" \
      RALPH_RAW_JSONL_PATH="logs/ralph-issue-$num.jsonl" \
      RALPH_STDERR_LOG_PATH="logs/ralph-issue-$num.log" \
      RALPH_AGENT="${RALPH_RESOLVED_AGENT:-claude}" \
      RALPH_CODEX_MODEL="${RALPH_CODEX_MODEL:-}" \
      RALPH_DURATION_MS="$issue_dur_ms" \
      node "$RALPH_PKG_DIR/lib/capture-issue-event.js" || true

    if [ "$outcome" = "done" ]; then
      successes+=("$num")
    else
      failures+=("$num")
    fi

    # Zero-progress guard: the sweep above guarantees the task leaves afk/todo,
    # so the queue must drain. If somehow the SAME task is re-selected (e.g. a
    # sweep that could not move the file), abort rather than spin forever.
    if [ "$num" = "$prev_num" ]; then
      echo "❌ ralph.sh: no progress on task #$num (re-selected). Aborting the loop." >&2
      break
    fi
    prev_num="$num"
    continue
  fi

  labels=$(gh issue view "$num" --json labels -q '[.labels[].name] | join(",")')
  state=$(gh issue view "$num" --json state -q '.state')

  # Best-effort per-issue telemetry: capture one RALPH_ISSUE_EVENT line into
  # .ralph/metrics/issues.jsonl. Runs once per iteration regardless of outcome.
  # Telemetry failure MUST NEVER abort or alter the loop, hence `|| true`.
  RALPH_ISSUE_NUMBER="$num" \
    RALPH_RUN_ID="$RALPH_RUN_ID" \
    RALPH_CLAUDE_EXIT="$claude_failed" \
    RALPH_ISSUE_LABELS="$labels" \
    RALPH_ISSUE_STATE="$state" \
    RALPH_DEV_BRANCH="${DEV_BRANCH:-}" \
    RALPH_RAW_JSONL_PATH="logs/ralph-issue-$num.jsonl" \
    RALPH_STDERR_LOG_PATH="logs/ralph-issue-$num.log" \
    RALPH_AGENT="${RALPH_RESOLVED_AGENT:-claude}" \
    RALPH_CODEX_MODEL="${RALPH_CODEX_MODEL:-}" \
    RALPH_DURATION_MS="$issue_dur_ms" \
    node "$RALPH_PKG_DIR/lib/capture-issue-event.js" || true

  if echo ",$labels," | grep -q ",claude-failed,"; then
    failures+=("$num")
  elif [ "$state" = "CLOSED" ] || echo ",$labels," | grep -q ",pending-merge,"; then
    successes+=("$num")
  else
    # No exclusion label and still open. If claude failed (non-zero exit) mark
    # the issue claude-failed so the queue advances on the next iteration.
    if [ "$claude_failed" = "1" ]; then
      echo "⚠️  claude failed on issue #$num (non-zero exit). Marking claude-failed." >&2
      gh issue edit "$num" --add-label claude-failed >/dev/null 2>&1 || true
    fi

    # Zero-progress guard: if we just re-selected the SAME issue we worked on
    # last iteration and it still has no exclusion state, no progress was made.
    # Record it as a failure and abort rather than spinning forever.
    if [ "$num" = "$prev_num" ]; then
      echo "❌ ralph.sh: no progress on issue #$num (re-selected without state change). Aborting the loop." >&2
      failures+=("$num")
      break
    fi
    failures+=("$num")
  fi

  prev_num="$num"
done

echo "==> Cleanup"
git checkout dev 2>/dev/null || true
git pull --ff-only 2>/dev/null || true
git branch --merged dev 2>/dev/null | grep -E '^\s+issue-' | xargs -r git branch -d 2>/dev/null || true

# --- End-of-run notifications ---------------------------------------------
ELAPSED=$(( $(date +%s) - START ))
duration_min=$(( ELAPSED / 60 ))
ok_count=${#successes[@]}
fail_count=${#failures[@]}
ok_list=$( [ "$ok_count" -gt 0 ] && printf '#%s ' "${successes[@]}" || echo "-" )
fail_list=$( [ "$fail_count" -gt 0 ] && printf '#%s ' "${failures[@]}" || echo "-" )
msg="Ralph finished: ${ok_count} ok, ${fail_count} failed, ${duration_min}min. OK: ${ok_list}| FAIL: ${fail_list}"

if [ "$fail_count" -eq 0 ]; then
  status="success"
elif [ "$ok_count" -gt 0 ]; then
  status="partial"
else
  status="failed"
fi

# Stdout always — visible to anyone running `tmux attach`.
echo "$msg"

# In --once mode (called from `ralph cycle`), the parent owns notifications +
# lifetime. Skip end-of-run notify and tmux teardown.
if [ -n "$RALPH_ONCE_MODE" ]; then
  exit 0
fi

# --- Run-event telemetry (issue #531) -------------------------------------
# Normal (interactive `ralph start`) mode only. The automated path (`ralph
# cycle`) is the sole emitter for itself and runs detached, so its stdout never
# reaches logs/ralph-cycle.out.log — the file lib/heartbeat.js globs for the 24h
# rollup. Append exactly one RALPH_CYCLE_EVENT line carrying the loop's REAL
# bash-computed counts + the same run_id used by the per-issue capture, so
# interactive runs are counted too. Purely additive; same tag/file/fields the
# heartbeat already parses. Best-effort: `|| true` so it NEVER aborts the loop.
run_event_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'RALPH_CYCLE_EVENT {"ts":"%s","status":"%s","ok":%d,"failed":%d,"durationMin":%d,"processed":%d,"run_id":"%s"}\n' \
  "$run_event_ts" "$status" "$ok_count" "$fail_count" "$duration_min" "$((ok_count + fail_count))" "$RALPH_RUN_ID" \
  >> logs/ralph-cycle.out.log || true
# ---------------------------------------------------------------------------

# Re-source creds so any added mid-run are picked up: global config fills unset
# vars first (#4), then .env.local wins — same repo → process.env → global
# precedence as the startup path.
source_global_config
if [ -f ./.env.local ]; then
  set -a
  . ./.env.local
  set +a
fi

# Built-in WhatsApp via CallMeBot. Failures must not crash the loop.
if [ -n "${CALLMEBOT_KEY:-}" ] && [ -n "${WHATSAPP_PHONE:-}" ]; then
  encoded=$(jq -sRr @uri <<< "$msg") || encoded=""
  if [ -n "$encoded" ]; then
    curl -s --connect-timeout 5 \
      "https://api.callmebot.com/whatsapp.php?phone=${WHATSAPP_PHONE}&text=${encoded}&apikey=${CALLMEBOT_KEY}" \
      > /dev/null || true
    echo "==> WhatsApp notification sent."
  fi
fi

# Custom hook. Project-supplied script with full freedom over channels.
if [ -x ./ralph-notify.sh ]; then
  ./ralph-notify.sh "$msg" "$status" "$ok_count" "$fail_count" "$duration_min" || true
fi
# ---------------------------------------------------------------------------

tmux kill-session -t "${RALPH_TMUX_SESSION:-ralph}" 2>/dev/null || exit 0
