import { describe, expect, it } from 'vitest';
import { isCommunicationRunnerMessage } from './runner-messages.js';

describe('isCommunicationRunnerMessage', () => {
  it('accepts ready and failed messages', () => {
    expect(
      isCommunicationRunnerMessage({
        type: 'communication-ready',
        communicationId: 'c1',
        version: 1,
      }),
    ).toBe(true);
    expect(
      isCommunicationRunnerMessage({
        type: 'communication-failed',
        communicationId: 'c1',
        version: 2,
        error: 'boom',
      }),
    ).toBe(true);
  });

  it('rejects malformed messages', () => {
    expect(isCommunicationRunnerMessage(null)).toBe(false);
    expect(
      isCommunicationRunnerMessage({
        type: 'communication-ready',
        communicationId: '',
        version: 1,
      }),
    ).toBe(false);
    expect(
      isCommunicationRunnerMessage({
        type: 'communication-ready',
        communicationId: 'c1',
        version: 0,
      }),
    ).toBe(false);
    expect(
      isCommunicationRunnerMessage({
        type: 'communication-failed',
        communicationId: 'c1',
        version: 1,
      }),
    ).toBe(false);
    expect(
      isCommunicationRunnerMessage({
        type: 'ticket-diagnosis-ready',
        communicationId: 'c1',
        version: 1,
      }),
    ).toBe(false);
  });
});
