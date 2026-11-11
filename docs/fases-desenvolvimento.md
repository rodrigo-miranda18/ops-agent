# Fases de desenvolvimento

O histórico git não foi publicado. Os hashes curtos abaixo são do **repositório privado** (verificáveis
pelos autores mediante solicitação). Datas e horários em BRT (UTC-3), 2026.

| Fase                                                | Período     | Marcos (hash privado)                                                                                                                                                                                  |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runner inicial: diagnóstico e remediação            | 22/07–31/07 | `5a610e1` runner (22/07); `52afd93` NestJS v0.2.0 (23/07); `dbbf0a2` estágios/assumir (25/07); `d40017b` execução de diagnóstico + remediação (27/07)                                                  |
| Deploy e entrada em produção                        | 01/08–05/08 | `aecc100` preparação do deploy (01/08); `09c0c2b` (02/08 19:46); 1ª execução em produção 02/08 19:48; `4928bd5` review gate (04/08), revertido em `3c88591` (05/08)                                    |
| Vetores, threads e reorientação                     | 26/08–31/08 | `a572495` PR #1 vetor do ticket (26/08); `cd6cbf8` #3 threads no Google Chat (28/08); `fffa279` #4 reorientação de remediação (31/08)                                                                  |
| Agente de incidentes Grafana                        | 15/09–22/09 | `b285971` #6 (15/09) … `f8377cd` #16 (22/09)                                                                                                                                                           |
| Refatoração em 13 etapas                            | 22/09–28/09 | etapas 0–12; `b6f50dd` #17 e `051e2ec` #34 (28/09); `cd6bb6b` #29 e `8791c81` #31 (24–25/09)                                                                                                           |
| Robustez: autenticação, concorrência, armazenamento | 28/09–06/10 | `16b75de` #37 (28/09); `98ff67d` #40 GitHub App, `3e5202e` #41 concorrência, `a1c4cd9` #42 manutenção de armazenamento (03/10); `fdf4cd0` #45 remediação em etapas, revertida em `989ca89` #48 (06/10) |
| Comunicação ao atendimento                          | 07/10–20/10 | `07e2ca0` #51 (07/10) … `9619b94` #58 (20/10)                                                                                                                                                          |
| Runtime Claude, mídia e API de comunicação          | 28/10–05/11 | `1644340` #60 proxy LLM (28/10); `2e24d33` #61 runtime Claude (31/10 23:48); `0f61ed8` #62 e `54b35a9` #63 mídia (01/11); `0ef3381` #66 API de comunicação (05/11)                                     |

## Modelos em produção

Obtidos do cabeçalho `model:` dos logs de cada execução. A troca para `gpt-6-astra` foi feita por
variável de ambiente, sem commit.

| Modelo                          | Período                                                               | Relação com o git                                                            |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `gpt-5.6-sol` (Codex)           | 02/08 a 21/09 (último ticket 21/09 16:53; incidentes até 22/09 17:24) | default em `docker/codex/config.toml` desde `aecc100`                        |
| `gpt-6-astra` (Codex)           | a partir de 22/09, entre 17:24 e 17:37                                | troca por ambiente; coincide com os merges `f6ac5fc` (#15) e `f8377cd` (#16) |
| `claude-opus-5-5` (Claude Code) | a partir de 01/11 00:23                                               | após `2e24d33` (#61); default `CLAUDE_MODEL` em `.env.example`               |

Commits na branch principal por mês: jul 6, ago 46, set 147, out 113, nov 11.
