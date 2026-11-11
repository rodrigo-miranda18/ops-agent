import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { STATE_INSTANCE_ID, StateService } from '../state/state.service.js';
import {
  DiagnosisExecutionService,
  type RemediationReorientationRecord,
} from './diagnosis-execution.service.js';
import type { DiagnosisRunRecord, DiagnosisRuns } from './diagnosis-run.js';
import {
  planRunRecovery,
  type RecoverableReorientationRecord,
} from './run-recovery.js';

const RECOVERY_INTERVAL_MS = 60_000;
const OWNER_LEASE_MS = 120_000;

type ReorientationState = Record<string, RemediationReorientationRecord>;

@Injectable()
export class RunRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(RunRecoveryService.name);
  private readonly scheduledDiagnoses = new Set<string>();
  private readonly scheduledReorientations = new Set<string>();

  constructor(
    private readonly state: StateService,
    private readonly executions: DiagnosisExecutionService,
    @Inject(STATE_INSTANCE_ID) private readonly instanceId: string,
  ) {}

  onModuleInit() {
    return this.executeRecovery();
  }

  @Interval(RECOVERY_INTERVAL_MS)
  async executeRecovery() {
    try {
      await this.recover(new Date());
    } catch (error) {
      this.logger.error(`Run recovery failed: ${(error as Error).message}`);
    }
  }

  async recover(now: Date) {
    const runs = await this.state.update<DiagnosisRuns>(
      'diagnosis-runs.json',
      (current) => {
        const plan = planRunRecovery(
          current,
          {},
          this.instanceId,
          now,
          OWNER_LEASE_MS,
        );
        for (const action of plan.diagnoses) {
          const original = current[action.runId];
          if (!original) continue;
          if (action.interrupt) {
            original.status = 'interrupted';
            original.finishedAt = now.toISOString();
            original.error = 'owner instance stopped (lease expired)';
          }
          const resumedIds = action.resumes.map(() => randomUUID());
          original.resumedBy = resumedIds;
          action.resumes.forEach((resume, index) => {
            const runId = resumedIds[index];
            if (!runId) return;
            current[runId] = {
              runId,
              ticketId: resume.ticketId,
              incidentId: resume.incidentId,
              source: resume.source,
              force: resume.force,
              notify: resume.notify,
              remediation: resume.remediation,
              googleChatSpace: resume.googleChatSpace,
              googleChatThread: resume.googleChatThread,
              status: 'queued',
              createdAt: now.toISOString(),
              ownerInstanceId: this.instanceId,
              heartbeatAt: now.toISOString(),
              resumedFrom: original.runId,
              resumeAttempt: resume.resumeAttempt,
            };
          });
          if (!action.resumes.length && (original.resumeAttempt ?? 0) >= 2)
            this.logger.error(
              `Run recovery attempt limit reached: runId=${original.runId}`,
            );
        }
      },
    );
    for (const run of Object.values(runs)) this.scheduleDiagnosis(run);

    const updatedReorientations = await this.state.update<ReorientationState>(
      'remediation-reorientations.json',
      (current) => {
        const plan = planRunRecovery(
          {},
          current as Record<string, RecoverableReorientationRecord>,
          this.instanceId,
          now,
          OWNER_LEASE_MS,
        );
        for (const action of plan.reorientations) {
          const record = current[action.id];
          if (!record) continue;
          if (!action.resume) {
            if (action.interrupt) {
              record.status = 'interrupted';
              record.finishedAt = now.toISOString();
              record.error = 'owner instance stopped (lease expired)';
            }
            this.logger.error(
              `Reorientation recovery attempt limit reached: id=${record.id}`,
            );
            continue;
          }
          record.status = 'queued';
          record.ownerInstanceId = this.instanceId;
          record.heartbeatAt = now.toISOString();
          record.resumedFrom ??= record.id;
          record.resumeAttempt = action.resumeAttempt;
          delete record.finishedAt;
          delete record.error;
        }
      },
    );
    for (const record of Object.values(updatedReorientations))
      this.scheduleReorientation(record);
  }

  private scheduleDiagnosis(run: DiagnosisRunRecord) {
    if (
      run.status !== 'queued' ||
      run.ownerInstanceId !== this.instanceId ||
      !run.resumedFrom ||
      this.scheduledDiagnoses.has(run.runId)
    )
      return;
    this.scheduledDiagnoses.add(run.runId);
    void this.executions
      .schedulePersistedDiagnosis(run)
      .catch((error: Error) => {
        this.scheduledDiagnoses.delete(run.runId);
        this.logger.error(
          `Could not schedule recovered run ${run.runId}: ${error.message}`,
        );
      });
  }

  private scheduleReorientation(record: RemediationReorientationRecord) {
    if (
      record.status !== 'queued' ||
      record.ownerInstanceId !== this.instanceId ||
      !record.resumedFrom ||
      this.scheduledReorientations.has(record.id)
    )
      return;
    this.scheduledReorientations.add(record.id);
    void this.executions
      .schedulePersistedReorientation(record)
      .catch((error: Error) => {
        this.scheduledReorientations.delete(record.id);
        this.logger.error(
          `Could not schedule recovered reorientation ${record.id}: ${error.message}`,
        );
      });
  }
}
