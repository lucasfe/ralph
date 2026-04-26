#!/bin/bash
# Wrapper para disparar o Ralph loop em uma sessão tmux detached.
# Faz sanity checks, cria labels, oferece cleanup de issues órfãs e dispara ralph.sh.

set -euo pipefail

cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

# 1. Sessão tmux única
if tmux has-session -t ralph 2>/dev/null; then
  echo "❌ Sessão tmux 'ralph' já existe."
  echo "   Ver:    tmux attach -t ralph"
  echo "   Matar:  tmux kill-session -t ralph"
  exit 1
fi

# 2. CLIs obrigatórios
for cmd in tmux jq gh claude curl npm git; do
  command -v "$cmd" >/dev/null || { echo "❌ '$cmd' não encontrado no PATH"; exit 1; }
done

# 3. .env.local com credenciais do WhatsApp
if [ ! -f .env.local ]; then
  echo "❌ .env.local não encontrado. Adicione CALLMEBOT_KEY e WHATSAPP_PHONE."
  exit 1
fi
set -a
. ./.env.local
set +a
if [ -z "${CALLMEBOT_KEY:-}" ] || [ -z "${WHATSAPP_PHONE:-}" ]; then
  echo "❌ CALLMEBOT_KEY ou WHATSAPP_PHONE não definidos em .env.local"
  exit 1
fi

# 4. gh autenticado
gh auth status >/dev/null 2>&1 || { echo "❌ gh não autenticado. Rode 'gh auth login'."; exit 1; }

# 5. .mcp.json válido
if [ -f .mcp.json ]; then
  jq -e . .mcp.json >/dev/null 2>&1 || { echo "❌ .mcp.json com JSON inválido"; exit 1; }
  servers=$(jq -r '.mcpServers | keys | join(", ")' .mcp.json)
  echo "ℹ️  MCP servers configurados: $servers"
  echo "   Se a auth de algum MCP expirou, rode 'claude' interativamente uma vez antes pra re-autenticar."
fi

# 6. Cria labels (idempotente)
gh label create claude-working --color FFA500 --description "Ralph loop em andamento" 2>/dev/null || true
gh label create claude-failed  --color B60205 --description "Ralph loop tentou e desistiu" 2>/dev/null || true

# 7. Cleanup de issues órfãs com 'claude-working' (de runs interrompidas)
orphaned=$(gh issue list --state open --label claude-working --json number,title -q '.[] | "  #\(.number) \(.title)"' || true)
if [ -n "$orphaned" ]; then
  echo "⚠️  Issues com label 'claude-working' (provavelmente de run anterior interrompida):"
  echo "$orphaned"
  read -r -p "Remover label e reprocessar? [y/N] " confirm
  if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
    gh issue list --state open --label claude-working --json number -q '.[].number' | \
      xargs -I{} gh issue edit {} --remove-label claude-working
    echo "✅ Labels removidas."
  else
    echo "ℹ️  Mantendo labels. Essas issues serão puladas no próximo run."
  fi
fi

# 8. Verifica se há issue para processar
count=$(gh issue list --state open --label '-claude-working' --label '-claude-failed' --json number -q '. | length')
if [ "$count" = "0" ]; then
  echo "ℹ️  Nenhuma issue na fila. Nada a fazer."
  exit 0
fi

# 9. Dispara em tmux detached
tmux new -d -s ralph "cd '$PROJECT_DIR' && ./ralph.sh"
echo "✅ Ralph iniciado em background. $count issues na fila."
echo "   Ver ao vivo:    tmux attach -t ralph"
echo "   Detach:         dentro da sessão, Ctrl+B depois D"
echo "   Listar:         tmux ls"
echo "   Matar:          tmux kill-session -t ralph"
echo "   Logs:           logs/ralph-issue-*.log"
