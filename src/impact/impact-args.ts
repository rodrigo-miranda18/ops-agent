import path from 'node:path';
import { runnerLogger } from '../runner/runner-logger.js';

export interface ImpactRunnerArgs {
  all: boolean;
  force: boolean;
  concurrency: number;
  ticketId: string | null;
  source: string;
  output: string | null;
  help?: boolean;
}

export function parseImpactArgs(
  argv: readonly string[],
  projectDir: string,
): ImpactRunnerArgs {
  const args: ImpactRunnerArgs = {
    all: false,
    force: false,
    concurrency: 1,
    ticketId: null,
    source: path.join(projectDir, 'results'),
    output: null,
  };
  for (const arg of argv) {
    if (arg === '--all') args.all = true;
    else if (arg === '--force') args.force = true;
    else if (arg.startsWith('--ticket-id='))
      args.ticketId = arg.slice('--ticket-id='.length).trim();
    else if (arg.startsWith('--source='))
      args.source = path.resolve(arg.slice('--source='.length));
    else if (arg.startsWith('--output='))
      args.output = path.resolve(arg.slice('--output='.length));
    else if (arg.startsWith('--concurrency='))
      args.concurrency = concurrency(
        arg.slice('--concurrency='.length),
        '--concurrency',
      );
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.help && args.all === Boolean(args.ticketId))
    throw new Error('Use exactly one of --all or --ticket-id');
  if (args.all && !args.output)
    args.output = path.join(
      projectDir,
      'results',
      `impact-v1.1-${path.basename(args.source)}`,
    );
  return args;
}

function concurrency(value: string, name: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8)
    throw new Error(`${name} must be an integer from 1 to 8`);
  return parsed;
}

export function printImpactHelp(): void {
  runnerLogger.info(`Usage:
  node dist/impact/impact-runner.js --ticket-id=ID [--source=DIR] [--force]
  node dist/impact/impact-runner.js --all --source=DIR --output=DIR [--concurrency=N] [--force]`);
}
