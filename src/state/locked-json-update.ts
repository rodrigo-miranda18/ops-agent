import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './atomic-write.js';
import {
  acquireOwnedLock,
  type OwnedLockOptions,
  type OwnedLockOwner,
} from './owned-lock.js';

export type LockedJsonUpdateOptions = Omit<
  OwnedLockOptions,
  'directory' | 'owner'
>;

async function readJsonObject<T extends Record<string, unknown>>(
  filename: string,
): Promise<T> {
  try {
    const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Expected JSON object in ${filename}`);
    }
    return value as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {} as T;
    throw error;
  }
}

export async function updateJsonFileLocked<T extends Record<string, unknown>>(
  filename: string,
  owner: OwnedLockOwner,
  mutate: (state: T) => void | Promise<void>,
  options: LockedJsonUpdateOptions = {},
): Promise<T> {
  const lock = await acquireOwnedLock({
    ...options,
    directory: `${filename}.lock`,
    owner,
  });
  try {
    const state = await readJsonObject<T>(filename);
    await mutate(state);
    await writeJsonAtomic(filename, state);
    return state;
  } finally {
    await lock.release();
  }
}
