import { describe, expect, it } from 'vitest';
import {
  customFieldValues,
  isClickUpAttachmentUrl,
  isClosed,
  matchesTicket,
  normalizeTicket,
  richTextToPlain,
  safeFilename,
  taskTypeName,
  toIso,
  wasCreatedWithin,
  type TicketFilterConfig,
} from './clickup-task.js';
import type { ClickUpTask } from './clickup.types.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');

const filter: TicketFilterConfig = {
  taskType: 'Ticket',
  taskTypeId: '',
  ticketTypeFieldId: 'type-field',
  ticketTypeField: 'Tipo',
  ticketTypeValue: 'Bug',
  areaFieldId: '',
  areaField: 'Área',
  areaValues: ['Engajamento'],
  vectorsFieldId: 'vectors-field',
  vectorsField: 'Vetores',
  tags: ['suporte'],
  createdWithinMinutes: 60,
};

function task(overrides: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id: 123,
    name: 'Falha no envio',
    status: { status: 'open', type: 'open' },
    date_created: String(Date.now() - 10 * 60_000),
    task_type: { name: 'Ticket' },
    tags: [{ name: 'Suporte' }],
    custom_fields: [
      {
        id: 'type-field',
        name: 'Tipo',
        value: 0,
        type_config: {
          options: [{ id: 'opt-bug', name: 'Bug', orderindex: 0 }],
        },
      },
      { id: 'area-field', name: 'Área', value: 'Engajamento' },
      {
        id: 'vectors-field',
        name: 'Vetores',
        value: ['v1', 'v2'],
        type_config: {
          options: [
            { id: 'v1', label: 'Email' },
            { id: 'v2', label: 'WhatsApp' },
          ],
        },
      },
    ],
    ...overrides,
  };
}

describe('clickup task helpers', () => {
  it('richTextToPlain prefere o texto plano e junta fragmentos', () => {
    expect(richTextToPlain('plain', [{ text: 'x' }])).toBe('plain');
    expect(richTextToPlain(undefined, [{ text: 'a' }, {}, { text: 'b' }])).toBe(
      'ab',
    );
    expect(richTextToPlain(undefined, null)).toBe('');
  });

  it('resolve opções de dropdown e labels', () => {
    expect(customFieldValues(task(), 'vectors-field', 'Vetores')).toEqual([
      'Email',
      'WhatsApp',
    ]);
    expect(customFieldValues(task(), '', 'vetores')).toEqual([
      'Email',
      'WhatsApp',
    ]);
    expect(customFieldValues(task({ custom_fields: [] }), '', 'x')).toEqual([]);
  });

  it('lê o tipo da task das formas aceitas pelo ClickUp', () => {
    expect(taskTypeName(task())).toBe('Ticket');
    expect(taskTypeName(task({ task_type: undefined, type: 'Bug' }))).toBe(
      'Bug',
    );
    expect(
      taskTypeName(
        task({ task_type: undefined, custom_item: { name: 'Pedido' } }),
      ),
    ).toBe('Pedido');
    expect(taskTypeName(task({ task_type: ' ' }))).toBeNull();
  });

  it('detecta task fechada por tipo ou nome do status', () => {
    expect(isClosed(task({ status: { status: 'x', type: 'closed' } }))).toBe(
      true,
    );
    expect(isClosed(task({ status: 'Closed' }))).toBe(true);
    expect(isClosed(task())).toBe(false);
  });

  it('wasCreatedWithin aceita timestamp em ms e rejeita futuro', () => {
    const created = task({ date_created: String(NOW - 30 * 60_000) });
    expect(wasCreatedWithin(created, 60, NOW)).toBe(true);
    expect(wasCreatedWithin(created, 10, NOW)).toBe(false);
    expect(
      wasCreatedWithin(task({ date_created: String(NOW + 1000) }), 60, NOW),
    ).toBe(false);
    expect(wasCreatedWithin(task({ date_created: 'x' }), 60, NOW)).toBe(false);
  });

  it('matchesTicket exige tipo, área, tags, janela e task aberta', () => {
    expect(matchesTicket(task(), filter)).toEqual({
      matches: true,
      actual: {
        taskType: 'Ticket',
        taskTypeId: null,
        ticketType: 'Bug',
        area: 'Engajamento',
        vectors: ['Email', 'WhatsApp'],
      },
    });
    expect(matchesTicket(task({ tags: [] }), filter).matches).toBe(false);
    expect(matchesTicket(task({ status: 'closed' }), filter).matches).toBe(
      false,
    );
    expect(
      matchesTicket(task({ custom_item_id: 7 }), { ...filter, taskTypeId: '8' })
        .matches,
    ).toBe(false);
    expect(
      matchesTicket(task({ custom_item_id: 7 }), { ...filter, taskTypeId: '7' })
        .matches,
    ).toBe(true);
  });

  it('toIso converte timestamps e ignora inválidos', () => {
    expect(toIso(String(NOW))).toBe('2026-09-23T12:00:00.000Z');
    expect(toIso(null)).toBeNull();
    expect(toIso('invalid')).toBeNull();
  });

  it('normalizeTicket monta o ticket.json', () => {
    const ticket = normalizeTicket(
      task({
        custom_id: 'SUP-1',
        markdown_description: '# md',
        description: 'plain',
        date_created: String(NOW),
        date_updated: 'not-a-date',
        priority: { priority: 'high' },
        assignees: [{ id: 9 }],
        list: { id: 'l1', name: 'Lista' },
      }),
      [],
      { taskType: 'Ticket', area: 'Engajamento' },
    );
    expect(ticket).toMatchObject({
      id: '123',
      custom_id: 'SUP-1',
      description: '# md',
      status: 'open',
      vectors: [],
      created_at: '2026-09-23T12:00:00.000Z',
      updated_at: 'not-a-date',
      priority: 'high',
      tags: ['Suporte'],
      assignees: [{ id: 9, username: null }],
      list: { id: 'l1', name: 'Lista' },
      folder: null,
      attachments: [],
    });
  });

  it('safeFilename troca caracteres inseguros e pontos iniciais', () => {
    expect(safeFilename('a/b:c*?"<>|\x01.png', 'f')).toBe('a_b_c_______.png');
    expect(safeFilename('..hidden', 'f')).toBe('hidden');
    expect(safeFilename('...', 'fallback')).toBe('fallback');
    expect(safeFilename(undefined, 'fallback')).toBe('fallback');
    expect(safeFilename('x'.repeat(200), 'f')).toHaveLength(180);
  });
});

describe('isClickUpAttachmentUrl', () => {
  it('accepts https URLs on clickup-attachments.com and its subdomains', () => {
    expect(
      isClickUpAttachmentUrl('https://t1.p.clickup-attachments.com/t1/a.png'),
    ).toBe(true);
    expect(
      isClickUpAttachmentUrl('https://clickup-attachments.com/a.png'),
    ).toBe(true);
  });

  it('rejects other hosts, lookalikes, http and credentials', () => {
    for (const url of [
      'https://evil.example/?clickup-attachments.com',
      'https://evil.example/clickup-attachments.com/a.png',
      'https://clickup-attachments.com.evil.example/a.png',
      'https://evilclickup-attachments.com/a.png',
      'http://t1.clickup-attachments.com/a.png',
      'https://user:pass@t1.clickup-attachments.com/a.png',
      'not a url',
    ])
      expect(isClickUpAttachmentUrl(url)).toBe(false);
  });
});
