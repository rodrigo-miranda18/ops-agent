import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createInstanceId } from './owner-identity.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

describe('createInstanceId', () => {
  it('creates a Nest instance ID from hostname and UUID', () => {
    expect(createInstanceId()).toMatch(new RegExp(`^${hostname()}:${uuid}$`, 'i'));
  });

  it('creates a manual runner instance ID from hostname and UUID', () => {
    expect(createInstanceId('runner')).toMatch(
      new RegExp(`^runner:${hostname()}:${uuid}$`, 'i'),
    );
  });

  it('creates distinct IDs for separate calls', () => {
    expect(createInstanceId()).not.toBe(createInstanceId());
  });
});
