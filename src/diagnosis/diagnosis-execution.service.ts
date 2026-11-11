import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { GoogleChatNotificationsService } from '../google-chat/google-chat-notifications.service.js';
import type { ReorientationStatus } from '../remediation/reorientation-status.js';
import { STATE_INSTANCE_ID, StateService } from '../state/state.service.js';
import { ticketResultsDir } from './diagnosis-artifacts.js';
import { ExecutionHeartbeat } from './execution-heartbeat.js';
import { ExecutionPool } from './execution-pool.js';
import { itemKey } from './item-claims.js';
import {
  isActiveRunStatus,
  type DiagnosisRunRecord,
  type DiagnosisRuns,
  type DiagnosisSource,
  type RemediationMode,
} from './diagnosis-run.js';
import {
  isRunnerMessage,
  type IncidentNotificationAck,
} from './runner-messages.js';

const RUNNER_PATH = fileURLToPath(new URL('../runner.js', import.meta.url));

export interface RemediationReorientationRecord {
  id: string;
  ticketId: string;
  status: ReorientationStatus;
  finishedAt?: string;
  error?: string;
  ownerInstanceId?: string;
  heartbeatAt?: string;
  resumedFrom?: string;
  resumedBy?: string[];
  resumeAttempt?: number;
}

type RemediationReorientations = Record<string, RemediationReorientationRecord>;

@Injectable()
export class DiagnosisExecutionService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(DiagnosisExecutionService.name);
  private readonly pool: ExecutionPool;
  private readonly heartbeat: ExecutionHeartbeat;
  private readonly children = new Map<string, ChildProcess>();

  constructor(
    private readonly state: StateService,
    private readonly googleChat: GoogleChatNotificationsService,
    @Inject(APP_CONFIG) appConfig: AppConfig,
    @Inject(RUNTIME_CONFIG) private readonly runtime: RuntimeConfig,
    @Inject(STATE_INSTANCE_ID) private readonly instanceId: string,
  ) {
    this.pool = new ExecutionPool(appConfig.diagnosisExecutionConcurrency);
    this.heartbeat = new ExecutionHeartbeat(state, instanceId, {
      onError: (error) =>
        this.logger.error(`Execution heartbeat failed: ${error.message}`),
    });
  }

  onModuleInit() {
    this.heartbeat.start();
  }

  async onApplicationShutdown() {
    this.pool.stopStarting();
    this.heartbeat.stop();
    for (const child of this.children.values()) child.kill('SIGTERM');
    const finishedAt = new Date().toISOString();
    await this.state.update<DiagnosisRuns>('diagnosis-runs.json', (runs) => {
      for (const run of Object.values(runs)) {
        if (
          run.status === 'running' &&
          run.ownerInstanceId === this.instanceId
        ) {
          run.status = 'interrupted';
          run.finishedAt = finishedAt;
          run.error = 'interrupted by shutdown';
        }
      }
    });
    await this.state.update<RemediationReorientations>(
      'remediation-reorientations.json',
      (records) => {
        for (const record of Object.values(records)) {
          if (
            record.status === 'running' &&
            record.ownerInstanceId === this.instanceId
          ) {
            record.status = 'interrupted';
            record.finishedAt = finishedAt;
            record.error = 'interrupted by shutdown';
          }
        }
      },
    );
  }

  async enqueue(options: {
    ticketId?: string;
    incidentId?: string;
    source: DiagnosisSource;
    force?: boolean;
    notify?: boolean;
    remediation?: RemediationMode;
    googleChatSpace?: string;
    googleChatThread?: string;
  }) {
    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    const record: DiagnosisRunRecord = {
      runId,
      ticketId: options.ticketId,
      incidentId: options.incidentId,
      source: options.source,
      force: options.force || false,
      notify: options.notify !== false,
      remediation: options.remediation || 'auto',
      googleChatSpace: options.googleChatSpace,
      googleChatThread: options.googleChatThread,
      status: 'queued',
      createdAt,
      ownerInstanceId: this.instanceId,
      heartbeatAt: createdAt,
      resumeAttempt: 0,
    };
    await this.state.update<DiagnosisRuns>('diagnosis-runs.json', (runs) => {
      runs[runId] = record;
    });
    const completion = this.schedulePersistedDiagnosis(record);
    return { runId, completion };
  }

  async get(runId: string) {
    const runs = await this.state.read<DiagnosisRuns>('diagnosis-runs.json');
    const run = runs[runId];
    if (!run) return null;
    const workItemId = run.incidentId || run.ticketId;
    if (!workItemId || !['completed', 'failed'].includes(run.status))
      return run;
    const ticketDir = ticketResultsDir(this.runtime.resultsDir, workItemId);
    return {
      ...run,
      result: await readOptionalJson(path.join(ticketDir, 'run.json')),
      customerImpact: await readOptionalJson(
        path.join(ticketDir, 'customer-impact.json'),
      ),
      customerImpactHistory: await readOptionalJson(
        path.join(ticketDir, 'customer-impact-history.json'),
      ),
      engineeringAction: await readOptionalJson(
        path.join(ticketDir, 'engineering-action.json'),
      ),
      githubIssues: await readOptionalJson(
        path.join(ticketDir, 'github-issues.json'),
      ),
      remediation: await readOptionalJson(
        path.join(ticketDir, 'remediation.json'),
      ),
    };
  }

  async findActiveByTicket(ticketId: string) {
    const runs = await this.state.read<DiagnosisRuns>('diagnosis-runs.json');
    const diagnosis = Object.values(runs).find(
      (run) => run.ticketId === ticketId && isActiveRunStatus(run.status),
    );
    if (diagnosis) return diagnosis;
    const reorientations = await this.state.read<RemediationReorientations>(
      'remediation-reorientations.json',
    );
    const reorientation = Object.values(reorientations).find(
      (record) =>
        record.ticketId === ticketId && isActiveRunStatus(record.status),
    );
    return reorientation
      ? { runId: reorientation.id, ticketId, status: reorientation.status }
      : null;
  }

  async enqueueReorientation(reorientationId: string) {
    const records = await this.state.read<RemediationReorientations>(
      'remediation-reorientations.json',
    );
    const record = records[reorientationId];
    if (!record)
      throw new Error(
        `Remediation reorientation not found: ${reorientationId}`,
      );
    await this.patchReorientation(reorientationId, {
      ownerInstanceId: this.instanceId,
      heartbeatAt: new Date().toISOString(),
      resumeAttempt: record.resumeAttempt ?? 0,
    });
    return this.schedulePersistedReorientation(record);
  }

  schedulePersistedDiagnosis(record: DiagnosisRunRecord) {
    const completion = this.pool.enqueue({
      key: itemKey({
        ticketId: record.ticketId,
        incidentId: record.incidentId,
      }),
      run: () => this.execute(record),
    });
    void completion.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Diagnosis run ${record.runId} failed: ${message}`);
    });
    return completion;
  }

  schedulePersistedReorientation(record: RemediationReorientationRecord) {
    return this.pool.enqueue({
      key: itemKey({ reorientationTicketId: record.ticketId }),
      run: () => this.executeReorientation(record.id),
    });
  }

  private async execute(record: DiagnosisRunRecord) {
    const startedAt = new Date().toISOString();
    await this.patch(record.runId, {
      status: 'running',
      startedAt,
      heartbeatAt: startedAt,
      activeItems: [],
    });
    const args = [
      RUNNER_PATH,
      `--owner-instance-id=${this.instanceId}`,
      `--remediation=${record.remediation}`,
      record.notify ? '--notify' : '--no-notify',
    ];
    if (record.googleChatSpace)
      args.push(`--google-chat-space=${record.googleChatSpace}`);
    if (record.googleChatThread)
      args.push(`--google-chat-thread=${record.googleChatThread}`);
    if (record.ticketId) args.push(`--ticket-id=${record.ticketId}`);
    if (record.incidentId) args.push(`--incident-id=${record.incidentId}`);
    if (record.force) args.push('--force');
    if (record.resumedFrom) args.push('--resume');
    this.logger.log(
      `Starting ${record.source} diagnosis run ${record.runId}${record.ticketId ? ` for ${record.ticketId}` : ''}`,
    );
    try {
      const exitCode = await this.spawnRunner(
        args,
        record.notify,
        record.runId,
        record.runId,
      );
      if (exitCode !== 0)
        throw new Error(`Diagnosis runner exited with code ${exitCode}`);
      if (record.notify) await this.googleChat.notifySuccessfulRuns();
      await this.patchRunning(record.runId, {
        status: 'completed',
        exitCode,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.patchRunning(record.runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: (error as Error).message.slice(0, 2000),
      });
      throw error;
    }
  }

  private async executeReorientation(reorientationId: string) {
    const startedAt = new Date().toISOString();
    await this.patchReorientation(reorientationId, {
      status: 'running',
      heartbeatAt: startedAt,
    });
    this.logger.log(`Starting remediation reorientation ${reorientationId}`);
    try {
      const exitCode = await this.spawnRunner(
        [
          RUNNER_PATH,
          `--owner-instance-id=${this.instanceId}`,
          `--reorientation-id=${reorientationId}`,
        ],
        false,
        reorientationId,
      );
      if (exitCode !== 0)
        throw new Error(
          `Remediation reorientation runner exited with code ${exitCode}`,
        );
      await this.googleChat.notifySuccessfulRuns();
      await this.patchRunningReorientation(reorientationId, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.patchRunningReorientation(reorientationId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: (error as Error).message.slice(0, 2000),
      });
      throw error;
    }
  }

  private spawnRunner(
    args: string[],
    notify: boolean,
    executionId: string,
    diagnosisRunId?: string,
  ) {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: this.runtime.cwd,
        env: this.runtime.processEnv,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      this.children.set(executionId, child);
      let notificationQueue = Promise.resolve();
      child.on('message', (message: unknown) => {
        if (!isRunnerMessage(message)) return;
        if (
          diagnosisRunId &&
          (message.type === 'item-started' || message.type === 'item-finished')
        ) {
          void this.updateActiveItem(
            diagnosisRunId,
            message.key,
            message.type === 'item-started',
          ).catch((error: Error) =>
            this.logger.error(
              `Could not update active item for ${diagnosisRunId}: ${error.message}`,
            ),
          );
          return;
        }
        if (message.type === 'incident-diagnosis-ready') {
          const { incidentId } = message;
          const reply = (ack: IncidentNotificationAck) => {
            if (child.connected) child.send(ack);
          };
          void this.googleChat.notifyDiagnosis(incidentId).then(
            () => reply({ incidentId }),
            (error: Error) => reply({ incidentId, error: error.message }),
          );
          return;
        }
        if (message.type !== 'ticket-diagnosis-ready' || !notify) return;
        const { ticketId } = message;
        notificationQueue = notificationQueue
          .then(() => this.googleChat.notifyDiagnosis(ticketId))
          .catch((error) =>
            this.logger.error(
              `Diagnosis notification failed for ${ticketId}: ${(error as Error).message}`,
            ),
          );
      });
      const cleanup = () => this.children.delete(executionId);
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', (code) => {
        cleanup();
        void notificationQueue.finally(() => resolve(code ?? 1));
      });
    });
  }

  private async updateActiveItem(runId: string, key: string, active: boolean) {
    await this.state.update<DiagnosisRuns>('diagnosis-runs.json', (runs) => {
      const run = runs[runId];
      if (!run || run.status !== 'running') return;
      const items = new Set(run.activeItems ?? []);
      if (active) items.add(key);
      else items.delete(key);
      run.activeItems = [...items];
    });
  }

  private async patch(runId: string, patch: Partial<DiagnosisRunRecord>) {
    await this.state.update<DiagnosisRuns>('diagnosis-runs.json', (runs) => {
      if (runs[runId]) Object.assign(runs[runId], patch);
    });
  }

  private async patchRunning(
    runId: string,
    patch: Partial<DiagnosisRunRecord>,
  ) {
    await this.state.update<DiagnosisRuns>('diagnosis-runs.json', (runs) => {
      const run = runs[runId];
      if (run?.status === 'running') Object.assign(run, patch);
    });
  }

  private async patchReorientation(
    reorientationId: string,
    patch: Partial<RemediationReorientationRecord>,
  ) {
    await this.state.update<RemediationReorientations>(
      'remediation-reorientations.json',
      (records) => {
        if (records[reorientationId])
          Object.assign(records[reorientationId], patch);
      },
    );
  }

  private async patchRunningReorientation(
    reorientationId: string,
    patch: Partial<RemediationReorientationRecord>,
  ) {
    await this.state.update<RemediationReorientations>(
      'remediation-reorientations.json',
      (records) => {
        const record = records[reorientationId];
        if (record?.status === 'running') Object.assign(record, patch);
      },
    );
  }
}

async function readOptionalJson(filename: string) {
  try {
    return JSON.parse(await readFile(filename, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
