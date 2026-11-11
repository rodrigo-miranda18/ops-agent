import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectClickUpContext,
  collectImageUrls,
  findImprovementTickets,
  richCommentText,
} from './clickup-context.js';

const field = (value: unknown) => ({
  name: 'Tipo do Ticket',
  value,
  type_config: {
    options: [
      { id: 'o1', name: 'Bug', orderindex: 0 },
      { id: 'o2', name: 'Melhoria de Produto', orderindex: 1 },
    ],
  },
});

const ownerField = (value: unknown = [{ id: 7, username: 'Ana CS' }]) => ({
  id: '00000000-0000-0000-0000-000000000005',
  name: 'Dono',
  type: 'users',
  value,
});

const subtask = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Melhoria',
  url: 'https://app.clickup.com/t/s1',
  task_type: 'form_response',
  creator: { id: 7, username: 'Ana CS' },
  custom_fields: [field(1), ownerField()],
  ...over,
});

describe('richCommentText', () => {
  it('preserva links de blocos', () => {
    const text = richCommentText([
      { text: 'PR hub: ' },
      {
        text: 'PR fechada',
        attributes: { link: 'https://github.com/x/y/pull/1' },
      },
      { type: 'bookmark', bookmark: { url: 'https://github.com/x/y/pull/2' } },
    ]);
    expect(text).toContain('github.com/x/y/pull/1');
    expect(text).toContain('github.com/x/y/pull/2');
  });
});

describe('findImprovementTickets', () => {
  const members = [
    { user: { id: 7, username: 'Ana CS', email: 'anpessoa1@example.com' } },
  ];

  it('aceita form_response com melhoria (por índice ou id) e resolve e-mail', () => {
    const tickets = findImprovementTickets(
      [
        subtask(),
        subtask({ id: 's2', custom_fields: [field('o2'), ownerField()] }),
      ],
      members,
    );
    expect(tickets.map((t) => t.id)).toEqual(['s1', 's2']);
    expect(tickets[0]?.owners).toEqual([
      {
        username: 'Ana CS',
        email: 'anpessoa1@example.com',
      },
    ]);
  });

  it('reconhece Form Response pelo custom_item_id retornado pela API v2', () => {
    const tickets = findImprovementTickets(
      [
        subtask({ task_type: undefined, custom_item_id: 3 }),
        subtask({ task_type: undefined, custom_item_id: '3', id: 's2' }),
        subtask({ task_type: undefined, custom_item_id: 1002, id: 'feature' }),
      ],
      members,
    );
    expect(tickets.map((ticket) => ticket.id)).toEqual(['s1', 's2']);
  });

  it('cita todos os Donos sem usar o criador ou o assignee de desenvolvimento', () => {
    const tickets = findImprovementTickets(
      [
        subtask({
          creator: { id: 99, username: 'Dev' },
          assignees: [{ id: 99, username: 'Dev' }],
          custom_fields: [
            field(1),
            ownerField([
              { id: 7, username: 'Ana CS', email: 'anpessoa1@example.com' },
              { id: 8, username: 'Bia CS', email: 'bipessoa1@example.com' },
              { id: 7, username: 'Ana CS', email: 'anpessoa1@example.com' },
            ]),
          ],
        }),
      ],
      [],
    );
    expect(tickets[0]?.owners).toEqual([
      { username: 'Ana CS', email: 'anpessoa1@example.com' },
      { username: 'Bia CS', email: 'bipessoa1@example.com' },
    ]);
  });

  it('não adivinha um Dono ausente', () => {
    const tickets = findImprovementTickets(
      [subtask({ custom_fields: [field(1)] })],
      members,
    );
    expect(tickets[0]?.owners).toEqual([]);
  });

  it('rejeita outro tipo, outra opção e devolve email null sem membro', () => {
    expect(
      findImprovementTickets(
        [
          subtask({ task_type: 'task' }),
          subtask({ custom_fields: [field(0)] }),
        ],
        members,
      ),
    ).toEqual([]);
    expect(
      findImprovementTickets([subtask()], [])[0]?.owners[0]?.email,
    ).toBeNull();
  });
});

describe('collectImageUrls', () => {
  it('ignora imagens fora do host de anexos do ClickUp', () => {
    expect(
      collectImageUrls(
        [
          '![](https://evil.example/?clickup-attachments.com)',
          '![](https://clickup-attachments.com.evil.example/a.png)',
        ],
        [
          {
            mimetype: 'image/png',
            url: 'https://evil.example/x.clickup-attachments.com.png',
          },
        ],
      ),
    ).toEqual([]);
  });

  it('junta inline e anexos, deduplica e corta', () => {
    const a = 'https://t1.clickup-attachments.com/a.png';
    const urls = collectImageUrls(
      [`![](${a}) e ![](${a})`, '![x](https://example.com/n.png)'],
      [
        {
          mimetype: 'image/png',
          url: 'https://t2.clickup-attachments.com/b.png',
        },
        {
          mimetype: 'application/pdf',
          url: 'https://t2.clickup-attachments.com/c.pdf',
        },
      ],
      2,
    );
    expect(urls).toEqual([a, 'https://t2.clickup-attachments.com/b.png']);
  });
});

describe('collectClickUpContext', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('coleta contexto e transforma falhas parciais em avisos', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/task/t1/comment'))
        return json({
          comments: [
            {
              id: 'c1',
              comment: [
                { text: 'veja ', attributes: {} },
                {
                  text: 'PR',
                  attributes: { link: 'https://github.com/x/y/pull/9' },
                },
              ],
              user: { username: 'Bia' },
              date: '1700000000000',
              reply_count: 1,
            },
          ],
        });
      if (url.includes('/comment/c1/reply'))
        return json({
          comments: [
            {
              comment_text: 'ok',
              user: { username: 'Caio' },
              date: '1700000001000',
            },
          ],
        });
      if (url.includes('/task/s1/comment')) return json({ err: 'x' }, 500);
      if (url.includes('/task/t1'))
        return json({
          id: 't1',
          name: 'Feature',
          url: 'https://app.clickup.com/t/t1',
          markdown_description: '![](https://t1.clickup-attachments.com/i.png)',
          subtasks: [subtask()],
          custom_fields: [
            {
              id: '00000000-0000-0000-0000-000000000004',
              name: 'Comunicação Cliente',
              value: 2,
              type_config: {
                options: [
                  { id: 'p', name: 'P', orderindex: 1 },
                  { id: 'm', name: 'M', orderindex: 2 },
                ],
              },
            },
          ],
        });
      if (url.includes('/team/9'))
        return json({
          team: {
            members: [{ user: { id: 7, email: 'anpessoa1@example.com' } }],
          },
        });
      return json({}, 404);
    });

    const context = await collectClickUpContext(
      { token: 'tk', teamId: '9', maxImages: 10 },
      't1',
    );

    expect(context.task.name).toBe('Feature');
    expect(context.task.communicationSize).toBe('M');
    expect(context.comments.map((c) => c.author)).toEqual(['Bia', 'Caio']);
    expect(context.comments[0]?.text).toContain('github.com/x/y/pull/9');
    expect(context.improvementTickets[0]?.owners[0]?.email).toBe(
      'anpessoa1@example.com',
    );
    expect(context.imageUrls).toEqual([
      'https://t1.clickup-attachments.com/i.png',
    ]);
    expect(context.warnings.some((w) => w.includes('s1'))).toBe(true);
  });

  it('hidrata toda subtask e cai na embutida quando a busca falha', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/comment')) return json({ comments: [] });
      if (url.includes('/task/s1?'))
        return json({
          ...subtask(),
          markdown_description: 'Spec github.com/x/y/pull/3',
          attachments: [
            {
              mimetype: 'image/png',
              url: 'https://t1.clickup-attachments.com/s1.png',
            },
          ],
        });
      if (url.includes('/task/s2?')) return json({ err: 'x' }, 500);
      if (url.includes('/task/t1'))
        return json({
          id: 't1',
          name: 'Feature',
          subtasks: [subtask(), subtask({ id: 's2', name: 'Embutida' })],
        });
      if (url.includes('/team/9')) return json({ team: { members: [] } });
      return json({}, 404);
    });

    const context = await collectClickUpContext(
      { token: 'tk', teamId: '9', maxImages: 10 },
      't1',
    );

    const subtaskUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => /\/task\/s[12]\?/.test(url));
    expect(subtaskUrls).toHaveLength(2);
    for (const url of subtaskUrls)
      expect(url).toContain('include_markdown_description=true');
    expect(context.subtasks.map((item) => item.description)).toEqual([
      'Spec github.com/x/y/pull/3',
      '',
    ]);
    expect(context.subtasks[1]?.name).toBe('Embutida');
    expect(context.imageUrls).toEqual([
      'https://t1.clickup-attachments.com/s1.png',
    ]);
    expect(context.warnings.some((w) => w.includes('Subtask s2'))).toBe(true);
  });

  it.each([false, true])(
    'inclui o pedido de melhoria na task principal ou subtask (subtask=%s)',
    async (nested) => {
      const improvement = subtask({
        id: '86tkt0017',
        custom_id: 'TICKET-10004',
        task_type: undefined,
        custom_item_id: 3,
        creator: { id: 99, username: 'Dev' },
        custom_fields: [
          field(1),
          ownerField([{ username: 'Davi', email: 'luccpessoa1@example.com' }]),
        ],
      });
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/comment')) return json({ comments: [] });
        if (url.includes('/team/')) return json({ team: { members: [] } });
        if (url.includes('/task/86tkt0017')) return json(improvement);
        return json({
          id: '86tkt0016',
          custom_item_id: 1002,
          subtasks: [improvement],
        });
      });
      const context = await collectClickUpContext(
        { token: 'tk', teamId: '9', maxImages: 10 },
        nested ? '86tkt0016' : '86tkt0017',
      );
      expect(context.improvementTickets).toHaveLength(1);
      expect(context.improvementTickets[0]?.owners).toEqual([
        { username: 'Davi', email: 'luccpessoa1@example.com' },
      ]);
    },
  );

  it('avisa sobre Dono ausente sem perder o link da melhoria', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/comment')) return json({ comments: [] });
      if (url.includes('/team/')) return json({ team: { members: [] } });
      return json(subtask({ custom_fields: [field(1)] }));
    });
    const context = await collectClickUpContext(
      { token: 'tk', teamId: '9', maxImages: 10 },
      's1',
    );
    expect(context.improvementTickets[0]?.url).toBe(
      'https://app.clickup.com/t/s1',
    );
    expect(context.warnings.join(' ')).toContain('Dono');
  });

  it('lança se a task principal falhar', async () => {
    fetchMock.mockResolvedValue(json({ err: 'no' }, 404));
    await expect(
      collectClickUpContext({ token: 'tk', teamId: '9', maxImages: 10 }, 't1'),
    ).rejects.toThrow(/404/);
  });
});
