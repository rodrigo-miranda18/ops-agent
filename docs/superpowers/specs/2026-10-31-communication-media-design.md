# Imagens na publicação do `/comunicacao`

## Intenção

Publicar prints da task do ClickUp junto da comunicação no espaço de novidades. Era entregável original da feature e saiu do MVP porque `media.upload` do Google Chat exige autenticação de usuário e o app usa `chat.bot`. Spec anterior: `2026-10-07-feature-communication-design.md`.

O caminho é hospedar a imagem em S3 e exibi-la no widget `Image` de um card, mantendo o app como remetente.

## Objetivos

- O agente escolhe quais imagens da task entram na comunicação.
- A PM vê as imagens no rascunho e pede ajuste na thread, como já faz com o texto.
- A aprovação publica texto, menções e imagens em uma única mensagem.
- Imagens publicadas continuam visíveis em mensagens antigas.

## Fora de escopo

- Vídeo, PDF e outros arquivos. O Chat não tem widget de vídeo e o agente não assiste vídeos; o caminho futuro é link do Drive.
- Anexo nativo do Chat, OAuth de usuário e delegação de domínio.
- Migrar `results/` ou outros artefatos para S3.
- Detecção automática de dado sensível em imagem.
- Redimensionar ou converter imagens.
- Mudar o limite de 10 imagens coletadas. Em task com mais imagens, o agente só vê as 10 primeiras (limitação conhecida).

## O que não pode acontecer

- Publicar card com imagem quebrada sem que ninguém tenha visto antes.
- Imagem que ninguém aprovou ficar pública para sempre.
- Chave de escrita do S3 chegar ao Codex, a logs ou a `results/`.
- Falha de S3 impedir a geração do rascunho de texto.
- Mudança visível em produção enquanto o bucket não estiver configurado (cards, mensagens publicadas, falhas de execução).

## Decisões do desenvolvedor

- Reutilizar um bucket existente, com prefixo próprio. O bucket dedicado proposto antes não é viável agora.
- Leitura pública sem login para imagens publicadas, por enquanto: quem tiver o link vê a imagem.
- O agente decide as imagens; a PM revisa no rascunho.
- Vídeo fica para depois.

## Evidências dos testes

Teste de 2026-10-31 com o app de produção em `spaces/SPACE_ID_3` (mensagem `Bc-m3WlvprI`): `text` + `cardsV2` saem na mesma mensagem e a menção `<users/ID>` no `text` continua funcionando.

Uma imagem servida com 200 direto renderizou. Outra, atrás de um 301 com `Location` relativo, quebrou e mostrou o alt, **sem erro na API do Chat**. A causa provável é o redirect, não comprovada. Consequências: usar URL direta do objeto e verificar a URL antes de usá-la.

URL pré-assinada não serve para a publicação, pois a assinatura expira em no máximo 7 dias (padrão do `service-04`), mas basta para o rascunho. Objeto público tem precedente em `service-12/internal/adapters/s3_uploader.go`.

## Infraestrutura

Reutiliza o bucket `media-bucket` do object storage (compatível com S3), já usado com `public-read` por objeto pelo `service-12`. Prefixos exclusivos: `ops-agent/communication/drafts/` e `ops-agent/communication/published/`. Não há bucket novo, bucket policy nem lifecycle.

A visibilidade é por objeto:

- Rascunho: privado, exibido no card por URL pré-assinada de 7 dias.
- Publicado: cópia com ACL `public-read`, URL direta e permanente.

A credencial é gravada pelo desenvolvedor com `config:set`, sem passar por chat. Rascunhos não aprovados ficam privados no bucket até uma limpeza futura.

## Desenho

### Contrato de saída

`CommunicationOutput` ganha `images: CommunicationImage[]`, com `{ index: number, caption: string }`.

- `index` é o número da imagem na lista de `context/images.json`.
- `caption` é uma descrição curta, usada como `altText`.
- `output.json` antigo sem `images` continua válido e é lido como `[]`.
- Mudam juntos: `src/prompts/communication-prompt.md`, `repos/.codex/skills/driva-communication`, `communication-output.ts` e os fixtures.

### Seleção pelo agente

`runCommunication` grava `context/images.json` com as imagens efetivamente baixadas: `{ index, file }`. O índice é o número usado no nome do arquivo (`images/<index>.<ext>`), que pode ter lacunas quando um download falha.

O prompt instrui a escolher imagens que mostrem a funcionalidade, evitar dados de cliente e telas internas, usar no máximo 4 e devolver `[]` quando nenhuma servir. Feedback da PM na thread ("tira a segunda") vale para as imagens da nova versão.

A seleção nunca invalida a saída nem custa retry: `images` malformado vale como `[]`, índice fora do manifesto é descartado com aviso e só os 4 primeiros itens são usados. O texto da comunicação não pode falhar por causa de uma imagem.

O prompt, a skill e `context/images.json` não dependem do bucket. Sem bucket, o agente ainda devolve `images`, mas nada é enviado nem exibido.

### Upload

Roda no runner, fora do sandbox, depois de uma saída válida e apenas com `status: READY`.

Para cada imagem escolhida:

1. Detectar o formato pelos bytes do arquivo, não pela extensão, que hoje assume `.png` por padrão. Só PNG e JPEG passam, que são os formatos documentados do widget.
2. Enviar para o prefixo de rascunhos, privado, em `<uuid-aleatório>.<ext>`, com `ContentType` correto. A chave não deriva do ID da task.
3. Gerar a URL pré-assinada e buscá-la sem seguir redirect, exigindo 200 com `Content-Type` de imagem. Falha de conexão nessa checagem não descarta a imagem, porque só uma resposta HTTP diz algo sobre o acesso à URL.

O resultado vai para `media.json` no diretório da versão: `{ key, url, caption }`. Arquivo ausente equivale a `[]`, o que cobre versões antigas.

Falha em uma imagem não falha a execução: ela fica de fora e entra em `warnings`, que já aparecem no card. Imagem acima de 2 MB é enviada mesmo assim, com aviso, porque esse limite é recomendação da documentação.

Sem bucket configurado, a etapa é ignorada sem aviso.

### Rascunho

`buildCommunicationCard` ganha a seção `🖼️ Imagens`, depois do rascunho, com um widget `image` por item. O card não muda quando `media.json` está vazio.

### Publicação

Em `CommunicationActionsService`, depois de `claimPublication`:

1. Copiar cada objeto para o prefixo de publicados, com o mesmo nome e ACL `public-read` (`CopyObject` no servidor), e verificar a URL pública como no upload.
2. Publicar com `messenger.sendMessage`: o `text` atual de `renderCommunicationText` e, havendo imagens, um `cardsV2` só com os widgets de imagem.

Imagem nunca é obrigatória. Sem imagens, a mensagem continua apenas com texto. Se a cópia de uma imagem falhar ou o armazenamento não estiver configurado, a imagem fica de fora, a comunicação é publicada e a resposta ao aprovador informa quantas não entraram.

### Adapter e configuração

- Adapter sem Nest em `src/communication/media-storage.ts`, usado pelo runner e pelo service, mockado na fronteira nos testes.
- Dependências novas: `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner`. `package-lock.json` é o lockfile oficial. Com endpoint não AWS, calcular checksums só quando exigido.
- Variáveis, lidas só em `src/config/`: `COMMUNICATION_MEDIA_S3_BUCKET`, `_REGION`, `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_PUBLIC_BASE_URL`.
- Todas opcionais em conjunto: com `BUCKET` vazio, a feature fica desligada. Com `BUCKET` preenchido, as demais são obrigatórias no boot.
- Essas variáveis não entram em `communicationCodexEnvironment` nem em nenhuma outra allowlist de subprocesso. Um teste deve garantir isso.
- Adicionar ao `.env.example` e ao README.

## Testes

- Contrato: `images` válido, ausente e malformado, índice inexistente e mais de 4 itens, sem retry nem falha da versão.
- Upload: PNG, JPEG, formato recusado, falha parcial, verificação com redirect e com status diferente de 200, bucket não configurado.
- Cards: rascunho e publicação com e sem imagens, com snapshots.
- Publicação: ordem cópia → envio, e publicação só com texto quando a cópia falha.
- Allowlist: credenciais fora do ambiente do Codex.

## Validação antes de produção

Com a credencial configurada, repetir o teste do Chat com prints reais hospedados no S3, incluindo um acima de 2 MB e um de altura grande, vistos por outra pessoa no espaço de novidades.

## A cargo de quem implementar

Nomes internos, divisão de funções e como `media.json` entra em `CommunicationVersionArtifacts`, respeitando as regras do `AGENTS.md`. Implementar a partir de `origin/main`, em branch própria, não em `feat/claude-runtime`.

## Riscos aceitos

- O preview no widget depende do Google buscar a imagem; não há garantia documentada para prints grandes.
- Depois de 7 dias, as imagens do card de rascunho deixam de carregar, mas a aprovação continua funcionando, porque a cópia não depende da URL.
- Link vazado expõe a imagem para sempre, enquanto o objeto existir.
- Se o envio ao Chat falhar depois da cópia e a PM desistir, o objeto fica órfão e público no prefixo de publicados. A PM já tinha aprovado a imagem e a URL não é divulgada, então não há limpeza nem `s3:DeleteObject`. Apagar depois de um envio com falha também poderia quebrar uma mensagem entregue cuja resposta se perdeu.
- O prompt muda mesmo com o bucket desligado, o que pode influenciar levemente o texto gerado.
