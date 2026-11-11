import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCommunicationArtifacts } from './communication-artifacts.js';

const ready = await readFile(
  new URL('./fixtures/ready.json', import.meta.url),
  'utf8',
);

describe('readCommunicationArtifacts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'communication-artifacts-'));
    await mkdir(path.join(dir, 'context'));
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('reads output, improvement tickets and warnings', async () => {
    await writeFile(path.join(dir, 'output.json'), ready);
    await writeFile(
      path.join(dir, 'context', 'clickup.json'),
      JSON.stringify({
        improvementTickets: [
          {
            id: '1',
            customId: 'TICKET-1',
            name: 'Exportar',
            url: 'https://app.clickup.com/t/1',
            creator: { username: 'Ana', email: 'anpessoa1@example.com' },
          },
          { id: 2 },
        ],
      }),
    );
    await writeFile(
      path.join(dir, 'context', 'warnings.json'),
      JSON.stringify(['Imagem x não baixou']),
    );

    const artifacts = await readCommunicationArtifacts(dir);

    expect(artifacts.output.status).toBe('READY');
    expect(artifacts.tickets).toEqual([
      {
        id: '1',
        customId: 'TICKET-1',
        name: 'Exportar',
        url: 'https://app.clickup.com/t/1',
        owners: [{ username: 'Ana', email: 'anpessoa1@example.com' }],
      },
    ]);
    expect(artifacts.warnings).toEqual(['Imagem x não baixou']);
  });

  it('lê Donos do novo formato e não recorre ao criador se a lista está vazia', async () => {
    await writeFile(path.join(dir, 'output.json'), ready);
    await writeFile(
      path.join(dir, 'context', 'clickup.json'),
      JSON.stringify({
        improvementTickets: [
          {
            id: '1',
            name: 'Melhoria',
            url: 'u',
            owners: [{ username: 'Bia', email: 'bipessoa1@example.com' }],
          },
          {
            id: '2',
            name: 'Outra',
            url: 'v',
            owners: [],
            creator: { username: 'Dev' },
          },
        ],
      }),
    );
    const artifacts = await readCommunicationArtifacts(dir);
    expect(artifacts.tickets.map((ticket) => ticket.owners)).toEqual([
      [{ username: 'Bia', email: 'bipessoa1@example.com' }],
      [],
    ]);
  });

  it('treats missing context files as empty', async () => {
    await writeFile(path.join(dir, 'output.json'), ready);
    const artifacts = await readCommunicationArtifacts(dir);
    expect(artifacts.tickets).toEqual([]);
    expect(artifacts.warnings).toEqual([]);
  });

  it('rejects a missing or invalid output', async () => {
    await expect(readCommunicationArtifacts(dir)).rejects.toThrow(
      'output.json não foi gerado',
    );
    await writeFile(path.join(dir, 'output.json'), '{not json');
    await expect(readCommunicationArtifacts(dir)).rejects.toThrow(
      'output.json não é um JSON válido',
    );
    await writeFile(path.join(dir, 'output.json'), '{"status":"READY"}');
    await expect(readCommunicationArtifacts(dir)).rejects.toThrow(
      'Communication title must be a non-empty string',
    );
  });

  it('reads media and treats a missing file as no images', async () => {
    await writeFile(path.join(dir, 'output.json'), ready);
    expect((await readCommunicationArtifacts(dir)).media).toEqual([]);

    const image = { name: 'a.png', url: 'https://x/a.png', caption: 'Tela' };
    await writeFile(
      path.join(dir, 'media.json'),
      JSON.stringify([image, { name: 1 }]),
    );
    expect((await readCommunicationArtifacts(dir)).media).toEqual([image]);
  });
});
