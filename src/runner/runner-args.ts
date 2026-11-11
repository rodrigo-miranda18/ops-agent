import { positiveInteger } from '../config/runner-config.js';
import {
  isRemediationMode,
  type RemediationMode,
} from '../diagnosis/diagnosis-run.js';
import { runnerLogger } from './runner-logger.js';

export interface RunnerArgs {
  dryRun: boolean;
  force: boolean;
  notify: boolean;
  syncDependenciesOnly: boolean;
  help?: boolean;
  ticketId: string | undefined;
  incidentId: string | undefined;
  remediation: RemediationMode;
  googleChatSpace: string | undefined;
  googleChatThread: string | undefined;
  reorientationId: string | undefined;
  ownerInstanceId: string | undefined;
  resume: boolean;
  maxTickets: number | undefined;
  createdWithinMinutes: number | undefined;
}

export function parseArgs(argv: readonly string[]): RunnerArgs {
  const args: RunnerArgs = {
    dryRun: false,
    force: false,
    notify: true,
    syncDependenciesOnly: false,
    ticketId: undefined,
    incidentId: undefined,
    remediation: 'auto',
    googleChatSpace: undefined,
    googleChatThread: undefined,
    reorientationId: undefined,
    ownerInstanceId: undefined,
    resume: false,
    maxTickets: undefined,
    createdWithinMinutes: undefined,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--notify') args.notify = true;
    else if (arg === '--no-notify') args.notify = false;
    else if (arg === '--sync-dependencies-only')
      args.syncDependenciesOnly = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--ticket-id='))
      args.ticketId = arg.split('=', 2)[1]?.trim();
    else if (arg.startsWith('--incident-id='))
      args.incidentId = arg.split('=', 2)[1]?.trim();
    else if (arg.startsWith('--remediation='))
      args.remediation = remediationMode(arg.split('=', 2)[1]);
    else if (arg.startsWith('--google-chat-space='))
      args.googleChatSpace = arg.split('=', 2)[1]?.trim();
    else if (arg.startsWith('--google-chat-thread='))
      args.googleChatThread = arg.split('=', 2)[1]?.trim();
    else if (arg.startsWith('--reorientation-id='))
      args.reorientationId = arg.split('=', 2)[1]?.trim();
    else if (arg.startsWith('--owner-instance-id=')) {
      args.ownerInstanceId = arg.split('=', 2)[1]?.trim();
      if (!args.ownerInstanceId)
        throw new Error('--owner-instance-id must not be empty');
    } else if (arg === '--resume') args.resume = true;
    else if (arg.startsWith('--max-tickets='))
      args.maxTickets = positiveInteger(arg.split('=', 2)[1], '--max-tickets');
    else if (arg.startsWith('--created-within-minutes='))
      args.createdWithinMinutes = positiveInteger(
        arg.split('=', 2)[1],
        '--created-within-minutes',
      );
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function remediationMode(value: string | undefined): RemediationMode {
  if (!isRemediationMode(value))
    throw new Error('--remediation must be none, plan, or auto');
  return value;
}

export function printHelp(): void {
  runnerLogger.info(
    `Usage: node dist/runner.js [--ticket-id=ID] [--force] [--remediation=none|plan|auto] [--dry-run] [--sync-dependencies-only] [--owner-instance-id=ID] [--resume] [--max-tickets=N] [--created-within-minutes=N]\n\n--ticket-id=ID             Diagnose one ticket, ignoring the creation window and automatic filters.\n--force                    Ignore state/processed.json for a manual ticket.\n--remediation=MODE         none: diagnosis only; plan: remediation plan only; auto: implement eligible actions.\n--dry-run                  Fetch and filter tickets without invoking Codex or changing state.\n--sync-dependencies-only   Synchronize repositories and lockfile-based dependencies, then exit.\n--owner-instance-id=ID     Identify the Nest instance that owns this execution.\n--resume                   Resume an interrupted item from persisted artifacts when possible.\n--max-tickets=N            Override CLICKUP_MAX_TICKETS for this run.\n--created-within-minutes=N  Only select tickets created in the last N minutes.`,
  );
}
