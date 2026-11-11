import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerLogger } from '../runner/runner-logger.js';
import type { ClickUpContext } from './communication.types.js';
import {
  runCommunication,
  type CommunicationCodexInput,
  type CommunicationRunDeps,
} from './communication-run.js';

const TOKEN = 'scoped-installation-token-xyz';
const silentLogger: RunnerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function context(overrides: Partial<ClickUpContext> = {}): ClickUpContext {
  return {
    task: {
      id: 'abc',
      customId: 'TICKET-1',
      name: 'Exportar conversas',
      url: 'https://app.clickup.com/t/abc',
      description: 'Spec da exportação',
    },
    subtasks: [],
    comments: [],
    improvementTickets: [],
    imageUrls: ['https://t1.clickup-attachments.com/a/tela.jpg'],
    warnings: ['Membros do workspace indisponíveis: x'],
    ...overrides,
  };
}

async function readyOutput() {
  return readFile(new URL('./fixtures/ready.json', import.meta.url), 'utf8');
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

describe('runCommunication', () => {
  let root: string;
  let artifactDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'communication-run-'));
    artifactDir = path.join(root, 'results', 'c1', 'v1');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function deps(
    clickUp: ClickUpContext,
    stdouts: string[],
  ): CommunicationRunDeps & {
    codexInputs: CommunicationCodexInput[];
    scopedToken: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  } {
    const codexInputs: CommunicationCodexInput[] = [];
    let call = 0;
    return {
      codexInputs,
      collect: vi.fn(() => Promise.resolve(clickUp)),
      readPullRequest: vi.fn((ref) =>
        Promise.resolve({ title: `PR ${ref.number}`, diff: '+ code' }),
      ),
      scopedToken: vi.fn(() => Promise.resolve(TOKEN)),
      downloadImage: vi.fn((_url: string, destination: string) =>
        writeFile(destination, 'png'),
      ),
      runCodex: vi.fn((input: CommunicationCodexInput) => {
        codexInputs.push(input);
        const stdout = stdouts[Math.min(call, stdouts.length - 1)] ?? '';
        call += 1;
        return Promise.resolve({
          exitCode: 0,
          stdout,
          stderr: `GH_TOKEN=${input.ghToken ?? ''} leaked ${input.ghToken ?? ''}`,
        });
      }),
      logger: silentLogger,
    };
  }

  function args(history: unknown[] = []) {
    return {
      communicationId: 'c1',
      version: 1,
      taskId: 'abc',
      history,
      artifactDir,
      reposDir: '/repos',
      organization: 'example-org',
    };
  }

  it('does not mint a token when a pull request is cited', async () => {
    const fake = deps(
      context({
        comments: [
          {
            taskId: 'abc',
            author: 'dev',
            date: '',
            text: 'PR: github.com/Example-org/service-17/pull/42',
          },
        ],
      }),
      [await readyOutput()],
    );

    const output = await runCommunication(args(), fake);

    expect(output.status).toBe('READY');
    expect(fake.scopedToken).not.toHaveBeenCalled();
    expect(fake.codexInputs[0]?.ghToken).toBeNull();
    expect(fake.codexInputs[0]?.cwd).toBe('/repos');
    expect(
      JSON.parse(
        await readFile(
          path.join(
            artifactDir,
            'context',
            'pull-requests',
            'Example-org-service-17-42.json',
          ),
          'utf8',
        ),
      ),
    ).toEqual({ title: 'PR 42', diff: '+ code' });
  });

  it('passes the scoped token when no pull request is cited', async () => {
    const fake = deps(context(), [await readyOutput()]);

    await runCommunication(args(), fake);

    expect(fake.scopedToken).toHaveBeenCalledTimes(1);
    expect(fake.codexInputs[0]?.ghToken).toBe(TOKEN);
    expect(fake.codexInputs[0]?.imagePaths).toEqual([
      path.join(artifactDir, 'images', '1.jpg'),
    ]);
  });

  it('keeps going with a warning when the token cannot be minted', async () => {
    const fake = deps(context(), [await readyOutput()]);
    fake.scopedToken.mockRejectedValueOnce(new Error('app auth failed'));

    await runCommunication(args(), fake);

    expect(fake.codexInputs[0]?.ghToken).toBeNull();
    const warnings = JSON.parse(
      await readFile(
        path.join(artifactDir, 'context', 'warnings.json'),
        'utf8',
      ),
    ) as string[];
    expect(
      warnings.some((warning) => warning.includes('Token do GitHub')),
    ).toBe(true);
  });

  it('retries invalid JSON once and then fails', async () => {
    const fake = deps(context(), ['not json', '{"status":"READY"}']);

    await expect(runCommunication(args(), fake)).rejects.toThrow(
      /Invalid communication output/,
    );
    expect(fake.runCodex).toHaveBeenCalledTimes(2);
    expect(fake.codexInputs[1]?.prompt).toContain('A resposta anterior');
  });

  it('accepts a valid answer on the retry', async () => {
    const fake = deps(context(), ['not json', await readyOutput()]);

    const output = await runCommunication(args(), fake);

    expect(output.status).toBe('READY');
    expect(fake.runCodex).toHaveBeenCalledTimes(2);
  });

  it('fails when Codex exits with an error', async () => {
    const fake = deps(context(), [await readyOutput()]);
    vi.mocked(fake.runCodex).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'boom',
    });

    await expect(runCommunication(args(), fake)).rejects.toThrow(
      /Codex exited with code 1: boom/,
    );
  });

  it('does not mint a token when a cited pull request cannot be read', async () => {
    const fake = deps(
      context({
        comments: [
          {
            taskId: 'abc',
            author: 'dev',
            date: '',
            text: 'https://github.com/Example-org/service-17/pull/7',
          },
        ],
      }),
      [await readyOutput()],
    );
    vi.mocked(fake.readPullRequest).mockRejectedValueOnce(
      new Error('gh failed'),
    );

    await runCommunication(args(), fake);

    expect(fake.scopedToken).not.toHaveBeenCalled();
    expect(fake.codexInputs[0]?.ghToken).toBeNull();
    const warnings = JSON.parse(
      await readFile(
        path.join(artifactDir, 'context', 'warnings.json'),
        'utf8',
      ),
    ) as string[];
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'PR https://github.com/Example-org/service-17/pull/7 indisponível',
        ),
      ]),
    );
  });

  it('writes the artifacts and never writes the token', async () => {
    const fake = deps(context(), [
      `\`\`\`json\n${await readyOutput()}\n\`\`\``,
    ]);
    vi.mocked(fake.downloadImage).mockRejectedValueOnce(
      new Error(`HTTP 403 ${TOKEN}`),
    );
    const history = [
      { version: 1, feedback: null, output: null },
      { version: 2, feedback: 'mais curto', output: null },
    ];

    await runCommunication(args(history), fake);

    expect(fake.codexInputs[0]?.ghToken).toBe(TOKEN);
    const files = (await listFiles(artifactDir)).map((file) =>
      path.relative(artifactDir, file),
    );
    expect(files).toEqual(
      expect.arrayContaining([
        'context/clickup.json',
        'context/history.json',
        'context/warnings.json',
        'prompt.md',
        'output.json',
        'codex.log',
      ]),
    );
    const warnings = JSON.parse(
      await readFile(
        path.join(artifactDir, 'context', 'warnings.json'),
        'utf8',
      ),
    ) as string[];
    expect(warnings).toEqual(
      expect.arrayContaining([
        'Membros do workspace indisponíveis: x',
        expect.stringContaining('Imagem 1'),
      ]),
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(artifactDir, 'context', 'history.json'),
          'utf8',
        ),
      ),
    ).toEqual(history);
    expect(
      await readFile(path.join(artifactDir, 'prompt.md'), 'utf8'),
    ).toContain(artifactDir);
    for (const file of await listFiles(artifactDir))
      expect(await readFile(file, 'utf8')).not.toContain(TOKEN);
  });

  it('writes pull request files when cited', async () => {
    const fake = deps(
      context({
        task: {
          id: 'abc',
          customId: null,
          name: 'x',
          url: 'u',
          description:
            'github.com/Example-org/r/pull/1 e github.com/EXAMPLE-ORG/s/pull/2',
        },
      }),
      [await readyOutput()],
    );

    await runCommunication(args(), fake);

    expect(
      (
        await readdir(path.join(artifactDir, 'context', 'pull-requests'))
      ).sort(),
    ).toEqual(['EXAMPLE-ORG-s-2.json', 'Example-org-r-1.json']);
  });

  it('ignores pull requests from other organizations', async () => {
    const fake = deps(
      context({
        task: {
          id: 'abc',
          customId: null,
          name: 'x',
          url: 'u',
          description: 'Referência: github.com/outra-org/lib/pull/5',
        },
      }),
      [await readyOutput()],
    );

    await runCommunication(args(), fake);

    expect(fake.readPullRequest).not.toHaveBeenCalled();
    expect(fake.scopedToken).toHaveBeenCalledTimes(1);
    expect(fake.codexInputs[0]?.ghToken).toBe(TOKEN);
    expect(
      await readdir(path.join(artifactDir, 'context', 'pull-requests')),
    ).toEqual([]);
  });

  describe('images', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);

    async function outputWithImages(images: unknown[]) {
      return JSON.stringify({ ...JSON.parse(await readyOutput()), images });
    }

    function storage() {
      return {
        uploadDraft: vi.fn(() =>
          Promise.resolve({ name: 'a.png', url: 'https://signed/a.png' }),
        ),
        publish: vi.fn(),
      };
    }

    function pngDeps(stdout: string) {
      const fake = deps(context(), [stdout]);
      fake.downloadImage = vi.fn((_url: string, destination: string) =>
        writeFile(destination, PNG),
      );
      return fake;
    }

    async function json(...parts: string[]): Promise<unknown> {
      return JSON.parse(
        await readFile(path.join(artifactDir, ...parts), 'utf8'),
      );
    }

    it('uploads the selected image and records it for the card', async () => {
      const media = storage();
      const fake = pngDeps(
        await outputWithImages([{ index: 1, caption: 'Tela' }]),
      );
      await runCommunication(args(), { ...fake, media });

      expect(await json('context', 'images.json')).toEqual([
        { index: 1, file: '1.jpg' },
      ]);
      expect(media.uploadDraft).toHaveBeenCalledWith({
        body: PNG,
        contentType: 'image/png',
        extension: 'png',
      });
      expect(await json('media.json')).toEqual([
        { name: 'a.png', url: 'https://signed/a.png', caption: 'Tela' },
      ]);
    });

    it('keeps the version when the upload fails', async () => {
      const media = storage();
      media.uploadDraft.mockRejectedValueOnce(new Error('storage down'));
      const fake = pngDeps(
        await outputWithImages([{ index: 1, caption: 'Tela' }]),
      );
      const output = await runCommunication(args(), { ...fake, media });

      expect(output.status).toBe('READY');
      expect(await json('media.json')).toEqual([]);
      expect(await json('context', 'warnings.json')).toContainEqual(
        'Imagem 1 não foi enviada: storage down',
      );
    });

    it('uploads nothing without storage', async () => {
      const fake = pngDeps(
        await outputWithImages([{ index: 1, caption: 'Tela' }]),
      );
      await runCommunication(args(), fake);
      await expect(json('media.json')).rejects.toThrow('ENOENT');
    });

    it('uploads nothing for an insufficient version', async () => {
      const media = storage();
      const stdout = await readFile(
        new URL('./fixtures/insufficient.json', import.meta.url),
        'utf8',
      );
      await runCommunication(args(), { ...pngDeps(stdout), media });
      expect(media.uploadDraft).not.toHaveBeenCalled();
    });
  });
});
