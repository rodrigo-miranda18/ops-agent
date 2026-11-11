---
name: driva-debug
description: Orquestra o diagnóstico somente leitura de tickets e incidentes em produção — classifica o relato, localiza os repositórios no workspace local, usa skills de debug específicas de cada repositório (logs, banco, sessões) e entrega um diagnóstico rastreável com evidências. VERSÃO DE EXEMPLO com serviços fictícios; substitua pelo mapa real do seu ambiente.
---

# Driva Debug (exemplo público)

> Esta é uma versão **anonimizada e fictícia** da skill usada em produção. A estrutura de seções,
> as regras e o fluxo são os mesmos; serviços, bancos e playbooks foram substituídos por exemplos.

Orquestrar o diagnóstico ponta a ponta. Começar com uma hipótese de roteamento, mas ampliar o escopo
sempre que a evidência revelar outro serviço, fila, callback ou dependência.

## Preparar o workspace

- Os repositórios ficam em `$DRIVA_REPOS_DIR` (um clone por serviço; ver `references/service-map.md`).
- Ler o `AGENTS.md` e as skills `.codex/skills/*` de cada repositório envolvido antes de consultar dados.

## Regras centrais

- **Somente leitura.** Nunca escrever em banco, fila, cache, cluster ou API de terceiros. Nunca reprocessar.
- Usar apenas os wrappers de consulta aprovados de cada repositório (credenciais read-only).
- Toda afirmação precisa de evidência citável (consulta, arquivo:linha, commit, log com horário em UTC).
- Separar **fato**, **inferência**, **hipóteses descartadas** e **lacunas**.
- Não copiar dados pessoais de clientes para o diagnóstico; referenciar por ID.

### Isolar falhas de fonte

Se uma fonte (banco, logs, sessões) estiver indisponível, registrar em "Fontes indisponíveis" e seguir
com as demais. Nunca concluir "sem erro" a partir de uma fonte que falhou.

## Fazer a triagem

1. Extrair do ticket: produto/área, conta/usuário (IDs), horário, passos, mensagem de erro, anexos.
2. Classificar a hipótese inicial: bug, mal-entendido, mal-entendido com oportunidade, inconclusivo.
3. Escolher o playbook em `references/playbooks.md`.

### Avaliar sessão do cliente

Quando houver gravação/sessão do usuário, usá-la para confirmar o fluxo real antes de olhar o código.

## Escolher o ponto de entrada

Partir do serviço que recebe a ação do usuário (ver mapa) e seguir as chamadas até a falha.

## Investigar por fronteiras

Para cada fronteira (frontend → API → fila → worker → terceiro), confirmar entrada e saída com evidência.

### Incidentes de runtime Kubernetes

Para alertas de pod/probe/restart, usar a skill `kubernetes-observability-read`.

### Regra de expansão dinâmica

Se a evidência apontar para um serviço fora da hipótese, incluí-lo e registrar o motivo.

## Usar skills especializadas

Cada repositório pode trazer skills próprias (ex.: `orders-logs-read`, `orders-db-read`). Preferi-las a
consultas improvisadas.

## Validar hipótese e regressão

- Localizar o commit/PR que introduziu o comportamento (`git log -S`, `git blame`).
- Verificar se já existe correção em branch ou PR aberto.

## Entregar o diagnóstico

Seções obrigatórias: Resumo, Classificação, Causa raiz, Evidências, **Fontes consultadas**,
Fontes indisponíveis, Decisão (correção necessária | melhoria recomendada | sem ação de código |
evidência insuficiente | já corrigido), Repositórios afetados, Proposta de correção, Comentário ao atendimento.
