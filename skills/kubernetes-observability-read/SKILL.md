---
name: kubernetes-observability-read
description: Investigação somente leitura de sintomas de pods, probes, restarts, recursos, eventos, métricas e rollouts Kubernetes usando dados OpenTelemetry em ClickHouse. Use quando um alerta citar pod, container, namespace, probe, OOM ou restart. VERSÃO DE EXEMPLO.
---

# Kubernetes observability read (exemplo público)

Evidência de infraestrutura/runtime que os logs de aplicação não estabelecem. **Somente leitura**: nunca
reiniciar, escalar, reimplantar, apagar ou alterar estado do Kubernetes ou do ClickHouse.

## Data source

Usar o wrapper de consulta read-only do repositório de logs do ambiente (ex.: `logs-read`). Tabelas
OpenTelemetry típicas: `otel_logs`, `otel_metrics_gauge`, `otel_metrics_sum`, `otel_metrics_histogram`,
`otel_traces` (confirme os nomes antes de usar). Ver `references/clickstack-schema.md`.

## Investigation workflow

1. Extrair namespace, pod, container, workload, nó, horário do alerta e janela em UTC.
2. Descobrir chaves de recurso em `ResourceAttributes`/`LogAttributes` com consultas agregadas e limitadas.
3. Logs de eventos/probe/restart/OOM/eviction agrupados por recurso e padrão de mensagem.
4. Métricas do pod/container na mesma janela (CPU, throttling, memória, restarts, readiness).
5. Traces apenas se latência ou dependência puder explicar a falha de probe.
6. Correlacionar com logs da aplicação. Separar fatos, inferências, hipóteses descartadas e lacunas.

## Restart/probe correlation pattern

Janela de ±3 min em torno do restart, agrupando pelo nome exato do pod:

    k8s.container.ready:    1 -> 0
    k8s.container.restarts: N -> N+1

Transições no mesmo minuto são evidência de correlação, não prova de causa.

## Required interpretations

- `Readiness probe failed` tira o pod dos endpoints; não prova restart.
- `OOMKilled` é evidência de memória. `Evicted`/`NodeNotReady`/rollout são causas distintas.
- Ausência de eventos na telemetria é lacuna, não evidência de ausência.

## Query safety

Só comandos de leitura, sempre com predicado de tempo, `LIMIT` e agregações; redigir payloads e identificadores.

## Output

Linha do tempo em UTC, evidências por fonte, conclusão com grau de confiança e lacunas.
