# Descoberta de schema (exemplo)

Antes de consultar, descubra colunas e chaves disponíveis:

    DESCRIBE TABLE otel_logs;
    SELECT arrayJoin(mapKeys(ResourceAttributes)) AS k, count() FROM otel_logs
    WHERE Timestamp > now() - INTERVAL 1 HOUR GROUP BY k ORDER BY 2 DESC LIMIT 50;

Use sempre janela de tempo e `LIMIT`. Nomes de tabelas e chaves variam por instalação.
