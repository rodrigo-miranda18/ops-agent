# Incidentes disparados pelo Grafana

## Primeira entrega

O endpoint `POST /incidents/grafana` recebe o webhook do Grafana, exige
`Authorization: Bearer $GRAFANA_WEBHOOK_TOKEN`, normaliza o alerta e persiste o
estado em `state/incidents.json`. O fingerprint do Grafana (ou um hash estável
dos labels e título) é a chave de deduplicação. Reenvios incrementam
`eventCount`; eles não representam novas investigações.

O ClickUp não participa deste fluxo. O incidente deve ser convertido para o
mesmo contexto de diagnóstico usado pelo runner, mas sem atualizar status,
campos ou comentários no ClickUp.

## Vetores e Google Chat

O diagnóstico continua obrigado a emitir o marcador `<!-- VECTOR: ... -->`.
Depois de canonicalizado contra `DIAGNOSIS_VECTORS`, o vetor seleciona o espaço
de destino. Use o mapa já existente `GOOGLE_CHAT_VECTOR_SPACES_JSON`:

```json
{
  "Sequências": ["spaces/platform"],
  "Conversas/Métricas": ["spaces/engagement"]
}
```

O vetor é a fonte de roteamento humano. A regra do Grafana pode sugerir um
`team`, mas não substitui a classificação produzida pelo diagnóstico. O mapa
usado é o mesmo `GOOGLE_CHAT_VECTOR_SPACES_JSON` do fluxo de tickets.

## Issue no GitHub

Depois do diagnóstico, o runner cria uma issue idempotente quando a ação técnica
retornada pela IA identifica um repositório disponível. O contexto inclui os
repositórios encontrados em `DRIVA_REPOS_DIR` e o `service-map.md` da skill
`driva-debug`. A IA precisa retornar confiança alta e os nomes relativos exatos;
caso contrário a execução registra diagnóstico inconclusivo e não cria issue.

Os remotes Git são usados para obter o slug GitHub, então não é necessário um
mapa de repositórios adicional. A URL é salva em `results/<incident-id>/github-issue.json` e incluída no
artefato `ticket.json` sintético. A remediação continua independente: ela roda
depois e abre PRs, sem merge ou deploy.

O modo `--incident-id` lê o artefato persistido, executa a mesma skill
`driva-debug`, usa ClickStack pelas ferramentas do projeto, grava os artefatos e
notifica o Google Chat. A remediação roda em `auto`, abrindo PRs sem merge ou
deploy.
