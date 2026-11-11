Use $driva-debug para avaliar exclusivamente o impacto no cliente do bug confirmado abaixo.
Este fluxo só é elegível quando `existing_run.classification` é `bug`; outras classificações
não possuem score de impacto e são ignoradas pelo runner.

Trabalhe em modo somente leitura. Não altere banco, filas, serviços, tickets, mensagens,
sequências, canais, código ou repositórios. Não execute retries, requeues, deploys ou
restarts. O diagnóstico existente é uma fonte importante, mas não é infalível. Consulte
banco, logs, traces, client sessions, código ou Git somente quando necessário para confirmar
alcance, consequência, jornada, duração, incidência ou recuperação. Registre como limitação
qualquer fonte histórica que já não esteja disponível.

Avalie o dano que realmente ocorreu ao cliente, não esforço técnico, prioridade, ARR,
tier, pressão do solicitante ou risco comercial. Não produza a nota final: o runner fará
a matemática deterministicamente.

Cada dimensão de 0 a 4 tem uma responsabilidade exclusiva:

- `reach` responde somente quantas contas ou pessoas clientes únicas foram afetadas entre
  as elegíveis para a capacidade. 0 nenhum cliente confirmado; 1 uma conta/usuário ou <1%;
  2 poucas contas/múltiplos usuários ou 1–5%; 3 múltiplas contas/segmento ou >5–25%;
  4 mais de 25%, múltiplos segmentos ou abrangência sistêmica. Não use quantidade de leads,
  mensagens, jobs, tentativas ou outras operações para aumentar alcance; isso pertence a
  `incidence`. Sem denominador entre clientes, use a melhor aproximação verificável e reduza
  a confiança.

- `functional_consequence` responde somente o que ocorreu com o resultado de uma operação
  ou objetivo de negócio afetado, considerando o efeito realmente percebido de retries e
  contornos seguros disponíveis. 0 resultado correto sem efeito confirmado; 1 resultado
  correto com fricção leve, problema de apresentação ou retry simples e completo; 2 objetivo
  alcançado com retrabalho/contorno ou resultado utilizável mas incompleto; 3 objetivo não
  alcançado na janela relevante ou resultado materialmente incorreto/perdido; 4 efeito
  indevido ou destrutivo, como ação não solicitada, corrupção, exclusão, comunicação externa
  incorreta, exposição ou efeito financeiro indevido. Não aumente este nível por alcance,
  quantidade de ocorrências, duração, importância da jornada ou esforço interno de correção.

- `journey_criticality` responde somente a importância intrínseca da capacidade no produto,
  imaginando-a funcionando normalmente. 0 fora da jornada; 1 conveniência, apresentação ou
  função administrativa periférica; 2 capacidade de apoio com caminho normal alternativo;
  3 etapa importante de uma jornada principal; 4 capacidade central diretamente prometida
  pelo produto. Não use magnitude do incidente, workaround criado para o incidente, alcance,
  duração, frequência, ARR ou tier.

- `duration` responde somente por quanto tempo o resultado do cliente permaneceu comprometido.
  0 nenhum período confirmado; 1 efeito breve encerrado no mesmo contexto de uso; 2 até um
  dia; 3 mais de um e até sete dias; 4 mais de sete dias ou impacto ainda ativo sem prazo.
  Meça o tempo do efeito até restauração, expiração da necessidade ou mitigação, não idade do
  ticket, número de ocorrências ou tempo técnico de correção depois que o cliente foi mitigado.

- `incidence` responde somente qual proporção dos objetivos/operações de negócio elegíveis
  apresentou o efeito na janela medida. 0 nenhuma ocorrência confirmada; 1 isolada ou <1%;
  2 de 1–5%; 3 >5–25%; 4 >25% ou falha praticamente determinística para a condição elegível.
  Use operações de negócio, não eventos de log ou retries técnicos. Não use contas únicas,
  gravidade do resultado ou duração para aumentar incidência.

Registre recuperação como contexto suplementar, nunca como dimensão ou contribuição ao score:
`mode` é `automatic`, `simple_retry`, `supported_workaround`, `assisted_manual` ou `none`;
`completeness` é `complete`, `partial` ou `impossible`; `customer_effort` é `none`, `low`
ou `high`; `residual_loss` é booleano. A recuperação ajuda a justificar a consequência
funcional. Esforço exclusivamente interno, invisível ao cliente, não altera nenhuma dimensão.

Use `stage=initial` quando a avaliação depender principalmente do relato/anexo,
`stage=observed` quando houver evidência operacional do efeito e `stage=final` quando o
alcance e período total após mitigação estiverem fechados. Para esta base histórica,
prefira `final` somente se os artefatos realmente fecharem o período e o resultado.

A confiança do impacto é independente da confiança da causa: `high` exige pelo menos
duas fontes independentes e alcance/janela verificáveis; `medium` exige uma fonte
operacional forte com alguma lacuna; `low` é baseada principalmente no relato,
reprodução isolada ou dados incompletos. Falta de evidência não significa impacto zero.
Preencha contagens e janela apenas quando conhecidas; caso contrário use `null` e explique
em `limitations`. Em `sources`, liste somente fontes consultadas com sucesso.

Classifique também a atribuição causal separadamente do impacto: `PRODUCT_DEFECT` para
comportamento do produto divergente do esperado; `PRODUCT_DESIGN_GAP` para comportamento
implementado conforme projetado, mas inadequado à necessidade; `EXTERNAL_DEPENDENCY` para
falha primária de fornecedor/integração externa; `CUSTOMER_CONFIGURATION_OR_USE` para
configuração ou uso do cliente como causa predominante; `MIXED` quando há contribuição
material de mais de uma categoria; e `UNCONFIRMED` quando a causa não foi estabelecida.
Impacto alto pode existir sem defeito do produto. A atribuição não altera matematicamente
o score e deve ter justificativa própria.

Condições especiais só podem ser marcadas quando confirmadas e exigem
`functional_consequence` 3 ou 4: `SECURITY_OR_PRIVACY_EXPOSURE`,
`IRREVERSIBLE_DATA_LOSS`, `IMPROPER_FINANCIAL_ACTION` ou
`MASS_EXTERNAL_COMMUNICATION`.

Responda somente com o bloco abaixo, sem texto antes ou depois:

<!-- CUSTOMER_IMPACT_START -->
{
  "stage": "initial|observed|final",
  "confidence": "low|medium|high",
  "attribution": "PRODUCT_DEFECT|PRODUCT_DESIGN_GAP|EXTERNAL_DEPENDENCY|CUSTOMER_CONFIGURATION_OR_USE|MIXED|UNCONFIRMED",
  "attribution_rationale": "justificativa causal independente do impacto",
  "dimensions": {
    "reach": { "level": 0, "rationale": "justificativa", "evidence": ["evidência"] },
    "functional_consequence": { "level": 0, "rationale": "justificativa", "evidence": ["evidência"] },
    "journey_criticality": { "level": 0, "rationale": "justificativa", "evidence": ["evidência"] },
    "duration": { "level": 0, "rationale": "justificativa", "evidence": ["evidência"] },
    "incidence": { "level": 0, "rationale": "justificativa", "evidence": ["evidência"] }
  },
  "recovery": {
    "mode": "automatic|simple_retry|supported_workaround|assisted_manual|none",
    "completeness": "complete|partial|impossible",
    "customer_effort": "none|low|high",
    "residual_loss": false
  },
  "measurement": {
    "affected_count": null,
    "eligible_count": null,
    "affected_accounts": null,
    "eligible_accounts": null,
    "affected_users": null,
    "eligible_users": null,
    "affected_operations": null,
    "eligible_operations": null,
    "unit": null,
    "window_start": null,
    "window_end": null,
    "sources": [],
    "limitations": []
  },
  "special_conditions": []
}
<!-- CUSTOMER_IMPACT_END -->

Artefatos históricos do ticket:

{{IMPACT_CONTEXT_JSON}}
