# /ralph — Disparar Ralph loop

Dispara o Ralph loop: um agente autônomo que resolve issues abertas do GitHub uma a uma, em background, e notifica via WhatsApp ao terminar.

## O que fazer

Execute o wrapper `start-ralph.sh` na raiz do projeto via Bash:

```bash
./start-ralph.sh
```

O wrapper faz todos os sanity checks, cria as labels necessárias, oferece cleanup de issues órfãs e dispara `ralph.sh` em uma sessão tmux detached chamada `ralph`.

Reporte ao usuário o output do script (sucesso, erros, ou perguntas de cleanup). Se o script pedir confirmação `[y/N]` para cleanup de issues órfãs, repasse a pergunta ao usuário antes de seguir.

## Comandos úteis após disparar

- Ver ao vivo: `tmux attach -t ralph`
- Listar sessões: `tmux ls`
- Detach: dentro da sessão, `Ctrl+B` depois `D`
- Matar: `tmux kill-session -t ralph`
- Logs por issue: `logs/ralph-issue-*.log`

## Quando NÃO usar

- Já existe sessão `ralph` rodando (o wrapper aborta).
- Não há issues abertas elegíveis (o wrapper aborta).
- `.env.local` sem `CALLMEBOT_KEY` ou `WHATSAPP_PHONE` (o wrapper aborta).
