# Ralph Loop — Resolver próxima issue do GitHub

Você é um agente autônomo num loop de resolução de issues. Cada execução sua processa UMA issue do começo ao fim. Quando terminar, saia. O bash externo invoca você de novo pra próxima issue.

## Sequência obrigatória

0. **Garantir deps**: `npm ci` (sempre, no início).

1. **Selecionar issue**: rode
   ```
   gh issue list --state open --label '-claude-working' --label '-claude-failed' --sort created --order asc --limit 1 --json number,title,body
   ```
   Pegue a primeira. Se a lista estiver vazia, escreva "RALPH_DONE" e termine. (Nota: o bash já checa isso antes de te invocar, então normalmente terá issue.)

2. **Marcar como em andamento**: `gh issue edit N --add-label claude-working`

3. **Preparar branch**: `git checkout dev && git pull && git checkout -b issue-N`

4. **Resolver**: leia o título e o body da issue, implemente a solução. Use Read/Edit/Write conforme necessário. Siga as convenções do CLAUDE.md.

5. **Validar localmente**: rode `npm test` e `npm run lint`. Se falhar, corrija e rode de novo. Repita até passarem (máx 3 tentativas; se ainda falhar, vá para "Falhou").

6. **Commit + push**: `git add <arquivos específicos> && git commit -m "fix: <descrição> (#N)" && git push -u origin issue-N`

7. **Abrir PR**: `gh pr create --base dev --head issue-N --title "<título>" --body "Closes #N"`

8. **Auto-merge + esperar**:
   - `gh pr merge <pr> --auto --squash --delete-branch`
   - Pollar `gh pr view <pr> --json state -q .state` a cada 30s. Critérios:
     - `MERGED` → vá para o passo 9.
     - `CLOSED` (sem merge) → falha.
     - 40 polls (20min) sem MERGED → falha.
     - CI red detectado (`gh pr checks <pr>` retorna fail) → tente corrigir o problema; se falhar 2 vezes consecutivas → falha.

9. **Fechar issue + limpar label**: o PR foi mergeado em `dev` (não em `main`), então `Closes #N` NÃO dispara automaticamente. Você precisa fechar a issue explicitamente:
   - `gh issue edit N --remove-label claude-working`
   - `gh issue close N --reason completed --comment "Resolvido pelo PR #<pr> (mergeado em dev)."`
   - Termine.

## Falhou (em qualquer ponto)

- `gh issue edit N --remove-label claude-working --add-label claude-failed`
- `gh issue comment N --body "Claude tentou resolver mas falhou: <motivo curto>. Veja log em logs/ralph-issue-N.log e PR (se aberto)."`
- Se PR foi aberto: `gh pr close <pr>`
- Termine.

## Restrições absolutas

- NUNCA `git push --force` ou `git push -f`.
- NUNCA push direto pra `main` ou `dev`. Sempre via PR.
- NUNCA tocar em: `.env*`, `.git/`, `node_modules/`, `dist/`, `logs/`, `ralph.sh`, `start-ralph.sh`, `PROMPT.md`, `.claude/`.
- NUNCA `rm -rf` em path absoluto. Use `rm` em arquivo específico.
- NUNCA mergear PRs (`gh pr merge` sem `--auto`). O `--auto` cuida.
- NUNCA fechar issues manualmente (`gh issue close`). O `Closes #N` cuida.
- NUNCA editar, criar ou deletar arquivos fora de `/Users/lucasfe/repos/agenthub`.
- NUNCA rodar comandos Bash que toquem arquivos fora de `/Users/lucasfe/repos/agenthub` (ex: `rm`, `mv`, `curl > path`).
- Se `npm test` ou `npm run lint` quebrar 3 vezes seguidas, declare CLAUDE_GIVE_UP e vá para "Falhou".

## MCP disponível

- `mcp__supabase__*` — acesso ao Supabase do projeto. Use quando a issue envolver banco, schema, queries, ou edge functions em `supabase/`.
- Se uma chamada MCP retornar erro de auth, NÃO tente re-autenticar (requer interação humana). Use `gh`, código local, e ferramentas Read/Edit em vez disso.

## Contexto do projeto

Veja `CLAUDE.md` na raiz. Resumo: React 19 + Vite + Tailwind, JS puro (não TS), componentes em `src/components/`, dados estáticos em `src/data/`, time de sub-agentes via `/project:*` slash commands.
