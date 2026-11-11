# Comunicação de features — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/comunicacao <link>` na DM gera, itera e publica a comunicação interna de uma feature.

**Architecture:** O módulo `src/communication/` cuida do Chat, do estado e da execução. O runner próprio (`communication-runner.ts`), disparado como processo filho fora da fila de diagnóstico, coleta o contexto do ClickUp e do GitHub e roda o Codex com a skill `driva-communication`. O IPC tipado avisa o Nest, que posta os cards.

**Tech Stack:** NestJS 11, TypeScript strict ESM, Vitest, Codex CLI, `gh`, ClickUp REST, Google Chat API (autenticação de app).

**Spec:** `docs/superpowers/specs/2026-10-07-feature-communication-design.md`

## Global Constraints

- Regras do `AGENTS.md`: `process.env` só em `src/config/`; escrita de estado só via `StateService.update`; `spawn` sempre com timeout; imports com `.js`; categorias como `as const`; sem comentários narrativos.
- O token do GitHub para o Codex é somente leitura (`contents:read`, `pull_requests:read`), restrito aos repositórios do suite, e só entra quando nenhum PR foi citado.
- O env do Codex de comunicação não leva credenciais de banco, ClickHouse ou ClickUp.
- Só o solicitante dá feedback e aprova. A comunicação é publicada uma única vez.
- A linha "Ticket de melhoria aberto por …" é gerada pelo código, nunca pelo modelo.

## Review Focus

1. **Link de PR sem `https://`, com `#issuecomment-…` ou repetido** → um único PR normalizado (Task 2).
2. **Dois cliques em "Aprovar" (ou aprovar outra versão depois de publicada)** → uma única publicação; o segundo clique recebe "já publicada" (Task 7).
3. **Feedback enviado por outra pessoa, ou durante uma geração** → é rejeitado com mensagem e não gera versão (Task 7).
4. **Codex devolve JSON inválido ou campos vazios** → a versão vira `failed` e a thread é avisada, sem card quebrado (Tasks 4 e 6).
5. **App reinicia no meio de uma geração** → a versão vira `failed` no boot e a thread é avisada (Task 6).

---

### Task 0: Spike da menção (descartável)

- [ ] Com o service account de produção, postar num espaço de teste em que o app está: `{"text":"teste <users/EMAIL_DO_PM>"}` via `POST https://chat.googleapis.com/v1/spaces/SPACE/messages` (scope `chat.bot`).
- [ ] Se a menção renderizar, `resolveMention` (Task 4) usa `users/<email>`. Se não renderizar, tentar `GET spaces/SPACE/members/users/<email>` e usar o `member.name` retornado. Se nada funcionar, entra só o nome.
- [ ] Registrar o resultado no PR. Nenhum código fica no repositório.

### Task 1: Configuração

**Files:** Create `src/config/communication-config.ts` e `src/config/communication-config.spec.ts`. Modify `src/config/google-chat-config.ts`, `src/config/env.ts`, `.env.example` e `README.md`.

**Produces:**

```ts
export function communicationConfigFromEnv(
  projectDir: string,
  env?: Environment,
): {
  codexModel: string | undefined; // COMMUNICATION_CODEX_MODEL || CODEX_MODEL
  timeoutMs: number; // COMMUNICATION_TIMEOUT_MINUTES (20) * 60_000
  maxConcurrent: 2;
  maxImages: 10;
  resultsDir: string; // <projectDir>/results/communications
};
export type CommunicationConfig = ReturnType<typeof communicationConfigFromEnv>;
export function communicationCodexEnvironment(
  env?: Environment,
): Record<string, string>;
// google-chat-config: communicationCommandId (GOOGLE_CHAT_COMMUNICATION_COMMAND_ID), newsSpace (GOOGLE_CHAT_NEWS_SPACE)
```

- [ ] Teste: fallback de modelo, timeout padrão e inválido. `communicationCodexEnvironment` contém `DRIVA_PROXY_API_KEY` e `CODEX_HOME`, e **não** contém `SALES_POSTGRESQL_PASSWORD`, `CLICKHOUSE_PASSWORD`, `CLICKUP_API_TOKEN` nem `GH_TOKEN`.
- [ ] Implementar: `communicationCodexEnvironment` = `pickEnv([...SYSTEM_ENVIRONMENT, 'GOROOT', ...CERTIFICATE_ENVIRONMENT, 'CODEX_CA_CERTIFICATE', 'CODEX_HOME', 'CODEX_MODEL', 'DRIVA_PROXY_API_KEY'], env)`. Exportar `pickEnv` de `env.ts` se ainda não for exportado.
- [ ] Adicionar as 4 variáveis em `.env.example`, com um comentário curto, e uma linha no README.
- [ ] `npx vitest run src/config` e commit `feat(communication): add configuration`.

### Task 2: Links de PR (função pura)

**Files:** Create `src/communication/pull-request-links.ts` e `.spec.ts`.

**Produces:** `export interface PullRequestRef { owner: string; repo: string; number: number; url: string }` e `export function extractPullRequestLinks(texts: readonly string[]): PullRequestRef[]`.

- [ ] Teste com os formatos reais vistos no ClickUp:

```ts
expect(
  extractPullRequestLinks([
    'PR: github.com/Example-org/service-17/pull/812',
    'https://github.com/Example-org/service-17/pull/812#issuecomment-123',
    '(https://github.com/Example-org/service-04/pull/45).',
    'github.com/Example-org/service-17/pulls',
  ]),
).toEqual([
  {
    owner: 'Example-org',
    repo: 'service-17',
    number: 812,
    url: 'https://github.com/Example-org/service-17/pull/812',
  },
  {
    owner: 'Example-org',
    repo: 'service-04',
    number: 45,
    url: 'https://github.com/Example-org/service-04/pull/45',
  },
]);
```

- [ ] Implementar:

```ts
const PULL_REQUEST_PATTERN =
  /(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;
export function extractPullRequestLinks(
  texts: readonly string[],
): PullRequestRef[] {
  const found = new Map<string, PullRequestRef>();
  for (const text of texts)
    for (const [, owner, repo, n] of text.matchAll(PULL_REQUEST_PATTERN)) {
      const url = `https://github.com/${owner}/${repo}/pull/${Number(n)}`;
      if (!found.has(url.toLowerCase()))
        found.set(url.toLowerCase(), { owner, repo, number: Number(n), url });
    }
  return [...found.values()];
}
```

- [ ] Rodar o teste e commitar `feat(communication): extract pull request links`.

### Task 3: Contexto do ClickUp

**Files:** Create `src/communication/clickup-context.ts` e `.spec.ts`, e `src/communication/communication.types.ts`. Modify `src/clickup/clickup-api.ts` (adicionar `fetchRichComments`, `fetchCommentReplies` e `fetchWorkspaceMembers`).

**Produces:**

```ts
export interface ImprovementTicket {
  id: string;
  customId: string | null;
  name: string;
  url: string;
  creator: { username: string; email: string | null };
}
export interface ClickUpContext {
  task: {
    id: string;
    customId: string | null;
    name: string;
    url: string;
    description: string;
  };
  subtasks: {
    id: string;
    customId: string | null;
    name: string;
    description: string;
    taskType: string | null;
  }[];
  comments: { taskId: string; author: string; date: string; text: string }[]; // texto + URLs dos blocos ricos
  improvementTickets: ImprovementTicket[];
  imageUrls: string[];
  warnings: string[];
}
// funções puras
export function richCommentText(blocks: unknown): string; // concatena text + attributes.link + bookmark/url de cada bloco
export function findImprovementTickets(
  subtasks: unknown[],
  members: unknown[],
): ImprovementTicket[];
export function collectImageUrls(
  markdown: readonly string[],
  attachments: unknown[],
): string[];
// I/O
export async function collectClickUpContext(
  config: { token: string; teamId: string; maxImages: number },
  taskId: string,
): Promise<ClickUpContext>;
```

- [ ] Testes das funções puras:
  - `richCommentText` preserva o link de um bloco que virou card: `[{text:'PR hub: '},{text:'PR fechada',attributes:{link:'https://github.com/x/y/pull/1'}}]` → contém `github.com/x/y/pull/1`.
  - `findImprovementTickets` só aceita `task_type === 'form_response'` com o custom field "Tipo do Ticket" igual a "Melhoria de Produto" (comparar pelo nome da opção resolvida via `type_config.options`). O e-mail vem do membro cujo `user.id === creator.id`; sem membro, `email: null`.
  - `collectImageUrls` pega `![](https://t….clickup-attachments.com/…)` e anexos com `mimetype` `image/*`, deduplica e corta em `maxImages`.
- [ ] Implementar o coletor:
  1. `fetchTask(?include_subtasks=true&include_markdown_description=true)`;
  2. para a task e cada subtask, `fetchRichComments` e, quando `reply_count > 0`, `fetchCommentReplies`;
  3. `fetchWorkspaceMembers` (`GET /team/{teamId}`) uma vez.

  Cada falha parcial vai para `warnings` e não lança erro.

- [ ] Rodar `npx vitest run src/communication src/clickup` e commitar `feat(communication): collect ClickUp context`.

### Task 4: Contrato, renderização, prompt e skill

**Files:** Create:

- `src/communication/communication-output.ts` e `.spec.ts`;
- `src/communication/communication-text.ts` e `.spec.ts`;
- `src/communication/fixtures/{ready,insufficient,invalid}.json`;
- `src/prompts/communication-prompt.md`;
- `repos/.codex/skills/driva-communication/SKILL.md` e `references/examples.md`.

**Produces:**

```ts
export const COMMUNICATION_STATUSES = [
  'READY',
  'INSUFFICIENT_CONTEXT',
] as const;
export const PULL_REQUEST_SOURCES = [
  'CITED',
  'DISCOVERED',
  'NOT_FOUND',
] as const;
export const EVIDENCE_KINDS = ['pull_request', 'commit', 'code'] as const;
export interface CommunicationOutput {
  status;
  title: string;
  summary: string;
  changes: { label: string; description: string }[];
  in_practice: string;
  pull_request_source;
  evidence: { kind; reference: string; note: string }[];
  open_questions: string[];
}
export function parseCommunicationOutput(raw: unknown): CommunicationOutput; // lança Error com o primeiro campo inválido
export function renderCommunicationText(
  output: CommunicationOutput,
  tickets: ImprovementTicket[],
  mention: (t: ImprovementTicket) => string,
): string;
```

- [ ] Testes:
  - `ready.json` é aceito;
  - `invalid.json` (sem `changes`) e `title` vazio lançam erro;
  - `READY` exige `changes.length >= 1`;
  - `renderCommunicationText` gera exatamente o formato do exemplo 1 da spec, com `*O que mudou:*`, uma linha `*label:* description` por item e `*Na prática:*`. Com ticket, termina em `Ticket de melhoria aberto por <mention>\n<url>`; sem ticket, a linha não aparece.
- [ ] Implementar a validação com as constantes e a renderização.
- [ ] `communication-prompt.md`:
  - **Entrada:** lista os arquivos de `context/` (`clickup.json`, `pull-requests/*.json`, `history.json`, imagens anexadas).
  - **Regras:**
    - usar a skill `$CODEX_HOME/skills/driva-communication`;
    - se `pull-requests/` estiver vazio, buscar a implementação com `gh` e `git` a partir de todo o contexto;
    - não citar pessoas;
    - não afirmar nada sem evidência;
    - aplicar o feedback mais recente de `history.json`.
  - **Saída:** apenas o JSON do contrato, igual ao de `ready.json`.
- [ ] `SKILL.md`:
  - **Público:** CS e vendas, em PT-BR, sem jargão técnico.
  - **Estrutura:** título com emoji, resumo de 1 a 3 frases, "O que mudou" com o comportamento visível (padrões, permissões, exceções) e "Na prática" com antes × agora.
  - **Método:** spec e comentários → PRs (diff) ou busca (`gh pr list --repo Example-org/<repo> --state all --search "<termos>"`, `gh pr diff`, `git log --all --grep`) → confirmar no código atual → listar em `evidence` e `open_questions`.
  - **Mapa de repositórios:** usar `$CODEX_HOME/skills/driva-debug/references/service-map.md`.
- [ ] `references/examples.md`: os 3 exemplos da conversa, sem a linha do ticket, que é do código.
- [ ] Rodar o teste e commitar `feat(communication): output contract, text rendering, prompt and skill`.

### Task 5: Token restrito do GitHub

**Files:** Modify `src/github/github-credentials.ts` e `.spec.ts`.

**Produces:** `createScopedInstallationToken(config: GitHubConfig, scope: { repositories: string[]; permissions: Record<string, 'read'> }, deps?): Promise<{ token: string; expiresAt: Date }>`, que não usa nem altera o cache do provider.

- [ ] Teste com `fetch` mockado. O POST para `/app/installations/{id}/access_tokens` leva o corpo `{"repositories":["service-17"],"permissions":{"contents":"read","pull_requests":"read"}}`, e o resultado não aparece no `getCredential()` posterior. Se `GITHUB_AUTH_MODE` não for `app`, lança `Scoped tokens require GitHub App auth`.
- [ ] Implementar reaproveitando `installationId()`/`requestJson` (extrair para que aceitem um body opcional).
- [ ] Rodar o teste e commitar `feat(github): mint scoped read-only installation tokens`.

### Task 6: Runner e execução

**Files:** Create:

- `src/communication/communication-runner.ts`;
- `src/communication/communication-run.ts` e `.spec.ts` (pipeline com deps injetadas);
- `src/communication/runner-messages.ts` e `.spec.ts`;
- `src/communication/communication-execution.service.ts` e `.spec.ts`;
- `src/communication/communication.module.ts`.

Modify `nest-cli.json` (assets: `prompts/communication-prompt.md`), `package.json` (`"communication": "node dist/communication/communication-runner.js"`) e `Dockerfile` (`COPY repos/.codex/skills/driva-communication /app/codex/skills/driva-communication`).

**Produces:**

```ts
// runner-messages.ts
export type CommunicationRunnerMessage =
  | { type: 'communication-ready'; communicationId: string; version: number }
  | { type: 'communication-failed'; communicationId: string; version: number; error: string };
export function isCommunicationRunnerMessage(v: unknown): v is CommunicationRunnerMessage;

// communication-run.ts
export interface CommunicationRunDeps {
  collect(taskId: string): Promise<ClickUpContext>;
  readPullRequest(ref: PullRequestRef): Promise<unknown>; // gh pr view --json title,body,state,files + gh pr diff (truncado 60 KB)
  scopedToken(): Promise<string | null>;                  // null + warning em caso de falha
  runCodex(input: { prompt: string; imagePaths: string[]; ghToken: string | null; cwd: string }): Promise<string>; // stdout final
}
export async function runCommunication(args: { communicationId: string; version: number; taskId: string; history: unknown[]; artifactDir: string }, deps: CommunicationRunDeps): Promise<CommunicationOutput>;

// communication-execution.service.ts
start(input: { communicationId: string; version: number }): Promise<void>; // dispara e retorna; resultado via IPC
```

- [ ] Testes de `runCommunication` com deps fake:
  - com PR citado: `scopedToken` não é chamado e `ghToken` é `null`;
  - sem PR: `ghToken` é o token;
  - JSON inválido: uma retentativa e depois lança erro;
  - os artefatos (`context/clickup.json`, `context/pull-requests/*.json`, `context/warnings.json`, `output.json`) são escritos;
  - o token nunca aparece em nenhum arquivo do `artifactDir` (varrer os arquivos e checar).
- [ ] `communication-runner.ts`:
  - parse de `--communication-id`/`--version`;
  - lê o registro do estado (task e histórico) e monta as deps reais (`collectClickUpContext`, `gh` via o wrapper existente, `createScopedInstallationToken` com os repositórios do suite, `runCodexExec` com `CODEX_READ_NETWORK_PERMISSIONS`, `communicationCodexEnvironment()` mais o `GH_TOKEN` opcional, `--model` e `withRepositoryAccess`);
  - roda `runCommunication` e envia o resultado com `process.send`;
  - sai com 0 ou 1.
  - As imagens são baixadas para `artifactDir/images` com o token do ClickUp e o tamanho máximo existente.
- [ ] `CommunicationExecutionService`:
  - `spawn(process.execPath, [runner, ...], { stdio: ['ignore','inherit','inherit','ipc'] })`, com timeout `config.timeoutMs` (kill e `failed`);
  - semáforo de `maxConcurrent`;
  - ao receber a mensagem, chama `CommunicationNotifier.versionReady/versionFailed` (Task 7), em fire-and-forget com `.catch` e log;
  - se o processo morrer sem mensagem, trata como `failed`;
  - `onApplicationBootstrap`: versões em `generating` viram `failed` e recebem aviso na thread.
- [ ] Testes do service com `spawn` mockado: exit sem mensagem vira `failed`, timeout vira `failed` e a recuperação no boot funciona.
- [ ] `npm run build && npx vitest run src/communication` e commit `feat(communication): runner and execution`.

### Task 7: Estado, Chat e aprovação

**Files:** Create:

- `src/communication/communication-store.ts` e `.spec.ts`;
- `src/communication/communication-cards.ts` e `.spec.ts`;
- `src/communication/communication-command.service.ts` e `.spec.ts`;
- `src/communication/communication-thread.service.ts` e `.spec.ts`;
- `src/communication/communication-actions.service.ts` e `.spec.ts`;
- `src/communication/communication-notifier.service.ts`.

Modify `src/google-chat/google-chat.controller.ts` (chamar `communicationCommand.handle` depois do `diagnosisCommand`), `src/google-chat/google-chat-event-router.service.ts` (`invokedFunction` com prefixo `communication_` vai para `communicationActions`; mensagem cuja thread pertence a uma comunicação vai para `communicationThread` antes da `conversation`) e `src/google-chat/google-chat-events.module.ts` (importar `CommunicationModule`).

**Produces:**

```ts
export const COMMUNICATION_STATUSES_STATE = ['generating', 'ready', 'failed', 'published'] as const;
// communication-store.ts (state/communications.json, sempre via StateService.update)
create(input): Promise<CommunicationRecord>;
findByThread(threadName: string): Promise<CommunicationRecord | null>;
startVersion(id: string, feedback: string | null): Promise<{ version: number } | { busy: true }>;
finishVersion(id: string, version: number, status: 'ready' | 'failed', cardMessageName?: string): Promise<void>;
claimPublication(id: string, version: number, user: string): Promise<'claimed' | 'already_published' | 'not_requester' | 'not_ready'>;
completePublication(id: string, messageName: string): Promise<void>;
releasePublication(id: string): Promise<void>;
```

- [ ] Testes do store (Review Focus 2 e 3):
  - duas chamadas de `claimPublication` em paralelo resultam em exatamente um `'claimed'`;
  - depois de publicada, retorna `'already_published'` para qualquer versão;
  - usuário diferente do solicitante retorna `'not_requester'`;
  - `startVersion` com uma versão em `generating` retorna `{ busy: true }`;
  - `releasePublication` volta o status para `ready`.
- [ ] Testes dos services:
  - **Comando:** link inválido gera a mesma mensagem do `/processar` (reaproveitar `parseClickUpLink` exportando-o de `google-chat-diagnosis-command.service.ts` para um `src/clickup/clickup-link.ts`); link válido cria o registro, responde "Gerando a comunicação de <task>…" e chama `execution.start`.
  - **Thread:** um não solicitante recebe "Só quem pediu a comunicação pode ajustá-la."; durante uma geração, "Ainda estou gerando a versão N; envie o ajuste quando ela chegar."; caso contrário, chama `startVersion(feedback)` e `start`.
  - **Aprovar:** `'claimed'` publica com `messenger.sendText(newsSpace, renderCommunicationText(…, mention real))` e confirma na thread com o link. Se a publicação falhar, chama `releasePublication` e responde com o erro.
- [ ] Cards (com snapshot):
  - **Rascunho:** título "Versão N", o texto renderizado com o nome do CS em texto, a seção "Evidências" e a seção "Dúvidas".
  - **Botão:** "Aprovar e publicar" (`communication_approve`, parâmetros `communicationId` e `version`), só quando o status for `READY`.
  - **Avisos:** aparecem quando `warnings` não estiver vazio.
- [ ] `CommunicationNotifier`: `versionReady` lê `output.json`, posta o card na thread e chama `finishVersion('ready', messageName)`. `versionFailed` chama `finishVersion('failed')` e envia o texto de falha.
- [ ] `npm run build && npm run lint && npm test` e commit `feat(communication): chat command, feedback loop and approval`.

### Task 8: Validação final

- [ ] `npm run build && npm run lint && npm test`: tudo verde.
- [ ] Rodar `npm run communication -- --communication-id=<id> --version=1` localmente contra uma task lançada (por exemplo TICKET-10002), com um registro criado à mão em `state/`, e conferir `output.json` e a ausência do token nos artefatos.
- [ ] Abrir o PR com o resultado do spike da Task 0 e a checklist de rollout da spec (registrar `/comunicacao` no console do Chat e configurar as variáveis com o espaço de teste).
