import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunStatus } from '../diagnosis/diagnosis-run.js';
import { StateService } from '../state/state.service.js';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';

const IMPACT_RUNNER_PATH = fileURLToPath(
  new URL('./impact-runner.js', import.meta.url),
);

export interface ImpactRunRecord {
  runId: string;
  ticketId: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
}

type ImpactRuns = Record<string, ImpactRunRecord>;

@Injectable()
export class ImpactExecutionService {
  private readonly logger = new Logger(ImpactExecutionService.name);
  private queue = Promise.resolve();

  constructor(
    private readonly state: StateService,
    @Inject(RUNTIME_CONFIG) private readonly runtime: RuntimeConfig,
  ) {}

  async enqueue(ticketId: string) {
    const runId = randomUUID();
    const record: ImpactRunRecord = {
      runId,
      ticketId,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    await this.state.update<ImpactRuns>('impact-runs.json', (runs) => {
      runs[runId] = record;
    });
    const completion = this.queue.then(() => this.execute(record));
    this.queue = completion.catch(() => undefined);
    return { runId, completion };
  }

  async get(runId: string) {
    const runs = await this.state.read<ImpactRuns>('impact-runs.json');
    const run = runs[runId];
    if (!run) return null;
    if (!['completed', 'failed'].includes(run.status)) return run;
    const ticketDir = path.resolve(
      this.runtime.resultsDir,
      safeTicketId(run.ticketId),
    );
    return {
      ...run,
      customerImpact: await readOptionalJson(
        path.join(ticketDir, 'customer-impact.json'),
      ),
      customerImpactHistory: await readOptionalJson(
        path.join(ticketDir, 'customer-impact-history.json'),
      ),
    };
  }

  private async execute(record: ImpactRunRecord) {
    await this.patch(record.runId, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    this.logger.log(
      `Starting manual customer impact run ${record.runId} for ${record.ticketId}`,
    );
    try {
      const exitCode = await spawnRunner(
        IMPACT_RUNNER_PATH,
        record.ticketId,
        this.runtime,
      );
      if (exitCode !== 0)
        throw new Error(`Impact runner exited with code ${exitCode}`);
      await this.patch(record.runId, {
        status: 'completed',
        exitCode,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.patch(record.runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: (error as Error).message.slice(0, 2000),
      });
      throw error;
    }
  }

  private async patch(runId: string, patch: Partial<ImpactRunRecord>) {
    await this.state.update<ImpactRuns>('impact-runs.json', (runs) => {
      if (runs[runId]) Object.assign(runs[runId], patch);
    });
  }
}

function spawnRunner(runner: string, ticketId: string, runtime: RuntimeConfig) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [runner, `--ticket-id=${safeTicketId(ticketId)}`],
      {
        cwd: runtime.cwd,
        env: runtime.processEnv,
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

function safeTicketId(ticketId: string) {
  const safe = ticketId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!safe || safe !== ticketId) throw new Error('Invalid ticket ID');
  return safe;
}

async function readOptionalJson(filename: string) {
  try {
    return JSON.parse(await readFile(filename, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
