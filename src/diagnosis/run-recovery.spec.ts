import { describe, expect, it } from 'vitest';
import type { DiagnosisRuns } from './diagnosis-run.js';
import { planRunRecovery } from './run-recovery.js';

const now = new Date('2026-10-03T12:05:00.000Z');
const old = '2026-10-03T12:00:00.000Z';
const fresh = '2026-10-03T12:04:30.000Z';

function run(
  overrides: Partial<DiagnosisRuns[string]> = {},
): DiagnosisRuns[string] {
  return {
    runId: 'run-1',
    ticketId: '42',
    source: 'manual',
    force: false,
    notify: true,
    remediation: 'auto',
    status: 'running',
    createdAt: old,
    startedAt: old,
    ownerInstanceId: 'old-instance',
    ...overrides,
  };
}

describe('planRunRecovery', () => {
  it('interrupts and resumes an expired foreign single-item run', () => {
    const plan = planRunRecovery(
      { 'run-1': run() },
      {},
      'new-instance',
      now,
      120_000,
    );

    expect(plan.diagnoses).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        interrupt: true,
        resumes: [
          expect.objectContaining({
            ticketId: '42',
            source: 'manual',
            force: true,
            resumeAttempt: 1,
          }),
        ],
      }),
    ]);
  });

  it('does not touch live foreign or own-instance runs', () => {
    const plan = planRunRecovery(
      {
        live: run({ runId: 'live', heartbeatAt: fresh }),
        own: run({ runId: 'own', ownerInstanceId: 'new-instance' }),
      },
      {},
      'new-instance',
      now,
      120_000,
    );

    expect(plan.diagnoses).toEqual([]);
  });

  it('resumes an already interrupted run once and honors the attempt limit', () => {
    const plan = planRunRecovery(
      {
        resumable: run({ runId: 'resumable', status: 'interrupted' }),
        handled: run({
          runId: 'handled',
          status: 'interrupted',
          resumedBy: [],
        }),
        capped: run({
          runId: 'capped',
          status: 'interrupted',
          resumeAttempt: 2,
        }),
      },
      {},
      'new-instance',
      now,
      120_000,
    );

    expect(plan.diagnoses.map(({ runId }) => runId)).toEqual([
      'resumable',
      'capped',
    ]);
    expect(plan.diagnoses[0]?.resumes).toHaveLength(1);
    expect(plan.diagnoses[1]?.resumes).toEqual([]);
  });

  it('resumes only active items from an interrupted cron batch', () => {
    const plan = planRunRecovery(
      {
        cron: run({
          runId: 'cron',
          ticketId: undefined,
          source: 'cron',
          status: 'interrupted',
          activeItems: ['ticket:1', 'incident:grafana-2'],
        }),
      },
      {},
      'new-instance',
      now,
      120_000,
    );

    expect(plan.diagnoses[0]?.resumes).toEqual([
      expect.objectContaining({ ticketId: '1', incidentId: undefined }),
      expect.objectContaining({ incidentId: 'grafana-2', ticketId: undefined }),
    ]);
  });

  it('recovers a foreign queued run after its owner lease expires', () => {
    const plan = planRunRecovery(
      {
        queued: run({
          runId: 'queued',
          status: 'queued',
          startedAt: undefined,
        }),
      },
      {},
      'new-instance',
      now,
      120_000,
    );

    expect(plan.diagnoses[0]).toEqual(
      expect.objectContaining({ runId: 'queued', interrupt: true }),
    );
  });

  it('requeues an interrupted or expired reorientation up to two attempts', () => {
    const plan = planRunRecovery(
      {},
      {
        reorientation: {
          id: 'reorientation',
          ticketId: '42',
          status: 'running',
          ownerInstanceId: 'old-instance',
          heartbeatAt: old,
          resumeAttempt: 0,
        },
      },
      'new-instance',
      now,
      120_000,
    );

    expect(plan.reorientations).toEqual([
      {
        id: 'reorientation',
        interrupt: true,
        resume: true,
        resumeAttempt: 1,
      },
    ]);
  });
});
