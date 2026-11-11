import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import {
  STORAGE_MAINTENANCE_CONFIG,
  type StorageMaintenanceConfig,
} from '../config/storage-maintenance-config.js';

const RUNNER_PATH = fileURLToPath(
  new URL('./storage-maintenance-runner.js', import.meta.url),
);

@Injectable()
export class StorageMaintenanceExecutionService implements OnApplicationShutdown {
  private readonly children = new Map<ChildProcess, Promise<void>>();

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly runtime: RuntimeConfig,
    @Inject(STORAGE_MAINTENANCE_CONFIG)
    private readonly config: StorageMaintenanceConfig,
  ) {}

  execute(trigger: 'cron'): Promise<number> {
    return this.spawnRunner(trigger);
  }

  async onApplicationShutdown(): Promise<void> {
    const completions = [...this.children.values()];
    for (const child of this.children.keys()) terminateProcessTree(child);
    await Promise.allSettled(completions);
  }

  private spawnRunner(trigger: 'cron'): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [RUNNER_PATH, '--execute', `--trigger=${trigger}`],
        {
          cwd: this.runtime.cwd,
          env: this.runtime.processEnv,
          stdio: 'inherit',
          detached: process.platform !== 'win32',
        },
      );
      let complete!: () => void;
      const completion = new Promise<void>((done) => {
        complete = done;
      });
      this.children.set(child, completion);
      const timeout = setTimeout(
        () => terminateProcessTree(child),
        this.config.timeoutMs,
      );
      let settled = false;
      const finish = (exitCode?: number, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.children.delete(child);
        complete();
        if (error) reject(error);
        else resolve(exitCode ?? 1);
      };
      child.once('error', (error) => finish(undefined, error));
      child.once('close', (code) => finish(code ?? 1));
    });
  }
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  child.kill('SIGTERM');
}
