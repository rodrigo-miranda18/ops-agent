import { describe, expect, it } from 'vitest';
import { isRunnerMessage } from './runner-messages.js';

describe('runner lifecycle messages', () => {
  it('accepts item lifecycle messages with non-empty keys', () => {
    expect(isRunnerMessage({ type: 'item-started', key: 'ticket:42' })).toBe(
      true,
    );
    expect(isRunnerMessage({ type: 'item-finished', key: 'ticket:42' })).toBe(
      true,
    );
  });

  it('rejects malformed lifecycle messages', () => {
    expect(isRunnerMessage({ type: 'item-started', key: '' })).toBe(false);
    expect(isRunnerMessage({ type: 'item-finished' })).toBe(false);
  });
});
