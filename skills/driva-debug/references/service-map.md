# Mapa de serviços (exemplo fictício)

> Substitua por um mapa real do seu ambiente. Os nomes abaixo são ilustrativos.

## Sumário

- [Visão geral](#visão-geral)
- [web-app](#web-app) · [orders-api](#orders-api) · [notifier-worker](#notifier-worker)
- [Como ampliar o mapa](#como-ampliar-o-mapa)

## Visão geral

    web-app ──HTTP──> orders-api ──fila──> notifier-worker ──> provedor de e-mail (terceiro)
                         │
                         └──> Postgres (orders)

## web-app

- Frontend (React). Repositório: `web-app`. Evidências: sessões do usuário, erros de console, chamadas HTTP.

## orders-api

- API (Node/NestJS). Repositório: `orders-api`. Banco: Postgres `orders` (leitura via `orders-db-read`).
- Logs: ClickHouse/OpenTelemetry, serviço `orders-api` (leitura via `orders-logs-read`).

## notifier-worker

- Worker (Go) que consome a fila `notifications`. Repositório: `notifier-worker`.
- Falhas típicas: mensagem rejeitada pelo provedor, retry esgotado, payload inválido.

## Como ampliar o mapa

Para cada serviço novo: nome do repositório, responsabilidade, entradas/saídas, bancos e filas,
skills de leitura disponíveis e playbooks relacionados.
