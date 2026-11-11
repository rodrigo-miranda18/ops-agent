# Achados abertos

Bugs, dívidas e dúvidas abertas no fim do refactor (etapas 0–12). Cada item vira um PR próprio. O histórico completo, com os itens já resolvidos, está em `docs/archive/refactor-plan.md`. Os itens marcados como "preservado" são comportamento de produção mantido de propósito: mudar qualquer um deles é mudança de comportamento.

## Tipos e testes

- **Specs sem typecheck (etapas 1, 6, 11).** Os `*.spec.ts` não passam no `tsc` strict: parâmetros sem tipo, fixtures parciais e `MemoryState` local nos specs do Chat. O `tsconfig.build.json` exclui os specs e o Vitest não faz typecheck. Tipar os specs e depois incluir `tsc --noEmit` na validação.
- **`EngineeringAction` do Chat com `string`.** Em `google-chat/google-chat.types.ts`, `decision` e `confidence` vêm do `engineering-action.json` lido sem validação. Estreitar para `EngineeringDecision`/`ConfidenceLevel` quando essa leitura for validada.
- **Non-null assertions herdadas.** `event.chat!`, `pr.url!`, `remediation!`, `dimension!.level`, `issue.url!` e `invokedFunction!`, nos services do Chat. Trocar por guarda explícita.
- **Casts sem estreitamento.** No runner, `reorientationId as string` e `as TicketProcessingConfig`. Em `RunnerConfig`, `token` e `listId` são opcionais porque só são exigidos fora do modo incidente. Resolver com tipos distintos por modo.
- **`ClickUpTask.id` é `string | number`.** O runner chama `String(task.id)` em cada uso. Normalizar na borda do adapter.
- **`impact-report` com tipo de entrada estreito.** Recebe `ImpactEvaluation`, com só os campos lidos, e não o `CustomerImpact` completo.
- **`vi.stubEnv` em `git/dependencies.spec.ts`.** O `vi.unstubAllEnvs` fica no fim do teste e não roda se uma asserção falhar. Mover para `afterEach` ou injetar o env em `dependencyEnvironment`.

## Configuração

- **Três defaults para `DRIVA_REPOS_DIR`.** O runner usa `DEFAULT_RUNNER_REPOS_DIR`, um caminho absoluto fixo da máquina de um dev (`config/runner-config.ts`). O impacto usa `<projectDir>/repos` e o Nest usa `<cwd>/repos`. Em produção a variável está definida. Localmente, cada processo pode olhar para um diretório diferente.
- **`CLICKUP_MAX_ATTACHMENT_MB`.** O default no código é 50 e o `.env.example` sugere 20.
- **Helpers de `config/app-config.ts` com default `process.env`.** No Nest eles só são chamados com o env injetado. O default pode sair.
- **Fallback morto `options.timeoutMs ||`.** Aparece em `runner/runner-codex.ts` e `impact/impact-evaluator.ts`. O timeout sempre chega preenchido.

## Subprocessos e segredos

- **Runner filho sem timeout.** `DiagnosisExecutionService` e `ImpactExecutionService` tratam exit code e `error`, mas não têm timeout. Um runner travado segura a fila única indefinidamente.
- **`gh`, `git` e o runner de impacto recebem o `process.env` inteiro.** Preservado. Avaliar uma allowlist para cada um.
- **Lacunas do `common/sanitize.ts`.** A regex de `Authorization` redige só um token. Um corpo `Bearer` não é redigido, nem tokens `ghp_`.
- **Erro do ClickUp sanitizado só no runner.** O `ClickupService` mantém o corpo do erro, truncado em 500 caracteres. Preservado.
- **Instalação de dependências com `stdio: 'inherit'`.** Nesse caso o erro traz só o exit code e o sinal, sem stderr.
- **Fingerprint de dependências inclui `process.version`.** Trocar a versão do Node reinstala todas as dependências. Preservado.

## Runner e estado

- **Prompt montado com `String.replace` de string.** Só a primeira ocorrência de cada placeholder é substituída. Sequências `$&`, `$'` ou `` $` `` no JSON do ticket ou da ação são interpretadas como padrões de substituição e podem corromper o prompt. Acontece em `diagnosis-prompt.ts` e `remediation-prompt.ts`.
- **`run.json` atualizado por read-modify-write sem fila.** Acontece em `updateRunArtifact`, fora de qualquer serialização.
- **`readProcessed` roda antes do `--sync-dependencies-only`.** Um `state/processed.json` corrompido faz a sincronização falhar sem necessidade.
- **`processIncident` não remove artefatos antigos.** Diferente de `processTicket`, uma execução sem stdout/stderr deixa no lugar os `raw-output.md` e `codex-stderr.log` da anterior.
- **`state/incidents.json` sem tratar `ENOENT`.** Com `--incident-id` e sem o arquivo, a execução falha com o erro cru do `readFile`.
- **Fechamento de PRs substituídos ignora o `github` injetado.** `closeSupersededPullRequests` usa `runGitHub` direto, e os testes não cobrem esse caminho.
- **Notificação de ticket × incidente.** A de ticket é `process.send?.()`, sem ack. A de incidente espera ack por até 120 s, fica fora da fila de notificações do Nest e falha fora do Nest sem `--no-notify`. Preservado.

## HTTP e Google Chat

- **`POST /diagnoses` sem modo dry-run.** Um smoke test no container não consegue rodar sem chamar o ClickUp.
- **`POST /diagnoses` aceita `ticketId` em branco.** `"   "` é enfileirado e o runner falha adiante. `/impacts` já rejeita esse caso.
- **Alias `googleChatUser` com `googleChatSpace: null`.** O alias é validado e usado como espaço. Preservado.
- **Status "ativos" diferentes.** `findActiveByTicket` considera `queued` e `running`, mas a reorientação também trata `pending_confirmation` como ativo. Confirmar se a diferença é intencional.
- **`normalize` sem remover acentos.** A comparação de área e tipo no runner, e a de texto do `/processar` e da conversa, só faz `trim` e `toLowerCase`, diferente de outras comparações do Nest.
- **Anexos do ClickUp autenticam com `x-api-key`.** As chamadas à API usam `Authorization`. Preservado.
- **Trava `acting` só em memória.** Restart não herda a trava contra clique duplo na aprovação. Preservado.
- **`google-chat-github-users.ts` usa `new Logger('GoogleChatService')` fixo.** Esse service não existe mais.
- **Linha comentada `Ver codex log` em `google-chat-cards.ts`.** Remover ou implementar. Isso atualiza os snapshots.

## Código morto (knip)

O `knip` rodou via `npx`, sem virar dependência, com entradas `main`, `runner`, `notify`, `impact-runner`, specs e `incidents/fixtures/*.js`. Nenhum arquivo ou dependência morta. O `@nestjs/schematics` aparece como não listado, porque é usado pelo `nest-cli.json` e está fora do `package.json`.

Estes exports só têm uso dentro do próprio arquivo. O `export` pode sair; não são código morto:

- `runnerClickUpError`, `customFieldValue`, `firstValidationMessage`, `DEFAULT_DIAGNOSIS_CRON`, `parseBoolean`, `initializeLinkedinSubmodules` e `runnerGhError`.
- `SYSTEM_ENVIRONMENT`, `CERTIFICATE_ENVIRONMENT`, `CODEX_ENVIRONMENT` e `GIT_IDENTITY_ENVIRONMENT` (`config/env.ts`).
- Listas `as const` de domínio: `ACTIVE_RUN_STATUSES`, `DEPENDENCY_MANAGERS`, `DEPENDENCY_SYNC_VERSION`, `CUSTOMER_IMPACT_DIMENSIONS`, `CUSTOMER_IMPACT_SPECIAL_CONDITIONS` e `REMEDIATION_STATUSES`.
- 46 tipos e interfaces exportados sem import externo. A maioria descreve assinaturas públicas; mantidos.

## Ambiente local

- **`bwrap` sem namespace de rede no Ubuntu 24.04.** Com `kernel.apparmor_restrict_unprivileged_userns=1`, `bwrap --unshare-net` falha e o Codex não abre sessão. Para rodar diagnóstico ou impacto real localmente, é preciso um perfil AppArmor para o `bwrap` ou usar o container.
- **`.env` local sem `DIAGNOSIS_VECTORS`.** O `dry-run` local falha sem essa variável. Usar o valor do `.env.example`.
- **`state/diagnosis.lock` órfão no clone local.** Remover à mão, conforme o procedimento de lock órfão.
