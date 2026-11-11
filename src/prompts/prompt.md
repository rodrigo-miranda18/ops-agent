Use $driva-debug para investigar o ticket abaixo.

A skill `driva-debug` está instalada em `$CODEX_HOME/skills/driva-debug/SKILL.md`, e
suas referências em `$CODEX_HOME/skills/driva-debug/references/` (`service-map.md` e
`playbooks.md`). Não procure esses arquivos dentro de `$CODEX_HOME/skills/.system/`.

Quando task_type for incident, o contexto veio do Grafana, não do ClickUp.
Use repository_candidates.repositories e repository_candidates.service_map para
orientar a investigação completa. Consulte ClickStack pelas skills dos projetos;
não presuma Loki ou Prometheus configurados. Labels do alerta são pistas, não prova
da causa. Em engineering-action.repositories retorne os nomes relativos EXATOS dos
repositórios disponíveis, com o responsável primário primeiro, e descreva em `role` e
`scope` o papel e o recorte específico de cada um no incidente. Justifique a seleção
nas evidências e use confiança alta somente após confirmar a fronteira no código.
O vetor continua sendo inferido após o diagnóstico, independentemente do repositório.

Trabalhe exclusivamente em modo somente leitura.
Não altere banco, filas, serviços, tickets, mensagens, sequências ou canais.
Não execute retries, requeues, deploys ou restarts.

Se uma skill, wrapper ou fonte de dados falhar, registre no diagnóstico qual fonte,
comando e erro ficaram indisponíveis, mas continue a investigação com todas as demais
fontes independentes elegíveis. Uma falha em client sessions não impede consultas de
Engagement, LinkedIn ou outros serviços, e vice-versa. Não generalize a falha de uma
fonte como indisponibilidade de toda a observabilidade.

Produza duas entregas: um diagnóstico técnico e um comentário para o CS responsável
pelo ticket, além de uma decisão estruturada de engenharia. Classifique o caso em exatamente uma destas categorias:

- BUG: há evidência de comportamento incorreto do produto.
- MAL_ENTENDIDO: o produto aparenta funcionar como previsto e a dúvida decorre de expectativa ou uso.
- MAL_ENTENDIDO_COM_OPORTUNIDADE: o produto funciona como previsto, mas a dúvida é razoável e revela oportunidade concreta de melhorar UX, comunicação ou comportamento do produto.
- INCONCLUSIVO: não há evidência suficiente para uma classificação segura.

Depois de concluir a investigação, classifique também o vetor responsável pelo caso em
exatamente um destes valores:

{{DIAGNOSIS_VECTOR_OPTIONS}}

O campo `vectors` recebido no ticket é somente o valor preenchido previamente no
ClickUp e pode estar errado. Não o use como premissa nem como evidência. Determine o
vetor somente depois do diagnóstico, pela causa e pela superfície do produto efetivamente
afetada. Em casos que atravessam mais de uma área, escolha o vetor primário responsável
pelo comportamento diagnosticado.

O diagnóstico técnico deve ser objetivo e incluir resumo, evidências, causa provável,
grau de confiança, fontes consultadas e próximos passos seguros.

No diagnóstico técnico, registre de forma compacta e verificável:

1. **Fontes consultadas:** liste separadamente as fontes que realmente foram acessadas
   com sucesso, como banco, logs/traces, client session, código, Git e anexos. Identifique
   o serviço ou repositório e explique em uma frase curta o que cada fonte comprovou.
2. **Evidências técnicas:** ao usar banco, cite as tabelas ou coleções relevantes e o
   tipo de registro/filtro correlacionado, sem expor dados sensíveis nem despejar queries.
   Ao usar logs, cite o serviço, a janela temporal e os identificadores/eventos ou
   mensagens que sustentaram a decisão. Ao usar código ou Git, cite arquivo, componente
   ou mudança relevante.
3. **Fontes indisponíveis:** mantenha separadas das fontes consultadas com sucesso. Uma
   fonte indisponível é uma lacuna, não uma evidência. Não crie essa seção quando todas
   as fontes elegíveis funcionarem.

Não basta afirmar genericamente “banco e logs confirmam”. Dê nomes suficientes para um
desenvolvedor auditar o raciocínio, mas sem transformar o diagnóstico em um inventário
exaustivo de tabelas, linhas ou mensagens repetidas.

Depois do diagnóstico, decida se existe ação concreta no código:

- `CORRECTION_REQUIRED`: bug ou comportamento inesperado confirmado.
- `IMPROVEMENT_RECOMMENDED`: melhoria concreta e operacionalmente relevante.
- `NO_CODE_ACTION`: nenhuma mudança de código justificada.
- `INSUFFICIENT_EVIDENCE`: investigação incompleta; nunca recomende implementação.
- `ALREADY_FIXED`: a correção já está presente no código atual.

A confiança deve ser `low`, `medium` ou `high`. Só use confiança alta quando causa e
mudança estiverem sustentadas por evidência verificável. Em `repositories`, liste os
diretórios de repositório possivelmente afetados, relativos ao diretório de repositórios.
Cada entrada é um objeto com `name` (nome relativo do diretório), `role` (papel do
repositório na cadeia causal) e `scope` (o que precisa ser investigado ou corrigido nele).
Uma issue por repositório listado é aberta com esse recorte, então liste apenas os
repositórios que realmente precisam de ação e descreva cada escopo de forma autossuficiente.

Somente quando a classificação for `BUG`, calcule também os insumos do **Impacto do
Incidente no Cliente**. Para `MAL_ENTENDIDO`, `MAL_ENTENDIDO_COM_OPORTUNIDADE` ou
`INCONCLUSIVO`, omita completamente o bloco `CUSTOMER_IMPACT`; essas classificações não
possuem score de impacto. Em bugs confirmados, não produza a nota final: o runner fará a
matemática de forma determinística. Avalie cada dimensão de 0 a 4 e justifique com
evidências concretas:

- `reach` — mede somente contas e usuários clientes únicos afetados entre os elegíveis.
  0: nenhum confirmado; 1: uma conta/usuário ou <1%; 2: poucas contas/múltiplos usuários
  ou 1–5%; 3: múltiplas contas/segmento ou >5–25%; 4: mais de 25%, múltiplos segmentos
  ou abrangência sistêmica. Não use leads, mensagens, jobs, tentativas ou outras operações
  para aumentar alcance; a proporção de operações pertence a `incidence`.

O diagnóstico deve produzir os dados necessários para medir o alcance real. Quando as
fontes permitirem, agrupe o efeito por conta/workspace, `user_id` e operação, calculando
afetados e elegíveis na janela do incidente. Não se limite ao volume total de erros quando
os identificadores permitirem medir clientes distintos. Use `null` somente quando esses
dados realmente não estiverem disponíveis e registre o motivo em `limitations`.

- `functional_consequence` — mede somente o resultado de uma operação/objetivo afetado,
  considerando o efeito percebido de retries e contornos seguros: 0 resultado correto
  sem efeito; 1 resultado correto com fricção leve ou retry simples; 2 objetivo alcançado
  com retrabalho/contorno ou resultado utilizável mas incompleto; 3 objetivo não alcançado
  na janela relevante ou resultado materialmente incorreto/perdido; 4 efeito indevido ou
  destrutivo. Não aumente por alcance, frequência, duração ou importância da jornada.
- `journey_criticality` — mede somente a importância intrínseca da capacidade funcionando
  normalmente: 0 fora da jornada; 1 periférica/administrativa; 2 apoio com caminho normal
  alternativo; 3 etapa importante de jornada principal; 4 capacidade central prometida.
  Não considere a magnitude nem o workaround específico do incidente.
- `duration` — mede somente quanto tempo o resultado permaneceu comprometido: 0 nenhum
  período; 1 breve no mesmo contexto de uso; 2 até um dia; 3 mais de um e até sete dias;
  4 mais de sete dias ou ainda ativo. Não use idade do ticket nem número de ocorrências.
- `incidence` — mede somente operações/objetivos de negócio afetados entre os elegíveis:
  0 nenhuma ocorrência; 1 isolada ou <1%; 2 de 1–5%; 3 >5–25%; 4 >25% ou falha quase
  determinística. Não use eventos de log, retries técnicos, contas únicas, gravidade ou duração.

Registre recuperação separadamente, sem pontuação: `mode` (`automatic`, `simple_retry`,
`supported_workaround`, `assisted_manual`, `none`), `completeness` (`complete`, `partial`,
`impossible`), `customer_effort` (`none`, `low`, `high`) e `residual_loss` booleano.
Ela justifica a consequência funcional; esforço exclusivamente interno não altera o score.

Use `stage=initial` quando a avaliação depender principalmente do relato/anexo,
`stage=observed` quando houver evidência operacional do efeito e `stage=final` somente
quando alcance e período total após mitigação estiverem fechados. A confiança do impacto
é independente da confiança da causa: `high` exige ao menos duas fontes independentes e
alcance/janela verificáveis; `medium` exige uma fonte operacional forte, mas possui
lacuna relevante; `low` é baseada principalmente no relato, reprodução isolada ou dados
incompletos. Falta de evidência não significa impacto zero.

Preencha contagens e janela apenas quando conhecidas; caso contrário use `null` e registre
a lacuna em `limitations`. Em `sources`, liste somente fontes realmente consultadas com
sucesso. Condições especiais só podem ser marcadas quando confirmadas e exigem consequência
funcional 3 ou 4: `SECURITY_OR_PRIVACY_EXPOSURE`, `IRREVERSIBLE_DATA_LOSS`,
`IMPROPER_FINANCIAL_ACTION` ou `MASS_EXTERNAL_COMMUNICATION`. ARR, tier, pressão do
solicitante, esforço técnico e risco comercial não entram neste score.

Classifique a atribuição causal separadamente: `PRODUCT_DEFECT` (produto diverge do
esperado), `PRODUCT_DESIGN_GAP` (comportamento projetado, mas inadequado),
`EXTERNAL_DEPENDENCY`, `CUSTOMER_CONFIGURATION_OR_USE`, `MIXED` ou `UNCONFIRMED`.
Impacto alto pode existir sem defeito do produto; a atribuição não altera a nota e exige
uma justificativa própria.

O comentário para o CS deve ser conciso, mas substancial: normalmente entre 120 e 220
palavras, ajustando quando o caso realmente exigir menos ou mais. Ele deve permitir que
o CS entenda e demonstre ao cliente como chegamos à conclusão, sem precisar consultar o
diagnóstico técnico.

Inclua no comentário para o CS:

1. conclusão direta sobre o que aconteceu e, quando aplicável, o que não aconteceu;
2. de duas a quatro evidências concretas relevantes, como horários, duração, ação
   observada, etapa alcançada, resultado posterior ou estado atual;
3. distinção explícita entre fato confirmado e causa apenas provável;
4. situação atual do cliente/conta/fluxo;
5. orientação prática para o CS e eventual melhoria de produto registrada.

Traduza evidências técnicas para linguagem de negócio. Por exemplo, prefira “a tela de
login ficou disponível em cerca de sete segundos” a nomes de workers, filas ou eventos
internos. Não use nomes de serviços, tabelas, filas, logs, código, queries, stack traces,
siglas internas ou jargão de engenharia no comentário do CS. Não omita evidências apenas
para tornar o texto curto. Não afirme certeza quando a investigação for inconclusiva,
não prometa correção ou prazo que não esteja confirmado e não instrua o CS a executar
ações técnicas.

Estrutura recomendada para o comentário do CS:

- **O que identificamos:** conclusão em linguagem simples.
- **Evidências:** fatos concretos que sustentam a conclusão.
- **Situação atual e orientação:** estado atual e próximo passo seguro.

No formato abaixo, inclua `CUSTOMER_IMPACT` somente quando a classificação for `BUG`.
Nas demais classificações, passe diretamente de `CS_COMMENT_END` para
`ENGINEERING_ACTION_START`.

Responda obrigatoriamente no formato abaixo, preservando os marcadores HTML:

<!-- CLASSIFICATION: BUG|MAL_ENTENDIDO|MAL_ENTENDIDO_COM_OPORTUNIDADE|INCONCLUSIVO -->
<!-- TECHNICAL_DIAGNOSIS_START -->
Markdown do diagnóstico técnico
<!-- TECHNICAL_DIAGNOSIS_END -->
{{DIAGNOSIS_VECTOR_MARKER}}
<!-- CS_COMMENT_START -->
Markdown do comentário para o CS
<!-- CS_COMMENT_END -->
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
<!-- ENGINEERING_ACTION_START -->
{
  "decision": "CORRECTION_REQUIRED|IMPROVEMENT_RECOMMENDED|NO_CODE_ACTION|INSUFFICIENT_EVIDENCE|ALREADY_FIXED",
  "confidence": "low|medium|high",
  "summary": "resumo objetivo da ação",
  "reason": "fundamentação verificável ou motivo para não agir",
  "repositories": [{"name": "nome-do-repositorio", "role": "papel na cadeia causal", "scope": "recorte a investigar ou corrigir neste repositório"}]
}
<!-- ENGINEERING_ACTION_END -->

Dados normalizados do ticket:

Quando houver `attachments`, examine os arquivos locais indicados por `local_path` e
use seu conteúdo como evidência do diagnóstico. Imagens também são fornecidas
diretamente como contexto visual. Se algum anexo estiver indisponível ou com erro,
declare essa limitação; não invente seu conteúdo.

{{TICKET_JSON}}
