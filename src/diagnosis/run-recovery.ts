import type {
  DiagnosisRunRecord,
  DiagnosisRuns,
  DiagnosisSource,
  RemediationMode,
} from './diagnosis-run.js';

export interface DiagnosisResumeDescriptor {
  ticketId?: string;
  incidentId?: string;
  source: DiagnosisSource;
  force: true;
  notify: boolean;
  remediation: RemediationMode;
  googleChatSpace?: string;
  googleChatThread?: string;
  resumeAttempt: number;
}

export interface DiagnosisRecoveryAction {
  runId: string;
  interrupt: boolean;
  resumes: DiagnosisResumeDescriptor[];
}

export interface RecoverableReorientationRecord {
  id: string;
  ticketId: string;
  status: string;
  ownerInstanceId?: string;
  heartbeatAt?: string;
  startedAt?: string;
  createdAt?: string;
  resumeAttempt?: number;
}

export interface ReorientationRecoveryAction {
  id: string;
  interrupt: boolean;
  resume: boolean;
  resumeAttempt: number;
}

export interface RecoveryPlan {
  diagnoses: DiagnosisRecoveryAction[];
  reorientations: ReorientationRecoveryAction[];
}

function expiredAt(
  record: {
    heartbeatAt?: string;
    startedAt?: string;
    createdAt?: string;
  },
  now: Date,
  leaseMs: number,
): boolean {
  const timestamp = record.heartbeatAt ?? record.startedAt ?? record.createdAt;
  if (!timestamp) return true;
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds) || now.getTime() - milliseconds >= leaseMs;
}

function descriptor(
  run: DiagnosisRunRecord,
  ticketId?: string,
  incidentId?: string,
): DiagnosisResumeDescriptor {
  return {
    ticketId,
    incidentId,
    source: run.source,
    force: true,
    notify: run.notify,
    remediation: run.remediation,
    googleChatSpace: run.googleChatSpace,
    googleChatThread: run.googleChatThread,
    resumeAttempt: (run.resumeAttempt ?? 0) + 1,
  };
}

function resumeDescriptors(run: DiagnosisRunRecord) {
  if ((run.resumeAttempt ?? 0) >= 2) return [];
  if (run.ticketId) return [descriptor(run, run.ticketId)];
  if (run.incidentId) return [descriptor(run, undefined, run.incidentId)];
  return (run.activeItems ?? []).flatMap((key) => {
    if (key.startsWith('ticket:'))
      return [descriptor(run, key.slice('ticket:'.length))];
    if (key.startsWith('incident:'))
      return [descriptor(run, undefined, key.slice('incident:'.length))];
    return [];
  });
}

export function planRunRecovery(
  runs: DiagnosisRuns,
  reorientations: Record<string, RecoverableReorientationRecord>,
  instanceId: string,
  now: Date,
  leaseMs: number,
): RecoveryPlan {
  const liveOwners = new Set(
    Object.values(runs)
      .filter(
        (run) =>
          run.status === 'running' &&
          run.ownerInstanceId &&
          !expiredAt(run, now, leaseMs),
      )
      .map((run) => run.ownerInstanceId as string),
  );
  const diagnoses: DiagnosisRecoveryAction[] = [];
  for (const run of Object.values(runs)) {
    if (run.resumedBy !== undefined) continue;
    const alreadyInterrupted = run.status === 'interrupted';
    const foreign = run.ownerInstanceId !== instanceId;
    const expiredRunning =
      run.status === 'running' && foreign && expiredAt(run, now, leaseMs);
    const lostQueued =
      run.status === 'queued' &&
      foreign &&
      !liveOwners.has(run.ownerInstanceId ?? '') &&
      expiredAt(run, now, leaseMs);
    if (!alreadyInterrupted && !expiredRunning && !lostQueued) continue;
    diagnoses.push({
      runId: run.runId,
      interrupt: expiredRunning || lostQueued,
      resumes: resumeDescriptors(run),
    });
  }

  const reorientationActions: ReorientationRecoveryAction[] = [];
  for (const record of Object.values(reorientations)) {
    const alreadyInterrupted = record.status === 'interrupted';
    const foreign = record.ownerInstanceId !== instanceId;
    const expired =
      ['running', 'queued'].includes(record.status) &&
      foreign &&
      expiredAt(record, now, leaseMs);
    if (!alreadyInterrupted && !expired) continue;
    const attempt = record.resumeAttempt ?? 0;
    reorientationActions.push({
      id: record.id,
      interrupt: expired,
      resume: attempt < 2,
      resumeAttempt: attempt + 1,
    });
  }

  return { diagnoses, reorientations: reorientationActions };
}
