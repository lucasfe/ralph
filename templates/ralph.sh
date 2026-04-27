#!/bin/bash
# Ralph loop — resolve open GitHub issues one at a time, fully autonomously.
# Invoked by `ralph start` inside a tmux session. Don't run directly.

set -u

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

# Source ralph.config.sh first so commands/branches/merge config become env
# vars visible to the prompt builder. Then source .env.local for credentials.
if [ -f ralph.config.sh ]; then
  set -a
  . ./ralph.config.sh
  set +a
fi

if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi

mkdir -p logs

# --- Lazy config validation -------------------------------------------------
# Run a one-shot Claude validation before the main loop when:
#   • .ralph/state.json is absent, OR
#   • the sha256 of ralph.config.sh changed since last validation, OR
#   • the installed @lucasfe/ralph version changed since last validation.
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
    if [ "$current_hash" != "$stored_hash" ] || [ "$RALPH_VERSION" != "$stored_version" ]; then
      needs_validate="yes"
    fi
  fi

  if [ "$needs_validate" = "yes" ]; then
    echo "==> Validando ralph.config.sh contra os manifestos do projeto..."
    node "$RALPH_PKG_DIR/lib/build-validate-prompt.js" | claude -p --dangerously-skip-permissions \
      --output-format stream-json --verbose --include-partial-messages 2>&1 \
      | jq -r --unbuffered '
          if .type == "assistant" then
            (.message.content[]? | select(.type=="text").text // empty)
          elif .type == "user" then
            (.message.content[]? | select(.type=="tool_result") | "  ↳ tool_result")
          elif .type == "result" then
            "==> result: " + (.subtype // "ok")
          else empty end' \
      | tee "logs/ralph-validate.log"

    if [ ! -f .ralph/state.json ]; then
      echo "❌ Validação não produziu .ralph/state.json. Abortando." >&2
      exit 1
    fi

    if ! node "$RALPH_PKG_DIR/lib/finalize-state.js"; then
      echo "❌ Falha ao finalizar .ralph/state.json. Abortando." >&2
      exit 1
    fi

    # Re-source the config in case Claude edited it during validation.
    set -a
    . ./ralph.config.sh
    set +a
    echo "==> Validação concluída."
  fi
fi
# ---------------------------------------------------------------------------

START=$(date +%s)
successes=()
failures=()

SEARCH_QUERY='state:open -label:claude-working -label:claude-failed -label:do-not-ralph'

while :; do
  count=$(gh issue list --search "$SEARCH_QUERY" --limit 100 --json number -q '. | length')
  if [ "$count" = "0" ]; then
    echo "Fila vazia, encerrando."
    break
  fi

  num=$(gh issue list --search "$SEARCH_QUERY sort:created-asc" --limit 1 --json number -q '.[0].number')
  echo "==> Iteração para issue #$num ($count restantes)"

  node "$RALPH_PKG_DIR/lib/build-prompt.js" | claude -p --dangerously-skip-permissions \
    --output-format stream-json --verbose --include-partial-messages 2>&1 \
    | jq -r --unbuffered '
        if .type == "assistant" then
          (.message.content[]? | select(.type=="text").text // empty)
        elif .type == "user" then
          (.message.content[]? | select(.type=="tool_result") | "  ↳ tool_result")
        elif .type == "result" then
          "==> result: " + (.subtype // "ok")
        else empty end' \
    | tee "logs/ralph-issue-$num.log"

  labels=$(gh issue view "$num" --json labels -q '[.labels[].name] | join(",")')
  state=$(gh issue view "$num" --json state -q '.state')
  if echo ",$labels," | grep -q ",claude-failed,"; then
    failures+=("$num")
  elif [ "$state" = "CLOSED" ]; then
    successes+=("$num")
  else
    failures+=("$num")
  fi
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
msg="Ralph finalizado: ${ok_count} ok, ${fail_count} falharam, ${duration_min}min. OK: ${ok_list}| FAIL: ${fail_list}"

if [ "$fail_count" -eq 0 ]; then
  status="success"
elif [ "$ok_count" -gt 0 ]; then
  status="partial"
else
  status="failed"
fi

# Stdout always — visible to anyone running `tmux attach`.
echo "$msg"

# Re-source .env.local so credentials added mid-run are picked up.
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
    echo "==> Notificação WhatsApp enviada."
  fi
fi

# Custom hook. Project-supplied script with full freedom over channels.
if [ -x ./ralph-notify.sh ]; then
  ./ralph-notify.sh "$msg" "$status" "$ok_count" "$fail_count" "$duration_min" || true
fi
# ---------------------------------------------------------------------------

tmux kill-session -t ralph 2>/dev/null || exit 0
