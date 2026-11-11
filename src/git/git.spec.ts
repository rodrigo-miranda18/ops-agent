import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChildProcess } from '../common/fake-child-process.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { findGitRepositories, runGit, synchronizeRepositories } =
  await import('./git.js');

type SpawnCall = [string, string[], { cwd: string; env: NodeJS.ProcessEnv }];

describe('git adapter', () => {
  let root: string;

  beforeEach(async () => {
    spawnMock.mockReset();
    root = await mkdtemp(path.join(os.tmpdir(), 'git-spec-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('runGit roda no repositório sem prompt e devolve stdout aparado', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const promise = runGit({ repositorySyncTimeoutMs: 1000 }, '/repo', [
      'rev-parse',
      'HEAD',
    ]);
    child.finish({ stdout: 'abc\n' }, 0);

    await expect(promise).resolves.toBe('abc');
    const [command, args, options] = spawnMock.mock.calls[0] as SpawnCall;
    expect(command).toBe('git');
    expect(args).toEqual(['rev-parse', 'HEAD']);
    expect(options.cwd).toBe('/repo');
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('runGit exposes only Git, network, and GitHub helper configuration', async () => {
    vi.stubEnv('PATH', '/usr/bin');
    vi.stubEnv('HOME', '/home/app');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.internal');
    vi.stubEnv('GIT_AUTHOR_NAME', 'Driva Ops Agent');
    vi.stubEnv('GITHUB_AUTH_MODE', 'app');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_FILE', '/run/secrets/github.pem');
    vi.stubEnv('CLICKUP_API_TOKEN', 'clickup-secret');
    vi.stubEnv('SALES_POSTGRESQL_PASSWORD', 'database-secret');
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = runGit({ repositorySyncTimeoutMs: 1000 }, '/repo', [
      'fetch',
    ]);
    child.finish({}, 0);
    await promise;

    const options = (spawnMock.mock.calls[0] as SpawnCall)[2];
    expect(options.env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/app',
      HTTPS_PROXY: 'http://proxy.internal',
      GIT_AUTHOR_NAME: 'Driva Ops Agent',
      GITHUB_AUTH_MODE: 'app',
      GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github.pem',
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(options.env).not.toHaveProperty('CLICKUP_API_TOKEN');
    expect(options.env).not.toHaveProperty('SALES_POSTGRESQL_PASSWORD');
  });

  it('runGit sanitiza o erro e mata o processo no timeout', async () => {
    const failing = new FakeChildProcess();
    spawnMock.mockReturnValue(failing);
    const failed = runGit({ repositorySyncTimeoutMs: 1000 }, '/repo', [
      'fetch',
    ]);
    failing.finish({ stderr: 'https://user:secret@github.com denied\n' }, 1);
    await expect(failed).rejects.toThrow(
      'git fetch failed: https://[REDACTED_CREDENTIALS]@github.com denied',
    );

    vi.useFakeTimers();
    const hanging = new FakeChildProcess();
    spawnMock.mockReturnValue(hanging);
    const timedOut = runGit({ repositorySyncTimeoutMs: 1000 }, '/repo', [
      'fetch',
    ]);
    vi.advanceTimersByTime(1000);
    expect(hanging.killed).toEqual(['SIGTERM']);
    hanging.finish({}, null, 'SIGTERM');
    await expect(timedOut).rejects.toThrow(
      'git fetch failed: terminated by SIGTERM',
    );
  });

  it('findGitRepositories ignora node_modules, ocultos e a lista de ignorados', async () => {
    for (const dir of ['a/.git', 'b/.git', 'c/node_modules/d/.git', '.e/.git'])
      await mkdir(path.join(root, dir), { recursive: true });
    const log = vi.fn();

    await expect(findGitRepositories(root, ['b'], log)).resolves.toEqual([
      path.join(root, 'a'),
    ]);
    expect(log.mock.calls).toEqual([
      ['Repository found: a'],
      ['Repository ignored: b'],
    ]);
  });

  it('synchronizeRepositories recusa repositório com mudanças locais', async () => {
    await mkdir(path.join(root, 'a', '.git'), { recursive: true });
    spawnMock.mockImplementation(() => {
      const child = new FakeChildProcess();
      setImmediate(() => child.finish({ stdout: ' M file\n' }, 0));
      return child;
    });

    await expect(
      synchronizeRepositories(
        {
          reposDir: root,
          repositorySyncIgnore: [],
          repositorySyncTimeoutMs: 1,
        },
        vi.fn(),
      ),
    ).rejects.toThrow(
      'Repository a has local changes; refusing to synchronize it',
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('synchronizeRepositories faz fetch e reset para origin/main', async () => {
    await mkdir(path.join(root, 'a', '.git'), { recursive: true });
    const outputs: Record<string, string> = {
      'status --porcelain': '',
      'rev-parse refs/heads/main': 'old000000000000',
      'rev-parse refs/remotes/origin/main': 'new000000000000',
      'rev-parse HEAD': 'new000000000000',
      'rev-parse origin/main': 'new000000000000',
    };
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeChildProcess();
      const stdout = outputs[args.join(' ')] ?? '';
      setImmediate(() => child.finish({ stdout }, 0));
      return child;
    });
    const log = vi.fn();

    await synchronizeRepositories(
      { reposDir: root, repositorySyncIgnore: [], repositorySyncTimeoutMs: 1 },
      log,
    );

    const commands = spawnMock.mock.calls.map((call) =>
      (call as SpawnCall)[1].join(' '),
    );
    expect(commands).toEqual([
      'status --porcelain',
      'remote get-url origin',
      'rev-parse --verify refs/heads/main',
      'fetch --prune origin main',
      'rev-parse --verify refs/remotes/origin/main',
      'rev-parse refs/heads/main',
      'rev-parse refs/remotes/origin/main',
      'switch main',
      'reset --hard origin/main',
      'rev-parse HEAD',
      'rev-parse origin/main',
    ]);
    expect(log).toHaveBeenCalledWith(
      'Repository a will reset old000000000 -> new000000000',
    );
    expect(log).toHaveBeenLastCalledWith('Repository a ready at new000000000');
  });

  it('inicializa submódulos do service-09 ausentes', async () => {
    const parent = path.join(root, 'service-09');
    await mkdir(path.join(parent, '.git'), { recursive: true });
    await writeFile(
      path.join(parent, '.gitmodules'),
      '[submodule "api"]\n\tpath = linkedin-api\n',
    );
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeChildProcess();
      setImmediate(() =>
        args[0] === 'status'
          ? child.finish({ stdout: 'x' }, 0)
          : child.finish({}, 0),
      );
      return child;
    });
    const log = vi.fn();

    await expect(
      synchronizeRepositories(
        {
          reposDir: root,
          repositorySyncIgnore: [],
          repositorySyncTimeoutMs: 1,
        },
        log,
      ),
    ).rejects.toThrow('has local changes');

    const calls = spawnMock.mock.calls.map((call) => {
      const [, args, options] = call as SpawnCall;
      return [path.relative(root, options.cwd), args.join(' ')];
    });
    expect(calls.slice(0, 3)).toEqual([
      ['service-09', 'submodule sync --recursive'],
      ['service-09', 'submodule update --init --recursive -- linkedin-api'],
      ['service-09/linkedin-api', 'switch main'],
    ]);
    expect(log).toHaveBeenCalledWith(
      'Initializing service-09 submodule: linkedin-api',
    );
  });
});
