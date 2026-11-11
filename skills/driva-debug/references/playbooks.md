# Playbooks de roteamento (exemplo fictício)

## Sumário

- Sintoma visual ou ação no frontend
- Pedido não foi criado
- Notificação não chegou
- Métricas ou histórico divergentes

## Sintoma visual ou ação no frontend

1. Confirmar o fluxo na sessão do usuário. 2. Identificar a chamada HTTP e o status. 3. Seguir para `orders-api`.

## Pedido não foi criado

1. Buscar a requisição nos logs de `orders-api` pela janela do ticket (UTC). 2. Conferir o registro no banco
   (somente leitura). 3. Correlacionar com deploys/commits recentes.

## Notificação não chegou

1. Verificar a publicação na fila. 2. Verificar consumo e erros em `notifier-worker`. 3. Checar resposta do provedor.

## Métricas ou histórico divergentes

Comparar a fonte de verdade (banco) com a agregação exibida; procurar filtros de fuso horário e janelas.
