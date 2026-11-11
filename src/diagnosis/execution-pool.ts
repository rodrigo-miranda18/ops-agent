type PoolEntry<T> = {
  key?: string;
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
};

type QueuedEntry = PoolEntry<unknown>;

export class ExecutionPool {
  private readonly queue: QueuedEntry[] = [];
  private readonly activeKeys = new Set<string>();
  private runningCount = 0;
  private stopped = false;

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error('Execution pool concurrency must be at least 1');
  }

  get running() {
    return this.runningCount;
  }

  get pending() {
    return this.queue.length;
  }

  enqueue<T>(entry: { key?: string; run: () => Promise<T> }): Promise<T> {
    if (this.stopped)
      return Promise.reject(new Error('Execution pool is stopping'));
    const completion = new Promise<T>((resolve, reject) => {
      this.queue.push({ ...entry, resolve, reject } as QueuedEntry);
    });
    this.drain();
    return completion;
  }

  stopStarting() {
    this.stopped = true;
  }

  private drain() {
    if (this.stopped) return;
    while (this.runningCount < this.concurrency) {
      const index = this.queue.findIndex(
        ({ key }) => key === undefined || !this.activeKeys.has(key),
      );
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      this.start(entry);
    }
  }

  private start(entry: QueuedEntry) {
    this.runningCount += 1;
    if (entry.key) this.activeKeys.add(entry.key);
    void entry
      .run()
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.runningCount -= 1;
        if (entry.key) this.activeKeys.delete(entry.key);
        this.drain();
      });
  }
}
