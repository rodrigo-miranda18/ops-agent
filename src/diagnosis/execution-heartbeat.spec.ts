import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateService } from '../state/state.service.js';
import { ExecutionHeartbeat } from './execution-heartbeat.js';

class FakeState {
  files: Record<string, Record<string, Record<string, unknown>>> = {};
  updates: string[] = [];

  async update(
    name: string,
    mutate: (state: Record<string, Record<string, unknown>>) => void,
  ) {
    const state = structuredClone(this.files[name] || {});
    mutate(state);
    this.files[name] = state;
    this.updates.push(name);
    return state;
  }
}

describe('ExecutionHeartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('renews only running records owned by this instance', async () => {
    const state = new FakeState();
    state.files['diagnosis-runs.json'] = {
      own: { status: 'running', ownerInstanceId: 'instance' },
      queued: { status: 'queued', ownerInstanceId: 'instance' },
      foreign: { status: 'running', ownerInstanceId: 'other' },
    };
    state.files['remediation-reorientations.json'] = {
      reorientation: { status: 'running', ownerInstanceId: 'instance' },
    };
    const now = new Date('2026-10-03T12:00:00.000Z');
    const heartbeat = new ExecutionHeartbeat(
      state as unknown as StateService,
      'instance',
      { now: () => now },
    );

    await heartbeat.tick();

    expect(state.files['diagnosis-runs.json'].own?.heartbeatAt).toBe(
      now.toISOString(),
    );
    expect(
      state.files['diagnosis-runs.json'].queued?.heartbeatAt,
    ).toBeUndefined();
    expect(
      state.files['diagnosis-runs.json'].foreign?.heartbeatAt,
    ).toBeUndefined();
    expect(
      state.files['remediation-reorientations.json'].reorientation?.heartbeatAt,
    ).toBe(now.toISOString());
    expect(state.updates).toEqual([
      'diagnosis-runs.json',
      'remediation-reorientations.json',
    ]);
  });

  it('stops its timer during shutdown', async () => {
    vi.useFakeTimers();
    const state = new FakeState();
    const heartbeat = new ExecutionHeartbeat(
      state as unknown as StateService,
      'instance',
    );
    heartbeat.start();
    heartbeat.stop();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(state.updates).toEqual([]);
  });
});
