import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCommunicationCard,
  buildPublicationImages,
  COMMUNICATION_APPROVE_ACTION,
} from './communication-cards.js';
import { parseCommunicationOutput } from './communication-output.js';
import type { ImprovementTicket } from './communication.types.js';

const ACTION_URL = 'https://ops.example.com/google-chat/events';

function fixture(name: string) {
  return parseCommunicationOutput(
    JSON.parse(
      readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
    ) as unknown,
  );
}

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

const base = {
  communicationId: 'c1',
  version: 2,
  taskLabel: 'TASK-1 — Exportar conversas',
  tickets: [ticket],
  warnings: [],
  media: [],
};

function buttons(card: ReturnType<typeof buildCommunicationCard>) {
  return JSON.stringify(card).includes(COMMUNICATION_APPROVE_ACTION);
}

describe('buildCommunicationCard', () => {
  it('snapshots the ready draft card with the approve button', () => {
    const card = buildCommunicationCard(
      { ...base, output: fixture('ready.json') },
      ACTION_URL,
    );
    expect(card).toMatchSnapshot();
    const text = JSON.stringify(card);
    expect(text).toContain('Versão 2');
    expect(text).toContain(
      'Ticket de melhoria aberto por @Carlos Henrique Souza Teixeira',
    );
    expect(text).not.toContain('users/');
    expect(text).toContain('{"key":"communicationId","value":"c1"}');
    expect(text).toContain('{"key":"version","value":"2"}');
    expect(text).not.toContain('Avisos');
  });

  it('snapshots the insufficient context card without approve and with warnings', () => {
    const card = buildCommunicationCard(
      {
        ...base,
        output: fixture('insufficient.json'),
        warnings: ['Não consegui ler o PR #12'],
      },
      undefined,
    );
    expect(card).toMatchSnapshot();
    expect(buttons(card)).toBe(false);
    expect(JSON.stringify(card)).toContain('Avisos');
    expect(JSON.stringify(card)).toContain(
      'Qual PR ou repositório implementa esta funcionalidade?',
    );
  });

  it('escapes quotes in hrefs and keeps bold formatting out of URLs', () => {
    const output = fixture('insufficient.json');
    const card = buildCommunicationCard(
      {
        ...base,
        output: {
          ...output,
          summary: '*Atenção:* veja https://x.example/a*b*c"d e <tag> *fim*',
        },
      },
      undefined,
    );
    const html = (
      card.cardsV2[0]?.card.sections[0]?.widgets[0] as {
        textParagraph: { text: string };
      }
    ).textParagraph.text;
    expect(html).toContain(
      '<a href="https://x.example/a*b*c&quot;d">https://x.example/a*b*c"d</a>',
    );
    expect(html).toContain('<b>Atenção:</b> veja ');
    expect(html).toContain(' e &lt;tag&gt; <b>fim</b>');
  });
});

describe('communication images', () => {
  const media = [
    { name: 'a.png', url: 'https://signed.example/a.png', caption: 'Tela' },
  ];
  const image = { image: { imageUrl: media[0]?.url, altText: 'Tela' } };

  it('shows draft images only on ready versions', () => {
    const ready = JSON.stringify(
      buildCommunicationCard(
        { ...base, media, output: fixture('ready.json') },
        ACTION_URL,
      ),
    );
    expect(ready).toContain(JSON.stringify(image));
    const insufficient = JSON.stringify(
      buildCommunicationCard(
        { ...base, media, output: fixture('insufficient.json') },
        ACTION_URL,
      ),
    );
    expect(insufficient).not.toContain('imageUrl');
  });

  it('builds the publication card only when there are images', () => {
    expect(buildPublicationImages('c1', 1, [])).toEqual({});
    expect(buildPublicationImages('c1', 1, media).cardsV2?.[0]).toEqual({
      cardId: 'communication-c1-v1-images',
      card: { sections: [{ widgets: [image] }] },
    });
  });
});
