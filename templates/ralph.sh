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

# --- Session teardown, on EVERY exit (#62) ----------------------------------
# `ralph start` runs this loop as window 0 of a session it created, and since #62 it
# may open a second window in that same session running `ralph digest --loop`. That
# second window changes what an abort means: window 0 closing no longer ends the
# session, so a loop that exits early — not a git repo, an agent bridge it cannot
# resolve, a validation that produced no state — used to leave the digest narrating a
# run that never started, on a timer, against a paid model, with the session name
# still taken so the next `ralph start` refused as "already running".
#
# A TRAP rather than teardown before each `exit 1`: there are five of those today and
# the sixth one somebody adds must not have to remember this. Installed as early as it
# can be, so it covers the guards below it too — including the git-root and $HOME
# refusals, which run before anything has been read.
#
# That position has one cost, and it is the reason the whole guard reads as it does: the
# decision is taken BEFORE ralph.config.sh is sourced (`set -a` further down), so a
# session named ONLY in that config is never torn down. Ralph does not produce that
# shape — `ralph start` passes the session name in the command string it launches this
# script with, so the variable is always already set by the time we get here — and a
# hand-written config that sets it is not describing a session this process is in.
#
# Guarded on BOTH facts, and both matter. RALPH_TMUX_SESSION is only set by `ralph
# start`, so a hand-run `bash templates/ralph.sh` kills nothing it does not own. And
# `--once` (the path `ralph cycle` drives) must NEVER tear a session down: it is not
# running inside one, and a stale variable in the ambient environment would otherwise
# make an aborting cycle kill somebody else's.
if [ -z "$RALPH_ONCE_MODE" ] && [ -n "${RALPH_TMUX_SESSION:-}" ]; then
  # CAPTURED here, not re-expanded at exit: the trap body is single-quoted, so without
  # this the guard above would test one value and the kill would use whatever the
  # variable held when the shell exited. A ralph.config.sh that assigns
  # RALPH_TMUX_SESSION is sourced with `set -a` between those two moments, which would
  # make an aborting loop kill a session it has nothing to do with and leave its own —
  # digest window and all — running with the name still taken. One name, read once.
  _RALPH_TEARDOWN_SESSION="$RALPH_TMUX_SESSION"
  trap 'tmux kill-session -t "$_RALPH_TEARDOWN_SESSION" 2>/dev/null || true' EXIT
fi
# ---------------------------------------------------------------------------

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
#
# The same output may carry `export` lines for environment the chosen agent needs
# (claude's background-wait ceiling, which decides whether an orphaned subagent
# kills the whole invocation — see lib/agent-registry.js). They are emitted AHEAD
# of the assignments because the stream filter is a multi-line value that must
# stay last, and they are DEFAULTS: anything already set above wins, so
# ralph.config.sh keeps the last word. Nothing here needs to know which variables
# those are.
#
# THE BRIDGE'S STDERR IS CAPTURED AND THEN FORWARDED, on both paths (#118). The
# capture exists to keep other people's WORDS out of the program — a node
# Deprecation/Experimental notice or an nvm/shim banner on a SUCCESSFUL run would
# otherwise land in $sh and choke the eval — not to keep them from the user, and
# discarding it on success was over-collection: `rm -f` with no `cat` ate every
# sentence the bridge had. It ate a real one. The bridge now says so when
# RALPH_AGENT is mistyped and it falls back to claude, and a whole overnight run
# went to the wrong agent in silence because that line was missing. Forwarding
# restores exactly what the terminal would have shown with no capture at all.
#
# THE WHOLE STREAM, unread. This bash holds no agent-specific knowledge (see above)
# and must not acquire any to do this: no grep for a warning, no test for a prefix.
# That is why the bridge speaks in a plain stderr line rather than a structured
# field — there is nothing here to parse it with, and nothing here that should.
#
# THE PRICE, accepted deliberately: those deprecation notices and shim banners now
# reach the terminal on every loop start, where they used to vanish. That is what
# stderr is for, and swallowing a child's diagnostics to keep a start-up quiet is
# the bug being fixed here, not a feature to restore. Do not put either `rm` back
# without its `cat`.
#
# TWICE IN THE SOURCE, ONCE PER RUN, and not hoisted. The two branches are mutually
# exclusive — the failing one ends in `exit 1` — so the duplicated `cat` forwards
# exactly once either way. There is nowhere to hoist it TO: above the `if` it would
# read a file the redirect has not filled yet, and below it, it would never run on
# the path that exits.
resolve_agent_invocation() {
  local sh _err
  # Fail fast: bash has no agent defaults to fall back to. If the node bridge
  # fails or yields nothing, abort loudly rather than silently guessing.
  # Capture stderr to a temp file so stdout stays PRISTINE for eval: a node
  # Deprecation/Experimental warning (or nvm/shim banner) on a SUCCESSFUL run
  # must never be folded into $sh, or eval would choke on the warning line. Then
  # forwarded to our own stderr, on BOTH paths — see the header above for why, and
  # why the two `cat`s stay where they are rather than being hoisted above the `if`.
  _err="$(mktemp)"
  if ! sh="$(node "$RALPH_PKG_DIR/lib/agent-invocation.js" 2>"$_err")" || [ -z "$sh" ]; then
    echo "ralph.sh: failed to resolve agent invocation from lib/agent-invocation.js. Aborting." >&2
    cat "$_err" >&2
    rm -f "$_err"
    exit 1
  fi
  cat "$_err" >&2
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
# Iteration index for the run-state record (#55) — the loop had no counter of its
# own, and "which pass are we on?" is what makes a stuck run legible from outside.
iter=0

SEARCH_QUERY='state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge'

# --- Task source dispatch (#565, #127) --------------------------------------
# Ralph draws work from GitHub issues (the default, unchanged), a local
# `.ralph/tasks/` folder tree (TASK_SOURCE=folder), or a Jira project
# (TASK_SOURCE=jira, #127). The source is read from the env sourced from
# ralph.config.sh. Any value other than an EXACT `folder` or `jira` resolves to
# github — unset and unknown both take that zero-regression path. The github
# branch of every helper below is byte-for-byte the code the loop has always run.
#
# THIS COMPARE IS EXACT AND lib/task-source.js's resolveSource IS NOT: that one
# trims and lowercases first, so `JIRA`, `Jira` and ` folder` are recognised by
# `ralph status`, `cycle`, `doctor` and the prompt builder, and NOT here. This
# comment used to claim the two mirror each other; they do not. The divergence
# predates the jira arm (`FOLDER` has had it since #565) and is left for a slice
# that fixes both values at once — it is pinned, with the per-site cost, in
# test/loop.jira.adversarial.test.js.
#
# BASH HOLDS NO JIRA KNOWLEDGE OF ITS OWN: no JQL, no `acli`, no label name, not
# even the key grammar. lib/jira-queue.js owns all of it and is shelled out to,
# exactly as folder mode shells out to lib/folder-queue.js — which is what keeps
# the query composition (lib/jira-jql.js) testable in one place instead of being
# half-written in a shell string nothing can unit-test.
if [ "${TASK_SOURCE:-github}" = "folder" ]; then
  TASK_SOURCE="folder"
elif [ "${TASK_SOURCE:-github}" = "jira" ]; then
  TASK_SOURCE="jira"
else
  TASK_SOURCE="github"
fi
TASKS_ROOT="$PROJECT_ROOT/.ralph/tasks"

# Number of items waiting in the queue.
queue_count() {
  if [ "$TASK_SOURCE" = "jira" ]; then
    # An UNSET JIRA_JQL counts 0 and spawns no acli: lib/jira-jql.js refuses an
    # empty eligibility clause (Ralph's half of the query alone would select every
    # work item on the Jira site), and the CLI exits non-zero without printing, so
    # `|| echo 0` is what the loop reads. An unconfigured Jira source is an empty
    # queue, never somebody else's board.
    node "$RALPH_PKG_DIR/lib/jira-queue.js" count "${JIRA_JQL:-}" 2>/dev/null || echo 0
  elif [ "$TASK_SOURCE" = "folder" ]; then
    node "$RALPH_PKG_DIR/lib/folder-queue.js" count "$TASKS_ROOT" 2>/dev/null || echo 0
  else
    gh issue list --search "$SEARCH_QUERY" --limit 100 --json number -q '. | length'
  fi
}

# --- Run state (#55) --------------------------------------------------------
# Record this run in .ralph/run-state.json so a DETACHED run is observable from
# outside the tmux pane — `ralph status` reads that file. lib/run-state.js owns
# the record's whole shape; bash only passes values it already has.
#
# Placed HERE rather than beside RALPH_RUN_ID above because the queue depth at
# start needs queue_count(), defined just above. That costs one extra count call
# per run (cheap: the loop already counts once per iteration) and buys a record
# that says how much work the run started with.
#
# Best-effort, exactly like the telemetry sidecar further down: `|| true` so an
# unwritable .ralph/ can never change the run's outcome. Same for every other
# run-state call in this file.
node "$RALPH_PKG_DIR/lib/run-state.js" begin \
  "$PROJECT_ROOT" \
  "$RALPH_RUN_ID" \
  "${RALPH_TMUX_SESSION:-ralph}" \
  "$TASK_SOURCE" \
  "$(queue_count)" || true
# ---------------------------------------------------------------------------

# --- Stale `claude-working` sweep (#40) -------------------------------------
# A merged PR that closes its issue (`Closes #N`) runs neither of the agent's
# label-removal paths, so `claude-working` survives on an issue this loop counts
# as a SUCCESS — and if that issue is ever reopened it is silently dropped from
# the queue (`-label:claude-working`).
#
# Called ONLY from the outcome branches that leave the issue in a terminal
# exclusion state (closed, pending-merge, claude-failed), never from the
# zero-progress branch: there the sticky label is what keeps a stuck issue out
# of the queue, and clearing it would make the loop re-select the same issue and
# `break` on the re-selection guard, abandoning everything still queued — so
# that residue is left to the cycle-level sweep in `lib/orphan-cleanup.js`.
#
# No "does it have the label?" pre-check: gh no-ops on an absent label.
clear_working_label() {
  gh issue edit "$1" --remove-label claude-working >/dev/null 2>&1 || true
}
# ---------------------------------------------------------------------------

# Track the previously-selected issue so we can detect a zero-progress spin:
# if the same issue is re-selected without any exclusion-state changing
# (claude crashed, no label applied, not closed), the queue can never drain
# and the loop would burn API calls forever. We break out instead.
prev_num=""

# The in-flight task's Jira key (#127) — `FOO-123`, and empty for every other
# source. Declared HERE, outside the loop, because `set -u` is on and the ONE
# shared `begin-task` call below passes it for all three sources; only the jira
# arm ever assigns it.
task_key=""

while :; do
  count=$(queue_count)
  if [ "$count" = "0" ]; then
    echo "Queue empty, exiting."
    break
  fi

  if [ "$TASK_SOURCE" = "jira" ]; then
    # Jira mode (#127): select the oldest eligible ticket (key + summary, tab
    # separated — the same shape folder mode's `pick` prints, cut the same way, so
    # a summary full of spaces can never be read as part of the key).
    #
    # THE ITERATION LINE NAMES THE TICKET, not a number: `FOO-123` is what a reader
    # can look up on the board, and the numeric handle in the run record is derived
    # from it for the readers that predate Jira (lib/jira-key.js explains why).
    # The `[agent: ...]` suffix matches the two arms below now that #128 actually
    # invokes an agent for a Jira ticket: the name is what a reader greps for when
    # the per-ticket log looks wrong, and it was omitted only while the promise
    # would have been false.
    pick=$(node "$RALPH_PKG_DIR/lib/jira-queue.js" pick "${JIRA_JQL:-}" 2>/dev/null)
    task_key="${pick%%$'\t'*}"
    if [ -z "$task_key" ]; then
      # The count said there was work and the pick found none: a ticket claimed by
      # somebody else between the two calls, or an acli that stopped answering.
      # Either way there is nothing to work on, which is the same finding as an
      # empty queue.
      echo "Queue empty, exiting."
      break
    fi
    # No numeric handle from bash: lib/run-state.js derives one from the key, and
    # `''` is the record's documented "unknown" for every value bash cannot supply.
    num=""
    echo "==> Iteration for $task_key ($count remaining) [agent: ${RALPH_RESOLVED_AGENT:-claude}]"
  elif [ "$TASK_SOURCE" = "folder" ]; then
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

  # Run state (#55): the in-flight task, updated at the top of every iteration so
  # `ralph status` can say what Ralph is on and for how long. ONE call for ALL
  # THREE task sources — $num and $task_key are set by the branches above, and
  # each source leaves empty the one it does not have — and best-effort like the
  # `begin` call.
  iter=$((iter + 1))
  node "$RALPH_PKG_DIR/lib/run-state.js" begin-task "$PROJECT_ROOT" "$num" "$iter" "$task_key" || true

  if [ "$TASK_SOURCE" = "jira" ]; then
    # CLAIM THE TICKET, hand it to the agent, then sweep it if it did not finish
    # (#127 selection + claim, #128 the dispatch, #130 the sweep). The block still
    # returns to the top of the loop rather than falling through: NONE of the outcome
    # handling below applies to a Jira ticket, because it is written against gh (PR
    # merge state, `claude-working`/`claude-failed` labels, `Closes #N`).
    #
    # THE TWO HALVES OF JIRA'S BOOKKEEPING BELONG TO DIFFERENT PROCESSES, and that is
    # the shape of this arm. The SUCCESS half is the AGENT's: #129 gave it a `done`
    # label, a comment carrying the commit SHA, and — only where JIRA_DONE_STATUS
    # names a status this project's workflow accepts — a transition, and the agent
    # makes all three itself as step 7 of prompt-team-jira.md, calling
    # `lib/jira-queue.js complete` and `comment`. It is the agent's job because only
    # the agent knows whether the work landed and what SHA it landed as. The FAILURE
    # half has to be THIS FILE's for the mirror-image reason (#130): the invocation
    # that most needs sweeping is the one that DIED, and a dead agent writes nothing.
    # See the outcome branch below the dispatch.
    #
    # What is still missing is per-ticket telemetry (#131): no RALPH_ISSUE_EVENT line
    # is appended under this source, which is why nothing here reads `claude_failed`
    # even now that the outcome is known.
    #
    # The claim adds the `in-progress` label, which is the label the composed query
    # EXCLUDES (lib/jira-jql.js), so a claimed ticket drops out of the next count
    # and the queue drains. lib/jira-queue.js does it as read-then-union so a
    # team's own labels survive it, and passes `--yes` so an unattended run is
    # never blocked on a confirmation prompt.
    #
    # A FAILED CLAIM WARNS AND CARRIES ON, like every other best-effort call in this
    # file: the ticket stays eligible, and the guard below is what stops the loop
    # from handing it out forever. Aborting the run instead would let one
    # unwritable ticket take a whole scheduled cycle down with it. stderr is NOT
    # suppressed here — the CLI's own sentence names the ticket and what acli said,
    # and that line is the only record of why the board never changed.
    if ! node "$RALPH_PKG_DIR/lib/jira-queue.js" claim "$task_key"; then
      echo "⚠️  Could not claim $task_key. Leaving it eligible and moving on." >&2
    fi

    # ZERO-PROGRESS GUARD, and it runs BEFORE the dispatch below rather than after it,
    # which is the one way this arm's guard differs from the two further down. Same
    # premise as theirs: a successful claim removes the ticket from the query, so
    # re-selecting the SAME key means the board did not change (the claim failed, or
    # Jira has not caught up) and the queue can never drain. `prev_num` carries the key
    # in this mode — one variable, since a run works one source.
    #
    # THE ORDER IS THE POINT, and #128 is what made it matter: the thing this guard now
    # stands in front of is a PAID model call. With the guard after the dispatch, an
    # unwritable claim bought two full agent invocations on one ticket before the loop
    # noticed nothing had moved — the second one on a ticket whose state was identical
    # to the first's, so it could only produce the same result at the same price. The
    # other two arms have nothing to save by moving theirs: folder sweeps the task out
    # of `afk/todo` and github relabels the issue, so a re-selection there means the
    # WRITE failed and the iteration is worth attempting; jira's re-selection means the
    # ticket was never claimed at all, and the agent would be told to work a ticket the
    # board still shows as open to anyone.
    if [ "$task_key" = "$prev_num" ]; then
      echo "❌ ralph.sh: no progress on $task_key (re-selected). Aborting the loop." >&2
      break
    fi
    prev_num="$task_key"

    # WORK THE TICKET (#128). The key is the ENTIRE handoff: bash passes no summary,
    # no description and no labels, and lib/build-prompt.js reads RALPH_TASK_KEY into
    # the {{RALPH_TASK_KEY}} placeholder of prompt-team-jira.md, which then tells the
    # agent to fetch its own work item — the same shape as github mode, where the
    # agent runs its own issue read. So this export IS the dispatch contract: drop it
    # and the rendered prompt names an empty ticket and the agent has nothing to work.
    # THE KEY, VERBATIM: build-prompt.js runs it through the same `usableJiraKey` that
    # produced it (lib/jira-key.js), so tidying it here would only give the two ends
    # two chances to disagree.
    export RALPH_TASK_KEY="$task_key"

    # A FILESYSTEM-SAFE HANDLE FOR THE LOG PATHS, and ONLY for those. `$task_key` comes
    # out of acli's own JSON and `usableJiraKey` deliberately passes through a key its
    # grammar does not recognise (Jira names its own tickets), so a `/` in it reached
    # `run_agent_for_issue` and named `logs/ralph-issue-FOO/1.log` — a directory that
    # does not exist. This file runs under `set -u` ONLY, no `set -e`, so the failed
    # redirection stopped nothing: the agent was still spawned and still billed, and the
    # transcript that would explain what it did went nowhere, leaving bash's own
    # redirection error as the only clue. Every character outside `[A-Za-z0-9._-]`
    # becomes `_`, which is a no-op for `FOO-123` — the ordinary case keeps the exact
    # path `logs/ralph-issue-FOO-123.log` that the prompt quotes and that the tests pin.
    #
    # THE HANDLE IS NOT THE KEY and is used nowhere else: not in the acli argv, not in
    # the export above, not in the iteration line, not in the run record. A ticket is
    # named by its key on every surface a human or the board reads; this is a filename.
    #
    # NOT $num, either. $num is deliberately empty in this mode (see the selection arm),
    # so passing it would collapse every ticket onto `logs/ralph-issue-.log`. One log
    # per task, no per-role logs — the same rule the other two sources follow.
    task_log_handle="${task_key//[^A-Za-z0-9._-]/_}"
    run_agent_for_issue "$task_log_handle"

    # THE OUTCOME, READ OFF THE BOARD (#130) — jira mode's forward-progress guarantee,
    # and the structural twin of the folder arm's sweep below.
    #
    # THE BOARD DECIDES, NOT THE EXIT CODE, and this sweep is deliberately
    # unconditional on `claude_failed`: an agent killed after committing did the work
    # and labelled the ticket `done`, while an agent that exited 0 having done nothing
    # did not, so the exit code is the one thing here that cannot answer the question.
    # `locate` asks acli what labels the ticket carries now and prints one word;
    # `unknown` is what it prints when the ticket could not be read at all, and
    # `${outcome:-unknown}` covers the narrower case of a node that printed nothing.
    # Either way the comparison is the same: anything that is not `done` gets swept.
    #
    # A LABEL IS WHY THIS IS A GUARANTEE. Folder mode can promise the queue drains
    # because bash can always `mv` a file; here bash can always write a LABEL — Jira
    # labels are freeform text no workflow rule can veto, needing no transition and no
    # status this file would have to guess. `failed` is excluded by the composed query
    # (lib/jira-jql.js), so the swept ticket is out of the next count and the queue
    # drains even when the agent recorded nothing at all.
    #
    # THE TWO CALLS ARE REDIRECTED DIFFERENTLY, and each on its own merits. `locate`
    # drops stderr because its whole answer is the word on STDOUT and it writes no
    # sentence of its own — an unreadable ticket is reported as `unknown`, not as
    # prose — so `2>/dev/null` there can only hide a node that crashed, which the
    # empty capture already says. THE SWEEP'S STDERR IS KEPT, unlike the folder arm's
    # `mv`: `fail` does write a sentence, naming the ticket and what acli said, and
    # that line is the only record of why the board never changed. `|| true` all the
    # same — a sweep Ralph could not write is still not a reason to abort the run, and
    # the guard above is what stops the loop from handing the ticket out forever.
    outcome=$(node "$RALPH_PKG_DIR/lib/jira-queue.js" locate "$task_key" 2>/dev/null)
    if [ "$outcome" != "done" ]; then
      echo "⚠️  $task_key was not completed (state: ${outcome:-unknown}). Labelling it failed." >&2
      node "$RALPH_PKG_DIR/lib/jira-queue.js" fail "$task_key" >/dev/null || true
      outcome="failed"
    fi

    # The end-of-run summary counts TICKETS BY KEY here — `successes`/`failures` hold
    # whatever the source names its work, and in this mode that is `FOO-123` rather
    # than a number, which is also how the iteration line and the run record name it.
    #
    # A SECOND `if` ON A VARIABLE THAT NOW HOLDS ONE OF TWO WORDS, and it is the folder
    # arm's shape rather than a second test: after the block above, `outcome` is
    # provably `done` or `failed`, so this can only take the branch already decided.
    # The folder arm below writes it exactly this way because its per-task TELEMETRY
    # block sits in the gap between the two, reading `$outcome` — which is where #131
    # will put this arm's, so the split stays where the twin keeps it.
    if [ "$outcome" = "done" ]; then
      successes+=("$task_key")
    else
      failures+=("$task_key")
    fi
    continue
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

  # Classify from what the AGENT left behind: $labels/$state were read ABOVE, so
  # neither this nor the telemetry capture can observe our own label edits. The
  # terminal-exclusion branches also call clear_working_label (see its header).
  if echo ",$labels," | grep -q ",claude-failed,"; then
    clear_working_label "$num"
    failures+=("$num")
  elif [ "$state" = "CLOSED" ] || echo ",$labels," | grep -q ",pending-merge,"; then
    clear_working_label "$num"
    successes+=("$num")
  else
    # No exclusion label and still open. If claude failed (non-zero exit) mark
    # the issue claude-failed so the queue advances on the next iteration.
    if [ "$claude_failed" = "1" ]; then
      echo "⚠️  claude failed on issue #$num (non-zero exit). Marking claude-failed." >&2
      gh issue edit "$num" --add-label claude-failed >/dev/null 2>&1 || true
      # claude-failed now excludes the issue, so claude-working is stale.
      clear_working_label "$num"
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

# Run state (#55): the terminal record — the loop's OWN counts and status, so a
# finished run stops reading as in flight.
#
# Deliberately ABOVE the `--once` early exit below, unlike the RALPH_CYCLE_EVENT
# append further down: `ralph cycle` drives this exact path, and a cycle whose run
# record never terminates would leave every scheduled run looking like it is still
# working. The cycle event stays below the exit because `ralph cycle` emits its
# own; a run record has no such second emitter. Best-effort as ever.
node "$RALPH_PKG_DIR/lib/run-state.js" end \
  "$PROJECT_ROOT" "$status" "$ok_count" "$fail_count" || true

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

# Session teardown is the EXIT trap installed at the top of this file (#62) — one
# site, so the normal end of a run and every abort in between cannot disagree about
# it. This used to be an explicit `tmux kill-session` here, which is why nothing but
# the happy path took the session down.
exit 0
