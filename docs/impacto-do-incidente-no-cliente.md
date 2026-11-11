# Impacto do incidente no cliente

## Objetivo

Substituir a leitura isolada de quantidade de tickets por uma medida do dano que bugs e incidentes realmente causam aos clientes. A métrica deve permitir:

- comparar incidentes diferentes com critérios consistentes;
- priorizar investigação, mitigação e correção;
- medir quanto impacto foi removido em um período;
- ser recalculada pelo agente conforme surgem evidências de banco, logs, traces e sessões do cliente;
- deixar explícito quando o valor é estimado ou tem baixa confiança.

O score mede **impacto observado do incidente**, não esforço técnico, prioridade comercial, tamanho do cliente ou benefício esperado de uma feature.

O score é produzido somente para tickets classificados como **bug confirmado**.
`Inconclusivo`, `Mal entendido` e `Mal entendido com oportunidade` não recebem score de
impacto. Uma eventual oportunidade de produto deve ser avaliada por benefício esperado,
não pela métrica de dano causado por incidente.

## Decisão de nomenclatura no ClickUp

Já existe o campo `Impacto no Cliente` (`00000000-0000-0000-0000-000000000003`), do tipo emoji 1–5 🚀, nos backlogs de produto. Ele aparenta representar o benefício esperado de uma feature e não está disponível atualmente na lista `Formulário de Tickets`.

Para não misturar benefício potencial de feature com dano realizado por bug, a recomendação é criar nos tickets:

- **`Impacto do Incidente`**: número inteiro de 0 a 100;
- **`Confiança do Impacto`**: Baixa, Média ou Alta;
- opcionalmente, **`Faixa de Impacto`**: Baixo, Moderado, Alto ou Crítico.

O campo existente `Criticidade` deve continuar separado. Criticidade representa urgência/prioridade operacional e pode considerar SLA, cliente estratégico e risco comercial; `Impacto do Incidente` representa somente o efeito no uso do produto.

## Modelo recomendado

O score é composto por cinco dimensões, cada uma avaliada de 0 a 4.

### Implementação v1.2

A implementação separa julgamento e matemática:

1. o agente produz níveis, justificativas, evidências, medição, confiança e condições especiais;
2. `src/impact/customer-impact.mjs` valida esses insumos e calcula o score deterministicamente;
3. o snapshot atual é salvo em `results/<ticket-id>/customer-impact.json`;
4. todas as iterações são preservadas em `customer-impact-history.json`, sem apagar avaliações anteriores;
5. `run.json` recebe score, faixa, confiança e versão resumidos para consultas e relatórios;
6. a atribuição causal é registrada separadamente e não altera a nota de impacto.

O agente não informa a nota final e não pode alterar pesos ou limitadores. A versão atual
da rubrica é `1.2.0`. A v1.2 substitui severidade funcional por consequência funcional,
separa duração de incidência e mantém recuperação como contexto não ponderado. Snapshots
históricos preservam a versão e as dimensões com que foram produzidos.

| Dimensão               | Peso | Pergunta respondida                                                    |
| ---------------------- | ---: | ---------------------------------------------------------------------- |
| Alcance                |  25% | Quantas contas ou pessoas clientes únicas foram afetadas?              |
| Consequência funcional |  30% | O que ocorreu com o resultado de uma operação/objetivo afetado?        |
| Criticidade da jornada |  25% | Qual é a importância intrínseca da capacidade no produto?              |
| Duração                |  10% | Por quanto tempo o resultado permaneceu comprometido?                  |
| Incidência             |  10% | Qual proporção das operações de negócio elegíveis apresentou o efeito? |

### Fórmula

```text
score_bruto =
    25 × alcance / 4
  + 30 × consequência / 4
  + 25 × jornada / 4
  + 10 × duração / 4
  + 10 × incidência / 4

Impacto do Incidente = arredondar(score_bruto), após aplicar os limitadores
```

### 1. Alcance

Alcance mede principalmente quantas **contas e pessoas clientes** foram atingidas. Usar
preferencialmente a proporção da população de clientes elegível para o fluxo, não a base
total. Contagens de leads, mensagens, ações e outras operações alimentam incidência, não
alcance ou consequência. Elas não tornam um caso restrito a uma única conta sistêmico
entre clientes.

| Nível | Definição orientativa                                                                                       |
| ----: | ----------------------------------------------------------------------------------------------------------- |
|     0 | Nenhum cliente afetado foi confirmado.                                                                      |
|     1 | Isolado: uma conta/usuário ou menos de 1% da população de clientes elegível.                                |
|     2 | Limitado: múltiplos usuários em uma ou poucas contas, ou 1% a 5%.                                           |
|     3 | Amplo: múltiplas contas, um segmento elegível, ou mais de 5% até 25%.                                       |
|     4 | Sistêmico: mais de 25% entre clientes, múltiplos segmentos ou indisponibilidade generalizada da plataforma. |

Os percentuais são o critério principal. Contagens absolutas servem como aproximação quando o denominador não estiver disponível, reduzindo a confiança do cálculo.

O snapshot mantém contagens específicas de contas, usuários e operações afetadas/elegíveis.
Os campos genéricos `affected_count`, `eligible_count` e `unit` continuam disponíveis para
compatibilidade, mas não devem ocultar qual população foi medida.

## Atribuição causal, separada do impacto

O score responde “quanto dano ocorreu?”, enquanto a atribuição responde “qual foi a
causa predominante?”. Um incidente pode ter impacto crítico mesmo quando o produto se
comportou conforme projetado ou quando a origem foi externa. Misturar as duas perguntas
reduziria artificialmente o dano observado e prejudicaria a priorização do atendimento.

| Atribuição                      | Uso                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `PRODUCT_DEFECT`                | O produto divergiu do comportamento esperado.                                        |
| `PRODUCT_DESIGN_GAP`            | O comportamento foi implementado conforme projetado, mas é inadequado à necessidade. |
| `EXTERNAL_DEPENDENCY`           | A falha primária ocorreu em fornecedor ou integração externa.                        |
| `CUSTOMER_CONFIGURATION_OR_USE` | Configuração ou uso do cliente foi a causa predominante.                             |
| `MIXED`                         | Mais de uma categoria contribuiu materialmente.                                      |
| `UNCONFIRMED`                   | As evidências não permitem estabelecer a causa.                                      |

A atribuição exige justificativa auditável, mas não entra na fórmula.

### 2. Consequência funcional

Mede somente o resultado de uma operação ou objetivo de negócio afetado. Retries e
contornos entram pelo efeito realmente percebido pelo cliente, não por uma segunda nota.

| Nível | Definição                                                                                                                                        |
| ----: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
|     0 | Resultado correto, sem efeito confirmado para o cliente.                                                                                         |
|     1 | Resultado correto com fricção leve, problema de apresentação ou retry simples e completo.                                                        |
|     2 | Objetivo alcançado com retrabalho/contorno, ou resultado utilizável mas incompleto.                                                              |
|     3 | Objetivo não alcançado na janela relevante, ou resultado materialmente incorreto/perdido.                                                        |
|     4 | Efeito indevido ou destrutivo: ação não solicitada, corrupção, exclusão, comunicação externa incorreta, exposição ou efeito financeiro indevido. |

Não entram nesta dimensão quantidade de clientes, número de ocorrências, duração,
importância da jornada nem esforço interno de correção.

### 3. Criticidade da jornada

| Nível | Definição                                                                               |
| ----: | --------------------------------------------------------------------------------------- |
|     0 | Não afeta uma jornada de cliente.                                                       |
|     1 | Conveniência, apresentação ou função administrativa periférica.                         |
|     2 | Etapa de apoio; existe outro caminho normal para atingir o objetivo.                    |
|     3 | Etapa importante de uma jornada principal.                                              |
|     4 | Capacidade central prometida pelo produto e diretamente ligada ao resultado do cliente. |

Esta dimensão é avaliada imaginando a capacidade funcionando normalmente. Ela não usa
magnitude do incidente, workaround específico, alcance, duração, ARR ou tier. Consequência
funcional avalia **o que aconteceu**; jornada avalia **a importância do que foi atingido**.

### 4. Duração

| Nível | Definição orientativa                                        |
| ----: | ------------------------------------------------------------ |
|     0 | Nenhum período de impacto confirmado.                        |
|     1 | Efeito breve, encerrado no mesmo contexto de uso.            |
|     2 | Efeito de até um dia.                                        |
|     3 | Mais de um dia e até sete dias.                              |
|     4 | Mais de sete dias ou efeito ainda ativo sem prazo conhecido. |

A duração termina na restauração, expiração da necessidade ou mitigação do cliente. Não usa
idade do ticket, número de ocorrências ou tempo técnico de correção após mitigação.

### 5. Incidência

Mede operações ou objetivos de negócio afetados entre os elegíveis na janela. Eventos de
log e retries técnicos não são unidades independentes.

| Nível | Definição                                                                  |
| ----: | -------------------------------------------------------------------------- |
|     0 | Nenhuma ocorrência afetada confirmada.                                     |
|     1 | Ocorrência isolada ou menos de 1% das operações elegíveis.                 |
|     2 | De 1% a 5%.                                                                |
|     3 | Mais de 5% até 25%.                                                        |
|     4 | Mais de 25% ou falha praticamente determinística para a condição elegível. |

Contas únicas pertencem a alcance; magnitude do resultado pertence a consequência;
tempo pertence a duração.

## Recuperação, sem peso

Recuperação é armazenada como contexto auditável: modo (`automatic`, `simple_retry`,
`supported_workaround`, `assisted_manual`, `none`), completude (`complete`, `partial`,
`impossible`), esforço do cliente (`none`, `low`, `high`) e presença de perda residual.
Esses dados justificam a consequência funcional, mas não somam pontos. Esforço exclusivamente
interno, invisível ao cliente, não entra no score.

## Limitadores e casos especiais

Uma soma ponderada pura pode supervalorizar um problema cosmético muito disseminado. Aplicar estes limitadores:

- consequência funcional 0: score final 0;
- consequência funcional 1: score final máximo 39;
- consequência funcional 2: score final máximo 59;
- consequência funcional 4: score final mínimo 50 quando o efeito estiver confirmado;
- exposição de dados, violação de privacidade/segurança, perda irreversível de dados, ação financeira indevida ou comunicação externa indevida em massa: revisão humana obrigatória e score mínimo 75 quando confirmado.

`0` significa **ausência de impacto confirmada**. Falta de evidência não deve virar zero; deve produzir um score provisório com baixa confiança ou `não calculado`, conforme a quantidade de informação disponível.

## Faixas de leitura

|  Score | Faixa                  | Interpretação                                                       |
| -----: | ---------------------- | ------------------------------------------------------------------- |
|      0 | Sem impacto confirmado | O produto funcionou como esperado ou não houve efeito no resultado. |
|   1–24 | Baixo                  | Efeito isolado, breve ou de baixa severidade.                       |
|  25–49 | Moderado               | Degradação relevante, mas contida.                                  |
|  50–74 | Alto                   | Bloqueio/perda relevante, jornada importante ou alcance amplo.      |
| 75–100 | Crítico                | Dano sistêmico, grave, prolongado ou de confiança/segurança.        |

As faixas não devem substituir o score numérico nos cálculos.

## Confiança e evidências

A confiança é armazenada separadamente e **não multiplica nem reduz o score**. Reduzir matematicamente o impacto por falta de observabilidade faria incidentes pouco observáveis parecerem pouco importantes.

| Confiança | Regra sugerida                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| Alta      | Duas ou mais fontes independentes confirmam efeito, alcance e janela; há denominador elegível ou inventário confiável. |
| Média     | Uma fonte operacional forte confirma o efeito, mas falta denominador, janela completa ou segunda fonte independente.   |
| Baixa     | Cálculo baseado principalmente no relato do ticket, reprodução isolada ou evidências incompletas/contraditórias.       |

Toda atualização deve guardar um resumo auditável:

- valores das cinco dimensões;
- score e confiança;
- janela analisada;
- fontes usadas e fontes indisponíveis;
- numerador e denominador do alcance, quando conhecidos;
- motivo da mudança em relação à iteração anterior.

## Como o agente calcula a cada iteração

### Iteração inicial — estimativa

Usa descrição, anexos, comentários, cliente, produto e fluxo informados no ticket. O valor é provisório e normalmente tem confiança baixa. A ausência de outros relatos não prova alcance baixo.

### Após investigação — impacto observado atual

- **Banco:** identifica usuários, workspaces, entidades e operações afetadas; calcula população elegível e estados incorretos.
- **Logs/traces:** determina volume de falhas/sucessos, primeira e última ocorrência, recorrência e serviços/etapas atingidos.
- **Client sessions:** confirma a experiência visível, o ponto da jornada, bloqueio, tentativas e eventual contorno.
- **Código e Git:** confirmam comportamento esperado, abrangência da condição e se a falha ainda existe; não substituem evidência de impacto em produção.

Se uma fonte falhar, ela deve ser registrada como indisponível. A falha de consulta nunca conta como evidência de ausência de impacto.

### Encerramento — impacto realizado final

Após mitigação/correção, recalcula-se o período total, alcance final e capacidade de recuperação. Esse snapshot final é o valor usado para métricas históricas. O score atual pode cair após a mitigação, mas o score final realizado não deve ser reescrito para zero: ele representa o dano que ocorreu antes da solução.

Recomenda-se manter pelo menos três snapshots no histórico do diagnóstico: `inicial`, `observado` e `final`. O campo visível do ClickUp pode mostrar o valor atual; o histórico estruturado preserva a evolução.

## Métricas agregadas recomendadas

Não usar apenas a média dos scores. Ela muda conforme a quantidade de tickets pequenos e não representa o impacto total.

1. **Carga de impacto aberta:** soma do score atual dos incidentes únicos ainda não mitigados.
2. **Impacto removido no período:** soma do score final realizado dos incidentes únicos mitigados/corrigidos no período.
3. **Tempo ponderado até mitigação:** `soma(score final × horas até mitigação) / soma(score final)`.
4. **Horas de alto impacto:** tempo acumulado com incidentes de score 50 ou mais ativos.
5. **Cobertura da métrica:** percentual de tickets elegíveis com score e percentual com confiança média/alta.
6. **Distribuição por faixa, produto, vetor e causa:** identifica onde o dano está concentrado.

### Evitar dupla contagem

Vários tickets podem representar o mesmo bug. Repetições devem aumentar a evidência de alcance, mas não somar o mesmo incidente várias vezes nas métricas agregadas. A evolução recomendada é introduzir um `ID do Incidente`/`Chave de causa` e agregar por incidente único. Enquanto isso não existir, relatórios devem deduplicar por causa, janela e comportamento afetado.

## O que não deve entrar no score

- esforço ou complexidade da correção;
- prioridade do roadmap;
- pressão do solicitante;
- ARR, tier ou tamanho comercial do cliente;
- risco de churn sem evidência de impacto no produto;
- quantidade de comentários no ticket;
- tempo do ticket no backlog, quando diferente do tempo real de exposição.

Esses elementos podem compor uma métrica separada de **Urgência de Negócio**. Separá-los evita que um problema grave em clientes pequenos pareça irrelevante e que qualquer demanda de uma conta estratégica pareça um incidente de produto grave.

## Exemplo

Uma falha atinge múltiplas contas e impede o envio de uma etapa de sequência em 8% das
operações elegíveis durante três dias. O fluxo é central e há apenas um contorno manual parcial:

| Dimensão               | Nível | Contribuição |
| ---------------------- | ----: | -----------: |
| Alcance                |     3 |        18,75 |
| Consequência funcional |     3 |        22,50 |
| Criticidade da jornada |     4 |        25,00 |
| Duração                |     3 |         7,50 |
| Incidência             |     3 |         7,50 |
| **Total**              |       |       **81** |

Resultado: `Impacto do Incidente = 81 (Crítico)`. A recuperação é registrada como
`assisted_manual`, `partial`, esforço `high` e eventual perda residual conforme a evidência.
A confiança será alta somente se o alcance, volume elegível, falhas, janela e efeito no
cliente estiverem confirmados por fontes independentes.

## Plano de calibração

Antes de usar o score como meta de desempenho:

1. aplicar retrospectivamente a 30–50 tickets variados e deduplicá-los por incidente;
2. fazer duas pessoas pontuarem uma amostra sem consultar a nota da outra;
3. revisar divergências maiores que 15 pontos e ajustar exemplos/limites, não notas individuais;
4. comparar as faixas com cancelamentos, escaladas, volume operacional afetado e tempo de mitigação;
5. rodar por duas a quatro sprints em modo informativo;
6. só então congelar a versão `v1` da rubrica e começar séries históricas comparáveis.

O objetivo inicial não é precisão matemática absoluta, mas consistência, auditabilidade e melhora progressiva com evidências reais.
