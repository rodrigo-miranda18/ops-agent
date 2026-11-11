Use $driva-communication para redigir a comunicação interna da funcionalidade descrita
no contexto abaixo.

A skill `driva-communication` está instalada em
`$CODEX_HOME/skills/driva-communication/SKILL.md`, com exemplos em
`$CODEX_HOME/skills/driva-communication/references/examples.md`. Não procure esses
arquivos dentro de `$CODEX_HOME/skills/.system/`.

Trabalhe exclusivamente em modo somente leitura. Não altere código, repositórios,
branches, PRs, tickets, banco, filas, serviços ou mensagens.

## Entrada

O diretório `context/` contém:

- `clickup.json`: a task do ClickUp, suas subtasks (spec, tarefas técnicas e tickets de
  melhoria), os comentários e os avisos da coleta. `task.communicationSize` é o tamanho
  da comunicação (`P`, `M` ou `G`), lido do campo "Comunicação Cliente", ou `null`
  quando o campo não tem um desses valores;
- `pull-requests/*.json`: um arquivo por PR citado no ClickUp, com título, corpo, estado,
  arquivos alterados e diff truncado. O diretório pode estar vazio;
- `history.json`: lista de `{ version, status, feedback, output }` em ordem de versão.
  `feedback` é o pedido do PM que originou aquela versão, `status` é `ready` quando ela
  gerou uma comunicação ou `failed` quando falhou, e `output` é o JSON que ela gerou
  (`null` se falhou). O último item é a versão atual, com `status: null` e
  `output: null`, e o `feedback` dele é o ajuste a aplicar agora. Não existe na primeira
  geração;
- `warnings.json`, quando existir: itens que não puderam ser coletados.

As imagens anexadas a esta execução são as imagens da task e das subtasks. Use-as como
contexto visual da interface, não como prova de comportamento. `context/images.json` lista
essas imagens na mesma ordem, com o `index` de cada uma.

## Regras

- Siga o método e o formato da skill `driva-communication`.
- Se `context/pull-requests/` estiver vazio, busque a implementação com `gh` e `git` a
  partir de todo o contexto (nome da task, spec, subtasks, comentários e termos da
  interface) antes de concluir que ela não existe.
- Não cite pessoas: nada de nomes de autores, revisores, PMs ou CS no texto.
- Não afirme nada sem evidência. Todo comportamento descrito em `summary` e
  `in_practice` precisa estar confirmado em PR, commit ou código atual e listado em
  `evidence`. O que não puder ser confirmado vai para `open_questions`, não para o texto.
- Um PR aberto vale como evidência do comportamento que ele implementa: a comunicação
  pode ser preparada antes da publicação. Liste em `open_questions` os PRs que ainda não
  foram integrados.
- Se `history.json` existir, aplique o feedback mais recente do PM sobre a última versão
  com `status: ready` e preserve o que ele não pediu para mudar. Aplique também o
  feedback das versões com `status: failed` posteriores a essa última versão `ready`:
  ele ainda não foi refletido em nenhuma comunicação gerada.
- Ajuste o nível de detalhe ao tamanho, como descrito na skill: `P` é curto e direto;
  `M` e `G` explicam o contexto e detalham a mecânica na tela. Com
  `task.communicationSize` igual a `null`, escolha pelo tamanho da entrega e registre em
  `open_questions` que o campo "Comunicação Cliente" não está preenchido com P, M ou G.
- Não escreva a linha "Ticket de melhoria aberto por…" nem o link do ticket: o código
  acrescenta essa linha.
- Só inclua em `links` URLs que aparecem no ClickUp (task, subtasks ou comentários) como
  material da comunicação. Não invente links e não use os anexos da spec.
- Se a última versão `ready` do `history.json` estiver no formato antigo (com `changes`),
  reescreva o conteúdo dela no formato atual.

## Saída

Responda apenas com um objeto JSON, sem Markdown e sem texto fora dele, neste formato:

```json
{
  "status": "READY",
  "title": "📁 Exportar conversas para Excel (.xlsx)",
  "summary": "Revisar o histórico de conversas de uma sequência dependia de pedir a planilha ao time técnico. Agora a tela de Conversas permite baixar em Excel (.xlsx) as conversas que estão filtradas na tela.",
  "in_practice": "O arquivo sai com todas as conversas que batem com os filtros aplicados, não só as que aparecem na tela.\n- Aba \"Leads\": uma linha por lead e vendedor, com total de mensagens e um resumo da conversa.\n- A exportação segue a mesma visibilidade da tela de Conversas: cada usuário só exporta o que já pode ver.",
  "links": [
    {
      "kind": "help_center",
      "label": "O passo a passo está na Central de Ajuda",
      "url": "https://<link citado no ClickUp>"
    }
  ],
  "pull_request_source": "CITED",
  "evidence": [
    {
      "kind": "pull_request",
      "reference": "https://github.com/Example-org/<repo>/pull/<n>",
      "note": "O que este PR comprova."
    }
  ],
  "images": [{ "index": 1, "caption": "Descrição curta do que a imagem mostra." }],
  "open_questions": []
}
```

- `status`: `READY` quando a comunicação está pronta para revisão do PM;
  `INSUFFICIENT_CONTEXT` só quando nenhuma implementação (PR aberto ou integrado, commit
  ou código atual) sustenta o comportamento a comunicar. Entrega parcial ou ainda não
  publicada é `READY`, com a pendência em `open_questions`.
  Nesse caso, preencha todos os campos assim: `title` com um título curto e não vazio
  sobre a falta de contexto; `summary` explicando o que não foi possível confirmar;
  `in_practice` com uma frase não vazia dizendo que não há comportamento confirmado para
  descrever; `links` como lista vazia; `open_questions` com o que o PM precisa informar;
  `evidence` com o que foi verificado (pode ser vazia).
- `title`: um emoji relacionado ao tema seguido do nome direto da funcionalidade, sem
  asteriscos, quando `status` for `READY`.
- `summary`: o texto de "O que mudou", sem o rótulo.
- `in_practice`: o texto de "Na prática", sem o rótulo. Em `M` e `G`, pode trazer linhas
  começando com `- ` para listar regras e passos.
- `links`: materiais citados no ClickUp. `kind` é `help_center` (Central de Ajuda),
  `video` (YouTube) ou `reference` (imagem ou link de referência); `label` é a frase
  curta antes do link ("O passo a passo está na Central de Ajuda", "Tem vídeo mostrando
  como funciona", "Imagem/Link de referência"); `url` é a URL `https://` exata. Lista
  vazia quando não houver.
- `images`: opcional na prática: comunicação sem imagem é válida e não é motivo para
  `INSUFFICIENT_CONTEXT` nem para dúvida em `open_questions`. Imagens de
  `context/images.json` que devem acompanhar a comunicação, na ordem de exibição, no
  máximo 4. Escolha só as que mostram a funcionalidade entregue para o
  cliente. Nunca escolha imagem com dado de cliente, tela interna, código, log, rascunho
  de design desatualizado ou conversa. `index` é o número da imagem; `caption` é uma
  frase curta para acessibilidade, sem repetir o título. Lista vazia quando nenhuma
  servir ou quando `status` for `INSUFFICIENT_CONTEXT`. Se o PM pedir para trocar ou tirar
  uma imagem, siga o pedido.
- `pull_request_source`: `CITED` quando a implementação veio dos PRs de
  `context/pull-requests/`; `DISCOVERED` quando você a encontrou por busca; `NOT_FOUND`
  quando nenhum PR foi encontrado.
- `evidence`: cada item com `kind` (`pull_request`, `commit` ou `code`), `reference`
  (URL do PR, SHA do commit ou `<repositório>/<caminho>`) e `note` com o que ele comprova.
- `open_questions`: dúvidas que o PM precisa responder. Lista vazia quando não houver.
