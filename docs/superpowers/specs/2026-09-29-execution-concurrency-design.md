# Concorrência de execuções — design

Data: 2026-09-29 · Branch: `feat/execution-concurrency`

## Objetivo

Um item individual (incidente do Grafana, `POST /diagnoses`, comando ou reorientação do Chat) não pode esperar atrás de um lote longo do cron nem de outro item longo. Throughput do cron **não** é objetivo.

Um restart do container (deploy ou `dokku config:set`) não pode perder nem travar trabalho em andamento: lock, registro de execução e item interrompido se recuperam sozinhos, e o item volta a ser processado — inclusive a remediação.

Critérios de sucesso:

- Com o lote do cron em execução, um `POST /diagnoses` vira `running` imediatamente e diagnostica sobre os repositórios como estão (sem sync).
- Um `config:set` no meio de um diagnóstico de incidente não deixa lock órfão nem registro preso em `running`, e o incidente é retomado pelo container novo sem ação manual.

## Decisões

- Aproximação escolhida: pool de execuções no Nest + lock global do runner dividido em lock de sync, registro de leitores e claim por item. Rejeitadas: faixas fixas cron/interativo; runner de vida longa recebendo itens por IPC.
- Frescor dos repositórios: execução que começa com outra lendo usa os repositórios como estão. Sync só acontece sem leitores vivos. Sem teto de "sync forçado" (YAGNI); o skip é logado e registrado no `run.json`.
- Runner continua processo filho do Nest; instância única **em regime**. Durante deploy o Dokku mantém o container antigo vivo por ~60 s junto do novo, sobre o mesmo volume de `state/`: todo dono (lock, claim, execução) precisa ser identificado entre containers.
- Vida do dono por **lease com heartbeat**, não por pid. `process.kill(pid, 0)` não serve: o pid é de outro namespace (container antigo), pode ser reusado, e não distingue "container antigo ainda vivo na sobreposição" de "morreu".
- Execução interrompida é **retomada**, não só marcada como falha. Retomada a partir do último checkpoint: se o diagnóstico já terminou, o resultado persistido é reutilizado, o card é reenviado idempotentemente e só a remediação é refeita, sem novo Codex de diagnóstico.

## 1. Pool de execuções no Nest

`DiagnosisExecutionService`:

- `private queue = Promise.resolve()` é substituído por um pool com `DIAGNOSIS_EXECUTION_CONCURRENCY` vagas (default 2), compartilhado por `enqueue` e `enqueueReorientation`.
- Registro fica `queued` em `diagnosis-runs.json` até ganhar vaga; então `running`. Ordem FIFO.
- Contrato público inalterado: `enqueue` devolve `{ runId, completion }`; `enqueueReorientation` devolve a promise. Nenhum chamador muda.
- Chave de item: `ticket:<id>`, `incident:<id>`, reorientação = `ticket:<ticketId da reorientação>`; lote do cron sem chave. O pool não inicia uma execução cuja chave já está ativa; pula para a próxima elegível da fila. A pulada roda quando a anterior do mesmo item termina (um segundo `POST /diagnoses` com `force` continua rodando, depois do primeiro).
- Chaves ativas ficam em memória.
- `DiagnosisScheduler` mantém o `inFlight`: o cron ocupa no máximo 1 vaga.
- Vaga liberada em `finally` (falha, exit ≠ 0 ou erro de spawn não prendem o pool).

### Dono, heartbeat e recuperação de execuções interrompidas

**Identidade.** No boot, o Nest gera `instanceId = <hostname>:<uuid>` (hostname do container muda a cada deploy; uuid cobre restart no mesmo container). Vai para o runner por argumento (`--owner-instance-id`), não por env. Uma execução manual do runner sem esse argumento gera uma identidade efêmera `runner:<hostname>:<uuid>` para participar do mesmo protocolo de locks.

**Registro de execução.** `DiagnosisRunRecord` e o registro de reorientação ganham campos aditivos: `ownerInstanceId`, `heartbeatAt`, `activeItems` (itens que o runner está processando agora, só relevante no lote do cron), `resumedFrom` (runId que originou a tentativa), `resumedBy` (runIds criados para retomar este registro) e `resumeAttempt`. Registros antigos sem esses campos continuam válidos.

**Heartbeat.** Enquanto houver execuções `running` da instância, um timer de 30 s atualiza `heartbeatAt` de todas elas numa única escrita via `StateService.update`. O timer é limpo no shutdown.

**Itens ativos do lote.** Nova mensagem IPC em `runner-messages.ts`: `item-started` / `item-finished` (`{ key }`, mesmas chaves da seção 1). O Nest mantém `activeItems` no registro. Sem parsing de stdout.

**Status novo.** `RUN_STATUSES` ganha `interrupted` (terminal, não ativo). "Termina em `completed` ou `failed`" passa a ser "termina em `completed`, `failed` ou `interrupted`"; a API (`GET /diagnoses/:id`) expõe o status como está.

**Varredura de recuperação** (`src/diagnosis/run-recovery.ts`, função pura + service fino): roda no boot e a cada minuto (`@Interval`, com try/catch e log). Não roda só no boot porque, na sobreposição do deploy, o container antigo ainda está vivo quando o novo sobe.

1. Registro `running` de **outra** instância com `heartbeatAt` (ou `startedAt`, se ausente) mais velho que o lease (2 min) → `interrupted`, `finishedAt`, `error: 'owner instance stopped (lease expired)'`.
2. Registro `queued` de outra instância: `queued` só vive em memória do dono → se o dono não tem nenhum heartbeat vivo no arquivo, `interrupted` pelo mesmo critério (fila perdida junto com o processo).
3. São candidatos à retomada tanto os registros que acabaram de expirar quanto registros já `interrupted` (por exemplo, pelo shutdown gracioso), desde que o campo `resumedBy` esteja ausente e respeitem o limite de tentativas. O campo é gravado mesmo como lista vazia quando não há item ativo para retomar, marcando o registro como tratado.
4. Para cada candidato, a retomada prepara execuções novas com `resumedFrom` e `resumeAttempt + 1`:
   - execução de item único (`ticketId`/`incidentId`) → retoma aquele item;
   - lote do cron → retoma cada chave de `activeItems` como item único (ticket fora da janela de criação não seria recolhido pelo próximo cron). Itens do lote que nem começaram ficam para o próximo cron;
   - reorientação → reenfileira a mesma reorientação.
     Mesmos `source`, `notify`, `remediation`, `googleChatSpace`/`googleChatThread` do original.
5. A transição para `interrupted`, a criação dos novos registros `queued` e o preenchimento de `resumedBy` no candidato acontecem na mesma atualização atômica de `diagnosis-runs.json`. Só depois do commit o service adiciona os novos registros ao pool em memória. Se o processo morrer entre essas etapas, os registros `queued` persistidos serão recuperados pelo mesmo protocolo, sem duplicar a retomada anterior.
6. Limite: uma execução com `resumeAttempt >= 2` fica `interrupted` sem nova retomada e gera alerta no log (evita loop se o próprio item derruba o processo). A execução original sem o campo equivale à tentativa 0.
7. A decisão (transições e descritores das retomadas) é função pura sobre `(runs, instanceId, now)`; o service aloca os runIds, aplica a atualização atômica e agenda os registros já persistidos.

**Checkpoint da retomada** (decidido pelo runner ao receber `--resume` junto de `--ticket-id`/`--incident-id`/`--reorientation-id`):

- Diagnóstico terminado (`results/<id>/run.json` com `status: success`, `engineering-action.json` presente e `remediation_status: 'pending'`) → pula o Codex de diagnóstico, reconstrói o mesmo card a partir dos artefatos persistidos e solicita novamente sua entrega pelo IPC. A deduplicação existente torna o reenvio idempotente e cobre a morte entre a conclusão do diagnóstico e a confirmação da notificação. Depois executa só a etapa de remediação existente (`remediateTicket` / `remediateIncident`, extraídas da cauda de `processTicket` / `processIncident` para função reutilizável), grava `remediation.json`, marca processado e dispara o card de remediação.
- Caso contrário → processa o item do zero com `force` (o ticket ainda não está em `processed.json`, mas `force` evita que a janela de criação o descarte).
- Reorientação → reexecuta a reorientação inteira.

**Idempotência exigida na retomada da remediação** (verificar e cobrir com teste antes de ligar):

- worktrees temporárias órfãs do processo morto: `git worktree prune` + remoção dos diretórios temporários no início da remediação;
- branch remota já empurrada sem PR: o nome da branch é determinístico por item/causa, e a remediação reaproveita a branch (force-push da nova tentativa) em vez de falhar ou criar outra;
- PR já aberto antes da morte: reaproveitado pelo dedup de PR existente;
- escrita no ClickUp e notificações do Chat: dedup pelas chaves já existentes (`<id>:<updated_at>:<tipo>:<space>`); comentário no ClickUp não pode duplicar.

**Shutdown gracioso** (`enableShutdownHooks` já ligado): em `onApplicationShutdown`, o Nest para de iniciar execuções, envia SIGTERM aos runners filhos e, sem esperar o fim, marca as próprias execuções `running` como `interrupted` (`error: 'interrupted by shutdown'`). O runner trata SIGTERM soltando locks/claims no `finally` e saindo. Isso só antecipa a retomada (segundos em vez do lease); a correção não depende dele, porque o container pode receber SIGKILL.

`findActiveByTicket` já ignora `interrupted` por não ser status ativo.

## 2. Acesso aos repositórios e claim por item (runner)

O `state/diagnosis.lock` deixa de ser usado. `runner/runner-lock.ts` é substituído.

Todas as peças usam diretório criado com `mkdir`, dono em `owner.json` `{instance_id, pid, started_at, heartbeat_at}` modo 0600 (helper único `src/state/owned-lock.ts`). O dono renova `heartbeat_at` a cada 30 s enquanto segura a peça. Dono é considerado morto quando `heartbeat_at` passou do lease (2 min); `owner.json` ilegível ou ausente conta como morto se o diretório tiver mtime além do lease. Peça com dono morto é movida para `<nome>.stale-<timestamp>` (auditoria, como o procedimento manual de hoje) por quem a encontrar.

### `src/git/repository-access.ts`

Expõe `withRepositoryAccess(config, options, fn)`. Protocolo:

1. Adquire `state/repo-sync.lock`. Se ocupado por dono vivo: polling, loga que está aguardando sync de outra execução, timeout de `REPOSITORY_SYNC_TIMEOUT_MINUTES + DEPENDENCY_SYNC_TIMEOUT_MINUTES` → erro. Dono morto → remove e tenta de novo.
2. Remove leitores mortos de `state/repo-readers/`.
3. Sem leitores vivos: `synchronizeRepositories` → `syncDependencies` → `materializeDiagnosisEnvFiles` (como hoje). Com leitores vivos: pula e loga o HEAD de cada repositório.
4. Registra `state/repo-readers/<owner-id>` **ainda dentro do lock de sync** (fecha a corrida entre "não há leitores" e "comecei a ler"). O nome combina a identidade única da instância/execução com o pid sanitizado; pid isolado não é suficiente porque pode se repetir entre containers.
5. Solta o lock de sync, executa `fn(syncInfo)`, remove o registro de leitor em `finally`.

`syncInfo = { status: 'synced' | 'skipped', heads: Record<repo, sha> }`. É gravado no `run.json` do item como campo aditivo `repository_sync` (formato antigo continua válido).

`--sync-dependencies-only`: modo exclusivo; com leitores vivos falha com "repositórios em uso por N execução(ões)".

Leitor de um container que morreu deixa de contar como vivo após o lease: o sync volta a acontecer no máximo 2 min depois, sem intervenção.

### `src/diagnosis/item-claims.ts`

Claim em `state/item-locks/<chave>` (mesmas chaves da seção 1; caracteres fora de `[A-Za-z0-9_-]` sanitizados no nome do diretório). Adquirido por item, dentro do processo, antes de `processTicket` / `processIncident` / reorientação; liberado em `finally`.

- Claim de outro processo vivo, no lote do cron: ticket pulado com log, não conta como falha.
- Claim de outro processo vivo, em execução de item único: erro claro (só ocorre por CLI manual; o Nest já impede).

### `runner.ts`

Os quatro blocos "lock → sync → deps → env" viram chamadas a `withRepositoryAccess`. `runner.ts` encolhe.

## 3. Estado JSON entre processos

- Nova primitiva compartilhada `src/state/locked-json-update.ts`: `updateJsonFileLocked(file, owner, mutate)`. Lock entre processos via `owned-lock` em `<file>.lock` (mesma regra de dono/lease); dono morto → recupera; dono vivo → polling, timeout de 30 s → erro. Dentro do lock: relê o arquivo, aplica `mutate` e grava com `writeJsonAtomic`.
- `StateService.update` mantém sua fila em memória e passa a executar cada read-modify-write por essa primitiva, com lock por arquivo. Isso protege `diagnosis-runs.json`, incidentes e os demais estados durante a sobreposição de containers sem mudar a API dos services. `StateService.read` continua retornando uma versão atômica completa (anterior ou posterior à atualização), sem exigir lock de leitura.
- `markProcessed` usa a mesma primitiva diretamente no runner e faz merge só da entrada nova (`<id>:<updated_at>`). Formato de `processed.json` inalterado; arquivo ausente começa como `{}` e `stateWriteQueue` é removida.
- Recheck de elegibilidade: no lote, depois do claim e antes do Codex, o runner relê `processed.json` e pula o ticket se a mesma versão já foi processada (exceto `force`), com log.
- Fora do escopo (já seguros): `results/<id>/*` e `github-issues.json` são por item (claim garante exclusividade); estado de dependências só é escrito durante sync exclusivo.

## 4. Config e erros

- `DIAGNOSIS_EXECUTION_CONCURRENCY` em `config/app-config.ts`: inteiro ≥ 1, default 2, inválido derruba o boot. Entra no `.env.example` e no README. `1` reproduz o comportamento atual (rollback sem deploy de código).
- `RUNNER_CONCURRENCY` inalterado; README explica que as duas se somam (defaults: até 3 Codex do lote + 1 item individual).
- Nenhuma variável nova para timeouts de lock (derivados da config existente / constante).
- Logs de lock mostram só pid, chave do item e HEADs. Nenhum segredo novo circula.
- Estouro de espera de lock → item `failed`; no lote, um ticket falho não aborta os outros.

## 5. Testes e rollout

Vitest, spec ao lado do código, sem spawn real, Codex ou git remoto:

- Pool: limite N; FIFO; mesmo item nunca em paralelo e item diferente passa à frente; reorientação divide vagas; falha libera vaga.
- `run-recovery` (pura): registro de outra instância com lease vencido vira `interrupted`; com lease vivo (sobreposição do deploy) não é tocado; registro da própria instância nunca é tocado; registro já `interrupted` pelo shutdown também retoma; `resumedBy` impede retomada duplicada; item único retoma o item; lote retoma só `activeItems`; reorientação retoma a reorientação; `resumeAttempt >= 2` não retoma; registros antigos sem os campos novos usam `startedAt`.
- Persistência da retomada: original interrompido, `resumedBy` e novos registros `queued` são gravados juntos; morte antes de inserir no pool deixa o registro recuperável sem duplicar a tentativa.
- Heartbeat: renova só execuções da própria instância; timer limpo no shutdown.
- Shutdown: marca `interrupted` e sinaliza os filhos.
- Checkpoint da retomada: com diagnóstico terminado não chama o Codex, reenvia idempotentemente o card persistido e roda só a remediação; sem diagnóstico terminado processa do zero com `force`.
- Idempotência da remediação retomada: worktree órfã removida; branch remota existente reaproveitada; PR existente reaproveitado; comentário no ClickUp e cards do Chat não duplicados.
- `owned-lock`: adquirir/liberar; heartbeat renova; dono com lease vencido é movido para `.stale-*`; `owner.json` ilegível; dois containers com o mesmo pid mantêm identidades distintas.
- `repository-access`: sync sem leitores; skip com leitor vivo (com `syncInfo`); recupera leitor e lock de sync com lease vencido; `--sync-dependencies-only` falha com leitores.
- `item-claims`: adquirir/liberar; duplicado vivo; dono morto.
- `updateJsonFileLocked`: merge concorrente preserva entradas; timeout; arquivo ausente.
- `StateService.update`: duas instâncias atualizando o mesmo arquivo preservam ambas as mutações; arquivos diferentes não compartilham lock; falha do mutator não grava estado.
- Lote: pula ticket com claim ativo e ticket já processado após a seleção.
- Config: default 2, inválido falha, 1 aceito.

Rollout: PR na branch `feat/execution-concurrency`; sem push ao Dokku sem pedido explícito. Validação em prod: com cron rodando, `POST /diagnoses` vira `running` na hora e `run.json` mostra `repository_sync.status = 'skipped'`. Recuperação: `dokku config:set` (valor inalterado) no meio de um diagnóstico de incidente → em até ~3 min o registro antigo está `interrupted`, há execução nova com `resumedFrom`, nenhum lock sobra em `state/` e o incidente termina com os cards e o PR esperados, sem duplicatas. Rollback: `DIAGNOSIS_EXECUTION_CONCURRENCY=1`. `state/diagnosis.lock` remanescente é inerte; README diz que pode ser removido.
