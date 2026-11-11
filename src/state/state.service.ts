import { Inject, Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { updateJsonFileLocked } from './locked-json-update.js';
import type { OwnedLockOwner } from './owned-lock.js';
export const STATE_INSTANCE_ID = Symbol('STATE_INSTANCE_ID');

@Injectable()
export class StateService {
  private readonly stateDir: string;
  private readonly owner: OwnedLockOwner;
  private queue = Promise.resolve<unknown>(undefined);

  constructor(
    @Inject(RUNTIME_CONFIG) runtime: RuntimeConfig,
    @Inject(STATE_INSTANCE_ID) instanceId: string,
  ) {
    this.stateDir = runtime.stateDir;
    const startedAt = new Date().toISOString();
    this.owner = {
      instanceId,
      pid: process.pid,
      startedAt,
      heartbeatAt: startedAt,
    };
  }

  async read<T extends Record<string, unknown>>(name: string): Promise<T> {
    try {
      return JSON.parse(await readFile(path.join(this.stateDir, name), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {} as T;
      throw error;
    }
  }

  async update<T extends Record<string, unknown>>(
    name: string,
    mutate: (state: T) => void | Promise<void>,
  ): Promise<T> {
    let result: T | undefined;
    const operation = this.queue.then(async () => {
      result = await updateJsonFileLocked(
        path.join(this.stateDir, name),
        this.owner,
        mutate,
      );
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    if (result === undefined) throw new Error(`State update did not produce a result: ${name}`);
    return result;
  }
}
