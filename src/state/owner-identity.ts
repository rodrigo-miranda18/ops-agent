import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export function createInstanceId(prefix?: 'runner'): string {
  const identity = `${hostname()}:${randomUUID()}`;
  return prefix === 'runner' ? `runner:${identity}` : identity;
}
