import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateService } from '../state/state.service.js';
import type { DiagnosisExecutionService } from './diagnosis-execution.service.js';
import type { DiagnosisRuns } from './diagnosis-run.js';
import { RunRecoveryService } from './run-recovery.service.js';

class FakeState {
  files: Record<string, Record<string, unknown>> = {};

  read<T extends Record<string, unknown>>(name: string): Promise<T> {
    return Promise.resolve(structuredClone(this.files[name] || {}) as T);
  }

  async update<T extends Record<string, unknown>>(
    name: string,
    mutate: (state: T) => void,
  ): Promise<T> {
    const state = structuredClone(this.files[name] || {}) as T;
    mutate(state);
    this.files[name] = state;
    return state;
  }
}

function interruptedRuns(): DiagnosisRuns {
  return {
    original: {
      runId: 'original',
      ticketId: '42',
      source: 'manual',
      force: false,
      notify: true,
      remediation: 'auto',
      status: 'interrupted',
      createdAt: '2026-10-03T12:00:00.000Z',
    },
  };
}

describe('RunRecoveryService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('persists the original marker and resumed queued record before scheduling', async () => {
    const state = new FakeState();
    state.files['diagnosis-runs.json'] = interruptedRuns();
    const schedulePersistedDiagnosis = vi.fn(async () => undefined);
    const executions = {
      schedulePersistedDiagnosis,
      schedulePersistedReorientation: vi.fn(async () => undefined),
    };
    const service = new RunRecoveryService(
      state as unknown as StateService,
      executions as unknown as DiagnosisExecutionService,
      'new-instance',
    );

    await service.recover(new Date('2026-10-03T12:05:00.000Z'));

    const runs = state.files['diagnosis-runs.json'] as DiagnosisRuns;
    expect(runs.original.resumedBy).toHaveLength(1);
    const resumedId = runs.original.resumedBy?.[0];
    expect(runs[resumedId || '']).toEqual(
      expect.objectContaining({
        runId: resumedId,
        ticketId: '42',
        status: 'queued',
        resumedFrom: 'original',
        resumeAttempt: 1,
        ownerInstanceId: 'new-instance',
      }),
    );
    expect(schedulePersistedDiagnosis).toHaveBeenCalledWith(
      runs[resumedId || ''],
    );
  });

  it('retries scheduling a persisted resumed record without duplicating it', async () => {
    const state = new FakeState();
    state.files['diagnosis-runs.json'] = interruptedRuns();
    const schedulePersistedDiagnosis = vi
      .fn()
      .mockRejectedValueOnce(new Error('pool unavailable'))
      .mockResolvedValue(undefined);
    const executions = {
      schedulePersistedDiagnosis,
      schedulePersistedReorientation: vi.fn(async () => undefined),
    };
    const service = new RunRecoveryService(
      state as unknown as StateService,
      executions as unknown as DiagnosisExecutionService,
      'new-instance',
    );
    const now = new Date('2026-10-03T12:05:00.000Z');

    await service.recover(now);
    await service.recover(now);

    const runs = state.files['diagnosis-runs.json'] as DiagnosisRuns;
    expect(
      Object.values(runs).filter((run) => run.resumedFrom === 'original'),
    ).toHaveLength(1);
    expect(schedulePersistedDiagnosis).toHaveBeenCalledTimes(2);
  });
});
