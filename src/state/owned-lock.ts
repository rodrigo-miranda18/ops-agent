import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export type OwnedLockOwner = {
  instanceId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
};

type PersistedOwner = {
  instance_id: string;
  pid: number;
  started_at: string;
  heartbeat_at: string;
  fencing_token?: string;
  released_at?: string;
};

export type OwnedLockOptions = {
  directory: string;
  owner: OwnedLockOwner;
  leaseMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type OwnedLockHandle = {
  owner: OwnedLockOwner;
  token: string;
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
};

export type OwnedLockState = 'missing' | 'live' | 'released' | 'expired';

const activeReleases = new Set<() => Promise<void>>();

export async function releaseAllOwnedLocks() {
  await Promise.allSettled([...activeReleases].map((release) => release()));
}

export function startOwnedLockHeartbeat(
  handle: OwnedLockHandle,
  intervalMs = 30_000,
  onError: (error: Error) => void = () => undefined,
) {
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(() => handle.heartbeat())
      .catch((error: Error) => onError(error));
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

function toPersistedOwner(
  owner: OwnedLockOwner,
  fencingToken: string,
  releasedAt?: string,
): PersistedOwner {
  return {
    instance_id: owner.instanceId,
    pid: owner.pid,
    started_at: owner.startedAt,
    heartbeat_at: owner.heartbeatAt,
    fencing_token: fencingToken,
    ...(releasedAt === undefined ? {} : { released_at: releasedAt }),
  };
}

function parsePersistedOwner(value: unknown): PersistedOwner | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const owner = value as Record<string, unknown>;
  if (
    typeof owner.instance_id !== 'string' ||
    typeof owner.pid !== 'number' ||
    typeof owner.started_at !== 'string' ||
    typeof owner.heartbeat_at !== 'string' ||
    (owner.fencing_token !== undefined && typeof owner.fencing_token !== 'string') ||
    (owner.released_at !== undefined && typeof owner.released_at !== 'string')
  ) {
    return undefined;
  }
  return {
    instance_id: owner.instance_id,
    pid: owner.pid,
    started_at: owner.started_at,
    heartbeat_at: owner.heartbeat_at,
    fencing_token: owner.fencing_token,
    released_at: owner.released_at,
  };
}

async function readPersistedOwner(directory: string): Promise<PersistedOwner | undefined> {
  try {
    return parsePersistedOwner(
      JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')),
    );
  } catch {
    return undefined;
  }
}

async function readPinnedOwner(file: FileHandle): Promise<PersistedOwner | undefined> {
  const { size } = await file.stat();
  const content = Buffer.alloc(size);
  await file.read(content, 0, size, 0);
  return parsePersistedOwner(JSON.parse(content.toString('utf8')));
}

async function writePinnedOwner(
  file: FileHandle,
  owner: OwnedLockOwner,
  token: string,
  releasedAt?: string,
): Promise<void> {
  const content = Buffer.from(
    `${JSON.stringify(toPersistedOwner(owner, token, releasedAt), null, 2)}\n`,
  );
  await file.write(content, 0, content.length, 0);
  await file.truncate(content.length);
}

function hasExpired(timestamp: string, leaseMs: number, now: Date): boolean {
  const time = Date.parse(timestamp);
  return Number.isNaN(time) || now.getTime() - time >= leaseMs;
}

export async function inspectOwnedLock(
  directory: string,
  options: { leaseMs?: number; now?: Date } = {},
): Promise<OwnedLockState> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? new Date();
  const owner = await readPersistedOwner(directory);
  if (owner !== undefined) {
    if (owner.released_at !== undefined) return 'released';
    return hasExpired(owner.heartbeat_at, leaseMs, now) ? 'expired' : 'live';
  }
  try {
    return hasExpired((await stat(directory)).mtime.toISOString(), leaseMs, now)
      ? 'expired'
      : 'live';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function removeNormallyReleasedLock(directory: string): Promise<void> {
  const releasedDirectory = `${directory}.released-${randomUUID()}`;
  try {
    await rename(directory, releasedDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rm(releasedDirectory, { recursive: true, force: true });
}

async function takeOverInactiveLock(
  directory: string,
  leaseMs: number,
  now: Date,
): Promise<boolean> {
  const guardPath = `${directory}.takeover`;
  let guard: FileHandle;
  try {
    guard = await open(guardPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const state = await inspectOwnedLock(directory, { leaseMs, now });
    if (state === 'released') {
      await removeNormallyReleasedLock(directory);
      return true;
    }
    if (state === 'expired') {
      try {
        await rename(directory, `${directory}.stale-${now.toISOString()}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return true;
    }
    return state === 'missing';
  } finally {
    await guard.close();
    await rm(guardPath, { force: true });
  }
}

export async function acquireOwnedLock(
  options: OwnedLockOptions,
): Promise<OwnedLockHandle> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const waitedAt = now().getTime();
  const token = randomUUID();
  const owner = { ...options.owner };
  const ownerFile = path.join(options.directory, 'owner.json');
  await mkdir(path.dirname(options.directory), { recursive: true });

  while (true) {
    try {
      await mkdir(options.directory);
      const acquiredAt = now().toISOString();
      owner.startedAt = acquiredAt;
      owner.heartbeatAt = acquiredAt;
      await writeJsonAtomic(ownerFile, toPersistedOwner(owner, token));
      const pinnedOwnerFile = await open(ownerFile, 'r+');
      if ((await readPinnedOwner(pinnedOwnerFile))?.fencing_token !== token) {
        await pinnedOwnerFile.close();
        continue;
      }
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        activeReleases.delete(release);
        try {
          const pinnedOwner = await readPinnedOwner(pinnedOwnerFile);
          if (pinnedOwner?.fencing_token !== token) return;
          await writePinnedOwner(
            pinnedOwnerFile,
            owner,
            token,
            now().toISOString(),
          );
        } finally {
          await pinnedOwnerFile.close();
        }
      };
      const handle: OwnedLockHandle = {
        owner,
        token,
        heartbeat: async () => {
          if (
            released ||
            (await readPinnedOwner(pinnedOwnerFile))?.fencing_token !== token
          )
            return;
          const heartbeatAt = now().toISOString();
          await writePinnedOwner(
            pinnedOwnerFile,
            { ...owner, heartbeatAt },
            token,
          );
          owner.heartbeatAt = heartbeatAt;
        },
        release,
      };
      activeReleases.add(release);
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    const currentTime = now();
    if (await takeOverInactiveLock(options.directory, leaseMs, currentTime))
      continue;

    if (currentTime.getTime() - waitedAt >= waitTimeoutMs) {
      throw new Error(`Timed out acquiring owned lock: ${options.directory}`);
    }
    await sleep(
      Math.min(pollIntervalMs, waitTimeoutMs - (currentTime.getTime() - waitedAt)),
    );
  }
}
