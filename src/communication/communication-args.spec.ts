import { describe, expect, it } from 'vitest';
import {
  buildCommunicationHistory,
  parseCommunicationArgs,
} from './communication-args.js';
import type { CommunicationVersion } from './communication-store.js';

function version(
  number: number,
  feedback: string | null,
  status: CommunicationVersion['status'] = 'ready',
): CommunicationVersion {
  return {
    number,
    feedback,
    createdAt: '',
    status,
    runId: `r${number}`,
    cardMessageName: null,
    artifactDir: `/results/c/v${number}`,
  };
}

describe('parseCommunicationArgs', () => {
  it('parses the communication ID and version', () => {
    expect(
      parseCommunicationArgs(['--communication-id=abc-1', '--version=2']),
    ).toEqual({ communicationId: 'abc-1', version: 2, help: false });
  });

  it('rejects unsafe IDs, invalid versions and unknown arguments', () => {
    expect(() =>
      parseCommunicationArgs(['--communication-id=../x', '--version=1']),
    ).toThrow(/communication-id/);
    expect(() =>
      parseCommunicationArgs(['--communication-id=a', '--version=0']),
    ).toThrow(/version/);
    expect(() => parseCommunicationArgs(['--other=1'])).toThrow(/Unknown/);
  });
});

describe('buildCommunicationHistory', () => {
  it('is empty for the first version', () => {
    expect(
      buildCommunicationHistory({ versions: [version(1, null)] }, 1, new Map()),
    ).toEqual([]);
  });

  it('lists prior versions with their outputs and the current feedback', () => {
    const record = {
      versions: [
        version(1, null),
        version(2, 'mais curto'),
        version(3, 'sem emoji'),
      ],
    };
    expect(
      buildCommunicationHistory(record, 3, new Map([[1, { title: 'v1' }]])),
    ).toEqual([
      { version: 1, status: 'ready', feedback: null, output: { title: 'v1' } },
      { version: 2, status: 'ready', feedback: 'mais curto', output: null },
      { version: 3, status: null, feedback: 'sem emoji', output: null },
    ]);
  });

  it('marks failed versions so their feedback is still applied', () => {
    const record = {
      versions: [
        version(1, null),
        version(2, 'mais curto', 'failed'),
        version(3, 'sem emoji'),
      ],
    };
    expect(
      buildCommunicationHistory(record, 3, new Map([[1, { title: 'v1' }]])),
    ).toEqual([
      { version: 1, status: 'ready', feedback: null, output: { title: 'v1' } },
      { version: 2, status: 'failed', feedback: 'mais curto', output: null },
      { version: 3, status: null, feedback: 'sem emoji', output: null },
    ]);
  });
});
