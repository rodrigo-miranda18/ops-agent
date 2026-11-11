# AGENTS.md — driva-ops-agent

Agente de operações da Driva. Seleciona tickets do ClickUp e incidentes do Grafana, roda um diagnóstico com o Codex CLI ou o Claude Code sobre os repositórios de produto (em sandbox), decide a ação de engenharia, notifica o Google Chat e, quando elegível, abre PRs de remediação. Nunca faz merge nem deploy.

**Stack:** Node.js 24 · NestJS 11 · TypeScript (strict, ESM/NodeNext) · Codex CLI · Claude Code · `gh` CLI · estado em arquivos JSON · deploy Dokku (container único)

## Comandos

```bash
npm ci                      # instalar (package-lock.json é o lockfile oficial; não usar pnpm aqui)
npm run start:dev           # Nest em watch (porta 3000)
npm run build               # nest build → dist/
npm test                    # testes
npm run lint                # eslint --max-warnings 0
npm run format              # prettier
npm run diagnose -- --help  # runner de diagnóstico em modo CLI
npm run dry-run             # seleciona tickets sem chamar o Codex nem alterar estado
npm run impact -- --ticket-id=ID
```

## Arquitetura

Dois processos, um código:

1. **App Nest** (`dist/main.js`): HTTP (Google Chat, API manual, webhook do Grafana), cron, fila de execução única e notificações.
2. **Runner** (`dist/runner.js`): pipeline de diagnóstico/remediação. Sempre roda como **processo filho** do Nest (via `DiagnosisExecutionService`) ou manualmente pela CLI. O isolamento é intencional: execução longa, lock de diagnóstico, subprocessos `bwrap`/`codex`/`claude`/`git`, e uma falha não derruba o servidor HTTP. Não mover o runner para dentro do processo Nest.

```
src/
├── main.ts                 # bootstrap HTTP
├── runner.ts               # entrypoint CLI do pipeline (parse de args + main)
├── runner/                 # etapas do runner: args, lock, logger, paths, preparação, Codex
├── notify.ts               # entrypoint CLI de reenvio de notificações
├── app.module.ts           # módulo raiz: só importa módulos de feature
├── config/                 # leitura e validação de env; ConfigModule global com tokens
├── state/                  # StateService + escrita atômica de JSON
├── common/                 # run-process, sanitize, safe-equal, RequestValidationPipe
├── agent/                  # escolha do runtime por superfície (`runAgentExec`), sombra e canário
├── codex/ claude/ git/     # adapters sem Nest (Codex CLI, Claude Code, git, dependências, worktrees)
├── clickup/ github/        # adapters de sistemas externos
├── google-chat/            # GoogleChatModule (notificações, threads) e GoogleChatEventsModule (eventos)
├── diagnosis/              # fila, cron, controller, classificação de vetores
├── incidents/              # webhook Grafana, seleção de repositórios, issues
├── remediation/            # reorientação e supersessão de PRs
├── impact/                 # impacto no cliente (score, relatório, runner próprio)
├── health/                 # healthcheck HTTP
└── prompts/                # prompt.md, remediation-prompt.md, impact-prompt.md
```

### Separação de responsabilidades

- **Organização por feature**, não por camada técnica: cada pasta de `src/` é um módulo autocontido (controller, service, tipos, funções puras e testes juntos). Não criar divisões como `api/` × `core/`, nem camadas de `use-cases/`. Cada feature com controller/service próprios tem seu módulo (`<feature>/<feature>.module.ts`). `AppModule` só importa módulos. Um provider é declarado em um único módulo e exportado para quem precisa, nunca duplicado.
- **Controllers são finos:** autenticam (guard), validam entrada (DTO) e delegam para um service. Sem regra de negócio.
- **Lógica de decisão é função pura** em arquivo próprio (`vector-classification.ts`, `repository-selection.ts`, `customer-impact.ts`...): recebe dados, devolve dados, sem I/O, sem `process.env`. É o que concentra os testes.
- **Side effects ficam nas bordas:** adapters (ClickUp, GitHub, Google Chat, Codex, git) e `StateService`. Funções puras não chamam adapters.
- **Arquivos grandes são dívida.** Não adicionar código a `runner.ts`, a `runner/` ou a um service do Chat quando a responsabilidade tem casa própria; extrair para o módulo da feature. Um arquivo novo deve ter uma responsabilidade nomeável.
- **Código compartilhado entre Nest e runner** é TypeScript comum, importado pelos dois. Não duplicar lógica entre os dois processos.

### Fluxo do diagnóstico (domínio crítico)

**Antes de tocar em `runner.ts`, nos prompts ou em `diagnosis/`, entender este fluxo:**

1. Cron (`DIAGNOSIS_CRON`, só com `DIAGNOSIS_CRON_ENABLED=true`), API manual (`POST /diagnoses`) ou webhook Grafana (`POST /incidents/grafana`) enfileiram uma execução. **Há uma única fila**: execuções são serializadas.
2. O runner adquire o lock de diagnóstico, sincroniza repositórios e dependências e seleciona tickets (área, janela de criação, `state/processed.json`).
3. O agente (Codex por padrão, ou Claude Code por `AGENT_RUNTIME`) diagnostica em sandbox `bwrap` **somente leitura**, com allowlist de env (`codexEnvironment`). Diagnóstico **não** recebe `GH_TOKEN`.
4. A saída é validada contra o contrato da ação de engenharia (`CORRECTION_REQUIRED`, `IMPROVEMENT_RECOMMENDED`, `NO_CODE_ACTION`, `INSUFFICIENT_EVIDENCE`, `ALREADY_FIXED` + `confidence` + repositórios).
5. O vetor diagnosticado define os espaços do Google Chat e é sincronizado de volta no ClickUp.
6. O runner avisa o Nest que o diagnóstico está pronto → primeiro card no Chat.
7. Se elegível, a remediação roda em worktrees temporárias, com `GH_TOKEN`, e abre um PR por repositório. PRs abertos da mesma causa são reaproveitados em vez de duplicados.
8. Segundo card com o resultado da remediação. Ações humanas (assumir, aprovar comentário, reorientar) chegam por `POST /google-chat/events`.

Regras do domínio:

- `INSUFFICIENT_EVIDENCE` significa "sem causa única comprovada", não "sem dados". Serviço não identificado é problema de label/mapeamento, não de evidência.
- Remediação só com repositório resolvido e confiança suficiente; `UNRESOLVED` bloqueia PR **e** issue no GitHub.
- **Contrato prompt ↔ código:** os prompts em `prompts/` definem o JSON que o runner valida. Mudou um lado, muda o outro e o fixture de teste correspondente (`incidents/fixtures/`). Mudança de prompt é mudança de comportamento em produção: tratar como mudança de código.
- Skills do agente (`skills/driva-debug`, `kubernetes-observability-read`) vão na imagem e valem para os dois runtimes. Alterá-las muda o diagnóstico.
- `AGENT_RUNTIME` define o runtime, e `AGENT_RUNTIME_<SURFACE>` sobrepõe por superfície (`DIAGNOSIS`, `REMEDIATION`, `CONVERSATION`, `COMMUNICATION`, `IMPACT`). Chamadas de agente passam por `runAgentExec`. Mudança de prompt afeta os dois runtimes.
- `CLAUDE_MODEL` mantém o prefixo `claude/`: outras rotas do proxy servem outro modelo sem erro. O adapter valida o modelo servido.

## Convenções

### TypeScript

- **Tudo é `.ts`.** Não criar `.mjs`/`.js` em `src/`; a exceção são os executáveis que simulam o Codex em `incidents/fixtures/`. Único código fora do build: `docker/entrypoint.sh`.
- `strict: true` — não afrouxar flags do `tsconfig`, não usar `any` (usar `unknown` + narrowing), não usar `!` para calar o compilador sem garantia real.
- ESM com `NodeNext`: imports relativos com extensão `.js` (`from './state.service.js'`).
- **Uma fonte da verdade para categorias de domínio** (decisões, modos de remediação, status de execução, fontes): `const X = [...] as const` + `type X = (typeof X)[number]`, e a validação em runtime usa a mesma constante. Nunca repetir a lista de literais em outro arquivo.
- Tipos de payload externo (ClickUp, Grafana, Google Chat, saída do Codex) em `<feature>.types.ts`. Dado externo entra como `unknown` e é validado antes de ser tratado como tipado.

### Configuração

- `process.env` é lido **apenas** em `src/config/`. O restante do código recebe configuração tipada: no Nest, por injeção dos tokens do `ConfigModule` global (`APP_CONFIG`, `AUTH_CONFIG`, `CLICKUP_CONFIG`, `GOOGLE_CHAT_CONFIG`, `RUNTIME_CONFIG`); no runner, por parâmetro.
- Configuração obrigatória é validada no boot com mensagem clara; o processo não sobe com config inválida.
- Variável nova: adicionar em `config/`, em `.env.example` (com comentário curto) e no README se for operacional.
- `dotenv` é carregado só nos entrypoints (`main.ts`, `runner.ts`, `notify.ts`, runner de impacto).

### HTTP e autenticação

- Validação de entrada com DTO (`class-validator`) e o `RequestValidationPipe` global (`common/request-validation.pipe.ts`), que devolve só a primeira mensagem de erro. O service recebe dados já tipados. Não validar body à mão com `typeof` em controller.
- Autenticação por guard (`@UseGuards`), não por método `authorize()` repetido em cada controller. Bearer da API manual (`DIAGNOSIS_API_KEY`), token do Grafana (`GRAFANA_WEBHOOK_TOKEN`) e verificação do JWT do Google Chat são guards distintos.
- Comparação de segredos com `timingSafeEqual`.
- `GOOGLE_CHAT_SKIP_AUTH` é só para desenvolvimento local.

### Estado e persistência

- Estado vive em `state/*.json`, artefatos de execução em `results/<ticket-id>/`. **Só uma instância** da aplicação (cron, fila e locks não são distribuídos).
- Toda escrita de estado passa por `StateService.update` (Nest) ou pelo helper de escrita atômica compartilhado (runner): temp file + `rename`, modo `0600`. Nunca `writeFile` direto em `state/`.
- Read-modify-write sempre dentro do `update` (serializado), nunca `read` seguido de `write` separado.
- Mudou o formato de um arquivo de estado: o código continua lendo o formato antigo ou há migração explícita. Estado de produção não é descartável.

### Subprocessos e integrações externas

- Chamadas a ClickUp, GitHub, Google Chat, Codex e Claude Code passam pelo adapter da integração. Não fazer `fetch`/`spawn('gh')` avulso em outro lugar. Adapters usados pelo runner não dependem do Nest (`codex/codex.ts`, `claude/claude.ts`, `git/`, `github/gh.ts`, `clickup/clickup-api.ts`, `common/run-process.ts`); os services do Nest os reutilizam.
- Todo `spawn` tem timeout, captura de stderr para log/artefato e tratamento de exit code ≠ 0.
- Env de subprocesso é **allowlist**, nunca `process.env` inteiro para o agente. Segredos só para a etapa que precisa (ex.: `GH_TOKEN` só na remediação).
- Não relaxar o sandbox `bwrap`, a config de rede do Codex nem as permissões do container sem pedido explícito.
- **Comunicação runner → Nest** é por mensagens IPC tipadas (`process.send`), com o tipo da mensagem definido em `diagnosis/runner-messages.ts`, compartilhado pelos dois lados. Não criar novos protocolos por parsing de stdout.

### Logging

- No Nest: `private readonly logger = new Logger(ClassName.name)`. No runner: o logger compartilhado do runner. Sem `console.log` solto.
- Logar início/fim de execução com `runId`/`ticketId`/`incidentId`, chamadas externas que falham, decisões do pipeline (ticket ignorado e por quê, ação decidida, PR aberto/reaproveitado).
- Nunca logar tokens, chaves, credenciais de service account nem conteúdo de `.env` materializado para os repositórios.

### Async error handling

`@Cron`, callbacks de `child_process` e promises fire-and-forget não têm handler do Nest: um rejection não tratado derruba o processo e interrompe a fila.

```typescript
// ❌ promise flutuante
this.googleChat.notifyDiagnosis(ticketId);

// ✅ fire-and-forget explícito, com log
void this.googleChat.notifyDiagnosis(ticketId).catch((error: Error) =>
  this.logger.error(`Diagnosis notification failed for ${ticketId}: ${error.message}`),
);

// ✅ cron com try/catch
@Cron(CRON_EXPRESSION)
async execute() {
  try {
    await this.executions.enqueue({ source: 'cron' });
  } catch (error) {
    this.logger.error(`Diagnosis cron failed: ${(error as Error).message}`);
  }
}
```

- Erro de uma notificação não pode falhar a execução do diagnóstico; erro de um ticket não pode abortar os outros do mesmo lote.
- Registro de execução (`diagnosis-runs.json`) sempre termina em `completed` ou `failed`, inclusive quando o runner morre.

### NestJS

- Constructor injection sempre; providers singleton (sem `Scope.REQUEST`).
- Sem dependência circular entre módulos: extrair o compartilhado para um terceiro módulo.
- `app.enableShutdownHooks()` está ligado: ao adicionar recurso que segura o processo (child process, timer), tratar o shutdown.

### Comentários

Não escrever comentários narrativos ou justificativos (motivação, histórico, alternativas descartadas). Nomes, tipos e testes carregam essa informação; a justificativa vai no commit e no PR. Comentário só para armadilha técnica que o leitor não infere do código, em uma linha.

## Testes

- Framework: Vitest, arquivos `*.spec.ts` ao lado do código.
- Testes importam o **código-fonte TypeScript**, nunca `dist/`, e não exigem build prévio.
- Prioridade: funções puras de decisão (seleção de ticket, classificação de vetor, seleção de repositório, dedup de PR, impacto), validação do contrato da ação de engenharia com fixtures reais de saída do Codex, e montagem de cards/threads do Chat.
- Integrações externas são mockadas na fronteira do adapter (injeção de dependência, como o parâmetro `github` de `processIncident`). Teste nunca chama ClickUp, GitHub, Google Chat, Codex ou Claude Code de verdade.
- Sempre criar ou atualizar teste para lógica nova ou correção de bug. Testar comportamento público, não detalhes internos.

## Git e deploy

- Nunca commitar direto em `main`. Branch `feat/*`/`fix/*`/`refactor/*` e PR.
- `main` local só espelha `origin/main` e pode levar `reset --hard` fora da sessão: commitar cedo, não deixar trabalho só no working tree de `main`.
- Deploy é `git push` para o remote Dokku (`dokku-remote`). **Nunca fazer push para o Dokku sem pedido explícito.** `GIT_REV` indica o que está rodando.
- Arquivos que a imagem precisa em runtime (prompts, skills) devem estar no `Dockerfile`/assets do build. Adicionou arquivo lido em runtime: conferir que ele chega em `dist/` ou na imagem.
- Nunca commitar `.env`, credenciais de service account, `state/*.json` ou `results/`.

## Princípios de desenvolvimento

### Reutilização

- Procure implementação existente (adapter, helper, função pura, tipo) antes de criar outra. Prefira estender a criar paralela.
- Mantenha consistência com os padrões já adotados; evite abstrações sem segundo uso.

### Em caso de dúvida

- Não suponha requisitos, regras de negócio ou comportamento do agente. Não invente implementação para preencher lacuna.
- Havendo ambiguidade, **pare e pergunte ao desenvolvedor**.

### Processo

1. Entenda o problema.
2. Localize implementações semelhantes e entenda como funcionam.
3. Faça a menor alteração possível.
4. Preserve o comportamento existente (principalmente o que o agente faz em produção: quem é notificado, o que é escrito no ClickUp, quando abre PR).
5. Atualize ou crie testes.

### Checklist antes de finalizar

- [ ] `npm run build`, `npm run lint` e `npm test` passam?
- [ ] Existe implementação semelhante que deveria ser reutilizada?
- [ ] O comportamento em produção foi preservado (notificações, escrita no ClickUp/GitHub, abertura de PR)?
- [ ] Contrato prompt ↔ validação ↔ fixtures continua consistente?
- [ ] `process.env` só foi lido em `config/`? Variável nova está no `.env.example`?
- [ ] Escritas de estado são atômicas e serializadas? Formato antigo continua legível?
- [ ] Promises fire-and-forget e crons têm tratamento de erro?
- [ ] Algum segredo pode vazar para log, artefato em `results/` ou subprocesso que não precisa dele?
- [ ] Arquivo novo lido em runtime chega na imagem Docker?
