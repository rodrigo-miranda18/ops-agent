import type { StateService } from '../state/state.service.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

type OwnedExecutionRecord = {
  status?: unknown;
  ownerInstanceId?: unknown;
  heartbeatAt?: string;
};

type ExecutionState = Record<string, OwnedExecutionRecord>;

export class ExecutionHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly onError: (error: Error) => void;

  constructor(
    private readonly state: StateService,
    private readonly instanceId: string,
    options: {
      now?: () => Date;
      intervalMs?: number;
      onError?: (error: Error) => void;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.onError = options.onError ?? (() => undefined);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: Error) => this.onError(error));
    }, this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick() {
    const heartbeatAt = this.now().toISOString();
    for (const filename of [
      'diagnosis-runs.json',
      'remediation-reorientations.json',
    ]) {
      await this.state.update<ExecutionState>(filename, (records) => {
        for (const record of Object.values(records)) {
          if (
            record.status === 'running' &&
            record.ownerInstanceId === this.instanceId
          )
            record.heartbeatAt = heartbeatAt;
        }
      });
    }
  }
}
