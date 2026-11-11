# driva-ops-agent — Agente de Diagnóstico de Bugs em Softwares de Produção

Artefato do Trabalho de Conclusão de Curso **"Agente de Diagnóstico de Bugs em Softwares de Produção"**
(Universidade Tecnológica Federal do Paraná — UTFPR), de **Rodrigo Alves Miranda** e **Brian Leão**,
sob orientação do **Prof. Alexandre Graeml**. Metodologia: **Design Science Research (DSR)**.

O agente foi desenvolvido e operado na Driva, que autorizou esta publicação. Este repositório é um
**snapshot sanitizado** do repositório privado (commit-base `0ef3381`, 05/11/2026), **sem histórico git**,
sem dados de clientes e sem detalhes de infraestrutura (ver [O que foi anonimizado](#o-que-foi-anonimizado)).

## Pergunta de pesquisa

Em que medida uma arquitetura de agente baseada em LLM, com recuperação contextual em múltiplas fontes e
memória persistente, viabiliza o diagnóstico rastreável de bugs relatados em software em produção, e quais
fontes de contexto e mecanismos de controle se mostram determinantes para que esse diagnóstico seja útil e
seguro?

## Arquitetura

```
ClickUp (ticket)        Grafana (alerta/webhook)        Google Chat (comandos)
        \                       |                              /
         v                      v                             v
   ┌──────────────────────── Runner (NestJS) ───────────────────────────┐
   │ seleção de tickets (cron) · incidentes · comunicação · manutenção  │
   │ memória persistente: state/*.json (runs, aprovações, locks, threads)│
   └──────────────────────────────┬─────────────────────────────────────┘
                                  v
        Agente LLM (Codex CLI ou Claude Code) em sandbox SOMENTE LEITURA
        skills de contexto: skills/driva-debug, kubernetes-observability-read
          ├─ código-fonte e histórico git/PRs dos serviços (clones em repos/)
          ├─ bancos de dados (credenciais read-only, wrappers aprovados)
          ├─ logs e rastros (ClickHouse/OpenTelemetry), métricas/Kubernetes
          ├─ sessões do cliente
          └─ ticket e anexos
                                  v
     Diagnóstico estruturado: classificação, causa raiz, evidências,
     fontes consultadas/indisponíveis, decisão, repositórios afetados
                                  v
     Card no Google Chat → assunção/aprovação humana → comentário ao atendimento
                                  v
     Remediação: branch + Pull Request por repositório (nunca merge ou deploy automático)
```

Principais módulos em `src/`: `diagnosis` (execução e artefatos do diagnóstico), `remediation` (planos e
PRs), `incidents` (alertas do Grafana), `impact` (impacto no cliente), `communication` (comunicados
internos), `google-chat` (cards, threads, comandos), `clickup`, `github` (GitHub App, tokens de curta
duração), `git`, `state` (memória persistente com escrita atômica e locks), `storage-maintenance`,
`runner`, `codex`, `claude`, `common/sanitize` (redação de segredos em saídas).

### Salvaguardas

- Perfis de sandbox com rede e filesystem restritos (`.codex/config.toml`, `docker/codex/config.toml`).
- Credenciais de banco somente leitura; segredos montados como arquivos read-only no container.
- GitHub App com token de instalação de curta duração, renovado sob demanda.
- Sanitização de tokens/segredos em logs, estado e artefatos (`src/common/sanitize.ts`).
- Aprovação/assunção humana antes de comunicar ao atendimento; remediação apenas via Pull Request.

## Como rodar

Requisitos: Node.js ≥ 20 (imagem usa 24). Para execuções reais: Codex CLI ou Claude Code, `gh` e acesso
somente leitura às fontes de contexto.

```bash
npm ci
npm test              # suíte vitest, sem dependências externas
npm run lint
npm run build
cp .env.example .env  # todos os valores são placeholders; preencha com os do seu ambiente
mkdir -p repos/.codex && cp -r skills repos/.codex/skills   # ou defina CODEX_HOME
npm run dry-run       # ciclo de seleção/diagnóstico sem efeitos colaterais
npm start             # API HTTP + agendadores
```

As skills em `skills/` mantêm a **estrutura** das usadas em produção, mas descrevem **serviços
fictícios** (`web-app`, `orders-api`, `notifier-worker`). Para outro ambiente, escreva o seu mapa de
serviços e playbooks.

`scripts/extrair_indicadores_tcc.py` recalcula os indicadores de uso do TCC a partir de `results/` e
`state/` (diretórios não incluídos aqui, por conterem dados reais).

## O que foi anonimizado

| Categoria                                                                   | Tratamento                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Hosts, domínios e IPs internos, VPN, host de deploy                         | removidos ou substituídos por `*.example.internal` / `10.0.0.1`                            |
| Mapa de serviços, bancos, esquema de logs e playbooks internos              | substituídos por skills de exemplo fictícias                                               |
| Nomes de repositórios internos e organização GitHub                         | `service-NN` / `example-org`                                                               |
| E-mails de pessoas                                                          | `pessoaN@example.com`                                                                      |
| Nomes de pessoas e logins em fixtures de teste                              | nomes e logins fictícios                                                                   |
| IDs de ClickUp (tickets, workspace, listas, campos) e spaces do Google Chat | placeholders (`86tktNNNN`, `TICKET-1000N`, `SPACE_ID_N`, UUIDs zerados)                    |
| Documentos de deploy, onboarding, handoffs e calibração com casos reais     | removidos                                                                                  |
| Resultados de diagnóstico, estado de produção, amostras de avaliação        | não incluídos                                                                              |
| Histórico git (commits, PRs, autores)                                       | não incluído; ver [docs/fases-desenvolvimento.md](docs/fases-desenvolvimento.md)           |
| Tokens/chaves nos testes                                                    | mantidos: são **fixtures falsas** que testam a sanitização (allowlist em `.gitleaks.toml`) |

Nomes de variáveis de ambiente (ex.: `*_PG_HOST`) foram mantidos porque o código os referencia; não
contêm valores.

## Fases de desenvolvimento

Resumo; detalhes e hashes do repositório privado em [docs/fases-desenvolvimento.md](docs/fases-desenvolvimento.md).

| Fase                                                | Período (2026) |
| --------------------------------------------------- | -------------- |
| Runner inicial: diagnóstico e remediação            | 22/07–31/07    |
| Deploy e entrada em produção (1ª execução em 02/08) | 01/08–05/08    |
| Vetores, threads e reorientação                     | 26/08–31/08    |
| Agente de incidentes Grafana                        | 15/09–22/09    |
| Refatoração em 13 etapas                            | 22/09–28/09    |
| Robustez: autenticação, concorrência, armazenamento | 28/09–06/10    |
| Comunicação ao atendimento                          | 07/10–20/10    |
| Runtime Claude, mídia e API de comunicação          | 28/10–05/11    |

Modelos em produção: `gpt-5.6-sol` (02/08–21/09), `gpt-6-astra` (a partir de 22/09), `claude-opus-5-5`
(a partir de 01/11). Os indicadores do TCC cobrem 02/08–30/10/2026 (somente Codex).

## Como citar

ABNT:

> MIRANDA, Rodrigo Alves; LEÃO, Brian. **driva-ops-agent**: agente de diagnóstico de bugs em softwares de
> produção. 2026. Software (snapshot sanitizado, base privada `0ef3381`). Disponível em:
> https://github.com/<usuario-github>/driva-ops-agent. Acesso em: <dd mmm. aaaa>.

BibTeX:

```bibtex
@software{miranda_leao_2026_driva_ops_agent,
  author  = {Miranda, Rodrigo Alves and Leão, Brian},
  title   = {driva-ops-agent: Agente de Diagnóstico de Bugs em Softwares de Produção},
  year    = {2026},
  url     = {https://github.com/<usuario-github>/driva-ops-agent},
  version = {<hash-do-commit-publico>},
  note    = {Artefato de TCC, UTFPR. Orientador: Alexandre Graeml}
}
```

## Licença

MIT — ver [LICENSE](LICENSE). Publicado com autorização da Driva. O nome e a marca "Driva" não são
licenciados.
