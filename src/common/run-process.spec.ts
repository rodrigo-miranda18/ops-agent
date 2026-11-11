import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChildProcess } from './fake-child-process.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { runProcess } = await import('./run-process.js');

describe('runProcess', () => {
  let child: FakeChildProcess;

  beforeEach(() => {
    child = new FakeChildProcess();
    spawnMock.mockReset().mockReturnValue(child);
  });

  it('escreve input no stdin e devolve saída bruta com exit code', async () => {
    const promise = runProcess('codex', ['exec', '-'], {
      cwd: '/repos',
      env: { PATH: '/bin' },
      timeoutMs: 1000,
      input: 'prompt',
    });
    child.finish({ stdout: 'out', stderr: 'err' }, 2);

    await expect(promise).resolves.toEqual({
      exitCode: 2,
      signal: null,
      stdout: 'out',
      stderr: 'err',
    });
    expect(child.input).toBe('prompt');
    expect(spawnMock).toHaveBeenCalledWith('codex', ['exec', '-'], {
      cwd: '/repos',
      env: { PATH: '/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('ignora close depois de erro', async () => {
    const promise = runProcess('git', ['status'], {
      env: {},
      timeoutMs: 1000,
    });
    child.emit('error', new Error('ENOENT'));
    child.finish({}, 0);

    await expect(promise).rejects.toThrow('ENOENT');
  });
});
