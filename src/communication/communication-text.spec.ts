import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCommunicationOutput } from './communication-output.js';
import {
  draftMention,
  publicationMention,
  renderCommunicationText,
} from './communication-text.js';
import type { ImprovementTicket } from './communication.types.js';

const output = parseCommunicationOutput(
  JSON.parse(
    readFileSync(new URL('./fixtures/ready.json', import.meta.url), 'utf8'),
  ) as unknown,
);

const body = [
  '*📁 Exportar conversas para Excel (.xlsx)*',
  '• *O que mudou:* Revisar o histórico de conversas de uma sequência dependia de pedir a planilha ao time técnico. Agora a tela de Conversas permite baixar em Excel (.xlsx) as conversas que estão filtradas na tela.',
  `• *Na prática:* ${output.in_practice}`,
].join('\n');

const helpCenter =
  '• 📚 O passo a passo está na Central de Ajuda: https://servico5.example.internal/exportar-conversas';

const ticket: ImprovementTicket = {
  id: '86abc',
  customId: 'TICKET-10003',
  name: 'Exportar conversas',
  url: 'https://app.clickup.com/t/90000000001/TICKET-10003',
  owners: [
    {
      username: 'Carlos Henrique Souza Teixeira',
      email: 'pessoa4@example.com',
    },
  ],
};

describe('renderCommunicationText', () => {
  it('renders the feature block without a ticket line when there is no ticket', () => {
    expect(renderCommunicationText(output, [], () => 'unused')).toBe(
      `${body}\n${helpCenter}`,
    );
  });

  it('cites the improvement ticket before the reference links', () => {
    const text = renderCommunicationText(
      output,
      [ticket],
      (t) => `@${t.owners[0]?.username}`,
    );
    expect(text).toBe(
      `${body}\n• Ticket de melhoria aberto por @Carlos Henrique Souza Teixeira: https://app.clickup.com/t/90000000001/TICKET-10003\n${helpCenter}`,
    );
  });

  it('keeps rendering legacy drafts with labeled changes', () => {
    const legacy = parseCommunicationOutput({
      status: 'READY',
      title: '🤝 Convite',
      summary: 'Resumo.',
      changes: [{ label: 'Nova opção', description: 'chave nova.' }],
      in_practice: 'antes x agora.',
      pull_request_source: 'CITED',
      evidence: [],
      open_questions: [],
    });
    expect(renderCommunicationText(legacy, [], () => 'unused')).toBe(
      [
        '*🤝 Convite*',
        '• *O que mudou:* Resumo.',
        '   - *Nova opção:* chave nova.',
        '• *Na prática:* antes x agora.',
      ].join('\n'),
    );
  });

  it('uses an emoji per link kind', () => {
    const text = renderCommunicationText(
      {
        ...output,
        links: [
          { kind: 'video', label: 'Vídeo', url: 'https://youtu.be/x' },
          {
            kind: 'reference',
            label: 'Imagem/Link de referência',
            url: 'https://x.io/i.png',
          },
        ],
      },
      [],
      () => 'unused',
    );
    expect(text.split('\n').slice(-2)).toEqual([
      '• ▶️ Vídeo: https://youtu.be/x',
      '• 🔗 Imagem/Link de referência: https://x.io/i.png',
    ]);
  });
});

describe('mentions', () => {
  it('uses the plain name in drafts', () => {
    expect(draftMention(ticket)).toBe('@Carlos Henrique Souza Teixeira');
  });

  it('usa somente IDs resolvidos ao publicar e preserva o nome sem identidade', () => {
    expect(
      publicationMention(
        ticket,
        new Map([['pessoa4@example.com', 'users/123456']]),
      ),
    ).toBe('<users/123456>');
    expect(publicationMention(ticket, new Map())).toBe(
      'Carlos Henrique Souza Teixeira',
    );
    expect(
      publicationMention(
        ticket,
        new Map([['pessoa4@example.com', 'users/pessoa4@example.com']]),
      ),
    ).toBe('Carlos Henrique Souza Teixeira');
  });

  it('mostra todos os Donos no preview sem menção ativa', () => {
    const multiple = {
      ...ticket,
      owners: [...ticket.owners, { username: 'Maria', email: null }],
    };
    expect(draftMention(multiple)).toBe(
      '@Carlos Henrique Souza Teixeira, @Maria',
    );
    expect(
      publicationMention(
        multiple,
        new Map([['pessoa4@example.com', 'users/123456']]),
      ),
    ).toBe('<users/123456>, Maria');
  });

  it('preserva o link sem atribuir autoria quando falta o Dono', () => {
    const text = renderCommunicationText(
      output,
      [{ ...ticket, owners: [] }],
      draftMention,
    );
    expect(text).toContain('Ticket de melhoria (Dono não identificado)');
    expect(text).toContain(ticket.url);
    expect(text).not.toContain('aberto por');
  });
});
