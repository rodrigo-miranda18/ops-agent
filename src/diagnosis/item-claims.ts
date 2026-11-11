import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  acquireOwnedLock,
  startOwnedLockHeartbeat,
  type OwnedLockHandle,
  type OwnedLockOptions,
  type OwnedLockOwner,
} from '../state/owned-lock.js';

export function itemKey(input: {
  ticketId?: string;
  incidentId?: string;
  reorientationTicketId?: string;
}): string | undefined {
  if (input.ticketId) return `ticket:${input.ticketId}`;
  if (input.incidentId) return `incident:${input.incidentId}`;
  if (input.reorientationTicketId)
    return `ticket:${input.reorientationTicketId}`;
  return undefined;
}

export function itemClaimDirectory(stateDir: string, key: string): string {
  const readable = key.replace(/[^A-Za-z0-9_-]/g, '_');
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return path.join(stateDir, 'item-locks', `${readable}-${hash}`);
}

type ItemClaimOptions = {
  stateDir: string;
  key: string;
  owner: OwnedLockOwner;
  batch: boolean;
} & Pick<OwnedLockOptions, 'leaseMs' | 'now' | 'sleep' | 'pollIntervalMs'>;

export async function withItemClaim<T>(
  options: ItemClaimOptions,
  run: () => Promise<T>,
): Promise<{ status: 'processed'; value: T } | { status: 'skipped' }> {
  let claim: OwnedLockHandle;
  try {
    claim = await acquireOwnedLock({
      directory: itemClaimDirectory(options.stateDir, options.key),
      owner: options.owner,
      leaseMs: options.leaseMs,
      waitTimeoutMs: 0,
      pollIntervalMs: options.pollIntervalMs,
      now: options.now,
      sleep: options.sleep,
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith('Timed out acquiring owned lock:')
    )
      throw error;
    if (options.batch) return { status: 'skipped' };
    throw new Error(`Item is already being processed: ${options.key}`, {
      cause: error,
    });
  }

  const stopHeartbeat = startOwnedLockHeartbeat(claim);
  try {
    return { status: 'processed', value: await run() };
  } finally {
    await stopHeartbeat();
    await claim.release();
  }
}
