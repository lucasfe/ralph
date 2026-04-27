#!/bin/bash
# Ralph loop — resolve open GitHub issues one at a time, fully autonomously.
# Invoked by start-ralph.sh inside a tmux session. Don't run directly.

set -u

cd "$(dirname "$0")"

if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi

mkdir -p logs

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

  cat PROMPT.md | claude -p --dangerously-skip-permissions \
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

ELAPSED=$(( $(date +%s) - START ))
mins=$(( ELAPSED / 60 ))
ok_list=$( [ ${#successes[@]} -gt 0 ] && printf '#%s ' "${successes[@]}" || echo "-" )
fail_list=$( [ ${#failures[@]} -gt 0 ] && printf '#%s ' "${failures[@]}" || echo "-" )
msg="Ralph finalizado: ${#successes[@]} ok, ${#failures[@]} falharam, ${mins}min. OK: ${ok_list}| FAIL: ${fail_list}"
echo "$msg"

if [ -n "${CALLMEBOT_KEY:-}" ] && [ -n "${WHATSAPP_PHONE:-}" ]; then
  encoded=$(jq -sRr @uri <<< "$msg")
  curl -s "https://api.callmebot.com/whatsapp.php?phone=${WHATSAPP_PHONE}&text=${encoded}&apikey=${CALLMEBOT_KEY}" > /dev/null || true
  echo "==> Notificação WhatsApp enviada."
else
  echo "==> CALLMEBOT_KEY/WHATSAPP_PHONE ausentes; pulando notificação."
fi

tmux kill-session -t ralph 2>/dev/null || exit 0
