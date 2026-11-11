import { describe, expect, it, vi } from 'vitest';
import { ExecutionPool } from './execution-pool.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ExecutionPool', () => {
  it('runs at most N entries concurrently', async () => {
    const pool = new ExecutionPool(2);
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const starts: string[] = [];

    const executions = [
      pool.enqueue({ key: 'a', run: () => (starts.push('a'), first.promise) }),
      pool.enqueue({ key: 'b', run: () => (starts.push('b'), second.promise) }),
      pool.enqueue({ key: 'c', run: () => (starts.push('c'), third.promise) }),
    ];
    await vi.waitFor(() => expect(starts).toEqual(['a', 'b']));
    first.resolve();
    await vi.waitFor(() => expect(starts).toEqual(['a', 'b', 'c']));
    second.resolve();
    third.resolve();
    await Promise.all(executions);
  });

  it('serializes the same key while starting the next eligible key', async () => {
    const pool = new ExecutionPool(2);
    const first = deferred();
    const duplicate = deferred();
    const other = deferred();
    const starts: string[] = [];

    const executions = [
      pool.enqueue({
        key: 'ticket:1',
        run: () => (starts.push('first'), first.promise),
      }),
      pool.enqueue({
        key: 'ticket:1',
        run: () => (starts.push('duplicate'), duplicate.promise),
      }),
      pool.enqueue({
        key: 'ticket:2',
        run: () => (starts.push('other'), other.promise),
      }),
    ];
    await vi.waitFor(() => expect(starts).toEqual(['first', 'other']));
    other.resolve();
    expect(starts).toEqual(['first', 'other']);
    first.resolve();
    await vi.waitFor(() =>
      expect(starts).toEqual(['first', 'other', 'duplicate']),
    );
    duplicate.resolve();
    await Promise.all(executions);
  });

  it('allows keyless entries to share capacity', async () => {
    const pool = new ExecutionPool(2);
    const first = deferred();
    const second = deferred();
    const starts: string[] = [];

    const executions = [
      pool.enqueue({ run: () => (starts.push('first'), first.promise) }),
      pool.enqueue({ run: () => (starts.push('second'), second.promise) }),
    ];
    await vi.waitFor(() => expect(starts).toEqual(['first', 'second']));
    first.resolve();
    second.resolve();
    await Promise.all(executions);
  });

  it('releases capacity and keys after rejection', async () => {
    const pool = new ExecutionPool(1);
    const next = vi.fn(async () => 'ok');

    await expect(
      pool.enqueue({
        key: 'ticket:1',
        run: async () => Promise.reject(new Error('boom')),
      }),
    ).rejects.toThrow('boom');
    await expect(pool.enqueue({ key: 'ticket:1', run: next })).resolves.toBe(
      'ok',
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('stops starting queued entries', async () => {
    const pool = new ExecutionPool(1);
    const active = deferred();
    const queued = vi.fn(async () => undefined);
    const activeExecution = pool.enqueue({
      key: 'a',
      run: () => active.promise,
    });
    const queuedExecution = pool.enqueue({ key: 'b', run: queued });
    await vi.waitFor(() => expect(pool.running).toBe(1));

    pool.stopStarting();
    active.resolve();
    await activeExecution;
    await new Promise((resolve) => setImmediate(resolve));

    expect(queued).not.toHaveBeenCalled();
    expect(pool.pending).toBe(1);
    void queuedExecution;
  });
});
