import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COMMUNICATION_CONFIG,
  type CommunicationConfig,
} from '../config/communication-config.js';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import {
  COMMUNICATION_VERSION_EVENTS,
  type CommunicationVersionEvents,
} from './communication-events.js';
import { CommunicationStore } from './communication-store.js';
import { isCommunicationRunnerMessage } from './runner-messages.js';

const COMMUNICATION_RUNNER_PATH = fileURLToPath(
  new URL('./communication-runner.js', import.meta.url),
);

export const STALE_GENERATION_ERROR =
  'A geração foi interrompida por um reinício do serviço.';

interface CommunicationRun {
  communicationId: string;
  version: number;
}

@Injectable()
export class CommunicationExecutionService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(CommunicationExecutionService.name);
  private readonly waiting: CommunicationRun[] = [];
  private readonly children = new Set<ChildProcess>();
  private running = 0;
  private stopping = false;

  constructor(
    private readonly store: CommunicationStore,
    @Inject(COMMUNICATION_VERSION_EVENTS)
    private readonly events: CommunicationVersionEvents,
    @Inject(RUNTIME_CONFIG) private readonly runtime: RuntimeConfig,
    @Inject(COMMUNICATION_CONFIG) private readonly config: CommunicationConfig,
  ) {}

  onApplicationBootstrap() {
    void this.recoverStaleGenerations().catch((error: Error) =>
      this.logger.error(`Communication boot recovery failed: ${error.message}`),
    );
  }

  onApplicationShutdown() {
    this.stopping = true;
    this.waiting.length = 0;
    for (const child of this.children) child.kill('SIGTERM');
  }

  start(input: CommunicationRun): Promise<void> {
    this.waiting.push(input);
    this.drain();
    return Promise.resolve();
  }

  async recoverStaleGenerations() {
    const stale = await this.store.failStaleGenerations();
    for (const generation of stale) {
      this.logger.warn(
        `Communication ${generation.id} v${generation.version} was generating at boot; marked failed`,
      );
      this.notifyFailed({
        communicationId: generation.id,
        version: generation.version,
        error: STALE_GENERATION_ERROR,
      });
    }
  }

  private drain() {
    while (!this.stopping && this.running < this.config.maxConcurrent) {
      const next = this.waiting.shift();
      if (!next) return;
      this.running += 1;
      void this.execute(next)
        .catch((error: Error) =>
          this.logger.error(
            `Communication ${next.communicationId} v${next.version} execution failed: ${error.message}`,
          ),
        )
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }

  private execute(run: CommunicationRun): Promise<void> {
    const label = `${run.communicationId} v${run.version}`;
    this.logger.log(`Starting communication runner for ${label}`);
    return new Promise<void>((resolve) => {
      let notified = false;
      let timedOut = false;
      let settled = false;
      const child = spawn(
        process.execPath,
        [
          COMMUNICATION_RUNNER_PATH,
          `--communication-id=${run.communicationId}`,
          `--version=${run.version}`,
        ],
        {
          cwd: this.runtime.cwd,
          env: this.runtime.processEnv,
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        },
      );
      this.children.add(child);
      const timer = setTimeout(() => {
        timedOut = true;
        this.logger.error(
          `Communication runner for ${label} timed out after ${this.config.timeoutMs} ms`,
        );
        child.kill('SIGTERM');
      }, this.config.timeoutMs);

      child.on('message', (message: unknown) => {
        if (
          notified ||
          !isCommunicationRunnerMessage(message) ||
          message.communicationId !== run.communicationId ||
          message.version !== run.version
        )
          return;
        notified = true;
        if (message.type === 'communication-ready') this.notifyReady(run);
        else this.notifyFailed({ ...run, error: message.error });
      });

      const settle = (error: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (!notified) {
          notified = true;
          this.notifyFailed({ ...run, error: error ?? 'unknown error' });
        }
        this.logger.log(`Communication runner for ${label} finished`);
        resolve();
      };
      child.once('error', (error) =>
        settle(`Communication runner failed to start: ${error.message}`),
      );
      child.once('close', (code, signal) =>
        settle(
          timedOut
            ? `Communication runner timed out after ${Math.round(this.config.timeoutMs / 60_000)} min`
            : `Communication runner exited without a result (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
        ),
      );
    });
  }

  private notifyReady(run: CommunicationRun) {
    void this.events
      .versionReady(run)
      .catch((error: Error) =>
        this.logger.error(
          `Communication ready notification failed for ${run.communicationId} v${run.version}: ${error.message}`,
        ),
      );
  }

  private notifyFailed(input: CommunicationRun & { error: string }) {
    void this.events
      .versionFailed(input)
      .catch((error: Error) =>
        this.logger.error(
          `Communication failure notification failed for ${input.communicationId} v${input.version}: ${error.message}`,
        ),
      );
  }
}
