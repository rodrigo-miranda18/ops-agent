export const REMEDIATION_MODES = ['none', 'plan', 'auto'] as const;
export type RemediationMode = (typeof REMEDIATION_MODES)[number];

export const DIAGNOSIS_SOURCES = ['cron', 'manual', 'grafana'] as const;
export type DiagnosisSource = (typeof DIAGNOSIS_SOURCES)[number];

export const RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'interrupted',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface DiagnosisRunRecord {
  runId: string;
  ticketId?: string;
  incidentId?: string;
  source: DiagnosisSource;
  force: boolean;
  notify: boolean;
  remediation: RemediationMode;
  googleChatSpace?: string;
  googleChatThread?: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  ownerInstanceId?: string;
  heartbeatAt?: string;
  activeItems?: string[];
  resumedFrom?: string;
  resumedBy?: string[];
  resumeAttempt?: number;
}

export type DiagnosisRuns = Record<string, DiagnosisRunRecord>;

export const ACTIVE_RUN_STATUSES = [
  'queued',
  'running',
] as const satisfies readonly RunStatus[];

export function isRemediationMode(value: unknown): value is RemediationMode {
  return (REMEDIATION_MODES as readonly unknown[]).includes(value);
}

export function isActiveRunStatus(value: unknown): boolean {
  return (ACTIVE_RUN_STATUSES as readonly unknown[]).includes(value);
}
