# Comunicação de features (`/comunicacao`)

## Objetivo

Ajudar as PMs a comunicar features internamente. A PM roda `/comunicacao <link do ClickUp>` na DM com o app. O agente lê a task e o código dos repositórios e propõe um copy no formato padrão. A PM itera dando feedback na thread e aprova uma versão, que é publicada no espaço de novidades.

Público: times internos (CS, vendas, ops). O agente não altera código, ClickUp nem GitHub.

## Decisões

- **Execução fora da fila de diagnóstico**, em um runner próprio (`dist/communication-runner.js`) disparado como processo filho, no padrão do `impact/`.
- **ClickUp via API REST** (adapter `clickup-api.ts`). Nada de MCP.
- **Skill `driva-communication`** guarda o método e o estilo. O prompt `communication-prompt.md` guarda só o contrato de entrada e saída.
- **Modelo:** `COMMUNICATION_CODEX_MODEL`, com fallback para `CODEX_MODEL`.
- **Token do GitHub para o Codex** (autorizado pelo dono do projeto em 2026-10-07): só neste fluxo e só quando nenhum PR foi citado na task. É um token de instalação do App com 1 hora de validade, `contents:read` e `pull_requests:read`, restrito aos repositórios do suite.
- **Screenshots** não são publicados no MVP (o upload de mídia no Chat exige autenticação de usuário). As imagens servem como contexto visual para o Codex.
- **Só o solicitante** dá feedback e aprova.

## Fluxo

1. `/comunicacao <link>`: valida o link, busca a task, cria o registro e responde "gerando…" na thread.
2. O runner coleta o contexto, roda o Codex e valida a saída. Avisa o Nest por IPC.
3. O Nest posta o card da versão N na thread, com o rascunho, as evidências, as dúvidas e o botão "Aprovar".
4. Uma mensagem do solicitante na thread vira feedback e gera a versão N+1, com o histórico de versões e feedbacks como contexto.
5. "Aprovar" na versão N publica o texto no `GOOGLE_CHAT_NEWS_SPACE`, com menção real ao CS, e confirma na thread.

## Coleta de contexto (determinística, no runner)

- Task e subtasks, com a descrição em markdown.
- Comentários e respostas da task e das subtasks, no formato rico (`comment[]`), para não perder links que viraram card.
- **Tickets de melhoria:** subtasks com `task_type` `form_response` e "Tipo do Ticket = Melhoria de Produto". O CS é o `creator`, e o e-mail é resolvido pela lista de membros do workspace.
- **Imagens:** anexos e imagens inline (`clickup-attachments`) da task e das subtasks, baixados pelo runner, no máximo 10.
- **PRs:** links `github.com/<org>/<repo>/pull/<n>` extraídos de todo o texto (com ou sem `https://`, com sufixo `#…`, deduplicados). Para cada um, o `gh` (fora do sandbox) grava em `context/` o título, o corpo, o estado, os arquivos e o diff truncado.
- **Se nenhum PR for encontrado:** o Codex recebe o token restrito em `GH_TOKEN` e procura a implementação com `gh` e `git`, guiado por todo o contexto coletado.

Falha em um item isolado (imagem, PR, token) não aborta a geração: vira aviso em `context/warnings.json` e aparece no card.

## Contrato de saída do Codex

```json
{
  "status": "READY | INSUFFICIENT_CONTEXT",
  "title": "📁 Exportar conversas para Excel (.xlsx)",
  "summary": "…",
  "changes": [{ "label": "…", "description": "…" }],
  "in_practice": "…",
  "pull_request_source": "CITED | DISCOVERED | NOT_FOUND",
  "evidence": [
    { "kind": "pull_request | commit | code", "reference": "…", "note": "…" }
  ],
  "open_questions": ["…"]
}
```

- **O texto final é renderizado pelo código:** título, resumo, "O que mudou:", "Na prática:" e, por último, "Ticket de melhoria aberto por <CS>" com o link. A linha do ticket é determinística, sem participação do modelo.
- **`evidence` e `open_questions`** aparecem só no card de rascunho.
- **`INSUFFICIENT_CONTEXT`:** o card não tem "Aprovar" e explica o que falta.
- **CS no rascunho:** o nome aparece em texto. Na publicação, entra `<users/...>`. Se a menção não puder ser resolvida, entra só o nome, e a publicação não falha por isso.

## Estado

O arquivo `state/communications.json` é escrito via `StateService.update`, e cada registro tem:

- `id`, `requester` (`user`, `displayName`), `space`, `threadName` e `task` (`id`, `customId`, `name`, `url`);
- `status`: `generating | ready | failed | published`;
- `versions[]`: `number`, `createdAt`, `feedback`, `status`, `runId`, `cardMessageName` e `artifactDir`;
- `published`: `version`, `messageName`, `publishedAt` e `publishedBy`, ou `null`.

Artefatos ficam em `results/communications/<id>/v<N>/`: `context/`, `images/`, `prompt.md`, `output.json` e `codex.log`, este já sanitizado.

## Regras

- **Concorrência:** uma geração por comunicação. Feedback recebido durante uma geração recebe "aguarde a versão N".
- **Limite global:** no máximo 2 gerações simultâneas.
- **Repositórios:** a leitura usa o lease de `state/repo-readers`.
- **Aprovação:**
  - qualquer versão `ready` pode ser aprovada;
  - a comunicação é publicada uma única vez;
  - checar e marcar acontecem no mesmo `update`;
  - se a publicação falhar, o estado volta para `ready`.
- **Boot:** uma versão em `generating` sem processo vivo vira `failed` e recebe um aviso na thread.
- **Env do Codex:** allowlist própria, sem credenciais de banco ou ClickHouse e sem token do ClickUp.

## Configuração nova

| Variável                               | Uso                                   |
| -------------------------------------- | ------------------------------------- |
| `GOOGLE_CHAT_COMMUNICATION_COMMAND_ID` | ID do slash command `/comunicacao`    |
| `GOOGLE_CHAT_NEWS_SPACE`               | Espaço de publicação (`spaces/…`)     |
| `COMMUNICATION_CODEX_MODEL`            | Opcional. Fallback para `CODEX_MODEL` |
| `COMMUNICATION_TIMEOUT_MINUTES`        | Timeout do runner. Padrão: 20         |

## Rollout

1. Spike: menção por e-mail com autenticação de app.
2. Registrar `/comunicacao` no console do Chat e apontar `GOOGLE_CHAT_NEWS_SPACE` para um espaço de teste.
3. Gerar comunicações de 2 ou 3 tasks lançadas (uma sem PR citado) e comparar com os exemplos.
4. Apontar para o espaço real de novidades.
