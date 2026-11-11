import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clickupRequest,
  downloadAttachments,
  downloadClickUpAttachment,
  fetchComments,
  fetchTasks,
  serviceClickUpError,
  synchronizeDiagnosedVector,
} from './clickup-api.js';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function call(index = 0): [string, RequestInit] {
  const [url, init] = fetchMock.mock.calls[index] ?? [];
  return [String(url), init ?? {}];
}

describe('clickup api adapter', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('envia token, headers JSON e timeout', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      clickupRequest({ token: 'pk_1' }, '/task/1', { method: 'PUT' }),
    ).resolves.toEqual({ ok: true });

    const [url, init] = call();
    expect(url).toBe('https://api.clickup.com/api/v2/task/1');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({
      Authorization: 'pk_1',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('runner sanitiza o corpo do erro; service mantém o corpo', async () => {
    fetchMock.mockResolvedValue(
      new Response('invalid token pk_123_ABC', { status: 401 }),
    );
    await expect(clickupRequest({ token: 't' }, '/x')).rejects.toThrow(
      'ClickUp API 401: invalid token [REDACTED_CLICKUP_TOKEN]',
    );

    fetchMock.mockResolvedValue(new Response('x'.repeat(600), { status: 500 }));
    await expect(
      clickupRequest({ token: 't', formatError: serviceClickUpError }, '/x'),
    ).rejects.toThrow(`ClickUp API 500: ${'x'.repeat(500)}`);
  });

  it('fetchTasks pagina até página incompleta e repete statuses[]', async () => {
    const fullPage = Array.from({ length: 100 }, (_, id) => ({ id }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ tasks: fullPage }))
      .mockResolvedValueOnce(jsonResponse({ tasks: [{ id: 'last' }] }));

    const tasks = await fetchTasks({
      token: 't',
      listId: 'list',
      includeSubtasks: true,
      createdWithinMinutes: 60,
      statuses: ['open', 'in progress'],
    });

    expect(tasks).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const query = new URL(call(1)[0]).searchParams;
    expect(query.get('page')).toBe('1');
    expect(query.get('subtasks')).toBe('true');
    expect(query.get('archived')).toBe('false');
    expect(query.get('include_closed')).toBe('false');
    expect(query.getAll('statuses[]')).toEqual(['open', 'in progress']);
    expect(Number(query.get('date_created_gt'))).toBeLessThan(
      Date.now() - 59 * 60_000,
    );
  });

  it('fetchComments normaliza autor, texto e data', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        comments: [
          {
            id: 1,
            user: { email: 'pessoa1@example.com' },
            comment: [{ text: 'oi ' }, { text: 'time' }],
            date: '1790000000000',
          },
        ],
      }),
    );
    await expect(fetchComments({ token: 't' }, '9')).resolves.toEqual([
      {
        id: '1',
        author: 'pessoa1@example.com',
        text: 'oi time',
        created_at: new Date(1790000000000).toISOString(),
        resolved: null,
      },
    ]);
  });

  describe('synchronizeDiagnosedVector', () => {
    const config = {
      token: 't',
      vectorsFieldId: 'vf',
      vectorsField: 'Vetores',
      diagnosisVectors: [
        { name: 'Email', description: '' },
        { name: 'WhatsApp', description: '' },
      ],
    };
    const taskWith = (value: string[]) => ({
      id: '1',
      custom_fields: [
        {
          id: 'vf',
          name: 'Vetores',
          value,
          type_config: {
            options: [
              { id: 'o-email', label: 'Email' },
              { id: 'o-wa', label: 'WhatsApp' },
            ],
          },
        },
      ],
    });

    it('não escreve quando o vetor já é o diagnosticado', async () => {
      fetchMock.mockResolvedValue(jsonResponse(taskWith(['o-email'])));
      await expect(
        synchronizeDiagnosedVector(config, '1', 'Email'),
      ).resolves.toEqual({ updated: false, previousVectors: ['Email'] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('grava a opção do vetor diagnosticado', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(taskWith(['o-email'])))
        .mockResolvedValueOnce(jsonResponse({}));
      await expect(
        synchronizeDiagnosedVector(config, '1', 'WhatsApp'),
      ).resolves.toEqual({ updated: true, previousVectors: ['Email'] });
      const [url, init] = call(1);
      expect(url).toBe('https://api.clickup.com/api/v2/task/1/field/vf');
      expect(init.body).toBe(JSON.stringify({ value: 'o-wa' }));
    });
  });

  describe('downloadClickUpAttachment', () => {
    let dir: string;
    const config = { token: 'pk_secret', maxAttachmentBytes: 100 };

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'clickup-attachment-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('recusa host fora do ClickUp sem chamar fetch', async () => {
      await expect(
        downloadClickUpAttachment(
          config,
          'https://evil.example/?clickup-attachments.com',
          path.join(dir, 'a.png'),
        ),
      ).rejects.toThrow(/not a ClickUp attachment host/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('não segue redirect para outro host', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/steal' },
        }),
      );
      await expect(
        downloadClickUpAttachment(
          config,
          'https://t1.clickup-attachments.com/a.png',
          path.join(dir, 'a.png'),
        ),
      ).rejects.toThrow(/not a ClickUp attachment host/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(call(0)[1].redirect).toBe('manual');
    });

    it('segue redirect dentro do host do ClickUp e grava o arquivo', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: '/b.png' },
          }),
        )
        .mockResolvedValueOnce(new Response('png', { status: 200 }));
      await downloadClickUpAttachment(
        config,
        'https://t1.clickup-attachments.com/a.png',
        path.join(dir, 'a.png'),
      );
      expect(call(1)[0]).toBe('https://t1.clickup-attachments.com/b.png');
      await expect(readFile(path.join(dir, 'a.png'), 'utf8')).resolves.toBe(
        'png',
      );
    });
  });

  describe('downloadAttachments', () => {
    let ticketDir: string;
    const config = { token: 'pk', maxAttachments: 3, maxAttachmentBytes: 10 };

    beforeEach(async () => {
      ticketDir = await mkdtemp(path.join(os.tmpdir(), 'clickup-spec-'));
    });

    afterEach(async () => {
      await rm(ticketDir, { recursive: true, force: true });
    });

    it('sem anexos não cria diretório', async () => {
      await expect(
        downloadAttachments(config, { id: '1' }, ticketDir),
      ).resolves.toEqual([]);
      await expect(stat(path.join(ticketDir, 'attachments'))).rejects.toThrow();
    });

    it('baixa, pula e registra erro respeitando os limites', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('png-data', { status: 200 }))
        .mockResolvedValueOnce(new Response('nope', { status: 404 }));

      const result = await downloadAttachments(
        { ...config, maxAttachments: 4 },
        {
          id: '1',
          attachments: [
            { id: 'a', title: 'print.png', url: 'https://files/a' },
            { id: 'b', title: 'sem-url' },
            { id: 'c', title: 'grande', url: 'https://files/c', size: 11 },
            { id: 'd', title: 'erro.txt', url: 'https://files/d' },
            { id: 'e', title: 'excedente', url: 'https://files/e' },
          ],
        },
        ticketDir,
      );

      expect(result.map((item) => [item.id, item.status, item.error])).toEqual([
        ['a', 'downloaded', null],
        ['b', 'skipped', 'Attachment has no downloadable URL'],
        ['c', 'skipped', 'Attachment exceeds 0 MB limit'],
        ['d', 'error', 'HTTP 404'],
      ]);
      expect(result[0]?.image_context).toBe(true);
      const localPath = path.join(ticketDir, 'attachments', '1-print.png');
      expect(result[0]?.local_path).toBe(localPath);
      await expect(readFile(localPath, 'utf8')).resolves.toBe('png-data');
      expect((await stat(localPath)).mode & 0o777).toBe(0o600);

      const [url, init] = call(0);
      expect(url).toBe('https://files/a');
      expect(init).toMatchObject({
        headers: { 'x-api-key': 'pk' },
        redirect: 'follow',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejeita download maior que o limite', async () => {
      fetchMock.mockResolvedValue(new Response('x'.repeat(11)));
      const [metadata] = await downloadAttachments(
        config,
        { id: '1', attachments: [{ title: 'a.bin', url: 'https://f' }] },
        ticketDir,
      );
      expect(metadata).toMatchObject({
        id: '1',
        status: 'error',
        error: 'file exceeds 0 MB limit',
        local_path: null,
      });
    });
  });
});
